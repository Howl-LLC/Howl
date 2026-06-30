// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * SEO + public-preview HTML routes.
 *
 *   GET /robots.txt      — text/plain
 *   GET /sitemap.xml     — application/xml
 *   GET /s/:vanity       — text/html (per-server OG/Twitter meta)
 *
 * Mounted at the application root, NOT under `/api`. Returns lightweight
 * SSR HTML so link unfurlers (Discord, iMessage, Slack, Twitter, etc.) can
 * render a card for a Howl community without first loading the SPA.
 *
 * The HTML payload is the same shell `index.html` ships, with two changes:
 *   1. Per-server Open Graph + Twitter card meta tags.
 *   2. No prefetch of voice-only assets (RNNoise) — those are unnecessary
 *      cost on a public landing page that may be visited from a mobile
 *      preview.
 *
 * Eligibility for `/s/:vanity` and `sitemap.xml` mirrors `publicServer.ts`
 * exactly:
 *   - settings.communityEnabled = true
 *   - settings.discoveryEnabled = true
 *   - server.suspendedAt IS NULL
 *   - server.hiddenFromDiscovery = false (read defensively; optional column)
 *   (nsfwLevel check removed — Channel.ageRestricted is the only NSFW concept)
 *
 * IP rate-limited via the shared Redis-backed store.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { isPubliclyDiscoverable } from '../utils/communityEligibility.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';
import {
  renderServerProfileHtml,
  renderServerProfileNotFoundHtml,
  safeImageUrl,
} from '../views/serverProfile.html.js';

const router = Router();

const PUBLIC_ORIGIN =
  process.env.PUBLIC_APP_ORIGIN ||
  // Fall back to the first FRONTEND_ORIGIN if set (production), else local.
  (process.env.FRONTEND_ORIGIN
    ? process.env.FRONTEND_ORIGIN.split(',')[0]?.trim()
    : 'http://localhost:3000') ||
  'https://app.howlpro.com';

const seoLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:seo:'),
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => getClientIp(req) ?? 'anonymous',
  message: 'Too many requests',
});

const sitemapLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:sitemap:'),
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => getClientIp(req) ?? 'anonymous',
  message: 'Too many requests',
});

const VANITY_RE = /^[a-z0-9](?:[a-z0-9-]){1,30}[a-z0-9]$/;

const vanityParamSchema = z.object({
  params: z
    .object({
      vanity: z.string().min(3).max(32),
    })
    .strict(),
});

type DefensiveServerExtras = {
  hiddenFromDiscovery?: boolean | null;
};

// /robots.txt

router.get('/robots.txt', seoLimiter, (_req, res) => {
  const body = [
    'User-agent: *',
    'Disallow: /api/',
    'Disallow: /admin/',
    'Allow: /s/',
    'Allow: /discover',
    `Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`,
    '',
  ].join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
  res.send(body);
});

// /sitemap.xml

router.get(
  '/sitemap.xml',
  sitemapLimiter,
  asyncHandler(async (_req, res) => {
    // Filter eligible Server rows at the SQL layer with the same 5 checks
    // `isPubliclyDiscoverable` enforces in the runtime helper:
    //   suspendedAt IS NULL, hiddenFromDiscovery = false,
    //   settings.communityEnabled = true,
    //   settings.discoveryEnabled = true.
    // Keeping the where-clause and the helper in lock-step is what
    // prevents drift between the sitemap and the per-row anonymous
    // surfaces.
    //
    // We bind the `take` cap at 50,000 per the sitemap.xml spec — beyond
    // that we'd need a sitemap index with multiple files.
    //
    // SEO sitemaps don't need to expose UUID-only servers (a vanity is a
    // prerequisite for a meaningful share link), so filter
    // `vanityUrl != null` and skip rows without one.
    const servers = await prisma.server.findMany({
      where: {
        suspendedAt: null,
        hiddenFromDiscovery: false,
        vanityUrl: { not: null },
        settings: {
          communityEnabled: true,
          discoveryEnabled: true,
        },
      },
      select: {
        vanityUrl: true,
        // We don't have a Server.updatedAt — the closest signal we have is
        // ServerSettings.updatedAt. Best-effort lastmod.
        settings: { select: { updatedAt: true, discoverableSince: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50_000,
    });

    const lines: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ];
    for (const s of servers) {
      if (!s.vanityUrl) continue;
      // Defense-in-depth — only emit if vanity matches the canonical regex
      // (so we never emit a poisoned slug into XML).
      if (!VANITY_RE.test(s.vanityUrl)) continue;
      const lastmod =
        s.settings?.updatedAt?.toISOString() ??
        s.settings?.discoverableSince?.toISOString() ??
        new Date().toISOString();
      lines.push('  <url>');
      lines.push(`    <loc>${PUBLIC_ORIGIN}/s/${s.vanityUrl}</loc>`);
      lines.push(`    <lastmod>${lastmod}</lastmod>`);
      lines.push('  </url>');
    }
    lines.push('</urlset>');

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    res.send(lines.join('\n'));
  }),
);

// /s/:vanity

router.get(
  '/s/:vanity',
  seoLimiter,
  validate(vanityParamSchema),
  asyncHandler(async (req, res) => {
    const raw = String(req.params.vanity ?? '').trim().toLowerCase();

    const sendNotFound = () => {
      res.status(404);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900');
      res.send(renderServerProfileNotFoundHtml());
    };

    if (!VANITY_RE.test(raw)) {
      return sendNotFound();
    }

    const server = await prisma.server.findUnique({
      where: { vanityUrl: raw },
      include: {
        settings: {
          select: {
            description: true,
            longDescription: true,
            bannerSplash: true,
            communityEnabled: true,
            discoveryEnabled: true,
          },
        },
      },
    });

    if (!server || !server.settings) return sendNotFound();
    // 5-check publicly-discoverable gate (community + discovery + not
    // suspended + not hidden + not mature). Any failure → 404 HTML; never
    // leak existence.
    const extras = server as typeof server & DefensiveServerExtras;
    if (
      !isPubliclyDiscoverable(
        {
          suspendedAt: server.suspendedAt,
          hiddenFromDiscovery: extras.hiddenFromDiscovery ?? false,
        },
        server.settings,
      )
    ) {
      return sendNotFound();
    }

    // Image precedence: bannerSplash → banner → icon. Each one is validated
    // by `safeImageUrl` so an attacker-controlled image URL on an opted-in
    // server can't smuggle a `javascript:` or non-allowlisted host into the
    // OG meta.
    const candidate =
      server.settings.bannerSplash || server.banner || server.icon || null;
    const imageUrl = candidate ? safeImageUrl(candidate) : null;

    // Description precedence: settings.description (short) wins for OG (200
    // char cap). Falls back to longDescription truncated.
    const description =
      (server.settings.description && server.settings.description.trim()) ||
      (server.settings.longDescription && server.settings.longDescription.trim()) ||
      null;

    let html: string;
    try {
      html = renderServerProfileHtml({
        vanity: raw,
        name: server.name,
        description,
        imageUrl,
      });
    } catch (err) {
      logger.warn(
        { err, serverId: server.id },
        'serverProfile render rejected by escape tripwire',
      );
      return sendNotFound();
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900');
    res.send(html);
  }),
);

export default router;
