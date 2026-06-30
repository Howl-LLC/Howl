// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'settings' });
const router = Router();

const settingsReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:user-settings-r:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many settings requests.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const settingsWriteLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:user-settings-w:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many settings updates.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const MAX_SETTINGS_SIZE = 50 * 1024; // 50KB

const updateSettingsSchema = z.object({
  body: z.object({
    data: z.record(z.string(), z.unknown()),
  }).strict(),
});

/**
 * Load a user's stored settings blob. Shared with the /bootstrap aggregate
 * endpoint so cold-start clients can fetch settings in the same round trip.
 */
export async function loadUserSettings(userId: string): Promise<{ data: unknown; updatedAt: string | null }> {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { data: true, updatedAt: true },
  });
  if (!settings) return { data: null, updatedAt: null };
  return { data: settings.data, updatedAt: settings.updatedAt.toISOString() };
}

// GET /api/settings — Fetch server-stored settings
router.get('/', authenticateToken, settingsReadLimiter, async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  try {
    return res.json(await loadUserSettings(req.userId));
  } catch (err) {
    log.error({ err }, 'get-settings error');
    return res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /api/settings — Save settings to server
router.put('/', authenticateToken, settingsWriteLimiter, validate(updateSettingsSchema), async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  try {
    const { data } = req.body as { data: Record<string, unknown> };

    const jsonStr = JSON.stringify(data);
    if (jsonStr.length > MAX_SETTINGS_SIZE) {
      return res.status(400).json({ error: 'Settings payload too large' });
    }

    const jsonData = data as unknown as Prisma.InputJsonValue;
    const result = await prisma.userSettings.upsert({
      where: { userId: req.userId },
      create: { userId: req.userId, data: jsonData },
      update: { data: jsonData },
      select: { updatedAt: true },
    });

    // Emit to all own sessions for cross-tab / cross-device sync
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) {
      io.to(`user:${req.userId}`).emit('settings-updated', { data, updatedAt: result.updatedAt.toISOString() });
    }

    return res.json({ updatedAt: result.updatedAt.toISOString() });
  } catch (err) {
    log.error({ err }, 'save-settings error');
    return res.status(500).json({ error: 'Failed to save settings' });
  }
});

export default router;
