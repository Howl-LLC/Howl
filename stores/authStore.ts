// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';
import type { User } from '../types';

interface AuthState {
  currentUser: User | null;
  currentUserStatus: User['status'];
  hasSteamLinked: boolean;
  showMfaBanner: boolean;

  setCurrentUser(user: User | null): void;
  updateCurrentUser(partial: Partial<User>): void;
  setCurrentUserStatus(status: User['status']): void;
  setHasSteamLinked(val: boolean): void;
  setShowMfaBanner(val: boolean): void;
}

export const useAuthStore = create<AuthState>((set) => ({
  currentUser: null,
  currentUserStatus: 'offline',
  hasSteamLinked: false,
  showMfaBanner: false,

  setCurrentUser(user) {
    set({ currentUser: user, ...(user?.status ? { currentUserStatus: user.status } : {}) });
  },

  updateCurrentUser(partial) {
    set(state => {
      if (!state.currentUser) return state;
      const updated = { ...state.currentUser, ...partial };
      return { currentUser: updated, ...(partial.status ? { currentUserStatus: partial.status } : {}) };
    });
  },

  setCurrentUserStatus(status) {
    // Mirror the status onto currentUser.status so consumers that read the
    // whole user object (FloatingUserStatusBar, AccountView, etc.) see the
    // new value. Subscribers that only read currentUserStatus keep working.
    set(state => ({
      currentUserStatus: status,
      ...(state.currentUser ? { currentUser: { ...state.currentUser, status } } : {}),
    }));
  },

  setHasSteamLinked(val) {
    set({ hasSteamLinked: val });
  },

  setShowMfaBanner(val) {
    set({ showMfaBanner: val });
  },
}));
