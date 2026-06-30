// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Activity source priority utilities.
 *
 * Determines whether a new activity should overwrite an existing one
 * based on the user's activitySourcePriority setting. Used by both
 * polling services and the socket set-activity handler to prevent
 * lower-priority sources from overwriting higher-priority ones.
 */

// Maps activity type → source name in the priority string
const SOURCE_MAP: Record<string, string> = {
  steam_game: 'steam',
  spotify: 'spotify',
  detected_game: 'detected',
  custom: 'custom',
  twitch_live: 'twitch',
  youtube_live: 'youtube',
};

const DEFAULT_PRIORITY = 'custom,twitch,youtube,steam,spotify,detected,bio';

/**
 * Returns the priority index for an activity type (lower = higher priority).
 * Returns Infinity if the type isn't in the priority list.
 */
function getPriorityIndex(activityType: string, priorityStr: string): number {
  const source = SOURCE_MAP[activityType];
  if (!source) return Infinity;
  const priorities = (priorityStr || DEFAULT_PRIORITY).split(',');
  const idx = priorities.indexOf(source);
  return idx === -1 ? Infinity : idx;
}

/**
 * Check if a new activity type should overwrite an existing one.
 *
 * Rules:
 * - If no existing activity: always write
 * - If new type has equal or higher priority (lower or equal index): overwrite
 * - If new type has lower priority (higher index): skip
 *
 * "Equal priority" overwrites because it means the same source is updating
 * (e.g., Spotify poll updating the current Spotify track).
 */
export function shouldOverwriteActivity(
  newType: string,
  existingType: string | null | undefined,
  priorityStr: string | null | undefined,
): boolean {
  if (!existingType) return true;
  const priority = priorityStr || DEFAULT_PRIORITY;
  const newIdx = getPriorityIndex(newType, priority);
  const existIdx = getPriorityIndex(existingType, priority);
  return newIdx <= existIdx;
}
