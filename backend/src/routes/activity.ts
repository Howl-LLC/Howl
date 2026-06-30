// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Activity routes — CRUD for user game/activity status.
 *
 * GET    /api/v1/activity/friends     — batch get friend activities
 * GET    /api/v1/activity/:userId     — get a user's current activity
 * PUT    /api/v1/activity             — set manual/detected activity
 * DELETE /api/v1/activity             — clear current activity
 */

import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { setActivitySchema, getActivityParamsSchema, setCustomGamesSchema, setServerActivitySchema } from '../schemas.js';
import { broadcastActivityChange, fetchAndBroadcastActivities } from '../socketHandlers/infrastructure.js';
import { logActivityToHistory, closeActivityHistory } from '../services/activityHistory.js';
import { invalidatePermissionContext } from '../redis.js';

const log = logger.child({ module: 'routes:activity' });
const router = Router();

// Rate limiters

const activityReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore('rl:activity-read:'),
  keyGenerator: (req) => (req as AuthRequest).userId || req.ip || 'anon',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const activityWriteLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore('rl:activity-write:'),
  keyGenerator: (req) => (req as AuthRequest).userId || req.ip || 'anon',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

// Helpers

const ACTIVITY_SELECT = {
  id: true,
  type: true,
  name: true,
  details: true,
  state: true,
  largeImage: true,
  smallImage: true,
  startedAt: true,
  platformId: true,
  platform: true,
  durationMs: true,
  updatedAt: true,
} as const;

async function areFriends(userA: string, userB: string): Promise<boolean> {
  const count = await prisma.friendRequest.count({
    where: {
      status: 'accepted',
      OR: [
        { fromUserId: userA, toUserId: userB },
        { fromUserId: userB, toUserId: userA },
      ],
    },
  });
  return count > 0;
}

// GET /friends — batch get activities for all friends

router.get('/friends', authenticateToken, activityReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  // Get accepted friendships
  const friendships = await prisma.friendRequest.findMany({
    where: {
      status: 'accepted',
      OR: [{ fromUserId: req.userId }, { toUserId: req.userId }],
    },
    select: { fromUserId: true, toUserId: true },
    take: 2000,
  });

  const rawFriendIds = friendships.map(f =>
    f.fromUserId === req.userId ? f.toUserId : f.fromUserId,
  );

  if (rawFriendIds.length === 0) return res.json([]);

  // Filter out blocked users
  const blocks = await prisma.block.findMany({
    where: {
      OR: [
        { blockerId: req.userId, blockedUserId: { in: rawFriendIds } },
        { blockedUserId: req.userId, blockerId: { in: rawFriendIds } },
      ],
    },
    select: { blockerId: true, blockedUserId: true },
    take: 5000,
  });
  const blockedIds = new Set(blocks.flatMap(b => [b.blockerId, b.blockedUserId]));
  blockedIds.delete(req.userId);
  const friendIds = rawFriendIds.filter(id => !blockedIds.has(id));

  if (friendIds.length === 0) return res.json([]);

  // Fetch activities + privacy settings for all friends in one query
  const friends = await prisma.user.findMany({
    where: { id: { in: friendIds } },
    select: {
      id: true,
      showCurrentActivity: true,
      activity: { select: ACTIVITY_SELECT },
    },
    take: 2000,
  });

  // Filter by privacy: friends_only and everyone both allow friends to see
  const results = friends
    .filter(f => f.showCurrentActivity !== 'nobody' && f.activity)
    .map(f => ({
      userId: f.id,
      activity: f.activity,
    }));

  return res.json(results);
}));

// GET /servers — per-server activity sharing settings

router.get('/servers', authenticateToken, activityReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const members = await prisma.serverMember.findMany({
    where: { userId: req.userId },
    select: {
      serverId: true,
      shareActivity: true,
      server: { select: { id: true, name: true, icon: true, _count: { select: { members: true } } } },
    },
    take: 200,
  });

  return res.json(members.map(m => ({
    serverId: m.server.id,
    serverName: m.server.name,
    serverIcon: m.server.icon,
    memberCount: m.server._count.members,
    shareActivity: m.shareActivity,
  })));
}));

// PATCH /servers/:serverId — set per-server activity override

router.patch('/servers/:serverId', authenticateToken, activityWriteLimiter, validateUuidParams('serverId'), validate(setServerActivitySchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = req.params.serverId as string;

  const member = await prisma.serverMember.findUnique({
    where: { userId_serverId: { userId: req.userId, serverId } },
    select: { userId: true },
  });
  if (!member) return res.status(404).json({ error: 'Not a member of this server' });

  const updated = await prisma.serverMember.update({
    where: { userId_serverId: { userId: req.userId, serverId } },
    data: { shareActivity: req.body.shareActivity },
    select: { shareActivity: true },
  });
  await invalidatePermissionContext(serverId, req.userId);

  // Re-broadcast activity so the toggled server sees/hides it immediately
  fetchAndBroadcastActivities(req.userId).catch(() => {});

  return res.json({ serverId, shareActivity: updated.shareActivity });
}));

// GET /custom-games — get custom game list from UserSettings

router.get('/custom-games', authenticateToken, activityReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const settings = await prisma.userSettings.findUnique({
    where: { userId: req.userId },
    select: { data: true },
  });

  const data = (settings?.data as Record<string, unknown>) ?? {};
  const customGames = Array.isArray(data.customGames) ? data.customGames : [];
  return res.json({ customGames });
}));

// PUT /custom-games — replace custom game list in UserSettings

router.put('/custom-games', authenticateToken, activityWriteLimiter, validate(setCustomGamesSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const { customGames } = req.body;

  // Merge with existing data to preserve other client settings
  const existing = await prisma.userSettings.findUnique({ where: { userId: req.userId }, select: { data: true } });
  const existingData = (existing?.data && typeof existing.data === 'object' && !Array.isArray(existing.data)) ? existing.data as Record<string, unknown> : {};

  await prisma.userSettings.upsert({
    where: { userId: req.userId },
    create: { userId: req.userId, data: { customGames } },
    update: { data: { ...existingData, customGames } },
  });

  log.info({ userId: req.userId, count: customGames.length }, 'custom games updated');
  return res.json({ customGames });
}));

// GET /history — recent activity history for the current user

router.get('/history', authenticateToken, activityReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const history = await prisma.activityHistory.findMany({
    where: { userId: req.userId },
    orderBy: { startedAt: 'desc' },
    take: 20,
    select: {
      id: true,
      type: true,
      name: true,
      details: true,
      largeImage: true,
      smallImage: true,
      platformId: true,
      platform: true,
      startedAt: true,
      endedAt: true,
    },
  });

  res.json(history);
}));

// GET /:userId/history — public activity history (respects privacy)

router.get('/:userId/history', authenticateToken, activityReadLimiter, validateUuidParams('userId'), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const targetUserId = req.params.userId as string;

  const HISTORY_SELECT = {
    id: true, type: true, name: true, details: true,
    largeImage: true, smallImage: true, platformId: true,
    platform: true, startedAt: true, endedAt: true,
  } as const;

  // Own history — return full list
  if (targetUserId === req.userId) {
    const history = await prisma.activityHistory.findMany({
      where: { userId: req.userId },
      orderBy: { startedAt: 'desc' },
      take: 20,
      select: HISTORY_SELECT,
    });
    return res.json(history);
  }

  // Block check — return empty, not 403
  const [blockExists, target] = await Promise.all([
    prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: req.userId, blockedUserId: targetUserId },
          { blockerId: targetUserId, blockedUserId: req.userId },
        ],
      },
      select: { id: true },
    }),
    prisma.user.findUnique({
      where: { id: targetUserId },
      select: { showCurrentActivity: true, profilePrivate: true },
    }),
  ]);

  if (!target) return res.status(404).json({ error: 'User not found' });
  if (blockExists) return res.json([]);

  // Private profile + activity visibility gates (cache friendship check to avoid double query)
  let friendshipChecked = false;
  let isFriend = false;
  if (target.profilePrivate) {
    isFriend = await areFriends(req.userId, targetUserId);
    friendshipChecked = true;
    if (!isFriend) return res.json([]);
  }

  if (target.showCurrentActivity === 'nobody') return res.json([]);

  if (target.showCurrentActivity === 'friends_only') {
    if (!friendshipChecked) isFriend = await areFriends(req.userId, targetUserId);
    if (!isFriend) return res.json([]);
  }

  const history = await prisma.activityHistory.findMany({
    where: { userId: targetUserId },
    orderBy: { startedAt: 'desc' },
    take: 20,
    select: HISTORY_SELECT,
  });

  return res.json(history);
}));

// GET /:userId — get a specific user's activity

router.get('/:userId', authenticateToken, activityReadLimiter, validateUuidParams('userId'), validate(getActivityParamsSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const targetUserId = req.params.userId as string;

  // Own activity: always visible
  if (targetUserId === req.userId) {
    const activity = await prisma.userActivity.findUnique({
      where: { userId: targetUserId },
      select: ACTIVITY_SELECT,
    });
    return res.json({ userId: targetUserId, activity });
  }

  // Parallel: block check + user/activity fetch
  const [blockExists, target] = await Promise.all([
    prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: req.userId, blockedUserId: targetUserId },
          { blockerId: targetUserId, blockedUserId: req.userId },
        ],
      },
      select: { id: true },
    }),
    prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        showCurrentActivity: true,
        profilePrivate: true,
        activity: { select: ACTIVITY_SELECT },
      },
    }),
  ]);

  if (!target) return res.status(404).json({ error: 'User not found' });
  if (blockExists) return res.json({ userId: targetUserId, activity: null });

  // Private profile + activity visibility gates (cache friendship check to avoid double query)
  let friendChecked = false;
  let isFriendResult = false;
  if (target.profilePrivate) {
    isFriendResult = await areFriends(req.userId, targetUserId);
    friendChecked = true;
    if (!isFriendResult) return res.json({ userId: targetUserId, activity: null });
  }

  if (target.showCurrentActivity === 'nobody') return res.json({ userId: targetUserId, activity: null });

  if (target.showCurrentActivity === 'friends_only') {
    if (!friendChecked) isFriendResult = await areFriends(req.userId, targetUserId);
    if (!isFriendResult) return res.json({ userId: targetUserId, activity: null });
  }

  return res.json({ userId: targetUserId, activity: target.activity });
}));

// PUT / — set manual or detected activity

router.put('/', authenticateToken, activityWriteLimiter, validate(setActivitySchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const { type, name, details, state, largeImage, smallImage, platformId, platform } = req.body;

  // Only allow detected_game and custom from client
  if (type !== 'detected_game' && type !== 'custom') {
    return res.status(400).json({ error: 'Type must be "detected_game" or "custom"' });
  }

  // Check if user allows detected games (for Electron client)
  if (type === 'detected_game') {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { shareDetectedGames: true },
    });
    if (user && !user.shareDetectedGames) {
      return res.status(403).json({ error: 'Detected game sharing is disabled' });
    }
  }

  const activity = await prisma.userActivity.upsert({
    where: { userId: req.userId },
    create: {
      userId: req.userId,
      type,
      name,
      details: details || null,
      state: state || null,
      largeImage: largeImage || null,
      smallImage: smallImage || null,
      platformId: platformId || null,
      platform: platform || null,
    },
    update: {
      type,
      name,
      details: details || null,
      state: state || null,
      largeImage: largeImage || null,
      smallImage: smallImage || null,
      platformId: platformId || null,
      platform: platform || null,
    },
    select: ACTIVITY_SELECT,
  });

  // Log to activity history (deduplicate same consecutive game) — fire-and-forget, never block response
  logActivityToHistory(req.userId, { type, name, details, largeImage, smallImage, platformId, platform })
    .catch(err => log.warn({ err: (err as Error).message, userId: req.userId }, 'failed to log activity history'));

  // Broadcast to friends and server members (include secondary if it exists)
  fetchAndBroadcastActivities(req.userId).catch(() => {});

  log.info({ userId: req.userId, type, name }, 'activity set');
  return res.json(activity);
}));

// DELETE / — clear current activity

router.delete('/', authenticateToken, activityWriteLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  // Close the most recent open history entry before deleting the live activity
  await closeActivityHistory(req.userId)
    .catch(err => log.warn({ err: (err as Error).message, userId: req.userId }, 'failed to close activity history'));

  await prisma.userActivity.deleteMany({ where: { userId: req.userId } });

  // Broadcast cleared activity
  broadcastActivityChange(req.userId, null).catch(() => {});

  log.info({ userId: req.userId }, 'activity cleared');
  return res.json({ cleared: true });
}));

export default router;
