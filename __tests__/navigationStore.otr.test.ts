// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
import { useNavigationStore } from '../stores/navigationStore';

describe('navigationStore.activeDmTier', () => {
  beforeEach(() => useNavigationStore.setState({ activeDmChannelId: null, activeDmTier: 'saved' }));

  it("setActiveDmTier('otr') sets the active tier to 'otr'", () => {
    useNavigationStore.getState().setActiveDmTier('otr');
    expect(useNavigationStore.getState().activeDmTier).toBe('otr');
  });

  it("setActiveDmChannelId resets activeDmTier to 'saved' on channel switch", () => {
    useNavigationStore.getState().setActiveDmTier('otr');
    useNavigationStore.getState().setActiveDmChannelId('x');
    expect(useNavigationStore.getState().activeDmChannelId).toBe('x');
    expect(useNavigationStore.getState().activeDmTier).toBe('saved');
  });
});
