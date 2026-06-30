// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { messageSendLimiter } from '../middleware/messageRateLimit.js';
import { validate } from '../middleware/validate.js';
import { sendMessageSchema, editMessageSchema, getMessagesQuery, reactMessageSchema } from '../schemas.js';
import { getParam, hasPermission, loadPermissionContext, isSafeExternalUrl, AUTHOR_USER_SELECT, getEffectivePlan, isMemberTimedOut, timeoutRetryAfterSeconds } from '../utils.js';
import { logger } from '../logger.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { enqueueNotification } from '../queues/producers.js';
import { queuesEnabled } from '../queues/connection.js';
import { applyBadgePrefs } from '../utils/badges.js';
import { hasChannelPermission } from '../utils/channelPermissions.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { serverNotSuspendedByChannelId } from '../middleware/serverNotSuspended.js';
import { deleteUploadedFile } from './upload.js';
import { checkUploadAttachment } from '../services/uploadProvenance.js';
import { redis, onAutomodInvalidation } from '../redis.js';
import { cappedMapSet } from '../socketHandlers/infrastructure.js';
import { getClientIp } from '../utils/clientIp.js';
import { denyIfAgeGated } from '../utils/ageGate.js';
import { invalidateMessageCount } from '../utils/messageCountCache.js';

const log = logger.child({ module: 'messages' });

const messageActionLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:msg-action:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const messageFetchLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:msg-fetch:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const router = Router();

// Slow mode enforcement
// Slow mode: Redis-backed when available (see checkSlowMode below), in-memory fallback for single-instance mode.
// key: `${channelId}:${userId}` → timestamp of last message
const MAX_SLOW_MODE_ENTRIES = 50_000;
const MAX_EVERYONE_COOLDOWN_ENTRIES = 50_000;
const slowModeTimestamps = new Map<string, number>();
const everyoneMentionCooldown = new Map<string, number>();
const EVERYONE_COOLDOWN_MS = 30_000;

// Periodic cleanup for in-memory maps to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of slowModeTimestamps) {
    if (now - ts > 600_000) slowModeTimestamps.delete(key); // 10 min stale
  }
  for (const [key, ts] of everyoneMentionCooldown) {
    if (now - ts > EVERYONE_COOLDOWN_MS * 2) everyoneMentionCooldown.delete(key);
  }
}, 60_000).unref();

async function checkSlowMode(channelId: string, userId: string, slowModeSeconds: number): Promise<{ allowed: boolean; retryAfter?: number }> {
  if (slowModeSeconds <= 0) return { allowed: true };

  // Redis path: atomic SET NX with TTL for distributed slow mode enforcement
  if (redis) {
    const redisKey = `slowmode:${channelId}:${userId}`;
    const result = await redis.set(redisKey, '1', 'PX', slowModeSeconds * 1000, 'NX');
    if (result === 'OK') {
      return { allowed: true };
    }
    const ttl = await redis.pttl(redisKey);
    return { allowed: false, retryAfter: Math.ceil(Math.max(ttl, 0) / 1000) };
  }

  // In-memory fallback (single-instance mode)
  const key = `${channelId}:${userId}`;
  const now = Date.now();
  const last = slowModeTimestamps.get(key);
  if (last) {
    const elapsed = (now - last) / 1000;
    if (elapsed < slowModeSeconds) {
      return { allowed: false, retryAfter: Math.ceil(slowModeSeconds - elapsed) };
    }
  }
  cappedMapSet(slowModeTimestamps, key, now, MAX_SLOW_MODE_ENTRIES);
  return { allowed: true };
}

// Pre-compiled regexes for hot path
const URL_REGEX = /https?:\/\/[^\s]+/gi;
const CONTENT_FILTER_PATTERNS = [
  /nsfw/i, /xxx/i, /porn/i, /explicit/i, /hentai/i, /rule34/i,
];

// AutoMod enforcement

interface AutomodConfig {
  keywords?: string[];
  action?: string; // 'block' | 'flag' | 'delete'
  maxMentions?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
}

// Automod cache: local per-instance with Redis pub/sub invalidation (see invalidateAutomodCache below). TTL 30s.
const MAX_AUTOMOD_CACHE_ENTRIES = 10_000;
const automodCache = new Map<string, { rules: any[]; fetchedAt: number }>();
const AUTOMOD_CACHE_TTL = 30_000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of automodCache) {
    if (now - entry.fetchedAt > AUTOMOD_CACHE_TTL * 2) automodCache.delete(key);
  }
}, 60_000).unref();

export function invalidateAutomodCache(serverId: string) {
  automodCache.delete(serverId);
  if (redis) {
    redis.publish('howl:automod-invalidate', serverId).catch(() => {});
  }
}

// Listen for automod invalidation from other instances via Redis pub/sub
onAutomodInvalidation((serverId: string) => {
  automodCache.delete(serverId);
});

async function checkAutomod(serverId: string, content: string, _authorId: string): Promise<{ blocked: boolean; reason?: string }> {
  const now = Date.now();
  const cached = automodCache.get(serverId);
  let rules: any[];
  if (cached && now - cached.fetchedAt < AUTOMOD_CACHE_TTL) {
    rules = cached.rules;
  } else {
    rules = await prisma.automodRule.findMany({ where: { serverId, enabled: true }, take: 50 });
    cappedMapSet(automodCache, serverId, { rules, fetchedAt: now }, MAX_AUTOMOD_CACHE_ENTRIES);
  }

  for (const rule of rules) {
    const config = (rule.config ?? {}) as AutomodConfig;

    if (rule.type === 'keyword_filter') {
      const keywords = config.keywords ?? [];
      const lower = content.toLowerCase();
      for (const kw of keywords) {
        if (kw && lower.includes(kw.toLowerCase())) {
          if (config.action === 'block' || !config.action) {
            return { blocked: true, reason: `Message blocked by automod: contains prohibited word.` };
          }
        }
      }
    }

    if (rule.type === 'spam_filter') {
      const repeatedChar = /(.)\1{9,}/.test(content);
      const allCaps = content.length > 8 && content === content.toUpperCase() && /[A-Z]/.test(content);
      if (repeatedChar || allCaps) {
        if (config.action === 'block' || !config.action) {
          return { blocked: true, reason: 'Message blocked by automod: detected as spam.' };
        }
      }
    }

    if (rule.type === 'mention_spam') {
      const maxMentions = config.maxMentions ?? 5;
      const mentionCount = (content.match(/@/g) || []).length;
      if (mentionCount > maxMentions) {
        return { blocked: true, reason: `Message blocked by automod: too many mentions (max ${maxMentions}).` };
      }
    }

    if (rule.type === 'link_filter') {
      URL_REGEX.lastIndex = 0;
      const urls = content.match(URL_REGEX) || [];
      if (urls.length > 0) {
        const blocked = config.blockedDomains ?? [];
        const allowed = config.allowedDomains ?? [];
        for (const url of urls) {
          try {
            if (!isSafeExternalUrl(url)) continue;
            const hostname = new URL(url).hostname.toLowerCase();
            if (blocked.length > 0 && blocked.some(d => hostname.includes(d.toLowerCase()))) {
              return { blocked: true, reason: 'Message blocked by automod: link from a blocked domain.' };
            }
            if (allowed.length > 0 && !allowed.some(d => hostname.includes(d.toLowerCase()))) {
              return { blocked: true, reason: 'Message blocked by automod: link not from an allowed domain.' };
            }
          } catch {
            // invalid URL, skip
          }
        }
      }
    }
  }

  return { blocked: false };
}

// Content filter

async function checkContentFilter(
  serverId: string,
  userId: string,
  content: string,
  _attachmentUrl: string | undefined,
): Promise<{ blocked: boolean; reason?: string }> {
  const settings = await prisma.serverSettings.findUnique({ where: { serverId } });
  if (!settings || settings.contentFilter === 'off') return { blocked: false };

  if (settings.contentFilter === 'scan_no_roles') {
    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId, serverId } },
      select: { roleId: true },
    });
    if (membership?.roleId) return { blocked: false };
  }

  // Attachment URL keyword matching removed — filenames are typically UUIDs and
  // regex on the URL provides false confidence. Actual image content is checked
  // via PDQ perceptual hashing in the upload route instead.

  for (const pat of CONTENT_FILTER_PATTERNS) {
    if (pat.test(content)) {
      return { blocked: true, reason: 'Message blocked by content filter: potentially explicit content.' };
    }
  }

  return { blocked: false };
}

/** Parse message content for @everyone, @here, @username#1234, @role and return mentioned user IDs in this server. */
export async function getMentionedUserIds(prismaClient: typeof prisma, content: string, serverId: string): Promise<string[]> {
  // eslint-disable-next-line security/detect-unsafe-regex
  const MENTION_REGEX = /@(?:<([^>]+)>|(everyone|here|[a-zA-Z0-9_]{1,32}(?:#\d{4})?))/gi;
  const matches = [...content.matchAll(MENTION_REGEX)].map((m: RegExpMatchArray) => (m[1] || m[2] || '').toLowerCase());
  if (matches.length === 0) return [];

  const hasEveryone = matches.some(r => r === 'everyone');
  const hasHere = matches.some(r => r === 'here');

  // If @everyone/@here, we need all member IDs -- use a lightweight count-only approach
  if (hasEveryone) {
    // @everyone → all server members
    const allMembers = await prismaClient.serverMember.findMany({
      where: { serverId },
      select: { userId: true },
      take: 5000,
    });
    return allMembers.map(m => m.userId);
  }

  if (hasHere) {
    // @here → only members whose User status is online, idle, or dnd
    const onlineMembers = await prismaClient.serverMember.findMany({
      where: {
        serverId,
        user: { status: { in: ['online', 'idle', 'dnd'] } },
      },
      select: { userId: true },
      take: 5000,
    });
    return onlineMembers.map(m => m.userId);
  }

  // Otherwise, resolve only the specific usernames and roles mentioned
  const userMentions: { username: string; disc: string | null }[] = [];
  const roleMentions: string[] = [];

  for (const raw of matches) {
    if (raw.includes('#')) {
      const idx = raw.lastIndexOf('#');
      userMentions.push({ username: raw.slice(0, idx).toLowerCase(), disc: raw.slice(idx + 1) });
    } else {
      roleMentions.push(raw);
    }
  }

  const userIds = new Set<string>();

  if (userMentions.length > 0) {
    const usernames = [...new Set(userMentions.map(m => m.username))];
    const members = await prismaClient.serverMember.findMany({
      where: { serverId, user: { username: { in: usernames, mode: 'insensitive' } } },
      include: { user: { select: { id: true, username: true, discriminator: true } } },
      take: 200,
    });
    for (const mention of userMentions) {
      const member = members.find(
        (m) =>
          m.user.username.toLowerCase() === mention.username &&
          (m.user.discriminator ?? '').padStart(4, '0') === (mention.disc ?? '').padStart(4, '0')
      );
      if (member) userIds.add(member.userId);
    }
  }

  if (roleMentions.length > 0) {
    const uniqueRoleNames = [...new Set(roleMentions)];
    const roles = await prismaClient.serverRole.findMany({
      where: { serverId, name: { in: uniqueRoleNames, mode: 'insensitive' } },
      include: { members: { select: { userId: true }, take: 10000 } },
      take: 100,
    });
    for (const role of roles) {
      role.members.forEach((m) => userIds.add(m.userId));
    }
  }

  return [...userIds];
}

// GET /api/messages/channels/:channelId/pins – list pinned messages in this channel
router.get('/channels/:channelId/pins', validateUuidParams('channelId'), authenticateToken, messageFetchLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const channelId = getParam(req, 'channelId');
  try {
    const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, serverId: true, isPrivate: true, categoryId: true, ageRestricted: true } });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const ageGateDenial = await denyIfAgeGated(channel, req.userId);
    if (ageGateDenial) return res.status(403).json(ageGateDenial);
    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId: channel.serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, channel.serverId),
    ]);
    if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });
    const [chOverrides, catOverrides] = await Promise.all([
      prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 200 }),
      channel.categoryId
        ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 200 })
        : Promise.resolve([]),
    ]);
    if (channel.isPrivate && !hasChannelPermission(permCtx,'viewChannels', chOverrides, catOverrides, undefined, { requireOverride: true })) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    if (!hasChannelPermission(permCtx,'readMessageHistory', chOverrides, catOverrides)) return res.status(403).json({ error: 'You do not have permission to read message history in this server.' });
    const pins = await prisma.channelPinnedMessage.findMany({
      where: { channelId },
      orderBy: { pinnedAt: 'asc' },
      take: 200,
    });
    const messageIds = pins.map((p) => p.messageId);
    const messages = await prisma.message.findMany({
      where: { id: { in: messageIds }, channelId },
      take: 200,
    });
    const msgMap = new Map(messages.map((m) => [m.id, m]));
    const authorIds = [...new Set(messages.map((m) => m.authorId))];
    const [authors, memberships] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: authorIds } }, select: AUTHOR_USER_SELECT, take: 200 }),
      prisma.serverMember.findMany({ where: { serverId: channel.serverId, userId: { in: authorIds } }, include: { serverRole: { select: { color: true, style: true, name: true } } }, take: 200 }),
    ]);
    const authorMap = Object.fromEntries(authors.map((u) => [u.id, u]));
    const roleByUser = Object.fromEntries(memberships.map((m) => [m.userId, m.serverRole]));
    const memberByUser = Object.fromEntries(memberships.map((m) => [m.userId, m]));
    const list = pins.map((p) => {
      const msg = msgMap.get(p.messageId);
      if (!msg) return null;
      const author = authorMap[msg.authorId];
      const role = roleByUser[msg.authorId];
      return {
        id: msg.id,
        channelId: msg.channelId,
        authorId: msg.authorId,
        content: msg.content,
        createdAt: msg.createdAt.toISOString(),
        editedAt: msg.editedAt?.toISOString() ?? null,
        authorUsername: memberByUser[msg.authorId]?.nickname ?? author?.username ?? null,
        authorDiscriminator: author?.discriminator ?? null,
        authorAvatar: memberByUser[msg.authorId]?.serverAvatar ?? author?.avatar ?? null,
        authorRoleColor: role?.color ?? null,
        authorRoleStyle: role?.style ?? 'solid',
        authorStripePlan: author ? getEffectivePlan(author) : null,
        authorNameColor: author?.nameColor ?? null,
        authorNameFont: author?.nameFont ?? null,
        authorNameEffect: author?.nameEffect ?? null,
        authorAvatarEffect: author?.avatarEffect ?? null,
        authorBadges: author ? applyBadgePrefs(author) : [],
        forwarded: msg.forwarded ?? false,
        pinnedAt: p.pinnedAt.toISOString(),
        pinnedById: p.pinnedById,
      };
    }).filter(Boolean);
    res.json({ pins: list });
  } catch (err) {
    log.error({ err }, 'GET /api/messages/channels/:channelId/pins error');
    next(err);
  }
});

// POST /api/messages/channels/:channelId/messages/:messageId/pin (manageMessages permission)
router.post('/channels/:channelId/messages/:messageId/pin', validateUuidParams('channelId', 'messageId'), authenticateToken, serverNotSuspendedByChannelId('channelId'), messageActionLimiter, async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const channelId = getParam(req, 'channelId');
  const messageId = getParam(req, 'messageId');
  const [channel, message] = await Promise.all([
    prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, serverId: true, isPrivate: true, categoryId: true, ageRestricted: true } }),
    prisma.message.findFirst({ where: { id: messageId, channelId } }),
  ]);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!message) return res.status(404).json({ error: 'Message not found' });
  const ageGateDenial = await denyIfAgeGated(channel, req.userId);
  if (ageGateDenial) return res.status(403).json(ageGateDenial);
  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId: channel.serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, channel.serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });
  const [chOverrides, catOverrides] = await Promise.all([
    prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 200 }),
    channel.categoryId
      ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 200 })
      : Promise.resolve([]),
  ]);
  if (channel.isPrivate && !hasChannelPermission(permCtx,'viewChannels', chOverrides, catOverrides, undefined, { requireOverride: true })) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  if (!hasChannelPermission(permCtx,'readMessageHistory', chOverrides, catOverrides)) return res.status(403).json({ error: 'You do not have permission to read message history in this server.' });
  if (!hasChannelPermission(permCtx,'manageMessages', chOverrides, catOverrides)) return res.status(403).json({ error: 'You need the Manage Messages permission' });
  const MAX_PINS_PER_CHANNEL = 50;
  const existingPin = await prisma.channelPinnedMessage.findUnique({ where: { channelId_messageId: { channelId, messageId } } });
  if (!existingPin) {
    const pinCount = await prisma.channelPinnedMessage.count({ where: { channelId } });
    if (pinCount >= MAX_PINS_PER_CHANNEL) {
      return res.status(400).json({ error: `Cannot pin more than ${MAX_PINS_PER_CHANNEL} messages in a channel.` });
    }
  }
  await prisma.channelPinnedMessage.upsert({
    where: { channelId_messageId: { channelId, messageId } },
    create: { channelId, messageId, pinnedById: req.userId },
    update: { pinnedById: req.userId, pinnedAt: new Date() },
  });
  const systemPayload = { kind: 'pin', messageId };
  const systemMessage = await prisma.message.create({
    data: {
      channelId,
      authorId: req.userId,
      content: 'pinned a message',
      type: 'system',
      systemPayload: systemPayload as object,
    },
  });
  const [author, membership] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.userId }, select: AUTHOR_USER_SELECT }),
    prisma.serverMember.findUnique({ where: { userId_serverId: { userId: req.userId, serverId: channel.serverId } }, include: { serverRole: true } }),
  ]);
  const payload = {
    id: systemMessage.id,
    channelId: systemMessage.channelId,
    authorId: systemMessage.authorId,
    content: systemMessage.content,
    type: systemMessage.type,
    systemPayload: systemMessage.systemPayload,
    createdAt: systemMessage.createdAt.toISOString(),
    authorUsername: membership?.nickname ?? author?.username ?? null,
    authorDiscriminator: author?.discriminator ?? null,
    authorAvatar: membership?.serverAvatar ?? author?.avatar ?? null,
    authorRoleColor: membership?.serverRole?.color ?? null,
    authorRoleStyle: membership?.serverRole?.style ?? 'solid',
    authorStripePlan: author ? getEffectivePlan(author) : null,
    authorNameColor: author?.nameColor ?? null,
    authorNameFont: author?.nameFont ?? null,
    authorNameEffect: author?.nameEffect ?? null,
    authorAvatarEffect: author?.avatarEffect ?? null,
    authorBadges: author ? applyBadgePrefs(author) : [],
  };
  const io = req.app.get('io') as import('socket.io').Server;
  if (io) {
    io.to(`channel:${channelId}`).emit('channel-message-pinned', { channelId, messageId });
    io.to(`channel:${channelId}`).emit('new-message', payload);
  }
  return res.status(201).json(payload);
});

// DELETE /api/messages/channels/:channelId/messages/:messageId/pin (manageMessages permission)
router.delete('/channels/:channelId/messages/:messageId/pin', validateUuidParams('channelId', 'messageId'), authenticateToken, serverNotSuspendedByChannelId('channelId'), messageActionLimiter, async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const channelId = getParam(req, 'channelId');
  const messageId = getParam(req, 'messageId');
  const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, serverId: true, isPrivate: true, categoryId: true, ageRestricted: true } });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const ageGateDenial = await denyIfAgeGated(channel, req.userId);
  if (ageGateDenial) return res.status(403).json(ageGateDenial);
  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId: channel.serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, channel.serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });
  const [chOverrides, catOverrides] = await Promise.all([
    prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 200 }),
    channel.categoryId
      ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 200 })
      : Promise.resolve([]),
  ]);
  if (channel.isPrivate && !hasChannelPermission(permCtx,'viewChannels', chOverrides, catOverrides, undefined, { requireOverride: true })) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  if (!hasChannelPermission(permCtx,'readMessageHistory', chOverrides, catOverrides)) return res.status(403).json({ error: 'You do not have permission to read message history in this server.' });
  if (!hasChannelPermission(permCtx,'manageMessages', chOverrides, catOverrides)) return res.status(403).json({ error: 'You need the Manage Messages permission' });
  await prisma.channelPinnedMessage.deleteMany({
    where: { channelId, messageId },
  });
  // Remove the "X pinned a message" system message using JSON path filter
  await prisma.message.deleteMany({
    where: {
      channelId,
      type: 'system',
      systemPayload: { path: ['kind'], equals: 'pin' },
      AND: { systemPayload: { path: ['messageId'], equals: messageId } },
    },
  });
  const io = req.app.get('io') as import('socket.io').Server;
  if (io) io.to(`channel:${channelId}`).emit('channel-message-unpinned', { channelId, messageId });
  return res.status(204).send();
});

// DELETE /api/messages/channels/:channelId/messages/:messageId
router.delete('/channels/:channelId/messages/:messageId', validateUuidParams('channelId', 'messageId'), authenticateToken, serverNotSuspendedByChannelId('channelId'), messageActionLimiter, async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const channelId = getParam(req, 'channelId');
  const messageId = getParam(req, 'messageId');
  const [channel, message] = await Promise.all([
    prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, serverId: true, isPrivate: true, categoryId: true } }),
    prisma.message.findFirst({ where: { id: messageId, channelId } }),
  ]);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!message) return res.status(404).json({ error: 'Message not found' });
  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId: channel.serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, channel.serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });
  const [chOverrides, catOverrides] = await Promise.all([
    prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 200 }),
    channel.categoryId
      ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 200 })
      : Promise.resolve([]),
  ]);
  if (channel.isPrivate && !hasChannelPermission(permCtx,'viewChannels', chOverrides, catOverrides, undefined, { requireOverride: true })) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  if (!hasChannelPermission(permCtx,'readMessageHistory', chOverrides, catOverrides)) return res.status(403).json({ error: 'You do not have permission to read message history in this server.' });
  const isAuthor = message.authorId === req.userId;
  const canDeleteAny = hasChannelPermission(permCtx,'manageMessages', chOverrides, catOverrides);
  if (!isAuthor && !canDeleteAny) return res.status(403).json({ error: 'You can only delete your own messages' });
  if (message.type === 'system') return res.status(400).json({ error: 'Cannot delete system messages' });
  await Promise.all([
    prisma.channelPinnedMessage.deleteMany({ where: { channelId, messageId } }),
    prisma.message.deleteMany({
      where: {
        channelId,
        type: 'system',
        systemPayload: { path: ['kind'], equals: 'pin' },
        AND: { systemPayload: { path: ['messageId'], equals: messageId } },
      },
    }),
  ]);
  await prisma.message.delete({ where: { id: messageId } });
  if (message.attachmentUrl) {
    const [msgRefs, dmRefs] = await Promise.all([
      prisma.message.count({ where: { attachmentUrl: message.attachmentUrl, id: { not: message.id } } }),
      prisma.dMMessage.count({ where: { attachmentUrl: message.attachmentUrl } }),
    ]);
    if (msgRefs + dmRefs === 0) {
      deleteUploadedFile(message.attachmentUrl).catch(() => {});
    }
  }
  const io = req.app.get('io') as import('socket.io').Server;
  if (io) io.to(`channel:${channelId}`).emit('message-deleted', { channelId, messageId });
  return res.status(204).send();
});

// PATCH /api/messages/channels/:channelId/messages/:messageId
router.patch('/channels/:channelId/messages/:messageId', validateUuidParams('channelId', 'messageId'), authenticateToken, serverNotSuspendedByChannelId('channelId'), messageActionLimiter, validate(editMessageSchema), async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const channelId = getParam(req, 'channelId');
  const messageId = getParam(req, 'messageId');
  const { content } = req.body as { content?: string };
  if (!content || !content.trim()) return res.status(400).json({ error: 'Content is required' });
  const [channel, message] = await Promise.all([
    prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, serverId: true, isPrivate: true, categoryId: true } }),
    prisma.message.findFirst({ where: { id: messageId, channelId } }),
  ]);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!message) return res.status(404).json({ error: 'Message not found' });
  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId: channel.serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, channel.serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });
  if (isMemberTimedOut(member)) {
    return res.status(403).json({ error: 'MEMBER_TIMED_OUT', retryAfter: timeoutRetryAfterSeconds(member) });
  }
  const [chOverrides, catOverrides] = await Promise.all([
    prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 200 }),
    channel.categoryId
      ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 200 })
      : Promise.resolve([]),
  ]);
  if (channel.isPrivate && !hasChannelPermission(permCtx,'viewChannels', chOverrides, catOverrides, undefined, { requireOverride: true })) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  if (!hasChannelPermission(permCtx,'readMessageHistory', chOverrides, catOverrides)) return res.status(403).json({ error: 'You do not have permission to read message history in this server.' });
  if (!hasChannelPermission(permCtx,'sendMessages', chOverrides, catOverrides)) return res.status(403).json({ error: 'You do not have permission to send messages in this channel.' });
  if (message.authorId !== req.userId) return res.status(403).json({ error: 'You can only edit your own messages' });
  if (message.type === 'system') return res.status(400).json({ error: 'Cannot edit system messages' });

  let trimmedContent = content.trim();

  // Tiered message length: 2000 free, 4000 essential/pro
  if (trimmedContent.length > 2000) {
    const sender = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true },
    });
    const senderPlan = sender ? getEffectivePlan(sender) : 'free';
    const maxLen = (senderPlan === 'essential' || senderPlan === 'pro') ? 4000 : 2000;
    if (trimmedContent.length > maxLen) {
      return res.status(400).json({ error: `Message exceeds the ${maxLen} character limit.` });
    }
  }

  if (channel.serverId) {
    const filterResult = await checkContentFilter(channel.serverId, req.userId, trimmedContent, undefined);
    if (filterResult.blocked) return res.status(403).json({ error: filterResult.reason ?? 'Message blocked by content filter.' });
    const automodResult = await checkAutomod(channel.serverId, trimmedContent, req.userId);
    if (automodResult.blocked) return res.status(403).json({ error: automodResult.reason ?? 'Message blocked by automod.' });
    // Strip @everyone/@here if the user lacks mentionEveryone permission
    if (/@(everyone|here)\b/i.test(trimmedContent) && !hasPermission(permCtx,'mentionEveryone')) {
      trimmedContent = trimmedContent.replace(/@(everyone|here)\b/gi, '@\u200B$1');
    }
  }

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { content: trimmedContent, editedAt: new Date() },
  });
  const io = req.app.get('io') as import('socket.io').Server;
  if (io) io.to(`channel:${channelId}`).emit('message-updated', { channelId, messageId, content: updated.content, editedAt: updated.editedAt?.toISOString() ?? null });
  return res.json({ id: updated.id, content: updated.content, editedAt: updated.editedAt?.toISOString() ?? null });
});

// GET /api/messages/channels/:channelId
router.get('/channels/:channelId', validateUuidParams('channelId'), authenticateToken, messageFetchLimiter, validate(getMessagesQuery), async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const channelId = getParam(req, 'channelId');
  try {
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: {
        id: true,
        serverId: true,
        isPrivate: true,
        categoryId: true,
        ageRestricted: true,
      },
    });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    if (channel.serverId) {
      const [member, permCtx] = await Promise.all([
        prisma.serverMember.findUnique({
          where: { userId_serverId: { userId: req.userId, serverId: channel.serverId } },
          include: { serverRole: true },
        }),
        loadPermissionContext(req.userId, channel.serverId),
      ]);
      if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });
      const [chOverrides, catOverrides] = await Promise.all([
        prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 200 }),
        channel.categoryId
          ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 200 })
          : Promise.resolve([]),
      ]);
      if (channel.isPrivate && !hasChannelPermission(permCtx,'viewChannels', chOverrides, catOverrides, undefined, { requireOverride: true })) {
        return res.status(404).json({ error: 'Channel not found' });
      }
      if (!hasChannelPermission(permCtx,'readMessageHistory', chOverrides, catOverrides)) {
        return res.status(403).json({ error: 'You do not have permission to read message history in this server.' });
      }
      const ageDeny = await denyIfAgeGated(channel, req.userId);
      if (ageDeny) return res.status(403).json(ageDeny);
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 200);
    const before = req.query.before as string | undefined;
    const around = req.query.around as string | undefined;

    let list: any[];
    let hasMore: boolean;
    let hasMoreNewer = false;

    if (around) {
      // Jump-to-message: fetch a window centered on the target. We `findFirst` with
      // `channelId` baked into the WHERE so a target in a different channel returns
      // a clean 404 (never reveal cross-channel existence).
      const target = await prisma.message.findFirst({
        where: { id: around, channelId },
        select: { createdAt: true },
      });
      if (!target) return res.status(404).json({ error: 'Message not found' });
      const half = Math.floor(limit / 2);
      const [beforeRows, afterRows] = await Promise.all([
        prisma.message.findMany({
          where: { channelId, createdAt: { lt: target.createdAt } },
          orderBy: { createdAt: 'desc' },
          take: half + 1,
        }),
        prisma.message.findMany({
          // gte includes the target itself (and any tied-createdAt siblings).
          where: { channelId, createdAt: { gte: target.createdAt } },
          orderBy: { createdAt: 'asc' },
          take: half + 1,
        }),
      ]);
      hasMore = beforeRows.length > half;
      if (hasMore) beforeRows.pop();
      hasMoreNewer = afterRows.length > half;
      if (hasMoreNewer) afterRows.pop();
      beforeRows.reverse();
      list = [...beforeRows, ...afterRows];
    } else {
      const whereClause: any = { channelId };
      if (before) {
        const cursor = await prisma.message.findUnique({ where: { id: before }, select: { createdAt: true } });
        if (cursor) {
          whereClause.createdAt = { lt: cursor.createdAt };
        }
      }

      list = await prisma.message.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
      });

      hasMore = list.length > limit;
      if (hasMore) list.pop();
      list.reverse();
    }
    const authorIds = [...new Set(list.map((m) => m.authorId))];
    const replyToIds = list.map((m) => m.replyToMessageId).filter(Boolean) as string[];
    const [authors, memberships, replyToMessages, pinnedRows] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: authorIds } }, select: AUTHOR_USER_SELECT, take: 200 }),
      authorIds.length ? prisma.serverMember.findMany({ where: { serverId: channel.serverId, userId: { in: authorIds } }, include: { serverRole: { select: { color: true, style: true, name: true } } }, take: 200 }) : [],
      replyToIds.length ? prisma.message.findMany({ where: { id: { in: replyToIds }, channelId }, take: 200 }) : [],
      prisma.channelPinnedMessage.findMany({ where: { channelId }, select: { messageId: true }, take: 200 }),
    ]);
    const authorMap = Object.fromEntries(authors.map((u) => [u.id, u]));
    const roleByUser = Object.fromEntries(memberships.map((m) => [m.userId, m.serverRole]));
    const memberByUser = Object.fromEntries(memberships.map((m) => [m.userId, m]));
    const replyToMap = Object.fromEntries(replyToMessages.map((r) => [r.id, r]));
    const replyToAuthorIds = [...new Set(replyToMessages.map((r) => r.authorId))];
    const replyToAuthors = replyToAuthorIds.length ? await prisma.user.findMany({ where: { id: { in: replyToAuthorIds } }, select: AUTHOR_USER_SELECT, take: 200 }) : [];
    const replyToAuthorMap = Object.fromEntries(replyToAuthors.map((u) => [u.id, u]));
    // Batch-fetch reactions for all messages
    const messageIds = list.map(m => m.id);
    const reactionRows = messageIds.length ? await prisma.messageReaction.findMany({
      where: { messageId: { in: messageIds } },
      select: { messageId: true, emoji: true, userId: true },
      orderBy: { createdAt: 'asc' },
      take: 5000,
    }) : [];
    const reactionsByMsg = new Map<string, Array<{ emoji: string; userIds: string[] }>>();
    for (const r of reactionRows) {
      if (!reactionsByMsg.has(r.messageId)) reactionsByMsg.set(r.messageId, []);
      const msgReactions = reactionsByMsg.get(r.messageId)!;
      const existing = msgReactions.find(x => x.emoji === r.emoji);
      if (existing) existing.userIds.push(r.userId);
      else msgReactions.push({ emoji: r.emoji, userIds: [r.userId] });
    }

    const mapped = list.map((m) => {
      const author = authorMap[m.authorId];
      const role = roleByUser[m.authorId];
      const replyTo = m.replyToMessageId ? (() => {
        const ref = replyToMap[m.replyToMessageId!];
        if (!ref) return null;
        const refAuthor = replyToAuthorMap[ref.authorId];
        return { id: ref.id, authorId: ref.authorId, authorUsername: refAuthor?.username ?? null, content: ref.content };
      })() : null;
      return {
        id: m.id,
        channelId: m.channelId,
        authorId: m.authorId,
        content: m.content,
        type: m.type,
        systemPayload: m.systemPayload ?? null,
        replyToMessageId: m.replyToMessageId ?? null,
        attachmentUrl: m.attachmentUrl ?? null,
        attachmentName: m.attachmentName ?? null,
        attachmentContentType: m.attachmentContentType ?? null,
        attachmentWidth: m.attachmentWidth ?? null,
        attachmentHeight: m.attachmentHeight ?? null,
        attachmentIsSpoiler: m.attachmentIsSpoiler,
        attachmentAlt: m.attachmentAlt ?? null,
        forwarded: m.forwarded,
        createdAt: m.createdAt.toISOString(),
        editedAt: m.editedAt?.toISOString() ?? null,
        authorUsername: memberByUser[m.authorId]?.nickname ?? author?.username ?? null,
        authorDiscriminator: author?.discriminator ?? null,
        authorAvatar: memberByUser[m.authorId]?.serverAvatar ?? author?.avatar ?? null,
        authorRoleColor: role?.color ?? null,
        authorRoleStyle: (role?.style ?? 'solid') as string,
        authorStripePlan: author ? getEffectivePlan(author) : null,
        authorNameColor: author?.nameColor ?? null,
        authorNameFont: author?.nameFont ?? null,
        authorNameEffect: author?.nameEffect ?? null,
        authorAvatarEffect: author?.avatarEffect ?? null,
        authorBadges: author ? applyBadgePrefs(author) : [],
        replyTo,
        reactions: reactionsByMsg.get(m.id) ?? [],
      };
    });
    // Fetch user's read state for this channel
    const readState = await prisma.channelReadState.findUnique({
      where: { userId_channelId: { userId: req.userId, channelId } },
      select: { lastReadAt: true },
    });

    res.json({ messages: mapped, hasMore, hasMoreNewer, pinnedMessageIds: pinnedRows.map(p => p.messageId), lastReadAt: readState?.lastReadAt?.toISOString() ?? null });
  } catch (err) {
    log.error({ err }, 'GET /api/messages/channels/:channelId error');
    next(err);
  }
});

// POST /api/messages/channels/:channelId
router.post('/channels/:channelId', validateUuidParams('channelId'), authenticateToken, serverNotSuspendedByChannelId('channelId'), messageSendLimiter, validate(sendMessageSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  const channelId = getParam(req, 'channelId');
  const { content, replyToMessageId, attachmentUrl, attachmentName, attachmentContentType, attachmentWidth, attachmentHeight, attachmentIsSpoiler: bodyIsSpoiler, attachmentAlt: bodyAlt, forwarded } = req.body as {
    content?: string; replyToMessageId?: string;
    attachmentUrl?: string; attachmentName?: string; attachmentContentType?: string;
    attachmentWidth?: number; attachmentHeight?: number;
    attachmentIsSpoiler?: boolean;
    attachmentAlt?: string;
    forwarded?: boolean;
  };
  const resolvedIsSpoiler = bodyIsSpoiler ?? false;
  // Alt text: trim, treat empty string as null
  const resolvedAlt = typeof bodyAlt === 'string' && bodyAlt.trim().length > 0 ? bodyAlt.trim() : null;

  let contentTrimmed = typeof content === 'string' ? content.trim() : '';
  if (!contentTrimmed && !attachmentUrl) {
    return res.status(400).json({ error: 'Message content or attachment is required' });
  }

  // Tiered message length: 2000 free, 4000 essential/pro
  if (contentTrimmed.length > 2000) {
    const sender = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true },
    });
    const senderPlan = sender ? getEffectivePlan(sender) : 'free';
    const maxLen = (senderPlan === 'essential' || senderPlan === 'pro') ? 4000 : 2000;
    if (contentTrimmed.length > maxLen) {
      return res.status(400).json({ error: `Message exceeds the ${maxLen} character limit.` });
    }
  }

  if (attachmentUrl) {
    const isLocalUpload = /^\/api\/uploads\//.test(attachmentUrl);
    let isAllowedOrigin = false;
    if (!isLocalUpload) {
      try {
        const backendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5000';
        const parsed = new URL(attachmentUrl);
        const TRUSTED_MEDIA_ORIGINS = ['https://static.klipy.com'];
        isAllowedOrigin = backendOrigin.split(',').some((o) => {
          try { return new URL(o.trim()).origin === parsed.origin; } catch { return false; }
        });
        if (!isAllowedOrigin) {
          isAllowedOrigin = TRUSTED_MEDIA_ORIGINS.includes(parsed.origin);
        }
      } catch { /* invalid URL */ }
    }
    if (!isLocalUpload && !isAllowedOrigin) {
      return res.status(400).json({ error: 'Attachment URL must be a server upload path or match the backend origin' });
    }
    // An encrypted (E2E DM) blob skips ALL server-side
    // content safety on upload, so it must never be attached to a plaintext,
    // multi-recipient server channel. checkUploadAttachment normalizes the URL the
    // same way the serve route resolves it (relative, /api/v1/, absolute backend
    // origin, trailing slash, ?query, %-encoding) and refuses any upload whose
    // ImageHash provenance is `encrypted: true`; it fails CLOSED on a lookup error.
    const att = await checkUploadAttachment(attachmentUrl);
    if (!att.ok) return res.status(att.status).json({ error: att.error });
  }

  if (!req.userId) {
    return res.status(401).json({ error: 'Missing user in token' });
  }

  try {
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: {
        id: true,
        serverId: true,
        slowMode: true,
        name: true,
        isPrivate: true,
        categoryId: true,
        ageRestricted: true,
      },
    });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    if (channel.serverId) {
      const [member, permCtx] = await Promise.all([
        prisma.serverMember.findUnique({
          where: { userId_serverId: { userId: req.userId!, serverId: channel.serverId } },
          include: { serverRole: true },
        }),
        loadPermissionContext(req.userId!, channel.serverId),
      ]);
      if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });

      if (isMemberTimedOut(member)) {
        return res.status(403).json({ error: 'MEMBER_TIMED_OUT', retryAfter: timeoutRetryAfterSeconds(member) });
      }

      const [chOverrides, catOverrides] = await Promise.all([
        prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 200 }),
        channel.categoryId
          ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 200 })
          : Promise.resolve([]),
      ]);
      if (channel.isPrivate && !hasChannelPermission(permCtx,'viewChannels', chOverrides, catOverrides, undefined, { requireOverride: true })) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      if (!hasChannelPermission(permCtx,'sendMessages', chOverrides, catOverrides)) {
        return res.status(403).json({ error: 'You do not have permission to send messages in this server.' });
      }

      const ageDeny = await denyIfAgeGated(channel, req.userId!);
      if (ageDeny) return res.status(403).json(ageDeny);
      if (attachmentUrl && !hasChannelPermission(permCtx,'attachFiles', chOverrides, catOverrides)) {
        return res.status(403).json({ error: 'You do not have permission to upload files in this server.' });
      }
      if (contentTrimmed && /@(everyone|here)\b/i.test(contentTrimmed) && !hasPermission(permCtx,'mentionEveryone')) {
        contentTrimmed = contentTrimmed.replace(/@(everyone|here)\b/gi, '@\u200B$1');
      }

      if (contentTrimmed) {
        const automodResult = await checkAutomod(channel.serverId, contentTrimmed, req.userId!);
        if (automodResult.blocked) {
          return res.status(403).json({ error: automodResult.reason ?? 'Message blocked by automod.' });
        }
      }

      const cfResult = await checkContentFilter(channel.serverId, req.userId!, contentTrimmed, attachmentUrl);
      if (cfResult.blocked) {
        return res.status(403).json({ error: cfResult.reason ?? 'Message blocked by content filter.' });
      }
    }

    // Validate cross-server custom emoji usage (requires Essential+ plan)
    if (contentTrimmed && channel.serverId) {
      const emojiPattern = /:([a-zA-Z0-9_]+):/g;
      const emojiNames = new Set<string>();
      let em: RegExpExecArray | null;
      while ((em = emojiPattern.exec(contentTrimmed)) !== null) emojiNames.add(em[1]);

      if (emojiNames.size > 0) {
        const localEmojis = await prisma.customEmoji.findMany({
          where: { serverId: channel.serverId, name: { in: [...emojiNames] } },
          select: { name: true },
          take: 200,
        });
        const localNames = new Set(localEmojis.map((e) => e.name));
        const crossServer = [...emojiNames].filter((n) => !localNames.has(n));

        if (crossServer.length > 0) {
          const crossExist = await prisma.customEmoji.findMany({
            where: { name: { in: crossServer } },
            select: { name: true },
            take: 200,
          });
          const crossExistNames = new Set(crossExist.map((e) => e.name));

          if (crossExistNames.size > 0) {
            const sender = await prisma.user.findUnique({ where: { id: req.userId! }, select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true } });
            const senderPlan = sender ? getEffectivePlan(sender) : 'free';
            if (senderPlan !== 'essential' && senderPlan !== 'pro') {
              const stripped = contentTrimmed.replace(/:([a-zA-Z0-9_]+):/g, (full, name) =>
                crossExistNames.has(name) ? '' : full
              ).trim();
              if (stripped || attachmentUrl) contentTrimmed = stripped;
            }
          }
        }
      }
    }

    const slowModeSec = channel.slowMode ?? 0;
    if (slowModeSec > 0) {
      const sm = await checkSlowMode(channelId, req.userId!, slowModeSec);
      if (!sm.allowed) {
        return res.status(429).json({ error: `Slow mode active. Try again in ${sm.retryAfter}s.` });
      }
    }

    let replyRef: { id: string; authorId: string } | null = null;
    if (replyToMessageId) {
      replyRef = await prisma.message.findFirst({ where: { id: replyToMessageId, channelId }, select: { id: true, authorId: true } });
      if (!replyRef) return res.status(400).json({ error: 'Reply target message not found' });
    }
    const message = await prisma.message.create({
      data: {
        channelId,
        authorId: req.userId,
        content: contentTrimmed,
        replyToMessageId: replyToMessageId || null,
        attachmentUrl: attachmentUrl || null,
        attachmentName: attachmentName || null,
        attachmentContentType: attachmentContentType || null,
        attachmentWidth: attachmentWidth ?? null,
        attachmentHeight: attachmentHeight ?? null,
        attachmentIsSpoiler: resolvedIsSpoiler,
        attachmentAlt: resolvedAlt,
        forwarded: !!forwarded,
      },
    });
    // Invalidate the per-(user, server) message-count cache so self-role
    // claims that gate on `messageCount` see the new total within the next
    // request (rather than waiting up to 5 min for the cache to expire).
    invalidateMessageCount(req.userId, channel.serverId).catch(() => { /* best-effort */ });
    const [author, membership, replyToMsg, replyToAuthor] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.userId }, select: AUTHOR_USER_SELECT }),
      prisma.serverMember.findUnique({ where: { userId_serverId: { userId: req.userId, serverId: channel.serverId } }, include: { serverRole: true } }),
      message.replyToMessageId ? prisma.message.findUnique({ where: { id: message.replyToMessageId } }) : null,
      replyRef ? prisma.user.findUnique({ where: { id: replyRef.authorId }, select: AUTHOR_USER_SELECT }) : null,
    ]);
    const payload = {
      id: message.id,
      channelId: message.channelId,
      authorId: message.authorId,
      content: message.content,
      type: message.type,
      systemPayload: message.systemPayload ?? null,
      replyToMessageId: message.replyToMessageId ?? null,
      forwarded: message.forwarded,
      createdAt: message.createdAt.toISOString(),
      editedAt: message.editedAt?.toISOString() ?? null,
      authorUsername: membership?.nickname ?? author?.username ?? null,
      authorDiscriminator: author?.discriminator ?? null,
      authorAvatar: membership?.serverAvatar ?? author?.avatar ?? null,
      authorRoleColor: membership?.serverRole?.color ?? null,
      authorRoleStyle: (membership?.serverRole?.style ?? 'solid') as string,
      authorStripePlan: author ? getEffectivePlan(author) : null,
      authorNameColor: author?.nameColor ?? null,
      authorNameFont: author?.nameFont ?? null,
      authorNameEffect: author?.nameEffect ?? null,
      authorAvatarEffect: author?.avatarEffect ?? null,
      authorBadges: author ? applyBadgePrefs(author) : [],
      replyTo: message.replyToMessageId && replyToMsg ? { id: replyToMsg.id, authorId: replyToMsg.authorId, authorUsername: replyToAuthor?.username ?? null, content: replyToMsg.content } : null,
      attachmentUrl: message.attachmentUrl ?? null,
      attachmentName: message.attachmentName ?? null,
      attachmentContentType: message.attachmentContentType ?? null,
      attachmentWidth: message.attachmentWidth ?? null,
      attachmentHeight: message.attachmentHeight ?? null,
      attachmentIsSpoiler: message.attachmentIsSpoiler,
      attachmentAlt: message.attachmentAlt ?? null,
    };
    const io = req.app.get('io') as import('socket.io').Server;
    if (io) {
      io.to(`channel:${channelId}`).emit('new-message', payload);

      const hasEveryoneMention = /@(everyone|here)\b/i.test(contentTrimmed);
      let skipMentionNotification = false;
      if (hasEveryoneMention) {
        const cooldownKey = `${channelId}:${req.userId}`;
        if (redis) {
          // Redis path: atomic SET NX with TTL for distributed @everyone cooldown
          const cdKey = `everyone-cd:${cooldownKey}`;
          const cdResult = await redis.set(cdKey, '1', 'PX', EVERYONE_COOLDOWN_MS, 'NX');
          if (cdResult !== 'OK') {
            skipMentionNotification = true;
          }
        } else {
          // In-memory fallback (single-instance mode)
          const lastMention = everyoneMentionCooldown.get(cooldownKey) || 0;
          if (Date.now() - lastMention < EVERYONE_COOLDOWN_MS) {
            skipMentionNotification = true;
          } else {
            cappedMapSet(everyoneMentionCooldown, cooldownKey, Date.now(), MAX_EVERYONE_COOLDOWN_ENTRIES);
          }
        }
      }

      if (!skipMentionNotification) {
        if (queuesEnabled) {
          enqueueNotification({
            type: 'mentions',
            serverId: channel.serverId,
            channelId,
            messageId: message.id,
            content: contentTrimmed,
            authorId: req.userId!,
          }).catch(() => {});
        } else {
          const hasEveryone = /@(everyone|here)\b/i.test(contentTrimmed);
          if (hasEveryone) {
            io.to(`server:${channel.serverId}`).emit('server-channel-activity', {
              serverId: channel.serverId,
              channelId,
              messageId: message.id,
              mentionUserIds: ['@everyone'],
            });

            // Inline notification creation (no queue)
            const authorName = payload.authorUsername ?? 'Someone';
            const preview = contentTrimmed.length > 200 ? contentTrimmed.slice(0, 200) + '…' : contentTrimmed;
            prisma.serverMember.findMany({ where: { serverId: channel.serverId }, select: { userId: true }, take: 5000 }).then(members => {
              const ids = members.map(m => m.userId).filter(uid => uid !== req.userId);
              if (ids.length === 0) return;
              const notifTitle = `${authorName} mentioned @everyone in #${channel.name ?? 'channel'}`;
              prisma.notification.createMany({
                data: ids.map(uid => ({
                  userId: uid, serverId: channel.serverId, channelId, type: 'everyone',
                  title: notifTitle, body: preview,
                  metadata: { messageId: message.id, authorId: req.userId, authorUsername: authorName, channelName: channel.name ?? 'channel' },
                })),
              }).catch(() => {});
              for (const uid of ids) {
                prisma.channelReadState.upsert({
                  where: { userId_channelId: { userId: uid, channelId } },
                  create: { userId: uid, channelId, mentionCount: 1 },
                  update: { mentionCount: { increment: 1 } },
                }).catch(() => {});
                io.to(`user:${uid}`).emit('notification-created', {
                  serverId: channel.serverId, channelId, type: 'everyone', title: notifTitle,
                  body: preview, metadata: { messageId: message.id }, createdAt: new Date().toISOString(),
                });
              }
            }).catch(() => {});
          } else {
            getMentionedUserIds(prisma, contentTrimmed, channel.serverId).then((mentionUserIds) => {
              const excludeAuthor = mentionUserIds.filter((id) => id !== req.userId);
              if (excludeAuthor.length > 0) {
                io.to(`server:${channel.serverId}`).emit('server-channel-activity', {
                  serverId: channel.serverId,
                  channelId,
                  messageId: message.id,
                  mentionUserIds: excludeAuthor,
                });

                // Inline notification creation (no queue)
                const authorName = payload.authorUsername ?? 'Someone';
                const preview = contentTrimmed.length > 200 ? contentTrimmed.slice(0, 200) + '…' : contentTrimmed;
                const notifTitle = `${authorName} mentioned you in #${channel.name ?? 'channel'}`;
                prisma.notification.createMany({
                  data: excludeAuthor.map(uid => ({
                    userId: uid, serverId: channel.serverId, channelId, type: 'mention',
                    title: notifTitle, body: preview,
                    metadata: { messageId: message.id, authorId: req.userId, authorUsername: authorName, channelName: channel.name ?? 'channel' },
                  })),
                }).catch(() => {});
                for (const uid of excludeAuthor) {
                  prisma.channelReadState.upsert({
                    where: { userId_channelId: { userId: uid, channelId } },
                    create: { userId: uid, channelId, mentionCount: 1 },
                    update: { mentionCount: { increment: 1 } },
                  }).catch(() => {});
                  io.to(`user:${uid}`).emit('notification-created', {
                    serverId: channel.serverId, channelId, type: 'mention', title: notifTitle,
                    body: preview, metadata: { messageId: message.id }, createdAt: new Date().toISOString(),
                  });
                }
              }
            });
          }
        }
      }
    }
    res.status(201).json(payload);
  } catch (err) {
    log.error({ err }, 'POST /api/messages/channels/:channelId error');
    next(err);
  }
});

// Reaction helpers

async function getGroupedReactions(messageId: string): Promise<Array<{ emoji: string; userIds: string[] }>> {
  const rows = await prisma.messageReaction.findMany({
    where: { messageId },
    select: { emoji: true, userId: true },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.emoji) ?? [];
    list.push(r.userId);
    map.set(r.emoji, list);
  }
  return Array.from(map.entries()).map(([emoji, userIds]) => ({ emoji, userIds }));
}

const reactionLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:reaction:'),
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  message: { error: 'Too many reactions. Slow down.' },
});

// PUT /api/messages/channels/:channelId/messages/:messageId/reactions — toggle reaction
router.put('/channels/:channelId/messages/:messageId/reactions', validateUuidParams('channelId', 'messageId'), authenticateToken, serverNotSuspendedByChannelId('channelId'), reactionLimiter, validate(reactMessageSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const channelId = getParam(req, 'channelId');
  const messageId = getParam(req, 'messageId');
  const { emoji } = req.body as { emoji: string };

  try {
    const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, serverId: true, isPrivate: true, categoryId: true } });
    if (!channel?.serverId) return res.status(404).json({ error: 'Channel not found' });

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId: channel.serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, channel.serverId),
    ]);
    if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });
    const [chOverrides, catOverrides] = await Promise.all([
      prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 200 }),
      channel.categoryId
        ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 200 })
        : Promise.resolve([]),
    ]);
    if (channel.isPrivate && !hasChannelPermission(permCtx,'viewChannels', chOverrides, catOverrides, undefined, { requireOverride: true })) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    if (!hasChannelPermission(permCtx,'addReactions', chOverrides, catOverrides)) return res.status(403).json({ error: 'You do not have permission to add reactions.' });

    const message = await prisma.message.findFirst({ where: { id: messageId, channelId } });
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const existing = await prisma.messageReaction.findUnique({
      where: { messageId_userId_emoji: { messageId, userId: req.userId, emoji } },
    });

    if (existing) {
      await prisma.messageReaction.delete({ where: { id: existing.id } });
    } else {
      const uniqueEmojis = await prisma.messageReaction.groupBy({ by: ['emoji'], where: { messageId } });
      if (uniqueEmojis.length >= 20 && !uniqueEmojis.some(g => g.emoji === emoji)) {
        return res.status(400).json({ error: 'Maximum of 20 unique emojis per message.' });
      }
      await prisma.messageReaction.create({ data: { messageId, userId: req.userId, emoji } });
    }

    const reactions = await getGroupedReactions(messageId);
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) io.to(`channel:${channelId}`).emit('message-reaction-update', { channelId, messageId, reactions });

    res.json({ reactions });
  } catch (err) {
    log.error({ err }, 'PUT reaction error');
    next(err);
  }
});

// Channel read state

const channelReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:ch-read:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const channelReadSchema = z.object({
  body: z.object({
    before: z.string().datetime().optional(),
  }).strict().optional(),
});

router.post('/channels/:channelId/read', validateUuidParams('channelId'), authenticateToken, channelReadLimiter, validate(channelReadSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const channelId = getParam(req, 'channelId');

  const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true } });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const member = await prisma.serverMember.findUnique({
    where: { userId_serverId: { userId: req.userId, serverId: channel.serverId } },
    select: { userId: true },
  });
  if (!member) return res.status(403).json({ error: 'Not a server member' });

  const before: string | undefined = req.body?.before;
  const readAt = before ? new Date(new Date(before).getTime() - 1) : new Date();

  await prisma.channelReadState.upsert({
    where: { userId_channelId: { userId: req.userId, channelId } },
    create: { userId: req.userId, channelId, lastReadAt: readAt, mentionCount: before ? undefined : 0 },
    update: { lastReadAt: readAt, ...(before ? {} : { mentionCount: 0 }) },
  });

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${req.userId}`).emit('channel-read-state', {
      channelId,
      lastReadAt: readAt.toISOString(),
      ...(before ? { markedUnread: true } : { mentionCount: 0 }),
    });
  }

  res.status(204).send();
}));

export default router;

