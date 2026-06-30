// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';
import type { Server, User, GameActivity } from '../types';
import type { ServerMember } from './types';

interface ServerState {
  servers: Server[];
  serverMembers: ServerMember[];
  serverOwnerId: string | null;

  setServers(servers: Server[]): void;
  updateServer(serverId: string, updater: (server: Server) => Server): void;
  addServer(server: Server): void;
  removeServer(serverId: string): void;
  setServerMembers(members: ServerMember[]): void;
  updateMemberPresence(userId: string, status: User['status']): void;
  /**
   * Apply a batch of presence updates in a single store transition.
   *
   * usePresenceUpdates flushes 5–50+ pending status changes every 2 seconds.
   * Calling updateMemberPresence in a loop allocates a new serverMembers
   * array (and notifies subscribers) once per user — even with React batching
   * downstream that's redundant work. This collapses the whole batch into
   * one O(N) walk and a single store update.
   */
  applyMemberPresencePatch(patch: ReadonlyMap<string, User['status']>): void;
  updateMemberActivity(userId: string, activity: GameActivity | null, secondaryActivity?: GameActivity | null): void;
  setServerOwnerId(id: string | null): void;
  _setAll(partial: Partial<Pick<ServerState, 'servers' | 'serverMembers' | 'serverOwnerId'>>): void;
}

export const useServerStore = create<ServerState>((set) => ({
  servers: [],
  serverMembers: [],
  serverOwnerId: null,

  setServers(servers) {
    set(state => {
      if (state.servers === servers) return state;
      // Merge slim payloads with already-hydrated entries. `GET /api/servers`
      // returns slim servers (channels: [], categories: []); the active server
      // is hydrated separately via `GET /api/servers/:id`. Focus / reconnect
      // refreshes (and channel/category permission-update events) re-call
      // setServers with a slim payload — without this merge those would wipe
      // the hydrated channels[] of every previously-loaded server, breaking
      // the channel list, voice-channel name lookups, and jump-to-first-channel
      // until the user navigates away and back. Preserve hydrated arrays
      // whenever the incoming entry has none of its own.
      const prevById = new Map(state.servers.map(s => [s.id, s]));
      const merged = servers.map(incoming => {
        const prev = prevById.get(incoming.id);
        if (!prev) return incoming;
        const incomingChannels = incoming.channels ?? [];
        const incomingCategories = incoming.categories ?? [];
        const keepChannels = incomingChannels.length === 0 && prev.channels.length > 0;
        const keepCategories = incomingCategories.length === 0 && (prev.categories?.length ?? 0) > 0;
        if (!keepChannels && !keepCategories) return incoming;
        return {
          ...incoming,
          channels: keepChannels ? prev.channels : incomingChannels,
          categories: keepCategories ? prev.categories : incomingCategories,
        };
      });
      return { servers: merged };
    });
  },

  updateServer(serverId, updater) {
    set(state => ({
      servers: state.servers.map(s => s.id === serverId ? updater(s) : s),
    }));
  },

  addServer(server) {
    set(state => {
      if (state.servers.some(s => s.id === server.id)) return state;
      return { servers: [...state.servers, server] };
    });
  },

  removeServer(serverId) {
    set(state => ({ servers: state.servers.filter(s => s.id !== serverId) }));
  },

  setServerMembers(members) {
    set(state => (state.serverMembers === members ? state : { serverMembers: members }));
  },

  updateMemberPresence(userId, status) {
    set(state => {
      let changed = false;
      const next = state.serverMembers.map(m => {
        if (m.id === userId && m.status !== status) {
          changed = true;
          return { ...m, status };
        }
        return m;
      });
      return changed ? { serverMembers: next } : state;
    });
  },

  applyMemberPresencePatch(patch) {
    if (patch.size === 0) return;
    set(state => {
      let changed = false;
      const next = state.serverMembers.map(m => {
        const ns = patch.get(m.id);
        if (ns !== undefined && m.status !== ns) {
          changed = true;
          return { ...m, status: ns };
        }
        return m;
      });
      return changed ? { serverMembers: next } : state;
    });
  },

  updateMemberActivity(userId, activity, secondaryActivity) {
    set(state => {
      let changed = false;
      const next = state.serverMembers.map(m => {
        if (m.id === userId) {
          const activityChanged = m.activity !== activity;
          const secondaryChanged = secondaryActivity !== undefined && m.secondaryActivity !== secondaryActivity;
          if (activityChanged || secondaryChanged) {
            changed = true;
            const updated = { ...m, activity };
            if (secondaryActivity !== undefined) {
              updated.secondaryActivity = secondaryActivity;
            }
            return updated;
          }
        }
        return m;
      });
      return changed ? { serverMembers: next } : state;
    });
  },

  setServerOwnerId(id) {
    set({ serverOwnerId: id });
  },

  _setAll(partial) {
    set(partial);
  },
}));
