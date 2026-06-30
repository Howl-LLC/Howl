// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { notificationListQuery, notificationReadAllSchema } from '../schemas.js';
import { getParam } from '../utils.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';

const _log = logger.child({ module: 'notifications' });

// Rate limiters

const notifReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:notif-read:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const notifMutateLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:notif-mutate:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many notification actions. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const router = Router();

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

// GET / — paginated notification list

router.get('/', authenticateToken, notifReadLimiter, validate(notificationListQuery), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const serverId = req.query.serverId as string | undefined;
  const unreadOnly = req.query.unreadOnly !== 'false';
  const before = req.query.before as string | undefined;

  const cutoff = new Date(Date.now() - NINETY_DAYS_MS);

  const where: Record<string, unknown> = {
    userId: req.userId,
    createdAt: before
      ? { lt: new Date(before), gt: cutoff }
      : { gt: cutoff },
  };
  if (serverId) where.serverId = serverId;
  if (unreadOnly) where.read = false;

  const rows = await prisma.notification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const notifications = rows.slice(0, limit);

  res.json({ notifications, hasMore });
}));

/**
 * Compute lightweight badge counts (unread + mention) per server. Shared with
 * the /bootstrap aggregate endpoint so cold-start clients can fetch counts in
 * one round trip.
 */
export async function loadNotificationCounts(userId: string): Promise<{
  total: number;
  byServer: Record<string, { unreadCount: number; mentionCount: number }>;
}> {
  const cutoff = new Date(Date.now() - NINETY_DAYS_MS);
  const baseWhere = { userId, read: false, createdAt: { gt: cutoff } };

  const [counts, mentionCounts] = await Promise.all([
    prisma.notification.groupBy({
      by: ['serverId'],
      where: baseWhere,
      _count: true,
    }),
    prisma.notification.groupBy({
      by: ['serverId'],
      where: { ...baseWhere, type: { in: ['mention', 'everyone', 'thread_mention'] } },
      _count: true,
    }),
  ]);

  const mentionMap = new Map(mentionCounts.map(r => [r.serverId, r._count]));
  let total = 0;
  const byServer: Record<string, { unreadCount: number; mentionCount: number }> = {};

  for (const row of counts) {
    const key = row.serverId ?? '__dm';
    total += row._count;
    byServer[key] = {
      unreadCount: row._count,
      mentionCount: mentionMap.get(row.serverId) ?? 0,
    };
  }

  return { total, byServer };
}

// GET /counts — lightweight badge counts

router.get('/counts', authenticateToken, notifReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  res.json(await loadNotificationCounts(req.userId));
}));

// POST /:notificationId/read — mark one as read

router.post('/:notificationId/read', validateUuidParams('notificationId'), authenticateToken, notifMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const notificationId = getParam(req, 'notificationId');

  const notif = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: { userId: true },
  });
  if (!notif || notif.userId !== req.userId) {
    return res.status(404).json({ error: 'Notification not found' });
  }

  await prisma.notification.update({
    where: { id: notificationId },
    data: { read: true },
  });

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  io?.to(`user:${req.userId}`).emit('notification-read-sync', { notificationId });

  res.status(204).send();
}));

// POST /read-all — mark all read (optionally scoped to a server)

router.post('/read-all', authenticateToken, notifMutateLimiter, validate(notificationReadAllSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { serverId } = req.body as { serverId?: string };

  const where: Record<string, unknown> = { userId: req.userId, read: false };
  if (serverId) where.serverId = serverId;

  await prisma.notification.updateMany({ where, data: { read: true } });

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  io?.to(`user:${req.userId}`).emit('notification-read-sync', { serverId: serverId ?? null, all: !serverId });

  res.status(204).send();
}));

// DELETE /delete-all — delete all notifications for the current user

const deleteAllSchema = z.object({
  body: z.object({
    serverId: z.string().uuid().optional(),
  }).strict(),
});

router.delete('/delete-all', authenticateToken, notifMutateLimiter, validate(deleteAllSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { serverId } = req.body as { serverId?: string };

  const where: Record<string, unknown> = { userId: req.userId };
  if (serverId) where.serverId = serverId;

  const result = await prisma.notification.deleteMany({ where });

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  io?.to(`user:${req.userId}`).emit('notification-delete-sync', {
    serverId: serverId ?? null,
    all: !serverId,
    deletedCount: result.count,
  });

  res.json({ deleted: result.count });
}));

// DELETE /:notificationId — delete one notification

router.delete('/:notificationId', validateUuidParams('notificationId'), authenticateToken, notifMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const notificationId = getParam(req, 'notificationId');

  const notif = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: { userId: true },
  });
  if (!notif || notif.userId !== req.userId) {
    return res.status(404).json({ error: 'Notification not found' });
  }

  await prisma.notification.delete({ where: { id: notificationId } });

  res.status(204).send();
}));

export default router;
