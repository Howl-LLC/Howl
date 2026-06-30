// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Per-channel age-gate acceptance.
 *
 * Single route: POST /:channelId/age-gate/accept
 * Mounted under /api/v1/channels in server.ts.
 *
 * When a channel has `ageRestricted = true`, authenticated users 18+ can
 * accept the gate. The acceptance is stored as an idempotent append to
 * `ServerMember.acceptedAgeRestrictedChannelIds`.
 */

import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { acceptChannelAgeGateSchema } from '../schemas.js';
import { isUnderEighteen } from '../utils/discoveryFilters.js';
import { getParam } from '../utils.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';
import { invalidatePermissionContext } from '../redis.js';

const log = logger.child({ module: 'channelAgeGate' });
const router = Router();

const ageGateAcceptLimiter = rateLimit({
  ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:age-gate-accept:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many age-gate requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

// POST /channels/:channelId/age-gate/accept

router.post(
  '/:channelId/age-gate/accept',
  authenticateToken,
  ageGateAcceptLimiter,
  validate(acceptChannelAgeGateSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const channelId = getParam(req, 'channelId');

    // Look up the channel
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true, serverId: true, ageRestricted: true },
    });
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    if (!channel.ageRestricted) {
      return res.status(400).json({ error: 'This channel is not age-restricted.' });
    }

    // Age check: look up DOB
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { dateOfBirth: true },
    });
    if (!user?.dateOfBirth || isUnderEighteen(user.dateOfBirth)) {
      return res.status(403).json({
        error: 'age_restricted',
        message: 'You must be 18 or older to view this channel.',
      });
    }

    // Find the ServerMember row
    const member = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId: channel.serverId } },
      select: { acceptedAgeRestrictedChannelIds: true },
    });
    if (!member) {
      return res.status(403).json({ error: 'You are not a member of this server.' });
    }

    // Idempotent append
    const existing = member.acceptedAgeRestrictedChannelIds ?? [];
    if (!existing.includes(channelId)) {
      await prisma.serverMember.update({
        where: { userId_serverId: { userId: req.userId, serverId: channel.serverId } },
        data: {
          acceptedAgeRestrictedChannelIds: [...existing, channelId],
        },
      });
      await invalidatePermissionContext(channel.serverId, req.userId);
      log.info({ userId: req.userId, channelId, serverId: channel.serverId }, 'age-gate accepted');
    }

    const updated = existing.includes(channelId) ? existing : [...existing, channelId];
    return res.status(200).json({ acceptedAgeRestrictedChannelIds: updated });
  }),
);

export default router;
