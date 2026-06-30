// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Web Push subscription management routes.
 *
 * POST   /api/push/subscribe    — register a push subscription
 * DELETE /api/push/unsubscribe  — remove a push subscription
 * GET    /api/push/vapid-key    — get the public VAPID key for the frontend
 */

import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { z } from 'zod';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'push' });
const router = Router();

const pushSubscribeSchema = z.object({
  body: z.object({
    subscription: z.object({
      endpoint: z.string().url().max(2048),
      expirationTime: z.number().nullable().optional(),
      keys: z.object({
        p256dh: z.string().max(512),
        auth: z.string().max(512),
      }).strict(),
    }).strict(),
  }).strict(),
});

const pushUnsubscribeSchema = z.object({
  body: z.object({
    endpoint: z.string().url().max(2048),
  }).strict(),
});

const pushSubscribeLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:push-sub:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many subscription requests. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const vapidKeyLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:vapid:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';

// GET /api/push/vapid-key
router.get('/vapid-key', vapidKeyLimiter, (_req, res: Response) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Push notifications not configured' });
  }
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe
router.post('/subscribe', authenticateToken, pushSubscribeLimiter, validate(pushSubscribeSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

  // Zod already validated the shape via pushSubscribeSchema — safe to destructure directly
  const { subscription } = req.body as {
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  };

  const existing = await prisma.pushSubscription.findUnique({ where: { endpoint: subscription.endpoint }, select: { userId: true } });
  if (existing && existing.userId !== req.userId) {
    return res.status(409).json({ error: 'Subscription endpoint already registered' });
  }
  await prisma.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    update: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: req.headers['user-agent'] || null,
    },
    create: {
      userId: req.userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: req.headers['user-agent'] || null,
    },
  });

  log.info({ userId: req.userId }, 'push subscription registered');
  res.json({ success: true });
}));

// DELETE /api/push/unsubscribe
router.delete('/unsubscribe', authenticateToken, pushSubscribeLimiter, validate(pushUnsubscribeSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

  // Zod already validated endpoint via pushUnsubscribeSchema
  const { endpoint } = req.body as { endpoint: string };

  await prisma.pushSubscription.deleteMany({
    where: { userId: req.userId, endpoint },
  });
  log.info({ userId: req.userId }, 'push subscription removed');
  res.json({ success: true });
}));

export default router;
