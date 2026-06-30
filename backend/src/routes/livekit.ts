// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { AccessToken } from 'livekit-server-sdk';
import { TrackSource } from '@livekit/protocol';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { livekitTokenSchema } from '../schemas.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { getEffectivePlan, hasPermission, loadPermissionContext, isMemberTimedOut } from '../utils.js';
import { hasChannelPermission } from '../utils/channelPermissions.js';
import { isStageSpeaker, isInSet } from './stages.js';
import { isInVoiceChannel, isInDmCall } from '../redis.js';
import { getRegion, getDefaultRegion, getRegionListForClient } from '../services/livekitRegions.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'livekit' });

const router = Router();

const tokenLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:lk-token:'),
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many token requests. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const ROOM_NAME_RE = /^(voice|dm-call|stage):([a-zA-Z0-9_-]+)$/;
// Kept in sync with services/livekitTokens.ts — 15-minute TTL.
const TOKEN_TTL = '15m';

// GET /regions — list available LiveKit regions
router.get('/regions', authenticateToken, asyncHandler(async (_req: Request, res: Response) => {
  res.json({ regions: getRegionListForClient() });
}));

router.post('/token', authenticateToken, tokenLimiter, validate(livekitTokenSchema), asyncHandler(async (req: AuthRequest, res) => {
  const { roomName, participantName } = req.body as { roomName?: string; participantName?: string };
  const userId = req.userId;

  if (!roomName || !userId || !participantName) {
    return res.status(400).json({ error: 'roomName, participantName are required' });
  }

  const match = ROOM_NAME_RE.exec(roomName);
  if (!match) {
    return res.status(400).json({ error: 'Invalid room name format' });
  }

  const [, roomType, resourceId] = match;

  let canPublish = true;
  let region;

  if (roomType === 'voice' || roomType === 'stage') {
    const channel = await prisma.channel.findUnique({
      where: { id: resourceId },
      select: { id: true, type: true, serverId: true, isPrivate: true, categoryId: true },
    });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (roomType === 'voice' && channel.type !== 'voice') return res.status(400).json({ error: 'Not a voice channel' });
    if (roomType === 'stage' && channel.type !== 'stage') return res.status(400).json({ error: 'Not a stage channel' });

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId, serverId: channel.serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(userId, channel.serverId),
    ]);
    if (!member || !permCtx) return res.status(403).json({ error: 'You are not a member of this server' });
    // Refuse to mint a stage token for a timed-out member — defense in
    // depth behind the stage-join socket gate, closing any other entry path into
    // the speaker/audience set (e.g. starting a stage via REST while timed out).
    if (roomType === 'stage' && isMemberTimedOut(member)) {
      return res.status(403).json({ error: 'You are timed out and cannot join stages' });
    }
    if (!hasPermission(permCtx,'connect')) {
      return res.status(403).json({ error: 'You do not have permission to join voice channels' });
    }
    // Verify user has actually joined the channel via socket before issuing a token
    if (roomType === 'voice') {
      const isParticipant = await isInVoiceChannel(resourceId, userId);
      if (!isParticipant) {
        return res.status(403).json({ error: 'You must join the channel first' });
      }
    } else if (roomType === 'stage') {
      const isSpeaker = await isInSet(resourceId, 'speakers', userId);
      const isAudience = await isInSet(resourceId, 'audience', userId);
      if (!isSpeaker && !isAudience) {
        return res.status(403).json({ error: 'You must join the channel first' });
      }
    }

    // Defense-in-depth: private channels require an explicit view override even
    // if the user somehow holds Redis membership. Re-checks the channel/category
    // override chain (requireOverride: a server @everyone baseline does not grant
    // access to a private channel) before minting a media token.
    if (channel.isPrivate) {
      const [chOverrides, catOverrides] = await Promise.all([
        prisma.channelPermissionOverride.findMany({ where: { channelId: channel.id }, take: 100 }),
        channel.categoryId
          ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 100 })
          : Promise.resolve([]),
      ]);
      if (!hasChannelPermission(permCtx, 'viewChannels', chOverrides, catOverrides, undefined, { requireOverride: true })) {
        return res.status(403).json({ error: 'You do not have permission to view this channel' });
      }
    }

    if (roomType === 'stage') {
      // Stage: check Redis speaker set, or manageStages permission
      const speakerStatus = await isStageSpeaker(resourceId, userId);
      canPublish = speakerStatus || hasPermission(permCtx,'manageStages');
    } else if (!hasPermission(permCtx,'speak')) {
      canPublish = false;
    }

    // Resolve region from server settings, with failover to the default
    // region if the server-configured one isn't credentialed (misconfig or
    // partial rollout of LIVEKIT_REGIONS). Prevents a 503 when a region
    // entry exists but lacks apiKey/apiSecret.
    const settings = await prisma.serverSettings.findUnique({
      where: { serverId: channel.serverId },
      select: { region: true },
    });
    const primary = getRegion(settings?.region ?? 'automatic');
    if (primary && primary.apiKey && primary.apiSecret) {
      region = primary;
    } else {
      log.warn({ serverId: channel.serverId, configuredRegion: settings?.region }, 'Primary region missing credentials — falling back to default');
      region = getDefaultRegion();
    }
  } else if (roomType === 'dm-call') {
    const participant = await prisma.dMParticipant.findUnique({
      where: { userId_dmChannelId: { userId, dmChannelId: resourceId } },
    });
    if (!participant) return res.status(403).json({ error: 'You are not in this DM' });

    const otherParticipants = await prisma.dMParticipant.findMany({
      where: { dmChannelId: resourceId, userId: { not: userId } },
      select: { userId: true },
      take: 50,
    });
    const otherIds = otherParticipants.map(p => p.userId);
    if (otherIds.length > 0) {
      const block = await prisma.block.findFirst({
        where: {
          OR: [
            { blockerId: userId, blockedUserId: { in: otherIds } },
            { blockerId: { in: otherIds }, blockedUserId: userId },
          ],
        },
      });
      if (block) {
        return res.status(403).json({ error: 'Cannot call this user' });
      }
    }

    // Verify user has actually joined the DM call via socket
    const isCallParticipant = await isInDmCall(resourceId, userId);
    if (!isCallParticipant) {
      return res.status(403).json({ error: 'You must join the call first' });
    }

    region = getDefaultRegion();
  }

  if (!region) {
    return res.status(400).json({ error: 'Unable to resolve region' });
  }

  if (!region.apiKey || !region.apiSecret) {
    return res.status(503).json({ error: 'Voice server not configured for this region' });
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true } });
  const plan = user ? getEffectivePlan(user) : 'free';

  const maxCameraBitrate = plan === 'pro' ? 8_000_000 : plan === 'essential' ? 4_500_000 : 2_500_000;
  const maxCameraRes = plan === 'pro' ? '1440p' : plan === 'essential' ? '1080p' : '720p';
  const maxScreenShareBitrate = plan === 'pro' ? 5_000_000 : plan === 'essential' ? 3_000_000 : 2_000_000;

  const token = new AccessToken(region.apiKey, region.apiSecret, {
    identity: userId,
    name: participantName.slice(0, 32),
    ttl: TOKEN_TTL,
    metadata: JSON.stringify({ plan, maxCameraBitrate, maxCameraRes, maxScreenShareBitrate }),
  });

  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: canPublish
      ? [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
      : [],
  });

  const jwt = await token.toJwt();
  log.info({ userId, roomName, roomType, resourceId, plan, regionId: region.id }, 'livekit token issued');
  res.json({ token: jwt, url: region.url });
}));

export default router;
