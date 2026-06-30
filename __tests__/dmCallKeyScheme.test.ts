// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { decideInitialCallKey } from '../hooks/useDMCall';

const KEY = new Uint8Array(32).fill(7);

describe('decideInitialCallKey (mls | blocked | none)', () => {
  it('E2EE not expected -> none', () => {
    expect(decideInitialCallKey({ e2eeExpected: false, isInitiator: true, mlsKey: null, incomingMlsCallReady: undefined }))
      .toEqual({ scheme: 'none', keyBytes: null });
  });
  it('initiator with an MLS key -> mls', () => {
    expect(decideInitialCallKey({ e2eeExpected: true, isInitiator: true, mlsKey: KEY, incomingMlsCallReady: undefined }))
      .toEqual({ scheme: 'mls', keyBytes: KEY });
  });
  it('initiator without an MLS key -> blocked, never none (the blocked-not-silent guarantee)', () => {
    const d = decideInitialCallKey({ e2eeExpected: true, isInitiator: true, mlsKey: null, incomingMlsCallReady: undefined });
    expect(d.scheme).toBe('blocked');
    expect(d.scheme).not.toBe('none');
    expect(d.keyBytes).toBeNull();
  });
  it('recipient with MLS key AND ringer-advertised readiness -> mls', () => {
    expect(decideInitialCallKey({ e2eeExpected: true, isInitiator: false, mlsKey: KEY, incomingMlsCallReady: true }))
      .toEqual({ scheme: 'mls', keyBytes: KEY });
  });
  it('recipient with MLS key but ringer NOT ready -> blocked (no legacy rung below MLS)', () => {
    expect(decideInitialCallKey({ e2eeExpected: true, isInitiator: false, mlsKey: KEY, incomingMlsCallReady: undefined }).scheme).toBe('blocked');
    expect(decideInitialCallKey({ e2eeExpected: true, isInitiator: false, mlsKey: KEY, incomingMlsCallReady: false }).scheme).toBe('blocked');
  });
  it('recipient without an MLS key -> blocked', () => {
    expect(decideInitialCallKey({ e2eeExpected: true, isInitiator: false, mlsKey: null, incomingMlsCallReady: true }).scheme).toBe('blocked');
  });
});
