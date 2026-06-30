// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBluetoothQuality } from '../../hooks/useBluetoothQuality';
import { BluetoothQualityBanner, type BannerVariant } from './BluetoothQualityBanner';
import { useSettings } from '../../contexts/SettingsContext';
import { matchesBluetoothLabel } from '../../services/audio/btQualityDetector';

export interface InCallBluetoothBannerProps {
  /** Switch the active mic to the given deviceId. Provided by the session
   *  that owns the call engine (useDMCall / useVoiceChannel / useStageRoom). */
  onRequestMicSwitch: (deviceId: string) => Promise<void>;
}

export function InCallBluetoothBanner({ onRequestMicSwitch }: InCallBluetoothBannerProps) {
  const { t } = useTranslation();
  const { status, shouldShowBanner, dismiss, remember } = useBluetoothQuality();
  const { bluetoothAudioSettings, setLastNonBtMicLabel } = useSettings();
  const [candidateLabel, setCandidateLabel] = useState<string | null>(null);
  const [splitApplied, setSplitApplied] = useState(false);
  const [splitToast, setSplitToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const splitToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showSplitToast = useCallback((message: string, type: 'success' | 'error') => {
    if (splitToastTimer.current) clearTimeout(splitToastTimer.current);
    setSplitToast({ message, type });
    splitToastTimer.current = setTimeout(() => setSplitToast(null), 5000);
  }, []);

  useEffect(() => {
    return () => { if (splitToastTimer.current) clearTimeout(splitToastTimer.current); };
  }, []);

  // Reset splitApplied whenever the device changes so the remember checkbox
  // only enables after the user applies a split for the CURRENT device.
  useEffect(() => { setSplitApplied(false); }, [status?.deviceId, status?.deviceLabel]);

  useEffect(() => {
    if (!status || status.tier !== 'bad') { setCandidateLabel(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        const nonBt = devices.filter(d => d.kind === 'audioinput' && !matchesBluetoothLabel(d.label));
        if (nonBt.length === 0) { setCandidateLabel(null); return; }
        const byLastUsed = bluetoothAudioSettings.lastNonBtMicLabel
          ? nonBt.find(d => d.label === bluetoothAudioSettings.lastNonBtMicLabel)
          : undefined;
        const byDefault = nonBt.find(d => d.deviceId === 'default');
        setCandidateLabel((byLastUsed ?? byDefault ?? nonBt[0]).label);
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [status, bluetoothAudioSettings.lastNonBtMicLabel]);

  const bannerVariant: BannerVariant | null = useMemo(() => {
    if (!status) return null;
    if (!status.canAutoSplit) return status.platform === 'ios' ? 'guidance-ios' : 'guidance-android';
    if (!candidateLabel) return status.platform === 'ios' ? 'guidance-ios' : 'guidance-android';
    return 'action';
  }, [status, candidateLabel]);

  if (!shouldShowBanner || !status || !bannerVariant) return null;

  return (
    <>
    <BluetoothQualityBanner
      deviceLabel={status.deviceLabel}
      candidateLabel={candidateLabel}
      variant={bannerVariant}
      splitApplied={splitApplied}
      onSplit={async () => {
        if (!candidateLabel) return;
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const target = devices.find(d => d.kind === 'audioinput' && d.label === candidateLabel);
          if (!target) throw new Error('candidate not found');
          await onRequestMicSwitch(target.deviceId);
          setLastNonBtMicLabel(target.label);
          setSplitApplied(true);
          showSplitToast(t('bluetoothQuality.toast.splitSuccess', { deviceName: target.label }), 'success');
        } catch {
          showSplitToast(t('bluetoothQuality.toast.splitFailed'), 'error');
        }
      }}
      onDismiss={dismiss}
      onRemember={remember}
    />
    {splitToast && (
      <div
        role="status"
        aria-live="polite"
        className={`mt-2 rounded-lg px-4 py-2 text-sm font-medium ${
          splitToast.type === 'success'
            ? 'border border-[var(--success)]/40 bg-[var(--success-subtle)] text-[var(--success)]'
            : 'border border-[var(--danger)]/40 bg-[var(--danger-subtle)] text-[var(--danger)]'
        }`}
      >
        {splitToast.message}
      </div>
    )}
    </>
  );
}
