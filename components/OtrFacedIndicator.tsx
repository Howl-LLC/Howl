// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Faced-side indicator that replaces the header OTR toggle. Two paging dots
 * (left = Saved, right = OTR); the faced side is lit. An "Off the Record" tag
 * shows when faced to OTR. Clicking toggles the tier (desktop + no-touch
 * affordance).
 */
export const OtrFacedIndicator: React.FC<{ active: boolean; onToggle: () => void }> = ({ active, onToggle }) => {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-fill-active transition-colors"
      title={t('chat.offTheRecord', 'Off the Record')}
      aria-label={t('chat.offTheRecord', 'Off the Record')}
      aria-pressed={active}
    >
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: active ? 'var(--text-secondary)' : 'var(--cyan-accent)', opacity: active ? 0.4 : 1 }} />
        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: active ? 'var(--cyan-accent)' : 'var(--text-secondary)', opacity: active ? 1 : 0.4 }} />
      </span>
      {active && (
        <span className="text-[11px] font-semibold" style={{ color: 'var(--cyan-accent)' }}>
          {t('chat.offTheRecordTag', 'Off the Record')}
        </span>
      )}
    </button>
  );
};
OtrFacedIndicator.displayName = 'OtrFacedIndicator';
