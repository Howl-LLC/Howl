// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * User content / discovery preferences.
 *
 * Owns the per-user controls that govern how Community surfaces treat
 * content and whether the user shows up in discovery ranking.
 *
 * Routes mounted under `/api/v1/users` so the public surface is:
 *   GET   /api/v1/users/me/preferences
 *   PATCH /api/v1/users/me/preferences
 */

import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { updateUserContentPreferencesSchema } from '../schemas.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'userPreferences' });

const router = Router();

const preferencesLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:user-content-prefs:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many preference updates. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

/**
 * GET /api/v1/users/me/preferences
 * Returns the current discovery-opt-out preference.
 */
router.get('/me/preferences', authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      discoveryOptOut: true,
    },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    discoveryOptOut: user.discoveryOptOut,
  });
}));

/**
 * PATCH /api/v1/users/me/preferences
 * Partial update of `{ discoveryOptOut }`.
 */
router.patch(
  '/me/preferences',
  authenticateToken,
  preferencesLimiter,
  validate(updateUserContentPreferencesSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const body = req.body as { discoveryOptOut?: boolean };

    if (body.discoveryOptOut === undefined) {
      return res.status(400).json({ error: 'No preferences provided.' });
    }

    const updates: { discoveryOptOut?: boolean } = {};
    if (body.discoveryOptOut !== undefined) {
      updates.discoveryOptOut = body.discoveryOptOut;
    }

    const updated = await prisma.user.update({
      where: { id: req.userId },
      data: updates,
      select: { discoveryOptOut: true },
    });

    log.info(
      {
        userId: req.userId,
        changedDiscoveryOptOut: body.discoveryOptOut !== undefined,
      },
      'user content preferences updated',
    );

    res.json({
      discoveryOptOut: updated.discoveryOptOut,
    });
  }),
);

export default router;
