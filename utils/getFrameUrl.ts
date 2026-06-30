// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { CDN_URL, getBackendOrigin } from '../config';

/**
 * Derive the frozen frame URL for a GIF uploaded to Howl.
 * Returns undefined for non-GIF URLs, external URLs (Klipy, Tenor), or blob URLs.
 *
 * Convention: uploads/{uuid}.gif → uploads/frame_{uuid}.webp
 * Matches the existing thumb_ prefix pattern.
 */
// eslint-disable-next-line security/detect-unsafe-regex
const UPLOADS_GIF_RE = /\/uploads\/([^/?]+)\.gif(?:\?.*)?$/i;

export function getFrameUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  if (!UPLOADS_GIF_RE.test(url)) return undefined;
  // Only for Howl uploads — API paths or CDN domain, not external CDNs
  const isHowl = url.includes('/api/uploads/') ||
    (!!CDN_URL && url.startsWith(CDN_URL)) ||
    url.startsWith(getBackendOrigin());
  if (!isHowl) return undefined;
  // eslint-disable-next-line security/detect-unsafe-regex
  return url.replace(/\/([^/?]+)\.gif(?:\?.*)?$/i, '/frame_$1.webp');
}
