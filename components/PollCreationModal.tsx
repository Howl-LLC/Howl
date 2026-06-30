// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Plus, Trash2, BarChart3 } from 'lucide-react';
import { Dropdown } from './ui/dropdown';
const EmojiPicker = React.lazy(() => import('./EmojiPicker').then(m => ({ default: m.EmojiPicker })));

export interface PollCreationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreatePoll: (data: {
    question: string;
    options: (string | { text: string; emoji?: string })[];
    allowMultiple: boolean;
    anonymous: boolean;
    duration: string;
  }) => Promise<void>;
}

const DURATION_OPTIONS = [
  { value: '15', labelKey: 'polls.duration15m' },
  { value: '30', labelKey: 'polls.duration30m' },
  { value: '60', labelKey: 'polls.duration1h' },
  { value: '240', labelKey: 'polls.duration4h' },
  { value: '480', labelKey: 'polls.duration8h' },
  { value: '1440', labelKey: 'polls.duration24h' },
  { value: '4320', labelKey: 'polls.duration3d' },
  { value: '10080', labelKey: 'polls.duration7d' },
  { value: 'none', labelKey: 'polls.durationNone' },
] as const;

const MAX_OPTIONS = 15;
const MIN_OPTIONS = 2;

export const PollCreationModal: React.FC<PollCreationModalProps> = ({ isOpen, onClose, onCreatePoll }) => {
  const { t } = useTranslation();
  const questionRef = useRef<HTMLInputElement>(null);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [duration, setDuration] = useState('1440');
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optionEmojis, setOptionEmojis] = useState<(string | null)[]>([null, null]);
  const [emojiPickerIndex, setEmojiPickerIndex] = useState<number | null>(null);
  const emojiButtonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (isOpen) {
      setQuestion('');
      setOptions(['', '']);
      setDuration('1440');
      setAllowMultiple(false);
      setAnonymous(false);
      setSubmitting(false);
      setError(null);
      setOptionEmojis([null, null]);
      setEmojiPickerIndex(null);
      setTimeout(() => questionRef.current?.focus(), 100);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const durationOptions = useMemo(
    () => DURATION_OPTIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) })),
    [t]
  );

  const selectionOptions = useMemo(
    () => [
      { value: 'single' as const, label: t('polls.singleChoice') },
      { value: 'multiple' as const, label: t('polls.multipleChoice') },
    ],
    [t]
  );

  if (!isOpen) return null;

  const canSubmit = question.trim().length > 0 && options.filter((o) => o.trim()).length >= MIN_OPTIONS && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreatePoll({
        question: question.trim(),
        options: options.reduce<(string | { text: string; emoji?: string })[]>((acc, o, i) => {
          if (!o.trim()) return acc;
          const emoji = optionEmojis[i];
          acc.push(emoji ? { text: o.trim(), emoji } : o.trim());
          return acc;
        }, []),
        allowMultiple,
        anonymous,
        duration,
      });
      onClose();
    } catch (err: any) {
      setSubmitting(false);
      setError(err?.message || t('polls.createError', 'Failed to create poll. Please try again.'));
    }
  };

  const updateOption = (index: number, value: string) => {
    setOptions((prev) => prev.map((o, i) => (i === index ? value : o)));
  };

  const addOption = () => {
    if (options.length < MAX_OPTIONS) {
      setOptions((prev) => [...prev, '']);
      setOptionEmojis((prev) => [...prev, null]);
    }
  };

  const removeOption = (index: number) => {
    if (options.length > MIN_OPTIONS) {
      setOptions((prev) => prev.filter((_, i) => i !== index));
      setOptionEmojis((prev) => prev.filter((_, i) => i !== index));
      if (emojiPickerIndex === index) setEmojiPickerIndex(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--overlay-backdrop)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden"
        style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2">
            <BarChart3 size={18} style={{ color: 'var(--cyan-accent)' }} />
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('polls.createPoll')}</h2>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {/* Question */}
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('polls.question')}</label>
            <input
              ref={questionRef}
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value.slice(0, 300))}
              placeholder={t('polls.questionPlaceholder')}
              className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none focus:border-[var(--cyan-accent)]/50"
              style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
            />
            <div className="text-right text-[10px] mt-0.5" style={{ color: question.length > 280 ? 'var(--danger)' : 'var(--text-tertiary)' }}>
              {question.length}/300
            </div>
          </div>

          {/* Options */}
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('polls.options')}</label>
            <div className="space-y-2">
              {options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <button
                    ref={(el) => { emojiButtonRefs.current[i] = el; }}
                    type="button"
                    onClick={() => setEmojiPickerIndex(emojiPickerIndex === i ? null : i)}
                    className="w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 text-base transition-colors"
                    style={{
                      borderColor: optionEmojis[i] ? 'color-mix(in srgb, var(--cyan-accent) 20%, transparent)' : 'var(--glass-border)',
                      backgroundColor: optionEmojis[i] ? 'color-mix(in srgb, var(--cyan-accent) 8%, transparent)' : 'var(--fill-hover)',
                    }}
                    title={t('polls.addEmoji', 'Add emoji')}
                  >
                    {optionEmojis[i] || (
                      <span className="text-sm" style={{ color: 'var(--text-secondary)', opacity: 0.4 }}>+</span>
                    )}
                  </button>
                  <input
                    type="text"
                    value={opt}
                    onChange={(e) => updateOption(i, e.target.value.slice(0, 80))}
                    placeholder={t('polls.optionPlaceholder', { number: i + 1 })}
                    className="flex-1 px-3 py-2 rounded-xl border text-sm outline-none focus:border-[var(--cyan-accent)]/50"
                    style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); if (i === options.length - 1 && options.length < MAX_OPTIONS) addOption(); }
                    }}
                  />
                  {options.length > MIN_OPTIONS && (
                    <button type="button" onClick={() => removeOption(i)} className="p-1.5 rounded-lg hover:bg-fill-active shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {options.length < MAX_OPTIONS && (
              <button
                type="button"
                onClick={addOption}
                className="mt-2 flex items-center gap-1.5 text-xs font-medium px-2 py-1.5 rounded-lg hover:bg-fill-active transition-colors"
                style={{ color: 'var(--cyan-accent)' }}
              >
                <Plus size={14} /> {t('polls.addOption', { max: MAX_OPTIONS })}
              </button>
            )}
          </div>
          {emojiPickerIndex !== null && (
            <React.Suspense fallback={null}>
              <EmojiPicker
                open
                onClose={() => setEmojiPickerIndex(null)}
                onSelect={(emoji: string) => {
                  setOptionEmojis((prev) => prev.map((e, i) => i === emojiPickerIndex ? emoji : e));
                  setEmojiPickerIndex(null);
                }}
                anchorRef={{ current: emojiButtonRefs.current[emojiPickerIndex] ?? null } as React.RefObject<HTMLElement | null>}
              />
            </React.Suspense>
          )}

          {/* Settings row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('polls.duration')}</label>
              <Dropdown
                options={durationOptions}
                value={duration}
                onChange={(v) => setDuration(v)}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('polls.selection')}</label>
              <Dropdown
                options={selectionOptions}
                value={allowMultiple ? 'multiple' : 'single'}
                onChange={(v) => setAllowMultiple(v === 'multiple')}
              />
            </div>
          </div>

          {/* Anonymous toggle */}
          <label className="flex items-center justify-between cursor-pointer py-1">
            <div className="min-w-0">
              <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t('polls.anonymous')}</div>
              <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('polls.anonymousDescription')}</div>
            </div>
            <div
              className={`w-10 h-6 rounded-full p-0.5 transition-colors cursor-pointer shrink-0 ${anonymous ? 'bg-[var(--cyan-accent)]' : 'bg-fill-active'}`}
              onClick={() => setAnonymous((v) => !v)}
            >
              <div className={`w-5 h-5 rounded-full bg-white transition-transform ${anonymous ? 'translate-x-4' : ''}`} />
            </div>
          </label>
        </div>

        {/* Error */}
        {error && (
          <div className="px-5 py-2">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium hover:bg-fill-active transition-colors"
            style={{ color: 'var(--text-secondary)' }}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="btn-cta px-4 py-2 rounded-xl text-sm font-semibold transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? t('common.loading') : t('polls.create')}
          </button>
        </div>
      </div>
    </div>
  );
};
