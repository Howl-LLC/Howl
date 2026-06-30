// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Anonymous discovery directory.
 *
 * Same query as `/api/v1/discover` but:
 *   - no authentication (per spec; public previews are a primary surface);
 *   - mature servers are NEVER exposed regardless of query string;
 *   - response strips fields that aren't safe to leak to anonymous traffic
 *     (no member list, no subcategory; only the public-card shape);
 *   - aggressive per-IP rate limiting (60/min);
 *   - CDN-friendly cache headers.
 *
 * The shared query logic lives in `services/discoveryQuery.ts`; this file
 * is intentionally a thin wrapper so the two surfaces cannot drift apart.
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { logger } from '../logger.js';
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
import { runDiscoveryQuery, mapServerRowToCard } from '../services/discoveryQuery.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'publicDiscover' });
const router = Router();

const publicDiscoverLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:public-discover:'),
  windowMs: 60 * 1000,
  max: 60, // per spec
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req) ?? 'anonymous',
});

function publicCache(res: Response): void {
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900');
}

// GET /api/v1/public/discover

router.get(
  '/',
  publicDiscoverLimiter,
  validate(discoveryListQuery),
  asyncHandler(async (req: Request, res: Response) => {
    publicCache(res);

    const q = (req.query.q as string | undefined)?.trim() || undefined;
    const category = req.query.category as string | undefined;
    const tags = (req.query.tag as string[] | undefined) ?? [];
    const language = req.query.language as string | undefined;
    const sort = (req.query.sort as DiscoverySort | undefined) ?? 'relevance';
    const cursor = req.query.cursor as string | undefined;

    // Anonymous traffic is forced to `exclude` regardless of `req.query.nsfw`.
    const result = await runDiscoveryQuery({
      q,
      category,
      tags,
      language,
      sort,
      cursor,

      pageSize: DISCOVERY_PAGE_SIZE,
    });

    const items = result.rows.map((row) =>
      mapServerRowToCard(row, { includeMemberCount: true, includeOnline: true, publicMinimal: true }),
    );

    res.json({ items, nextCursor: result.nextCursor });
  }),
);

// GET /api/v1/public/discover/featured

router.get(
  '/featured',
  publicDiscoverLimiter,
  validate(discoveryFeaturedQuery),
  asyncHandler(async (_req: Request, res: Response) => {
    publicCache(res);

    const result = await runDiscoveryQuery({
      sort: 'members',
      featuredOnly: true,

      pageSize: DISCOVERY_FEATURED_LIMIT,
    });
    const items = result.rows.map((row) =>
      mapServerRowToCard(row, { includeMemberCount: true, includeOnline: true, publicMinimal: true }),
    );
    res.json({ items });
  }),
);

// GET /api/v1/public/discover/categories

router.get(
  '/categories',
  publicDiscoverLimiter,
  validate(discoveryCategoriesQuery),
  asyncHandler(async (_req: Request, res: Response) => {
    publicCache(res);
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
      log.warn({ err }, 'public discovery category count failed; returning without counts');
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
