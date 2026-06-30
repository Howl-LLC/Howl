// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Discovery store.
 *
 * Holds the search/listing state for the public/auth `/discover` page. The
 * paginated server list is keyed by the active filter set so changing a
 * filter resets the cursor cleanly. Featured + categories are cached for
 * the lifetime of the session — they refresh when the user logs in/out
 * because the auth-mode hub uses different endpoints than the anon hub.
 */
import { create } from 'zustand';
import { apiClient, type ServerCardSummary, type DiscoverFilters, type DiscoverCategory } from '../services/api';

export type DiscoveryAuthMode = 'anonymous' | 'authenticated';

export interface DiscoveryFiltersState {
  q: string;
  category: string | null;
  language: string | null;
  tag: string | null;
}

const DEFAULT_FILTERS: DiscoveryFiltersState = {
  q: '',
  category: null,
  language: null,
  tag: null,
};

const PAGE_SIZE = 24;

interface DiscoveryState {
  authMode: DiscoveryAuthMode;
  filters: DiscoveryFiltersState;
  items: ServerCardSummary[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;

  featured: ServerCardSummary[];
  featuredLoaded: boolean;

  categories: DiscoverCategory[];
  categoriesLoaded: boolean;

  setAuthMode(mode: DiscoveryAuthMode): void;
  setFilters(patch: Partial<DiscoveryFiltersState>): void;
  resetFilters(): void;

  /** Fetch the first page (resets cursor + items). */
  fetchInitial(): Promise<void>;
  /** Fetch the next page using the saved cursor. No-op when there is no cursor. */
  fetchMore(): Promise<void>;
  /** Load featured + categories. Idempotent for the lifetime of the auth mode. */
  fetchSidebars(): Promise<void>;
  /**
   * Drop sidebar caches and re-fetch the visible page + sidebars. Used when an
   * external signal (socket event, window focus) tells us the discoverable
   * server set may have changed. No-op while a fetch is already in-flight.
   */
  invalidate(): void;
}

const buildApiFilters = (state: DiscoveryState, cursor: string | null): DiscoverFilters => ({
  q: state.filters.q || undefined,
  category: state.filters.category || undefined,
  language: state.filters.language || undefined,
  tag: state.filters.tag || undefined,
  cursor: cursor ?? undefined,
  limit: PAGE_SIZE,
});

export const useDiscoveryStore = create<DiscoveryState>((set, get) => ({
  authMode: 'anonymous',
  filters: { ...DEFAULT_FILTERS },
  items: [],
  nextCursor: null,
  loading: false,
  loadingMore: false,
  error: null,

  featured: [],
  featuredLoaded: false,

  categories: [],
  categoriesLoaded: false,

  setAuthMode(mode) {
    if (get().authMode === mode) return;
    set({
      authMode: mode,
      // Reset everything cached for the previous auth mode — the endpoint
      // surface and the visible result set both change.
      items: [],
      nextCursor: null,
      featured: [],
      featuredLoaded: false,
      categories: [],
      categoriesLoaded: false,
      error: null,
    });
  },

  setFilters(patch) {
    // Pure setter — the consumer (DiscoverPage) controls when to fetch so
    // it can debounce search input without firing intermediate requests.
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...DEFAULT_FILTERS } });
  },

  async fetchInitial() {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const state = get();
      const fn = state.authMode === 'authenticated' ? apiClient.discoverList : apiClient.publicDiscoverList;
      const res = await fn.call(apiClient, buildApiFilters(state, null));
      set({ items: res.items, nextCursor: res.nextCursor, loading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load servers';
      set({ loading: false, error: message, items: [], nextCursor: null });
    }
  },

  async fetchMore() {
    const state = get();
    if (state.loadingMore || state.loading) return;
    if (!state.nextCursor) return;
    set({ loadingMore: true });
    try {
      const fn = state.authMode === 'authenticated' ? apiClient.discoverList : apiClient.publicDiscoverList;
      const res = await fn.call(apiClient, buildApiFilters(state, state.nextCursor));
      // Dedupe by id — the cursor pagination on the backend is best-effort
      // and a slow caller can race a server boost into the next page.
      const existingIds = new Set(state.items.map((i) => i.id));
      const merged = [...state.items, ...res.items.filter((i) => !existingIds.has(i.id))];
      set({ items: merged, nextCursor: res.nextCursor, loadingMore: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load more servers';
      set({ loadingMore: false, error: message });
    }
  },

  async fetchSidebars() {
    const state = get();
    const promises: Promise<unknown>[] = [];
    if (!state.featuredLoaded) {
      promises.push(
        apiClient
          .discoverFeatured()
          .then((featured) => set({ featured, featuredLoaded: true }))
          .catch(() => set({ featured: [], featuredLoaded: true }))
      );
    }
    if (!state.categoriesLoaded) {
      promises.push(
        apiClient
          .discoverCategories()
          .then((categories) => set({ categories, categoriesLoaded: true }))
          .catch(() => set({ categories: [], categoriesLoaded: true }))
      );
    }
    if (promises.length > 0) await Promise.all(promises);
  },

  invalidate() {
    // Skip if there's already an in-flight initial fetch — fetchInitial()'s
    // own guard would no-op anyway.
    if (get().loading) return;
    // bust the 15s response cache so the refetch sees fresh data
    apiClient.invalidateCache('/discover');
    apiClient.invalidateCache('/public/discover');
    // Stale-while-revalidate: refetch in the background without flipping
    // featuredLoaded/categoriesLoaded back to false. Keeps the existing items
    // visible (no skeleton flash) until the new responses arrive. Triggered
    // on window focus, so a brief tab switch shouldn't blank the page.
    void get().fetchInitial();
    void apiClient.discoverFeatured()
      .then((featured) => set({ featured, featuredLoaded: true }))
      .catch(() => { /* keep existing */ });
    void apiClient.discoverCategories()
      .then((categories) => set({ categories, categoriesLoaded: true }))
      .catch(() => { /* keep existing */ });
  },
}));
