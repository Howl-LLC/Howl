// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, MessageCirclePlus } from 'lucide-react';
import { Dropdown } from './ui/dropdown';

export interface ThreadCreationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateThread: (data: {
    name: string;
    parentMessageId: string;
    autoArchive: boolean;
    autoArchiveDuration: string;
  }) => Promise<void>;
  parentMessageId: string;
  parentMessagePreview?: string;
}

const ARCHIVE_DURATIONS = [
  { value: '60', labelKey: 'threads.duration1h' },
  { value: '1440', labelKey: 'threads.duration1d' },
  { value: '4320', labelKey: 'threads.duration3d' },
  { value: '10080', labelKey: 'threads.duration7d' },
  { value: '21600', labelKey: 'threads.duration15d' },
  { value: '43200', labelKey: 'threads.duration30d' },
] as const;

export const ThreadCreationModal: React.FC<ThreadCreationModalProps> = ({ isOpen, onClose, onCreateThread, parentMessageId, parentMessagePreview }) => {
  const { t } = useTranslation();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [autoArchive, setAutoArchive] = useState(true);
  const [autoArchiveDuration, setAutoArchiveDuration] = useState('1440');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setAutoArchive(true);
      setAutoArchiveDuration('1440');
      setSubmitting(false);
      setError(null);
      setTimeout(() => nameRef.current?.focus(), 100);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const archiveOptions = useMemo(
    () => ARCHIVE_DURATIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) })),
    [t]
  );

  if (!isOpen) return null;

  const canSubmit = name.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreateThread({ name: name.trim(), parentMessageId, autoArchive, autoArchiveDuration });
      onClose();
    } catch (err: any) {
      setSubmitting(false);
      setError(err?.message || t('threads.createError', 'Failed to create thread. Please try again.'));
    }
  };

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--overlay-backdrop)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-sm rounded-2xl border shadow-2xl overflow-hidden"
        style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2">
            <MessageCirclePlus size={18} style={{ color: 'var(--cyan-accent)' }} />
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('threads.createThread')}</h2>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Parent message preview */}
          {parentMessagePreview && (
            <div className="text-xs px-3 py-2 rounded-lg truncate" style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-tertiary)' }}>
              {parentMessagePreview.slice(0, 100)}
            </div>
          )}

          {/* Thread name */}
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('threads.threadName')}</label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 100))}
              placeholder={t('threads.threadNamePlaceholder')}
              className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none focus:border-[var(--cyan-accent)]/50"
              style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); } }}
            />
          </div>

          {/* Auto-archive settings */}
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 cursor-pointer">
              <div
                className={`w-10 h-6 rounded-full p-0.5 transition-colors cursor-pointer shrink-0 ${autoArchive ? 'bg-[var(--cyan-accent)]' : 'bg-fill-active'}`}
                onClick={() => setAutoArchive((v) => !v)}
              >
                <div className={`w-5 h-5 rounded-full bg-white transition-transform ${autoArchive ? 'translate-x-4' : ''}`} />
              </div>
              <span className="text-sm min-w-0" style={{ color: 'var(--text-primary)' }}>{t('threads.autoArchive')}</span>
            </label>
            {autoArchive && (
              <Dropdown
                options={archiveOptions}
                value={autoArchiveDuration}
                onChange={(v) => setAutoArchiveDuration(v)}
                size="sm"
              />
            )}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="px-5 py-2">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium hover:bg-fill-active transition-colors" style={{ color: 'var(--text-secondary)' }}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="btn-cta px-4 py-2 rounded-xl text-sm transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? t('common.loading') : t('threads.createThread')}
          </button>
        </div>
      </div>
    </div>
  );
};
