// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getOtrFirstSwipeSeen, setOtrFirstSwipeSeen } from '../utils/otrFirstSwipeStorage';

describe('otrFirstSwipeStorage', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to false when unset', () => {
    expect(getOtrFirstSwipeSeen()).toBe(false);
  });
  it('persists true', () => {
    setOtrFirstSwipeSeen(true);
    expect(getOtrFirstSwipeSeen()).toBe(true);
  });
  it('does not throw when writes are blocked', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => setOtrFirstSwipeSeen(true)).not.toThrow();
    spy.mockRestore();
  });
  it('returns false when reads are blocked', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(getOtrFirstSwipeSeen()).toBe(false);
    spy.mockRestore();
  });
});
