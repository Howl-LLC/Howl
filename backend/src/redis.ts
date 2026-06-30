// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Redis client and helpers for shared state across multiple backend instances.
 *
 * When REDIS_URL is set, all state (voice participants, DM calls, presence sockets,
 * rate limiters, etc.) is stored in Redis so any backend instance can read/write it.
 *
 * When REDIS_URL is NOT set, falls back to plain in-memory Maps (single-instance mode).
 */

import Redis from 'ioredis';
import { logger } from './logger.js';
import { parseRedisUrl } from './utils/redisUrl.js';

const log = logger.child({ module: 'redis' });

// Redis client

const REDIS_URL = process.env.REDIS_URL || '';
export const redisEnabled = !!REDIS_URL;

export let pub: Redis | null = null;
export let sub: Redis | null = null;
export let redis: Redis | null = null;

/**
 * Test-only seam: swap the active Redis client so helpers that read the
 * module-level `redis` binding (e.g. isDmInitRateLimited/recordDmInit) can be
 * exercised against a fake client or the in-memory fallback. The ESM namespace
 * export is read-only, so tests cannot reassign `redisModule.redis` directly.
 */
export function __setRedisForTests(client: Redis | null): void {
  redis = client;
}

if (redisEnabled) {
  // Parse the URL ourselves and pass options directly to ioredis. This avoids
  // a startup crash if the password contains characters (`@`, `%`, `#`, `!`,
  // `$`) that Node's strict URL parser rejects — see utils/redisUrl.ts.
  const parsed = parseRedisUrl(REDIS_URL);
  const redisOpts = {
    ...parsed,
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    keyPrefix: 'howl:',
  };
  pub = new Redis(redisOpts);
  sub = new Redis({ ...redisOpts, keyPrefix: undefined }); // sub cannot use keyPrefix
  redis = pub;
  pub.on('error', (err) => log.error({ err }, 'pub connection error'));
  sub.on('error', (err) => log.error({ err }, 'sub connection error'));
  log.info({ host: parsed.host, port: parsed.port, tls: !!parsed.tls }, 'connected');
} else {
  log.info('REDIS_URL not set — using in-memory state (single-instance mode)');
}

// Generic helpers

type SignedVoiceJoinBlob = { v: 1; channelId: string; joinTimestamp: number; pub: string; sigPub: string };
// `joinedAt` is the server-authoritative arrival timestamp (Date.now() at the
// moment the server committed the Redis write). It gives us a monotonic join
// order that doesn't depend on Redis HGETALL iteration order, and is the
// fallback leader ordering when no participant carries a verifying join-blob.
// When signed blobs ARE present, both the clients and the server elect the
// leader by the signed `joinTimestamp` instead (services/voiceLeaderElection.ts
// mirrors services/voiceE2ee.ts#selectSignedLeader) so the two never disagree
// under clock skew.
// `signingPublicKey` is the DB-authoritative Ed25519 pub we propagate to
// peers so they can verify the join-blob signature against the true key on
// file — not the self-declared `blob.sigPub` the joiner embedded.
type VoiceParticipant = { username: string; nickname?: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string; joinBlob?: SignedVoiceJoinBlob; signature?: string; signingPublicKey?: string; joinedAt?: number; capabilities?: string[]; isScreenSharing?: boolean };
type DmCallParticipant = { username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; withVideo?: boolean; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; capabilities?: string[]; mlsCallReady?: boolean };
type VoiceOverride = { serverMuted: boolean; serverDeafened: boolean; byUserId: string };

/**
 * Returns the participant record with server-internal fields stripped:
 * - `capabilities` — used only on the server side for dialect negotiation
 *   (leader picks sframe.v1/vN based on receiver caps). Never broadcast.
 * - `joinedAt` — server-side ordering helper; clients derive leader from
 *   the signed join-blob, so they don't need the absolute timestamp.
 *
 * `signingPublicKey` is intentionally kept in the public payload: peers use
 * it as the trusted reference when verifying the signed join-blob.
 */
export function publicVoiceParticipant(p: VoiceParticipant & { userId: string }): Omit<VoiceParticipant, 'capabilities' | 'joinedAt'> & { userId: string } {
  const { capabilities: _caps, joinedAt: _joinedAt, ...rest } = p;
  return rest;
}

// In-memory fallback stores (used when Redis is disabled)

const MEM_MAX_ENTRIES = 50_000;

const mem = {
  userSockets: new Map<string, Set<string>>(),
  voiceParticipants: new Map<string, Map<string, VoiceParticipant>>(),
  dmCallParticipants: new Map<string, Map<string, DmCallParticipant>>(),
  dmCallDeclined: new Map<string, Set<string>>(),
  dmCallStartTimes: new Map<string, number>(),
  voiceOverrides: new Map<string, VoiceOverride>(),
  dmCallRateLimiter: new Map<string, number[]>(),
  dmInitTimestamps: new Map<string, number[]>(),
  kpConsumeTimestamps: new Map<string, number[]>(),
  kpConsumeCallerTimestamps: new Map<string, number[]>(), // per-(caller,target) sub-limit
  kpLowWaterSignaledAt: new Map<string, number>(),        // per-victim low-water signal debounce
  recentDmCallPresence: new Map<string, number>(),
  loginLockouts: new Map<string, { count: number; lockedUntil: number; createdAt: number }>(),
  verifyMappings: new Map<string, { realUserId: string; expiresAt: number }>(),
};

function memGuard(map: Map<unknown, unknown>): boolean {
  return map.size < MEM_MAX_ENTRIES;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of mem.dmCallRateLimiter) {
    const fresh = timestamps.filter((t) => t > now - 3600_000);
    if (fresh.length === 0) mem.dmCallRateLimiter.delete(key);
    else mem.dmCallRateLimiter.set(key, fresh);
  }
  for (const [key, timestamps] of mem.dmInitTimestamps) {
    const fresh = timestamps.filter((t) => t > now - DM_INIT_RATE_WINDOW_MS);
    if (fresh.length === 0) mem.dmInitTimestamps.delete(key);
    else mem.dmInitTimestamps.set(key, fresh);
  }
  for (const [key, timestamps] of mem.kpConsumeTimestamps) {
    const fresh = timestamps.filter((t) => t > now - KP_CONSUME_WINDOW_MS);
    if (fresh.length === 0) mem.kpConsumeTimestamps.delete(key);
    else mem.kpConsumeTimestamps.set(key, fresh);
  }
  for (const [key, timestamps] of mem.kpConsumeCallerTimestamps) {
    const fresh = timestamps.filter((t) => t > now - KP_CONSUME_WINDOW_MS);
    if (fresh.length === 0) mem.kpConsumeCallerTimestamps.delete(key);
    else mem.kpConsumeCallerTimestamps.set(key, fresh);
  }
  for (const [key, at] of mem.kpLowWaterSignaledAt) {
    if (at <= now - KP_LOW_WATER_SIGNAL_DEBOUNCE_MS) mem.kpLowWaterSignaledAt.delete(key);
  }
  for (const [key, entry] of mem.loginLockouts) {
    // Expire if: (a) lockout period has passed, or (b) entry is older than TTL (matches Redis EX behavior)
    if ((entry.lockedUntil > 0 && now > entry.lockedUntil) || (now - entry.createdAt > KEY_TTL_LOCKOUT * 1000)) {
      mem.loginLockouts.delete(key);
    }
  }
  for (const [key, entry] of mem.verifyMappings) {
    if (now > entry.expiresAt) mem.verifyMappings.delete(key);
  }
  for (const [key, expires] of mem.recentDmCallPresence) {
    if (now > expires) mem.recentDmCallPresence.delete(key);
  }
  for (const [channelId, participants] of mem.voiceParticipants) {
    if (participants.size === 0) mem.voiceParticipants.delete(channelId);
  }
  for (const [channelId, participants] of mem.dmCallParticipants) {
    if (participants.size === 0) {
      mem.dmCallParticipants.delete(channelId);
      mem.dmCallDeclined.delete(channelId);
      mem.dmCallStartTimes.delete(channelId);
    }
  }
  for (const [key] of mem.voiceOverrides) {
    const [channelId] = key.split(':');
    if (!mem.voiceParticipants.has(channelId!)) mem.voiceOverrides.delete(key);
  }
}, 60_000).unref();

// User Sockets

const KEY_TTL_SOCKETS = 86400;      // 24h safety net
const KEY_TTL_VOICE = 3600;         // 1 hour — conservative TTL; refreshed on voice-state-update and typing
const KEY_TTL_DMCALL = 14400;       // 4h
const KEY_TTL_REVERSE = 14400;      // 4h
const KEY_TTL_OVERRIDE = 3600;      // 1 hour

export async function addUserSocket(userId: string, socketId: string): Promise<boolean> {
  if (redis) {
    const sizeBefore = await redis.scard(`sockets:${userId}`);
    const pipe = redis.pipeline();
    pipe.sadd(`sockets:${userId}`, socketId);
    pipe.expire(`sockets:${userId}`, KEY_TTL_SOCKETS);
    await pipe.exec();
    return sizeBefore === 0;
  }
  if (!mem.userSockets.has(userId)) {
    if (!memGuard(mem.userSockets)) return false;
    mem.userSockets.set(userId, new Set());
  }
  const wasEmpty = mem.userSockets.get(userId)!.size === 0;
  mem.userSockets.get(userId)!.add(socketId);
  return wasEmpty;
}

export async function removeUserSocket(userId: string, socketId: string): Promise<void> {
  if (redis) {
    await redis.srem(`sockets:${userId}`, socketId);
    const remaining = await redis.scard(`sockets:${userId}`);
    if (remaining === 0) await redis.del(`sockets:${userId}`);
    return;
  }
  const s = mem.userSockets.get(userId);
  if (s) {
    s.delete(socketId);
    if (s.size === 0) mem.userSockets.delete(userId);
  }
}

export async function isUserConnected(userId: string): Promise<boolean> {
  if (redis) {
    const c = await redis.scard(`sockets:${userId}`);
    return c > 0;
  }
  const s = mem.userSockets.get(userId);
  return !!s && s.size > 0;
}

export async function getUserSocketIds(userId: string): Promise<string[]> {
  if (redis) return redis.smembers(`sockets:${userId}`);
  const s = mem.userSockets.get(userId);
  return s ? Array.from(s) : [];
}

// Voice Participants

export async function addVoiceParticipant(channelId: string, userId: string, data: VoiceParticipant): Promise<void> {
  if (redis) {
    const pipe = redis.pipeline();
    pipe.hset(`voice:${channelId}`, userId, JSON.stringify(data));
    pipe.expire(`voice:${channelId}`, KEY_TTL_VOICE);
    await pipe.exec();
    return;
  }
  if (!mem.voiceParticipants.has(channelId)) {
    if (!memGuard(mem.voiceParticipants)) return;
    mem.voiceParticipants.set(channelId, new Map());
  }
  mem.voiceParticipants.get(channelId)!.set(userId, data);
}

export async function refreshVoiceTTL(channelId: string): Promise<void> {
  if (redis) {
    await redis.expire(`voice:${channelId}`, KEY_TTL_VOICE);
  }
}

export async function removeVoiceParticipant(channelId: string, userId: string): Promise<void> {
  if (redis) {
    await redis.hdel(`voice:${channelId}`, userId);
    const remaining = await redis.hlen(`voice:${channelId}`);
    if (remaining === 0) await redis.del(`voice:${channelId}`);
    return;
  }
  const m = mem.voiceParticipants.get(channelId);
  if (m) {
    m.delete(userId);
    if (m.size === 0) mem.voiceParticipants.delete(channelId);
  }
}

// Sort by server-authoritative joinedAt ascending so `participants[0]` is
// the actual oldest participant rather than whoever Redis HGETALL happens
// to return first. Entries written before `joinedAt` was added (upgrade
// window) compare as 0 — effectively treated as "oldest", which is
// benign because legacy entries are already absent from active channels
// once the TTL expires.
function sortVoiceParticipantsByJoinedAt(
  participants: Array<{ userId: string } & VoiceParticipant>,
): Array<{ userId: string } & VoiceParticipant> {
  participants.sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0));
  return participants;
}

function parseVoiceHash(all: Record<string, string>): Array<{ userId: string } & VoiceParticipant> {
  return Object.entries(all).map(([userId, json]) => ({ userId, ...JSON.parse(json) }));
}

export async function getVoiceParticipants(channelId: string): Promise<Array<{ userId: string } & VoiceParticipant>> {
  if (redis) {
    const all = await redis.hgetall(`voice:${channelId}`);
    return sortVoiceParticipantsByJoinedAt(parseVoiceHash(all));
  }
  const m = mem.voiceParticipants.get(channelId);
  if (!m) return [];
  return sortVoiceParticipantsByJoinedAt(
    Array.from(m.entries()).map(([userId, data]) => ({ userId, ...data })),
  );
}

/**
 * Batched form of `getVoiceParticipants` — issues one Redis pipeline with N
 * HGETALLs in a single network round-trip. Used by `emitServersInitialState`
 * on socket connect, where a user in many servers can otherwise generate N×RTT
 * Redis latency on the bootstrap path.
 *
 * Returns a Map keyed by channelId. Channels with no participants map to `[]`.
 */
export async function getVoiceParticipantsBatch(
  channelIds: string[],
): Promise<Map<string, Array<{ userId: string } & VoiceParticipant>>> {
  const out = new Map<string, Array<{ userId: string } & VoiceParticipant>>();
  if (channelIds.length === 0) return out;

  if (redis) {
    const pipe = redis.pipeline();
    for (const id of channelIds) pipe.hgetall(`voice:${id}`);
    const results = await pipe.exec();
    // ioredis pipeline returns null only when the dispatch itself fails
    // (e.g. broken connection). Per-command errors surface as `[err, value]`
    // tuples; we treat that channel as empty rather than throwing — one bad
    // key shouldn't abort the entire bootstrap fanout.
    channelIds.forEach((id, i) => {
      const tuple = results?.[i];
      const all = (tuple && !tuple[0] ? tuple[1] : null) as Record<string, string> | null;
      out.set(id, all ? sortVoiceParticipantsByJoinedAt(parseVoiceHash(all)) : []);
    });
    return out;
  }

  for (const id of channelIds) {
    const m = mem.voiceParticipants.get(id);
    if (!m) { out.set(id, []); continue; }
    out.set(id, sortVoiceParticipantsByJoinedAt(
      Array.from(m.entries()).map(([userId, data]) => ({ userId, ...data })),
    ));
  }
  return out;
}

/**
 * Update just the `isScreenSharing` flag on an existing participant without
 * overwriting any of their other state. Used by the screenshare-state socket
 * event so clients in the same server can render a "watching available" icon
 * next to the user in the sidebar voice list.
 *
 * No-op if the user isn't currently in the voice channel (stale event).
 */
export async function setVoiceParticipantScreenSharing(channelId: string, userId: string, isScreenSharing: boolean): Promise<boolean> {
  if (redis) {
    const raw = await redis.hget(`voice:${channelId}`, userId);
    if (!raw) return false;
    const data: VoiceParticipant = JSON.parse(raw);
    data.isScreenSharing = isScreenSharing;
    await redis.hset(`voice:${channelId}`, userId, JSON.stringify(data));
    return true;
  }
  const m = mem.voiceParticipants.get(channelId);
  const entry = m?.get(userId);
  if (!entry) return false;
  entry.isScreenSharing = isScreenSharing;
  return true;
}

export async function getVoiceParticipantData(channelId: string, userId: string): Promise<VoiceParticipant | null> {
  if (redis) {
    const raw = await redis.hget(`voice:${channelId}`, userId);
    return raw ? JSON.parse(raw) : null;
  }
  return mem.voiceParticipants.get(channelId)?.get(userId) ?? null;
}

export async function isInVoiceChannel(channelId: string, userId: string): Promise<boolean> {
  if (redis) {
    const exists = await redis.hexists(`voice:${channelId}`, userId);
    return exists === 1;
  }
  return mem.voiceParticipants.get(channelId)?.has(userId) ?? false;
}

export async function voiceChannelSize(channelId: string): Promise<number> {
  if (redis) return redis.hlen(`voice:${channelId}`);
  return mem.voiceParticipants.get(channelId)?.size ?? 0;
}

export async function getVoiceChannelUserIds(channelId: string): Promise<string[]> {
  if (redis) return redis.hkeys(`voice:${channelId}`);
  const m = mem.voiceParticipants.get(channelId);
  return m ? Array.from(m.keys()) : [];
}

/** Find which voice channel a userId is in (scans all channels). Returns channelId or null. */
export async function findUserVoiceChannel(userId: string): Promise<string | null> {
  if (redis) {
    // We store a reverse-lookup key for efficiency
    const ch = await redis.get(`voice-rev:${userId}`);
    return ch || null;
  }
  for (const [channelId, m] of mem.voiceParticipants.entries()) {
    if (m.has(userId)) return channelId;
  }
  return null;
}

export async function setVoiceReverseLookup(userId: string, channelId: string | null): Promise<void> {
  if (!redis) return; // in-memory mode iterates the map
  if (channelId) {
    await redis.set(`voice-rev:${userId}`, channelId, 'EX', KEY_TTL_REVERSE);
  } else {
    await redis.del(`voice-rev:${userId}`);
  }
}

// DM Call Participants

export async function addDmCallParticipant(dmChannelId: string, userId: string, data: DmCallParticipant): Promise<void> {
  if (redis) {
    const pipe = redis.pipeline();
    pipe.hset(`dmcall:${dmChannelId}`, userId, JSON.stringify(data));
    pipe.expire(`dmcall:${dmChannelId}`, KEY_TTL_DMCALL);
    await pipe.exec();
    return;
  }
  if (!mem.dmCallParticipants.has(dmChannelId)) {
    if (!memGuard(mem.dmCallParticipants)) return;
    mem.dmCallParticipants.set(dmChannelId, new Map());
  }
  mem.dmCallParticipants.get(dmChannelId)!.set(userId, data);
}

export async function refreshDmCallTTL(dmChannelId: string): Promise<void> {
  if (redis) {
    await redis.expire(`dmcall:${dmChannelId}`, KEY_TTL_DMCALL);
  }
}

export async function removeDmCallParticipant(dmChannelId: string, userId: string): Promise<void> {
  if (redis) {
    await redis.hdel(`dmcall:${dmChannelId}`, userId);
    const remaining = await redis.hlen(`dmcall:${dmChannelId}`);
    if (remaining === 0) await redis.del(`dmcall:${dmChannelId}`);
    return;
  }
  const m = mem.dmCallParticipants.get(dmChannelId);
  if (m) {
    m.delete(userId);
    if (m.size === 0) mem.dmCallParticipants.delete(dmChannelId);
  }
}

export async function getDmCallParticipants(dmChannelId: string): Promise<Array<{ userId: string } & DmCallParticipant>> {
  if (redis) {
    const all = await redis.hgetall(`dmcall:${dmChannelId}`);
    return Object.entries(all).map(([userId, json]) => ({ userId, ...JSON.parse(json) }));
  }
  const m = mem.dmCallParticipants.get(dmChannelId);
  if (!m) return [];
  return Array.from(m.entries()).map(([uid, data]) => ({ userId: uid, ...data }));
}

export async function dmCallSize(dmChannelId: string): Promise<number> {
  if (redis) return redis.hlen(`dmcall:${dmChannelId}`);
  return mem.dmCallParticipants.get(dmChannelId)?.size ?? 0;
}

export async function isInDmCall(dmChannelId: string, userId: string): Promise<boolean> {
  if (redis) return (await redis.hexists(`dmcall:${dmChannelId}`, userId)) === 1;
  return mem.dmCallParticipants.get(dmChannelId)?.has(userId) ?? false;
}

export async function getDmCallFirstCaller(dmChannelId: string): Promise<{ userId: string; data: DmCallParticipant } | null> {
  if (redis) {
    const all = await redis.hgetall(`dmcall:${dmChannelId}`);
    const entries = Object.entries(all);
    if (entries.length === 0) return null;
    const [userId, json] = entries[0];
    return { userId, data: JSON.parse(json) };
  }
  const m = mem.dmCallParticipants.get(dmChannelId);
  if (!m || m.size === 0) return null;
  const [userId, data] = m.entries().next().value!;
  return { userId, data };
}

/** Find which DM call a user is in. Returns dmChannelId or null. */
export async function findUserDmCall(userId: string): Promise<string | null> {
  if (redis) {
    const ch = await redis.get(`dmcall-rev:${userId}`);
    return ch || null;
  }
  for (const [dmChannelId, m] of mem.dmCallParticipants.entries()) {
    if (m.has(userId)) return dmChannelId;
  }
  return null;
}

export async function setDmCallReverseLookup(userId: string, dmChannelId: string | null): Promise<void> {
  if (!redis) return;
  if (dmChannelId) {
    await redis.set(`dmcall-rev:${userId}`, dmChannelId, 'EX', KEY_TTL_REVERSE);
  } else {
    await redis.del(`dmcall-rev:${userId}`);
  }
}

// DM Call Declined Users

export async function addDmCallDeclined(dmChannelId: string, userId: string): Promise<void> {
  if (redis) {
    const pipe = redis.pipeline();
    pipe.sadd(`dmcall:declined:${dmChannelId}`, userId);
    pipe.expire(`dmcall:declined:${dmChannelId}`, KEY_TTL_DMCALL);
    await pipe.exec();
    return;
  }
  if (!mem.dmCallDeclined.has(dmChannelId)) {
    if (!memGuard(mem.dmCallDeclined)) return;
    mem.dmCallDeclined.set(dmChannelId, new Set());
  }
  mem.dmCallDeclined.get(dmChannelId)!.add(userId);
}

export async function isDmCallDeclined(dmChannelId: string, userId: string): Promise<boolean> {
  if (redis) return (await redis.sismember(`dmcall:declined:${dmChannelId}`, userId)) === 1;
  return mem.dmCallDeclined.get(dmChannelId)?.has(userId) ?? false;
}

export async function clearDmCallDeclined(dmChannelId: string): Promise<void> {
  if (redis) { await redis.del(`dmcall:declined:${dmChannelId}`); return; }
  mem.dmCallDeclined.delete(dmChannelId);
}

// DM Call Recent Presence (rate-limit rejoin bypass)
//
// When a user leaves a DM call (explicit leave, disconnect, or refresh), we
// stamp a short-TTL marker so an immediate rejoin to the same DM's call
// bypasses the isDmCallRateLimited anti-spam check. Without this, a user who
// hard-refreshes the page gets throttled after just a few rejoin cycles,
// because once the backend cleans them up the call may be empty (`isNewCall`)
// and counted against the 3-per-30s cap intended for fresh outbound calls.
//
// Scoped per (user, channel): bypassing rate limits for THIS specific DM call
// they were just in does not weaken spam protection for new targets.

const RECENT_DM_CALL_TTL_SEC = 60;

export async function markRecentDmCallPresence(dmChannelId: string, userId: string): Promise<void> {
  if (redis) {
    await redis.set(`dmcall:recent:${userId}:${dmChannelId}`, '1', 'EX', RECENT_DM_CALL_TTL_SEC);
    return;
  }
  const key = `${userId}:${dmChannelId}`;
  if (!mem.recentDmCallPresence.has(key) && !memGuard(mem.recentDmCallPresence)) return;
  mem.recentDmCallPresence.set(key, Date.now() + RECENT_DM_CALL_TTL_SEC * 1000);
}

export async function wasRecentlyInDmCall(dmChannelId: string, userId: string): Promise<boolean> {
  if (redis) {
    return (await redis.exists(`dmcall:recent:${userId}:${dmChannelId}`)) === 1;
  }
  const key = `${userId}:${dmChannelId}`;
  const expires = mem.recentDmCallPresence.get(key);
  if (!expires) return false;
  if (Date.now() > expires) { mem.recentDmCallPresence.delete(key); return false; }
  return true;
}

// DM Call Start Times

export async function setDmCallStartTime(dmChannelId: string, timestamp: number): Promise<void> {
  if (redis) { await redis.set(`dmcall:start:${dmChannelId}`, String(timestamp), 'EX', KEY_TTL_DMCALL); return; }
  if (!memGuard(mem.dmCallStartTimes)) return;
  mem.dmCallStartTimes.set(dmChannelId, timestamp);
}

export async function getDmCallStartTime(dmChannelId: string): Promise<number | null> {
  if (redis) {
    const v = await redis.get(`dmcall:start:${dmChannelId}`);
    return v ? Number(v) : null;
  }
  return mem.dmCallStartTimes.get(dmChannelId) ?? null;
}

export async function deleteDmCallStartTime(dmChannelId: string): Promise<void> {
  if (redis) { await redis.del(`dmcall:start:${dmChannelId}`); return; }
  mem.dmCallStartTimes.delete(dmChannelId);
}

// Voice Server Overrides

export async function getVoiceOverride(channelId: string, userId: string): Promise<VoiceOverride | null> {
  const key = `${channelId}:${userId}`;
  if (redis) {
    const raw = await redis.get(`voice:override:${key}`);
    return raw ? JSON.parse(raw) : null;
  }
  return mem.voiceOverrides.get(key) ?? null;
}

export async function setVoiceOverride(channelId: string, userId: string, data: VoiceOverride): Promise<void> {
  const key = `${channelId}:${userId}`;
  if (redis) { await redis.set(`voice:override:${key}`, JSON.stringify(data), 'EX', KEY_TTL_OVERRIDE); return; }
  if (!memGuard(mem.voiceOverrides)) return;
  mem.voiceOverrides.set(key, data);
}

export async function deleteVoiceOverride(channelId: string, userId: string): Promise<void> {
  const key = `${channelId}:${userId}`;
  if (redis) { await redis.del(`voice:override:${key}`); return; }
  mem.voiceOverrides.delete(key);
}

// Login Lockout (per-account brute-force protection)

const KEY_TTL_LOCKOUT = 1800; // 30 minutes

export async function getLoginLockout(key: string): Promise<{ count: number; lockedUntil: number } | null> {
  if (redis) {
    const raw = await redis.get(`lockout:${key}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  return mem.loginLockouts.get(key) ?? null;
}

export async function setLoginLockout(key: string, data: { count: number; lockedUntil: number }): Promise<void> {
  if (redis) {
    await redis.set(`lockout:${key}`, JSON.stringify(data), 'EX', KEY_TTL_LOCKOUT);
    return;
  }
  if (!memGuard(mem.loginLockouts)) return;
  mem.loginLockouts.set(key, { ...data, createdAt: Date.now() });
}

export async function deleteLoginLockout(key: string): Promise<void> {
  if (redis) { await redis.del(`lockout:${key}`); return; }
  mem.loginLockouts.delete(key);
}

// Verification-Pending UUID Mapping
// Maps opaque UUIDs (sent to client) → real userIds (never sent to client)
const VERIFY_MAP_TTL_S = 1800; // 30 minutes (longer than 15-min code expiry)

export async function setVerifyMapping(opaqueId: string, realUserId: string): Promise<void> {
  if (redis) {
    await redis.set(`verify-map:${opaqueId}`, realUserId, 'EX', VERIFY_MAP_TTL_S);
    return;
  }
  if (!memGuard(mem.verifyMappings)) return;
  mem.verifyMappings.set(opaqueId, { realUserId, expiresAt: Date.now() + VERIFY_MAP_TTL_S * 1000 });
}

export async function getVerifyMapping(opaqueId: string): Promise<string | null> {
  if (redis) {
    return await redis.get(`verify-map:${opaqueId}`);
  }
  const entry = mem.verifyMappings.get(opaqueId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { mem.verifyMappings.delete(opaqueId); return null; }
  return entry.realUserId;
}

export async function deleteVerifyMapping(opaqueId: string): Promise<void> {
  if (redis) { await redis.del(`verify-map:${opaqueId}`); return; }
  mem.verifyMappings.delete(opaqueId);
}

// DM Call Rate Limiter

const DM_CALL_RATE_MAX = 3;
const DM_CALL_RATE_WINDOW_MS = 30_000;

export async function isDmCallRateLimited(userId: string): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - DM_CALL_RATE_WINDOW_MS;

  if (redis) {
    const key = `ratelimit:dmcall:${userId}`;
    const ttlSec = Math.ceil(DM_CALL_RATE_WINDOW_MS / 1000);
    const count = await redis.eval(
      `redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
       local c = redis.call('zcard', KEYS[1])
       if c >= tonumber(ARGV[2]) then return c end
       redis.call('zadd', KEYS[1], ARGV[3], ARGV[3] .. '-' .. tostring(math.random(1000000)))
       redis.call('expire', KEYS[1], ARGV[4])
       return c`,
      1, key, String(windowStart), String(DM_CALL_RATE_MAX), String(now), String(ttlSec),
    ) as number;
    return count >= DM_CALL_RATE_MAX;
  }

  const timestamps = (mem.dmCallRateLimiter.get(userId) ?? []).filter((t) => t > windowStart);
  if (timestamps.length >= DM_CALL_RATE_MAX) {
    mem.dmCallRateLimiter.set(userId, timestamps);
    return true;
  }
  if (!mem.dmCallRateLimiter.has(userId) && !memGuard(mem.dmCallRateLimiter)) return true;
  timestamps.push(now);
  mem.dmCallRateLimiter.set(userId, timestamps);
  return false;
}

// DM Init Rate Limiter
//
// Per-sender cap on new DM channel creations: 15 / hour. Backed by a Redis
// sorted-set sliding window so the cap is shared across all backend replicas.
// Without Redis, a multi-replica deploy lets a single user create
// `15 × N` DMs/hour by spreading requests across replicas. Mirrors
// `isDmCallRateLimited` (ZREMRANGEBYSCORE + ZCARD /
// ZADD pattern) but split into a read-only check (`isDmInitRateLimited`,
// called inside `canUserDm`) and a writer (`recordDmInit`, called from the
// DM-create endpoints after a new channel actually persists).
//
// In-memory fallback runs only when REDIS_URL is unset (single-instance dev);
// in production `redis` is non-null and the Redis path is the only path.

const DM_INIT_RATE_MAX = 15;
const DM_INIT_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DM_INIT_KEY_TTL_SEC = Math.ceil(DM_INIT_RATE_WINDOW_MS / 1000);

export async function isDmInitRateLimited(userId: string): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - DM_INIT_RATE_WINDOW_MS;

  if (redis) {
    const key = `dm-init:${userId}`;
    const count = await redis.eval(
      `redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
       return redis.call('zcard', KEYS[1])`,
      1, key, String(windowStart),
    ) as number;
    return count >= DM_INIT_RATE_MAX;
  }

  const fresh = (mem.dmInitTimestamps.get(userId) ?? []).filter((t) => t > windowStart);
  if (fresh.length === 0) {
    mem.dmInitTimestamps.delete(userId);
  } else {
    mem.dmInitTimestamps.set(userId, fresh);
  }
  return fresh.length >= DM_INIT_RATE_MAX;
}

export async function recordDmInit(userId: string): Promise<void> {
  const now = Date.now();
  const windowStart = now - DM_INIT_RATE_WINDOW_MS;

  if (redis) {
    const key = `dm-init:${userId}`;
    await redis.eval(
      `redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
       redis.call('zadd', KEYS[1], ARGV[2], ARGV[2] .. '-' .. tostring(math.random(1000000)))
       redis.call('expire', KEYS[1], ARGV[3])
       return 1`,
      1, key, String(windowStart), String(now), String(DM_INIT_KEY_TTL_SEC),
    );
    return;
  }

  // In-memory fallback: bounded LRU. If we'd exceed the cap, evict the oldest
  // user entry — same shape as cappedMapSet but specialised so we can keep
  // mutating the existing array without cloning.
  const existing = mem.dmInitTimestamps.get(userId);
  if (!existing) {
    if (mem.dmInitTimestamps.size >= MEM_MAX_ENTRIES) {
      const oldestKey = mem.dmInitTimestamps.keys().next().value;
      if (oldestKey !== undefined) mem.dmInitTimestamps.delete(oldestKey);
    }
    mem.dmInitTimestamps.set(userId, [now]);
    return;
  }
  const fresh = existing.filter((t) => t > windowStart);
  fresh.push(now);
  mem.dmInitTimestamps.set(userId, fresh);
}

// KeyPackage consume bounds (pool-drain forward-secrecy DoS). TWO sliding
// windows, BOTH counted per single-use PACKAGE actually consumed (a consume
// request drains one single-use package per target device, up to the take:50
// device ceiling), mirroring the `isDmInitRateLimited`/`recordDmInit` split
// read-only-check + writer over the ZREMRANGEBYSCORE + ZCARD / ZADD window.
// Per-package counting makes each counter reflect TRUE pool drain.
//
//   (1) per-(CALLER,TARGET) — `kp-consume-c:${callerId}:${targetUserId}`, cap
//       KP_CONSUME_CALLER_MAX. Bounds ONE caller's drain of a victim.
//   (2) per-TARGET aggregate — `kp-consume:${targetUserId}`, cap KP_CONSUME_RATE_MAX.
//       Bounds TOTAL drain across all (colluding) callers.
//
// A single legitimate add never false-positives: the caps are checked BEFORE the
// atomic, all-devices consume, so the first add always passes regardless of the
// victim's device count. Monopoly invariant (must hold for ANY device count): a
// single caller's worst-case contribution to the shared aggregate is
// ~KP_CONSUME_CALLER_MAX + (take:50 − 1) packages (sit just under the cap, then
// land one 50-device add); RATE_MAX = 12× CALLER_MAX keeps that well under the
// aggregate, so no single account can saturate it and 429 every legitimate
// group-adder (the original target-only-keyed defect). Both caps are
// tunable policy. CALLER_MAX ≥ take:50 fits one full multi-device add plus ample
// headroom for client group-create retries; the per-target ≈600 budget keeps the
// per-distinct-adder allowance (≈600/device_count) far above realistic concurrent
// adders even for an unusually multi-device victim.
export const KP_CONSUME_RATE_MAX = 600;       // per-target aggregate, single-use PACKAGES / hour
export const KP_CONSUME_CALLER_MAX = 50;      // per-(caller,target), single-use PACKAGES / hour
const KP_CONSUME_WINDOW_MS = 60 * 60 * 1000;  // 1 hour (both windows)
const KP_CONSUME_KEY_TTL_SEC = Math.ceil(KP_CONSUME_WINDOW_MS / 1000);

// Debounce the per-victim low-water / last-resort-in-use signal so a
// consume-route flood cannot notification-bomb the victim.
export const KP_LOW_WATER_SIGNAL_DEBOUNCE_MS = 5 * 60 * 1000; // at most one signal / 5 min / victim
const KP_LOW_WATER_SIGNAL_TTL_SEC = Math.ceil(KP_LOW_WATER_SIGNAL_DEBOUNCE_MS / 1000);

export async function isKpConsumeRateLimited(targetUserId: string): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - KP_CONSUME_WINDOW_MS;

  if (redis) {
    const key = `kp-consume:${targetUserId}`;
    const count = await redis.eval(
      `redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
       return redis.call('zcard', KEYS[1])`,
      1, key, String(windowStart),
    ) as number;
    return count >= KP_CONSUME_RATE_MAX;
  }

  const fresh = (mem.kpConsumeTimestamps.get(targetUserId) ?? []).filter((t) => t > windowStart);
  if (fresh.length === 0) {
    mem.kpConsumeTimestamps.delete(targetUserId);
  } else {
    mem.kpConsumeTimestamps.set(targetUserId, fresh);
  }
  return fresh.length >= KP_CONSUME_RATE_MAX;
}

export async function recordKpConsume(targetUserId: string, count = 1): Promise<void> {
  if (count <= 0) return; // a last-resort-only request drains no single-use pool
  const now = Date.now();
  const windowStart = now - KP_CONSUME_WINDOW_MS;

  if (redis) {
    const key = `kp-consume:${targetUserId}`;
    // One ZSET member per single-use package consumed so the counter reflects
    // true pool drain, not request count. Members stay unique via the loop index.
    await redis.eval(
      `redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
       for i=1,tonumber(ARGV[4]) do
         redis.call('zadd', KEYS[1], ARGV[2], ARGV[2] .. '-' .. i .. '-' .. tostring(math.random(1000000)))
       end
       redis.call('expire', KEYS[1], ARGV[3])
       return 1`,
      1, key, String(windowStart), String(now), String(KP_CONSUME_KEY_TTL_SEC), String(count),
    );
    return;
  }

  // In-memory fallback: bounded LRU. If we'd exceed the cap, evict the oldest
  // target entry — same shape as recordDmInit.
  const existing = mem.kpConsumeTimestamps.get(targetUserId);
  if (!existing) {
    if (mem.kpConsumeTimestamps.size >= MEM_MAX_ENTRIES) {
      const oldestKey = mem.kpConsumeTimestamps.keys().next().value;
      if (oldestKey !== undefined) mem.kpConsumeTimestamps.delete(oldestKey);
    }
    mem.kpConsumeTimestamps.set(targetUserId, Array(count).fill(now));
    return;
  }
  const fresh = existing.filter((t) => t > windowStart);
  for (let i = 0; i < count; i++) fresh.push(now);
  mem.kpConsumeTimestamps.set(targetUserId, fresh);
}

// Per-(caller,target) request sub-limit. Keyed by the requesting caller AND the
// victim so one abuser cannot spend the shared per-target budget;
// request-counted (not per-package) so a single legit multi-device add never
// trips it. KP_CONSUME_CALLER_MAX ≪ KP_CONSUME_RATE_MAX (see the block above).
export async function isKpConsumeCallerLimited(callerId: string, targetUserId: string): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - KP_CONSUME_WINDOW_MS;
  const memKey = `${callerId}:${targetUserId}`;

  if (redis) {
    const key = `kp-consume-c:${memKey}`;
    const count = await redis.eval(
      `redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
       return redis.call('zcard', KEYS[1])`,
      1, key, String(windowStart),
    ) as number;
    return count >= KP_CONSUME_CALLER_MAX;
  }

  const fresh = (mem.kpConsumeCallerTimestamps.get(memKey) ?? []).filter((t) => t > windowStart);
  if (fresh.length === 0) {
    mem.kpConsumeCallerTimestamps.delete(memKey);
  } else {
    mem.kpConsumeCallerTimestamps.set(memKey, fresh);
  }
  return fresh.length >= KP_CONSUME_CALLER_MAX;
}

export async function recordKpConsumeCaller(callerId: string, targetUserId: string, count = 1): Promise<void> {
  if (count <= 0) return;
  const now = Date.now();
  const windowStart = now - KP_CONSUME_WINDOW_MS;
  const memKey = `${callerId}:${targetUserId}`;

  if (redis) {
    const key = `kp-consume-c:${memKey}`;
    // One ZSET member per single-use package consumed, so a caller's budget
    // reflects true drain and stays dimensionally comparable to the per-target
    // aggregate (the monopoly invariant). Members unique via index.
    await redis.eval(
      `redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
       for i=1,tonumber(ARGV[4]) do
         redis.call('zadd', KEYS[1], ARGV[2], ARGV[2] .. '-' .. i .. '-' .. tostring(math.random(1000000)))
       end
       redis.call('expire', KEYS[1], ARGV[3])
       return 1`,
      1, key, String(windowStart), String(now), String(KP_CONSUME_KEY_TTL_SEC), String(count),
    );
    return;
  }

  const existing = mem.kpConsumeCallerTimestamps.get(memKey);
  if (!existing) {
    if (mem.kpConsumeCallerTimestamps.size >= MEM_MAX_ENTRIES) {
      const oldestKey = mem.kpConsumeCallerTimestamps.keys().next().value;
      if (oldestKey !== undefined) mem.kpConsumeCallerTimestamps.delete(oldestKey);
    }
    mem.kpConsumeCallerTimestamps.set(memKey, Array(count).fill(now));
    return;
  }
  const fresh = existing.filter((t) => t > windowStart);
  for (let i = 0; i < count; i++) fresh.push(now);
  mem.kpConsumeCallerTimestamps.set(memKey, fresh);
}

/**
 * Returns true at most once per KP_LOW_WATER_SIGNAL_DEBOUNCE_MS per
 * victim (atomic SET NX EX in Redis; LRU map in-memory). Gate the per-victim
 * low-water / last-resort-in-use socket emit on this so a consume-route flood
 * cannot notification-bomb the victim.
 */
export async function shouldSignalKpLowWater(targetUserId: string): Promise<boolean> {
  if (redis) {
    const key = `kp-lowwater:${targetUserId}`;
    const set = await redis.set(key, '1', 'EX', KP_LOW_WATER_SIGNAL_TTL_SEC, 'NX');
    return set === 'OK';
  }

  const now = Date.now();
  const last = mem.kpLowWaterSignaledAt.get(targetUserId);
  if (last !== undefined && now - last < KP_LOW_WATER_SIGNAL_DEBOUNCE_MS) return false;
  if (!mem.kpLowWaterSignaledAt.has(targetUserId) && mem.kpLowWaterSignaledAt.size >= MEM_MAX_ENTRIES) {
    const oldestKey = mem.kpLowWaterSignaledAt.keys().next().value;
    if (oldestKey !== undefined) mem.kpLowWaterSignaledAt.delete(oldestKey);
  }
  mem.kpLowWaterSignaledAt.set(targetUserId, now);
  return true;
}

// Socket Event Rate Limiting

const SOCKET_RATE_LIMIT_DEFAULT = 30;
const SOCKET_RATE_WINDOW_MS_DEFAULT = 10_000;

const memSocketRates = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memSocketRates) {
    if (now > entry.resetAt) memSocketRates.delete(key);
  }
}, 60_000).unref();

function checkSocketRateLimitMem(userId: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = memSocketRates.get(userId);
  if (!entry || now > entry.resetAt) {
    if (!memSocketRates.has(userId) && memSocketRates.size >= MEM_MAX_ENTRIES) {
      const oldest = memSocketRates.keys().next().value;
      if (oldest !== undefined) memSocketRates.delete(oldest);
    }
    memSocketRates.set(userId, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count++;
  return entry.count <= limit;
}

export async function checkSocketRateLimit(
  userId: string,
  limit = SOCKET_RATE_LIMIT_DEFAULT,
  windowMs = SOCKET_RATE_WINDOW_MS_DEFAULT,
): Promise<boolean> {
  if (redis) {
    try {
      const key = `sockrate:${userId}`;
      const count = await redis.eval(
        `local c = redis.call('incr', KEYS[1]) if c == 1 then redis.call('pexpire', KEYS[1], ARGV[1]) end return c`,
        1, key, windowMs,
      );
      if (typeof count !== 'number') {
        // Non-numeric reply (e.g. Lua returned a string/array/null). Treat as a
        // Redis fault and fall back to per-process accounting rather than
        // fail-open.
        log.warn({ userId, replyType: typeof count }, 'socket rate limit: non-numeric reply, falling back to memory');
        return checkSocketRateLimitMem(userId, limit, windowMs);
      }
      return count <= limit;
    } catch (err) {
      // Redis script execution failed (connection reset, Lua error, timeout).
      // Previously this returned `true` unconditionally, silently disabling the
      // limiter for every request until Redis recovered. Fall back to the
      // per-process map instead so a single replica can still throttle abusive
      // peers — bounded by (configured-limit × N_replicas) instead of unlimited.
      log.warn({ err, userId }, 'socket rate limit: Redis call failed, falling back to memory');
      return checkSocketRateLimitMem(userId, limit, windowMs);
    }
  }
  return checkSocketRateLimitMem(userId, limit, windowMs);
}

export function clearSocketRateLimit(userId: string): void {
  if (redis) {
    redis.del(`sockrate:${userId}`).catch(() => {});
  }
  memSocketRates.delete(userId);
}

// Session Invalidation Pub/Sub

const SESSION_INVALIDATION_CHANNEL = 'howl:session-invalidation';
type SessionInvalidationHandler = (tokenHash: string) => void;
const sessionInvalidationHandlers: SessionInvalidationHandler[] = [];

export function onSessionInvalidation(handler: SessionInvalidationHandler): void {
  sessionInvalidationHandlers.push(handler);
}

export function publishSessionInvalidation(tokenHash: string): void {
  if (redis) {
    redis.publish(SESSION_INVALIDATION_CHANNEL, tokenHash).catch(() => {});
  } else {
    for (const h of sessionInvalidationHandlers) h(tokenHash);
  }
}

// Automod Cache Invalidation Pub/Sub

const AUTOMOD_INVALIDATION_CHANNEL = 'howl:automod-invalidate';
type AutomodInvalidationHandler = (serverId: string) => void;
const automodInvalidationHandlers: AutomodInvalidationHandler[] = [];

export function onAutomodInvalidation(handler: AutomodInvalidationHandler): void {
  automodInvalidationHandlers.push(handler);
}

// Flagged Hash Invalidation Pub/Sub

const FLAGGED_HASH_CHANNEL = 'howl:flagged-hash-update';
type FlaggedHashInvalidationHandler = () => void;
const flaggedHashInvalidationHandlers: FlaggedHashInvalidationHandler[] = [];

export function onFlaggedHashInvalidation(handler: FlaggedHashInvalidationHandler): void {
  flaggedHashInvalidationHandlers.push(handler);
}

export function publishFlaggedHashUpdate(): void {
  if (redis) {
    redis.publish(FLAGGED_HASH_CHANNEL, '1').catch(() => {});
  } else {
    for (const h of flaggedHashInvalidationHandlers) h();
  }
}

// Permission Context Cache + Invalidation Pub/Sub
//
// loadPermissionContext is called on virtually every authenticated server
// request (~109 sites). Each call issues 2 Prisma queries. Caching the result
// in Redis with explicit pubsub-driven invalidation eliminates the hot-path
// Prisma round-trip on cache hit while keeping cross-replica consistency on
// every mutation.
//
// TTL of 5 min is a backstop — pubsub invalidation is the authoritative
// consistency mechanism. The TTL bounds staleness for time-sensitive fields
// (rawMember.timeoutUntil) and any mutation site we forgot to wire up.
// Over-invalidation is safe; under-invalidation is a privilege-escalation
// bug.
//
// Payload format on the channel: `serverId|userId` for single-member
// invalidation, or `serverId|*` for server-wide (role/perm change).

const PERMS_TTL = 300; // seconds — 5 min backstop; pubsub is authoritative
const PERMS_CACHE_PREFIX = 'perms:v1:';
const PERMS_INVALIDATION_CHANNEL = 'howl:perms-invalidate';

function permsKey(serverId: string, userId: string): string {
  return `${PERMS_CACHE_PREFIX}${serverId}:${userId}`;
}

export async function getCachedPermissionContext(
  serverId: string,
  userId: string,
): Promise<unknown | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(permsKey(serverId, userId));
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function setCachedPermissionContext(
  serverId: string,
  userId: string,
  ctx: unknown,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.setex(permsKey(serverId, userId), PERMS_TTL, JSON.stringify(ctx));
  } catch {
    /* best-effort cache write */
  }
}

/**
 * Invalidate the cached permission context for (serverId, userId) across all
 * replicas. Local DEL + pubsub fan-out so peer replicas evict any value they
 * may have read between this DEL and the pubsub delivery.
 */
export async function invalidatePermissionContext(
  serverId: string,
  userId: string,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(permsKey(serverId, userId));
    await redis.publish(PERMS_INVALIDATION_CHANNEL, `${serverId}|${userId}`);
  } catch (err) {
    log.warn({ err, serverId, userId }, 'failed to invalidate permission context');
  }
}

/**
 * Invalidate every cached permission context for this server. Use after
 * role/permission mutations that affect all members of a role (role create
 * with new perms, role permission/position update, role delete, @everyone
 * permission change).
 */
export async function invalidatePermissionContextForServer(serverId: string): Promise<void> {
  if (!redis) return;
  try {
    await scanAndDeletePermsForServer(serverId);
    await redis.publish(PERMS_INVALIDATION_CHANNEL, `${serverId}|*`);
  } catch (err) {
    log.warn({ err, serverId }, 'failed to invalidate permission context for server');
  }
}

async function scanAndDeletePermsForServer(serverId: string): Promise<void> {
  if (!redis) return;
  // ioredis auto-prepends keyPrefix `howl:` to SCAN MATCH and DEL args.
  // scanStream uses the prefix transparently; we DEL the returned keys with
  // the prefix stripped so ioredis doesn't double-prefix.
  const pattern = `${PERMS_CACHE_PREFIX}${serverId}:*`;
  const stream = redis.scanStream({ match: pattern, count: 200 });
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (keys: string[]) => {
      if (keys.length === 0) return;
      const stripped = keys.map((k) => (k.startsWith('howl:') ? k.slice(5) : k));
      redis!.del(...stripped).catch(() => {});
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
}

if (sub) {
  sub.subscribe(SESSION_INVALIDATION_CHANNEL).catch((err) =>
    log.error({ err }, 'failed to subscribe to session invalidation channel'),
  );
  sub.subscribe(AUTOMOD_INVALIDATION_CHANNEL).catch((err) =>
    log.error({ err }, 'failed to subscribe to automod invalidation channel'),
  );
  sub.subscribe(FLAGGED_HASH_CHANNEL).catch((err) =>
    log.error({ err }, 'failed to subscribe to flagged hash invalidation channel'),
  );
  sub.subscribe(PERMS_INVALIDATION_CHANNEL).catch((err) =>
    log.error({ err }, 'failed to subscribe to perms invalidation channel'),
  );
  sub.on('message', (channel: string, message: string) => {
    if (channel === SESSION_INVALIDATION_CHANNEL) {
      for (const h of sessionInvalidationHandlers) h(message);
    }
    if (channel === AUTOMOD_INVALIDATION_CHANNEL) {
      for (const h of automodInvalidationHandlers) h(message);
    }
    if (channel === FLAGGED_HASH_CHANNEL) {
      for (const h of flaggedHashInvalidationHandlers) h();
    }
    if (channel === PERMS_INVALIDATION_CHANNEL) {
      const sep = message.indexOf('|');
      if (sep < 0 || !redis) return;
      const serverId = message.slice(0, sep);
      const target = message.slice(sep + 1);
      if (target === '*') {
        scanAndDeletePermsForServer(serverId).catch(() => {});
      } else {
        redis.del(permsKey(serverId, target)).catch(() => {});
      }
    }
  });
}

// User Socket Count (Redis-backed for multi-instance)

export async function getUserSocketCount(userId: string): Promise<number> {
  if (redis) {
    return redis.scard(`sockets:${userId}`);
  }
  const s = mem.userSockets.get(userId);
  return s ? s.size : 0;
}

// Offline Grace (Redis-backed key for distributed coordination)

const OFFLINE_GRACE_TTL = 10;

export async function setOfflineGrace(userId: string): Promise<boolean> {
  if (redis) {
    const result = await redis.set(`offline-grace:${userId}`, '1', 'EX', OFFLINE_GRACE_TTL, 'NX');
    return result === 'OK';
  }
  return true;
}

export async function clearOfflineGrace(userId: string): Promise<void> {
  if (redis) {
    await redis.del(`offline-grace:${userId}`);
  }
}

// Status Reconcile Lock (connect-storm dedup)
//
// On connect, the handler reconciles the user's DB `status` row (e.g. flips
// `offline` → `online`). When a user's tab cluster reconnects in a burst
// (Electron sleep/wake, network blip), each socket runs the reconcile
// independently and we get N redundant `user.update` writes within seconds.
//
// This SETNX gate lets only the first connect within a 60s window touch the
// DB. Skipped reconciles still get correct presence via Redis (addUserSocket
// updates the socket-set, broadcastPresenceChange handles room emission); we
// only suppress the redundant write itself.
//
// In-memory fallback (no Redis): a process-local Map with timestamp expiry.

const STATUS_RECONCILE_TTL = 60; // seconds

const memStatusReconcileLocks = new Map<string, number>();

/**
 * Try to acquire a status-reconcile lock for `userId`. Returns `true` if this
 * caller should run the DB update, `false` if another connect already did so
 * within the last 60s.
 */
export async function tryAcquireStatusReconcileLock(userId: string): Promise<boolean> {
  const lockKey = `status-reconcile:${userId}`;
  if (redis) {
    const result = await redis.set(lockKey, '1', 'EX', STATUS_RECONCILE_TTL, 'NX');
    return result === 'OK';
  }
  const existing = memStatusReconcileLocks.get(lockKey);
  if (existing && Date.now() < existing) return false;
  if (!memStatusReconcileLocks.has(lockKey) && memStatusReconcileLocks.size >= MEM_MAX_ENTRIES) {
    const oldest = memStatusReconcileLocks.keys().next().value;
    if (oldest !== undefined) memStatusReconcileLocks.delete(oldest);
  }
  memStatusReconcileLocks.set(lockKey, Date.now() + STATUS_RECONCILE_TTL * 1000);
  return true;
}

// Disconnect Cleanup Lock (prevents orphaned voice/DM-call participants)
//
// When N sockets of the same user disconnect in the same event-loop tick,
// `fetchSockets()` may still see peers as present (room leave is async).
// Each socket skips cleanup because it believes another socket still holds the
// room, leaving an orphaned participant row in Redis.
//
// Fix: each disconnecting socket attempts a Redis SETNX lock scoped to
// (userId, roomKey). The first socket to acquire the lock runs cleanup;
// others skip. A 5-second TTL auto-releases the lock if the winner crashes
// before calling `releaseDisconnectCleanupLock`.
//
// In-memory fallback (no Redis): a process-local Map with timestamp-based
// expiry provides the same guarantee within a single instance.

const DISCONNECT_LOCK_TTL = 5; // seconds

const memDisconnectLocks = new Map<string, number>();

/**
 * Try to acquire a cleanup lock for `roomKey` (e.g. `voice:${channelId}`)
 * on behalf of `userId`. Returns `true` if this caller should run cleanup.
 */
export async function acquireDisconnectCleanupLock(
  roomKey: string, userId: string,
): Promise<boolean> {
  const lockKey = `disconnect-lock:${roomKey}:${userId}`;
  if (redis) {
    const result = await redis.set(lockKey, '1', 'EX', DISCONNECT_LOCK_TTL, 'NX');
    return result === 'OK';
  }
  // In-memory fallback: check timestamp-based expiry
  const existing = memDisconnectLocks.get(lockKey);
  if (existing && Date.now() < existing) return false;
  if (!memDisconnectLocks.has(lockKey) && memDisconnectLocks.size >= MEM_MAX_ENTRIES) {
    const oldest = memDisconnectLocks.keys().next().value;
    if (oldest !== undefined) memDisconnectLocks.delete(oldest);
  }
  memDisconnectLocks.set(lockKey, Date.now() + DISCONNECT_LOCK_TTL * 1000);
  return true;
}

/**
 * Release the cleanup lock early so a quick reconnect + re-disconnect
 * doesn't have to wait for the 5-second TTL.
 */
export async function releaseDisconnectCleanupLock(
  roomKey: string, userId: string,
): Promise<void> {
  const lockKey = `disconnect-lock:${roomKey}:${userId}`;
  if (redis) {
    await redis.del(lockKey);
    return;
  }
  memDisconnectLocks.delete(lockKey);
}

// Stream viewer helpers (viewer tracking)

type StreamContextKind = 'voice' | 'dm' | 'stage';

interface StreamCtx { kind: StreamContextKind; scopeId: string }

const STREAM_VIEWERS_PAGE_SIZE = 100;

function streamViewersKey(ctx: StreamCtx, ownerId: string, type: string): string {
  return `stream-viewers:${ctx.kind}:${ctx.scopeId}:${ownerId}:${type}`;
}

/** In-memory fallback, keyed by full Redis key. */
const memStreamViewers = new Map<string, Set<string>>();

export async function addStreamViewer(
  ctx: StreamCtx, ownerId: string, type: string, viewerId: string,
): Promise<void> {
  const key = streamViewersKey(ctx, ownerId, type);
  if (pub) {
    await pub.sadd(key, viewerId);
    return;
  }
  let set = memStreamViewers.get(key);
  if (!set) {
    // LRU eviction to cap map size (matches cappedMapSet pattern from infrastructure.ts;
    // can't import directly due to circular dependency redis → infrastructure → redis).
    if (memStreamViewers.size >= MEM_MAX_ENTRIES && !memStreamViewers.has(key)) {
      const oldest = memStreamViewers.keys().next().value;
      if (oldest !== undefined) memStreamViewers.delete(oldest);
    }
    set = new Set();
    memStreamViewers.set(key, set);
  }
  set.add(viewerId);
}

export async function removeStreamViewer(
  ctx: StreamCtx, ownerId: string, type: string, viewerId: string,
): Promise<void> {
  const key = streamViewersKey(ctx, ownerId, type);
  if (pub) {
    await pub.srem(key, viewerId);
    const size = await pub.scard(key);
    if (size === 0) await pub.del(key);
    return;
  }
  const set = memStreamViewers.get(key);
  if (!set) return;
  set.delete(viewerId);
  if (set.size === 0) memStreamViewers.delete(key);
}

export async function getStreamViewers(
  ctx: StreamCtx, ownerId: string, type: string,
): Promise<string[]> {
  const key = streamViewersKey(ctx, ownerId, type);
  if (pub) return pub.smembers(key);
  return Array.from(memStreamViewers.get(key) ?? []);
}

export async function getStreamViewersPage(
  ctx: StreamCtx, ownerId: string, type: string, page: number,
): Promise<{ viewers: string[]; nextPage?: number }> {
  const all = await getStreamViewers(ctx, ownerId, type);
  const start = page * STREAM_VIEWERS_PAGE_SIZE;
  const viewers = all.slice(start, start + STREAM_VIEWERS_PAGE_SIZE);
  const nextPage = start + STREAM_VIEWERS_PAGE_SIZE < all.length ? page + 1 : undefined;
  return { viewers, nextPage };
}

/** Clears every stream-viewers set scoped to `ctx`. Used when a call ends. */
export async function clearStreamViewersForContext(ctx: StreamCtx): Promise<void> {
  const pattern = `stream-viewers:${ctx.kind}:${ctx.scopeId}:*`;
  if (pub) {
    // SCAN through the keyspace (keyPrefix "howl:" applied by ioredis).
    // We iterate with cursor to avoid blocking Redis.
    let cursor = '0';
    do {
      const [next, keys] = await pub.scan(cursor, 'MATCH', `howl:${pattern}`, 'COUNT', 100);
      cursor = next;
      if (keys.length) {
        // Strip the 'howl:' prefix ioredis adds on writes — del gets raw keys.
        const stripped = keys.map(k => k.replace(/^howl:/, ''));
        await pub.del(...stripped);
      }
    } while (cursor !== '0');
    return;
  }
  for (const key of Array.from(memStreamViewers.keys())) {
    if (key.startsWith(`stream-viewers:${ctx.kind}:${ctx.scopeId}:`)) {
      memStreamViewers.delete(key);
    }
  }
}

/**
 * Remove `viewerId` from every stream-viewers set in `ctx`.
 * Returns the list of `{ streamOwnerId, streamType }` the user was removed from.
 */
export async function removeUserFromAllStreams(
  viewerId: string, ctx: StreamCtx,
): Promise<Array<{ streamOwnerId: string; streamType: string }>> {
  const removed: Array<{ streamOwnerId: string; streamType: string }> = [];
  const pattern = `stream-viewers:${ctx.kind}:${ctx.scopeId}:*`;
  if (pub) {
    let cursor = '0';
    do {
      const [next, keys] = await pub.scan(cursor, 'MATCH', `howl:${pattern}`, 'COUNT', 100);
      cursor = next;
      for (const fullKey of keys) {
        const stripped = fullKey.replace(/^howl:/, '');
        const removedCount = await pub.srem(stripped, viewerId);
        if (removedCount > 0) {
          // key format: stream-viewers:{kind}:{scopeId}:{ownerId}:{type}
          const parts = stripped.split(':');
          const ownerId = parts[3];
          const type = parts[4];
          removed.push({ streamOwnerId: ownerId, streamType: type });
          const size = await pub.scard(stripped);
          if (size === 0) await pub.del(stripped);
        }
      }
    } while (cursor !== '0');
    return removed;
  }
  for (const [key, set] of memStreamViewers.entries()) {
    if (!key.startsWith(`stream-viewers:${ctx.kind}:${ctx.scopeId}:`)) continue;
    if (set.delete(viewerId)) {
      // key format: stream-viewers:{kind}:{scopeId}:{ownerId}:{type}
      const parts = key.split(':');
      const ownerId = parts[3];
      const type = parts[4];
      removed.push({ streamOwnerId: ownerId, streamType: type });
      if (set.size === 0) memStreamViewers.delete(key);
    }
  }
  return removed;
}

/** Clear every stream-viewers set where `ownerId` is the presenter within ctx.
 *  Returns the list of cleared { streamType } entries. */
export async function clearOwnedStreams(
  ownerId: string, ctx: StreamCtx,
): Promise<Array<{ streamType: string }>> {
  const cleared: Array<{ streamType: string }> = [];
  const pattern = `stream-viewers:${ctx.kind}:${ctx.scopeId}:${ownerId}:*`;
  if (pub) {
    let cursor = '0';
    do {
      const [next, keys] = await pub.scan(cursor, 'MATCH', `howl:${pattern}`, 'COUNT', 100);
      cursor = next;
      for (const fullKey of keys) {
        const stripped = fullKey.replace(/^howl:/, '');
        const parts = stripped.split(':');
        const type = parts[4];
        cleared.push({ streamType: type });
        await pub.del(stripped);
      }
    } while (cursor !== '0');
    return cleared;
  }
  for (const key of Array.from(memStreamViewers.keys())) {
    if (!key.startsWith(`stream-viewers:${ctx.kind}:${ctx.scopeId}:${ownerId}:`)) continue;
    const parts = key.split(':');
    const type = parts[4];
    cleared.push({ streamType: type });
    memStreamViewers.delete(key);
  }
  return cleared;
}
