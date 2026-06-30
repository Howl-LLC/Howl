// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { logger } from '../logger.js';
import { prisma } from '../db.js';
import { getClientIp } from '../utils/clientIp.js';

const router = Router();
const log = logger.child({ module: 'klipy' });

const KLIPY_API_KEY = process.env.KLIPY_API_KEY || '';
const KLIPY_BASE = 'https://api.klipy.com/api/v1';

const klipySearchQuery = z.object({
  q: z.string().max(200),
  page: z.coerce.number().int().min(1).max(100).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(25),
});

const klipyTrendingQuery = z.object({
  page: z.coerce.number().int().min(1).max(100).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(25),
});

const klipySearchValidation = z.object({ query: klipySearchQuery });
const klipyTrendingValidation = z.object({ query: klipyTrendingQuery });

const klipyRecentsQuery = z.object({
  page: z.coerce.number().int().min(1).max(100).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(25),
});
const klipyRecentsValidation = z.object({ query: klipyRecentsQuery });

const shareTriggerBody = z.object({
  item_id: z.string().max(200),
}).strict();
const shareTriggerValidation = z.object({ body: shareTriggerBody });

const favoritesQuery = z.object({
  page: z.coerce.number().int().min(1).max(100).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
const favoritesValidation = z.object({ query: favoritesQuery });

const favoriteAddBody = z.object({
  gifUrl: z.string().url().max(2000),
  previewUrl: z.string().url().max(2000),
  title: z.string().max(200).default(''),
}).strict();
const favoriteAddValidation = z.object({ body: favoriteAddBody });

const favoriteRemoveBody = z.object({
  gifUrl: z.string().url().max(2000),
}).strict();
const favoriteRemoveValidation = z.object({ body: favoriteRemoveBody });

const klipyLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:klipy:'),
  windowMs: 60_000,
  max: 30,
  message: { error: 'Too many GIF requests. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

router.get('/search', authenticateToken, klipyLimiter, validate(klipySearchValidation), async (req: Request, res: Response) => {
  if (!KLIPY_API_KEY) return res.json({ data: [], has_next: false, current_page: 1 });
  try {
    const q = String(req.query.q ?? '');
    const page = Math.min(Number(req.query.page) || 1, 100);
    const perPage = Math.min(Number(req.query.per_page) || 25, 50);
    const qs = new URLSearchParams({ q, page: String(page), per_page: String(perPage) }).toString();
    // Note: Klipy API requires the API key in the URL path — this is their API design, not our choice.
    // The key is also sent via Authorization header for consistency.
    const upstream = await fetch(`${KLIPY_BASE}/${KLIPY_API_KEY}/gifs/search?${qs}`, {
      headers: { Authorization: `Bearer ${KLIPY_API_KEY}` },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Upstream error' });
    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'GIF service timeout' });
    }
    log.error({ err }, 'Klipy search error');
    res.status(502).json({ error: 'GIF service unavailable' });
  }
});

router.get('/trending', authenticateToken, klipyLimiter, validate(klipyTrendingValidation), async (req: Request, res: Response) => {
  if (!KLIPY_API_KEY) return res.json({ data: [], has_next: false, current_page: 1 });
  try {
    const page = Math.min(Number(req.query.page) || 1, 100);
    const perPage = Math.min(Number(req.query.per_page) || 25, 50);
    const qs = new URLSearchParams({ page: String(page), per_page: String(perPage) }).toString();
    // Note: Klipy API requires the API key in the URL path — this is their API design, not our choice.
    // The key is also sent via Authorization header for consistency.
    const upstream = await fetch(`${KLIPY_BASE}/${KLIPY_API_KEY}/gifs/trending?${qs}`, {
      headers: { Authorization: `Bearer ${KLIPY_API_KEY}` },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Upstream error' });
    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'GIF service timeout' });
    }
    log.error({ err }, 'Klipy trending error');
    res.status(502).json({ error: 'GIF service unavailable' });
  }
});

router.get('/recents', authenticateToken, klipyLimiter, validate(klipyRecentsValidation), async (req: Request, res: Response) => {
  if (!KLIPY_API_KEY) return res.json({ data: [], has_next: false, current_page: 1 });
  try {
    const userId = (req as AuthRequest).userId!;
    const page = Math.min(Number(req.query.page) || 1, 100);
    const perPage = Math.min(Number(req.query.per_page) || 25, 50);
    const qs = new URLSearchParams({ page: String(page), per_page: String(perPage), user_id: userId }).toString();
    const upstream = await fetch(`${KLIPY_BASE}/${KLIPY_API_KEY}/gifs/recent?${qs}`, {
      headers: { Authorization: `Bearer ${KLIPY_API_KEY}` },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Upstream error' });
    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'GIF service timeout' });
    }
    log.error({ err }, 'Klipy recents error');
    res.status(502).json({ error: 'GIF service unavailable' });
  }
});

router.post('/share', authenticateToken, klipyLimiter, validate(shareTriggerValidation), async (req: Request, res: Response) => {
  if (!KLIPY_API_KEY) return res.json({ ok: true });
  try {
    const userId = (req as AuthRequest).userId!;
    const { item_id } = req.body;
    const upstream = await fetch(`${KLIPY_BASE}/${KLIPY_API_KEY}/gifs/share`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KLIPY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id, user_id: userId }),
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    if (!upstream.ok) log.warn({ status: upstream.status }, 'Klipy share trigger failed');
    res.json({ ok: true });
  } catch (err) {
    // Share trigger is fire-and-forget — don't fail the request
    log.warn({ err }, 'Klipy share trigger error');
    res.json({ ok: true });
  }
});

// GET /klipy/favorites — list user's favorites
router.get('/favorites', authenticateToken, klipyLimiter, validate(favoritesValidation), async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const page = Math.min(Number(req.query.page) || 1, 100);
    const limit = Math.min(Number(req.query.limit) || 25, 50);
    const skip = (page - 1) * limit;
    const [favorites, total] = await Promise.all([
      prisma.gifFavorite.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: { gifUrl: true, previewUrl: true, title: true, createdAt: true },
      }),
      prisma.gifFavorite.count({ where: { userId } }),
    ]);
    res.json({ favorites, total, page, hasNext: skip + limit < total });
  } catch (err) {
    log.error({ err }, 'Failed to list gif favorites');
    res.status(500).json({ error: 'Failed to load favorites' });
  }
});

// POST /klipy/favorites — add a favorite
router.post('/favorites', authenticateToken, klipyLimiter, validate(favoriteAddValidation), async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const { gifUrl, previewUrl, title } = req.body;

    // Cap at 200 favorites per user
    const count = await prisma.gifFavorite.count({ where: { userId } });
    if (count >= 200) {
      return res.status(400).json({ error: 'Maximum 200 favorites reached' });
    }

    await prisma.gifFavorite.upsert({
      where: { userId_gifUrl: { userId, gifUrl } },
      create: { userId, gifUrl, previewUrl, title },
      update: {},
    });
    res.json({ ok: true });
  } catch (err) {
    log.error({ err }, 'Failed to add gif favorite');
    res.status(500).json({ error: 'Failed to add favorite' });
  }
});

// DELETE /klipy/favorites — remove a favorite
router.delete('/favorites', authenticateToken, klipyLimiter, validate(favoriteRemoveValidation), async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const { gifUrl } = req.body;
    await prisma.gifFavorite.deleteMany({ where: { userId, gifUrl } });
    res.json({ ok: true });
  } catch (err) {
    log.error({ err }, 'Failed to remove gif favorite');
    res.status(500).json({ error: 'Failed to remove favorite' });
  }
});

export default router;
