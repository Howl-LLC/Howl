// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Showcase stats refresh worker.
 *
 * Runs every 10 minutes. Finds all GameStatsCache rows where nextRefreshAt <= now,
 * fetches fresh stats from external APIs, and updates the cache.
 *
 * Respects external API rate limits by processing sequentially per provider
 * and adding small delays between requests.
 */

import { Worker, Job } from 'bullmq';
import { redisConnection, queuesEnabled } from '../connection.js';
import { logger } from '../../logger.js';
import { prisma } from '../../db.js';
import { refreshGameAccountStats, fetchSteamPlaytime, fetchSteamRecentActivity } from '../../services/gameStats.js';
import { Prisma } from '../../../generated/prisma-client-v7/client.js';
import { refreshConnectedAppProfile } from '../../services/platformProfiles.js';

const log = logger.child({ module: 'worker:showcase-refresh' });

const BATCH_SIZE = 50;
const DELAY_BETWEEN_FETCHES_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processJob(_job: Job): Promise<void> {
  const now = new Date();
  const INACTIVITY_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
  const inactivityCutoff = new Date(now.getTime() - INACTIVITY_THRESHOLD_MS);

  // Find stale caches ONLY for users who have been active in the last 5 days
  const staleCaches = await prisma.gameStatsCache.findMany({
    where: {
      nextRefreshAt: { lte: now },
      gameAccount: {
        user: {
          sessions: {
            some: {
              lastActiveAt: { gte: inactivityCutoff },
            },
          },
        },
      },
    },
    select: {
      id: true,
      gameAccountId: true,
      gameAccount: {
        select: { id: true, game: true, provider: true, userId: true },
      },
    },
    orderBy: { nextRefreshAt: 'asc' },
    take: BATCH_SIZE,
  });

  if (staleCaches.length === 0) {
    log.debug('no stale showcase caches to refresh');
    return;
  }

  // Filter out game accounts that aren't displayed in the user's showcase
  const userIds = [...new Set(staleCaches.map(c => c.gameAccount.userId))];
  const userLayouts = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, showcaseLayout: true },
    take: userIds.length,
  });
  const layoutByUserId = new Map(userLayouts.map(u => [u.id, u.showcaseLayout]));

  function hasDisplayedCards(userId: string, game: string): boolean {
    const layout = layoutByUserId.get(userId);
    if (!layout || !Array.isArray(layout)) return false;
    return (layout as Array<{ game?: string; type?: string }>).some(
      card => card.game === game && (card.type === 'game_rank' || card.type === 'game_stats' || card.type === 'rank_timeline')
    );
  }

  const filteredCaches = staleCaches.filter(cache =>
    hasDisplayedCards(cache.gameAccount.userId, cache.gameAccount.game)
  );

  if (filteredCaches.length === 0) {
    log.debug('no displayed game accounts to refresh (all filtered out)');
    return;
  }

  log.info({ total: staleCaches.length, displayed: filteredCaches.length }, 'refreshing stale showcase stats (filtered to displayed games)');

  let success = 0;
  let failed = 0;

  // Group by provider to process sequentially within each provider
  const byProvider = new Map<string, typeof filteredCaches>();
  for (const cache of filteredCaches) {
    const provider = cache.gameAccount.provider;
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider)!.push(cache);
  }

  // Process each provider's accounts sequentially
  for (const [_provider, caches] of byProvider) {
    for (let i = 0; i < caches.length; i++) {
      const cache = caches[i];
      try {
        const ok = await refreshGameAccountStats(cache.gameAccountId);
        if (ok) success++;
        else failed++;
      } catch (err) {
        failed++;
        log.warn({ err, gameAccountId: cache.gameAccountId, game: cache.gameAccount.game }, 'showcase refresh failed for account');
      }

      // Rate limit delay between fetches
      if (i < caches.length - 1) {
        await sleep(DELAY_BETWEEN_FETCHES_MS);
      }
    }
  }

  log.info({ total: filteredCaches.length, success, failed }, 'showcase refresh poll complete');

  // Also refresh Steam playtime — but ONLY for users who have steam_playtime or steam_recent_activity cards displayed
  try {
    const steamUsers = await prisma.ssoAccount.findMany({
      where: {
        provider: 'steam',
        user: {
          OR: [
            { steamPlaytimeFetchedAt: null },
            { steamPlaytimeFetchedAt: { lte: new Date(Date.now() - 6 * 60 * 60 * 1000) } },
          ],
          sessions: {
            some: {
              lastActiveAt: { gte: inactivityCutoff },
            },
          },
        },
      },
      select: { userId: true, providerId: true },
      take: 20,
    });

    // Filter to users who have steam_playtime or steam_recent_activity cards displayed
    const steamUserIds = steamUsers.map(su => su.userId);
    const steamLayouts = await prisma.user.findMany({
      where: { id: { in: steamUserIds } },
      select: { id: true, showcaseLayout: true },
      take: steamUserIds.length,
    });
    const steamLayoutMap = new Map(steamLayouts.map(u => [u.id, u.showcaseLayout]));

    const filteredSteamUsers = steamUsers.filter(su => {
      const layout = steamLayoutMap.get(su.userId);
      if (!layout || !Array.isArray(layout)) return false;
      return (layout as Array<{ type?: string }>).some(
        card => card.type === 'steam_playtime' || card.type === 'steam_recent_activity'
      );
    });

    for (const su of filteredSteamUsers) {
      try {
        const [lifetime, recent] = await Promise.all([
          fetchSteamPlaytime(su.providerId),
          fetchSteamRecentActivity(su.providerId),
        ]);
        await prisma.user.update({
          where: { id: su.userId },
          data: {
            steamPlaytimeData: { lifetime, recent } as unknown as Prisma.InputJsonValue,
            steamPlaytimeFetchedAt: new Date(),
          },
        });
      } catch (err) {
        log.warn({ err, userId: su.userId }, 'steam playtime refresh failed');
      }
      if (filteredSteamUsers.indexOf(su) < filteredSteamUsers.length - 1) {
        await sleep(DELAY_BETWEEN_FETCHES_MS);
      }
    }
  } catch (err) {
    log.warn({ err }, 'steam playtime batch refresh failed');
  }

  // Refresh stale connected app profiles (Twitch, YouTube, GitHub, Reddit)
  try {
    const staleApps = await prisma.connectedApp.findMany({
      where: {
        provider: { in: ['twitch', 'youtube', 'github', 'reddit'] },
        nextProfileRefreshAt: { lte: now },
        user: {
          sessions: {
            some: {
              lastActiveAt: { gte: inactivityCutoff },
            },
          },
        },
      },
      select: { id: true, provider: true, userId: true },
      orderBy: { nextProfileRefreshAt: 'asc' },
      take: 30,
    });

    if (staleApps.length > 0) {
      log.info({ count: staleApps.length }, 'refreshing stale connected app profiles');

      for (let i = 0; i < staleApps.length; i++) {
        try {
          await refreshConnectedAppProfile(staleApps[i].id);
        } catch (err) {
          log.warn({ err, appId: staleApps[i].id, provider: staleApps[i].provider }, 'connected app profile refresh failed');
        }
        if (i < staleApps.length - 1) {
          await sleep(DELAY_BETWEEN_FETCHES_MS);
        }
      }
    }
  } catch (err) {
    log.warn({ err }, 'connected app profile batch refresh failed');
  }
}

export function startShowcaseRefreshWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;

  const worker = new Worker('showcase-refresh', processJob, {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: 120_000,
  });

  worker.on('failed', (job, err) => {
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (job && job.attemptsMade >= maxAttempts) {
      log.error({ jobId: job.id, err, attemptsMade: job.attemptsMade }, 'DEAD_LETTER: showcase refresh job permanently failed');
    } else {
      log.warn({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'showcase refresh job failed (will retry)');
    }
  });

  log.info('showcase refresh worker started');
  return worker;
}
