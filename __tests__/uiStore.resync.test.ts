// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
import { useUiStore } from '../stores/uiStore';

describe('uiStore — per-channel resync flag', () => {
  beforeEach(() => { useUiStore.setState({ resyncNeededChannels: {} }); });

  it('marks and clears a channel', () => {
    useUiStore.getState().markChannelNeedsResync('ch1');
    expect(useUiStore.getState().resyncNeededChannels['ch1']).toBe(true);
    useUiStore.getState().clearChannelResync('ch1');
    expect(useUiStore.getState().resyncNeededChannels['ch1']).toBeUndefined();
  });

  it('marking is idempotent', () => {
    useUiStore.getState().markChannelNeedsResync('ch1');
    useUiStore.getState().markChannelNeedsResync('ch1');
    expect(Object.keys(useUiStore.getState().resyncNeededChannels)).toEqual(['ch1']);
  });
});
