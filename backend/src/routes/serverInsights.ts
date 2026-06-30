// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Server insights read endpoint for public/community servers.
 *
 * `GET /api/v1/servers/:serverId/insights?range=7d|30d|90d` — owner-facing
 * time-series read of `DailyServerStats`. Requires `manageServer` perm.
 *
 * The underlying `DailyServerStats` rows are populated by the BullMQ
 * `serverStats` worker (see queues/workers/serverStats.worker.ts). This
 * route is read-only — it never writes, never recomputes, never falls
 * back to live aggregation. Missing days simply return fewer points.
 *
 * DM E2E sanctity: insights cover server channel activity only — `Message`
 * (channel-scoped), `ServerMember`, and `StageSession`. DM tables are
 * never touched.
 *
 * Cache header: `Cache-Control: private, max-age=300` keeps stale reads
 * cheap inside browsers / Cloudflare while still letting an owner pull
 * fresh numbers within 5 min of a manual rollup. `private` blocks shared
 * caches from leaking one server's insights to another tenant.
 */

import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { validate } from '../middleware/validate.js';
import { getParam, hasPermission, loadPermissionContext } from '../utils.js';
import { serverInsightsQuery } from '../schemas.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'serverInsights' });

const router = Router({ mergeParams: true });

// 60/min per user — the insights panel polls modestly when an owner
// switches range filters, but still needs to stay well below the global
// limiter.
const insightsLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  windowMs: 60 * 1000,
  max: 60,
  store: createRateLimitStore('rl:srv-insights:'),
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
  message: { error: 'Too many insights requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const RANGE_DAYS: Record<'7d' | '30d' | '90d', number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

router.get(
  '/',
  validateUuidParams('serverId'),
  authenticateToken,
  insightsLimiter,
  validate(serverInsightsQuery),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: 'Missing user' });
      }

      const serverId = getParam(req, 'serverId');
      const ctx = await loadPermissionContext(req.userId, serverId);
      if (!ctx) {
        return res.status(403).json({ error: 'Not a member of this server' });
      }
      if (!hasPermission(ctx, 'manageServer')) {
        return res.status(403).json({ error: 'You need the manageServer permission' });
      }

      // Zod schema applies .default('7d'), so range is always a known key.
      const range = req.query.range as '7d' | '30d' | '90d';
      const days = RANGE_DAYS[range];

      // UTC-anchored bounds. The worker writes rows with `date @db.Date`
      // (UTC midnight); aligning the read window to UTC midnight keeps
      // query semantics consistent regardless of process TZ.
      const now = new Date();
      const todayUtc = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
      ));
      const fromUtc = new Date(todayUtc.getTime() - days * 24 * 60 * 60 * 1000);

      const rows = await prisma.dailyServerStats.findMany({
        where: {
          serverId,
          date: { gte: fromUtc, lt: todayUtc },
        },
        select: {
          date: true,
          members: true,
          joins: true,
          leaves: true,
          messages: true,
          voiceMinutes: true,
          retainedAfter7d: true,
        },
        orderBy: { date: 'asc' },
        // Hard cap matches the longest range the schema permits. Any
        // future expansion of `range` must adjust both this number and
        // the schema enum.
        take: 90,
      });

      const points = rows.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        members: r.members,
        joins: r.joins,
        leaves: r.leaves,
        messages: r.messages,
        voiceMinutes: r.voiceMinutes,
        retainedAfter7d: r.retainedAfter7d,
      }));

      res.set('Cache-Control', 'private, max-age=300');
      res.json({
        from: fromUtc.toISOString(),
        to: todayUtc.toISOString(),
        points,
      });
    } catch (err) {
      log.error({ err, serverId: getParam(req, 'serverId') }, 'failed to load server insights');
      next(err);
    }
  },
);

export default router;
