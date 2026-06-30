// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
const rl = await import('../../electron/streamdeck/rate-limiter.js').then((m) => m.default ?? m);

let now = 1_000_000;
const clock = () => now;

beforeEach(() => { now = 1_000_000; });

describe('streamdeck/rate-limiter', () => {
  it('allows up to `max` within the window, then rejects', () => {
    const r = rl.create({ max: 3, windowMs: 1000, clock });
    expect(r.tryHit('k')).toBe(true);
    expect(r.tryHit('k')).toBe(true);
    expect(r.tryHit('k')).toBe(true);
    expect(r.tryHit('k')).toBe(false);
  });

  it('replenishes after the window advances', () => {
    const r = rl.create({ max: 2, windowMs: 1000, clock });
    r.tryHit('k'); r.tryHit('k');
    expect(r.tryHit('k')).toBe(false);
    now += 1001;
    expect(r.tryHit('k')).toBe(true);
  });

  it('separates keys', () => {
    const r = rl.create({ max: 1, windowMs: 1000, clock });
    expect(r.tryHit('a')).toBe(true);
    expect(r.tryHit('a')).toBe(false);
    expect(r.tryHit('b')).toBe(true);
  });

  it('returns retryAfterMs on rejection', () => {
    const r = rl.create({ max: 1, windowMs: 1000, clock });
    r.tryHit('k');
    const res = r.tryHitWithRetryAfter('k');
    expect(res.ok).toBe(false);
    expect(res.retryAfterMs).toBeGreaterThan(0);
    expect(res.retryAfterMs).toBeLessThanOrEqual(1000);
  });
});
