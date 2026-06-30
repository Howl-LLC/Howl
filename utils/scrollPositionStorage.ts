// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Per-channel scroll position memory.
 *
 * Discord remembers where you left off in each channel — switching away and
 * coming back keeps you anchored to the same message. We mirror that:
 * - In-memory Map (instant access while the tab is open).
 * - Backed by localStorage so positions survive page reloads.
 * - LRU-capped to MAX_REMEMBERED_CHANNELS so the storage doesn't grow forever.
 *
 * Position is stored as a messageId rather than a numeric index, so prepends /
 * deletions / reorderings don't invalidate it. If the saved messageId is no
 * longer in the loaded set when we try to restore, callers fall back to their
 * default (typically: jump to first unread, otherwise jump to bottom).
 *
 * `atBottom: true` is a sentinel — restore by scrolling to the latest message,
 * regardless of messageId. This is the common case (most active reading sessions
 * end with the user at the bottom).
 */

export type ScrollPosition = {
  /** The id of the topmost-visible message when the position was saved.
   *  Null when atBottom is true (we don't anchor — just go to the end). */
  messageId: string | null;
  /** True if the user was at the bottom of the channel at save time. */
  atBottom: boolean;
};

const STORAGE_KEY = 'howl_scroll_positions_v1';
const MAX_REMEMBERED_CHANNELS = 50;
let _persistTimer: number | null = null;
const PERSIST_DEBOUNCE_MS = 500;

// In-memory cache. JavaScript Maps preserve insertion order, which we exploit
// for LRU eviction: re-inserting a key moves it to the "most recent" end.
const cache = new Map<string, ScrollPosition>();
let _hydrated = false;

function hydrate(): void {
  if (_hydrated) return;
  _hydrated = true;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return;
    const parsed = JSON.parse(raw) as Array<[string, ScrollPosition]>;
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [channelId, pos] = entry;
      if (typeof channelId !== 'string' || !channelId) continue;
      if (!pos || typeof pos !== 'object') continue;
      if (typeof pos.atBottom !== 'boolean') continue;
      if (pos.messageId !== null && typeof pos.messageId !== 'string') continue;
      cache.set(channelId, { messageId: pos.messageId, atBottom: pos.atBottom });
    }
  } catch {
    // Corrupt localStorage entry — ignore and start fresh.
  }
}

function schedulePersist(): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  if (_persistTimer != null) return;
  _persistTimer = window.setTimeout(() => {
    _persistTimer = null;
    try {
      // Only the most recent MAX_REMEMBERED_CHANNELS entries.
      const entries = Array.from(cache.entries()).slice(-MAX_REMEMBERED_CHANNELS);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Quota exceeded or unavailable — best-effort, drop silently.
    }
  }, PERSIST_DEBOUNCE_MS);
}

export function getScrollPosition(channelId: string): ScrollPosition | null {
  if (!channelId) return null;
  hydrate();
  return cache.get(channelId) ?? null;
}

export function saveScrollPosition(channelId: string, pos: ScrollPosition): void {
  if (!channelId) return;
  hydrate();
  // Re-insert to bump LRU position to end.
  cache.delete(channelId);
  cache.set(channelId, pos);
  // Evict oldest entries if over cap.
  while (cache.size > MAX_REMEMBERED_CHANNELS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  schedulePersist();
}

export function clearScrollPosition(channelId: string): void {
  if (!channelId) return;
  hydrate();
  if (cache.delete(channelId)) schedulePersist();
}
