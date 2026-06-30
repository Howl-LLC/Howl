// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Vanity URL endpoints for Community Servers.
 *
 * Owner-facing (under `/api/v1/servers/:serverId/vanity`):
 *   GET    /  → current `vanityUrl` (null if unset)
 *   POST   /  → claim a slug      (manageServer perm, audit `vanity_set`)
 *   DELETE /  → clear current slug (manageServer perm, audit `vanity_cleared`)
 *
 * Public availability check (anonymous, separate router under `/api/v1/vanity`):
 *   GET /check?slug=<slug>  → `{ available, reason? }`
 *   The response NEVER reveals the owning server's id, name, or any other
 *   detail when a slug is taken — only that it is unavailable. This prevents
 *   the endpoint from being abused as a slug → server-id oracle.
 *
 * Race-safety on claim:
 *   `Server.vanityUrl` has a unique index. The single `prisma.server.update`
 *   atomically overwrites the previous slug (if any) and claims the new one;
 *   simultaneous claims are resolved by the unique constraint surfacing as
 *   Prisma error code P2002, which we map to 409 `vanity_taken`. No
 *   transaction is needed.
 */

import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { getParam, hasPermission, loadPermissionContext } from '../utils.js';
import { setVanitySchema, vanityCheckQuery } from '../schemas.js';
import { validateSlug } from '../utils/vanitySlug.js';
import { canClaimVanityUrl } from '../utils/communityEligibility.js';
import { createAuditLog } from './serverSettings.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'serverVanity' });

/**
 * Cooldown between successful vanity-URL claims. Owners can release at any
 * time, but cannot claim a NEW slug for 30 days after the last claim. Same
 * window as Discord's vanity rebrand cooldown — long enough to prevent
 * slug-laundering, short enough not to be punitive on a real rebrand.
 */
const VANITY_CLAIM_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

// Rate limiters

// Owner mutations: 10/min/user. Read is the same bucket since the GET is
// negligible-cost and pairs naturally with claim attempts.
const vanityOwnerLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:srv-vanity-w:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many vanity-URL changes. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

// Public availability check: 60/min/IP. Anonymous, so we can't key on userId.
const vanityCheckLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:vanity-check:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req) ?? 'anonymous',
});

// Owner router (mounted under /api/v1/servers/:serverId/vanity)

export const serverVanityRouter = Router({ mergeParams: true });

async function requireManageServer(req: AuthRequest, res: Response): Promise<{ userId: string; serverId: string } | null> {
  if (!req.userId) { res.status(401).json({ error: 'Missing user' }); return null; }
  const serverId = getParam(req, 'serverId');
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) { res.status(403).json({ error: 'Not a member of this server' }); return null; }
  if (!hasPermission(ctx, 'manageServer')) {
    res.status(403).json({ error: 'You need the Manage Server permission' });
    return null;
  }
  return { userId: req.userId, serverId };
}

// GET /api/v1/servers/:serverId/vanity — current vanity slug + cooldown state
serverVanityRouter.get(
  '/',
  validateUuidParams('serverId'),
  authenticateToken,
  vanityOwnerLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const m = await requireManageServer(req, res);
    if (!m) return;
    const server = await prisma.server.findUnique({
      where: { id: m.serverId },
      select: { vanityUrl: true, vanityLastClaimedAt: true },
    });
    if (!server) return res.status(404).json({ error: 'Server not found' });

    // Surface cooldown so the UI can render "next change in N days" without
    // having to provoke a 429. Null when no claim has happened yet or the
    // cooldown window has elapsed.
    let nextEligibleAt: string | null = null;
    let daysRemaining = 0;
    if (server.vanityLastClaimedAt) {
      const elapsed = Date.now() - server.vanityLastClaimedAt.getTime();
      if (elapsed < VANITY_CLAIM_COOLDOWN_MS) {
        nextEligibleAt = new Date(server.vanityLastClaimedAt.getTime() + VANITY_CLAIM_COOLDOWN_MS).toISOString();
        daysRemaining = Math.max(1, Math.ceil((VANITY_CLAIM_COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000)));
      }
    }

    res.json({
      vanityUrl: server.vanityUrl ?? null,
      nextEligibleAt,
      daysRemaining,
    });
  }),
);

// POST /api/v1/servers/:serverId/vanity { slug } — claim a slug
serverVanityRouter.post(
  '/',
  validateUuidParams('serverId'),
  authenticateToken,
  vanityOwnerLimiter,
  validate(setVanitySchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const m = await requireManageServer(req, res);
    if (!m) return;

    const { slug: rawSlug } = req.body as { slug: string };
    const validation = validateSlug(rawSlug);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.reason });
    }
    const slug = validation.slug;

    // Idempotent: if the requesting server already owns this slug, succeed
    // without a write or an audit-log entry. Done before the eligibility +
    // cooldown gates so a re-claim after community-mode is later disabled
    // doesn't 422 on the owner, and a no-op POST during cooldown doesn't
    // 429 — the slug is theirs already.
    const current = await prisma.server.findUnique({
      where: { id: m.serverId },
      select: { vanityUrl: true, vanityLastClaimedAt: true },
    });
    if (!current) return res.status(404).json({ error: 'Server not found' });
    if (current.vanityUrl === slug) {
      return res.json({ vanityUrl: slug });
    }

    // Vanity URLs are a community-tier perk. The server must be community-
    // mode-eligible (every quality check passes) or already have community
    // mode enabled. Releasing the slug stays open regardless — see DELETE.
    const gate = await canClaimVanityUrl(m.serverId);
    if (!gate.canClaim) {
      return res.status(422).json({
        error: 'community_eligibility_required',
        message: 'Complete every community-mode requirement before claiming a vanity URL.',
        checks: gate.eligibility.checks,
      });
    }

    // 30-day cooldown between claims. NULL `vanityLastClaimedAt` (legacy
    // rows + first-ever claim) bypasses the gate so this isn't retroactive.
    if (current.vanityLastClaimedAt) {
      const elapsed = Date.now() - current.vanityLastClaimedAt.getTime();
      if (elapsed < VANITY_CLAIM_COOLDOWN_MS) {
        const nextEligibleAt = new Date(current.vanityLastClaimedAt.getTime() + VANITY_CLAIM_COOLDOWN_MS);
        const daysRemaining = Math.max(1, Math.ceil((VANITY_CLAIM_COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000)));
        return res.status(429).json({
          error: 'vanity_cooldown',
          message: `You can change your vanity URL again in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}.`,
          nextEligibleAt: nextEligibleAt.toISOString(),
          daysRemaining,
        });
      }
    }

    try {
      // Atomic update — the unique index on `vanityUrl` resolves the race
      // between two simultaneous claims by failing the loser with P2002.
      // No need to null-out-then-set: a single update overwrites the previous
      // value (if any) and claims the new slug in one statement.
      // `vanityLastClaimedAt` arms the 30-day cooldown for the next change.
      await prisma.server.update({
        where: { id: m.serverId },
        data: { vanityUrl: slug, vanityLastClaimedAt: new Date() },
      });
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'P2002') {
        return res.status(409).json({ error: 'vanity_taken' });
      }
      throw err;
    }

    await createAuditLog(
      m.serverId,
      m.userId,
      'vanity_set',
      'server',
      m.serverId,
      { previous: current.vanityUrl ?? null, slug },
    ).catch(() => {});

    log.info({ serverId: m.serverId, slug }, 'vanity url set');
    res.json({ vanityUrl: slug });
  }),
);

// DELETE /api/v1/servers/:serverId/vanity — clear the slug
serverVanityRouter.delete(
  '/',
  validateUuidParams('serverId'),
  authenticateToken,
  vanityOwnerLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const m = await requireManageServer(req, res);
    if (!m) return;

    const current = await prisma.server.findUnique({
      where: { id: m.serverId },
      select: { vanityUrl: true },
    });
    if (!current) return res.status(404).json({ error: 'Server not found' });
    if (current.vanityUrl === null) {
      return res.json({ vanityUrl: null });
    }

    await prisma.server.update({
      where: { id: m.serverId },
      data: { vanityUrl: null },
    });

    await createAuditLog(
      m.serverId,
      m.userId,
      'vanity_cleared',
      'server',
      m.serverId,
      { previous: current.vanityUrl },
    ).catch(() => {});

    log.info({ serverId: m.serverId, previous: current.vanityUrl }, 'vanity url cleared');
    res.json({ vanityUrl: null });
  }),
);

// Public router (mounted under /api/v1/vanity)

export const vanityCheckRouter = Router();

// GET /api/v1/vanity/check?slug=<slug> — anonymous availability check
vanityCheckRouter.get(
  '/check',
  vanityCheckLimiter,
  validate(vanityCheckQuery),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const rawSlug = (req.query.slug as string | undefined) ?? '';
    const validation = validateSlug(rawSlug);
    if (!validation.ok) {
      return res.json({ available: false, reason: validation.reason });
    }
    const slug = validation.slug;

    // Look up by the unique index only — select nothing identifying, so the
    // response can never reflect server-id/name through a side channel.
    const taken = await prisma.server.findUnique({
      where: { vanityUrl: slug },
      select: { id: true },
    });
    if (taken) {
      return res.json({ available: false, reason: 'taken' });
    }
    res.json({ available: true });
  }),
);

// We deliberately do NOT expose a `lookup` endpoint on `/api/v1/vanity` here.
// Resolving a slug → serverId for invite-style joins belongs to the public
// preview / discovery surface and should be auth-shaped there. Adding a public
// lookup would let any anonymous caller enumerate which slugs map to which
// server IDs.
