// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { prisma } from '../db.js';
import { type AdminAuthRequest } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { adminForumsQuery, adminForumActionSchema } from '../schemas.js';
import { logAction, validateUuidParam, adminLimiter } from './adminHelpers.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'adminForums' });
const router = Router();

// GET /api/admin/forums
router.get('/forums', adminLimiter, validate(adminForumsQuery), async (req: AdminAuthRequest, res: Response) => {
  const q = (req.query.q as string || '').trim();
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const serverId = req.query.serverId as string | undefined;
  const limit = 50;
  const skip = (page - 1) * limit;

  const conditions: Prisma.ForumPostWhereInput[] = [];

  if (q) {
    conditions.push({ title: { contains: q, mode: 'insensitive' } });
  }
  if (serverId) {
    conditions.push({ channel: { serverId } });
  }

  const where: Prisma.ForumPostWhereInput = conditions.length > 0 ? { AND: conditions } : {};

  const [posts, total] = await Promise.all([
    prisma.forumPost.findMany({
      where,
      include: {
        channel: {
          select: {
            id: true, name: true,
            server: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.forumPost.count({ where }),
  ]);

  // Resolve author info
  const authorIds = [...new Set(posts.map(p => p.authorId))];
  const authors = authorIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, username: true, discriminator: true, avatar: true },
        take: 50,
      })
    : [];
  const authorMap = new Map(authors.map(u => [u.id, u]));

  res.json({
    posts: posts.map(p => ({
      id: p.id,
      title: p.title,
      locked: p.locked,
      pinned: p.pinned,
      messageCount: p.messageCount,
      createdAt: p.createdAt.toISOString(),
      lastActivityAt: p.lastActivityAt.toISOString(),
      author: authorMap.get(p.authorId) || null,
      channel: { id: p.channel.id, name: p.channel.name },
      server: p.channel.server,
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

// PATCH /api/admin/forums/:postId/lock
router.patch('/forums/:postId/lock', adminLimiter, validate(adminForumActionSchema), async (req: AdminAuthRequest, res: Response) => {
  const postId = validateUuidParam(req.params.postId);
  if (!postId) return res.status(400).json({ error: 'Invalid postId format' });

  const post = await prisma.forumPost.findUnique({
    where: { id: postId },
    select: { id: true, locked: true, authorId: true, title: true },
  });
  if (!post) return res.status(404).json({ error: 'Forum post not found' });

  const newLocked = !post.locked;
  await prisma.forumPost.update({
    where: { id: postId },
    data: { locked: newLocked },
  });
  await logAction(req.adminId!, 'lock_forum_post', post.authorId, { postId, locked: newLocked });

  log.info({ adminId: req.adminId, postId, locked: newLocked }, 'admin toggled forum post lock');
  res.json({ success: true, locked: newLocked });
});

// DELETE /api/admin/forums/:postId
router.delete('/forums/:postId', adminLimiter, validate(adminForumActionSchema), async (req: AdminAuthRequest, res: Response) => {
  const postId = validateUuidParam(req.params.postId);
  if (!postId) return res.status(400).json({ error: 'Invalid postId format' });

  const post = await prisma.forumPost.findUnique({
    where: { id: postId },
    select: { id: true, authorId: true, title: true },
  });
  if (!post) return res.status(404).json({ error: 'Forum post not found' });

  // Cascade: ForumPostTag, ForumMessageReaction (via ForumMessage), ForumMessage are all cascade-deleted by Prisma
  await prisma.forumPost.delete({ where: { id: postId } });
  await logAction(req.adminId!, 'delete_forum_post', post.authorId, { postId, title: post.title });

  log.info({ adminId: req.adminId, postId, title: post.title }, 'admin deleted forum post');
  res.json({ success: true });
});

export default router;
