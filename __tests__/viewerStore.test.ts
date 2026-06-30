// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
import { useViewerStore } from '../stores/viewerStore';
import { makeStreamKey } from '../stores/types';

const ctx = { kind: 'voice' as const, scopeId: 'ch-1' };
const owner = 'bob';
const key = makeStreamKey(ctx, owner, 'screen');

describe('viewerStore', () => {
  beforeEach(() => {
    useViewerStore.getState().reset();
  });

  it('addViewers merges ids', () => {
    useViewerStore.getState().addViewers(key, ['alice']);
    useViewerStore.getState().addViewers(key, ['carol']);
    expect(useViewerStore.getState().getViewers(key)).toEqual(['alice', 'carol']);
  });

  it('removeViewers drops ids, deletes empty entries', () => {
    useViewerStore.getState().addViewers(key, ['alice', 'bob']);
    useViewerStore.getState().removeViewers(key, ['alice', 'bob']);
    expect(useViewerStore.getState().getViewers(key)).toEqual([]);
    expect(useViewerStore.getState().hasStream(key)).toBe(false);
  });

  it('clearStream removes the key entirely', () => {
    useViewerStore.getState().addViewers(key, ['alice']);
    useViewerStore.getState().clearStream(key);
    expect(useViewerStore.getState().hasStream(key)).toBe(false);
  });

  it('clearForContext removes all streams under a scope', () => {
    useViewerStore.getState().addViewers(makeStreamKey(ctx, 'a', 'screen'), ['x']);
    useViewerStore.getState().addViewers(makeStreamKey(ctx, 'b', 'screen'), ['y']);
    useViewerStore.getState().clearForContext(ctx);
    expect(useViewerStore.getState().getViewers(makeStreamKey(ctx, 'a', 'screen'))).toEqual([]);
    expect(useViewerStore.getState().getViewers(makeStreamKey(ctx, 'b', 'screen'))).toEqual([]);
  });

  it('getViewerCount excludes self when selfUserId passed', () => {
    useViewerStore.getState().addViewers(key, ['alice', 'bob', 'carol']);
    expect(useViewerStore.getState().getViewerCount(key, 'alice')).toBe(2);
  });
});
