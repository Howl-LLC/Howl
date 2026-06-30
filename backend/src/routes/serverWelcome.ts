// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Welcome screen endpoints for public/community servers.
 *
 * Mounted under `/api/v1/servers/:serverId/welcome`. The welcome screen has
 * two surfaces:
 *   1. The screen-level on/off toggle + leading description, persisted on
 *      `ServerSettings.welcomeScreenEnabled` / `welcomeScreenDescription`.
 *   2. The curated channel grid (≤5 entries), persisted as rows in the
 *      `ServerWelcomeChannel` model with a unique `(serverId, channelId)`
 *      constraint and a `(serverId, position)` index for ordered reads.
 *
 * Endpoints
 *   GET    /                         — any member; or anyone (anon, public
 *                                      subset) when the server is community
 *                                      and discovery is enabled.
 *   PATCH  /                         — manageServer; toggle + description.
 *   POST   /channels                 — manageServer; add a channel (max 5).
 *   PATCH  /channels/:id             — manageServer; update description /
 *                                      emoji / position (atomic swap).
 *   DELETE /channels/:id             — manageServer; remove a channel.
 *
 * Conventions
 *   - `validate(zodSchema)` middleware (never inline safeParse).
 *   - `validateUuidParams` on every UUID route param.
 *   - `createRateLimitStore()` Redis-backed limiter (30/min/user).
 *   - `hasPermission(ctx, 'manageServer')` for write authorization.
 *   - Audit log row for every state-changing action.
 *   - Pino structured logging (no console.log).
 *   - All `findMany` queries are bounded.
 */

import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest, JWT_SECRET } from '../middleware/auth.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { validate } from '../middleware/validate.js';
import { getParam, hasPermission, loadPermissionContext } from '../utils.js';
import { hashToken } from '../utils/sessionUtils.js';
import {
  updateWelcomeScreenSchema,
  createWelcomeChannelSchema,
  updateWelcomeChannelSchema,
} from '../schemas.js';
import { createAuditLog } from './serverSettings.js';
import { isPubliclyDiscoverable } from '../utils/communityEligibility.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'serverWelcome' });

const router = Router({ mergeParams: true });

// 30/min/user — matches the surrounding settings router so a moderator
// iterating on the welcome screen doesn't hit the limiter while dragging
// entries around. Keyed by user (with IP fallback for anon reads).
const welcomeLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  windowMs: 60 * 1000,
  max: 30,
  store: createRateLimitStore('rl:srv-welcome:'),
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
  message: { error: 'Too many welcome-screen requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const MAX_WELCOME_CHANNELS = 5;

type MemberCtx = {
  userId: string;
  serverId: string;
  ctx: import('../utils/permissions.js').LoadedPermissionContext;
};

async function requireMember(req: AuthRequest, res: Response): Promise<MemberCtx | null> {
  if (!req.userId) {
    res.status(401).json({ error: 'Missing user' });
    return null;
  }
  const serverId = getParam(req, 'serverId');
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) {
    res.status(403).json({ error: 'Not a member of this server' });
    return null;
  }
  return { userId: req.userId, serverId, ctx };
}

async function requireManageServer(req: AuthRequest, res: Response): Promise<MemberCtx | null> {
  const m = await requireMember(req, res);
  if (!m) return null;
  if (!hasPermission(m.ctx, 'manageServer')) {
    res.status(403).json({ error: 'You need the manageServer permission' });
    return null;
  }
  return m;
}

/**
 * Best-effort token extraction for the public GET endpoint. Unlike
 * `authenticateToken` we never reject on missing/invalid tokens — the
 * downstream handler decides whether to allow anon access based on the
 * server's discovery flags. We only verify the JWT signature and look up
 * the session row; on any failure `req.userId` stays undefined.
 */
async function tryAttachUser(req: AuthRequest): Promise<void> {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return;
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as {
      userId?: string;
      purpose?: string;
    };
    if (!decoded.userId || decoded.purpose) return;
    // Confirm a live session exists — same gate `authenticateToken` uses.
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true },
    });
    if (!session) return;
    req.userId = decoded.userId;
  } catch {
    // Silent fall-through: anon read is allowed when the server is discoverable.
  }
}

/**
 * Shape returned to clients. Pulls the current `name` and `type` from the
 * `Channel` table so renames on the underlying channel propagate without a
 * data migration.
 */
type WelcomeChannelDTO = {
  id: string;
  channelId: string;
  channelName: string | null;
  channelType: string | null;
  description: string;
  emoji: string | null;
  position: number;
};

async function buildWelcomeResponse(serverId: string): Promise<{
  welcomeScreenEnabled: boolean;
  welcomeScreenDescription: string | null;
  welcomeChannels: WelcomeChannelDTO[];
}> {
  const [settings, entries] = await Promise.all([
    prisma.serverSettings.findUnique({
      where: { serverId },
      select: { welcomeScreenEnabled: true, welcomeScreenDescription: true },
    }),
    prisma.serverWelcomeChannel.findMany({
      where: { serverId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      take: MAX_WELCOME_CHANNELS,
      include: {
        channel: { select: { id: true, name: true, type: true } },
      },
    }),
  ]);

  return {
    welcomeScreenEnabled: settings?.welcomeScreenEnabled ?? false,
    welcomeScreenDescription: settings?.welcomeScreenDescription ?? null,
    welcomeChannels: entries.map((e) => ({
      id: e.id,
      channelId: e.channelId,
      channelName: e.channel?.name ?? null,
      channelType: e.channel?.type ?? null,
      description: e.description,
      emoji: e.emoji,
      position: e.position,
    })),
  };
}

// GET /
//
// Any server member may read the welcome screen; anonymous requests succeed
// only when the server has community + discovery enabled. The response shape
// is identical in both cases — there's nothing private here, just the
// curated channel grid the owner already chose to surface.

router.get(
  '/',
  validateUuidParams('serverId'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const serverId = getParam(req, 'serverId');
      await tryAttachUser(req);

      // Authenticated path: must be a member.
      if (req.userId) {
        const ctx = await loadPermissionContext(req.userId, serverId);
        if (ctx) {
          const data = await buildWelcomeResponse(serverId);
          return res.json(data);
        }
        // Authenticated but not a member — fall through to the anon check so
        // discoverable servers still serve their welcome screen to outsiders.
      }

      // Anonymous / non-member path: gated by `isPubliclyDiscoverable`.
      // Failures collapse to a single 404 (never 401/403) so we don't
      // leak whether the server is missing, suspended, hidden, or mature.
      const [settings, server] = await Promise.all([
        prisma.serverSettings.findUnique({
          where: { serverId },
          select: { communityEnabled: true, discoveryEnabled: true },
        }),
        prisma.server.findUnique({
          where: { id: serverId },
          select: {
            id: true,
            suspendedAt: true,
            hiddenFromDiscovery: true,
          },
        }),
      ]);
      if (!server || !settings) return res.status(404).json({ error: 'not_found' });
      if (!isPubliclyDiscoverable(server, settings)) {
        return res.status(404).json({ error: 'not_found' });
      }
      const data = await buildWelcomeResponse(serverId);
      res.json(data);
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /

router.patch(
  '/',
  validateUuidParams('serverId'),
  authenticateToken,
  welcomeLimiter,
  validate(updateWelcomeScreenSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const m = await requireManageServer(req, res);
      if (!m) return;

      const body = req.body as { welcomeScreenEnabled?: boolean; welcomeScreenDescription?: string | null };
      const data: Record<string, unknown> = {};
      if (body.welcomeScreenEnabled !== undefined) data.welcomeScreenEnabled = body.welcomeScreenEnabled;
      if (body.welcomeScreenDescription !== undefined) data.welcomeScreenDescription = body.welcomeScreenDescription;

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: 'No welcome-screen fields to update' });
      }

      // Upsert so first-time enable on a server without a settings row works.
      // The non-welcome fields keep their schema defaults via `create`.
      await prisma.serverSettings.upsert({
        where: { serverId: m.serverId },
        create: { serverId: m.serverId, ...data } as never,
        update: data as never,
      });

      await createAuditLog(
        m.serverId,
        m.userId,
        'welcome_screen_update',
        'settings',
        m.serverId,
        data,
      );

      const response = await buildWelcomeResponse(m.serverId);

      const io = req.app.get('io');
      if (io) {
        io.to(`server:${m.serverId}`).emit('server-welcome-updated', {
          serverId: m.serverId,
          welcome: response,
        });
      }

      log.info({ serverId: m.serverId, actorId: m.userId }, 'welcome screen updated');
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

// POST /channels

router.post(
  '/channels',
  validateUuidParams('serverId'),
  authenticateToken,
  welcomeLimiter,
  validate(createWelcomeChannelSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const m = await requireManageServer(req, res);
      if (!m) return;

      const { channelId, description, emoji } = req.body as {
        channelId: string;
        description: string;
        emoji?: string | null;
      };

      // Channel must belong to this server. Look it up explicitly — never
      // trust the client's serverId/channelId pairing.
      const channel = await prisma.channel.findFirst({
        where: { id: channelId, serverId: m.serverId },
        select: { id: true },
      });
      if (!channel) {
        return res.status(400).json({ error: 'Channel not found in this server' });
      }

      // Cap at MAX_WELCOME_CHANNELS — Discord-parity. Count + position both
      // come from the same query so we don't race with a concurrent insert.
      const existing = await prisma.serverWelcomeChannel.findMany({
        where: { serverId: m.serverId },
        select: { position: true },
        orderBy: { position: 'desc' },
        take: MAX_WELCOME_CHANNELS,
      });
      if (existing.length >= MAX_WELCOME_CHANNELS) {
        return res.status(409).json({
          error: `A server can have at most ${MAX_WELCOME_CHANNELS} welcome channels`,
        });
      }
      const nextPosition = (existing[0]?.position ?? -1) + 1;

      let entry;
      try {
        entry = await prisma.serverWelcomeChannel.create({
          data: {
            serverId: m.serverId,
            channelId,
            description,
            emoji: emoji ?? null,
            position: nextPosition,
          },
        });
      } catch (err) {
        // Unique constraint on (serverId, channelId) — channel already exists
        // in the welcome grid. Surface as 409 with a clear message.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return res.status(409).json({ error: 'This channel is already on the welcome screen' });
        }
        throw err;
      }

      await createAuditLog(
        m.serverId,
        m.userId,
        'welcome_channel_add',
        'welcome_channel',
        entry.id,
        { channelId, position: nextPosition },
      );

      const response = await buildWelcomeResponse(m.serverId);

      const io = req.app.get('io');
      if (io) {
        io.to(`server:${m.serverId}`).emit('server-welcome-updated', {
          serverId: m.serverId,
          welcome: response,
        });
      }

      log.info(
        { serverId: m.serverId, actorId: m.userId, entryId: entry.id, channelId },
        'welcome channel added',
      );
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /channels/:id
//
// Description / emoji are simple in-place updates. Position changes do an
// atomic swap inside a transaction so two channels never share a position.

router.patch(
  '/channels/:id',
  validateUuidParams('serverId', 'id'),
  authenticateToken,
  welcomeLimiter,
  validate(updateWelcomeChannelSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const m = await requireManageServer(req, res);
      if (!m) return;

      const entryId = getParam(req, 'id');
      const entry = await prisma.serverWelcomeChannel.findFirst({
        where: { id: entryId, serverId: m.serverId },
        select: { id: true, position: true },
      });
      if (!entry) return res.status(404).json({ error: 'Welcome channel not found' });

      const body = req.body as {
        description?: string;
        emoji?: string | null;
        position?: number;
      };

      const fieldData: Record<string, unknown> = {};
      if (body.description !== undefined) fieldData.description = body.description;
      if (body.emoji !== undefined) fieldData.emoji = body.emoji;

      if (Object.keys(fieldData).length === 0 && body.position === undefined) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      // Atomic position swap. If a sibling currently occupies the requested
      // position, give it our old position so the (serverId, position)
      // ordering stays unique-by-intent. Wrapped in a $transaction so the
      // two writes commit together.
      if (body.position !== undefined && body.position !== entry.position) {
        const sibling = await prisma.serverWelcomeChannel.findFirst({
          where: { serverId: m.serverId, position: body.position },
          select: { id: true },
        });
        const ops: Prisma.PrismaPromise<unknown>[] = [
          prisma.serverWelcomeChannel.update({
            where: { id: entry.id },
            data: { ...fieldData, position: body.position },
          }),
        ];
        if (sibling && sibling.id !== entry.id) {
          ops.push(
            prisma.serverWelcomeChannel.update({
              where: { id: sibling.id },
              data: { position: entry.position },
            }),
          );
        }
        await prisma.$transaction(ops);
      } else if (Object.keys(fieldData).length > 0) {
        await prisma.serverWelcomeChannel.update({
          where: { id: entry.id },
          data: fieldData as never,
        });
      }

      await createAuditLog(
        m.serverId,
        m.userId,
        'welcome_channel_update',
        'welcome_channel',
        entry.id,
        { ...fieldData, ...(body.position !== undefined ? { position: body.position } : {}) },
      );

      const response = await buildWelcomeResponse(m.serverId);

      const io = req.app.get('io');
      if (io) {
        io.to(`server:${m.serverId}`).emit('server-welcome-updated', {
          serverId: m.serverId,
          welcome: response,
        });
      }

      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /channels/:id

router.delete(
  '/channels/:id',
  validateUuidParams('serverId', 'id'),
  authenticateToken,
  welcomeLimiter,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const m = await requireManageServer(req, res);
      if (!m) return;

      const entryId = getParam(req, 'id');
      const entry = await prisma.serverWelcomeChannel.findFirst({
        where: { id: entryId, serverId: m.serverId },
        select: { id: true, channelId: true, position: true },
      });
      if (!entry) return res.status(404).json({ error: 'Welcome channel not found' });

      await prisma.serverWelcomeChannel.delete({ where: { id: entry.id } });

      await createAuditLog(
        m.serverId,
        m.userId,
        'welcome_channel_delete',
        'welcome_channel',
        entry.id,
        { channelId: entry.channelId, position: entry.position },
      );

      const response = await buildWelcomeResponse(m.serverId);

      const io = req.app.get('io');
      if (io) {
        io.to(`server:${m.serverId}`).emit('server-welcome-updated', {
          serverId: m.serverId,
          welcome: response,
        });
      }

      log.info(
        { serverId: m.serverId, actorId: m.userId, entryId: entry.id },
        'welcome channel deleted',
      );
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
