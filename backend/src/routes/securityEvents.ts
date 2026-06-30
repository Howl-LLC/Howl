// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * `GET /api/v1/me/security-events`.
 *
 * Paginated, authenticated feed of the caller's own security-sensitive
 * events (password change, email change, MFA enroll/disable, passkey
 * add/remove, session revoke, logout-all, self-delete initiated, login
 * success/new-device). Lets a user review "did someone change my password
 * last night?" without waiting on admin triage.
 *
 * Authorization: self-scoped — the WHERE clause hard-pins `userId` to
 * `req.userId`, so there is no IDOR surface even if the cursor is
 * manipulated.
 *
 * Retention: the read endpoint caps the lookup window at 90 days. Rows
 * older than that are not returned (and also not swept by a background
 * job today — sweeping is a future concern; for now the 90-day filter
 * keeps responses bounded even if the table grows).
 *
 * Pagination: forward cursor on `createdAt DESC`. Client passes the
 * `createdAt` of the last event seen and gets the next page. `take` is
 * clamped to `min(limit, 100)` on the server side — the Zod schema
 * already enforces this but the clamp is defense-in-depth against a
 * future schema change.
 */

import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { listSecurityEventsQuery } from '../schemas.js';
import { getClientIp } from '../utils/clientIp.js';

const router = Router();

const securityEventsReadLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:sec-events:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const HARD_MAX_LIMIT = 100;

router.get(
  '/',
  authenticateToken,
  securityEventsReadLimiter,
  validate(listSecurityEventsQuery),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

    const { limit, cursor } = req.query as unknown as { limit: number; cursor?: string };
    const safeLimit = Math.min(limit, HARD_MAX_LIMIT);
    const windowStart = new Date(Date.now() - NINETY_DAYS_MS);

    const createdAtFilter: { gte: Date; lt?: Date } = { gte: windowStart };
    if (cursor) {
      const cursorDate = new Date(cursor);
      // If the cursor is invalid or predates the window, fall back to
      // the window floor — guarantees strict forward progress.
      if (!Number.isNaN(cursorDate.getTime()) && cursorDate > windowStart) {
        createdAtFilter.lt = cursorDate;
      }
    }

    const events = await prisma.userSecurityEvent.findMany({
      where: {
        userId: req.userId,
        createdAt: createdAtFilter,
      },
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
      select: {
        id: true,
        eventType: true,
        ipMasked: true,
        userAgentHash: true,
        metadata: true,
        createdAt: true,
      },
    });

    const nextCursor =
      events.length === safeLimit ? events[events.length - 1].createdAt.toISOString() : null;

    // Sensitive data — don't let intermediaries cache.
    res.set('Cache-Control', 'no-store');
    res.json({ events, nextCursor });
  }),
);

export default router;
