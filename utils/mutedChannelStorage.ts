// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Persist mute state for server channels (text/voice) with duration, like Mute Server / DM mute.
 * Muted channels can be hidden or shown with muted styling; unread dots can respect mute.
 */

export type ChannelMuteDuration = '15m' | '1h' | '3h' | '8h' | '24h' | 'forever';

const MUTED_CHANNELS_KEY = 'howl_muted_server_channels';

export function muteDurationToUntil(d: ChannelMuteDuration): number | null {
  const now = Date.now();
  if (d === 'forever') return null;
  const ms: Record<Exclude<ChannelMuteDuration, 'forever'>, number> = {
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '3h': 3 * 60 * 60 * 1000,
    '8h': 8 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
  };
  return now + ms[d];
}

/** { channelId: { until: number | null } } */
function getMutedMap(): Record<string, { until: number | null }> {
  try {
    const raw = localStorage.getItem(MUTED_CHANNELS_KEY);
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

function setMutedMap(map: Record<string, { until: number | null }>) {
  localStorage.setItem(MUTED_CHANNELS_KEY, JSON.stringify(map));
}

export function isChannelMuted(channelId: string): boolean {
  const map = getMutedMap();
  const entry = map[channelId];
  return !!entry && (entry.until === null || entry.until > Date.now());
}

export function setChannelMutedForDuration(channelId: string, duration: ChannelMuteDuration): void {
  const map = getMutedMap();
  map[channelId] = { until: muteDurationToUntil(duration) };
  setMutedMap(map);
}

export function unmuteChannel(channelId: string): void {
  const map = getMutedMap();
  delete map[channelId];
  setMutedMap(map);
}
