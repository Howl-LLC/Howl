// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Per-server notification settings (used by Sidebar context menu submenu and ChannelList modal).
 */

const STORAGE_KEY_BASE = 'howl_server_notification_settings';

export type ServerNotificationLevel = 'all' | 'mentions' | 'none';

export interface ServerNotificationSettings {
  level: ServerNotificationLevel;
  suppressEveryone: boolean;
  suppressRoleMentions: boolean;
  suppressHighlights: boolean;
  muteNewEvents: boolean;
  mobilePush: boolean;
}

const DEFAULTS: ServerNotificationSettings = {
  level: 'all',
  suppressEveryone: false,
  suppressRoleMentions: false,
  suppressHighlights: false,
  muteNewEvents: false,
  mobilePush: true,
};

function storageKey(userId?: string): string {
  return userId ? `${userId}:${STORAGE_KEY_BASE}` : STORAGE_KEY_BASE;
}

export function getServerNotificationSettings(serverId: string, userId?: string): ServerNotificationSettings {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    const data = raw ? (JSON.parse(raw) as Record<string, Partial<ServerNotificationSettings>>) : {};
    return { ...DEFAULTS, ...data[serverId] };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setServerNotificationSettings(serverId: string, prefs: ServerNotificationSettings, userId?: string) {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    const data = raw ? (JSON.parse(raw) as Record<string, ServerNotificationSettings>) : {};
    data[serverId] = prefs;
    localStorage.setItem(storageKey(userId), JSON.stringify(data));
  } catch { /* storage unavailable */ }
}

export function setServerNotificationLevel(serverId: string, level: ServerNotificationLevel, userId?: string) {
  const prefs = getServerNotificationSettings(serverId, userId);
  setServerNotificationSettings(serverId, { ...prefs, level }, userId);
}
