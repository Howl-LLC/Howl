// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { userSearchQuery } from '../schemas.js';
import { PUBLIC_USER_SELECT, getEffectivePlan } from '../utils.js';
import { applyBadgePrefs } from '../utils/badges.js';
import { getClientIp } from '../utils/clientIp.js';

const userSearchValidation = z.object({
  query: userSearchQuery,
});

const router = Router();

const userSearchLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:user-search:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const meReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:users-me:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

// GET /api/v1/users/me — minimal "self" view including content prefs
//
// The historical canonical "me" route lives at `/api/v1/auth/me` (see
// routes/profile.ts) and returns the full user blob the SPA boots from.
// Discovery-related code only needs the small set of fields below — the
// content-filter preference flags plus enough identity to render a card —
// so this endpoint is intentionally narrow and cheap.
router.get('/me', authenticateToken, meReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      id: true,
      username: true,
      discriminator: true,
      avatar: true,
      discoveryOptOut: true,
    },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  return res.json({
    id: user.id,
    username: user.username,
    discriminator: user.discriminator,
    avatar: user.avatar ?? null,
    discoveryOptOut: user.discoveryOptOut,
  });
}));

router.get('/', authenticateToken, userSearchLimiter, validate(userSearchValidation), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const { q: query, limit, offset } = req.query as unknown as { q: string; limit: number; offset: number };

  const [blockedByMe, blockedMe] = await Promise.all([
    prisma.block.findMany({ where: { blockerId: req.userId! }, select: { blockedUserId: true }, take: 1000 }),
    prisma.block.findMany({ where: { blockedUserId: req.userId! }, select: { blockerId: true }, take: 1000 }),
  ]);
  const blockedIds = [
    ...blockedByMe.map(b => b.blockedUserId),
    ...blockedMe.map(b => b.blockerId),
  ];

  const where: Record<string, unknown> = {
    id: blockedIds.length > 0
      ? { not: req.userId, notIn: blockedIds }
      : { not: req.userId },
  };
  if (query) {
    where.username = { startsWith: query, mode: 'insensitive' };
  }

  const users = await prisma.user.findMany({
    where,
    select: { id: true, username: true, discriminator: true, avatar: true },
    take: limit,
    skip: offset,
    orderBy: { username: 'asc' },
  });
  res.json(users.map((u) => ({ id: u.id, username: u.username, discriminator: u.discriminator, avatar: u.avatar ?? undefined })));
}));

// GET /:userId/profile — enriched profile data for full profile modal

const userProfileLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:user-profile:'),
  windowMs: 60_000,
  max: 30,
  message: { error: 'Too many requests. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

router.get('/:userId/profile', authenticateToken, userProfileLimiter, validateUuidParams('userId'), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const targetUserId = req.params.userId as string;
  const serverId = typeof req.query.serverId === 'string' ? req.query.serverId : undefined;

  // Block check
  const blockExists = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: req.userId, blockedUserId: targetUserId },
        { blockerId: targetUserId, blockedUserId: req.userId },
      ],
    },
    select: { id: true },
  });
  if (blockExists) return res.status(403).json({ error: 'Blocked' });

  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: {
      id: true,
      createdAt: true,
      badges: true,
      showBadges: true,
      badgeDisplay: true,
      activityBio: true,
      shareActivityBio: true,
      profilePrivate: true,
      banner: true,
      bannerPositionY: true,
      bannerZoom: true,
      avatar: true,
      nameColor: true,
      nameFont: true,
      nameEffect: true,
      avatarEffect: true,
      stripePlan: true,
      stripeStatus: true,
      stripePeriodEnd: true,
      stripeSubscriptionId: true,
      ssoAccounts: {
        select: { provider: true, displayName: true, providerId: true },
      },
      connectedApps: {
        select: { provider: true, displayName: true, providerId: true },
      },
    },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Private profile gate: non-friends see limited data
  if (user.profilePrivate && targetUserId !== req.userId) {
    const isFriend = await prisma.friendRequest.findFirst({
      where: {
        status: 'accepted',
        OR: [
          { fromUserId: req.userId, toUserId: targetUserId },
          { fromUserId: targetUserId, toUserId: req.userId },
        ],
      },
      select: { id: true },
    });
    if (!isFriend) {
      const limited: Record<string, unknown> = {
        private: true,
        createdAt: user.createdAt.toISOString(),
      };
      // Include server-context data for moderation if in same server
      if (serverId) {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(serverId)) {
          const requesterMember = await prisma.serverMember.findUnique({
            where: { userId_serverId: { userId: req.userId, serverId } },
            select: { userId: true },
          });
          if (requesterMember) {
            const targetMember = await prisma.serverMember.findUnique({
              where: { userId_serverId: { userId: targetUserId, serverId } },
              select: {
                joinedAt: true,
                memberRoles: {
                  include: { role: { select: { id: true, name: true, color: true, style: true, position: true, isEveryone: true } } },
                },
              },
            });
            if (targetMember) {
              limited.serverJoinedAt = targetMember.joinedAt.toISOString();
              // Multi-role: surface every assigned role sorted by hierarchy
              // (lower position = higher rank, like Discord). @everyone is
              // filtered so the chip strip doesn't include the implicit role.
              limited.serverRoles = targetMember.memberRoles
                .map(mr => mr.role)
                .filter(r => !r.isEveryone)
                .sort((a, b) => (a.position ?? 999) - (b.position ?? 999))
                .map(r => ({ id: r.id, name: r.name, color: r.color, style: r.style || 'solid', position: r.position }));
            }
          }
        }
      }
      return res.json(limited);
    }
  }

  const profile: Record<string, unknown> = {
    createdAt: user.createdAt.toISOString(),
    bio: user.shareActivityBio !== false ? (user.activityBio || null) : null,
    connections: [
      ...user.ssoAccounts.filter(s => s.provider === 'steam').map(s => ({ provider: s.provider, displayName: s.displayName, providerId: s.providerId })),
      ...user.connectedApps.map(a => ({ provider: a.provider, displayName: a.displayName, providerId: a.providerId })),
    ],
    banner: user.banner ?? null,
    bannerPositionY: user.bannerPositionY ?? 50,
    bannerZoom: user.bannerZoom ?? 100,
    avatar: user.avatar ?? null,
    nameColor: user.nameColor ?? null,
    nameFont: user.nameFont ?? null,
    nameEffect: user.nameEffect ?? null,
    avatarEffect: user.avatarEffect ?? null,
    effectivePlan: getEffectivePlan(user),
    badges: applyBadgePrefs(user),
  };

  // Server-specific data if requested
  if (serverId) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(serverId)) {
      // Verify requester is also a member of this server
      const requesterMember = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        select: { userId: true },
      });

      if (requesterMember) {
        const targetMember = await prisma.serverMember.findUnique({
          where: { userId_serverId: { userId: targetUserId, serverId } },
          select: {
            joinedAt: true,
            memberRoles: {
              include: { role: { select: { id: true, name: true, color: true, style: true, position: true, isEveryone: true } } },
            },
          },
        });

        if (targetMember) {
          profile.serverJoinedAt = targetMember.joinedAt.toISOString();
          // Multi-role: every role assigned to the member, sorted by
          // hierarchy (lower position = higher rank). @everyone filtered so
          // the chip strip mirrors what's surfaced in the member list.
          profile.serverRoles = targetMember.memberRoles
            .map(mr => mr.role)
            .filter(r => !r.isEveryone)
            .sort((a, b) => (a.position ?? 999) - (b.position ?? 999))
            .map(r => ({ id: r.id, name: r.name, color: r.color, style: r.style || 'solid', position: r.position }));
        }
      }
    }
  }

  return res.json(profile);
}));

// GET /:userId/mutuals — mutual friends and servers

router.get('/:userId/mutuals', authenticateToken, userProfileLimiter, validateUuidParams('userId'), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const targetUserId = req.params.userId as string;

  // Self — no mutuals with yourself
  if (targetUserId === req.userId) return res.json({ mutualFriends: [], mutualServers: [] });

  // Block check — return empty, not 403
  const blockExists = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: req.userId, blockedUserId: targetUserId },
        { blockerId: targetUserId, blockedUserId: req.userId },
      ],
    },
    select: { id: true },
  });
  if (blockExists) return res.json({ mutualFriends: [], mutualServers: [] });

  // Target exists + private profile check
  const targetUser = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, profilePrivate: true } });
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  if (targetUser.profilePrivate) {
    const isFriend = await prisma.friendRequest.findFirst({
      where: {
        status: 'accepted',
        OR: [
          { fromUserId: req.userId, toUserId: targetUserId },
          { fromUserId: targetUserId, toUserId: req.userId },
        ],
      },
      select: { id: true },
    });
    if (!isFriend) return res.json({ mutualFriends: [], mutualServers: [], private: true });
  }

  // Mutual friends: accepted friends with BOTH requester and target
  const [myFriendships, targetFriendships, myMemberships, targetMemberships] = await Promise.all([
    prisma.friendRequest.findMany({
      where: { status: 'accepted', OR: [{ fromUserId: req.userId }, { toUserId: req.userId }] },
      select: { fromUserId: true, toUserId: true },
      take: 5000,
    }),
    prisma.friendRequest.findMany({
      where: { status: 'accepted', OR: [{ fromUserId: targetUserId }, { toUserId: targetUserId }] },
      select: { fromUserId: true, toUserId: true },
      take: 5000,
    }),
    prisma.serverMember.findMany({
      where: { userId: req.userId },
      select: { serverId: true },
      take: 200,
    }),
    prisma.serverMember.findMany({
      where: { userId: targetUserId },
      select: { serverId: true },
      take: 200,
    }),
  ]);

  const myFriends = new Set(myFriendships.map(f => f.fromUserId === req.userId ? f.toUserId : f.fromUserId));
  const targetFriends = new Set(targetFriendships.map(f => f.fromUserId === targetUserId ? f.toUserId : f.fromUserId));
  const mutualFriendIds = [...myFriends].filter(id => targetFriends.has(id));

  // Fetch mutual friend user data (max 50)
  const mutualFriendUsers = mutualFriendIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: mutualFriendIds.slice(0, 50) } },
        select: {
          ...PUBLIC_USER_SELECT,
          stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true,
        },
        take: 50,
      })
    : [];

  const mutualFriends = mutualFriendUsers.map(u => ({
    id: u.id,
    username: u.username,
    discriminator: u.discriminator,
    avatar: u.avatar,
    status: u.status,
    badges: applyBadgePrefs(u),
    effectivePlan: getEffectivePlan(u),
    nameColor: u.nameColor,
    nameFont: u.nameFont,
    nameEffect: u.nameEffect,
    avatarEffect: u.avatarEffect,
  }));

  // Mutual servers: servers where BOTH users are members
  const myServers = new Set(myMemberships.map(m => m.serverId));
  const mutualServerIds = targetMemberships.map(m => m.serverId).filter(id => myServers.has(id));

  const mutualServerData = mutualServerIds.length > 0
    ? await prisma.server.findMany({
        where: { id: { in: mutualServerIds.slice(0, 50) } },
        select: {
          id: true,
          name: true,
          icon: true,
          _count: { select: { members: true } },
        },
        take: 50,
      })
    : [];

  const mutualServers = mutualServerData.map(s => ({
    id: s.id,
    name: s.name,
    icon: s.icon,
    memberCount: s._count.members,
  }));

  return res.json({ mutualFriends, mutualServers });
}));

export default router;
