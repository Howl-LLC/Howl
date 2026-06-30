// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';
import type { Message } from '../types';

const MAX_MESSAGES_PER_CHANNEL = 1000;
const MAX_CACHED_CHANNELS = 30;
const MAX_CACHED_DM_CHANNELS = 30;

const capMessages = (arr: Message[]): Message[] =>
  arr.length > MAX_MESSAGES_PER_CHANNEL ? arr.slice(-MAX_MESSAGES_PER_CHANNEL) : arr;

interface MessageState {
  // Channel messages
  messages: Record<string, Message[]>;
  channelHasMore: Record<string, boolean>;
  channelPinnedMessageIds: Record<string, string[]>;
  pinnedRevision: number;
  // DM messages
  dmMessages: Record<string, Message[]>;
  dmHasMore: Record<string, boolean>;
  dmPinnedMessageIds: Record<string, string[]>;
  dmPinnedVersion: number;
  // Delete pending
  deleteMessagePending: {
    id: string;
    channelId: string;
    content: string;
    authorUsername: string;
    authorAvatar?: string | null;
    createdAt: string;
  } | null;

  // Internal LRU tracking (not consumed by components)
  _channelAccessOrder: string[];
  _dmAccessOrder: string[];

  // Channel message actions
  addChannelMessage(channelId: string, message: Message): void;
  addChannelMessageBatch(batch: Array<{ channelId: string; message: Message }>): void;
  setChannelMessages(channelId: string, messages: Message[], hasMore: boolean): void;
  removeChannelMessage(channelId: string, messageId: string): void;
  updateChannelMessage(channelId: string, messageId: string, updater: (msg: Message) => Message): void;
  touchChannel(channelId: string): void;
  evictStaleChannels(currentChannelId: string): void;
  setChannelHasMore(channelId: string, hasMore: boolean): void;
  setChannelPinnedIds(channelId: string, ids: string[]): void;
  addChannelPinnedId(channelId: string, messageId: string): void;
  removeChannelPinnedId(channelId: string, messageId: string): void;
  bumpPinnedRevision(): void;

  // DM message actions
  addDmMessage(dmChannelId: string, message: Message): void;
  addDmMessageBatch(batch: Array<{ dmChannelId: string; message: Message }>): void;
  setDmMessages(dmChannelId: string, messages: Message[], hasMore: boolean): void;
  removeDmMessage(dmChannelId: string, messageId: string): void;
  updateDmMessage(dmChannelId: string, messageId: string, updater: (msg: Message) => Message): void;
  touchDmChannel(dmChannelId: string): void;
  evictStaleDmChannels(currentDmChannelId: string | null): void;
  setDmHasMore(dmChannelId: string, hasMore: boolean): void;
  setDmPinnedIds(dmChannelId: string, ids: string[]): void;
  addDmPinnedId(dmChannelId: string, messageId: string): void;
  removeDmPinnedId(dmChannelId: string, messageId: string): void;
  bumpDmPinnedVersion(): void;

  // Delete pending
  setDeleteMessagePending(val: MessageState['deleteMessagePending']): void;

  // Bulk setter for bridge sync
  _setAll(partial: Partial<Pick<MessageState, 'messages' | 'channelHasMore' | 'channelPinnedMessageIds' | 'pinnedRevision' | 'dmMessages' | 'dmHasMore' | 'dmPinnedMessageIds' | 'dmPinnedVersion' | 'deleteMessagePending'>>): void;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: {},
  channelHasMore: {},
  channelPinnedMessageIds: {},
  pinnedRevision: 0,
  dmMessages: {},
  dmHasMore: {},
  dmPinnedMessageIds: {},
  dmPinnedVersion: 0,
  deleteMessagePending: null,
  _channelAccessOrder: [],
  _dmAccessOrder: [],

  // Channel message actions

  addChannelMessage(channelId, message) {
    set(state => {
      const existing = state.messages[channelId] ?? [];
      // Deduplicate
      if (existing.some(m => m.id === message.id)) return state;
      // Touch LRU to prevent socket-only channels from leaking memory
      const order = state._channelAccessOrder.filter(id => id !== channelId);
      order.push(channelId);
      return {
        messages: {
          ...state.messages,
          [channelId]: capMessages([...existing, message]),
        },
        _channelAccessOrder: order,
      };
    });
  },

  addChannelMessageBatch(batch) {
    if (batch.length === 0) return;
    set(state => {
      const next = { ...state.messages };
      let changed = false;
      // Touch LRU to prevent socket-only channels from leaking memory
      const order = [...state._channelAccessOrder];
      for (const { channelId, message } of batch) {
        const existing = next[channelId] ?? [];
        if (existing.some(m => m.id === message.id)) continue;
        next[channelId] = capMessages([...existing, message]);
        changed = true;
        const idx = order.indexOf(channelId);
        if (idx !== -1) order.splice(idx, 1);
        order.push(channelId);
      }
      return changed ? { messages: next, _channelAccessOrder: order } : state;
    });
  },

  setChannelMessages(channelId, messages, hasMore) {
    set(state => ({
      messages: { ...state.messages, [channelId]: messages },
      channelHasMore: { ...state.channelHasMore, [channelId]: hasMore },
    }));
  },

  removeChannelMessage(channelId, messageId) {
    set(state => {
      const existing = state.messages[channelId];
      if (!existing) return state;
      const filtered = existing.filter(m => m.id !== messageId);
      if (filtered.length === existing.length) return state;
      return { messages: { ...state.messages, [channelId]: filtered } };
    });
  },

  updateChannelMessage(channelId, messageId, updater) {
    set(state => {
      const existing = state.messages[channelId];
      if (!existing) return state;
      const updated = existing.map(m => m.id === messageId ? updater(m) : m);
      return { messages: { ...state.messages, [channelId]: updated } };
    });
  },

  touchChannel(channelId) {
    set(state => {
      const order = state._channelAccessOrder.filter(id => id !== channelId);
      order.push(channelId);
      return { _channelAccessOrder: order };
    });
  },

  evictStaleChannels(currentChannelId) {
    set(state => {
      const order = state._channelAccessOrder;
      if (order.length <= MAX_CACHED_CHANNELS) return state;
      const toEvict = order.slice(0, order.length - MAX_CACHED_CHANNELS)
        .filter(id => id !== currentChannelId);
      if (toEvict.length === 0) return state;
      const evictSet = new Set(toEvict);
      const nextMessages = { ...state.messages };
      const nextHasMore = { ...state.channelHasMore };
      const nextPinned = { ...state.channelPinnedMessageIds };
      for (const id of toEvict) {
        delete nextMessages[id];
        delete nextHasMore[id];
        delete nextPinned[id];
      }
      return {
        messages: nextMessages,
        channelHasMore: nextHasMore,
        channelPinnedMessageIds: nextPinned,
        _channelAccessOrder: order.filter(id => !evictSet.has(id)),
      };
    });
  },

  setChannelHasMore(channelId, hasMore) {
    set(state => ({ channelHasMore: { ...state.channelHasMore, [channelId]: hasMore } }));
  },

  setChannelPinnedIds(channelId, ids) {
    set(state => ({ channelPinnedMessageIds: { ...state.channelPinnedMessageIds, [channelId]: ids } }));
  },

  addChannelPinnedId(channelId, messageId) {
    set(state => {
      const existing = state.channelPinnedMessageIds[channelId] ?? [];
      if (existing.includes(messageId)) return state;
      return {
        channelPinnedMessageIds: { ...state.channelPinnedMessageIds, [channelId]: [...existing, messageId] },
      };
    });
  },

  removeChannelPinnedId(channelId, messageId) {
    set(state => {
      const existing = state.channelPinnedMessageIds[channelId];
      if (!existing) return state;
      return {
        channelPinnedMessageIds: { ...state.channelPinnedMessageIds, [channelId]: existing.filter(id => id !== messageId) },
      };
    });
  },

  bumpPinnedRevision() {
    set(state => ({ pinnedRevision: state.pinnedRevision + 1 }));
  },

  // DM message actions

  addDmMessage(dmChannelId, message) {
    set(state => {
      const existing = state.dmMessages[dmChannelId] ?? [];
      if (existing.some(m => m.id === message.id)) return state;
      // Touch LRU to prevent socket-only DM channels from leaking memory
      const order = state._dmAccessOrder.filter(id => id !== dmChannelId);
      order.push(dmChannelId);
      return {
        dmMessages: {
          ...state.dmMessages,
          [dmChannelId]: capMessages([...existing, message]),
        },
        _dmAccessOrder: order,
      };
    });
  },

  addDmMessageBatch(batch) {
    if (batch.length === 0) return;
    set(state => {
      const next = { ...state.dmMessages };
      let changed = false;
      // Touch LRU to prevent socket-only DM channels from leaking memory
      const order = [...state._dmAccessOrder];
      for (const { dmChannelId, message } of batch) {
        const existing = next[dmChannelId] ?? [];
        if (existing.some(m => m.id === message.id)) continue;
        next[dmChannelId] = capMessages([...existing, message]);
        changed = true;
        const idx = order.indexOf(dmChannelId);
        if (idx !== -1) order.splice(idx, 1);
        order.push(dmChannelId);
      }
      return changed ? { dmMessages: next, _dmAccessOrder: order } : state;
    });
  },

  setDmMessages(dmChannelId, messages, hasMore) {
    set(state => ({
      dmMessages: { ...state.dmMessages, [dmChannelId]: messages },
      dmHasMore: { ...state.dmHasMore, [dmChannelId]: hasMore },
    }));
  },

  removeDmMessage(dmChannelId, messageId) {
    set(state => {
      const existing = state.dmMessages[dmChannelId];
      if (!existing) return state;
      const filtered = existing.filter(m => m.id !== messageId);
      if (filtered.length === existing.length) return state;
      return { dmMessages: { ...state.dmMessages, [dmChannelId]: filtered } };
    });
  },

  updateDmMessage(dmChannelId, messageId, updater) {
    set(state => {
      const existing = state.dmMessages[dmChannelId];
      if (!existing) return state;
      const updated = existing.map(m => m.id === messageId ? updater(m) : m);
      return { dmMessages: { ...state.dmMessages, [dmChannelId]: updated } };
    });
  },

  touchDmChannel(dmChannelId) {
    set(state => {
      const order = state._dmAccessOrder.filter(id => id !== dmChannelId);
      order.push(dmChannelId);
      return { _dmAccessOrder: order };
    });
  },

  evictStaleDmChannels(currentDmChannelId) {
    set(state => {
      const order = state._dmAccessOrder;
      if (order.length <= MAX_CACHED_DM_CHANNELS) return state;
      const toEvict = order.slice(0, order.length - MAX_CACHED_DM_CHANNELS)
        .filter(id => id !== currentDmChannelId);
      if (toEvict.length === 0) return state;
      const evictSet = new Set(toEvict);
      const nextDmMessages = { ...state.dmMessages };
      const nextDmHasMore = { ...state.dmHasMore };
      const nextDmPinned = { ...state.dmPinnedMessageIds };
      for (const id of toEvict) {
        delete nextDmMessages[id];
        delete nextDmHasMore[id];
        delete nextDmPinned[id];
      }
      return {
        dmMessages: nextDmMessages,
        dmHasMore: nextDmHasMore,
        dmPinnedMessageIds: nextDmPinned,
        _dmAccessOrder: order.filter(id => !evictSet.has(id)),
      };
    });
  },

  setDmHasMore(dmChannelId, hasMore) {
    set(state => ({ dmHasMore: { ...state.dmHasMore, [dmChannelId]: hasMore } }));
  },

  setDmPinnedIds(dmChannelId, ids) {
    set(state => ({ dmPinnedMessageIds: { ...state.dmPinnedMessageIds, [dmChannelId]: ids } }));
  },

  addDmPinnedId(dmChannelId, messageId) {
    set(state => {
      const existing = state.dmPinnedMessageIds[dmChannelId] ?? [];
      if (existing.includes(messageId)) return state;
      return {
        dmPinnedMessageIds: { ...state.dmPinnedMessageIds, [dmChannelId]: [...existing, messageId] },
      };
    });
  },

  removeDmPinnedId(dmChannelId, messageId) {
    set(state => {
      const existing = state.dmPinnedMessageIds[dmChannelId];
      if (!existing) return state;
      return {
        dmPinnedMessageIds: { ...state.dmPinnedMessageIds, [dmChannelId]: existing.filter(id => id !== messageId) },
      };
    });
  },

  bumpDmPinnedVersion() {
    set(state => ({ dmPinnedVersion: state.dmPinnedVersion + 1 }));
  },

  // Delete pending
  setDeleteMessagePending(val) {
    set({ deleteMessagePending: val });
  },

  // Bulk setter
  _setAll(partial) {
    set(partial);
  },
}));
