// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Authenticated discovery directory.
 *
 * Mirrors the shape of `/api/v1/public/discover` but enriches results with
 * member counts (always emitted from this surface; the public surface caps
 * exposure). The query is shared with the public route via
 * `services/discoveryQuery.ts` so the two cannot drift apart.
 *
 * NSFW filter resolution, `applyBlurFlag`, and the `nsfw` query param are not
 * present here. Discovery results are uniform — no blurred cards, no mature
 * filter.
 *
 * Pagination is opaque-cursor based; clients should pass the
 * `nextCursor` from the previous page back as `cursor`. Page size is fixed
 * at `DISCOVERY_PAGE_SIZE` (24 — a hard `take ≤ 24` cap).
 */

import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';
import {
  discoveryListQuery,
  discoveryFeaturedQuery,
  discoveryCategoriesQuery,
} from '../schemas.js';
import {
  DISCOVERY_CATEGORIES,
  DISCOVERY_CATEGORY_LABELS,
  DISCOVERY_PAGE_SIZE,
  DISCOVERY_FEATURED_LIMIT,
  type DiscoverySort,
} from '../utils/discoveryFilters.js';
import {
  runDiscoveryQuery,
  type DiscoveryServerCard,
  mapServerRowToCard,
} from '../services/discoveryQuery.js';

const log = logger.child({ module: 'discover' });
const router = Router();

const discoverLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:discover:'),
  windowMs: 60 * 1000,
  max: 120, // authenticated users get a higher cap; the public surface is the abuse-prone one
  message: { error: 'Too many discovery requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

// GET /api/v1/discover

router.get(
  '/',
  authenticateToken,
  discoverLimiter,
  validate(discoveryListQuery),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    noStore(res);

    const q = (req.query.q as string | undefined)?.trim() || undefined;
    const category = req.query.category as string | undefined;
    const tags = (req.query.tag as string[] | undefined) ?? [];
    const language = req.query.language as string | undefined;
    const sort = (req.query.sort as DiscoverySort | undefined) ?? 'relevance';
    const cursor = req.query.cursor as string | undefined;

    const result = await runDiscoveryQuery({
      q,
      category,
      tags,
      language,
      sort,
      cursor,

      pageSize: DISCOVERY_PAGE_SIZE,
    });

    const items: DiscoveryServerCard[] = result.rows.map((row) =>
      mapServerRowToCard(row, { includeMemberCount: true, includeOnline: true }),
    );

    res.json({ items, nextCursor: result.nextCursor });
  }),
);

// GET /api/v1/discover/featured

router.get(
  '/featured',
  authenticateToken,
  discoverLimiter,
  validate(discoveryFeaturedQuery),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    noStore(res);

    const result = await runDiscoveryQuery({
      sort: 'members',
      featuredOnly: true,

      pageSize: DISCOVERY_FEATURED_LIMIT,
    });

    const items = result.rows.map((row) =>
      mapServerRowToCard(row, { includeMemberCount: true, includeOnline: true }),
    );

    res.json({ items });
  }),
);

// GET /api/v1/discover/categories

router.get(
  '/categories',
  authenticateToken,
  discoverLimiter,
  validate(discoveryCategoriesQuery),
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    noStore(res);
    let counts: Map<string, number> | null = null;
    try {
      const grouped = await prisma.serverSettings.groupBy({
        by: ['category'],
        where: {
          communityEnabled: true,
          discoveryEnabled: true,
          server: {
            hiddenFromDiscovery: false,
            suspendedAt: null,
          },
        },
        _count: { _all: true },
        take: 50,
      });
      counts = new Map(grouped.filter(g => g.category).map(g => [g.category as string, g._count._all]));
    } catch (err) {
      log.warn({ err }, 'discovery category count failed; returning without counts');
      counts = null;
    }
    const items = DISCOVERY_CATEGORIES.map((key) => ({
      key,
      label: DISCOVERY_CATEGORY_LABELS[key],
      ...(counts ? { count: counts.get(key) ?? 0 } : {}),
    }));
    res.json({ items });
  }),
);

export default router;
