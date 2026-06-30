// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../services/api';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useUiStore } from '../stores/uiStore';
import { useDmStore } from '../stores/dmStore';
import { isUnlocked } from '../services/dmKeyManager';

type ReportReason = 'spam' | 'harassment' | 'csam' | 'violence' | 'other';

interface ReportMessageModalProps {
  onClose: () => void;
  onSubmitted: () => void;
  showToast: (message: string, type?: 'info' | 'warning') => void;
}

const REASON_OPTIONS: { value: ReportReason; labelKey: string; color: string }[] = [
  { value: 'spam', labelKey: 'report.spam', color: '#eab308' },
  { value: 'harassment', labelKey: 'report.harassment', color: '#f97316' },
  { value: 'violence', labelKey: 'report.violence', color: '#f43f5e' },
  { value: 'csam', labelKey: 'report.csam', color: '#ef4444' },
  { value: 'other', labelKey: 'report.other', color: '#94a3b8' },
];

export function ReportMessageModal({
  onClose,
  onSubmitted,
  showToast,
}: ReportMessageModalProps) {
  const { t } = useTranslation();
  const reportModal = useUiStore(s => s.reportModal);
  const dmChannels = useDmStore(s => s.dmChannels);
  const isOpen = !!reportModal;
  const messageId = reportModal?.messageId ?? '';
  const messageType = reportModal?.messageType ?? 'channel';
  const channelId = reportModal?.channelId;
  const dmChannelId = reportModal?.dmChannelId;
  const messageContent = reportModal?.content ?? '';

  // Detect if this is an encrypted DM where we can provide verification data
  const isEncryptedDm = useMemo(() => {
    if (messageType !== 'dm' || !dmChannelId) return false;
    const ch = dmChannels.find(c => c.id === dmChannelId);
    return ch?.encrypted === true;
  }, [messageType, dmChannelId, dmChannels]);
  const [reason, setReason] = useState<ReportReason | ''>('');
  const [details, setDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  useEffect(() => {
    if (isOpen) {
      setReason('');
      setDetails('');
      setSubmitting(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!reason) return;
    setSubmitting(true);
    try {
      const payload: Parameters<typeof apiClient.reportMessage>[0] = {
        messageId,
        messageType,
        channelId,
        dmChannelId,
        reason,
        details: details || undefined,
      };

      // For encrypted DMs, include the client-decrypted plaintext so the
      // admin panel can read the report (the server cannot decrypt MLS
      // content; no encryption key is ever disclosed).
      if (isEncryptedDm && dmChannelId && isUnlocked() && messageContent) {
        payload.plaintext = messageContent;
      }

      await apiClient.reportMessage(payload);
      showToast(t('toast.reportSubmitted'));
      onSubmitted();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('toast.reportFailed'), 'warning');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[var(--z-max)] flex items-center justify-center" style={{ backgroundColor: 'var(--overlay-backdrop)', backdropFilter: 'blur(4px)' }} onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="report-modal-title" className="w-full max-w-md max-h-[90vh] overflow-y-auto mx-4 rounded-2xl border" style={{ backgroundColor: 'var(--bg-floating)', borderColor: 'var(--glass-border)' }} onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: 'var(--danger-subtle)' }}>
              <ShieldAlert size={16} style={{ color: 'var(--danger)' }} />
            </div>
            <div>
              <h3 id="report-modal-title" className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{t('report.reportMessage')}</h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                {messageType === 'dm' ? t('report.dmReportNote') : t('report.channelReportNote')}
              </p>
            </div>
          </div>
        </div>

        <div className="p-5 space-y-4">
          <div className="rounded-xl p-3 border text-xs max-h-24 overflow-y-auto" style={{ backgroundColor: 'var(--fill-hover)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
            {messageContent || <span style={{ opacity: 0.5, fontStyle: 'italic' }}>{t('report.noTextContent')}</span>}
          </div>

          {isEncryptedDm && (
            <div className="rounded-xl p-3 border text-xs leading-relaxed" style={{ backgroundColor: 'rgba(245, 158, 11, 0.08)', borderColor: 'rgba(245, 158, 11, 0.2)', color: 'var(--text-secondary)' }}>
              Reporting this message will share your decrypted copy of this single message with Howl&apos;s moderation team. No encryption keys are shared, and our team cannot read any other messages in this or any other conversation.
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('report.reason')}</label>
            <div className="grid grid-cols-2 gap-2">
              {REASON_OPTIONS.map(r => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => setReason(r.value)}
                  className="px-3 py-2 rounded-lg text-xs font-medium border transition-all duration-150"
                  style={{
                    backgroundColor: reason === r.value ? `${r.color}15` : 'var(--fill-hover)',
                    borderColor: reason === r.value ? `${r.color}40` : 'var(--border-subtle)',
                    color: reason === r.value ? r.color : 'var(--text-secondary)',
                  }}
                >{t(r.labelKey)}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('report.additionalDetails')}</label>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder={t('report.additionalContextPlaceholder')}
              className="w-full px-3 py-2.5 rounded-xl text-sm resize-none border focus:outline-none transition-all"
              style={{
                backgroundColor: 'var(--fill-hover)',
                borderColor: 'var(--glass-border)',
                color: 'var(--text-primary)',
              }}
            />
          </div>
        </div>

        <div className="p-5 pt-0 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium transition-all"
            style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' }}
          >{t('common.cancel')}</button>
          <button
            type="button"
            disabled={!reason || submitting}
            onClick={handleSubmit}
            className="px-5 py-2 rounded-xl text-sm font-bold transition-all disabled:opacity-40"
            style={{
              backgroundColor: 'var(--danger-subtle)',
              color: 'var(--danger)',
              border: '1px solid var(--danger-muted)',
            }}
          >{submitting ? t('report.submitting') : t('report.submitReport')}</button>
        </div>
      </div>
    </div>
  );
}
