// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Platform token refresh utilities.
 *
 * Handles OAuth token refresh for Twitch, YouTube, and Reddit.
 * GitHub tokens don't expire — no refresh needed.
 */

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { encryptSecret, decryptSecret } from './mfaCrypto.js';

const log = logger.child({ module: 'platform-tokens' });

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || '';
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || '';
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID || '';
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET || '';

/**
 * Get a valid access token for a connected app, refreshing if expired.
 * Returns null if the app doesn't exist or refresh fails.
 */
export async function getValidPlatformToken(userId: string, provider: string): Promise<string | null> {
  const app = await prisma.connectedApp.findUnique({
    where: { userId_provider: { userId, provider } },
    select: { id: true, accessToken: true, refreshToken: true, tokenExpiresAt: true },
  });
  if (!app) return null;

  const accessToken = decryptSecret(app.accessToken);

  // GitHub tokens don't expire
  if (provider === 'github') return accessToken;

  // Check if token is still valid (with 5-minute buffer)
  if (app.tokenExpiresAt && app.tokenExpiresAt.getTime() > Date.now() + 5 * 60 * 1000) {
    return accessToken;
  }

  // Token expired or about to expire — refresh it
  const refreshToken = decryptSecret(app.refreshToken);
  if (!refreshToken) return null;

  try {
    let tokenRes: globalThis.Response;
    let tokenData: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };

    switch (provider) {
      case 'twitch': {
        tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: TWITCH_CLIENT_ID,
            client_secret: TWITCH_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          }),
          signal: AbortSignal.timeout(5000),
          redirect: 'manual',
        });
        tokenData = await tokenRes.json() as typeof tokenData;
        break;
      }
      case 'youtube': {
        tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: YOUTUBE_CLIENT_ID,
            client_secret: YOUTUBE_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          }),
          signal: AbortSignal.timeout(5000),
          redirect: 'manual',
        });
        tokenData = await tokenRes.json() as typeof tokenData;
        break;
      }
      case 'reddit': {
        const basicAuth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
        tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basicAuth}`,
            'User-Agent': 'Howl/1.0',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          }),
          signal: AbortSignal.timeout(5000),
          redirect: 'manual',
        });
        tokenData = await tokenRes.json() as typeof tokenData;
        break;
      }
      default:
        return null;
    }

    if (!tokenData.access_token) {
      log.warn({ provider, error: tokenData.error }, 'platform token refresh failed');
      return null;
    }

    // Update DB with new tokens
    const updateData: Record<string, unknown> = {
      accessToken: encryptSecret(tokenData.access_token),
      tokenExpiresAt: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null,
    };
    // Some providers return a new refresh token
    if (tokenData.refresh_token) {
      updateData.refreshToken = encryptSecret(tokenData.refresh_token);
    }

    await prisma.connectedApp.update({
      where: { id: app.id },
      data: updateData,
    });

    return tokenData.access_token;
  } catch (err) {
    log.warn({ err, provider }, 'platform token refresh threw');
    return null;
  }
}
