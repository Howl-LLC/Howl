// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Self Roles — picker channel + categories + entries + manual-approval queue.
 *
 * Permission model:
 * - Configure picker (categories, entries, conditions): manageRoles
 * - Self-claim a self-assignable role: any member, gated by per-entry conditions
 * - Submit manual-approval request: any member
 * - Approve/reject requests: manageRoles
 *
 * One picker per server — schema-enforced via @unique on serverId. Channel
 * create checks separately (in routes/servers.ts) for a cleaner 409 with the
 * existing channel id, before the cascade ripple of unique-violation rollback.
 */

import express, { Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { getClientIp } from '../utils/clientIp.js';
import { getParam } from '../utils.js';
import { powerUpTier } from './serverHelpers.js';
import { hasPermission, loadPermissionContext, canSeeHiddenRoles, roleCarriesElevatedGrants } from '../utils/permissions.js';
import { prisma } from '../db.js';
import { redis, invalidatePermissionContext } from '../redis.js';
import {
  updateRolePickerSchema,
  createPickerCategorySchema,
  updatePickerCategorySchema,
  createPickerEntrySchema,
  updatePickerEntrySchema,
  movePickerEntrySchema,
  submitClaimRequestSchema,
  decideClaimRequestSchema,
  listClaimRequestsSchema,
} from '../schemas.js';
import { emitMemberRoleEventScoped } from '../utils/roleEmit.js';
import { evaluateConditions, type ConditionRequirements, type EvaluationContext } from '../utils/conditionEvaluator.js';
import { getMessageCount } from '../utils/messageCountCache.js';
import { logger } from '../logger.js';
import { createAuditLog } from './serverSettings.js';
import { checkUploadAttachment } from '../services/uploadProvenance.js';
import type { Server as IoServer } from 'socket.io';

const log = logger.child({ module: 'rolePickers' });
const router = express.Router({ mergeParams: true });

// Dedicated rate limiter for mutating picker routes, matching the mutation
// limiter the rest of the roles subsystem applies. Placed after
// authenticateToken in each mutating route's chain so it keys by userId
// (IP only for unauthenticated rejects).
const pickerMutationLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:picker-mutate:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

// Per-(user, entry) claim mutex
// Prevents a fast double-click from creating two grants. Redis-first; in-memory
// fallback when Redis isn't configured (single-instance dev).

const localLocks = new Map<string, number>();

async function acquireClaimLock(userId: string, entryId: string): Promise<boolean> {
  const key = `claimlock:${userId}:${entryId}`;
  if (redis) {
    try {
      const result = await redis.set(key, '1', 'EX', 5, 'NX');
      return result === 'OK';
    } catch {
      /* fall through to in-memory */
    }
  }
  // In-memory fallback. Self-expiring via wall-clock check.
  const now = Date.now();
  const existing = localLocks.get(key);
  if (existing && existing > now) return false;
  localLocks.set(key, now + 5000);
  return true;
}

async function releaseClaimLock(userId: string, entryId: string): Promise<void> {
  const key = `claimlock:${userId}:${entryId}`;
  if (redis) {
    try {
      await redis.del(key);
      return;
    } catch {
      /* ignore */
    }
  }
  localLocks.delete(key);
}

// Permission helper
async function requireManageRoles(
  userId: string,
  serverId: string,
  res: Response,
): Promise<boolean> {
  const ctx = await loadPermissionContext(userId, serverId);
  if (!ctx) {
    res.status(403).json({ error: 'Not a member of this server' });
    return false;
  }
  if (!hasPermission(ctx, 'manageRoles')) {
    res.status(403).json({ error: 'You need the Manage Roles permission' });
    return false;
  }
  return true;
}

async function requireMember(
  userId: string,
  serverId: string,
  res: Response,
): Promise<boolean> {
  const ctx = await loadPermissionContext(userId, serverId);
  if (!ctx) {
    res.status(403).json({ error: 'Not a member of this server' });
    return false;
  }
  return true;
}

// Member-roles broadcast
// Mirrors the rich payload that serverRoles.ts emits on admin role-add/remove
// so the frontend's reconcileMemberRoles handler keeps the member list in
// sync. Without `roles` (full id list) and `role` (added role data) the
// reconciler treats the member as if they had no roles — visible as the user
// dropping out of any hoisted section until the next full members refetch.
async function broadcastMemberRolesChanged(
  io: IoServer | undefined,
  serverId: string,
  userId: string,
  opts: { addedRoleId?: string | null; removedRoleId?: string | null },
): Promise<void> {
  if (!io) return;
  const allRoles = await prisma.memberRole.findMany({
    where: { userId, serverId },
    include: {
      role: { select: { id: true, name: true, color: true, style: true, position: true, displaySeparately: true, isEveryone: true, hidden: true } },
    },
  });
  const { pickDisplayRole } = await import('../utils/permissions.js');
  // True display (incl. hidden — what mods see) vs visible-only display (non-mods).
  const trueDisplay = pickDisplayRole(allRoles.map((mr) => mr.role));
  const visibleDisplay = pickDisplayRole(allRoles.filter((mr) => !mr.role.hidden).map((mr) => mr.role));
  const visibleRoleIds = allRoles.filter((mr) => !mr.role.isEveryone && !mr.role.hidden).map((mr) => mr.role.id);
  const allNonEveryoneIds = allRoles.filter((mr) => !mr.role.isEveryone).map((mr) => mr.role.id);

  // The removed role is already gone from `allRoles`; the added role is present.
  // For removal we can't read its hidden flag from `allRoles`, so treat the
  // removed-role case as hidden-involved only via the (re)load below.
  const addedRole = opts.addedRoleId ? allRoles.find((mr) => mr.role.id === opts.addedRoleId)?.role : undefined;
  const removedRole = opts.removedRoleId
    ? await prisma.serverRole.findFirst({ where: { id: opts.removedRoleId, serverId }, select: { hidden: true } })
    : null;
  const displayHidden = trueDisplay ? !!allRoles.find((mr) => mr.role.id === trueDisplay.id)?.role.hidden : false;
  const holdsHidden = allRoles.some((mr) => mr.role.hidden && !mr.role.isEveryone);
  // Any hidden role in play (added/removed/display) OR a still-held hidden role
  // whose id would leak in roles[] forces the scoped (per-mod) emit. Mods keep
  // the full payload; non-mods get the sanitized one.
  const hiddenInvolved = !!addedRole?.hidden || !!removedRole?.hidden || displayHidden || holdsHidden;

  if (opts.addedRoleId) {
    const added = addedRole;
    const rolePayload = added
      ? { id: added.id, name: added.name, color: added.color, style: added.style ?? 'solid', position: added.position, displaySeparately: added.displaySeparately }
      : undefined;
    if (hiddenInvolved) {
      // Cloak any hidden role's metadata + ids from non-mods.
      await emitMemberRoleEventScoped(io, serverId, 'server-member-role-added', {
        full: { serverId, userId, roleId: opts.addedRoleId, role: rolePayload, roles: allNonEveryoneIds },
        sanitized: { serverId, userId, roleId: opts.addedRoleId, role: added?.hidden ? undefined : rolePayload, roles: visibleRoleIds },
      });
    } else {
      io.to(`server:${serverId}`).emit('server-member-role-added', {
        serverId, userId, roleId: opts.addedRoleId,
        role: rolePayload,
        roles: allNonEveryoneIds,
      });
    }
  }

  if (opts.removedRoleId) {
    if (hiddenInvolved) {
      await emitMemberRoleEventScoped(io, serverId, 'server-member-role-removed', {
        full: { serverId, userId, roleId: opts.removedRoleId, roles: allNonEveryoneIds },
        sanitized: { serverId, userId, roleId: opts.removedRoleId, roles: visibleRoleIds },
      });
    } else {
      io.to(`server:${serverId}`).emit('server-member-role-removed', {
        serverId, userId, roleId: opts.removedRoleId,
        roles: allNonEveryoneIds,
      });
    }
  }

  if (trueDisplay) {
    if (hiddenInvolved) {
      await emitMemberRoleEventScoped(io, serverId, 'server-member-role-updated', {
        full: {
          serverId, userId,
          roleId: trueDisplay.id,
          roleName: trueDisplay.name,
          roleColor: trueDisplay.color,
          roleStyle: trueDisplay.style ?? 'solid',
        },
        sanitized: {
          serverId, userId,
          roleId: visibleDisplay?.id ?? null,
          roleName: visibleDisplay?.name ?? 'member',
          roleColor: visibleDisplay?.color ?? '#99aab5',
          roleStyle: visibleDisplay?.style ?? 'solid',
        },
      });
    } else {
      io.to(`server:${serverId}`).emit('server-member-role-updated', {
        serverId, userId,
        roleId: trueDisplay.id,
        roleName: trueDisplay.name,
        roleColor: trueDisplay.color,
        roleStyle: trueDisplay.style ?? 'solid',
      });
    }
  }
}

// Custom icon (server power-up) gate
// Custom role icons unlock when the server reaches power-up tier 1 (2 power-ups).
// Emoji-only roles stay free. The URL must point at our own backend / R2 CDN
// so admins can't link arbitrary external images (privacy + hot-linking).
const ROLE_ICON_MIN_TIER = 1;

async function ensurePowerUpForIconUrl(serverId: string, iconUrl: string | null | undefined, res: Response): Promise<boolean> {
  if (iconUrl == null) return true;
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { powerUpCount: true },
  });
  const tier = powerUpTier(server?.powerUpCount ?? 0);
  if (tier < ROLE_ICON_MIN_TIER) {
    res.status(402).json({
      error: 'Custom role icons unlock at server power-up tier 1. Boost this server to use uploaded images.',
      requiredTier: ROLE_ICON_MIN_TIER,
      currentTier: tier,
    });
    return false;
  }
  if (!isTrustedUploadUrl(iconUrl)) {
    res.status(400).json({ error: 'Icon URL must be a Howl-hosted upload.' });
    return false;
  }
  // A role-picker entry icon is served to every server member and has no
  // image-extension allowlist (so the `.enc` forcing does not cover it).
  // Refuse an encrypted (scan-skipped) DM blob explicitly. Fail-closed on lookup error.
  const prov = await checkUploadAttachment(iconUrl);
  if (!prov.ok) {
    res.status(prov.status).json({ error: prov.error });
    return false;
  }
  return true;
}

function isTrustedUploadUrl(raw: string): boolean {
  // Local-relative upload paths from the upload route.
  if (raw.startsWith('/api/uploads/') || raw.startsWith('/uploads/')) return true;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  const allowed = [
    process.env.PUBLIC_BACKEND_HOST,
    process.env.R2_PUBLIC_HOST,
    process.env.UPLOAD_CDN_HOST,
  ].filter(Boolean).map((h) => h!.toLowerCase());
  if (allowed.length === 0) {
    // In dev/local without explicit host config, accept localhost + r2.dev.
    return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.r2.dev') || host.endsWith('.r2.cloudflarestorage.com');
  }
  return allowed.includes(host);
}

// Picker tree helpers
async function fetchPickerTree(pickerId: string, serverId: string, viewerUserId: string | null) {
  const picker = await prisma.rolePickerChannel.findFirst({
    where: { id: pickerId, serverId },
    include: {
      categories: {
        orderBy: { position: 'asc' },
        include: {
          entries: {
            orderBy: { position: 'asc' },
            include: {
              role: {
                select: {
                  id: true, name: true, color: true, position: true,
                  selfAssignable: true, displaySeparately: true, locked: true,
                  // `hidden` is internal — used only to filter entries out for
                  // non-mod viewers; never included in the returned wire shape.
                  hidden: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!picker) return null;

  // Hidden-role display gate: non-mod viewers must never receive hidden-role
  // entries (the onboarding modal + self-roles UI both render this tree, so a
  // hidden entry here would leak the role's name/color to non-mods). Mods
  // (canSeeHiddenRoles) keep all entries.
  const viewerCanSeeHidden = viewerUserId
    ? canSeeHiddenRoles(await loadPermissionContext(viewerUserId, serverId))
    : false;

  const roleIds = picker.categories.flatMap((c) => c.entries.map((e) => e.roleId));
  const counts = roleIds.length === 0
    ? []
    : await prisma.memberRole.groupBy({
        by: ['roleId'],
        where: { roleId: { in: roleIds } },
        _count: { roleId: true },
      });
  const countByRole = new Map(counts.map((c) => [c.roleId, c._count.roleId]));

  const heldByViewer = viewerUserId && roleIds.length > 0
    ? await prisma.memberRole.findMany({
        where: { userId: viewerUserId, serverId, roleId: { in: roleIds } },
        select: { roleId: true },
      })
    : [];
  const heldSet = new Set(heldByViewer.map((r) => r.roleId));

  const pendingByEntry = viewerUserId && picker.categories.length > 0
    ? await prisma.roleClaimRequest.findMany({
        where: { userId: viewerUserId, serverId, status: 'pending' },
        select: { pickerEntryId: true },
      })
    : [];
  const pendingSet = new Set(pendingByEntry.map((r) => r.pickerEntryId));

  const selfRolesBlocked = viewerUserId
    ? (await prisma.serverRole.findFirst({ where: { serverId, blocksSelfRoles: true, memberRoles: { some: { userId: viewerUserId, serverId } } }, select: { id: true } })) !== null
    : false;

  return {
    id: picker.id,
    channelId: picker.channelId,
    serverId: picker.serverId,
    heroTitle: picker.heroTitle,
    heroDescription: picker.heroDescription,
    selfRolesBlocked,
    categories: picker.categories.map((c) => ({
      id: c.id,
      name: c.name,
      position: c.position,
      pickMode: c.pickMode as 'single' | 'multi',
      required: c.required,
      entries: c.entries
        // Strip hidden-role entries for non-mods (keep all for mods).
        .filter((e) => viewerCanSeeHidden || !e.role.hidden)
        .map((e) => {
          // Drop the internal `hidden` flag — keep the RolePickerTree wire
          // shape unchanged.
          const { hidden: _hidden, ...role } = e.role;
          return {
            id: e.id,
            roleId: e.roleId,
            position: e.position,
            emoji: e.emoji,
            iconUrl: e.iconUrl,
            description: e.description,
            requirements: (e.requirements ?? null) as ConditionRequirements | null,
            memberCount: countByRole.get(e.roleId) ?? 0,
            held: heldSet.has(e.roleId),
            pending: pendingSet.has(e.id),
            role,
          };
        }),
    })),
  };
}

function emitPickerUpdated(io: IoServer | undefined, serverId: string, pickerId: string) {
  if (!io) return;
  io.to(`server:${serverId}`).emit('role-picker-updated', { serverId, pickerId });
}

function emitClaimRequestUpdated(
  io: IoServer | undefined,
  serverId: string,
  applicantUserId: string,
  requestId: string,
  status: string,
) {
  if (!io) return;
  io.to(`server:${serverId}`).emit('role-claim-request-updated', { serverId, requestId, status });
  io.to(`user:${applicantUserId}`).emit('role-claim-request-updated', { serverId, requestId, status });
}

// GET /role-pickers — return server's single picker (or null)
router.get('/', authenticateToken, validateUuidParams('serverId'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const serverId = getParam(req, 'serverId');
  if (!await requireMember(req.userId!, serverId, res)) return;

  const picker = await prisma.rolePickerChannel.findUnique({
    where: { serverId },
    select: {
      id: true, channelId: true, serverId: true, heroTitle: true, heroDescription: true,
      _count: { select: { categories: true } },
    },
  });
  res.json({ picker: picker ?? null });
}));

// GET /role-pickers/:pickerId — full tree
router.get('/:pickerId', authenticateToken, validateUuidParams('serverId', 'pickerId'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const serverId = getParam(req, 'serverId');
  const pickerId = getParam(req, 'pickerId');
  if (!await requireMember(req.userId!, serverId, res)) return;

  const tree = await fetchPickerTree(pickerId, serverId, req.userId!);
  if (!tree) return res.status(404).json({ error: 'Picker not found' });
  res.json(tree);
}));

// PATCH /role-pickers/:pickerId — update hero
router.patch('/:pickerId', authenticateToken, pickerMutationLimiter, validateUuidParams('serverId', 'pickerId'),
  validate(updateRolePickerSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const serverId = getParam(req, 'serverId');
    const pickerId = getParam(req, 'pickerId');
    if (!await requireManageRoles(req.userId!, serverId, res)) return;

    const picker = await prisma.rolePickerChannel.findFirst({ where: { id: pickerId, serverId } });
    if (!picker) return res.status(404).json({ error: 'Picker not found' });

    const { heroTitle, heroDescription } = req.body as { heroTitle?: string | null; heroDescription?: string | null };
    const data: Record<string, string | null> = {};
    if (heroTitle !== undefined) data.heroTitle = heroTitle;
    if (heroDescription !== undefined) data.heroDescription = heroDescription;

    const updated = await prisma.rolePickerChannel.update({
      where: { id: pickerId },
      data,
    });
    await createAuditLog(serverId, req.userId!, 'role_picker_update', 'picker', pickerId, data).catch(() => {});

    emitPickerUpdated(req.app.get('io') as IoServer | undefined, serverId, pickerId);
    res.json({
      id: updated.id,
      channelId: updated.channelId,
      serverId: updated.serverId,
      heroTitle: updated.heroTitle,
      heroDescription: updated.heroDescription,
    });
  }),
);

// POST /role-pickers/:pickerId/categories — create category
router.post('/:pickerId/categories', authenticateToken, pickerMutationLimiter, validateUuidParams('serverId', 'pickerId'),
  validate(createPickerCategorySchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const serverId = getParam(req, 'serverId');
    const pickerId = getParam(req, 'pickerId');
    if (!await requireManageRoles(req.userId!, serverId, res)) return;

    const picker = await prisma.rolePickerChannel.findFirst({ where: { id: pickerId, serverId } });
    if (!picker) return res.status(404).json({ error: 'Picker not found' });

    const { name, pickMode, required } = req.body as { name: string; pickMode: 'single' | 'multi'; required?: boolean };
    const max = await prisma.rolePickerCategory.findFirst({
      where: { pickerId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const cat = await prisma.rolePickerCategory.create({
      data: { pickerId, name, pickMode, required: required ?? false, position: (max?.position ?? -1) + 1 },
    });
    await createAuditLog(serverId, req.userId!, 'role_picker_category_create', 'category', cat.id, { name }).catch(() => {});

    emitPickerUpdated(req.app.get('io') as IoServer | undefined, serverId, pickerId);
    res.status(201).json(cat);
  }),
);

// PATCH /role-pickers/:pickerId/categories/:catId — update category
router.patch('/:pickerId/categories/:catId', authenticateToken, pickerMutationLimiter,
  validateUuidParams('serverId', 'pickerId', 'catId'),
  validate(updatePickerCategorySchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const serverId = getParam(req, 'serverId');
    const pickerId = getParam(req, 'pickerId');
    const catId = getParam(req, 'catId');
    if (!await requireManageRoles(req.userId!, serverId, res)) return;

    const cat = await prisma.rolePickerCategory.findFirst({
      where: { id: catId, pickerId, picker: { serverId } },
    });
    if (!cat) return res.status(404).json({ error: 'Category not found' });

    const body = req.body as { name?: string; pickMode?: 'single' | 'multi'; position?: number; required?: boolean };
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.pickMode !== undefined) data.pickMode = body.pickMode;
    if (body.required !== undefined) data.required = body.required;

    // Position update: gap-fill the moved-from spot. Only accept positions
    // within the current count so admins can't sparse-position categories.
    if (body.position !== undefined && body.position !== cat.position) {
      const all = await prisma.rolePickerCategory.findMany({
        where: { pickerId },
        orderBy: { position: 'asc' },
        select: { id: true, position: true },
      });
      const newPos = Math.max(0, Math.min(all.length - 1, body.position));
      const reorderedIds = all.filter((c) => c.id !== catId).map((c) => c.id);
      reorderedIds.splice(newPos, 0, catId);
      // Two-pass to avoid violating @@unique([pickerId, position]).
      await prisma.$transaction([
        ...reorderedIds.map((id, idx) =>
          prisma.rolePickerCategory.update({ where: { id }, data: { position: idx + all.length } }),
        ),
        ...reorderedIds.map((id, idx) =>
          prisma.rolePickerCategory.update({ where: { id }, data: { position: idx } }),
        ),
      ]);
      // Apply other fields outside the reorder transaction.
      if (Object.keys(data).length > 0) {
        await prisma.rolePickerCategory.update({ where: { id: catId }, data });
      }
    } else if (Object.keys(data).length > 0) {
      await prisma.rolePickerCategory.update({ where: { id: catId }, data });
    }

    await createAuditLog(serverId, req.userId!, 'role_picker_category_update', 'category', catId, body).catch(() => {});
    emitPickerUpdated(req.app.get('io') as IoServer | undefined, serverId, pickerId);
    res.json({ ok: true });
  }),
);

// DELETE /role-pickers/:pickerId/categories/:catId
router.delete('/:pickerId/categories/:catId', authenticateToken, pickerMutationLimiter,
  validateUuidParams('serverId', 'pickerId', 'catId'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const serverId = getParam(req, 'serverId');
    const pickerId = getParam(req, 'pickerId');
    const catId = getParam(req, 'catId');
    if (!await requireManageRoles(req.userId!, serverId, res)) return;

    const cat = await prisma.rolePickerCategory.findFirst({
      where: { id: catId, pickerId, picker: { serverId } },
    });
    if (!cat) return res.status(404).json({ error: 'Category not found' });

    await prisma.rolePickerCategory.delete({ where: { id: catId } });
    await createAuditLog(serverId, req.userId!, 'role_picker_category_delete', 'category', catId, { name: cat.name }).catch(() => {});
    emitPickerUpdated(req.app.get('io') as IoServer | undefined, serverId, pickerId);
    res.json({ ok: true });
  }),
);

// POST /role-pickers/:pickerId/categories/:catId/entries — add entry
router.post('/:pickerId/categories/:catId/entries', authenticateToken, pickerMutationLimiter,
  validateUuidParams('serverId', 'pickerId', 'catId'),
  validate(createPickerEntrySchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const serverId = getParam(req, 'serverId');
    const pickerId = getParam(req, 'pickerId');
    const catId = getParam(req, 'catId');
    if (!await requireManageRoles(req.userId!, serverId, res)) return;

    const { roleId, emoji, iconUrl, description, requirements } = req.body as {
      roleId: string; emoji?: string | null; iconUrl?: string | null; description?: string | null; requirements?: ConditionRequirements | null;
    };

    if (iconUrl != null && !await ensurePowerUpForIconUrl(serverId, iconUrl, res)) return;

    const role = await prisma.serverRole.findFirst({ where: { id: roleId, serverId } });
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (!role.selfAssignable) return res.status(400).json({ error: 'Role is not marked self-assignable' });
    if (role.locked) return res.status(400).json({ error: 'Locked roles cannot be in a picker' });
    if (role.isEveryone) return res.status(400).json({ error: '@everyone cannot be in a picker' });
    // Backstop the self-assign invariant at every grant-surface entry point:
    // a role that carries moderation/management power (base perms or a
    // channel/category override) must never be reachable through the picker.
    if (await roleCarriesElevatedGrants(role.id, role.permissions)) {
      return res.status(400).json({ error: 'A role with moderation or management permissions cannot be in a picker' });
    }

    const cat = await prisma.rolePickerCategory.findFirst({
      where: { id: catId, pickerId, picker: { serverId } },
    });
    if (!cat) return res.status(404).json({ error: 'Category not found' });

    const max = await prisma.rolePickerEntry.findFirst({
      where: { categoryId: catId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    try {
      const entry = await prisma.rolePickerEntry.create({
        data: {
          categoryId: catId,
          roleId,
          position: (max?.position ?? -1) + 1,
          emoji: emoji ?? null,
          iconUrl: iconUrl ?? null,
          description: description ?? null,
          requirements: (requirements as object | undefined) ?? undefined,
        },
      });
      await createAuditLog(serverId, req.userId!, 'role_picker_entry_create', 'entry', entry.id, { roleId, name: role.name }).catch(() => {});
      emitPickerUpdated(req.app.get('io') as IoServer | undefined, serverId, pickerId);
      res.status(201).json(entry);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'P2002') return res.status(409).json({ error: 'Role already in this category' });
      throw e;
    }
  }),
);

// PATCH /role-pickers/:pickerId/entries/:entryId
router.patch('/:pickerId/entries/:entryId', authenticateToken, pickerMutationLimiter,
  validateUuidParams('serverId', 'pickerId', 'entryId'),
  validate(updatePickerEntrySchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const serverId = getParam(req, 'serverId');
    const pickerId = getParam(req, 'pickerId');
    const entryId = getParam(req, 'entryId');
    if (!await requireManageRoles(req.userId!, serverId, res)) return;

    const entry = await prisma.rolePickerEntry.findFirst({
      where: { id: entryId, category: { pickerId, picker: { serverId } } },
    });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const body = req.body as { emoji?: string | null; iconUrl?: string | null; description?: string | null; requirements?: ConditionRequirements | null };
    if (body.iconUrl != null && !await ensurePowerUpForIconUrl(serverId, body.iconUrl, res)) return;
    const data: Record<string, unknown> = {};
    if (body.emoji !== undefined) data.emoji = body.emoji;
    if (body.iconUrl !== undefined) data.iconUrl = body.iconUrl;
    if (body.description !== undefined) data.description = body.description;
    if (body.requirements !== undefined) data.requirements = (body.requirements as object | null) ?? null;

    const updated = await prisma.rolePickerEntry.update({ where: { id: entryId }, data });
    await createAuditLog(serverId, req.userId!, 'role_picker_entry_update', 'entry', entryId, body).catch(() => {});
    emitPickerUpdated(req.app.get('io') as IoServer | undefined, serverId, pickerId);
    res.json(updated);
  }),
);

// PATCH /role-pickers/:pickerId/entries/:entryId/move
router.patch('/:pickerId/entries/:entryId/move', authenticateToken, pickerMutationLimiter,
  validateUuidParams('serverId', 'pickerId', 'entryId'),
  validate(movePickerEntrySchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const serverId = getParam(req, 'serverId');
    const pickerId = getParam(req, 'pickerId');
    const entryId = getParam(req, 'entryId');
    if (!await requireManageRoles(req.userId!, serverId, res)) return;

    const entry = await prisma.rolePickerEntry.findFirst({
      where: { id: entryId, category: { pickerId, picker: { serverId } } },
    });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const { categoryId, position } = req.body as { categoryId?: string; position: number };
    const targetCatId = categoryId ?? entry.categoryId;

    if (categoryId && categoryId !== entry.categoryId) {
      const targetCat = await prisma.rolePickerCategory.findFirst({
        where: { id: categoryId, pickerId, picker: { serverId } },
      });
      if (!targetCat) return res.status(404).json({ error: 'Target category not found' });
    }

    // Move entry atomically. Prisma can't express partial updates cleanly here
    // — use a two-pass position rewrite to avoid @@unique([categoryId, roleId])
    // collisions on cross-category moves (different category, no clash).
    await prisma.$transaction(async (tx) => {
      // 1. Remove from old position (close the gap).
      await tx.rolePickerEntry.updateMany({
        where: { categoryId: entry.categoryId, position: { gt: entry.position } },
        data: { position: { decrement: 1 } },
      });
      // 2. Make room at new position.
      const targetCount = await tx.rolePickerEntry.count({ where: { categoryId: targetCatId } });
      const newPos = Math.max(0, Math.min(targetCount, position));
      await tx.rolePickerEntry.updateMany({
        where: { categoryId: targetCatId, position: { gte: newPos } },
        data: { position: { increment: 1 } },
      });
      // 3. Update the moved entry.
      await tx.rolePickerEntry.update({
        where: { id: entryId },
        data: { categoryId: targetCatId, position: newPos },
      });
    });

    await createAuditLog(serverId, req.userId!, 'role_picker_entry_move', 'entry', entryId, { categoryId: targetCatId, position }).catch(() => {});
    emitPickerUpdated(req.app.get('io') as IoServer | undefined, serverId, pickerId);
    res.json({ ok: true });
  }),
);

// DELETE /role-pickers/:pickerId/entries/:entryId
router.delete('/:pickerId/entries/:entryId', authenticateToken, pickerMutationLimiter,
  validateUuidParams('serverId', 'pickerId', 'entryId'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const serverId = getParam(req, 'serverId');
    const pickerId = getParam(req, 'pickerId');
    const entryId = getParam(req, 'entryId');
    if (!await requireManageRoles(req.userId!, serverId, res)) return;

    const entry = await prisma.rolePickerEntry.findFirst({
      where: { id: entryId, category: { pickerId, picker: { serverId } } },
    });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    // Withdraw any pending requests for this entry before delete so applicants
    // get notified rather than the rows silently disappearing via cascade.
    const pending = await prisma.roleClaimRequest.findMany({
      where: { pickerEntryId: entryId, status: 'pending' },
      select: { id: true, userId: true },
    });
    if (pending.length > 0) {
      await prisma.roleClaimRequest.updateMany({
        where: { id: { in: pending.map((p) => p.id) } },
        data: { status: 'withdrawn', decidedAt: new Date() },
      });
      const io = req.app.get('io') as IoServer | undefined;
      for (const p of pending) {
        emitClaimRequestUpdated(io, serverId, p.userId, p.id, 'withdrawn');
      }
    }

    await prisma.rolePickerEntry.delete({ where: { id: entryId } });
    await createAuditLog(serverId, req.userId!, 'role_picker_entry_delete', 'entry', entryId, { roleId: entry.roleId }).catch(() => {});
    emitPickerUpdated(req.app.get('io') as IoServer | undefined, serverId, pickerId);
    res.json({ ok: true });
  }),
);

// POST /role-pickers/:pickerId/entries/:entryId/claim — self-claim
router.post('/:pickerId/entries/:entryId/claim', authenticateToken, pickerMutationLimiter,
  validateUuidParams('serverId', 'pickerId', 'entryId'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const serverId = getParam(req, 'serverId');
    const pickerId = getParam(req, 'pickerId');
    const entryId = getParam(req, 'entryId');
    const userId = req.userId!;
    if (!await requireMember(userId, serverId, res)) return;

    const restricted = await prisma.serverRole.findFirst({
      where: { serverId, blocksSelfRoles: true, memberRoles: { some: { userId, serverId } } },
      select: { id: true },
    });
    if (restricted) return res.status(403).json({ error: 'You are restricted from claiming self-roles' });

    const lock = await acquireClaimLock(userId, entryId);
    if (!lock) return res.status(409).json({ error: 'Claim in progress' });
    try {
      const entry = await prisma.rolePickerEntry.findFirst({
        where: { id: entryId, category: { pickerId, picker: { serverId } } },
        include: {
          role: true,
          category: { select: { id: true, pickMode: true } },
        },
      });
      if (!entry) return res.status(404).json({ error: 'Entry not found' });
      if (!entry.role.selfAssignable) return res.status(400).json({ error: 'Role is not self-assignable' });
      if (entry.role.locked) return res.status(400).json({ error: 'Locked roles cannot be claimed' });
      // Backstop at claim time: entries created before a role gained elevated
      // perms (or an elevated channel/category override) must not grant them.
      if (await roleCarriesElevatedGrants(entry.roleId, entry.role.permissions)) {
        return res.status(400).json({ error: 'This role can no longer be self-assigned' });
      }

      // Already held? Idempotent.
      const existing = await prisma.memberRole.findUnique({
        where: { userId_serverId_roleId: { userId, serverId, roleId: entry.roleId } },
      });
      if (existing) return res.status(200).json({ ok: true, status: 'already_held' });

      const requirements = (entry.requirements ?? null) as ConditionRequirements | null;

      // Manual-approval short-circuit — route to queue without granting.
      if (requirements?.manualApproval === true) {
        try {
          const r = await prisma.roleClaimRequest.create({
            data: { serverId, userId, pickerEntryId: entryId, roleId: entry.roleId, status: 'pending' },
          });
          emitClaimRequestUpdated(req.app.get('io') as IoServer | undefined, serverId, userId, r.id, 'pending');
          return res.status(202).json({ ok: true, status: 'pending_approval', requestId: r.id });
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === 'P2002') {
            return res.status(409).json({ error: 'You already have a pending request for this role' });
          }
          throw e;
        }
      }

      // Evaluate conditions
      const [user, member, myRoles, msgCount] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } }),
        prisma.serverMember.findUnique({ where: { userId_serverId: { userId, serverId } }, select: { joinedAt: true } }),
        prisma.memberRole.findMany({ where: { userId, serverId }, select: { roleId: true } }),
        getMessageCount(userId, serverId),
      ]);
      if (!user || !member) return res.status(404).json({ error: 'User or membership missing' });

      const evalCtx: EvaluationContext = {
        now: new Date(),
        userCreatedAt: user.createdAt,
        memberJoinedAt: member.joinedAt,
        userRoleIds: new Set(myRoles.map((r) => r.roleId)),
        messageCount: msgCount,
      };
      const result = evaluateConditions(requirements, evalCtx);
      if (!result.ok) return res.status(422).json({ error: 'Conditions not met', failed: result.failed });

      const io = req.app.get('io') as IoServer | undefined;

      // Single-mode category: remove sibling roles in same category before granting.
      // Track the IDs we removed so we can broadcast the post-state once the
      // grant is in. Emitting the removal events before the grant means each
      // listener sees the new authoritative roles[] list.
      let siblingIdsRemoved: string[] = [];
      if (entry.category.pickMode === 'single') {
        const siblings = await prisma.rolePickerEntry.findMany({
          where: { categoryId: entry.category.id, NOT: { id: entryId } },
          select: { roleId: true },
        });
        const siblingIds = siblings.map((s) => s.roleId);
        if (siblingIds.length > 0) {
          const r = await prisma.memberRole.deleteMany({
            where: { userId, serverId, roleId: { in: siblingIds } },
          });
          if (r.count > 0) siblingIdsRemoved = siblingIds;
        }
      }

      // Grant role
      await prisma.memberRole.create({
        data: { userId, serverId, roleId: entry.roleId, assignedBy: null },
      });

      // Recompute display role (legacy ServerMember.roleId / role string).
      const allRoles = await prisma.memberRole.findMany({
        where: { userId, serverId },
        include: { role: { select: { id: true, name: true, color: true, style: true, position: true, displaySeparately: true, isEveryone: true } } },
      });
      const { pickDisplayRole } = await import('../utils/permissions.js');
      const display = pickDisplayRole(allRoles.map((mr) => mr.role));
      await prisma.serverMember.update({
        where: { userId_serverId: { userId, serverId } },
        data: { roleId: display?.id ?? null, role: display?.name ?? 'member' },
      });
      await invalidatePermissionContext(serverId, userId);

      // Broadcast: removed siblings (single-mode) + the newly added role,
      // each carrying the same post-state roles[] so the frontend reconciler
      // converges to the correct state regardless of ordering.
      for (const rid of siblingIdsRemoved) {
        await broadcastMemberRolesChanged(io, serverId, userId, { removedRoleId: rid });
      }
      await broadcastMemberRolesChanged(io, serverId, userId, { addedRoleId: entry.roleId });
      log.info({ serverId, userId, entryId, roleId: entry.roleId }, 'self-role granted');
      res.status(200).json({ ok: true, status: 'granted' });
    } finally {
      await releaseClaimLock(userId, entryId);
    }
  }),
);

// DELETE /role-pickers/:pickerId/entries/:entryId/claim — release
router.delete('/:pickerId/entries/:entryId/claim', authenticateToken, pickerMutationLimiter,
  validateUuidParams('serverId', 'pickerId', 'entryId'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const serverId = getParam(req, 'serverId');
    const pickerId = getParam(req, 'pickerId');
    const entryId = getParam(req, 'entryId');
    const userId = req.userId!;
    if (!await requireMember(userId, serverId, res)) return;

    const entry = await prisma.rolePickerEntry.findFirst({
      where: { id: entryId, category: { pickerId, picker: { serverId } } },
      include: { role: { select: { locked: true, isEveryone: true } } },
    });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    if (entry.role.locked || entry.role.isEveryone) {
      return res.status(400).json({ error: 'This role cannot be released' });
    }

    const removed = await prisma.memberRole.deleteMany({
      where: { userId, serverId, roleId: entry.roleId },
    });
    if (removed.count > 0) {
      // Recompute display role
      const remaining = await prisma.memberRole.findMany({
        where: { userId, serverId },
        include: { role: { select: { id: true, name: true, color: true, style: true, position: true, displaySeparately: true, isEveryone: true } } },
      });
      const { pickDisplayRole } = await import('../utils/permissions.js');
      const display = pickDisplayRole(remaining.map((mr) => mr.role));
      await prisma.serverMember.update({
        where: { userId_serverId: { userId, serverId } },
        data: { roleId: display?.id ?? null, role: display?.name ?? 'member' },
      });
      await invalidatePermissionContext(serverId, userId);

      const io = req.app.get('io') as IoServer | undefined;
      await broadcastMemberRolesChanged(io, serverId, userId, { removedRoleId: entry.roleId });
    }
    res.status(200).json({ ok: true, removed: removed.count });
  }),
);

// POST /role-pickers/:pickerId/entries/:entryId/request — manual approval
router.post('/:pickerId/entries/:entryId/request', authenticateToken, pickerMutationLimiter,
  validateUuidParams('serverId', 'pickerId', 'entryId'),
  validate(submitClaimRequestSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const serverId = getParam(req, 'serverId');
    const pickerId = getParam(req, 'pickerId');
    const entryId = getParam(req, 'entryId');
    const userId = req.userId!;
    if (!await requireMember(userId, serverId, res)) return;

    const restricted = await prisma.serverRole.findFirst({
      where: { serverId, blocksSelfRoles: true, memberRoles: { some: { userId, serverId } } },
      select: { id: true },
    });
    if (restricted) return res.status(403).json({ error: 'You are restricted from claiming self-roles' });

    const entry = await prisma.rolePickerEntry.findFirst({
      where: { id: entryId, category: { pickerId, picker: { serverId } } },
    });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const requirements = (entry.requirements ?? null) as ConditionRequirements | null;
    if (requirements?.manualApproval !== true) {
      return res.status(400).json({ error: 'This role does not require manual approval' });
    }

    const { applicantMessage } = req.body as { applicantMessage?: string };
    try {
      const r = await prisma.roleClaimRequest.create({
        data: {
          serverId, userId,
          pickerEntryId: entryId,
          roleId: entry.roleId,
          status: 'pending',
          applicantMessage: applicantMessage ?? null,
        },
      });
      emitClaimRequestUpdated(req.app.get('io') as IoServer | undefined, serverId, userId, r.id, 'pending');
      res.status(201).json(r);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'P2002') return res.status(409).json({ error: 'You already have a pending request for this role' });
      throw e;
    }
  }),
);

// DELETE /role-pickers/:pickerId/requests/me/:requestId — withdraw
router.delete('/:pickerId/requests/me/:requestId', authenticateToken, pickerMutationLimiter,
  validateUuidParams('serverId', 'pickerId', 'requestId'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const serverId = getParam(req, 'serverId');
    const requestId = getParam(req, 'requestId');
    const userId = req.userId!;
    if (!await requireMember(userId, serverId, res)) return;

    const r = await prisma.roleClaimRequest.findFirst({
      where: { id: requestId, serverId, userId, status: 'pending' },
    });
    if (!r) return res.status(404).json({ error: 'Pending request not found' });

    await prisma.roleClaimRequest.update({
      where: { id: requestId },
      data: { status: 'withdrawn', decidedAt: new Date() },
    });
    emitClaimRequestUpdated(req.app.get('io') as IoServer | undefined, serverId, userId, requestId, 'withdrawn');
    res.json({ ok: true });
  }),
);

// GET /role-pickers/requests/list — admin queue
router.get('/requests/list', authenticateToken, validateUuidParams('serverId'),
  validate(listClaimRequestsSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const serverId = getParam(req, 'serverId');
    if (!await requireManageRoles(req.userId!, serverId, res)) return;

    const status = (req.query.status as string | undefined) ?? 'pending';
    const cursor = req.query.cursor as string | undefined;
    const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? '25', 10) || 25));

    const where: Record<string, unknown> = { serverId, status };
    if (cursor) where.createdAt = { lt: new Date(cursor) };

    const rows = await prisma.roleClaimRequest.findMany({
      where: where as never,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        user: { select: { id: true, username: true, discriminator: true, avatar: true } },
        decidedBy: { select: { id: true, username: true, discriminator: true, avatar: true } },
        entry: {
          select: {
            id: true, emoji: true, description: true,
            category: { select: { id: true, name: true } },
            role: { select: { id: true, name: true, color: true } },
          },
        },
      },
    });

    const nextCursor = rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null;
    res.json({
      requests: rows.map((r) => ({
        id: r.id,
        serverId: r.serverId,
        applicant: r.user,
        roleId: r.roleId,
        role: r.entry?.role ?? null,
        category: r.entry?.category ?? null,
        entryEmoji: r.entry?.emoji ?? null,
        entryDescription: r.entry?.description ?? null,
        applicantMessage: r.applicantMessage,
        status: r.status,
        decisionNote: r.decisionNote,
        decidedBy: r.decidedBy,
        createdAt: r.createdAt.toISOString(),
        decidedAt: r.decidedAt?.toISOString() ?? null,
      })),
      nextCursor,
    });
  }),
);

// PATCH /role-pickers/requests/:requestId/decide — approve / reject
router.patch('/requests/:requestId/decide', authenticateToken, pickerMutationLimiter,
  validateUuidParams('serverId', 'requestId'),
  validate(decideClaimRequestSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const serverId = getParam(req, 'serverId');
    const requestId = getParam(req, 'requestId');
    if (!await requireManageRoles(req.userId!, serverId, res)) return;

    const r = await prisma.roleClaimRequest.findFirst({
      where: { id: requestId, serverId },
      include: {
        entry: { include: { role: true } },
      },
    });
    if (!r) return res.status(404).json({ error: 'Request not found' });
    if (r.status !== 'pending') return res.status(409).json({ error: 'Already decided' });

    const { decision, decisionNote } = req.body as { decision: 'approve' | 'reject'; decisionNote?: string };
    const newStatus = decision === 'approve' ? 'approved' : 'rejected';

    if (decision === 'approve') {
      // Grant role (idempotent — user may already have it via another path).
      const role = r.entry.role;
      if (!role.selfAssignable) {
        return res.status(400).json({ error: 'Role is no longer self-assignable' });
      }
      // Same claim-time backstop as the instant-claim path: the role may have
      // gained elevated perms after the request was queued.
      if (await roleCarriesElevatedGrants(role.id, role.permissions)) {
        return res.status(400).json({ error: 'This role can no longer be self-assigned' });
      }
      const applicantRestricted = await prisma.serverRole.findFirst({
        where: { serverId: r.serverId, blocksSelfRoles: true, memberRoles: { some: { userId: r.userId, serverId: r.serverId } } },
        select: { id: true },
      });
      if (applicantRestricted) return res.status(403).json({ error: 'Applicant is restricted from claiming self-roles' });
      await prisma.memberRole.upsert({
        where: { userId_serverId_roleId: { userId: r.userId, serverId, roleId: role.id } },
        create: { userId: r.userId, serverId, roleId: role.id, assignedBy: req.userId! },
        update: {},
      });
      // Recompute display role
      const allRoles = await prisma.memberRole.findMany({
        where: { userId: r.userId, serverId },
        include: { role: { select: { id: true, name: true, color: true, style: true, position: true, displaySeparately: true, isEveryone: true } } },
      });
      const { pickDisplayRole } = await import('../utils/permissions.js');
      const display = pickDisplayRole(allRoles.map((mr) => mr.role));
      await prisma.serverMember.update({
        where: { userId_serverId: { userId: r.userId, serverId } },
        data: { roleId: display?.id ?? null, role: display?.name ?? 'member' },
      });
      await invalidatePermissionContext(serverId, r.userId);

      const io = req.app.get('io') as IoServer | undefined;
      await broadcastMemberRolesChanged(io, serverId, r.userId, { addedRoleId: role.id });
    }

    await prisma.roleClaimRequest.update({
      where: { id: requestId },
      data: {
        status: newStatus,
        decidedAt: new Date(),
        decidedById: req.userId!,
        decisionNote: decisionNote ?? null,
      },
    });

    // Notify applicant
    await prisma.notification.create({
      data: {
        userId: r.userId,
        serverId,
        type: 'role_claim_decision',
        title: decision === 'approve' ? 'Role approved' : 'Role declined',
        body: decision === 'approve'
          ? `You were granted "${r.entry.role.name}".`
          : `Your request for "${r.entry.role.name}" was declined.${decisionNote ? ` Reason: ${decisionNote}` : ''}`,
        metadata: { requestId, decision: newStatus, roleId: r.entry.role.id },
      },
    }).catch(() => { /* best-effort */ });

    const io2 = req.app.get('io') as IoServer | undefined;
    if (io2) {
      io2.to(`user:${r.userId}`).emit('notification-created', {
        serverId,
        type: 'role_claim_decision',
        title: decision === 'approve' ? 'Role approved' : 'Role declined',
        body: decision === 'approve'
          ? `You were granted "${r.entry.role.name}".`
          : `Your request for "${r.entry.role.name}" was declined.`,
        metadata: { requestId, decision: newStatus, roleId: r.entry.role.id },
        createdAt: new Date().toISOString(),
      });
    }

    emitClaimRequestUpdated(req.app.get('io') as IoServer | undefined, serverId, r.userId, requestId, newStatus);
    await createAuditLog(serverId, req.userId!, 'role_claim_decided', 'request', requestId, { decision: newStatus, roleId: r.entry.role.id, applicantId: r.userId }).catch(() => {});

    res.json({ ok: true, status: newStatus });
  }),
);

export default router;
