// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';

interface RefundConfirmModalProps {
  type: 'subscription' | 'gift' | 'power_up';
  amount: number;
  currency: string;
  loading: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export const RefundConfirmModal: React.FC<RefundConfirmModalProps> = ({ type, amount, currency, loading, onConfirm, onCancel }) => {
  const { t } = useTranslation();
  const [confirmText, setConfirmText] = useState('');
  const [reason, setReason] = useState('');

  const amountStr = `$${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => { if (!loading) onCancel(); }}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-md rounded-2xl border border-red-500/20 p-6"
        style={{ backgroundColor: 'var(--bg-panel)', backgroundImage: 'linear-gradient(135deg, rgba(239,68,68,0.06) 0%, transparent 100%)' }}
        onClick={(e) => e.stopPropagation()}>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-red-500/15 flex items-center justify-center shrink-0">
            <AlertTriangle size={20} className="text-red-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('billing.refund.confirmTitle')}</h3>
            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('billing.refund.confirmSubtitle')}</p>
          </div>
        </div>

        <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-4 mb-4">
          <p className="text-xs" style={{ color: 'var(--text-primary)' }}>
            {type === 'subscription' && t('billing.refund.confirmSubscription', { amount: amountStr })}
            {type === 'gift' && t('billing.refund.confirmGift', { amount: amountStr })}
            {type === 'power_up' && t('billing.refund.confirmPowerUp', { amount: amountStr })}
          </p>
        </div>

        <div className="mb-4">
          <label className="text-[10px] font-semibold mb-1 block" style={{ color: 'var(--text-secondary)' }}>{t('billing.refund.reasonLabel')}</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2}
            placeholder={t('billing.refund.reasonPlaceholder')}
            className="w-full rounded-lg border border-[var(--glass-border)] bg-fill-hover px-3 py-2 text-xs resize-none focus:outline-none focus:border-[var(--border-strong)]"
            style={{ color: 'var(--text-primary)' }} />
        </div>

        <div className="mb-5">
          <label className="text-[10px] font-semibold mb-1 block" style={{ color: 'var(--text-secondary)' }}>{t('billing.refund.typeToConfirm')}</label>
          <input type="text" value={confirmText} onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
            placeholder="REFUND"
            className="w-full rounded-lg border border-[var(--glass-border)] bg-fill-hover px-3 py-2 text-xs font-mono tracking-widest focus:outline-none focus:border-red-500/40"
            style={{ color: 'var(--text-primary)' }}
            autoComplete="off" spellCheck={false} />
        </div>

        <div className="flex gap-3">
          <button type="button" onClick={onCancel} disabled={loading}
            className="btn-secondary flex-1 text-[10px] py-2.5">
            {t('billing.refund.cancel')}
          </button>
          <button type="button" onClick={() => onConfirm(reason)} disabled={loading || confirmText !== 'REFUND'}
            className="btn-cta-danger flex-1 text-[10px] py-2.5 rounded-xl transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2">
            {loading && <Loader2 size={12} className="animate-spin" />}
            {loading ? t('billing.refund.processing') : t('billing.refund.confirmButton')}
          </button>
        </div>

        <p className="text-[10px] mt-3 text-center" style={{ color: 'var(--text-secondary)' }}>
          <Link to="/refund-policy" className="text-[var(--cyan-accent)] hover:underline">{t('billing.refund.viewPolicy')}</Link>
        </p>
      </div>
    </div>
  );
};
