// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { getEffectivePlan } from '../utils.js';
import { getIO } from '../socketIO.js';
import { getClientIp } from '../utils/clientIp.js';

const router = Router();

/** Emit power-up tier change to all server members. */
function emitPowerUpUpdated(serverId: string, powerUpCount: number): void {
  try {
    const io = getIO();
    io.to(`server:${serverId}`).emit('server-power-up-updated', {
      serverId,
      powerUpCount,
      powerUpTier: powerUpTier(powerUpCount),
    });
  } catch {
    // Socket.IO may not be initialized in tests
  }
}

const powerUpMutateLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:power-up:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many power-up actions. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const MAX_POWER_UPS_PRO = 2;

function powerUpTier(count: number): number {
  if (count >= 14) return 3;
  if (count >= 7) return 2;
  if (count >= 2) return 1;
  return 0;
}

// GET /api/power-ups/me — my power-up slots and where I've used them
router.get('/me', authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const [user, myPowerUps] = await Promise.all([
    prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true, powerUpPaidSlots: true },
    }),
    prisma.serverPowerUp.findMany({
      where: { userId: req.userId },
      include: { server: { select: { id: true, name: true, icon: true, powerUpCount: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);

  const freeSlots = (user && getEffectivePlan(user) === 'pro') ? MAX_POWER_UPS_PRO : 0;
  const paidSlots = user?.powerUpPaidSlots ?? 0;
  const totalSlots = freeSlots + paidSlots;

  res.json({
    totalSlots,
    freeSlots,
    paidSlots,
    used: myPowerUps.length,
    available: Math.max(0, totalSlots - myPowerUps.length),
    powerUps: myPowerUps.map((b) => ({
      id: b.id,
      serverId: b.serverId,
      serverName: b.server.name,
      serverIcon: b.server.icon,
      serverPowerUpCount: b.server.powerUpCount,
      serverPowerUpTier: powerUpTier(b.server.powerUpCount),
      createdAt: b.createdAt.toISOString(),
    })),
  });
}));

// GET /api/power-ups/servers — all servers the user is in, with power-up info
router.get('/servers', authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const [memberships, myPowerUps] = await Promise.all([
    prisma.serverMember.findMany({
      where: { userId: req.userId },
      take: 200,
      include: {
        server: {
          select: { id: true, name: true, icon: true, powerUpCount: true },
        },
      },
    }),
    prisma.serverPowerUp.findMany({
      where: { userId: req.userId },
      select: { serverId: true },
      take: 10,
    }),
  ]);
  const myPowerUpCounts = new Map<string, number>();
  for (const b of myPowerUps) {
    myPowerUpCounts.set(b.serverId, (myPowerUpCounts.get(b.serverId) ?? 0) + 1);
  }

  res.json(
    memberships.map((m) => ({
      id: m.server.id,
      name: m.server.name,
      icon: m.server.icon,
      powerUpCount: m.server.powerUpCount,
      powerUpTier: powerUpTier(m.server.powerUpCount),
      myPowerUpCount: myPowerUpCounts.get(m.server.id) ?? 0,
    }))
  );
}));

// POST /api/power-ups/:serverId — power up a server
router.post('/:serverId', authenticateToken, powerUpMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const serverId = req.params.serverId as string;
  if (!serverId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(serverId)) {
    return res.status(400).json({ error: 'Invalid server ID' });
  }
  const member = await prisma.serverMember.findUnique({ where: { userId_serverId: { userId: req.userId, serverId } }, select: { userId: true } });
  if (!member) return res.status(403).json({ error: 'You must be a member of this server.' });

  const result = await prisma.$transaction(async (tx) => {
    const freshUser = await tx.user.findUnique({
      where: { id: req.userId },
      select: { powerUpPaidSlots: true, stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true },
    });
    const freeSlots = (freshUser && getEffectivePlan(freshUser) === 'pro') ? MAX_POWER_UPS_PRO : 0;
    const totalSlots = freeSlots + (freshUser?.powerUpPaidSlots ?? 0);
    if (totalSlots < 1) return null;
    const usedCount = await tx.serverPowerUp.count({ where: { userId: req.userId } });
    if (usedCount >= totalSlots) return null;
    await tx.serverPowerUp.create({ data: { serverId, userId: req.userId! } });
    return tx.server.update({ where: { id: serverId }, data: { powerUpCount: { increment: 1 } } });
  }, { isolationLevel: 'Serializable' });
  if (!result) {
    return res.status(400).json({ error: 'You\'ve used all your power-up slots. Purchase more or remove one first.' });
  }

  emitPowerUpUpdated(serverId, result.powerUpCount ?? 0);

  res.status(201).json({
    success: true,
    powerUpCount: result.powerUpCount ?? 0,
    powerUpTier: powerUpTier(result.powerUpCount ?? 0),
  });
}));

// DELETE /api/power-ups/:serverId — remove one power-up from a server
router.delete('/:serverId', authenticateToken, powerUpMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const serverId = req.params.serverId as string;
  if (!serverId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(serverId)) {
    return res.status(400).json({ error: 'Invalid server ID' });
  }
  const existing = await prisma.serverPowerUp.findFirst({
    where: { serverId, userId: req.userId },
    orderBy: { createdAt: 'desc' },
  });
  if (!existing) return res.status(404).json({ error: 'You have not powered up this server.' });

  await prisma.$transaction([
    prisma.serverPowerUp.delete({ where: { id: existing.id } }),
    prisma.$executeRaw`UPDATE "Server" SET "powerUpCount" = GREATEST("powerUpCount" - 1, 0) WHERE id = ${serverId}::uuid`,
  ]);
  const updatedServer = await prisma.server.findUnique({ where: { id: serverId }, select: { powerUpCount: true } });
  const deletedPowerUpCount = updatedServer?.powerUpCount ?? 0;
  const deletedPowerUpTier = powerUpTier(deletedPowerUpCount);

  emitPowerUpUpdated(serverId, deletedPowerUpCount);

  res.json({
    success: true,
    powerUpCount: deletedPowerUpCount,
    powerUpTier: deletedPowerUpTier,
  });
}));

export default router;
