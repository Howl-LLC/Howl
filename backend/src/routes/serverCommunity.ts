// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Community lifecycle endpoints for public/community servers.
 *
 * All endpoints mounted under `/api/v1/servers/:serverId/community`.
 *
 *   GET  /eligibility — any member; checklist used by the eligibility UI.
 *   POST /enable      — manageServer; flips `communityEnabled`/`discoveryEnabled`.
 *   POST /disable     — manageServer; flips both off.
 *   PATCH /           — manageServer; community-only metadata (category,
 *                       tags, language, long description, splash, NSFW).
 *
 * Follows the same shape as `serverSettings.ts`: `validate(zodSchema)` for
 * every body, `authenticateToken` first, `validateUuidParams('serverId')`
 * before any DB access, a per-router rate limiter backed by the shared
 * Redis-backed store, and an `AuditLog` row for every state-changing
 * action. All Prisma `findMany`/`findFirst` calls remain explicitly bounded.
 *
 * The Server model has no `ownerId` column — owner is resolved through
 * `ServerMember.role = 'owner'` (case-insensitive) in `communityEligibility`.
 */

import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { validate } from '../middleware/validate.js';
import { getParam, hasPermission, loadPermissionContext } from '../utils.js';
import { communityEnableSchema, communityUpdateSchema } from '../schemas.js';
import { evaluateCommunityEligibility } from '../utils/communityEligibility.js';
import {
  getDiscoveryEligibility,
  invalidateDiscoveryEligibility,
} from '../services/discoveryEligibilityCache.js';
import { createAuditLog } from './serverSettings.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';
import { checkUploadAttachment } from '../services/uploadProvenance.js';

const log = logger.child({ module: 'serverCommunity' });

const router = Router({ mergeParams: true });

/**
 * Project Server + ServerSettings rows into the flat `CommunityConfig`
 * shape the frontend expects. The client's `setConfig(updated)` overwrites
 * in-memory state with the response body, so partial or nested payloads
 * cause the community-mode toggle and dependent UI (vanity URL, splash,
 * etc.) to collapse — every lifecycle endpoint must return this projection.
 */
// Mirror of the cooldown constant in serverVanity.ts. Co-locating here keeps
// projection self-contained; both routes import the same number from
// serverVanity once it's surfaced cross-module if/when more callers need it.
const VANITY_CLAIM_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

function projectCommunityConfig(
  server: { vanityUrl: string | null; vanityLastClaimedAt: Date | null } | null,
  settings: {
    communityEnabled: boolean;
    discoveryEnabled: boolean;
    category: string | null;
    subcategory: string | null;
    tags: unknown;
    language: string | null;
    longDescription: string | null;
    bannerSplash: string | null;
    discoverableSince: Date | null;
  } | null,
) {
  // Compute the next-eligible-at timestamp for the vanity-URL cooldown so the
  // settings UI can render "next change in N days" without provoking a 429.
  // Null when no claim has happened yet OR the cooldown window has elapsed.
  let vanityChangeEligibleAt: string | null = null;
  if (server?.vanityLastClaimedAt) {
    const elapsed = Date.now() - server.vanityLastClaimedAt.getTime();
    if (elapsed < VANITY_CLAIM_COOLDOWN_MS) {
      vanityChangeEligibleAt = new Date(
        server.vanityLastClaimedAt.getTime() + VANITY_CLAIM_COOLDOWN_MS,
      ).toISOString();
    }
  }

  return {
    communityEnabled: settings?.communityEnabled ?? false,
    discoveryEnabled: settings?.discoveryEnabled ?? false,
    category: settings?.category ?? null,
    subcategory: settings?.subcategory ?? null,
    tags: Array.isArray(settings?.tags) ? (settings.tags as string[]) : [],
    language: settings?.language ?? 'en',
    longDescription: settings?.longDescription ?? null,
    bannerSplash: settings?.bannerSplash ?? null,
    vanityUrl: server?.vanityUrl ?? null,
    vanityChangeEligibleAt,
    discoverableSince: settings?.discoverableSince
      ? settings.discoverableSince.toISOString()
      : null,
  };
}

/**
 * Bounded read of the columns needed for `projectCommunityConfig`. No
 * passwordHash/email/MFA fields are ever queried here.
 */
async function readCommunityConfig(serverId: string) {
  const [server, settings] = await Promise.all([
    prisma.server.findUnique({
      where: { id: serverId },
      select: { id: true, vanityUrl: true, vanityLastClaimedAt: true, suspendedAt: true },
    }),
    prisma.serverSettings.findUnique({
      where: { serverId },
      select: {
        communityEnabled: true,
        discoveryEnabled: true,
        category: true,
        subcategory: true,
        tags: true,
        language: true,
        longDescription: true,
        bannerSplash: true,
        discoverableSince: true,
      },
    }),
  ]);
  return projectCommunityConfig(server, settings);
}

// 30/min per user — matches the cadence of the surrounding settings router so
// a moderator opening the community settings panel doesn't immediately get
// throttled. Keyed by user (with IP fallback) so shared IPs don't conflate.
const communityLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  windowMs: 60 * 1000,
  max: 30,
  store: createRateLimitStore('rl:srv-community:'),
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
  message: { error: 'Too many community requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

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

// Eligibility

router.get(
  '/eligibility',
  validateUuidParams('serverId'),
  authenticateToken,
  communityLimiter,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const m = await requireMember(req, res);
      if (!m) return;
      const result = await evaluateCommunityEligibility(m.serverId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// Discovery-listing eligibility
//
// Sister to /eligibility (which gates community-mode enablement). This one
// gates whether a community-mode server can additionally enable discovery
// listing — enforces the size/age/activity bars on top of community-mode
// quality checks. Cached for 5 min via Redis to bound DB cost during
// public-launch traffic. manageServer-gated because the result includes
// member counts and activity totals.
router.get(
  '/discovery-eligibility',
  validateUuidParams('serverId'),
  authenticateToken,
  communityLimiter,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const m = await requireManageServer(req, res);
      if (!m) return;
      const result = await getDiscoveryEligibility(m.serverId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// Read canonical community config
//
// Defensive read used by the frontend's `refreshConfig` so the community
// settings panel stays consistent with the source of truth across reloads,
// vanity claims, and navigate-away-and-back. Returning the same flat
// `CommunityConfig` shape the lifecycle/PATCH handlers do means the
// client's `setConfig(updated)` overwrite is safe — `vanityUrl` and the
// rest of the metadata stay populated. manageServer-gated because the
// projection includes the canonical vanity URL and discoverability state
// the settings panel surfaces.
router.get(
  '/',
  validateUuidParams('serverId'),
  authenticateToken,
  communityLimiter,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const m = await requireManageServer(req, res);
      if (!m) return;
      const config = await readCommunityConfig(m.serverId);
      res.json(config);
    } catch (err) {
      next(err);
    }
  },
);

// Enable

router.post(
  '/enable',
  validateUuidParams('serverId'),
  authenticateToken,
  communityLimiter,
  validate(communityEnableSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const m = await requireManageServer(req, res);
      if (!m) return;

      // Server-side enforcement — never trust the client's checklist view.
      const result = await evaluateCommunityEligibility(m.serverId);
      if (!result.eligible) {
        return res.status(422).json({
          error: 'eligibility_failed',
          failed: result.checks.filter((c) => !c.met),
        });
      }

      const { discoveryEnabled = true } = req.body as { discoveryEnabled?: boolean };

      // Discovery has additional size/age/activity bars on top of community
      // eligibility. Owners can enable community-mode immediately on a fresh
      // server, but discovery listing is gated until the bars are met.
      if (discoveryEnabled) {
        const discoveryResult = await getDiscoveryEligibility(m.serverId);
        if (!discoveryResult.eligible) {
          return res.status(422).json({
            error: 'discovery_eligibility_failed',
            failed: discoveryResult.checks.filter((c) => !c.met),
            thresholds: discoveryResult.thresholds,
          });
        }
      }

      // Preserve the original opt-in date across re-enables (analytics ranks
      // by tenure). Promote the schema default `invite_only` joinMethod to
      // `discoverable` when discovery is on — otherwise the public join
      // endpoint rejects with `join_method_mismatch`. `apply_to_join` is
      // left alone (intentional gating choice).
      const existing = await prisma.serverSettings.findUnique({
        where: { serverId: m.serverId },
        select: { discoverableSince: true, joinMethod: true },
      });
      const discoverableSince =
        discoveryEnabled && !existing?.discoverableSince ? new Date() : existing?.discoverableSince ?? null;
      const joinMethodPatch =
        discoveryEnabled && (existing?.joinMethod ?? 'invite_only') === 'invite_only'
          ? { joinMethod: 'discoverable' }
          : {};

      await prisma.serverSettings.upsert({
        where: { serverId: m.serverId },
        create: {
          serverId: m.serverId,
          communityEnabled: true,
          discoveryEnabled,
          discoverableSince,
          ...joinMethodPatch,
        },
        update: {
          communityEnabled: true,
          discoveryEnabled,
          discoverableSince,
          ...joinMethodPatch,
        },
      });

      await createAuditLog(m.serverId, m.userId, 'community_enable', 'settings', m.serverId, {
        discoveryEnabled,
      });

      const io = req.app.get('io');
      if (io) {
        io.to(`server:${m.serverId}`).emit('server-community-updated', {
          serverId: m.serverId,
          communityEnabled: true,
          discoveryEnabled,
        });
      }

      log.info({ serverId: m.serverId, actorId: m.userId, discoveryEnabled }, 'community enabled');

      // Project canonical state back to the client. The client's
      // `setConfig(updated)` would otherwise overwrite the in-memory config
      // with `{ communityEnabled, discoveryEnabled }` and erase the rest of
      // the metadata fields it already had hydrated.
      const config = await readCommunityConfig(m.serverId);
      res.json(config);
    } catch (err) {
      next(err);
    }
  },
);

// Disable

router.post(
  '/disable',
  validateUuidParams('serverId'),
  authenticateToken,
  communityLimiter,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const m = await requireManageServer(req, res);
      if (!m) return;

      // Idempotent disable — if no settings row exists, nothing to flip.
      // We still write the audit row so admins can see the action attempt.
      const existing = await prisma.serverSettings.findUnique({
        where: { serverId: m.serverId },
        select: { communityEnabled: true, discoveryEnabled: true },
      });

      if (existing) {
        await prisma.serverSettings.update({
          where: { serverId: m.serverId },
          data: { communityEnabled: false, discoveryEnabled: false },
        });
      }

      await createAuditLog(m.serverId, m.userId, 'community_disable', 'settings', m.serverId, {
        wasCommunityEnabled: existing?.communityEnabled ?? false,
        wasDiscoveryEnabled: existing?.discoveryEnabled ?? false,
      });

      const io = req.app.get('io');
      if (io) {
        io.to(`server:${m.serverId}`).emit('server-community-updated', {
          serverId: m.serverId,
          communityEnabled: false,
          discoveryEnabled: false,
        });
      }

      log.info({ serverId: m.serverId, actorId: m.userId }, 'community disabled');

      // Same projection as enable — return the full canonical config so the
      // frontend's `setConfig(updated)` doesn't blow away the metadata it
      // already has hydrated alongside the lifecycle flags.
      const config = await readCommunityConfig(m.serverId);
      res.json(config);
    } catch (err) {
      next(err);
    }
  },
);

// Update community metadata

router.patch(
  '/',
  validateUuidParams('serverId'),
  authenticateToken,
  communityLimiter,
  validate(communityUpdateSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const m = await requireManageServer(req, res);
      if (!m) return;

      const body = req.body as {
        category?: string | null;
        subcategory?: string | null;
        tags?: string[] | null;
        language?: string | null;
        longDescription?: string | null;
        bannerSplash?: string | null;
        discoveryEnabled?: boolean;
      };

      const serverData: Record<string, unknown> = {};

      const settingsData: Record<string, unknown> = {};
      if (body.category !== undefined) settingsData.category = body.category;
      if (body.subcategory !== undefined) settingsData.subcategory = body.subcategory;
      if (body.tags !== undefined) settingsData.tags = body.tags;
      if (body.language !== undefined) settingsData.language = body.language;
      if (body.longDescription !== undefined) settingsData.longDescription = body.longDescription;
      if (body.bannerSplash !== undefined) {
        // bannerSplash is shown on the public discovery page and has no
        // image-extension check — refuse an encrypted (scan-skipped) blob.
        const prov = await checkUploadAttachment(body.bannerSplash);
        if (!prov.ok) return res.status(prov.status).json({ error: prov.error });
        settingsData.bannerSplash = body.bannerSplash;
      }
      if (body.discoveryEnabled !== undefined) settingsData.discoveryEnabled = body.discoveryEnabled;

      if (Object.keys(serverData).length === 0 && Object.keys(settingsData).length === 0) {
        return res.status(400).json({ error: 'No community fields to update' });
      }

      // Discovery enable: enforce eligibility AND promote joinMethod when
      // needed. We block the toggle (422) if eligibility fails, and only
      // touch joinMethod when discovery actually goes through.
      if (body.discoveryEnabled === true) {
        const discoveryResult = await getDiscoveryEligibility(m.serverId);
        if (!discoveryResult.eligible) {
          return res.status(422).json({
            error: 'discovery_eligibility_failed',
            failed: discoveryResult.checks.filter((c) => !c.met),
            thresholds: discoveryResult.thresholds,
          });
        }

        const current = await prisma.serverSettings.findUnique({
          where: { serverId: m.serverId },
          select: { joinMethod: true },
        });
        if ((current?.joinMethod ?? 'invite_only') === 'invite_only') {
          settingsData.joinMethod = 'discoverable';
        }
      }

      const ops: Promise<unknown>[] = [];
      if (Object.keys(serverData).length > 0) {
        ops.push(prisma.server.update({ where: { id: m.serverId }, data: serverData as never }));
      }
      if (Object.keys(settingsData).length > 0) {
        ops.push(
          prisma.serverSettings.upsert({
            where: { serverId: m.serverId },
            create: { serverId: m.serverId, ...settingsData } as never,
            update: settingsData as never,
          }),
        );
      }
      await Promise.all(ops);

      // Re-read the canonical state once. The same rows feed both the REST
      // response (flat `CommunityConfig` shape the frontend expects) and the
      // socket payload (legacy nested `{ server, settings }` shape that
      // existing listeners are wired to — see the routing-affordance fields
      // `rulesChannelId`/`updatesChannelId` they consume).
      //
      // Returning a nested `{ server, settings }` from REST would cause
      // `setConfig(updated)` on the client to clobber the in-memory config
      // with an unusable nested object (community-mode toggle would read
      // undefined, splash/vanity would render blank). Hence the projection.
      const [server, settings] = await Promise.all([
        prisma.server.findUnique({
          where: { id: m.serverId },
          select: { id: true, vanityUrl: true, vanityLastClaimedAt: true, suspendedAt: true },
        }),
        prisma.serverSettings.findUnique({
          where: { serverId: m.serverId },
          select: {
            category: true,
            subcategory: true,
            tags: true,
            language: true,
            longDescription: true,
            bannerSplash: true,
            communityEnabled: true,
            discoveryEnabled: true,
            discoverableSince: true,
            rulesChannelId: true,
            updatesChannelId: true,
          },
        }),
      ]);

      const config = projectCommunityConfig(server, settings);

      await createAuditLog(m.serverId, m.userId, 'community_update', 'settings', m.serverId, {
        ...settingsData,
        ...serverData,
      });

      // Discovery-eligibility cache invalidation: longDescription /
      // bannerSplash / category / discoveryEnabled can all change what the
      // next read computes. Best-effort — owner sees fresh status next
      // request rather than waiting for the 5-min TTL.
      void invalidateDiscoveryEligibility(m.serverId);

      const io = req.app.get('io');
      if (io) {
        io.to(`server:${m.serverId}`).emit('server-community-updated', {
          serverId: m.serverId,
          server,
          settings,
        });
      }

      res.json(config);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
