// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { Request } from 'express';
import { Prisma } from '../generated/prisma-client-v7/client.js';
import { isAllPro } from './selfHost.js';

/**
 * Safe subset of User fields that can be sent to other users.
 * NEVER include passwordHash, mfaTotpSecret, mfaRecoveryCodes,
 * email, emailVerifyCode, passwordResetCode, stripeCustomerId,
 * stripeSubscriptionId, mfaPhone, or session data.
 */
export const PUBLIC_USER_SELECT = {
  id: true,
  username: true,
  discriminator: true,
  avatar: true,
  banner: true,
  bannerPositionY: true,
  bannerZoom: true,
  status: true,
  createdAt: true,
  badges: true,
  showBadges: true,
  badgeDisplay: true,
  nameColor: true,
  nameFont: true,
  nameEffect: true,
  avatarEffect: true,
} satisfies Prisma.UserSelect;

/**
 * Extended select for author/display contexts where stripePlan
 * is needed for cosmetic features (badges, name effects, etc.).
 * Do NOT use for member lists or other contexts where billing info
 * should not be exposed to other users.
 */
export const AUTHOR_USER_SELECT = {
  ...PUBLIC_USER_SELECT,
  stripePlan: true,
  stripeStatus: true,
  stripePeriodEnd: true,
  stripeSubscriptionId: true,
  showJoinDate: true,
  showBadges: true,
} satisfies Prisma.UserSelect;

/**
 * Validate a URL to prevent SSRF attacks.
 * Only allows http/https with non-internal hostnames.
 */
export function isSafeExternalUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') return false;
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    const parts = hostname.split('.');
    if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
      const [a, b] = parts.map(Number);
      if (a === 10) return false;
      if (a === 172 && b !== undefined && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
      if (a === 169 && b === 254) return false;
      if (a === 0) return false;
    }
    if (hostname.startsWith('[') || hostname.includes(':')) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the user's effective plan, accounting for expiry.
 * If the plan period has ended and there's no active Stripe subscription, returns 'free'.
 */
export function getEffectivePlan(user: {
  stripePlan?: string | null;
  stripeStatus?: string | null;
  stripePeriodEnd?: Date | null;
  stripeSubscriptionId?: string | null;
}): string {
  // Self-host unlocks every Pro feature for free via the single plan choke point.
  if (isAllPro()) return 'pro';
  if (!user.stripePlan) return 'free';
  if (user.stripeStatus === 'disputed') return 'free';
  // Admin-granted plans that have expired downgrade to free.
  if (user.stripeStatus === 'admin_granted' && user.stripePeriodEnd && user.stripePeriodEnd < new Date() && !user.stripeSubscriptionId) {
    return 'free';
  }
  // Admin-set timed plans write stripeStatus = 'active' + a stripePeriodEnd
  // but leave stripeSubscriptionId null. Those need the same expiry gate as
  // admin_granted — otherwise the plan reads as active past its end date
  // until the nightly cleanup cron runs.
  if (user.stripeStatus === 'active' && !user.stripeSubscriptionId && user.stripePeriodEnd && user.stripePeriodEnd < new Date()) {
    return 'free';
  }
  if (user.stripeStatus === 'active' || user.stripeStatus === 'admin_granted') return user.stripePlan;
  if (user.stripeStatus === 'trialing') return user.stripePlan!;
  if (user.stripePeriodEnd && user.stripePeriodEnd > new Date()) return user.stripePlan;
  return 'free';
}

/** Get a single route param as string (Express/Node can type params as string | string[]). */
export function getParam(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

// Permission helpers moved to ./utils/permissions.ts with multi-role + @everyone
// baseline semantics. Re-exported here so existing imports keep resolving.
export {
  hasPermission,
  hasChannelPermission,
  canViewChannel,
  loadPermissionContext,
  memberHasPermission,
  unionPerms,
  computeMyPermissions,
  pickDisplayRole,
  effectivePosition,
  canSeeHiddenRoles,
  ALL_PERMISSIONS_GRANTED,
} from './utils/permissions.js';
export type { PermissionContext, LoadedPermissionContext, RoleLike, MemberLike, PermissionOverride } from './utils/permissions.js';

/**
 * Check if a server member is currently timed out (lazy expiry -- no background job needed).
 * Returns true only when `timeoutUntil` is set and still in the future.
 */
export function isMemberTimedOut(member: { timeoutUntil?: Date | null }): boolean {
  if (!member.timeoutUntil) return false;
  return member.timeoutUntil.getTime() > Date.now();
}

/**
 * Compute the number of seconds remaining on a timeout.
 * Returns 0 if the timeout is expired or not set.
 */
export function timeoutRetryAfterSeconds(member: { timeoutUntil?: Date | null }): number {
  if (!member.timeoutUntil) return 0;
  const remaining = Math.ceil((member.timeoutUntil.getTime() - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
}
