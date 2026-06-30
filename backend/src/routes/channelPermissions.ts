// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { channelPermissionOverrideSchema, categoryPermissionOverrideSchema } from '../schemas.js';
import { getParam, hasPermission, loadPermissionContext, effectivePosition, unionPerms } from '../utils.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'channelPermissions' });

const permMutationLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:ch-perm:'),
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many permission changes. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const permReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:ch-perm-read:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const router = Router();

// Channel Permission Overrides

// GET /servers/:serverId/channels/:channelId/permissions
router.get('/:serverId/channels/:channelId/permissions', validateUuidParams('serverId', 'channelId'), authenticateToken, permReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const channelId = getParam(req, 'channelId');
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'manageChannels') && !hasPermission(ctx, 'manageRoles')) {
    return res.status(403).json({ error: 'You need Manage Channels or Manage Roles permission' });
  }
  const channel = await prisma.channel.findFirst({ where: { id: channelId, serverId }, select: { id: true, categoryId: true } });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const [overrides, categoryOverrides] = await Promise.all([
    prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 200 }),
    channel.categoryId
      ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 200 })
      : Promise.resolve([]),
  ]);
  res.json({ overrides, categoryOverrides });
}));

// PUT /servers/:serverId/channels/:channelId/permissions
router.put('/:serverId/channels/:channelId/permissions', validateUuidParams('serverId', 'channelId'), authenticateToken, permMutationLimiter, validate(channelPermissionOverrideSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const channelId = getParam(req, 'channelId');
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'manageChannels') && !hasPermission(ctx, 'manageRoles')) {
    return res.status(403).json({ error: 'You need Manage Channels or Manage Roles permission' });
  }
  const channel = await prisma.channel.findFirst({ where: { id: channelId, serverId } });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const { targetType, targetId, permissions } = req.body as { targetType: string; targetId: string; permissions: Record<string, boolean | null> };

  const isOwner = ctx.member.role?.toLowerCase() === 'owner';
  const actorPosition = effectivePosition(ctx);

  // Validate target exists + role hierarchy check
  if (targetType === 'role') {
    if (targetId !== 'everyone') {
      const role = await prisma.serverRole.findFirst({ where: { id: targetId, serverId } });
      if (!role) return res.status(400).json({ error: 'Role not found in this server' });
      if (!isOwner) {
        if (role.position <= actorPosition) {
          return res.status(403).json({ error: 'Cannot set overrides for roles at or above your position' });
        }
      }
    }
    // 'everyone' = virtual @everyone role — no DB lookup needed, always allowed
  } else {
    const targetCtx = await loadPermissionContext(targetId, serverId);
    if (!targetCtx) return res.status(400).json({ error: 'User is not a member of this server' });
    // Role-hierarchy check on the member-target branch.
    // Without this, an actor with `manageChannels` could write overrides
    // targeting higher-ranked members (including admins) and e.g. deny them
    // viewChannels on a channel they would otherwise have access to.
    if (!isOwner) {
      if (targetCtx.member.role?.toLowerCase() === 'owner') {
        return res.status(403).json({ error: 'Cannot set overrides for the server owner' });
      }
      const targetPosition = effectivePosition(targetCtx);
      if (targetPosition <= actorPosition) {
        return res.status(403).json({ error: 'Cannot set overrides for members at or above your position' });
      }
    }
  }

  // Permission grant check: cannot grant permissions you don't have
  if (!isOwner) {
    const actorPerms = unionPerms(ctx.everyoneRole ? [ctx.everyoneRole, ...ctx.roles] : ctx.roles);
    const actorIsAdmin = actorPerms.administrator === true;
    if (!actorIsAdmin) {
      for (const [key, value] of Object.entries(permissions)) {
        if (value === true && !actorPerms[key]) {
          return res.status(403).json({ error: 'Cannot grant permissions you do not have' });
        }
      }
    }
  }

  const override = await prisma.channelPermissionOverride.upsert({
    where: { channelId_targetType_targetId: { channelId, targetType, targetId } },
    create: { channelId, targetType, targetId, permissions },
    update: { permissions },
  });

  log.info({ serverId, channelId, targetType, targetId, actor: req.userId }, 'Channel permission override updated');
  const io = req.app.get('io');
  if (io) io.to(`server:${serverId}`).emit('channel-permissions-updated', { serverId, channelId });
  res.json(override);
}));

// DELETE /servers/:serverId/channels/:channelId/permissions/:overrideId
router.delete('/:serverId/channels/:channelId/permissions/:overrideId', validateUuidParams('serverId', 'channelId', 'overrideId'), authenticateToken, permMutationLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const channelId = getParam(req, 'channelId');
  const overrideId = getParam(req, 'overrideId');
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'manageChannels') && !hasPermission(ctx, 'manageRoles')) {
    return res.status(403).json({ error: 'You need Manage Channels or Manage Roles permission' });
  }
  const override = await prisma.channelPermissionOverride.findFirst({ where: { id: overrideId, channelId } });
  if (!override) return res.status(404).json({ error: 'Permission override not found' });

  await prisma.channelPermissionOverride.delete({ where: { id: overrideId } });
  log.info({ serverId, channelId, overrideId, actor: req.userId }, 'Channel permission override deleted');
  const io = req.app.get('io');
  if (io) io.to(`server:${serverId}`).emit('channel-permissions-updated', { serverId, channelId });
  res.json({ success: true });
}));

// Category Permission Overrides

// GET /servers/:serverId/categories/:categoryId/permissions
router.get('/:serverId/categories/:categoryId/permissions', validateUuidParams('serverId', 'categoryId'), authenticateToken, permReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const categoryId = getParam(req, 'categoryId');
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'manageChannels') && !hasPermission(ctx, 'manageRoles')) {
    return res.status(403).json({ error: 'You need Manage Channels or Manage Roles permission' });
  }
  const category = await prisma.channelCategory.findFirst({ where: { id: categoryId, serverId } });
  if (!category) return res.status(404).json({ error: 'Category not found' });

  const overrides = await prisma.categoryPermissionOverride.findMany({ where: { categoryId }, take: 200 });
  res.json({ overrides });
}));

// PUT /servers/:serverId/categories/:categoryId/permissions
router.put('/:serverId/categories/:categoryId/permissions', validateUuidParams('serverId', 'categoryId'), authenticateToken, permMutationLimiter, validate(categoryPermissionOverrideSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const categoryId = getParam(req, 'categoryId');
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'manageChannels') && !hasPermission(ctx, 'manageRoles')) {
    return res.status(403).json({ error: 'You need Manage Channels or Manage Roles permission' });
  }
  const category = await prisma.channelCategory.findFirst({ where: { id: categoryId, serverId } });
  if (!category) return res.status(404).json({ error: 'Category not found' });

  const { targetType, targetId, permissions } = req.body as { targetType: string; targetId: string; permissions: Record<string, boolean | null> };

  const isOwner = ctx.member.role?.toLowerCase() === 'owner';
  const actorPosition = effectivePosition(ctx);

  // Validate target exists + role hierarchy check
  if (targetType === 'role') {
    if (targetId !== 'everyone') {
      const role = await prisma.serverRole.findFirst({ where: { id: targetId, serverId } });
      if (!role) return res.status(400).json({ error: 'Role not found in this server' });
      if (!isOwner) {
        if (role.position <= actorPosition) {
          return res.status(403).json({ error: 'Cannot set overrides for roles at or above your position' });
        }
      }
    }
    // 'everyone' = virtual @everyone role — no DB lookup needed, always allowed
  } else {
    const targetCtx = await loadPermissionContext(targetId, serverId);
    if (!targetCtx) return res.status(400).json({ error: 'User is not a member of this server' });
    // Category variant: same role-hierarchy check on the member-target branch.
    if (!isOwner) {
      if (targetCtx.member.role?.toLowerCase() === 'owner') {
        return res.status(403).json({ error: 'Cannot set overrides for the server owner' });
      }
      const targetPosition = effectivePosition(targetCtx);
      if (targetPosition <= actorPosition) {
        return res.status(403).json({ error: 'Cannot set overrides for members at or above your position' });
      }
    }
  }

  // Permission grant check: cannot grant permissions you don't have
  if (!isOwner) {
    const actorPerms = unionPerms(ctx.everyoneRole ? [ctx.everyoneRole, ...ctx.roles] : ctx.roles);
    const actorIsAdmin = actorPerms.administrator === true;
    if (!actorIsAdmin) {
      for (const [key, value] of Object.entries(permissions)) {
        if (value === true && !actorPerms[key]) {
          return res.status(403).json({ error: 'Cannot grant permissions you do not have' });
        }
      }
    }
  }

  const override = await prisma.categoryPermissionOverride.upsert({
    where: { categoryId_targetType_targetId: { categoryId, targetType, targetId } },
    create: { categoryId, targetType, targetId, permissions },
    update: { permissions },
  });

  log.info({ serverId, categoryId, targetType, targetId, actor: req.userId }, 'Category permission override updated');
  const io = req.app.get('io');
  if (io) io.to(`server:${serverId}`).emit('category-permissions-updated', { serverId, categoryId });
  res.json(override);
}));

// DELETE /servers/:serverId/categories/:categoryId/permissions/:overrideId
router.delete('/:serverId/categories/:categoryId/permissions/:overrideId', validateUuidParams('serverId', 'categoryId', 'overrideId'), authenticateToken, permMutationLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const categoryId = getParam(req, 'categoryId');
  const overrideId = getParam(req, 'overrideId');
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'manageChannels') && !hasPermission(ctx, 'manageRoles')) {
    return res.status(403).json({ error: 'You need Manage Channels or Manage Roles permission' });
  }
  const override = await prisma.categoryPermissionOverride.findFirst({ where: { id: overrideId, categoryId } });
  if (!override) return res.status(404).json({ error: 'Permission override not found' });

  await prisma.categoryPermissionOverride.delete({ where: { id: overrideId } });
  log.info({ serverId, categoryId, overrideId, actor: req.userId }, 'Category permission override deleted');
  const io = req.app.get('io');
  if (io) io.to(`server:${serverId}`).emit('category-permissions-updated', { serverId, categoryId });
  res.json({ success: true });
}));

export default router;
