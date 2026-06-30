// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSettings } from '../contexts/SettingsContext';
import type { BtQualityStatus } from '../services/audio/btQualityDetector';
import { subscribeBtQualityBus } from '../services/audio/btQualityBus';

export interface UseBluetoothQualityResult {
  /** The most recent probe result, or null when nothing has been probed. */
  status: BtQualityStatus | null;
  /** Update the current status. Called by the call engine / settings layer after each probe. */
  setStatus: (s: BtQualityStatus | null) => void;
  /** True when the UI should render a `bad`-tier banner for the current device. */
  shouldShowBanner: boolean;
  /** Dismiss the banner for the current device in this session only. Does not persist. */
  dismiss: () => void;
  /** Persist a 'split' preference for the current device. */
  remember: () => void;
  /** Remove the persisted preference for the current device. */
  forget: () => void;
}

export function useBluetoothQuality(): UseBluetoothQualityResult {
  const {
    bluetoothAudioSettings,
    addBtDevicePreference,
    removeBtDevicePreferenceByLabel,
  } = useSettings();

  const [status, setStatus] = useState<BtQualityStatus | null>(null);
  const [dismissedDeviceIds, setDismissedDeviceIds] = useState<Set<string>>(() => new Set());

  // Subscribe to the engine's BT quality bus. Unsubscribes on unmount.
  useEffect(() => {
    const unsubscribe = subscribeBtQualityBus((s) => setStatus(s));
    return unsubscribe;
  }, []);

  const dismiss = useCallback(() => {
    if (!status) return;
    const id = status.deviceId || status.deviceLabel;
    setDismissedDeviceIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, [status]);

  const remember = useCallback(() => {
    if (!status) return;
    addBtDevicePreference({
      label: status.deviceLabel,
      deviceId: status.deviceId || undefined,
      choice: 'split',
      lastSeenAt: Date.now(),
    });
  }, [status, addBtDevicePreference]);

  const forget = useCallback(() => {
    if (!status) return;
    removeBtDevicePreferenceByLabel(status.deviceLabel);
  }, [status, removeBtDevicePreferenceByLabel]);

  const shouldShowBanner = useMemo(() => {
    if (!bluetoothAudioSettings.autoOptimizeBluetoothAudio) return false;
    if (!status) return false;
    if (status.tier !== 'bad') return false;
    const id = status.deviceId || status.deviceLabel;
    if (dismissedDeviceIds.has(id)) return false;
    return true;
  }, [bluetoothAudioSettings.autoOptimizeBluetoothAudio, status, dismissedDeviceIds]);

  return { status, setStatus, shouldShowBanner, dismiss, remember, forget };
}
