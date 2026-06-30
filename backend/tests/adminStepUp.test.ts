// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Admin step-up proof helper tests.
 *
 * Exercises the Redis-backed proof store + its in-memory fallback for dev.
 * Covers set / has / clear and TTL expiry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/redis.js', () => ({
  redis: null,
}));

vi.mock('../src/socketHandlers/infrastructure.js', () => ({
  cappedMapSet: (map: Map<string, unknown>, k: string, v: unknown) => { map.set(k, v); },
}));

describe('adminStepUp helpers (in-memory fallback)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('set + has returns true within TTL', async () => {
    const mod = await import('../src/utils/adminStepUp.js');
    await mod.setAdminStepUp('admin-1');
    expect(await mod.hasAdminStepUp('admin-1')).toBe(true);
  });

  it('has returns false before set', async () => {
    const mod = await import('../src/utils/adminStepUp.js');
    expect(await mod.hasAdminStepUp('admin-never')).toBe(false);
  });

  it('has returns false after TTL expiry (5 minutes + 1s)', async () => {
    const mod = await import('../src/utils/adminStepUp.js');
    await mod.setAdminStepUp('admin-2');
    expect(await mod.hasAdminStepUp('admin-2')).toBe(true);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
    expect(await mod.hasAdminStepUp('admin-2')).toBe(false);
  });

  it('clear removes the flag', async () => {
    const mod = await import('../src/utils/adminStepUp.js');
    await mod.setAdminStepUp('admin-3');
    await mod.clearAdminStepUp('admin-3');
    expect(await mod.hasAdminStepUp('admin-3')).toBe(false);
  });

  it('has does not leak between different adminIds', async () => {
    const mod = await import('../src/utils/adminStepUp.js');
    await mod.setAdminStepUp('admin-a');
    expect(await mod.hasAdminStepUp('admin-b')).toBe(false);
    expect(await mod.hasAdminStepUp('admin-a')).toBe(true);
  });
});

describe('adminStepUp helpers (Redis path)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('uses redis.set with 5 minute EX when redis available', async () => {
    const setMock = vi.fn().mockResolvedValue('OK');
    const getMock = vi.fn().mockResolvedValue(null);
    const delMock = vi.fn().mockResolvedValue(1);
    vi.doMock('../src/redis.js', () => ({
      redis: { set: setMock, get: getMock, del: delMock },
    }));
    const mod = await import('../src/utils/adminStepUp.js');
    await mod.setAdminStepUp('admin-r');
    expect(setMock).toHaveBeenCalledWith('adminStepUp:admin-r', '1', 'EX', 300);
    await mod.hasAdminStepUp('admin-r');
    expect(getMock).toHaveBeenCalledWith('adminStepUp:admin-r');
    await mod.clearAdminStepUp('admin-r');
    expect(delMock).toHaveBeenCalledWith('adminStepUp:admin-r');
  });

  it('hasAdminStepUp returns true when redis returns a value', async () => {
    const getMock = vi.fn().mockResolvedValue('1');
    vi.doMock('../src/redis.js', () => ({
      redis: { set: vi.fn(), get: getMock, del: vi.fn() },
    }));
    const mod = await import('../src/utils/adminStepUp.js');
    expect(await mod.hasAdminStepUp('admin-x')).toBe(true);
  });
});
