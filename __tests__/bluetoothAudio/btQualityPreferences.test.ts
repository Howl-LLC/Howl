// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import {
  findPreferenceByLabel,
  upsertPreference,
  removePreference,
  clearAllPreferences,
  evictLruIfNeeded,
  BT_PREFS_CAP,
} from '../../services/audio/btQualityPreferences';
import type { BtDevicePreference } from '../../utils/settingsStorage';

describe('btQualityPreferences — findPreferenceByLabel', () => {
  it('returns undefined for empty list', () => {
    expect(findPreferenceByLabel([], 'AirPods Pro')).toBeUndefined();
  });

  it('returns matching entry by label', () => {
    const list: BtDevicePreference[] = [
      { label: 'AirPods Pro', choice: 'split', lastSeenAt: 1 },
      { label: 'Sony WH-1000XM5', choice: 'split', lastSeenAt: 2 },
    ];
    expect(findPreferenceByLabel(list, 'AirPods Pro')).toEqual(list[0]);
  });

  it('is case-sensitive on exact label match', () => {
    const list: BtDevicePreference[] = [
      { label: 'AirPods Pro', choice: 'split', lastSeenAt: 1 },
    ];
    expect(findPreferenceByLabel(list, 'airpods pro')).toBeUndefined();
  });
});

describe('btQualityPreferences — upsertPreference', () => {
  it('adds a new preference to an empty list', () => {
    const out = upsertPreference([], { label: 'AirPods Pro', deviceId: 'id1', choice: 'split', lastSeenAt: 100 });
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('AirPods Pro');
  });

  it('updates lastSeenAt and deviceId when preference with same label exists', () => {
    const existing: BtDevicePreference[] = [
      { label: 'AirPods Pro', deviceId: 'old', choice: 'split', lastSeenAt: 100 },
    ];
    const out = upsertPreference(existing, { label: 'AirPods Pro', deviceId: 'new', choice: 'split', lastSeenAt: 500 });
    expect(out).toHaveLength(1);
    expect(out[0].deviceId).toBe('new');
    expect(out[0].lastSeenAt).toBe(500);
  });

  it('does not mutate the input array', () => {
    const input: BtDevicePreference[] = [{ label: 'Foo', choice: 'split', lastSeenAt: 1 }];
    upsertPreference(input, { label: 'Bar', choice: 'split', lastSeenAt: 2 });
    expect(input).toEqual([{ label: 'Foo', choice: 'split', lastSeenAt: 1 }]);
  });
});

describe('btQualityPreferences — removePreference', () => {
  it('removes the matching label entry', () => {
    const input: BtDevicePreference[] = [
      { label: 'AirPods Pro', choice: 'split', lastSeenAt: 1 },
      { label: 'Sony', choice: 'split', lastSeenAt: 2 },
    ];
    const out = removePreference(input, 'AirPods Pro');
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('Sony');
  });

  it('returns the same shape when label is not present', () => {
    const input: BtDevicePreference[] = [{ label: 'Foo', choice: 'split', lastSeenAt: 1 }];
    const out = removePreference(input, 'Bar');
    expect(out).toEqual(input);
  });
});

describe('btQualityPreferences — clearAllPreferences', () => {
  it('returns an empty array', () => {
    const input: BtDevicePreference[] = [{ label: 'Foo', choice: 'split', lastSeenAt: 1 }];
    expect(clearAllPreferences(input)).toEqual([]);
  });
});

describe('btQualityPreferences — evictLruIfNeeded', () => {
  it('is a no-op when below cap', () => {
    const input: BtDevicePreference[] = [
      { label: 'A', choice: 'split', lastSeenAt: 1 },
      { label: 'B', choice: 'split', lastSeenAt: 2 },
    ];
    expect(evictLruIfNeeded(input)).toEqual(input);
  });

  it('evicts the oldest lastSeenAt entries when over cap', () => {
    const input: BtDevicePreference[] = [];
    for (let i = 0; i < BT_PREFS_CAP + 3; i++) {
      input.push({ label: `dev${i}`, choice: 'split', lastSeenAt: i });
    }
    const out = evictLruIfNeeded(input);
    expect(out).toHaveLength(BT_PREFS_CAP);
    expect(out.find(p => p.label === 'dev0')).toBeUndefined();
    expect(out.find(p => p.label === 'dev1')).toBeUndefined();
    expect(out.find(p => p.label === 'dev2')).toBeUndefined();
    expect(out.find(p => p.label === `dev${BT_PREFS_CAP + 2}`)).toBeDefined();
  });

  it('is a no-op when exactly at the cap (boundary)', () => {
    const input: BtDevicePreference[] = [];
    for (let i = 0; i < BT_PREFS_CAP; i++) {
      input.push({ label: `dev${i}`, choice: 'split', lastSeenAt: i });
    }
    const out = evictLruIfNeeded(input);
    expect(out).toBe(input); // same reference — no new array created
    expect(out).toHaveLength(BT_PREFS_CAP);
  });
});
