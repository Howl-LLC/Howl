// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { Socket } from 'socket.io';
import type { SocketContext } from './types.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { hasPermission, loadPermissionContext } from '../utils.js';
import { hasChannelPermission } from '../utils/channelPermissions.js';
import { denyIfAgeGated } from '../utils/ageGate.js';
import { findUserVoiceChannel, refreshVoiceTTL, getVoiceParticipantsBatch } from '../redis.js';
import { getActiveStageSpeakers } from '../routes/stages.js';
import { isValidUUID, parseSocketPayload, typingPayload, setActivityPayload } from '../socketSchemas.js';
import {
  checkSocketRateLimit, isActivityRateLimited, broadcastActivityChange,
  fetchAndBroadcastActivities,
  cappedMapSet, CACHE_MAX_SIZE, TYPING_CACHE_TTL,
  channelServerIdCache, memberNicknameCache, dmTypingUsernameCache,
} from './infrastructure.js';
import { shouldOverwriteActivity } from '../services/activityPriority.js';
import { writeSecondaryActivity, clearSecondaryActivity, demotePrimaryToSecondary } from '../services/secondaryActivity.js';
import { logActivityToHistory, closeActivityHistory } from '../services/activityHistory.js';

/**
 * Emit the `server-voice-participants-initial` + `server-stage-participants-initial`
 * payloads for a batch of servers. Batched so the socket connect auto-subscribe
 * pass (connection.ts) pays two Prisma round trips for N servers instead of 2N.
 * `join-server` handler calls this with a single-element array; the behavior and
 * payload shape match the pre-batch per-server form.
 */
export async function emitServersInitialState(socket: Socket, serverIds: string[]): Promise<void> {
  if (serverIds.length === 0) return;
  const [voiceChannels, stageChannels] = await Promise.all([
    prisma.channel.findMany({
      where: { serverId: { in: serverIds }, type: 'voice' },
      select: { id: true, serverId: true },
      take: 5000,
    }),
    prisma.channel.findMany({
      where: { serverId: { in: serverIds }, type: 'stage' },
      select: { id: true, serverId: true },
      take: 5000,
    }),
  ]);

  // Partition channel IDs by server.
  const voiceByServer = new Map<string, string[]>();
  for (const c of voiceChannels) {
    const list = voiceByServer.get(c.serverId);
    if (list) list.push(c.id); else voiceByServer.set(c.serverId, [c.id]);
  }
  const stageByServer = new Map<string, string[]>();
  for (const c of stageChannels) {
    const list = stageByServer.get(c.serverId);
    if (list) list.push(c.id); else stageByServer.set(c.serverId, [c.id]);
  }

  // Voice participants batched into one Redis pipeline (1×RTT instead of N×RTT)
  // — critical on the connect-storm path where a user in many servers would
  // otherwise serialize a per-channel HGETALL. Stage speakers are fetched
  // per-channel because each call mixes Redis (session+SMEMBERS) with a
  // Prisma `user.findMany`, so pipelining doesn't apply cleanly.
  const allVoiceIds = voiceChannels.map(c => c.id);
  const allStageIds = stageChannels.map(c => c.id);
  const [voiceParticipantsById, stageLists] = await Promise.all([
    getVoiceParticipantsBatch(allVoiceIds),
    Promise.all(allStageIds.map(id => getActiveStageSpeakers(id))),
  ]);
  const stageParticipantsById = new Map<string, Array<{ userId: string; username: string; avatar?: string }>>();
  allStageIds.forEach((id, i) => stageParticipantsById.set(id, stageLists[i]));

  for (const serverId of serverIds) {
    const voiceIds = voiceByServer.get(serverId) ?? [];
    const voiceMap: Record<string, Array<{ userId: string; username: string; avatar?: string; banner?: string }>> = {};
    for (const id of voiceIds) {
      const list = voiceParticipantsById.get(id) ?? [];
      if (list.length > 0) voiceMap[id] = list;
    }
    // Always emit — mirrors pre-extraction behavior so the client's onInitial
    // handler fires even when the server has no active voice participants.
    socket.emit('server-voice-participants-initial', { serverId, participantsByChannel: voiceMap });

    const stageIds = stageByServer.get(serverId) ?? [];
    const stageMap: Record<string, Array<{ userId: string; username: string; avatar?: string }>> = {};
    for (const id of stageIds) {
      const list = stageParticipantsById.get(id) ?? [];
      if (list.length > 0) stageMap[id] = list;
    }
    // Only emit stage initial if there are active speakers — matches pre-extraction gate.
    if (Object.keys(stageMap).length > 0) {
      socket.emit('server-stage-participants-initial', { serverId, participantsByChannel: stageMap });
    }
  }
}

export function registerChannelHandlers(ctx: SocketContext): void {
  const { socket, userId } = ctx;

  // Per-socket typing state (created here, NOT at module scope)
  const typingThrottle = new Map<string, number>();
  const TYPING_THROTTLE_MS = 3000;
  const TYPING_RATE_WINDOW_MS = 10_000;
  const TYPING_RATE_MAX = 5;
  const typingRateTimestamps: number[] = [];

  // Block cache for DM typing — avoids DB query per typing event
  const dmBlockCache = new Map<string, { blocked: boolean; expiresAt: number }>();
  const DM_BLOCK_CACHE_TTL = 10_000; // 10 seconds — balance between DB load and block enforcement latency

  // Cached invisible status — suppress typing events for invisible users to prevent presence leakage
  let userStatusCache: { status: string; expiresAt: number } | null = null;
  const USER_STATUS_CACHE_TTL = 30_000;

  // Clean up per-socket state on disconnect
  socket.on('disconnect', () => {
    typingThrottle.clear();
    dmBlockCache.clear();
  });

  socket.on('ping-latency', async (cb: () => void) => {
    if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
    if (typeof cb === 'function') cb();
    const voiceChannelId = await findUserVoiceChannel(userId);
    if (voiceChannelId) refreshVoiceTTL(voiceChannelId).catch(() => {});
  });

  socket.on('join-channel', async (channelId: string) => {
    try {
      if (!(await checkSocketRateLimit(userId))) {
        socket.emit('rate-limited');
        return;
      }
      if (!isValidUUID(channelId)) return;
      const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true, isPrivate: true, categoryId: true, ageRestricted: true } });
      if (!channel) return;
      // Drop the join silently for minors on age-gated channels — same gate
      // the REST handlers apply via `denyIfAgeGated`. We don't surface a
      // distinct error to the socket because the client already learns about
      // age-gated channels via the channel-meta payload; a silent skip
      // matches the existing permission-fail behaviour above.
      if (await denyIfAgeGated(channel, userId)) return;
      const permCtx = await loadPermissionContext(userId, channel.serverId);
      if (!permCtx) return;
      if (!hasPermission(permCtx, 'viewChannels') || !hasPermission(permCtx, 'readMessageHistory')) return;

      // Channel-level permission override check (private channels + per-channel denies)
      const [channelOverrides, categoryOverrides] = await Promise.all([
        prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 100 }),
        channel.categoryId
          ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 100 })
          : Promise.resolve([]),
      ]);
      if (channel.isPrivate && !hasChannelPermission(permCtx, 'viewChannels', channelOverrides, categoryOverrides, undefined, { requireOverride: true })) return;
      if (!hasChannelPermission(permCtx, 'readMessageHistory', channelOverrides, categoryOverrides)) return;

      socket.join(`channel:${channelId}`);
    } catch (err) {
      logger.error({ err, userId, event: 'join-channel' }, 'socket handler error');
    }
  });

  socket.on('leave-channel', async (channelId: string) => {
    if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
    if (!isValidUUID(channelId)) return;
    socket.leave(`channel:${channelId}`);
  });

  socket.on('join-dm', async (dmChannelId: string) => {
    try {
      if (!(await checkSocketRateLimit(userId))) {
        socket.emit('rate-limited');
        return;
      }
      if (!isValidUUID(dmChannelId)) return;
      const participant = await prisma.dMParticipant.findUnique({
        where: { userId_dmChannelId: { userId, dmChannelId } },
      });
      if (participant) socket.join(`dm:${dmChannelId}`);
    } catch (err) {
      logger.error({ err, userId, event: 'join-dm' }, 'socket handler error');
    }
  });

  socket.on('leave-dm', async (dmChannelId: string) => {
    if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
    if (!isValidUUID(dmChannelId)) return;
    socket.leave(`dm:${dmChannelId}`);
  });

  socket.on('typing', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) return;
      const payload = parseSocketPayload(typingPayload, raw);
      if (!payload) return;

      const now = Date.now();

      // Global per-user typing rate limit
      while (typingRateTimestamps.length > 0 && now - typingRateTimestamps[0]! > TYPING_RATE_WINDOW_MS) {
        typingRateTimestamps.shift();
      }
      if (typingRateTimestamps.length >= TYPING_RATE_MAX) return;
      typingRateTimestamps.push(now);

      // Suppress typing events for invisible users — prevents presence leakage
      if (!userStatusCache || now >= userStatusCache.expiresAt) {
        const u = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
        userStatusCache = { status: u?.status ?? 'offline', expiresAt: now + USER_STATUS_CACHE_TTL };
      }
      if (userStatusCache.status === 'invisible') return;

      const key = payload.channelId ?? payload.dmChannelId ?? '';
      const last = typingThrottle.get(key);
      if (last && now - last < TYPING_THROTTLE_MS) return;
      cappedMapSet(typingThrottle, key, now, 500);

      if (payload.channelId && isValidUUID(payload.channelId)) {
        if (!socket.rooms.has(`channel:${payload.channelId}`)) return;
        let serverId: string | undefined;
        const cached = channelServerIdCache.get(payload.channelId);
        if (cached && now < cached.expiresAt) {
          serverId = cached.serverId;
        } else {
          const channel = await prisma.channel.findUnique({ where: { id: payload.channelId }, select: { serverId: true } });
          if (!channel) return;
          serverId = channel.serverId;
          cappedMapSet(channelServerIdCache, payload.channelId, { serverId, expiresAt: now + TYPING_CACHE_TTL }, CACHE_MAX_SIZE);
        }

        const memberKey = `${userId}:${serverId}`;
        let displayName: string;
        const cachedMember = memberNicknameCache.get(memberKey);
        if (cachedMember && now < cachedMember.expiresAt) {
          displayName = cachedMember.nickname || cachedMember.username;
        } else {
          const member = await prisma.serverMember.findUnique({
            where: { userId_serverId: { userId, serverId } },
            select: { nickname: true, user: { select: { username: true } } },
          });
          if (!member) return;
          cappedMapSet(memberNicknameCache, memberKey, { nickname: member.nickname, username: member.user.username, expiresAt: now + TYPING_CACHE_TTL }, CACHE_MAX_SIZE);
          displayName = member.nickname || member.user.username;
        }

        socket.to(`channel:${payload.channelId}`).emit('user-typing', {
          channelId: payload.channelId,
          serverId,
          userId,
          username: displayName,
        });
      } else if (payload.dmChannelId && isValidUUID(payload.dmChannelId)) {
        if (!socket.rooms.has(`dm:${payload.dmChannelId}`)) return;

        // Block check for 1:1 DMs — cached to avoid DB hit per typing event
        const blockCacheKey = `block:${userId}:${payload.dmChannelId}`;
        const cachedBlock = dmBlockCache.get(blockCacheKey);
        if (cachedBlock && now < cachedBlock.expiresAt) {
          if (cachedBlock.blocked) return;
        } else {
          const dmCh = await prisma.dMChannel.findUnique({
            where: { id: payload.dmChannelId },
            select: { isGroup: true, participants: { select: { userId: true } } },
          });
          if (dmCh && !dmCh.isGroup) {
            const otherId = dmCh.participants.find(p => p.userId !== userId)?.userId;
            if (otherId) {
              const block = await prisma.block.findFirst({
                where: { OR: [
                  { blockerId: userId, blockedUserId: otherId },
                  { blockerId: otherId, blockedUserId: userId },
                ]},
                select: { id: true },
              });
              const isBlocked = !!block;
              cappedMapSet(dmBlockCache, blockCacheKey, { blocked: isBlocked, expiresAt: now + DM_BLOCK_CACHE_TTL }, CACHE_MAX_SIZE);
              if (isBlocked) return;
            }
          }
        }

        const dmCacheKey = `${userId}:${payload.dmChannelId}`;
        // Use the outer `now` — no re-declaration (fixes variable shadowing)
        let dmUsername: string | undefined;
        const cachedDm = dmTypingUsernameCache.get(dmCacheKey);
        if (cachedDm && now < cachedDm.expiresAt) {
          dmUsername = cachedDm.username;
        } else {
          const participant = await prisma.dMParticipant.findUnique({
            where: { userId_dmChannelId: { userId, dmChannelId: payload.dmChannelId } },
            include: { user: { select: { username: true } } },
          });
          if (!participant) return;
          dmUsername = participant.user.username;
          cappedMapSet(dmTypingUsernameCache, dmCacheKey, { username: dmUsername, expiresAt: now + TYPING_CACHE_TTL }, CACHE_MAX_SIZE);
        }
        socket.to(`dm:${payload.dmChannelId}`).emit('user-typing', {
          dmChannelId: payload.dmChannelId,
          userId,
          username: dmUsername,
        });
      }
    } catch (err) {
      logger.error({ err, userId, event: 'typing' }, 'socket handler error');
    }
  });

  // Server room: so we can broadcast voice participants to everyone viewing the server
  socket.on('join-server', async (serverId: string) => {
    try {
      if (!(await checkSocketRateLimit(userId))) {
        socket.emit('rate-limited');
        return;
      }
      if (!isValidUUID(serverId)) return;
      const [member, ban] = await Promise.all([
        prisma.serverMember.findUnique({ where: { userId_serverId: { userId, serverId } } }),
        prisma.serverBan.findUnique({ where: { serverId_userId: { serverId, userId } } }),
      ]);
      if (!member || ban) return;
      socket.join(`server:${serverId}`);
      await emitServersInitialState(socket, [serverId]);
    } catch (err) {
      logger.error({ err, userId, event: 'join-server' }, 'socket handler error');
    }
  });

  socket.on('leave-server', async (serverId: string) => {
    if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
    if (!isValidUUID(serverId)) return;
    socket.leave(`server:${serverId}`);
  });

  // Activity events

  socket.on('set-activity', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) return;
      const payload = parseSocketPayload(setActivityPayload, raw);
      if (!payload) return;
      if (await isActivityRateLimited(userId)) return;

      // Check detected game preference
      if (payload.type === 'detected_game') {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { shareDetectedGames: true },
        });
        if (user && !user.shareDetectedGames) return;
      }

      // Spotify local detection — verify user has Spotify connected + sharing enabled
      if (payload.type === 'spotify') {
        const [connectedApp, user] = await Promise.all([
          prisma.connectedApp.findUnique({
            where: { userId_provider: { userId, provider: 'spotify' } },
            select: { id: true },
          }),
          prisma.user.findUnique({
            where: { id: userId },
            select: { shareSpotifyActivity: true },
          }),
        ]);
        if (!connectedApp || !user?.shareSpotifyActivity) return;
      }

      // Priority check: don't overwrite a higher-priority activity
      const current = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          activitySourcePriority: true,
          activity: { select: { type: true } },
        },
      });
      if (current?.activity && !shouldOverwriteActivity(payload.type, current.activity.type, current.activitySourcePriority)) {
        // Lost priority — write to secondary instead
        const platformMap: Record<string, string> = { detected_game: 'electron', spotify: 'spotify' };
        await writeSecondaryActivity(userId, {
          type: payload.type, name: payload.name, details: payload.details || null,
          state: payload.state || null, platform: platformMap[payload.type] || 'manual',
          durationMs: payload.durationMs ?? null,
        });
        fetchAndBroadcastActivities(userId).catch(() => {});
        return;
      }

      const platformMap: Record<string, string> = { detected_game: 'electron', spotify: 'spotify' };

      // Demote existing primary if it's a different source type
      if (current?.activity && current.activity.type !== payload.type) {
        await demotePrimaryToSecondary(userId);
      }

      // For SPOTIFY local-detection triggers: preserve existing image fields
      // (largeImage / smallImage / platformId). The local detector only knows
      // {name, artist} — blanking the image fields here causes the album art
      // to disappear in the FloatingUserStatusBar between local-emit (every
      // 5s) and the next backend OAuth poll (every 30s). The OAuth poll
      // remains the authoritative source for image fields and will overwrite
      // them with the correct values for the new track within at most 30s.
      let preservedLargeImage: string | null = null;
      let preservedSmallImage: string | null = null;
      let preservedPlatformId: string | null = null;
      let resolvedPlatform: string = platformMap[payload.type] || 'manual';
      if (payload.type === 'spotify') {
        const existing = await prisma.userActivity.findUnique({
          where: { userId },
          select: { largeImage: true, smallImage: true, platformId: true },
        });
        if (existing) {
          preservedLargeImage = existing.largeImage;
          preservedSmallImage = existing.smallImage;
          preservedPlatformId = existing.platformId;
        }
      } else if (payload.type === 'detected_game') {
        // Local game scanner provides Steam appid for known Steam titles —
        // pass it through as platformId so the renderer can derive the
        // Steam store header image without round-tripping through the
        // Steam API. Treat any payload.platformId as a Steam app id.
        if (payload.platformId) {
          preservedPlatformId = payload.platformId;
          resolvedPlatform = 'steam';
        }
      }

      await prisma.userActivity.upsert({
        where: { userId },
        create: {
          userId,
          type: payload.type,
          name: payload.name,
          details: payload.details || null,
          state: payload.state || null,
          largeImage: preservedLargeImage,
          smallImage: preservedSmallImage,
          platformId: preservedPlatformId,
          platform: resolvedPlatform,
          durationMs: payload.durationMs ?? null,
        },
        update: {
          type: payload.type,
          name: payload.name,
          details: payload.details || null,
          state: payload.state || null,
          largeImage: preservedLargeImage,
          smallImage: preservedSmallImage,
          platformId: preservedPlatformId,
          platform: resolvedPlatform,
          durationMs: payload.durationMs ?? null,
        },
      });

      // Log to activity history (fire-and-forget — never block the socket handler)
      logActivityToHistory(userId, {
        type: payload.type,
        name: payload.name,
        details: payload.details || null,
        largeImage: null,
        smallImage: null,
        platformId: null,
        platform: platformMap[payload.type] || 'manual',
      }).catch(err => logger.warn({ err: (err as Error).message, userId, event: 'set-activity' }, 'failed to log activity history'));

      fetchAndBroadcastActivities(userId).catch(() => {});
    } catch (err) {
      logger.error({ err, userId, event: 'set-activity' }, 'socket handler error');
    }
  });

  socket.on('clear-activity', async () => {
    try {
      if (!(await checkSocketRateLimit(userId))) return;

      // Close the most recent open history entry before deleting the live activity
      await closeActivityHistory(userId)
        .catch(err => logger.warn({ err: (err as Error).message, userId, event: 'clear-activity' }, 'failed to close activity history'));

      await prisma.userActivity.deleteMany({ where: { userId } });
      await clearSecondaryActivity(userId);
      broadcastActivityChange(userId, null, null).catch(() => {});
    } catch (err) {
      logger.error({ err, userId, event: 'clear-activity' }, 'socket handler error');
    }
  });
}
