// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';
import type { StreamContext, StreamKey } from './types';

interface ViewerState {
  /** Source of truth: stream key → set of viewer user IDs. */
  viewers: Map<StreamKey, Set<string>>;
  /** Version counter bumped on every mutation — subscribers that only read
   *  via `getViewers` selector can depend on this to invalidate memoization. */
  version: number;

  addViewers(key: StreamKey, userIds: string[]): void;
  removeViewers(key: StreamKey, userIds: string[]): void;
  clearStream(key: StreamKey): void;
  clearForContext(ctx: StreamContext): void;
  reset(): void;

  getViewers(key: StreamKey): string[];
  getViewerCount(key: StreamKey, selfUserId?: string): number;
  hasStream(key: StreamKey): boolean;
}

export const useViewerStore = create<ViewerState>((set, get) => ({
  viewers: new Map(),
  version: 0,

  addViewers(key, userIds) {
    set((state) => {
      const map = new Map(state.viewers);
      const current = map.get(key) ?? new Set<string>();
      const next = new Set(current);
      for (const u of userIds) next.add(u);
      map.set(key, next);
      return { viewers: map, version: state.version + 1 };
    });
  },

  removeViewers(key, userIds) {
    set((state) => {
      const current = state.viewers.get(key);
      if (!current) return state;
      const next = new Set(current);
      for (const u of userIds) next.delete(u);
      const map = new Map(state.viewers);
      if (next.size === 0) map.delete(key);
      else map.set(key, next);
      return { viewers: map, version: state.version + 1 };
    });
  },

  clearStream(key) {
    set((state) => {
      if (!state.viewers.has(key)) return state;
      const map = new Map(state.viewers);
      map.delete(key);
      return { viewers: map, version: state.version + 1 };
    });
  },

  clearForContext(ctx) {
    set((state) => {
      const prefix = `${ctx.kind}:${ctx.scopeId}:` as const;
      const map = new Map(state.viewers);
      let changed = false;
      for (const k of Array.from(map.keys())) {
        if (k.startsWith(prefix)) { map.delete(k); changed = true; }
      }
      return changed ? { viewers: map, version: state.version + 1 } : state;
    });
  },

  reset() {
    set({ viewers: new Map(), version: 0 });
  },

  getViewers(key) {
    return Array.from(get().viewers.get(key) ?? []);
  },

  getViewerCount(key, selfUserId) {
    const set = get().viewers.get(key);
    if (!set) return 0;
    if (selfUserId && set.has(selfUserId)) return set.size - 1;
    return set.size;
  },

  hasStream(key) {
    return (get().viewers.get(key)?.size ?? 0) > 0;
  },
}));
