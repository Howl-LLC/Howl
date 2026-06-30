// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Shared rate-limit store factory.
 *
 * In production Redis is REQUIRED — an in-memory MemoryStore per replica means each
 * instance keeps its own counters and a user hitting N replicas effectively
 * gets `documented_limit × N` requests, defeating the documented per-window limit.
 * We throw at import time in production so the platform restarts the replica instead of
 * silently serving traffic without functioning rate limits.
 *
 * In dev/test, the `undefined` fallback is preserved so local work without Redis
 * continues to function.
 */

import { timingSafeEqual } from 'crypto';
import RedisStore from 'rate-limit-redis';
import type { Request } from 'express';
import { redis } from './redis.js';
import { logger } from './logger.js';
import { getClientIp } from './utils/clientIp.js';

const log = logger.child({ module: 'rateLimitStore' });

/**
 * Optional load-test bypass for rate limiters. When LOAD_TEST_BYPASS_TOKEN is
 * set in the env (32+ chars) and a request carries a matching X-Loadtest-Bypass
 * header, the request skips rate limiting. Off by default — only active when
 * the env var is set, which makes it safe to ship.
 *
 * Per-route limiters that don't define their own `skip` will inherit this via
 * RATE_LIMIT_DEFAULTS.skip below. Limiters with their own `skip` must call
 * isLoadTestBypass() explicitly (see globalLimiter in server.ts).
 */
const loadTestBypassToken = process.env.LOAD_TEST_BYPASS_TOKEN;
const loadTestBypassBuf = loadTestBypassToken && loadTestBypassToken.length >= 32
  ? Buffer.from(loadTestBypassToken)
  : null;

export function isLoadTestBypass(req: { headers?: Record<string, string | string[] | undefined> }): boolean {
  if (!loadTestBypassBuf) return false;
  const header = req.headers?.['x-loadtest-bypass'];
  if (typeof header !== 'string' || header.length !== loadTestBypassBuf.length) return false;
  try {
    return timingSafeEqual(Buffer.from(header), loadTestBypassBuf);
  } catch {
    return false;
  }
}

/**
 * Shared defaults for every express-rate-limit instance.
 *
 * `skip: OPTIONS` is critical: CORS preflights must never be rate-limited.
 * If a preflight receives 429 without CORS headers the browser blocks the
 * real request entirely, breaking login flows (passkey, MFA) and other
 * cross-origin API calls.
 *
 * `keyGenerator` uses `getClientIp` instead of express's default `req.ip`
 * because Howl runs behind a CDN and one or more reverse proxies,
 * and Express's `trust proxy: 1` only peels one X-Forwarded-For hop, leaving
 * `req.ip` set to an edge/proxy IP shared by every visitor in
 * the region. See utils/clientIp.ts for the resolution order.
 */
export const RATE_LIMIT_DEFAULTS = {
  standardHeaders: true as const,
  legacyHeaders: false as const,
  skip: (req: { method?: string; headers?: Record<string, string | string[] | undefined> }) =>
    req.method === 'OPTIONS' || isLoadTestBypass(req),
  keyGenerator: (req: Request) => getClientIp(req) ?? 'anonymous',
};

let warnedMemoryFallback = false;

export function createRateLimitStore(prefix?: string): RedisStore | undefined {
  if (!redis) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'createRateLimitStore: REDIS_URL is not set in production. Refusing to start — ' +
        'in-memory rate-limit stores desync across replicas.',
      );
    }
    if (!warnedMemoryFallback) {
      warnedMemoryFallback = true;
      log.warn('REDIS_URL not set — rate limiters will use per-process MemoryStore (OK for dev/test only)');
    }
    return undefined;
  }

  return new RedisStore({
    // ioredis `.call()` sends raw Redis commands, which is what rate-limit-redis expects.
    sendCommand: (...args: string[]) => redis!.call(args[0], ...args.slice(1)) as Promise<any>,
    prefix: prefix ?? 'rl:',
  });
}

/** Called at boot to make the chosen backing store visible in logs. */
export function logRateLimitStoreChoice(): void {
  log.info({ store: redis ? 'redis' : 'memory' }, 'rate-limit store initialized');
}
