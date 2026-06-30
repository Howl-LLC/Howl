// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getProfilePanelOpen, setProfilePanelOpen,
  getProfilePanelWidth, setProfilePanelWidth, clampProfilePanelWidth,
  PROFILE_PANEL_MIN, PROFILE_PANEL_MAX, PROFILE_PANEL_DEFAULT,
} from '../utils/dmProfilePanelStorage';

describe('dmProfilePanelStorage', () => {
  beforeEach(() => { localStorage.clear(); });

  it('defaults open to true when nothing is stored', () => {
    expect(getProfilePanelOpen()).toBe(true);
  });

  it('returns false only when explicitly closed', () => {
    setProfilePanelOpen(false);
    expect(getProfilePanelOpen()).toBe(false);
    setProfilePanelOpen(true);
    expect(getProfilePanelOpen()).toBe(true);
  });

  it('defaults width to PROFILE_PANEL_DEFAULT', () => {
    expect(getProfilePanelWidth()).toBe(PROFILE_PANEL_DEFAULT);
  });

  it('round-trips a valid width', () => {
    setProfilePanelWidth(360);
    expect(getProfilePanelWidth()).toBe(360);
  });

  it('ignores an out-of-range stored width and returns the default', () => {
    localStorage.setItem('howl_dm_profile_panel_width', '9999');
    expect(getProfilePanelWidth()).toBe(PROFILE_PANEL_DEFAULT);
  });

  it('clamps to [MIN, MAX]', () => {
    expect(clampProfilePanelWidth(10)).toBe(PROFILE_PANEL_MIN);
    expect(clampProfilePanelWidth(99999)).toBe(PROFILE_PANEL_MAX);
    expect(clampProfilePanelWidth(350)).toBe(350);
  });

  it('persists the clamped width, not the raw value', () => {
    setProfilePanelWidth(99999);
    expect(getProfilePanelWidth()).toBe(PROFILE_PANEL_MAX);
  });
});
