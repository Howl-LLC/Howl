// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { prisma } from '../db.js';
import { type AdminAuthRequest } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { adminThreadsQuery, adminThreadActionSchema } from '../schemas.js';
import { logAction, validateUuidParam, adminLimiter } from './adminHelpers.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'adminThreads' });
const router = Router();

// GET /api/admin/threads
router.get('/threads', adminLimiter, validate(adminThreadsQuery), async (req: AdminAuthRequest, res: Response) => {
  const q = (req.query.q as string || '').trim();
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const serverId = req.query.serverId as string | undefined;
  const archived = req.query.archived as string | undefined;
  const limit = 50;
  const skip = (page - 1) * limit;

  const conditions: Prisma.ThreadWhereInput[] = [];

  if (q) {
    conditions.push({ name: { contains: q, mode: 'insensitive' } });
  }
  if (serverId) {
    conditions.push({ serverId });
  }
  if (archived === 'true') {
    conditions.push({ archived: true });
  } else if (archived === 'false') {
    conditions.push({ archived: false });
  }

  const where: Prisma.ThreadWhereInput = conditions.length > 0 ? { AND: conditions } : {};

  const [threads, total] = await Promise.all([
    prisma.thread.findMany({
      where,
      include: {
        channel: { select: { id: true, name: true } },
        server: { select: { id: true, name: true } },
        _count: { select: { messages: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.thread.count({ where }),
  ]);

  // Resolve author info
  const authorIds = [...new Set(threads.map(t => t.authorId))];
  const authors = authorIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, username: true, discriminator: true, avatar: true },
        take: 50,
      })
    : [];
  const authorMap = new Map(authors.map(u => [u.id, u]));

  res.json({
    threads: threads.map(t => ({
      id: t.id,
      name: t.name,
      archived: t.archived,
      archivedAt: t.archivedAt?.toISOString() || null,
      messageCount: t._count.messages,
      lastActivityAt: t.lastActivityAt.toISOString(),
      createdAt: t.createdAt.toISOString(),
      author: authorMap.get(t.authorId) || null,
      channel: t.channel,
      server: t.server,
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

// PATCH /api/admin/threads/:threadId/archive
router.patch('/threads/:threadId/archive', adminLimiter, validate(adminThreadActionSchema), async (req: AdminAuthRequest, res: Response) => {
  const threadId = validateUuidParam(req.params.threadId);
  if (!threadId) return res.status(400).json({ error: 'Invalid threadId format' });

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { id: true, authorId: true, name: true, archived: true },
  });
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  await prisma.thread.update({
    where: { id: threadId },
    data: { archived: true, archivedAt: new Date() },
  });
  await logAction(req.adminId!, 'archive_thread', thread.authorId, { threadId, name: thread.name });

  log.info({ adminId: req.adminId, threadId, name: thread.name }, 'admin archived thread');
  res.json({ success: true });
});

// DELETE /api/admin/threads/:threadId
router.delete('/threads/:threadId', adminLimiter, validate(adminThreadActionSchema), async (req: AdminAuthRequest, res: Response) => {
  const threadId = validateUuidParam(req.params.threadId);
  if (!threadId) return res.status(400).json({ error: 'Invalid threadId format' });

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { id: true, authorId: true, name: true },
  });
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  // Cascade: ThreadMessageReaction (via ThreadMessage), ThreadMessage are cascade-deleted by Prisma
  await prisma.thread.delete({ where: { id: threadId } });
  await logAction(req.adminId!, 'delete_thread', thread.authorId, { threadId, name: thread.name });

  log.info({ adminId: req.adminId, threadId, name: thread.name }, 'admin deleted thread');
  res.json({ success: true });
});

export default router;
