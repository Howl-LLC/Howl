// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { Info, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface RecoveryKeyReminderProps {
  onDismiss: () => void;
  onViewKey: () => void;
}

export const RecoveryKeyReminder: React.FC<RecoveryKeyReminderProps> = ({ onDismiss, onViewKey }) => {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--cyan-accent)]/8 border border-[var(--cyan-accent)]/20">
      <Info size={16} className="text-[var(--cyan-accent)]/80 shrink-0" />
      <p className="text-xs flex-1" style={{ color: 'var(--text-secondary)' }}>
        {t('dm.recoveryKeyReminder', "Make sure you've saved your recovery key. You'll need it if you forget your password.")}
      </p>
      <button
        type="button"
        onClick={onViewKey}
        className="text-xs font-medium text-[var(--cyan-accent)]/80 hover:text-[var(--cyan-accent)] whitespace-nowrap transition-colors"
      >
        {t('dm.recoveryKeyView', 'View Key')}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="p-1 rounded-md hover:bg-fill-active transition-colors shrink-0"
        style={{ color: 'var(--text-secondary)' }}
      >
        <X size={14} />
      </button>
    </div>
  );
};
