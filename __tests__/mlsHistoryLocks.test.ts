// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * mlsHistoryLocks — navigator.locks coordination for the history archive.
 *
 * jsdom defines `navigator` but NOT `navigator.locks`, so these tests naturally
 * exercise the single-tab fallback path:
 *  - acquireHistorySyncLease resolves true and hasHistorySyncLease() flips true.
 *  - runWithChannelRestoreLock runs fn directly (no locks → no dedupe gate).
 *  - releaseHistorySyncLease clears the held flag.
 * Cross-tab grant/steal behavior is covered by manual E2E, not unit tests.
 *
 * Also asserts the mlsCoordinator.onHistoryRestored emitter delivers events to a
 * subscriber and that the returned unsubscribe stops delivery.
 *
 * The lease module holds module state (_hasLease etc.), so each test re-imports
 * it fresh via vi.resetModules() to avoid cross-test leakage. The module logs via
 * services/logger (not console), mocked with a hoisted spy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('../services/logger', () => ({ logger: { warn: warnSpy, error: vi.fn() } }));

describe('mlsHistoryLocks (single-tab fallback path)', () => {
  const realLocks = (navigator as unknown as { locks?: unknown }).locks;

  beforeEach(() => {
    vi.resetModules();
    warnSpy.mockClear();
  });

  afterEach(() => {
    (navigator as unknown as { locks?: unknown }).locks = realLocks;
    vi.restoreAllMocks();
  });

  it('confirms jsdom has navigator but not navigator.locks', () => {
    expect(typeof navigator).toBe('object');
    expect((navigator as unknown as { locks?: unknown }).locks).toBeUndefined();
  });

  it('acquireHistorySyncLease resolves true and reports the lease (fallback)', async () => {
    const { acquireHistorySyncLease, hasHistorySyncLease } = await import('../services/mls/mlsHistoryLocks');
    const onLost = vi.fn();
    const got = await acquireHistorySyncLease(onLost);
    expect(got).toBe(true);
    expect(hasHistorySyncLease()).toBe(true);
    expect(onLost).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('re-acquire while holding the lease is idempotent (returns true, no second warn)', async () => {
    const { acquireHistorySyncLease, hasHistorySyncLease } = await import('../services/mls/mlsHistoryLocks');
    expect(await acquireHistorySyncLease(() => undefined)).toBe(true);
    warnSpy.mockClear();
    expect(await acquireHistorySyncLease(() => undefined)).toBe(true);
    expect(hasHistorySyncLease()).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('releaseHistorySyncLease clears the held flag (fallback)', async () => {
    const { acquireHistorySyncLease, hasHistorySyncLease, releaseHistorySyncLease } =
      await import('../services/mls/mlsHistoryLocks');
    await acquireHistorySyncLease(() => undefined);
    expect(hasHistorySyncLease()).toBe(true);
    releaseHistorySyncLease();
    expect(hasHistorySyncLease()).toBe(false);
  });

  it('runWithChannelRestoreLock runs fn directly when locks are unavailable', async () => {
    const { runWithChannelRestoreLock } = await import('../services/mls/mlsHistoryLocks');
    const fn = vi.fn(() => Promise.resolve());
    await runWithChannelRestoreLock('chan-1', fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('mlsCoordinator.onHistoryRestored emitter', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('delivers the event to a subscriber and the unsubscribe stops delivery', async () => {
    const { onHistoryRestored, emitHistoryRestored } = await import('../services/mls/mlsCoordinator');
    const cb = vi.fn();
    const unsub = onHistoryRestored(cb);

    emitHistoryRestored({ dmChannelId: 'chan-42' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ dmChannelId: 'chan-42' });

    // null channel id (eager bulk pass) is also delivered.
    emitHistoryRestored({ dmChannelId: null });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith({ dmChannelId: null });

    unsub();
    emitHistoryRestored({ dmChannelId: 'chan-99' });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
