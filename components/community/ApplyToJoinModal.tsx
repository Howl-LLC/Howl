// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useState, useCallback } from 'react';
import { Send, AlertTriangle, Check, Loader2 } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/modal';
import { apiClient } from '../../services/api';
import type { ApplicationQuestion, ApplicationAnswer } from '../../services/api/community';
import { TurnstileWidget } from './TurnstileWidget';

interface ApplyToJoinModalProps {
  /** Server the user is applying to. Pass null to render nothing. */
  serverId: string | null;
  /** Server display name. */
  serverName: string;
  /** Server icon URL. */
  serverIcon?: string | null;
  /** Application questions, supplied by the caller (typically from the
   * 202 `application_required` response on `/invites/join`). */
  questions: ApplicationQuestion[];
  /** Optional pre-form description (markdown allowed). */
  description?: string | null;
  /** When set, render the modal directly in the submitted/decided state
   * instead of the form — used when the caller already has a pending
   * application on file from a previous visit. */
  existingStatus?: 'pending' | 'accepted' | 'rejected' | null;
  onClose: () => void;
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'submitted'; status: 'pending' | 'accepted' | 'rejected' }
  | { kind: 'error'; message: string };

/**
 * Apply-to-join flow. Renders the configured questions (short text / long
 * text / single-choice), client-side-validates required fields, and submits
 * with a Turnstile captcha token. On 409 (duplicate application) collapses
 * to a "you already applied" pending state.
 *
 * The caller supplies `questions` directly — this modal does NOT fetch the
 * form itself, since the backend's `/invites/join` 202 response already
 * carries the questions inline. That keeps the apply path one round-trip
 * (POST `/applications`) instead of two (GET form, then POST).
 */
export const ApplyToJoinModal: React.FC<ApplyToJoinModalProps> = ({ serverId, serverName, serverIcon, questions, description, existingStatus, onClose }) => {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const [submit, setSubmit] = useState<SubmitState>(
    existingStatus ? { kind: 'submitted', status: existingStatus } : { kind: 'idle' },
  );

  // Pre-populate answers map so controlled inputs don't warn on first render.
  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const q of questions) initial[q.id] = '';
    setAnswers(initial);
    setValidationErrors({});
    setSubmit(existingStatus ? { kind: 'submitted', status: existingStatus } : { kind: 'idle' });
    setCaptchaToken('');
  }, [serverId, questions, existingStatus]);

  const validate = useCallback((): boolean => {
    const errs: Record<string, string> = {};
    for (const q of questions) {
      const val = (answers[q.id] ?? '').trim();
      if (q.required && !val) errs[q.id] = 'This question is required.';
      if (q.maxLength && val.length > q.maxLength) {
        errs[q.id] = `Must be ${q.maxLength} characters or less.`;
      }
    }
    setValidationErrors(errs);
    return Object.keys(errs).length === 0;
  }, [questions, answers]);

  const handleSubmit = useCallback(async () => {
    if (!serverId) return;
    if (!validate()) return;

    const payload: ApplicationAnswer[] = questions.map((q) => ({
      questionId: q.id,
      value: (answers[q.id] ?? '').trim(),
    }));

    setSubmit({ kind: 'submitting' });
    try {
      await apiClient.applicationSubmit(serverId, payload, captchaToken);
      // Backend returns `pending` for fresh submissions; reviewer decisions
      // arrive separately via `notification-created` / email, not this response.
      setSubmit({ kind: 'submitted', status: 'pending' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to submit application';
      // Common backend signals — match by error message keywords since the
      // request method only returns the message string.
      if (/already|duplicate|exists|409/i.test(message)) {
        setSubmit({ kind: 'submitted', status: 'pending' });
        return;
      }
      setSubmit({ kind: 'error', message });
      // Reset captcha so user can retry.
      setCaptchaToken('');
      setCaptchaResetKey((k) => k + 1);
    }
  }, [serverId, questions, answers, captchaToken, validate]);

  if (!serverId) return null;

  const renderQuestion = (q: ApplicationQuestion) => {
    const value = answers[q.id] ?? '';
    const err = validationErrors[q.id];
    const onChange = (next: string) =>
      setAnswers((prev) => ({ ...prev, [q.id]: next }));

    const baseInputCls =
      'w-full px-3 py-2.5 rounded-xl bg-input-surface border border-default text-t-primary text-sm placeholder:text-t-secondary focus:outline-none focus:border-[var(--cyan-accent)]/40 transition-colors';

    return (
      <div key={q.id} className="space-y-1.5">
        <label className="block text-xs font-semibold text-t-primary">
          {q.prompt}
          {q.required && <span className="text-red-400 ml-1">*</span>}
        </label>

        {q.type === 'short_text' && (
          <input
            type="text"
            value={value}
            maxLength={q.maxLength ?? undefined}
            onChange={(e) => onChange(e.target.value)}
            className={baseInputCls}
            placeholder="Your answer..."
          />
        )}

        {q.type === 'long_text' && (
          <textarea
            value={value}
            maxLength={q.maxLength ?? undefined}
            onChange={(e) => onChange(e.target.value)}
            rows={4}
            className={`${baseInputCls} resize-none`}
            placeholder="Your answer..."
          />
        )}

        {q.type === 'multiple_choice' && (
          <div className="space-y-1.5">
            {(q.choices ?? []).map((choice) => (
              <label
                key={choice}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                  value === choice
                    ? 'border-[var(--cyan-accent)]/40 bg-[var(--cyan-accent)]/[0.08]'
                    : 'border-default bg-input-surface hover:bg-fill-hover'
                }`}
              >
                <input
                  type="radio"
                  name={`q-${q.id}`}
                  value={choice}
                  checked={value === choice}
                  onChange={() => onChange(choice)}
                  className="accent-[var(--cyan-accent)]"
                />
                <span className="text-xs text-t-primary">{choice}</span>
              </label>
            ))}
          </div>
        )}

        {q.maxLength && q.type !== 'multiple_choice' && (
          <p className="text-[10px] text-t-secondary text-right">
            {value.length}/{q.maxLength}
          </p>
        )}

        {err && (
          <p className="text-[11px] text-red-400 flex items-center gap-1">
            <AlertTriangle size={11} /> {err}
          </p>
        )}
      </div>
    );
  };

  const isSubmitted = submit.kind === 'submitted';
  const isSubmitting = submit.kind === 'submitting';

  const displayName = serverName || 'this server';
  const displayIcon = serverIcon ?? null;

  return (
    <Modal open onClose={onClose} size="lg">
      <ModalHeader>
        <div className="flex items-center gap-3">
          {displayIcon ? (
            <img src={displayIcon} alt="" className="w-12 h-12 rounded-2xl object-cover" />
          ) : (
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-fill-hover text-t-primary font-bold text-lg">
              {displayName.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--cyan-accent)]">
              Apply to join
            </span>
            <h2 className="text-lg font-bold text-t-primary truncate">{displayName}</h2>
          </div>
        </div>
      </ModalHeader>

      <ModalBody>
        {isSubmitted ? (
          <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-5 py-4 text-sm text-emerald-300 flex items-start gap-3">
            <Check size={18} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold mb-1">
                {submit.status === 'accepted'
                  ? 'You were accepted.'
                  : submit.status === 'rejected'
                    ? 'Your application was declined.'
                    : 'Application pending review.'}
              </p>
              <p className="text-emerald-300/80 text-xs">
                {submit.status === 'pending'
                  ? "We'll notify you once a moderator reviews your answers."
                  : submit.status === 'accepted'
                    ? 'You can now access the server.'
                    : 'You may apply again at a later time.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {description && (
              <p className="text-xs text-t-secondary leading-relaxed whitespace-pre-line">
                {description}
              </p>
            )}

            {questions.length === 0 ? (
              <p className="text-xs text-t-secondary italic py-3 text-center">
                This server has no application questions configured.
              </p>
            ) : (
              questions.map(renderQuestion)
            )}

            <TurnstileWidget onToken={setCaptchaToken} resetKey={captchaResetKey} />

            {submit.kind === 'error' && (
              <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-xs text-red-300 flex items-start gap-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{submit.message}</span>
              </div>
            )}
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 rounded-lg bg-fill-hover text-t-primary text-xs font-semibold hover:bg-fill-active transition-colors"
        >
          {isSubmitted ? 'Close' : 'Cancel'}
        </button>
        {!isSubmitted && (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="btn-cta px-5 py-2 rounded-xl text-xs font-bold uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
          >
            {isSubmitting ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            {isSubmitting ? 'Submitting...' : 'Submit application'}
          </button>
        )}
      </ModalFooter>
    </Modal>
  );
};

export default ApplyToJoinModal;
