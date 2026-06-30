// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
import { useUiStore } from '../stores/uiStore';

describe('uiStore.establishFailureReasons', () => {
  beforeEach(() => useUiStore.setState({ establishFailureReasons: {} }));

  it('sets a peer-unprovisioned reason with the offending userId', () => {
    useUiStore.getState().setEstablishFailureReason('chan-1', 'peer-unprovisioned', 'bob');
    expect(useUiStore.getState().establishFailureReasons['chan-1']).toEqual({ reason: 'peer-unprovisioned', userId: 'bob' });
  });

  it('clears a reason', () => {
    useUiStore.getState().setEstablishFailureReason('chan-1', 'peer-unprovisioned', 'bob');
    useUiStore.getState().clearEstablishFailure('chan-1');
    expect(useUiStore.getState().establishFailureReasons['chan-1']).toBeUndefined();
  });

  it('is a no-op when setting an identical reason (stable reference)', () => {
    useUiStore.getState().setEstablishFailureReason('chan-1', 'peer-unprovisioned', 'bob');
    const before = useUiStore.getState().establishFailureReasons;
    useUiStore.getState().setEstablishFailureReason('chan-1', 'peer-unprovisioned', 'bob');
    expect(useUiStore.getState().establishFailureReasons).toBe(before);
  });
});
