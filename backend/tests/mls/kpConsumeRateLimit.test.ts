// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Per-target KeyPackage consume rate-limit (pool-drain FS-DoS bound).
 *
 * The existing DM-init limiter is per-SENDER and does not cover member-add, so
 * colluders could drain a victim's single-use KeyPackage pool to pin everyone
 * onto the reused last-resort package (widening the forward-secrecy window).
 * The fix is a per-TARGET (victim) consume bound keyed `kp-consume:${targetId}`,
 * mirroring the `isDmInitRateLimited`/`recordDmInit` split read/write ZSET pattern.
 *
 * These cases exercise the in-memory fallback path (no Redis configured).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as redisModule from '../../src/redis.js';
import type Redis from 'ioredis';

// `redis` is a module-scoped `export let`. ESM namespace exports are read-only,
// so we swap the live binding through the module's test-only setter and restore
// the original in afterEach (matches dmInitRateLimit.test.ts).
const originalRedis = redisModule.redis;

beforeEach(() => {
  redisModule.__setRedisForTests(null); // force the in-memory fallback (no Redis in unit test)
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  redisModule.__setRedisForTests(originalRedis as Redis | null); // restore module default
});

describe('per-target KeyPackage consume bound (in-memory fallback)', () => {
  it('blocks after KP_CONSUME_RATE_MAX consumes within the window', async () => {
    const target = randomUUID();
    for (let i = 0; i < redisModule.KP_CONSUME_RATE_MAX; i++) {
      expect(await redisModule.isKpConsumeRateLimited(target)).toBe(false);
      await redisModule.recordKpConsume(target);
    }
    expect(await redisModule.isKpConsumeRateLimited(target)).toBe(true);
  });

  it('lets the window slide so consumes resume after it elapses', async () => {
    const target = randomUUID();
    for (let i = 0; i < redisModule.KP_CONSUME_RATE_MAX; i++) await redisModule.recordKpConsume(target);
    expect(await redisModule.isKpConsumeRateLimited(target)).toBe(true);
    vi.advanceTimersByTime(1000 * 60 * 60 + 1000); // > 1h window
    expect(await redisModule.isKpConsumeRateLimited(target)).toBe(false);
  });

  it('is keyed per target — draining one victim does not limit another', async () => {
    const a = randomUUID();
    const b = randomUUID();
    for (let i = 0; i < redisModule.KP_CONSUME_RATE_MAX; i++) await redisModule.recordKpConsume(a);
    expect(await redisModule.isKpConsumeRateLimited(a)).toBe(true);
    expect(await redisModule.isKpConsumeRateLimited(b)).toBe(false);
  });
});

// A per-(caller,target) sub-limit so ONE abuser cannot spend the
// shared per-target budget and 429 every legitimate group-adder (Impact a).
describe('per-(caller,target) KeyPackage consume bound (in-memory fallback)', () => {
  it('blocks a single caller after KP_CONSUME_CALLER_MAX requests against one target', async () => {
    const caller = randomUUID();
    const target = randomUUID();
    for (let i = 0; i < redisModule.KP_CONSUME_CALLER_MAX; i++) {
      expect(await redisModule.isKpConsumeCallerLimited(caller, target)).toBe(false);
      await redisModule.recordKpConsumeCaller(caller, target);
    }
    expect(await redisModule.isKpConsumeCallerLimited(caller, target)).toBe(true);
  });

  it('is keyed per (caller,target): one abuser maxing out does NOT limit another caller (Impact a)', async () => {
    const abuser = randomUUID();
    const honest = randomUUID();
    const target = randomUUID();
    for (let i = 0; i < redisModule.KP_CONSUME_CALLER_MAX; i++) await redisModule.recordKpConsumeCaller(abuser, target);
    expect(await redisModule.isKpConsumeCallerLimited(abuser, target)).toBe(true);
    expect(await redisModule.isKpConsumeCallerLimited(honest, target)).toBe(false);
  });

  it('is keyed per target too: maxing one target does not limit the same caller against another', async () => {
    const caller = randomUUID();
    const t1 = randomUUID();
    const t2 = randomUUID();
    for (let i = 0; i < redisModule.KP_CONSUME_CALLER_MAX; i++) await redisModule.recordKpConsumeCaller(caller, t1);
    expect(await redisModule.isKpConsumeCallerLimited(caller, t1)).toBe(true);
    expect(await redisModule.isKpConsumeCallerLimited(caller, t2)).toBe(false);
  });

  it('lets the window slide so the caller can consume again after it elapses', async () => {
    const caller = randomUUID();
    const target = randomUUID();
    for (let i = 0; i < redisModule.KP_CONSUME_CALLER_MAX; i++) await redisModule.recordKpConsumeCaller(caller, target);
    expect(await redisModule.isKpConsumeCallerLimited(caller, target)).toBe(true);
    vi.advanceTimersByTime(1000 * 60 * 60 + 1000); // > 1h window
    expect(await redisModule.isKpConsumeCallerLimited(caller, target)).toBe(false);
  });

  it('counts per package: one multi-device request charges the caller by count', async () => {
    const caller = randomUUID();
    const target = randomUUID();
    await redisModule.recordKpConsumeCaller(caller, target, redisModule.KP_CONSUME_CALLER_MAX);
    expect(await redisModule.isKpConsumeCallerLimited(caller, target)).toBe(true);
  });
});

// Monopoly invariant: the per-(caller,target) cap must stay well below the
// per-target aggregate (BOTH package-counted) so no single account can saturate the
// shared budget and 429 every legitimate adder — for ANY device count (take:50).
describe('monopoly invariant', () => {
  it('per-caller cap is well below the per-target aggregate, even for a worst-case max-device add', () => {
    expect(redisModule.KP_CONSUME_CALLER_MAX).toBeLessThan(redisModule.KP_CONSUME_RATE_MAX);
    // Worst case: a caller sits just under its cap, then lands one take:50-device add,
    // so its max contribution to the shared aggregate is ~CALLER_MAX + (50 - 1).
    const worstCallerContribution = redisModule.KP_CONSUME_CALLER_MAX + 49;
    expect(worstCallerContribution * 2).toBeLessThanOrEqual(redisModule.KP_CONSUME_RATE_MAX);
  });
});

// The per-target aggregate counts PACKAGES actually consumed, not
// requests, so it reflects true single-use pool drain.
describe('per-package consume accounting (in-memory fallback)', () => {
  it('records one event per package consumed: a single multi-package request advances the counter by count', async () => {
    const target = randomUUID();
    await redisModule.recordKpConsume(target, redisModule.KP_CONSUME_RATE_MAX); // one request draining MAX packages
    expect(await redisModule.isKpConsumeRateLimited(target)).toBe(true);
  });

  it('defaults to one event when no count is given (back-compat with the per-request callers)', async () => {
    const target = randomUUID();
    await redisModule.recordKpConsume(target);
    expect(await redisModule.isKpConsumeRateLimited(target)).toBe(false);
  });
});

// The victim low-water / last-resort-in-use signal is debounced so
// an attacker cannot notification-bomb the victim by hammering the consume route.
describe('victim low-water signal debounce (in-memory fallback)', () => {
  it('signals at most once per debounce window per target', async () => {
    const target = randomUUID();
    expect(await redisModule.shouldSignalKpLowWater(target)).toBe(true);
    expect(await redisModule.shouldSignalKpLowWater(target)).toBe(false);
  });

  it('debounces per target (one victim signalling does not suppress another)', async () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(await redisModule.shouldSignalKpLowWater(a)).toBe(true);
    expect(await redisModule.shouldSignalKpLowWater(b)).toBe(true);
  });

  it('allows another signal after the debounce window elapses', async () => {
    const target = randomUUID();
    expect(await redisModule.shouldSignalKpLowWater(target)).toBe(true);
    vi.advanceTimersByTime(redisModule.KP_LOW_WATER_SIGNAL_DEBOUNCE_MS + 1000);
    expect(await redisModule.shouldSignalKpLowWater(target)).toBe(true);
  });
});
