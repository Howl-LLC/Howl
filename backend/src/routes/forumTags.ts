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
import { createForumTagSchema, updateForumTagSchema, reorderForumTagsSchema } from '../schemas.js';
import { getParam, hasPermission, loadPermissionContext } from '../utils.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'forumTags' });

// Rate limiters

const readLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:forum-tag:read:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const mutateLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:forum-tag:mutate:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many tag actions. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const router = Router();

// GET /:serverId/channels/:channelId/tags — List tags

router.get(
  '/:serverId/channels/:channelId/tags',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  readLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');

    const member = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
    });
    if (!member) return res.status(403).json({ error: 'Not a member of this server' });

    const channel = await prisma.channel.findFirst({
      where: { id: channelId, serverId },
      select: { id: true },
    });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const tags = await prisma.forumTag.findMany({
      where: { channelId },
      orderBy: { position: 'asc' },
      take: 50,
    });

    return res.json(tags);
  }),
);

// POST /:serverId/channels/:channelId/tags — Create tag

router.post(
  '/:serverId/channels/:channelId/tags',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  mutateLimiter,
  validate(createForumTagSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');

    const ctx = await loadPermissionContext(req.userId, serverId);
    if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
    if (!hasPermission(ctx, 'manageChannels')) {
      return res.status(403).json({ error: 'You need Manage Channels permission' });
    }

    const channel = await prisma.channel.findFirst({
      where: { id: channelId, serverId },
      select: { id: true, type: true },
    });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (channel.type !== 'forum') {
      return res.status(400).json({ error: 'Tags are only available on forum channels' });
    }

    const tagCount = await prisma.forumTag.count({ where: { channelId } });
    if (tagCount >= 20) {
      return res.status(400).json({ error: 'Maximum of 20 tags per channel' });
    }

    const maxPos = await prisma.forumTag.aggregate({
      where: { channelId },
      _max: { position: true },
    });
    const position = (maxPos._max.position ?? -1) + 1;

    const { name, emoji, color } = req.body;
    const tag = await prisma.forumTag.create({
      data: { channelId, name, emoji, color, position },
    });

    log.info({ tagId: tag.id, channelId, serverId }, 'Forum tag created');

    const io = req.app.get('io');
    if (io) io.to(`channel:${channelId}`).emit('forum-tag-created', { serverId, channelId, tag });

    return res.status(201).json(tag);
  }),
);

// PATCH /:serverId/channels/:channelId/tags/:tagId — Update tag

router.patch(
  '/:serverId/channels/:channelId/tags/:tagId',
  validateUuidParams('serverId', 'channelId', 'tagId'),
  authenticateToken,
  mutateLimiter,
  validate(updateForumTagSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');
    const tagId = getParam(req, 'tagId');

    const ctx = await loadPermissionContext(req.userId, serverId);
    if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
    if (!hasPermission(ctx, 'manageChannels')) {
      return res.status(403).json({ error: 'You need Manage Channels permission' });
    }

    const tag = await prisma.forumTag.findFirst({
      where: { id: tagId, channelId },
    });
    if (!tag) return res.status(404).json({ error: 'Tag not found' });

    const { name, emoji, color, position } = req.body;
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (emoji !== undefined) data.emoji = emoji;
    if (color !== undefined) data.color = color;
    if (position !== undefined) data.position = position;

    const updated = await prisma.forumTag.update({
      where: { id: tagId },
      data,
    });

    log.info({ tagId, channelId, serverId }, 'Forum tag updated');

    const io = req.app.get('io');
    if (io) io.to(`channel:${channelId}`).emit('forum-tag-updated', { serverId, channelId, tag: updated });

    return res.json(updated);
  }),
);

// DELETE /:serverId/channels/:channelId/tags/:tagId — Delete tag

router.delete(
  '/:serverId/channels/:channelId/tags/:tagId',
  validateUuidParams('serverId', 'channelId', 'tagId'),
  authenticateToken,
  mutateLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');
    const tagId = getParam(req, 'tagId');

    const ctx = await loadPermissionContext(req.userId, serverId);
    if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
    if (!hasPermission(ctx, 'manageChannels')) {
      return res.status(403).json({ error: 'You need Manage Channels permission' });
    }

    const tag = await prisma.forumTag.findFirst({
      where: { id: tagId, channelId },
    });
    if (!tag) return res.status(404).json({ error: 'Tag not found' });

    await prisma.forumTag.delete({ where: { id: tagId } });

    log.info({ tagId, channelId, serverId }, 'Forum tag deleted');

    const io = req.app.get('io');
    if (io) io.to(`channel:${channelId}`).emit('forum-tag-deleted', { serverId, channelId, tagId });

    return res.json({ success: true });
  }),
);

// PUT /:serverId/channels/:channelId/tags/reorder — Reorder tags

router.put(
  '/:serverId/channels/:channelId/tags/reorder',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  mutateLimiter,
  validate(reorderForumTagsSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');

    const ctx = await loadPermissionContext(req.userId, serverId);
    if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
    if (!hasPermission(ctx, 'manageChannels')) {
      return res.status(403).json({ error: 'You need Manage Channels permission' });
    }

    const { tags } = req.body as { tags: Array<{ id: string; position: number }> };

    await prisma.$transaction(
      tags.map((t) =>
        prisma.forumTag.update({
          where: { id: t.id },
          data: { position: t.position },
        }),
      ),
    );

    log.info({ channelId, serverId, count: tags.length }, 'Forum tags reordered');

    // Fetch the updated tag list so all clients see the new order
    const updatedTags = await prisma.forumTag.findMany({
      where: { channelId },
      orderBy: { position: 'asc' },
      take: 50,
    });

    const io = req.app.get('io');
    if (io) io.to(`channel:${channelId}`).emit('forum-tags-reordered', { serverId, channelId, tags: updatedTags });

    return res.json({ success: true });
  }),
);

export default router;
