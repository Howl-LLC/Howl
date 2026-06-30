// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useMemo, useCallback } from 'react';
import { ChevronLeft, Clock, Bell, Pencil, Trash2, Calendar, User, Repeat, Headphones } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '../../hooks/useIsMobile';
import { formatRecurrenceLabel } from '../../utils/calendarUtils';
import type { ServerEvent } from '../../types';

// Constants

const RSVP_OPTIONS = [
  { status: 'GOING' as const, label: 'Going', color: 'var(--success)', bg: 'var(--success-subtle)', border: 'var(--success-muted)' },
  { status: 'INTERESTED' as const, label: 'Maybe', color: 'var(--warning)', bg: 'var(--warning-subtle)', border: 'var(--warning-muted)' },
  { status: 'DECLINED' as const, label: "Can't make it", color: 'var(--danger)', bg: 'var(--danger-subtle)', border: 'var(--danger-muted)' },
] as const;

const REMINDER_LABELS: Record<string, string> = {
  AT_START: 'At start',
  '15_MIN': '15 min before',
  '1_HOUR': '1 hour before',
  '1_DAY': '1 day before',
  '1_WEEK': '1 week before',
};

const MAX_VISIBLE_AVATARS = 5;

// Helpers

function formatEventDate(startIso: string, endIso: string, allDay: boolean): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const dateOpts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

  const startDate = start.toLocaleDateString(undefined, dateOpts);

  if (allDay) {
    const endDate = end.toLocaleDateString(undefined, dateOpts);
    // Same day
    if (start.toDateString() === end.toDateString() || new Date(end.getTime() - 1).toDateString() === start.toDateString()) {
      return `${startDate} \u00B7 All day`;
    }
    return `${startDate} \u2013 ${endDate} \u00B7 All day`;
  }

  const startTime = start.toLocaleTimeString(undefined, timeOpts);
  const endTime = end.toLocaleTimeString(undefined, timeOpts);

  if (start.toDateString() === end.toDateString()) {
    return `${startDate} \u00B7 ${startTime} \u2013 ${endTime}`;
  }

  const endDate = end.toLocaleDateString(undefined, dateOpts);
  return `${startDate} ${startTime} \u2013 ${endDate} ${endTime}`;
}

// Props

export interface Attendee {
  userId: string;
  username: string;
  avatar?: string | null;
  status: 'GOING' | 'INTERESTED' | 'DECLINED';
}

interface EventDetailProps {
  event: ServerEvent;
  canManage: boolean;
  creatorName?: string | null;
  attendees?: Attendee[];
  onBack: () => void;
  onEdit: (event: ServerEvent) => void;
  onDelete: (eventId: string) => void;
  onRsvp: (status: 'GOING' | 'INTERESTED' | 'DECLINED') => void;
  onRemoveRsvp: () => void;
  voiceChannelName?: string | null;
  onJoinVoice?: (channelId: string) => void;
}

// Component

export const EventDetail: React.FC<EventDetailProps> = React.memo(function EventDetail({
  event, canManage, creatorName, attendees = [], onBack, onEdit, onDelete, onRsvp, onRemoveRsvp, voiceChannelName, onJoinVoice,
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const dateStr = useMemo(() => formatEventDate(event.startTime, event.endTime, event.allDay), [event.startTime, event.endTime, event.allDay]);

  const activeReminders = useMemo(
    () => event.reminders.filter((r) => !r.sent).map((r) => REMINDER_LABELS[r.timing] ?? r.timing),
    [event.reminders],
  );

  const goingAttendees = useMemo(() => attendees.filter((a) => a.status === 'GOING'), [attendees]);
  const interestedAttendees = useMemo(() => attendees.filter((a) => a.status === 'INTERESTED'), [attendees]);
  const totalAttending = goingAttendees.length + interestedAttendees.length;

  const handleRsvp = useCallback((status: 'GOING' | 'INTERESTED' | 'DECLINED') => {
    if (event.myRsvp === status) onRemoveRsvp();
    else onRsvp(status);
  }, [event.myRsvp, onRsvp, onRemoveRsvp]);

  const content = (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between shrink-0 px-3 py-2.5"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium hover:bg-fill-hover transition-colors"
          style={{ color: 'var(--text-secondary)', minHeight: 32 }}
        >
          <ChevronLeft size={14} />
          {isMobile ? 'Calendar' : 'Back'}
        </button>
        {canManage && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onEdit(event)}
              className="rounded-md p-1.5 hover:bg-fill-hover transition-colors"
              style={{ color: 'var(--text-secondary)' }}
              title={t('calendar.editEvent')}
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              onClick={() => onDelete(event.id)}
              className="rounded-md p-1.5 hover:bg-red-500/10 transition-colors"
              style={{ color: 'var(--text-tertiary)' }}
              title={t('calendar.deleteEvent')}
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Title + color */}
        <div className="flex items-start gap-3">
          <div className="rounded-full shrink-0 mt-1.5" style={{ width: 10, height: 10, backgroundColor: event.color }} />
          <h3 className="text-base font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>
            {event.title}
          </h3>
        </div>

        {/* Date/time */}
        <div className="flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
          <Clock size={14} className="shrink-0" />
          <span className="text-sm">{dateStr}</span>
        </div>

        {/* Timezone */}
        {event.timezone && event.timezone !== 'UTC' && (
          <div className="flex items-center gap-2" style={{ color: 'var(--text-tertiary)' }}>
            <Calendar size={14} className="shrink-0" />
            <span className="text-xs">{event.timezone}</span>
          </div>
        )}

        {/* Recurrence */}
        {event.recurrenceRule && event.recurrenceRule !== 'NONE' && (
          <div className="flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
            <Repeat size={13} className="shrink-0" />
            <span className="text-xs">{formatRecurrenceLabel(event)}</span>
            {event.recurrenceEndDate && (
              <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                until {new Date(event.recurrenceEndDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            )}
          </div>
        )}

        {/* Voice channel */}
        {event.voiceChannelId && (
          <div className="flex items-center gap-2">
            <Headphones size={13} className="shrink-0" style={{ color: 'var(--text-secondary)' }} />
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {voiceChannelName ?? 'Voice channel'}
            </span>
            {onJoinVoice && (
              <button
                type="button"
                onClick={() => onJoinVoice(event.voiceChannelId!)}
                className="rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors hover:brightness-125"
                style={{
                  minHeight: 28,
                  backgroundColor: 'var(--success-subtle)',
                  color: 'var(--success)',
                  border: '1px solid var(--success-muted)',
                }}
              >
                Join
              </button>
            )}
          </div>
        )}

        {/* Description */}
        {event.description && (
          <p
            className="text-sm leading-relaxed whitespace-pre-wrap"
            style={{ color: 'var(--text-secondary)' }}
          >
            {event.description}
          </p>
        )}

        {/* Reminders */}
        {activeReminders.length > 0 && (
          <div className="flex items-start gap-2">
            <Bell size={13} className="shrink-0 mt-0.5" style={{ color: 'var(--text-tertiary)' }} />
            <div className="flex flex-wrap gap-1">
              {activeReminders.map((label) => (
                <span
                  key={label}
                  className="rounded-md px-2 py-0.5 text-[11px]"
                  style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-tertiary)' }}
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Creator */}
        {creatorName && (
          <div className="flex items-center gap-2" style={{ color: 'var(--text-tertiary)' }}>
            <User size={13} className="shrink-0" />
            <span className="text-xs">Created by {creatorName}</span>
          </div>
        )}

        {/* Divider */}
        <div style={{ borderTop: '1px solid var(--border-subtle)' }} />

        {/* RSVP buttons */}
        <div>
          <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
            RSVP
          </p>
          <div className="flex gap-2 flex-wrap">
            {RSVP_OPTIONS.map(({ status, label }) => {
              const isActive = event.myRsvp === status;
              return (
                <button
                  key={status}
                  type="button"
                  onClick={() => handleRsvp(status)}
                  className="rounded-lg px-3 py-2 text-xs font-medium transition-all hover:brightness-125"
                  style={{
                    minHeight: 44,
                    minWidth: isMobile ? 0 : 80,
                    flex: isMobile ? '1 1 0%' : undefined,
                    backgroundColor: isActive ? 'var(--cta-bg, #02385A)' : 'var(--fill-hover)',
                    border: `1px solid ${isActive ? 'var(--cta-bg, #02385A)' : 'var(--border-subtle)'}`,
                    color: isActive ? '#fff' : 'var(--text-secondary)',
                  }}
                >
                  {label}
                  {isActive && ' \u2713'}
                </button>
              );
            })}
          </div>
        </div>

        {/* RSVP counts */}
        <div className="flex gap-4 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          <span>{event.rsvpCounts.going} going</span>
          <span>{event.rsvpCounts.interested} interested</span>
          <span>{event.rsvpCounts.declined} declined</span>
        </div>

        {/* Attendee avatars */}
        {totalAttending > 0 && (
          <div>
            <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              Attending
            </p>
            <div className="flex items-center">
              {/* Avatar stack */}
              <div className="flex -space-x-2">
                {[...goingAttendees, ...interestedAttendees].slice(0, MAX_VISIBLE_AVATARS).map((att) => (
                  <div
                    key={att.userId}
                    className="rounded-full border-2 flex items-center justify-center shrink-0"
                    style={{
                      width: 32,
                      height: 32,
                      borderColor: 'var(--bg-panel)',
                      backgroundColor: 'var(--fill-active)',
                      overflow: 'hidden',
                    }}
                    title={`${att.username} (${att.status === 'GOING' ? 'going' : 'interested'})`}
                  >
                    {att.avatar ? (
                      <img
                        src={att.avatar}
                        alt={att.username}
                        className="w-full h-full object-cover rounded-full"
                      />
                    ) : (
                      <span className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                        {att.username.charAt(0).toUpperCase()}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {totalAttending > MAX_VISIBLE_AVATARS && (
                <span
                  className="rounded-full border-2 flex items-center justify-center shrink-0 text-[10px] font-semibold -ml-2"
                  style={{
                    width: 32,
                    height: 32,
                    borderColor: 'var(--bg-panel)',
                    backgroundColor: 'var(--fill-hover)',
                    color: 'var(--text-tertiary)',
                  }}
                >
                  +{totalAttending - MAX_VISIBLE_AVATARS}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  // Mobile: full-screen overlay
  if (isMobile) {
    return (
      <div
        className="fixed inset-0 z-50 flex flex-col"
        style={{ backgroundColor: 'var(--bg-app)' }}
      >
        {content}
      </div>
    );
  }

  // Desktop: inline in parent container
  return content;
});
