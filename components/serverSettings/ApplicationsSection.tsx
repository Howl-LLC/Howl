// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardList, Plus, Trash2, ChevronDown, Check, X, Loader2, ChevronUp } from 'lucide-react';
import { Server, serverHasPerm } from '../../types';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import type {
  ApplicationQuestion,
  ApplicationQuestionType,
  ApplicationStatus,
  ServerApplicationSummary,
} from '../../services/api/community';
import { LetterAvatar } from '../LetterAvatar';
import {
  SectionHeader,
  Card,
  Toggle,
  PrimaryButton,
  EmptyState,
} from '../settings/SettingsWidgets';
import { Dropdown } from '../ui/dropdown';

const MAX_QUESTIONS = 5;
const MAX_PROMPT_LEN = 200;
const MAX_ANSWER_LEN = 2000;
const MAX_CHOICES = 8;

export interface ApplicationsSectionProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

const QUESTION_TYPE_OPTIONS: { value: ApplicationQuestionType; label: string }[] = [
  { value: 'short_text', label: 'Short text' },
  { value: 'long_text', label: 'Long text' },
  { value: 'multiple_choice', label: 'Multiple choice' },
];

const STATUS_TABS: { id: ApplicationStatus; labelKey: string; defaultLabel: string }[] = [
  { id: 'pending', labelKey: 'applications.tabPending', defaultLabel: 'Pending' },
  { id: 'accepted', labelKey: 'applications.tabAccepted', defaultLabel: 'Accepted' },
  { id: 'rejected', labelKey: 'applications.tabRejected', defaultLabel: 'Rejected' },
];

function genId() {
  // Crypto.randomUUID is widely supported now; fall back to timestamped suffix.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const ApplicationsSection: React.FC<ApplicationsSectionProps> = ({ server, showToast }) => {
  const { t } = useTranslation();
  const canManage = serverHasPerm(server, 'manageMembers');

  // Questions
  const [questions, setQuestions] = useState<ApplicationQuestion[]>([]);
  const [questionsLoading, setQuestionsLoading] = useState(true);
  const [questionsSaving, setQuestionsSaving] = useState(false);

  const refreshQuestions = useCallback(async () => {
    setQuestionsLoading(true);
    try {
      const r = await apiClient.serverApplicationsQuestionsGet(server.id);
      setQuestions(r.questions);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('applications.loadQuestionsFailed', { defaultValue: 'Failed to load questions' }), 'error');
    } finally {
      setQuestionsLoading(false);
    }
  }, [server.id, showToast, t]);

  useEffect(() => { if (canManage) refreshQuestions(); }, [canManage, refreshQuestions]);

  const addQuestion = () => {
    if (questions.length >= MAX_QUESTIONS) return;
    setQuestions((prev) => [
      ...prev,
      { id: genId(), prompt: '', type: 'short_text', required: true, maxLength: 200 },
    ]);
  };

  const updateQuestion = (id: string, patch: Partial<ApplicationQuestion>) => {
    setQuestions((prev) => prev.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  };

  const removeQuestion = (id: string) => {
    setQuestions((prev) => prev.filter((q) => q.id !== id));
  };

  const moveQuestion = (id: string, direction: 'up' | 'down') => {
    setQuestions((prev) => {
      const idx = prev.findIndex((q) => q.id === id);
      if (idx === -1) return prev;
      const nextIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (nextIdx < 0 || nextIdx >= prev.length) return prev;
      const copy = prev.slice();
      const tmp = copy[idx];
      copy[idx] = copy[nextIdx];
      copy[nextIdx] = tmp;
      return copy;
    });
  };

  const saveQuestions = useCallback(async () => {
    // Client-side validation
    const cleaned = questions.map((q) => ({
      ...q,
      prompt: q.prompt.trim().slice(0, MAX_PROMPT_LEN),
      maxLength: Math.max(1, Math.min(MAX_ANSWER_LEN, (q.maxLength ?? 0) | 0)),
      choices: q.type === 'multiple_choice'
        ? (q.choices ?? []).map((c) => c.trim()).filter(Boolean).slice(0, MAX_CHOICES)
        : undefined,
    }));
    if (cleaned.some((q) => !q.prompt)) {
      showToast(t('applications.promptRequired', { defaultValue: 'Every question needs a prompt.' }), 'error');
      return;
    }
    if (cleaned.some((q) => q.type === 'multiple_choice' && (!q.choices || q.choices.length < 2))) {
      showToast(t('applications.choicesRequired', { defaultValue: 'Multiple-choice questions need at least 2 choices.' }), 'error');
      return;
    }
    setQuestionsSaving(true);
    try {
      const next = await apiClient.serverApplicationsQuestionsPatch(server.id, cleaned);
      setQuestions(next.questions);
      showToast(t('applications.questionsSaved', { defaultValue: 'Questions saved' }));
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('applications.saveFailed', { defaultValue: 'Failed to save questions' }), 'error');
    } finally {
      setQuestionsSaving(false);
    }
  }, [questions, server.id, showToast, t]);

  // Applications list
  const [activeTab, setActiveTab] = useState<ApplicationStatus>('pending');
  const [items, setItems] = useState<ServerApplicationSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadList = useCallback(async (status: ApplicationStatus, nextCursor: string | null = null, append = false) => {
    if (append) setLoadingMore(true); else setListLoading(true);
    try {
      const page = await apiClient.serverApplicationsList(server.id, { status, cursor: nextCursor });
      setItems((prev) => append ? [...prev, ...page.applications] : page.applications);
      setCursor(page.nextCursor);
      setHasMore(!!page.nextCursor);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('applications.loadListFailed', { defaultValue: 'Failed to load applications' }), 'error');
    } finally {
      if (append) setLoadingMore(false); else setListLoading(false);
    }
  }, [server.id, showToast, t]);

  useEffect(() => { if (canManage) loadList(activeTab, null, false); }, [canManage, activeTab, loadList]);

  // Live sync: when another admin edits the questions or a new application
  // arrives / is decided, backend emits `server-applications-updated` with
  // `{ kind: 'questions' | 'list' }`. Refetch the affected slice so admins
  // viewing the tab see changes without a refresh.
  useEffect(() => {
    if (!canManage) return;
    const sock = socketService.getSocket();
    if (!sock) return;
    const handler = (payload: { serverId: string; kind?: 'questions' | 'list' }) => {
      if (payload.serverId !== server.id) return;
      if (payload.kind === 'questions') {
        refreshQuestions();
      } else {
        loadList(activeTab, null, false);
      }
    };
    sock.on('server-applications-updated', handler);
    return () => { sock.off('server-applications-updated', handler); };
  }, [canManage, server.id, activeTab, refreshQuestions, loadList]);

  if (!canManage) {
    return (
      <div className="max-w-3xl">
        <SectionHeader title={t('applications.title', { defaultValue: 'Applications' })} icon={<ClipboardList size={24} />} />
        <EmptyState icon={<ClipboardList size={40} />}
          title={t('applications.noPermission', { defaultValue: 'You don\'t have permission to review applications.' })}
          desc={t('applications.noPermissionDesc', { defaultValue: 'Ask a server admin with the Manage Members permission.' })} />
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <SectionHeader
        title={t('applications.title', { defaultValue: 'Applications' })}
        desc={t('applications.headerDesc', { defaultValue: 'Configure questions and review who wants to join.' })}
        icon={<ClipboardList size={24} />}
      />

      {/* ─── Questions config ─────────────────────────────────────────────── */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-sm font-semibold text-t-primary">{t('applications.questionsTitle', { defaultValue: 'Application questions' })}</p>
            <p className="text-[12px] text-t-secondary mt-0.5">
              {t('applications.questionsDesc', { defaultValue: 'Up to 5 questions. Applicants must answer the required ones.' })}
            </p>
          </div>
          <button type="button" onClick={addQuestion} disabled={questions.length >= MAX_QUESTIONS}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-default hover:bg-fill-hover transition-all text-sm text-t-accent disabled:opacity-40 disabled:cursor-not-allowed">
            <Plus size={14} /> {t('applications.addQuestion', { defaultValue: 'Add question' })}
          </button>
        </div>
        {questionsLoading ? (
          <div className="py-10 text-center text-[12px] text-t-secondary">{t('serverSettings.loading')}</div>
        ) : questions.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-t-secondary">
            {t('applications.noQuestions', { defaultValue: 'No questions yet. Click "Add question" to start.' })}
          </p>
        ) : (
          <ul className="space-y-3">
            {questions.map((q, idx) => (
              <li key={q.id} className="rounded-xl border border-default bg-floating p-3 space-y-3">
                <div className="flex items-start gap-2">
                  <div className="flex flex-col gap-1 pt-1">
                    <button type="button" onClick={() => moveQuestion(q.id, 'up')} disabled={idx === 0}
                      className="p-0.5 rounded-lg hover:bg-fill-hover transition-colors text-t-secondary disabled:opacity-30 disabled:cursor-not-allowed">
                      <ChevronUp size={12} />
                    </button>
                    <button type="button" onClick={() => moveQuestion(q.id, 'down')} disabled={idx === questions.length - 1}
                      className="p-0.5 rounded-lg hover:bg-fill-hover transition-colors text-t-secondary disabled:opacity-30 disabled:cursor-not-allowed">
                      <ChevronDown size={12} />
                    </button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <input
                      value={q.prompt}
                      onChange={(e) => updateQuestion(q.id, { prompt: e.target.value.slice(0, MAX_PROMPT_LEN) })}
                      maxLength={MAX_PROMPT_LEN}
                      placeholder={t('applications.promptPlaceholder', { defaultValue: 'What\'s your question?' })}
                      className="w-full rounded-lg px-3 py-2 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary"
                    />
                  </div>
                  <button type="button" onClick={() => removeQuestion(q.id)}
                    className="p-1.5 rounded-md hover:bg-red-400/15 text-t-secondary hover:text-red-400 transition-colors shrink-0">
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="w-44">
                    <Dropdown
                      value={q.type}
                      onChange={(v) => updateQuestion(q.id, { type: v as ApplicationQuestionType })}
                      options={QUESTION_TYPE_OPTIONS.map((o) => ({ value: o.value, label: t(`applications.questionType.${o.value}`, { defaultValue: o.label }) }))}
                      size="sm"
                    />
                  </div>
                  <label className="inline-flex items-center gap-2 text-[12px] text-t-secondary">
                    <Toggle checked={q.required} onChange={(v) => updateQuestion(q.id, { required: v })} />
                    {t('applications.required', { defaultValue: 'Required' })}
                  </label>
                  {q.type !== 'multiple_choice' && (
                    <label className="inline-flex items-center gap-2 text-[12px] text-t-secondary">
                      {t('applications.maxLength', { defaultValue: 'Max length' })}
                      <input
                        type="number"
                        value={q.maxLength ?? ''}
                        onChange={(e) => updateQuestion(q.id, { maxLength: Math.max(1, Math.min(MAX_ANSWER_LEN, parseInt(e.target.value || '1', 10))) })}
                        min={1}
                        max={MAX_ANSWER_LEN}
                        className="w-20 rounded-md px-2 py-1 text-xs border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary tabular-nums"
                      />
                    </label>
                  )}
                </div>
                {q.type === 'multiple_choice' && (
                  <div className="space-y-2">
                    <p className="text-[11px] font-medium text-t-secondary">{t('applications.choices', { defaultValue: 'Choices' })}</p>
                    {(q.choices ?? []).map((choice, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          value={choice}
                          onChange={(e) => {
                            const next = (q.choices ?? []).slice();
                            next[i] = e.target.value;
                            updateQuestion(q.id, { choices: next });
                          }}
                          maxLength={64}
                          placeholder={t('applications.choicePlaceholder', { defaultValue: 'Choice text' })}
                          className="flex-1 rounded-lg px-3 py-1.5 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all bg-app-surface text-t-primary"
                        />
                        <button type="button" onClick={() => updateQuestion(q.id, { choices: (q.choices ?? []).filter((_, j) => j !== i) })}
                          className="p-1.5 rounded-md hover:bg-red-400/15 text-t-secondary hover:text-red-400 transition-colors">
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                    <button type="button" onClick={() => updateQuestion(q.id, { choices: [...(q.choices ?? []), ''] })}
                      disabled={(q.choices?.length ?? 0) >= MAX_CHOICES}
                      className="text-[12px] text-t-accent inline-flex items-center gap-1 hover:underline disabled:opacity-40">
                      <Plus size={12} /> {t('applications.addChoice', { defaultValue: 'Add choice' })}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <PrimaryButton onClick={saveQuestions} loading={questionsSaving} disabled={questionsLoading}>
            {t('applications.saveQuestions', { defaultValue: 'Save questions' })}
          </PrimaryButton>
        </div>
      </Card>

      {/* ─── Applications list with tabs ──────────────────────────────────── */}
      <div>
        <div className="inline-flex rounded-xl border border-default p-1 bg-floating mb-4">
          {STATUS_TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${isActive ? 'bg-[var(--cyan-accent)] text-black' : 'text-t-secondary hover:text-t-primary'}`}
              >
                {t(tab.labelKey, { defaultValue: tab.defaultLabel })}
              </button>
            );
          })}
        </div>
        {listLoading ? (
          <Card><div className="py-10 text-center text-[12px] text-t-secondary">{t('serverSettings.loading')}</div></Card>
        ) : items.length === 0 ? (
          <Card><EmptyState icon={<ClipboardList size={40} />}
            title={t('applications.empty', { defaultValue: 'No applications' })}
            desc={
              activeTab === 'pending'
                ? t('applications.emptyPending', { defaultValue: 'New applications will appear here.' })
                : activeTab === 'accepted'
                  ? t('applications.emptyAccepted', { defaultValue: 'You haven\'t accepted any applicants yet.' })
                  : t('applications.emptyRejected', { defaultValue: 'You haven\'t rejected any applicants yet.' })
            } /></Card>
        ) : (
          <ul className="space-y-3">
            {items.map((app) => (
              <ApplicationCard
                key={app.id}
                app={app}
                questions={questions}
                onDecided={(updated) => {
                  // Move card out of the active tab if its status changed
                  if (updated.status !== activeTab) {
                    setItems((prev) => prev.filter((a) => a.id !== updated.id));
                  } else {
                    setItems((prev) => prev.map((a) => a.id === updated.id ? updated : a));
                  }
                }}
                showToast={showToast}
                serverId={server.id}
                t={t}
              />
            ))}
          </ul>
        )}
        {hasMore && (
          <div className="mt-4 flex justify-center">
            <button type="button"
              onClick={() => loadList(activeTab, cursor, true)}
              disabled={loadingMore}
              className="btn-secondary px-4 py-2 text-sm">
              {loadingMore ? t('applications.loadingMore', { defaultValue: 'Loading…' }) : t('applications.loadMore', { defaultValue: 'Load more' })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

interface ApplicationCardProps {
  app: ServerApplicationSummary;
  questions: ApplicationQuestion[];
  onDecided: (updated: ServerApplicationSummary) => void;
  showToast: (message: string, type?: 'success' | 'error') => void;
  serverId: string;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}

const ApplicationCard: React.FC<ApplicationCardProps> = ({ app, questions, onDecided, showToast, serverId, t }) => {
  const [expanded, setExpanded] = useState(false);
  const [decisionInFlight, setDecisionInFlight] = useState<'accept' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [internalNote, setInternalNote] = useState('');

  const promptById = useMemo(() => {
    const map = new Map<string, ApplicationQuestion>();
    for (const q of questions) map.set(q.id, q);
    return map;
  }, [questions]);

  const decide = async (decision: 'accept' | 'reject') => {
    setDecisionInFlight(decision);
    try {
      const updated = await apiClient.serverApplicationDecide(serverId, app.id, decision, {
        note: note.trim() || undefined,
        internalNote: internalNote.trim() || undefined,
      });
      onDecided(updated);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('applications.decisionFailed', { defaultValue: 'Failed to record decision' }), 'error');
    } finally {
      setDecisionInFlight(null);
    }
  };

  return (
    <li className="rounded-xl border border-default bg-floating overflow-hidden">
      <div className="p-4 flex items-start gap-3">
        <LetterAvatar avatar={app.applicant.avatar} username={app.applicant.username} size={36} className="rounded-full shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-t-primary truncate">
            {app.applicant.username}
            {app.applicant.discriminator ? <span className="text-t-secondary font-normal">#{app.applicant.discriminator}</span> : null}
          </p>
          <p className="text-[11px] text-t-secondary">
            {new Date(app.createdAt).toLocaleString()}
          </p>
        </div>
        {app.status === 'pending' && (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => decide('reject')} disabled={!!decisionInFlight}
              className="btn-danger-soft inline-flex items-center gap-1.5 px-3 py-1.5 text-sm">
              {decisionInFlight === 'reject' ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
              {t('applications.reject', { defaultValue: 'Reject' })}
            </button>
            <button type="button" onClick={() => decide('accept')} disabled={!!decisionInFlight}
              className="btn-cta inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition-all text-sm disabled:opacity-40">
              {decisionInFlight === 'accept' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              {t('applications.accept', { defaultValue: 'Accept' })}
            </button>
          </div>
        )}
        {app.status !== 'pending' && (
          <span className={`px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider ${
            app.status === 'accepted' ? 'bg-emerald-500/15 text-emerald-400' :
            app.status === 'rejected' ? 'bg-red-400/15 text-red-400' :
            'bg-t-secondary/15 text-t-secondary'
          }`}>
            {t(`applications.status.${app.status}`, { defaultValue: app.status })}
          </span>
        )}
      </div>
      {/* Answers preview / expand toggle */}
      <div className="border-t border-default px-4 py-2">
        <button type="button" onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center justify-between text-[12px] text-t-secondary hover:text-t-primary transition-colors">
          <span>{expanded ? t('applications.hideAnswers', { defaultValue: 'Hide answers' }) : t('applications.showAnswers', { defaultValue: `Show ${app.answers.length} answer(s)` })}</span>
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        {expanded && (
          <div className="mt-3 space-y-3">
            {app.answers.map((a) => {
              const q = promptById.get(a.questionId);
              return (
                <div key={a.questionId}>
                  <p className="text-[11px] font-semibold text-t-secondary mb-0.5">
                    {q?.prompt ?? t('applications.unknownQuestion', { defaultValue: '(question removed)' })}
                  </p>
                  <p className="text-sm text-t-primary whitespace-pre-wrap break-words">{a.value || '—'}</p>
                </div>
              );
            })}
            {app.status === 'pending' && (
              <>
                <div className="pt-3 border-t border-default space-y-1.5">
                  <label className="block text-[11px] font-medium text-t-secondary">
                    {t('applications.applicantNoteLabel', { defaultValue: 'Message to the applicant (optional)' })}
                  </label>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value.slice(0, 500))}
                    rows={2}
                    maxLength={500}
                    placeholder={t('applications.applicantNotePlaceholder', { defaultValue: 'Will be included in the accept or reject email…' })}
                    className="w-full rounded-lg px-3 py-2 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all resize-none bg-app-surface text-t-primary"
                  />
                  <p className="text-[10px] text-t-tertiary">
                    {t('applications.applicantNoteHelp', { defaultValue: 'Sent to the applicant in the decision email.' })}
                  </p>
                </div>
                <div className="pt-3 space-y-1.5">
                  <label className="block text-[11px] font-medium text-t-secondary">
                    {t('applications.internalNoteLabel', { defaultValue: 'Internal note (optional)' })}
                  </label>
                  <textarea
                    value={internalNote}
                    onChange={(e) => setInternalNote(e.target.value.slice(0, 1000))}
                    rows={2}
                    maxLength={1000}
                    placeholder={t('applications.internalNotePlaceholder', { defaultValue: 'Notes for your mod team — never sent to the applicant…' })}
                    className="w-full rounded-lg px-3 py-2 text-sm border border-default outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 transition-all resize-none bg-app-surface text-t-primary"
                  />
                  <p className="text-[10px] text-t-tertiary">
                    {t('applications.internalNoteHelp', { defaultValue: 'Only visible to moderators in this view.' })}
                  </p>
                </div>
              </>
            )}
            {app.decisionNote && (
              <div className="pt-3 border-t border-default">
                <p className="text-[11px] font-semibold text-t-secondary mb-0.5">
                  {t('applications.applicantNoteHeader', { defaultValue: 'Message sent to the applicant' })}
                </p>
                <p className="text-sm text-t-primary whitespace-pre-wrap">{app.decisionNote}</p>
              </div>
            )}
            {app.internalNote && (
              <div className="pt-3 border-t border-default">
                <p className="text-[11px] font-semibold text-t-secondary mb-0.5">
                  {t('applications.internalNoteHeader', { defaultValue: 'Internal note (mods only)' })}
                </p>
                <p className="text-sm text-t-primary whitespace-pre-wrap">{app.internalNote}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
};

export default ApplicationsSection;
