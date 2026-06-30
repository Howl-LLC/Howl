// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/** Shared status-color map using CSS custom properties. */
export const STATUS_COLORS: Record<string, string> = {
  online: 'var(--status-online)',
  idle: 'var(--status-idle)',
  dnd: 'var(--status-dnd)',
  invisible: 'var(--status-offline)',
  offline: 'var(--status-offline)',
};
