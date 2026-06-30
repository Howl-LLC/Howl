// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS, isLoadTestBypass } from '../rateLimitStore.js';
import { getClientIp } from '../utils/clientIp.js';

interface AuthRequest extends Request {
  userId?: string;
}

/**
 * Rate limit for sending messages (server channels, DMs, group DMs).
 * Per-user: 8 messages per 10 seconds. When exceeded, user must wait for the window to reset (~10 sec).
 */
export const messageSendLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:msg-send:'),
  windowMs: 10 * 1000, // 10 seconds
  max: 8, // 8 messages per window per user
  message: { error: "You're sending messages too fast. Please wait 10 seconds before sending again." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const userId = (req as AuthRequest).userId;
    return userId ?? getClientIp(req) ?? 'anonymous';
  },
  skip: (req) => req.method === 'OPTIONS' || !(req as AuthRequest).userId || isLoadTestBypass(req),
});
