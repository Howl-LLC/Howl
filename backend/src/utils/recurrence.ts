// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Occurrence generation utility for recurring events.
 *
 * Given a recurring event's rule + base times, generates all occurrence
 * start/end pairs within the provided date range.
 */

export interface RecurrenceInput {
  startTime: Date;
  endTime: Date;
  recurrenceRule: string;
  recurrenceDays?: number[] | null;
  recurrenceEndDate?: Date | null;
}

export interface Occurrence {
  startTime: Date;
  endTime: Date;
}

/**
 * Generate all occurrences of a recurring event within [rangeStart, rangeEnd].
 * Each occurrence preserves the original event duration.
 * Max 366 occurrences to prevent runaway generation.
 */
export function generateOccurrences(
  event: RecurrenceInput,
  rangeStart: Date,
  rangeEnd: Date,
  maxOccurrences = 366,
): Occurrence[] {
  const rule = event.recurrenceRule;
  if (!rule || rule === 'NONE') return [];

  const duration = event.endTime.getTime() - event.startTime.getTime();
  const endCap = event.recurrenceEndDate
    ? new Date(Math.min(event.recurrenceEndDate.getTime(), rangeEnd.getTime()))
    : rangeEnd;

  const occurrences: Occurrence[] = [];
  const baseStart = new Date(event.startTime);

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
      // Move to next month, same day-of-month (clamped)
      const nextMonth = cursor.getMonth() + 1;
      cursor.setMonth(nextMonth);
      // Clamp day if the month doesn't have enough days
      const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      cursor.setDate(Math.min(dayOfMonth, daysInMonth));
    }
  } else if (rule === 'CUSTOM') {
    const days = event.recurrenceDays ?? [];
    if (days.length === 0) return [];
    const daySet = new Set(days);
    // Start from the beginning of the range or the event start, whichever is later
    const cursor = new Date(Math.max(baseStart.getTime(), rangeStart.getTime()));
    // Rewind to start of the day
    cursor.setHours(baseStart.getHours(), baseStart.getMinutes(), baseStart.getSeconds(), baseStart.getMilliseconds());
    // Go back up to 7 days to catch events starting before rangeStart but ending after
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
 * Find the next occurrence after a given date.
 * Returns null if no more occurrences exist (past recurrenceEndDate or no rule).
 */
export function getNextOccurrenceAfter(
  event: RecurrenceInput,
  after: Date,
): Occurrence | null {
  // Search up to 1 year ahead
  const searchEnd = new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000);
  const occurrences = generateOccurrences(event, after, searchEnd, 2);
  // Return the first occurrence that starts after `after`
  for (const occ of occurrences) {
    if (occ.startTime > after) return occ;
  }
  return null;
}
