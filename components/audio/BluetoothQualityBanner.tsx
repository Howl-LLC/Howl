// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useTranslation } from 'react-i18next';

export type BannerVariant = 'action' | 'guidance-ios' | 'guidance-android';

export interface BluetoothQualityBannerProps {
  deviceLabel: string;
  /** Candidate non-BT mic label. Null in guidance variants. */
  candidateLabel: string | null;
  variant: BannerVariant;
  onSplit: () => void;
  onDismiss: () => void;
  onRemember: () => void;
  /** True after onSplit has been successfully applied — enables the remember checkbox. */
  splitApplied?: boolean;
}

export function BluetoothQualityBanner(props: BluetoothQualityBannerProps) {
  const { t } = useTranslation();
  const { deviceLabel, candidateLabel, variant, onSplit, onDismiss, onRemember, splitApplied } = props;

  const isAction = variant === 'action';
  const guidanceKey =
    variant === 'guidance-ios' ? 'bluetoothQuality.banner.iosGuidance'
    : variant === 'guidance-android' ? 'bluetoothQuality.banner.androidFallback'
    : null;

  return (
    <div
      role={isAction ? 'alert' : 'status'}
      aria-live={isAction ? 'assertive' : 'polite'}
      className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
    >
      <div className="flex items-center gap-2 font-medium">
        <span aria-hidden="true">🎧</span>
        <span>{t('bluetoothQuality.banner.title')}</span>
      </div>

      {isAction ? (
        <>
          <p className="text-[var(--text-secondary,#9ca3af)]">{t('bluetoothQuality.banner.body')}</p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              className="rounded-md bg-[var(--accent,#3b82f6)] px-3 py-1.5 text-white hover:opacity-90"
              onClick={onSplit}
            >
              {t('bluetoothQuality.banner.fixAction', { deviceName: candidateLabel ?? '' })}
            </button>
            <button
              type="button"
              className="rounded-md border border-[var(--border,#374151)] px-3 py-1.5 hover:bg-white/5"
              onClick={onDismiss}
            >
              {t('bluetoothQuality.banner.dismissAction')}
            </button>
          </div>
          <label className="flex items-center gap-2 pt-1 text-[var(--text-secondary,#9ca3af)]">
            <input
              type="checkbox"
              disabled={!splitApplied}
              onChange={onRemember}
            />
            <span>{t('bluetoothQuality.banner.rememberCheckbox', { deviceName: deviceLabel })}</span>
          </label>
        </>
      ) : (
        <>
          {guidanceKey && (
            <p className="text-[var(--text-secondary,#9ca3af)]">{t(guidanceKey)}</p>
          )}
          <div className="flex pt-1">
            <button
              type="button"
              className="rounded-md border border-[var(--border,#374151)] px-3 py-1.5 hover:bg-white/5"
              onClick={onDismiss}
            >
              {t('bluetoothQuality.banner.gotIt')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
