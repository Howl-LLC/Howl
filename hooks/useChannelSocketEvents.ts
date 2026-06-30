// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef } from 'react';
import type { Message } from '../types';
import { formatUsername } from '../types';
import { socketService } from '../services/socket';
import { playMessageNotification } from '../utils/notificationSound';
import { isChannelMuted } from '../utils/mutedChannelStorage';
import { isAppVisible, onVisibilityChange } from './useAppVisible';
import { deferStoreUpdate } from '../utils/storeHelpers';
import { useMessageStore } from '../stores/messageStore';
import { useTypingStore } from '../stores/typingStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useAuthStore } from '../stores/authStore';
import { useServerStore } from '../stores/serverStore';
import { useServerFolderStore } from '../stores/serverFolderStore';

export interface UseChannelSocketEventsOpts {
  currentUserId: string | undefined;
}

/**
 * Registers channel message socket events:
 * - new-message (immediate dot/badge/sound; RAF/5s-batched message-store insert)
 * - typing indicators with auto-expiry cleanup
 * - pin/unpin, delete, update
 */
export function useChannelSocketEvents(opts: UseChannelSocketEventsOpts): void {
  const {
    currentUserId,
  } = opts;

  // RAF batching refs — internal to this hook
  const msgBufferRef = useRef<Array<{ channelId: string; message: Message }>>([]);
  const msgRafRef = useRef<number>(0);

  // New message handler with RAF batching
  useEffect(() => {
    if (!currentUserId) return;

    // Per-message notification side effects fire synchronously, even when
    // the tab is hidden. Only the message-store insert (which drives the
    // expensive Virtuoso re-measure) stays on the 5s hidden-tab timer; the
    // sidebar dot, mention badge, sound, and game overlay must not wait
    // for the flush, otherwise they're invisible until the user returns.
    const applyChannelNotification = (chId: string, msg: Message) => {
      const activeCh = useNavigationStore.getState().activeChannelId;
      const notActive = chId !== activeCh;
      const allServers = useServerStore.getState().servers;
      const serverForChannel = allServers.find((s) => s.channels.some((c) => c.id === chId));
      const serverId = serverForChannel?.id;

      // Mute gates intentionally NOT applied to the unread dot — muted
      // channels and servers in muted folders still show dots; mute only
      // suppresses sound + overlay (gated separately below). Matches DM
      // mute behavior and Discord.
      if (notActive && serverId && msg.authorId !== currentUserId) {
        const cur = useAuthStore.getState().currentUser;
        const content = (msg.content ?? '').toLowerCase();
        const myMention = cur ? '@' + formatUsername(cur).toLowerCase() : '';
        const isMention = content.includes('@everyone') || content.includes('@here') || (myMention && content.includes(myMention));
        const notifStore = useNotificationStore.getState();
        if (isMention) {
          notifStore.incrementServerMention(serverId);
          notifStore.incrementChannelMention(chId);
        } else {
          notifStore.addServerUnread(serverId);
          notifStore.addChannelUnread(chId);
        }
      }

      if (msg.authorId !== currentUserId && !isChannelMuted(chId)) {
        const isInMutedFolder = serverId ? useServerFolderStore.getState().isServerMuted(serverId) : false;
        if (isInMutedFolder) return;
        if (chId !== activeCh) {
          // Sound is throttled internally to 1 play / 2s, so per-message
          // calls don't produce sound storms during bursty arrival.
          playMessageNotification(false);
          if ((window as any).electron?.updateOverlayNotifications && serverForChannel) {
            const ch = serverForChannel.channels.find((c) => c.id === chId);
            (window as any).electron.updateOverlayNotifications({
              id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              type: 'message',
              serverName: serverForChannel.name,
              serverIcon: serverForChannel.icon ?? undefined,
              channelName: ch?.name ?? 'unknown',
              channelId: chId,
              authorName: msg.authorUsername ?? 'Unknown',
              authorAvatar: msg.authorAvatar ?? undefined,
              content: (msg.content ?? '').slice(0, 100),
              timestamp: Date.now(),
            });
          }
        } else if (document.hidden || useAuthStore.getState().currentUser?.status === 'idle') {
          playMessageNotification(true);
        }
      }
    };

    const flushBatch = () => {
      msgRafRef.current = 0;
      const batch = msgBufferRef.current.splice(0);
      if (batch.length === 0) return;

      deferStoreUpdate(() => {
        useMessageStore.getState().addChannelMessageBatch(batch);

        for (const { channelId: chId, message: msg } of batch) {
          useTypingStore.getState().clearUserTyping(chId, msg.authorId);
        }
      });
    };

    const unsubVis = onVisibilityChange((visible) => {
      if (visible && msgBufferRef.current.length > 0) {
        if (msgRafRef.current) {
          cancelAnimationFrame(msgRafRef.current);
          clearTimeout(msgRafRef.current);
          msgRafRef.current = 0;
        }
        flushBatch();
      }
    });

    socketService.onNewMessage((channelId, message) => {
      // Validate payload shape and channel membership
      if (typeof channelId !== 'string' || !channelId || !message?.id || typeof message.id !== 'string') return;
      if (!useServerStore.getState().servers.some((s) => s.channels?.some((c) => c.id === channelId))) return;

      // Immediate: dot/badge/sound/overlay — must not be deferred by the 5s
      // hidden-tab batcher below, or they're invisible until tab refocus.
      applyChannelNotification(channelId, message);

      // Batched: message-store insert (Virtuoso re-measure is the expensive
      // bit we want to skip while hidden).
      msgBufferRef.current.push({ channelId, message });
      if (msgRafRef.current) return;
      if (isAppVisible()) {
        msgRafRef.current = requestAnimationFrame(flushBatch);
      } else {
        // When hidden, batch messages on a 5s timer instead of every frame
        msgRafRef.current = window.setTimeout(flushBatch, 5000) as unknown as number;
      }
    });

    return () => {
      unsubVis();
      socketService.offNewMessage();
      cancelAnimationFrame(msgRafRef.current);
      clearTimeout(msgRafRef.current);
      msgBufferRef.current.length = 0;
      msgRafRef.current = 0;
    };
  }, [currentUserId]);

  // Typing indicator handler with auto-expiry cleanup interval
  const typingCleanupRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!currentUserId) return;
    const TYPING_TIMEOUT = 5000;

    const ensureCleanupInterval = () => {
      if (typingCleanupRef.current) return;
      typingCleanupRef.current = setInterval(() => {
        const store = useTypingStore.getState();
        store.pruneExpired();
        // Stop interval when all 3 maps are empty
        if (!store.hasAnyTyping() && typingCleanupRef.current) {
          clearInterval(typingCleanupRef.current);
          typingCleanupRef.current = null;
        }
      }, 1000);
    };

    const typingRateLimit = new Map<string, number>();
    // Per-key TTL: entries older than 2x TYPING_TIMEOUT are stale and can
    // be pruned individually. This avoids the bulk clear() that would
    // momentarily drop all rate-limit state for active typers.
    const TYPING_RL_ENTRY_TTL = TYPING_TIMEOUT * 2;

    const recordTyping = (
      key: string,
      typerUserId: string,
      username: string,
      serverId: string | undefined,
      isDm: boolean,
    ) => {
      if (!key) return;
      const rateKey = `${key}:${typerUserId}`;
      const now = Date.now();
      const lastSeen = typingRateLimit.get(rateKey) ?? 0;
      if (now - lastSeen < 500) return;
      typingRateLimit.set(rateKey, now);
      let pruned = 0;
      for (const [k, ts] of typingRateLimit) {
        if (now - ts > TYPING_RL_ENTRY_TTL) {
          typingRateLimit.delete(k);
          pruned++;
          if (pruned >= 50) break;
        } else {
          break;
        }
      }
      if (typingRateLimit.size > 5000) typingRateLimit.clear();
      const expires = now + TYPING_TIMEOUT;
      deferStoreUpdate(() => {
        useTypingStore.getState().handleTypingEvent(
          key, typerUserId, username.slice(0, 32), expires, serverId, isDm,
        );
      });
      ensureCleanupInterval();
    };

    socketService.onUserTyping((payload) => {
      if (payload.userId === currentUserId) return;
      const key = payload.channelId ?? payload.dmChannelId ?? '';
      recordTyping(
        key,
        payload.userId,
        payload.username || '',
        (payload.serverId && payload.channelId) ? payload.serverId : undefined,
        !!payload.dmChannelId,
      );
    });

    socketService.onForumPostTyping((payload) => {
      if (payload.userId === currentUserId) return;
      // Key the typing on postId so future per-post UI can read typingByChannel[postId].
      // serverId is set so the right-side server member list dot lights up.
      // Username isn't carried in this event; pass empty so handleTypingEvent stores
      // a presence-only entry — the member-list dot doesn't render the name.
      recordTyping(payload.postId, payload.userId, '', payload.serverId, false);
    });

    return () => {
      socketService.offUserTyping();
      socketService.offForumPostTyping();
      if (typingCleanupRef.current) {
        clearInterval(typingCleanupRef.current);
        typingCleanupRef.current = null;
      }
    };
  }, [currentUserId]);

  // Channel pin/unpin, delete, update handlers
  useEffect(() => {
    if (!currentUserId) return;

    socketService.onChannelMessagePinned((channelId, messageId) => {
      // Validate payload shape
      if (typeof channelId !== 'string' || !channelId || typeof messageId !== 'string' || !messageId) return;
      if (!useServerStore.getState().servers.some((s) => s.channels?.some((c) => c.id === channelId))) return;
      deferStoreUpdate(() => {
        useMessageStore.getState().addChannelPinnedId(channelId, messageId);
        useMessageStore.getState().bumpPinnedRevision();
      });
    });

    socketService.onChannelMessageUnpinned((channelId, messageId) => {
      // Validate payload shape
      if (typeof channelId !== 'string' || !channelId || typeof messageId !== 'string' || !messageId) return;
      if (!useServerStore.getState().servers.some((s) => s.channels?.some((c) => c.id === channelId))) return;
      // Combine sequential setter calls into one _setAll batch — `deferStoreUpdate`
      // is a no-op passthrough and would otherwise produce two renders.
      const msgState = useMessageStore.getState();
      const list = msgState.messages[channelId] ?? [];
      const pinSystemMsg = list.find(
        (m) => m.type === 'system' && m.systemPayload?.kind === 'pin' && m.systemPayload?.messageId === messageId,
      );
      const pinnedIds = msgState.channelPinnedMessageIds[channelId];
      msgState._setAll({
        ...(pinSystemMsg
          ? { messages: { ...msgState.messages, [channelId]: list.filter((m) => m.id !== pinSystemMsg.id) } }
          : {}),
        ...(pinnedIds && pinnedIds.includes(messageId)
          ? { channelPinnedMessageIds: { ...msgState.channelPinnedMessageIds, [channelId]: pinnedIds.filter((id) => id !== messageId) } }
          : {}),
        pinnedRevision: msgState.pinnedRevision + 1,
      });
    });

    socketService.onChannelMessageDeleted((channelId, messageId) => {
      // Validate payload shape
      if (typeof channelId !== 'string' || !channelId || typeof messageId !== 'string' || !messageId) return;
      const msgState = useMessageStore.getState();
      const messages = msgState.messages[channelId];
      const pinnedIds = msgState.channelPinnedMessageIds[channelId];
      msgState._setAll({
        ...(messages
          ? { messages: { ...msgState.messages, [channelId]: messages.filter((m) => m.id !== messageId) } }
          : {}),
        ...(pinnedIds && pinnedIds.includes(messageId)
          ? { channelPinnedMessageIds: { ...msgState.channelPinnedMessageIds, [channelId]: pinnedIds.filter((id) => id !== messageId) } }
          : {}),
      });
    });

    socketService.onChannelMessageUpdated((channelId, messageId, content, editedAt) => {
      // Validate payload shape
      if (typeof channelId !== 'string' || !channelId || typeof messageId !== 'string' || !messageId) return;
      deferStoreUpdate(() => {
        useMessageStore.getState().updateChannelMessage(channelId, messageId, (m) => {
          // Only apply if server version is newer (prevents stale overwrites)
          if (m.editedAt && editedAt) {
            const localTime = new Date(m.editedAt).getTime();
            const remoteTime = new Date(editedAt).getTime();
            if (!isNaN(localTime) && !isNaN(remoteTime) && localTime > remoteTime) return m;
          }
          return { ...m, content, editedAt };
        });
      });
    });

    socketService.onMessageReactionUpdate((channelId, messageId, reactions) => {
      // Validate payload shape
      if (typeof channelId !== 'string' || !channelId || typeof messageId !== 'string' || !messageId) return;
      // Validate channel membership
      if (!useServerStore.getState().servers.some(s => s.channels?.some(c => c.id === channelId))) return;
      deferStoreUpdate(() => {
        useMessageStore.getState().updateChannelMessage(channelId, messageId, (m) => ({ ...m, reactions }));
      });
    });

    return () => {
      socketService.offChannelMessagePinned();
      socketService.offChannelMessageUnpinned();
      socketService.offChannelMessageDeleted();
      socketService.offChannelMessageUpdated();
      socketService.offMessageReactionUpdate();
    };
  }, [currentUserId]);
}
