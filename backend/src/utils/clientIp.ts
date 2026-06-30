// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Real client-IP extraction for rate-limit keying and similar per-IP logic.
 *
 * Howl typically runs behind a CDN and one or more reverse proxies (e.g. a
 * Cloudflare edge in front of the app server). Express's `trust proxy: 1`
 * setting only peels the rightmost X-Forwarded-For hop, so `req.ip` resolves
 * to an edge/proxy address rather than the real visitor. Without this helper,
 * every IP-keyed rate limiter buckets thousands of users sharing a CDN PoP
 * into a single quota.
 *
 * Resolution order:
 *   1. `CF-Connecting-IP` — only set by Cloudflare; canonical when present.
 *   2. Leftmost entry in `X-Forwarded-For` — the original client per RFC 7239
 *      (already used by sso.ts / mfa.ts / sessionUtils.ts for forensic logging).
 *   3. `req.ip` — last-resort fallback for dev / non-proxied environments.
 *
 * Spoofing note: an attacker who can reach the app server's origin directly
 * (bypassing the CDN) can forge `CF-Connecting-IP` or `X-Forwarded-For`
 * headers. The `cloudflareGuard` middleware (when enabled via
 * `REQUIRE_CLOUDFLARE=true`) closes that bypass at the network edge by
 * rejecting connections whose underlying IP isn't in Cloudflare's published
 * ranges. Without the guard, the trust model here is the same as the existing
 * forensic-logging code: we trust XFF because no better signal is available.
 */

import type { Request } from 'express';

export function getClientIp(req: Request): string | undefined {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length > 0) return cf.trim();

  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }

  return req.ip;
}
