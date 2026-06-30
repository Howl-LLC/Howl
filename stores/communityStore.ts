// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';

/**
 * Tracks which community-enabled servers have already shown the welcome
 * screen modal to the current user. Persisted to `localStorage` so we
 * don't repeat the modal across sessions.
 *
 * Also caches per-server welcome screen payloads (channels list, etc.)
 * fetched from `GET /api/v1/servers/:id/welcome-screen` so the modal
 * renders instantly on second open.
 */

const STORAGE_KEY = 'howl_welcome_seen_servers_v1';

export interface WelcomeScreenChannel {
  channelId: string;
  emoji: string | null;
  description: string;
}

export interface WelcomeScreenData {
  serverId: string;
  serverName: string;
  serverIcon: string | null;
  description: string;
  channels: WelcomeScreenChannel[];
  enabled: boolean;
}

function loadSeenSet(): Set<string> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return new Set<string>();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set<string>();
    return new Set<string>(arr.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set<string>();
  }
}

function persistSeenSet(set: Set<string>) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch {
    /* best-effort */
  }
}

interface CommunityState {
  /** Set of serverIds for which we've already shown the welcome modal. */
  seenServers: Set<string>;
  /** Cached welcome-screen payloads, keyed by serverId. */
  welcomeScreens: Map<string, WelcomeScreenData>;
  /** Server currently being shown a welcome modal (null = none). */
  activeWelcomeServerId: string | null;
  /** Server currently being shown the mandatory onboarding modal (null = none). */
  activeOnboardingServerId: string | null;
  /**
   * Session-scoped guard (NOT persisted) for serverIds whose onboarding gate
   * has already been evaluated this session. The DURABLE show-once gate is the
   * server's `onboardingCompletedAt` (roams across devices); this set only
   * prevents refetch loops on tab/server switches within a single session.
   */
  shownOnboardingThisSession: Set<string>;

  hasSeenWelcome(serverId: string): boolean;
  markWelcomeSeen(serverId: string): void;
  resetWelcomeSeen(serverId: string): void;
  cacheWelcomeScreen(data: WelcomeScreenData): void;
  getCachedWelcomeScreen(serverId: string): WelcomeScreenData | undefined;
  showWelcomeModal(serverId: string): void;
  closeWelcomeModal(): void;
  showOnboardingModal(serverId: string): void;
  closeOnboardingModal(): void;
  markOnboardingShownThisSession(serverId: string): void;
  hasShownOnboardingThisSession(serverId: string): boolean;
}

export const useCommunityStore = create<CommunityState>((set, get) => ({
  seenServers: loadSeenSet(),
  welcomeScreens: new Map(),
  activeWelcomeServerId: null,
  activeOnboardingServerId: null,
  shownOnboardingThisSession: new Set<string>(),

  hasSeenWelcome(serverId) {
    return get().seenServers.has(serverId);
  },

  markWelcomeSeen(serverId) {
    set((state) => {
      if (state.seenServers.has(serverId)) return state;
      const next = new Set(state.seenServers);
      next.add(serverId);
      persistSeenSet(next);
      return { seenServers: next };
    });
  },

  resetWelcomeSeen(serverId) {
    set((state) => {
      if (!state.seenServers.has(serverId)) return state;
      const next = new Set(state.seenServers);
      next.delete(serverId);
      persistSeenSet(next);
      return { seenServers: next };
    });
  },

  cacheWelcomeScreen(data) {
    set((state) => {
      const next = new Map(state.welcomeScreens);
      next.set(data.serverId, data);
      return { welcomeScreens: next };
    });
  },

  getCachedWelcomeScreen(serverId) {
    return get().welcomeScreens.get(serverId);
  },

  showWelcomeModal(serverId) {
    set({ activeWelcomeServerId: serverId });
  },

  closeWelcomeModal() {
    set({ activeWelcomeServerId: null });
  },

  showOnboardingModal(serverId) {
    set({ activeOnboardingServerId: serverId });
  },

  closeOnboardingModal() {
    set({ activeOnboardingServerId: null });
  },

  markOnboardingShownThisSession(serverId) {
    set((state) => {
      if (state.shownOnboardingThisSession.has(serverId)) return state;
      const next = new Set(state.shownOnboardingThisSession);
      next.add(serverId);
      return { shownOnboardingThisSession: next };
    });
  },

  hasShownOnboardingThisSession(serverId) {
    return get().shownOnboardingThisSession.has(serverId);
  },
}));
