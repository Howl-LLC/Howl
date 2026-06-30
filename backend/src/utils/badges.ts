// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Compute the full badges array for a user by merging DB-stored badges
 * with auto-detected badges (subscription plan).
 *
 * Badge keys:
 *  - "beta"           — manually assigned (stored in DB)
 *  - "pro_essential"  — auto-detected from effective plan === 'essential'
 *  - "pro"            — auto-detected from effective plan === 'pro'
 */

import { getEffectivePlan } from '../utils.js';
import { BADGE_KEYS } from './badgeKeys.js';

const BETA_CUTOFF = new Date(process.env.BETA_CUTOFF_DATE || '2026-12-31T23:59:59Z');

// Re-exported from the dependency-free leaf module to preserve the existing
// `import { BADGE_KEYS } from '../utils/badges.js'` API surface.
export { BADGE_KEYS };

/**
 * Badges that admins can manually grant or revoke via the admin panel.
 * Auto-computed badges (pro, pro_essential) cannot be manually managed.
 */
export const ADMIN_GRANTABLE_BADGES = new Set([
  'beta', 'staff', 'bug_hunter', 'early_supporter', 'verified',
]);

export function computeBadges(user: {
  badges?: string[];
  stripePlan?: string | null;
  stripeStatus?: string | null;
  stripePeriodEnd?: Date | null;
  stripeSubscriptionId?: string | null;
  createdAt?: Date | string | null;
}): string[] {
  const set = new Set<string>(user.badges ?? []);

  if (user.createdAt) {
    const created = typeof user.createdAt === 'string' ? new Date(user.createdAt) : user.createdAt;
    if (created <= BETA_CUTOFF) set.add('beta');
  }

  const plan = getEffectivePlan(user);
  if (plan === 'essential') set.add('pro_essential');
  if (plan === 'pro') set.add('pro');

  return Array.from(set);
}

/**
 * Defensively parse the untyped Prisma `badgeDisplay` Json column. Any malformed
 * shape (non-object, missing/non-array fields, non-string entries) degrades to
 * "no preferences" and never throws.
 */
function parseBadgeDisplay(raw: unknown): { hidden: Set<string>; order: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { hidden: new Set(), order: [] };
  }
  const obj = raw as { hidden?: unknown; order?: unknown };
  const hidden = Array.isArray(obj.hidden)
    ? obj.hidden.filter((x): x is string => typeof x === 'string')
    : [];
  const order = Array.isArray(obj.order)
    ? obj.order.filter((x): x is string => typeof x === 'string')
    : [];
  return { hidden: new Set(hidden), order };
}

/**
 * User-facing badge list: the genuine earned set (computeBadges) minus the
 * user's hidden deny-list, reordered by their `order` preference (canonical
 * default order for the remainder). Returns [] when the master `showBadges`
 * switch is off.
 *
 * Truth gate: `earned` is recomputed independently, so preferences can only
 * ever filter and reorder genuine badges - never surface an unearned one.
 * For self-views and the admin panel, use computeBadges (raw) instead.
 */
export function applyBadgePrefs(user: {
  badges?: string[];
  showBadges?: boolean | null;
  badgeDisplay?: unknown;
  stripePlan?: string | null;
  stripeStatus?: string | null;
  stripePeriodEnd?: Date | null;
  stripeSubscriptionId?: string | null;
  createdAt?: Date | string | null;
}): string[] {
  if (user.showBadges === false) return [];
  const earned = computeBadges(user);
  const { hidden, order } = parseBadgeDisplay(user.badgeDisplay);
  const visible = new Set(earned.filter((b) => !hidden.has(b)));
  const result: string[] = [];
  const push = (k: string) => { if (visible.has(k) && !result.includes(k)) result.push(k); };
  for (const k of order) push(k);        // user-preferred order first
  for (const k of BADGE_KEYS) push(k);   // canonical default for the rest
  for (const k of earned) push(k);       // any unknown earned key, in earned order
  return result;
}
