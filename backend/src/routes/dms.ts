// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { createDmSchema, createGroupDmSchema, updateGroupDmSchema, addGroupDmMembersSchema, dmListQuery } from '../schemas.js';
import { getParam, PUBLIC_USER_SELECT, AUTHOR_USER_SELECT, getEffectivePlan } from '../utils.js';
import { applyBadgePrefs } from '../utils/badges.js';
import { hasBlockBetween, hasFamilyDmRestriction, canUserDm, recordDmInit, dmFetchLimiter } from './dmHelpers.js';
import dmMessageRoutes from './dmMessages.js';
import { resolveActivityWinner } from '../socketHandlers/infrastructure.js';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { encryptDmContent, decryptMessageContent } from '../services/dmCrypto.js';
import { logger } from '../logger.js';
import { getDmCallParticipants } from '../redis.js';
import { removeLiveKitParticipant } from '../services/livekitAdmin.js';
import { getClientIp } from '../utils/clientIp.js';
import { checkUploadAttachment } from '../services/uploadProvenance.js';
import { isMasterKeyConfigured } from '../services/e2eEscrow.js';

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

// Repurposed MLS self-leave leader-election (next-oldest fallback): elect the
// oldest NON-pendingRemoval remaining member to author the
// Remove commit that evicts the leaver's leaf, but PREFER the oldest member who
// is currently CONNECTED so an offline absolute-oldest never strands the commit.
// Falls back to the absolute oldest (by joinedAt) only when NO real member is
// connected. If the elected member never lands the Remove (e.g. it was offline
// at leave time, or the only members are all offline), the MLS
// stale-pendingRemoval sweep (cleanup.worker.ts `sweepStalePendingRemovals`,
// every 15 min for removals older than 1 hour) re-fires this same
// dm-key-rotation-needed trigger on a schedule until the Remove lands. That
// sweep is itself presence-aware (prefers an online committer), so once a
// remaining member reconnects a later sweep cycle re-targets it. (There is no
// separate reconnect-time re-emit: the leave route and that sweep are the only
// emitters of dm-key-rotation-needed for the MLS path.) `connectedUserIds` is
// the set of remaining members the server currently has a live socket for.
// Returns null when no real member remains. memberIds is the full real-member
// set (unchanged).
export function electOldestRemaining(
  entries: { userId: string; joinedAt: Date; pendingRemoval: Date | null }[],
  leaverId: string,
  connectedUserIds: Set<string>,
): { oldestMemberId: string; memberIds: string[] } | null {
  const real = entries.filter((p) => p.userId !== leaverId && p.pendingRemoval === null);
  if (real.length === 0) return null;
  const oldestBy = (rows: typeof real) => rows.reduce((a, b) => (a.joinedAt < b.joinedAt ? a : b));
  const connected = real.filter((p) => connectedUserIds.has(p.userId));
  // Prefer the oldest CONNECTED member; fall back to the absolute oldest if none
  // are connected (the stale-pendingRemoval sweep re-fires until it lands).
  const oldest = connected.length > 0 ? oldestBy(connected) : oldestBy(real);
  return { oldestMemberId: oldest.userId, memberIds: real.map((p) => p.userId) };
}

/**
 * Per-1:1-DM "can Howl's servers read this conversation" signal.
 * Hardened for true reconstructability: legacy non-E2E DMs are always readable;
 * escrow only counts when the master key is configured. Returns undefined for
 * group DMs (out of scope).
 */
export function computeServerReadable(opts: {
  channelEncrypted: boolean;
  isGroup: boolean;
  selfUserId: string;
  peerUserIds: string[];
  escrowCapable: Set<string>;
  masterKeyConfigured: boolean;
}): boolean | undefined {
  if (opts.isGroup) return undefined;
  if (!opts.channelEncrypted) return true;
  if (!opts.masterKeyConfigured) return false;
  if (opts.escrowCapable.has(opts.selfUserId)) return true;
  return opts.peerUserIds.some((id) => opts.escrowCapable.has(id));
}

function userActivityForDm(u: DmUserFields): object | undefined {
  if (u.activitySharingEnabled === false || u.showCurrentActivity === 'nobody') return undefined;
  const status = u.status || 'offline';
  if (status === 'offline' || status === 'invisible') return undefined;
  const winner = resolveActivityWinner(u.activity, u.activityBio, u.shareActivityBio, u.activitySourcePriority);
  if (winner === 'activity' && u.activity) {
    const a = u.activity;
    return {
      type: a.type, name: a.name, details: a.details ?? undefined,
      state: a.state ?? undefined, largeImage: a.largeImage ?? undefined,
      smallImage: a.smallImage ?? undefined, startedAt: a.startedAt.toISOString(),
      platformId: a.platformId ?? undefined, platform: a.platform ?? undefined,
      durationMs: a.durationMs ?? undefined,
    };
  }
  if (winner === 'bio' && u.activityBio) {
    return { type: 'bio', name: u.activityBio, startedAt: new Date().toISOString() };
  }
  return undefined;
}

function userSecondaryActivityForDm(u: DmUserFields): object | undefined {
  if (u.activitySharingEnabled === false || u.showCurrentActivity === 'nobody') return undefined;
  const status = u.status || 'offline';
  if (status === 'offline' || status === 'invisible') return undefined;
  if (!u.secondaryActivity) return undefined;
  const a = u.secondaryActivity;
  return {
    type: a.type, name: a.name, details: a.details ?? undefined,
    state: a.state ?? undefined, largeImage: a.largeImage ?? undefined,
    smallImage: a.smallImage ?? undefined, startedAt: a.startedAt.toISOString(),
    platformId: a.platformId ?? undefined, platform: a.platform ?? undefined,
    durationMs: a.durationMs ?? undefined,
  };
}

/** Typed shape of a DM participant's user after Prisma select with AUTHOR_USER_SELECT + activity fields. */
type DmUserFields = {
  id: string;
  username: string;
  discriminator: string | null;
  avatar: string | null;
  banner: string | null;
  bannerPositionY: number | null;
  bannerZoom: number | null;
  status: string;
  createdAt: Date;
  badges: string[];
  nameColor: string | null;
  nameFont: string | null;
  nameEffect: string | null;
  avatarEffect: string | null;
  stripePlan: string | null;
  stripeStatus: string | null;
  stripePeriodEnd: Date | null;
  stripeSubscriptionId: string | null;
  showJoinDate: boolean | null;
  showBadges: boolean | null;
  badgeDisplay?: unknown;
  showCurrentActivity?: 'everyone' | 'friends_only' | 'nobody';
  activitySharingEnabled?: boolean;
  activityBio?: string | null;
  shareActivityBio?: boolean;
  activitySourcePriority?: string;
  activity?: { type: string; name: string; details?: string | null; state?: string | null; largeImage?: string | null; smallImage?: string | null; startedAt: Date; platformId?: string | null; platform?: string | null; durationMs?: number | null } | null;
  secondaryActivity?: { type: string; name: string; details?: string | null; state?: string | null; largeImage?: string | null; smallImage?: string | null; startedAt: Date; platformId?: string | null; platform?: string | null; durationMs?: number | null } | null;
};

function extractProFields(u: DmUserFields) {
  return {
    nameFont: u.nameFont ?? null,
    nameEffect: u.nameEffect ?? null,
    nameColor: u.nameColor ?? null,
    avatarEffect: u.avatarEffect ?? null,
    effectivePlan: getEffectivePlan(u),
    badges: applyBadgePrefs(u),
  };
}

const dmMutateLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:dm-mutate:'),
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const dmCreateLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:dm-create:'),
  windowMs: 60 * 60 * 1000,
  max: 15,
  message: { error: 'Too many DM channels created. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const MAX_DM_CHANNELS = 15000;
const MAX_GROUP_DM_MEMBERS = 15;

const router = Router();

// GET /api/dms – list my DM channels with other user info (1:1 or group)
router.get('/', authenticateToken, dmFetchLimiter, validate(dmListQuery), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const participants = await prisma.dMParticipant.findMany({
    where: { userId: req.userId },
    take: limit,
    orderBy: { dmChannel: { createdAt: 'desc' } },
    include: {
      dmChannel: {
        include: {
          participants: {
            where: { userId: { not: req.userId } },
            include: { user: { select: { ...AUTHOR_USER_SELECT, showCurrentActivity: true, activitySharingEnabled: true, activity: { select: ACTIVITY_PUBLIC_SELECT }, secondaryActivity: { select: SECONDARY_ACTIVITY_SELECT }, activityBio: true, shareActivityBio: true, activitySourcePriority: true } } },
          },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { content: true, contentIv: true, encryptionVersion: true, createdAt: true, authorId: true },
          },
          mlsGroups: {
            select: { id: true, tier: true, currentEpoch: true },
          },
        },
      },
    },
  });
  // Fetch all blocks for this user once to avoid N+1 queries per DM channel
  const allBlocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: req.userId }, { blockedUserId: req.userId }] },
    select: { blockerId: true, blockedUserId: true },
    take: 2000,
  });
  const blockedByMeSet = new Set(allBlocks.filter(b => b.blockerId === req.userId).map(b => b.blockedUserId));
  const blockedByThemSet = new Set(allBlocks.filter(b => b.blockedUserId === req.userId).map(b => b.blockerId));
  const allBlockedUserIds = new Set([...blockedByMeSet, ...blockedByThemSet]);

  // Batch-compute unread message counts for all DM channels (avoids N+1)
  const dmChannelIds = participants.map(p => p.dmChannelId);
  let unreadCountMap = new Map<string, number>();
  if (dmChannelIds.length > 0) {
    const unreadCountsRaw = await prisma.$queryRaw<Array<{ dmChannelId: string; cnt: number }>>`
      SELECT dmp."dmChannelId", LEAST(COUNT(dm.id)::int, 999) as cnt
      FROM "DMParticipant" dmp
      JOIN "DMMessage" dm ON dm."dmChannelId" = dmp."dmChannelId"
        AND dm."createdAt" > COALESCE(dmp."lastReadAt", '1970-01-01'::timestamp)
        AND dm."authorId" != ${req.userId}
      WHERE dmp."userId" = ${req.userId}
        AND dmp."dmChannelId" IN (${Prisma.join(dmChannelIds)})
      GROUP BY dmp."dmChannelId"
    `;
    unreadCountMap = new Map(unreadCountsRaw.map(r => [r.dmChannelId, Number(r.cnt)]));
  }

  // Batch-compute the per-1:1-DM "Howl's servers can read this" signal (avoids N+1).
  // escrowCapable = users whose keys are server-recoverable (Server recovery: a
  // server-readable escrow blob exists). Privacy: only the derived serverReadable
  // boolean reaches the wire; passwordDerived/serverEscrowBlob never leave this scope.
  const peerIds = participants.flatMap((p) => p.dmChannel.participants.map((pp) => pp.userId));
  const bundleIds = Array.from(new Set([req.userId!, ...peerIds]));
  const recoverabilityBundles = bundleIds.length
    ? await prisma.dmKeyBundle.findMany({
        where: { userId: { in: bundleIds } },
        select: { userId: true, passwordDerived: true, serverEscrowBlob: true },
        take: 5000,
      })
    : [];
  const escrowCapable = new Set(
    recoverabilityBundles
      .filter((b) => b.passwordDerived === true && b.serverEscrowBlob != null)
      .map((b) => b.userId),
  );
  const masterKeyConfigured = isMasterKeyConfigured();

  const dms = participants.map((p) => {
      const others = p.dmChannel.participants.map((pp) => pp.user) as unknown as DmUserFields[];
      const lastMsg = p.dmChannel.messages[0];
      const isGroup = p.dmChannel.isGroup;
      let blockedByMe: boolean | undefined;
      let blockedByThem: boolean | undefined;
      let blockedParticipantIds: string[] | undefined;
      if (!isGroup && others[0]) {
        blockedByMe = blockedByMeSet.has(others[0].id);
        blockedByThem = blockedByThemSet.has(others[0].id);
      } else if (isGroup) {
        blockedParticipantIds = others.filter((u) => allBlockedUserIds.has(u.id)).map((u) => u.id);
      }
      const unreadCount = unreadCountMap.get(p.dmChannelId) ?? 0;
      const hasUnread = unreadCount > 0;
      return {
        id: p.dmChannel.id,
        isGroup: isGroup || undefined,
        ownerId: isGroup ? (p.dmChannel.ownerId ?? null) : undefined,
        name: p.dmChannel.name ?? undefined,
        icon: p.dmChannel.icon ?? undefined,
        encrypted: p.dmChannel.encrypted,
        mlsGroupId: p.dmChannel.mlsGroups.find((g) => g.tier === 'saved')?.id ?? null,
        otrMlsGroupId: p.dmChannel.mlsGroups.find((g) => g.tier === 'otr')?.id ?? null,
        otrMlsGroupEpoch: (() => {
          const otr = p.dmChannel.mlsGroups.find((g) => g.tier === 'otr');
          return otr ? otr.currentEpoch.toString() : null;
        })(),
        otherUser: !isGroup && others[0] ? { id: others[0].id, username: others[0].username, discriminator: others[0].discriminator, avatar: others[0].avatar, banner: others[0].banner ?? undefined, bannerPositionY: others[0].bannerPositionY ?? 50, bannerZoom: others[0].bannerZoom ?? 100, ...extractProFields(others[0]), activityBio: (others[0].status !== 'offline' && others[0].status !== 'invisible') ? (others[0].shareActivityBio !== false ? (others[0].activityBio || null) : null) : null, status: others[0].status || 'offline', activity: userActivityForDm(others[0]), secondaryActivity: userSecondaryActivityForDm(others[0]) } : null,
        otherUsers: isGroup ? others.map((u) => ({ id: u.id, username: u.username, discriminator: u.discriminator, avatar: u.avatar, banner: u.banner ?? undefined, bannerPositionY: u.bannerPositionY ?? 50, bannerZoom: u.bannerZoom ?? 100, ...extractProFields(u), activityBio: (u.status !== 'offline' && u.status !== 'invisible') ? (u.shareActivityBio !== false ? (u.activityBio || null) : null) : null, status: u.status || 'offline', activity: userActivityForDm(u), secondaryActivity: userSecondaryActivityForDm(u) })) : undefined,
        lastMessage: lastMsg ? (() => {
          const isE2e = (lastMsg as any).encryptionVersion >= 2;
          const content = isE2e ? lastMsg.content : decryptMessageContent(lastMsg);
          // Detect E2E envelopes stored with wrong encryptionVersion during migration
          const looksEncrypted = !isE2e && content.startsWith('{"v":') && content.includes('"ct"');
          return { content, createdAt: lastMsg.createdAt.toISOString(), authorId: lastMsg.authorId, encrypted: isE2e || looksEncrypted || undefined };
        })() : null,
        hasUnread,
        unreadCount,
        mentionCount: p.mentionCount ?? 0,
        pinned: p.pinned || undefined,
        pinnedAt: p.pinnedAt?.toISOString() ?? undefined,
        ...(blockedByMe !== undefined && { blockedByMe }),
        ...(blockedByThem !== undefined && { blockedByThem }),
        ...(blockedParticipantIds !== undefined && { blockedParticipantIds }),
        serverReadable: computeServerReadable({
          channelEncrypted: p.dmChannel.encrypted,
          isGroup,
          selfUserId: req.userId!,
          peerUserIds: p.dmChannel.participants.map((pp) => pp.userId),
          escrowCapable,
          masterKeyConfigured,
        }),
      };
    });
  res.json(dms);
}));

// GET /api/dms/:dmChannelId/call-status — active call participants
router.get('/:dmChannelId/call-status', validateUuidParams('dmChannelId'), authenticateToken, dmFetchLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');

  // Verify DM membership
  const participant = await prisma.dMParticipant.findUnique({
    where: { userId_dmChannelId: { userId: req.userId, dmChannelId } },
    select: { userId: true },
  });
  if (!participant) return res.status(403).json({ error: 'Not a member of this DM' });

  const participants = await getDmCallParticipants(dmChannelId);
  res.json({
    active: participants.length > 0,
    participants: participants.map(p => ({
      userId: p.userId,
      username: p.username,
      avatar: p.avatar ?? null,
      banner: p.banner ?? null,
      bannerPositionY: p.bannerPositionY ?? 50,
      bannerZoom: p.bannerZoom ?? 100,
      nameColor: p.nameColor ?? null,
      nameFont: p.nameFont ?? null,
      nameEffect: p.nameEffect ?? null,
      avatarEffect: p.avatarEffect ?? null,
      effectivePlan: p.effectivePlan ?? null,
    })),
  });
}));

// POST /api/dms/:dmChannelId/read – mark DM as read (updates lastReadAt for current user)
const dmReadSchema = z.object({
  body: z.object({
    before: z.string().datetime().optional(),
  }).strict().optional(),
});

router.post('/:dmChannelId/read', validateUuidParams('dmChannelId'), authenticateToken, dmMutateLimiter, validate(dmReadSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');
  const participant = await prisma.dMParticipant.findUnique({
    where: { userId_dmChannelId: { userId: req.userId!, dmChannelId } },
    select: { userId: true },
  });
  if (!participant) return res.status(403).json({ error: 'Not in this DM' });

  const before: string | undefined = req.body?.before;
  const readAt = before ? new Date(new Date(before).getTime() - 1) : new Date();

  await prisma.dMParticipant.update({
    where: { userId_dmChannelId: { userId: req.userId!, dmChannelId } },
    data: { lastReadAt: readAt, ...(before ? {} : { mentionCount: 0 }) },
  });

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${req.userId}`).emit('dm-read-state', {
      dmChannelId,
      lastReadAt: readAt.toISOString(),
      ...(before ? { markedUnread: true } : { mentionCount: 0 }),
    });
  }

  return res.status(204).send();
}));

// POST /api/dms/:dmChannelId/pin – pin a DM conversation to the top of the list
router.post('/:dmChannelId/pin', validateUuidParams('dmChannelId'), authenticateToken, dmMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');
  const participant = await prisma.dMParticipant.findUnique({
    where: { userId_dmChannelId: { userId: req.userId!, dmChannelId } },
    select: { userId: true },
  });
  if (!participant) return res.status(403).json({ error: 'Not in this DM' });
  await prisma.dMParticipant.update({
    where: { userId_dmChannelId: { userId: req.userId!, dmChannelId } },
    data: { pinned: true, pinnedAt: new Date() },
  });
  return res.json({ pinned: true });
}));

// DELETE /api/dms/:dmChannelId/pin – unpin a DM conversation
router.delete('/:dmChannelId/pin', validateUuidParams('dmChannelId'), authenticateToken, dmMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');
  const participant = await prisma.dMParticipant.findUnique({
    where: { userId_dmChannelId: { userId: req.userId!, dmChannelId } },
    select: { userId: true },
  });
  if (!participant) return res.status(403).json({ error: 'Not in this DM' });
  await prisma.dMParticipant.update({
    where: { userId_dmChannelId: { userId: req.userId!, dmChannelId } },
    data: { pinned: false, pinnedAt: null },
  });
  return res.json({ pinned: false });
}));

// POST /api/dms - create or get the 1:1 DM channel with another user.
// Keyless create. The channel row is encrypted=true by construction; MLS
// (Welcome / External Commit, established client-side after create) is the
// sole key distribution. No PendingKeyDelivery dead-drop is written.
router.post('/', authenticateToken, dmCreateLimiter, dmMutateLimiter, validate(createDmSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { otherUserId } = req.body as { otherUserId: string };
  if (otherUserId === req.userId) return res.status(400).json({ error: 'Cannot DM yourself' });

  const other = await prisma.user.findUnique({ where: { id: otherUserId }, select: PUBLIC_USER_SELECT });
  if (!other) return res.status(403).json({ error: "This user's privacy settings prevent you from messaging them." });

  const [familyRestriction1, familyRestriction2, canDm] = await Promise.all([
    hasFamilyDmRestriction(req.userId, otherUserId),
    hasFamilyDmRestriction(otherUserId, req.userId),
    canUserDm(req.userId, otherUserId),
  ]);
  if (familyRestriction1) {
    return res.status(403).json({ error: 'A parent account has restricted DMs to friends only.' });
  }
  if (familyRestriction2) {
    return res.status(403).json({ error: "This user's privacy settings prevent you from messaging them." });
  }
  if (!canDm) {
    return res.status(403).json({ error: "This user's privacy settings prevent you from messaging them." });
  }

  // Find or create 1:1 DM atomically to prevent duplicates
  // Block check is inside the transaction to eliminate TOCTOU window
  const result = await prisma.$transaction(async (tx) => {
    const blockExists = await tx.block.findFirst({
      where: {
        OR: [
          { blockerId: req.userId!, blockedUserId: otherUserId },
          { blockerId: otherUserId, blockedUserId: req.userId! },
        ],
      },
      select: { id: true },
    });
    if (blockExists) return { error: 'blocked' } as const;

    const candidates = await tx.dMChannel.findMany({
      where: {
        AND: [
          { participants: { some: { userId: req.userId } } },
          { participants: { some: { userId: otherUserId } } },
        ],
      },
      take: 10,
      include: {
        participants: {
          where: { userId: { not: req.userId } },
          include: { user: { select: AUTHOR_USER_SELECT } },
        },
      },
    });
    const existing = candidates.find((ch) => ch.participants.length === 1);
    if (existing) return { channel: existing, isNew: false };

    const dmCount = await tx.dMParticipant.count({ where: { userId: req.userId } });
    if (dmCount >= MAX_DM_CHANNELS) return { error: 'limit' } as const;

    const created = await tx.dMChannel.create({
      data: {
        encrypted: true,
        participants: {
          create: [
            { userId: req.userId! },
            { userId: otherUserId },
          ],
        },
      },
      include: {
        participants: {
          where: { userId: { not: req.userId } },
          include: { user: { select: AUTHOR_USER_SELECT } },
        },
      },
    });

    return { channel: created, isNew: true };
  });

  if ('error' in result) {
    if (result.error === 'blocked') {
      return res.status(403).json({ error: "This user's privacy settings prevent you from messaging them." });
    }
    return res.status(403).json({ error: `You've reached the maximum of ${MAX_DM_CHANNELS.toLocaleString()} direct message channels.` });
  }

  const otherUser = result.channel.participants[0]?.user as DmUserFields | undefined;
  const peerId = result.channel.participants[0]?.user.id as string | undefined;
  const recoverabilityIds = Array.from(new Set([req.userId!, peerId].filter(Boolean) as string[]));
  const recoverabilityBundles = await prisma.dmKeyBundle.findMany({
    where: { userId: { in: recoverabilityIds } },
    select: { userId: true, passwordDerived: true, serverEscrowBlob: true },
    take: 10,
  });
  const escrowCapable = new Set(
    recoverabilityBundles
      .filter((b) => b.passwordDerived === true && b.serverEscrowBlob != null)
      .map((b) => b.userId),
  );
  const statusCode = result.isNew ? 201 : 200;
  res.status(statusCode).json({
    id: result.channel.id,
    encrypted: result.channel.encrypted,
    otherUser: otherUser ? { id: otherUser.id, username: otherUser.username, discriminator: otherUser.discriminator, avatar: otherUser.avatar, ...extractProFields(otherUser), status: otherUser.status || 'offline' } : null,
    serverReadable: computeServerReadable({
      channelEncrypted: result.channel.encrypted,
      isGroup: false,
      selfUserId: req.userId!,
      peerUserIds: peerId ? [peerId] : [],
      escrowCapable,
      masterKeyConfigured: isMasterKeyConfigured(),
    }),
  });

  if (!result.isNew) return;
  await recordDmInit(req.userId);

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    const creator = await prisma.user.findUnique({ where: { id: req.userId! }, select: PUBLIC_USER_SELECT });
    if (creator) {
      // Auto-subscribe both parties' live sockets to the new DM room so
      // messages flow immediately. Connection-time auto-subscribe
      // (connection.ts) handles future reconnects; this covers the
      // currently-connected session.
      io.in(`user:${req.userId!}`).socketsJoin(`dm:${result.channel.id}`);
      io.in(`user:${otherUserId}`).socketsJoin(`dm:${result.channel.id}`);
      io.to(`user:${otherUserId}`).emit('new-dm-channel', {
        id: result.channel.id,
        otherUser: { id: creator.id, username: creator.username, discriminator: creator.discriminator, avatar: creator.avatar, status: (creator.status as string) || 'offline' },
        encrypted: result.channel.encrypted,
        mlsGroupId: null,
      });
    }
  }
}));

// POST /api/dms/group – create or get group DM. All group DMs are MLS-only;
// the MLS Welcome is the sole key distribution (no legacy X25519 dead-drop).
router.post('/group', authenticateToken, dmCreateLimiter, dmMutateLimiter, validate(createGroupDmSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { memberIds } = req.body as { memberIds: string[] };
  const unique = [...new Set(memberIds)].filter((id) => id !== req.userId);
  if (unique.length < 1) return res.status(400).json({ error: 'Add at least one other member' });

  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true } });
  if (users.length !== unique.length) return res.status(404).json({ error: 'One or more users not found' });

  for (const memberId of unique) {
    const [blocked, famRestrict1, famRestrict2, canDm] = await Promise.all([
      hasBlockBetween(req.userId!, memberId),
      hasFamilyDmRestriction(req.userId!, memberId),
      hasFamilyDmRestriction(memberId, req.userId!),
      canUserDm(req.userId!, memberId),
    ]);
    if (blocked) return res.status(403).json({ error: 'Cannot create group DM: one or more users are blocked.' });
    if (famRestrict1 || famRestrict2) return res.status(403).json({ error: 'Cannot create group DM: family restrictions apply.' });
    if (!canDm) return res.status(403).json({ error: 'Cannot create group DM: one or more users have restricted DMs.' });
  }

  // Cross-member block check: don't put people who've blocked each other in the same group
  if (unique.length > 1) {
    const allUserIds = [req.userId!, ...unique];
    const blockPairs: { blockerId: string; blockedUserId: string }[] = [];
    for (let i = 0; i < allUserIds.length; i++) {
      for (let j = i + 1; j < allUserIds.length; j++) {
        blockPairs.push(
          { blockerId: allUserIds[i], blockedUserId: allUserIds[j] },
          { blockerId: allUserIds[j], blockedUserId: allUserIds[i] },
        );
      }
    }
    const anyBlock = await prisma.block.findFirst({
      where: { OR: blockPairs },
      select: { id: true },
    });
    if (anyBlock) {
      return res.status(403).json({ error: 'Cannot create group DM: one or more members have blocked each other.' });
    }
  }

  const memberSet = new Set([req.userId, ...unique].sort());
  // Only fetch group DM channels that include ALL target members, not all user channels
  const allMemberIds = [req.userId, ...unique];
  const candidateChannels = await prisma.dMChannel.findMany({
    where: {
      isGroup: true,
      AND: allMemberIds.map(uid => ({ participants: { some: { userId: uid } } })),
    },
    take: 50,
    include: {
      participants: { include: { user: { select: AUTHOR_USER_SELECT } } },
    },
  });
  const match = candidateChannels.find((ch) => {
    const ids = new Set(ch.participants.map((p) => p.userId));
    if (ids.size !== memberSet.size) return false;
    for (const id of ids) if (!memberSet.has(id)) return false;
    return true;
  });

  if (match) {
    const others = match.participants.filter((p) => p.userId !== req.userId).map((p) => p.user);
    return res.status(200).json({
      id: match.id,
      isGroup: true,
      // Distinguish dedup-to-existing (200) from a genuine create (201)
      // so the client never mints a fresh channel key for a channel whose members
      // already hold the original. The client recovers the original key instead.
      created: false,
      encrypted: match.encrypted,
      name: match.name ?? undefined,
      icon: match.icon ?? undefined,
      otherUsers: others.map((u) => ({ id: u.id, username: u.username, discriminator: u.discriminator, avatar: u.avatar, banner: u.banner ?? undefined, bannerPositionY: u.bannerPositionY ?? 50, bannerZoom: u.bannerZoom ?? 100, ...extractProFields(u as DmUserFields), status: (u.status as string) || 'offline' })),
    });
  }

  const totalMembers = unique.length + 1;
  if (totalMembers > MAX_GROUP_DM_MEMBERS) {
    return res.status(403).json({ error: `Group DMs are limited to ${MAX_GROUP_DM_MEMBERS} members.` });
  }

  const dmCount = await prisma.dMParticipant.count({ where: { userId: req.userId } });
  if (dmCount >= MAX_DM_CHANNELS) {
    return res.status(403).json({ error: `You've reached the maximum of ${MAX_DM_CHANNELS.toLocaleString()} direct message channels.` });
  }

  const created = await prisma.$transaction(async (tx) => {
    const channel = await tx.dMChannel.create({
      data: {
        isGroup: true,
        encrypted: true,
        ownerId: req.userId!,
        participants: {
          create: [{ userId: req.userId! }, ...unique.map((userId) => ({ userId }))],
        },
      },
      include: {
        participants: {
          where: { userId: { not: req.userId } },
          include: { user: { select: AUTHOR_USER_SELECT } },
        },
      },
    });

    logger.info({ userId: req.userId, dmChannelId: channel.id }, 'MLS group DM created');

    return channel;
  });

  const otherUsers = (created as any).participants.map((p: any) => p.user) as DmUserFields[];
  res.status(201).json({
    id: created.id,
    isGroup: true,
    // Genuine create — the client adopts and persists the fresh key.
    created: true,
    encrypted: created.encrypted,
    ownerId: created.ownerId,
    otherUsers: otherUsers.map((u) => ({ id: u.id, username: u.username, discriminator: u.discriminator, avatar: u.avatar, banner: u.banner ?? undefined, bannerPositionY: u.bannerPositionY ?? 50, bannerZoom: u.bannerZoom ?? 100, ...extractProFields(u), status: u.status || 'offline' })),
  });

  // Carry the real saved-tier MLS group id on the create emit where ordering
  // allows. The client registers the MlsGroup AFTER this channel row, so this
  // is usually null at emit time; GET /dms catches up. Plumbed from the real
  // lookup, not a literal, to stay consistent with the add path.
  const createdMlsGroup = await prisma.mlsGroup.findFirst({
    where: { dmChannelId: created.id, tier: 'saved' },
    select: { id: true },
  });

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    const creator = await prisma.user.findUnique({ where: { id: req.userId! }, select: AUTHOR_USER_SELECT });
    const allMembers = creator ? [creator as DmUserFields, ...otherUsers] : otherUsers;
    // Auto-subscribe creator's live sockets to the group room. `unique` is
    // the other-member list (creator emits directly); loop below handles them.
    io.in(`user:${req.userId!}`).socketsJoin(`dm:${created.id}`);
    for (const memberId of unique) {
      // Put each recipient's live sockets into the DM room before emitting
      // so they receive subsequent messages without an explicit `join-dm`.
      io.in(`user:${memberId}`).socketsJoin(`dm:${created.id}`);
      const membersForRecipient = allMembers.filter((u) => u.id !== memberId);
      io.to(`user:${memberId}`).emit('new-dm-channel', {
        id: created.id,
        isGroup: true,
        otherUsers: membersForRecipient.map((u) => ({ id: u.id, username: u.username, discriminator: u.discriminator, avatar: u.avatar, banner: u.banner ?? undefined, bannerPositionY: u.bannerPositionY ?? 50, bannerZoom: u.bannerZoom ?? 100, ...extractProFields(u), status: (u.status as string) || 'offline' })),
        encrypted: created.encrypted,
        mlsGroupId: createdMlsGroup?.id ?? null,
        ownerId: created.ownerId,
      });
    }
  }
}));

// PATCH /api/dms/:dmChannelId – update group DM name/icon (group only, participant only)
router.patch('/:dmChannelId', validateUuidParams('dmChannelId'), authenticateToken, dmMutateLimiter, validate(updateGroupDmSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');
  const participant = await prisma.dMParticipant.findUnique({
    where: { userId_dmChannelId: { userId: req.userId, dmChannelId } },
    select: { userId: true },
  });
  if (!participant) return res.status(403).json({ error: 'Not in this DM' });
  const channel = await prisma.dMChannel.findUnique({ where: { id: dmChannelId } });
  if (!channel?.isGroup) return res.status(400).json({ error: 'Only group DMs can be updated' });
  const body = req.body as { name?: string; icon?: string };
  const name = typeof body.name === 'string' ? body.name.trim() || null : undefined;
  const icon = typeof body.icon === 'string' ? body.icon.trim() || null : undefined;
  if (name === undefined && icon === undefined) return res.status(400).json({ error: 'Provide name and/or icon' });
  // A group-DM icon has no image-extension check, so `.enc` forcing does not
  // cover it — refuse an encrypted (scan-skipped) blob explicitly.
  if (icon) {
    const prov = await checkUploadAttachment(icon);
    if (!prov.ok) return res.status(prov.status).json({ error: prov.error });
  }
  const updated = await prisma.dMChannel.update({
    where: { id: dmChannelId },
    data: {
      ...(name !== undefined && { name }),
      ...(icon !== undefined && { icon }),
    },
  });

  // Emit to all participants so they see the name/icon change in real-time
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    const groupParticipants = await prisma.dMParticipant.findMany({
      where: { dmChannelId },
      select: { userId: true },
      take: 50,
    });
    const updatePayload = { dmChannelId, name: updated.name ?? undefined, icon: updated.icon ?? undefined };
    io.to(`dm:${dmChannelId}`).emit('dm-group-updated', updatePayload);
    for (const p of groupParticipants) {
      io.to(`user:${p.userId}`).emit('dm-group-updated', updatePayload);
    }
  }

  return res.json({ id: updated.id, name: updated.name ?? undefined, icon: updated.icon ?? undefined });
}));

// POST /api/dms/:dmChannelId/members – add members to existing group DM
router.post('/:dmChannelId/members', validateUuidParams('dmChannelId'), authenticateToken, dmMutateLimiter, validate(addGroupDmMembersSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');
  const { memberIds } = req.body as { memberIds: string[] };

  const participant = await prisma.dMParticipant.findUnique({
    where: { userId_dmChannelId: { userId: req.userId, dmChannelId } },
    select: { userId: true },
  });
  if (!participant) return res.status(403).json({ error: 'Not in this DM' });

  const channel = await prisma.dMChannel.findUnique({ where: { id: dmChannelId }, select: { id: true, isGroup: true, name: true, icon: true, encrypted: true, ownerId: true } });
  if (!channel) return res.status(404).json({ error: 'DM channel not found' });
  if (!channel.isGroup) return res.status(400).json({ error: 'Cannot add members to a 1:1 DM. Create a group DM instead.' });
  if (channel.ownerId !== req.userId) return res.status(403).json({ error: 'Only the group owner can add members' });

  const existingParticipants = await prisma.dMParticipant.findMany({
    where: { dmChannelId },
    select: { userId: true },
  });
  const existingIds = new Set(existingParticipants.map(p => p.userId));
  const newMemberIds = [...new Set(memberIds)].filter(id => !existingIds.has(id) && id !== req.userId);

  if (newMemberIds.length === 0) {
    const allP = await prisma.dMParticipant.findMany({
      where: { dmChannelId },
      include: { user: { select: PUBLIC_USER_SELECT } },
    });
    return res.json({
      id: dmChannelId,
      members: allP.map(p => ({ id: p.user.id, username: p.user.username, discriminator: p.user.discriminator, avatar: p.user.avatar, status: (p.user.status as string) || 'offline' })),
    });
  }

  if (existingIds.size + newMemberIds.length > MAX_GROUP_DM_MEMBERS) {
    return res.status(403).json({ error: `Group DMs are limited to ${MAX_GROUP_DM_MEMBERS} members.` });
  }

  // Validate new members exist
  const users = await prisma.user.findMany({ where: { id: { in: newMemberIds } }, select: { id: true } });
  if (users.length !== newMemberIds.length) return res.status(404).json({ error: 'One or more users not found' });

  // Privacy checks for each new member vs requester
  for (const memberId of newMemberIds) {
    const [blocked, famRestrict1, famRestrict2, canDm] = await Promise.all([
      hasBlockBetween(req.userId!, memberId),
      hasFamilyDmRestriction(req.userId!, memberId),
      hasFamilyDmRestriction(memberId, req.userId!),
      canUserDm(req.userId!, memberId),
    ]);
    if (blocked) return res.status(403).json({ error: 'Cannot add members: one or more users are blocked.' });
    if (famRestrict1 || famRestrict2) return res.status(403).json({ error: 'Cannot add members: family restrictions apply.' });
    if (!canDm) return res.status(403).json({ error: 'Cannot add members: one or more users have restricted DMs.' });
  }

  // Cross-member block check: new members vs all existing participants AND between new members
  const existingIdArr = [...existingIds];
  const blockPairs: { blockerId: string; blockedUserId: string }[] = [];
  for (const newId of newMemberIds) {
    for (const existingId of existingIdArr) {
      blockPairs.push(
        { blockerId: newId, blockedUserId: existingId },
        { blockerId: existingId, blockedUserId: newId },
      );
    }
    for (const otherId of newMemberIds) {
      if (otherId !== newId) {
        blockPairs.push({ blockerId: newId, blockedUserId: otherId });
      }
    }
  }
  if (blockPairs.length > 0) {
    const anyBlock = await prisma.block.findFirst({
      where: { OR: blockPairs },
      select: { id: true },
    });
    if (anyBlock) {
      return res.status(403).json({ error: 'Cannot add members: one or more users have blocked each other.' });
    }
  }

  // Check DM channel limits for new members (batch groupBy instead of per-member count)
  const dmCounts = await prisma.dMParticipant.groupBy({
    by: ['userId'],
    where: { userId: { in: newMemberIds } },
    _count: { userId: true },
  });
  const dmCountMap = new Map(dmCounts.map(c => [c.userId, c._count.userId]));
  for (const memberId of newMemberIds) {
    if ((dmCountMap.get(memberId) ?? 0) >= MAX_DM_CHANNELS) {
      return res.status(403).json({ error: 'One or more users have reached their DM channel limit.' });
    }
  }

  // Create participant records
  await prisma.dMParticipant.createMany({
    data: newMemberIds.map(userId => ({ userId, dmChannelId })),
    skipDuplicates: true,
  });

  // Fetch updated participant list
  const allParticipants = await prisma.dMParticipant.findMany({
    where: { dmChannelId },
    include: { user: { select: PUBLIC_USER_SELECT } },
  });

  // MLS groups carry membership via native Commits + Welcomes; surface the
  // real saved-tier group id so a freshly-added member resolves its Welcome
  // immediately instead of racing into a premature External Commit. Detection
  // is the only server signal: presence of a saved-tier MlsGroup row.
  const mlsGroup = await prisma.mlsGroup.findFirst({
    where: { dmChannelId, tier: 'saved' },
    select: { id: true },
  });

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    const newUserData = allParticipants
      .filter(p => newMemberIds.includes(p.userId))
      .map(p => ({ id: p.user.id, username: p.user.username, discriminator: p.user.discriminator, avatar: p.user.avatar, status: (p.user.status as string) || 'offline' }));

    // Notify existing members in the DM room
    io.to(`dm:${dmChannelId}`).emit('dm-participants-added', {
      dmChannelId,
      newMembers: newUserData,
    });

    // Notify each new member with full channel data
    for (const newId of newMemberIds) {
      // Put the new member's live sockets into the DM room so subsequent
      // messages flow without an explicit `join-dm`.
      io.in(`user:${newId}`).socketsJoin(`dm:${dmChannelId}`);
      const othersForRecipient = allParticipants
        .filter(p => p.userId !== newId)
        .map(p => ({ id: p.user.id, username: p.user.username, discriminator: p.user.discriminator, avatar: p.user.avatar, status: (p.user.status as string) || 'offline' }));
      io.to(`user:${newId}`).emit('new-dm-channel', {
        id: dmChannelId,
        isGroup: true,
        name: channel.name ?? undefined,
        icon: channel.icon ?? undefined,
        otherUsers: othersForRecipient,
        encrypted: channel.encrypted,
        mlsGroupId: mlsGroup?.id ?? null,
        ownerId: channel.ownerId ?? undefined,
      });
    }
  }

  // System message
  const adder = await prisma.user.findUnique({ where: { id: req.userId! }, select: { username: true } });
  const addedUserData = allParticipants.filter(p => newMemberIds.includes(p.userId));
  const addedNames = addedUserData.map(p => p.user.username).join(', ');
  const sysMsgPlaintext = `${adder?.username ?? 'Someone'} added ${addedNames} to the group`;
  const sysMsgEnc = encryptDmContent(sysMsgPlaintext);
  const sysMsg = await prisma.dMMessage.create({
    data: {
      dmChannelId,
      authorId: req.userId!,
      content: sysMsgEnc.ciphertext,
      contentIv: sysMsgEnc.iv,
      type: 'system',
      systemPayload: { kind: 'members_added', memberIds: newMemberIds },
    },
  });
  if (io) {
    io.to(`dm:${dmChannelId}`).emit('dm-system-message', {
      id: sysMsg.id,
      dmChannelId: sysMsg.dmChannelId,
      authorId: sysMsg.authorId,
      content: sysMsgPlaintext,
      type: sysMsg.type,
      systemPayload: sysMsg.systemPayload,
      createdAt: sysMsg.createdAt.toISOString(),
      authorUsername: adder?.username ?? null,
      authorDiscriminator: null,
      authorAvatar: null,
    });
  }

  res.json({
    id: dmChannelId,
    members: allParticipants.map(p => ({ id: p.user.id, username: p.user.username, discriminator: p.user.discriminator, avatar: p.user.avatar, status: (p.user.status as string) || 'offline' })),
  });
}));

// DELETE /api/dms/:dmChannelId/members/:targetUserId – owner removes a member (group only)
router.delete('/:dmChannelId/members/:targetUserId', validateUuidParams('dmChannelId', 'targetUserId'), authenticateToken, dmMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');
  const targetUserId = getParam(req, 'targetUserId');

  const channel = await prisma.dMChannel.findUnique({
    where: { id: dmChannelId },
    include: { participants: { select: { userId: true, joinedAt: true } } },
  });
  if (!channel) return res.status(404).json({ error: 'DM channel not found' });
  if (!channel.isGroup) return res.status(400).json({ error: 'Only group DMs support removing members' });
  if (channel.ownerId !== req.userId) return res.status(403).json({ error: 'Only the group owner can remove members' });
  if (targetUserId === req.userId) return res.status(403).json({ error: 'Use leave to remove yourself' });
  if (!channel.participants.some((p) => p.userId === targetUserId)) {
    return res.status(404).json({ error: 'User is not a member of this group' });
  }

  // Every group DM is MLS. Two-phase removal: mark pendingRemoval; the
  // DMParticipant row is deleted only when the owner's MLS Remove commit lands
  // (mls.ts finalize via removedUserIds).
  await prisma.dMParticipant.update({
    where: { userId_dmChannelId: { userId: targetUserId, dmChannelId } },
    data: { pendingRemoval: new Date() },
  });

  const remaining = channel.participants.filter((p) => p.userId !== targetUserId);
  const remainingIds = remaining.map((p) => p.userId);

  // SFU eject backstop: the MLS Remove rekey makes a kicked member DEAF
  // (no new-epoch key) but cannot silence them — remaining members retain the
  // old epoch key in the SFrame keyring (in-flight overlap), so the kicked
  // member's outbound still decodes, and their lingering LiveKit presence
  // never acks the new epoch, false-failing the remaining members' shields.
  // Hard-disconnect at the SFU, same as voice-channel kicks and GDPR removal.
  removeLiveKitParticipant(`dm-call:${dmChannelId}`, targetUserId).catch(() => {});

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.in(`user:${targetUserId}`).socketsLeave(`dm:${dmChannelId}`);
    io.to(`user:${targetUserId}`).emit('dm-removed-from-group', { dmChannelId });
    io.to(`dm:${dmChannelId}`).emit('dm-participant-removed', { dmChannelId, userId: targetUserId });
    for (const uid of remainingIds) {
      io.to(`user:${uid}`).emit('dm-participant-removed', { dmChannelId, userId: targetUserId });
    }
  }

  const [ownerUser, targetUser] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.userId! }, select: { username: true } }),
    prisma.user.findUnique({ where: { id: targetUserId }, select: { username: true } }),
  ]);
  const sysMsgPlaintext = `${ownerUser?.username ?? 'Owner'} removed ${targetUser?.username ?? 'someone'} from the group`;
  const sysMsgEnc = encryptDmContent(sysMsgPlaintext);
  const sysMsg = await prisma.dMMessage.create({
    data: {
      dmChannelId,
      authorId: req.userId!,
      content: sysMsgEnc.ciphertext,
      contentIv: sysMsgEnc.iv,
      type: 'system',
      systemPayload: { kind: 'member_removed', userId: targetUserId },
    },
  });
  if (io) {
    io.to(`dm:${dmChannelId}`).emit('dm-system-message', {
      id: sysMsg.id,
      dmChannelId: sysMsg.dmChannelId,
      authorId: sysMsg.authorId,
      content: sysMsgPlaintext,
      type: sysMsg.type,
      systemPayload: sysMsg.systemPayload,
      createdAt: sysMsg.createdAt.toISOString(),
      authorUsername: ownerUser?.username ?? null,
      authorDiscriminator: null,
      authorAvatar: null,
    });
  }

  const updated = await prisma.dMParticipant.findMany({
    where: { dmChannelId },
    include: { user: { select: PUBLIC_USER_SELECT } },
    take: MAX_GROUP_DM_MEMBERS,
  });
  res.json({
    id: dmChannelId,
    members: updated.map((p) => ({ id: p.user.id, username: p.user.username, discriminator: p.user.discriminator, avatar: p.user.avatar, status: (p.user.status as string) || 'offline' })),
  });
}));

// POST /api/dms/:dmChannelId/leave – leave group DM (group only)
router.post('/:dmChannelId/leave', validateUuidParams('dmChannelId'), authenticateToken, dmMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');
  const participant = await prisma.dMParticipant.findUnique({
    where: { userId_dmChannelId: { userId: req.userId, dmChannelId } },
    select: { userId: true },
  });
  if (!participant) return res.status(403).json({ error: 'Not in this DM' });
  const channel = await prisma.dMChannel.findUnique({
    where: { id: dmChannelId },
    include: { participants: { select: { userId: true, joinedAt: true, pendingRemoval: true } } },
  });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!channel.isGroup) return res.status(400).json({ error: 'Only group DMs can be left; use block for 1:1' });
  // MLS detection: the saved-tier MlsGroup row is the ONLY server-side MLS signal.
  const mlsGroup = await prisma.mlsGroup.findFirst({ where: { dmChannelId, tier: 'saved' }, select: { id: true } });
  const isMls = !!mlsGroup;
  // Remaining REAL members exclude the leaver AND any already-pendingRemoval rows
  // (a marked member is no longer a live leaf for ownership / rotation purposes).
  const remainingParticipantEntries = channel.participants.filter(
    (p) => p.userId !== req.userId && p.pendingRemoval === null,
  );
  const remainingUserIds = remainingParticipantEntries.map((p) => p.userId);
  // Every group DM is MLS. Two-phase self-leave: mark pendingRemoval; the
  // DMParticipant row is deleted only when the elected committer's MLS Remove
  // lands (mls.ts finalize via removedUserIds). The leaver stays a lingering
  // leaf until then.
  await prisma.dMParticipant.update({
    where: { userId_dmChannelId: { userId: req.userId, dmChannelId } },
    data: { pendingRemoval: new Date() },
  });
  // Clean up active call if user was in one for this group DM
  try {
    const { isInDmCall: chkCall, removeDmCallParticipant: rmCall, setDmCallReverseLookup: setRev, addDmCallDeclined: addDecl, dmCallSize: getSize, getDmCallStartTime: getStart, deleteDmCallStartTime: delStart } = await import('../redis.js');
    const wasInCall = await chkCall(dmChannelId, req.userId!);
    if (wasInCall) {
      await rmCall(dmChannelId, req.userId!);
      await setRev(req.userId!, null);
      await addDecl(dmChannelId, req.userId!);
      const io = req.app.get('io') as import('socket.io').Server | undefined;
      if (io) {
        io.in(`user:${req.userId!}`).socketsLeave(`dm-call:${dmChannelId}`);
        io.to(`dm-call:${dmChannelId}`).emit('dm-call-declined', { userId: req.userId!, dmChannelId });
        io.to(`dm-call:${dmChannelId}`).emit('dm-call-user-left', { userId: req.userId! });
        const sz = await getSize(dmChannelId);
        if (sz === 0) {
          const { stopDmCallRing: stopRing, createDmCallSystemMessage: createMsg } = await import('../socketHandlers/infrastructure.js');
          stopRing(dmChannelId);
          const st = await getStart(dmChannelId);
          await delStart(dmChannelId);
          const dur = st ? Date.now() - st : 0;
          createMsg(dmChannelId, req.userId!, 'Call ended', 'call_ended', { durationSeconds: Math.round(dur / 1000) });
          io.to(`dm:${dmChannelId}`).emit('dm-call-ended', { dmChannelId });
        }
      }
    }
  } catch { /* best-effort call cleanup */ }
  // Exclude pendingRemoval rows so a marked leaver (MLS lingering leaf) never
  // blocks teardown nor keeps an otherwise-empty channel alive.
  const remainingParticipants = await prisma.dMParticipant.count({ where: { dmChannelId, pendingRemoval: null } });
  if (remainingParticipants === 0) {
    await prisma.dMChannel.delete({ where: { id: dmChannelId } });
  } else {
    // If the owner left, transfer ownership to the oldest NON-pendingRemoval
    // remaining member. The DB write runs UNCONDITIONALLY (independent of socket
    // presence) so ownership is never stranded when io is unavailable; only the
    // notification is gated on io.
    let newOwnerId: string | null = null;
    if (channel.ownerId === req.userId && remainingParticipantEntries.length >= 1) {
      const newOwner = remainingParticipantEntries.reduce((a, b) => (a.joinedAt < b.joinedAt ? a : b));
      newOwnerId = newOwner.userId;
      await prisma.dMChannel.update({ where: { id: dmChannelId }, data: { ownerId: newOwnerId } });
    }
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) {
      io.to(`dm:${dmChannelId}`).emit('dm-participant-left', { dmChannelId, userId: req.userId });
      for (const uid of remainingUserIds) {
        io.to(`user:${uid}`).emit('dm-participant-left', { dmChannelId, userId: req.userId });
      }
      if (newOwnerId) {
        for (const uid of remainingUserIds) {
          io.to(`user:${uid}`).emit('dm-group-owner-changed', { dmChannelId, ownerId: newOwnerId });
        }
      }
      if (isMls) {
        // Next-oldest fallback: resolve which remaining real members are
        // currently connected so the election prefers an ONLINE committer.
        const isUserConnectedAsync = req.app.get('isUserConnectedAsync') as
          | ((userId: string) => Promise<boolean>)
          | undefined;
        const realRemaining = channel.participants
          .filter((p) => p.userId !== req.userId && p.pendingRemoval === null)
          .map((p) => p.userId);
        const connectedUserIds = new Set<string>();
        if (isUserConnectedAsync) {
          const flags = await Promise.all(
            realRemaining.map((uid) => isUserConnectedAsync(uid).then((c) => [uid, c] as const)),
          );
          for (const [uid, c] of flags) if (c) connectedUserIds.add(uid);
        } else {
          for (const uid of realRemaining) connectedUserIds.add(uid);
        }
        const election = electOldestRemaining(
          channel.participants.map((p) => ({ userId: p.userId, joinedAt: p.joinedAt, pendingRemoval: p.pendingRemoval })),
          req.userId,
          connectedUserIds,
        );
        if (election) {
          for (const uid of election.memberIds) {
            io.to(`user:${uid}`).emit('dm-key-rotation-needed', {
              dmChannelId,
              oldestMemberId: election.oldestMemberId,
              memberIds: election.memberIds,
              leaverId: req.userId,
            });
          }
        }
      }
    }
  }
  return res.status(204).send();
}));

// Mount DM message routes (messages, pins for messages)
router.use('/', dmMessageRoutes);

export default router;
