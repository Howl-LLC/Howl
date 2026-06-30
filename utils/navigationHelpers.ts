// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Navigation helper utilities.
 * Shared guard for distinguishing real server UUIDs from special navigation targets.
 */

const SPECIAL_NAV_IDS = new Set(['home', 'dm', 'friends', 'account', 'notifications', 'discover']);

/** Returns true if `id` is a real server UUID (not a special navigation target). */
export function isRealServerId(id: string | null | undefined): id is string {
  if (!id) return false;
  return !SPECIAL_NAV_IDS.has(id);
}
