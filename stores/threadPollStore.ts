// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';
import type { Poll, Thread, ThreadMessage } from '../types';

const MAX_CACHED_THREAD_CHANNELS = 30;
const MAX_THREAD_MESSAGES_PER_THREAD = 500;

interface ThreadPollState {
  channelPolls: Record<string, Poll[]>;
  channelThreads: Record<string, Thread[]>;
  activeThread: Thread | null;
  threadMessages: Record<string, ThreadMessage[]>;
  unreadThreadIds: Set<string>;
  unreadThreadCounts: Record<string, number>;
  _threadAccessOrder: string[];

  setChannelPolls(channelId: string, polls: Poll[]): void;
  setChannelThreads(channelId: string, threads: Thread[]): void;
  setActiveThread(thread: Thread | null | ((prev: Thread | null) => Thread | null)): void;
  setThreadMessages(threadId: string, messages: ThreadMessage[]): void;
  addThreadMessage(threadId: string, message: ThreadMessage): void;
  removeThreadMessage(threadId: string, messageId: string): void;
  updateThreadMessage(threadId: string, messageId: string, updater: (msg: ThreadMessage) => ThreadMessage): void;
  addUnreadThread(threadId: string): void;
  removeUnreadThread(threadId: string): void;
  setUnreadThreadIds(ids: Set<string> | ((prev: Set<string>) => Set<string>)): void;
  setUnreadThreadCounts(counts: Record<string, number> | ((prev: Record<string, number>) => Record<string, number>)): void;
  // Raw setters for functional updater patterns (App.tsx migration)
  setChannelPollsRaw(updater: (prev: Record<string, Poll[]>) => Record<string, Poll[]>): void;
  setChannelThreadsRaw(updater: (prev: Record<string, Thread[]>) => Record<string, Thread[]>): void;
  setThreadMessagesRaw(updater: (prev: Record<string, ThreadMessage[]>) => Record<string, ThreadMessage[]>): void;

  // LRU eviction
  touchThreadChannel(channelId: string): void;
  evictStaleThreadChannels(currentChannelId: string): void;
}

export const useThreadPollStore = create<ThreadPollState>()((set) => ({
  channelPolls: {},
  channelThreads: {},
  activeThread: null,
  threadMessages: {},
  unreadThreadIds: new Set<string>(),
  unreadThreadCounts: {},
  _threadAccessOrder: [] as string[],

  setChannelPolls(channelId, polls) {
    set((state) => ({ channelPolls: { ...state.channelPolls, [channelId]: polls } }));
  },

  setChannelThreads(channelId, threads) {
    set((state) => ({ channelThreads: { ...state.channelThreads, [channelId]: threads } }));
  },

  setActiveThread(thread) {
    if (typeof thread === 'function') set((state) => ({ activeThread: (thread as (prev: Thread | null) => Thread | null)(state.activeThread) }));
    else set({ activeThread: thread });
  },

  setThreadMessages(threadId, messages) {
    set((state) => ({ threadMessages: { ...state.threadMessages, [threadId]: messages } }));
  },

  addThreadMessage(threadId, message) {
    set((state) => {
      const existing = state.threadMessages[threadId] ?? [];
      const next = [...existing, message];
      return {
        threadMessages: {
          ...state.threadMessages,
          [threadId]: next.length > MAX_THREAD_MESSAGES_PER_THREAD ? next.slice(-MAX_THREAD_MESSAGES_PER_THREAD) : next,
        },
      };
    });
  },

  removeThreadMessage(threadId, messageId) {
    set((state) => {
      const existing = state.threadMessages[threadId];
      if (!existing) return state;
      return {
        threadMessages: {
          ...state.threadMessages,
          [threadId]: existing.filter((m) => m.id !== messageId),
        },
      };
    });
  },

  updateThreadMessage(threadId, messageId, updater) {
    set((state) => {
      const existing = state.threadMessages[threadId];
      if (!existing) return state;
      return {
        threadMessages: {
          ...state.threadMessages,
          [threadId]: existing.map((m) => (m.id === messageId ? updater(m) : m)),
        },
      };
    });
  },

  addUnreadThread(threadId) {
    set((state) => {
      if (state.unreadThreadIds.has(threadId)) return state;
      const next = new Set(state.unreadThreadIds);
      next.add(threadId);
      return { unreadThreadIds: next };
    });
  },

  removeUnreadThread(threadId) {
    set((state) => {
      const next = new Set(state.unreadThreadIds);
      next.delete(threadId);
      return { unreadThreadIds: next };
    });
  },

  setUnreadThreadIds(ids) {
    if (typeof ids === 'function') set((state) => ({ unreadThreadIds: (ids as (prev: Set<string>) => Set<string>)(state.unreadThreadIds) }));
    else set({ unreadThreadIds: new Set(ids) });
  },
  setUnreadThreadCounts(counts) {
    if (typeof counts === 'function') set((state) => ({ unreadThreadCounts: (counts as (prev: Record<string, number>) => Record<string, number>)(state.unreadThreadCounts) }));
    else set({ unreadThreadCounts: counts });
  },

  // Raw setters for functional updater patterns (App.tsx migration)
  setChannelPollsRaw(updater: (prev: Record<string, Poll[]>) => Record<string, Poll[]>) {
    set((state) => ({ channelPolls: updater(state.channelPolls) }));
  },
  setChannelThreadsRaw(updater: (prev: Record<string, Thread[]>) => Record<string, Thread[]>) {
    set((state) => ({ channelThreads: updater(state.channelThreads) }));
  },
  setThreadMessagesRaw(updater: (prev: Record<string, ThreadMessage[]>) => Record<string, ThreadMessage[]>) {
    set((state) => ({ threadMessages: updater(state.threadMessages) }));
  },

  // LRU eviction
  touchThreadChannel(channelId) {
    set((state) => {
      const order = state._threadAccessOrder.filter(id => id !== channelId);
      order.push(channelId);
      return { _threadAccessOrder: order };
    });
  },

  evictStaleThreadChannels(currentChannelId) {
    set((state) => {
      const order = state._threadAccessOrder;
      if (order.length <= MAX_CACHED_THREAD_CHANNELS) return state;
      const toEvict = order.slice(0, order.length - MAX_CACHED_THREAD_CHANNELS)
        .filter(id => id !== currentChannelId);
      if (toEvict.length === 0) return state;
      const evictSet = new Set(toEvict);
      const nextPolls = { ...state.channelPolls };
      const nextThreads = { ...state.channelThreads };
      const nextMessages = { ...state.threadMessages };
      for (const id of toEvict) {
        delete nextPolls[id];
        delete nextThreads[id];
        // Thread messages are keyed by threadId, not channelId, but we can
        // derive which threads belong to evicted channels from channelThreads
        const threads = state.channelThreads[id];
        if (threads) {
          for (const t of threads) {
            delete nextMessages[t.id];
          }
        }
      }
      return {
        channelPolls: nextPolls,
        channelThreads: nextThreads,
        threadMessages: nextMessages,
        _threadAccessOrder: order.filter(id => !evictSet.has(id)),
      };
    });
  },
}));
