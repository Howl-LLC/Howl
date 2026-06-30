// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Spotify token management — refresh and validation.
 *
 * Used by the polling service and future routes that need a valid
 * Spotify access token. Tokens are always encrypted at rest.
 *
 * Two layers of mutex prevent concurrent refresh races on token
 * rotation (Spotify may rotate the refresh_token, so two concurrent
 * refreshes with the same old token cause the loser to receive an
 * invalid_grant + delete the ConnectedApp):
 *
 *   1. Per-process Map — dedups concurrent in-flight refreshes
 *      within ONE replica (zero Redis round-trips on cache hit).
 *   2. Redis SET NX EX — dedups across replicas.
 *      The winner runs the HTTP refresh + DB write; the loser polls
 *      then re-reads the DB row to pick up the rotated refreshToken.
 */

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { redis } from '../redis.js';
import { cappedMapSet } from '../socketHandlers/infrastructure.js';
import { encryptSecret, decryptSecret } from './mfaCrypto.js';

const log = logger.child({ module: 'spotify-tokens' });

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';

// Refresh buffer — refresh if token expires within this window.
const EXPIRY_BUFFER_MS = 60_000;

// Per-process mutex — dedups concurrent refreshes within a single replica.
const refreshLocks = new Map<string, Promise<{ accessToken: string; expiresAt: Date } | null>>();
const MAX_REFRESH_LOCKS = 10_000;

// Redis distributed-mutex parameters.
const REDIS_LOCK_TTL_SEC = 10;             // Spotify HTTP timeout is 5s; double it for slack.
const REDIS_LOCK_POLL_INTERVAL_MS = 100;
const REDIS_LOCK_MAX_WAIT_MS = 12_000;     // > REDIS_LOCK_TTL_SEC * 1000 so a crashed winner can't starve us.

function spotifyRefreshLockKey(appId: string): string {
  return `refresh:spotify:${appId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Internal refresh implementation — callers should use refreshSpotifyToken(). */
async function doRefresh(
  connectedApp: { id: string; refreshToken: string },
): Promise<{ accessToken: string; expiresAt: Date } | null> {
  let plainRefreshToken: string;
  try {
    plainRefreshToken = decryptSecret(connectedApp.refreshToken);
  } catch {
    log.warn({ connectedAppId: connectedApp.id }, 'failed to decrypt Spotify refresh token — deleting connection');
    await prisma.connectedApp.delete({ where: { id: connectedApp.id } }).catch(() => {});
    return null;
  }

  const basicAuth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');

  let res: Response;
  try {
    res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: plainRefreshToken,
      }),
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
  } catch (err) {
    log.warn({ connectedAppId: connectedApp.id, err: (err as Error).message }, 'Spotify token refresh network error');
    return null;
  }

  if (res.status === 400 || res.status === 401) {
    // Token revoked or invalid — user needs to re-link
    log.warn({ connectedAppId: connectedApp.id, status: res.status }, 'Spotify refresh token revoked — deleting connection');
    await prisma.connectedApp.delete({ where: { id: connectedApp.id } }).catch(() => {});
    return null;
  }

  if (!res.ok) {
    log.warn({ connectedAppId: connectedApp.id, status: res.status }, 'Spotify token refresh returned non-OK status');
    return null;
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    log.warn({ connectedAppId: connectedApp.id }, 'Spotify token refresh returned no access_token');
    return null;
  }

  const expiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000);

  // Build update payload — always update access token and expiry
  const update: Record<string, string | Date> = {
    accessToken: encryptSecret(data.access_token),
    tokenExpiresAt: expiresAt,
  };

  // Spotify sometimes rotates the refresh token
  if (data.refresh_token) {
    update.refreshToken = encryptSecret(data.refresh_token);
  }

  await prisma.connectedApp.update({
    where: { id: connectedApp.id },
    data: update,
  }).catch(err => log.warn({ connectedAppId: connectedApp.id, err: (err as Error).message }, 'failed to persist refreshed Spotify tokens'));

  return { accessToken: data.access_token, expiresAt };
}

/**
 * Cross-replica refresh path. The Redis lock holder runs `doRefresh`; any
 * concurrent caller polls until the lock clears, then re-reads the DB row
 * and decrypts the freshly persisted accessToken (which the winner wrote
 * along with any rotated refreshToken).
 */
async function refreshWithRedisLock(
  connectedApp: { id: string; refreshToken: string },
): Promise<{ accessToken: string; expiresAt: Date } | null> {
  if (!redis) return doRefresh(connectedApp);

  const key = spotifyRefreshLockKey(connectedApp.id);
  const acquired = await redis.set(key, '1', 'EX', REDIS_LOCK_TTL_SEC, 'NX');

  if (acquired === 'OK') {
    try {
      return await doRefresh(connectedApp);
    } finally {
      await redis.del(key).catch(() => { /* TTL backstop releases anyway */ });
    }
  }

  // Loser path — wait for the winner to release the lock, then read the
  // refreshed row from the DB. Bounded by REDIS_LOCK_MAX_WAIT_MS so a
  // crashed winner can't deadlock callers (the lock TTL also caps this).
  const deadline = Date.now() + REDIS_LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(REDIS_LOCK_POLL_INTERVAL_MS);
    const stillHeld = await redis.exists(key);
    if (stillHeld === 0) break;
  }

  const row = await prisma.connectedApp.findUnique({
    where: { id: connectedApp.id },
    select: { accessToken: true, tokenExpiresAt: true },
  });
  if (!row || !row.tokenExpiresAt) {
    log.warn({ connectedAppId: connectedApp.id }, 'spotify refresh lock contended but post-wait DB row is missing or empty');
    return null;
  }
  try {
    return { accessToken: decryptSecret(row.accessToken), expiresAt: row.tokenExpiresAt };
  } catch (err) {
    log.warn({ connectedAppId: connectedApp.id, err: (err as Error).message }, 'failed to decrypt post-refresh Spotify access token');
    return null;
  }
}

/**
 * Refresh a Spotify access token using the stored refresh token.
 *
 * Concurrent refreshes for the same ConnectedApp dedup in two layers:
 *   - in-process Map for same-replica callers (the common case);
 *   - Redis SET NX EX for cross-replica callers.
 * Without the Redis layer, two replicas can both POST the same
 * refresh_token to Spotify, and the loser receives invalid_grant +
 * deletes the ConnectedApp once Spotify rotates the token.
 */
export async function refreshSpotifyToken(
  connectedApp: { id: string; refreshToken: string },
): Promise<{ accessToken: string; expiresAt: Date } | null> {
  const existing = refreshLocks.get(connectedApp.id);
  if (existing) return existing;

  const promise = refreshWithRedisLock(connectedApp);
  cappedMapSet(refreshLocks, connectedApp.id, promise, MAX_REFRESH_LOCKS);

  try {
    return await promise;
  } finally {
    refreshLocks.delete(connectedApp.id);
  }
}

/**
 * Get a valid plain-text Spotify access token, refreshing if needed.
 * Returns null if the token is expired and refresh failed.
 */
export async function getValidSpotifyToken(
  connectedApp: { id: string; accessToken: string; refreshToken: string; tokenExpiresAt: Date | null },
): Promise<string | null> {
  // Token still valid (with buffer)?
  if (connectedApp.tokenExpiresAt && connectedApp.tokenExpiresAt.getTime() > Date.now() + EXPIRY_BUFFER_MS) {
    try {
      return decryptSecret(connectedApp.accessToken);
    } catch {
      // Decryption failed — try refresh instead of giving up
    }
  }

  // Token expired or about to expire — refresh
  const result = await refreshSpotifyToken(connectedApp);
  return result?.accessToken ?? null;
}
