// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Cloudflare-only ingress guard.
 *
 * When enabled (env `REQUIRE_CLOUDFLARE=true`), rejects any request whose
 * underlying connection IP isn't in Cloudflare's published edge ranges. This
 * closes the bypass that would otherwise let an attacker reach the origin
 * server directly (via its platform-assigned hostname) and spoof `CF-Connecting-IP`
 * to dodge per-IP rate limits.
 *
 * Off by default so local dev (`npm run dev` direct against Express) and
 * tests still work. Turn on in production via an env var after confirming
 * api.howlpro.com routes through Cloudflare AND the origin hostname is
 * either non-public or not relied on.
 *
 * Cloudflare IP ranges are published at:
 *   https://www.cloudflare.com/ips-v4
 *   https://www.cloudflare.com/ips-v6
 *
 * The list is pinned here rather than fetched at boot to avoid a startup
 * network dependency. Cloudflare announces additions in advance and updates
 * are rare; refresh this constant manually when the announcement post
 * mentions a new range.
 */

import type { Request, Response, NextFunction } from 'express';
import ipaddr from 'ipaddr.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'cloudflareGuard' });

const CLOUDFLARE_RANGES_V4: Array<[ipaddr.IPv4, number]> = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
].map((cidr) => ipaddr.IPv4.parseCIDR(cidr));

const CLOUDFLARE_RANGES_V6: Array<[ipaddr.IPv6, number]> = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
].map((cidr) => ipaddr.IPv6.parseCIDR(cidr));

function isCloudflareIp(raw: string | undefined): boolean {
  if (!raw) return false;
  // Strip IPv4-mapped IPv6 prefix that Node's req.socket.remoteAddress sometimes emits.
  const cleaned = raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(cleaned);
  } catch {
    return false;
  }
  if (parsed.kind() === 'ipv4') {
    return CLOUDFLARE_RANGES_V4.some((range) => (parsed as ipaddr.IPv4).match(range));
  }
  return CLOUDFLARE_RANGES_V6.some((range) => (parsed as ipaddr.IPv6).match(range));
}

const REQUIRE_CLOUDFLARE = process.env.REQUIRE_CLOUDFLARE === 'true';
let warnedNoSocketAddress = false;

export function cloudflareGuard(req: Request, res: Response, next: NextFunction): void {
  if (!REQUIRE_CLOUDFLARE) return next();
  // Skip CORS preflights — they must always succeed regardless.
  if (req.method === 'OPTIONS') return next();
  // Skip platform/CF healthchecks (load balancer pings origin directly).
  if (req.path === '/health' || req.path === '/api/health' || req.path === '/api/v1/health') return next();

  const peer = req.socket.remoteAddress;
  if (!peer) {
    if (!warnedNoSocketAddress) {
      warnedNoSocketAddress = true;
      log.warn('req.socket.remoteAddress is unavailable; cloudflareGuard cannot enforce');
    }
    return next();
  }

  if (isCloudflareIp(peer)) return next();

  log.warn({ peer, path: req.path }, 'cloudflareGuard: rejecting non-Cloudflare connection');
  res.status(403).json({ error: 'Direct origin access is not permitted.' });
}
