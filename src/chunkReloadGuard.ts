// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Recovery for stale-deploy chunk-load failures.
 *
 * After a Cloudflare Pages redeploy, a still-running tab can fail to lazy-import
 * code-split chunks: the new index.html references new chunk hashes, but the
 * service worker (or HTTP cache) still serves the old shell, so requests for
 * the old chunks fall through to the SPA fallback (`index.html`, MIME text/html)
 * and the browser refuses to execute them ("Expected a JavaScript-or-Wasm
 * module script…"). The page can become unrecoverable until the user
 * manually hard-refreshes.
 *
 * This guard listens for those failures, evicts the service worker + caches
 * once, and reloads. A sessionStorage flag prevents an infinite reload loop
 * if the failure persists across the recovery (e.g. true CSP issue, not a
 * stale chunk).
 */

const RELOAD_FLAG_KEY = 'chunk-reload-attempted';

function isChunkLoadFailure(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('failed to fetch dynamically imported module') ||
    m.includes('failed to load module script') ||
    m.includes('importing a module script failed') ||
    // Vite's preload error from preload-helper.js
    (m.includes('expected a javascript') && m.includes('module script')) ||
    // Some browsers throw 'ChunkLoadError' (webpack-style, harmless to also catch)
    m.includes('chunkloaderror')
  );
}

async function evictAndReload(): Promise<void> {
  // Guard against reload loops.
  let attempted = false;
  try {
    attempted = sessionStorage.getItem(RELOAD_FLAG_KEY) === '1';
  } catch { /* private mode */ }
  if (attempted) {
    // Already tried recovery this session and still failing — surface the
    // error normally instead of bouncing the user forever.
    return;
  }
  try { sessionStorage.setItem(RELOAD_FLAG_KEY, '1'); } catch { /* ignore */ }

  // Best-effort SW + cache eviction. Failures here shouldn't block the reload.
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    }
  } catch { /* ignore */ }
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
    }
  } catch { /* ignore */ }

  // Cache-busting query string forces a fresh index.html fetch even when
  // intermediate proxies (Cloudflare edge) have a cached response.
  const url = new URL(window.location.href);
  url.searchParams.set('_reload', String(Date.now()));
  window.location.replace(url.toString());
}

/**
 * If we previously triggered a reload and this load succeeded, clear the
 * one-shot guard so the next stale-deploy can recover again later. Called
 * once from index.tsx after the app mounts.
 */
export function clearChunkReloadFlagOnSuccess(): void {
  // Defer past the first paint so we know rendering actually started.
  setTimeout(() => {
    try { sessionStorage.removeItem(RELOAD_FLAG_KEY); } catch { /* ignore */ }
  }, 5_000);
}

/**
 * Decide whether this error looks like a stale-deploy chunk failure and,
 * if so, kick off the eviction + reload. Returns true when recovery was
 * triggered so the caller can short-circuit other error handling.
 */
export function maybeRecoverFromChunkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : undefined;
  if (!isChunkLoadFailure(message)) return false;
  void evictAndReload();
  return true;
}

/**
 * Install global listeners. Idempotent.
 */
let installed = false;
export function installChunkReloadGuard(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (event) => {
    if (maybeRecoverFromChunkError(event.error ?? event.message)) {
      event.preventDefault();
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (maybeRecoverFromChunkError(event.reason)) {
      event.preventDefault();
    }
  });
}
