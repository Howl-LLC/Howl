// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronLeft, ChevronRight, Plus, Calendar, Clock, Users, X, Repeat } from 'lucide-react';
import { useIsMobile } from '../hooks/useIsMobile';
import { useSwipeGesture } from '../hooks/useSwipeGesture';
import { EventDetail } from './calendar/EventDetail';
import { generateOccurrences } from '../utils/calendarUtils';
import type { Server, ServerEvent } from '../types';
import { serverHasPerm } from '../types';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';

// Constants

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_NARROW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MAX_CHIPS = 3;

// Helpers

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatTime(iso: string, allDay: boolean): string {
  if (allDay) return 'All day';
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatTimeRange(start: string, end: string, allDay: boolean): string {
  if (allDay) return 'All day';
  return `${formatTime(start, false)} – ${formatTime(end, false)}`;
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

/** Check if an event overlaps a given local date */
function eventOverlapsDay(event: ServerEvent, day: Date): boolean {
  const start = new Date(event.startTime);
  const end = new Date(event.endTime);
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  return start < dayEnd && end > dayStart;
}

// Grid calculation

interface CalendarDay {
  date: Date;
  day: number;
  isCurrentMonth: boolean;
  isToday: boolean;
}

function buildCalendarGrid(year: number, month: number): CalendarDay[] {
  const today = new Date();
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfWeek(year, month);
  const prevMonthDays = getDaysInMonth(year, month - 1);
  const days: CalendarDay[] = [];

  // Previous month filler
  for (let i = firstDay - 1; i >= 0; i--) {
    const d = prevMonthDays - i;
    const date = new Date(year, month - 1, d);
    days.push({ date, day: d, isCurrentMonth: false, isToday: isSameDay(date, today) });
  }

  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    days.push({ date, day: d, isCurrentMonth: true, isToday: isSameDay(date, today) });
  }

  // Next month filler — fill to complete last row
  const remaining = 7 - (days.length % 7);
  if (remaining < 7) {
    for (let d = 1; d <= remaining; d++) {
      const date = new Date(year, month + 1, d);
      days.push({ date, day: d, isCurrentMonth: false, isToday: isSameDay(date, today) });
    }
  }

  return days;
}

// Props

interface ServerCalendarProps {
  serverId: string;
  server: Server;
  events: ServerEvent[];
  loading?: boolean;
  onCreateEvent: (date?: Date) => void;
  onSelectEvent: (event: ServerEvent) => void;
  onNavigateBack: () => void;
  onMonthChange: (year: number, month: number) => void;
  onEditEvent?: (event: ServerEvent) => void;
  onDeleteEvent?: (eventId: string) => Promise<void>;
  onRsvp?: (eventId: string, status: 'GOING' | 'INTERESTED' | 'DECLINED') => Promise<void>;
  onRemoveRsvp?: (eventId: string) => Promise<void>;
  onJoinVoiceChannel?: (channelId: string) => void;
  currentUserId?: string;
  members?: Array<{ id: string; username: string; avatar?: string | null }>;
}

// Day Cell

interface DayCellProps {
  cell: CalendarDay;
  dayEvents: ServerEvent[];
  isSelected: boolean;
  isMobile: boolean;
  canManage: boolean;
  isLastRow?: boolean;
  onSelect: (date: Date) => void;
  onCreateEvent: (date: Date) => void;
  onSelectEvent: (event: ServerEvent) => void;
}

const DayCell = React.memo(function DayCell({
  cell, dayEvents, isSelected, isMobile, canManage, isLastRow, onSelect, onCreateEvent, onSelectEvent,
}: DayCellProps) {
  const hasEvents = dayEvents.length > 0;
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      onClick={() => onSelect(cell.date)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative flex flex-col items-center gap-0.5 rounded-lg transition-colors duration-100 outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/50"
      style={{
        minHeight: isMobile ? 44 : 90,
        padding: isMobile ? '4px 2px' : '4px 4px 6px',
        backgroundColor: isSelected
          ? 'var(--accent-subtle)'
          : hovered
            ? 'var(--fill-hover)'
            : 'transparent',
        border: isSelected
          ? '1px solid var(--accent-emphasis)'
          : '1px solid transparent',
        opacity: cell.isCurrentMonth ? 1 : 0.3,
      }}
    >
      {/* Date number */}
      <span
        className="text-xs font-medium leading-none"
        style={{
          width: 24,
          height: 24,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '50%',
          backgroundColor: cell.isToday ? 'var(--cyan-accent)' : 'transparent',
          color: cell.isToday ? 'var(--bg-app)' : 'var(--text-primary)',
          fontWeight: cell.isToday ? 700 : 500,
        }}
      >
        {cell.day}
      </span>

      {/* Event indicators */}
      {hasEvents && isMobile && (
        <div className="flex gap-0.5 mt-0.5">
          {dayEvents.slice(0, 3).map((ev) => (
            <span
              key={ev.id}
              className="rounded-full"
              style={{ width: 5, height: 5, backgroundColor: ev.color }}
            />
          ))}
          {dayEvents.length > 3 && (
            <span className="text-[8px] leading-none" style={{ color: 'var(--text-tertiary)' }}>
              +{dayEvents.length - 3}
            </span>
          )}
        </div>
      )}

      {hasEvents && !isMobile && (
        <div className="flex flex-col gap-0.5 w-full mt-0.5 px-0.5">
          {dayEvents.slice(0, MAX_CHIPS).map((ev) => (
            <button
              key={ev.id}
              type="button"
              onClick={(e) => { e.stopPropagation(); onSelectEvent(ev); }}
              className="flex items-center gap-1 rounded-lg px-1 py-0.5 text-[10px] leading-tight truncate text-left transition-opacity hover:opacity-80"
              style={{ backgroundColor: `${ev.color}22`, color: ev.color }}
              title={ev.title}
            >
              <span className="rounded-full shrink-0" style={{ width: 4, height: 4, backgroundColor: ev.color }} />
              <span className="truncate">{ev.title}</span>
              {ev.recurrenceRule && ev.recurrenceRule !== 'NONE' && (
                <Repeat size={8} className="shrink-0 opacity-60" />
              )}
            </button>
          ))}
          {dayEvents.length > MAX_CHIPS && (
            <span className="text-[10px] px-1" style={{ color: 'var(--text-tertiary)' }}>
              +{dayEvents.length - MAX_CHIPS} more
            </span>
          )}
        </div>
      )}

      {/* Quick-create on hover (desktop only) */}
      {!isMobile && canManage && hovered && cell.isCurrentMonth && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCreateEvent(cell.date); }}
          className="absolute top-1 right-1 rounded-full flex items-center justify-center transition-opacity"
          style={{
            width: 18,
            height: 18,
            backgroundColor: 'var(--accent-muted)',
            color: 'var(--cyan-accent)',
          }}
          title="Create event"
        >
          <Plus size={10} />
        </button>
      )}
      {!isLastRow && (
        <div style={{ position: 'absolute', bottom: 0, left: '15%', right: '15%', height: 1, backgroundColor: 'var(--border-subtle)' }} />
      )}
    </button>
  );
});

// Event Card

interface EventCardProps {
  event: ServerEvent;
  onClick: (event: ServerEvent) => void;
  compact?: boolean;
}

const EventCard = React.memo(function EventCard({ event, onClick, compact }: EventCardProps) {
  const totalRsvp = event.rsvpCounts.going + event.rsvpCounts.interested;

  return (
    <button
      type="button"
      onClick={() => onClick(event)}
      className="w-full text-left rounded-lg transition-colors hover:brightness-110 outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/50"
      style={{
        padding: compact ? '8px 10px' : '10px 12px',
        backgroundColor: 'var(--fill-hover)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      <div className="flex items-start gap-2.5">
        {/* Color bar */}
        <div
          className="rounded-full shrink-0 mt-1"
          style={{ width: 3, height: compact ? 28 : 36, backgroundColor: event.color }}
        />
        <div className="flex-1 min-w-0">
          <p
            className="text-sm font-medium truncate"
            style={{ color: 'var(--text-primary)' }}
          >
            {event.title}
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              <Clock size={10} />
              {formatTimeRange(event.startTime, event.endTime, event.allDay)}
            </span>
            {totalRsvp > 0 && (
              <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                <Users size={10} />
                {totalRsvp}
              </span>
            )}
          </div>
          {!compact && event.description && (
            <p
              className="text-xs mt-1 line-clamp-2"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {event.description}
            </p>
          )}
        </div>
      </div>
    </button>
  );
});

// Mobile Bottom Sheet

interface BottomSheetProps {
  selectedDate: Date | null;
  events: ServerEvent[];
  canManage: boolean;
  onClose: () => void;
  onCreateEvent: (date: Date) => void;
  onSelectEvent: (event: ServerEvent) => void;
}

const BottomSheet = React.memo(function BottomSheet({
  selectedDate, events, canManage, onClose, onCreateEvent, onSelectEvent,
}: BottomSheetProps) {
  if (!selectedDate) return null;

  const label = selectedDate.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  return (
    <AnimatePresence>
      {selectedDate && (
        <>
          {/* Scrim */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-40"
            style={{ backgroundColor: 'var(--overlay-backdrop)' }}
            onClick={onClose}
          />
          {/* Sheet */}
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 340 }}
            className="fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl"
            style={{
              backgroundColor: 'var(--glass-bg)',
              borderTop: '1px solid var(--glass-border)',
              backdropFilter: 'blur(24px) saturate(1.3)',
              WebkitBackdropFilter: 'blur(24px) saturate(1.3)',
              maxHeight: '60vh',
            }}
          >
            {/* Drag handle */}
            <div className="flex justify-center py-2">
              <div className="rounded-full" style={{ width: 32, height: 4, backgroundColor: 'var(--fill-strong)' }} />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-4 pb-2">
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {label}
              </h3>
              <div className="flex items-center gap-2">
                {canManage && (
                  <button
                    type="button"
                    onClick={() => onCreateEvent(selectedDate)}
                    className="rounded-full flex items-center justify-center"
                    style={{
                      width: 28,
                      height: 28,
                      backgroundColor: 'var(--accent-muted)',
                      color: 'var(--cyan-accent)',
                    }}
                  >
                    <Plus size={14} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-full flex items-center justify-center"
                  style={{
                    width: 28,
                    height: 28,
                    backgroundColor: 'var(--fill-hover)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Events list */}
            <div className="overflow-y-auto px-4 pb-6" style={{ maxHeight: 'calc(60vh - 80px)' }}>
              {events.length === 0 ? (
                <p className="text-center text-xs py-6" style={{ color: 'var(--text-tertiary)' }}>
                  No events this day
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {events.map((ev) => (
                    <EventCard key={ev.id} event={ev} onClick={onSelectEvent} compact />
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
});

// Rich Event Card

interface RichEventCardProps {
  event: ServerEvent;
  onClick: (event: ServerEvent) => void;
  onRsvp?: (eventId: string, status: 'GOING' | 'INTERESTED' | 'DECLINED') => void;
  onRemoveRsvp?: (eventId: string) => void;
  showCountdown?: boolean;
  users?: Array<{ id: string; username: string; avatar?: string | null }>;
}

const RichEventCard = React.memo(function RichEventCard({ event, onClick, onRsvp, onRemoveRsvp, showCountdown, users }: RichEventCardProps) {
  const countdown = useMemo(() => {
    if (!showCountdown) return null;
    const diffMs = new Date(event.startTime).getTime() - Date.now();
    if (diffMs <= 0) return 'Now';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
  }, [event.startTime, showCountdown]);

  const ec = event.color || '#076FA0';

  const goingUsers = useMemo(() => {
    if (!event.rsvpGoingUserIds || !users) return [];
    return event.rsvpGoingUserIds.map((id) => users.find((u) => u.id === id)).filter(Boolean).slice(0, 3);
  }, [event.rsvpGoingUserIds, users]);

  const handleRsvp = (status: 'GOING' | 'INTERESTED' | 'DECLINED', e: React.MouseEvent) => {
    e.stopPropagation();
    if (event.myRsvp === status) onRemoveRsvp?.(event.id);
    else onRsvp?.(event.id, status);
  };

  return (
    <div onClick={() => onClick(event)} style={{ borderRadius: 12, overflow: 'hidden', border: `1px solid ${ec}15`, cursor: 'pointer' }}>
      <div style={{ padding: '10px 12px', background: `linear-gradient(135deg, ${ec}1F, ${ec}08)`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 30, height: 30, borderRadius: 12, backgroundColor: `${ec}26`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Calendar size={14} style={{ color: ec }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event.title}</div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{formatTimeRange(event.startTime, event.endTime, event.allDay)}</div>
        </div>
        {countdown && <div style={{ padding: '3px 7px', borderRadius: 12, fontSize: 9, fontWeight: 500, color: ec, backgroundColor: `${ec}1A` }}>{countdown}</div>}
      </div>
      <div style={{ padding: '8px 12px', background: 'var(--fill-hover)' }}>
        {event.description && (
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}>{event.description}</div>
        )}
        {(event.rsvpCounts.going > 0 || event.rsvpCounts.interested > 0) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            {goingUsers.length > 0 && (
              <div style={{ display: 'flex' }}>
                {goingUsers.map((user, i) => (
                  <div key={user!.id} style={{ width: 20, height: 20, borderRadius: '50%', border: '1.5px solid var(--bg-app)', marginLeft: i > 0 ? -5 : 0, overflow: 'hidden', backgroundColor: 'var(--fill-active)', flexShrink: 0 }}>
                    {user!.avatar ? (
                      <LazyGif src={user!.avatar} frameSrc={getFrameUrl(user!.avatar)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 500, color: 'var(--text-primary)', backgroundColor: 'var(--fill-active)' }}>{user!.username?.charAt(0)?.toUpperCase() ?? '?'}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {goingUsers.length === 0 && <Users size={10} style={{ color: 'var(--text-tertiary)' }} />}
            <span style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>
              {event.rsvpCounts.going > 0 ? `${event.rsvpCounts.going} going` : ''}{event.rsvpCounts.going > 0 && event.rsvpCounts.interested > 0 ? ' · ' : ''}{event.rsvpCounts.interested > 0 ? `${event.rsvpCounts.interested} interested` : ''}
            </span>
          </div>
        )}
        {onRsvp && (
          <div style={{ display: 'flex', gap: 4 }}>
            {(['GOING', 'INTERESTED', 'DECLINED'] as const).map((status) => (
              <button key={status} type="button" onClick={(e) => handleRsvp(status, e)} style={{
                flex: 1, padding: '5px 0', borderRadius: 12, fontSize: 9, fontWeight: 500, cursor: 'pointer', border: 'none',
                color: event.myRsvp === status ? '#fff' : (status === 'GOING' ? ec : 'var(--text-tertiary)'),
                backgroundColor: event.myRsvp === status ? 'var(--cta-bg, #02385A)' : (status === 'GOING' ? `${ec}15` : 'var(--fill-hover)'),
              }}>
                {status === 'GOING' ? 'Going' : status === 'INTERESTED' ? 'Interested' : 'Decline'}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

// Split Detail Panel (Desktop)

interface SplitDetailPanelProps {
  selectedDate: Date | null;
  selectedDayEvents: ServerEvent[];
  weekEvents: ServerEvent[];
  canManage: boolean;
  onCreateEvent: (date: Date) => void;
  onSelectEvent: (event: ServerEvent) => void;
  onRsvp?: (eventId: string, status: 'GOING' | 'INTERESTED' | 'DECLINED') => Promise<void> | void;
  onRemoveRsvp?: (eventId: string) => Promise<void> | void;
  users?: Array<{ id: string; username: string; avatar?: string | null }>;
}

const SplitDetailPanel = React.memo(function SplitDetailPanel({
  selectedDate, selectedDayEvents, weekEvents, canManage, onCreateEvent, onSelectEvent, onRsvp, onRemoveRsvp, users,
}: SplitDetailPanelProps) {
  const { t } = useTranslation();
  const today = useMemo(() => new Date(), []);
  const isToday = selectedDate ? isSameDay(selectedDate, today) : false;
  const dateLabel = selectedDate ? selectedDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '';

  const otherWeekEvents = useMemo(() => {
    return weekEvents.filter((ev) => !selectedDate || !isSameDay(new Date(ev.startTime), selectedDate));
  }, [weekEvents, selectedDate]);

  return (
    <div style={{ width: 'clamp(280px, 30vw, 400px)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Bubble 1: Selected day */}
      <div className="rounded-2xl border glass" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: isToday ? 'var(--cyan-accent)' : 'var(--text-primary)' }}>{isToday ? 'Today' : (dateLabel || 'Select a day')}</span>
          {isToday && <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{dateLabel}</span>}
        </div>
        {canManage && selectedDate && (
          <button type="button" onClick={() => onCreateEvent(selectedDate)} className="btn-cta" style={{ padding: '3px 8px', fontSize: 10, cursor: 'pointer' }}>+ New</button>
        )}
      </div>

      {/* Top: Selected day rich cards */}
      <div style={{ overflowY: 'auto', padding: 8, borderBottom: '1px solid var(--border-subtle)', minHeight: 80 }}>
        {!selectedDate || selectedDayEvents.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px 0', gap: 8 }}>
            <Calendar size={22} style={{ color: 'var(--text-tertiary)' }} />
            <p style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{!selectedDate ? 'Select a day to view events' : 'No events'}</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {selectedDayEvents.map((ev) => (
              <RichEventCard key={ev.id} event={ev} onClick={onSelectEvent} onRsvp={onRsvp} onRemoveRsvp={onRemoveRsvp} showCountdown={isToday} users={users} />
            ))}
          </div>
        )}
      </div>
      </div>

      {/* Bubble 2: This week */}
      <div className="rounded-2xl border glass" style={{ height: 200, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '8px 12px 4px' }}>
        <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-secondary)' }}>{t('calendar.thisWeek')}</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
        {otherWeekEvents.length === 0 ? (
          <div style={{ padding: '16px 0', textAlign: 'center' }}>
            <p style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{t('calendar.noMoreEventsThisWeek')}</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {otherWeekEvents.map((ev) => (
              <div key={`${ev.id}-${ev.startTime}`} onClick={() => onSelectEvent(ev)} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 8, borderRadius: 12, cursor: 'pointer' }} className="hover:bg-fill-hover">
                <div style={{ minWidth: 36, textAlign: 'right' }}>
                  <div style={{ fontSize: 9, fontWeight: 500, color: 'var(--text-tertiary)', letterSpacing: 0.3 }}>{new Date(ev.startTime).toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}</div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)' }}>{new Date(ev.startTime).getDate()}</div>
                </div>
                <div style={{ width: 3, height: 28, borderRadius: 2, backgroundColor: ev.color || '#076FA0', flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-primary)' }}>{ev.title}</div>
                  <div style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>
                    {formatTime(ev.startTime, ev.allDay)}{ev.recurrenceRule && ev.recurrenceRule !== 'NONE' ? ' · Recurring' : ''}{ev.rsvpCounts.going > 0 ? ` · ${ev.rsvpCounts.going} going` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      </div>
    </div>
  );
});

// Main Component

export const ServerCalendar: React.FC<ServerCalendarProps> = React.memo(function ServerCalendar({
  serverId: _serverId, server, events, loading, onCreateEvent, onSelectEvent, onNavigateBack, onMonthChange,
  onEditEvent, onDeleteEvent, onRsvp, onRemoveRsvp, onJoinVoiceChannel, currentUserId: _currentUserId, members,
}) {
  const isMobile = useIsMobile();
  // Narrow-desktop breakpoint: between the mobile threshold and ~1500px the
  // inline detail panel crushes the 7-column grid into unreadable widths, so
  // reuse the mobile overlay path there.
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 1500px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1500px)');
    const onChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const canManage = serverHasPerm(server, 'manageCalendar');
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const now = new Date();
    const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
    const timer = setTimeout(() => setToday(new Date()), msUntilMidnight + 1000);
    return () => clearTimeout(timer);
  }, [today]);

  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState<Date | null>(() => new Date());
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [viewingEvent, setViewingEvent] = useState<ServerEvent | null>(null);

  const grid = useMemo(() => buildCalendarGrid(currentYear, currentMonth), [currentYear, currentMonth]);

  // Expand recurring events into per-day entries
  const eventsByDay = useMemo(() => {
    const map = new Map<string, ServerEvent[]>();
    // Compute range for the grid
    const firstCell = grid[0]?.date;
    const lastCell = grid[grid.length - 1]?.date;
    if (!firstCell || !lastCell) return map;
    const rangeStart = new Date(firstCell.getFullYear(), firstCell.getMonth(), firstCell.getDate());
    const rangeEnd = new Date(lastCell.getFullYear(), lastCell.getMonth(), lastCell.getDate() + 1);

    for (const cell of grid) {
      const key = `${cell.date.getFullYear()}-${cell.date.getMonth()}-${cell.date.getDate()}`;
      const dayEvents: ServerEvent[] = [];
      // Per-cell id guard. The outer store already dedupes by id, but if a
      // duplicate ever leaks in (legacy DB row, broken socket replay), we
      // don't want it to paint two chips on every recurrence day.
      const seen = new Set<string>();

      for (const ev of events) {
        if (seen.has(ev.id)) continue;
        const isRecurring = ev.recurrenceRule && ev.recurrenceRule !== 'NONE';
        if (isRecurring) {
          // Check if any occurrence overlaps this day
          const occurrences = generateOccurrences(ev, rangeStart, rangeEnd);
          for (const occ of occurrences) {
            if (eventOverlapsDay({ ...ev, startTime: occ.startTime.toISOString(), endTime: occ.endTime.toISOString() }, cell.date)) {
              dayEvents.push(ev);
              seen.add(ev.id);
              break; // Only add once per day
            }
          }
        } else {
          if (eventOverlapsDay(ev, cell.date)) {
            dayEvents.push(ev);
            seen.add(ev.id);
          }
        }
      }

      if (dayEvents.length > 0) map.set(key, dayEvents);
    }
    return map;
  }, [grid, events]);

  const selectedDayEvents = useMemo(() => {
    if (!selectedDate) return [];
    const key = `${selectedDate.getFullYear()}-${selectedDate.getMonth()}-${selectedDate.getDate()}`;
    return eventsByDay.get(key) ?? [];
  }, [selectedDate, eventsByDay]);

  const weekEvents = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const result: ServerEvent[] = [];
    for (const ev of events) {
      const isRecurring = ev.recurrenceRule && ev.recurrenceRule !== 'NONE';
      if (isRecurring) {
        const occs = generateOccurrences(ev, start, end);
        for (const occ of occs) {
          result.push({ ...ev, startTime: occ.startTime.toISOString(), endTime: occ.endTime.toISOString() });
        }
      } else {
        const evStart = new Date(ev.startTime);
        if (evStart >= start && evStart < end) result.push(ev);
      }
    }
    result.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    return result;
  }, [events]);

  // Navigation

  const navigate = useCallback((delta: number) => {
    setCurrentMonth((m) => {
      let newMonth = m + delta;
      let newYear = currentYear;
      if (newMonth < 0) { newMonth = 11; newYear--; }
      else if (newMonth > 11) { newMonth = 0; newYear++; }
      setCurrentYear(newYear);
      onMonthChange(newYear, newMonth + 1);
      return newMonth;
    });
  }, [currentYear, onMonthChange]);

  const goToday = useCallback(() => {
    const now = new Date();
    setCurrentYear(now.getFullYear());
    setCurrentMonth(now.getMonth());
    setSelectedDate(now);
    onMonthChange(now.getFullYear(), now.getMonth() + 1);
  }, [onMonthChange]);

  const handleSelectDay = useCallback((date: Date) => {
    setSelectedDate(date);
    if (isMobile) setMobileSheetOpen(true);
  }, [isMobile]);

  const handleCreateFromDay = useCallback((date: Date) => {
    onCreateEvent(date);
  }, [onCreateEvent]);

  // Keep viewingEvent in sync with events array (updated/deleted via socket)
  const syncedViewingEvent = useMemo(() => {
    if (!viewingEvent) return null;
    return events.find((e) => e.id === viewingEvent.id) ?? null;
  }, [viewingEvent, events]);

  // When the synced event disappears (deleted), close detail
  useEffect(() => {
    if (viewingEvent && !syncedViewingEvent) {
      setViewingEvent(null);
    }
  }, [viewingEvent, syncedViewingEvent]);

  const handleSelectEvent = useCallback((event: ServerEvent) => {
    setViewingEvent(event);
    onSelectEvent(event);
  }, [onSelectEvent]);

  const handleDetailBack = useCallback(() => {
    setViewingEvent(null);
  }, []);

  const handleDetailEdit = useCallback((event: ServerEvent) => {
    onEditEvent?.(event);
  }, [onEditEvent]);

  const handleDetailDelete = useCallback((eventId: string) => {
    onDeleteEvent?.(eventId);
    setViewingEvent(null);
  }, [onDeleteEvent]);

  const handleDetailRsvp = useCallback((status: 'GOING' | 'INTERESTED' | 'DECLINED') => {
    if (!syncedViewingEvent) return;
    onRsvp?.(syncedViewingEvent.id, status);
  }, [syncedViewingEvent, onRsvp]);

  const handleDetailRemoveRsvp = useCallback(() => {
    if (!syncedViewingEvent) return;
    onRemoveRsvp?.(syncedViewingEvent.id);
  }, [syncedViewingEvent, onRemoveRsvp]);

  // Swipe navigation (mobile)

  const { bind: swipeBind } = useSwipeGesture({
    direction: 'horizontal',
    threshold: 60,
    onSwipe: (dir) => {
      if (dir === 'left') navigate(1);
      else if (dir === 'right') navigate(-1);
    },
    enabled: isMobile && !mobileSheetOpen,
  });

  // Empty state

  const isCurrentMonthEmpty = events.length === 0;

  return (
    <div
      className="flex flex-col h-full min-h-0"
      {...swipeBind}
    >
      {/* ── Header ─────────────────────────────────────── */}
      <div
        className="flex items-center justify-between shrink-0 px-4 py-2.5"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onNavigateBack}
            className="rounded-md p-1"
            style={{ color: 'var(--text-secondary)' }}
          >
            <ChevronLeft size={18} />
          </button>
          <div className="flex items-center gap-1.5">
            <Calendar size={15} style={{ color: 'var(--cyan-accent)' }} />
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Calendar
            </h2>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="rounded-md p-1.5 transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            aria-label="Previous month"
          >
            <ChevronLeft size={15} />
          </button>

          <button
            type="button"
            onClick={goToday}
            className="rounded-md px-2 py-1 text-xs font-medium transition-colors hover:brightness-125"
            style={{
              color: 'var(--text-secondary)',
              backgroundColor: 'var(--fill-hover)',
            }}
          >
            Today
          </button>

          <span className="text-sm font-medium px-1.5 min-w-[130px] text-center" style={{ color: 'var(--text-primary)' }}>
            {MONTHS[currentMonth]} {currentYear}
          </span>

          <button
            type="button"
            onClick={() => navigate(1)}
            className="rounded-md p-1.5 transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            aria-label="Next month"
          >
            <ChevronRight size={15} />
          </button>

          {canManage && (
            <button
              type="button"
              onClick={() => onCreateEvent(selectedDate ?? new Date())}
              className="btn-cta rounded-xl flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium ml-2 transition-colors"
            >
              <Plus size={13} />
              {!isMobile && 'Event'}
            </button>
          )}
        </div>
      </div>

      {/* Loading progress bar (month change with cached events) */}
      {loading && !isCurrentMonthEmpty && (
        <div className="shrink-0 h-0.5 w-full overflow-hidden" style={{ backgroundColor: 'var(--accent-subtle)' }}>
          <div className="h-full animate-pulse" style={{ width: '40%', backgroundColor: 'var(--cyan-accent)', animation: 'pulse 1.5s ease-in-out infinite' }} />
        </div>
      )}

      {/* ── Content: Grid + Detail ─────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden" style={{ padding: 10, gap: 10 }}>
        {/* Calendar grid — glass bubble */}
        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto relative rounded-2xl border glass" style={{ padding: '6px 8px' }}>
          {/* Weekday headers */}
          <div className="grid grid-cols-7 shrink-0 px-2 pt-2">
            {(isMobile ? WEEKDAYS_NARROW : WEEKDAYS_SHORT).map((d, i) => (
              <div
                key={i}
                className="text-center text-[11px] font-medium py-1"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {d}
              </div>
            ))}
          </div>

          {/* Gradient separator */}
          <div style={{ display: 'flex', justifyContent: 'center', margin: '0 0 6px' }}>
            <div style={{ width: '92%', height: 1, background: 'linear-gradient(90deg, transparent, var(--border-subtle) 15%, var(--border-subtle) 85%, transparent)' }} />
          </div>
          {/* Day grid */}
          <div className="grid grid-cols-7 flex-1 px-2 pb-2 content-start" style={{ gridAutoRows: 'minmax(clamp(56px, 8vh, 90px), 1fr)' }}>
            {grid.map((cell, idx) => {
              const key = `${cell.date.getFullYear()}-${cell.date.getMonth()}-${cell.date.getDate()}`;
              const dayEvents = eventsByDay.get(key) ?? [];
              const isSelected = selectedDate ? isSameDay(cell.date, selectedDate) : false;

              return (
                <DayCell
                  key={key}
                  cell={cell}
                  dayEvents={dayEvents}
                  isSelected={isSelected}
                  isMobile={isMobile}
                  canManage={canManage}
                  isLastRow={idx >= grid.length - 7}
                  onSelect={handleSelectDay}
                  onCreateEvent={handleCreateFromDay}
                  onSelectEvent={handleSelectEvent}
                />
              );
            })}
          </div>

          {/* Loading overlay */}
          {loading && isCurrentMonthEmpty && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', zIndex: 1 }}>
              <div className="rounded-full border-2 animate-spin" style={{ width: 24, height: 24, borderColor: 'var(--accent-emphasis)', borderTopColor: 'var(--cyan-accent)' }} />
            </div>
          )}
        </div>

        {/* Detail panel (desktop only; narrow-desktop windows reuse the mobile overlay) */}
        {!isMobile && !isNarrow && (
          syncedViewingEvent ? (
            <div className="shrink-0 flex flex-col rounded-2xl border glass" style={{ width: 'clamp(280px, 30vw, 400px)' }}>
              <EventDetail
                event={syncedViewingEvent}
                canManage={canManage}
                onBack={handleDetailBack}
                onEdit={handleDetailEdit}
                onDelete={handleDetailDelete}
                onRsvp={handleDetailRsvp}
                onRemoveRsvp={handleDetailRemoveRsvp}
                voiceChannelName={syncedViewingEvent.voiceChannelId ? server.channels?.find((c) => c.id === syncedViewingEvent.voiceChannelId)?.name : undefined}
                onJoinVoice={syncedViewingEvent.voiceChannelId && onJoinVoiceChannel ? () => onJoinVoiceChannel(syncedViewingEvent.voiceChannelId!) : undefined}
              />
            </div>
          ) : (
            <SplitDetailPanel
              selectedDate={selectedDate}
              selectedDayEvents={selectedDayEvents}
              weekEvents={weekEvents}
              canManage={canManage}
              onCreateEvent={handleCreateFromDay}
              onSelectEvent={handleSelectEvent}
              onRsvp={onRsvp ? (id, status) => onRsvp(id, status) : undefined}
              onRemoveRsvp={onRemoveRsvp ? (id) => onRemoveRsvp(id) : undefined}
              users={members}
            />
          )
        )}
      </div>

      {/* Mobile + narrow-desktop event detail overlay */}
      {(isMobile || isNarrow) && syncedViewingEvent && (
        <EventDetail
          event={syncedViewingEvent}
          canManage={canManage}
          onBack={handleDetailBack}
          onEdit={handleDetailEdit}
          onDelete={handleDetailDelete}
          onRsvp={handleDetailRsvp}
          onRemoveRsvp={handleDetailRemoveRsvp}
          voiceChannelName={syncedViewingEvent.voiceChannelId ? server.channels?.find((c) => c.id === syncedViewingEvent.voiceChannelId)?.name : undefined}
          onJoinVoice={syncedViewingEvent.voiceChannelId && onJoinVoiceChannel ? () => onJoinVoiceChannel(syncedViewingEvent.voiceChannelId!) : undefined}
        />
      )}

      {/* Mobile bottom sheet */}
      {isMobile && !viewingEvent && (
        <BottomSheet
          selectedDate={mobileSheetOpen ? selectedDate : null}
          events={selectedDayEvents}
          canManage={canManage}
          onClose={() => setMobileSheetOpen(false)}
          onCreateEvent={handleCreateFromDay}
          onSelectEvent={handleSelectEvent}
        />
      )}
    </div>
  );
});
