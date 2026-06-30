// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Single-use challenge / token replay protection.
 *
 * In multi-replica cluster mode, a per-replica `Map<fingerprint, ts>` only
 * enforces single-use within one process. A leaked MFA / device-verify /
 * admin MFA / admin passkey token replayed against a different replica would
 * be accepted. `markTokenUsedOnce` migrates the mark-or-fail to Redis SET NX
 * so the enforcement is global and atomic.
 *
 * These tests exercise the helper directly with a shared mock Redis client
 * shimmed in via vi.doMock, simulating two replicas calling the helper with
 * the same fingerprint:
 *   - first call → SET NX returns 'OK' → helper returns true (allowed).
 *   - second call → SET NX returns null → helper returns false (rejected).
 *
 * Production fail-fast is verified separately by the rateLimitStore test
 * (which already covers the same boot guard pattern); this file targets the
 * per-call atomicity guarantee.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

describe('markTokenUsedOnce — multi-replica replay protection', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('rejects replay against a shared mock Redis (cluster mode)', async () => {
    vi.resetModules();

    // Simulated Redis backing store, shared across both "replicas".
    const store = new Map<string, string>();
    const sharedRedis = {
      set: vi.fn(async (key: string, _value: string, ..._args: unknown[]) => {
        // SET NX semantics: only set if key absent; return 'OK' on insert,
        // null on no-op (key already present).
        if (store.has(key)) return null;
        store.set(key, '1');
        return 'OK';
      }),
      exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    };

    vi.doMock('../src/redis.js', () => ({ redis: sharedRedis }));

    const { markTokenUsedOnce, isTokenAlreadyUsed } = await import('../src/utils/singleUseToken.js');

    const fingerprint = 'replay-fp-001';
    const ttl = 600;

    // Replica A claims the token first → must succeed.
    const firstClaim = await markTokenUsedOnce('mfa:used-challenge', fingerprint, ttl);
    expect(firstClaim).toBe(true);

    // Replica B tries to replay the same token → must be rejected.
    const secondClaim = await markTokenUsedOnce('mfa:used-challenge', fingerprint, ttl);
    expect(secondClaim).toBe(false);

    // Read-only short-circuit also reflects the claim.
    expect(await isTokenAlreadyUsed('mfa:used-challenge', fingerprint)).toBe(true);

    // Both calls hit Redis with SET NX (we don't fall back to in-memory under cluster mode).
    expect(sharedRedis.set).toHaveBeenCalledTimes(2);
    expect(sharedRedis.set).toHaveBeenNthCalledWith(
      1, 'mfa:used-challenge:replay-fp-001', '1', 'EX', ttl, 'NX',
    );
    expect(sharedRedis.set).toHaveBeenNthCalledWith(
      2, 'mfa:used-challenge:replay-fp-001', '1', 'EX', ttl, 'NX',
    );
  });

  it('keeps namespaces independent (admin MFA token != user MFA challenge)', async () => {
    vi.resetModules();

    const store = new Map<string, string>();
    const sharedRedis = {
      set: vi.fn(async (key: string, _v: string, ..._args: unknown[]) => {
        if (store.has(key)) return null;
        store.set(key, '1');
        return 'OK';
      }),
      exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    };
    vi.doMock('../src/redis.js', () => ({ redis: sharedRedis }));

    const { markTokenUsedOnce } = await import('../src/utils/singleUseToken.js');

    // Same fingerprint string, different namespaces — both should claim cleanly.
    expect(await markTokenUsedOnce('mfa:used-challenge', 'shared-fp', 600)).toBe(true);
    expect(await markTokenUsedOnce('admin:used-mfa-token', 'shared-fp', 600)).toBe(true);
    expect(await markTokenUsedOnce('auth:used-device-verify', 'shared-fp', 600)).toBe(true);
    expect(await markTokenUsedOnce('admin-passkey:used-token', 'shared-fp', 600)).toBe(true);

    // Replays in any namespace are rejected.
    expect(await markTokenUsedOnce('mfa:used-challenge', 'shared-fp', 600)).toBe(false);
    expect(await markTokenUsedOnce('admin:used-mfa-token', 'shared-fp', 600)).toBe(false);
  });

  it('falls back to in-memory enforcement when Redis is unavailable (dev/test only)', async () => {
    vi.resetModules();
    vi.doMock('../src/redis.js', () => ({ redis: null }));

    const mod = await import('../src/utils/singleUseToken.js');
    mod._resetSingleUseFallbackForTests();

    const fp = 'dev-mode-fp';
    expect(await mod.markTokenUsedOnce('mfa:used-challenge', fp, 600)).toBe(true);
    expect(await mod.markTokenUsedOnce('mfa:used-challenge', fp, 600)).toBe(false);
    expect(await mod.isTokenAlreadyUsed('mfa:used-challenge', fp)).toBe(true);
  });

  it('expires fallback entries after TTL elapses', async () => {
    vi.resetModules();
    vi.doMock('../src/redis.js', () => ({ redis: null }));
    vi.useFakeTimers();

    try {
      const mod = await import('../src/utils/singleUseToken.js');
      mod._resetSingleUseFallbackForTests();

      const fp = 'ttl-fp';
      expect(await mod.markTokenUsedOnce('mfa:used-challenge', fp, 1)).toBe(true);
      expect(await mod.markTokenUsedOnce('mfa:used-challenge', fp, 1)).toBe(false);

      // Advance past the 1-second TTL — entry should be evicted on next check.
      vi.advanceTimersByTime(2_000);
      expect(await mod.isTokenAlreadyUsed('mfa:used-challenge', fp)).toBe(false);
      expect(await mod.markTokenUsedOnce('mfa:used-challenge', fp, 1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
