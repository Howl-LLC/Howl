// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
const KEY = 'howl_otr_first_swipe_seen';

/** Whether the user has permanently dismissed the OTR first-swipe explainer. */
export function getOtrFirstSwipeSeen(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true';
  } catch {
    return false;
  }
}

export function setOtrFirstSwipeSeen(seen: boolean): void {
  try {
    localStorage.setItem(KEY, seen ? 'true' : 'false');
  } catch { /* storage unavailable */ }
}
