// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Persist mute state for DM channels (1:1 and group), similar to server mute.
 * Used so "Mute Conversation" in DM context menu actually mutes and unread badge can respect it.
 */

export type MuteDuration = '15m' | '1h' | '3h' | '8h' | '24h' | 'forever';

const MUTED_DMS_KEY = 'howl_muted_dms';

export function muteDurationToUntil(d: MuteDuration): number | null {
  const now = Date.now();
  if (d === 'forever') return null;
  const ms = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000, '3h': 3 * 60 * 60 * 1000, '8h': 8 * 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 }[d];
  return now + ms;
}

/** { dmChannelId: { until: timestamp | null } } */
export function getMutedDmsMap(): Record<string, { until: number | null }> {
  try {
    const raw = localStorage.getItem(MUTED_DMS_KEY);
    const parsed: Record<string, { until: number | null }> = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    const pruned: Record<string, { until: number | null }> = {};
    for (const [id, v] of Object.entries(parsed)) {
      if (v.until === null || v.until > now) pruned[id] = v;
    }
    return pruned;
  } catch {
    return {};
  }
}

export function setMutedDmsMap(map: Record<string, { until: number | null }>) {
  localStorage.setItem(MUTED_DMS_KEY, JSON.stringify(map));
}

export function setDmMuted(dmChannelId: string, until: number | null) {
  const map = getMutedDmsMap();
  map[dmChannelId] = { until };
  setMutedDmsMap(map);
}

export function setDmUnmuted(dmChannelId: string) {
  const map = getMutedDmsMap();
  delete map[dmChannelId];
  setMutedDmsMap(map);
}

export function isDmChannelMuted(dmChannelId: string): boolean {
  const map = getMutedDmsMap();
  const entry = map[dmChannelId];
  return !!entry && (entry.until === null || entry.until > Date.now());
}

/** Unread DM channel IDs that are not muted (for badge count). */
export function filterUnreadByMutedDms(unreadDmChannelIds: string[]): string[] {
  return unreadDmChannelIds.filter((id) => !isDmChannelMuted(id));
}
