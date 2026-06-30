// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// backend/src/routes/publicConfig.ts
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { getClientIp } from '../utils/clientIp.js';
import { prisma } from '../db.js';
import { isSelfHost, getInstanceName, getRegistrationMode, isVoiceEnabled, isBillingEnabled, isEmailEnabled } from '../selfHost.js';

const router = Router();

const configLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:public-config:'),
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req) ?? 'anonymous',
  message: { error: 'Too many requests. Please slow down.' },
});

router.get('/', configLimiter, async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  const voiceEnabled = isVoiceEnabled();
  // needsBootstrap is true ONLY on a fresh self-host instance with zero users,
  // so the SPA can show the register form to let the first registrant claim
  // admin even when REGISTRATION_MODE=closed (the backend's first-admin
  // exception). The isSelfHost() guard avoids the DB count on hosted.
  const needsBootstrap = isSelfHost() ? (await prisma.user.count()) === 0 : false;
  res.json({
    instanceName: getInstanceName(),
    selfHost: isSelfHost(),
    registrationMode: getRegistrationMode(),
    voiceEnabled,
    livekitUrl: voiceEnabled ? (process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_URL || '') : '',
    billingEnabled: isBillingEnabled(),
    emailEnabled: isEmailEnabled(),
    needsBootstrap,
  });
});

export default router;
