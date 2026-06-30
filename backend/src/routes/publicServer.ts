// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Public (unauthenticated) server profile JSON endpoint.
 *
 *   GET /api/v1/public/server/:vanityOrId
 *
 * Returns a redacted public profile for any server that has opted in to
 * community discovery. Used by the SPA's `/s/:vanity` page (after the SSR
 * shell loads), and by external integrations / unfurlers that prefer JSON
 * over scraping the HTML.
 *
 * Eligibility (must ALL be true; any failure → 404):
 *   - settings.communityEnabled = true
 *   - settings.discoveryEnabled = true
 *   - server.hiddenFromDiscovery = false  (read defensively; a missing
 *     column is treated as false)
 *   - server.suspendedAt IS NULL
 *   (nsfwLevel check removed — Channel.ageRestricted is the only
 *     NSFW concept; discovery × age-restricted are mutually exclusive)
 *
 * Response is intentionally minimal: identity, branding, member counts,
 * tags/category/language, rules. No member list, no channel list, no owner
 * id, no invite codes, nothing privileged.
 *
 * Cache: 5 minute private + 15 minute shared. Anonymous, GET-only, IP-rate-
 * limited via the shared Redis-backed `createRateLimitStore()`.
 */

import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../db.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { authenticateToken, AuthRequest, JWT_SECRET } from '../middleware/auth.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { isPubliclyDiscoverable } from '../utils/communityEligibility.js';
import { computeMyPermissions, getEffectivePlan, loadPermissionContext } from '../utils.js';
import { filterVisibleChannelIds } from '../utils/channelVisibility.js';
import { loadIsMinor } from '../utils/ageGate.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';
import { invalidatePermissionContext } from '../redis.js';
import { applyAutoAssignRoles, postJoinWelcomeMessage } from '../utils/joinWelcome.js';

const MAX_SERVERS_FREE = 100;
const MAX_SERVERS_PRO = 200;

// Permissive auth middleware: if a valid Bearer token is present, set
// `req.userId` so the handler can selectively relax the anon-only mature
// filter for the requesting adult user. Missing/malformed tokens are simply
// treated as anonymous — never reject the request here, this endpoint must
// stay anon-accessible for SEO / share-link previews.
function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const header = req.headers['authorization'];
  const token = header && header.split(' ')[1];
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { userId?: string; purpose?: string };
    if (decoded?.userId && !decoded.purpose) {
      req.userId = decoded.userId;
    }
  } catch { /* swallow — treat as anonymous */ }
  next();
}

const router = Router();

const publicServerLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:public-server:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests.' },
  keyGenerator: (req) => getClientIp(req) ?? 'anonymous',
});

const publicServerParamSchema = z.object({
  params: z
    .object({
      // Loose at the schema layer; route handler decides UUID vs vanity at
      // resolve time. 1..64 covers UUIDs (36) and vanity (≤32) with slack.
      vanityOrId: z.string().min(1).max(64),
    })
    .strict(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VANITY_RE = /^[a-z0-9](?:[a-z0-9-]){1,30}[a-z0-9]$/;

const NOT_FOUND = { error: 'Not found' } as const;

/**
 * Optional Server columns (`featured`, `verified`, `hiddenFromDiscovery`)
 * are read defensively — if the column is missing the field is `undefined` and
 * we coerce to a safe default. This keeps the route forward-compatible while
 * the migration lands.
 */
type DefensiveServerExtras = {
  featured?: boolean | null;
  verified?: boolean | null;
  hiddenFromDiscovery?: boolean | null;
};

router.get(
  '/server/:vanityOrId',
  publicServerLimiter,
  optionalAuth,
  validate(publicServerParamSchema),
  asyncHandler(async (req: AuthRequest, res) => {
    const raw = String(req.params.vanityOrId ?? '').trim();
    if (!raw) return res.status(404).json(NOT_FOUND);

    const lower = raw.toLowerCase();
    let server: Awaited<ReturnType<typeof prisma.server.findFirst>> | null = null;

    // Resolve by exact vanityUrl first. Vanity is canonically lowercase, so
    // this both matches Discord's behaviour and avoids leaking case-sensitive
    // collisions.
    if (VANITY_RE.test(lower)) {
      server = await prisma.server.findUnique({ where: { vanityUrl: lower } });
    }
    // Fall back to UUID lookup. This is intentional: a server with a vanity
    // is still reachable by its UUID (e.g. for share links generated before
    // the owner claimed a vanity).
    if (!server && UUID_RE.test(raw)) {
      server = await prisma.server.findUnique({ where: { id: raw } });
    }

    if (!server) return res.status(404).json(NOT_FOUND);

    const settings = await prisma.serverSettings.findUnique({
      where: { serverId: server.id },
    });
    if (!settings) return res.status(404).json(NOT_FOUND);

    // Eligibility — check the server exists + is publicly discoverable.
    // Channel.ageRestricted is the only NSFW concept. Discovery ×
    // age-restricted are enforced at the toggle level, so anything in
    // discovery is uniform.
    const extras = server as typeof server & DefensiveServerExtras;
    const baseEligible = isPubliclyDiscoverable(
      {
        suspendedAt: server.suspendedAt,
        hiddenFromDiscovery: extras.hiddenFromDiscovery ?? false,
      },
      settings,
    );
    if (!baseEligible) {
      return res.status(404).json(NOT_FOUND);
    }

    // Counts in parallel — both bounded by the indexed `serverId` column.
    const [memberCount, onlineCount] = await Promise.all([
      prisma.serverMember.count({ where: { serverId: server.id } }),
      prisma.serverMember.count({
        where: { serverId: server.id, user: { status: { not: 'offline' } } },
      }),
    ]);

    // Tags / rules are stored as JSON arrays. Cap and coerce for safety —
    // anything not a non-empty string gets dropped, the array is capped at
    // 5 (tags) or 10 (rules), and each entry is trimmed.
    const tags = Array.isArray(settings.tags)
      ? (settings.tags as unknown[])
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          .map((t) => t.trim().slice(0, 32))
          .slice(0, 5)
      : [];
    const rules = Array.isArray(settings.rules)
      ? (settings.rules as unknown[])
          .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
          .map((r) => r.trim().slice(0, 1024))
          .slice(0, 10)
      : [];

    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900');
    res.removeHeader('Pragma');

    return res.json({
      id: server.id,
      vanityUrl: server.vanityUrl ?? null,
      name: server.name,
      icon: server.icon ?? null,
      banner: server.banner ?? null,
      bannerSplash: settings.bannerSplash ?? null,
      longDescription: settings.longDescription ?? null,
      description: settings.description ?? null,
      category: settings.category ?? null,
      subcategory: settings.subcategory ?? null,
      tags,
      language: settings.language ?? null,
      memberCount,
      onlineCount,
      verified: extras.verified === true,
      featured: extras.featured === true,
      joinMethod: settings.joinMethod ?? 'invite_only',
      rules,
    });
  }),
);

// POST /server/:vanityOrId/join — direct join from the public profile
//
// Lets an authenticated user join a discoverable community server without
// needing an invite code. Mirrors the gate ordering of routes/invites.ts so
// owners can rely on the same policy regardless of whether members arrive
// via a private invite, an apply-to-join queue, or the public discovery
// page. Only fires for `joinMethod === 'discoverable'` — invite-only and
// apply-to-join servers refuse this entry path.
const publicJoinLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:public-join:'),
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many join attempts. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

router.post(
  '/server/:vanityOrId/join',
  authenticateToken,
  publicJoinLimiter,
  validate(publicServerParamSchema),
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const raw = String(req.params.vanityOrId ?? '').trim();
    if (!raw) return res.status(404).json(NOT_FOUND);

    const lower = raw.toLowerCase();
    let server: Awaited<ReturnType<typeof prisma.server.findFirst>> | null = null;
    if (VANITY_RE.test(lower)) {
      server = await prisma.server.findUnique({ where: { vanityUrl: lower } });
    }
    if (!server && UUID_RE.test(raw)) {
      server = await prisma.server.findUnique({ where: { id: raw } });
    }
    if (!server) return res.status(404).json(NOT_FOUND);

    const settings = await prisma.serverSettings.findUnique({ where: { serverId: server.id } });
    if (!settings) return res.status(404).json(NOT_FOUND);

    const extras = server as typeof server & DefensiveServerExtras;
    const baseEligible = isPubliclyDiscoverable(
      {
        suspendedAt: server.suspendedAt,
        hiddenFromDiscovery: extras.hiddenFromDiscovery ?? false,
      },
      settings,
    );
    if (!baseEligible) {
      return res.status(404).json(NOT_FOUND);
    }

    if (settings.joinMethod !== 'discoverable') {
      return res.status(409).json({
        error: 'join_method_mismatch',
        joinMethod: settings.joinMethod,
        message:
          settings.joinMethod === 'apply_to_join'
            ? 'This server requires an application to join.'
            : 'This server is invite-only.',
      });
    }

    const [ban, familyRestriction] = await Promise.all([
      prisma.serverBan.findUnique({
        where: { serverId_userId: { serverId: server.id, userId: req.userId } },
      }),
      prisma.familyRestriction.findFirst({
        where: { familyLink: { childId: req.userId, status: 'active' }, blockServerJoin: true },
      }),
    ]);
    if (ban) return res.status(403).json({ error: 'You are banned from this server.' });
    if (familyRestriction) {
      return res.status(403).json({ error: 'A parent account has restricted you from joining new servers.' });
    }

    const [serverCount, joiner] = await Promise.all([
      prisma.serverMember.count({ where: { userId: req.userId } }),
      prisma.user.findUnique({
        where: { id: req.userId },
        select: {
          id: true,
          createdAt: true,
          username: true,
          discriminator: true,
          avatar: true,
          status: true,
          emailVerified: true,
          dateOfBirth: true,
          stripePlan: true,
          stripeStatus: true,
          stripePeriodEnd: true,
          stripeSubscriptionId: true,
        },
      }),
    ]);
    if (!joiner) return res.status(401).json({ error: 'Missing user' });
    const joinerPlan = getEffectivePlan(joiner);
    const serverLimit = joinerPlan === 'essential' || joinerPlan === 'pro' ? MAX_SERVERS_PRO : MAX_SERVERS_FREE;
    if (serverCount >= serverLimit) {
      return res.status(403).json({
        error: `You've reached the maximum of ${serverLimit} servers. ${
          serverLimit === MAX_SERVERS_FREE ? 'Upgrade to Howl Pro to join up to 200 servers.' : ''
        }`,
      });
    }

    // Already a member → idempotent return of the server view.
    const existingCtx = await loadPermissionContext(req.userId, server.id);
    if (existingCtx) {
      const channels = await prisma.channel.findMany({
        where: { serverId: server.id, isPrivate: false },
        select: { id: true, name: true, description: true, type: true, categoryId: true, position: true },
        orderBy: { createdAt: 'asc' },
        take: 1000,
      });
      return res.status(200).json({
        id: server.id,
        name: server.name,
        icon: server.icon ?? undefined,
        banner: server.banner ?? undefined,
        myRole: existingCtx.member.role?.toLowerCase() === 'owner' ? 'owner' : 'member',
        myPermissions: computeMyPermissions(existingCtx),
        channels,
      });
    }

    const level = settings.verificationLevel;
    if (level !== 'none') {
      if ((level === 'low' || level === 'medium' || level === 'high') && !joiner.emailVerified) {
        return res.status(403).json({ error: 'You must have a verified email to join this server.' });
      }
      if (level === 'medium' || level === 'high') {
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
        if (joiner.createdAt > fiveMinAgo) {
          return res.status(403).json({ error: 'Your account must be at least 5 minutes old to join this server.' });
        }
      }
      if (level === 'high') {
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
        if (joiner.createdAt > tenMinAgo) {
          return res.status(403).json({ error: 'Your account must be at least 10 minutes old to join this server.' });
        }
      }
    }

    const memberRole = await prisma.serverRole.findFirst({
      where: { serverId: server.id, name: 'Member', isEveryone: false },
    });
    await prisma.serverMember.upsert({
      where: { userId_serverId: { userId: req.userId, serverId: server.id } },
      create: {
        userId: req.userId,
        serverId: server.id,
        role: 'member',
        roleId: memberRole?.id ?? undefined,
      },
      update: {},
    });
    if (memberRole) {
      await prisma.memberRole.upsert({
        where: {
          userId_serverId_roleId: { userId: req.userId, serverId: server.id, roleId: memberRole.id },
        },
        create: { userId: req.userId, serverId: server.id, roleId: memberRole.id },
        update: {},
      });
    }
    // Drop any stale entry from a prior membership before re-reading the
    // now-current context (which seeds the cache on miss).
    await invalidatePermissionContext(server.id, req.userId);

    // Grant any configured auto-assign roles + recompute the member's display
    // role, mirroring the invite-join path. Runs before the display role is
    // re-read for the `server-member-joined` emit below.
    await applyAutoAssignRoles(server.id, req.userId);

    // Re-read the recomputed display role for the emit (auto-assign may have
    // hoisted a different role than the default 'Member').
    const joinedMember = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId: server.id } },
      include: { serverRole: { select: { name: true, color: true } } },
    });

    const joinedCtx = await loadPermissionContext(req.userId, server.id);
    const joinPerms = joinedCtx ? computeMyPermissions(joinedCtx) : {};

    const visibleChannels = await prisma.channel.findMany({
      where: { serverId: server.id, isPrivate: false },
      select: { id: true, name: true, description: true, type: true, categoryId: true, position: true, isPrivate: true, ageRestricted: true },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io && joinedCtx) {
      io.in(`user:${req.userId}`).socketsJoin(`server:${server.id}`);
      const isMinor = await loadIsMinor(req.userId);
      const visibleIds = await filterVisibleChannelIds(joinedCtx, visibleChannels.filter((c) => c.type === 'text' || c.type === 'stage' || c.type === 'forum'), { isMinor });
      for (const id of visibleIds) {
        io.in(`user:${req.userId}`).socketsJoin(`channel:${id}`);
      }
      io.to(`server:${server.id}`).emit('server-member-joined', {
        serverId: server.id,
        user: {
          id: joiner.id,
          username: joiner.username,
          discriminator: joiner.discriminator,
          avatar: joiner.avatar ?? undefined,
          status: joiner.status ?? 'online',
        },
        role: joinedMember?.serverRole?.name ?? 'member',
        roleColor: joinedMember?.serverRole?.color ?? undefined,
      });
    }

    // Welcome message (runs regardless of io/joinedCtx).
    await postJoinWelcomeMessage(server.id, { id: joiner.id, username: joiner.username }, io);

    return res.status(200).json({
      id: server.id,
      name: server.name,
      icon: server.icon ?? undefined,
      banner: server.banner ?? undefined,
      myRole: memberRole?.name ?? 'member',
      myPermissions: joinPerms,
      channels: visibleChannels,
    });
  }),
);

router.use((err: unknown, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
  logger.error({ err, route: 'publicServer' }, 'publicServer route error');
  res.status(500).json({ error: 'Internal server error' });
});

export default router;
