// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Simple LRU avatar cache for Stream Deck key rendering.
 * Caches fetched avatar image buffers to avoid re-fetching on every render cycle.
 * Capped at 50 entries.
 */

const MAX_ENTRIES = 50;

interface CacheEntry {
  buffer: Buffer;
  fetchedAt: number;
}

/** LRU cache: Map insertion order = access order (re-insert on get). */
const cache = new Map<string, CacheEntry>();

/** TTL for cached avatars (5 minutes). */
const TTL_MS = 5 * 60 * 1000;

/**
 * Get a cached avatar buffer, fetching it if not cached or expired.
 * Returns null if the fetch fails.
 */
export async function getCachedAvatar(url: string): Promise<Buffer | null> {
  const existing = cache.get(url);
  if (existing && Date.now() - existing.fetchedAt < TTL_MS) {
    // Move to end (most recently used) by re-inserting.
    cache.delete(url);
    cache.set(url, existing);
    return existing.buffer;
  }

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    // Evict oldest entries if at capacity.
    while (cache.size >= MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }

    const entry: CacheEntry = { buffer, fetchedAt: Date.now() };
    cache.set(url, entry);
    return buffer;
  } catch {
    return null;
  }
}

/**
 * Evict a specific URL from the cache.
 */
export function evictAvatar(url: string): void {
  cache.delete(url);
}

/**
 * Clear the entire avatar cache.
 */
export function clearAvatarCache(): void {
  cache.clear();
}
