// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef } from 'react';
import type { Message } from '../types';
import { socketService } from '../services/socket';
import { apiClient } from '../services/api';
import { playMessageNotification } from '../utils/notificationSound';
import { isDmChannelMuted } from '../utils/dmMuteStorage';
// dmSearchIndex is dynamic-imported at each call site so the MiniSearch + idb
// modules stay out of the main chunk (useDmSocketEvents is eagerly imported
// by AppLayout). All call sites are fire-and-forget inside socket handlers.
import * as mlsGroupStore from '../services/mls/mlsGroupStore';
import * as mlsCoordinator from '../services/mls/mlsCoordinator';
import { routeEstablishOutcome } from '../utils/mlsRetry';
import { decryptSingleDMMessage, decryptDMContent, ENCRYPTED_PLACEHOLDER } from '../services/dmEncryption';
import { isChannelEncrypted, isChannelMls, setChannelEncryptionStatus } from '../services/encryptionFlags';
import { deferStoreUpdate } from '../utils/storeHelpers';
import { useMessageStore } from '../stores/messageStore';
import { useTypingStore } from '../stores/typingStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useDmStore } from '../stores/dmStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useAuthStore } from '../stores/authStore';
import { isAppVisible, onVisibilityChange } from './useAppVisible';
import type { DmChannelEntry, DmBlockStatusEntry } from '../stores/types';

export type { DmChannelEntry, DmBlockStatusEntry };

export interface UseDmSocketEventsOpts {
  currentUserId: string | undefined;
}

/** Max messages kept in memory per channel. Oldest are evicted when exceeded. */
const MAX_MESSAGES_PER_CHANNEL = 1000;

const _capMessages = (arr: Message[]) =>
  arr.length > MAX_MESSAGES_PER_CHANNEL ? arr.slice(-MAX_MESSAGES_PER_CHANNEL) : arr;

/**
 * Registers all DM-related socket event listeners:
 * new message, system message, pin/unpin, delete/update,
 * new channel, participant left, block/unblock.
 */
export function useDmSocketEvents(opts: UseDmSocketEventsOpts): void {
  const {
    currentUserId,
  } = opts;

  // RAF batching refs for new DM messages — mirrors useChannelSocketEvents.
  // Without this, bursty DM arrival (10+ messages in 50ms from a paste or bot) caused N
  // synchronous re-renders, contributing to scroll rubber-banding.
  const dmBufferRef = useRef<Array<{ dmChannelId: string; message: Message; decryptedMsg: Message }>>([]);
  const dmRafRef = useRef<number>(0);

  // DM message handlers (new message, system, pin/unpin, delete, update, new channel, participant left)
  useEffect(() => {
    if (!currentUserId) return;

    // Per-message side effects fire synchronously, even when the tab is
    // hidden. Only the message-store insert (which drives the expensive
    // Virtuoso re-measure) stays on the 5s hidden-tab timer; the DM list
    // last-message preview, unread/mention badges, and notification sound
    // must not wait for the flush, otherwise they're invisible until the
    // user returns to the tab.
    const applyDmNotification = (dmChannelId: string, message: Message, decryptedMsg: Message) => {
      const activeDmChannelId = useNavigationStore.getState().activeDmChannelId;

      // DM list last-message preview is visible in the sidebar even when
      // the message-store insert is deferred.
      useDmStore.getState().updateDmChannel(dmChannelId, (ch) => ({
        ...ch,
        lastMessage: { content: decryptedMsg.content, createdAt: message.timestamp.toISOString(), authorId: message.authorId },
      }));

      if (message.authorId === currentUserId) return;

      if (dmChannelId !== activeDmChannelId) {
        useNotificationStore.getState().addUnreadDmChannel(dmChannelId);
        useNotificationStore.getState().incrementDmUnread(dmChannelId);
      }

      if (isDmChannelMuted(dmChannelId)) return;
      if (dmChannelId !== activeDmChannelId) {
        // Sound is throttled internally to 1 play / 2s, so per-message
        // calls don't produce sound storms during bursty arrival.
        playMessageNotification(false);
      } else if (document.hidden || useAuthStore.getState().currentUser?.status === 'idle') {
        playMessageNotification(true);
      }
    };

    const flushDmBatch = () => {
      dmRafRef.current = 0;
      const batch = dmBufferRef.current.splice(0);
      if (batch.length === 0) return;

      deferStoreUpdate(() => {
        // Single batch insert into the message store (one set() instead of N).
        useMessageStore.getState().addDmMessageBatch(
          batch.map((b) => ({ dmChannelId: b.dmChannelId, message: b.decryptedMsg })),
        );

        for (const { dmChannelId, message } of batch) {
          if (message.authorId !== currentUserId) {
            useTypingStore.getState().clearUserTyping(dmChannelId, message.authorId);
          }
        }
      });
    };

    const unsubVis = onVisibilityChange((visible) => {
      if (visible && dmBufferRef.current.length > 0) {
        if (dmRafRef.current) {
          cancelAnimationFrame(dmRafRef.current);
          clearTimeout(dmRafRef.current);
          dmRafRef.current = 0;
        }
        flushDmBatch();
      }
    });

    socketService.onNewDMMessage(async (dmChannelId, message, encrypted) => {
      // Validate payload shape and DM channel membership
      if (typeof dmChannelId !== 'string' || !dmChannelId || !message?.id || typeof message.id !== 'string') return;
      let dmChannel = useDmStore.getState().dmChannels.find((ch) => ch.id === dmChannelId);
      if (!dmChannel) {
        // Race / orphan: new-dm-message arrived before new-dm-channel propagated,
        // or the backend created a DM and we missed the channel-creation event.
        // Fetch the DM list once and retry. Bounded to one extra API call per
        // unknown channel — acceptable cost to avoid silently dropping the
        // message (and the sound + dot that go with it).
        try {
          const list = await apiClient.getDMs();
          const found = (list as Array<{ id: string; isGroup?: boolean; otherUser?: any; otherUsers?: any; encrypted?: boolean }>).find(c => c.id === dmChannelId);
          if (found) {
            useDmStore.getState().addDmChannel({
              id: found.id,
              isGroup: !!found.isGroup,
              otherUser: found.otherUser,
              otherUsers: found.otherUsers,
              encrypted: !!found.encrypted,
            });
            dmChannel = useDmStore.getState().dmChannels.find((ch) => ch.id === dmChannelId);
          }
        } catch { /* swallow — fall through to early return below */ }
        if (!dmChannel) return;
      }

      // Always run through decryption — never trust the `encrypted` flag alone.
      // decryptSingleDMMessage is a no-op for non-envelope content, and ensures
      // any v2 envelope is either decrypted or replaced with a placeholder.
      let decryptedMsg: Message;
      try {
        decryptedMsg = await decryptSingleDMMessage(dmChannelId, message, dmChannel as any);
      } catch {
        decryptedMsg = { ...message, content: ENCRYPTED_PLACEHOLDER };
      }
      if (decryptedMsg.replyTo?.content && isChannelEncrypted(dmChannelId)) {
        try {
          const originalReplyContent = decryptedMsg.replyTo.content;
          const decryptedReply = await decryptDMContent(dmChannelId, originalReplyContent, true, decryptedMsg.replyTo.authorId, decryptedMsg.replyTo.id);
          // When the reply is transiently undecryptable, preserve its
          // original ciphertext so the heal sweep can retry the preview later.
          // `content` still shows the placeholder; `_encryptedContent` is the
          // client-only stash (mirrors the parent's `_encryptedEnvelope`).
          decryptedMsg.replyTo = {
            ...decryptedMsg.replyTo,
            content: decryptedReply,
            _encryptedContent: decryptedReply === ENCRYPTED_PLACEHOLDER ? originalReplyContent : undefined,
          };
        } catch { /* reply decrypt failed, show as-is */ }
      }
      void encrypted;

      // Dedup early so we don't waste a buffered slot on already-known messages.
      // addDmMessageBatch also dedupes inside the store, but checking here lets us
      // skip the search-index insert too.
      const existingMsgs = useMessageStore.getState().dmMessages[dmChannelId];
      if (existingMsgs?.some((m) => m.id === message.id)) return;

      // Per-message side effects that must happen synchronously / can't batch:
      if (message.authorId !== currentUserId) {
        import('../services/dmSearchIndex').then(m => m.addMessageToIndex(dmChannelId, decryptedMsg)).catch(() => {});
      }

      // Immediate: lastMessage preview, unread/mention badge, sound — must
      // not be deferred by the 5s hidden-tab batcher below.
      applyDmNotification(dmChannelId, message, decryptedMsg);

      dmBufferRef.current.push({ dmChannelId, message, decryptedMsg });
      if (dmRafRef.current) return;
      if (isAppVisible()) {
        dmRafRef.current = requestAnimationFrame(flushDmBatch);
      } else {
        // When hidden, batch on a 5s timer (matches channel handler).
        dmRafRef.current = window.setTimeout(flushDmBatch, 5000) as unknown as number;
      }
    });

    socketService.onDmSystemMessage((dmChannelId, message) => {
      if (typeof dmChannelId !== 'string' || !dmChannelId || !message?.id || typeof message.id !== 'string') return;
      if (!useDmStore.getState().dmChannels.some((ch) => ch.id === dmChannelId)) return;
      deferStoreUpdate(() => {
        useMessageStore.getState().addDmMessage(dmChannelId, message);
      });
    });

    socketService.onDmSystemMessageUpdated((data) => {
      // Mutates an existing system DM message in place (e.g., gift card flips
      // to "Claimed" state when the recipient redeems). Server only emits the
      // updated systemPayload, never user-authored content — same E2EE-safe
      // pattern as the gift card insert.
      if (!data?.id || typeof data.id !== 'string') return;
      if (typeof data.dmChannelId !== 'string' || !data.dmChannelId) return;
      if (!useDmStore.getState().dmChannels.some((ch) => ch.id === data.dmChannelId)) return;
      deferStoreUpdate(() => {
        useMessageStore.getState().updateDmMessage(data.dmChannelId, data.id, (m) => ({
          ...m,
          systemPayload: { ...(m.systemPayload || {}), ...data.systemPayload },
        }));
      });
    });

    socketService.onDmMessagePinned((dmChannelId, messageId) => {
      if (typeof dmChannelId !== 'string' || !dmChannelId || typeof messageId !== 'string' || !messageId) return;
      if (!useDmStore.getState().dmChannels.some((ch) => ch.id === dmChannelId)) return;
      deferStoreUpdate(() => {
        useMessageStore.getState().addDmPinnedId(dmChannelId, messageId);
      });
    });

    socketService.onDmMessageUnpinned((dmChannelId, messageId) => {
      if (typeof dmChannelId !== 'string' || !dmChannelId || typeof messageId !== 'string' || !messageId) return;
      if (!useDmStore.getState().dmChannels.some((ch) => ch.id === dmChannelId)) return;
      // Combine 3 sequential set() calls into a single _setAll batch — `deferStoreUpdate`
      // is a no-op passthrough, so individual setter calls produced N renders.
      const msgState = useMessageStore.getState();
      const list = msgState.dmMessages[dmChannelId] ?? [];
      const pinSystemMsg = list.find(
        (m) => m.type === 'system' && m.systemPayload?.kind === 'pin' && m.systemPayload?.messageId === messageId,
      );
      const pinnedIds = msgState.dmPinnedMessageIds[dmChannelId];
      msgState._setAll({
        ...(pinSystemMsg
          ? { dmMessages: { ...msgState.dmMessages, [dmChannelId]: list.filter((m) => m.id !== pinSystemMsg.id) } }
          : {}),
        ...(pinnedIds && pinnedIds.includes(messageId)
          ? { dmPinnedMessageIds: { ...msgState.dmPinnedMessageIds, [dmChannelId]: pinnedIds.filter((id) => id !== messageId) } }
          : {}),
        dmPinnedVersion: msgState.dmPinnedVersion + 1,
      });
    });

    socketService.onDMMessageDeleted((dmChannelId, messageId) => {
      // Validate payload shape and DM channel membership
      if (typeof dmChannelId !== 'string' || !dmChannelId || typeof messageId !== 'string' || !messageId) return;
      if (!useDmStore.getState().dmChannels.some((ch) => ch.id === dmChannelId)) return;
      // Honor "delete for everyone" locally — drop the at-rest plaintext for
      // this message (and any retained edit revisions). Idempotent; needs no key.
      void mlsGroupStore.deleteHistory(dmChannelId, messageId).catch(() => {});
      // Also purge the row from the server-side cross-device archive so a
      // restore on another device can't resurrect a message the peer (or this user
      // on another device) deleted for everyone. Best-effort, MLS-only, idempotent.
      if (isChannelMls(dmChannelId)) {
        void apiClient.deleteDmHistoryArchiveMessage(dmChannelId, messageId).catch(() => {});
      }
      import('../services/dmSearchIndex').then(m => m.removeMessageFromIndex(messageId)).catch(() => {});
      const msgState = useMessageStore.getState();
      const messages = msgState.dmMessages[dmChannelId];
      const pinnedIds = msgState.dmPinnedMessageIds[dmChannelId];
      msgState._setAll({
        ...(messages
          ? { dmMessages: { ...msgState.dmMessages, [dmChannelId]: messages.filter((m) => m.id !== messageId) } }
          : {}),
        ...(pinnedIds && pinnedIds.includes(messageId)
          ? { dmPinnedMessageIds: { ...msgState.dmPinnedMessageIds, [dmChannelId]: pinnedIds.filter((id) => id !== messageId) } }
          : {}),
        dmPinnedVersion: msgState.dmPinnedVersion + 1,
      });
    });

    socketService.onDMMessageUpdated(async (dmChannelId, messageId, content, editedAt, _encrypted, authorId) => {
      // Validate payload shape and DM channel membership
      if (typeof dmChannelId !== 'string' || !dmChannelId || typeof messageId !== 'string' || !messageId) return;
      if (!useDmStore.getState().dmChannels.some((ch) => ch.id === dmChannelId)) return;
      // Decrypt envelope content defensively — never trust `_encrypted` alone,
      // since state mismatches can leave envelopes flowing through with the flag false.
      const displayContent = await decryptDMContent(dmChannelId, content, true, authorId, messageId);
      // The edit funnel must re-stamp the heal flags off the EDIT's
      // decrypt result, not leave whatever the original arrival left. Otherwise a
      // message that was undecryptable on arrival (stale _encryptedEnvelope = the
      // ORIGINAL ciphertext) keeps that flag after the edit decrypts, and the
      // useMlsRedecrypt sweep later reconstructs from the original envelope and
      // silently reverts the edit. On success: clear the flags so the sweep skips
      // it. On failure: stamp undecryptable and preserve the NEW edit ciphertext
      // so the sweep retries the current envelope (never the stale original).
      const undecryptable = displayContent === ENCRYPTED_PLACEHOLDER;
      import('../services/dmSearchIndex').then(m => m.updateMessageInIndex(messageId, displayContent)).catch(() => {});
      deferStoreUpdate(() => {
        useMessageStore.getState().updateDmMessage(dmChannelId, messageId, (m) => {
          if (m.editedAt && editedAt) {
            const localTime = new Date(m.editedAt).getTime();
            const remoteTime = new Date(editedAt).getTime();
            if (!isNaN(localTime) && !isNaN(remoteTime) && localTime >= remoteTime) return m;
          }
          return {
            ...m,
            content: displayContent,
            editedAt,
            undecryptable,
            _encryptedEnvelope: undecryptable ? content : undefined,
          };
        });
      });
    });

    socketService.onNewDmChannel((data) => {
      if (typeof data?.id !== 'string' || !data.id) return;
      const dmStore = useDmStore.getState();
      const existing = dmStore.dmChannels.some((ch) => ch.id === data.id);
      if (!existing) {
        deferStoreUpdate(() => {
          dmStore.addDmChannel({
            id: data.id,
            isGroup: data.isGroup,
            otherUser: data.otherUser,
            otherUsers: data.otherUsers,
            encrypted: data.encrypted,
            ownerId: data.ownerId ?? null,
            mlsGroupId: data.mlsGroupId ?? null,
            otrMlsGroupId: data.otrMlsGroupId ?? null,
          });
        });
      }
      socketService.joinDM(data.id);
    });

    socketService.onDmParticipantLeft(({ dmChannelId, userId: leftUserId }) => {
      deferStoreUpdate(() => {
        useDmStore.getState().updateDmChannel(dmChannelId, (ch) => {
          if (!ch.isGroup) return ch;
          return {
            ...ch,
            otherUsers: ch.otherUsers?.filter((u) => u.id !== leftUserId),
          };
        });
      });
    });

    socketService.onDmRemovedFromGroup(({ dmChannelId }) => {
      useDmStore.getState().removeDmChannel(dmChannelId);
      const navStore = useNavigationStore.getState();
      if (navStore.activeDmChannelId === dmChannelId) {
        navStore.setActiveDmChannelId(null);
        navStore.setActiveServerId('dm');
      }
    });

    socketService.onDmParticipantRemoved(({ dmChannelId, userId: removedId }) => {
      useDmStore.getState().updateDmChannel(dmChannelId, (ch) => ({
        ...ch,
        otherUsers: ch.otherUsers?.filter((u) => u.id !== removedId),
      }));
    });

    socketService.onDmGroupOwnerChanged(({ dmChannelId, ownerId }) => {
      useDmStore.getState().updateDmChannel(dmChannelId, (ch) => ({ ...ch, ownerId }));
    });

    socketService.onDmParticipantsAdded(({ dmChannelId, newMembers }) => {
      deferStoreUpdate(() => {
        useDmStore.getState().updateDmChannel(dmChannelId, (ch) => {
          if (!ch.isGroup) return ch;
          const existingIds = new Set(ch.otherUsers?.map(u => u.id) ?? []);
          const toAdd = newMembers
            .filter(m => !existingIds.has(m.id) && m.id !== currentUserId)
            .map(m => ({ ...m, avatar: m.avatar ?? undefined }));
          if (toAdd.length === 0) return ch;
          return { ...ch, otherUsers: [...(ch.otherUsers ?? []), ...toAdd] };
        });
      });
    });

    socketService.onDmMessageReactionUpdate((dmChannelId, messageId, reactions) => {
      deferStoreUpdate(() => {
        useMessageStore.getState().updateDmMessage(dmChannelId, messageId, (m) => ({ ...m, reactions }));
      });
    });

    socketService.onDmGroupUpdated(({ dmChannelId, name, icon }) => {
      if (typeof dmChannelId !== 'string' || !dmChannelId) return;
      if (!useDmStore.getState().dmChannels.some((ch) => ch.id === dmChannelId)) return;
      deferStoreUpdate(() => {
        useDmStore.getState().updateDmChannel(dmChannelId, (ch) => ({
          ...ch,
          ...(name !== undefined && { name }),
          ...(icon !== undefined && { icon }),
        }));
      });
    });

    socketService.onDmMention(({ dmChannelId, mentionUserIds }) => {
      if (!currentUserId || !mentionUserIds.includes(currentUserId)) return;
      if (dmChannelId === useNavigationStore.getState().activeDmChannelId) return;
      deferStoreUpdate(() => {
        useNotificationStore.getState().incrementDmMention(dmChannelId);
      });
    });

    socketService.onDmReadState(({ dmChannelId, markedUnread }) => {
      deferStoreUpdate(() => {
        if (markedUnread) {
          useNotificationStore.getState().addUnreadDmChannel(dmChannelId);
        } else {
          useNotificationStore.getState().removeUnreadDmChannel(dmChannelId);
          useNotificationStore.getState().clearDmMention(dmChannelId);
        }
      });
    });

    return () => {
      unsubVis();
      socketService.offNewDMMessage();
      socketService.offDmSystemMessage();
      socketService.offDmSystemMessageUpdated();
      socketService.offDmMessagePinned();
      socketService.offDmMessageUnpinned();
      socketService.offDMMessageDeleted();
      socketService.offDMMessageUpdated();
      socketService.offNewDmChannel();
      socketService.offDmParticipantLeft();
      socketService.offDmRemovedFromGroup();
      socketService.offDmParticipantRemoved();
      socketService.offDmGroupOwnerChanged();
      socketService.offDmParticipantsAdded();
      socketService.offDmMessageReactionUpdate();
      socketService.offDmGroupUpdated();
      socketService.offDmMention?.();
      socketService.offDmReadState?.();
      cancelAnimationFrame(dmRafRef.current);
      clearTimeout(dmRafRef.current);
      dmBufferRef.current.length = 0;
      dmRafRef.current = 0;
    };
  }, [currentUserId]);

  // Block / unblock handlers
  useEffect(() => {
    if (!currentUserId) return;

    socketService.onDmBlocked(({ dmChannelIds }) => {
      if (!Array.isArray(dmChannelIds)) return;
      deferStoreUpdate(() => {
        const dmStore = useDmStore.getState();
        for (const channelId of dmChannelIds) {
          const ch = useDmStore.getState().dmChannels.find((c) => c.id === channelId);
          if (!ch) continue;
          // For 1:1 DMs, the other user is the one who blocked us (event is sent TO the blocked user)
          if (!ch.isGroup) {
            dmStore.updateDmChannel(channelId, (c) => ({ ...c, blockedByThem: true }));
            dmStore.setDmBlockStatus(channelId, { ...dmStore.dmBlockStatus[channelId], blockedByThem: true });
          }
          // For group DMs, we don't know who blocked — mark stale so next fetch corrects it
        }
      });
    });

    socketService.onDmUnblocked(({ dmChannelIds }) => {
      if (!Array.isArray(dmChannelIds)) return;
      deferStoreUpdate(() => {
        const dmStore = useDmStore.getState();
        for (const channelId of dmChannelIds) {
          const ch = useDmStore.getState().dmChannels.find((c) => c.id === channelId);
          if (!ch) continue;
          if (!ch.isGroup) {
            // For 1:1 DMs, the other user unblocked us
            dmStore.updateDmChannel(channelId, (c) => ({ ...c, blockedByThem: false }));
            dmStore.setDmBlockStatus(channelId, { ...dmStore.dmBlockStatus[channelId], blockedByThem: false });
          } else {
            // For group DMs, clear blocked participants — the unblock event means
            // someone unblocked us, so clear stale entries. Next fetch will correct if needed.
            dmStore.updateDmChannel(channelId, (c) => ({ ...c, blockedParticipantIds: [] }));
            dmStore.setDmBlockStatus(channelId, { ...dmStore.dmBlockStatus[channelId], blockedParticipantIds: [] });
          }
        }
      });
    });

    return () => {
      socketService.offDmBlocked();
      socketService.offDmUnblocked();
    };
  }, [currentUserId]);

  // Legacy DM upgraded to E2E — flip the local encryption ratchet so the
  // shield icon appears immediately and subsequent sends route through the
  // E2E path.
  useEffect(() => {
    if (!currentUserId) return;
    socketService.onDmEncryptionUpgraded(({ dmChannelId }) => {
      setChannelEncryptionStatus(dmChannelId, true);
      useDmStore.getState().updateDmChannel(dmChannelId, (ch) => ({ ...ch, encrypted: true }));
    });
    return () => {
      socketService.offDmEncryptionUpgraded();
    };
  }, [currentUserId]);

  // A DM partner performed a full encryption reset. NEVER clear a pin here (a
  // server-triggerable event must not weaken TOFU) — just re-attempt establish on the
  // shared MLS channels so the key change surfaces the accept prompt through the
  // normal validation path (or records peer-unprovisioned until they re-set-up,
  // which the presence retry then heals).
  useEffect(() => {
    if (!currentUserId) return;
    socketService.onDmEncryptionReset(({ userId }) => {
      if (!userId || typeof userId !== 'string') return;
      // Our own reset (this or another device): the resetting device already tore its
      // local state down, and other own-devices can't act on a vault that no longer
      // exists server-side — nothing safe to do here.
      if (userId === currentUserId) return;
      const channels = useDmStore.getState().dmChannels;
      for (const ch of channels) {
        const involvesUser = ch.isGroup
          ? !!ch.otherUsers?.some((u) => u.id === userId)
          : ch.otherUser?.id === userId;
        if (!involvesUser || !isChannelMls(ch.id)) continue;
        if (mlsCoordinator.isReadyForChannel(ch.id)) continue;
        const onErr = (err: unknown) => routeEstablishOutcome(ch.id, err);
        if (ch.isGroup) {
          if (!ch.mlsGroupId) continue; // rowless group DMs are joiner-only (no group to establish yet)
          void mlsCoordinator.establishGroupDmChannel(ch.id, ch.mlsGroupId).catch(onErr);
        } else {
          void mlsCoordinator.establishChannel(ch.id, userId, ch.mlsGroupId).catch(onErr);
        }
      }
    });
    return () => {
      socketService.offDmEncryptionReset();
    };
  }, [currentUserId]);

}
