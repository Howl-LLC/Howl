// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { JWT_SECRET, authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { validate } from '../middleware/validate.js';
import { listenAlongSchema, spotifyPlayPauseSchema, spotifyShuffleSchema, spotifyRepeatSchema } from '../schemas.js';
import { logger } from '../logger.js';
import { encryptSecret } from '../services/mfaCrypto.js';
import { sensitiveActionLimiter } from './authHelpers.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getValidSpotifyToken } from '../services/spotifyTokens.js';
import { redis } from '../redis.js';
import { refreshGameAccountStats } from '../services/gameStats.js';
import { refreshConnectedAppProfile } from '../services/platformProfiles.js';
import { getEffectivePlan } from '../utils.js';
import { closeActivityHistory } from '../services/activityHistory.js';
import type { Server as SocketIOServer } from 'socket.io';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'connected-apps' });

const router = Router();

const FRONTEND_URL = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000').split(',')[0].trim();

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:5000/api/v1/connected-apps/spotify/callback';
const SPOTIFY_SCOPES = 'user-read-currently-playing user-read-playback-state user-read-recently-played user-top-read user-modify-playback-state';

const REQUIRED_SCOPES = SPOTIFY_SCOPES.split(' ');

// Riot RSO
const RIOT_CLIENT_ID = process.env.RIOT_CLIENT_ID || '';
const RIOT_CLIENT_SECRET = process.env.RIOT_CLIENT_SECRET || '';
const RIOT_REDIRECT_URI = process.env.RIOT_REDIRECT_URI || 'http://localhost:5000/api/v1/connected-apps/riot/callback';
const RIOT_SCOPES = 'openid offline_access';

// Epic Games
const EPIC_CLIENT_ID = process.env.EPIC_CLIENT_ID || '';
const EPIC_CLIENT_SECRET = process.env.EPIC_CLIENT_SECRET || '';
const EPIC_REDIRECT_URI = process.env.EPIC_REDIRECT_URI || 'http://localhost:5000/api/v1/connected-apps/epic/callback';
const EPIC_SCOPES = 'basic_profile';

// Twitch
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const TWITCH_REDIRECT_URI = process.env.TWITCH_REDIRECT_URI || 'http://localhost:5000/api/v1/connected-apps/twitch/callback';
const TWITCH_SCOPES = 'user:read:email';

// YouTube (Google)
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || '';
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || '';
const YOUTUBE_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:5000/api/v1/connected-apps/youtube/callback';
const YOUTUBE_SCOPES = 'https://www.googleapis.com/auth/youtube.readonly';

// GitHub
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI || 'http://localhost:5000/api/v1/connected-apps/github/callback';
const GITHUB_SCOPES = 'read:user';

// Reddit
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID || '';
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET || '';
const REDDIT_REDIRECT_URI = process.env.REDDIT_REDIRECT_URI || 'http://localhost:5000/api/v1/connected-apps/reddit/callback';
const REDDIT_SCOPES = 'identity,mysubreddits';

// Cookie names — distinct from SSO cookies to avoid collision
const APP_STATE_COOKIE = 'howl_app_state';
const APP_USER_COOKIE = 'howl_app_user';
const APP_STATE_MAX_AGE_MS = 5 * 60 * 1000;
const COOKIE_PATH = '/api';
// Use SameSite=None in production so the cookie survives the cross-site
// redirect back from the OAuth provider (Spotify/Twitch/etc. → our callback)
// in browsers with strict tracking protection (Safari ITP, Firefox ETP Strict,
// Brave Shields). Requires `secure: true`. In dev (http://localhost) browsers
// reject `None` without `Secure`, so fall back to `Lax`.
const COOKIE_SAMESITE: 'none' | 'lax' = process.env.NODE_ENV === 'production' ? 'none' : 'lax';

// Rate limiters

const appInitLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:app-init:'),
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many connection requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Prefer connect_token (unique per click, works on GET /connect where
  // authenticateToken hasn't run), then userId, then IP. IP fallback alone
  // starves shared-network users (dorm/office/CGNAT).
  keyGenerator: (req) => {
    const ct = typeof req.query.connect_token === 'string' ? req.query.connect_token : null;
    if (ct) return `t:${ct.slice(-40)}`;
    const uid = (req as AuthRequest).userId;
    if (uid) return `u:${uid}`;
    return `i:${getClientIp(req) ?? 'anonymous'}`;
  },
});

const appCallbackLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:app-callback:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many callback attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Key on state cookie (unique per OAuth flow) instead of IP so shared
  // networks can each link across all 7 providers without colliding.
  keyGenerator: (req) => {
    const s = req.cookies?.[APP_STATE_COOKIE];
    if (typeof s === 'string' && s.length === 64) return `s:${s}`;
    return `i:${getClientIp(req) ?? 'anonymous'}`;
  },
});

const appListLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:app-list:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const spotifyReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:spotify-read:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const spotifyTopLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:spotify-top:'),
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const spotifySharedLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:spotify-shared:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

// Spotify helpers

async function getSpotifyApp(userId: string) {
  return prisma.connectedApp.findUnique({
    where: { userId_provider: { userId, provider: 'spotify' } },
    select: { id: true, accessToken: true, refreshToken: true, tokenExpiresAt: true, displayName: true, avatarUrl: true, scopes: true },
  });
}

async function spotifyFetch(token: string, url: string): Promise<globalThis.Response> {
  return fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
    redirect: 'manual',
  });
}

async function isBlocked(userA: string, userB: string): Promise<boolean> {
  const block = await prisma.block.findFirst({
    where: { OR: [{ blockerId: userA, blockedUserId: userB }, { blockerId: userB, blockedUserId: userA }] },
    select: { id: true },
  });
  return !!block;
}

async function areFriends(userA: string, userB: string): Promise<boolean> {
  const count = await prisma.friendRequest.count({
    where: {
      status: 'accepted',
      OR: [{ fromUserId: userA, toUserId: userB }, { fromUserId: userB, toUserId: userA }],
    },
  });
  return count > 0;
}

const VALID_TIME_RANGES = ['short_term', 'medium_term', 'long_term'] as const;

// CSRF state helpers

function generateAppState(res: Response): string {
  const state = crypto.randomBytes(32).toString('hex');
  res.cookie(APP_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: COOKIE_SAMESITE,
    maxAge: APP_STATE_MAX_AGE_MS,
    path: COOKIE_PATH,
  });
  log.info({ stateLen: state.length, path: COOKIE_PATH, sameSite: COOKIE_SAMESITE, secure: process.env.NODE_ENV === 'production' }, 'CSRF state cookie issued on /connect');
  return state;
}

/**
 * Validate the CSRF state cookie against the baseState extracted from the
 * callback URL. Callers MUST pass the parsed baseState (with any
 * `:electron:<nonce>` suffix already stripped). Passing through `req.query`
 * does not work under Express 5 because writing `req.query.state = …` does
 * not persist across the lazy getter — use the explicit parameter.
 */
function validateAppState(req: Request, res: Response, queryState: string | undefined): boolean {
  const cookie = req.cookies?.[APP_STATE_COOKIE] as string | undefined;
  const query = queryState;
  const path = req.originalUrl.split('?')[0];
  res.clearCookie(APP_STATE_COOKIE, { path: COOKIE_PATH });
  if (!cookie) {
    log.warn({ path, reason: 'cookie-missing', hasQueryState: !!query, queryLen: query?.length ?? 0 }, 'invalid_state: CSRF cookie missing on callback');
    return false;
  }
  if (!query) {
    log.warn({ path, reason: 'query-missing', cookieLen: cookie.length }, 'invalid_state: query state missing on callback');
    return false;
  }
  if (cookie.length !== query.length) {
    log.warn({ path, reason: 'length-mismatch', cookieLen: cookie.length, queryLen: query.length }, 'invalid_state: cookie and query state length differ');
    return false;
  }
  try {
    const match = crypto.timingSafeEqual(Buffer.from(cookie, 'utf8'), Buffer.from(query, 'utf8'));
    if (!match) log.warn({ path, reason: 'value-mismatch', len: cookie.length }, 'invalid_state: cookie and query state values differ (CSRF)');
    return match;
  } catch (err) {
    log.warn({ path, reason: 'compare-threw', error: (err as Error).message }, 'invalid_state: timingSafeEqual threw');
    return false;
  }
}

// Electron deep-link helpers

const ELECTRON_NONCE_RE = /^[a-f0-9]{32}$/;

function parseElectronState(rawState: string | undefined): { baseState: string; electronNonce: string | null } {
  if (!rawState) return { baseState: '', electronNonce: null };
  const idx = rawState.indexOf(':electron:');
  if (idx === -1) return { baseState: rawState, electronNonce: null };
  const nonce = rawState.slice(idx + ':electron:'.length);
  return {
    baseState: rawState.slice(0, idx),
    electronNonce: ELECTRON_NONCE_RE.test(nonce) ? nonce : null,
  };
}

async function storeElectronAppNonce(nonce: string, provider: string): Promise<boolean> {
  if (!ELECTRON_NONCE_RE.test(nonce)) {
    log.warn({ provider, nonceLen: nonce.length }, 'electron-nonce: bad format on /connect, store skipped');
    return false;
  }
  if (!redis) {
    log.error({ provider }, 'electron-nonce: redis unavailable on /connect, store skipped');
    return false;
  }
  await redis.set(`app-electron:${nonce}`, JSON.stringify({ provider }), 'EX', 300);
  log.info({ provider, nonceLen: nonce.length }, 'electron-nonce: stored on /connect (TTL 300s)');
  return true;
}

async function consumeElectronAppNonce(nonce: string): Promise<{ provider: string } | null> {
  if (!ELECTRON_NONCE_RE.test(nonce)) {
    log.warn({ reason: 'bad-format', nonceLen: nonce.length }, 'invalid_state: electron-nonce bad format on callback');
    return null;
  }
  if (!redis) {
    log.error({ reason: 'redis-unavailable' }, 'invalid_state: electron-nonce redis unavailable on callback');
    return null;
  }
  const raw = await redis.get(`app-electron:${nonce}`);
  if (!raw) {
    log.warn({ reason: 'redis-miss-or-expired' }, 'invalid_state: electron-nonce missing or expired in redis on callback');
    return null;
  }
  await redis.del(`app-electron:${nonce}`);
  try { return JSON.parse(raw); } catch (err) {
    log.warn({ reason: 'json-parse-failed', error: (err as Error).message }, 'invalid_state: electron-nonce redis value unparseable');
    return null;
  }
}

function settingsRedirect(res: Response, params: Record<string, string>, electronNonce: string | null): void {
  if (electronNonce) {
    const qs = new URLSearchParams({ ...params, nonce: electronNonce }).toString();
    res.redirect(`howl://settings/callback?${qs}`);
  } else {
    const qs = new URLSearchParams(params).toString();
    res.redirect(`${FRONTEND_URL}/settings?${qs}`);
  }
}

/**
 * Pull the Electron system-browser nonce off a /:provider/connect request.
 * The renderer (via preload.startAppConnect → main.handleSsoSystemBrowser)
 * opens the system browser with `?platform=electron&nonce=<uuid>` appended,
 * and we echo the nonce back in the deep link so Electron can route the
 * result to the correct renderer window.
 *
 * Centralised so every /connect handler can short-circuit early-error
 * paths (missing env vars, bad connect_token) through settingsRedirect
 * instead of dead-ending in raw JSON — on Electron a raw JSON error page
 * looks like the window "opened and closed" with no feedback.
 */
function getElectronConnectNonce(req: Request): string | null {
  const platform = req.query.platform;
  const nonce = req.query.nonce;
  if (platform === 'electron' && typeof nonce === 'string' && nonce.length > 0 && nonce.length <= 128) {
    return nonce;
  }
  return null;
}

// POST /spotify/connect-token

router.post('/spotify/connect-token', authenticateToken, appInitLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  const connectToken = jwt.sign({ userId: req.userId, purpose: 'spotify-connect' }, JWT_SECRET, { expiresIn: '5m' });
  res.json({ connectToken });
}));

// GET /spotify/connect

router.get('/spotify/connect', appInitLimiter, asyncHandler(async (req: Request, res: Response) => {
  const electronConnectNonce = getElectronConnectNonce(req);
  if (!SPOTIFY_CLIENT_ID) return settingsRedirect(res, { app_error: 'not_configured', provider: 'spotify' }, electronConnectNonce);

  // Verify connect_token from query param (frontend obtained this via POST /spotify/connect-token)
  const connectToken = req.query.connect_token as string | undefined;
  if (!connectToken) return res.redirect(`${FRONTEND_URL}/settings?app_error=invalid_connect_token`);

  let userId: string;
  try {
    const decoded = jwt.verify(connectToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
    if (decoded.purpose !== 'spotify-connect') throw new Error('Invalid token purpose');
    userId = decoded.userId;
  } catch {
    return res.redirect(`${FRONTEND_URL}/settings?app_error=invalid_connect_token`);
  }

  // Store userId in a signed short-lived JWT cookie (callback is a redirect, not an authenticated API call)
  const userToken = jwt.sign({ userId, purpose: 'spotify-connect' }, JWT_SECRET, { expiresIn: '5m' });
  res.cookie(APP_USER_COOKIE, userToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: COOKIE_SAMESITE,
    maxAge: APP_STATE_MAX_AGE_MS,
    path: COOKIE_PATH,
  });

  const state = generateAppState(res);

  // Electron system-browser flow: embed nonce in state
  const electronNonce = req.query.nonce as string | undefined;
  const platform = req.query.platform as string | undefined;
  let finalState = state;
  if (platform === 'electron' && electronNonce) {
    const stored = await storeElectronAppNonce(electronNonce, 'spotify');
    if (!stored) return res.status(503).json({ error: 'Electron SSO requires Redis' });
    finalState = state + ':electron:' + electronNonce;
  }

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: SPOTIFY_SCOPES,
    state: finalState,
    show_dialog: 'true',
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
}));

// GET /spotify/callback

router.get('/spotify/callback', appCallbackLimiter, asyncHandler(async (req: Request, res: Response) => {
  const clearCookies = () => {
    res.clearCookie(APP_USER_COOKIE, { path: COOKIE_PATH });
  };

  // Hoisted so the catch block can reach the Electron nonce. Without
  // this an unhandled exception drops the nonce, settingsRedirect falls
  // back to the web FRONTEND_URL path, and the Electron renderer never
  // hears back — the browser window just closes with no feedback.
  const rawState = req.query.state as string | undefined;
  const { baseState, electronNonce } = parseElectronState(rawState);

  try {

    // Validate CSRF state (also clears state cookie)
    if (!validateAppState(req, res, baseState)) {
      clearCookies();
      return settingsRedirect(res, { app_error: 'invalid_state' }, electronNonce);
    }

    if (electronNonce) {
      const nonceData = await consumeElectronAppNonce(electronNonce);
      if (!nonceData) {
        clearCookies();
        return settingsRedirect(res, { app_error: 'invalid_state' }, null);
      }
    }

    // Verify user identity from signed JWT cookie
    const userCookie = req.cookies?.[APP_USER_COOKIE] as string | undefined;
    clearCookies();
    if (!userCookie) {
      return settingsRedirect(res, { app_error: 'missing_session' }, electronNonce);
    }

    let userId: string;
    try {
      const decoded = jwt.verify(userCookie, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
      if (decoded.purpose !== 'spotify-connect') throw new Error('Invalid token purpose');
      userId = decoded.userId;
    } catch {
      return settingsRedirect(res, { app_error: 'invalid_session' }, electronNonce);
    }

    // User denied consent on Spotify
    if (req.query.error) {
      return settingsRedirect(res, { app_error: 'spotify_denied' }, electronNonce);
    }

    const code = req.query.code as string;
    if (!code) {
      return settingsRedirect(res, { app_error: 'missing_code' }, electronNonce);
    }

    // Exchange authorization code for tokens (Basic auth = base64(client_id:client_secret))
    const basicAuth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
    };

    if (!tokenData.access_token || !tokenData.refresh_token) {
      log.warn({ error: tokenData.error }, 'Spotify token exchange failed');
      return settingsRedirect(res, { app_error: 'token_exchange_failed' }, electronNonce);
    }

    // Fetch Spotify user profile
    const profileRes = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });

    const profile = (await profileRes.json()) as {
      id?: string;
      display_name?: string;
      images?: Array<{ url: string }>;
    };

    if (!profile.id) {
      log.warn('Spotify profile fetch returned no user ID');
      return settingsRedirect(res, { app_error: 'profile_fetch_failed' }, electronNonce);
    }

    // Check if this Spotify account is already connected to a different user
    const existingLink = await prisma.connectedApp.findUnique({
      where: { provider_providerId: { provider: 'spotify', providerId: profile.id } },
      select: { userId: true },
    });
    if (existingLink && existingLink.userId !== userId) {
      return settingsRedirect(res, { app_error: 'already_linked_other' }, electronNonce);
    }

    // Encrypt tokens before storage — tokens NEVER stored in plaintext
    const encryptedAccessToken = encryptSecret(tokenData.access_token);
    const encryptedRefreshToken = encryptSecret(tokenData.refresh_token);
    const tokenExpiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;

    // Truncate all untrusted external data before storage
    const safeProviderId = profile.id.slice(0, 128);
    const safeDisplayName = (profile.display_name || '').slice(0, 128) || null;
    const safeAvatarUrl = (profile.images?.[0]?.url || '').slice(0, 2048) || null;
    const safeScopes = (tokenData.scope || '').slice(0, 1024) || null;

    // Upsert: handles both first connect and re-connect
    await prisma.connectedApp.upsert({
      where: { userId_provider: { userId, provider: 'spotify' } },
      create: {
        userId,
        provider: 'spotify',
        providerId: safeProviderId,
        displayName: safeDisplayName,
        avatarUrl: safeAvatarUrl,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt,
        scopes: safeScopes,
      },
      update: {
        providerId: safeProviderId,
        displayName: safeDisplayName,
        avatarUrl: safeAvatarUrl,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt,
        scopes: safeScopes,
      },
    });

    settingsRedirect(res, { app_linked: 'spotify' }, electronNonce);
  } catch (err) {
    log.error({ err }, 'Spotify connect callback error');
    settingsRedirect(res, { app_error: 'connect_failed' }, electronNonce);
  }
}));

// GET /accounts

router.get('/accounts', authenticateToken, appListLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const apps = await prisma.connectedApp.findMany({
    where: { userId: req.userId },
    select: {
      id: true,
      provider: true,
      displayName: true,
      avatarUrl: true,
      scopes: true,
      createdAt: true,
    },
    take: 20,
  });

  res.json(apps);
}));

// DELETE /accounts/:accountId

router.delete('/accounts/:accountId', validateUuidParams('accountId'), authenticateToken, sensitiveActionLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const accountId = req.params.accountId as string;
  const app = await prisma.connectedApp.findFirst({
    where: { id: accountId, userId: req.userId },
    select: { id: true, provider: true },
  });
  if (!app) return res.status(404).json({ error: 'Connected app not found' });

  await prisma.connectedApp.delete({ where: { id: accountId } });

  // Clean up any active Spotify activity for this user
  if (app.provider === 'spotify') {
    await prisma.userActivity.deleteMany({
      where: { userId: req.userId, type: 'spotify' },
    }).catch(() => {}); // fire-and-forget cleanup
    await prisma.userSecondaryActivity.deleteMany({
      where: { userId: req.userId, type: 'spotify' },
    }).catch(() => {});
  }

  // Clean up GameAccount entries for this provider
  if (app.provider === 'riot') {
    await prisma.gameAccount.deleteMany({ where: { userId: req.userId, provider: 'riot' } });
  } else if (app.provider === 'epic') {
    await prisma.gameAccount.deleteMany({ where: { userId: req.userId, provider: 'epic' } });
  }

  // Clean up activity data for streaming/content providers
  if (['twitch', 'youtube'].includes(app.provider)) {
    await prisma.userActivity.deleteMany({
      where: { userId: req.userId, type: `${app.provider}_live` },
    }).catch(() => {});
    await prisma.userSecondaryActivity.deleteMany({
      where: { userId: req.userId, type: `${app.provider}_live` },
    }).catch(() => {});
    await closeActivityHistory(req.userId).catch(() => {});
  }

  // Emit to all user's sockets for cross-tab sync
  const io = req.app.get('io') as SocketIOServer | undefined;
  if (io) {
    io.to(`user:${req.userId}`).emit('connected-app-removed', { id: accountId, provider: app.provider });
  }

  res.json({ ok: true });
}));

// POST /accounts/:accountId/refresh-profile — manually trigger profile data refresh

const profileRefreshLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:profile-refresh:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many refresh requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

router.post('/accounts/:accountId/refresh-profile', validateUuidParams('accountId'), authenticateToken, profileRefreshLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const app = await prisma.connectedApp.findFirst({
    where: { id: req.params.accountId as string, userId: req.userId },
    select: {
      id: true,
      provider: true,
      profileFetchedAt: true,
      user: { select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true } },
    },
  });

  if (!app) return res.status(404).json({ error: 'Connected app not found' });

  // Only allow refresh for platforms that have profile data
  if (!['twitch', 'youtube', 'github', 'reddit'].includes(app.provider)) {
    return res.status(400).json({ error: 'This app does not support profile refresh' });
  }

  // Check cooldown based on plan
  if (app.profileFetchedAt) {
    const plan = getEffectivePlan(app.user);
    const cooldownHours = plan === 'pro' ? 1 : plan === 'essential' ? 3 : 24;
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    const elapsed = Date.now() - app.profileFetchedAt.getTime();

    if (elapsed < cooldownMs) {
      const nextAvailable = new Date(app.profileFetchedAt.getTime() + cooldownMs);
      return res.status(429).json({
        error: 'Manual refresh on cooldown',
        nextRefreshAt: nextAvailable.toISOString(),
        cooldownHours,
      });
    }
  }

  const success = await refreshConnectedAppProfile(app.id);

  // Return updated profile data
  const updated = await prisma.connectedApp.findUnique({
    where: { id: app.id },
    select: { profileData: true, profileFetchedAt: true, nextProfileRefreshAt: true },
  });

  res.json({
    success,
    profileData: updated?.profileData ?? null,
    profileFetchedAt: updated?.profileFetchedAt?.toISOString() ?? null,
    nextProfileRefreshAt: updated?.nextProfileRefreshAt?.toISOString() ?? null,
  });
}));

// RIOT GAMES RSO OAuth

router.post('/riot/connect-token', authenticateToken, appInitLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  const connectToken = jwt.sign({ userId: req.userId, purpose: 'riot-connect' }, JWT_SECRET, { expiresIn: '5m' });
  res.json({ connectToken });
}));

router.get('/riot/connect', appInitLimiter, asyncHandler(async (req: Request, res: Response) => {
  const electronConnectNonce = getElectronConnectNonce(req);
  if (!RIOT_CLIENT_ID) return settingsRedirect(res, { app_error: 'not_configured', provider: 'riot' }, electronConnectNonce);

  const connectToken = req.query.connect_token as string | undefined;
  if (!connectToken) return res.redirect(`${FRONTEND_URL}/settings?app_error=invalid_connect_token`);

  let userId: string;
  try {
    const decoded = jwt.verify(connectToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
    if (decoded.purpose !== 'riot-connect') throw new Error('Invalid token purpose');
    userId = decoded.userId;
  } catch {
    return res.redirect(`${FRONTEND_URL}/settings?app_error=invalid_connect_token`);
  }

  const userToken = jwt.sign({ userId, purpose: 'riot-connect' }, JWT_SECRET, { expiresIn: '5m' });
  res.cookie(APP_USER_COOKIE, userToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: COOKIE_SAMESITE,
    maxAge: APP_STATE_MAX_AGE_MS,
    path: COOKIE_PATH,
  });

  const state = generateAppState(res);

  // Electron system-browser flow: embed nonce in state
  const electronNonce = req.query.nonce as string | undefined;
  const platform = req.query.platform as string | undefined;
  let finalState = state;
  if (platform === 'electron' && electronNonce) {
    const stored = await storeElectronAppNonce(electronNonce, 'riot');
    if (!stored) return res.status(503).json({ error: 'Electron SSO requires Redis' });
    finalState = state + ':electron:' + electronNonce;
  }

  const params = new URLSearchParams({
    client_id: RIOT_CLIENT_ID,
    redirect_uri: RIOT_REDIRECT_URI,
    response_type: 'code',
    scope: RIOT_SCOPES,
    state: finalState,
  });
  res.redirect(`https://auth.riotgames.com/authorize?${params}`);
}));

router.get('/riot/callback', appCallbackLimiter, asyncHandler(async (req: Request, res: Response) => {
  const clearCookies = () => { res.clearCookie(APP_USER_COOKIE, { path: COOKIE_PATH }); };

  // Hoisted for catch-block access — see spotify/callback for rationale.
  const rawState = req.query.state as string | undefined;
  const { baseState, electronNonce } = parseElectronState(rawState);

  try {

    if (!validateAppState(req, res, baseState)) { clearCookies(); return settingsRedirect(res, { app_error: 'invalid_state' }, electronNonce); }

    if (electronNonce) {
      const nonceData = await consumeElectronAppNonce(electronNonce);
      if (!nonceData) {
        clearCookies();
        return settingsRedirect(res, { app_error: 'invalid_state' }, null);
      }
    }

    const userCookie = req.cookies?.[APP_USER_COOKIE] as string | undefined;
    clearCookies();
    if (!userCookie) return settingsRedirect(res, { app_error: 'missing_session' }, electronNonce);

    let userId: string;
    try {
      const decoded = jwt.verify(userCookie, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
      if (decoded.purpose !== 'riot-connect') throw new Error('Invalid token purpose');
      userId = decoded.userId;
    } catch { return settingsRedirect(res, { app_error: 'invalid_session' }, electronNonce); }

    if (req.query.error) return settingsRedirect(res, { app_error: 'riot_denied' }, electronNonce);

    const code = req.query.code as string;
    if (!code) return settingsRedirect(res, { app_error: 'missing_code' }, electronNonce);

    // Exchange code for tokens
    const basicAuth = Buffer.from(`${RIOT_CLIENT_ID}:${RIOT_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://auth.riotgames.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basicAuth}` },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: RIOT_REDIRECT_URI }),
      signal: AbortSignal.timeout(10000),
      redirect: 'manual',
    });

    if (!tokenRes.ok) {
      log.error({ status: tokenRes.status }, 'Riot token exchange failed');
      return settingsRedirect(res, { app_error: 'riot_token_failed' }, electronNonce);
    }

    const tokenData = await tokenRes.json() as {
      access_token: string; refresh_token?: string; expires_in: number;
      token_type: string; scope: string; id_token?: string;
    };

    // Get account info (PUUID, gameName, tagLine)
    const accountRes = await fetch('https://americas.api.riotgames.com/riot/account/v1/accounts/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });

    if (!accountRes.ok) {
      log.error({ status: accountRes.status }, 'Riot account fetch failed');
      return settingsRedirect(res, { app_error: 'riot_account_failed' }, electronNonce);
    }

    const accountData = await accountRes.json() as { puuid: string; gameName: string; tagLine: string };

    // Truncate untrusted external data
    const safePuuid = accountData.puuid.slice(0, 128);
    const safeDisplayName = `${(accountData.gameName || '').slice(0, 64)}#${(accountData.tagLine || '').slice(0, 16)}`;

    // Check if this Riot account is already linked to a different user
    const existingLink = await prisma.connectedApp.findUnique({
      where: { provider_providerId: { provider: 'riot', providerId: safePuuid } },
      select: { userId: true },
    });
    if (existingLink && existingLink.userId !== userId) {
      return settingsRedirect(res, { app_error: 'already_linked_other' }, electronNonce);
    }

    // Upsert ConnectedApp
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
    const safeScopes = (tokenData.scope || RIOT_SCOPES).slice(0, 1024);
    await prisma.connectedApp.upsert({
      where: { userId_provider: { userId, provider: 'riot' } },
      create: {
        userId,
        provider: 'riot',
        providerId: safePuuid,
        displayName: safeDisplayName,
        accessToken: encryptSecret(tokenData.access_token),
        refreshToken: encryptSecret(tokenData.refresh_token || ''),
        tokenExpiresAt: expiresAt,
        scopes: safeScopes,
      },
      update: {
        providerId: safePuuid,
        displayName: safeDisplayName,
        accessToken: encryptSecret(tokenData.access_token),
        refreshToken: encryptSecret(tokenData.refresh_token || ''),
        tokenExpiresAt: expiresAt,
        scopes: safeScopes,
      },
    });

    // Auto-create GameAccount entries for Riot games (valorant, lol, tft)
    const riotGames = ['valorant', 'lol', 'tft'] as const;
    for (const game of riotGames) {
      await prisma.gameAccount.upsert({
        where: { userId_game: { userId, game } },
        create: {
          userId,
          game,
          provider: 'riot',
          platformId: safePuuid,
          displayName: safeDisplayName,
          verified: true,
        },
        update: {
          platformId: safePuuid,
          displayName: safeDisplayName,
          verified: true,
        },
      });
      // Ensure stats cache exists
      const ga = await prisma.gameAccount.findUnique({ where: { userId_game: { userId, game } }, select: { id: true, statsCache: { select: { id: true } } } });
      if (ga && !ga.statsCache) {
        await prisma.gameStatsCache.create({ data: { gameAccountId: ga.id } });
      }
    }

    log.info({ userId, puuid: safePuuid, displayName: safeDisplayName }, 'Riot account connected');
    return settingsRedirect(res, { app_connected: 'riot' }, electronNonce);
  } catch (err) {
    log.error({ err }, 'Riot callback error');
    return settingsRedirect(res, { app_error: 'riot_callback_failed' }, electronNonce);
  }
}));

// EPIC GAMES OAuth

router.post('/epic/connect-token', authenticateToken, appInitLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  const connectToken = jwt.sign({ userId: req.userId, purpose: 'epic-connect' }, JWT_SECRET, { expiresIn: '5m' });
  res.json({ connectToken });
}));

router.get('/epic/connect', appInitLimiter, asyncHandler(async (req: Request, res: Response) => {
  const electronConnectNonce = getElectronConnectNonce(req);
  if (!EPIC_CLIENT_ID) return settingsRedirect(res, { app_error: 'not_configured', provider: 'epic' }, electronConnectNonce);

  const connectToken = req.query.connect_token as string | undefined;
  if (!connectToken) return res.redirect(`${FRONTEND_URL}/settings?app_error=invalid_connect_token`);

  let userId: string;
  try {
    const decoded = jwt.verify(connectToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
    if (decoded.purpose !== 'epic-connect') throw new Error('Invalid token purpose');
    userId = decoded.userId;
  } catch {
    return res.redirect(`${FRONTEND_URL}/settings?app_error=invalid_connect_token`);
  }

  const userToken = jwt.sign({ userId, purpose: 'epic-connect' }, JWT_SECRET, { expiresIn: '5m' });
  res.cookie(APP_USER_COOKIE, userToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: COOKIE_SAMESITE,
    maxAge: APP_STATE_MAX_AGE_MS,
    path: COOKIE_PATH,
  });

  const state = generateAppState(res);

  // Electron system-browser flow: embed nonce in state
  const electronNonce = req.query.nonce as string | undefined;
  const platform = req.query.platform as string | undefined;
  let finalState = state;
  if (platform === 'electron' && electronNonce) {
    const stored = await storeElectronAppNonce(electronNonce, 'epic');
    if (!stored) return res.status(503).json({ error: 'Electron SSO requires Redis' });
    finalState = state + ':electron:' + electronNonce;
  }

  const params = new URLSearchParams({
    client_id: EPIC_CLIENT_ID,
    redirect_uri: EPIC_REDIRECT_URI,
    response_type: 'code',
    scope: EPIC_SCOPES,
    state: finalState,
  });
  res.redirect(`https://www.epicgames.com/id/authorize?${params}`);
}));

router.get('/epic/callback', appCallbackLimiter, asyncHandler(async (req: Request, res: Response) => {
  const clearCookies = () => { res.clearCookie(APP_USER_COOKIE, { path: COOKIE_PATH }); };

  // Hoisted for catch-block access — see spotify/callback for rationale.
  const rawState = req.query.state as string | undefined;
  const { baseState, electronNonce } = parseElectronState(rawState);

  try {
    if (!validateAppState(req, res, baseState)) { clearCookies(); return settingsRedirect(res, { app_error: 'invalid_state' }, electronNonce); }

    if (electronNonce) {
      const nonceData = await consumeElectronAppNonce(electronNonce);
      if (!nonceData) {
        clearCookies();
        return settingsRedirect(res, { app_error: 'invalid_state' }, null);
      }
    }

    const userCookie = req.cookies?.[APP_USER_COOKIE] as string | undefined;
    clearCookies();
    if (!userCookie) return settingsRedirect(res, { app_error: 'missing_session' }, electronNonce);

    let userId: string;
    try {
      const decoded = jwt.verify(userCookie, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
      if (decoded.purpose !== 'epic-connect') throw new Error('Invalid token purpose');
      userId = decoded.userId;
    } catch { return settingsRedirect(res, { app_error: 'invalid_session' }, electronNonce); }

    if (req.query.error) return settingsRedirect(res, { app_error: 'epic_denied' }, electronNonce);

    const code = req.query.code as string;
    if (!code) return settingsRedirect(res, { app_error: 'missing_code' }, electronNonce);

    // Exchange code for tokens
    const basicAuth = Buffer.from(`${EPIC_CLIENT_ID}:${EPIC_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://api.epicgames.dev/epic/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basicAuth}` },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: EPIC_REDIRECT_URI, scope: EPIC_SCOPES }),
      signal: AbortSignal.timeout(10000),
      redirect: 'manual',
    });

    if (!tokenRes.ok) {
      log.error({ status: tokenRes.status }, 'Epic token exchange failed');
      return settingsRedirect(res, { app_error: 'epic_token_failed' }, electronNonce);
    }

    const tokenData = await tokenRes.json() as {
      access_token: string; refresh_token?: string; expires_in: number;
      token_type: string; scope?: string; account_id?: string;
      displayName?: string;
    };

    // Epic token response includes account_id and displayName
    let epicAccountId = (tokenData.account_id || '').slice(0, 128);
    let epicDisplayName = (tokenData.displayName || '').slice(0, 128);

    if (!epicAccountId) {
      // Fallback: fetch account info from userinfo endpoint
      const infoRes = await fetch('https://api.epicgames.dev/epic/oauth/v2/userInfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      });
      if (infoRes.ok) {
        const info = await infoRes.json() as { sub?: string; preferred_username?: string };
        epicAccountId = (info.sub || '').slice(0, 128);
        epicDisplayName = epicDisplayName || (info.preferred_username || '').slice(0, 128);
      }
    }

    if (!epicAccountId) {
      log.error('Epic account ID not found in token or userinfo response');
      return settingsRedirect(res, { app_error: 'epic_account_failed' }, electronNonce);
    }

    // Check if this Epic account is already linked to a different user
    const existingLink = await prisma.connectedApp.findUnique({
      where: { provider_providerId: { provider: 'epic', providerId: epicAccountId } },
      select: { userId: true },
    });
    if (existingLink && existingLink.userId !== userId) {
      return settingsRedirect(res, { app_error: 'already_linked_other' }, electronNonce);
    }

    // Upsert ConnectedApp
    const expiresAt = new Date(Date.now() + (tokenData.expires_in || 7200) * 1000);
    const safeScopes = (tokenData.scope || EPIC_SCOPES).slice(0, 1024);
    await prisma.connectedApp.upsert({
      where: { userId_provider: { userId, provider: 'epic' } },
      create: {
        userId,
        provider: 'epic',
        providerId: epicAccountId,
        displayName: epicDisplayName || null,
        accessToken: encryptSecret(tokenData.access_token),
        refreshToken: encryptSecret(tokenData.refresh_token || ''),
        tokenExpiresAt: expiresAt,
        scopes: safeScopes,
      },
      update: {
        providerId: epicAccountId,
        displayName: epicDisplayName || null,
        accessToken: encryptSecret(tokenData.access_token),
        refreshToken: encryptSecret(tokenData.refresh_token || ''),
        tokenExpiresAt: expiresAt,
        scopes: safeScopes,
      },
    });

    // Auto-create GameAccount for Fortnite
    await prisma.gameAccount.upsert({
      where: { userId_game: { userId, game: 'fortnite' } },
      create: {
        userId,
        game: 'fortnite',
        provider: 'epic',
        platformId: epicAccountId,
        displayName: epicDisplayName || null,
        verified: true,
      },
      update: {
        platformId: epicAccountId,
        displayName: epicDisplayName || null,
        verified: true,
      },
    });
    // Ensure stats cache exists
    const fga = await prisma.gameAccount.findUnique({ where: { userId_game: { userId, game: 'fortnite' } }, select: { id: true, statsCache: { select: { id: true } } } });
    if (fga && !fga.statsCache) {
      await prisma.gameStatsCache.create({ data: { gameAccountId: fga.id } });
    }

    log.info({ userId, epicAccountId, epicDisplayName }, 'Epic account connected');
    return settingsRedirect(res, { app_connected: 'epic' }, electronNonce);
  } catch (err) {
    log.error({ err }, 'Epic callback error');
    return settingsRedirect(res, { app_error: 'epic_callback_failed' }, electronNonce);
  }
}));

// STEAM Game Linking (from existing SsoAccount)

router.post('/steam/link-games', authenticateToken, appInitLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  // Find Steam SSO account
  const steamSso = await prisma.ssoAccount.findFirst({
    where: { userId: req.userId, provider: 'steam' },
    select: { providerId: true, displayName: true },
  });

  if (!steamSso) return res.status(404).json({ error: 'No Steam account linked. Connect Steam via SSO first.' });

  // Auto-create GameAccount entries for Steam games (cs2, dota2)
  const steamGames = ['cs2', 'dota2'] as const;
  const created: string[] = [];

  // Batch lookup: single query instead of per-game findUnique
  const existingAccounts = await prisma.gameAccount.findMany({
    where: { userId: req.userId, game: { in: [...steamGames] } },
    take: steamGames.length,
  });
  const existingByGame = new Map(existingAccounts.map(a => [a.game, a]));

  for (const game of steamGames) {
    const existing = existingByGame.get(game);
    if (!existing) {
      const ga = await prisma.gameAccount.create({
        data: {
          userId: req.userId,
          game,
          provider: 'steam',
          platformId: steamSso.providerId,
          displayName: steamSso.displayName || null,
          verified: true, // SSO-linked = verified
        },
      });
      await prisma.gameStatsCache.create({ data: { gameAccountId: ga.id } });
      // Trigger initial stats fetch (fire-and-forget)
      refreshGameAccountStats(ga.id).catch(err => {
        log.warn({ err, game, gameAccountId: ga.id }, 'steam link initial fetch failed');
      });
      created.push(game);
    } else if (!existing.verified) {
      // Update to verified if SSO was connected after initial username link
      await prisma.gameAccount.update({ where: { id: existing.id }, data: { platformId: steamSso.providerId, displayName: steamSso.displayName || existing.displayName, verified: true } });
    }
  }

  log.info({ userId: req.userId, steamId: steamSso.providerId, created }, 'Steam game accounts linked');
  res.json({ success: true, games: steamGames, created });
}));

// TWITCH OAuth

router.post('/twitch/connect-token', authenticateToken, appInitLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  const connectToken = jwt.sign({ userId: req.userId, purpose: 'twitch-connect' }, JWT_SECRET, { expiresIn: '5m' });
  res.json({ connectToken });
}));

router.get('/twitch/connect', appInitLimiter, asyncHandler(async (req: Request, res: Response) => {
  const electronConnectNonce = getElectronConnectNonce(req);
  if (!TWITCH_CLIENT_ID) return settingsRedirect(res, { app_error: 'not_configured', provider: 'twitch' }, electronConnectNonce);

  const connectToken = req.query.connect_token as string | undefined;
  if (!connectToken) return res.redirect(`${FRONTEND_URL}/settings?app_error=invalid_connect_token`);

  let userId: string;
  try {
    const decoded = jwt.verify(connectToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
    if (decoded.purpose !== 'twitch-connect') throw new Error('Invalid token purpose');
    userId = decoded.userId;
  } catch {
    return res.redirect(`${FRONTEND_URL}/settings?app_error=invalid_connect_token`);
  }

  const userToken = jwt.sign({ userId, purpose: 'twitch-connect' }, JWT_SECRET, { expiresIn: '5m' });
  res.cookie(APP_USER_COOKIE, userToken, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: COOKIE_SAMESITE, maxAge: APP_STATE_MAX_AGE_MS, path: COOKIE_PATH,
  });

  const state = generateAppState(res);

  // Electron system-browser flow: embed nonce in state
  const electronNonce = req.query.nonce as string | undefined;
  const platform = req.query.platform as string | undefined;
  let finalState = state;
  if (platform === 'electron' && electronNonce) {
    const stored = await storeElectronAppNonce(electronNonce, 'twitch');
    if (!stored) return res.status(503).json({ error: 'Electron SSO requires Redis' });
    finalState = state + ':electron:' + electronNonce;
  }

  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: TWITCH_REDIRECT_URI,
    scope: TWITCH_SCOPES,
    state: finalState,
    force_verify: 'true',
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
}));

router.get('/twitch/callback', appCallbackLimiter, asyncHandler(async (req: Request, res: Response) => {
  const clearCookies = () => { res.clearCookie(APP_USER_COOKIE, { path: COOKIE_PATH }); };

  // Hoisted for catch-block access — see spotify/callback for rationale.
  const rawState = req.query.state as string | undefined;
  const { baseState, electronNonce } = parseElectronState(rawState);

  try {
    if (!validateAppState(req, res, baseState)) { clearCookies(); return settingsRedirect(res, { app_error: 'invalid_state' }, electronNonce); }

    if (electronNonce) {
      const nonceData = await consumeElectronAppNonce(electronNonce);
      if (!nonceData) {
        clearCookies();
        return settingsRedirect(res, { app_error: 'invalid_state' }, null);
      }
    }

    const userCookie = req.cookies?.[APP_USER_COOKIE] as string | undefined;
    clearCookies();
    if (!userCookie) return settingsRedirect(res, { app_error: 'missing_session' }, electronNonce);

    let userId: string;
    try {
      const decoded = jwt.verify(userCookie, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
      if (decoded.purpose !== 'twitch-connect') throw new Error('Invalid token purpose');
      userId = decoded.userId;
    } catch { return settingsRedirect(res, { app_error: 'invalid_session' }, electronNonce); }

    if (req.query.error) return settingsRedirect(res, { app_error: 'twitch_denied' }, electronNonce);

    const code = req.query.code as string;
    if (!code) return settingsRedirect(res, { app_error: 'missing_code' }, electronNonce);

    // Exchange code for tokens
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: TWITCH_REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });

    const tokenData = (await tokenRes.json()) as {
      access_token?: string; refresh_token?: string; expires_in?: number; scope?: string[]; error?: string;
    };

    if (!tokenData.access_token || !tokenData.refresh_token) {
      log.warn({ error: tokenData.error }, 'Twitch token exchange failed');
      return settingsRedirect(res, { app_error: 'token_exchange_failed' }, electronNonce);
    }

    // Fetch Twitch user profile
    const profileRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Client-Id': TWITCH_CLIENT_ID },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });

    const profileBody = (await profileRes.json()) as { data?: Array<{ id: string; login: string; display_name: string; profile_image_url: string }> };
    const profile = profileBody.data?.[0];

    if (!profile?.id) {
      log.warn('Twitch profile fetch returned no user');
      return settingsRedirect(res, { app_error: 'profile_fetch_failed' }, electronNonce);
    }

    // Check for existing link to different user
    const existingLink = await prisma.connectedApp.findUnique({
      where: { provider_providerId: { provider: 'twitch', providerId: profile.id } },
      select: { userId: true },
    });
    if (existingLink && existingLink.userId !== userId) {
      return settingsRedirect(res, { app_error: 'already_linked_other' }, electronNonce);
    }

    const encryptedAccessToken = encryptSecret(tokenData.access_token);
    const encryptedRefreshToken = encryptSecret(tokenData.refresh_token);
    const tokenExpiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null;

    const safeProviderId = profile.id.slice(0, 128);
    const safeDisplayName = (profile.display_name || profile.login || '').slice(0, 128) || null;
    const safeAvatarUrl = (profile.profile_image_url || '').slice(0, 2048) || null;
    const safeScopes = (Array.isArray(tokenData.scope) ? tokenData.scope.join(' ') : '').slice(0, 1024) || null;

    const connectedApp = await prisma.connectedApp.upsert({
      where: { userId_provider: { userId, provider: 'twitch' } },
      create: {
        userId, provider: 'twitch', providerId: safeProviderId,
        displayName: safeDisplayName, avatarUrl: safeAvatarUrl,
        accessToken: encryptedAccessToken, refreshToken: encryptedRefreshToken,
        tokenExpiresAt, scopes: safeScopes,
      },
      update: {
        providerId: safeProviderId, displayName: safeDisplayName, avatarUrl: safeAvatarUrl,
        accessToken: encryptedAccessToken, refreshToken: encryptedRefreshToken,
        tokenExpiresAt, scopes: safeScopes,
      },
    });

    // Fire-and-forget: fetch initial profile data
    refreshConnectedAppProfile(connectedApp.id).catch(err => {
      log.warn({ err, provider: 'twitch' }, 'initial profile fetch failed');
    });

    settingsRedirect(res, { app_linked: 'twitch' }, electronNonce);
  } catch (err) {
    log.error({ err }, 'Twitch connect callback error');
    settingsRedirect(res, { app_error: 'connect_failed' }, electronNonce);
  }
}));

// YOUTUBE (GOOGLE) OAuth

router.post('/youtube/connect-token', authenticateToken, appInitLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  const connectToken = jwt.sign({ userId: req.userId, purpose: 'youtube-connect' }, JWT_SECRET, { expiresIn: '5m' });
  res.json({ connectToken });
}));

router.get('/youtube/connect', appInitLimiter, asyncHandler(async (req: Request, res: Response) => {
  const electronConnectNonce = getElectronConnectNonce(req);
  if (!YOUTUBE_CLIENT_ID) return settingsRedirect(res, { app_error: 'not_configured', provider: 'youtube' }, electronConnectNonce);

  const connectToken = req.query.connect_token as string | undefined;
  if (!connectToken) return res.redirect(`${FRONTEND_URL}/settings?app_error=invalid_connect_token`);

  let userId: string;
  try {
    const decoded = jwt.verify(connectToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
    if (decoded.purpose !== 'youtube-connect') throw new Error('Invalid token purpose');
    userId = decoded.userId;
  } catch {
    return res.redirect(`${FRONTEND_URL}/settings?app_error=invalid_connect_token`);
  }

  const userToken = jwt.sign({ userId, purpose: 'youtube-connect' }, JWT_SECRET, { expiresIn: '5m' });
  res.cookie(APP_USER_COOKIE, userToken, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: COOKIE_SAMESITE, maxAge: APP_STATE_MAX_AGE_MS, path: COOKIE_PATH,
  });

  const state = generateAppState(res);

  // Electron system-browser flow: embed nonce in state
  const electronNonce = req.query.nonce as string | undefined;
  const platform = req.query.platform as string | undefined;
  let finalState = state;
  if (platform === 'electron' && electronNonce) {
    const stored = await storeElectronAppNonce(electronNonce, 'youtube');
    if (!stored) return res.status(503).json({ error: 'Electron SSO requires Redis' });
    finalState = state + ':electron:' + electronNonce;
  }

  const params = new URLSearchParams({
    client_id: YOUTUBE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: YOUTUBE_REDIRECT_URI,
    scope: YOUTUBE_SCOPES,
    state: finalState,
    access_type: 'offline',
    prompt: 'consent',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}));

router.get('/youtube/callback', appCallbackLimiter, asyncHandler(async (req: Request, res: Response) => {
  const clearCookies = () => { res.clearCookie(APP_USER_COOKIE, { path: COOKIE_PATH }); };

  // Hoisted for catch-block access — see spotify/callback for rationale.
  const rawState = req.query.state as string | undefined;
  const { baseState, electronNonce } = parseElectronState(rawState);

  try {

    if (!validateAppState(req, res, baseState)) { clearCookies(); return settingsRedirect(res, { app_error: 'invalid_state' }, electronNonce); }

    if (electronNonce) {
      const nonceData = await consumeElectronAppNonce(electronNonce);
      if (!nonceData) {
        clearCookies();
        return settingsRedirect(res, { app_error: 'invalid_state' }, null);
      }
    }

    const userCookie = req.cookies?.[APP_USER_COOKIE] as string | undefined;
    clearCookies();
    if (!userCookie) return settingsRedirect(res, { app_error: 'missing_session' }, electronNonce);

    let userId: string;
    try {
      const decoded = jwt.verify(userCookie, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
      if (decoded.purpose !== 'youtube-connect') throw new Error('Invalid token purpose');
      userId = decoded.userId;
    } catch { return settingsRedirect(res, { app_error: 'invalid_session' }, electronNonce); }

    if (req.query.error) return settingsRedirect(res, { app_error: 'youtube_denied' }, electronNonce);

    const code = req.query.code as string;
    if (!code) return settingsRedirect(res, { app_error: 'missing_code' }, electronNonce);

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: YOUTUBE_CLIENT_ID,
        client_secret: YOUTUBE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: YOUTUBE_REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });

    const tokenData = (await tokenRes.json()) as {
      access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string;
    };

    if (!tokenData.access_token || !tokenData.refresh_token) {
      log.warn({ error: tokenData.error }, 'YouTube token exchange failed');
      return settingsRedirect(res, { app_error: 'token_exchange_failed' }, electronNonce);
    }

    // Fetch YouTube channel profile
    const profileRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });

    const profileBody = (await profileRes.json()) as {
      items?: Array<{ id: string; snippet: { title: string; thumbnails: { default: { url: string } } }; statistics: { subscriberCount?: string } }>;
    };
    const channel = profileBody.items?.[0];

    if (!channel?.id) {
      log.warn('YouTube channel fetch returned no channel');
      return settingsRedirect(res, { app_error: 'profile_fetch_failed' }, electronNonce);
    }

    // Check for existing link to different user
    const existingLink = await prisma.connectedApp.findUnique({
      where: { provider_providerId: { provider: 'youtube', providerId: channel.id } },
      select: { userId: true },
    });
    if (existingLink && existingLink.userId !== userId) {
      return settingsRedirect(res, { app_error: 'already_linked_other' }, electronNonce);
    }

    const encryptedAccessToken = encryptSecret(tokenData.access_token);
    const encryptedRefreshToken = encryptSecret(tokenData.refresh_token);
    const tokenExpiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null;

    const safeProviderId = channel.id.slice(0, 128);
    const safeDisplayName = (channel.snippet?.title || '').slice(0, 128) || null;
    const safeAvatarUrl = (channel.snippet?.thumbnails?.default?.url || '').slice(0, 2048) || null;
    const safeScopes = (tokenData.scope || '').slice(0, 1024) || null;

    const connectedApp = await prisma.connectedApp.upsert({
      where: { userId_provider: { userId, provider: 'youtube' } },
      create: {
        userId, provider: 'youtube', providerId: safeProviderId,
        displayName: safeDisplayName, avatarUrl: safeAvatarUrl,
        accessToken: encryptedAccessToken, refreshToken: encryptedRefreshToken,
        tokenExpiresAt, scopes: safeScopes,
      },
      update: {
        providerId: safeProviderId, displayName: safeDisplayName, avatarUrl: safeAvatarUrl,
        accessToken: encryptedAccessToken, refreshToken: encryptedRefreshToken,
        tokenExpiresAt, scopes: safeScopes,
      },
    });

    // Fire-and-forget: fetch initial profile data
    refreshConnectedAppProfile(connectedApp.id).catch(err => {
      log.warn({ err, provider: 'youtube' }, 'initial profile fetch failed');
    });

    settingsRedirect(res, { app_linked: 'youtube' }, electronNonce);
  } catch (err) {
    log.error({ err }, 'YouTube connect callback error');
    settingsRedirect(res, { app_error: 'connect_failed' }, electronNonce);
  }
}));

// GITHUB OAuth

router.post('/github/connect-token', authenticateToken, appInitLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  const connectToken = jwt.sign({ userId: req.userId, purpose: 'github-connect' }, JWT_SECRET, { expiresIn: '5m' });
  res.json({ connectToken });
}));

router.get('/github/connect', appInitLimiter, asyncHandler(async (req: Request, res: Response) => {
  const electronConnectNonce = getElectronConnectNonce(req);
  if (!GITHUB_CLIENT_ID) return settingsRedirect(res, { app_error: 'not_configured', provider: 'github' }, electronConnectNonce);

  const connectToken = req.query.connect_token as string | undefined;
  if (!connectToken) return res.redirect(`${FRONTEND_URL}/settings?app_error=invalid_connect_token`);

  let userId: string;
  try {
    const decoded = jwt.verify(connectToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
    if (decoded.purpose !== 'github-connect') throw new Error('Invalid token purpose');
    userId = decoded.userId;
  } catch {
    return res.redirect(`${FRONTEND_URL}/settings?app_error=invalid_connect_token`);
  }

  const userToken = jwt.sign({ userId, purpose: 'github-connect' }, JWT_SECRET, { expiresIn: '5m' });
  res.cookie(APP_USER_COOKIE, userToken, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: COOKIE_SAMESITE, maxAge: APP_STATE_MAX_AGE_MS, path: COOKIE_PATH,
  });

  const state = generateAppState(res);

  // Electron system-browser flow: embed nonce in state
  const electronNonce = req.query.nonce as string | undefined;
  const platform = req.query.platform as string | undefined;
  let finalState = state;
  if (platform === 'electron' && electronNonce) {
    const stored = await storeElectronAppNonce(electronNonce, 'github');
    if (!stored) return res.status(503).json({ error: 'Electron SSO requires Redis' });
    finalState = state + ':electron:' + electronNonce;
  }

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_REDIRECT_URI,
    scope: GITHUB_SCOPES,
    state: finalState,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
}));

router.get('/github/callback', appCallbackLimiter, asyncHandler(async (req: Request, res: Response) => {
  const clearCookies = () => { res.clearCookie(APP_USER_COOKIE, { path: COOKIE_PATH }); };

  // Hoisted for catch-block access — see spotify/callback for rationale.
  const rawState = req.query.state as string | undefined;
  const { baseState, electronNonce } = parseElectronState(rawState);

  try {
    if (!validateAppState(req, res, baseState)) { clearCookies(); return settingsRedirect(res, { app_error: 'invalid_state' }, electronNonce); }

    if (electronNonce) {
      const nonceData = await consumeElectronAppNonce(electronNonce);
      if (!nonceData) {
        clearCookies();
        return settingsRedirect(res, { app_error: 'invalid_state' }, null);
      }
    }

    const userCookie = req.cookies?.[APP_USER_COOKIE] as string | undefined;
    clearCookies();
    if (!userCookie) return settingsRedirect(res, { app_error: 'missing_session' }, electronNonce);

    let userId: string;
    try {
      const decoded = jwt.verify(userCookie, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
      if (decoded.purpose !== 'github-connect') throw new Error('Invalid token purpose');
      userId = decoded.userId;
    } catch { return settingsRedirect(res, { app_error: 'invalid_session' }, electronNonce); }

    if (req.query.error) return settingsRedirect(res, { app_error: 'github_denied' }, electronNonce);

    const code = req.query.code as string;
    if (!code) return settingsRedirect(res, { app_error: 'missing_code' }, electronNonce);

    // Exchange code for token (GitHub uses POST body, not Basic auth)
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });

    const tokenData = (await tokenRes.json()) as {
      access_token?: string; token_type?: string; scope?: string; error?: string;
    };

    if (!tokenData.access_token) {
      log.warn({ error: tokenData.error }, 'GitHub token exchange failed');
      return settingsRedirect(res, { app_error: 'token_exchange_failed' }, electronNonce);
    }

    // Fetch GitHub user profile
    const profileRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Howl',
      },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });

    const profile = (await profileRes.json()) as {
      id?: number; login?: string; name?: string; avatar_url?: string;
    };

    if (!profile?.id) {
      log.warn('GitHub profile fetch returned no user');
      return settingsRedirect(res, { app_error: 'profile_fetch_failed' }, electronNonce);
    }

    // Check for existing link to different user
    const githubId = String(profile.id);
    const existingLink = await prisma.connectedApp.findUnique({
      where: { provider_providerId: { provider: 'github', providerId: githubId } },
      select: { userId: true },
    });
    if (existingLink && existingLink.userId !== userId) {
      return settingsRedirect(res, { app_error: 'already_linked_other' }, electronNonce);
    }

    // GitHub tokens don't expire and have no refresh token
    const encryptedAccessToken = encryptSecret(tokenData.access_token);

    const safeProviderId = githubId.slice(0, 128);
    const safeDisplayName = (profile.login || profile.name || '').slice(0, 128) || null;
    const safeAvatarUrl = (profile.avatar_url || '').slice(0, 2048) || null;
    const safeScopes = (tokenData.scope || '').slice(0, 1024) || null;

    const connectedApp = await prisma.connectedApp.upsert({
      where: { userId_provider: { userId, provider: 'github' } },
      create: {
        userId, provider: 'github', providerId: safeProviderId,
        displayName: safeDisplayName, avatarUrl: safeAvatarUrl,
        accessToken: encryptedAccessToken, refreshToken: encryptedAccessToken,
        tokenExpiresAt: null, scopes: safeScopes,
      },
      update: {
        providerId: safeProviderId, displayName: safeDisplayName, avatarUrl: safeAvatarUrl,
        accessToken: encryptedAccessToken, refreshToken: encryptedAccessToken,
        tokenExpiresAt: null, scopes: safeScopes,
      },
    });

    // Fire-and-forget: fetch initial profile data
    refreshConnectedAppProfile(connectedApp.id).catch(err => {
      log.warn({ err, provider: 'github' }, 'initial profile fetch failed');
    });

    settingsRedirect(res, { app_linked: 'github' }, electronNonce);
  } catch (err) {
    log.error({ err }, 'GitHub connect callback error');
    settingsRedirect(res, { app_error: 'connect_failed' }, electronNonce);
  }
}));

// REDDIT OAuth

router.post('/reddit/connect-token', authenticateToken, appInitLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  const connectToken = jwt.sign({ userId: req.userId, purpose: 'reddit-connect' }, JWT_SECRET, { expiresIn: '5m' });
  res.json({ connectToken });
}));

router.get('/reddit/connect', appInitLimiter, asyncHandler(async (req: Request, res: Response) => {
  const electronConnectNonce = getElectronConnectNonce(req);
  if (!REDDIT_CLIENT_ID) return settingsRedirect(res, { app_error: 'not_configured', provider: 'reddit' }, electronConnectNonce);

  const connectToken = req.query.connect_token as string | undefined;
  if (!connectToken) return res.redirect(`${FRONTEND_URL}/settings?app_error=invalid_connect_token`);

  let userId: string;
  try {
    const decoded = jwt.verify(connectToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
    if (decoded.purpose !== 'reddit-connect') throw new Error('Invalid token purpose');
    userId = decoded.userId;
  } catch {
    return res.redirect(`${FRONTEND_URL}/settings?app_error=invalid_connect_token`);
  }

  const userToken = jwt.sign({ userId, purpose: 'reddit-connect' }, JWT_SECRET, { expiresIn: '5m' });
  res.cookie(APP_USER_COOKIE, userToken, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: COOKIE_SAMESITE, maxAge: APP_STATE_MAX_AGE_MS, path: COOKIE_PATH,
  });

  const state = generateAppState(res);

  // Electron system-browser flow: embed nonce in state
  const electronNonce = req.query.nonce as string | undefined;
  const platform = req.query.platform as string | undefined;
  let finalState = state;
  if (platform === 'electron' && electronNonce) {
    const stored = await storeElectronAppNonce(electronNonce, 'reddit');
    if (!stored) return res.status(503).json({ error: 'Electron SSO requires Redis' });
    finalState = state + ':electron:' + electronNonce;
  }

  const params = new URLSearchParams({
    client_id: REDDIT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDDIT_REDIRECT_URI,
    scope: REDDIT_SCOPES,
    state: finalState,
    duration: 'permanent',
  });
  res.redirect(`https://www.reddit.com/api/v1/authorize?${params}`);
}));

router.get('/reddit/callback', appCallbackLimiter, asyncHandler(async (req: Request, res: Response) => {
  const clearCookies = () => { res.clearCookie(APP_USER_COOKIE, { path: COOKIE_PATH }); };

  // Hoisted for catch-block access — see spotify/callback for rationale.
  const rawState = req.query.state as string | undefined;
  const { baseState, electronNonce } = parseElectronState(rawState);

  try {
    if (!validateAppState(req, res, baseState)) { clearCookies(); return settingsRedirect(res, { app_error: 'invalid_state' }, electronNonce); }

    if (electronNonce) {
      const nonceData = await consumeElectronAppNonce(electronNonce);
      if (!nonceData) {
        clearCookies();
        return settingsRedirect(res, { app_error: 'invalid_state' }, null);
      }
    }

    const userCookie = req.cookies?.[APP_USER_COOKIE] as string | undefined;
    clearCookies();
    if (!userCookie) return settingsRedirect(res, { app_error: 'missing_session' }, electronNonce);

    let userId: string;
    try {
      const decoded = jwt.verify(userCookie, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
      if (decoded.purpose !== 'reddit-connect') throw new Error('Invalid token purpose');
      userId = decoded.userId;
    } catch { return settingsRedirect(res, { app_error: 'invalid_session' }, electronNonce); }

    if (req.query.error) return settingsRedirect(res, { app_error: 'reddit_denied' }, electronNonce);

    const code = req.query.code as string;
    if (!code) return settingsRedirect(res, { app_error: 'missing_code' }, electronNonce);

    // Exchange code for tokens (Reddit uses Basic auth)
    const basicAuth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
        'User-Agent': 'Howl/1.0',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDDIT_REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });

    const tokenData = (await tokenRes.json()) as {
      access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string;
    };

    if (!tokenData.access_token || !tokenData.refresh_token) {
      log.warn({ error: tokenData.error }, 'Reddit token exchange failed');
      return settingsRedirect(res, { app_error: 'token_exchange_failed' }, electronNonce);
    }

    // Fetch Reddit user profile
    const profileRes = await fetch('https://oauth.reddit.com/api/v1/me', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'User-Agent': 'Howl/1.0',
      },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });

    const profile = (await profileRes.json()) as {
      id?: string; name?: string; icon_img?: string;
    };

    if (!profile?.id) {
      log.warn('Reddit profile fetch returned no user');
      return settingsRedirect(res, { app_error: 'profile_fetch_failed' }, electronNonce);
    }

    // Check for existing link to different user
    const existingLink = await prisma.connectedApp.findUnique({
      where: { provider_providerId: { provider: 'reddit', providerId: profile.id } },
      select: { userId: true },
    });
    if (existingLink && existingLink.userId !== userId) {
      return settingsRedirect(res, { app_error: 'already_linked_other' }, electronNonce);
    }

    const encryptedAccessToken = encryptSecret(tokenData.access_token);
    const encryptedRefreshToken = encryptSecret(tokenData.refresh_token);
    const tokenExpiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null;

    const safeProviderId = profile.id.slice(0, 128);
    const safeDisplayName = (profile.name || '').slice(0, 128) || null;
    // Reddit icon_img has query params — strip them
    const rawAvatarUrl = (profile.icon_img || '').split('?')[0];
    const safeAvatarUrl = rawAvatarUrl.slice(0, 2048) || null;
    const safeScopes = (tokenData.scope || '').slice(0, 1024) || null;

    const connectedApp = await prisma.connectedApp.upsert({
      where: { userId_provider: { userId, provider: 'reddit' } },
      create: {
        userId, provider: 'reddit', providerId: safeProviderId,
        displayName: safeDisplayName, avatarUrl: safeAvatarUrl,
        accessToken: encryptedAccessToken, refreshToken: encryptedRefreshToken,
        tokenExpiresAt, scopes: safeScopes,
      },
      update: {
        providerId: safeProviderId, displayName: safeDisplayName, avatarUrl: safeAvatarUrl,
        accessToken: encryptedAccessToken, refreshToken: encryptedRefreshToken,
        tokenExpiresAt, scopes: safeScopes,
      },
    });

    // Fire-and-forget: fetch initial profile data
    refreshConnectedAppProfile(connectedApp.id).catch(err => {
      log.warn({ err, provider: 'reddit' }, 'initial profile fetch failed');
    });

    settingsRedirect(res, { app_linked: 'reddit' }, electronNonce);
  } catch (err) {
    log.error({ err }, 'Reddit connect callback error');
    settingsRedirect(res, { app_error: 'connect_failed' }, electronNonce);
  }
}));

// GET /spotify/now-playing

router.get('/spotify/now-playing', authenticateToken, spotifyReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const app = await getSpotifyApp(req.userId);
  if (!app) return res.json({ playing: false });

  const token = await getValidSpotifyToken(app);
  if (!token) return res.json({ playing: false });

  const spotifyRes = await spotifyFetch(token, 'https://api.spotify.com/v1/me/player/currently-playing');

  if (spotifyRes.status === 204 || !spotifyRes.ok) return res.json({ playing: false });

  const data = (await spotifyRes.json()) as {
    is_playing?: boolean;
    item?: {
      id: string;
      name: string;
      artists: Array<{ name: string }>;
      album: { name: string; images: Array<{ url: string }> };
      duration_ms: number;
      uri: string;
      external_urls?: { spotify?: string };
    };
    progress_ms?: number;
    currently_playing_type?: string;
  };

  if (!data.is_playing || data.currently_playing_type !== 'track' || !data.item) {
    return res.json({ playing: false });
  }

  const t = data.item;
  res.json({
    playing: true,
    track: {
      id: t.id,
      name: t.name.slice(0, 128),
      artists: (t.artists ?? []).slice(0, 5).map(a => a.name),
      album: t.album.name.slice(0, 128),
      albumArt: (t.album.images[0]?.url || '').slice(0, 2048),
      durationMs: t.duration_ms,
      progressMs: data.progress_ms ?? 0,
      uri: t.uri.slice(0, 256),
      externalUrl: (t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`).slice(0, 2048),
    },
  });
}));

// GET /spotify/top-artists

router.get('/spotify/top-artists', authenticateToken, spotifyTopLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const app = await getSpotifyApp(req.userId);
  if (!app) return res.status(404).json({ error: 'Spotify not connected' });

  const token = await getValidSpotifyToken(app);
  if (!token) return res.status(502).json({ error: 'Spotify token expired. Please reconnect.' });

  const timeRange = VALID_TIME_RANGES.includes(req.query.time_range as typeof VALID_TIME_RANGES[number])
    ? req.query.time_range as string : 'medium_term';
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 20);

  const spotifyRes = await spotifyFetch(token, `https://api.spotify.com/v1/me/top/artists?time_range=${timeRange}&limit=${limit}`);
  if (!spotifyRes.ok) return res.status(502).json({ error: 'Spotify API error' });

  const data = (await spotifyRes.json()) as {
    items?: Array<{
      id: string; name: string; genres: string[];
      images: Array<{ url: string }>; external_urls?: { spotify?: string }; popularity: number;
    }>;
  };

  res.json({
    artists: (data.items ?? []).map(a => ({
      id: a.id,
      name: a.name.slice(0, 128),
      genres: (a.genres ?? []).slice(0, 5),
      imageUrl: (a.images[0]?.url || '').slice(0, 2048) || null,
      externalUrl: (a.external_urls?.spotify || `https://open.spotify.com/artist/${a.id}`).slice(0, 2048),
      popularity: a.popularity,
    })),
  });
}));

// GET /spotify/top-tracks

router.get('/spotify/top-tracks', authenticateToken, spotifyTopLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const app = await getSpotifyApp(req.userId);
  if (!app) return res.status(404).json({ error: 'Spotify not connected' });

  const token = await getValidSpotifyToken(app);
  if (!token) return res.status(502).json({ error: 'Spotify token expired. Please reconnect.' });

  const timeRange = VALID_TIME_RANGES.includes(req.query.time_range as typeof VALID_TIME_RANGES[number])
    ? req.query.time_range as string : 'medium_term';
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 20);

  const spotifyRes = await spotifyFetch(token, `https://api.spotify.com/v1/me/top/tracks?time_range=${timeRange}&limit=${limit}`);
  if (!spotifyRes.ok) return res.status(502).json({ error: 'Spotify API error' });

  const data = (await spotifyRes.json()) as {
    items?: Array<{
      id: string; name: string; artists: Array<{ name: string }>;
      album: { name: string; images: Array<{ url: string }> };
      duration_ms: number; external_urls?: { spotify?: string }; preview_url?: string | null;
    }>;
  };

  res.json({
    tracks: (data.items ?? []).map(t => ({
      id: t.id,
      name: t.name.slice(0, 128),
      artists: (t.artists ?? []).slice(0, 5).map(a => a.name),
      album: t.album.name.slice(0, 128),
      albumArt: (t.album.images[0]?.url || '').slice(0, 2048) || null,
      durationMs: t.duration_ms,
      externalUrl: (t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`).slice(0, 2048),
      previewUrl: (t.preview_url || '').slice(0, 2048) || null,
    })),
  });
}));

// GET /spotify/recently-played

router.get('/spotify/recently-played', authenticateToken, spotifyTopLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const app = await getSpotifyApp(req.userId);
  if (!app) return res.status(404).json({ error: 'Spotify not connected' });

  const token = await getValidSpotifyToken(app);
  if (!token) return res.status(502).json({ error: 'Spotify token expired. Please reconnect.' });

  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);

  const spotifyRes = await spotifyFetch(token, `https://api.spotify.com/v1/me/player/recently-played?limit=${limit}`);
  if (!spotifyRes.ok) return res.status(502).json({ error: 'Spotify API error' });

  const data = (await spotifyRes.json()) as {
    items?: Array<{
      track: {
        id: string; name: string; artists: Array<{ name: string }>;
        album: { name: string; images: Array<{ url: string }> };
        duration_ms: number; external_urls?: { spotify?: string };
      };
      played_at: string;
    }>;
  };

  res.json({
    tracks: (data.items ?? []).map(item => ({
      id: item.track.id,
      name: item.track.name.slice(0, 128),
      artists: (item.track.artists ?? []).slice(0, 5).map(a => a.name),
      album: item.track.album.name.slice(0, 128),
      albumArt: (item.track.album.images[0]?.url || '').slice(0, 2048) || null,
      playedAt: item.played_at,
      durationMs: item.track.duration_ms,
      externalUrl: (item.track.external_urls?.spotify || `https://open.spotify.com/track/${item.track.id}`).slice(0, 2048),
    })),
  });
}));

// GET /spotify/profile/:userId

router.get('/spotify/profile/:userId', validateUuidParams('userId'), authenticateToken, spotifyReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  const targetUserId = req.params.userId as string;

  // Privacy checks (skip for own profile)
  if (targetUserId !== req.userId) {
    const [blocked, target] = await Promise.all([
      isBlocked(req.userId, targetUserId),
      prisma.user.findUnique({
        where: { id: targetUserId },
        select: { showCurrentActivity: true, shareSpotifyActivity: true, profilePrivate: true },
      }),
    ]);

    if (blocked || !target) return res.json({ connected: false });

    // Private profile + activity visibility gates (cache friendship check)
    let spotifyFriendChecked = false;
    let isSpotifyFriend = false;
    if (target.profilePrivate) {
      isSpotifyFriend = await areFriends(req.userId, targetUserId);
      spotifyFriendChecked = true;
      if (!isSpotifyFriend) return res.json({ connected: false });
    }

    if (target.showCurrentActivity === 'nobody') return res.json({ connected: false });
    if (!target.shareSpotifyActivity) return res.json({ connected: false });
    if (target.showCurrentActivity === 'friends_only') {
      if (!spotifyFriendChecked) isSpotifyFriend = await areFriends(req.userId, targetUserId);
      if (!isSpotifyFriend) return res.json({ connected: false });
    }
  }

  const app = await getSpotifyApp(targetUserId);
  if (!app) return res.json({ connected: false });

  const token = await getValidSpotifyToken(app);
  if (!token) return res.json({ connected: false });

  // Fetch top artists and top tracks in parallel
  const [artistsRes, tracksRes] = await Promise.all([
    spotifyFetch(token, 'https://api.spotify.com/v1/me/top/artists?time_range=medium_term&limit=5'),
    spotifyFetch(token, 'https://api.spotify.com/v1/me/top/tracks?time_range=medium_term&limit=5'),
  ]);

  type SpotifyArtistItem = { id: string; name: string; genres: string[]; images: Array<{ url: string }>; external_urls?: { spotify?: string }; popularity: number };
  type SpotifyTrackItem = { id: string; name: string; artists: Array<{ name: string }>; album: { name: string; images: Array<{ url: string }> }; duration_ms: number; external_urls?: { spotify?: string }; preview_url?: string | null };

  let topArtists: SpotifyArtistItem[] = [];
  let topTracks: SpotifyTrackItem[] = [];

  if (artistsRes.ok) {
    const d = (await artistsRes.json()) as { items?: SpotifyArtistItem[] };
    topArtists = d.items ?? [];
  }
  if (tracksRes.ok) {
    const d = (await tracksRes.json()) as { items?: SpotifyTrackItem[] };
    topTracks = d.items ?? [];
  }

  res.json({
    connected: true,
    displayName: app.displayName,
    topArtists: topArtists.map(a => ({
      id: a.id,
      name: a.name.slice(0, 128),
      genres: (a.genres ?? []).slice(0, 5),
      imageUrl: (a.images[0]?.url || '').slice(0, 2048) || null,
      externalUrl: (a.external_urls?.spotify || `https://open.spotify.com/artist/${a.id}`).slice(0, 2048),
      popularity: a.popularity,
    })),
    topTracks: topTracks.map(t => ({
      id: t.id,
      name: t.name.slice(0, 128),
      artists: (t.artists ?? []).slice(0, 5).map(a => a.name),
      album: t.album.name.slice(0, 128),
      albumArt: (t.album.images[0]?.url || '').slice(0, 2048) || null,
      durationMs: t.duration_ms,
      externalUrl: (t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`).slice(0, 2048),
      previewUrl: (t.preview_url || '').slice(0, 2048) || null,
    })),
  });
}));

// GET /spotify/shared-tastes/:userId

router.get('/spotify/shared-tastes/:userId', validateUuidParams('userId'), authenticateToken, spotifySharedLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  const targetUserId = req.params.userId as string;
  if (targetUserId === req.userId) return res.status(400).json({ error: 'Cannot compare with yourself' });

  // Must be friends + no blocks
  const [blocked, friends] = await Promise.all([
    isBlocked(req.userId, targetUserId),
    areFriends(req.userId, targetUserId),
  ]);
  if (blocked) return res.status(403).json({ error: 'Blocked' });
  if (!friends) return res.status(403).json({ error: 'Must be friends to compare tastes' });

  // Both users must have Spotify connected + sharing enabled
  const [selfUser, targetUser] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.userId }, select: { shareSpotifyActivity: true } }),
    prisma.user.findUnique({ where: { id: targetUserId }, select: { shareSpotifyActivity: true } }),
  ]);
  if (!selfUser?.shareSpotifyActivity || !targetUser?.shareSpotifyActivity) {
    return res.status(400).json({ error: 'Both users must have Spotify sharing enabled' });
  }

  const [selfApp, targetApp] = await Promise.all([
    getSpotifyApp(req.userId),
    getSpotifyApp(targetUserId),
  ]);
  if (!selfApp || !targetApp) return res.status(400).json({ error: 'Both users must have Spotify connected' });

  // Check Redis cache
  const sortedIds = [req.userId, targetUserId].sort().join(':');
  const cacheKey = `spotify:shared:${sortedIds}`;
  if (redis) {
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) {
      try { return res.json(JSON.parse(cached)); } catch { /* stale cache, recompute */ }
    }
  }

  // Get valid tokens
  const [selfToken, targetToken] = await Promise.all([
    getValidSpotifyToken(selfApp),
    getValidSpotifyToken(targetApp),
  ]);
  if (!selfToken || !targetToken) return res.status(502).json({ error: 'Spotify token expired. Please reconnect.' });

  // Fetch both users' top artists and top tracks in parallel
  const [selfArtistsRes, selfTracksRes, targetArtistsRes, targetTracksRes] = await Promise.all([
    spotifyFetch(selfToken, 'https://api.spotify.com/v1/me/top/artists?time_range=medium_term&limit=50'),
    spotifyFetch(selfToken, 'https://api.spotify.com/v1/me/top/tracks?time_range=medium_term&limit=50'),
    spotifyFetch(targetToken, 'https://api.spotify.com/v1/me/top/artists?time_range=medium_term&limit=50'),
    spotifyFetch(targetToken, 'https://api.spotify.com/v1/me/top/tracks?time_range=medium_term&limit=50'),
  ]);

  type ArtistItem = { id: string; name: string; images: Array<{ url: string }> };
  type TrackItem = { id: string; name: string; artists: Array<{ name: string }>; album: { images: Array<{ url: string }> } };

  const parse = async <T>(r: globalThis.Response): Promise<T[]> => {
    if (!r.ok) return [];
    const d = (await r.json()) as { items?: T[] };
    return d.items ?? [];
  };

  const [selfArtists, selfTracks, targetArtists, targetTracks] = await Promise.all([
    parse<ArtistItem>(selfArtistsRes),
    parse<TrackItem>(selfTracksRes),
    parse<ArtistItem>(targetArtistsRes),
    parse<TrackItem>(targetTracksRes),
  ]);

  // Compute shared artists (by Spotify ID)
  const targetArtistMap = new Map(targetArtists.map((a, i) => [a.id, i]));
  const sharedArtists = selfArtists
    .map((a, selfIdx) => {
      const targetIdx = targetArtistMap.get(a.id);
      if (targetIdx === undefined) return null;
      return { artist: a, avgRank: (selfIdx + targetIdx) / 2 };
    })
    .filter(Boolean)
    .sort((a, b) => a!.avgRank - b!.avgRank)
    .map(entry => ({
      id: entry!.artist.id,
      name: entry!.artist.name.slice(0, 128),
      imageUrl: (entry!.artist.images[0]?.url || '').slice(0, 2048) || null,
    }));

  // Compute shared tracks (by Spotify ID)
  const targetTrackMap = new Map(targetTracks.map((t, i) => [t.id, i]));
  const sharedTracks = selfTracks
    .map((t, selfIdx) => {
      const targetIdx = targetTrackMap.get(t.id);
      if (targetIdx === undefined) return null;
      return { track: t, avgRank: (selfIdx + targetIdx) / 2 };
    })
    .filter(Boolean)
    .sort((a, b) => a!.avgRank - b!.avgRank)
    .map(entry => ({
      id: entry!.track.id,
      name: entry!.track.name.slice(0, 128),
      artists: (entry!.track.artists ?? []).slice(0, 5).map(a => a.name),
      albumArt: (entry!.track.album.images[0]?.url || '').slice(0, 2048) || null,
    }));

  const compatibilityScore = Math.min(
    Math.round((sharedArtists.length * 2 + sharedTracks.length) / (50 * 2 + 50) * 100),
    100,
  );

  const result = { compatibilityScore, sharedArtists, sharedTracks };

  // Cache in Redis for 1 hour
  if (redis) {
    redis.set(cacheKey, JSON.stringify(result), 'EX', 3600).catch(() => {});
  }

  res.json(result);
}));

// PUT /spotify/listen-along

const listenAlongLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:spotify-listen:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many listen along requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

router.put('/spotify/listen-along', authenticateToken, listenAlongLimiter, validate(listenAlongSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { targetUserId } = req.body as { targetUserId: string };

  if (targetUserId === req.userId) return res.status(400).json({ error: 'Cannot listen along to yourself' });

  // Privacy checks
  const [blocked, friends] = await Promise.all([
    isBlocked(req.userId, targetUserId),
    areFriends(req.userId, targetUserId),
  ]);
  if (blocked) return res.status(403).json({ error: 'Cannot listen along with this user' });
  if (!friends) return res.status(403).json({ error: 'You must be friends to listen along' });

  // Target user must have Spotify connected + sharing enabled
  const [targetUser, targetApp] = await Promise.all([
    prisma.user.findUnique({ where: { id: targetUserId }, select: { shareSpotifyActivity: true } }),
    getSpotifyApp(targetUserId),
  ]);
  if (!targetApp) return res.status(404).json({ error: 'User does not have Spotify connected' });
  if (!targetUser?.shareSpotifyActivity) return res.status(403).json({ error: 'User has disabled Spotify activity sharing' });

  // Fetch what the target is currently playing
  const targetToken = await getValidSpotifyToken(targetApp);
  if (!targetToken) return res.status(502).json({ error: 'Could not access target user\'s Spotify' });

  const nowPlayingRes = await spotifyFetch(targetToken, 'https://api.spotify.com/v1/me/player/currently-playing');
  if (nowPlayingRes.status === 204) return res.status(404).json({ error: 'User is not currently playing anything' });
  if (!nowPlayingRes.ok) return res.status(502).json({ error: 'Could not fetch current playback' });

  const nowPlaying = (await nowPlayingRes.json()) as {
    is_playing?: boolean;
    item?: { id: string; name: string; uri: string; type: string; artists: Array<{ name: string }> };
    progress_ms?: number;
    currently_playing_type?: string;
  };

  if (!nowPlaying.is_playing || !nowPlaying.item) return res.status(404).json({ error: 'User is not currently playing anything' });
  if (nowPlaying.currently_playing_type !== 'track' || nowPlaying.item.type !== 'track') {
    return res.status(400).json({ error: 'Listen Along only supports tracks' });
  }

  const trackUri = nowPlaying.item.uri;
  const progressMs = nowPlaying.progress_ms ?? 0;
  const trackName = nowPlaying.item.name.slice(0, 128);
  const artistName = (nowPlaying.item.artists[0]?.name ?? 'Unknown').slice(0, 128);

  // Requesting user must have Spotify connected with playback scope
  const selfApp = await getSpotifyApp(req.userId);
  if (!selfApp) return res.status(400).json({ error: 'Connect Spotify to use Listen Along' });

  const grantedScopes = (selfApp.scopes ?? '').split(/[\s,]+/).filter(Boolean);
  if (!grantedScopes.includes('user-modify-playback-state')) {
    return res.status(403).json({ error: 'Reconnect Spotify to enable Listen Along', code: 'MISSING_SCOPE' });
  }

  const selfToken = await getValidSpotifyToken(selfApp);
  if (!selfToken) return res.status(502).json({ error: 'Could not access your Spotify' });

  // Start playback on requesting user's Spotify
  const playRes = await fetch('https://api.spotify.com/v1/me/player/play', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${selfToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uris: [trackUri], position_ms: progressMs }),
    signal: AbortSignal.timeout(5000),
    redirect: 'manual',
  });

  if (playRes.status === 204) {
    log.info({ userId: req.userId, targetUserId, track: trackName }, 'listen along started');
    return res.json({ ok: true, track: trackName, artist: artistName });
  }

  if (playRes.status === 404) {
    const body = (await playRes.json().catch(() => ({}))) as { error?: { reason?: string } };
    if (body.error?.reason === 'NO_ACTIVE_DEVICE') {
      return res.status(400).json({ error: 'Open Spotify on a device first', code: 'NO_ACTIVE_DEVICE' });
    }
  }

  if (playRes.status === 403) {
    const body = (await playRes.json().catch(() => ({}))) as { error?: { reason?: string } };
    if (body.error?.reason === 'PREMIUM_REQUIRED') {
      return res.status(403).json({ error: 'Spotify Premium is required for Listen Along', code: 'PREMIUM_REQUIRED' });
    }
  }

  log.warn({ userId: req.userId, status: playRes.status }, 'Spotify play request failed');
  return res.status(500).json({ error: 'Failed to start playback' });
}));

// GET /spotify/scope-check

router.get('/spotify/scope-check', authenticateToken, spotifyReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const app = await getSpotifyApp(req.userId);
  if (!app) return res.json({ connected: false });

  const grantedScopes = (app.scopes ?? '').split(/[\s,]+/).filter(Boolean);
  const missingScopes = REQUIRED_SCOPES.filter(s => !grantedScopes.includes(s));

  res.json({ connected: true, scopes: grantedScopes, missingScopes });
}));

// Playback control rate limiter

const spotifyPlaybackLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:spotify-playback:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many playback requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

// GET /spotify/playback-state

router.get('/spotify/playback-state', authenticateToken, spotifyPlaybackLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const app = await getSpotifyApp(req.userId);
  if (!app) return res.json({ active: false });

  const token = await getValidSpotifyToken(app);
  if (!token) return res.status(502).json({ error: 'Could not refresh Spotify token' });

  const playerRes = await spotifyFetch(token, 'https://api.spotify.com/v1/me/player');

  if (playerRes.status === 204) {
    return res.json({ active: false });
  }

  if (playerRes.status === 403) {
    const body = (await playerRes.json().catch(() => ({}))) as { error?: { reason?: string } };
    if (body.error?.reason === 'PREMIUM_REQUIRED') {
      return res.json({ active: false, isPremium: false });
    }
  }

  if (!playerRes.ok) {
    return res.status(502).json({ error: 'Could not fetch playback state' });
  }

  const data = (await playerRes.json()) as {
    is_playing?: boolean;
    item?: {
      id?: string;
      name?: string;
      uri?: string;
      external_urls?: { spotify?: string };
      duration_ms?: number;
      artists?: Array<{ name?: string }>;
      album?: { name?: string; images?: Array<{ url?: string }> };
      type?: string;
    } | null;
    progress_ms?: number;
    shuffle_state?: boolean;
    repeat_state?: string;
    device?: { name?: string; type?: string };
  };

  // item is null when playing an ad or podcast episode without full metadata
  if (!data.item || data.item.type !== 'track') {
    return res.json({
      active: true,
      playing: !!data.is_playing,
      track: null,
      shuffle: !!data.shuffle_state,
      repeat: data.repeat_state ?? 'off',
      device: data.device ? { name: (data.device.name ?? '').slice(0, 128), type: (data.device.type ?? '').slice(0, 64) } : null,
      isPremium: true,
    });
  }

  const item = data.item;
  res.json({
    active: true,
    playing: !!data.is_playing,
    track: {
      id: (item.id ?? '').slice(0, 128),
      name: (item.name ?? '').slice(0, 128),
      artists: (item.artists ?? []).slice(0, 10).map(a => (a.name ?? '').slice(0, 128)),
      album: (item.album?.name ?? '').slice(0, 128),
      albumArt: (item.album?.images?.[0]?.url ?? '').slice(0, 2048) || null,
      durationMs: item.duration_ms ?? 0,
      progressMs: data.progress_ms ?? 0,
      uri: (item.uri ?? '').slice(0, 256),
      externalUrl: (item.external_urls?.spotify ?? '').slice(0, 2048) || null,
    },
    shuffle: !!data.shuffle_state,
    repeat: data.repeat_state ?? 'off',
    device: data.device ? { name: (data.device.name ?? '').slice(0, 128), type: (data.device.type ?? '').slice(0, 64) } : null,
    isPremium: true,
  });
}));

// Playback control helpers

type PlaybackError = { error: string; status: number; code?: string };
type PlaybackSuccess = { token: string };

async function getPlaybackContext(userId: string): Promise<PlaybackError | PlaybackSuccess> {
  const app = await getSpotifyApp(userId);
  if (!app) return { error: 'Spotify not connected', status: 404 };

  const grantedScopes = (app.scopes ?? '').split(/[\s,]+/).filter(Boolean);
  if (!grantedScopes.includes('user-modify-playback-state')) {
    return { error: 'Reconnect Spotify to enable playback control', status: 403, code: 'MISSING_SCOPE' };
  }

  const token = await getValidSpotifyToken(app);
  if (!token) return { error: 'Could not refresh Spotify token', status: 502 };

  return { token };
}

function handlePlaybackResponse(playRes: globalThis.Response, res: Response, userId: string, action: string) {
  if (playRes.status === 204) {
    log.info({ userId, action }, 'playback control success');
    return res.json({ ok: true });
  }

  // Parse error body once
  const parseBody = playRes.json().catch(() => ({})) as Promise<{ error?: { reason?: string; message?: string } }>;

  return parseBody.then(body => {
    if (playRes.status === 403 && body.error?.reason === 'PREMIUM_REQUIRED') {
      return res.status(403).json({ error: 'Spotify Premium is required for playback control', code: 'PREMIUM_REQUIRED' });
    }

    if (playRes.status === 404 && body.error?.reason === 'NO_ACTIVE_DEVICE') {
      return res.status(400).json({ error: 'Open Spotify on a device first', code: 'NO_ACTIVE_DEVICE' });
    }

    log.warn({ userId, action, status: playRes.status }, 'playback control failed');
    return res.status(502).json({ error: 'Playback control failed' });
  });
}

// PUT /spotify/playback/play-pause

router.put('/spotify/playback/play-pause', authenticateToken, spotifyPlaybackLimiter, validate(spotifyPlayPauseSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const ctx = await getPlaybackContext(req.userId);
  if ('error' in ctx) return res.status(ctx.status).json({ error: ctx.error, ...('code' in ctx ? { code: ctx.code } : {}) });

  const { action } = req.body as { action: 'play' | 'pause' };
  const url = action === 'play'
    ? 'https://api.spotify.com/v1/me/player/play'
    : 'https://api.spotify.com/v1/me/player/pause';

  const playRes = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${ctx.token}` },
    signal: AbortSignal.timeout(5000),
    redirect: 'manual',
  });

  return handlePlaybackResponse(playRes, res, req.userId, action);
}));

// POST /spotify/playback/next

router.post('/spotify/playback/next', authenticateToken, spotifyPlaybackLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const ctx = await getPlaybackContext(req.userId);
  if ('error' in ctx) return res.status(ctx.status).json({ error: ctx.error, ...('code' in ctx ? { code: ctx.code } : {}) });

  const playRes = await fetch('https://api.spotify.com/v1/me/player/next', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}` },
    signal: AbortSignal.timeout(5000),
    redirect: 'manual',
  });

  return handlePlaybackResponse(playRes, res, req.userId, 'next');
}));

// POST /spotify/playback/previous

router.post('/spotify/playback/previous', authenticateToken, spotifyPlaybackLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const ctx = await getPlaybackContext(req.userId);
  if ('error' in ctx) return res.status(ctx.status).json({ error: ctx.error, ...('code' in ctx ? { code: ctx.code } : {}) });

  const playRes = await fetch('https://api.spotify.com/v1/me/player/previous', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}` },
    signal: AbortSignal.timeout(5000),
    redirect: 'manual',
  });

  return handlePlaybackResponse(playRes, res, req.userId, 'previous');
}));

// PUT /spotify/playback/shuffle

router.put('/spotify/playback/shuffle', authenticateToken, spotifyPlaybackLimiter, validate(spotifyShuffleSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const ctx = await getPlaybackContext(req.userId);
  if ('error' in ctx) return res.status(ctx.status).json({ error: ctx.error, ...('code' in ctx ? { code: ctx.code } : {}) });

  const { state } = req.body as { state: boolean };

  const playRes = await fetch(`https://api.spotify.com/v1/me/player/shuffle?state=${state}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${ctx.token}` },
    signal: AbortSignal.timeout(5000),
    redirect: 'manual',
  });

  return handlePlaybackResponse(playRes, res, req.userId, `shuffle:${state}`);
}));

// PUT /spotify/playback/repeat

router.put('/spotify/playback/repeat', authenticateToken, spotifyPlaybackLimiter, validate(spotifyRepeatSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });

  const ctx = await getPlaybackContext(req.userId);
  if ('error' in ctx) return res.status(ctx.status).json({ error: ctx.error, ...('code' in ctx ? { code: ctx.code } : {}) });

  const { state } = req.body as { state: 'off' | 'track' | 'context' };

  const playRes = await fetch(`https://api.spotify.com/v1/me/player/repeat?state=${state}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${ctx.token}` },
    signal: AbortSignal.timeout(5000),
    redirect: 'manual',
  });

  return handlePlaybackResponse(playRes, res, req.userId, `repeat:${state}`);
}));

export default router;
