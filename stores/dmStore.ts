// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';
import type { GameActivity } from '../types';
import type { DmChannelEntry, DmBlockStatusEntry } from './types';

const MAX_DM_BLOCK_STATUS_ENTRIES = 1000;

interface DmState {
  dmChannels: DmChannelEntry[];
  dmBlockStatus: Record<string, DmBlockStatusEntry>;

  setDmChannels(channels: DmChannelEntry[]): void;
  updateDmChannel(id: string, updater: (ch: DmChannelEntry) => DmChannelEntry): void;
  addDmChannel(channel: DmChannelEntry): void;
  removeDmChannel(id: string): void;
  updateDmChannelPresence(userId: string, status: string): void;
  /** Batched companion to updateDmChannelPresence — applies many user-status changes in one walk. */
  applyDmChannelPresencePatch(patch: ReadonlyMap<string, string>): void;
  updateDmChannelActivity(userId: string, activity: GameActivity | null, secondaryActivity?: GameActivity | null): void;
  setDmBlockStatus(channelId: string, status: DmBlockStatusEntry): void;
  clearBlockStatus(): void;
  _setAll(partial: Partial<Pick<DmState, 'dmChannels' | 'dmBlockStatus'>>): void;
}

export const useDmStore = create<DmState>((set) => ({
  dmChannels: [],
  dmBlockStatus: {},

  setDmChannels(channels) {
    set({ dmChannels: channels });
  },

  updateDmChannel(id, updater) {
    set(state => ({
      dmChannels: state.dmChannels.map(ch => ch.id === id ? updater(ch) : ch),
    }));
  },

  addDmChannel(channel) {
    set(state => ({ dmChannels: [...state.dmChannels, channel] }));
  },

  removeDmChannel(id) {
    set(state => ({ dmChannels: state.dmChannels.filter(ch => ch.id !== id) }));
  },

  updateDmChannelPresence(userId, status) {
    set(state => {
      let anyChanged = false;
      const next = state.dmChannels.map(ch => {
        // 1:1 DM — check otherUser
        if (ch.otherUser?.id === userId && ch.otherUser.status !== status) {
          anyChanged = true;
          return { ...ch, otherUser: { ...ch.otherUser, status } };
        }
        // Group DM — check otherUsers array
        if (ch.otherUsers?.some(u => u.id === userId)) {
          let channelChanged = false;
          const updatedUsers = ch.otherUsers.map(u => {
            if (u.id === userId && u.status !== status) {
              channelChanged = true;
              return { ...u, status };
            }
            return u;
          });
          if (channelChanged) {
            anyChanged = true;
            return { ...ch, otherUsers: updatedUsers };
          }
        }
        return ch;
      });
      return anyChanged ? { dmChannels: next } : state;
    });
  },

  applyDmChannelPresencePatch(patch) {
    if (patch.size === 0) return;
    set(state => {
      let anyChanged = false;
      const next = state.dmChannels.map(ch => {
        // 1:1 DM
        if (ch.otherUser) {
          const ns = patch.get(ch.otherUser.id);
          if (ns !== undefined && ch.otherUser.status !== ns) {
            anyChanged = true;
            return { ...ch, otherUser: { ...ch.otherUser, status: ns } };
          }
        }
        // Group DM
        if (ch.otherUsers && ch.otherUsers.length > 0) {
          let channelChanged = false;
          const updatedUsers = ch.otherUsers.map(u => {
            const ns = patch.get(u.id);
            if (ns !== undefined && u.status !== ns) {
              channelChanged = true;
              return { ...u, status: ns };
            }
            return u;
          });
          if (channelChanged) {
            anyChanged = true;
            return { ...ch, otherUsers: updatedUsers };
          }
        }
        return ch;
      });
      return anyChanged ? { dmChannels: next } : state;
    });
  },

  updateDmChannelActivity(userId, activity, secondaryActivity) {
    set(state => {
      let changed = false;
      const next = state.dmChannels.map(ch => {
        // 1:1 DM — check otherUser
        if (ch.otherUser?.id === userId) {
          const activityChanged = ch.otherUser.activity !== activity;
          const secondaryChanged = secondaryActivity !== undefined && ch.otherUser.secondaryActivity !== secondaryActivity;
          if (activityChanged || secondaryChanged) {
            changed = true;
            const updatedUser = { ...ch.otherUser, activity };
            if (secondaryActivity !== undefined) {
              updatedUser.secondaryActivity = secondaryActivity;
            }
            return { ...ch, otherUser: updatedUser };
          }
        }
        // Group DM — check otherUsers array
        if (ch.otherUsers?.some(u => u.id === userId)) {
          let groupChanged = false;
          const updatedUsers = ch.otherUsers.map(u => {
            if (u.id === userId) {
              const activityChanged = u.activity !== activity;
              const secondaryChanged = secondaryActivity !== undefined && u.secondaryActivity !== secondaryActivity;
              if (activityChanged || secondaryChanged) {
                groupChanged = true;
                const updatedUser = { ...u, activity };
                if (secondaryActivity !== undefined) {
                  updatedUser.secondaryActivity = secondaryActivity;
                }
                return updatedUser;
              }
            }
            return u;
          });
          if (groupChanged) {
            changed = true;
            return { ...ch, otherUsers: updatedUsers };
          }
        }
        return ch;
      });
      return changed ? { dmChannels: next } : state;
    });
  },

  setDmBlockStatus(channelId, status) {
    set(state => {
      const next = { ...state.dmBlockStatus, [channelId]: status };
      // Evict oldest entries if over cap
      const keys = Object.keys(next);
      if (keys.length > MAX_DM_BLOCK_STATUS_ENTRIES) {
        const toRemove = keys.slice(0, keys.length - MAX_DM_BLOCK_STATUS_ENTRIES);
        for (const k of toRemove) delete next[k];
      }
      return { dmBlockStatus: next };
    });
  },

  clearBlockStatus() {
    set({ dmBlockStatus: {} });
  },

  _setAll(partial) {
    set(partial);
  },
}));
