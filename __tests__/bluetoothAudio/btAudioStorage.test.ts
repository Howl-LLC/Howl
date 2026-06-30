// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getStoredBluetoothAudio,
  setStoredBluetoothAudio,
  getStoredBtDevicePreferences,
  setStoredBtDevicePreferences,
  type BtDevicePreference,
} from '../../utils/settingsStorage';

describe('settingsStorage — bluetooth audio', () => {
  beforeEach(() => { localStorage.clear(); });

  it('returns default settings when nothing is stored', () => {
    const s = getStoredBluetoothAudio();
    expect(s.autoOptimizeBluetoothAudio).toBe(true);
    expect(s.lastNonBtMicLabel).toBeNull();
  });

  it('round-trips autoOptimizeBluetoothAudio toggle', () => {
    setStoredBluetoothAudio({ autoOptimizeBluetoothAudio: false });
    expect(getStoredBluetoothAudio().autoOptimizeBluetoothAudio).toBe(false);
    setStoredBluetoothAudio({ autoOptimizeBluetoothAudio: true });
    expect(getStoredBluetoothAudio().autoOptimizeBluetoothAudio).toBe(true);
  });

  it('round-trips lastNonBtMicLabel including null clearing', () => {
    setStoredBluetoothAudio({ lastNonBtMicLabel: 'MacBook Air Microphone' });
    expect(getStoredBluetoothAudio().lastNonBtMicLabel).toBe('MacBook Air Microphone');
    setStoredBluetoothAudio({ lastNonBtMicLabel: null });
    expect(getStoredBluetoothAudio().lastNonBtMicLabel).toBeNull();
  });

  it('returns empty array when no preferences stored', () => {
    expect(getStoredBtDevicePreferences()).toEqual([]);
  });

  it('round-trips a single preference', () => {
    const p: BtDevicePreference = { label: 'AirPods Pro', choice: 'split', lastSeenAt: 100 };
    setStoredBtDevicePreferences([p]);
    expect(getStoredBtDevicePreferences()).toEqual([p]);
  });

  it('preserves multiple preferences in insertion order', () => {
    const a: BtDevicePreference = { label: 'AirPods Pro', choice: 'split', lastSeenAt: 100 };
    const b: BtDevicePreference = { label: 'Sony WH-1000XM5', choice: 'split', lastSeenAt: 200 };
    setStoredBtDevicePreferences([a, b]);
    expect(getStoredBtDevicePreferences()).toEqual([a, b]);
  });

  it('drops stored entries with invalid shape', () => {
    localStorage.setItem('howl_bt_device_prefs', JSON.stringify([
      { label: 'OK', choice: 'split', lastSeenAt: 1 },
      { label: 'Missing choice', lastSeenAt: 2 },
      { choice: 'split', lastSeenAt: 3 },
      'not an object',
    ]));
    const out = getStoredBtDevicePreferences();
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('OK');
  });

  it('drops stored entries with non-finite lastSeenAt', () => {
    // 1e999 parses via JSON as Infinity.
    localStorage.setItem('howl_bt_device_prefs',
      '[{"label":"valid","choice":"split","lastSeenAt":42},{"label":"infinite","choice":"split","lastSeenAt":1e999}]'
    );
    const out = getStoredBtDevicePreferences();
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('valid');
  });
});
