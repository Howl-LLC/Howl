// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Multi-role permission resolution with server-level @everyone baseline.
 *
 * Effective permissions for a member = union across all their assigned roles
 * (via MemberRole) ∪ the server's @everyone role. Any role with
 * `administrator: true` grants every permission. Owner bypass (via legacy
 * `ServerMember.role === 'owner'` string) short-circuits everything.
 *
 * Channel resolution order (most specific wins):
 *   1. Owner / administrator bypass
 *   2. Channel MEMBER override (explicit true/false wins outright)
 *   3. Channel ROLE overrides for all member's roles — Discord collapse rule:
 *      any false at this tier beats any true at this tier
 *   4. Channel @everyone override
 *   5. Category MEMBER override
 *   6. Category ROLE overrides (same collapse)
 *   7. Category @everyone override
 *   8. Server base: unionPerms(everyoneRole, ...memberRoles)[key] === true
 *
 * Tri-state on overrides: true = allow, false = deny, null/undefined = inherit.
 */

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { getCachedPermissionContext, setCachedPermissionContext } from '../redis.js';

const log = logger.child({ module: 'permissions' });

export type RoleLike = {
  id: string;
  position: number;
  permissions?: unknown;
  isEveryone?: boolean;
};

export type MemberLike = {
  userId: string;
  role?: string | null; // legacy string; 'owner' short-circuits
};

export type PermissionOverride = {
  targetType: string; // 'role' | 'member'
  targetId: string;
  permissions: unknown; // Record<string, boolean | null>
};

export interface PermissionContext {
  member: MemberLike;
  roles: RoleLike[]; // explicit MemberRole roles (excludes @everyone)
  everyoneRole: RoleLike | null; // null only in pathological pre-migration state
}

/**
 * Extended context that retains the full Prisma member row for callers that
 * need additional fields (isTemporary, timeoutUntil, nickname, etc.).
 */
export interface LoadedPermissionContext extends PermissionContext {
  rawMember: {
    userId: string;
    serverId: string;
    role: string;
    roleId: string | null;
    joinedAt: Date;
    nickname: string | null;
    serverAvatar: string | null;
    serverBanner: string | null;
    allowDirectMessages: boolean | null;
    shareActivity: boolean | null;
    isTemporary: boolean;
    serverMuted: boolean;
    serverDeafened: boolean;
    timeoutUntil: Date | null;
    timeoutReason: string | null;
    timedOutById: string | null;
  };
}

/**
 * Load a fresh permission context: member, all assigned roles, plus @everyone.
 * Returns null if the member does not belong to the server.
 *
 * Caching: backed by Redis with a 5-min TTL backstop and pubsub-driven cross-
 * replica invalidation (see `redis.ts` PERMS_INVALIDATION_CHANNEL). Every
 * permission-affecting mutation (role assignment, ban, kick, timeout, profile
 * edit, etc.) explicitly invalidates the (serverId, userId) tuple so cache
 * staleness is bounded by network propagation, not the TTL.
 *
 * Caveat: `rawMember.timeoutUntil` is time-sensitive — with a 300s TTL, a
 * timeout that expires mid-window will appear active for up to 5 min after
 * its real expiry on a cache hit. This is acceptable for the intended use
 * (moderation tooling / channel access checks); callers needing wall-clock
 * accuracy should bypass the cache.
 */
export async function loadPermissionContext(
  userId: string,
  serverId: string,
): Promise<LoadedPermissionContext | null> {
  // Cache lookup — only Redis hits when REDIS_URL is configured; no-op otherwise.
  const cached = (await getCachedPermissionContext(serverId, userId)) as
    | (Omit<LoadedPermissionContext, 'rawMember'> & {
        rawMember: Omit<LoadedPermissionContext['rawMember'], 'joinedAt' | 'timeoutUntil'> & {
          joinedAt: string;
          timeoutUntil: string | null;
        };
      })
    | null;
  if (cached) {
    return {
      ...cached,
      rawMember: {
        ...cached.rawMember,
        joinedAt: new Date(cached.rawMember.joinedAt),
        timeoutUntil: cached.rawMember.timeoutUntil ? new Date(cached.rawMember.timeoutUntil) : null,
      },
    };
  }

  const [member, everyoneRole] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId, serverId } },
      include: {
        memberRoles: {
          include: { role: true },
        },
      },
    }),
    prisma.serverRole.findFirst({
      where: { serverId, isEveryone: true },
      select: { id: true, position: true, permissions: true, isEveryone: true },
    }),
  ]);

  if (!member) return null;

  if (!everyoneRole) {
    log.warn({ serverId }, 'server has no @everyone role — falling back to empty baseline');
  }

  const roles: RoleLike[] = member.memberRoles.map((mr) => ({
    id: mr.role.id,
    position: mr.role.position,
    permissions: mr.role.permissions,
    isEveryone: mr.role.isEveryone,
  }));

  const { memberRoles: _mr, ...rawMember } = member;

  const ctx: LoadedPermissionContext = {
    member: { userId: member.userId, role: member.role },
    roles,
    everyoneRole,
    rawMember,
  };

  // Fire-and-forget cache write — failure must never block the request path.
  void setCachedPermissionContext(serverId, userId, ctx);

  return ctx;
}

/**
 * Union permissions across roles. If any role has `administrator: true`,
 * returns the administrator sentinel (every permission true at read time).
 */
export function unionPerms(roles: Array<RoleLike | null | undefined>): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const r of roles) {
    if (!r) continue;
    const p = (r.permissions as Record<string, boolean> | null) ?? {};
    if (p.administrator === true) {
      // Short-circuit: administrator => all permissions. We still return the
      // `administrator: true` flag so callers can check it explicitly if they
      // want; per-key reads will use the checker functions.
      result.administrator = true;
    }
    for (const [k, v] of Object.entries(p)) {
      if (v === true) result[k] = true;
    }
  }
  return result;
}

function effectiveRoles(ctx: PermissionContext): RoleLike[] {
  return ctx.everyoneRole ? [ctx.everyoneRole, ...ctx.roles] : ctx.roles;
}

/**
 * Narrow a value to PermissionContext vs. legacy member.
 */
function isContext(v: unknown): v is PermissionContext {
  return (
    typeof v === 'object' &&
    v !== null &&
    'roles' in v &&
    Array.isArray((v as { roles: unknown }).roles) &&
    'member' in v
  );
}

/**
 * Legacy member shape that backend routes load with `include: { serverRole: true }`.
 * Callers may optionally also include `memberRoles: { include: { role: true } }`
 * for true multi-role resolution. @everyone is always passed explicitly for
 * server-wide baseline.
 */
export type LegacyMember = {
  userId: string;
  role?: string | null;
  serverRole?: { id?: string; position?: number; permissions?: unknown; isEveryone?: boolean } | null;
  memberRoles?: Array<{ role: { id: string; position: number; permissions: unknown; isEveryone: boolean } }>;
};

function ctxFromLegacy(member: LegacyMember, everyoneRole?: RoleLike | null): PermissionContext {
  let roles: RoleLike[];
  if (member.memberRoles && member.memberRoles.length > 0) {
    // Multi-role: filter out @everyone (applied separately) to prevent double-counting.
    roles = member.memberRoles
      .map((mr) => mr.role)
      .filter((r) => !r.isEveryone)
      .map((r) => ({ id: r.id, position: r.position, permissions: r.permissions, isEveryone: r.isEveryone }));
  } else if (member.serverRole) {
    // Single-role legacy fallback.
    const sr = member.serverRole;
    roles = sr.isEveryone
      ? []
      : [{ id: sr.id ?? '', position: sr.position ?? 0, permissions: sr.permissions, isEveryone: false }];
  } else {
    roles = [];
  }
  return {
    member: { userId: member.userId, role: member.role ?? null },
    roles,
    everyoneRole: everyoneRole ?? null,
  };
}

/**
 * Server-level permission check. Accepts either a pre-built PermissionContext,
 * a legacy member object (with optional everyoneRole), or null (returns false).
 * Owner / administrator bypass, else union check across all applicable roles ∪ @everyone.
 */
export function hasPermission(
  ctxOrMember: PermissionContext | LegacyMember | null | undefined,
  permission: string,
  everyoneRole?: RoleLike | null,
): boolean {
  if (!ctxOrMember) return false;
  const ctx = isContext(ctxOrMember) ? ctxOrMember : ctxFromLegacy(ctxOrMember, everyoneRole);
  if (ctx.member.role?.toLowerCase() === 'owner') return true;
  const all = effectiveRoles(ctx);
  for (const r of all) {
    const p = (r.permissions as Record<string, boolean> | null) ?? {};
    if (p.administrator === true) return true;
  }
  for (const r of all) {
    const p = (r.permissions as Record<string, boolean> | null) ?? {};
    if (p[permission] === true) return true;
  }
  return false;
}

/** Can this member see hidden roles? Reuses manageRoles (no new permission).
 *  Owner / administrator / manageRoles qualify. DISPLAY gate only — never
 *  affects permission computation. */
export function canSeeHiddenRoles(
  ctxOrMember: PermissionContext | LegacyMember | null | undefined,
  everyoneRole?: RoleLike | null,
): boolean {
  return hasPermission(ctxOrMember, 'manageRoles', everyoneRole);
}

/**
 * Channel-level permission check. Accepts either a PermissionContext or a
 * legacy member object (with optional everyoneRole). Walks the override chain
 * per the Discord collapse rule (any deny at the role-override tier wins over
 * any allow at the same tier; member overrides still override role denies).
 */
export function hasChannelPermission(
  ctxOrMember: PermissionContext | LegacyMember | null | undefined,
  permission: string,
  channelOverrides: PermissionOverride[],
  categoryOverrides: PermissionOverride[],
  everyoneRole?: RoleLike | null,
  options?: { requireOverride?: boolean },
): boolean {
  if (!ctxOrMember) return false;
  const ctx = isContext(ctxOrMember) ? ctxOrMember : ctxFromLegacy(ctxOrMember, everyoneRole);
  if (ctx.member.role?.toLowerCase() === 'owner') return true;

  // Administrator bypass from any role.
  const all = effectiveRoles(ctx);
  for (const r of all) {
    const p = (r.permissions as Record<string, boolean> | null) ?? {};
    if (p.administrator === true) return true;
  }

  const roleIds = new Set(ctx.roles.map((r) => r.id));
  const everyoneId = ctx.everyoneRole?.id;

  const walkTier = (overrides: PermissionOverride[]): boolean | null => {
    // 1. Channel/Category @everyone override FIRST (lowest precedence at this tier
    //    so it can be overridden by role/member overrides below). We check it
    //    here just to surface a starting value — actual precedence is applied
    //    by returning only when the chain settles.
    // 2. Role overrides (collapse: deny wins over allow).
    // 3. Member override (highest precedence within the tier).

    // Member override — absolute winner at this tier.
    const memberOvr = overrides.find((o) => o.targetType === 'member' && o.targetId === ctx.member.userId);
    if (memberOvr) {
      const val = (memberOvr.permissions as Record<string, boolean | null>)?.[permission];
      if (val === true) return true;
      if (val === false) return false;
    }

    // Role overrides for all member's roles: any false beats any true.
    let roleAllow = false;
    let roleDeny = false;
    for (const o of overrides) {
      if (o.targetType !== 'role') continue;
      if (!roleIds.has(o.targetId)) continue;
      const val = (o.permissions as Record<string, boolean | null>)?.[permission];
      if (val === true) roleAllow = true;
      else if (val === false) roleDeny = true;
    }
    if (roleDeny) return false;
    if (roleAllow) return true;

    // @everyone override for the tier (string 'everyone' OR real @everyone role id).
    const everyoneOvr = overrides.find(
      (o) => o.targetType === 'role' && (o.targetId === 'everyone' || (everyoneId && o.targetId === everyoneId)),
    );
    if (everyoneOvr) {
      const val = (everyoneOvr.permissions as Record<string, boolean | null>)?.[permission];
      if (val === true) return true;
      if (val === false) return false;
    }

    return null; // inherit / pass to next tier
  };

  const chResult = walkTier(channelOverrides);
  if (chResult !== null) return chResult;

  const catResult = walkTier(categoryOverrides);
  if (catResult !== null) return catResult;

  // `requireOverride` mode: caller wants the answer to come strictly from a
  // channel- or category-tier override (not from the server base). This is
  // used to gate private-channel `viewChannels` — private channels require an
  // EXPLICIT grant in the override chain; inheriting from the server's
  // @everyone baseline would defeat the point of marking a channel private.
  if (options?.requireOverride) return false;

  // Server base: union across @everyone + member's roles.
  const merged = unionPerms(all);
  return merged[permission] === true;
}

/**
 * Convenience: can this member view a specific channel?
 * Public channels are always visible. Private channels require viewChannels.
 */
export function canViewChannel(
  ctxOrMember: PermissionContext | LegacyMember | null | undefined,
  channel: { isPrivate: boolean },
  channelOverrides: PermissionOverride[],
  categoryOverrides: PermissionOverride[],
  everyoneRole?: RoleLike | null,
): boolean {
  if (!channel.isPrivate) return true;
  return hasChannelPermission(ctxOrMember, 'viewChannels', channelOverrides, categoryOverrides, everyoneRole, { requireOverride: true });
}

/**
 * Async wrapper for call sites that just have userId+serverId. Loads the
 * context on demand. Used by socket handlers (stages, threads) that prefer a
 * single-shot helper over manual context loading.
 */
export async function memberHasPermission(userId: string, serverId: string, permission: string): Promise<boolean> {
  const ctx = await loadPermissionContext(userId, serverId);
  if (!ctx) return false;
  return hasPermission(ctx, permission);
}

/**
 * Compute the member's effective permissions as a plain object for transport
 * to the client (Server.myPermissions). Includes @everyone baseline.
 */
export function computeMyPermissions(ctx: PermissionContext): Record<string, boolean> {
  if (ctx.member.role?.toLowerCase() === 'owner') return ALL_PERMISSIONS_GRANTED;
  const merged = unionPerms(effectiveRoles(ctx));
  if (merged.administrator === true) return ALL_PERMISSIONS_GRANTED;
  return merged;
}

/**
 * Sentinel object representing "every permission granted" for owner/administrator
 * response shaping. Built lazily from VALID_PERMISSIONS to stay in sync.
 */
import { VALID_PERMISSIONS } from '../schemas.js';
export const ALL_PERMISSIONS_GRANTED: Record<string, boolean> = Object.freeze(
  Object.fromEntries(VALID_PERMISSIONS.map((k) => [k, true])),
) as Record<string, boolean>;

/**
 * Effective hierarchy position for a member, computed from their
 * PermissionContext. Howl's convention: LOWER number = HIGHER authority.
 * A member's effective position is their HIGHEST-authority role, i.e. the
 * minimum position across all explicit roles (excluding @everyone, which is
 * the implicit baseline and not meaningful for hierarchy gating).
 *
 * Members with no explicit roles (e.g. the server owner, or a freshly joined
 * member with no role assignments) return `Infinity` — the correct neutral
 * fallback so `targetPosition <= actorPosition` comparisons do not treat a
 * role-less member as top authority (position 0 is Owner, not "no role").
 *
 * Canonical hierarchy check:
 *   if (targetPosition <= actorPosition) return 403; // target equal-or-higher
 * Combine with a server-owner short-circuit so owners can act on anyone.
 */
export function effectivePosition(ctx: PermissionContext): number {
  if (ctx.roles.length === 0) return Infinity;
  return Math.min(...ctx.roles.map((r) => r.position ?? Infinity));
}

/**
 * Pick the "display role" for a member: highest-hoisted role, else highest-
 * position explicit role, else null. Used to derive ServerMember.role string
 * and Server.myRole for badge/color rendering.
 *
 * Howl's position convention: LOWER number = HIGHER authority. So "highest"
 * for display purposes means the role closest to Owner, i.e. MIN position.
 */
export function pickDisplayRole(roles: Array<{
  id: string;
  name: string;
  color: string;
  style: string;
  position: number;
  displaySeparately: boolean;
  isEveryone?: boolean;
}>): { id: string; name: string; color: string; style: string; position: number; displaySeparately: boolean } | null {
  const candidates = roles.filter((r) => !r.isEveryone);
  if (candidates.length === 0) return null;
  const hoisted = candidates.filter((r) => r.displaySeparately);
  const pool = hoisted.length > 0 ? hoisted : candidates;
  return pool.reduce((best, r) => (r.position < best.position ? r : best), pool[0]);
}
