// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';
import type { InstanceConfig } from '../shared/instanceConfig';

interface AppState {
  isOffline: boolean;
  floatingBarDocked: boolean;
  sidebarWidth: number;
  updateReady: string | null;
  updateError: string | null;
  updateAvailable: string | null;
  updateDownloading: boolean;
  channelLoadError: string | null;
  dmLoadError: string | null;
  membersLoadError: string | null;
  pinnedCatRevision: number;
  instanceConfig: InstanceConfig | null;

  setIsOffline(v: boolean): void;
  setFloatingBarDocked(v: boolean): void;
  setSidebarWidth(v: number): void;
  setUpdateReady(v: string | null): void;
  setUpdateError(v: string | null): void;
  setUpdateAvailable(v: string | null): void;
  setUpdateDownloading(v: boolean): void;
  setChannelLoadError(v: string | null): void;
  setDmLoadError(v: string | null): void;
  setMembersLoadError(v: string | null): void;
  bumpPinnedCatRevision(): void;
  setInstanceConfig(c: InstanceConfig | null): void;
}

const readFloatingBarDocked = (): boolean => {
  try {
    return localStorage.getItem('howl_floating_bar_docked') === 'true';
  } catch { /* ignore */ }
  return false;
};

export const useAppStore = create<AppState>()((set) => ({
  isOffline: false,
  floatingBarDocked: readFloatingBarDocked(),
  sidebarWidth: 72,
  updateReady: null,
  updateError: null,
  updateAvailable: null,
  updateDownloading: false,
  channelLoadError: null,
  dmLoadError: null,
  membersLoadError: null,
  pinnedCatRevision: 0,
  instanceConfig: null,

  setIsOffline(v) { set({ isOffline: v }); },

  setFloatingBarDocked(v) {
    try { localStorage.setItem('howl_floating_bar_docked', String(v)); } catch { /* ignore */ }
    set({ floatingBarDocked: v });
  },

  setSidebarWidth(v) { set({ sidebarWidth: v }); },
  setUpdateReady(v) { set({ updateReady: v }); },
  setUpdateError(v) { set({ updateError: v }); },
  setUpdateAvailable(v) { set({ updateAvailable: v }); },
  setUpdateDownloading(v) { set({ updateDownloading: v }); },
  setChannelLoadError(v) { set({ channelLoadError: v }); },
  setDmLoadError(v) { set({ dmLoadError: v }); },
  setMembersLoadError(v) { set({ membersLoadError: v }); },
  bumpPinnedCatRevision() { set((state) => ({ pinnedCatRevision: state.pinnedCatRevision + 1 })); },
  setInstanceConfig(c) { set({ instanceConfig: c }); },
}));
