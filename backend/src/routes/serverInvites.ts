// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import type { Server as SocketServer } from 'socket.io';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getParam, hasPermission, loadPermissionContext } from '../utils.js';
import type { PermissionContext } from '../utils.js';
import { createAuditLog } from './serverSettings.js';
import { validate } from '../middleware/validate.js';
import { createInviteSchema, inviteListQuery, updateInviteSchema } from '../schemas.js';
import { logger } from '../logger.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { powerUpTier, serverMutationLimiter } from './serverHelpers.js';
import { getClientIp } from '../utils/clientIp.js';

const router = Router();

const inviteReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:srv-inv-r:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

function randomInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[bytes[i]! % chars.length];
  return code;
}

const inviteLog = logger.child({ module: 'serverInvites' });

const INVITE_CREATOR_SELECT = { id: true, username: true, discriminator: true, avatar: true } as const;
type InviteCreator = { id: string; username: string; discriminator: string; avatar: string | null };
type InviteRow = {
  id: string;
  code: string;
  useCount: number;
  maxUses: number | null;
  expiresAt: Date | null;
  temporary: boolean;
  label: string | null;
  shareable: boolean;
  createdAt: Date;
};

function inviteBaseUrl(): string {
  return process.env.APP_URL || 'http://localhost:5000';
}

export function serializeInvite(inv: InviteRow, creator: InviteCreator | null) {
  return {
    id: inv.id,
    code: inv.code,
    link: `${inviteBaseUrl()}/invite/${inv.code}`,
    useCount: inv.useCount,
    maxUses: inv.maxUses ?? undefined,
    expiresAt: inv.expiresAt?.toISOString() ?? undefined,
    temporary: inv.temporary,
    label: inv.label ?? undefined,
    shareable: inv.shareable,
    createdAt: inv.createdAt.toISOString(),
    createdBy: creator ?? undefined,
  };
}

type SerializedInvite = ReturnType<typeof serializeInvite>;

// Per-socket filtered emit so non-shareable invite codes (bearer tokens) never
// reach plain members of the server room. Mirrors the GET handler's predicate
// (manageServer || createdById === me || shareable). Mirrors the fetchSockets
// pattern in utils/channelVisibility.ts.
export async function emitInviteToVisibleSockets(params: {
  io: SocketServer;
  serverId: string;
  event: 'server-invite-created' | 'server-invite-updated';
  invite: SerializedInvite;
  alsoEmitDeleteToInvisible?: boolean;
}): Promise<void> {
  const { io, serverId, event, invite, alsoEmitDeleteToInvisible } = params;
  try {
    const sockets = await io.in(`server:${serverId}`).fetchSockets();
    if (sockets.length === 0) return;

    const socketUsers: Array<{ socket: typeof sockets[number]; userId: string }> = [];
    const userIdSet = new Set<string>();
    for (const s of sockets) {
      let userId: string | null = null;
      for (const room of s.rooms) {
        if (room.startsWith('user:')) { userId = room.slice('user:'.length); break; }
      }
      if (!userId) continue;
      socketUsers.push({ socket: s, userId });
      userIdSet.add(userId);
    }
    if (socketUsers.length === 0) return;

    const userIds = [...userIdSet];
    const [members, everyoneRole] = await Promise.all([
      prisma.serverMember.findMany({
        where: { serverId, userId: { in: userIds } },
        include: { memberRoles: { include: { role: true } } },
        take: 1000,
      }),
      prisma.serverRole.findFirst({
        where: { serverId, isEveryone: true },
        select: { id: true, position: true, permissions: true, isEveryone: true },
      }),
    ]);

    const ctxByUser = new Map<string, PermissionContext>();
    for (const m of members) {
      const roles = m.memberRoles.map((mr) => ({
        id: mr.role.id,
        position: mr.role.position,
        permissions: mr.role.permissions,
        isEveryone: mr.role.isEveryone,
      }));
      ctxByUser.set(m.userId, {
        member: { userId: m.userId, role: m.role },
        roles,
        everyoneRole: everyoneRole ?? null,
      });
    }

    const creatorId = invite.createdBy?.id;
    for (const { socket, userId } of socketUsers) {
      const ctx = ctxByUser.get(userId);
      if (!ctx) continue;
      const eligible = invite.shareable || userId === creatorId || hasPermission(ctx, 'manageServer');
      if (eligible) {
        socket.emit(event, { serverId, invite });
      } else if (alsoEmitDeleteToInvisible) {
        socket.emit('server-invite-deleted', { serverId, inviteId: invite.id });
      }
    }
  } catch (err) {
    inviteLog.error({ err, serverId, event, inviteId: invite.id }, 'emitInviteToVisibleSockets failed');
  }
}

// GET /api/servers/:serverId/invites – list invites with creator info (paginated, auto-prune expired)
router.get('/:serverId/invites', validateUuidParams('serverId'), authenticateToken, inviteReadLimiter, validate(inviteListQuery), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member) return res.status(403).json({ error: 'Not a member of this server' });
  const canManage = hasPermission(permCtx, 'manageServer');

  const page = Math.max(Number(req.query.page) || 1, 1);
  const perPage = Math.min(Math.max(Number(req.query.perPage) || 50, 1), 100);

  // Opportunistically prune expired invites if there are many
  const totalInvites = await prisma.invite.count({ where: { serverId } });
  if (totalInvites > 50) {
    const pruned = await prisma.invite.deleteMany({
      where: {
        serverId,
        OR: [
          { expiresAt: { lt: new Date() } },
        ],
      },
    });
    if (pruned.count > 0) {
      inviteLog.info({ serverId, prunedCount: pruned.count }, 'pruned expired invites');
    }
  }

  const now = new Date();
  const visibilityClause = canManage
    ? {}
    : { OR: [{ createdById: req.userId }, { shareable: true }] };
  const activeWhere = {
    AND: [
      { serverId },
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      visibilityClause,
    ],
  };

  const [total, invites] = await Promise.all([
    prisma.invite.count({ where: activeWhere }),
    prisma.invite.findMany({
      where: activeWhere,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  // Filter out maxed-out invites (cannot be expressed in a single Prisma where)
  const active = invites.filter((inv) => {
    if (inv.maxUses != null && inv.useCount >= inv.maxUses) return false;
    return true;
  });

  const creatorIds = [...new Set(active.map((inv) => inv.createdById))];
  const creators = creatorIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: creatorIds } },
        select: INVITE_CREATOR_SELECT,
        take: 100,
      })
    : [];
  const creatorMap = new Map(creators.map((u) => [u.id, u]));

  res.json({
    invites: active.map((inv) => serializeInvite(inv, creatorMap.get(inv.createdById) ?? null)),
    pagination: { page, perPage, total, hasMore: page * perPage < total },
  });
}));

// POST /api/servers/:serverId/invites – create invite (createInvite permission)
router.post('/:serverId/invites', validateUuidParams('serverId'), authenticateToken, serverMutationLimiter, validate(createInviteSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(permCtx,'createInvite')) return res.status(403).json({ error: 'You need the Create Invite permission' });

  const MAX_ACTIVE_INVITES = 50;
  const activeInviteCount = await prisma.invite.count({
    where: {
      serverId,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } },
      ],
    },
  });
  if (activeInviteCount >= MAX_ACTIVE_INVITES) {
    return res.status(400).json({ error: `This server has reached the maximum of ${MAX_ACTIVE_INVITES} active invites. Delete unused invites before creating new ones.` });
  }

  const { customCode, expireAfter, maxUses, temporary, quickInvite, label, shareable } = req.body as {
    customCode?: string;
    expireAfter?: number | null; // seconds (null or 0 = never)
    maxUses?: number | null;     // null or 0 = unlimited
    temporary?: boolean;
    quickInvite?: boolean;
    label?: string;
    shareable?: boolean;
  };
  const canManage = hasPermission(permCtx, 'manageServer');
  const effectiveLabel = canManage && typeof label === 'string' && label.trim() ? label.trim() : null;
  const effectiveShareable = canManage && shareable === true;

  let code: string;
  if (typeof customCode === 'string' && customCode.trim()) {
    const server = await prisma.server.findUnique({ where: { id: serverId }, select: { powerUpCount: true } });
    if (powerUpTier(server?.powerUpCount ?? 0) < 3) {
      return res.status(403).json({ error: 'Custom invite links require Tier 3 (14 power-ups).' });
    }
    const cleaned = customCode.trim().toUpperCase().replace(/[^A-Z0-9\-_]/g, '');
    if (cleaned.length < 3 || cleaned.length > 32) {
      return res.status(400).json({ error: 'Custom invite code must be 3-32 characters (letters, numbers, hyphens, underscores).' });
    }
    const taken = await prisma.invite.findUnique({ where: { code: cleaned } });
    if (taken) return res.status(400).json({ error: 'That invite code is already in use.' });
    code = cleaned;
  } else {
    code = randomInviteCode();
    let existing = await prisma.invite.findUnique({ where: { code } });
    while (existing) {
      code = randomInviteCode();
      existing = await prisma.invite.findUnique({ where: { code } });
    }
  }

  const effectiveExpireAfter = quickInvite && expireAfter === undefined ? 86400 : expireAfter;
  const expiresAt = effectiveExpireAfter && effectiveExpireAfter > 0 ? new Date(Date.now() + effectiveExpireAfter * 1000) : null;
  const maxUsesVal = maxUses && maxUses > 0 ? maxUses : null;

  const invite = await prisma.invite.create({
    data: {
      code,
      serverId,
      createdById: req.userId,
      expiresAt,
      maxUses: maxUsesVal,
      temporary: !!temporary,
      label: effectiveLabel,
      shareable: effectiveShareable,
    },
  });

  await createAuditLog(serverId, req.userId!, 'invite_create', 'invite', invite.id, {
    code, maxUses: maxUsesVal, expiresAt: expiresAt?.toISOString(),
    temporary: !!temporary, label: effectiveLabel, shareable: effectiveShareable,
  }).catch(() => {});
  const creator = await prisma.user.findUnique({
    where: { id: req.userId },
    select: INVITE_CREATOR_SELECT,
  });
  const invitePayload = serializeInvite(invite, creator);

  const io = req.app.get('io') as SocketServer | undefined;
  if (io) await emitInviteToVisibleSockets({ io, serverId, event: 'server-invite-created', invite: invitePayload });

  res.status(201).json(invitePayload);
}));

// DELETE /api/servers/:serverId/invites/:inviteId – delete an invite (manageServer permission or creator)
router.delete('/:serverId/invites/:inviteId', validateUuidParams('serverId', 'inviteId'), authenticateToken, serverMutationLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const inviteId = getParam(req, 'inviteId');
  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member) return res.status(403).json({ error: 'Not a member of this server' });
  const invite = await prisma.invite.findFirst({ where: { id: inviteId, serverId } });
  if (!invite) return res.status(404).json({ error: 'Invite not found' });

  if (!hasPermission(permCtx,'manageServer') && invite.createdById !== req.userId) {
    return res.status(403).json({ error: 'Only the invite creator or someone with Manage Server permission can delete invites.' });
  }

  await prisma.invite.delete({ where: { id: inviteId } });
  await createAuditLog(serverId, req.userId!, 'invite_delete', 'invite', inviteId, { code: invite.code }).catch(() => {});

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) io.to(`server:${serverId}`).emit('server-invite-deleted', { serverId, inviteId });

  res.json({ ok: true });
}));

// PATCH /api/servers/:serverId/invites/:inviteId – update label or shareable (manageServer only)
router.patch('/:serverId/invites/:inviteId', validateUuidParams('serverId', 'inviteId'), authenticateToken, serverMutationLimiter, validate(updateInviteSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const inviteId = getParam(req, 'inviteId');
  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(permCtx, 'manageServer')) {
    return res.status(403).json({ error: 'You need the Manage Server permission to update invites' });
  }
  const invite = await prisma.invite.findFirst({ where: { id: inviteId, serverId } });
  if (!invite) return res.status(404).json({ error: 'Invite not found' });

  const { label, shareable } = req.body as { label?: string | null; shareable?: boolean };
  const data: { label?: string | null; shareable?: boolean } = {};
  if (label !== undefined) data.label = label === null ? null : label.trim() || null;
  if (shareable !== undefined) data.shareable = shareable;

  const updated = await prisma.invite.update({ where: { id: inviteId }, data });

  await createAuditLog(serverId, req.userId!, 'invite_update', 'invite', inviteId, {
    code: invite.code,
    ...(label !== undefined ? { label: data.label } : {}),
    ...(shareable !== undefined ? { shareable: data.shareable } : {}),
  }).catch(() => {});

  const creator = await prisma.user.findUnique({
    where: { id: updated.createdById },
    select: INVITE_CREATOR_SELECT,
  });
  const payload = serializeInvite(updated, creator);

  const io = req.app.get('io') as SocketServer | undefined;
  if (io) {
    // Lockdown ratchet: when shareable flips true → false, the invite becomes
    // invisible to non-admins/non-creators. Emit a synthetic delete to those
    // sockets so their cached lists prune the now-private invite.
    const wasShareable = invite.shareable === true;
    const nowShareable = updated.shareable === true;
    await emitInviteToVisibleSockets({
      io,
      serverId,
      event: 'server-invite-updated',
      invite: payload,
      alsoEmitDeleteToInvisible: wasShareable && !nowShareable,
    });
  }

  res.json(payload);
}));

export default router;
