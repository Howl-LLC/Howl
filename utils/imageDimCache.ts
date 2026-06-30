// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Persistent cache of natural image dimensions keyed by URL.
//
// Why: when a <img> loads after a scroll lurch or on cold page load, the
// browser reserves zero layout space until the bytes arrive and natural
// dimensions are known. Once known, the image grows to its real size and
// everything below it shifts down — the classic Cumulative Layout Shift
// that manifests as "rubber banding" or "lurching" during chat scroll.
//
// By persisting the (url → { w, h }) map in localStorage, any image the
// user has seen before can be rendered with `style={{ aspectRatio }}` on
// the very first render of a fresh page, reserving the correct space
// before the image even starts loading. This matches how Discord eliminates
// scroll jank on repeat views of the same chat.
//
// In-memory Map is the source of truth during a session. localStorage is
// the persistence layer — writes are debounced so rapid image-loads during
// a scroll don't thrash the storage API.

interface Dims { w: number; h: number }

const STORAGE_KEY = 'howl_img_dim_cache_v1';
const MAX_ENTRIES = 1500;
const PERSIST_DEBOUNCE_MS = 2000;

let _cache: Map<string, Dims> | null = null;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function hydrate(): Map<string, Dims> {
  if (_cache) return _cache;
  const cache = new Map<string, Dims>();
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, Dims>;
      for (const [url, dims] of Object.entries(parsed)) {
        if (dims && typeof dims.w === 'number' && typeof dims.h === 'number' && dims.w > 0 && dims.h > 0) {
          cache.set(url, dims);
        }
      }
    }
  } catch {
    // Corrupt JSON or storage disabled (private mode, quota, etc.) — start fresh.
  }
  _cache = cache;
  return cache;
}

function schedulePersist(): void {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      if (typeof localStorage === 'undefined') return;
      const cache = hydrate();
      const obj: Record<string, Dims> = {};
      for (const [url, dims] of cache) obj[url] = dims;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {
      // Quota exceeded / storage disabled — silent. Cache still works
      // in-memory for the rest of the session.
    }
  }, PERSIST_DEBOUNCE_MS);
}

export function getImageDims(url: string): Dims | undefined {
  if (!url) return undefined;
  return hydrate().get(url);
}

export function rememberImageDims(url: string, dims: Dims): void {
  if (!url || dims.w <= 0 || dims.h <= 0) return;
  const cache = hydrate();
  if (cache.has(url)) {
    // LRU refresh — delete then re-insert so this URL is most recently used.
    cache.delete(url);
  } else if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(url, dims);
  schedulePersist();
}
