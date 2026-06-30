// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { linkGameAccountSchema, GAME_PROVIDER_MAP, VALID_GAMES } from '../schemas.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getEffectivePlan } from '../utils.js';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { refreshGameAccountStats, fetchSteamPlaytime, fetchSteamRecentActivity } from '../services/gameStats.js';
import { logger } from '../logger.js';
import type { Server as SocketIOServer } from 'socket.io';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'game-accounts' });
const router = Router();

const gameAccountLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:game-accounts:'),
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

// GET / — list user's game accounts

router.get('/', authenticateToken, gameAccountLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  // Auto-link Steam games if Steam SSO exists but no game accounts
  const steamSso = await prisma.ssoAccount.findFirst({
    where: { userId: req.userId, provider: 'steam' },
    select: { providerId: true, displayName: true },
  });

  if (steamSso) {
    const existingSteamGames = await prisma.gameAccount.findMany({
      where: { userId: req.userId, provider: 'steam' },
      select: { game: true },
      take: 10,
    });
    const existingGameSet = new Set(existingSteamGames.map(g => g.game));

    for (const game of ['cs2', 'dota2'] as const) {
      if (!existingGameSet.has(game)) {
        const ga = await prisma.gameAccount.create({
          data: {
            userId: req.userId,
            game,
            provider: 'steam',
            platformId: steamSso.providerId,
            displayName: steamSso.displayName || null,
            verified: true,
          },
        });
        await prisma.gameStatsCache.create({ data: { gameAccountId: ga.id } });
        // Fire-and-forget initial stats fetch
        refreshGameAccountStats(ga.id).catch(err => {
          log.warn({ err, game, gameAccountId: ga.id }, 'auto-link initial fetch failed');
        });
      }
    }
  }

  const accounts = await prisma.gameAccount.findMany({
    where: { userId: req.userId },
    include: { statsCache: { select: { rank: true, stats: true, lastFetched: true, nextRefreshAt: true, fetchError: true, errorRetryCount: true, errorTransient: true } } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  // Check which games have displayed cards
  const layoutUser = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { showcaseLayout: true },
  });
  const displayedGames = new Set<string>();
  const layoutArr = layoutUser?.showcaseLayout as Array<{ game?: string; type?: string }> | null;
  if (layoutArr && Array.isArray(layoutArr)) {
    for (const card of layoutArr) {
      if (card.game && (card.type === 'game_rank' || card.type === 'game_stats' || card.type === 'rank_timeline')) {
        displayedGames.add(card.game);
      }
    }
  }

  res.json(accounts.map(a => ({
    id: a.id,
    game: a.game,
    provider: a.provider,
    platformId: a.platformId,
    platform: a.platform,
    displayName: a.displayName,
    verified: a.verified,
    createdAt: a.createdAt.toISOString(),
    rank: a.statsCache?.rank ?? null,
    stats: a.statsCache?.stats ?? null,
    lastFetched: a.statsCache?.lastFetched?.toISOString() ?? null,
    nextRefreshAt: a.statsCache?.nextRefreshAt?.toISOString() ?? null,
    fetchError: a.statsCache?.fetchError ?? null,
    errorRetryCount: a.statsCache?.errorRetryCount ?? 0,
    errorTransient: a.statsCache?.errorTransient ?? false,
    hasDisplayedCards: displayedGames.has(a.game),
  })));
}));

// POST / — link a game account (username entry for non-OAuth providers)

router.post('/', authenticateToken, gameAccountLimiter, validate(linkGameAccountSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const { game, platformId, platform, displayName } = req.body as {
    game: (typeof VALID_GAMES)[number];
    platformId: string;
    platform?: string | null;
    displayName?: string;
  };

  const provider = GAME_PROVIDER_MAP[game];
  if (!provider) return res.status(400).json({ error: 'Unsupported game' });

  // OAuth-linked providers must be connected through their respective OAuth flows, not here
  if (['steam', 'riot', 'epic'].includes(provider)) {
    return res.status(400).json({ error: `${game} requires OAuth connection. Use the Linked Apps settings to connect your ${provider === 'steam' ? 'Steam' : provider === 'riot' ? 'Riot Games' : 'Epic Games'} account first.` });
  }

  // Check for existing account for this game
  const existing = await prisma.gameAccount.findUnique({
    where: { userId_game: { userId: req.userId, game } },
  });
  if (existing) {
    return res.status(409).json({ error: `You already have a ${game} account linked. Unlink it first to change.` });
  }

  // TODO: Verify the account exists via the game's API before saving
  // For now, just save it — verification will be added when game stat fetchers are built

  const account = await prisma.gameAccount.create({
    data: {
      userId: req.userId,
      game,
      provider,
      platformId: platformId.trim(),
      platform: platform || null,
      displayName: displayName?.trim() || platformId.trim(),
      verified: false, // username-entry accounts are never verified
    },
  });

  // Create empty stats cache
  await prisma.gameStatsCache.create({
    data: { gameAccountId: account.id },
  });

  // Trigger initial stats fetch (fire-and-forget)
  refreshGameAccountStats(account.id).catch(err => {
    log.warn({ err, game, gameAccountId: account.id }, 'initial stats fetch failed');
  });

  log.info({ userId: req.userId, game, provider }, 'game account linked');

  const responseData = {
    id: account.id,
    game: account.game,
    provider: account.provider,
    platformId: account.platformId,
    platform: account.platform,
    displayName: account.displayName,
    verified: account.verified,
    createdAt: account.createdAt.toISOString(),
    rank: null,
    stats: null,
    lastFetched: null,
    nextRefreshAt: null,
    fetchError: null,
  };

  // Emit to all user's sockets for cross-tab sync
  const io = req.app.get('io') as SocketIOServer | undefined;
  if (io) {
    io.to(`user:${req.userId}`).emit('game-account-linked', responseData);
  }

  res.status(201).json(responseData);
}));

// DELETE /:id — unlink a game account

router.delete('/:id', validateUuidParams('id'), authenticateToken, gameAccountLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const account = await prisma.gameAccount.findUnique({
    where: { id: req.params.id as string },
    select: { id: true, userId: true, game: true },
  });

  if (!account) return res.status(404).json({ error: 'Game account not found' });
  if (account.userId !== req.userId) return res.status(403).json({ error: 'Not your account' });

  // Cascade deletes the GameStatsCache too
  await prisma.gameAccount.delete({ where: { id: account.id } });

  // Remove any showcase cards referencing this game
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { showcaseLayout: true } });
  if (user?.showcaseLayout && Array.isArray(user.showcaseLayout)) {
    const filtered = (user.showcaseLayout as Array<{ game?: string; type?: string; [k: string]: unknown }>).filter(
      card => !(card.game === account.game && (card.type === 'game_rank' || card.type === 'game_stats'))
    );
    if (filtered.length !== (user.showcaseLayout as unknown[]).length) {
      // Re-index positions
      const reindexed = filtered.map((card, i) => ({ ...card, position: i }));
      await prisma.user.update({ where: { id: req.userId }, data: { showcaseLayout: reindexed as unknown as Prisma.InputJsonValue } });
    }
  }

  log.info({ userId: req.userId, game: account.game }, 'game account unlinked');

  // Emit to all user's sockets for cross-tab sync
  const io = req.app.get('io') as SocketIOServer | undefined;
  if (io) {
    io.to(`user:${req.userId}`).emit('game-account-unlinked', { id: account.id, game: account.game });
  }

  res.json({ success: true });
}));

// POST /:id/refresh — manually trigger stats refresh for one game

router.post('/:id/refresh', validateUuidParams('id'), authenticateToken, gameAccountLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const account = await prisma.gameAccount.findUnique({
    where: { id: req.params.id as string },
    include: {
      statsCache: { select: { lastFetched: true, fetchError: true, errorRetryCount: true, errorTransient: true } },
      user: { select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true, showcaseLayout: true } },
    },
  });

  if (!account) return res.status(404).json({ error: 'Game account not found' });
  if (account.userId !== req.userId) return res.status(403).json({ error: 'Not your account' });

  // Block refresh for games that don't have any displayed cards in showcase
  const layoutArr = account.user.showcaseLayout as Array<{ game?: string; type?: string }> | null;
  const gameHasCards = layoutArr?.some(
    card => card.game === account.game && (card.type === 'game_rank' || card.type === 'game_stats' || card.type === 'rank_timeline')
  ) ?? false;

  if (!gameHasCards) {
    return res.status(400).json({
      error: 'Add a card for this game to your showcase to enable refresh',
      code: 'NO_DISPLAYED_CARDS',
    });
  }

  // Check manual refresh cooldown based on plan
  if (account.statsCache?.lastFetched) {
    const plan = getEffectivePlan(account.user);
    const cooldownHours = plan === 'pro' ? 1 : plan === 'essential' ? 3 : 24;
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    const elapsed = Date.now() - account.statsCache.lastFetched.getTime();

    // Cooldown selection:
    //   - transient outage on the provider side → 1h (don't hammer them)
    //   - normal error within retry budget → 30s (fast loop for fixable issues)
    //   - everything else → plan cooldown (1h Pro / 3h Essential / 24h Free)
    const hasError = !!account.statsCache.fetchError;
    const retryCount = account.statsCache.errorRetryCount ?? 0;
    const isTransient = !!account.statsCache.errorTransient;
    let effectiveCooldownMs: number;
    let cooldownReason: 'transient' | 'fast-retry' | 'normal';
    if (hasError && isTransient) {
      effectiveCooldownMs = 60 * 60 * 1000;
      cooldownReason = 'transient';
    } else if (hasError && retryCount < 5) {
      effectiveCooldownMs = 30_000;
      cooldownReason = 'fast-retry';
    } else {
      effectiveCooldownMs = cooldownMs;
      cooldownReason = 'normal';
    }

    if (elapsed < effectiveCooldownMs) {
      const nextAvailable = new Date(account.statsCache.lastFetched.getTime() + effectiveCooldownMs);
      return res.status(429).json({
        error: cooldownReason === 'transient'
          ? 'Provider is having issues — retry in ~1h'
          : cooldownReason === 'fast-retry'
            ? 'Error retry on cooldown (30s)'
            : 'Manual refresh on cooldown',
        nextRefreshAt: nextAvailable.toISOString(),
        cooldownHours: cooldownReason === 'normal' ? cooldownHours : null,
        errorRetryCount: retryCount,
        errorTransient: isTransient,
        maxRetries: 5,
      });
    }
  }

  // Fetch fresh stats
  const success = await refreshGameAccountStats(account.id);

  // If this is a Steam game, also refresh playtime data
  if (['cs2', 'dota2'].includes(account.game)) {
    const steamSso = await prisma.ssoAccount.findFirst({
      where: { userId: req.userId, provider: 'steam' },
      select: { providerId: true },
    });
    if (steamSso) {
      try {
        const [lifetime, recent] = await Promise.all([
          fetchSteamPlaytime(steamSso.providerId),
          fetchSteamRecentActivity(steamSso.providerId),
        ]);
        await prisma.user.update({
          where: { id: req.userId },
          data: {
            steamPlaytimeData: { lifetime, recent } as unknown as Prisma.InputJsonValue,
            steamPlaytimeFetchedAt: new Date(),
          },
        });
      } catch (err) {
        log.warn({ err }, 'steam playtime refresh alongside game stats failed');
      }
    }
  }

  // Return updated cache
  const updated = await prisma.gameStatsCache.findUnique({
    where: { gameAccountId: account.id },
    select: { rank: true, stats: true, lastFetched: true, nextRefreshAt: true, fetchError: true, errorRetryCount: true, errorTransient: true },
  });

  log.info({ userId: req.userId, game: account.game, success }, 'manual refresh completed');

  const refreshResult = {
    success,
    gameAccountId: account.id,
    game: account.game,
    rank: updated?.rank ?? null,
    stats: updated?.stats ?? null,
    lastFetched: updated?.lastFetched?.toISOString() ?? null,
    nextRefreshAt: updated?.nextRefreshAt?.toISOString() ?? null,
    fetchError: updated?.fetchError ?? null,
    errorRetryCount: updated?.errorRetryCount ?? 0,
    errorTransient: updated?.errorTransient ?? false,
  };

  // Emit to all user's sockets for cross-tab sync
  const io = req.app.get('io') as SocketIOServer | undefined;
  if (io) {
    io.to(`user:${req.userId}`).emit('game-account-refreshed', refreshResult);
  }

  res.json(refreshResult);
}));

export default router;
