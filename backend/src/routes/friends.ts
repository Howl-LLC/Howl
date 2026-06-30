// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { getParam, AUTHOR_USER_SELECT, getEffectivePlan } from '../utils.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { friendRequestSchema, blockUserSchema } from '../schemas.js';
import { computeBadges } from '../utils/badges.js';
import { resolveActivityWinner } from '../socketHandlers/infrastructure.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { logger } from '../logger.js';
import { findUserDmCall, removeDmCallParticipant, setDmCallReverseLookup, dmCallSize, isInDmCall, getDmCallStartTime, deleteDmCallStartTime } from '../redis.js';
import { stopDmCallRing, createDmCallSystemMessage } from '../socketHandlers/infrastructure.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'friends' });

const MAX_RELATIONSHIPS = 1000;

const ACTIVITY_PUBLIC_SELECT = {
  type: true, name: true, details: true, state: true,
  largeImage: true, smallImage: true, startedAt: true,
  platformId: true, platform: true, durationMs: true,
} as const;

const SECONDARY_ACTIVITY_SELECT = {
  type: true, name: true, details: true, state: true,
  largeImage: true, smallImage: true, startedAt: true,
  platformId: true, platform: true, durationMs: true,
} as const;

const router = Router();

const friendRequestLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:friend-req:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many friend requests. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const friendReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:friend-read:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const friendMutateLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:friend-mutate:'),
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

function toUserRow(u: {
  id: string; username: string; discriminator: string; avatar: string | null; status: string;
  banner?: string | null; bannerPositionY?: number | null; bannerZoom?: number | null;
  stripePlan?: string | null; stripeStatus?: string | null; stripePeriodEnd?: Date | null;
  stripeSubscriptionId?: string | null; badges?: string[]; createdAt?: Date;
  nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null;
  avatarEffect?: string | null;
  showCurrentActivity?: string; activitySharingEnabled?: boolean;
  activity?: { type: string; name: string; details?: string | null; state?: string | null; largeImage?: string | null; smallImage?: string | null; startedAt: Date; platformId?: string | null; platform?: string | null; durationMs?: number | null } | null;
  secondaryActivity?: { type: string; name: string; details?: string | null; state?: string | null; largeImage?: string | null; smallImage?: string | null; startedAt: Date; platformId?: string | null; platform?: string | null; durationMs?: number | null } | null;
  activityBio?: string | null; shareActivityBio?: boolean; activitySourcePriority?: string;
}) {
  return {
    id: u.id,
    username: u.username,
    discriminator: u.discriminator,
    avatar: u.avatar ?? undefined,
    banner: u.banner ?? undefined,
    bannerPositionY: u.bannerPositionY ?? 50,
    bannerZoom: u.bannerZoom ?? 100,
    activityBio: (u.status === 'offline' || u.status === 'invisible' || !u.status) ? null : (u.shareActivityBio !== false ? (u.activityBio || null) : null),
    badges: computeBadges(u),
    status: u.status || 'offline',
    nameColor: u.nameColor ?? null,
    nameFont: u.nameFont ?? null,
    nameEffect: u.nameEffect ?? null,
    avatarEffect: u.avatarEffect ?? null,
    stripePlan: u.stripePlan ?? null,
    effectivePlan: getEffectivePlan(u),
    activity: (() => {
      if (u.activitySharingEnabled === false || u.showCurrentActivity === 'nobody') return undefined;
      const effectiveStatus = u.status || 'offline';
      if (effectiveStatus === 'offline' || effectiveStatus === 'invisible') return undefined;
      const winner = resolveActivityWinner(u.activity, u.activityBio, u.shareActivityBio, u.activitySourcePriority);
      if (winner === 'activity' && u.activity) {
        return { type: u.activity.type, name: u.activity.name, details: u.activity.details ?? undefined, state: u.activity.state ?? undefined, largeImage: u.activity.largeImage ?? undefined, smallImage: u.activity.smallImage ?? undefined, startedAt: u.activity.startedAt.toISOString(), platformId: u.activity.platformId ?? undefined, platform: u.activity.platform ?? undefined, durationMs: u.activity.durationMs ?? undefined };
      }
      if (winner === 'bio' && u.activityBio) {
        return { type: 'bio' as const, name: u.activityBio, startedAt: new Date().toISOString() };
      }
      return undefined;
    })(),
    secondaryActivity: (() => {
      if (u.activitySharingEnabled === false || u.showCurrentActivity === 'nobody') return undefined;
      const effectiveStatus = u.status || 'offline';
      if (effectiveStatus === 'offline' || effectiveStatus === 'invisible') return undefined;
      if (!u.secondaryActivity) return undefined;
      const a = u.secondaryActivity;
      return {
        type: a.type, name: a.name, details: a.details ?? undefined,
        state: a.state ?? undefined, largeImage: a.largeImage ?? undefined,
        smallImage: a.smallImage ?? undefined, startedAt: a.startedAt.toISOString(),
        platformId: a.platformId ?? undefined, platform: a.platform ?? undefined,
        durationMs: a.durationMs ?? undefined,
      };
    })(),
  };
}

// POST /api/friends/request – send friend request by username#discriminator
router.post('/request', authenticateToken, friendRequestLimiter, validate(friendRequestSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  const me = req.userId;
  if (!me) return res.status(401).json({ error: 'Not authenticated' });

  // New accounts (< 24h) can send up to 10 friend requests to prevent spam from throwaway accounts
  const sender = await prisma.user.findUnique({ where: { id: me }, select: { createdAt: true } });
  if (!sender) return res.status(401).json({ error: 'Not authenticated' });
  const accountAgeMs = Date.now() - sender.createdAt.getTime();
  if (accountAgeMs < 24 * 60 * 60 * 1000) {
    const sentCount = await prisma.friendRequest.count({ where: { fromUserId: me } });
    if (sentCount >= 10) {
      return res.status(403).json({ error: 'New accounts can send up to 10 friend requests in the first 24 hours.' });
    }
  }

  const raw = (req.body?.usernameDiscriminator ?? req.body?.username ?? '') as string;
  const trimmed = raw.trim();
  const hashIdx = trimmed.indexOf('#');
  const username = hashIdx >= 0 ? trimmed.slice(0, hashIdx).trim() : trimmed;
  const discriminator = hashIdx >= 0 ? trimmed.slice(hashIdx + 1).trim() : '';
  if (!username) return res.status(400).json({ error: 'Enter a username (e.g. username#1234)' });
  if (!discriminator || !/^\d{4}$/.test(discriminator)) return res.status(400).json({ error: 'Enter a valid discriminator (e.g. username#1234)' });

  const target = await prisma.user.findFirst({
    where: {
      username: { equals: username, mode: 'insensitive' },
      discriminator,
    },
    select: { ...AUTHOR_USER_SELECT, showCurrentActivity: true, activitySharingEnabled: true, activity: { select: ACTIVITY_PUBLIC_SELECT }, secondaryActivity: { select: SECONDARY_ACTIVITY_SELECT }, activityBio: true, shareActivityBio: true, activitySourcePriority: true, friendRequestsEveryone: true, friendRequestsFriendsOfFriends: true, friendRequestsServerMembers: true },
  });
  if (!target) return res.status(404).json({ error: 'User not found. Check the username and discriminator.' });
  if (target.id === me) return res.status(400).json({ error: "You can't send a friend request to yourself." });

  const [blocked, blockedBy] = await Promise.all([
    prisma.block.findUnique({
      where: { blockerId_blockedUserId: { blockerId: me, blockedUserId: target.id } },
    }),
    prisma.block.findUnique({
      where: { blockerId_blockedUserId: { blockerId: target.id, blockedUserId: me } },
    }),
  ]);
  if (blocked) return res.status(400).json({ error: 'You have blocked this user.' });
  if (blockedBy) return res.status(400).json({ error: 'You cannot send a friend request to this user.' });

  // Enforce target user's friend request privacy preferences
  if (!target.friendRequestsEveryone) {
    let allowed = false;

    if (target.friendRequestsServerMembers) {
      const sharedServer = await prisma.serverMember.findFirst({
        where: { userId: me, server: { members: { some: { userId: target.id } } } },
        select: { serverId: true },
      });
      if (sharedServer) allowed = true;
    }

    if (!allowed && target.friendRequestsFriendsOfFriends) {
      // Check if any accepted friend of the requester is also an accepted friend of the target
      const myFriends = await prisma.friendRequest.findMany({
        where: { status: 'accepted', OR: [{ fromUserId: me }, { toUserId: me }] },
        select: { fromUserId: true, toUserId: true },
        take: 500,
      });
      const myFriendIds = myFriends.map(f => f.fromUserId === me ? f.toUserId : f.fromUserId);
      if (myFriendIds.length > 0) {
        const mutualFriend = await prisma.friendRequest.findFirst({
          where: {
            status: 'accepted',
            OR: [
              { fromUserId: target.id, toUserId: { in: myFriendIds } },
              { toUserId: target.id, fromUserId: { in: myFriendIds } },
            ],
          },
          select: { id: true },
        });
        if (mutualFriend) allowed = true;
      }
    }

    if (!allowed) {
      log.info({ requesterId: me, targetId: target.id }, 'friend request blocked by privacy settings');
      return res.status(403).json({ error: 'This user is not accepting friend requests.' });
    }
  }

  const [existing, reverse, sentCount, receivedCount, blockCount] = await Promise.all([
    prisma.friendRequest.findUnique({
      where: { fromUserId_toUserId: { fromUserId: me, toUserId: target.id } },
    }),
    prisma.friendRequest.findUnique({
      where: { fromUserId_toUserId: { fromUserId: target.id, toUserId: me } },
    }),
    prisma.friendRequest.count({ where: { fromUserId: me, status: { in: ['pending', 'accepted'] } } }),
    prisma.friendRequest.count({ where: { toUserId: me, status: { in: ['pending', 'accepted'] } } }),
    prisma.block.count({ where: { blockerId: me } }),
  ]);
  const friendCount = sentCount + receivedCount;
  if (existing) {
    if (existing.status === 'accepted') return res.status(400).json({ error: 'You are already friends with this user.' });
    if (existing.status === 'pending') return res.status(400).json({ error: 'Friend request already sent.' });
  }
  if (reverse?.status === 'accepted') return res.status(400).json({ error: 'You are already friends with this user.' });
  if (reverse?.status === 'pending') return res.status(400).json({ error: 'This user has already sent you a friend request. Check Pending to accept.' });

  if (friendCount + blockCount >= MAX_RELATIONSHIPS) {
    return res.status(403).json({ error: `You've reached the maximum of ${MAX_RELATIONSHIPS} friends, pending requests, and blocked users combined.` });
  }

  const fr = await prisma.friendRequest.upsert({
    where: { fromUserId_toUserId: { fromUserId: me, toUserId: target.id } },
    create: { fromUserId: me, toUserId: target.id, status: 'pending' },
    update: { status: 'pending' },
  });

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    const sender = await prisma.user.findUnique({ where: { id: me }, select: { ...AUTHOR_USER_SELECT, showCurrentActivity: true, activitySharingEnabled: true, activity: { select: ACTIVITY_PUBLIC_SELECT }, secondaryActivity: { select: SECONDARY_ACTIVITY_SELECT }, activityBio: true, shareActivityBio: true, activitySourcePriority: true } });
    if (sender) {
      io.to(`user:${target.id}`).emit('friend-request-received', { id: fr.id, user: toUserRow(sender) });
    }
    io.to(`user:${me}`).emit('friend-list-update', { type: 'request-sent' });
  }

  return res.status(201).json({ success: true, user: toUserRow(target) });
}));

// GET /api/friends – list friends (excluding blocked)
router.get('/', authenticateToken, friendReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  const me = req.userId;
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const [blockedByMe, blockedMe, accepted] = await Promise.all([
    prisma.block.findMany({ where: { blockerId: me }, select: { blockedUserId: true }, take: 500 }),
    prisma.block.findMany({ where: { blockedUserId: me }, select: { blockerId: true }, take: 500 }),
    prisma.friendRequest.findMany({
      where: { status: 'accepted', OR: [{ fromUserId: me }, { toUserId: me }] },
      include: { fromUser: { select: { ...AUTHOR_USER_SELECT, showCurrentActivity: true, activitySharingEnabled: true, activity: { select: ACTIVITY_PUBLIC_SELECT }, secondaryActivity: { select: SECONDARY_ACTIVITY_SELECT }, activityBio: true, shareActivityBio: true, activitySourcePriority: true } }, toUser: { select: { ...AUTHOR_USER_SELECT, showCurrentActivity: true, activitySharingEnabled: true, activity: { select: ACTIVITY_PUBLIC_SELECT }, secondaryActivity: { select: SECONDARY_ACTIVITY_SELECT }, activityBio: true, shareActivityBio: true, activitySourcePriority: true } } },
      take: 500,
    }),
  ]);
  const blockedSet = new Set([
    ...blockedByMe.map((b) => b.blockedUserId),
    ...blockedMe.map((b) => b.blockerId),
  ]);
  const friendIds = accepted.map((r) => (r.fromUserId === me ? r.toUserId : r.fromUserId)).filter((id) => !blockedSet.has(id));
  const friendIdSet = new Set(friendIds);
  const byId: Record<string, typeof accepted[0]['fromUser']> = {};
  for (const r of accepted) {
    if (friendIdSet.has(r.fromUser.id) && r.fromUser.id !== me) byId[r.fromUser.id] = r.fromUser;
    if (friendIdSet.has(r.toUser.id) && r.toUser.id !== me) byId[r.toUser.id] = r.toUser;
  }
  const isUserConnectedAsync = req.app.get('isUserConnectedAsync') as ((userId: string) => Promise<boolean>) | undefined;
  const getBulkPresence = req.app.get('getBulkPresence') as ((userIds: string[]) => Promise<Map<string, boolean>>) | undefined;
  const list = friendIds.map((id) => byId[id]).filter(Boolean);
  const userIds = list.map(u => u.id);
  let presenceMap: Map<string, boolean>;
  if (getBulkPresence) {
    presenceMap = await getBulkPresence(userIds);
  } else if (isUserConnectedAsync) {
    const entries = await Promise.all(userIds.map(id => isUserConnectedAsync(id).then(c => [id, c] as const)));
    presenceMap = new Map(entries);
  } else {
    presenceMap = new Map(userIds.map(id => [id, true]));
  }
  const results = list.map(u => {
    const effectiveStatus = presenceMap.get(u.id) === false ? 'offline' : (u.status || 'offline');
    const row = toUserRow({ ...u, status: effectiveStatus });
    return row;
  });
  return res.json(results);
}));

// GET /api/friends/requests – incoming and outgoing pending (excluding blocked)
router.get('/requests', authenticateToken, friendReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  const me = req.userId;
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const [blockedByMe, incoming, outgoing] = await Promise.all([
    prisma.block.findMany({ where: { blockerId: me }, select: { blockedUserId: true }, take: 1000 }),
    prisma.friendRequest.findMany({
      where: { toUserId: me, status: 'pending' },
      include: { fromUser: { select: { ...AUTHOR_USER_SELECT, showCurrentActivity: true, activitySharingEnabled: true, activity: { select: ACTIVITY_PUBLIC_SELECT }, secondaryActivity: { select: SECONDARY_ACTIVITY_SELECT }, activityBio: true, shareActivityBio: true, activitySourcePriority: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.friendRequest.findMany({
      where: { fromUserId: me, status: 'pending' },
      include: { toUser: { select: { ...AUTHOR_USER_SELECT, showCurrentActivity: true, activitySharingEnabled: true, activity: { select: ACTIVITY_PUBLIC_SELECT }, secondaryActivity: { select: SECONDARY_ACTIVITY_SELECT }, activityBio: true, shareActivityBio: true, activitySourcePriority: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);
  const blockedSet = new Set(blockedByMe.map((b) => b.blockedUserId));
  return res.json({
    incoming: incoming.filter((r) => !blockedSet.has(r.fromUserId)).map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString(), user: toUserRow(r.fromUser) })),
    outgoing: outgoing.filter((r) => !blockedSet.has(r.toUserId)).map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString(), user: toUserRow(r.toUser) })),
  });
}));

// POST /api/friends/requests/:requestId/accept
router.post('/requests/:requestId/accept', validateUuidParams('requestId'), authenticateToken, friendMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  const me = req.userId;
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const requestId = getParam(req, 'requestId');
  // Atomic update: the where clause ensures only a pending request owned by `me` is accepted,
  // preventing races where two concurrent accepts both succeed.
  const updated = await prisma.friendRequest.updateMany({
    where: { id: requestId, toUserId: me, status: 'pending' },
    data: { status: 'accepted' },
  });
  if (updated.count === 0) return res.status(404).json({ error: 'Request not found or already handled.' });

  // Fetch the request data for the response and socket notifications
  const request = await prisma.friendRequest.findUnique({
    where: { id: requestId },
    include: { fromUser: { select: { ...AUTHOR_USER_SELECT, showCurrentActivity: true, activitySharingEnabled: true, activity: { select: ACTIVITY_PUBLIC_SELECT }, secondaryActivity: { select: SECONDARY_ACTIVITY_SELECT }, activityBio: true, shareActivityBio: true, activitySourcePriority: true } } },
  });
  if (!request) return res.status(404).json({ error: 'Request not found.' });

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    const acceptor = await prisma.user.findUnique({ where: { id: me }, select: { ...AUTHOR_USER_SELECT, showCurrentActivity: true, activitySharingEnabled: true, activity: { select: ACTIVITY_PUBLIC_SELECT }, secondaryActivity: { select: SECONDARY_ACTIVITY_SELECT }, activityBio: true, shareActivityBio: true, activitySourcePriority: true } });
    if (acceptor) {
      io.to(`user:${request.fromUserId}`).emit('friend-request-accepted', { user: toUserRow(acceptor) });
    }
    io.to(`user:${me}`).emit('friend-list-update', { type: 'request-accepted' });
  }

  return res.json({ success: true, user: toUserRow(request.fromUser) });
}));

// POST /api/friends/requests/:requestId/decline – recipient declines
router.post('/requests/:requestId/decline', validateUuidParams('requestId'), authenticateToken, friendMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  const me = req.userId;
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const requestId = getParam(req, 'requestId');
  const { count } = await prisma.friendRequest.deleteMany({
    where: { id: requestId, toUserId: me, status: 'pending' },
  });
  if (count === 0) return res.status(404).json({ error: 'Friend request not found or already handled' });

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${me}`).emit('friend-list-update', { type: 'request-declined' });
  }

  return res.json({ success: true });
}));

// DELETE /api/friends/requests/:requestId – sender cancels outgoing request (receiver uses POST .../decline)
router.delete('/requests/:requestId', validateUuidParams('requestId'), authenticateToken, friendMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  const me = req.userId;
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const requestId = getParam(req, 'requestId');
  const { count } = await prisma.friendRequest.deleteMany({
    where: { id: requestId, fromUserId: me, status: 'pending' },
  });
  if (count === 0) return res.status(404).json({ error: 'Friend request not found or already handled' });

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${me}`).emit('friend-list-update', { type: 'request-cancelled' });
  }

  return res.json({ success: true });
}));

// DELETE /api/friends/:userId – remove friend
router.delete('/:userId', validateUuidParams('userId'), authenticateToken, friendMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  const me = req.userId;
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const otherId = getParam(req, 'userId');
  const row = await prisma.friendRequest.findFirst({
    where: {
      status: 'accepted',
      OR: [
        { fromUserId: me, toUserId: otherId },
        { fromUserId: otherId, toUserId: me },
      ],
    },
  });
  if (!row) return res.status(404).json({ error: 'Not friends with this user.' });
  await prisma.friendRequest.delete({ where: { id: row.id } });

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${otherId}`).emit('friend-removed', { userId: me });
    io.to(`user:${me}`).emit('friend-list-update', { type: 'friend-removed' });
  }

  return res.json({ success: true });
}));

/**
 * Load the user's blocked-user list in the same shape as `GET /api/friends/blocked`.
 * Shared with the /bootstrap aggregate endpoint so cold-start clients can fetch
 * blocks in one round trip.
 */
export async function loadBlockedUsers(userId: string): Promise<unknown[]> {
  const blocks = await prisma.block.findMany({
    where: { blockerId: userId },
    include: { blockedUser: { select: { ...AUTHOR_USER_SELECT, showCurrentActivity: true, activitySharingEnabled: true, activity: { select: ACTIVITY_PUBLIC_SELECT }, secondaryActivity: { select: SECONDARY_ACTIVITY_SELECT }, activityBio: true, shareActivityBio: true, activitySourcePriority: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  return blocks.map((b) => toUserRow(b.blockedUser));
}

// GET /api/friends/blocked – list blocked users
router.get('/blocked', authenticateToken, friendReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  const me = req.userId;
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  return res.json(await loadBlockedUsers(me));
}));

// POST /api/friends/block – block a user (body: { userId })
router.post('/block', authenticateToken, friendMutateLimiter, validate(blockUserSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  const me = req.userId;
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const { userId } = req.body as { userId?: string };
  if (!userId || userId === me) return res.status(400).json({ error: 'Valid userId required' });
  const [target, alreadyBlocked] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
    prisma.block.findUnique({ where: { blockerId_blockedUserId: { blockerId: me, blockedUserId: userId } } }),
  ]);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!alreadyBlocked) {
    try {
      await prisma.$transaction(async (tx) => {
        const [sentCount2, receivedCount2, blockCount] = await Promise.all([
          tx.friendRequest.count({ where: { fromUserId: me, status: { in: ['pending', 'accepted'] } } }),
          tx.friendRequest.count({ where: { toUserId: me, status: { in: ['pending', 'accepted'] } } }),
          tx.block.count({ where: { blockerId: me } }),
        ]);
        if (sentCount2 + receivedCount2 + blockCount >= MAX_RELATIONSHIPS) {
          throw new Error('LIMIT_REACHED');
        }
        await tx.block.upsert({
          where: { blockerId_blockedUserId: { blockerId: me, blockedUserId: userId } },
          create: { blockerId: me, blockedUserId: userId },
          update: {},
        });
      }, { isolationLevel: 'Serializable' });
    } catch (err: any) {
      if (err.message === 'LIMIT_REACHED') {
        return res.status(403).json({ error: `You've reached the maximum of ${MAX_RELATIONSHIPS} friends, pending requests, and blocked users combined.` });
      }
      throw err;
    }
  }
  // Remove any existing friendship (accepted) and pending requests in both directions
  await prisma.friendRequest.deleteMany({
    where: {
      status: 'accepted',
      OR: [
        { fromUserId: me, toUserId: userId },
        { fromUserId: userId, toUserId: me },
      ],
    },
  }).catch(() => {});
  await prisma.friendRequest.deleteMany({
    where: {
      status: 'pending',
      OR: [
        { fromUserId: me, toUserId: userId },
        { fromUserId: userId, toUserId: me },
      ],
    },
  }).catch(() => {});
  // Notify the blocked user so they see "This user has blocked you" immediately in shared DMs
  const channels = await prisma.dMChannel.findMany({
    where: {
      AND: [
        { participants: { some: { userId: me } } },
        { participants: { some: { userId } } },
      ],
    },
    select: { id: true },
    take: 100,
  });
  const dmChannelIds = channels.map((c) => c.id);
  const io = req.app.get('io') as import('socket.io').Server | undefined;

  // End active DM calls between blocker and blocked user
  try {
    const [blockerDmCallId, blockedDmCallId] = await Promise.all([
      findUserDmCall(me),
      findUserDmCall(userId),
    ]);

    for (const dmCallId of [blockerDmCallId, blockedDmCallId]) {
      if (!dmCallId || !dmChannelIds.includes(dmCallId)) continue;

      const [blockerInCall, blockedInCall] = await Promise.all([
        isInDmCall(dmCallId, me),
        isInDmCall(dmCallId, userId),
      ]);

      if (blockerInCall) {
        await removeDmCallParticipant(dmCallId, me).catch(() => {});
        await setDmCallReverseLookup(me, null).catch(() => {});
        if (io) {
          io.to(`dm-call:${dmCallId}`).emit('dm-call-user-left', { userId: me });
          const blockerSockets = await io.in(`user:${me}`).fetchSockets();
          for (const s of blockerSockets) s.leave(`dm-call:${dmCallId}`);
        }
      }

      if (blockedInCall) {
        await removeDmCallParticipant(dmCallId, userId).catch(() => {});
        await setDmCallReverseLookup(userId, null).catch(() => {});
        if (io) {
          io.to(`dm-call:${dmCallId}`).emit('dm-call-user-left', { userId });
          const blockedSockets = await io.in(`user:${userId}`).fetchSockets();
          for (const s of blockedSockets) s.leave(`dm-call:${dmCallId}`);
        }
      }

      const remaining = await dmCallSize(dmCallId);
      if (remaining === 0) {
        stopDmCallRing(dmCallId);
        const startTime = await getDmCallStartTime(dmCallId);
        await deleteDmCallStartTime(dmCallId).catch(() => {});
        const durationSec = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
        createDmCallSystemMessage(dmCallId, me, 'Call ended', 'call_ended', { durationSeconds: durationSec });
        if (io) io.to(`dm:${dmCallId}`).emit('dm-call-ended', { dmChannelId: dmCallId });
      }
    }

    // Stop any ringing for DM channels between these users
    for (const chId of dmChannelIds) {
      stopDmCallRing(chId);
    }
  } catch { /* DM call cleanup is best-effort — block already created */ }

  if (dmChannelIds.length > 0) {
    if (io) io.to(`user:${userId}`).emit('dm-blocked', { dmChannelIds });
  }
  // Notify both users so friend lists update in real-time
  if (io) {
    io.to(`user:${me}`).emit('friend-removed', { userId });
    io.to(`user:${userId}`).emit('friend-removed', { userId: me });
  }
  return res.status(201).json({ success: true });
}));

// DELETE /api/friends/block/:userId – unblock
router.delete('/block/:userId', validateUuidParams('userId'), authenticateToken, friendMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  const me = req.userId;
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const userId = getParam(req, 'userId');
  await prisma.block.deleteMany({
    where: { blockerId: me, blockedUserId: userId },
  });
  // Notify the unblocked user so they see the block lifted immediately in shared DMs
  const channels = await prisma.dMChannel.findMany({
    where: {
      AND: [
        { participants: { some: { userId: me } } },
        { participants: { some: { userId } } },
      ],
    },
    select: { id: true },
    take: 100,
  });
  const dmChannelIds = channels.map((c) => c.id);
  if (dmChannelIds.length > 0) {
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) io.to(`user:${userId}`).emit('dm-unblocked', { dmChannelIds });
  }
  return res.json({ success: true });
}));

export default router;
