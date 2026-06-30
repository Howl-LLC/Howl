// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tokened media resolution for /api/uploads served files. The serve route's
 * `?as=json` mode returns a short-lived signed CDN URL as data, which avoids the
 * cross-origin 302->CDN CORS break a direct media fetch hits under signed-URL
 * strict mode. The first hop carries the auth (Bearer + cookie); the second hop
 * to the CDN is a bare GET whose signed query string is the capability. Extracted
 * from the original inline implementation in components/ChatArea.tsx so video,
 * images, and non-ChatArea surfaces (threads, forum) share one tokened path.
 */

/** Resolve a served upload URL to its short-lived signed CDN URL (for <video>/<audio> streaming). */
export async function fetchSignedMediaUrl(fullUrl: string, token: string | null, signal?: AbortSignal): Promise<string> {
  const sep = fullUrl.includes('?') ? '&' : '?';
  const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
  const metaRes = await fetch(`${fullUrl}${sep}as=json`, { headers, credentials: 'include', signal });
  if (!metaRes.ok) throw new Error(`as=json ${metaRes.status}`);
  const { url: signedUrl } = (await metaRes.json()) as { url?: string };
  if (!signedUrl) throw new Error('as=json: missing url field');
  return signedUrl;
}

/** Resolve + download a served upload as a Blob (for <img>); the CDN hop sends no headers. */
export async function fetchMediaBlobUrl(fullUrl: string, token: string | null, signal?: AbortSignal): Promise<Blob> {
  const signedUrl = await fetchSignedMediaUrl(fullUrl, token, signal);
  const r = await fetch(signedUrl, { signal });
  if (!r.ok) throw new Error(`CDN fetch ${r.status}`);
  return r.blob();
}
