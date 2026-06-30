// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
const SAFE_PROTOCOLS = /^(https?:\/\/|\/|data:image\/(png|jpeg|jpg|gif|webp|avif)(;|,))/i;

/**
 * Ensures an image URL only uses safe protocols (http, https, relative paths,
 * or data:image URIs for known safe raster formats only).
 * Blocks SVG (script injection) and other MIME types.
 * Returns empty string for anything else to prevent protocol-based attacks.
 */
export function sanitizeImgSrc(url: string | null | undefined): string {
  if (!url) return '';
  const trimmed = url.trim();
  if (SAFE_PROTOCOLS.test(trimmed)) return trimmed;
  return '';
}
