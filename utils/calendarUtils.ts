// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { ServerEvent } from '../types';

export interface Occurrence {
  startTime: Date;
  endTime: Date;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Generate all occurrences of a recurring event within [rangeStart, rangeEnd].
 * Each occurrence preserves the original event duration.
 */
export function generateOccurrences(
  event: ServerEvent,
  rangeStart: Date,
  rangeEnd: Date,
  maxOccurrences = 366,
): Occurrence[] {
  const rule = event.recurrenceRule;
  if (!rule || rule === 'NONE') return [];

  const baseStart = new Date(event.startTime);
  const baseEnd = new Date(event.endTime);
  const duration = baseEnd.getTime() - baseStart.getTime();
  const endCap = event.recurrenceEndDate
    ? new Date(Math.min(new Date(event.recurrenceEndDate).getTime(), rangeEnd.getTime()))
    : rangeEnd;

  const occurrences: Occurrence[] = [];

  if (rule === 'DAILY') {
    const cursor = new Date(baseStart);
    while (cursor <= endCap && occurrences.length < maxOccurrences) {
      const occEnd = new Date(cursor.getTime() + duration);
      if (occEnd > rangeStart && cursor < rangeEnd) {
        occurrences.push({ startTime: new Date(cursor), endTime: occEnd });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  } else if (rule === 'WEEKLY') {
    const cursor = new Date(baseStart);
    while (cursor <= endCap && occurrences.length < maxOccurrences) {
      const occEnd = new Date(cursor.getTime() + duration);
      if (occEnd > rangeStart && cursor < rangeEnd) {
        occurrences.push({ startTime: new Date(cursor), endTime: occEnd });
      }
      cursor.setDate(cursor.getDate() + 7);
    }
  } else if (rule === 'BIWEEKLY') {
    const cursor = new Date(baseStart);
    while (cursor <= endCap && occurrences.length < maxOccurrences) {
      const occEnd = new Date(cursor.getTime() + duration);
      if (occEnd > rangeStart && cursor < rangeEnd) {
        occurrences.push({ startTime: new Date(cursor), endTime: occEnd });
      }
      cursor.setDate(cursor.getDate() + 14);
    }
  } else if (rule === 'MONTHLY') {
    const cursor = new Date(baseStart);
    const dayOfMonth = baseStart.getDate();
    while (cursor <= endCap && occurrences.length < maxOccurrences) {
      const occEnd = new Date(cursor.getTime() + duration);
      if (occEnd > rangeStart && cursor < rangeEnd) {
        occurrences.push({ startTime: new Date(cursor), endTime: occEnd });
      }
      const nextMonth = cursor.getMonth() + 1;
      cursor.setMonth(nextMonth);
      const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      cursor.setDate(Math.min(dayOfMonth, daysInMonth));
    }
  } else if (rule === 'CUSTOM') {
    const days = event.recurrenceDays ?? [];
    if (days.length === 0) return [];
    const daySet = new Set(days);
    const cursor = new Date(Math.max(baseStart.getTime(), rangeStart.getTime()));
    cursor.setHours(baseStart.getHours(), baseStart.getMinutes(), baseStart.getSeconds(), baseStart.getMilliseconds());
    cursor.setDate(cursor.getDate() - 7);

    while (cursor <= endCap && occurrences.length < maxOccurrences) {
      if (daySet.has(cursor.getDay()) && cursor >= baseStart) {
        const occEnd = new Date(cursor.getTime() + duration);
        if (occEnd > rangeStart && cursor < rangeEnd) {
          occurrences.push({ startTime: new Date(cursor), endTime: occEnd });
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  return occurrences;
}

/**
 * Format a human-readable recurrence label.
 * e.g., "Every day", "Every week on Friday", "Every Mon, Wed, Fri"
 */
export function formatRecurrenceLabel(event: ServerEvent): string {
  const rule = event.recurrenceRule;
  if (!rule || rule === 'NONE') return '';

  const startDay = WEEKDAY_LABELS[new Date(event.startTime).getDay()];

  switch (rule) {
    case 'DAILY':
      return 'Every day';
    case 'WEEKLY':
      return `Every week on ${startDay}`;
    case 'BIWEEKLY':
      return `Every 2 weeks on ${startDay}`;
    case 'MONTHLY': {
      const dayOfMonth = new Date(event.startTime).getDate();
      return `Monthly on the ${dayOfMonth}${daySuffix(dayOfMonth)}`;
    }
    case 'CUSTOM': {
      const days = event.recurrenceDays ?? [];
      if (days.length === 0) return 'Custom';
      if (days.length === 7) return 'Every day';
      const sorted = [...days].sort((a, b) => a - b);
      return `Every ${sorted.map((d) => WEEKDAY_LABELS[d]).join(', ')}`;
    }
    default:
      return '';
  }
}

function daySuffix(day: number): string {
  if (day >= 11 && day <= 13) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}
