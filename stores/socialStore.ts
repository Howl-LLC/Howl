// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';
import type { User, GameActivity } from '../types';

interface SocialState {
  homeFriends: User[];
  friendListVersion: number;
  blockedUserIds: Set<string>;

  setHomeFriends(friends: User[]): void;
  updateFriendPresence(userId: string, status: User['status']): void;
  /** Batched companion to updateFriendPresence — see serverStore.applyMemberPresencePatch. */
  applyFriendPresencePatch(patch: ReadonlyMap<string, User['status']>): void;
  updateFriendActivity(userId: string, activity: GameActivity | null, secondaryActivity?: GameActivity | null): void;
  addFriend(friend: User): void;
  removeFriend(userId: string): void;
  setBlockedUserIds(ids: Set<string>): void;
  addBlockedUser(userId: string): void;
  removeBlockedUser(userId: string): void;
  incrementFriendListVersion(): void;
  _setAll(partial: Partial<Pick<SocialState, 'homeFriends' | 'friendListVersion' | 'blockedUserIds'>>): void;
}

export const useSocialStore = create<SocialState>((set) => ({
  homeFriends: [],
  friendListVersion: 0,
  blockedUserIds: new Set(),

  setHomeFriends(friends) {
    set({ homeFriends: friends });
  },

  updateFriendPresence(userId, status) {
    set(state => {
      let changed = false;
      const next = state.homeFriends.map(f => {
        if (f.id === userId && f.status !== status) {
          changed = true;
          return { ...f, status };
        }
        return f;
      });
      return changed ? { homeFriends: next } : state;
    });
  },

  applyFriendPresencePatch(patch) {
    if (patch.size === 0) return;
    set(state => {
      let changed = false;
      const next = state.homeFriends.map(f => {
        const ns = patch.get(f.id);
        if (ns !== undefined && f.status !== ns) {
          changed = true;
          return { ...f, status: ns };
        }
        return f;
      });
      return changed ? { homeFriends: next } : state;
    });
  },

  updateFriendActivity(userId, activity, secondaryActivity) {
    set(state => {
      let changed = false;
      const next = state.homeFriends.map(f => {
        if (f.id === userId) {
          const activityChanged = f.activity !== activity;
          const secondaryChanged = secondaryActivity !== undefined && f.secondaryActivity !== secondaryActivity;
          if (activityChanged || secondaryChanged) {
            changed = true;
            const updated = { ...f, activity };
            if (secondaryActivity !== undefined) {
              updated.secondaryActivity = secondaryActivity;
            }
            return updated;
          }
        }
        return f;
      });
      return changed ? { homeFriends: next } : state;
    });
  },

  addFriend(friend) {
    set(state => {
      if (state.homeFriends.some(f => f.id === friend.id)) return state;
      return { homeFriends: [...state.homeFriends, friend] };
    });
  },

  removeFriend(userId) {
    set(state => ({ homeFriends: state.homeFriends.filter(f => f.id !== userId) }));
  },

  setBlockedUserIds(ids) {
    set({ blockedUserIds: ids });
  },

  addBlockedUser(userId) {
    set(state => {
      if (state.blockedUserIds.has(userId)) return state;
      const next = new Set(state.blockedUserIds);
      next.add(userId);
      return { blockedUserIds: next };
    });
  },

  removeBlockedUser(userId) {
    set(state => {
      if (!state.blockedUserIds.has(userId)) return state;
      const next = new Set(state.blockedUserIds);
      next.delete(userId);
      return { blockedUserIds: next };
    });
  },

  incrementFriendListVersion() {
    set(state => ({ friendListVersion: state.friendListVersion + 1 }));
  },

  _setAll(partial) {
    set(partial);
  },
}));
