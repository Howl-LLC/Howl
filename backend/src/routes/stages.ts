// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { redis } from '../redis.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { startStageSchema, editStageSchema, stageUserActionSchema, stageLowerHandSchema } from '../schemas.js';
import { getParam, hasPermission, loadPermissionContext, AUTHOR_USER_SELECT, getEffectivePlan } from '../utils.js';
import { logger } from '../logger.js';
import { createAuditLog } from './serverSettings.js';
import { powerUpTier } from './serverHelpers.js';
import { cancelGraceEnd } from '../stageGraceTimers.js';
import { getClientIp } from '../utils/clientIp.js';
import { rotateStageLeaderAndKey } from '../services/voiceE2eeRotation.js';

const log = logger.child({ module: 'stages' });

const STAGE_TTL = 86400; // 24 hours safety net
const MAX_SPEAKERS_LIMIT = 25;
const MAX_TOTAL_PARTICIPANTS = 10_000;
const MAX_HAND_RAISES = 100;
const MAX_VIDEO_PARTICIPANTS = 8;
const MAX_SCREEN_SHARES = 2;

function getVideoAudienceCap(serverPowerUpCount: number): number {
  const tier = powerUpTier(serverPowerUpCount);
  if (tier >= 3) return 300;
  if (tier >= 2) return 150;
  return 50;
}

async function getServerPowerUpCount(serverId: string): Promise<number> {
  const server = await prisma.server.findUnique({ where: { id: serverId }, select: { powerUpCount: true } });
  return server?.powerUpCount ?? 0;
}

/**
 * O(1) set size using SCARD instead of SMEMBERS (which is O(N) and loads all IDs).
 * Critical for 10K+ audience where SMEMBERS would transfer thousands of IDs just to count.
 */
export async function getSetSize(channelId: string, suffix: string): Promise<number> {
  if (redis) return redis.scard(stageKey(channelId, suffix));
  const map = suffix === 'speakers' ? memSpeakers : suffix === 'hands' ? memHands : suffix === 'audience' ? memAudience : memInvites;
  return map.get(channelId)?.size ?? 0;
}

export async function getTotalParticipants(channelId: string): Promise<number> {
  const speakerCount = await getSetSize(channelId, 'speakers');
  const audienceCount = await getSetSize(channelId, 'audience');
  return speakerCount + audienceCount;
}

// In-memory fallback when Redis is not available
// Caps prevent unbounded memory growth in non-Redis mode (dev/single-instance).
// One entry per active stage channel — 500 is generous for single-instance dev.
const MEM_STAGE_MAX_CHANNELS = 500;

const memSpeakers = new Map<string, Set<string>>();
const memHands = new Map<string, Set<string>>();
const memAudience = new Map<string, Set<string>>();
const memInvites = new Map<string, Set<string>>();
const memSession = new Map<string, string>(); // channelId -> sessionId

// Redis helpers with in-memory fallback

function stageKey(channelId: string, suffix: string): string {
  return `stage:${channelId}:${suffix}`;
}

export async function getStageSessionId(channelId: string): Promise<string | null> {
  if (redis) return redis.get(stageKey(channelId, 'session'));
  return memSession.get(channelId) ?? null;
}

async function setStageSessionId(channelId: string, sessionId: string): Promise<boolean> {
  if (redis) {
    const result = await redis.set(stageKey(channelId, 'session'), sessionId, 'EX', STAGE_TTL, 'NX');
    return result === 'OK';
  }
  if (memSession.has(channelId)) return false;
  // Evict oldest session entry if at cap
  if (memSession.size >= MEM_STAGE_MAX_CHANNELS) {
    const oldest = memSession.keys().next().value;
    if (oldest !== undefined) memSession.delete(oldest);
  }
  memSession.set(channelId, sessionId);
  return true;
}

export async function clearStageState(channelId: string): Promise<void> {
  if (redis) {
    const keys = ['session', 'speakers', 'hands', 'audience', 'invites', 'leader'].map((s) => stageKey(channelId, s));
    await redis.del(...keys);
    return;
  }
  memSession.delete(channelId);
  memSpeakers.delete(channelId);
  memHands.delete(channelId);
  memAudience.delete(channelId);
  memInvites.delete(channelId);
  memStageLeader.delete(channelId);
}

async function refreshStageTTL(channelId: string): Promise<void> {
  if (!redis) return;
  const keys = ['session', 'speakers', 'hands', 'audience', 'invites', 'leader'].map((s) => stageKey(channelId, s));
  const pipeline = redis.pipeline();
  for (const k of keys) pipeline.expire(k, STAGE_TTL);
  await pipeline.exec();
}

const memStageLeader = new Map<string, string>();

export async function setStageLeader(channelId: string, userId: string): Promise<void> {
  if (redis) {
    await redis.set(stageKey(channelId, 'leader'), userId, 'EX', STAGE_TTL);
    return;
  }
  if (memStageLeader.size >= MEM_STAGE_MAX_CHANNELS && !memStageLeader.has(channelId)) {
    const oldest = memStageLeader.keys().next().value;
    if (oldest !== undefined) memStageLeader.delete(oldest);
  }
  memStageLeader.set(channelId, userId);
}

export async function getStageLeader(channelId: string): Promise<string | null> {
  if (redis) return redis.get(stageKey(channelId, 'leader'));
  return memStageLeader.get(channelId) ?? null;
}

export async function addToSet(channelId: string, suffix: string, userId: string): Promise<void> {
  if (redis) {
    await redis.sadd(stageKey(channelId, suffix), userId);
    await redis.expire(stageKey(channelId, suffix), STAGE_TTL);
    return;
  }
  const map = suffix === 'speakers' ? memSpeakers : suffix === 'hands' ? memHands : suffix === 'audience' ? memAudience : memInvites;
  if (!map.has(channelId)) {
    // Evict oldest channel entry if at cap
    if (map.size >= MEM_STAGE_MAX_CHANNELS) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(channelId, new Set());
  }
  map.get(channelId)!.add(userId);
}

export async function removeFromSet(channelId: string, suffix: string, userId: string): Promise<void> {
  if (redis) {
    await redis.srem(stageKey(channelId, suffix), userId);
    return;
  }
  const map = suffix === 'speakers' ? memSpeakers : suffix === 'hands' ? memHands : suffix === 'audience' ? memAudience : memInvites;
  map.get(channelId)?.delete(userId);
}

export async function getSetMembers(channelId: string, suffix: string): Promise<string[]> {
  if (redis) return redis.smembers(stageKey(channelId, suffix));
  const map = suffix === 'speakers' ? memSpeakers : suffix === 'hands' ? memHands : suffix === 'audience' ? memAudience : memInvites;
  return [...(map.get(channelId) ?? [])];
}

export async function isInSet(channelId: string, suffix: string, userId: string): Promise<boolean> {
  if (redis) return (await redis.sismember(stageKey(channelId, suffix), userId)) === 1;
  const map = suffix === 'speakers' ? memSpeakers : suffix === 'hands' ? memHands : suffix === 'audience' ? memAudience : memInvites;
  return map.get(channelId)?.has(userId) ?? false;
}

// Rate limiters

const stageReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:stage-read:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const stageMutationLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:stage-mutate:'),
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many stage actions. Please wait.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

// Router

const router = Router({ mergeParams: true });

// Helper: build stage session response
async function buildStageResponse(channelId: string, session: any, serverPowerUpCount = 0) {
  const speakerIds = await getSetMembers(channelId, 'speakers');
  const handIds = await getSetMembers(channelId, 'hands');
  const audienceIds = await getSetMembers(channelId, 'audience');

  const speakerUsers = speakerIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: speakerIds } }, select: AUTHOR_USER_SELECT, take: MAX_SPEAKERS_LIMIT })
    : [];

  const speakerMembers = speakerIds.length > 0
    ? await prisma.serverMember.findMany({
        where: { serverId: session.serverId, userId: { in: speakerIds } },
        include: { serverRole: true },
        take: MAX_SPEAKERS_LIMIT,
      })
    : [];
  const canManageMap = new Map(speakerMembers.map(m => [m.userId, hasPermission(m, 'manageStages')]));

  const audienceUsers = audienceIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: audienceIds } }, select: AUTHOR_USER_SELECT, take: 200 })
    : [];

  const handUsers = handIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: handIds } }, select: { id: true, username: true, avatar: true }, take: 100 })
    : [];
  const handUserMap = new Map(handUsers.map(u => [u.id, u]));

  return {
    id: session.id,
    channelId: session.channelId,
    serverId: session.serverId,
    topic: session.topic,
    maxSpeakers: session.maxSpeakers,
    textChatEnabled: session.textChatEnabled,
    allowEmojis: session.allowEmojis ?? false,
    allowStickers: session.allowStickers ?? false,
    allowGifs: session.allowGifs ?? false,
    invitedSpeakerUserIds: session.invitedSpeakerUserIds ?? [],
    invitedRoleIds: session.invitedRoleIds ?? [],
    startedById: session.startedById,
    startedAt: session.startedAt instanceof Date ? session.startedAt.toISOString() : session.startedAt,
    endedAt: session.endedAt ? (session.endedAt instanceof Date ? session.endedAt.toISOString() : session.endedAt) : null,
    speakers: speakerUsers.map((u) => ({
      userId: u.id,
      username: u.username,
      discriminator: u.discriminator ?? '0000',
      avatar: u.avatar ?? null,
      banner: u.banner ?? null,
      bannerPositionY: u.bannerPositionY ?? 50,
      bannerZoom: u.bannerZoom ?? 100,
      nameColor: u.nameColor ?? null,
      nameFont: u.nameFont ?? null,
      nameEffect: u.nameEffect ?? null,
      avatarEffect: u.avatarEffect ?? null,
      effectivePlan: getEffectivePlan(u),
      isMuted: false,
      isHost: u.id === session.startedById || canManageMap.get(u.id) === true,
    })),
    audienceCount: audienceIds.length,
    audienceMembers: audienceUsers.map((u) => ({
      userId: u.id,
      username: u.username,
      discriminator: u.discriminator ?? '0000',
      avatar: u.avatar ?? null,
      nameColor: u.nameColor ?? null,
      nameFont: u.nameFont ?? null,
      nameEffect: u.nameEffect ?? null,
      avatarEffect: u.avatarEffect ?? null,
      effectivePlan: getEffectivePlan(u),
    })),
    handRaises: handIds.map(id => {
      const u = handUserMap.get(id);
      return { userId: id, username: u?.username ?? 'Unknown', avatar: u?.avatar ?? null };
    }),
    maxVideoParticipants: MAX_VIDEO_PARTICIPANTS,
    maxScreenShares: MAX_SCREEN_SHARES,
    videoAudienceCap: getVideoAudienceCap(serverPowerUpCount),
    maxTotalParticipants: MAX_TOTAL_PARTICIPANTS,
    maxHandRaises: MAX_HAND_RAISES,
  };
}

// POST /api/v1/servers/:serverId/channels/:channelId/stage/start
router.post(
  '/:serverId/channels/:channelId/stage/start',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  stageMutationLimiter,
  validate(startStageSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');

    const [channel, member, permCtx] = await Promise.all([
      prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, serverId: true, type: true } }),
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!channel || channel.serverId !== serverId) return res.status(404).json({ error: 'Channel not found' });
    if (channel.type !== 'stage') return res.status(400).json({ error: 'Not a stage channel' });
    if (!member) return res.status(403).json({ error: 'Not a server member' });
    if (!hasPermission(permCtx,'manageStages')) return res.status(403).json({ error: 'Missing manageStages permission' });

    // Check no active session (Redis SETNX pattern)
    const existingSessionId = await getStageSessionId(channelId);
    if (existingSessionId) {
      const existing = await prisma.stageSession.findUnique({ where: { id: existingSessionId } });
      if (existing && !existing.endedAt) {
        return res.status(409).json({ error: 'A stage session is already active' });
      }
      // Stale key — clear it
      await clearStageState(channelId);
    }

    const { topic, maxSpeakers, textChatEnabled, allowEmojis, allowStickers, allowGifs, invitedSpeakerUserIds, invitedRoleIds } = req.body as { topic?: string; maxSpeakers: number; textChatEnabled: boolean; allowEmojis: boolean; allowStickers: boolean; allowGifs: boolean; invitedSpeakerUserIds?: string[]; invitedRoleIds?: string[] };

    const session = await prisma.stageSession.create({
      data: {
        channelId,
        serverId,
        topic: topic ?? null,
        maxSpeakers,
        textChatEnabled,
        allowEmojis,
        allowStickers,
        allowGifs,
        invitedSpeakerUserIds: invitedSpeakerUserIds ?? [],
        invitedRoleIds: invitedRoleIds ?? [],
        startedById: req.userId,
      },
    });

    const set = await setStageSessionId(channelId, session.id);
    if (!set) {
      await prisma.stageSession.delete({ where: { id: session.id } });
      return res.status(409).json({ error: 'A stage session is already active' });
    }

    // Add creator as first speaker (host)
    await addToSet(channelId, 'speakers', req.userId);
    // Seed the E2EE-key-holder to the session host. Future stage-e2ee-distribute
    // calls are rejected unless the sender equals this value. Updated on
    // `stage-e2ee-rotate` when the host leaves.
    await setStageLeader(channelId, req.userId);

    // Pre-populate Redis invites set with invited user IDs
    if (invitedSpeakerUserIds && invitedSpeakerUserIds.length > 0) {
      for (const uid of invitedSpeakerUserIds) {
        await addToSet(channelId, 'invites', uid);
      }
    }
    // For role invites, resolve role members and add them to invites set
    if (invitedRoleIds && invitedRoleIds.length > 0) {
      const roleMembers = await prisma.serverMember.findMany({
        where: { serverId, roleId: { in: invitedRoleIds } },
        select: { userId: true },
        take: 200,
      });
      for (const rm of roleMembers) {
        if (rm.userId !== req.userId) {
          await addToSet(channelId, 'invites', rm.userId);
        }
      }
    }

    const puCount = await getServerPowerUpCount(serverId);
    const response = await buildStageResponse(channelId, session, puCount);

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`channel:${channelId}`).emit('stage-started', response);
    io?.to(`server:${serverId}`).emit('stage-started', response);

    // Notify server members about the new stage (fire-and-forget)
    if (io) {
      io.to(`server:${serverId}`).emit('server-channel-activity', {
        serverId, channelId, messageId: session.id, mentionUserIds: [], stageStarted: true,
      });
    }
    // Broadcast stage speakers to server room for activity panel
    io?.to(`server:${serverId}`).emit('server-stage-participants', {
      serverId,
      channelId,
      participants: response.speakers.map((s: { userId: string; username: string; avatar: string | null }) => ({
        userId: s.userId, username: s.username, avatar: s.avatar ?? undefined,
      })),
    });
    (async () => {
      const [chInfo, members] = await Promise.all([
        prisma.channel.findUnique({ where: { id: channelId }, select: { name: true } }),
        prisma.serverMember.findMany({ where: { serverId }, select: { userId: true }, take: 1000 }),
      ]);
      const channelName = chInfo?.name ?? 'stage';
      const memberIds = members.map(m => m.userId).filter(uid => uid !== req.userId);
      if (memberIds.length === 0) return;

      prisma.notification.createMany({
        data: memberIds.map(uid => ({
          userId: uid, serverId, channelId, type: 'stage_started',
          title: 'Stage started',
          body: session.topic ? `${session.topic} — ${channelName}` : channelName,
          metadata: { stageSessionId: session.id, channelName },
        })),
        skipDuplicates: true,
      }).catch(() => {});
    })().catch(() => {});

    await createAuditLog(serverId, req.userId, 'stage_start', 'channel', channelId, { sessionId: session.id, topic: session.topic }).catch(() => {});
    log.info({ userId: req.userId, sessionId: session.id, channelId }, 'stage started');
    res.status(201).json(response);
  }),
);

// POST /api/v1/servers/:serverId/channels/:channelId/stage/end
router.post(
  '/:serverId/channels/:channelId/stage/end',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  stageMutationLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a server member' });
    if (!hasPermission(permCtx,'manageStages')) return res.status(403).json({ error: 'Missing manageStages permission' });

    const sessionId = await getStageSessionId(channelId);
    if (!sessionId) return res.status(404).json({ error: 'No active stage session' });

    // Host explicitly ending — abort any pending grace-period auto-end.
    cancelGraceEnd(channelId);

    await prisma.stageSession.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
    await clearStageState(channelId);

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`channel:${channelId}`).emit('stage-ended', { sessionId, channelId });
    io?.to(`server:${serverId}`).emit('stage-ended', { sessionId, channelId });
    // Clear stage from activity panel
    io?.to(`server:${serverId}`).emit('server-stage-participants', {
      serverId, channelId, participants: [],
    });

    await createAuditLog(serverId, req.userId, 'stage_end', 'channel', channelId, { sessionId }).catch(() => {});
    log.info({ userId: req.userId, sessionId, channelId }, 'stage ended');
    res.json({ success: true });
  }),
);

// PATCH /api/v1/servers/:serverId/channels/:channelId/stage
router.patch(
  '/:serverId/channels/:channelId/stage',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  stageMutationLimiter,
  validate(editStageSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a server member' });
    if (!hasPermission(permCtx,'manageStages')) return res.status(403).json({ error: 'Missing manageStages permission' });

    const sessionId = await getStageSessionId(channelId);
    if (!sessionId) return res.status(404).json({ error: 'No active stage session' });

    const { topic, maxSpeakers, textChatEnabled, allowEmojis, allowStickers, allowGifs } = req.body as { topic?: string; maxSpeakers?: number; textChatEnabled?: boolean; allowEmojis?: boolean; allowStickers?: boolean; allowGifs?: boolean };
    const data: Record<string, unknown> = {};
    if (topic !== undefined) data.topic = topic;
    if (maxSpeakers !== undefined) data.maxSpeakers = maxSpeakers;
    if (textChatEnabled !== undefined) data.textChatEnabled = textChatEnabled;
    if (allowEmojis !== undefined) data.allowEmojis = allowEmojis;
    if (allowStickers !== undefined) data.allowStickers = allowStickers;
    if (allowGifs !== undefined) data.allowGifs = allowGifs;

    const updated = await prisma.stageSession.update({ where: { id: sessionId }, data });
    await refreshStageTTL(channelId);
    const puCount = await getServerPowerUpCount(serverId);
    const response = await buildStageResponse(channelId, updated, puCount);

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`channel:${channelId}`).emit('stage-updated', response);

    res.json(response);
  }),
);

// GET /api/v1/servers/:serverId/channels/:channelId/stage
router.get(
  '/:serverId/channels/:channelId/stage',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  stageReadLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');

    const member = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
    });
    if (!member) return res.status(403).json({ error: 'Not a server member' });

    const sessionId = await getStageSessionId(channelId);
    if (!sessionId) return res.json(null);

    const session = await prisma.stageSession.findUnique({ where: { id: sessionId } });
    if (!session || session.endedAt) return res.json(null);

    const puCount = await getServerPowerUpCount(serverId);
    res.json(await buildStageResponse(channelId, session, puCount));
  }),
);

// GET /api/v1/servers/:serverId/channels/:channelId/stage/history
router.get(
  '/:serverId/channels/:channelId/stage/history',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  stageReadLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');

    const member = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
    });
    if (!member) return res.status(403).json({ error: 'Not a server member' });

    const sessions = await prisma.stageSession.findMany({
      where: { channelId, serverId, endedAt: { not: null } },
      orderBy: { startedAt: 'desc' },
      take: 20,
    });

    res.json(sessions.map((s) => ({
      id: s.id,
      channelId: s.channelId,
      topic: s.topic,
      maxSpeakers: s.maxSpeakers,
      startedById: s.startedById,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt!.toISOString(),
    })));
  }),
);

// Speaker Management

// POST /api/v1/servers/:serverId/channels/:channelId/stage/speakers/invite
router.post(
  '/:serverId/channels/:channelId/stage/speakers/invite',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  stageMutationLimiter,
  validate(stageUserActionSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');
    const { userId: targetUserId } = req.body as { userId: string };

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a server member' });
    if (!hasPermission(permCtx,'manageStages')) return res.status(403).json({ error: 'Missing manageStages permission' });

    const sessionId = await getStageSessionId(channelId);
    if (!sessionId) return res.status(404).json({ error: 'No active stage session' });

    await addToSet(channelId, 'invites', targetUserId);
    await refreshStageTTL(channelId);

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`channel:${channelId}`).emit('stage-invite-sent', { userId: targetUserId, channelId });

    res.json({ success: true });
  }),
);

// POST /api/v1/servers/:serverId/channels/:channelId/stage/speakers/remove
router.post(
  '/:serverId/channels/:channelId/stage/speakers/remove',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  stageMutationLimiter,
  validate(stageUserActionSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');
    const { userId: targetUserId } = req.body as { userId: string };

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a server member' });
    if (!hasPermission(permCtx,'manageStages')) return res.status(403).json({ error: 'Missing manageStages permission' });

    const sessionId = await getStageSessionId(channelId);
    if (!sessionId) return res.status(404).json({ error: 'No active stage session' });

    await removeFromSet(channelId, 'speakers', targetUserId);
    await addToSet(channelId, 'audience', targetUserId);
    await refreshStageTTL(channelId);

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`channel:${channelId}`).emit('stage-speaker-removed', { channelId, userId: targetUserId });

    // Emit audience-joined for the demoted speaker
    const demotedUser = await prisma.user.findUnique({ where: { id: targetUserId }, select: AUTHOR_USER_SELECT });
    if (demotedUser) {
      io?.to(`channel:${channelId}`).emit('stage-audience-joined', {
        userId: targetUserId,
        username: demotedUser.username,
        discriminator: demotedUser.discriminator ?? '0000',
        avatar: demotedUser.avatar ?? null,
        nameColor: demotedUser.nameColor ?? null,
        nameFont: demotedUser.nameFont ?? null,
        nameEffect: demotedUser.nameEffect ?? null,
        avatarEffect: demotedUser.avatarEffect ?? null,
        effectivePlan: getEffectivePlan(demotedUser),
        channelId,
      });
    }

    // Update activity panel with full speaker list
    const updatedSpeakers = await getActiveStageSpeakers(channelId);
    io?.to(`server:${serverId}`).emit('server-stage-participants', {
      serverId, channelId, participants: updatedSpeakers,
    });

    // E2EE: Speaker removed — trigger key rotation for all remaining participants.
    // Shared with the graceful stage-leave handler and the abrupt-disconnect
    // cleanup in connection.ts so all three advance the leader pointer + emit
    // stage-e2ee-rotate identically and cannot drift.
    if (io) await rotateStageLeaderAndKey(io, channelId);

    res.json({ success: true });
  }),
);

// POST /api/v1/servers/:serverId/channels/:channelId/stage/hand/raise
router.post(
  '/:serverId/channels/:channelId/stage/hand/raise',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  stageMutationLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a server member' });
    if (!hasPermission(permCtx,'requestToSpeak')) return res.status(403).json({ error: 'Missing requestToSpeak permission' });

    const sessionId = await getStageSessionId(channelId);
    if (!sessionId) return res.status(404).json({ error: 'No active stage session' });

    const currentHandCount = await getSetSize(channelId, 'hands');
    if (currentHandCount >= MAX_HAND_RAISES) {
      return res.status(400).json({ error: `Maximum of ${MAX_HAND_RAISES} hand raises queued` });
    }

    await addToSet(channelId, 'hands', req.userId);
    await refreshStageTTL(channelId);

    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { username: true, avatar: true } });

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`channel:${channelId}`).emit('stage-hand-raised', { channelId, userId: req.userId, username: user?.username ?? 'Unknown', avatar: user?.avatar ?? null });

    res.json({ success: true });
  }),
);

// POST /api/v1/servers/:serverId/channels/:channelId/stage/hand/lower
router.post(
  '/:serverId/channels/:channelId/stage/hand/lower',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  stageMutationLimiter,
  validate(stageLowerHandSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');
    const { userId: targetUserId } = req.body as { userId?: string };
    const lowerUserId = targetUserId ?? req.userId;

    // Self-lower is always allowed; lowering others requires manageStages
    if (lowerUserId !== req.userId) {
      const [member, permCtx] = await Promise.all([
        prisma.serverMember.findUnique({
          where: { userId_serverId: { userId: req.userId, serverId } },
          include: { serverRole: true },
        }),
        loadPermissionContext(req.userId, serverId),
      ]);
      if (!member || !permCtx || !hasPermission(permCtx, 'manageStages')) {
        return res.status(403).json({ error: 'Missing manageStages permission' });
      }
    }

    const sessionId = await getStageSessionId(channelId);
    if (!sessionId) return res.status(404).json({ error: 'No active stage session' });

    await removeFromSet(channelId, 'hands', lowerUserId);
    await refreshStageTTL(channelId);

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`channel:${channelId}`).emit('stage-hand-lowered', { channelId, userId: lowerUserId });

    res.json({ success: true });
  }),
);

// POST /api/v1/servers/:serverId/channels/:channelId/stage/hand/accept
router.post(
  '/:serverId/channels/:channelId/stage/hand/accept',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  stageMutationLimiter,
  validate(stageUserActionSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');
    const { userId: targetUserId } = req.body as { userId: string };

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a server member' });
    if (!hasPermission(permCtx,'manageStages')) return res.status(403).json({ error: 'Missing manageStages permission' });

    const sessionId = await getStageSessionId(channelId);
    if (!sessionId) return res.status(404).json({ error: 'No active stage session' });

    // Check max speakers
    const session = await prisma.stageSession.findUnique({ where: { id: sessionId }, select: { maxSpeakers: true } });
    const currentSpeakerCount = await getSetSize(channelId, 'speakers');
    if (currentSpeakerCount >= (session?.maxSpeakers ?? MAX_SPEAKERS_LIMIT)) {
      return res.status(400).json({ error: 'Maximum speakers reached' });
    }

    // Move from hands to speakers, remove from audience
    await removeFromSet(channelId, 'hands', targetUserId);
    await removeFromSet(channelId, 'audience', targetUserId);
    await addToSet(channelId, 'speakers', targetUserId);
    await refreshStageTTL(channelId);

    const user = await prisma.user.findUnique({ where: { id: targetUserId }, select: AUTHOR_USER_SELECT });

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`channel:${channelId}`).emit('stage-speaker-added', {
      channelId,
      userId: targetUserId,
      username: user?.username ?? 'Unknown',
      discriminator: user?.discriminator ?? '0000',
      avatar: user?.avatar ?? null,
      banner: user?.banner ?? null,
      bannerPositionY: user?.bannerPositionY ?? 50,
      bannerZoom: user?.bannerZoom ?? 100,
      nameColor: user?.nameColor ?? null,
      nameFont: user?.nameFont ?? null,
      nameEffect: user?.nameEffect ?? null,
      avatarEffect: user?.avatarEffect ?? null,
      effectivePlan: user ? getEffectivePlan(user) : undefined,
      isMuted: true,
      isHost: false,
    });
    // Update activity panel with full speaker list
    const updatedSpeakers = await getActiveStageSpeakers(channelId);
    io?.to(`server:${serverId}`).emit('server-stage-participants', {
      serverId, channelId, participants: updatedSpeakers,
    });

    res.json({ success: true });
  }),
);

// POST /api/v1/servers/:serverId/channels/:channelId/stage/join-as-speaker
router.post(
  '/:serverId/channels/:channelId/stage/join-as-speaker',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  stageMutationLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a server member' });
    if (!hasPermission(permCtx,'manageStages')) return res.status(403).json({ error: 'Missing manageStages permission' });

    const sessionId = await getStageSessionId(channelId);
    if (!sessionId) return res.status(404).json({ error: 'No active stage session' });

    const session = await prisma.stageSession.findUnique({ where: { id: sessionId }, select: { maxSpeakers: true } });
    const currentSpeakerCount2 = await getSetSize(channelId, 'speakers');
    if (currentSpeakerCount2 >= (session?.maxSpeakers ?? MAX_SPEAKERS_LIMIT)) {
      return res.status(400).json({ error: 'Maximum speakers reached' });
    }

    // Remove from audience if they were there, add to speakers
    await removeFromSet(channelId, 'audience', req.userId);
    await addToSet(channelId, 'speakers', req.userId);
    await refreshStageTTL(channelId);

    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: AUTHOR_USER_SELECT });

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`channel:${channelId}`).emit('stage-speaker-added', {
      channelId,
      userId: req.userId,
      username: user?.username ?? 'Unknown',
      discriminator: user?.discriminator ?? '0000',
      avatar: user?.avatar ?? null,
      banner: user?.banner ?? null,
      bannerPositionY: user?.bannerPositionY ?? 50,
      bannerZoom: user?.bannerZoom ?? 100,
      nameColor: user?.nameColor ?? null,
      nameFont: user?.nameFont ?? null,
      nameEffect: user?.nameEffect ?? null,
      avatarEffect: user?.avatarEffect ?? null,
      effectivePlan: user ? getEffectivePlan(user) : undefined,
      isMuted: true,
      isHost: true,
    });

    // Also emit audience-left if they were in audience
    io?.to(`channel:${channelId}`).emit('stage-audience-left', { userId: req.userId, channelId });

    const updatedSpeakers = await getActiveStageSpeakers(channelId);
    io?.to(`server:${serverId}`).emit('server-stage-participants', {
      serverId, channelId, participants: updatedSpeakers,
    });

    res.json({ success: true });
  }),
);

// POST /api/v1/servers/:serverId/channels/:channelId/stage/move-to-audience
router.post(
  '/:serverId/channels/:channelId/stage/move-to-audience',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  stageMutationLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');

    const member = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
    });
    if (!member) return res.status(403).json({ error: 'Not a server member' });

    const sessionId = await getStageSessionId(channelId);
    if (!sessionId) return res.status(404).json({ error: 'No active stage session' });

    const isSpeakerNow = await isInSet(channelId, 'speakers', req.userId);
    if (!isSpeakerNow) return res.status(400).json({ error: 'You are not a speaker' });

    await removeFromSet(channelId, 'speakers', req.userId);
    await addToSet(channelId, 'audience', req.userId);
    await refreshStageTTL(channelId);

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`channel:${channelId}`).emit('stage-speaker-removed', { channelId, userId: req.userId });

    // Emit audience-joined
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: AUTHOR_USER_SELECT });
    if (user) {
      io?.to(`channel:${channelId}`).emit('stage-audience-joined', {
        userId: req.userId,
        username: user.username,
        discriminator: user.discriminator ?? '0000',
        avatar: user.avatar ?? null,
        nameColor: user.nameColor ?? null,
        nameFont: user.nameFont ?? null,
        nameEffect: user.nameEffect ?? null,
        avatarEffect: user.avatarEffect ?? null,
        effectivePlan: getEffectivePlan(user),
        channelId,
      });
    }

    const updatedSpeakers = await getActiveStageSpeakers(channelId);
    io?.to(`server:${serverId}`).emit('server-stage-participants', {
      serverId, channelId, participants: updatedSpeakers,
    });

    res.json({ success: true });
  }),
);

// LiveKit speaker check export

export async function isStageSpeaker(channelId: string, userId: string): Promise<boolean> {
  return isInSet(channelId, 'speakers', userId);
}

/**
 * Get active stage speakers with user data for server-level broadcasting.
 * Returns empty array if no active session or no speakers.
 */
export async function getActiveStageSpeakers(
  channelId: string,
): Promise<Array<{ userId: string; username: string; avatar?: string }>> {
  const sessionId = await getStageSessionId(channelId);
  if (!sessionId) return [];
  const speakerIds = await getSetMembers(channelId, 'speakers');
  if (speakerIds.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: speakerIds } },
    select: { id: true, username: true, avatar: true },
    take: 25,
  });
  return users.map(u => ({ userId: u.id, username: u.username, avatar: u.avatar ?? undefined }));
}

export default router;
