// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Per-channel notification level (All Messages / Only @mentions / Nothing).
 * Used in text channel context menu "Notification settings" submenu.
 */

const STORAGE_KEY_BASE = 'howl_channel_notification_settings';

export type ChannelNotificationLevel = 'all' | 'mentions' | 'none';

const DEFAULTS: ChannelNotificationLevel = 'all';

function storageKey(userId?: string): string {
  return userId ? `${userId}:${STORAGE_KEY_BASE}` : STORAGE_KEY_BASE;
}

export function getChannelNotificationLevel(channelId: string, userId?: string): ChannelNotificationLevel {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    const data: Record<string, ChannelNotificationLevel> = raw ? JSON.parse(raw) : {};
    const v = data[channelId];
    return v === 'mentions' || v === 'none' ? v : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function setChannelNotificationLevel(channelId: string, level: ChannelNotificationLevel, userId?: string): void {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    const data: Record<string, ChannelNotificationLevel> = raw ? JSON.parse(raw) : {};
    data[channelId] = level;
    localStorage.setItem(storageKey(userId), JSON.stringify(data));
  } catch { /* storage unavailable */ }
}
