// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Steam activity polling service.
 *
 * Fetches game status for all users with linked Steam accounts via
 * GetPlayerSummaries/v2, upserts UserActivity records, and updates
 * SsoAccount display names / avatar URLs.
 */

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { fetchAndBroadcastActivities } from '../socketHandlers/infrastructure.js';
import type { ActivityBroadcastPayload } from '../socketHandlers/infrastructure.js';
import { logActivityToHistory, closeActivityHistory } from './activityHistory.js';
import { shouldOverwriteActivity } from './activityPriority.js';
import { writeSecondaryActivity, clearSecondaryByType, demotePrimaryToSecondary, promoteSecondaryToPrimary } from './secondaryActivity.js';

const log = logger.child({ module: 'steam-activity' });

const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
const BATCH_SIZE = 100; // Steam API accepts up to 100 steamids per request

interface SteamPlayer {
  steamid: string;
  personaname?: string;
  avatar?: string;
  avatarfull?: string;
  gameextrainfo?: string;
  gameid?: string;
}

export interface ActivityChange {
  userId: string;
  activity: ActivityBroadcastPayload | null;
}

export async function pollSteamActivities(): Promise<ActivityChange[]> {
  if (!STEAM_API_KEY) {
    log.debug('STEAM_API_KEY not configured, skipping poll');
    return [];
  }

  // Fetch Steam-linked accounts for online users who opted in (skip offline users to reduce API calls)
  const INACTIVITY_CUTOFF = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

  const steamAccounts = await prisma.ssoAccount.findMany({
    where: {
      provider: 'steam',
      user: {
        shareSteamActivity: true,
        status: { in: ['online', 'idle', 'dnd'] },
        sessions: {
          some: {
            lastActiveAt: { gte: INACTIVITY_CUTOFF },
          },
        },
      },
    },
    select: {
      id: true,
      providerId: true,
      displayName: true,
      avatarUrl: true,
      userId: true,
      user: {
        select: { id: true, shareSteamActivity: true, activitySourcePriority: true },
      },
    },
    take: 10_000,
  });

  // Also fetch users who have an existing steam_game activity (to detect game-stop even if they went offline)
  const usersWithSteamActivity = await prisma.userActivity.findMany({
    where: { type: 'steam_game', userId: { notIn: steamAccounts.map(a => a.userId) } },
    select: { userId: true },
    take: 10_000,
  });
  if (usersWithSteamActivity.length > 0) {
    const additionalAccounts = await prisma.ssoAccount.findMany({
      where: {
        provider: 'steam',
        userId: { in: usersWithSteamActivity.map(a => a.userId) },
        user: { shareSteamActivity: true },
      },
      select: { id: true, providerId: true, displayName: true, avatarUrl: true, userId: true, user: { select: { id: true, shareSteamActivity: true, activitySourcePriority: true } } },
      take: 10_000,
    });
    steamAccounts.push(...additionalAccounts);
  }

  const activeAccounts = steamAccounts;
  if (activeAccounts.length === 0) return [];

  // Get current activities for ALL types (needed for priority comparison)
  const currentActivities = await prisma.userActivity.findMany({
    where: {
      userId: { in: activeAccounts.map(a => a.userId) },
    },
    take: 10_000,
  });
  const activityByUserId = new Map(currentActivities.map(a => [a.userId, a]));
  const priorityByUserId = new Map(activeAccounts.map(a => [a.userId, a.user?.activitySourcePriority ?? null]));

  const secondaryActivities = await prisma.userSecondaryActivity.findMany({
    where: { userId: { in: activeAccounts.map(a => a.userId) } },
    take: 10_000,
  });
  const secondaryByUserId = new Map(secondaryActivities.map(a => [a.userId, a]));

  // Batch steam IDs
  const batches: typeof activeAccounts[] = [];
  for (let i = 0; i < activeAccounts.length; i += BATCH_SIZE) {
    batches.push(activeAccounts.slice(i, i + BATCH_SIZE));
  }

  const changes: ActivityChange[] = [];

  for (const batch of batches) {
    const steamIds = batch.map(a => a.providerId).join(',');
    try {
      const res = await fetch(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamIds}`,
        { signal: AbortSignal.timeout(5000), redirect: 'manual' },
      );
      if (!res.ok) {
        log.warn({ status: res.status }, 'Steam API returned non-OK status');
        continue;
      }

      const data = (await res.json()) as { response?: { players?: SteamPlayer[] } };
      const players = data.response?.players ?? [];
      const playerBySteamId = new Map(players.map(p => [p.steamid, p]));

      for (const account of batch) {
        const player = playerBySteamId.get(account.providerId);
        if (!player) continue;

        // Update SsoAccount displayName and avatarUrl only if changed (skip redundant DB writes)
        const ssoUpdate: Record<string, string> = {};
        const newDisplayName = player.personaname ? player.personaname.slice(0, 128) : undefined;
        const newAvatarUrl = (player.avatarfull || player.avatar) ? (player.avatarfull || player.avatar || '').slice(0, 2048) : undefined;
        if (newDisplayName && newDisplayName !== account.displayName) ssoUpdate.displayName = newDisplayName;
        if (newAvatarUrl && newAvatarUrl !== account.avatarUrl) ssoUpdate.avatarUrl = newAvatarUrl;
        if (Object.keys(ssoUpdate).length > 0) {
          await prisma.ssoAccount.update({
            where: { id: account.id },
            data: ssoUpdate,
          }).catch(err => log.warn({ err: (err as Error).message, ssoAccountId: account.id }, 'failed to update SSO display info'));
        }

        const existing = activityByUserId.get(account.userId);

        if (player.gameextrainfo) {
          // Truncate untrusted external data to match our schema bounds
          const gameName = player.gameextrainfo.slice(0, 128);
          const gameId = player.gameid ? player.gameid.slice(0, 64) : null;

          // Priority check: don't overwrite a higher-priority activity
          if (existing && existing.type !== 'steam_game') {
            if (!shouldOverwriteActivity('steam_game', existing.type, priorityByUserId.get(account.userId))) {
              // Steam lost priority — write to secondary instead of discarding
              const secondary = secondaryByUserId.get(account.userId);
              if (!secondary || secondary.type === 'steam_game' || secondary.name !== gameName) {
                await writeSecondaryActivity(account.userId, {
                  type: 'steam_game', name: gameName, platformId: gameId, platform: 'steam',
                });
                fetchAndBroadcastActivities(account.userId).catch(() => {});
              }
              continue;
            }
          }

          // If we're about to overwrite a different source, demote it to secondary
          if (existing && existing.type !== 'steam_game') {
            await demotePrimaryToSecondary(account.userId);
          }

          // User is playing a game — upsert activity
          const activity = await prisma.userActivity.upsert({
            where: { userId: account.userId },
            create: {
              userId: account.userId,
              type: 'steam_game',
              name: gameName,
              details: null,
              state: null,
              largeImage: null,
              smallImage: null,
              platformId: gameId,
              platform: 'steam',
              durationMs: null,
            },
            update: {
              type: 'steam_game',
              name: gameName,
              details: null,
              state: null,
              largeImage: null,
              smallImage: null,
              platformId: gameId,
              platform: 'steam',
              durationMs: null,
            },
          });

          // Report change only if new or game name changed
          if (!existing || existing.name !== gameName) {
            // Log to activity history only on actual change
            await logActivityToHistory(account.userId, { type: 'steam_game', name: gameName, platformId: gameId, platform: 'steam' })
              .catch(err => log.warn({ err: (err as Error).message, userId: account.userId }, 'failed to log activity history'));
            const payload: ActivityBroadcastPayload = {
              type: activity.type,
              name: activity.name,
              details: activity.details,
              state: activity.state,
              largeImage: activity.largeImage,
              smallImage: activity.smallImage,
              startedAt: activity.startedAt.toISOString(),
              platformId: activity.platformId,
              platform: activity.platform,
              durationMs: activity.durationMs,
            };
            changes.push({ userId: account.userId, activity: payload });
            fetchAndBroadcastActivities(account.userId).catch(() => {});
          }
        } else if (existing && existing.type === 'steam_game') {
          // Close history entry before deleting activity
          await closeActivityHistory(account.userId)
            .catch(err => log.warn({ err: (err as Error).message, userId: account.userId }, 'failed to close activity history'));
          // User stopped playing — delete steam_game activity
          await prisma.userActivity.delete({ where: { id: existing.id } }).catch(() => {});
          // Promote secondary to primary if one exists
          await promoteSecondaryToPrimary(account.userId);
          fetchAndBroadcastActivities(account.userId).catch(() => {});
          changes.push({ userId: account.userId, activity: null });
        }

        // Also check if steam_game was in secondary (game ended while it wasn't prioritized)
        if (!player.gameextrainfo) {
          const secondary = secondaryByUserId.get(account.userId);
          if (secondary && secondary.type === 'steam_game') {
            await clearSecondaryByType(account.userId, 'steam_game');
            fetchAndBroadcastActivities(account.userId).catch(() => {});
          }
        }
      }
    } catch (err) {
      log.error({ err: (err as Error).message, batchSize: batch.length }, 'Steam API poll batch failed');
    }
  }

  return changes;
}
