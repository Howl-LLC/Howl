// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { SyntheticEvent } from 'react';

/**
 * CDN uploads are served via 30-min HMAC-signed URLs. When a cached `<img>`
 * element's signed URL expires the browser will receive 403 and fire `onError`.
 *
 * This handler refetches the element via `/api/uploads/<filename>` (which the
 * backend redirects to a freshly signed CDN URL) with a cache-buster query
 * param. Guarded by `data-retried` so we never loop.
 *
 * Elements opt in by setting `data-original-src` to the unresolved
 * `/api/uploads/...` path (use `toOriginalUploadPath()` when the raw path
 * isn't at hand).
 *
 * Returns `true` when a retry was issued, `false` otherwise — callers that
 * already had an `onError` handler can use this to decide whether to also
 * run their existing fallback immediately (no retry) or wait for the retry
 * to fail a second time (at which point this no-ops and the caller's
 * fallback should run).
 */
export function retryOnExpired(
  e: SyntheticEvent<HTMLImageElement | HTMLVideoElement>,
): boolean {
  const el = e.currentTarget;
  if (el.dataset.retried === '1') return false;
  const original = el.dataset.originalSrc;
  if (!original) return false;
  el.dataset.retried = '1';
  const sep = original.includes('?') ? '&' : '?';
  el.src = `${original}${sep}_=${Date.now()}`;
  return true;
}

/**
 * Derive the unresolved backend path (`/api/uploads/<filename>`) from any
 * URL that references a Howl upload — whether it's already relative
 * (`/api/uploads/<f>`) or resolved through the backend origin
 * (`https://api.howlpro.com/api/uploads/<f>`). Returns undefined for
 * anything else (blob:, data:, twemoji, external hosts) so callers can
 * skip wiring retry for those.
 */
export function toOriginalUploadPath(
  url: string | null | undefined,
): string | undefined {
  if (!url) return undefined;
  const apiIdx = url.indexOf('/api/uploads/');
  if (apiIdx !== -1) return url.slice(apiIdx);
  return undefined;
}
