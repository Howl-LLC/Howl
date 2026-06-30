// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Bluetooth device preferences — pure helpers.
 *
 * These are stateless list-transform helpers. The actual persistence is done
 * by `SettingsContext` via `utils/settingsStorage.ts`. Keeping the logic pure
 * makes it trivial to test and safe to reuse from any component.
 */

import type { BtDevicePreference } from '../../utils/settingsStorage';

export const BT_PREFS_CAP = 20;

/** Returns the first preference matching the given label, or undefined. */
export function findPreferenceByLabel(
  prefs: BtDevicePreference[],
  label: string,
): BtDevicePreference | undefined {
  return prefs.find(p => p.label === label);
}

/**
 * Returns a NEW list with the given preference inserted (if label is new) or
 * updated (if label already exists). Input is not mutated.
 */
export function upsertPreference(
  prefs: BtDevicePreference[],
  incoming: BtDevicePreference,
): BtDevicePreference[] {
  const existingIdx = prefs.findIndex(p => p.label === incoming.label);
  if (existingIdx === -1) {
    return [...prefs, { ...incoming }];
  }
  const next = prefs.slice();
  next[existingIdx] = { ...next[existingIdx], ...incoming };
  return next;
}

/** Returns a NEW list with the entry of the given label removed (if present). */
export function removePreference(
  prefs: BtDevicePreference[],
  label: string,
): BtDevicePreference[] {
  return prefs.filter(p => p.label !== label);
}

/** Returns an empty list. (Helper kept for symmetry with other ops.) */
export function clearAllPreferences(_prefs: BtDevicePreference[]): BtDevicePreference[] {
  return [];
}

/**
 * Returns a NEW list that is either identical to the input (if under cap) or
 * trimmed to the cap by dropping the oldest `lastSeenAt` entries.
 */
export function evictLruIfNeeded(prefs: BtDevicePreference[]): BtDevicePreference[] {
  if (prefs.length <= BT_PREFS_CAP) return prefs;
  const sorted = prefs.slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return sorted.slice(0, BT_PREFS_CAP);
}
