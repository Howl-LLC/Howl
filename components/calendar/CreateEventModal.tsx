// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X, Trash2, Check, Bell, ChevronDown, AlertTriangle, Users, Search, User, Repeat, Headphones, AtSign, Lock, Info } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useIsMobile } from '../../hooks/useIsMobile';
import { apiClient } from '../../services/api';
import type { ServerEvent, Channel, EventReminderTiming, RecurrenceRule } from '../../types';
import { EVENT_COLORS, EVENT_REMINDER_TIMINGS } from '../../types';
import { LazyGif } from '../LazyGif';
import { getFrameUrl } from '../../utils/getFrameUrl';

const RECURRENCE_KEYS: Array<{ value: RecurrenceRule; key: string }> = [
  { value: 'NONE', key: 'calendar.recurrenceNone' },
  { value: 'DAILY', key: 'calendar.recurrenceDaily' },
  { value: 'WEEKLY', key: 'calendar.recurrenceWeekly' },
  { value: 'BIWEEKLY', key: 'calendar.recurrenceBiweekly' },
  { value: 'MONTHLY', key: 'calendar.recurrenceMonthly' },
  { value: 'CUSTOM', key: 'calendar.recurrenceCustom' },
];
const WEEKDAY_PILLS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// Constants

const REMINDER_LABEL_KEYS: Record<string, string> = {
  AT_START: 'calendar.reminderAtStart',
  '15_MIN': 'calendar.reminder15Min',
  '1_HOUR': 'calendar.reminder1Hour',
  '1_DAY': 'calendar.reminder1Day',
  '1_WEEK': 'calendar.reminder1Week',
};

const MAX_TITLE = 100;
const MAX_DESCRIPTION = 2000;
const MAX_DURATION_DAYS = 30;

// Helpers

/** Convert ISO string to datetime-local input value (YYYY-MM-DDTHH:mm) */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Convert datetime-local value to ISO string */
function fromLocalInput(val: string): string {
  return new Date(val).toISOString();
}

/** Get a default start time (next hour from now, or given date at 10:00) */
function defaultStart(date?: Date): string {
  const d = date ? new Date(date) : new Date();
  if (date) {
    d.setHours(10, 0, 0, 0);
  } else {
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
  }
  return toLocalInput(d.toISOString());
}

/** Get default end time (1 hour after start) */
function defaultEnd(startLocal: string): string {
  const d = new Date(startLocal);
  d.setHours(d.getHours() + 1);
  return toLocalInput(d.toISOString());
}

// Props

interface CreateEventModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: {
    title: string;
    description?: string;
    startTime: string;
    endTime: string;
    allDay?: boolean;
    color?: string;
    timezone?: string;
    reminderChannelId?: string;
    reminders?: EventReminderTiming[];
    invitees?: Array<{ scope: 'EVERYONE' | 'ROLE' | 'USER'; targetId?: string }>;
    recurrenceRule?: string;
    recurrenceDays?: number[];
    recurrenceEndDate?: string | null;
    voiceChannelId?: string | null;
    reminderMentions?: { everyone?: boolean; here?: boolean; roleIds?: string[] } | null;
  }) => Promise<void>;
  onDelete?: (eventId: string) => Promise<void>;
  textChannels: Channel[];
  voiceChannels?: Channel[];
  /** If provided, modal opens in edit mode */
  editEvent?: ServerEvent | null;
  /** Pre-fill date when opened from a day click */
  initialDate?: Date | null;
  /** Server ID for fetching roles and members */
  serverId?: string;
  canMentionEveryone?: boolean;
}

// Component

export const CreateEventModal: React.FC<CreateEventModalProps> = React.memo(function CreateEventModal({
  isOpen, onClose, onSubmit, onDelete, textChannels, voiceChannels = [], editEvent, initialDate, serverId, canMentionEveryone,
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, isOpen);

  const isEdit = !!editEvent;

  // Form state

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [color, setColor] = useState<string>(EVENT_COLORS[0]);
  const [reminderChannelId, setReminderChannelId] = useState<string>('');
  const [reminders, setReminders] = useState<Set<EventReminderTiming>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Synchronous double-fire guards. setSubmitting/setDeleting only flip the
  // disabled prop after a React render; a fast double-click (or space-bar
  // repeat) lands a second handler call before the re-render commits and the
  // closure-captured `canSubmit` is still true → two POSTs → two rows. Refs
  // mutate immediately so the second call short-circuits.
  const submittingRef = useRef(false);
  const deletingRef = useRef(false);
  const [channelDropdownOpen, setChannelDropdownOpen] = useState(false);
  const channelDropdownRef = useRef<HTMLDivElement>(null);

  // Invitation state
  type VisibilityMode = 'everyone' | 'roles' | 'people' | 'mixed';
  const [visibility, setVisibility] = useState<VisibilityMode>('everyone');
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set());
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [serverRoles, setServerRoles] = useState<Array<{ id: string; name: string; color: string | null; memberCount?: number }>>([]);
  const [serverMembers, setServerMembers] = useState<Array<{ id: string; username: string; discriminator?: string; avatar?: string | null }>>([]);
  const [memberSearchInput, setMemberSearchInput] = useState('');
  const [debouncedMemberSearch, setDebouncedMemberSearch] = useState('');

  // Recurrence state
  const [recurrenceRule, setRecurrenceRule] = useState<RecurrenceRule>('NONE');
  const [recurrenceDays, setRecurrenceDays] = useState<Set<number>>(new Set());
  const [recurrenceEndDate, setRecurrenceEndDate] = useState<string>('');

  // Voice channel state
  const [voiceChannelId, setVoiceChannelId] = useState<string>('');
  const [voiceDropdownOpen, setVoiceDropdownOpen] = useState(false);
  const voiceDropdownRef = useRef<HTMLDivElement>(null);

  // Mention state
  const [mentionEveryone, setMentionEveryone] = useState(false);
  const [mentionHere, setMentionHere] = useState(false);
  const [mentionRoleIds, setMentionRoleIds] = useState<Set<string>>(new Set());
  const [mentionRoleDropdownOpen, setMentionRoleDropdownOpen] = useState(false);
  const mentionRoleDropdownRef = useRef<HTMLDivElement>(null);

  // Populate form when modal opens / event changes
  useEffect(() => {
    if (!isOpen) return;
    if (editEvent) {
      setTitle(editEvent.title);
      setDescription(editEvent.description ?? '');
      setStartTime(toLocalInput(editEvent.startTime));
      setEndTime(toLocalInput(editEvent.endTime));
      setAllDay(editEvent.allDay);
      setColor(editEvent.color);
      setReminderChannelId(editEvent.reminderChannelId ?? '');
      setReminders(new Set(editEvent.reminders.map((r) => r.timing)));
      // Populate recurrence
      setRecurrenceRule(editEvent.recurrenceRule ?? 'NONE');
      setRecurrenceDays(new Set(editEvent.recurrenceDays ?? []));
      setRecurrenceEndDate(editEvent.recurrenceEndDate ? editEvent.recurrenceEndDate.split('T')[0] : '');
      setVoiceChannelId(editEvent.voiceChannelId ?? '');
      // Populate reminderMentions
      if (editEvent.reminderMentions) {
        const m = editEvent.reminderMentions as { everyone?: boolean; here?: boolean; roleIds?: string[] };
        setMentionEveryone(!!m.everyone);
        setMentionHere(!!m.here);
        setMentionRoleIds(new Set(m.roleIds ?? []));
      } else {
        setMentionEveryone(false);
        setMentionHere(false);
        setMentionRoleIds(new Set());
      }
      // Populate invitees
      const invitees = editEvent.invitees ?? [];
      if (invitees.length === 0) {
        setVisibility('everyone');
        setSelectedRoles(new Set());
        setSelectedUsers(new Set());
      } else {
        const roleIds = new Set(invitees.filter((i) => i.scope === 'ROLE').map((i) => i.targetId!));
        const userIds = new Set(invitees.filter((i) => i.scope === 'USER').map((i) => i.targetId!));
        if (roleIds.size > 0 && userIds.size > 0) setVisibility('mixed');
        else if (roleIds.size > 0) setVisibility('roles');
        else if (userIds.size > 0) setVisibility('people');
        else setVisibility('everyone');
        setSelectedRoles(roleIds);
        setSelectedUsers(userIds);
      }
    } else {
      setTitle('');
      setDescription('');
      const start = defaultStart(initialDate ?? undefined);
      setStartTime(start);
      setEndTime(defaultEnd(start));
      setAllDay(false);
      setColor(EVENT_COLORS[0]);
      setReminderChannelId('');
      setReminders(new Set());
      setVisibility('everyone');
      setSelectedRoles(new Set());
      setSelectedUsers(new Set());
      setRecurrenceRule('NONE');
      setRecurrenceDays(new Set());
      setRecurrenceEndDate('');
      setVoiceChannelId('');
      setMentionEveryone(false);
      setMentionHere(false);
      setMentionRoleIds(new Set());
    }
    setError(null);
    setShowDeleteConfirm(false);
    setSubmitting(false);
    setDeleting(false);
    submittingRef.current = false;
    deletingRef.current = false;
    setMemberSearchInput('');
    setDebouncedMemberSearch('');
    setMentionRoleDropdownOpen(false);
  }, [isOpen, editEvent, initialDate]);

  // Fetch server roles and members when modal opens (cap at 500)
  useEffect(() => {
    if (!isOpen || !serverId) return;
    apiClient.getServerRoles(serverId).then(setServerRoles).catch(() => {});
    apiClient.getServerMembers(serverId).then((members) => {
      setServerMembers(members.slice(0, 500).map((m: any) => ({
        id: m.id, username: m.username, discriminator: m.discriminator, avatar: m.avatar,
      })));
    }).catch(() => {});
  }, [isOpen, serverId]);

  // Debounce member search (250ms)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedMemberSearch(memberSearchInput), 250);
    return () => clearTimeout(timer);
  }, [memberSearchInput]);

  // Close channel dropdown on outside click
  useEffect(() => {
    if (!channelDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (channelDropdownRef.current && !channelDropdownRef.current.contains(e.target as Node)) {
        setChannelDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [channelDropdownOpen]);

  // Close voice dropdown on outside click
  useEffect(() => {
    if (!voiceDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (voiceDropdownRef.current && !voiceDropdownRef.current.contains(e.target as Node)) {
        setVoiceDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [voiceDropdownOpen]);

  // Close mention role dropdown on outside click
  useEffect(() => {
    if (!mentionRoleDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (mentionRoleDropdownRef.current && !mentionRoleDropdownRef.current.contains(e.target as Node)) {
        setMentionRoleDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [mentionRoleDropdownOpen]);

  // Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showDeleteConfirm) setShowDeleteConfirm(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose, showDeleteConfirm]);

  // Validation

  const validation = useMemo(() => {
    const errors: string[] = [];
    if (!title.trim()) errors.push(t('calendar.validationTitleRequired'));
    if (title.length > MAX_TITLE) errors.push(t('calendar.validationTitleMax', { max: MAX_TITLE }));
    if (description.length > MAX_DESCRIPTION) errors.push(t('calendar.validationDescMax', { max: MAX_DESCRIPTION }));
    if (!startTime) errors.push(t('calendar.validationStartRequired'));
    if (!endTime) errors.push(t('calendar.validationEndRequired'));
    if (startTime && endTime) {
      const s = new Date(startTime);
      const e = new Date(endTime);
      if (e <= s) errors.push(t('calendar.validationEndAfterStart'));
      if (e.getTime() - s.getTime() > MAX_DURATION_DAYS * 24 * 60 * 60 * 1000) {
        errors.push(t('calendar.validationMaxDuration', { days: MAX_DURATION_DAYS }));
      }
    }
    return errors;
  }, [title, description, startTime, endTime, t]);

  const canSubmit = validation.length === 0 && !submitting;

  // Handlers

  const toggleReminder = useCallback((timing: EventReminderTiming) => {
    setReminders((prev) => {
      const next = new Set(prev);
      if (next.has(timing)) next.delete(timing);
      else next.add(timing);
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (submittingRef.current || !canSubmit) return;
    submittingRef.current = true;
    setError(null);
    setSubmitting(true);
    try {
      // Build invitees array
      const invitees: Array<{ scope: 'EVERYONE' | 'ROLE' | 'USER'; targetId?: string }> = [];
      if (visibility !== 'everyone') {
        for (const roleId of selectedRoles) {
          invitees.push({ scope: 'ROLE', targetId: roleId });
        }
        for (const userId of selectedUsers) {
          invitees.push({ scope: 'USER', targetId: userId });
        }
      }

      // Build reminderMentions
      const hasMentions = mentionEveryone || mentionHere || mentionRoleIds.size > 0;
      const reminderMentions = hasMentions ? {
        everyone: mentionEveryone || undefined,
        here: mentionHere || undefined,
        roleIds: mentionRoleIds.size > 0 ? [...mentionRoleIds] : undefined,
      } : null;

      await onSubmit({
        title: title.trim(),
        description: description.trim() || undefined,
        startTime: fromLocalInput(startTime),
        endTime: fromLocalInput(endTime),
        allDay,
        color,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        reminderChannelId: reminderChannelId || undefined,
        reminders: reminders.size > 0 ? [...reminders] : undefined,
        invitees: invitees.length > 0 ? invitees : undefined,
        recurrenceRule: recurrenceRule !== 'NONE' ? recurrenceRule : undefined,
        recurrenceDays: recurrenceRule === 'CUSTOM' && recurrenceDays.size > 0 ? [...recurrenceDays] : undefined,
        recurrenceEndDate: recurrenceEndDate ? new Date(recurrenceEndDate).toISOString() : null,
        voiceChannelId: voiceChannelId || null,
        reminderMentions,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('calendar.failedToSaveEvent'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [canSubmit, title, description, startTime, endTime, allDay, color, reminderChannelId, reminders, visibility, selectedRoles, selectedUsers, recurrenceRule, recurrenceDays, recurrenceEndDate, voiceChannelId, mentionEveryone, mentionHere, mentionRoleIds, onSubmit, onClose, t]);

  const handleDelete = useCallback(async () => {
    if (deletingRef.current || !editEvent || !onDelete) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      await onDelete(editEvent.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('calendar.failedToDeleteEvent'));
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }, [editEvent, onDelete, onClose, t]);

  const selectedChannelName = useMemo(() => {
    if (!reminderChannelId) return t('calendar.firstTextChannelDefault');
    return textChannels.find((c) => c.id === reminderChannelId)?.name ?? 'Unknown';
  }, [reminderChannelId, textChannels, t]);

  // Render

  if (!isOpen) return null;

  const inputClass = 'w-full bg-[var(--bg-input)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-sm outline-none focus:border-[var(--cyan-accent)]/50 transition-colors';

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose} />

      {/* Modal */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? t('calendar.editEvent') : t('calendar.createEvent')}
        className="w-full max-h-[90vh] overflow-y-auto rounded-2xl border shadow-2xl relative spring-pop-in"
        style={{
          maxWidth: isMobile ? '100%' : 480,
          backgroundColor: 'var(--bg-panel)',
          borderColor: 'var(--border-subtle)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 pb-3">
          <h2 className="text-base font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>
            {isEdit ? t('calendar.editEvent') : t('calendar.createEvent')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 hover:bg-fill-active transition-colors rounded-lg"
            style={{ color: 'var(--text-secondary)' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <div className="px-5 pb-5 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              {t('calendar.title')}
            </label>
            <input
              autoFocus
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('calendar.eventNamePlaceholder')}
              maxLength={MAX_TITLE}
              className={inputClass}
              style={{ color: 'var(--text-primary)' }}
            />
            {title.length > 80 && (
              <span className="text-[10px] mt-0.5 block text-right" style={{ color: title.length > MAX_TITLE ? 'var(--danger)' : 'var(--text-tertiary)' }}>
                {title.length}/{MAX_TITLE}
              </span>
            )}
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              {t('calendar.description')}
              <span className="font-normal ml-1" style={{ color: 'var(--text-tertiary)' }}>({t('common.optional')})</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('calendar.eventDescPlaceholder')}
              rows={2}
              maxLength={MAX_DESCRIPTION}
              className={`${inputClass} resize-none`}
              style={{ color: 'var(--text-primary)' }}
            />
          </div>

          {/* All Day toggle */}
          <button
            type="button"
            role="switch"
            aria-checked={allDay}
            onClick={() => {
              const next = !allDay;
              setAllDay(next);
              // Snap times so the stored start/end actually represent a full
              // day. Without this, the row keeps the old hh:mm and the chip
              // says "All day" while still firing reminders mid-afternoon.
              if (next) {
                const startDay = startTime ? startTime.split('T')[0] : toLocalInput(new Date().toISOString()).split('T')[0];
                const endDay = endTime ? endTime.split('T')[0] : startDay;
                setStartTime(`${startDay}T00:00`);
                setEndTime(`${endDay}T23:59`);
              } else {
                const baseDay = startTime ? startTime.split('T')[0] : toLocalInput(new Date().toISOString()).split('T')[0];
                const newStart = `${baseDay}T10:00`;
                setStartTime(newStart);
                setEndTime(defaultEnd(newStart));
              }
            }}
            className="flex items-center gap-3 cursor-pointer py-1 outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/50 rounded-md -ml-1 pl-1"
            style={{ minHeight: 44, background: 'transparent', border: 'none' }}
          >
            <span
              className="relative shrink-0 rounded-full transition-colors block"
              style={{
                width: 36,
                height: 20,
                backgroundColor: allDay ? 'var(--cyan-accent)' : 'var(--fill-active)',
              }}
            >
              <span
                className="absolute top-0.5 rounded-full bg-white transition-transform block"
                style={{
                  width: 16,
                  height: 16,
                  transform: allDay ? 'translateX(18px)' : 'translateX(2px)',
                }}
              />
            </span>
            <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{t('calendar.allDay')}</span>
          </button>

          {/* Date/Time — single Start input. The event's end time is auto-
              derived (start + 1h for timed events, same-day 23:59 for all-day)
              so users aren't confused by two "End" fields in the same form
              (event-end up here vs. recurrence-end down in the Repeat
              section). Submit logic still sends startTime + endTime to the
              backend; we just don't surface end as a manual input. */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              {allDay ? t('calendar.startDate') : t('calendar.start')}
            </label>
            <input
              type={allDay ? 'date' : 'datetime-local'}
              value={allDay ? startTime.split('T')[0] : startTime}
              onChange={(e) => {
                const val = allDay ? `${e.target.value}T00:00` : e.target.value;
                if (!val) { setStartTime(val); return; }
                setStartTime(val);
                // Keep endTime in lockstep with start. For all-day, snap end
                // to the same day's 23:59. For timed events, preserve the
                // current duration when one is set (so editing a 3-hour
                // event doesn't silently shrink it to 1h on every start
                // tweak); otherwise default to start + 1h.
                if (allDay) {
                  setEndTime(`${val.split('T')[0]}T23:59`);
                } else if (startTime && endTime) {
                  const delta = new Date(endTime).getTime() - new Date(startTime).getTime();
                  const newEnd = new Date(new Date(val).getTime() + delta);
                  const pad = (n: number) => String(n).padStart(2, '0');
                  setEndTime(
                    `${newEnd.getFullYear()}-${pad(newEnd.getMonth() + 1)}-${pad(newEnd.getDate())}T${pad(newEnd.getHours())}:${pad(newEnd.getMinutes())}`,
                  );
                } else {
                  setEndTime(defaultEnd(val));
                }
              }}
              className={inputClass}
              style={{ color: 'var(--text-primary)', colorScheme: 'dark' }}
            />
          </div>

          {/* Color */}
          <div>
            <label className="block text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              {t('calendar.color')}
            </label>
            <div className="flex gap-2 flex-wrap">
              {EVENT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className="rounded-full flex items-center justify-center transition-transform hover:scale-110"
                  style={{
                    width: 28,
                    height: 28,
                    minHeight: 28,
                    backgroundColor: c,
                    boxShadow: color === c ? `0 0 0 2px var(--bg-panel), 0 0 0 3.5px ${c}` : 'none',
                  }}
                  title={c}
                >
                  {color === c && <Check size={14} color="#fff" strokeWidth={3} />}
                </button>
              ))}
            </div>
          </div>

          {/* Recurrence */}
          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              <Repeat size={12} />
              {t('calendar.repeat')}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {RECURRENCE_KEYS.map(({ value, key: tKey }) => {
                const active = recurrenceRule === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setRecurrenceRule(value)}
                    className="rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
                    style={{
                      minHeight: 32,
                      backgroundColor: active ? 'var(--cta-bg, #02385A)' : 'var(--fill-hover)',
                      color: active ? '#fff' : 'var(--text-secondary)',
                      border: `1px solid ${active ? 'var(--accent-emphasis)' : 'var(--border-subtle)'}`,
                    }}
                  >
                    {t(tKey)}
                  </button>
                );
              })}
            </div>

            {/* Custom day-of-week pills */}
            {recurrenceRule === 'CUSTOM' && (
              <div className="flex gap-1.5 mt-2">
                {WEEKDAY_PILLS.map((label, i) => {
                  const active = recurrenceDays.has(i);
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setRecurrenceDays((prev) => {
                        const next = new Set(prev);
                        if (active) next.delete(i); else next.add(i);
                        return next;
                      })}
                      className="rounded-full flex items-center justify-center text-[11px] font-semibold transition-colors"
                      style={{
                        width: 32,
                        height: 32,
                        minHeight: 32,
                        backgroundColor: active ? 'var(--cta-bg, #02385A)' : 'var(--fill-hover)',
                        color: active ? '#fff' : 'var(--text-secondary)',
                        border: `1px solid ${active ? 'var(--accent-glow)' : 'var(--border-subtle)'}`,
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Recurrence end date */}
            {recurrenceRule !== 'NONE' && (
              <div className="mt-2">
                <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>
                  {t('calendar.recurrenceEnds')}
                </label>
                {/* Two-state binary so "no end date" is a visible chosen state,
                    not a disabled-button + empty-input shape that reads as
                    "you have to fill this in". */}
                <div className="flex items-center gap-1.5 mb-2">
                  <button
                    type="button"
                    onClick={() => setRecurrenceEndDate('')}
                    aria-pressed={!recurrenceEndDate}
                    className="rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
                    style={{
                      minHeight: 32,
                      backgroundColor: !recurrenceEndDate ? 'var(--cta-bg, #02385A)' : 'var(--fill-hover)',
                      color: !recurrenceEndDate ? '#fff' : 'var(--text-secondary)',
                      border: `1px solid ${!recurrenceEndDate ? 'var(--accent-emphasis)' : 'var(--border-subtle)'}`,
                    }}
                  >
                    {t('calendar.never')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!recurrenceEndDate) {
                        // Default to ~1 month past the start date so the date
                        // input has something useful instead of opening empty.
                        const base = startTime ? new Date(startTime) : new Date();
                        base.setMonth(base.getMonth() + 1);
                        const pad = (n: number) => String(n).padStart(2, '0');
                        setRecurrenceEndDate(`${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`);
                      }
                    }}
                    aria-pressed={!!recurrenceEndDate}
                    className="rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
                    style={{
                      minHeight: 32,
                      backgroundColor: recurrenceEndDate ? 'var(--cta-bg, #02385A)' : 'var(--fill-hover)',
                      color: recurrenceEndDate ? '#fff' : 'var(--text-secondary)',
                      border: `1px solid ${recurrenceEndDate ? 'var(--accent-emphasis)' : 'var(--border-subtle)'}`,
                    }}
                  >
                    {t('calendar.recurrenceEndsOn', 'On a date')}
                  </button>
                </div>
                {recurrenceEndDate && (
                  <input
                    type="date"
                    value={recurrenceEndDate}
                    onChange={(e) => setRecurrenceEndDate(e.target.value)}
                    className={`${inputClass} !py-2 w-full`}
                    style={{ color: 'var(--text-primary)', colorScheme: 'dark' }}
                  />
                )}
                {!recurrenceEndDate && (
                  <span className="text-[10px] mt-0.5 block" style={{ color: 'var(--text-tertiary)' }}>{t('calendar.recurrenceNoEnd')}</span>
                )}
              </div>
            )}
          </div>

          {/* Voice Channel */}
          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              <Headphones size={12} />
              {t('calendar.voiceChannel')}
              <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}>({t('calendar.voiceChannelOptional')})</span>
            </label>
            <div ref={voiceDropdownRef} className="relative">
              <button
                type="button"
                onClick={() => setVoiceDropdownOpen((o) => !o)}
                className="w-full bg-[var(--bg-input)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-sm text-left flex items-center justify-between hover:border-[var(--border-strong)] transition-colors"
                style={{ color: 'var(--text-primary)', minHeight: 44 }}
              >
                <span className="truncate">
                  {voiceChannelId
                    ? `🔊 ${voiceChannels.find((c) => c.id === voiceChannelId)?.name ?? 'Selected'}`
                    : t('calendar.voiceNone')}
                </span>
                <ChevronDown size={14} className={`shrink-0 transition-transform ${voiceDropdownOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--text-tertiary)' }} />
              </button>
              {voiceDropdownOpen && (
                <div
                  className="absolute left-0 right-0 top-full mt-1 z-50 rounded-xl border py-1 max-h-48 overflow-y-auto"
                  style={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--glass-border)',
                    boxShadow: 'var(--shadow-lg)',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => { setVoiceChannelId(''); setVoiceDropdownOpen(false); }}
                    className={`w-full text-left px-4 py-2 text-sm transition-colors ${!voiceChannelId ? 'bg-[var(--cyan-accent)]/15 text-[var(--cyan-accent)]' : 'hover:bg-fill-hover'}`}
                    style={{ color: !voiceChannelId ? undefined : 'var(--text-secondary)' }}
                  >
                    {t('calendar.voiceNone')}
                  </button>
                  {voiceChannels.map((ch) => (
                    <button
                      key={ch.id}
                      type="button"
                      onClick={() => { setVoiceChannelId(ch.id); setVoiceDropdownOpen(false); }}
                      className={`w-full text-left px-4 py-2 text-sm transition-colors ${voiceChannelId === ch.id ? 'bg-[var(--cyan-accent)]/15 text-[var(--cyan-accent)]' : 'hover:bg-fill-hover'}`}
                      style={{ color: voiceChannelId === ch.id ? undefined : 'var(--text-secondary)' }}
                    >
                      🔊 {ch.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Reminders */}
          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              <Bell size={12} />
              {t('calendar.reminders')}
              <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}>({t('calendar.max5')})</span>
            </label>
            <div className="flex flex-wrap gap-1.5">
              {EVENT_REMINDER_TIMINGS.map((timing) => {
                const active = reminders.has(timing);
                return (
                  <button
                    key={timing}
                    type="button"
                    onClick={() => toggleReminder(timing)}
                    className="rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
                    style={{
                      minHeight: 32,
                      backgroundColor: active ? 'var(--cta-bg, #02385A)' : 'var(--fill-hover)',
                      color: active ? '#fff' : 'var(--text-secondary)',
                      border: `1px solid ${active ? 'var(--accent-emphasis)' : 'var(--border-subtle)'}`,
                    }}
                  >
                    {t(REMINDER_LABEL_KEYS[timing])}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Mention with reminder */}
          <div>
            <label className="flex items-center gap-1.5 text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>
              <AtSign size={14} />
              {t('calendar.mentionWithReminder', 'Mention with reminder (optional)')}
            </label>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button type="button" disabled={!canMentionEveryone}
                onClick={() => canMentionEveryone && setMentionEveryone(v => !v)}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors ${!canMentionEveryone ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'}`}
                style={{
                  backgroundColor: mentionEveryone ? 'var(--cta-bg, #02385A)' : 'var(--fill-hover)',
                  color: mentionEveryone ? '#fff' : 'var(--text-secondary)',
                  borderColor: mentionEveryone ? 'color-mix(in srgb, var(--cyan-accent) 20%, transparent)' : 'var(--glass-border)',
                }}>
                {!canMentionEveryone && <Lock size={10} />}
                @everyone
              </button>
              <button type="button" disabled={!canMentionEveryone}
                onClick={() => canMentionEveryone && setMentionHere(v => !v)}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors ${!canMentionEveryone ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'}`}
                style={{
                  backgroundColor: mentionHere ? 'var(--cta-bg, #02385A)' : 'var(--fill-hover)',
                  color: mentionHere ? '#fff' : 'var(--text-secondary)',
                  borderColor: mentionHere ? 'color-mix(in srgb, var(--cyan-accent) 20%, transparent)' : 'var(--glass-border)',
                }}>
                {!canMentionEveryone && <Lock size={10} />}
                @here
              </button>
              <div className="relative" ref={mentionRoleDropdownRef}>
                <button type="button" onClick={() => setMentionRoleDropdownOpen(v => !v)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium border transition-colors cursor-pointer"
                  style={{ borderColor: 'var(--glass-border)', backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' }}>
                  {mentionRoleIds.size > 0 ? (
                    <>
                      {(() => {
                        const firstRole = serverRoles.find(r => mentionRoleIds.has(r.id));
                        return firstRole ? (
                          <span className="flex items-center gap-1 px-1.5 rounded-lg text-[9px] font-semibold" style={{ backgroundColor: `${firstRole.color ?? '#6b7280'}20`, color: firstRole.color ?? '#6b7280' }}>
                            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: firstRole.color ?? '#6b7280' }} />
                            {firstRole.name}
                          </span>
                        ) : null;
                      })()}
                      {mentionRoleIds.size > 1 && <span className="text-[10px]" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>+{mentionRoleIds.size - 1}</span>}
                    </>
                  ) : (
                    <span>{t('calendar.roles', 'Roles')}</span>
                  )}
                  <ChevronDown size={10} />
                </button>
                {mentionRoleDropdownOpen && (
                  <div className="absolute top-full mt-1 left-0 min-w-[180px] z-50 rounded-xl p-1 border shadow-xl"
                    style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--glass-border)', backdropFilter: 'blur(16px)' }}>
                    {serverRoles.filter(r => r.name !== '@everyone').map(role => (
                      <button key={role.id} type="button"
                        onClick={() => setMentionRoleIds(prev => {
                          const next = new Set(prev);
                          next.has(role.id) ? next.delete(role.id) : next.add(role.id);
                          return next;
                        })}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors hover:bg-fill-hover"
                        style={{ backgroundColor: mentionRoleIds.has(role.id) ? `${role.color ?? '#6b7280'}12` : 'transparent' }}>
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: role.color ?? '#6b7280' }} />
                        <span className="flex-1 text-[11px] font-medium" style={{ color: mentionRoleIds.has(role.id) ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{role.name}</span>
                        {mentionRoleIds.has(role.id) && <Check size={12} style={{ color: 'var(--cyan-accent)' }} />}
                      </button>
                    ))}
                    {serverRoles.filter(r => r.name !== '@everyone').length === 0 && (
                      <p className="text-[10px] px-2 py-2" style={{ color: 'var(--text-secondary)' }}>{t('calendar.noRoles', 'No roles available')}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
            {!canMentionEveryone && (
              <div className="flex items-center gap-1 mt-1.5 text-[9px]" style={{ color: 'var(--text-secondary)', opacity: 0.4 }}>
                <Info size={10} />
                {t('calendar.mentionPermissionHint', 'You need the Mention Everyone permission to use @everyone and @here')}
              </div>
            )}
          </div>

          {/* Reminder Channel */}
          {reminders.size > 0 && (
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                {t('calendar.reminderChannel')}
              </label>
              <div ref={channelDropdownRef} className="relative">
                <button
                  type="button"
                  onClick={() => setChannelDropdownOpen((o) => !o)}
                  className="w-full bg-[var(--bg-input)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-sm text-left flex items-center justify-between hover:border-[var(--border-strong)] transition-colors"
                  style={{ color: 'var(--text-primary)', minHeight: 44 }}
                >
                  <span className="truncate">
                    {reminderChannelId ? `# ${selectedChannelName}` : selectedChannelName}
                  </span>
                  <ChevronDown size={14} className={`shrink-0 transition-transform ${channelDropdownOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--text-tertiary)' }} />
                </button>
                {channelDropdownOpen && (
                  <div
                    className="absolute left-0 right-0 top-full mt-1 z-50 rounded-xl border py-1 max-h-48 overflow-y-auto"
                    style={{
                      backgroundColor: 'var(--bg-panel)',
                      borderColor: 'var(--glass-border)',
                      boxShadow: 'var(--shadow-lg)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => { setReminderChannelId(''); setChannelDropdownOpen(false); }}
                      className={`w-full text-left px-4 py-2 text-sm transition-colors ${!reminderChannelId ? 'bg-[var(--cyan-accent)]/15 text-[var(--cyan-accent)]' : 'hover:bg-fill-hover'}`}
                      style={{ color: !reminderChannelId ? undefined : 'var(--text-secondary)' }}
                    >
                      {t('calendar.firstTextChannelDefault')}
                    </button>
                    {textChannels.map((ch) => (
                      <button
                        key={ch.id}
                        type="button"
                        onClick={() => { setReminderChannelId(ch.id); setChannelDropdownOpen(false); }}
                        className={`w-full text-left px-4 py-2 text-sm transition-colors ${reminderChannelId === ch.id ? 'bg-[var(--cyan-accent)]/15 text-[var(--cyan-accent)]' : 'hover:bg-fill-hover'}`}
                        style={{ color: reminderChannelId === ch.id ? undefined : 'var(--text-secondary)' }}
                      >
                        # {ch.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Invitations */}
          {serverId && (
            <div>
              <label className="flex items-center gap-1.5 text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                <Users size={12} />
                {t('calendar.invite')}
              </label>
              {/* Visibility mode selector */}
              <div className="flex flex-wrap gap-1.5 mb-2">
                {([
                  ['everyone', t('calendar.inviteEveryone')],
                  ['roles', t('calendar.inviteRoles')],
                  ['people', t('calendar.invitePeople')],
                  ['mixed', t('calendar.inviteMixed')],
                ] as [VisibilityMode, string][]).map(([mode, label]) => {
                  const active = visibility === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        setVisibility(mode);
                        if (mode === 'everyone') { setSelectedRoles(new Set()); setSelectedUsers(new Set()); }
                        if (mode === 'roles') setSelectedUsers(new Set());
                        if (mode === 'people') setSelectedRoles(new Set());
                      }}
                      className="rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
                      style={{
                        minHeight: 32,
                        backgroundColor: active ? 'var(--cta-bg, #02385A)' : 'var(--fill-hover)',
                        color: active ? '#fff' : 'var(--text-secondary)',
                        border: `1px solid ${active ? 'var(--accent-emphasis)' : 'var(--border-subtle)'}`,
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              {/* Role picker */}
              {(visibility === 'roles' || visibility === 'mixed') && serverRoles.length > 0 && (
                <div className="mb-2">
                  <div className="flex flex-wrap gap-1.5 mb-1.5">
                    {selectedRoles.size > 0 && Array.from(selectedRoles).map((roleId) => {
                      const role = serverRoles.find((r) => r.id === roleId);
                      if (!role) return null;
                      return (
                        <span
                          key={roleId}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium"
                          style={{ backgroundColor: 'var(--fill-hover)', color: role.color || 'var(--text-secondary)' }}
                        >
                          <span className="rounded-full shrink-0" style={{ width: 6, height: 6, backgroundColor: role.color || 'var(--text-tertiary)' }} />
                          {role.name}
                          <button type="button" onClick={() => setSelectedRoles((prev) => { const next = new Set(prev); next.delete(roleId); return next; })} className="ml-0.5 hover:text-white">
                            <X size={10} />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                  <div
                    className="max-h-32 overflow-y-auto rounded-lg border" role="listbox" aria-label="Server roles" aria-multiselectable="true" tabIndex={0}
                    style={{ borderColor: 'var(--border-subtle)' }}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        const items = e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]');
                        const focused = e.currentTarget.querySelector<HTMLElement>(':focus');
                        const idx = focused ? Array.from(items).indexOf(focused) : -1;
                        const next = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
                        items[next]?.focus();
                      }
                    }}
                  >
                    {serverRoles.map((role) => {
                      const isSelected = selectedRoles.has(role.id);
                      return (
                        <button
                          key={role.id}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          onClick={() => {
                            if (selectedRoles.size + selectedUsers.size >= 50 && !isSelected) return;
                            setSelectedRoles((prev) => {
                              const next = new Set(prev);
                              if (isSelected) next.delete(role.id); else next.add(role.id);
                              return next;
                            });
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-fill-hover transition-colors"
                          style={{ color: isSelected ? '#fff' : 'var(--text-secondary)', backgroundColor: isSelected ? 'var(--cta-bg, #02385A)' : undefined, minHeight: 36 }}
                        >
                          <span className="rounded-full shrink-0" style={{ width: 8, height: 8, backgroundColor: role.color || 'var(--text-tertiary)' }} />
                          <span className="flex-1 truncate">{role.name}</span>
                          {isSelected && <Check size={12} />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* User picker */}
              {(visibility === 'people' || visibility === 'mixed') && (
                <div className="mb-2">
                  <div className="flex flex-wrap gap-1.5 mb-1.5">
                    {selectedUsers.size > 0 && Array.from(selectedUsers).map((userId) => {
                      const mem = serverMembers.find((m) => m.id === userId);
                      if (!mem) return null;
                      return (
                        <span
                          key={userId}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium"
                          style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' }}
                        >
                          {mem.avatar ? (
                            <LazyGif src={mem.avatar} frameSrc={getFrameUrl(mem.avatar)} alt="" className="w-3.5 h-3.5 rounded-[var(--radius-lg)]" />
                          ) : (
                            <User size={10} />
                          )}
                          {mem.username}
                          <button type="button" onClick={() => setSelectedUsers((prev) => { const next = new Set(prev); next.delete(userId); return next; })} className="ml-0.5 hover:text-white">
                            <X size={10} />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                  <div className="relative mb-1">
                    <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} />
                    <input
                      type="text"
                      value={memberSearchInput}
                      onChange={(e) => setMemberSearchInput(e.target.value)}
                      placeholder={t('calendar.searchMembers')}
                      aria-label={t('calendar.searchMembers')}
                      className="w-full bg-[var(--bg-input)] border border-[var(--glass-border)] rounded-lg pl-8 pr-3 py-2 text-xs outline-none focus:border-[var(--cyan-accent)]/50 transition-colors"
                      style={{ color: 'var(--text-primary)' }}
                    />
                  </div>
                  <div
                    className="max-h-32 overflow-y-auto rounded-lg border" role="listbox" aria-label="Server members" aria-multiselectable="true" tabIndex={0}
                    style={{ borderColor: 'var(--border-subtle)' }}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        const items = e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]');
                        const focused = e.currentTarget.querySelector<HTMLElement>(':focus');
                        const idx = focused ? Array.from(items).indexOf(focused) : -1;
                        const next = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
                        items[next]?.focus();
                      }
                    }}
                  >
                    {serverMembers
                      .filter((m) => !debouncedMemberSearch || m.username.toLowerCase().includes(debouncedMemberSearch.toLowerCase()))
                      .slice(0, 50)
                      .map((mem) => {
                        const isSelected = selectedUsers.has(mem.id);
                        const atLimit = selectedRoles.size + selectedUsers.size >= 50 || selectedUsers.size >= 20;
                        return (
                          <button
                            key={mem.id}
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            disabled={atLimit && !isSelected}
                            onClick={() => {
                              setSelectedUsers((prev) => {
                                const next = new Set(prev);
                                if (isSelected) next.delete(mem.id); else next.add(mem.id);
                                return next;
                              });
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-fill-hover transition-colors disabled:opacity-40"
                            style={{ color: isSelected ? '#fff' : 'var(--text-secondary)', backgroundColor: isSelected ? 'var(--cta-bg, #02385A)' : undefined, minHeight: 36 }}
                          >
                            {mem.avatar ? (
                              <LazyGif src={mem.avatar} frameSrc={getFrameUrl(mem.avatar)} alt="" className="w-5 h-5 rounded-[var(--radius-lg)] shrink-0" />
                            ) : (
                              <div className="w-5 h-5 rounded-full bg-fill-active flex items-center justify-center shrink-0">
                                <span className="text-[9px] font-semibold">{mem.username.charAt(0).toUpperCase()}</span>
                              </div>
                            )}
                            <span className="flex-1 truncate">{mem.username}</span>
                            {isSelected && <Check size={12} />}
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Count indicator */}
              {visibility !== 'everyone' && (selectedRoles.size > 0 || selectedUsers.size > 0) && (
                <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                  {selectedRoles.size > 0 && `${selectedRoles.size} role${selectedRoles.size !== 1 ? 's' : ''}`}
                  {selectedRoles.size > 0 && selectedUsers.size > 0 && ', '}
                  {selectedUsers.size > 0 && `${selectedUsers.size} user${selectedUsers.size !== 1 ? 's' : ''}`}
                  {' '}invited · {50 - selectedRoles.size - selectedUsers.size} remaining
                </p>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
              style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#f87171' }}
            >
              <AlertTriangle size={13} />
              {error}
            </div>
          )}

          {/* Validation hints */}
          {validation.length > 0 && title.length > 0 && (
            <div className="text-[11px] space-y-0.5" style={{ color: '#f87171' }}>
              {validation.map((v, i) => <p key={i}>{v}</p>)}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between pt-2">
            {/* Delete button (edit mode only) */}
            <div>
              {isEdit && onDelete && !showDeleteConfirm && (
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium hover:bg-red-500/10 transition-colors"
                  style={{ color: '#f87171', minHeight: 44 }}
                >
                  <Trash2 size={13} />
                  {t('common.delete')}
                </button>
              )}
              {showDeleteConfirm && (
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: '#f87171' }}>{t('common.deleteConfirm')}</span>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleting}
                    className="btn-cta-danger px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors disabled:opacity-50"
                  >
                    {deleting ? t('common.deleting') : t('common.yes')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(false)}
                    className="px-3 py-1.5 rounded-lg text-xs hover:bg-fill-active transition-colors"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {t('common.no')}
                  </button>
                </div>
              )}
            </div>

            {/* Submit / Cancel */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-fill-active transition-colors"
                style={{ color: 'var(--text-secondary)', minHeight: 44 }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={handleSubmit}
                className="btn-cta px-5 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ minHeight: 44 }}
              >
                {submitting ? t('common.saving') : isEdit ? t('calendar.saveChanges') : t('calendar.createEvent')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
});
