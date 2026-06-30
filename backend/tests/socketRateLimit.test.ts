// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression tests for `checkSocketRateLimit` fail-closed behaviour.
 *
 * Bug: The Redis branch's catch block returned `true` (allowed) on any EVAL
 * error. Every callsite reads `true` as "under the limit," so a transient
 * Redis hiccup (Lua error, connection reset, non-numeric reply) silently
 * disabled the limiter until Redis recovered.
 *
 * Fix: Fall back to the in-memory `memSocketRates` accounting on error
 * instead of fail-open. Only return `true` if that bucket is also under
 * the budget.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We need to swap in a fake `redis` client. `redis.ts` initialises its module
// state from `REDIS_URL`, so we mock the whole `ioredis` constructor and set
// `REDIS_URL` before the (fresh) module loads. Each test resets modules so
// the per-test fake is what the freshly-imported `redis.ts` sees.
const evalSpy = vi.fn();
const delSpy = vi.fn();

class FakeRedis {
  on(): this { return this; }
  // `redis.ts` runs side-effectful subscribe/duplicate calls at module load.
  // Stub them so the import itself succeeds.
  async subscribe(): Promise<number> { return 1; }
  duplicate(): FakeRedis { return new FakeRedis(); }
  eval = evalSpy;
  del = delSpy;
}

beforeEach(() => {
  vi.resetModules();
  evalSpy.mockReset();
  delSpy.mockReset();
  process.env.REDIS_URL = 'redis://fake:6379';
  vi.doMock('ioredis', () => ({ default: FakeRedis }));
});

afterEach(() => {
  delete process.env.REDIS_URL;
  vi.doUnmock('ioredis');
  vi.resetModules();
});

async function loadRedisModule() {
  return await import('../src/redis.js');
}

describe('checkSocketRateLimit', () => {
  it('falls back to in-memory accounting when Redis EVAL throws (does not fail-open)', async () => {
    evalSpy.mockRejectedValue(new Error('ECONNRESET'));
    const mod = await loadRedisModule();

    const limit = 3;
    const windowMs = 60_000;

    // Burn through the in-memory budget. All four calls go through Redis (which
    // throws) → fall back to the per-process map → only the last one returns
    // false. Pre-fix: every call would return true (fail-open).
    const r1 = await mod.checkSocketRateLimit('user-fail-closed', limit, windowMs);
    const r2 = await mod.checkSocketRateLimit('user-fail-closed', limit, windowMs);
    const r3 = await mod.checkSocketRateLimit('user-fail-closed', limit, windowMs);
    const r4 = await mod.checkSocketRateLimit('user-fail-closed', limit, windowMs);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);
    expect(r4).toBe(false); // 4th call exceeds limit=3 — proves fallback engaged.
    expect(evalSpy).toHaveBeenCalledTimes(4);
  });

  it('falls back to in-memory accounting when Redis EVAL returns a non-numeric reply', async () => {
    // Simulate a malformed Lua response (e.g. ["error", ...] array, string, null).
    evalSpy.mockResolvedValue(null);
    const mod = await loadRedisModule();

    const limit = 2;
    const windowMs = 60_000;

    const r1 = await mod.checkSocketRateLimit('user-fail-closed', limit, windowMs);
    const r2 = await mod.checkSocketRateLimit('user-fail-closed', limit, windowMs);
    const r3 = await mod.checkSocketRateLimit('user-fail-closed', limit, windowMs);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(false); // 3rd call exceeds limit=2 — fallback engaged.
    expect(evalSpy).toHaveBeenCalledTimes(3);
  });

  it('uses Redis result when EVAL returns a healthy numeric reply', async () => {
    // Numeric reply ≤ limit → allowed. Numeric reply > limit → denied.
    let counter = 0;
    evalSpy.mockImplementation(async () => ++counter);
    const mod = await loadRedisModule();

    const limit = 2;
    const windowMs = 60_000;

    expect(await mod.checkSocketRateLimit('user-fail-closed', limit, windowMs)).toBe(true);  // counter=1
    expect(await mod.checkSocketRateLimit('user-fail-closed', limit, windowMs)).toBe(true);  // counter=2
    expect(await mod.checkSocketRateLimit('user-fail-closed', limit, windowMs)).toBe(false); // counter=3
  });
});
