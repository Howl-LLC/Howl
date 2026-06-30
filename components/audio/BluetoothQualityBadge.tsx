// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useTranslation } from 'react-i18next';
import type { QualityTier } from '../../services/audio/btQualityDetector';

export interface BluetoothQualityBadgeProps {
  tier: QualityTier;
  /** True when a BT device is operating at LC3/LE Audio sample rates (>= 32 kHz). */
  isHdBluetooth: boolean;
}

const TIER_COLORS: Record<QualityTier, string> = {
  good: '#16a34a',
  medium: '#eab308',
  bad: '#dc2626',
};

const TIER_LABEL_KEYS: Record<QualityTier, string> = {
  good: 'bluetoothQuality.badge.good',
  medium: 'bluetoothQuality.badge.medium',
  bad: 'bluetoothQuality.badge.bad',
};

export function BluetoothQualityBadge({ tier, isHdBluetooth }: BluetoothQualityBadgeProps) {
  const { t } = useTranslation();
  const tierKey = TIER_LABEL_KEYS[tier];
  const tierText = t(tierKey);

  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary,#9ca3af)]"
      aria-label={tierText}
      title={tierText}
    >
      <span
        data-tier={tier}
        aria-hidden="true"
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: TIER_COLORS[tier] }}
      />
      {isHdBluetooth && (
        <span className="font-medium">{t('bluetoothQuality.badge.hdBluetooth')}</span>
      )}
    </span>
  );
}
