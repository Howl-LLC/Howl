// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { resolveRecoverabilityState } from '../utils/recoverabilityState';

describe('resolveRecoverabilityState', () => {
  it('returns null when serverReadable is undefined (unknown)', () => {
    expect(resolveRecoverabilityState(undefined, false)).toBe(null);
    expect(resolveRecoverabilityState(undefined, true)).toBe(null);
  });
  it('returns private when not server-readable', () => {
    expect(resolveRecoverabilityState(false, false)).toBe('private');
  });
  it('returns recoverable-self when server-readable and I am on Server recovery', () => {
    expect(resolveRecoverabilityState(true, true)).toBe('recoverable-self');
  });
  it('returns recoverable-peer when server-readable and I am on Self recovery', () => {
    expect(resolveRecoverabilityState(true, false)).toBe('recoverable-peer');
  });
});
