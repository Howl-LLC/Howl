// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Twitch live stream polling service.
 *
 * Polls Twitch Helix API for connected users to detect live streams.
 * When a user goes live, broadcasts activity status to friends/servers.
 * Mirrors the Spotify polling pattern (spotifyActivity.ts).
 */

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { fetchAndBroadcastActivities } from '../socketHandlers/infrastructure.js';
import { logActivityToHistory, closeActivityHistory } from './activityHistory.js';
import { getValidPlatformToken } from './platformTokens.js';
import { shouldOverwriteActivity } from './activityPriority.js';
import { writeSecondaryActivity, clearSecondaryByType, demotePrimaryToSecondary, promoteSecondaryToPrimary } from './secondaryActivity.js';
import type { ActivityChange } from './steamActivity.js';

const log = logger.child({ module: 'twitch-activity' });

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const PER_USER_DELAY_MS = 100;
const INACTIVITY_CUTOFF_MS = 5 * 24 * 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface TwitchStream {
  id: string;
  user_id: string;
  game_name: string;
  title: string;
  viewer_count: number;
  thumbnail_url: string;
  started_at: string;
  type: string; // 'live' or ''
}

export async function pollTwitchActivities(): Promise<ActivityChange[]> {
  if (!TWITCH_CLIENT_ID) {
    log.debug('TWITCH_CLIENT_ID not configured, skipping poll');
    return [];
  }

  const cutoff = new Date(Date.now() - INACTIVITY_CUTOFF_MS);

  // Find all users with Twitch connected + sharing enabled + active recently
  const twitchApps = await prisma.connectedApp.findMany({
    where: {
      provider: 'twitch',
      user: {
        shareTwitchActivity: true,
        sessions: { some: { lastActiveAt: { gte: cutoff } } },
      },
    },
    select: {
      userId: true,
      providerId: true,
      avatarUrl: true,
      displayName: true,
    },
    take: 200,
  });

  if (twitchApps.length === 0) return [];

  // Find users who currently have twitch_live activity but may have gone offline
  const usersWithTwitchActivity = await prisma.userActivity.findMany({
    where: { type: 'twitch_live' },
    select: { userId: true },
    take: 500,
  });
  const activeTwitchUserIds = new Set(usersWithTwitchActivity.map(a => a.userId));

  // Get current primary activities for priority checking
  const allUserIds = [...new Set([...twitchApps.map(a => a.userId), ...activeTwitchUserIds])];
  const currentActivities = await prisma.userActivity.findMany({
    where: { userId: { in: allUserIds } },
    select: { userId: true, type: true, id: true },
    take: allUserIds.length,
  });
  const activityByUser = new Map(currentActivities.map(a => [a.userId, a]));

  // Get user priority settings
  const userSettings = await prisma.user.findMany({
    where: { id: { in: allUserIds } },
    select: { id: true, activitySourcePriority: true },
    take: allUserIds.length,
  });
  const priorityByUser = new Map(userSettings.map(u => [u.id, u.activitySourcePriority]));

  const changes: ActivityChange[] = [];
  const connectedUserIds = new Set(twitchApps.map(a => a.userId));

  for (let i = 0; i < twitchApps.length; i++) {
    const app = twitchApps[i];

    try {
      const token = await getValidPlatformToken(app.userId, 'twitch');
      if (!token) continue;

      const res = await fetch(`https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(app.providerId)}`, {
        headers: { Authorization: `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID },
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      });

      const body = (await res.json()) as { data?: TwitchStream[] };
      const stream = body.data?.[0];
      const isLive = stream?.type === 'live';

      const existing = activityByUser.get(app.userId);
      const priority = priorityByUser.get(app.userId) ?? null;

      if (isLive) {
        if (!shouldOverwriteActivity('twitch_live', existing?.type, priority)) {
          // Can't overwrite current primary — write as secondary
          await writeSecondaryActivity(app.userId, {
            type: 'twitch_live',
            name: 'Live on Twitch',
            details: (stream.title || '').slice(0, 256),
            state: (stream.game_name || '').slice(0, 128),
            largeImage: stream.thumbnail_url ? stream.thumbnail_url.replace('{width}', '440').replace('{height}', '248').slice(0, 2048) : null,
            smallImage: (app.avatarUrl || '').slice(0, 2048),
            platformId: app.providerId.slice(0, 128),
            platform: 'twitch',
          });
          continue;
        }

        // Demote existing non-twitch primary to secondary
        if (existing && existing.type !== 'twitch_live') {
          await demotePrimaryToSecondary(app.userId);
        }

        const activity = await prisma.userActivity.upsert({
          where: { userId: app.userId },
          create: {
            userId: app.userId,
            type: 'twitch_live',
            name: 'Live on Twitch',
            details: (stream.title || '').slice(0, 256),
            state: (stream.game_name || '').slice(0, 128),
            largeImage: stream.thumbnail_url ? stream.thumbnail_url.replace('{width}', '440').replace('{height}', '248').slice(0, 2048) : null,
            smallImage: (app.avatarUrl || '').slice(0, 2048),
            platformId: app.providerId.slice(0, 128),
            platform: 'twitch',
            durationMs: null,
          },
          update: {
            name: 'Live on Twitch',
            details: (stream.title || '').slice(0, 256),
            state: (stream.game_name || '').slice(0, 128),
            largeImage: stream.thumbnail_url ? stream.thumbnail_url.replace('{width}', '440').replace('{height}', '248').slice(0, 2048) : null,
            smallImage: (app.avatarUrl || '').slice(0, 2048),
          },
        });

        await logActivityToHistory(app.userId, {
          type: activity.type,
          name: activity.name,
          details: activity.details,
          largeImage: activity.largeImage,
          smallImage: activity.smallImage,
          platformId: activity.platformId,
          platform: activity.platform,
        });

        changes.push({ userId: app.userId, activity: null });
        await fetchAndBroadcastActivities(app.userId);
      } else {
        // User is NOT live — clear twitch activity if exists
        if (existing?.type === 'twitch_live') {
          await prisma.userActivity.delete({ where: { id: existing.id } }).catch(() => {});
          await closeActivityHistory(app.userId);
          await promoteSecondaryToPrimary(app.userId);
          changes.push({ userId: app.userId, activity: null });
          await fetchAndBroadcastActivities(app.userId);
        }
        await clearSecondaryByType(app.userId, 'twitch_live');
      }
    } catch (err) {
      log.warn({ err, userId: app.userId }, 'twitch activity poll failed for user');
    }

    if (i < twitchApps.length - 1) {
      await sleep(PER_USER_DELAY_MS);
    }
  }

  // Handle orphaned activities — users with twitch_live but no connected+sharing account
  for (const userId of activeTwitchUserIds) {
    if (connectedUserIds.has(userId)) continue;
    const existing = activityByUser.get(userId);
    if (existing?.type === 'twitch_live') {
      await prisma.userActivity.delete({ where: { id: existing.id } }).catch(() => {});
      await closeActivityHistory(userId);
      await promoteSecondaryToPrimary(userId);
      changes.push({ userId, activity: null });
      await fetchAndBroadcastActivities(userId);
    }
    await clearSecondaryByType(userId, 'twitch_live');
  }

  return changes;
}
