// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
export const PROFILE_PANEL_MIN = 280;
export const PROFILE_PANEL_MAX = 480;
export const PROFILE_PANEL_DEFAULT = 340;

const OPEN_KEY = 'howl_dm_profile_panel_open';
const WIDTH_KEY = 'howl_dm_profile_panel_width';

export function clampProfilePanelWidth(w: number): number {
  return Math.max(PROFILE_PANEL_MIN, Math.min(PROFILE_PANEL_MAX, w));
}

export function getProfilePanelOpen(): boolean {
  try { return localStorage.getItem(OPEN_KEY) !== 'false'; } catch { return true; }
}

export function setProfilePanelOpen(open: boolean): void {
  try { localStorage.setItem(OPEN_KEY, open ? 'true' : 'false'); } catch { /* ignore */ }
}

export function getProfilePanelWidth(): number {
  try {
    const s = localStorage.getItem(WIDTH_KEY);
    if (s != null) {
      const n = Number(s);
      if (n >= PROFILE_PANEL_MIN && n <= PROFILE_PANEL_MAX) return n;
    }
  } catch { /* ignore */ }
  return PROFILE_PANEL_DEFAULT;
}

export function setProfilePanelWidth(w: number): void {
  try { localStorage.setItem(WIDTH_KEY, String(clampProfilePanelWidth(w))); } catch { /* ignore */ }
}
