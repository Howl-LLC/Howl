// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useDmStore } from '../stores/dmStore';
import { useUiStore } from '../stores/uiStore';
import { isChannelMls } from '../services/encryptionFlags';
import * as mlsCoordinator from '../services/mls/mlsCoordinator';
import { logger } from '../services/logger';

/** Push a rejected establish into uiStore IFF it is a typed failure
 *  (peer-unprovisioned / key-change-blocked). Generic failures are left for the
 *  caller's logging (no UI state). */
export function routeEstablishOutcome(dmChannelId: string, err: unknown): void {
  const reason = (err as { reason?: string }).reason;
  if (reason === 'peer-unprovisioned') {
    const userId = (err as { unprovisionedUserId?: string }).unprovisionedUserId;
    useUiStore.getState().setEstablishFailureReason(dmChannelId, 'peer-unprovisioned', userId);
  } else if (reason === 'key-change-blocked') {
    const userId = (err as { blockedUserId?: string }).blockedUserId;
    useUiStore.getState().setEstablishFailureReason(dmChannelId, 'key-change-blocked', userId);
  }
}

/** Chained create-then-send flows (InviteModal,
 *  sendMessageAndOpenDM, forwardToFriend) die fail-closed in encryptDMContent
 *  when the channel isn't MLS-ready, but that error's copy tells the SENDER to
 *  unlock their own vault. When the real state is a recorded peer-unprovisioned
 *  establish failure, translate it to the waiting copy, resolving the name the
 *  same way DMView's composer placeholder does (group: the RECORDED member;
 *  1:1: the only peer there is). Anything else - a different error, or a
 *  not-ready failure with no recorded reason - passes through unchanged so
 *  existing 'Encryption unavailable' consumers keep matching. The mapped Error
 *  carries __expected so Sentry's beforeSend still drops it. */
export function describeSendBlock(dmChannelId: string, err: unknown): unknown {
  if (!(err instanceof Error) || !err.message.includes('Encryption unavailable')) return err;
  const failure = useUiStore.getState().establishFailureReasons[dmChannelId];
  if (failure?.reason !== 'peer-unprovisioned' && failure?.reason !== 'key-change-blocked') return err;
  const ch = useDmStore.getState().dmChannels.find((c) => c.id === dmChannelId);
  const name = ch?.isGroup
    ? (ch.otherUsers?.find((u) => u.id === failure.userId)?.username ?? 'a member')
    : (ch?.otherUser?.username ?? 'this user');
  const mapped = new Error(
    failure.reason === 'key-change-blocked'
      ? `${name}'s security key changed — review it to continue`
      : `Waiting for ${name} to enable encryption`,
  );
  (mapped as Error & { __expected?: boolean }).__expected = true;
  return mapped;
}

/** Presence-driven retry: when `userId` comes online or flips to any connected status
 *  (online/idle/dnd), re-establish any MLS DM channel that explicitly failed
 *  peer-unprovisioned and names this user as the peer. Tightly
 *  bounded - iterates only the failed-channel set (usually empty), short-circuits ready
 *  channels (clearing their stale failure), and relies on the coordinator core's
 *  establish dedup/serialization so repeated presence pings can't corrupt group state
 *  (on the worker path each ping is a separate rpc, but the core resolves
 *  already-loaded channels immediately). */
export function retryMlsEstablishForUser(userId: string): void {
  const failures = useUiStore.getState().establishFailureReasons;
  const failedChannelIds = Object.keys(failures);
  if (failedChannelIds.length === 0) return;
  const channels = useDmStore.getState().dmChannels;

  for (const channelId of failedChannelIds) {
    // key-change-blocked can't be healed by presence: only the user's accept (or the
    // peer rotating to a new key) unblocks it, and each retry would hit the network
    // for the pre-consume AIK read. Presence-retry only the unprovisioned class.
    if (failures[channelId]?.reason !== 'peer-unprovisioned') continue;
    const ch = channels.find((c) => c.id === channelId);
    if (!ch || !isChannelMls(channelId)) continue;
    // A rowless GROUP DM can't be retried here: establishGroupDmChannel is the
    // joiner-only path, and re-creating the group needs the roster + creator
    // semantics (deliberate residual). A rowless 1:1 IS retryable:
    // establishChannel's resolution tree self-resolves (Welcome -> server
    // lookup -> create), which is exactly the intended recovery path.
    if (ch.isGroup && !ch.mlsGroupId) continue;
    // Match the peer: for groups, the RECORDED unprovisioned member (any other
    // member's presence can't heal a consume that names someone else); for 1:1,
    // the only peer there is.
    const failureUserId = failures[channelId]?.userId;
    const isPeer = ch.isGroup
      ? (failureUserId ? failureUserId === userId : !!ch.otherUsers?.some((u) => u.id === userId))
      : ch.otherUser?.id === userId;
    if (!isPeer) continue;
    if (mlsCoordinator.isReadyForChannel(channelId)) {
      useUiStore.getState().clearEstablishFailure(channelId);
      continue;
    }
    const onErr = (err: unknown) => {
      logger.warn('[mls] presence-retry establish failed', { channelId, error: (err as Error)?.message });
      routeEstablishOutcome(channelId, err);
    };
    if (ch.isGroup) {
      void mlsCoordinator.establishGroupDmChannel(channelId, ch.mlsGroupId).catch(onErr);
    } else if (ch.otherUser?.id) {
      void mlsCoordinator.establishChannel(channelId, ch.otherUser.id, ch.mlsGroupId).catch(onErr);
    }
  }
}
