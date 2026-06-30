// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect } from 'react';
import type { Message } from '../types';
import { socketService } from '../services/socket';
import { decryptSingleDMMessage } from '../services/dmEncryption';
import { roomKey, isOtrRoomKey } from '../services/mls/roomKey';
import * as mlsCoordinator from '../services/mls/mlsCoordinator';
import { useMessageStore } from '../stores/messageStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useNavigationStore } from '../stores/navigationStore';
import { isDmChannelMuted } from '../utils/dmMuteStorage';
import { playMessageNotification } from '../utils/notificationSound';

/**
 * Registers the OTR-tier socket listeners (incoming message, ended, pull-on-connect).
 *
 * OTR messages are ephemeral: they render only into the namespaced
 * `roomKey(id, 'otr')` bucket (never the durable `saved` bucket), are never
 * persisted, and a failed decrypt is dropped rather than placeholdered. We
 * surface unread + sound but NEVER a plaintext sidebar preview, so we never
 * touch useDmStore.lastMessage.
 */
export function useOtrSocketEvents(currentUserId: string | undefined): void {
  useEffect(() => {
    if (!currentUserId) return;

    socketService.onOtrMessage(async (p) => {
      if (!p?.dmChannelId || !p?.clientMsgId || !p?.ciphertext) return;
      const rk = roomKey(p.dmChannelId, 'otr');
      const existing = useMessageStore.getState().dmMessages[rk];
      if (existing?.some((m) => m.id === p.clientMsgId)) {
        socketService.emitOtrAck({ clientMsgId: p.clientMsgId });
        return;
      }
      const wire = {
        id: p.clientMsgId,
        content: p.ciphertext,
        authorId: p.authorId ?? '',
        timestamp: new Date(p.createdAt ?? Date.now()),
        type: 'message',
      } as Message;
      let decrypted: Message;
      try {
        decrypted = await decryptSingleDMMessage(p.dmChannelId, wire, undefined, 'otr');
      } catch {
        return; // ephemeral: a hard decrypt error is dropped, not placeholdered
      }
      // decryptSingleDMMessage does not throw on an undecryptable envelope — it
      // resolves a 🔒 placeholder (durable Saved DMs want that). For ephemeral
      // OTR we DROP it (never show 🔒) and leave it UN-acked, so the server keeps
      // it queued for a post-activation re-pull once the OTR group loads (the
      // onReadyChannel / mls-ready re-pull below).
      if (decrypted.undecryptable) return;
      useMessageStore.getState().addDmMessage(rk, decrypted);
      socketService.emitOtrAck({ clientMsgId: p.clientMsgId });

      // Unread + sound, but NEVER a plaintext sidebar preview.
      if (decrypted.authorId !== currentUserId) {
        const nav = useNavigationStore.getState();
        const isActiveOtr = nav.activeDmChannelId === p.dmChannelId && nav.activeDmTier === 'otr';
        if (!isActiveOtr) {
          useNotificationStore.getState().addOtrUnreadDmChannel(p.dmChannelId);
          useNotificationStore.getState().incrementOtrDmUnread(p.dmChannelId);
        }
        if (!isDmChannelMuted(p.dmChannelId)) playMessageNotification(isActiveOtr);
      }
    });

    socketService.onOtrEnded(async (p) => {
      if (!p?.dmChannelId) return;
      const rk = roomKey(p.dmChannelId, 'otr');
      useMessageStore.getState().setDmMessages(rk, [], false); // clear ephemeral scrollback
      useNotificationStore.getState().removeOtrUnreadDmChannel(p.dmChannelId);
      useNotificationStore.getState().clearOtrDmUnread(p.dmChannelId);
      try {
        await mlsCoordinator.endOtrGroup(p.dmChannelId);
      } catch { /* best-effort */ }
      const nav = useNavigationStore.getState();
      if (nav.activeDmChannelId === p.dmChannelId && nav.activeDmTier === 'otr') {
        nav.setActiveDmTier('saved');
      }
    });

    // Pull the recipient's queued OTR envelopes, but only once MLS is active —
    // on a reload the socket reconnects before the OTR group finishes loading
    // from IndexedDB, and an eager pull would deliver envelopes we can't decrypt
    // yet (dropped, un-acked). Re-pull on the two "now ready" signals so those
    // still-queued envelopes are replayed and decrypted: 'mls-ready' (in-process
    // activation; the worker relays it) and onReadyChannel for an OTR room
    // (worker readiness diff + a recipient's late Welcome/External-Commit join).
    // The pull is ordered, non-destructive (delete-on-ack), and rate-limited, so
    // firing it more than once is harmless.
    const pullIfActive = () => { if (mlsCoordinator.isActive()) socketService.emitOtrPull(); };
    socketService.whenConnected(pullIfActive);
    const offMlsReady = mlsCoordinator.mlsEvents.on((e) => { if (e === 'mls-ready') pullIfActive(); });
    const offReadyChannel = mlsCoordinator.onReadyChannel((rk) => { if (isOtrRoomKey(rk)) pullIfActive(); });

    return () => {
      socketService.offOtrMessage();
      socketService.offOtrEnded();
      offMlsReady();
      offReadyChannel();
    };
  }, [currentUserId]);
}
