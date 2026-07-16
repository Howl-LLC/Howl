// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getParam, hasPermission, loadPermissionContext, unionPerms, pickDisplayRole, canSeeHiddenRoles } from '../utils.js';
import { createAuditLog } from './serverSettings.js';
import { checkUploadAttachment } from '../services/uploadProvenance.js';
import { logger } from '../logger.js';
import { validate } from '../middleware/validate.js';
import { createRoleSchema, updateRoleSchema, addRoleMemberSchema, reorderRolesSchema } from '../schemas.js';
import { powerUpTier, toRelativeUploadUrl, serverMutationLimiter } from './serverHelpers.js';
import { getClientIp } from '../utils/clientIp.js';
import { invalidatePermissionContext, invalidatePermissionContextForServer } from '../redis.js';
import { hasElevatedPerms, roleCarriesElevatedGrants } from '../utils/permissions.js';
import { emitRoleEventToMods, emitMemberRoleEventScoped } from '../utils/roleEmit.js';

const _log = logger.child({ module: 'serverRoles' });

const router = Router();

const serverRoleReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:srv-roles:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

// GET /api/servers/:serverId/roles – list roles with member counts (backfill default Owner/Member if missing)
router.get('/:serverId/roles', validateUuidParams('serverId'), authenticateToken, serverRoleReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      select: { userId: true, role: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member) return res.status(403).json({ error: 'Not a member of this server' });
  let roles = await prisma.serverRole.findMany({
    where: { serverId },
    orderBy: { position: 'asc' },
    include: { _count: { select: { memberRoles: true } } },
    take: 100,
  });
  const hasOwner = roles.some((r) => r.name === 'Owner');
  const hasMember = roles.some((r) => r.name === 'Member' && !r.isEveryone);
  const hasEveryone = roles.some((r) => r.isEveryone);
  if (!hasOwner || !hasMember || !hasEveryone) {
    const toCreate: Array<{ name: string; color: string; position: number; locked: boolean; isEveryone: boolean; permissions: Record<string, boolean>; displaySeparately?: boolean }> = [];
    if (!hasOwner) toCreate.push({ name: 'Owner', color: '#f59e0b', position: 0, locked: true, isEveryone: false, displaySeparately: true, permissions: { administrator: true } });
    if (!hasMember) toCreate.push({ name: 'Member', color: '#06b6d4', position: 1, locked: false, isEveryone: false, permissions: {} });
    if (!hasEveryone) toCreate.push({ name: '@everyone', color: '#99aab5', position: 999, locked: true, isEveryone: true, permissions: { viewChannels: true, sendMessages: true, readMessageHistory: true, embedLinks: true, attachFiles: true, addReactions: true, connect: true, speak: true, video: true, useVoiceActivity: true, createInvite: true, changeNickname: true, viewCalendar: true, requestToSpeak: true, createPolls: true, createThreads: true, sendMessagesInThreads: true, createPosts: true, sendMessagesInPosts: true } });
    const created = await prisma.$transaction(
      toCreate.map((data) =>
        prisma.serverRole.create({
          data: {
            serverId,
            name: data.name,
            color: data.color,
            style: 'solid',
            position: data.position,
            locked: data.locked,
            isEveryone: data.isEveryone,
            permissions: data.permissions,
            ...(data.displaySeparately !== undefined ? { displaySeparately: data.displaySeparately } : {}),
          },
        })
      )
    );
    const ownerRole = created.find((r) => r.name === 'Owner') ?? roles.find((r) => r.name === 'Owner');
    const memberRole = created.find((r) => r.name === 'Member' && !r.isEveryone) ?? roles.find((r) => r.name === 'Member' && !r.isEveryone);
    if (ownerRole && memberRole) {
      await prisma.$transaction([
        prisma.serverMember.updateMany({
          where: { serverId, role: { equals: 'owner', mode: 'insensitive' } },
          data: { roleId: ownerRole.id },
        }),
        prisma.serverMember.updateMany({
          where: { serverId, NOT: { role: { equals: 'owner', mode: 'insensitive' } } },
          data: { roleId: memberRole.id, role: 'member' },
        }),
        // Backfill MemberRole for existing ServerMember.roleId assignments
        prisma.$executeRaw`
          INSERT INTO "MemberRole" ("userId", "serverId", "roleId", "assignedAt", "assignedBy")
          SELECT sm."userId", sm."serverId", sm."roleId", sm."joinedAt", NULL
          FROM "ServerMember" sm
          WHERE sm."serverId" = ${serverId} AND sm."roleId" IS NOT NULL
          ON CONFLICT DO NOTHING
        `,
      ]);
      // Backfill mutated every member of the server — wipe all cached contexts.
      await invalidatePermissionContextForServer(serverId);
    }
    roles = await prisma.serverRole.findMany({
      where: { serverId },
      orderBy: { position: 'asc' },
      take: 100,
      include: { _count: { select: { memberRoles: true } } },
    });
  }
  const seeHidden = canSeeHiddenRoles(permCtx);
  const visibleRoles = seeHidden ? roles : roles.filter((r) => !r.hidden);
  res.json(
    visibleRoles.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      style: r.style,
      icon: r.icon ?? undefined,
      position: r.position,
      locked: r.locked,
      isEveryone: r.isEveryone,
      permissions: (r.permissions as Record<string, boolean>) ?? {},
      displaySeparately: r.displaySeparately,
      allowMention: r.allowMention,
      selfAssignable: r.selfAssignable,
      hidden: r.hidden,
      blocksSelfRoles: r.blocksSelfRoles,
      linkedRoleRequirements: r.linkedRoleRequirements ?? undefined,
      memberCount: r._count.memberRoles,
    }))
  );
}));

// POST /api/servers/:serverId/roles – create role (manageRoles permission)
router.post('/:serverId/roles', validateUuidParams('serverId'), authenticateToken, serverMutationLimiter, validate(createRoleSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(permCtx, 'manageRoles')) return res.status(403).json({ error: 'You need the Manage Roles permission' });
  const { name, color, style, icon, permissions, displaySeparately, allowMention, selfAssignable, hidden, blocksSelfRoles } = req.body as Record<string, unknown>;

  const RESERVED_ROLE_NAMES = ['owner', '@everyone'];
  const nameStr = typeof name === 'string' && name.trim() ? name.trim() : 'New Role';
  if (RESERVED_ROLE_NAMES.includes(nameStr.toLowerCase())) {
    return res.status(400).json({ error: 'This role name is reserved' });
  }

  const isOwner = permCtx.isOwner === true;
  if (!isOwner && permissions && typeof permissions === 'object') {
    const requested = permissions as Record<string, boolean>;
    if (requested.administrator === true) {
      return res.status(403).json({ error: 'Only the server owner can grant administrator permission' });
    }
    // Actor's effective perms = union across their roles ∪ @everyone. Otherwise an admin whose baseline
    // perm comes via @everyone would be blocked from granting that perm to a new role.
    const actorPerms = unionPerms([permCtx.everyoneRole, ...permCtx.roles]);
    if (actorPerms.administrator !== true) {
      for (const [key, value] of Object.entries(requested)) {
        if (value === true && actorPerms[key] !== true) {
          return res.status(403).json({ error: `You cannot grant the '${key}' permission because you don't have it yourself` });
        }
      }
    }
  }

  // A self-assignable role must not carry elevated permissions, or any member
  // could grant themselves moderation/management power through the role picker.
  if (Boolean(selfAssignable) && hasElevatedPerms(permissions)) {
    return res.status(400).json({ error: 'A role with moderation or management permissions cannot be made self-assignable' });
  }

  if (typeof icon === 'string' && icon) {
    const srvForPowerUp = await prisma.server.findUnique({ where: { id: serverId }, select: { powerUpCount: true } });
    if (powerUpTier(srvForPowerUp?.powerUpCount ?? 0) < 2) {
      return res.status(403).json({ error: 'Custom role icons require at least Tier 2 (7 power-ups).' });
    }
    // Role icon is a public, multi-recipient surface validated by a schema with
    // no image-extension constraint, so the `.enc` forcing does not cover it —
    // refuse an encrypted (scan-skipped) DM blob here explicitly.
    const prov = await checkUploadAttachment(icon);
    if (!prov.ok) return res.status(prov.status).json({ error: prov.error });
  }
  const role = await prisma.$transaction(async (tx) => {
    const maxPos = await tx.serverRole.findMany({
      where: { serverId },
      orderBy: { position: 'desc' },
      take: 1,
    }).then((r) => r[0]?.position ?? -1);

    return tx.serverRole.create({
      data: {
        serverId,
        name: nameStr,
        color: typeof color === 'string' ? color : '#99aab5',
        style: style === 'gradient' || style === 'holographic' ? style : 'solid',
        icon: typeof icon === 'string' ? (toRelativeUploadUrl(icon) ?? icon) : null,
        position: maxPos + 1,
        permissions: permissions && typeof permissions === 'object' ? permissions : {},
        displaySeparately: Boolean(displaySeparately),
        allowMention: Boolean(allowMention),
        selfAssignable: Boolean(selfAssignable),
        hidden: Boolean(hidden),
        blocksSelfRoles: Boolean(blocksSelfRoles),
      },
    });
  });
  await createAuditLog(serverId, req.userId!, 'role_create', 'role', role.id, { name: role.name }).catch(() => {});

  const rolePayload = {
    id: role.id,
    name: role.name,
    color: role.color,
    style: role.style,
    icon: role.icon ?? undefined,
    position: role.position,
    locked: role.locked,
    isEveryone: role.isEveryone,
    permissions: (role.permissions as Record<string, boolean>) ?? {},
    displaySeparately: role.displaySeparately,
    allowMention: role.allowMention,
    selfAssignable: role.selfAssignable,
    hidden: role.hidden,
    blocksSelfRoles: role.blocksSelfRoles,
    memberCount: 0,
  };

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    if (rolePayload.hidden) await emitRoleEventToMods(io, serverId, 'server-role-created', { serverId, role: rolePayload });
    else io.to(`server:${serverId}`).emit('server-role-created', { serverId, role: rolePayload });
  }

  res.status(201).json(rolePayload);
}));

// POST /api/servers/:serverId/roles/reorder — atomic bulk reorder (manageRoles).
//
// Body: { orderedRoleIds: string[] } — top-to-bottom list of every
// non-@everyone role on the server. Convention: lower position number =
// higher authority (Owner = 0, @everyone = high fixed). The server keeps
// @everyone pinned to a high position outside the user-controlled range.
//
// Hierarchy gate: a non-owner caller cannot move a role at-or-above their
// own effective position, AND cannot move any role into the slice
// at-or-above their own position. Owner is always pinned to index 0.
router.post('/:serverId/roles/reorder', validateUuidParams('serverId'), authenticateToken, serverMutationLimiter,
  validate(reorderRolesSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const { orderedRoleIds } = req.body as { orderedRoleIds: string[] };

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });
    if (!hasPermission(permCtx, 'manageRoles')) return res.status(403).json({ error: 'You need the Manage Roles permission' });

    // Reject duplicate IDs in the submitted list — easy mistake on the client
    // side, and the bulk update would otherwise silently apply only the last
    // entry's position to the duplicated id.
    if (new Set(orderedRoleIds).size !== orderedRoleIds.length) {
      return res.status(400).json({ error: 'Duplicate role IDs in the order list' });
    }

    const allRoles = await prisma.serverRole.findMany({
      where: { serverId },
      orderBy: { position: 'asc' },
      take: 100,
    });
    const everyoneRole = allRoles.find((r) => r.isEveryone);
    const orderableRoles = allRoles.filter((r) => !r.isEveryone);
    const ownerRole = orderableRoles.find((r) => r.locked && r.name.toLowerCase() === 'owner');

    // Reordered set must be exactly the set of non-@everyone roles. Mismatch
    // means the client's view is stale (someone created or deleted a role
    // mid-edit) — surface as 409 so the UI can refetch.
    const orderableIds = new Set(orderableRoles.map((r) => r.id));
    const submittedSet = new Set(orderedRoleIds);
    if (orderableIds.size !== submittedSet.size || [...orderableIds].some((id) => !submittedSet.has(id))) {
      return res.status(409).json({ error: 'Roles changed since this list was loaded. Refresh and try again.' });
    }

    // Owner is fixed to index 0. Reject any list that puts another role above
    // Owner — the Owner role is locked from rearrangement, period.
    if (ownerRole && orderedRoleIds[0] !== ownerRole.id) {
      return res.status(400).json({ error: 'Owner must remain at the top.' });
    }

    const isOwner = permCtx.isOwner === true;
    const actorPosition = permCtx.roles.length > 0
      ? Math.min(...permCtx.roles.map((r) => r.position))
      : Infinity;

    // Hierarchy check: for every role whose computed (new) index differs from
    // its current position, neither the old nor the new position may be
    // at-or-above the actor's own position. Owner is exempt.
    const oldPositionById = new Map(allRoles.map((r) => [r.id, r.position]));
    if (!isOwner) {
      for (let newIdx = 0; newIdx < orderedRoleIds.length; newIdx++) {
        const roleId = orderedRoleIds[newIdx];
        const oldPos = oldPositionById.get(roleId)!;
        if (oldPos === newIdx) continue; // unchanged — fine
        if (oldPos <= actorPosition) {
          return res.status(403).json({ error: 'You cannot move a role at or above your own position.' });
        }
        if (newIdx <= actorPosition) {
          return res.status(403).json({ error: 'You cannot move a role into a slot at or above your own position.' });
        }
      }
    }

    // Apply: write the new sequential positions for every orderable role and
    // pin @everyone to a high constant. Two-phase to avoid colliding with old
    // positions during the rewrite (no @@unique on (serverId, position) today,
    // but the offset is cheap insurance against future schema tightening).
    const EVERYONE_POSITION = 1000;
    const POSITION_OFFSET = 100_000;
    const updated = await prisma.$transaction(async (tx) => {
      // Step 1: temp shift to a high range so no two rows collide on positon.
      for (let i = 0; i < orderedRoleIds.length; i++) {
        await tx.serverRole.update({
          where: { id: orderedRoleIds[i] },
          data: { position: POSITION_OFFSET + i },
        });
      }
      // Step 2: write the canonical positions.
      for (let i = 0; i < orderedRoleIds.length; i++) {
        await tx.serverRole.update({
          where: { id: orderedRoleIds[i] },
          data: { position: i },
        });
      }
      if (everyoneRole && everyoneRole.position !== EVERYONE_POSITION) {
        await tx.serverRole.update({
          where: { id: everyoneRole.id },
          data: { position: EVERYONE_POSITION },
        });
      }
      return tx.serverRole.findMany({
        where: { serverId },
        orderBy: { position: 'asc' },
        include: { _count: { select: { memberRoles: true } } },
        take: 100,
      });
    });

    // Position changes can shuffle the display role for any member of the
    // moved roles, plus permission resolution (channel overrides match
    // against @everyone-baseline + role list). Server-wide invalidation is
    // the only safe move here.
    await invalidatePermissionContextForServer(serverId);
    await createAuditLog(serverId, req.userId, 'roles_reorder', 'server', serverId, {
      orderedRoleIds,
    }).catch(() => {});

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) {
      const payloadRoles = updated.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        style: r.style,
        icon: r.icon ?? undefined,
        position: r.position,
        locked: r.locked,
        isEveryone: r.isEveryone,
        permissions: (r.permissions as Record<string, boolean>) ?? {},
        displaySeparately: r.displaySeparately,
        allowMention: r.allowMention,
        selfAssignable: r.selfAssignable,
        hidden: r.hidden,
        memberCount: r._count.memberRoles,
      }));
      // Non-mods get the visible subset only; mods get the full list (incl.
      // hidden roles) over per-user sockets. When there are no hidden roles,
      // the lists are identical and the scoped emit is skipped.
      const visibleRoles = payloadRoles.filter((r) => !r.hidden);
      io.to(`server:${serverId}`).emit('server-roles-reordered', { serverId, roles: visibleRoles });
      if (payloadRoles.length !== visibleRoles.length) await emitRoleEventToMods(io, serverId, 'server-roles-reordered', { serverId, roles: payloadRoles });
    }

    res.json({ ok: true, roles: updated.map((r) => ({ id: r.id, position: r.position })) });
  }),
);

// PUT /api/servers/:serverId/roles/:roleId – update role (manageRoles permission)
router.put('/:serverId/roles/:roleId', validateUuidParams('serverId', 'roleId'), authenticateToken, serverMutationLimiter, validate(updateRoleSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const roleId = getParam(req, 'roleId');
  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(permCtx, 'manageRoles')) return res.status(403).json({ error: 'You need the Manage Roles permission' });
  const role = await prisma.serverRole.findFirst({ where: { id: roleId, serverId } });
  if (!role) return res.status(404).json({ error: 'Role not found' });
  // Capture visibility BEFORE the update so the emit site can detect a
  // visible→hidden flip and tell non-mods to drop the now-hidden role.
  const wasHidden = role.hidden;
  // Locked roles refuse most edits. Two locked roles exist:
  //   - Owner: rejects permissions + position changes (Display-tab edits allowed).
  //   - @everyone: rejects name, position, displaySeparately, allowMention, icon.
  //                Permissions ARE editable — admins must be able to tune the baseline.
  const body = req.body as Record<string, unknown>;
  if (role.isEveryone) {
    const forbidden = ['name', 'position', 'displaySeparately', 'allowMention', 'icon', 'color', 'style'];
    for (const key of forbidden) {
      if (body[key] !== undefined) {
        return res.status(400).json({ error: `@everyone role does not allow editing '${key}'` });
      }
    }
  } else if (role.locked) {
    if (body.permissions !== undefined || body.position !== undefined) {
      return res.status(400).json({ error: "Can't change permissions or position on a locked role" });
    }
    // The Owner role's name is load-bearing: reorder pins the owner role by
    // name, and the legacy owner-string fallback mirrors it. Renaming it can't
    // change authoritative ownership (that's Server.ownerId now) but would
    // desync display and the reorder pin, so keep the name fixed.
    if (body.name !== undefined) {
      return res.status(400).json({ error: "Can't rename a locked role" });
    }
  }

  const isOwner = permCtx.isOwner === true;
  // Effective position in Howl = MIN position across all roles (lower number = higher authority).
  // @everyone is excluded from hierarchy since it's the implicit baseline.
  const actorPosition = permCtx.roles.length > 0
    ? Math.min(...permCtx.roles.map(r => r.position))
    : Infinity;
  if (!isOwner && !role.isEveryone && role.position <= actorPosition) {
    return res.status(403).json({ error: 'You cannot modify a role at or above your own position' });
  }

  if (typeof body.name === 'string' && body.name.trim()) {
    const RESERVED_ROLE_NAMES = ['owner', '@everyone'];
    // Built-in Owner / @everyone are allowed to keep their name; only reject the reserved name for OTHER roles.
    const nameLc = body.name.trim().toLowerCase();
    if (RESERVED_ROLE_NAMES.includes(nameLc) && role.name.toLowerCase() !== nameLc) {
      return res.status(400).json({ error: 'This role name is reserved' });
    }
  }
  const data: Record<string, unknown> = {};
  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
  if (typeof body.color === 'string') data.color = body.color;
  if (body.style === 'gradient' || body.style === 'holographic' || body.style === 'solid') data.style = body.style;
  if (body.icon !== undefined) {
    const iconVal = body.icon === null || body.icon === '' ? null : body.icon;
    if (iconVal && typeof iconVal === 'string') {
      const srv = await prisma.server.findUnique({ where: { id: serverId }, select: { powerUpCount: true } });
      if (powerUpTier(srv?.powerUpCount ?? 0) < 2) {
        return res.status(403).json({ error: 'Custom role icons require at least Tier 2 (7 power-ups).' });
      }
      // Refuse an encrypted (scan-skipped) DM blob as a role icon.
      const prov = await checkUploadAttachment(iconVal);
      if (!prov.ok) return res.status(prov.status).json({ error: prov.error });
    }
    data.icon = body.icon === null || body.icon === '' ? null : body.icon;
  }
  if (typeof body.permissions === 'object' && body.permissions !== null) {
    if (!isOwner) {
      const requested = body.permissions as Record<string, boolean>;
      if (requested.administrator === true) {
        return res.status(403).json({ error: 'Only the server owner can grant administrator permission' });
      }
      // Actor's effective perms = union across their roles ∪ @everyone.
      const actorPerms = unionPerms([permCtx.everyoneRole, ...permCtx.roles]);
      if (actorPerms.administrator !== true) {
        for (const [key, value] of Object.entries(requested)) {
          if (value === true && actorPerms[key] !== true) {
            return res.status(403).json({ error: `You cannot grant the '${key}' permission because you don't have it yourself` });
          }
        }
      }
    }
    data.permissions = body.permissions;
  }
  if (typeof body.displaySeparately === 'boolean') data.displaySeparately = body.displaySeparately;
  if (typeof body.allowMention === 'boolean') data.allowMention = body.allowMention;
  if (typeof body.selfAssignable === 'boolean') data.selfAssignable = body.selfAssignable;
  if (typeof body.hidden === 'boolean') data.hidden = body.hidden;
  if (typeof body.blocksSelfRoles === 'boolean') data.blocksSelfRoles = body.blocksSelfRoles;
  if (typeof body.position === 'number') {
    if (!isOwner && body.position <= actorPosition) {
      return res.status(403).json({ error: 'You cannot move a role above or equal to your own position' });
    }
    data.position = body.position;
  }
  // Enforce the self-assignable invariant against the POST-update state, so you
  // can neither flag an elevated role self-assignable nor add elevated perms to
  // an already-self-assignable role. Overrides count too: a channel/category
  // override can grant elevated perms beyond the role's base permissions.
  const effectiveSelfAssignable = data.selfAssignable !== undefined
    ? data.selfAssignable === true
    : role.selfAssignable;
  const effectivePermsForSelfAssign = data.permissions !== undefined ? data.permissions : role.permissions;
  if (effectiveSelfAssignable && await roleCarriesElevatedGrants(roleId, effectivePermsForSelfAssign)) {
    return res.status(400).json({ error: 'A role with moderation or management permissions cannot be self-assignable' });
  }
  // Wrap position shift + role update in a transaction to prevent concurrent reorder races
  const SELF_ASSIGN_CONFLICT = 'SELF_ASSIGN_CONFLICT';
  const updated = await prisma.$transaction(async (tx) => {
    // Re-check the self-assignable invariant against committed state under a
    // row lock, so two overlapping PUTs (one flagging selfAssignable, one
    // adding elevated perms) cannot interleave past the pre-check above.
    await tx.$queryRaw`SELECT id FROM "ServerRole" WHERE id = ${roleId} FOR UPDATE`;
    const current = await tx.serverRole.findUnique({ where: { id: roleId }, select: { selfAssignable: true, permissions: true } });
    const effSelf = data.selfAssignable !== undefined ? data.selfAssignable === true : current?.selfAssignable === true;
    const effPerms = data.permissions !== undefined ? data.permissions : current?.permissions;
    if (effSelf && hasElevatedPerms(effPerms)) throw new Error(SELF_ASSIGN_CONFLICT);
    if (data.position !== undefined) {
      // Shift roles at or above the target position up by 1 to prevent collisions
      await tx.serverRole.updateMany({
        where: { serverId, position: { gte: data.position as number }, id: { not: roleId } },
        data: { position: { increment: 1 } },
      });
    }
    return tx.serverRole.update({ where: { id: roleId }, data: data as never });
  }).catch((err: Error) => {
    if (err.message === SELF_ASSIGN_CONFLICT) return null;
    throw err;
  });
  if (!updated) {
    return res.status(400).json({ error: 'A role with moderation or management permissions cannot be self-assignable' });
  }
  const count = await prisma.memberRole.count({ where: { roleId: updated.id } });
  // Role permission/position change cascades to every cached member context
  // that includes this role; position changes can also reshuffle hierarchy
  // for unrelated roles. Server-wide invalidation is the only safe move.
  await invalidatePermissionContextForServer(serverId);
  await createAuditLog(serverId, req.userId!, 'role_update', 'role', roleId, data).catch(() => {});

  const rolePayload = {
    id: updated.id,
    name: updated.name,
    color: updated.color,
    style: updated.style,
    icon: updated.icon ?? undefined,
    position: updated.position,
    locked: updated.locked,
    isEveryone: updated.isEveryone,
    permissions: (updated.permissions as Record<string, boolean>) ?? {},
    displaySeparately: updated.displaySeparately,
    allowMention: updated.allowMention,
    selfAssignable: updated.selfAssignable,
    hidden: updated.hidden,
    blocksSelfRoles: updated.blocksSelfRoles,
    memberCount: count,
  };

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    if (updated.hidden) {
      await emitRoleEventToMods(io, serverId, 'server-role-updated', { serverId, role: rolePayload });
      // Visible→hidden flip: non-mods must drop the now-hidden role. The
      // delete payload carries only { serverId, roleId } — no leak.
      if (wasHidden === false) io.to(`server:${serverId}`).emit('server-role-deleted', { serverId, roleId: updated.id });
    } else {
      io.to(`server:${serverId}`).emit('server-role-updated', { serverId, role: rolePayload });
    }
  }

  res.json(rolePayload);
}));

// DELETE /api/servers/:serverId/roles/:roleId (manageRoles permission)
router.delete('/:serverId/roles/:roleId', validateUuidParams('serverId', 'roleId'), authenticateToken, serverMutationLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const roleId = getParam(req, 'roleId');
  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(permCtx, 'manageRoles')) return res.status(403).json({ error: 'You need the Manage Roles permission' });
  const role = await prisma.serverRole.findFirst({ where: { id: roleId, serverId } });
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.isEveryone) return res.status(400).json({ error: 'Cannot delete the @everyone role' });
  if (role.locked) return res.status(400).json({ error: 'Cannot delete locked role' });

  const isOwner = permCtx.isOwner === true;
  if (!isOwner) {
    const actorPosition = permCtx.roles.length > 0
      ? Math.min(...permCtx.roles.map(r => r.position))
      : Infinity;
    if (role.position <= actorPosition) {
      return res.status(403).json({ error: 'You cannot delete a role at or above your own position' });
    }
  }

  // Find affected members BEFORE deletion so we can recompute their display role
  // and emit events. Bounded so deleting a role held by a pathological number of
  // members can't turn one request into an unbounded synchronous storm. If the
  // cap is ever hit we log it rather than silently skipping the remainder (those
  // members' display columns self-heal on their next role touch or a /roles read).
  const MAX_AFFECTED_MEMBERS = 100_000;
  const affectedMembers = await prisma.memberRole.findMany({
    where: { serverId, roleId },
    select: { userId: true },
    take: MAX_AFFECTED_MEMBERS,
  });
  if (affectedMembers.length === MAX_AFFECTED_MEMBERS) {
    _log.warn({ serverId, roleId }, 'role delete hit affected-member cap; remaining members will recompute display lazily');
  }

  // Self Roles cleanup: any pending RoleClaimRequest for entries pointing at
  // this role should be marked withdrawn so applicants are notified before
  // the RolePickerEntry → cascade-delete fires.
  const pendingForRole = await prisma.roleClaimRequest.findMany({
    where: { serverId, status: 'pending', roleId },
    select: { id: true, userId: true },
  });
  if (pendingForRole.length > 0) {
    await prisma.roleClaimRequest.updateMany({
      where: { id: { in: pendingForRole.map((r) => r.id) } },
      data: { status: 'withdrawn', decidedAt: new Date() },
    });
    const ioRP = req.app.get('io');
    if (ioRP) {
      for (const r of pendingForRole) {
        ioRP.to(`user:${r.userId}`).emit('role-claim-request-updated', {
          serverId, requestId: r.id, status: 'withdrawn',
        });
      }
    }
  }

  // Delete overrides (targetId is a plain string — no FK cascade), then the role itself.
  // MemberRole rows cascade via ON DELETE CASCADE.
  await prisma.$transaction([
    prisma.channelPermissionOverride.deleteMany({ where: { targetType: 'role', targetId: roleId } }),
    prisma.categoryPermissionOverride.deleteMany({ where: { targetType: 'role', targetId: roleId } }),
    prisma.serverRole.delete({ where: { id: roleId } }),
    // Clear the legacy ServerMember.roleId pointer for any members whose single-role FK pointed here.
    // Their display role will be recomputed from remaining MemberRole entries below.
    prisma.serverMember.updateMany({
      where: { serverId, roleId },
      data: { roleId: null, role: 'member' },
    }),
  ]);
  // Role deletion mutates every member that had this role.
  await invalidatePermissionContextForServer(serverId);
  await createAuditLog(serverId, req.userId!, 'role_delete', 'role', roleId, { name: role.name }).catch(() => {});

  // Recompute display role for each affected member and emit socket events.
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) io.to(`server:${serverId}`).emit('server-role-deleted', { serverId, roleId });

  // Recompute display roles and emit, in batches. Each batch does ONE read for
  // all its members' remaining roles and groups the legacy-column writes into a
  // few updateMany calls by new display role, replacing the old per-member
  // query + update (an unbounded N+1 that held a DB connection for the whole
  // deletion). Writes happen BEFORE the socket emits so clients that refetch on
  // the events read the new state, and a failed batch is tolerated (the display
  // columns self-heal on the member's next role touch or a /roles read) instead
  // of failing the request after the role is already deleted.
  const RECOMPUTE_BATCH = 500;
  for (let i = 0; i < affectedMembers.length; i += RECOMPUTE_BATCH) {
    const chunkIds = affectedMembers.slice(i, i + RECOMPUTE_BATCH).map((m) => m.userId);
    const remainingCap = chunkIds.length * 100;
    const remaining = await prisma.memberRole.findMany({
      where: { serverId, userId: { in: chunkIds } },
      include: { role: { select: { id: true, name: true, color: true, style: true, position: true, displaySeparately: true, isEveryone: true, hidden: true } } },
      orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
      take: remainingCap,
    });
    if (remaining.length === remainingCap) {
      _log.warn({ serverId, roleId }, 'role-delete recompute read hit its cap; some display columns will heal on next role touch');
    }
    type RemRole = (typeof remaining)[number]['role'];
    const rolesByUser = new Map<string, RemRole[]>();
    for (const uid of chunkIds) rolesByUser.set(uid, []);
    for (const mr of remaining) rolesByUser.get(mr.userId)?.push(mr.role);

    // Group the legacy display-column writes by the new display role so we do a
    // handful of updateMany calls per batch instead of one update per member.
    const updateGroups = new Map<string, { roleId: string | null; roleName: string; userIds: string[] }>();
    const displayByUser = new Map<string, ReturnType<typeof pickDisplayRole>>();

    for (const userId of chunkIds) {
      const memberRoles = rolesByUser.get(userId) ?? [];
      const display = pickDisplayRole(memberRoles);
      displayByUser.set(userId, display);
      const gKey = display?.id ?? '__none__';
      let g = updateGroups.get(gKey);
      if (!g) { g = { roleId: display?.id ?? null, roleName: display?.name ?? 'member', userIds: [] }; updateGroups.set(gKey, g); }
      g.userIds.push(userId);
    }

    if (updateGroups.size > 0) {
      try {
        await prisma.$transaction(
          [...updateGroups.values()].map((g) =>
            prisma.serverMember.updateMany({
              where: { serverId, userId: { in: g.userIds } },
              data: { roleId: g.roleId, role: g.roleName },
            }),
          ),
        );
      } catch (err) {
        _log.warn({ serverId, roleId, error: (err as Error).message }, 'role-delete display recompute batch failed; columns heal lazily');
      }
    }

    for (const userId of chunkIds) {
      const memberRoles = rolesByUser.get(userId) ?? [];
      const display = displayByUser.get(userId) ?? null;

      if (io) {
        const allNonEveryoneIds = memberRoles.filter((r) => !r.isEveryone).map((r) => r.id);
        const visibleRoleIds = memberRoles.filter((r) => !r.isEveryone && !r.hidden).map((r) => r.id);
        const visibleDisplay = pickDisplayRole(memberRoles.filter((r) => !r.hidden));
        // A member who separately holds a hidden role would otherwise leak that
        // role's display metadata (name/color, when it becomes their new display
        // after the deletion) and its id in roles[] to non-mods on the room
        // broadcast. (The deleted role itself is already gone server-wide and
        // `server-role-deleted` fired above, so only a still-held hidden role can
        // leak here.) Mirrors the assign/remove-member sites' broadened trigger.
        const hiddenInvolved = memberRoles.some((r) => r.hidden && !r.isEveryone);

        if (hiddenInvolved) {
          await emitMemberRoleEventScoped(io, serverId, 'server-member-role-removed', {
            full: { serverId, userId, roleId, roles: allNonEveryoneIds },
            sanitized: { serverId, userId, roleId, roles: visibleRoleIds },
          });
          // Legacy compat event — carries the new display role.
          await emitMemberRoleEventScoped(io, serverId, 'server-member-role-updated', {
            full: {
              serverId, userId,
              roleId: display?.id ?? null,
              roleName: display?.name ?? 'member',
              roleColor: display?.color ?? '#99aab5',
              roleStyle: display?.style ?? 'solid',
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
          io.to(`server:${serverId}`).emit('server-member-role-removed', {
            serverId, userId, roleId,
            roles: allNonEveryoneIds,
          });
          // Legacy compat event — carries the new display role.
          io.to(`server:${serverId}`).emit('server-member-role-updated', {
            serverId, userId,
            roleId: display?.id ?? null,
            roleName: display?.name ?? 'member',
            roleColor: display?.color ?? '#99aab5',
            roleStyle: display?.style ?? 'solid',
          });
        }
      }
    }
  }

  res.status(200).json({ ok: true });
}));

// POST /api/servers/:serverId/roles/:roleId/members – add a role to a member (manageRoles permission).
// Multi-role additive: creates a MemberRole row (idempotent). Does not replace existing roles.
router.post('/:serverId/roles/:roleId/members', validateUuidParams('serverId', 'roleId'), authenticateToken, serverMutationLimiter, validate(addRoleMemberSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const roleId = getParam(req, 'roleId');
  const [actor, actorCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!actor || !actorCtx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(actorCtx, 'manageRoles')) return res.status(403).json({ error: 'You need the Manage Roles permission' });
  const { userId: targetUserId } = req.body as { userId?: string };
  if (!targetUserId) return res.status(400).json({ error: 'userId is required' });
  const role = await prisma.serverRole.findFirst({ where: { id: roleId, serverId } });
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.isEveryone) return res.status(400).json({ error: '@everyone is implicit — cannot assign or remove' });
  // Locked roles (Owner, @everyone) are system-managed and must never be
  // granted via role assignment; ownership moves only through
  // transfer-ownership, the single authoritative path.
  if (role.locked) return res.status(400).json({ error: 'This role is system-managed and cannot be assigned' });

  const isOwner = actorCtx.isOwner === true;
  const actorPosition = actorCtx.roles.length > 0
    ? Math.min(...actorCtx.roles.map(r => r.position))
    : Infinity;
  if (!isOwner && role.position <= actorPosition) {
    return res.status(403).json({ error: 'You cannot assign a role at or above your own position' });
  }

  // Resolve target's effective hierarchy (min position across their current roles).
  const targetCtx = await loadPermissionContext(targetUserId, serverId);
  if (!targetCtx) return res.status(404).json({ error: 'User is not a member of this server' });

  const targetPosition = targetCtx.roles.length > 0
    ? Math.min(...targetCtx.roles.map(r => r.position))
    : Infinity;
  if (!isOwner && targetPosition <= actorPosition) {
    return res.status(403).json({ error: 'You cannot change the role of a member whose role is at or above your own' });
  }

  // Idempotent: upsert the MemberRole row. No-op if already assigned.
  await prisma.memberRole.upsert({
    where: { userId_serverId_roleId: { userId: targetUserId, serverId, roleId } },
    create: { userId: targetUserId, serverId, roleId, assignedBy: req.userId },
    update: {},
  });

  // Recompute display role. Update legacy ServerMember.roleId / role string for badge continuity.
  const allRoles = await prisma.memberRole.findMany({
    where: { userId: targetUserId, serverId },
    include: { role: { select: { id: true, name: true, color: true, style: true, position: true, displaySeparately: true, isEveryone: true, hidden: true } } },
  });
  const display = pickDisplayRole(allRoles.map(mr => mr.role));
  await prisma.serverMember.update({
    where: { userId_serverId: { userId: targetUserId, serverId } },
    data: {
      roleId: display?.id ?? null,
      role: display?.name ?? 'member',
    },
  });
  await invalidatePermissionContext(serverId, targetUserId);

  await createAuditLog(serverId, req.userId!, 'member_role_update', 'user', targetUserId, { roleId, roleName: role.name, action: 'assign' }).catch(() => {});

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    const rolePayload = { id: role.id, name: role.name, color: role.color, style: role.style ?? 'solid', position: role.position, displaySeparately: role.displaySeparately };
    const allNonEveryoneIds = allRoles.filter(mr => !mr.role.isEveryone).map(mr => mr.role.id);
    const visibleRoleIds = allRoles.filter(mr => !mr.role.isEveryone && !mr.role.hidden).map(mr => mr.role.id);
    const visibleDisplay = pickDisplayRole(allRoles.filter(mr => !mr.role.hidden).map(mr => mr.role));
    const displayHidden = display ? !!allRoles.find(mr => mr.role.id === display.id)?.role.hidden : false;
    const holdsHidden = allRoles.some(mr => mr.role.hidden && !mr.role.isEveryone);
    // Hidden-role display metadata (name/color) AND hidden-role ids in roles[]
    // must never broadcast to non-mods. Only pay the per-socket scoping cost
    // when a hidden role is actually involved (added/removed/display) OR the
    // member holds any hidden role whose id would otherwise leak in roles[].
    const hiddenInvolved = role.hidden || displayHidden || holdsHidden;

    if (hiddenInvolved) {
      await emitMemberRoleEventScoped(io, serverId, 'server-member-role-added', {
        full: { serverId, userId: targetUserId, roleId, role: rolePayload, roles: allNonEveryoneIds },
        sanitized: { serverId, userId: targetUserId, roleId, role: role.hidden ? undefined : rolePayload, roles: visibleRoleIds },
      });
      // Legacy compat event — carries the (possibly-updated) display role.
      await emitMemberRoleEventScoped(io, serverId, 'server-member-role-updated', {
        full: {
          serverId, userId: targetUserId,
          roleId: display?.id ?? roleId,
          roleName: display?.name ?? role.name,
          roleColor: display?.color ?? role.color,
          roleStyle: display?.style ?? role.style ?? 'solid',
        },
        sanitized: {
          serverId, userId: targetUserId,
          roleId: visibleDisplay?.id ?? null,
          roleName: visibleDisplay?.name ?? 'member',
          roleColor: visibleDisplay?.color ?? '#99aab5',
          roleStyle: visibleDisplay?.style ?? 'solid',
        },
      });
    } else {
      // No hidden role involved → cheap room broadcast (member holds no hidden
      // roles, so allNonEveryoneIds === visibleRoleIds here).
      io.to(`server:${serverId}`).emit('server-member-role-added', {
        serverId, userId: targetUserId, roleId,
        role: rolePayload,
        roles: allNonEveryoneIds,
      });
      // Legacy compat event — carries the (possibly-updated) display role.
      io.to(`server:${serverId}`).emit('server-member-role-updated', {
        serverId, userId: targetUserId,
        roleId: display?.id ?? roleId,
        roleName: display?.name ?? role.name,
        roleColor: display?.color ?? role.color,
        roleStyle: display?.style ?? role.style ?? 'solid',
      });
    }
  }

  res.status(200).json({ ok: true });
}));

// DELETE /api/servers/:serverId/roles/:roleId/members/:userId – remove a role from a member (manageRoles).
// Multi-role: drops the MemberRole row. No auto-reassignment to Member — @everyone always applies.
router.delete('/:serverId/roles/:roleId/members/:userId', validateUuidParams('serverId', 'roleId', 'userId'), authenticateToken, serverMutationLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const roleId = getParam(req, 'roleId');
  const targetUserId = getParam(req, 'userId');
  const [actor, actorCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!actor || !actorCtx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(actorCtx, 'manageRoles')) return res.status(403).json({ error: 'You need the Manage Roles permission' });
  const targetRole = await prisma.serverRole.findFirst({ where: { id: roleId, serverId } });
  if (!targetRole) return res.status(404).json({ error: 'Role not found' });
  if (targetRole.isEveryone) return res.status(400).json({ error: '@everyone is implicit — cannot remove' });
  // Locked roles are system-managed. Blocking removal here keeps the invariant
  // that the owner always holds the Owner MemberRole (so their administrator
  // permission and display badge never drift), matching the assign-side block.
  if (targetRole.locked) return res.status(400).json({ error: 'This role is system-managed and cannot be removed' });

  const isOwner = actorCtx.isOwner === true;
  const actorPosition = actorCtx.roles.length > 0
    ? Math.min(...actorCtx.roles.map(r => r.position))
    : Infinity;
  if (!isOwner && targetRole.position <= actorPosition) {
    return res.status(403).json({ error: 'You cannot remove members from a role at or above your own position' });
  }

  // Target-member hierarchy gate — mirror the add-member path. A non-owner
  // cannot alter the roles of a member who outranks them (or the owner), even
  // for a role positioned below the actor; without it a low-ranked mod could
  // strip roles from a superior.
  const targetCtx = await loadPermissionContext(targetUserId, serverId);
  if (!targetCtx) return res.status(404).json({ error: 'User is not a member of this server' });
  if (!isOwner) {
    if (targetCtx.isOwner === true) {
      return res.status(403).json({ error: "You cannot change the owner's roles" });
    }
    const targetPosition = targetCtx.roles.length > 0
      ? Math.min(...targetCtx.roles.map(r => r.position))
      : Infinity;
    if (targetPosition <= actorPosition) {
      return res.status(403).json({ error: 'You cannot change the role of a member whose role is at or above your own' });
    }
  }

  const existing = await prisma.memberRole.findUnique({
    where: { userId_serverId_roleId: { userId: targetUserId, serverId, roleId } },
  });
  if (!existing) return res.status(400).json({ error: 'User is not in this role' });

  await prisma.memberRole.delete({
    where: { userId_serverId_roleId: { userId: targetUserId, serverId, roleId } },
  });

  // Recompute display role from remaining MemberRole rows.
  const remaining = await prisma.memberRole.findMany({
    where: { userId: targetUserId, serverId },
    include: { role: { select: { id: true, name: true, color: true, style: true, position: true, displaySeparately: true, isEveryone: true, hidden: true } } },
  });
  const display = pickDisplayRole(remaining.map(mr => mr.role));
  await prisma.serverMember.update({
    where: { userId_serverId: { userId: targetUserId, serverId } },
    data: {
      roleId: display?.id ?? null,
      role: display?.name ?? 'member',
    },
  });
  await invalidatePermissionContext(serverId, targetUserId);

  await createAuditLog(serverId, req.userId!, 'member_role_update', 'user', targetUserId, { previousRoleId: roleId, previousRoleName: targetRole?.name, newRoleName: display?.name ?? 'member', action: 'remove' }).catch(() => {});

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    const allNonEveryoneIds = remaining.filter(mr => !mr.role.isEveryone).map(mr => mr.role.id);
    const visibleRoleIds = remaining.filter(mr => !mr.role.isEveryone && !mr.role.hidden).map(mr => mr.role.id);
    const visibleDisplay = pickDisplayRole(remaining.filter(mr => !mr.role.hidden).map(mr => mr.role));
    const displayHidden = display ? !!remaining.find(mr => mr.role.id === display.id)?.role.hidden : false;
    const holdsHidden = remaining.some(mr => mr.role.hidden && !mr.role.isEveryone);
    // The removed role's hidden flag (it's no longer in `remaining`), the new
    // display role being hidden, or any still-held hidden role would otherwise
    // leak hidden name/color/ids to non-mods on the room broadcast.
    const hiddenInvolved = !!targetRole.hidden || displayHidden || holdsHidden;

    if (hiddenInvolved) {
      await emitMemberRoleEventScoped(io, serverId, 'server-member-role-removed', {
        full: { serverId, userId: targetUserId, roleId, roles: allNonEveryoneIds },
        sanitized: { serverId, userId: targetUserId, roleId, roles: visibleRoleIds },
      });
      await emitMemberRoleEventScoped(io, serverId, 'server-member-role-updated', {
        full: {
          serverId, userId: targetUserId,
          roleId: display?.id ?? null,
          roleName: display?.name ?? 'member',
          roleColor: display?.color ?? '#99aab5',
          roleStyle: display?.style ?? 'solid',
        },
        sanitized: {
          serverId, userId: targetUserId,
          roleId: visibleDisplay?.id ?? null,
          roleName: visibleDisplay?.name ?? 'member',
          roleColor: visibleDisplay?.color ?? '#99aab5',
          roleStyle: visibleDisplay?.style ?? 'solid',
        },
      });
    } else {
      io.to(`server:${serverId}`).emit('server-member-role-removed', {
        serverId, userId: targetUserId, roleId,
        roles: allNonEveryoneIds,
      });
      io.to(`server:${serverId}`).emit('server-member-role-updated', {
        serverId, userId: targetUserId,
        roleId: display?.id ?? null,
        roleName: display?.name ?? 'member',
        roleColor: display?.color ?? '#99aab5',
        roleStyle: display?.style ?? 'solid',
      });
    }
  }

  res.status(200).json({ ok: true });
}));

export default router;
