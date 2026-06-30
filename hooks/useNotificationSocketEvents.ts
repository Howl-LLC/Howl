// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, type RefObject } from 'react';
import type { User, Server } from '../types';
import { socketService } from '../services/socket';
import { deferStoreUpdate } from '../utils/storeHelpers';
import { useNotificationStore } from '../stores/notificationStore';
import { useNavigationStore } from '../stores/navigationStore';
import { upsertGroupedNotification } from '../utils/notificationGrouping';

/**
 * Registers socket events for notification-related real-time updates:
 * - server-channel-activity: mention badge / unread dot from backend
 * - channel-read-state: cross-tab sync for mark unread / mark read
 * - notification-created: increment badge counts
 * - notification-read-sync: clear badge counts from other devices
 * - calendar-activity: per-server calendar dots
 */
export function useNotificationSocketEvents(opts: {
  currentUserId: string | undefined;
  activeServerIdRef: RefObject<string>;
  activeChannelIdRef: RefObject<string>;
  currentUserRef: RefObject<User | null>;
  serversRef: RefObject<Server[]>;
}): void {
  const {
    currentUserId,
    activeServerIdRef,
    activeChannelIdRef,
    currentUserRef,
    serversRef,
  } = opts;

  // Socket: server-channel-activity (real-time mention badge / unread dot from backend)
  useEffect(() => {
    if (!currentUserId) return;
    socketService.onServerChannelActivity(({ serverId, channelId, messageId: _messageId, mentionUserIds }) => {
      const sid = activeServerIdRef.current;
      const activeChId = activeChannelIdRef.current;
      const isViewingThisChannel = sid === serverId && activeChId === channelId;
      if (isViewingThisChannel) return;
      // Mute gate intentionally removed — muted servers/folders still bump the
      // unread dot (matches DM mute and Discord). Mute now only suppresses
      // sound/overlay popups, not the dot itself.
      const myId = currentUserRef.current?.id;
      if (!myId) return;
      deferStoreUpdate(() => {
        if (mentionUserIds.includes(myId) || mentionUserIds.includes('@everyone') || mentionUserIds.includes('@here')) {
          useNotificationStore.getState().incrementServerMention(serverId);
          useNotificationStore.getState().incrementChannelMention(channelId);
        } else {
          useNotificationStore.getState().addServerUnread(serverId);
          useNotificationStore.getState().addChannelUnread(channelId);
        }
      });
      // Skip in-app notifications when streamer mode has notifications suppressed
      if (document.body.classList.contains('howl-streamer-no-notif')) return;
      const server = serversRef.current.find((s) => s.id === serverId);
      const ch = server?.channels.find((c) => c.id === channelId);
      const channelName = ch?.name ?? 'a channel';
      deferStoreUpdate(() => {
        const notifs = useNotificationStore.getState().serverNotifications;
        useNotificationStore.getState().setServerNotifications(
          upsertGroupedNotification(notifs, {
            groupKey: `text_activity:${channelId}`,
            type: 'text_activity',
            username: null,
            channelName,
          }),
        );
      });
    });
    return () => socketService.offServerChannelActivity();
  }, [currentUserId]);

  // Socket: channel-read-state -- cross-tab sync for mark unread / mark read
  useEffect(() => {
    if (!currentUserId) return;
    socketService.onChannelReadState(({ channelId, markedUnread }) => {
      deferStoreUpdate(() => {
        if (markedUnread) {
          useNotificationStore.getState().addChannelUnread(channelId);
        } else {
          useNotificationStore.getState().removeChannelUnread(channelId);
          useNotificationStore.getState().clearChannelMention(channelId);
        }
      });
    });
    return () => socketService.offChannelReadState();
  }, [currentUserId]);

  // Socket: notification-created -- increment badge counts
  useEffect(() => {
    if (!currentUserId) return;
    socketService.onNotificationCreated((notification) => {
      deferStoreUpdate(() => {
        useNotificationStore.getState().setNotificationCounts((prev) => {
          const sid = notification.serverId ?? '__dm__';
          const isMention = ['mention', 'everyone', 'thread_mention'].includes(notification.type);
          const existing = prev.byServer[sid] ?? { mentionCount: 0, unreadCount: 0 };
          return {
            total: prev.total + 1,
            byServer: { ...prev.byServer, [sid]: { mentionCount: existing.mentionCount + (isMention ? 1 : 0), unreadCount: existing.unreadCount + 1 } },
          };
        });
      });
    });
    return () => socketService.offNotificationCreated();
  }, [currentUserId]);

  // Socket: notification-read-sync -- clear badge counts from other devices
  useEffect(() => {
    if (!currentUserId) return;
    socketService.onNotificationReadSync(({ serverId, all }) => {
      deferStoreUpdate(() => {
        if (all) {
          useNotificationStore.getState().setNotificationCounts({ total: 0, byServer: {} });
        } else if (serverId) {
          useNotificationStore.getState().setNotificationCounts((prev) => {
            const serverCounts = prev.byServer[serverId];
            if (!serverCounts) return prev;
            return { total: Math.max(0, prev.total - serverCounts.unreadCount), byServer: { ...prev.byServer, [serverId]: { mentionCount: 0, unreadCount: 0 } } };
          });
        }
      });
    });
    return () => socketService.offNotificationReadSync();
  }, [currentUserId]);

  // Socket: notification-delete-sync -- clear badge counts from other devices
  useEffect(() => {
    if (!currentUserId) return;
    socketService.onNotificationDeleteSync(({ serverId, all }) => {
      deferStoreUpdate(() => {
        if (all) {
          useNotificationStore.getState().setNotificationCounts({ total: 0, byServer: {} });
        } else if (serverId) {
          useNotificationStore.getState().setNotificationCounts((prev) => {
            const serverCounts = prev.byServer[serverId];
            if (!serverCounts) return prev;
            return { total: Math.max(0, prev.total - serverCounts.unreadCount), byServer: { ...prev.byServer, [serverId]: { mentionCount: 0, unreadCount: 0 } } };
          });
        }
      });
    });
    return () => socketService.offNotificationDeleteSync();
  }, [currentUserId]);

  // Socket: calendar-activity -- track per-server calendar dots
  useEffect(() => {
    if (!currentUserId) return;
    socketService.onCalendarActivity(({ serverId, type }) => {
      deferStoreUpdate(() => {
        if (type === 'ended') {
          useNotificationStore.getState().setCalendarDotState((prev) => { if (!(serverId in prev)) return prev; const next = { ...prev }; delete next[serverId]; return next; });
        } else {
          const priority: Record<string, number> = { live: 3, soon: 2, change: 1 };
          useNotificationStore.getState().setCalendarDotState((prev) => {
            const current = prev[serverId];
            if (current && (priority[current] ?? 0) >= (priority[type] ?? 0)) return prev;
            return { ...prev, [serverId]: type as 'live' | 'soon' | 'change' };
          });
        }
      });
    });
    return () => socketService.offCalendarActivity();
  }, [currentUserId]);

  // Socket: forum-post-created / forum-message-created -- forum activity dots.
  // Uses raw socket.on with named callbacks so we coexist with ForumView's own
  // listeners (which keep the post list live). The events are emitted to
  // channel:${channelId} so only users with channel access receive them
  // (auto-joined via `join-channel` on connection).
  useEffect(() => {
    if (!currentUserId) return;
    const sock = socketService.getSocket();
    if (!sock) return;
    type PostPayload = { serverId: string; channelId: string; post: { id: string; author?: { id?: string } } };
    type MsgPayload = { serverId: string; channelId: string; postId: string; message: { authorId?: string } };
    const onPostCreated = (data: PostPayload) => {
      const myId = currentUserRef.current?.id;
      if (!data?.serverId || !data?.channelId) return;
      if (data.post?.author?.id === myId) return; // don't bump for own post
      const sid = activeServerIdRef.current;
      const activeChId = activeChannelIdRef.current;
      if (sid === data.serverId && activeChId === data.channelId) return; // viewing this channel — no dot
      deferStoreUpdate(() => {
        useNotificationStore.getState().addServerUnread(data.serverId);
        useNotificationStore.getState().addChannelUnread(data.channelId);
      });
    };
    const onMessageCreated = (data: MsgPayload) => {
      const myId = currentUserRef.current?.id;
      if (!data?.serverId || !data?.channelId || !data?.postId) return;
      if (data.message?.authorId === myId) return; // don't bump for own reply
      const sid = activeServerIdRef.current;
      const activeChId = activeChannelIdRef.current;
      const activePostId = useNavigationStore.getState().activeForumPostId;
      const isViewingThisChannel = sid === data.serverId && activeChId === data.channelId;
      const isViewingThisPost = isViewingThisChannel && activePostId === data.postId;
      deferStoreUpdate(() => {
        // Per-post unread always bumps unless they're literally viewing the post
        if (!isViewingThisPost) useNotificationStore.getState().addForumPostUnread(data.postId);
        // Channel/server unread only when not in the channel at all
        if (!isViewingThisChannel) {
          useNotificationStore.getState().addServerUnread(data.serverId);
          useNotificationStore.getState().addChannelUnread(data.channelId);
        }
      });
    };
    sock.on('forum-post-created', onPostCreated);
    sock.on('forum-message-created', onMessageCreated);
    return () => {
      sock.off('forum-post-created', onPostCreated);
      sock.off('forum-message-created', onMessageCreated);
    };
  }, [currentUserId, activeServerIdRef, activeChannelIdRef, currentUserRef]);
}
