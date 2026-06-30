// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * YouTube live broadcast polling service.
 *
 * Polls YouTube Data API for connected users to detect active broadcasts.
 * Mirrors the Twitch polling pattern.
 */

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { fetchAndBroadcastActivities } from '../socketHandlers/infrastructure.js';
import { logActivityToHistory, closeActivityHistory } from './activityHistory.js';
import { getValidPlatformToken } from './platformTokens.js';
import { shouldOverwriteActivity } from './activityPriority.js';
import { writeSecondaryActivity, clearSecondaryByType, demotePrimaryToSecondary, promoteSecondaryToPrimary } from './secondaryActivity.js';
import type { ActivityChange } from './steamActivity.js';

const log = logger.child({ module: 'youtube-activity' });

const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || '';
const PER_USER_DELAY_MS = 150; // slightly more conservative for YouTube API quota
const INACTIVITY_CUTOFF_MS = 5 * 24 * 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface YouTubeBroadcast {
  id: string;
  snippet: {
    title: string;
    thumbnails: {
      default?: { url: string };
      high?: { url: string };
    };
  };
  status: {
    lifeCycleStatus: string; // 'live' | 'testing' | 'complete' | etc.
  };
}

export async function pollYouTubeActivities(): Promise<ActivityChange[]> {
  if (!YOUTUBE_CLIENT_ID) {
    log.debug('YOUTUBE_CLIENT_ID not configured, skipping poll');
    return [];
  }

  const cutoff = new Date(Date.now() - INACTIVITY_CUTOFF_MS);

  const youtubeApps = await prisma.connectedApp.findMany({
    where: {
      provider: 'youtube',
      user: {
        shareYouTubeActivity: true,
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

  if (youtubeApps.length === 0) return [];

  const usersWithYouTubeActivity = await prisma.userActivity.findMany({
    where: { type: 'youtube_live' },
    select: { userId: true },
    take: 500,
  });
  const activeYouTubeUserIds = new Set(usersWithYouTubeActivity.map(a => a.userId));

  const allUserIds = [...new Set([...youtubeApps.map(a => a.userId), ...activeYouTubeUserIds])];
  const currentActivities = await prisma.userActivity.findMany({
    where: { userId: { in: allUserIds } },
    select: { userId: true, type: true, id: true },
    take: allUserIds.length,
  });
  const activityByUser = new Map(currentActivities.map(a => [a.userId, a]));

  const userSettings = await prisma.user.findMany({
    where: { id: { in: allUserIds } },
    select: { id: true, activitySourcePriority: true },
    take: allUserIds.length,
  });
  const priorityByUser = new Map(userSettings.map(u => [u.id, u.activitySourcePriority]));

  const changes: ActivityChange[] = [];
  const connectedUserIds = new Set(youtubeApps.map(a => a.userId));

  for (let i = 0; i < youtubeApps.length; i++) {
    const app = youtubeApps[i];

    try {
      const token = await getValidPlatformToken(app.userId, 'youtube');
      if (!token) continue;

      const res = await fetch('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status&broadcastStatus=active&mine=true', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      });

      const body = (await res.json()) as { items?: YouTubeBroadcast[]; error?: { code?: number; message?: string } };

      // Handle quota exceeded gracefully
      if (body.error?.code === 403) {
        log.warn({ error: body.error.message }, 'YouTube API quota exceeded — skipping remaining users this cycle');
        break;
      }

      const broadcast = body.items?.[0];
      const isLive = !!broadcast && broadcast.status?.lifeCycleStatus === 'live';

      const existing = activityByUser.get(app.userId);
      const priority = priorityByUser.get(app.userId) ?? null;

      if (isLive) {
        const thumbnailUrl = (broadcast.snippet.thumbnails?.high?.url || broadcast.snippet.thumbnails?.default?.url || '').slice(0, 2048);

        if (!shouldOverwriteActivity('youtube_live', existing?.type, priority)) {
          await writeSecondaryActivity(app.userId, {
            type: 'youtube_live',
            name: 'Live on YouTube',
            details: (broadcast.snippet.title || '').slice(0, 256),
            state: null,
            largeImage: thumbnailUrl || null,
            smallImage: (app.avatarUrl || '').slice(0, 2048),
            platformId: app.providerId.slice(0, 128),
            platform: 'youtube',
          });
          continue;
        }

        if (existing && existing.type !== 'youtube_live') {
          await demotePrimaryToSecondary(app.userId);
        }

        const activity = await prisma.userActivity.upsert({
          where: { userId: app.userId },
          create: {
            userId: app.userId,
            type: 'youtube_live',
            name: 'Live on YouTube',
            details: (broadcast.snippet.title || '').slice(0, 256),
            state: null,
            largeImage: thumbnailUrl || null,
            smallImage: (app.avatarUrl || '').slice(0, 2048),
            platformId: app.providerId.slice(0, 128),
            platform: 'youtube',
            durationMs: null,
          },
          update: {
            name: 'Live on YouTube',
            details: (broadcast.snippet.title || '').slice(0, 256),
            largeImage: thumbnailUrl || null,
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
        if (existing?.type === 'youtube_live') {
          await prisma.userActivity.delete({ where: { id: existing.id } }).catch(() => {});
          await closeActivityHistory(app.userId);
          await promoteSecondaryToPrimary(app.userId);
          changes.push({ userId: app.userId, activity: null });
          await fetchAndBroadcastActivities(app.userId);
        }
        await clearSecondaryByType(app.userId, 'youtube_live');
      }
    } catch (err) {
      log.warn({ err, userId: app.userId }, 'youtube activity poll failed for user');
    }

    if (i < youtubeApps.length - 1) {
      await sleep(PER_USER_DELAY_MS);
    }
  }

  // Handle orphaned activities
  for (const userId of activeYouTubeUserIds) {
    if (connectedUserIds.has(userId)) continue;
    const existing = activityByUser.get(userId);
    if (existing?.type === 'youtube_live') {
      await prisma.userActivity.delete({ where: { id: existing.id } }).catch(() => {});
      await closeActivityHistory(userId);
      await promoteSecondaryToPrimary(userId);
      changes.push({ userId, activity: null });
      await fetchAndBroadcastActivities(userId);
    }
    await clearSecondaryByType(userId, 'youtube_live');
  }

  return changes;
}
