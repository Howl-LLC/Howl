// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { validate } from '../middleware/validate.js';
import { updateShowcaseLayoutSchema, VALID_SHOWCASE_SIZES } from '../schemas.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getEffectivePlan } from '../utils.js';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { logger } from '../logger.js';
import type { SteamPlaytimeEntry } from '../services/gameStats.js';
import { fetchSteamPlaytime, fetchSteamRecentActivity } from '../services/gameStats.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'showcase' });
const router = Router();

/** Manual Steam refresh — tighter cooldown than the nightly batch job
 *  because it's user-initiated. Still capped so a user can't hammer the
 *  Steam Web API on a loop and burn the service's shared key quota. */
const STEAM_MANUAL_REFRESH_COOLDOWN_MS = 60 * 1000; // 60s between clicks
const steamRefreshLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:showcase-steam-refresh:'),
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many Steam refresh requests. Try again in a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const showcaseReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:showcase-read:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const showcaseWriteLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:showcase-write:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

// Free-tier sizes
const FREE_SIZES = new Set(['1x1', '2x1']);
// Essential sizes (everything except 3x2)
const ESSENTIAL_SIZES = new Set(['1x1', '2x1', '3x1', '1x2', '2x2', '1x3', '2x3']);

// GET /:userId — get a user's showcase

router.get('/:userId', validateUuidParams('userId'), authenticateToken, showcaseReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  const targetUserId = req.params.userId as string;

  // Privacy: check if blocked
  if (targetUserId !== req.userId) {
    const blocked = await prisma.block.findFirst({
      where: { OR: [{ blockerId: req.userId, blockedUserId: targetUserId }, { blockerId: targetUserId, blockedUserId: req.userId }] },
      select: { id: true },
    });
    if (blocked) return res.json({ layout: [], gameAccounts: [] });
  }

  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: {
      profilePrivate: true,
      showcaseLayout: true,
      showcaseMobileLayout: true,
      steamPlaytimeData: true,
      connectedApps: {
        where: { provider: { in: ['twitch', 'youtube', 'github', 'reddit'] } },
        select: {
          provider: true,
          displayName: true,
          avatarUrl: true,
          profileData: true,
          profileFetchedAt: true,
        },
        take: 10,
      },
      gameAccounts: {
        include: {
          statsCache: {
            select: { rank: true, stats: true, lastFetched: true, fetchError: true, errorRetryCount: true, errorTransient: true },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
      },
    },
  });

  if (!user) return res.status(404).json({ error: 'User not found' });

  // Private profile gate (checked after main query to avoid extra DB roundtrip)
  if (user.profilePrivate && targetUserId !== req.userId) {
    const isFriend = await prisma.friendRequest.findFirst({
      where: {
        status: 'accepted',
        OR: [
          { fromUserId: req.userId, toUserId: targetUserId },
          { fromUserId: targetUserId, toUserId: req.userId },
        ],
      },
      select: { id: true },
    });
    if (!isFriend) return res.json({ layout: [], gameAccounts: [], private: true });
  }

  // Handle both old format (array) and new format (object with lifetime/recent)
  const playtimeData = user.steamPlaytimeData as { lifetime?: SteamPlaytimeEntry[]; recent?: SteamPlaytimeEntry[] } | SteamPlaytimeEntry[] | null;
  const steamPlaytime = Array.isArray(playtimeData) ? playtimeData : playtimeData?.lifetime ?? [];
  const steamRecentActivity = Array.isArray(playtimeData) ? [] : playtimeData?.recent ?? [];

  // Compute which games have displayed cards in the showcase layout
  const displayedGames = new Set<string>();
  const layoutArr = user.showcaseLayout as Array<{ game?: string; type?: string }> | null;
  if (layoutArr && Array.isArray(layoutArr)) {
    for (const card of layoutArr) {
      if (card.game && (card.type === 'game_rank' || card.type === 'game_stats' || card.type === 'rank_timeline')) {
        displayedGames.add(card.game);
      }
    }
  }

  const hasSteamPlaytimeCard = layoutArr?.some(c => c.type === 'steam_playtime' || c.type === 'steam_recent_activity') ?? false;

  res.json({
    layout: user.showcaseLayout ?? [],
    mobileLayout: user.showcaseMobileLayout ?? null,
    steamPlaytime,
    steamRecentActivity,
    hasSteamPlaytimeCard: targetUserId === req.userId ? hasSteamPlaytimeCard : null,
    platformProfiles: (user.connectedApps || []).reduce((acc, app) => {
      acc[app.provider] = {
        displayName: app.displayName,
        avatarUrl: app.avatarUrl,
        profileData: app.profileData,
        profileFetchedAt: app.profileFetchedAt?.toISOString() ?? null,
      };
      return acc;
    }, {} as Record<string, unknown>),
    gameAccounts: user.gameAccounts.map(a => ({
      id: a.id,
      game: a.game,
      provider: a.provider,
      displayName: a.displayName,
      verified: a.verified,
      rank: a.statsCache?.rank ?? null,
      stats: a.statsCache?.stats ?? null,
      lastFetched: a.statsCache?.lastFetched?.toISOString() ?? null,
      fetchError: targetUserId === req.userId ? (a.statsCache?.fetchError ?? null) : null, // Only show errors to self
      errorRetryCount: targetUserId === req.userId ? (a.statsCache?.errorRetryCount ?? 0) : null,
      errorTransient: targetUserId === req.userId ? (a.statsCache?.errorTransient ?? false) : null,
      hasDisplayedCards: targetUserId === req.userId ? displayedGames.has(a.game) : null,
    })),
  });
}));

// PUT /layout — update own showcase layout

router.put('/layout', authenticateToken, showcaseWriteLimiter, validate(updateShowcaseLayoutSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const { layout } = req.body as {
    layout: Array<{
      id: string;
      type: string;
      game?: string | null;
      size: string;
      position: number;
      color?: string | null;
      config?: Record<string, unknown>;
    }>;
  };

  // Get user plan for gating
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const plan = getEffectivePlan(user);

  // Enforce card count limits
  const maxCards = plan === 'pro' ? 12 : plan === 'essential' ? 4 : 2;
  if (layout.length > maxCards) {
    return res.status(403).json({ error: `Your plan allows up to ${maxCards} showcase cards. Upgrade to add more.`, maxCards });
  }

  // Enforce size restrictions
  const allowedSizes = plan === 'pro' ? new Set(VALID_SHOWCASE_SIZES) : plan === 'essential' ? ESSENTIAL_SIZES : FREE_SIZES;
  for (const card of layout) {
    if (!allowedSizes.has(card.size)) {
      return res.status(403).json({ error: `Card size "${card.size}" is not available on your plan.` });
    }
  }

  // Enforce card type restrictions
  if (plan === 'free') {
    // Free users: no custom_text, no steam_playtime
    const restricted = layout.filter(c => c.type === 'custom_text' || c.type === 'steam_playtime');
    if (restricted.length > 0) {
      return res.status(403).json({ error: 'Custom text and Steam playtime cards require Howl Pro Essential or higher.' });
    }
  }

  // Validate game cards reference linked games
  const gameCards = layout.filter(c => c.game && (c.type === 'game_rank' || c.type === 'game_stats'));
  if (gameCards.length > 0) {
    const linkedGames = await prisma.gameAccount.findMany({
      where: { userId: req.userId },
      select: { game: true },
      take: 50,
    });
    const linkedSet = new Set(linkedGames.map(g => g.game));
    for (const card of gameCards) {
      if (card.game && !linkedSet.has(card.game)) {
        return res.status(400).json({ error: `Game "${card.game}" is not linked to your account.` });
      }
    }
  }

  // Validate provider-backed cards (Spotify/Twitch/YouTube/GitHub/Reddit/Steam)
  // reference a linked ConnectedApp or SsoAccount. Mirrors the frontend gating
  // and prevents clients from submitting cards for providers the user hasn't
  // linked (even if the UI is bypassed).
  const CARD_TYPE_PROVIDER_MAP: Record<string, { provider: string; source: 'connected' | 'sso' }> = {
    spotify_artists: { provider: 'spotify', source: 'connected' },
    spotify_tracks: { provider: 'spotify', source: 'connected' },
    spotify_now_playing: { provider: 'spotify', source: 'connected' },
    twitch_stats: { provider: 'twitch', source: 'connected' },
    youtube_stats: { provider: 'youtube', source: 'connected' },
    github_stats: { provider: 'github', source: 'connected' },
    reddit_stats: { provider: 'reddit', source: 'connected' },
    steam_playtime: { provider: 'steam', source: 'sso' },
    steam_recent_activity: { provider: 'steam', source: 'sso' },
  };
  const providerCards = layout.filter(c => CARD_TYPE_PROVIDER_MAP[c.type]);
  if (providerCards.length > 0) {
    const [connectedApps, ssoAccounts] = await Promise.all([
      prisma.connectedApp.findMany({ where: { userId: req.userId }, select: { provider: true }, take: 20 }),
      prisma.ssoAccount.findMany({ where: { userId: req.userId }, select: { provider: true }, take: 20 }),
    ]);
    const connectedSet = new Set(connectedApps.map(a => a.provider));
    const ssoSet = new Set(ssoAccounts.map(a => a.provider));
    for (const card of providerCards) {
      const meta = CARD_TYPE_PROVIDER_MAP[card.type]!;
      const present = meta.source === 'connected' ? connectedSet.has(meta.provider) : ssoSet.has(meta.provider);
      if (!present) {
        return res.status(400).json({ error: `Link ${meta.provider} in Linked Apps to use the "${card.type}" card.` });
      }
    }
  }

  // Re-index positions to be sequential
  const normalized = layout.map((card, i) => ({ ...card, position: i }));

  await prisma.user.update({
    where: { id: req.userId },
    data: { showcaseLayout: normalized as unknown as Prisma.InputJsonValue },
  });

  log.info({ userId: req.userId, cardCount: normalized.length }, 'showcase layout updated');

  // Emit to all own sessions for cross-tab / cross-device sync
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${req.userId}`).emit('showcase-layout-updated', { layout: normalized });
  }

  res.json({ layout: normalized });
}));

// PUT /mobile-layout — update own mobile showcase layout

router.put('/mobile-layout', authenticateToken, showcaseWriteLimiter, validate(updateShowcaseLayoutSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  // Get user plan for gating — mobile layout requires Essential+
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const plan = getEffectivePlan(user);
  // Matches shared/planPerks.ts → showcaseMobileLayout: plan === 'essential' || plan === 'pro'
  if (plan !== 'essential' && plan !== 'pro') {
    return res.status(403).json({ error: 'Mobile layout customization requires Howl Pro Essential or higher.' });
  }

  const { layout } = req.body as {
    layout: Array<{
      id: string;
      type: string;
      game?: string | null;
      size: string;
      position: number;
      color?: string | null;
      config?: Record<string, unknown>;
    }>;
  };

  // Enforce card count limits (same as desktop)
  const maxCards = plan === 'pro' ? 12 : plan === 'essential' ? 4 : 2;
  if (layout.length > maxCards) {
    return res.status(403).json({ error: `Your plan allows up to ${maxCards} showcase cards. Upgrade to add more.`, maxCards });
  }

  // Mobile layout uses 2-column grid — cap sizes to max 2 columns
  const MOBILE_VALID_SIZES = new Set(['1x1', '2x1', '1x2', '2x2', '1x3', '2x3']);
  for (const card of layout) {
    if (!MOBILE_VALID_SIZES.has(card.size)) {
      return res.status(400).json({ error: `Card size "${card.size}" is not supported on mobile (max 2 columns). Use 2x1 instead of 3x1.` });
    }
  }

  // Validate game cards reference linked games
  const gameCards = layout.filter(c => c.game && (c.type === 'game_rank' || c.type === 'game_stats' || c.type === 'rank_timeline'));
  if (gameCards.length > 0) {
    const linkedGames = await prisma.gameAccount.findMany({
      where: { userId: req.userId },
      select: { game: true },
      take: 50,
    });
    const linkedSet = new Set(linkedGames.map(g => g.game));
    for (const card of gameCards) {
      if (card.game && !linkedSet.has(card.game)) {
        return res.status(400).json({ error: `Game "${card.game}" is not linked to your account.` });
      }
    }
  }

  // Re-index positions
  const normalized = layout.map((card, i) => ({ ...card, position: i }));

  await prisma.user.update({
    where: { id: req.userId },
    data: { showcaseMobileLayout: normalized as unknown as Prisma.InputJsonValue },
  });

  log.info({ userId: req.userId, cardCount: normalized.length }, 'mobile showcase layout updated');

  // Emit to all own sessions for cross-tab / cross-device sync
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${req.userId}`).emit('showcase-layout-updated', { mobileLayout: normalized });
  }

  res.json({ mobileLayout: normalized });
}));

// DELETE /mobile-layout — remove mobile layout (revert to responsive reflow)

router.delete('/mobile-layout', authenticateToken, showcaseWriteLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  await prisma.user.update({
    where: { id: req.userId },
    data: { showcaseMobileLayout: Prisma.JsonNull },
  });

  log.info({ userId: req.userId }, 'mobile showcase layout removed');

  // Emit to all own sessions for cross-tab / cross-device sync
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${req.userId}`).emit('showcase-layout-updated', { mobileLayout: null });
  }

  res.json({ mobileLayout: null });
}));

// POST /refresh-steam — manual re-fetch of Steam playtime + recent
//
// User-facing refresh button for the Steam showcase cards. Re-fetches
// playtime + recent activity from the Steam Web API and overwrites
// steamPlaytimeData + steamPlaytimeFetchedAt on the user row. Layered
// cooldowns:
//   - express-rate-limit: 5/min per user (abuse ceiling)
//   - steamPlaytimeFetchedAt check: 60s between clicks (UX sanity)
// The nightly batch worker (cleanup-showcase) keeps data fresh without
// user action; this route is for "I linked a new game, let me see it
// now" moments.
router.post('/refresh-steam', authenticateToken, steamRefreshLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const steamSso = await prisma.ssoAccount.findFirst({
    where: { userId: req.userId, provider: 'steam' },
    select: { providerId: true },
  });
  if (!steamSso) {
    return res.status(400).json({ error: 'No Steam account linked. Connect Steam in Settings → Connections.' });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { steamPlaytimeFetchedAt: true },
  });
  if (user?.steamPlaytimeFetchedAt) {
    const elapsedMs = Date.now() - user.steamPlaytimeFetchedAt.getTime();
    if (elapsedMs < STEAM_MANUAL_REFRESH_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((STEAM_MANUAL_REFRESH_COOLDOWN_MS - elapsedMs) / 1000);
      return res.status(429).json({ error: `Please wait ${retryAfterSec}s before refreshing again.`, retryAfter: retryAfterSec });
    }
  }

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
    log.info({ userId: req.userId, lifetimeCount: lifetime.length, recentCount: recent.length }, 'steam refresh manual');
    res.json({
      steamPlaytime: lifetime as SteamPlaytimeEntry[],
      steamRecentActivity: recent as SteamPlaytimeEntry[],
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    log.warn({ err, userId: req.userId }, 'steam refresh failed');
    res.status(502).json({ error: 'Steam is unreachable right now. Try again in a minute.' });
  }
}));

export default router;
