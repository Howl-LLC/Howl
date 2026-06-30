// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for the `createRateLimitStore` guard.
 *
 * In production, a missing Redis connection must throw at import/init time so
 * the replica restarts rather than silently degrading to per-process
 * MemoryStore (which allows `documented_limit × N_replicas` in practice).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

describe('createRateLimitStore', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.resetModules();
  });

  it('returns a store object when Redis is available', async () => {
    vi.resetModules();
    // Provide a redis stub that returns benign script-load replies so rate-limit-redis's
    // internal loadScript calls don't surface as unhandled rejections.
    vi.doMock('../src/redis.js', () => ({
      redis: {
        call: vi.fn().mockResolvedValue('sha1-placeholder'),
      },
    }));

    const mod = await import('../src/rateLimitStore.js');
    const store = mod.createRateLimitStore('test:');
    expect(store).toBeDefined();
    expect(typeof (store as any).increment).toBe('function');
  });

  it('returns undefined (MemoryStore fallback) in non-production when Redis is missing', async () => {
    vi.resetModules();
    vi.doMock('../src/redis.js', () => ({ redis: null }));
    process.env.NODE_ENV = 'test';

    const mod = await import('../src/rateLimitStore.js');
    const store = mod.createRateLimitStore('test:');
    expect(store).toBeUndefined();
  });

  it('throws in production when Redis is missing', async () => {
    vi.resetModules();
    vi.doMock('../src/redis.js', () => ({ redis: null }));
    process.env.NODE_ENV = 'production';

    const mod = await import('../src/rateLimitStore.js');
    expect(() => mod.createRateLimitStore('test:')).toThrow(/REDIS_URL/);
  });
});
