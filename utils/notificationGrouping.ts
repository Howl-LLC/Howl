// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { ServerNotification } from '../types';

const MAX_GROUPED_NOTIFICATIONS = 15;

export function formatUserList(usernames: string[]): string {
  if (usernames.length === 0) return 'Someone';
  if (usernames.length === 1) return usernames[0];
  if (usernames.length === 2) return `${usernames[0]} and ${usernames[1]}`;
  if (usernames.length === 3) return `${usernames[0]}, ${usernames[1]}, and ${usernames[2]}`;
  return `${usernames[0]}, ${usernames[1]}, and ${usernames.length - 2} others`;
}

export function buildGroupMessage(
  type: ServerNotification['type'],
  channelName: string,
  usernames: string[],
  count: number,
): string {
  if (type === 'text_activity') {
    return count <= 1 ? `New message in #${channelName}` : `${count} new messages in #${channelName}`;
  }
  const verb = type === 'voice_join' ? 'joined' : 'left';
  return `${formatUserList(usernames)} ${verb} ${channelName}`;
}

export interface UpsertNotificationOpts {
  groupKey: string;
  type: ServerNotification['type'];
  username: string | null;
  channelName: string;
}

export function upsertGroupedNotification(
  notifications: ServerNotification[],
  opts: UpsertNotificationOpts,
): ServerNotification[] {
  const { groupKey, type, username, channelName } = opts;
  const existing = notifications.find((n) => n.groupKey === groupKey);

  if (existing) {
    const usernames = existing.usernames ? [...existing.usernames] : [];
    if (username && !usernames.includes(username)) {
      usernames.push(username);
    }
    const count = (existing.count ?? 1) + 1;
    const message = buildGroupMessage(type, channelName, usernames, count);
    const filtered = notifications.filter((n) => n.groupKey !== groupKey);
    return [...filtered, { ...existing, usernames, count, message, timestamp: Date.now() }];
  }

  const usernames = username ? [username] : [];
  const message = buildGroupMessage(type, channelName, usernames, 1);
  const id = `${groupKey}-${Date.now()}`;
  const next = [
    ...notifications,
    { id, type, message, timestamp: Date.now(), groupKey, usernames, channelName, count: 1 },
  ];
  if (next.length > MAX_GROUPED_NOTIFICATIONS) {
    return next.slice(next.length - MAX_GROUPED_NOTIFICATIONS);
  }
  return next;
}
