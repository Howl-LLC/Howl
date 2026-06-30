// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBluetoothQuality } from '../../hooks/useBluetoothQuality';
import type { BtQualityStatus } from '../../services/audio/btQualityDetector';

const mockPrefs = {
  btDevicePreferences: [] as Array<{ label: string; choice: 'split'; lastSeenAt: number }>,
  addBtDevicePreference: vi.fn(),
  removeBtDevicePreferenceByLabel: vi.fn(),
  bluetoothAudioSettings: { autoOptimizeBluetoothAudio: true, lastNonBtMicLabel: null as string | null },
};

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => mockPrefs,
}));

function makeStatus(over: Partial<BtQualityStatus> = {}): BtQualityStatus {
  return {
    tier: 'bad',
    deviceId: 'dev1',
    deviceLabel: 'AirPods Pro',
    sampleRate: 8000,
    isBluetooth: true,
    platform: 'windows',
    canAutoSplit: true,
    ...over,
  };
}

describe('useBluetoothQuality', () => {
  beforeEach(() => {
    mockPrefs.btDevicePreferences = [];
    mockPrefs.addBtDevicePreference.mockClear();
    mockPrefs.removeBtDevicePreferenceByLabel.mockClear();
    mockPrefs.bluetoothAudioSettings = { autoOptimizeBluetoothAudio: true, lastNonBtMicLabel: null };
  });

  it('starts with status=null', () => {
    const { result } = renderHook(() => useBluetoothQuality());
    expect(result.current.status).toBeNull();
  });

  it('setStatus updates status', () => {
    const { result } = renderHook(() => useBluetoothQuality());
    act(() => { result.current.setStatus(makeStatus()); });
    expect(result.current.status?.tier).toBe('bad');
  });

  it('dismiss hides the banner for the current device-session', () => {
    const { result } = renderHook(() => useBluetoothQuality());
    act(() => { result.current.setStatus(makeStatus()); });
    expect(result.current.shouldShowBanner).toBe(true);
    act(() => { result.current.dismiss(); });
    expect(result.current.shouldShowBanner).toBe(false);
  });

  it('dismiss is device-scoped — new device re-shows banner', () => {
    const { result } = renderHook(() => useBluetoothQuality());
    act(() => { result.current.setStatus(makeStatus({ deviceId: 'dev1', deviceLabel: 'AirPods Pro' })); });
    act(() => { result.current.dismiss(); });
    act(() => { result.current.setStatus(makeStatus({ deviceId: 'dev2', deviceLabel: 'Sony WH-1000XM5' })); });
    expect(result.current.shouldShowBanner).toBe(true);
  });

  it('remember calls addBtDevicePreference', () => {
    const { result } = renderHook(() => useBluetoothQuality());
    act(() => { result.current.setStatus(makeStatus()); });
    act(() => { result.current.remember(); });
    expect(mockPrefs.addBtDevicePreference).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'AirPods Pro', choice: 'split' }),
    );
  });

  it('forget calls removeBtDevicePreferenceByLabel', () => {
    const { result } = renderHook(() => useBluetoothQuality());
    act(() => { result.current.setStatus(makeStatus()); });
    act(() => { result.current.forget(); });
    expect(mockPrefs.removeBtDevicePreferenceByLabel).toHaveBeenCalledWith('AirPods Pro');
  });

  it('shouldShowBanner is false when tier is good', () => {
    const { result } = renderHook(() => useBluetoothQuality());
    act(() => { result.current.setStatus(makeStatus({ tier: 'good' })); });
    expect(result.current.shouldShowBanner).toBe(false);
  });

  it('shouldShowBanner is false when tier is medium', () => {
    const { result } = renderHook(() => useBluetoothQuality());
    act(() => { result.current.setStatus(makeStatus({ tier: 'medium' })); });
    expect(result.current.shouldShowBanner).toBe(false);
  });

  it('shouldShowBanner is false when autoOptimizeBluetoothAudio is off', () => {
    mockPrefs.bluetoothAudioSettings = { autoOptimizeBluetoothAudio: false, lastNonBtMicLabel: null };
    const { result } = renderHook(() => useBluetoothQuality());
    act(() => { result.current.setStatus(makeStatus()); });
    expect(result.current.shouldShowBanner).toBe(false);
  });
});
