// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Spotify activity polling service.
 *
 * Fetches "currently playing" status for all users with connected Spotify
 * accounts, upserts UserActivity records, and broadcasts changes via Socket.IO.
 * Mirrors the Steam polling pattern (steamActivity.ts).
 */

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { fetchAndBroadcastActivities } from '../socketHandlers/infrastructure.js';
import type { ActivityBroadcastPayload } from '../socketHandlers/infrastructure.js';
import { logActivityToHistory, closeActivityHistory } from './activityHistory.js';
import { getValidSpotifyToken } from './spotifyTokens.js';
import { shouldOverwriteActivity } from './activityPriority.js';
import { writeSecondaryActivity, clearSecondaryByType, demotePrimaryToSecondary, promoteSecondaryToPrimary } from './secondaryActivity.js';
import type { ActivityChange } from './steamActivity.js';

const log = logger.child({ module: 'spotify-activity' });

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';

// Small delay between per-user API calls to respect Spotify rate limits
const PER_USER_DELAY_MS = 100;

interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  artists: Array<{ name: string }>;
  album: {
    name: string;
    images: Array<{ url: string; width?: number; height?: number }>;
  };
}

interface SpotifyCurrentlyPlaying {
  is_playing: boolean;
  item: SpotifyTrack | null;
  currently_playing_type: string; // 'track' | 'episode' | 'ad' | 'unknown'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function pollSpotifyActivities(): Promise<ActivityChange[]> {
  if (!SPOTIFY_CLIENT_ID) {
    log.debug('SPOTIFY_CLIENT_ID not configured, skipping poll');
    return [];
  }

  // Fetch Spotify-connected accounts for online users who opted in
  const INACTIVITY_CUTOFF = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

  const spotifyApps = await prisma.connectedApp.findMany({
    where: {
      provider: 'spotify',
      user: {
        shareSpotifyActivity: true,
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
      accessToken: true,
      refreshToken: true,
      tokenExpiresAt: true,
      userId: true,
      user: { select: { activitySourcePriority: true } },
    },
    take: 10_000,
  });

  // Also fetch users who have an existing 'spotify' activity but aren't in the first query
  // (to detect playback-stop when user goes offline or disables sharing)
  const activeUserIds = new Set(spotifyApps.map(a => a.userId));
  const usersWithSpotifyActivity = await prisma.userActivity.findMany({
    where: { type: 'spotify', userId: { notIn: [...activeUserIds] } },
    select: { userId: true },
    take: 10_000,
  });

  if (usersWithSpotifyActivity.length > 0) {
    const additionalApps = await prisma.connectedApp.findMany({
      where: {
        provider: 'spotify',
        userId: { in: usersWithSpotifyActivity.map(a => a.userId) },
      },
      select: {
        id: true, providerId: true, displayName: true, avatarUrl: true,
        accessToken: true, refreshToken: true, tokenExpiresAt: true, userId: true,
        user: { select: { activitySourcePriority: true } },
      },
      take: 10_000,
    });
    spotifyApps.push(...additionalApps);
  }

  if (spotifyApps.length === 0) return [];

  // Get current activities for ALL types (needed for priority comparison)
  const currentActivities = await prisma.userActivity.findMany({
    where: {
      userId: { in: spotifyApps.map(a => a.userId) },
    },
    take: 10_000,
  });
  const activityByUserId = new Map(currentActivities.map(a => [a.userId, a]));
  const priorityByUserId = new Map(spotifyApps.map(a => [a.userId, a.user?.activitySourcePriority ?? null]));

  const secondaryActivities = await prisma.userSecondaryActivity.findMany({
    where: { userId: { in: spotifyApps.map(a => a.userId) } },
    take: 10_000,
  });
  const secondaryByUserId = new Map(secondaryActivities.map(a => [a.userId, a]));

  const changes: ActivityChange[] = [];
  let skipped = 0;
  let rateLimited = false;

  // Process users sequentially to respect Spotify rate limits
  for (const app of spotifyApps) {
    if (rateLimited) {
      skipped++;
      continue;
    }

    try {
      // Get a valid access token (refreshes if expired)
      const token = await getValidSpotifyToken(app);
      if (!token) {
        skipped++;
        continue;
      }

      const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      });

      // 429 — rate limited by Spotify, bail out for this entire cycle
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        log.warn({ retryAfter, userId: app.userId }, 'Spotify rate limited — skipping remaining users this cycle');
        rateLimited = true;
        skipped++;
        continue;
      }

      // 401 — token invalid despite refresh, skip
      if (res.status === 401) {
        skipped++;
        continue;
      }

      const existing = activityByUserId.get(app.userId);

      // 204 or non-OK — user not playing anything
      if (res.status === 204 || !res.ok) {
        if (existing && existing.type === 'spotify') {
          await closeActivityHistory(app.userId)
            .catch(err => log.warn({ err: (err as Error).message, userId: app.userId }, 'failed to close activity history'));
          await prisma.userActivity.delete({ where: { id: existing.id } }).catch(() => {});
          await promoteSecondaryToPrimary(app.userId);
          fetchAndBroadcastActivities(app.userId).catch(() => {});
          changes.push({ userId: app.userId, activity: null });
        } else {
          // Clear secondary Spotify only if stale (>2 min since last update).
          // This prevents flicker from brief API 204s, track transitions, or pauses.
          const secondary = secondaryByUserId.get(app.userId);
          if (secondary && secondary.type === 'spotify') {
            const ageMs = Date.now() - new Date(secondary.updatedAt).getTime();
            if (ageMs > 120_000) {
              await clearSecondaryByType(app.userId, 'spotify');
              fetchAndBroadcastActivities(app.userId).catch(() => {});
            }
          }
        }
        if (res.status !== 204 && !res.ok) skipped++;
        await sleep(PER_USER_DELAY_MS);
        continue;
      }

      // 200 — parse response
      const data = (await res.json()) as SpotifyCurrentlyPlaying;

      // Not actively playing or not a track (podcast, ad, etc.)
      if (!data.is_playing || data.currently_playing_type !== 'track' || !data.item) {
        if (existing && existing.type === 'spotify') {
          await closeActivityHistory(app.userId)
            .catch(err => log.warn({ err: (err as Error).message, userId: app.userId }, 'failed to close activity history'));
          await prisma.userActivity.delete({ where: { id: existing.id } }).catch(() => {});
          await promoteSecondaryToPrimary(app.userId);
          fetchAndBroadcastActivities(app.userId).catch(() => {});
          changes.push({ userId: app.userId, activity: null });
        } else {
          // Clear secondary Spotify only if stale (>2 min since last update).
          // This prevents flicker from brief API 204s, track transitions, or pauses.
          const secondary = secondaryByUserId.get(app.userId);
          if (secondary && secondary.type === 'spotify') {
            const ageMs = Date.now() - new Date(secondary.updatedAt).getTime();
            if (ageMs > 120_000) {
              await clearSecondaryByType(app.userId, 'spotify');
              fetchAndBroadcastActivities(app.userId).catch(() => {});
            }
          }
        }
        await sleep(PER_USER_DELAY_MS);
        continue;
      }

      // Extract track info — truncate all external data
      const track = data.item;
      const trackName = track.name.slice(0, 128);
      const artistNames = track.artists.slice(0, 3).map(a => a.name).join(', ').slice(0, 128);
      const albumName = track.album.name.slice(0, 128);
      const largeImage = track.album.images[0]?.url?.slice(0, 2048) || null;
      const smallImage = (track.album.images.length > 1 ? track.album.images[track.album.images.length - 1]?.url : null)?.slice(0, 2048) || null;
      const trackId = track.id.slice(0, 64);
      const durationMs = track.duration_ms ?? null;

      // Same track already showing? No-op to avoid broadcast spam
      if (existing && existing.type === 'spotify' && existing.platformId === trackId) {
        await sleep(PER_USER_DELAY_MS);
        continue;
      }

      // Priority check: don't overwrite a higher-priority activity
      if (existing && existing.type !== 'spotify') {
        if (!shouldOverwriteActivity('spotify', existing.type, priorityByUserId.get(app.userId))) {
          // Spotify lost priority — write to secondary
          const secondary = secondaryByUserId.get(app.userId);
          const trackChanged = !secondary || secondary.type !== 'spotify' || secondary.platformId !== trackId;
          if (trackChanged) {
            await writeSecondaryActivity(app.userId, {
              type: 'spotify', name: trackName, details: artistNames, state: albumName,
              largeImage, smallImage, platformId: trackId, platform: 'spotify', durationMs,
            });
            fetchAndBroadcastActivities(app.userId).catch(() => {});
          }
          await sleep(PER_USER_DELAY_MS);
          continue;
        }
      }

      // If overwriting a different source, demote it to secondary
      if (existing && existing.type !== 'spotify') {
        await demotePrimaryToSecondary(app.userId);
      }

      // Upsert activity
      const activity = await prisma.userActivity.upsert({
        where: { userId: app.userId },
        create: {
          userId: app.userId,
          type: 'spotify',
          name: trackName,
          details: artistNames,
          state: albumName,
          largeImage,
          smallImage,
          platformId: trackId,
          platform: 'spotify',
          durationMs,
        },
        update: {
          type: 'spotify',
          name: trackName,
          details: artistNames,
          state: albumName,
          largeImage,
          smallImage,
          platformId: trackId,
          platform: 'spotify',
          durationMs,
        },
      });

      // Log to activity history
      await logActivityToHistory(app.userId, {
        type: 'spotify',
        name: trackName,
        details: artistNames,
        largeImage,
        smallImage,
        platformId: trackId,
        platform: 'spotify',
      }).catch(err => log.warn({ err: (err as Error).message, userId: app.userId }, 'failed to log activity history'));

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
      changes.push({ userId: app.userId, activity: payload });
      fetchAndBroadcastActivities(app.userId).catch(() => {});
    } catch (err) {
      log.warn({ err: (err as Error).message, userId: app.userId }, 'Spotify poll failed for user');
      skipped++;
    }

    await sleep(PER_USER_DELAY_MS);
  }

  log.info({ polled: true, total: spotifyApps.length, changed: changes.length, skipped, rateLimited }, 'spotify activity poll complete');
  return changes;
}
