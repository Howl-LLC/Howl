// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { getClientIp } from '../utils/clientIp.js';
import { logger } from '../logger.js';
import { loadCurrentUserProfile } from './profile.js';
import { loadUserSettings } from './settings.js';
import { loadUserServers } from './servers.js';
import { loadUserServerFolders } from './serverFolders.js';
import { loadEmojisForServers } from './serverSettings.js';
import { loadNotificationCounts } from './notifications.js';
import { loadBlockedUsers } from './friends.js';

const log = logger.child({ module: 'bootstrap' });

// 30/min/user — generous enough for legitimate page reloads + tab restores,
// tight enough that a malicious client can't fan out the aggregate query.
const bootstrapLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:bootstrap:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many bootstrap requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const router = Router();

// Sensitive aggregate — never let proxies/CDNs cache the response.
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
});

type BootstrapErrors = Partial<Record<
  'user' | 'settings' | 'servers' | 'folders' | 'emojis' | 'notificationCounts' | 'blocked',
  string
>>;

function settledOr<T>(
  result: PromiseSettledResult<T>,
  key: keyof BootstrapErrors,
  errors: BootstrapErrors,
  fallback: T,
): T {
  if (result.status === 'fulfilled') return result.value;
  errors[key] = result.reason instanceof Error ? result.reason.message : 'unknown error';
  log.warn({ key, err: result.reason }, 'bootstrap sub-query failed');
  return fallback;
}

/**
 * GET /api/v1/bootstrap
 *
 * Aggregate cold-start payload that collapses the 7 separate REST calls the
 * frontend used to fan out at login (auth/me + settings + servers + folders +
 * per-server emojis × N + notification-counts + blocked). Connect-storm prep
 * for public-launch flash traffic.
 *
 * Failure mode: any individual sub-query failure is caught and surfaced via
 * the `errors` object; the rest of the payload is returned intact so the
 * client can render what it has and retry the failed slice on its own.
 */
router.get('/', authenticateToken, bootstrapLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const userId = req.userId;

  // Resolve user profile + settings + folders + notification counts + blocked
  // in parallel. Servers must finish before emojis can fire (need serverIds),
  // so we await the servers slice first and then race emojis with the others.
  const [
    userResult,
    settingsResult,
    serversResult,
    foldersResult,
    notificationCountsResult,
    blockedResult,
  ] = await Promise.allSettled([
    loadCurrentUserProfile(userId),
    loadUserSettings(userId),
    loadUserServers(userId),
    loadUserServerFolders(userId),
    loadNotificationCounts(userId),
    loadBlockedUsers(userId),
  ]);

  const errors: BootstrapErrors = {};

  const user = settledOr(userResult, 'user', errors, null);
  const settings = settledOr(settingsResult, 'settings', errors, { data: null, updatedAt: null });
  const servers = settledOr(serversResult, 'servers', errors, [] as unknown[]);
  const folders = settledOr(foldersResult, 'folders', errors, [] as unknown[]);
  const notificationCounts = settledOr(
    notificationCountsResult,
    'notificationCounts',
    errors,
    { total: 0, byServer: {} as Record<string, { unreadCount: number; mentionCount: number }> },
  );
  const blocked = settledOr(blockedResult, 'blocked', errors, [] as unknown[]);

  // Pull serverIds from the resolved servers list; if the server fetch failed
  // we just skip the emoji fan-out rather than firing it with an empty set.
  const serverIds = (Array.isArray(servers) ? servers : [])
    .map((s) => (s as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string');

  let emojis: Record<string, unknown[]> = {};
  if (serverIds.length > 0) {
    try {
      emojis = await loadEmojisForServers(serverIds);
    } catch (err) {
      errors.emojis = err instanceof Error ? err.message : 'unknown error';
      log.warn({ err }, 'bootstrap emoji fan-out failed');
    }
  }

  return res.json({
    user,
    settings,
    servers,
    folders,
    emojis,
    notificationCounts,
    blocked,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  });
}));

export default router;
