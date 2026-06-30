// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { getIO } from '../socketIO.js';
import { prisma } from '../db.js';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { logger } from '../logger.js';
import { enqueueNotification } from '../queues/producers.js';
import { queuesEnabled } from '../queues/connection.js';
import {
  removeVoiceParticipant, getVoiceParticipants, deleteVoiceOverride,
  voiceChannelSize, getVoiceChannelUserIds, setVoiceReverseLookup,
  getDmCallParticipants, removeDmCallParticipant, dmCallSize,
  isInDmCall, isDmCallDeclined, getDmCallFirstCaller, setDmCallReverseLookup,
  getDmCallStartTime, deleteDmCallStartTime,
  clearDmCallDeclined,
  getUserSocketIds,
  redis,
  redisEnabled,
  checkSocketRateLimit,
} from '../redis.js';
import { encryptDmContent } from '../services/dmCrypto.js';
import { sendPushToUser, pushEnabled } from '../services/pushNotifications.js';

// Capped Map helpers (LRU eviction)
export function cappedMapSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.size >= max && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export function cappedTimerMapSet<K>(map: Map<K, NodeJS.Timeout>, key: K, value: NodeJS.Timeout, max: number, clearFn: (t: NodeJS.Timeout) => void): void {
  if (map.size >= max && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      const evicted = map.get(oldest);
      if (evicted !== undefined) clearFn(evicted);
      map.delete(oldest);
    }
  }
  map.set(key, value);
}

// Constants
// Bumped from 10_000 → 50_000 for connect-storm headroom: at launch a single
// replica may hold ~10K concurrent sockets, and the typing/presence lookup
// caches keyed by channel/member rapidly fill past 10K under that load.
// Hitting the cap forces every new handshake into a DB roundtrip on the hot
// path — exactly the wrong behavior under a flash flood. 50K keeps the cap
// well above expected per-replica working-set size.
export const CACHE_MAX_SIZE = 50_000;
const MAX_TIMER_MAP_SIZE = 10_000;
export const MAX_OFFLINE_GRACE_SIZE = 100_000;
export const MAX_SOCKETS_PER_USER = 5;
const INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const OFFLINE_GRACE_MS = 7_000;
export const TYPING_CACHE_TTL = 60_000;

// Instance-local Maps
// Ring timers and inactivity timers are instance-local (held in JS memory, not Redis).
// Limitations:
//   - On crash or restart, all pending timers are lost — an in-progress ring or
//     inactivity countdown simply stops and will not fire.
//   - In a multi-instance deployment, timer ownership is not distributed: whichever
//     instance created the timer owns it, and other instances are unaware of it.
// Mitigation: all timers have short durations (ring ≤60s, inactivity ≤3min), so the
// worst case is a single missed auto-disconnect that the user can trigger manually.
export const dmCallRingTimers = new Map<string, NodeJS.Timeout>();
export const voiceInactivityTimers = new Map<string, NodeJS.Timeout>();
export const dmCallInactivityTimers = new Map<string, NodeJS.Timeout>();
export const userSocketCount = new Map<string, number>();
export const offlineGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Shared caches for typing-event lookups (module-scope to avoid per-socket leaks)
export const channelServerIdCache = new Map<string, { serverId: string; expiresAt: number }>();
export const memberNicknameCache = new Map<string, { nickname: string | null; username: string; expiresAt: number }>();
export const dmTypingUsernameCache = new Map<string, { username: string; expiresAt: number }>();

// Per-user soundboard play cooldown (max 3 plays per 10s)
const SOUNDBOARD_COOLDOWN_MS = 10_000;
const MAX_SOUNDBOARD_PLAYS = 3;
const MAX_SOUNDBOARD_COOLDOWN_ENTRIES = 10_000;
const soundboardCooldowns = new Map<string, number[]>();

// Cleanup intervals
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of soundboardCooldowns) {
    const recent = ts.filter(t => now - t < SOUNDBOARD_COOLDOWN_MS);
    if (recent.length === 0) soundboardCooldowns.delete(key);
    else soundboardCooldowns.set(key, recent);
  }
  // Purge stale zero-count entries from userSocketCount
  for (const [key, count] of userSocketCount) {
    if (count <= 0) userSocketCount.delete(key);
  }
}, 60_000).unref();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of channelServerIdCache) {
    if (now > entry.expiresAt) channelServerIdCache.delete(key);
  }
  for (const [key, entry] of memberNicknameCache) {
    if (now > entry.expiresAt) memberNicknameCache.delete(key);
  }
  for (const [key, entry] of dmTypingUsernameCache) {
    if (now > entry.expiresAt) dmTypingUsernameCache.delete(key);
  }
}, 60_000).unref();

// Soundboard throttle
export async function isSoundboardThrottled(userId: string): Promise<boolean> {
  if (redis) {
    try {
      const key = `sbrate:${userId}`;
      const count = await redis.eval(
        `local c = redis.call('incr', KEYS[1]) if c == 1 then redis.call('pexpire', KEYS[1], ARGV[1]) end return c`,
        1, key, String(SOUNDBOARD_COOLDOWN_MS),
      ) as number;
      return count > MAX_SOUNDBOARD_PLAYS;
    } catch {
      // fall through to in-memory
    }
  }
  const now = Date.now();
  const ts = soundboardCooldowns.get(userId) ?? [];
  const recent = ts.filter(t => now - t < SOUNDBOARD_COOLDOWN_MS);
  if (recent.length >= MAX_SOUNDBOARD_PLAYS) return true;
  recent.push(now);
  if (soundboardCooldowns.size >= MAX_SOUNDBOARD_COOLDOWN_ENTRIES && !soundboardCooldowns.has(userId)) {
    const oldest = soundboardCooldowns.keys().next().value;
    if (oldest !== undefined) soundboardCooldowns.delete(oldest);
  }
  soundboardCooldowns.set(userId, recent);
  return false;
}

// Socket ID lookup
export async function userIdToSocketId_get(userId: string): Promise<string | undefined> {
  const ids = await getUserSocketIds(userId);
  return ids.length > 0 ? ids[0] : undefined;
}

// For routes that need a sync check (best-effort in Redis mode).
export function isUserConnectedSync(userId: string): boolean {
  if (redisEnabled) return false;
  return (userSocketCount.get(userId) || 0) > 0;
}

// Presence relationship cache
// When BullMQ is unavailable, broadcastPresenceChange runs 3 parallel Prisma
// queries per status change. During mass connect/disconnect (server restart),
// this creates DB spikes. Cache membership + friendship + block data with a
// short TTL since these relationships change infrequently relative to presence.
const PRESENCE_CACHE_TTL = 60_000; // 60 seconds
const MAX_PRESENCE_CACHE_SIZE = 5_000;

interface PresenceCacheEntry {
  memberships: Array<{ serverId: string }>;
  friendships: Array<{ fromUserId: string; toUserId: string }>;
  blocks: Array<{ blockerId: string; blockedUserId: string }>;
  expiresAt: number;
}

const presenceRelationCache = new Map<string, PresenceCacheEntry>();

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of presenceRelationCache) {
    if (now > entry.expiresAt) presenceRelationCache.delete(key);
  }
}, 60_000).unref();

async function getPresenceRelations(userId: string): Promise<PresenceCacheEntry> {
  const cached = presenceRelationCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) return cached;

  const [memberships, friendships, blocks] = await Promise.all([
    prisma.serverMember.findMany({ where: { userId }, select: { serverId: true }, take: 500 }).catch(() => [] as Array<{ serverId: string }>),
    prisma.friendRequest.findMany({
      where: { status: 'accepted', OR: [{ fromUserId: userId }, { toUserId: userId }] },
      select: { fromUserId: true, toUserId: true },
      take: 2000,
    }).catch(() => [] as Array<{ fromUserId: string; toUserId: string }>),
    prisma.block.findMany({
      where: { OR: [{ blockerId: userId }, { blockedUserId: userId }] },
      select: { blockerId: true, blockedUserId: true },
      take: 5000,
    }).catch(() => [] as Array<{ blockerId: string; blockedUserId: string }>),
  ]);

  const entry: PresenceCacheEntry = { memberships, friendships, blocks, expiresAt: Date.now() + PRESENCE_CACHE_TTL };
  cappedMapSet(presenceRelationCache, userId, entry, MAX_PRESENCE_CACHE_SIZE);
  return entry;
}

// Presence broadcast
export async function broadcastPresenceChange(userId: string, status: string) {
  if (queuesEnabled) {
    enqueueNotification({ type: 'presence', userId, status }).catch(() => {});
    return;
  }
  const io = getIO();
  const visibleStatus = status === 'invisible' ? 'offline' : status;
  const { memberships, friendships, blocks } = await getPresenceRelations(userId);
  // Build set of blocked user IDs (both directions)
  const blockedIds = new Set<string>();
  for (const b of blocks) {
    if (b.blockerId === userId) blockedIds.add(b.blockedUserId);
    else blockedIds.add(b.blockerId);
  }
  const payload = { userId, status: visibleStatus };
  const friendIds = friendships.map(f => f.fromUserId === userId ? f.toUserId : f.fromUserId);

  // Single broadcast to friends + server members. The previous code split this
  // into separate friend-room vs server-room emissions to hide real status from
  // non-friend server members under `showOnlineStatus: 'friends_only'`. That
  // conflicted with the REST endpoints (which always return real status) and
  // with the client's last-write-wins presence buffer — same viewer in both
  // rooms collapsed the two payloads, producing home/server drift. `invisible`
  // still maps to 'offline' via `visibleStatus`.
  const rooms = memberships.map(m => `server:${m.serverId}`);
  rooms.push(...friendIds.filter(fid => !blockedIds.has(fid)).map(fid => `user:${fid}`));
  if (rooms.length > 0) {
    io.to(rooms).emit('presence-update', payload);
  }
}

// Activity broadcast

const _ACTIVITY_SOURCE_MAP: Record<string, string> = { steam_game: 'steam', spotify: 'spotify', detected_game: 'detected', custom: 'custom' };

export function resolveActivityWinner(
  realActivity: { type: string } | null | undefined,
  bio: string | null | undefined,
  shareActivityBio: boolean | undefined,
  _priorityStr: string | undefined,
): 'activity' | 'bio' | null {
  // Real live activity ALWAYS beats bio. Bio is a fallback, not a competitor.
  // Priority between real sources (steam vs spotify vs detected vs custom) is
  // already resolved at write time by shouldOverwriteActivity() — the activity
  // passed here is already the winner.
  if (realActivity) return 'activity';
  // No real activity — show bio if enabled and set
  const hasBio = shareActivityBio !== false && !!bio;
  if (hasBio) return 'bio';
  return null;
}

export interface ActivityBroadcastPayload {
  type: string;
  name: string;
  details?: string | null;
  state?: string | null;
  largeImage?: string | null;
  smallImage?: string | null;
  startedAt: string;
  platformId?: string | null;
  platform?: string | null;
  durationMs?: number | null;
}

export async function broadcastActivityChange(
  userId: string,
  activity: ActivityBroadcastPayload | null,
  secondaryActivity?: ActivityBroadcastPayload | null,
): Promise<void> {
  if (queuesEnabled) {
    enqueueNotification({ type: 'activity', userId, activity, secondaryActivity }).catch(() => {});
    return;
  }
  const io = getIO();
  const [memberships, friendships, blocks, userPrivacy] = await Promise.all([
    prisma.serverMember.findMany({
      where: { userId },
      select: { serverId: true, shareActivity: true, server: { select: { _count: { select: { members: true } } } } },
      take: 500,
    }).catch(() => [] as Array<{ serverId: string; shareActivity: boolean | null; server: { _count: { members: number } } }>),
    prisma.friendRequest.findMany({
      where: { status: 'accepted', OR: [{ fromUserId: userId }, { toUserId: userId }] },
      select: { fromUserId: true, toUserId: true },
      take: 2000,
    }).catch(() => []),
    prisma.block.findMany({
      where: { OR: [{ blockerId: userId }, { blockedUserId: userId }] },
      select: { blockerId: true, blockedUserId: true },
      take: 5000,
    }).catch(() => []),
    prisma.user.findUnique({
      where: { id: userId },
      select: { showCurrentActivity: true, activitySharingEnabled: true, activityShareScope: true, activityBio: true, shareActivityBio: true, activitySourcePriority: true, status: true },
    }).catch(() => null),
  ]);

  // Master toggle off → no emissions
  if (!userPrivacy || !userPrivacy.activitySharingEnabled) return;
  // Legacy privacy: "nobody" → no emissions
  if (userPrivacy.showCurrentActivity === 'nobody') return;

  // Don't broadcast if user is invisible or offline
  if ((userPrivacy as any).status === 'invisible' || (userPrivacy as any).status === 'offline') return;

  // Don't broadcast if user has no active socket connections
  const userRoom = await io.in(`user:${userId}`).fetchSockets();
  if (userRoom.length === 0) return;

  const blockedIds = new Set<string>();
  for (const b of blocks) {
    if (b.blockerId === userId) blockedIds.add(b.blockedUserId);
    else blockedIds.add(b.blockerId);
  }
  const friendIds = friendships
    .map(f => f.fromUserId === userId ? f.toUserId : f.fromUserId)
    .filter(fid => !blockedIds.has(fid));

  // Resolve which activity to broadcast based on priority
  const winner = resolveActivityWinner(
    activity,
    userPrivacy.activityBio,
    userPrivacy.shareActivityBio,
    userPrivacy.activitySourcePriority,
  );

  let effectiveActivity = activity;
  if (winner === 'bio' && userPrivacy.activityBio) {
    effectiveActivity = {
      type: 'bio',
      name: userPrivacy.activityBio,
      details: null,
      state: null,
      largeImage: null,
      smallImage: null,
      startedAt: new Date().toISOString(),
      platformId: null,
      platform: null,
    };
  } else if (winner === null) {
    effectiveActivity = null;
  }

  const payload = { userId, activity: effectiveActivity, secondaryActivity: secondaryActivity ?? null };
  const friendRooms = friendIds.map(fid => `user:${fid}`);

  // Determine which servers to include based on scope + per-server overrides
  const scope = userPrivacy.activityShareScope || 'everyone';
  const serverRooms: string[] = [];
  for (const m of memberships) {
    // Per-server explicit override wins
    if (m.shareActivity === false) continue;
    if (m.shareActivity === true) { serverRooms.push(`server:${m.serverId}`); continue; }
    // null → use scope
    if (scope === 'everyone') { serverRooms.push(`server:${m.serverId}`); continue; }
    if (scope === 'friends_small_servers' && m.server._count.members <= 200) { serverRooms.push(`server:${m.serverId}`); continue; }
    // friends_only → no server rooms unless explicit override
  }

  // Also respect legacy showCurrentActivity for backwards compat
  if (userPrivacy.showCurrentActivity === 'friends_only' || scope === 'friends_only') {
    if (friendRooms.length > 0) io.to(friendRooms).emit('activity-update', payload);
    // Still include explicitly-overridden servers
    const overrideRooms = memberships.filter(m => m.shareActivity === true).map(m => `server:${m.serverId}`);
    if (overrideRooms.length > 0) io.to(overrideRooms).emit('activity-update', payload);
  } else {
    const rooms = [...serverRooms, ...friendRooms];
    if (rooms.length > 0) io.to(rooms).emit('activity-update', payload);
  }
}

/**
 * Fetch both primary and secondary activities for a user, then broadcast.
 * Avoids duplicating fetch logic in every service.
 */
export async function fetchAndBroadcastActivities(userId: string): Promise<void> {
  const [primary, secondary] = await Promise.all([
    prisma.userActivity.findUnique({
      where: { userId },
      select: { type: true, name: true, details: true, state: true, largeImage: true, smallImage: true, startedAt: true, platformId: true, platform: true, durationMs: true },
    }),
    prisma.userSecondaryActivity.findUnique({
      where: { userId },
      select: { type: true, name: true, details: true, state: true, largeImage: true, smallImage: true, startedAt: true, platformId: true, platform: true, durationMs: true },
    }),
  ]);
  const toPayload = (a: typeof primary): ActivityBroadcastPayload | null => {
    if (!a) return null;
    return {
      type: a.type, name: a.name, details: a.details, state: a.state,
      largeImage: a.largeImage, smallImage: a.smallImage,
      startedAt: a.startedAt.toISOString(), platformId: a.platformId,
      platform: a.platform, durationMs: a.durationMs,
    };
  };
  await broadcastActivityChange(userId, toPayload(primary), toPayload(secondary));
}

// Activity socket rate limit (6/min per user)

const ACTIVITY_RATE_WINDOW_MS = 60_000;
const MAX_ACTIVITY_UPDATES_PER_MIN = 6;
const MAX_ACTIVITY_RATE_ENTRIES = 10_000;
const activityRates = new Map<string, number[]>();

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of activityRates) {
    const recent = ts.filter(t => now - t < ACTIVITY_RATE_WINDOW_MS);
    if (recent.length === 0) activityRates.delete(key);
    else activityRates.set(key, recent);
  }
}, 60_000).unref();

export async function isActivityRateLimited(userId: string): Promise<boolean> {
  if (redis) {
    try {
      const key = `actrate:${userId}`;
      const count = await redis.eval(
        `local c = redis.call('incr', KEYS[1]) if c == 1 then redis.call('pexpire', KEYS[1], ARGV[1]) end return c`,
        1, key, String(ACTIVITY_RATE_WINDOW_MS),
      ) as number;
      return count > MAX_ACTIVITY_UPDATES_PER_MIN;
    } catch {
      // fall through to in-memory
    }
  }
  const now = Date.now();
  const ts = activityRates.get(userId) ?? [];
  const recent = ts.filter(t => now - t < ACTIVITY_RATE_WINDOW_MS);
  if (recent.length >= MAX_ACTIVITY_UPDATES_PER_MIN) return true;
  recent.push(now);
  if (activityRates.size >= MAX_ACTIVITY_RATE_ENTRIES && !activityRates.has(userId)) {
    const oldest = activityRates.keys().next().value;
    if (oldest !== undefined) activityRates.delete(oldest);
  }
  activityRates.set(userId, recent);
  return false;
}

// DM call system messages
export async function createDmCallSystemMessage(
  dmChannelId: string,
  authorId: string,
  content: string,
  callKind: string,
  extra?: Record<string, unknown>,
) {
  try {
    const io = getIO();
    const payload = { kind: callKind, ...extra };
    const enc = encryptDmContent(content);
    const rows = await prisma.$queryRaw<
      Array<{ id: string; dmChannelId: string; authorId: string; content: string; contentIv: string | null; type: string; systemPayload: unknown; createdAt: Date }>
    >(Prisma.sql`
      INSERT INTO "DMMessage" (id, "dmChannelId", "authorId", content, "contentIv", type, "systemPayload", "createdAt")
      VALUES (gen_random_uuid(), ${dmChannelId}, ${authorId}, ${enc.ciphertext}, ${enc.iv}, 'system', ${JSON.stringify(payload)}::jsonb, NOW())
      RETURNING id, "dmChannelId", "authorId", content, "contentIv", type, "systemPayload", "createdAt"
    `);
    const msg = rows[0];
    if (!msg) return;
    const author = await prisma.user.findUnique({ where: { id: authorId }, select: { username: true, discriminator: true, avatar: true } });
    const emitPayload = {
      id: msg.id,
      dmChannelId: msg.dmChannelId,
      authorId: msg.authorId,
      content,
      type: msg.type,
      systemPayload: msg.systemPayload as Record<string, unknown>,
      createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : new Date(msg.createdAt).toISOString(),
      authorUsername: author?.username ?? null,
      authorDiscriminator: author?.discriminator ?? null,
      authorAvatar: author?.avatar ?? null,
    };
    io.to(`dm:${dmChannelId}`).emit('dm-system-message', emitPayload);
  } catch (err) {
    logger.error({ err, dmChannelId, authorId }, 'Failed to create DM call system message');
  }
}

// Voice inactivity
export async function checkVoiceInactivity(channelId: string) {
  const existing = voiceInactivityTimers.get(channelId);
  if (existing) { clearTimeout(existing); voiceInactivityTimers.delete(channelId); }

  const size = await voiceChannelSize(channelId);
  if (size === 0 || size > 1) return;

  const timer = setTimeout(async () => {
    voiceInactivityTimers.delete(channelId);
    const currentSize = await voiceChannelSize(channelId);
    if (currentSize !== 1) return;

    const userIds = await getVoiceChannelUserIds(channelId);
    const aloneUserId = userIds[0];
    if (!aloneUserId) return;
    const io = getIO();
    io.to(`user:${aloneUserId}`).emit('voice-inactivity-disconnect', { channelId });
    io.in(`user:${aloneUserId}`).socketsLeave(`voice:${channelId}`);
    await removeVoiceParticipant(channelId, aloneUserId);
    await deleteVoiceOverride(channelId, aloneUserId);
    await setVoiceReverseLookup(aloneUserId, null);

    const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true } }).catch(() => null);
    if (channel?.serverId) {
      const participants = await getVoiceParticipants(channelId);
      io.to(`server:${channel.serverId}`).emit('server-voice-participants', { serverId: channel.serverId, channelId, participants });
    }
  }, INACTIVITY_TIMEOUT_MS);
  cappedTimerMapSet(voiceInactivityTimers, channelId, timer, MAX_TIMER_MAP_SIZE, clearTimeout);
}

// DM call inactivity
export async function checkDmCallInactivity(dmChannelId: string) {
  const existing = dmCallInactivityTimers.get(dmChannelId);
  if (existing) { clearTimeout(existing); dmCallInactivityTimers.delete(dmChannelId); }

  const size = await dmCallSize(dmChannelId);
  if (size === 0 || size > 1) return;

  const timer = setTimeout(async () => {
    dmCallInactivityTimers.delete(dmChannelId);
    const currentSize = await dmCallSize(dmChannelId);
    if (currentSize !== 1) return;

    const participants = await getDmCallParticipants(dmChannelId);
    const aloneUserId = participants[0]?.userId;
    if (!aloneUserId) return;
    const io = getIO();
    io.to(`user:${aloneUserId}`).emit('dm-call-inactivity-disconnect', { dmChannelId });
    io.in(`user:${aloneUserId}`).socketsLeave(`dm-call:${dmChannelId}`);
    await removeDmCallParticipant(dmChannelId, aloneUserId);
    await setDmCallReverseLookup(aloneUserId, null);
    const remainingSize = await dmCallSize(dmChannelId);
    if (remainingSize === 0) {
      stopDmCallRing(dmChannelId);
      // Create system message with call duration (matching leave-dm-call and disconnect behavior)
      const startTime = await getDmCallStartTime(dmChannelId);
      await deleteDmCallStartTime(dmChannelId);
      const durationMs = startTime ? Date.now() - startTime : 0;
      const durationSec = Math.round(durationMs / 1000);
      createDmCallSystemMessage(dmChannelId, aloneUserId, 'Call ended', 'call_ended', { durationSeconds: durationSec });
      // Notify all DM members the call has ended
      io.to(`dm:${dmChannelId}`).emit('dm-call-ended', { dmChannelId });
    }
  }, INACTIVITY_TIMEOUT_MS);
  cappedTimerMapSet(dmCallInactivityTimers, dmChannelId, timer, MAX_TIMER_MAP_SIZE, clearTimeout);
}

// Startup ghost cleanup & periodic health check

export async function cleanupStaleVoiceParticipants() {
  if (!redis) return;
  const io = getIO();
  try {
    let cursor = '0';
    let voiceChannelsScanned = 0;
    let ghostsRemoved = 0;
    do {
      const result = await redis.scan(cursor, 'MATCH', 'voice:*', 'COUNT', 100);
      cursor = result[0];
      for (const key of result[1]) {
        if (key.startsWith('voice-rev:') || key.startsWith('voice:override:')) continue;
        const channelId = key.slice(6);
        if (channelId.length < 30) continue;
        voiceChannelsScanned++;
        const userIds = await getVoiceChannelUserIds(channelId);
        for (const userId of userIds) {
          const sockets = await io.in(`user:${userId}`).fetchSockets();
          if (sockets.length === 0) {
            logger.info({ userId, channelId, event: 'startup-ghost-cleanup' }, 'Removing ghost voice participant');
            await removeVoiceParticipant(channelId, userId);
            await setVoiceReverseLookup(userId, null);
            await deleteVoiceOverride(channelId, userId);
            ghostsRemoved++;
          }
        }
        await checkVoiceInactivity(channelId);
      }
    } while (cursor !== '0');

    cursor = '0';
    let dmCallsScanned = 0;
    do {
      const result = await redis.scan(cursor, 'MATCH', 'dm-call:*', 'COUNT', 100);
      cursor = result[0];
      for (const key of result[1]) {
        if (key.startsWith('dm-call-rev:') || key.startsWith('dm-call-ring:') || key.startsWith('dm-call-declined:') || key.startsWith('dm-call-start:')) continue;
        const dmChannelId = key.slice(8);
        if (dmChannelId.length < 30) continue;
        dmCallsScanned++;
        await checkDmCallInactivity(dmChannelId);
      }
    } while (cursor !== '0');

    logger.info({ voiceChannelsScanned, dmCallsScanned, ghostsRemoved, event: 'startup-cleanup-complete' }, 'Voice/DM startup cleanup complete');
  } catch (err) {
    logger.error({ err, event: 'startup-cleanup-error' }, 'Failed to clean up stale voice participants on startup');
  }
}

const VOICE_HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;

export function startVoiceHealthCheck() {
  if (!redis) return;
  setInterval(async () => {
    if (!redis) return;
    try {
      const io = getIO();
      let cursor = '0';
      do {
        const result = await redis.scan(cursor, 'MATCH', 'voice:*', 'COUNT', 100);
        cursor = result[0];
        for (const key of result[1]) {
          if (key.startsWith('voice-rev:') || key.startsWith('voice:override:')) continue;
          const channelId = key.slice(6);
          if (channelId.length < 30) continue;
          const userIds = await getVoiceChannelUserIds(channelId);
          let cleaned = false;
          for (const userId of userIds) {
            const sockets = await io.in(`user:${userId}`).fetchSockets();
            if (sockets.length === 0) {
              logger.info({ userId, channelId, event: 'periodic-ghost-cleanup' }, 'Removing ghost voice participant');
              await removeVoiceParticipant(channelId, userId);
              await setVoiceReverseLookup(userId, null);
              await deleteVoiceOverride(channelId, userId);
              cleaned = true;
            }
          }
          if (cleaned) {
            const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true } }).catch(() => null);
            if (channel?.serverId) {
              const participants = await getVoiceParticipants(channelId);
              io.to(`server:${channel.serverId}`).emit('server-voice-participants', { serverId: channel.serverId, channelId, participants });
            }
          }
          await checkVoiceInactivity(channelId);
        }
      } while (cursor !== '0');
    } catch (err) {
      logger.error({ err, event: 'voice-health-check-error' }, 'Voice health check failed');
    }
  }, VOICE_HEALTH_CHECK_INTERVAL);
}

// DM call lone-caller termination
// Ends the DM call when only the caller remains and every other DM participant
// has either declined or disconnected without accepting (or the 60s ring
// timer has expired with no answer). Without this, the caller is stranded in
// the dm-call room with their ringback looping until their client-side 60s
// safety net fires.
//
// Idempotent: bails if dmCallSize !== 1, so callers can fire-and-forget after
// any decline/disconnect/timer-expiry without checking state themselves.
export async function terminateLoneCallerDmCall(
  dmChannelId: string,
  reason: 'no_answer' | 'all_declined',
): Promise<void> {
  try {
    const size = await dmCallSize(dmChannelId);
    if (size !== 1) return;
    const first = await getDmCallFirstCaller(dmChannelId);
    if (!first) return;
    const callerId = first.userId;

    stopDmCallRing(dmChannelId);
    await removeDmCallParticipant(dmChannelId, callerId);
    await setDmCallReverseLookup(callerId, null);
    await deleteDmCallStartTime(dmChannelId);

    const io = getIO();
    // Boot the caller's sockets out of the dm-call room so any further
    // re-rings or stale broadcasts don't reach them.
    io.in(`user:${callerId}`).socketsLeave(`dm-call:${dmChannelId}`);
    // Caller-side teardown signal: useDmCallState listens for this and
    // clears activeDmCallChannelId, which unmounts DMCallView and stops
    // the ringback audio.
    io.to(`user:${callerId}`).emit('dm-call-no-answer', { dmChannelId, reason });
    // DM-list state update so the "X is in a call" banner clears for the
    // other DM members (mirrors the leave-handler behavior at size===0).
    io.to(`dm:${dmChannelId}`).emit('dm-call-ended', { dmChannelId });

    createDmCallSystemMessage(dmChannelId, callerId, 'Missed call', 'call_missed');
    logger.info({ dmChannelId, callerId, reason, event: 'dm-call-no-answer' }, 'lone caller DM call terminated');
  } catch (err) {
    logger.error({ err, dmChannelId, reason, event: 'dm-call-no-answer-error' }, 'Failed to terminate lone-caller DM call');
  }
}

// DM call ring
export function startDmCallRing(dmChannelId: string) {
  stopDmCallRing(dmChannelId);
  let ticks = 0;
  const MAX_RING_TICKS = 12; // 12 ticks × 5s interval = 60s max ring duration
  const pushSentTo = new Set<string>();
  // Cache participants ONCE before the interval — they don't change during ringing
  prisma.dMParticipant.findMany({
    where: { dmChannelId },
    select: { userId: true },
    take: 100,
  }).then((dmParticipants) => {
    const participantIds = dmParticipants.map(p => p.userId);
    const timer = setInterval(async () => {
      ticks++;
      const size = await dmCallSize(dmChannelId);
      if (size === 0 || ticks >= MAX_RING_TICKS) {
        if (ticks >= MAX_RING_TICKS && size === 1) {
          // Caller has been ringing for the full 60s with no answer — boot
          // them out of the call so the ringback stops, and write the
          // "Missed call" system message via the shared helper.
          await terminateLoneCallerDmCall(dmChannelId, 'no_answer');
        } else {
          stopDmCallRing(dmChannelId);
        }
        return;
      }
      const first = await getDmCallFirstCaller(dmChannelId);
      if (!first) return;
      try {
        const io = getIO();
        const callerUserId = first.userId;
        // Check for blocks between caller and each participant (re-checked every tick)
        const blockPairs = await prisma.block.findMany({
          where: {
            OR: [
              { blockerId: callerUserId, blockedUserId: { in: participantIds } },
              { blockedUserId: callerUserId, blockerId: { in: participantIds } },
            ],
          },
          select: { blockerId: true, blockedUserId: true },
          take: 100,
        }).catch(() => []);
        const blockedInRing = new Set(blockPairs.map(b => b.blockerId === callerUserId ? b.blockedUserId : b.blockerId));
        const ringChecks = await Promise.all(
          participantIds.map(async (uid) => ({
            userId: uid,
            inCall: await isInDmCall(dmChannelId, uid),
            declined: await isDmCallDeclined(dmChannelId, uid),
          }))
        );
        const toRing = ringChecks.filter(rc => !rc.inCall && !rc.declined && !blockedInRing.has(rc.userId));
        const callPayload = {
          dmChannelId,
          fromUserId: first.userId,
          username: first.data.username,
          avatar: first.data.avatar,
          banner: first.data.banner,
          bannerPositionY: first.data.bannerPositionY,
          bannerZoom: first.data.bannerZoom,
          withVideo: !!first.data.withVideo,
          nameColor: first.data.nameColor,
          nameFont: first.data.nameFont,
          nameEffect: first.data.nameEffect,
          avatarEffect: first.data.avatarEffect,
          effectivePlan: first.data.effectivePlan,
          // A push-notified recipient's FIRST sight of the call is a re-ring
          // tick, so it must carry the ringer's stored mlsCallReady or the
          // recipient's initial key decision degrades to legacy-then-upgrade.
          // Key-blind relay.
          mlsCallReady: first.data.mlsCallReady === true,
        };
        for (const rc of toRing) {
          io.to(`user:${rc.userId}`).emit('incoming-dm-call', callPayload);
        }

        // Push notification for users with no connected sockets (simple always-push for disconnected users)
        if (pushEnabled) {
          for (const rc of toRing) {
            if (pushSentTo.has(rc.userId)) continue;
            try {
              const sockets = await getUserSocketIds(rc.userId);
              if (sockets.length === 0) {
                pushSentTo.add(rc.userId);
                sendPushToUser(rc.userId, {
                  title: `${callPayload.username} is calling you`,
                  body: callPayload.withVideo ? 'Incoming video call' : 'Incoming voice call',
                  tag: `call-${dmChannelId}`,
                  url: `/channels/@me/${dmChannelId}`,
                  data: { type: 'incoming-call', dmChannelId },
                }).catch(() => {});
              }
            } catch { /* best-effort push */ }
          }
        }
      } catch { /* ring delivery is best-effort */ }
    }, 5000);
    cappedTimerMapSet(dmCallRingTimers, dmChannelId, timer, MAX_TIMER_MAP_SIZE, clearInterval);
  }).catch(() => {});
}

export function stopDmCallRing(dmChannelId: string) {
  const existing = dmCallRingTimers.get(dmChannelId);
  if (existing) {
    clearInterval(existing);
    dmCallRingTimers.delete(dmChannelId);
  }
  clearDmCallDeclined(dmChannelId).catch(() => {});
}

// Re-export for direct use in socket handlers (replaces the removed checkSocketRate wrapper)
export { checkSocketRateLimit, OFFLINE_GRACE_MS };

// Viewer rate limit (60 subscribe/unsubscribe ops per minute per user)
// Generous but prevents flood if a client loops enableRemoteScreen.
// Uses the same checkSocketRateLimit mechanism with a dedicated window.
const VIEWER_RATE_LIMIT = 60;
const VIEWER_RATE_WINDOW_MS = 60_000;

export async function checkViewerRateLimit(userId: string): Promise<boolean> {
  return checkSocketRateLimit(`viewer:${userId}`, VIEWER_RATE_LIMIT, VIEWER_RATE_WINDOW_MS);
}
