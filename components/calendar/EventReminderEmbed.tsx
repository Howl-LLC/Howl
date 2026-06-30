// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useMemo } from 'react';
import { Calendar, Clock, Bell, Repeat, Headphones, AtSign } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '../../hooks/useIsMobile';

// Constants

const TIMING_LABELS: Record<string, string> = {
  AT_START: 'Starting now',
  '15_MIN': 'Starting in 15 minutes',
  '1_HOUR': 'Starting in 1 hour',
  '1_DAY': 'Starting tomorrow',
  '1_WEEK': 'Starting in 1 week',
};

// Helpers

function formatEmbedTime(startIso: string, endIso: string, allDay: boolean): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const dateOpts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

  const startDate = start.toLocaleDateString(undefined, dateOpts);

  if (allDay) {
    if (start.toDateString() === end.toDateString() || new Date(end.getTime() - 1).toDateString() === start.toDateString()) {
      return `${startDate} \u00B7 All day`;
    }
    return `${startDate} \u2013 ${end.toLocaleDateString(undefined, dateOpts)} \u00B7 All day`;
  }

  const startTime = start.toLocaleTimeString(undefined, timeOpts);
  const endTime = end.toLocaleTimeString(undefined, timeOpts);

  if (start.toDateString() === end.toDateString()) {
    return `${startDate} \u00B7 ${startTime} \u2013 ${endTime}`;
  }
  return `${startDate} ${startTime} \u2013 ${end.toLocaleDateString(undefined, dateOpts)} ${endTime}`;
}

// Props

interface EventReminderEmbedProps {
  payload: {
    eventId: string;
    eventTitle: string;
    eventDescription?: string | null;
    eventStartTime: string;
    eventEndTime: string;
    eventColor: string;
    timing: string;
    allDay: boolean;
    recurring?: boolean;
    voiceChannelName?: string | null;
    mentionContent?: string | null;
  };
  serverId: string;
  onNavigateToEvent?: (serverId: string, eventId: string) => void;
}

// Component

export const EventReminderEmbed: React.FC<EventReminderEmbedProps> = React.memo(function EventReminderEmbed({
  payload, serverId, onNavigateToEvent,
}) {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const isUrgent = payload.timing === 'AT_START';

  const timingLabel = useMemo(() => TIMING_LABELS[payload.timing] ?? 'Upcoming event', [payload.timing]);
  const timeStr = useMemo(
    () => formatEmbedTime(payload.eventStartTime, payload.eventEndTime, payload.allDay),
    [payload.eventStartTime, payload.eventEndTime, payload.allDay],
  );

  return (
    <div
      className="rounded-xl overflow-hidden mt-1"
      style={{
        maxWidth: isMobile ? '100%' : 400,
        backgroundColor: isUrgent ? 'rgba(245, 158, 11, 0.06)' : 'var(--fill-hover)',
        border: `1px solid ${isUrgent ? 'rgba(245, 158, 11, 0.15)' : 'var(--glass-border)'}`,
      }}
    >
      <div className="px-3 py-2.5">
        {/* Timing label */}
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded-md flex items-center justify-center"
            style={{ backgroundColor: isUrgent ? 'rgba(245, 158, 11, 0.15)' : `color-mix(in srgb, ${payload.eventColor} 15%, transparent)` }}>
            {isUrgent ? <Bell size={12} style={{ color: '#f59e0b' }} /> : <Calendar size={12} style={{ color: payload.eventColor }} />}
          </div>
          <span className="text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: isUrgent ? '#f59e0b' : payload.eventColor }}>
            {timingLabel}
          </span>
        </div>

        {/* Title */}
        <p className="text-sm font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>
          {payload.eventTitle}
          {payload.recurring && <Repeat size={10} className="inline ml-1.5" style={{ color: 'var(--text-secondary)' }} />}
        </p>

        {/* Time */}
        <div className="flex items-center gap-1.5 mt-1">
          <Clock size={11} style={{ color: 'var(--text-tertiary)' }} />
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {timeStr}
          </span>
        </div>

        {/* Description (for 1_DAY, 1_WEEK, AT_START) */}
        {payload.eventDescription && (
          <p className="text-xs mt-1.5 line-clamp-3 leading-relaxed" style={{ color: 'var(--text-secondary)', opacity: 0.7 }}>
            {payload.eventDescription}
          </p>
        )}

        {/* Voice channel */}
        {payload.voiceChannelName && (
          <div className="flex items-center gap-1 mt-1">
            <Headphones size={10} style={{ color: 'var(--text-secondary)' }} />
            <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{payload.voiceChannelName}</span>
          </div>
        )}

        {/* Mention content */}
        {payload.mentionContent && (
          <div className="flex items-center gap-1 mt-1.5">
            <AtSign size={10} style={{ color: 'var(--cyan-accent)' }} />
            <span className="text-[11px] font-medium" style={{ color: 'var(--cyan-accent)' }}>{payload.mentionContent}</span>
          </div>
        )}

        {/* View in calendar link */}
        {onNavigateToEvent && (
          <button type="button" onClick={() => onNavigateToEvent(serverId, payload.eventId)}
            className="flex items-center gap-1 mt-2 text-xs font-medium hover:underline"
            style={{ color: 'var(--cyan-accent)', minHeight: 28 }}>
            <Calendar size={11} />
            {t('calendar.viewInCalendar', 'View in calendar')}
          </button>
        )}
      </div>
    </div>
  );
});
