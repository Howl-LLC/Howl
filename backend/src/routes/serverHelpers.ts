// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import type { AuthRequest } from '../middleware/auth.js';
import { getClientIp } from '../utils/clientIp.js';

export function powerUpTier(count: number): number {
  if (count >= 14) return 3;
  if (count >= 7) return 2;
  if (count >= 2) return 1;
  return 0;
}

/** Strip absolute URLs that point to our own uploads back to relative paths for storage. */
export function toRelativeUploadUrl(url: string | null | undefined): string | null | undefined {
  if (!url) return url;
  const idx = url.indexOf('/api/uploads/');
  if (idx > 0) return url.slice(idx);
  return url;
}

// Shared bucket for ALL server-management mutations (channel/category/role/invite
// CRUD + server profile updates). Owner/admin workflows routinely burst: set up
// a new server = create category, create text + voice channels, rename a couple,
// configure two roles, send a couple invites — easily 10+ calls in ~30s. The
// previous 15 req / 60s cap locked power users out mid-configuration.
// Kept per-user + Redis-backed so it still blocks scripted abuse.
export const serverMutationLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:srv-mutate:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});
