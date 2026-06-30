// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';

// Stable empty references for selectors (Zustand selector rule: never create objects inline)
export const EMPTY_TYPING: Record<string, { username: string; expires: number }> = {};
export const EMPTY_SERVER_TYPING: Record<string, { username: string; expires: number }> = {};

type TypingEntry = { username: string; expires: number };

interface TypingState {
  typingByChannel: Record<string, Record<string, TypingEntry>>;
  typingByServer: Record<string, Record<string, TypingEntry>>;
  typingDmUsers: Record<string, number>;

  /** Batched update for a single typing event — one set() call for all indices */
  handleTypingEvent(channelOrDmId: string, userId: string, username: string, expires: number, serverId?: string, isDm?: boolean): void;

  setUserTyping(channelOrDmId: string, userId: string, username: string, expires: number): void;
  clearUserTyping(channelOrDmId: string, userId: string): void;
  clearChannelTyping(channelOrDmId: string): void;

  setUserTypingServer(serverId: string, userId: string, username: string, expires: number): void;
  clearUserTypingServer(serverId: string, userId: string): void;
  setUserTypingDm(userId: string, expires: number): void;

  clearAllTyping(): void;
  /** Remove expired entries from all 3 maps. Returns true if anything was pruned. */
  pruneExpired(): void;
  setAll(data: Record<string, Record<string, TypingEntry>>): void;
  /** Check if any typing entries exist across all maps */
  hasAnyTyping(): boolean;
}

export const useTypingStore = create<TypingState>((set, get) => ({
  typingByChannel: {},
  typingByServer: {},
  typingDmUsers: {},

  handleTypingEvent(channelOrDmId, userId, username, expires, serverId, isDm) {
    set(state => {
      const entry: TypingEntry = { username, expires };
      const patch: Partial<Pick<TypingState, 'typingByChannel' | 'typingByServer' | 'typingDmUsers'>> = {};

      // typingByChannel — always
      const channelData = state.typingByChannel[channelOrDmId];
      const existCh = channelData?.[userId];
      if (!existCh || existCh.username !== username || existCh.expires !== expires) {
        patch.typingByChannel = {
          ...state.typingByChannel,
          [channelOrDmId]: channelData ? { ...channelData, [userId]: entry } : { [userId]: entry },
        };
      }

      // typingByServer — server channels only
      if (serverId) {
        const serverData = state.typingByServer[serverId];
        const existSv = serverData?.[userId];
        if (!existSv || existSv.username !== username || existSv.expires !== expires) {
          patch.typingByServer = {
            ...state.typingByServer,
            [serverId]: serverData ? { ...serverData, [userId]: entry } : { [userId]: entry },
          };
        }
      }

      // typingDmUsers — DMs only
      if (isDm && state.typingDmUsers[userId] !== expires) {
        patch.typingDmUsers = { ...state.typingDmUsers, [userId]: expires };
      }

      // Single set() — or no-op if nothing changed
      for (const _ in patch) return patch; // fast non-empty check
      return state;
    });
  },

  setUserTyping(channelOrDmId, userId, username, expires) {
    set(state => {
      const channelData = state.typingByChannel[channelOrDmId];
      const existing = channelData?.[userId];
      if (existing && existing.username === username && existing.expires === expires) return state;
      const nextChannel = channelData
        ? { ...channelData, [userId]: { username, expires } }
        : { [userId]: { username, expires } };
      return {
        typingByChannel: { ...state.typingByChannel, [channelOrDmId]: nextChannel },
      };
    });
  },

  clearUserTyping(channelOrDmId, userId) {
    set(state => {
      const channel = state.typingByChannel[channelOrDmId];
      if (!channel || !channel[userId]) return state;
      const { [userId]: _, ...rest } = channel;
      const hasRemaining = Object.keys(rest).length > 0;
      if (hasRemaining) {
        return { typingByChannel: { ...state.typingByChannel, [channelOrDmId]: rest } };
      }
      const { [channelOrDmId]: __, ...restChannels } = state.typingByChannel;
      return { typingByChannel: restChannels };
    });
  },

  clearChannelTyping(channelOrDmId) {
    set(state => {
      if (!state.typingByChannel[channelOrDmId]) return state;
      const { [channelOrDmId]: _, ...rest } = state.typingByChannel;
      return { typingByChannel: rest };
    });
  },

  setUserTypingServer(serverId, userId, username, expires) {
    set(state => {
      const serverData = state.typingByServer[serverId];
      const existing = serverData?.[userId];
      if (existing && existing.username === username && existing.expires === expires) return state;
      const nextServer = serverData
        ? { ...serverData, [userId]: { username, expires } }
        : { [userId]: { username, expires } };
      return {
        typingByServer: { ...state.typingByServer, [serverId]: nextServer },
      };
    });
  },

  clearUserTypingServer(serverId, userId) {
    set(state => {
      const server = state.typingByServer[serverId];
      if (!server || !server[userId]) return state;
      const { [userId]: _, ...rest } = server;
      const hasRemaining = Object.keys(rest).length > 0;
      if (hasRemaining) {
        return { typingByServer: { ...state.typingByServer, [serverId]: rest } };
      }
      const { [serverId]: __, ...restServers } = state.typingByServer;
      return { typingByServer: restServers };
    });
  },

  setUserTypingDm(userId, expires) {
    set(state => {
      if (state.typingDmUsers[userId] === expires) return state;
      return { typingDmUsers: { ...state.typingDmUsers, [userId]: expires } };
    });
  },

  clearAllTyping() {
    set({ typingByChannel: {}, typingByServer: {}, typingDmUsers: {} });
  },

  pruneExpired() {
    set(state => {
      const now = Date.now();

      // Early-exit: scan for any expired entry before allocating new objects
      let hasExpired = false;
      outer: for (const users of Object.values(state.typingByChannel)) {
        for (const entry of Object.values(users)) {
          if (now > entry.expires) { hasExpired = true; break outer; }
        }
      }
      if (!hasExpired) {
        for (const users of Object.values(state.typingByServer)) {
          for (const entry of Object.values(users)) {
            if (now > entry.expires) { hasExpired = true; break; }
          }
          if (hasExpired) break;
        }
      }
      if (!hasExpired) {
        for (const exp of Object.values(state.typingDmUsers)) {
          if (now > exp) { hasExpired = true; break; }
        }
      }
      if (!hasExpired) return state;

      // Something expired — build new maps
      const nextChannels: Record<string, Record<string, TypingEntry>> = {};
      for (const [channelId, users] of Object.entries(state.typingByChannel)) {
        const filtered: Record<string, TypingEntry> = {};
        let has = false;
        for (const [uid, entry] of Object.entries(users)) {
          if (now <= entry.expires) { filtered[uid] = entry; has = true; }
        }
        if (has) nextChannels[channelId] = filtered;
      }

      const nextServers: Record<string, Record<string, TypingEntry>> = {};
      for (const [serverId, users] of Object.entries(state.typingByServer)) {
        const filtered: Record<string, TypingEntry> = {};
        let has = false;
        for (const [uid, entry] of Object.entries(users)) {
          if (now <= entry.expires) { filtered[uid] = entry; has = true; }
        }
        if (has) nextServers[serverId] = filtered;
      }

      const nextDmUsers: Record<string, number> = {};
      for (const [uid, exp] of Object.entries(state.typingDmUsers)) {
        if (now <= exp) nextDmUsers[uid] = exp;
      }

      return { typingByChannel: nextChannels, typingByServer: nextServers, typingDmUsers: nextDmUsers };
    });
  },

  setAll(data) {
    set({ typingByChannel: data });
  },

  hasAnyTyping() {
    const s = get();
    for (const _ in s.typingByChannel) return true;
    for (const _ in s.typingByServer) return true;
    for (const _ in s.typingDmUsers) return true;
    return false;
  },
}));
