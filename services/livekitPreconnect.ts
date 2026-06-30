// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tier 2 latency optimization: TCP/TLS preconnect to LiveKit SFU endpoints
 * while the user merely hovers a voice channel in the sidebar. When the
 * user actually clicks, the browser reuses the already-warm TCP+TLS
 * connection for the WebSocket upgrade (signal server) and for the
 * subsequent WebRTC signaling requests, saving the handshake RTT (~80–
 * 250ms depending on distance to region).
 *
 * Unlike "hover preconnect to the room" schemes, this does NOT:
 *  - Write any Redis state (no ghost voice participants)
 *  - Request mic permission (no UX prompt surprises)
 *  - Issue a LiveKit token (no resource allocation)
 *
 * It only emits a `<link rel="preconnect">` tag the browser uses to
 * establish TCP + TLS (and HTTP/2 or HTTP/3 session) to the host early.
 * Any WebSocket upgrade or HTTPS request to that origin later in the
 * session reuses the warm connection.
 */

/** LiveKit URLs seen so far in this session (from inline token ACKs or
 *  HTTP token responses). We preconnect to all of them on hover since
 *  TCP+TLS warmup is cheap and we don't always know which region a
 *  specific voice channel resolves to until the user actually joins. */
const seenUrls = new Set<string>();

/** Origins that have an active preconnect <link> in the document head.
 *  Using a Set avoids duplicate tags when the user hovers repeatedly. */
const linkedOrigins = new Set<string>();

/** Convert a LiveKit URL (wss://... or https://...) to a browser-friendly
 *  origin suitable for `<link rel="preconnect" href="...">`. Returns null
 *  for inputs that can't be parsed (defensive — we cache URLs from the
 *  server so they should always be valid, but be resilient anyway). */
function urlToPreconnectOrigin(raw: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.replace(/^wss?:/, (m) => (m === 'ws:' ? 'http:' : 'https:')));
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Call after each successful LiveKit connection with the region URL the
 *  backend returned. Populates the cache used by preconnectAll(). */
export function cacheLiveKitUrl(url: string | null | undefined): void {
  if (!url) return;
  seenUrls.add(url);
}

/** Call on hover of a voice-channel sidebar item (or similar). Injects
 *  `<link rel="preconnect">` tags for every LiveKit URL we've seen this
 *  session so the browser has warm TCP+TLS ready if the user clicks.
 *  No-op server-side (SSR) since document is undefined. */
export function preconnectAll(): void {
  if (typeof document === 'undefined' || seenUrls.size === 0) return;
  for (const url of seenUrls) {
    const origin = urlToPreconnectOrigin(url);
    if (!origin || linkedOrigins.has(origin)) continue;
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
    linkedOrigins.add(origin);
  }
}
