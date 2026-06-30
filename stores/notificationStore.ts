// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';
import type { ServerNotification } from '../types';

const MAX_SERVER_NOTIFICATIONS = 200;

interface NotificationState {
  serverMentionCounts: Record<string, number>;
  serverUnreadIds: Set<string>;
  channelUnreadIds: Set<string>;
  channelMentionCounts: Record<string, number>;
  channelLastReadAt: Record<string, string>;
  threadMentionCounts: Record<string, number>;
  dmUnreadCounts: Record<string, number>;
  dmMentionCounts: Record<string, number>;
  unreadDmChannelIds: Set<string>;
  // OTR DM unreads (parallel to Saved, bare-id keyed). Kept separate so every
  // aggregate reading unreadDmChannelIds / dmUnreadCounts keeps counting Saved
  // unread only. Drives the two-color row dot.
  otrDmUnreadCounts: Record<string, number>;
  otrUnreadDmChannelIds: Set<string>;
  notificationCounts: { total: number; byServer: Record<string, { mentionCount: number; unreadCount: number }> };
  serverNotifications: ServerNotification[];
  pendingFriendRequestCount: number;
  calendarDotState: Record<string, 'live' | 'soon' | 'change'>;
  /** Per-post forum unread (post IDs with unseen replies since this session). */
  forumPostUnreadIds: Set<string>;

  // Server mentions
  incrementServerMention(serverId: string): void;
  setServerMentionCount(serverId: string, count: number): void;
  clearServerMention(serverId: string): void;
  setServerMentionCounts(counts: Record<string, number>): void;

  // Server unreads
  addServerUnread(serverId: string): void;
  removeServerUnread(serverId: string): void;
  setServerUnreadIds(ids: Set<string>): void;

  // Channel unreads
  addChannelUnread(channelId: string): void;
  removeChannelUnread(channelId: string): void;
  setChannelUnreadIds(ids: Set<string>): void;

  // Channel mentions
  incrementChannelMention(channelId: string): void;
  clearChannelMention(channelId: string): void;
  setChannelMentionCounts(counts: Record<string, number>): void;

  // Channel last-read tracking
  setChannelLastReadAt: (channelId: string, timestamp: string | null) => void;
  clearChannelLastReadAt: (channelId: string) => void;

  // Thread mentions
  incrementThreadMention(threadId: string): void;
  clearThreadMention(threadId: string): void;
  setThreadMentionCounts(counts: Record<string, number>): void;

  // DM unreads
  incrementDmUnread(dmChannelId: string): void;
  clearDmUnread(dmChannelId: string): void;
  setDmUnreadCounts(counts: Record<string, number>): void;

  // DM mentions
  incrementDmMention(dmChannelId: string): void;
  clearDmMention(dmChannelId: string): void;
  setDmMentionCounts(counts: Record<string, number>): void;

  // Unread DM channel IDs
  addUnreadDmChannel(channelId: string): void;
  removeUnreadDmChannel(channelId: string): void;
  setUnreadDmChannelIds(ids: Set<string>): void;

  // OTR DM unreads
  incrementOtrDmUnread(dmChannelId: string): void;
  clearOtrDmUnread(dmChannelId: string): void;
  addOtrUnreadDmChannel(dmChannelId: string): void;
  removeOtrUnreadDmChannel(dmChannelId: string): void;

  // Notification counts
  setNotificationCounts(counts: NotificationState['notificationCounts'] | ((prev: NotificationState['notificationCounts']) => NotificationState['notificationCounts'])): void;

  // Server notifications
  setServerNotifications(notifications: ServerNotification[] | ((prev: ServerNotification[]) => ServerNotification[])): void;
  addServerNotification(notification: ServerNotification): void;
  removeServerNotification(id: string): void;

  // Friend requests
  setPendingFriendRequestCount(count: number): void;
  incrementPendingFriendRequests(): void;
  decrementPendingFriendRequests(): void;

  // Calendar dots
  setCalendarDotState(state: Record<string, 'live' | 'soon' | 'change'> | ((prev: Record<string, 'live' | 'soon' | 'change'>) => Record<string, 'live' | 'soon' | 'change'>)): void;

  // Forum per-post unread (session-scoped — cleared on reload)
  addForumPostUnread(postId: string): void;
  clearForumPostUnread(postId: string): void;

  // Bulk setter for bridge
  _setAll(partial: Partial<Pick<NotificationState, 'serverMentionCounts' | 'serverUnreadIds' | 'channelUnreadIds' | 'channelMentionCounts' | 'channelLastReadAt' | 'threadMentionCounts' | 'dmUnreadCounts' | 'dmMentionCounts' | 'unreadDmChannelIds' | 'otrDmUnreadCounts' | 'otrUnreadDmChannelIds' | 'notificationCounts' | 'serverNotifications' | 'pendingFriendRequestCount' | 'calendarDotState' | 'forumPostUnreadIds'>>): void;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  serverMentionCounts: {},
  serverUnreadIds: new Set(),
  channelUnreadIds: new Set(),
  channelMentionCounts: {},
  channelLastReadAt: {},
  threadMentionCounts: {},
  dmUnreadCounts: {},
  dmMentionCounts: {},
  unreadDmChannelIds: new Set(),
  otrDmUnreadCounts: {},
  otrUnreadDmChannelIds: new Set(),
  notificationCounts: { total: 0, byServer: {} },
  serverNotifications: [],
  pendingFriendRequestCount: 0,
  calendarDotState: {},
  forumPostUnreadIds: new Set(),

  // Server mentions
  incrementServerMention(serverId) {
    set(state => ({
      serverMentionCounts: {
        ...state.serverMentionCounts,
        [serverId]: (state.serverMentionCounts[serverId] ?? 0) + 1,
      },
    }));
  },
  setServerMentionCount(serverId, count) {
    if (count <= 0) {
      set(state => {
        const { [serverId]: _, ...rest } = state.serverMentionCounts;
        return { serverMentionCounts: rest };
      });
    } else {
      set(state => ({ serverMentionCounts: { ...state.serverMentionCounts, [serverId]: count } }));
    }
  },
  clearServerMention(serverId) {
    set(state => {
      const { [serverId]: _, ...rest } = state.serverMentionCounts;
      return { serverMentionCounts: rest };
    });
  },
  setServerMentionCounts(counts) { set({ serverMentionCounts: counts }); },

  // Server unreads (new Set on every mutation)
  addServerUnread(serverId) {
    set(state => {
      if (state.serverUnreadIds.has(serverId)) return state;
      const next = new Set(state.serverUnreadIds);
      next.add(serverId);
      return { serverUnreadIds: next };
    });
  },
  removeServerUnread(serverId) {
    set(state => {
      if (!state.serverUnreadIds.has(serverId)) return state;
      const next = new Set(state.serverUnreadIds);
      next.delete(serverId);
      return { serverUnreadIds: next };
    });
  },
  setServerUnreadIds(ids) { set({ serverUnreadIds: ids }); },

  // Channel unreads
  addChannelUnread(channelId) {
    set(state => {
      if (state.channelUnreadIds.has(channelId)) return state;
      const next = new Set(state.channelUnreadIds);
      next.add(channelId);
      return { channelUnreadIds: next };
    });
  },
  removeChannelUnread(channelId) {
    set(state => {
      if (!state.channelUnreadIds.has(channelId)) return state;
      const next = new Set(state.channelUnreadIds);
      next.delete(channelId);
      return { channelUnreadIds: next };
    });
  },
  setChannelUnreadIds(ids) { set({ channelUnreadIds: ids }); },
  setChannelLastReadAt(channelId: string, timestamp: string | null) {
    if (!timestamp) return;
    set(state => ({
      channelLastReadAt: { ...state.channelLastReadAt, [channelId]: timestamp },
    }));
  },
  clearChannelLastReadAt(channelId: string) {
    set(state => {
      const next = { ...state.channelLastReadAt };
      delete next[channelId];
      return { channelLastReadAt: next };
    });
  },

  // Channel mentions
  incrementChannelMention(channelId) {
    set(state => ({
      channelMentionCounts: {
        ...state.channelMentionCounts,
        [channelId]: (state.channelMentionCounts[channelId] ?? 0) + 1,
      },
    }));
  },
  clearChannelMention(channelId) {
    set(state => {
      const { [channelId]: _, ...rest } = state.channelMentionCounts;
      return { channelMentionCounts: rest };
    });
  },
  setChannelMentionCounts(counts) { set({ channelMentionCounts: counts }); },

  // Thread mentions
  incrementThreadMention(threadId) {
    set(state => ({
      threadMentionCounts: {
        ...state.threadMentionCounts,
        [threadId]: (state.threadMentionCounts[threadId] ?? 0) + 1,
      },
    }));
  },
  clearThreadMention(threadId) {
    set(state => {
      const { [threadId]: _, ...rest } = state.threadMentionCounts;
      return { threadMentionCounts: rest };
    });
  },
  setThreadMentionCounts(counts) { set({ threadMentionCounts: counts }); },

  // DM unreads
  incrementDmUnread(dmChannelId) {
    set(state => ({
      dmUnreadCounts: {
        ...state.dmUnreadCounts,
        [dmChannelId]: (state.dmUnreadCounts[dmChannelId] ?? 0) + 1,
      },
    }));
  },
  clearDmUnread(dmChannelId) {
    set(state => {
      const { [dmChannelId]: _, ...rest } = state.dmUnreadCounts;
      return { dmUnreadCounts: rest };
    });
  },
  setDmUnreadCounts(counts) { set({ dmUnreadCounts: counts }); },

  // DM mentions
  incrementDmMention(dmChannelId) {
    set(state => ({
      dmMentionCounts: {
        ...state.dmMentionCounts,
        [dmChannelId]: (state.dmMentionCounts[dmChannelId] ?? 0) + 1,
      },
    }));
  },
  clearDmMention(dmChannelId) {
    set(state => {
      const { [dmChannelId]: _, ...rest } = state.dmMentionCounts;
      return { dmMentionCounts: rest };
    });
  },
  setDmMentionCounts(counts) { set({ dmMentionCounts: counts }); },

  // Unread DM channel IDs
  addUnreadDmChannel(channelId) {
    set(state => {
      if (state.unreadDmChannelIds.has(channelId)) return state;
      const next = new Set(state.unreadDmChannelIds);
      next.add(channelId);
      return { unreadDmChannelIds: next };
    });
  },
  removeUnreadDmChannel(channelId) {
    set(state => {
      if (!state.unreadDmChannelIds.has(channelId)) return state;
      const next = new Set(state.unreadDmChannelIds);
      next.delete(channelId);
      return { unreadDmChannelIds: next };
    });
  },
  setUnreadDmChannelIds(ids) { set({ unreadDmChannelIds: ids }); },

  // OTR DM unreads
  incrementOtrDmUnread(dmChannelId) {
    set(state => ({
      otrDmUnreadCounts: {
        ...state.otrDmUnreadCounts,
        [dmChannelId]: (state.otrDmUnreadCounts[dmChannelId] ?? 0) + 1,
      },
    }));
  },
  clearOtrDmUnread(dmChannelId) {
    set(state => {
      const { [dmChannelId]: _, ...rest } = state.otrDmUnreadCounts;
      return { otrDmUnreadCounts: rest };
    });
  },
  addOtrUnreadDmChannel(dmChannelId) {
    set(state => {
      if (state.otrUnreadDmChannelIds.has(dmChannelId)) return state;
      const next = new Set(state.otrUnreadDmChannelIds);
      next.add(dmChannelId);
      return { otrUnreadDmChannelIds: next };
    });
  },
  removeOtrUnreadDmChannel(dmChannelId) {
    set(state => {
      if (!state.otrUnreadDmChannelIds.has(dmChannelId)) return state;
      const next = new Set(state.otrUnreadDmChannelIds);
      next.delete(dmChannelId);
      return { otrUnreadDmChannelIds: next };
    });
  },

  // Notification counts
  setNotificationCounts(counts) {
    if (typeof counts === 'function') set((state) => ({ notificationCounts: (counts as (prev: NotificationState['notificationCounts']) => NotificationState['notificationCounts'])(state.notificationCounts) }));
    else set({ notificationCounts: counts });
  },

  // Server notifications
  setServerNotifications(notifications) {
    if (typeof notifications === 'function') set((state) => ({ serverNotifications: (notifications as (prev: ServerNotification[]) => ServerNotification[])(state.serverNotifications) }));
    else set({ serverNotifications: notifications });
  },
  addServerNotification(notification) {
    set(state => {
      const next = [...state.serverNotifications, notification];
      return { serverNotifications: next.length > MAX_SERVER_NOTIFICATIONS ? next.slice(-MAX_SERVER_NOTIFICATIONS) : next };
    });
  },
  removeServerNotification(id) {
    set(state => ({
      serverNotifications: state.serverNotifications.filter(n => n.id !== id),
    }));
  },

  // Friend requests
  setPendingFriendRequestCount(count) { set({ pendingFriendRequestCount: count }); },
  incrementPendingFriendRequests() {
    set(state => ({ pendingFriendRequestCount: state.pendingFriendRequestCount + 1 }));
  },
  decrementPendingFriendRequests() {
    set(state => ({ pendingFriendRequestCount: Math.max(0, state.pendingFriendRequestCount - 1) }));
  },

  // Calendar dots
  setCalendarDotState(s) {
    if (typeof s === 'function') set((state) => ({ calendarDotState: (s as (prev: Record<string, 'live' | 'soon' | 'change'>) => Record<string, 'live' | 'soon' | 'change'>)(state.calendarDotState) }));
    else set({ calendarDotState: s });
  },

  // Forum per-post unread (session-scoped)
  addForumPostUnread(postId) {
    set(state => {
      if (state.forumPostUnreadIds.has(postId)) return state;
      const next = new Set(state.forumPostUnreadIds);
      next.add(postId);
      return { forumPostUnreadIds: next };
    });
  },
  clearForumPostUnread(postId) {
    set(state => {
      if (!state.forumPostUnreadIds.has(postId)) return state;
      const next = new Set(state.forumPostUnreadIds);
      next.delete(postId);
      return { forumPostUnreadIds: next };
    });
  },

  // Bulk setter
  _setAll(partial) { set(partial); },
}));
