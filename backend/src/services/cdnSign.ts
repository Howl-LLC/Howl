// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * HMAC-signed CDN URL helper.
 *
 * The R2-backed CDN at cdn.howlpro.com was previously served with permanently-
 * valid public URLs. This module issues short-lived HMAC-signed URLs that a
 * Cloudflare Worker validates at the edge, matching Discord's approach.
 *
 * Wire format: `${CDN_BASE_URL}/${key}?exp=<unix-seconds>&sig=<base64url>`
 * Signed message: `${key}:${exp}`
 * Algorithm: HMAC-SHA256 over UTF-8 bytes, base64url-encoded (RFC 4648).
 *
 * The shared secret (`CDN_SIGNING_SECRET`) must match the Worker's secret.
 */

import { createHmac } from 'crypto';
import { CDN_BASE_URL, CDN_SIGNING_SECRET } from './s3.js';

// Short replay window — the client re-requests `?as=json` immediately
// before each blob fetch, so a 5-minute signed URL is ample.
export const CDN_URL_TTL_SECONDS = Number(process.env.CDN_URL_TTL_SECONDS) || 300;

export function signCdnUrl(key: string): string {
  const exp = Math.floor(Date.now() / 1000) + CDN_URL_TTL_SECONDS;
  const message = `${key}:${exp}`;
  const sig = createHmac('sha256', CDN_SIGNING_SECRET)
    .update(message)
    .digest('base64url');
  return `${CDN_BASE_URL}/${key}?exp=${exp}&sig=${sig}`;
}
