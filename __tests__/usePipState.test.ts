// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePipState } from '../hooks/usePipState';

// usePipState takes its inputs as arguments so tests can pass synthetic values.

describe('usePipState', () => {
  it('hidden when no active call', () => {
    const { result } = renderHook(() =>
      usePipState({ activeCall: null, isViewingCallContext: false, availableStreams: [] }),
    );
    expect(result.current.visible).toBe(false);
  });

  it('hidden when viewing the call context', () => {
    const ctx = { kind: 'voice' as const, scopeId: 'ch-1', displayName: 'Ch' };
    const { result } = renderHook(() => usePipState({
      activeCall: ctx, isViewingCallContext: true, availableStreams: [{ ownerId: 'bob', type: 'screen' }],
    }));
    expect(result.current.visible).toBe(false);
  });

  it('hidden when no streams', () => {
    const ctx = { kind: 'voice' as const, scopeId: 'ch-1', displayName: 'Ch' };
    const { result } = renderHook(() => usePipState({
      activeCall: ctx, isViewingCallContext: false, availableStreams: [],
    }));
    expect(result.current.visible).toBe(false);
  });

  it('visible when in call + not viewing + streams exist', () => {
    const ctx = { kind: 'voice' as const, scopeId: 'ch-1', displayName: 'Ch' };
    const { result } = renderHook(() => usePipState({
      activeCall: ctx, isViewingCallContext: false,
      availableStreams: [{ ownerId: 'bob', type: 'screen' }],
    }));
    expect(result.current.visible).toBe(true);
  });

  it('dismiss hides PIP; re-entering + leaving call view shows it again', () => {
    const ctx = { kind: 'voice' as const, scopeId: 'ch-1', displayName: 'Ch' };
    let viewingCallView = false;
    const { result, rerender } = renderHook(() => usePipState({
      activeCall: ctx, isViewingCallContext: viewingCallView,
      availableStreams: [{ ownerId: 'bob', type: 'screen' }],
    }));
    expect(result.current.visible).toBe(true);
    act(() => result.current.dismiss());
    expect(result.current.visible).toBe(false);

    // Enter call view — dismiss resets on re-entry.
    viewingCallView = true;
    rerender();
    expect(result.current.visible).toBe(false);
    viewingCallView = false;
    rerender();
    expect(result.current.visible).toBe(true);
  });
});
