// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { prisma } from '../db.js';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { AuthRequest } from '../middleware/auth.js';
import { getClientIp } from '../utils/clientIp.js';
import { isDmInitRateLimited, recordDmInit as redisRecordDmInit } from '../redis.js';

export const dmFetchLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:dm-fetch:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

/** User IDs that have a block with userId (either direction). */
export async function getUserIdsWithBlock(userId: string): Promise<Set<string>> {
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedUserId: userId }] },
    select: { blockerId: true, blockedUserId: true },
    take: 10000,
  });
  const set = new Set<string>();
  for (const b of blocks) {
    set.add(b.blockerId);
    set.add(b.blockedUserId);
  }
  set.delete(userId);
  return set;
}

/** True if there is a block between the two users (either direction). */
export async function hasBlockBetween(a: string, b: string): Promise<boolean> {
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: a, blockedUserId: b },
        { blockerId: b, blockedUserId: a },
      ],
    },
    select: { id: true },
  });
  return !!block;
}

/** For 1:1: returns { blockedByMe, blockedByThem }. */
export async function getBlockStatus(me: string, otherId: string): Promise<{ blockedByMe: boolean; blockedByThem: boolean }> {
  const [blockedByMe, blockedByThem] = await Promise.all([
    prisma.block.findUnique({ where: { blockerId_blockedUserId: { blockerId: me, blockedUserId: otherId } }, select: { id: true } }),
    prisma.block.findUnique({ where: { blockerId_blockedUserId: { blockerId: otherId, blockedUserId: me } }, select: { id: true } }),
  ]);
  return { blockedByMe: !!blockedByMe, blockedByThem: !!blockedByThem };
}

/** True if userId is a family-restricted child and otherUserId is not their friend. */
export async function hasFamilyDmRestriction(userId: string, otherUserId: string): Promise<boolean> {
  const restriction = await prisma.familyRestriction.findFirst({
    where: {
      familyLink: { childId: userId, status: 'active' },
      blockDmFromNonFriends: true,
    },
  });
  if (!restriction) return false;
  const friendship = await prisma.friendRequest.findFirst({
    where: {
      status: 'accepted',
      OR: [
        { fromUserId: userId, toUserId: otherUserId },
        { fromUserId: otherUserId, toUserId: userId },
      ],
    },
  });
  return !friendship;
}

// DM spam filter (per-sender rate limit for new DM initiations)
//
// 15 new DM channels per sender per hour. Backed by Redis sliding-window in
// `redis.ts` so the cap is shared across all backend replicas. Without that,
// a multi-replica deploy lets a single user create `15 × N` DMs/hour by
// spreading requests across replicas.
export const isDmSpamLimited = isDmInitRateLimited;
export const recordDmInit = redisRecordDmInit;

/** Check if senderId is allowed to DM recipientId based on per-server and global DM privacy settings. */
export async function canUserDm(senderId: string, recipientId: string): Promise<boolean> {
  const friendship = await prisma.friendRequest.findFirst({
    where: {
      status: 'accepted',
      OR: [
        { fromUserId: senderId, toUserId: recipientId },
        { fromUserId: recipientId, toUserId: senderId },
      ],
    },
  });
  if (friendship) return true;

  const recipient = await prisma.user.findUnique({
    where: { id: recipientId },
    select: { allowDmFromServerMembers: true },
  });
  if (!recipient) return false;

  const senderServers = await prisma.serverMember.findMany({
    where: { userId: senderId },
    select: { serverId: true },
    take: 200,
  });
  const senderServerIds = senderServers.map(s => s.serverId);
  const sharedServers = senderServerIds.length > 0
    ? await prisma.serverMember.findMany({
        where: { userId: recipientId, serverId: { in: senderServerIds } },
        select: { allowDirectMessages: true, serverId: true },
        take: 100,
      })
    : [];

  if (sharedServers.length === 0) return recipient.allowDmFromServerMembers;

  // Batch-fetch server settings to avoid N+1
  const serverIds = sharedServers.map(sm => sm.serverId);
  const allSettings = serverIds.length
    ? await prisma.serverSettings.findMany({ where: { serverId: { in: serverIds } }, select: { serverId: true, dmSpamFilter: true } })
    : [];
  const settingsByServerId = new Map(allSettings.map(s => [s.serverId, s]));

  // Single loop: check dmSpamFilter and allowDirectMessages together, return early on first allowed server
  for (const sm of sharedServers) {
    const settings = settingsByServerId.get(sm.serverId);
    if (settings?.dmSpamFilter && (await isDmSpamLimited(senderId))) {
      return false;
    }
    const allowed = sm.allowDirectMessages ?? recipient.allowDmFromServerMembers;
    if (allowed) return true;
  }
  return false;
}
