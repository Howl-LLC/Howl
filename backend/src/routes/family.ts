// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { createFamilyLinkSchema, updateFamilyRestrictionsSchema } from '../schemas.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { getClientIp } from '../utils/clientIp.js';

const familyLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:family:'),
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const router = Router();

// GET /api/family/links – list all family links (as parent or child)
router.get('/links', authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const links = await prisma.familyLink.findMany({
    where: { OR: [{ parentId: req.userId }, { childId: req.userId }] },
    include: {
      parent: { select: { id: true, username: true, discriminator: true, avatar: true } },
      child: { select: { id: true, username: true, discriminator: true, avatar: true } },
      restriction: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  res.json(links.map((l) => ({
    id: l.id,
    parentId: l.parentId,
    childId: l.childId,
    status: l.status,
    unlinkRequestedAt: l.unlinkRequestedAt?.toISOString() ?? null,
    createdAt: l.createdAt,
    role: l.parentId === req.userId ? 'parent' : 'child',
    parent: l.parent,
    child: l.child,
    restriction: l.restriction,
  })));
}));

// POST /api/family/links – create a family link request (parent sends to child)
router.post('/links', authenticateToken, familyLimiter, validate(createFamilyLinkSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { childUsername, childDiscriminator } = req.body as { childUsername?: string; childDiscriminator?: string };
  if (!childUsername || !childDiscriminator) return res.status(400).json({ error: 'childUsername and childDiscriminator required' });

  // Verify the requesting user (parent) is at least 18 years old
  const parent = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { dateOfBirth: true },
  });
  if (!parent?.dateOfBirth) {
    return res.status(400).json({ error: 'You must set your date of birth before creating a family link.' });
  }
  const today = new Date();
  let parentAge = today.getFullYear() - parent.dateOfBirth.getFullYear();
  const pMonthDiff = today.getMonth() - parent.dateOfBirth.getMonth();
  if (pMonthDiff < 0 || (pMonthDiff === 0 && today.getDate() < parent.dateOfBirth.getDate())) parentAge--;
  if (parentAge < 18) {
    return res.status(403).json({ error: 'You must be at least 18 years old to create a family link.' });
  }

  const child = await prisma.user.findFirst({
    where: { username: { equals: childUsername, mode: 'insensitive' }, discriminator: childDiscriminator },
  });
  if (!child) return res.status(404).json({ error: 'Child account not found' });
  if (child.id === req.userId) return res.status(400).json({ error: 'Cannot link to yourself' });

  const existing = await prisma.familyLink.findUnique({
    where: { parentId_childId: { parentId: req.userId, childId: child.id } },
  });
  if (existing) return res.status(400).json({ error: 'Link already exists', status: existing.status });

  const link = await prisma.familyLink.create({
    data: { parentId: req.userId, childId: child.id, status: 'pending' },
    include: {
      parent: { select: { id: true, username: true, discriminator: true, avatar: true } },
      child: { select: { id: true, username: true, discriminator: true, avatar: true } },
    },
  });

  const linkPayload = {
    id: link.id,
    parentId: link.parentId,
    childId: link.childId,
    status: link.status,
    createdAt: link.createdAt,
    parent: link.parent,
    child: link.child,
    restriction: null,
  };

  // Notify the child about the pending family link request
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${child.id}`).emit('family-link-created', { ...linkPayload, role: 'child' });
  }

  res.status(201).json({ ...linkPayload, role: 'parent' });
}));

// PATCH /api/family/links/:linkId/accept – child accepts a pending link
router.patch('/links/:linkId/accept', validateUuidParams('linkId'), authenticateToken, familyLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const link = await prisma.familyLink.findUnique({ where: { id: req.params.linkId as string } });
  if (!link || link.childId !== req.userId) return res.status(404).json({ error: 'Link not found' });
  if (link.status !== 'pending') return res.status(400).json({ error: 'Link is not pending' });

  const [updated] = await prisma.$transaction([
    prisma.familyLink.update({ where: { id: link.id }, data: { status: 'active' } }),
    prisma.familyRestriction.create({ data: { familyLinkId: link.id } }),
  ]);

  // Notify the parent that the child accepted the link
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${link.parentId}`).emit('family-link-accepted', { linkId: link.id, status: 'active' });
  }

  res.json({ id: updated.id, status: updated.status });
}));

// PATCH /api/family/links/:linkId/revoke – parent revokes the link (or either party declines a pending link)
router.patch('/links/:linkId/revoke', validateUuidParams('linkId'), authenticateToken, familyLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const link = await prisma.familyLink.findUnique({ where: { id: req.params.linkId as string } });
  if (!link || (link.parentId !== req.userId && link.childId !== req.userId)) {
    return res.status(404).json({ error: 'Link not found' });
  }

  const otherPartyId = link.parentId === req.userId ? link.childId : link.parentId;

  if (link.status === 'pending') {
    await prisma.familyLink.update({ where: { id: link.id }, data: { status: 'revoked' } });
    // Notify the other party about the declined/revoked pending link
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) {
      io.to(`user:${otherPartyId}`).emit('family-link-revoked', { linkId: link.id });
    }
    return res.json({ success: true });
  }

  if (link.childId === req.userId) {
    return res.status(403).json({ error: 'Child accounts cannot unlink directly. Use request-unlink instead.' });
  }

  await prisma.familyLink.update({ where: { id: link.id }, data: { status: 'revoked' } });
  // Notify the child that the parent revoked the link
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${link.childId}`).emit('family-link-revoked', { linkId: link.id });
  }
  res.json({ success: true });
}));

// PATCH /api/family/links/:linkId/request-unlink – child requests to be unlinked
router.patch('/links/:linkId/request-unlink', validateUuidParams('linkId'), authenticateToken, familyLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const link = await prisma.familyLink.findUnique({ where: { id: req.params.linkId as string } });
  if (!link || link.childId !== req.userId) return res.status(404).json({ error: 'Link not found' });
  if (link.status !== 'active') return res.status(400).json({ error: 'Link is not active' });
  if (link.unlinkRequestedAt) return res.status(400).json({ error: 'Unlink already requested' });

  const updated = await prisma.familyLink.update({
    where: { id: link.id },
    data: { unlinkRequestedAt: new Date() },
  });

  // Notify the parent about the child's unlink request
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${link.parentId}`).emit('family-unlink-requested', {
      linkId: link.id,
      unlinkRequestedAt: updated.unlinkRequestedAt?.toISOString() ?? null,
    });
  }

  res.json({ id: updated.id, unlinkRequestedAt: updated.unlinkRequestedAt?.toISOString() ?? null });
}));

// PATCH /api/family/links/:linkId/approve-unlink – parent approves unlink request
router.patch('/links/:linkId/approve-unlink', validateUuidParams('linkId'), authenticateToken, familyLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const link = await prisma.familyLink.findUnique({ where: { id: req.params.linkId as string } });
  if (!link || link.parentId !== req.userId) return res.status(404).json({ error: 'Link not found' });
  if (link.status !== 'active') return res.status(400).json({ error: 'Link is not active' });
  if (!link.unlinkRequestedAt) return res.status(400).json({ error: 'No unlink request pending' });

  await prisma.familyLink.update({ where: { id: link.id }, data: { status: 'revoked' } });

  // Notify the child that their unlink request was approved
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${link.childId}`).emit('family-link-revoked', { linkId: link.id });
  }

  res.json({ success: true });
}));

// PATCH /api/family/links/:linkId/deny-unlink – parent denies unlink request
router.patch('/links/:linkId/deny-unlink', validateUuidParams('linkId'), authenticateToken, familyLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const link = await prisma.familyLink.findUnique({ where: { id: req.params.linkId as string } });
  if (!link || link.parentId !== req.userId) return res.status(404).json({ error: 'Link not found' });
  if (link.status !== 'active') return res.status(400).json({ error: 'Link is not active' });
  if (!link.unlinkRequestedAt) return res.status(400).json({ error: 'No unlink request pending' });

  const updated = await prisma.familyLink.update({
    where: { id: link.id },
    data: { unlinkRequestedAt: null },
  });

  // Notify the child that their unlink request was denied
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${link.childId}`).emit('family-unlink-denied', { linkId: link.id });
  }

  res.json({ id: updated.id, unlinkRequestedAt: null });
}));

// PATCH /api/family/links/:linkId/restrictions – parent updates restrictions
router.patch('/links/:linkId/restrictions', validateUuidParams('linkId'), authenticateToken, familyLimiter, validate(updateFamilyRestrictionsSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const link = await prisma.familyLink.findUnique({ where: { id: req.params.linkId as string }, include: { restriction: true } });
  if (!link || link.parentId !== req.userId) return res.status(404).json({ error: 'Link not found' });
  if (link.status !== 'active') return res.status(400).json({ error: 'Link is not active' });

  const { blockDmFromNonFriends, blockServerJoin, dailyTimeLimitMinutes } = req.body as {
    blockDmFromNonFriends?: boolean;
    blockServerJoin?: boolean;
    dailyTimeLimitMinutes?: number | null;
  };

  const data: Record<string, unknown> = {};
  if (typeof blockDmFromNonFriends === 'boolean') data.blockDmFromNonFriends = blockDmFromNonFriends;
  if (typeof blockServerJoin === 'boolean') data.blockServerJoin = blockServerJoin;
  if (dailyTimeLimitMinutes !== undefined) data.dailyTimeLimitMinutes = dailyTimeLimitMinutes;

  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No restriction fields provided' });

  const restriction = link.restriction
    ? await prisma.familyRestriction.update({ where: { id: link.restriction.id }, data })
    : await prisma.familyRestriction.create({ data: { familyLinkId: link.id, ...data } });

  // Notify the child about updated restrictions
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${link.childId}`).emit('family-restrictions-updated', {
      linkId: link.id,
      restriction,
    });
  }

  res.json(restriction);
}));

// GET /api/family/links/:linkId/activity – parent sees child's activity summary
router.get('/links/:linkId/activity', validateUuidParams('linkId'), authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const link = await prisma.familyLink.findUnique({ where: { id: req.params.linkId as string } });
  if (!link || link.parentId !== req.userId) return res.status(404).json({ error: 'Link not found' });
  if (link.status !== 'active') return res.status(400).json({ error: 'Link is not active' });

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [messageCount, serverCount, sessions] = await Promise.all([
    prisma.message.count({ where: { authorId: link.childId, createdAt: { gte: weekAgo } } }),
    prisma.serverMember.count({ where: { userId: link.childId } }),
    prisma.session.findMany({
      where: { userId: link.childId },
      orderBy: { lastActiveAt: 'desc' },
      take: 5,
      select: { deviceName: true, os: true, lastActiveAt: true },
    }),
  ]);

  res.json({
    childId: link.childId,
    weeklyMessageCount: messageCount,
    serverCount,
    recentSessions: sessions,
  });
}));

export default router;
