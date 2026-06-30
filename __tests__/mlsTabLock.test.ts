// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * mlsTabLock — navigator.locks leadership held for the tab lifetime.
 * - When navigator.locks exists, acquireLeadership resolves true and isLeader()
 *   flips true once the lock is granted.
 * - When navigator.locks is absent, it falls back to single-tab leader and
 *   logs a warning (never throws).
 *
 * The module logs via services/logger (not console), so we mock that module
 * with a hoisted spy that survives vi.resetModules() (each test re-imports the
 * module fresh to reset its leader state).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('../services/logger', () => ({ logger: { warn: warnSpy, error: vi.fn() } }));

describe('mlsTabLock', () => {
  const realLocks = (navigator as unknown as { locks?: unknown }).locks;

  beforeEach(() => {
    vi.resetModules();
    warnSpy.mockClear();
  });

  afterEach(() => {
    (navigator as unknown as { locks?: unknown }).locks = realLocks;
    vi.restoreAllMocks();
  });

  it('resolves true and reports isLeader once the lock is granted', async () => {
    // Grant immediately by invoking the callback, then keep the held promise
    // pending forever (a real lifetime-held lock never resolves its callback).
    const request = vi.fn((_name: string, _opts: unknown, cb: (lock: unknown) => Promise<void>) => {
      void cb({});
      return new Promise<void>(() => {});
    });
    (navigator as unknown as { locks: { request: typeof request } }).locks = { request };

    const { acquireLeadership, isLeader } = await import('../services/mls/mlsTabLock');
    const onLost = vi.fn();
    const became = await acquireLeadership(onLost);
    expect(became).toBe(true);
    expect(isLeader()).toBe(true);
    expect(onLost).not.toHaveBeenCalled();
  });

  it('falls back to single-tab leader and logs when navigator.locks is absent', async () => {
    (navigator as unknown as { locks?: unknown }).locks = undefined;

    const { acquireLeadership, isLeader } = await import('../services/mls/mlsTabLock');
    const became = await acquireLeadership(() => undefined);
    expect(became).toBe(true);
    expect(isLeader()).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('withProvisionLock', () => {
  const realLocks = (navigator as unknown as { locks?: unknown }).locks;

  beforeEach(() => {
    vi.resetModules();
    warnSpy.mockClear();
  });

  afterEach(() => {
    (navigator as unknown as { locks?: unknown }).locks = realLocks;
    vi.restoreAllMocks();
  });

  it('serializes two overlapping calls under an exclusive lock and is distinct from the writer lease', async () => {
    const heldNames: string[] = [];
    // A minimal exclusive LockManager mock: queue requests per name; a held
    // request blocks the next same-name request until its callback resolves.
    const queues = new Map<string, Promise<unknown>>();
    const request = vi.fn((name: string, _opts: unknown, cb: () => Promise<unknown>) => {
      heldNames.push(name);
      const prior = queues.get(name) ?? Promise.resolve();
      const run = prior.then(() => cb());
      queues.set(name, run.catch(() => {}));
      return run;
    });
    (navigator as unknown as { locks: { request: typeof request } }).locks = { request };

    const { withProvisionLock } = await import('../services/mls/mlsTabLock');

    const order: string[] = [];
    let releaseA!: () => void;
    const aStarted = withProvisionLock(async () => {
      order.push('A-start');
      await new Promise<void>((r) => { releaseA = r; });
      order.push('A-end');
      return 'a';
    });
    // B is requested while A still holds the lock.
    const bDone = withProvisionLock(async () => {
      order.push('B-start');
      return 'b';
    });

    // Let microtasks settle: B must NOT have started while A holds the lock.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['A-start']); // B is queued behind A
    releaseA();
    const [aRes, bRes] = await Promise.all([aStarted, bDone]);
    expect(aRes).toBe('a');
    expect(bRes).toBe('b');
    expect(order).toEqual(['A-start', 'A-end', 'B-start']); // strict serialization
    // The lock name is the provision lock, NOT the writer lease.
    expect(heldNames.every((n) => n === 'howl-mls-provision')).toBe(true);
    expect(heldNames).not.toContain('howl-mls-writer');
  });

  it('runs fn directly (no throw) when navigator.locks is absent', async () => {
    (navigator as unknown as { locks?: unknown }).locks = undefined;
    const { withProvisionLock } = await import('../services/mls/mlsTabLock');
    const res = await withProvisionLock(async () => 42);
    expect(res).toBe(42);
  });

  it('propagates fn rejection and still releases the lock', async () => {
    const request = vi.fn((_name: string, _opts: unknown, cb: () => Promise<unknown>) => cb());
    (navigator as unknown as { locks: { request: typeof request } }).locks = { request };
    const { withProvisionLock } = await import('../services/mls/mlsTabLock');
    await expect(withProvisionLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // A subsequent call still runs (lock was released, not stuck).
    await expect(withProvisionLock(async () => 'ok')).resolves.toBe('ok');
  });
});
