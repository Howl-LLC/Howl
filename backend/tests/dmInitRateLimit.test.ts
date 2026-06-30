// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression tests for the Redis-backed DM-init sliding-window cap.
 *
 * Bug: `dmInitTimestamps` was a per-process Map. In multi-replica deploys, a
 * single user could create `15 × N` new DM channels per hour by spreading
 * requests across replicas — each replica saw its own counter.
 *
 * Fix: `isDmInitRateLimited` + `recordDmInit` now back the counter with a
 * Redis sorted-set sliding window. This test exercises the in-memory fallback
 * path (no Redis configured) plus a fake-Redis path that simulates real
 * sorted-set semantics, asserting the documented contract:
 *   - 15 calls in 1 hour pass, the 16th is rate-limited.
 *   - After the window slides past, the budget refills.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as redisModule from '../src/redis.js';
import type Redis from 'ioredis';

// `redis` is a module-scoped `export let`. ESM namespace exports are read-only,
// so we swap the live binding through the module's test-only setter and restore
// the original in afterEach.
const originalRedis = redisModule.redis;

type FakeRedis = Pick<Redis, 'eval'>;

function setRedis(client: FakeRedis | null): void {
  redisModule.__setRedisForTests(client as Redis | null);
}

/**
 * Minimal in-process simulation of the Redis sorted-set commands the helpers
 * use (`zremrangebyscore`, `zcard`, `zadd`, `expire`). Keeps insertion order
 * and supports `-inf` as the lower bound. Sufficient to verify the helpers'
 * Lua scripts behave as advertised.
 */
function makeFakeRedis(): FakeRedis {
  const sets = new Map<string, Array<{ score: number; member: string }>>();

  function zremrangebyscore(key: string, min: string, max: string): void {
    const arr = sets.get(key);
    if (!arr) return;
    const minN = min === '-inf' ? -Infinity : Number(min);
    const maxN = max === '+inf' ? Infinity : Number(max);
    const filtered = arr.filter((e) => e.score < minN || e.score > maxN);
    sets.set(key, filtered);
  }

  function zcard(key: string): number {
    return sets.get(key)?.length ?? 0;
  }

  function zadd(key: string, score: number, member: string): void {
    const arr = sets.get(key) ?? [];
    arr.push({ score, member });
    sets.set(key, arr);
  }

  // The helpers use two scripts — one read-only (zremrangebyscore + zcard),
  // one write (zremrangebyscore + zadd + expire). We pattern-match on the
  // script text so the fake stays decoupled from argument order.
  const evalImpl = vi.fn(async (script: string, _numKeys: number, ...args: unknown[]) => {
    const key = String(args[0]);
    const argv = args.slice(1).map(String);

    if (script.includes('zadd')) {
      // recordDmInit: ZREMRANGEBYSCORE + ZADD + EXPIRE
      const windowStart = argv[0];
      const now = argv[1];
      zremrangebyscore(key, '-inf', windowStart);
      zadd(key, Number(now), `${now}-${Math.random()}`);
      // expire is a no-op in the fake — TTL semantics aren't under test here.
      return 1;
    }
    // isDmInitRateLimited: ZREMRANGEBYSCORE + ZCARD
    const windowStart = argv[0];
    zremrangebyscore(key, '-inf', windowStart);
    return zcard(key);
  });

  return { eval: evalImpl } as unknown as FakeRedis;
}

describe('isDmInitRateLimited / recordDmInit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T00:00:00Z'));
  });

  afterEach(() => {
    setRedis(originalRedis as FakeRedis | null);
    vi.useRealTimers();
  });

  describe('Redis-backed path (multi-replica deployment)', () => {
    it('rejects the 16th call within an hour and refills after the window slides', async () => {
      setRedis(makeFakeRedis());
      const userId = 'user-d27-005';

      // 15 successful inits within 30 min — all should pass `isDmInitRateLimited`
      // before the record, then bump the counter.
      for (let i = 0; i < 15; i++) {
        expect(await redisModule.isDmInitRateLimited(userId)).toBe(false);
        await redisModule.recordDmInit(userId);
        vi.advanceTimersByTime(60_000); // +1 minute between inits
      }

      // 16th attempt — must be rejected.
      expect(await redisModule.isDmInitRateLimited(userId)).toBe(true);

      // Slide the window: jump 1 hour past the most recent recorded init so
      // every prior entry has scrolled out of the 1-hour window.
      vi.advanceTimersByTime(60 * 60_000);

      expect(await redisModule.isDmInitRateLimited(userId)).toBe(false);
      // And we can record + check again under the refilled budget.
      await redisModule.recordDmInit(userId);
      expect(await redisModule.isDmInitRateLimited(userId)).toBe(false);
    });

    it('isolates counters per user', async () => {
      setRedis(makeFakeRedis());

      for (let i = 0; i < 15; i++) {
        await redisModule.recordDmInit('user-A');
      }
      expect(await redisModule.isDmInitRateLimited('user-A')).toBe(true);
      expect(await redisModule.isDmInitRateLimited('user-B')).toBe(false);
    });
  });

  describe('In-memory fallback path (single-replica dev)', () => {
    it('rejects the 16th call within an hour and refills after the window slides', async () => {
      setRedis(null);
      const userId = 'user-d27-005-mem';

      for (let i = 0; i < 15; i++) {
        expect(await redisModule.isDmInitRateLimited(userId)).toBe(false);
        await redisModule.recordDmInit(userId);
        vi.advanceTimersByTime(60_000);
      }

      expect(await redisModule.isDmInitRateLimited(userId)).toBe(true);

      vi.advanceTimersByTime(60 * 60_000);
      expect(await redisModule.isDmInitRateLimited(userId)).toBe(false);
    });
  });
});
