// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Format elapsed time since an activity started.
 * Returns short human-readable strings: "1m", "15m", "1h 30m", "3h", "12h+".
 */
export function formatActivityElapsed(startedAt: string): string {
  const start = new Date(startedAt).getTime();
  if (isNaN(start)) return '';
  const diffMs = Date.now() - start;
  if (diffMs < 60_000) return '<1m';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hours >= 12) return '12h+';
  if (remainMins === 0) return `${hours}h`;
  return `${hours}h ${remainMins}m`;
}
