// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { searchMessagesSchema, searchDmMessagesSchema } from '../schemas.js';
import { logger } from '../logger.js';
import { hasPermission, getEffectivePlan, loadPermissionContext } from '../utils.js';
import { hasChannelPermission } from '../utils/channelPermissions.js';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { decryptMessageContent } from '../services/dmCrypto.js';
import { getClientIp } from '../utils/clientIp.js';
import { loadIsMinor, denyIfAgeGated } from '../utils/ageGate.js';

const log = logger.child({ module: 'search' });
const router = Router();

const searchLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:search:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many search requests. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const MAX_RESULTS = 50;

interface RawSearchRow {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  createdAt: Date;
  attachmentUrl: string | null;
  attachmentName: string | null;
  attachmentContentType: string | null;
  attachmentIsSpoiler: boolean;
  rank: number;
}

interface RawDmSearchRow {
  id: string;
  dmChannelId: string;
  authorId: string;
  content: string;
  contentIv: string | null;
  createdAt: Date;
  attachmentUrl: string | null;
  attachmentName: string | null;
  attachmentContentType: string | null;
  attachmentIsSpoiler: boolean;
  rank: number;
}

// GET /api/search/messages?q=...&serverId=...&channelId=...&authorId=...&has=...&before=...&after=...&offset=...&limit=...
router.get('/messages', authenticateToken, searchLimiter, validate(searchMessagesSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = ((req.query.q as string) || '').trim();
    const serverId = req.query.serverId as string | undefined;
    const channelId = req.query.channelId as string | undefined;
    const authorId = req.query.authorId as string | undefined;
    const has = req.query.has as string | undefined;
    const before = req.query.before as string | undefined;
    const after = req.query.after as string | undefined;
    const mentions = req.query.mentions as string | undefined;
    const pinned = req.query.pinned as string | undefined;
    const offset = Math.min(parseInt(req.query.offset as string) || 0, 1000);
    const limit = Math.min(parseInt(req.query.limit as string) || 25, MAX_RESULTS);

    // Require at least a text query or one filter
    if (!q && !authorId && !channelId && !has && !before && !after && !mentions && !pinned) {
      return res.json({ results: [], total: 0, hasMore: false });
    }

    // Cap deep pagination to avoid PostgreSQL scanning and discarding thousands of rows
    if (offset >= 1000) {
      return res.json({ results: [], total: 0, hasMore: false, hint: 'Search results are limited to the first 1000 matches. Try a more specific query.' });
    }

    // plainto_tsquery safely handles arbitrary user input without metacharacter injection
    const searchText = q.slice(0, 200);

    // Determine which channels the user has access to
    let accessibleChannelIds: string[] | null = null;
    if (serverId) {
      const [membership, permCtx, isMinor] = await Promise.all([
        prisma.serverMember.findUnique({
          where: { userId_serverId: { userId: req.userId!, serverId } },
          include: { serverRole: true },
        }),
        loadPermissionContext(req.userId!, serverId),
        loadIsMinor(req.userId!),
      ]);
      if (!membership || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });
      // Enforce readMessageHistory permission — matches the check in messages.ts GET route
      if (!hasPermission(permCtx, 'readMessageHistory')) {
        return res.status(403).json({ error: 'You do not have permission to search message history in this server' });
      }

      const channels = await prisma.channel.findMany({
        where: { serverId, type: 'text' },
        select: { id: true, isPrivate: true, categoryId: true, ageRestricted: true },
        take: 500,
      });
      // Drop age-gated channels for minors before any further filtering — a
      // search hit would otherwise surface message content + attachment URLs
      // from channels the user is not allowed to read.
      const visibleChannels = isMinor ? channels.filter((c) => !c.ageRestricted) : channels;
      accessibleChannelIds = visibleChannels.map(c => c.id);

      // Filter out private channels the user is denied access to via overrides
      const privateChannels = visibleChannels.filter(c => c.isPrivate);
      if (privateChannels.length > 0) {
        const privateChannelIds = privateChannels.map(c => c.id);
        const privateCategoryIds = [...new Set(privateChannels.map(c => c.categoryId).filter(Boolean))] as string[];
        const [chOverrides, catOverrides] = await Promise.all([
          prisma.channelPermissionOverride.findMany({ where: { channelId: { in: privateChannelIds } }, take: 5000 }),
          privateCategoryIds.length > 0
            ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: { in: privateCategoryIds } }, take: 5000 })
            : Promise.resolve([]),
        ]);
        const deniedChannelIds = new Set<string>();
        for (const ch of privateChannels) {
          const chOv = chOverrides.filter(o => o.channelId === ch.id);
          const catOv = ch.categoryId ? catOverrides.filter(o => o.categoryId === ch.categoryId) : [];
          if (!hasChannelPermission(permCtx, 'viewChannels', chOv, catOv)) {
            deniedChannelIds.add(ch.id);
          }
        }
        if (deniedChannelIds.size > 0) {
          accessibleChannelIds = accessibleChannelIds.filter(id => !deniedChannelIds.has(id));
        }
      }

      if (accessibleChannelIds.length === 0) return res.json({ results: [], total: 0, hasMore: false });
    } else if (channelId) {
      const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true, isPrivate: true, categoryId: true, ageRestricted: true } });
      if (channel) {
        const ageGateDenial = await denyIfAgeGated(channel, req.userId!);
        if (ageGateDenial) return res.status(403).json(ageGateDenial);
        const [membership, permCtx] = await Promise.all([
          prisma.serverMember.findUnique({
            where: { userId_serverId: { userId: req.userId!, serverId: channel.serverId } },
            include: { serverRole: true },
          }),
          loadPermissionContext(req.userId!, channel.serverId),
        ]);
        if (!membership || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });
        if (!hasPermission(permCtx, 'readMessageHistory')) {
          return res.status(403).json({ error: 'You do not have permission to search message history in this server' });
        }
        // Check channel-level permission overrides for private channels
        if (channel.isPrivate) {
          const [chOverrides, catOverrides] = await Promise.all([
            prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 200 }),
            channel.categoryId
              ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 200 })
              : Promise.resolve([]),
          ]);
          if (!hasChannelPermission(permCtx, 'viewChannels', chOverrides, catOverrides)) {
            return res.status(404).json({ error: 'Channel not found' });
          }
        }
      }
      accessibleChannelIds = [channelId];
    }

    if (!accessibleChannelIds) {
      return res.status(400).json({ error: 'serverId or channelId is required' });
    }

    // Build WHERE conditions using Prisma.sql for safe parameterization
    const conditions: Prisma.Sql[] = [
      Prisma.sql`m."channelId" = ANY(${accessibleChannelIds})`,
    ];

    // Only add FTS condition when there's a text query
    if (searchText) {
      conditions.push(Prisma.sql`m.search_vector @@ plainto_tsquery('english', ${searchText})`);
    }

    if (authorId) {
      conditions.push(Prisma.sql`m."authorId" = ${authorId}`);
    }

    if (has === 'file' || has === 'attachment') {
      conditions.push(Prisma.sql`m."attachmentUrl" IS NOT NULL`);
    } else if (has === 'image' || has === 'sticker') {
      conditions.push(Prisma.sql`m."attachmentContentType" LIKE 'image/%'`);
    } else if (has === 'video') {
      conditions.push(Prisma.sql`m."attachmentContentType" LIKE 'video/%'`);
    } else if (has === 'sound') {
      conditions.push(Prisma.sql`m."attachmentContentType" LIKE 'audio/%'`);
    } else if (has === 'link' || has === 'embed') {
      conditions.push(Prisma.sql`(m."content" LIKE '%http://%' OR m."content" LIKE '%https://%')`);
    }

    if (before) {
      conditions.push(Prisma.sql`m."createdAt" < ${new Date(before)}`);
    }

    if (after) {
      conditions.push(Prisma.sql`m."createdAt" > ${new Date(after)}`);
    }

    if (mentions) {
      const mentionedUser = await prisma.user.findUnique({
        where: { id: mentions },
        select: { username: true },
      });
      if (mentionedUser) {
        conditions.push(Prisma.sql`m."content" LIKE '%@' || ${mentionedUser.username} || '%'`);
      }
    }

    if (pinned === 'true') {
      conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "ChannelPinnedMessage" cp WHERE cp."messageId" = m."id")`);
    } else if (pinned === 'false') {
      conditions.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "ChannelPinnedMessage" cp WHERE cp."messageId" = m."id")`);
    }

    const whereClause = Prisma.join(conditions, ' AND ');

    // Fetch one extra row to determine hasMore (avoids expensive COUNT)
    const fetchLimit = limit + 1;

    // Use ts_rank ordering when there's a text query, otherwise just sort by date
    const rows = searchText
      ? await prisma.$queryRaw<RawSearchRow[]>(
          Prisma.sql`
           SELECT m.id, m."channelId", m."authorId", m.content, m."createdAt",
                  m."attachmentUrl", m."attachmentName", m."attachmentContentType",
                  m."attachmentIsSpoiler",
                  ts_rank(m.search_vector, plainto_tsquery('english', ${searchText})) as rank
           FROM "Message" m
           WHERE ${whereClause}
           ORDER BY rank DESC, m."createdAt" DESC
           LIMIT ${fetchLimit} OFFSET ${offset}
          `
        )
      : await prisma.$queryRaw<RawSearchRow[]>(
          Prisma.sql`
           SELECT m.id, m."channelId", m."authorId", m.content, m."createdAt",
                  m."attachmentUrl", m."attachmentName", m."attachmentContentType",
                  m."attachmentIsSpoiler",
                  0 as rank
           FROM "Message" m
           WHERE ${whereClause}
           ORDER BY m."createdAt" DESC
           LIMIT ${fetchLimit} OFFSET ${offset}
          `
        );

    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;

    // Enrich with author and channel info
    const authorIds = [...new Set(trimmed.map(r => r.authorId))];
    const channelIds = [...new Set(trimmed.map(r => r.channelId))];

    const [authors, channels] = await Promise.all([
      authorIds.length ? prisma.user.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, username: true, discriminator: true, avatar: true, nameColor: true, nameFont: true, nameEffect: true, avatarEffect: true, stripePlan: true, stripeStatus: true, stripePeriodEnd: true },
      }) : [],
      channelIds.length ? prisma.channel.findMany({
        where: { id: { in: channelIds } },
        select: { id: true, name: true, serverId: true },
      }) : [],
    ]);

    const authorMap = Object.fromEntries(authors.map(a => [a.id, a]));
    const channelMap = Object.fromEntries(channels.map(c => [c.id, c]));

    const results = trimmed.map(r => {
      const author = authorMap[r.authorId];
      const plan = author ? getEffectivePlan(author) : 'free';
      const channel = channelMap[r.channelId];
      return {
        id: r.id,
        channelId: r.channelId,
        channelName: channel?.name ?? null,
        serverId: channel?.serverId ?? null,
        authorId: r.authorId,
        authorUsername: author?.username ?? null,
        authorAvatar: author?.avatar ?? null,
        authorNameColor: plan === 'pro' ? (author?.nameColor ?? null) : null,
        authorNameFont: plan === 'pro' ? (author?.nameFont ?? null) : null,
        authorNameEffect: plan === 'pro' ? (author?.nameEffect ?? null) : null,
        authorAvatarEffect: plan === 'pro' ? (author?.avatarEffect ?? null) : null,
        authorEffectivePlan: plan,
        content: r.content,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
        attachmentUrl: r.attachmentUrl,
        attachmentName: r.attachmentName,
        attachmentIsSpoiler: r.attachmentIsSpoiler,
      };
    });

    res.json({ results, total: 0, hasMore });
  } catch (err) {
    log.error({ err }, 'search error');
    next(err);
  }
});

// GET /api/search/dm-messages?q=...&dmChannelId=...&authorId=...&offset=...&limit=...
router.get('/dm-messages', authenticateToken, searchLimiter, validate(searchDmMessagesSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = ((req.query.q as string) || '').trim();
    const dmChannelId = req.query.dmChannelId as string;
    const authorId = req.query.authorId as string | undefined;
    const has = req.query.has as string | undefined;
    const before = req.query.before as string | undefined;
    const after = req.query.after as string | undefined;
    const mentions = req.query.mentions as string | undefined;
    const pinned = req.query.pinned as string | undefined;
    const offset = Math.min(parseInt(req.query.offset as string) || 0, 1000);
    const limit = Math.min(parseInt(req.query.limit as string) || 25, MAX_RESULTS);

    // Require at least a text query or one filter
    if (!q && !authorId && !has && !before && !after && !mentions && !pinned) {
      return res.json({ results: [], total: 0, hasMore: false });
    }

    // Cap deep pagination to avoid PostgreSQL scanning and discarding thousands of rows
    if (offset >= 1000) {
      return res.json({ results: [], total: 0, hasMore: false, hint: 'Search results are limited to the first 1000 matches. Try a more specific query.' });
    }

    // Verify user is a participant and check encryption status
    const [participant, dmChannel] = await Promise.all([
      prisma.dMParticipant.findUnique({
        where: { userId_dmChannelId: { userId: req.userId!, dmChannelId } },
      }),
      prisma.dMChannel.findUnique({ where: { id: dmChannelId }, select: { encrypted: true } }),
    ]);
    if (!participant) return res.status(403).json({ error: 'Not a participant in this DM' });

    // Server-side full-text search cannot work on encrypted content — return early
    if (dmChannel?.encrypted) {
      return res.json({ results: [], total: 0, hasMore: false, encrypted: true });
    }

    const searchText = q.slice(0, 200);

    const conditions: Prisma.Sql[] = [
      Prisma.sql`m."dmChannelId" = ${dmChannelId}`,
    ];

    // Only add FTS condition when there's a text query
    if (searchText) {
      conditions.push(Prisma.sql`m.search_vector @@ plainto_tsquery('english', ${searchText})`);
    }

    if (authorId) {
      conditions.push(Prisma.sql`m."authorId" = ${authorId}`);
    }

    if (has === 'file' || has === 'attachment') {
      conditions.push(Prisma.sql`m."attachmentUrl" IS NOT NULL`);
    } else if (has === 'image' || has === 'sticker') {
      conditions.push(Prisma.sql`m."attachmentContentType" LIKE 'image/%'`);
    } else if (has === 'video') {
      conditions.push(Prisma.sql`m."attachmentContentType" LIKE 'video/%'`);
    } else if (has === 'sound') {
      conditions.push(Prisma.sql`m."attachmentContentType" LIKE 'audio/%'`);
    } else if (has === 'link' || has === 'embed') {
      conditions.push(Prisma.sql`(m."content" LIKE '%http://%' OR m."content" LIKE '%https://%')`);
    }

    if (before) {
      conditions.push(Prisma.sql`m."createdAt" < ${new Date(before)}`);
    }

    if (after) {
      conditions.push(Prisma.sql`m."createdAt" > ${new Date(after)}`);
    }

    if (mentions) {
      const mentionedUser = await prisma.user.findUnique({
        where: { id: mentions },
        select: { username: true },
      });
      if (mentionedUser) {
        conditions.push(Prisma.sql`m."content" LIKE '%@' || ${mentionedUser.username} || '%'`);
      }
    }

    if (pinned === 'true') {
      conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "DMPinnedMessage" dp WHERE dp."messageId" = m."id")`);
    } else if (pinned === 'false') {
      conditions.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "DMPinnedMessage" dp WHERE dp."messageId" = m."id")`);
    }

    const whereClause = Prisma.join(conditions, ' AND ');

    // Fetch one extra row to determine hasMore (avoids expensive COUNT)
    const effectiveLimit = (typeof limit === 'number' ? limit : 25);
    const fetchLimit = effectiveLimit + 1;

    // Use ts_rank ordering when there's a text query, otherwise just sort by date
    const rows = searchText
      ? await prisma.$queryRaw<RawDmSearchRow[]>(
          Prisma.sql`
           SELECT m.id, m."dmChannelId", m."authorId", m.content, m."contentIv", m."createdAt",
                  m."attachmentUrl", m."attachmentName", m."attachmentContentType",
                  m."attachmentIsSpoiler",
                  ts_rank(m.search_vector, plainto_tsquery('english', ${searchText})) as rank
           FROM "DMMessage" m
           WHERE ${whereClause}
           ORDER BY rank DESC, m."createdAt" DESC
           LIMIT ${fetchLimit} OFFSET ${offset}
          `
        )
      : await prisma.$queryRaw<RawDmSearchRow[]>(
          Prisma.sql`
           SELECT m.id, m."dmChannelId", m."authorId", m.content, m."contentIv", m."createdAt",
                  m."attachmentUrl", m."attachmentName", m."attachmentContentType",
                  m."attachmentIsSpoiler",
                  0 as rank
           FROM "DMMessage" m
           WHERE ${whereClause}
           ORDER BY m."createdAt" DESC
           LIMIT ${fetchLimit} OFFSET ${offset}
          `
        );

    const hasMore = rows.length > effectiveLimit;
    const trimmed = hasMore ? rows.slice(0, effectiveLimit) : rows;

    const authorIds = [...new Set(trimmed.map(r => r.authorId))];
    const authors = authorIds.length ? await prisma.user.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, username: true, discriminator: true, avatar: true, nameColor: true, nameFont: true, nameEffect: true, avatarEffect: true, stripePlan: true, stripeStatus: true, stripePeriodEnd: true },
    }) : [];
    const authorMap = Object.fromEntries(authors.map(a => [a.id, a]));

    const results = trimmed.map(r => {
      const author = authorMap[r.authorId];
      const plan = author ? getEffectivePlan(author) : 'free';
      return {
        id: r.id,
        dmChannelId: r.dmChannelId,
        authorId: r.authorId,
        authorUsername: author?.username ?? null,
        authorAvatar: author?.avatar ?? null,
        authorNameColor: plan === 'pro' ? (author?.nameColor ?? null) : null,
        authorNameFont: plan === 'pro' ? (author?.nameFont ?? null) : null,
        authorNameEffect: plan === 'pro' ? (author?.nameEffect ?? null) : null,
        authorAvatarEffect: plan === 'pro' ? (author?.avatarEffect ?? null) : null,
        authorEffectivePlan: plan,
        content: decryptMessageContent(r),
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
        attachmentUrl: r.attachmentUrl,
        attachmentName: r.attachmentName,
        attachmentIsSpoiler: r.attachmentIsSpoiler,
      };
    });

    res.json({ results, total: 0, hasMore });
  } catch (err) {
    log.error({ err }, 'dm search error');
    next(err);
  }
});

export default router;
