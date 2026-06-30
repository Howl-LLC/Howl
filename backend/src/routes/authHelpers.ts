// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import type { AuthRequest } from '../middleware/auth.js';
import { getClientIp } from '../utils/clientIp.js';

export const sensitiveActionLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:sensitive:'),
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Too many attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const REFRESH_COOKIE_NAME = 'howl_refresh';
const DEVICE_COOKIE_NAME = 'howl_device_id';
// 90 days. Matches Discord/Slack/Linear — active users never see a login
// screen unless they explicitly sign out. Sliding refresh (setRefreshCookie
// is called on every successful refresh) keeps the cookie rolling forward,
// so only users who disappear for 90 days straight get kicked back to login.
const REFRESH_COOKIE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
// Trust cookie shares the same sliding 90-day window. Set on the first
// successful device-verification; bumped on every subsequent login from
// the same browser. Drops off if the user disappears for 90 days straight.
const DEVICE_COOKIE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const ELECTRON_ORIGIN = 'howl-app://app';

const isCrossOriginDev = !!process.env.FRONTEND_ORIGIN
  && process.env.NODE_ENV !== 'production'
  && !process.env.FRONTEND_ORIGIN.includes('localhost');
const cookieSameSite: 'strict' | 'none' = isCrossOriginDev ? 'none' : 'strict';
const cookieSecure = process.env.NODE_ENV === 'production' || isCrossOriginDev;

export function setRefreshCookie(res: Response, refreshToken: string, req?: Request) {
  // Electron custom protocol (howl-app://app) is cross-site to the API (https://api.howlpro.com).
  // SameSite=None lets the cookie travel cross-site. This is safe because:
  // - Origin header is browser-enforced and can't be spoofed cross-origin
  // - howl-app:// is a secure context (registered as privileged scheme)
  // - Web users still get SameSite=Strict (unchanged)
  const isElectronOrigin = req?.headers?.origin === ELECTRON_ORIGIN;
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: cookieSecure || isElectronOrigin,
    sameSite: isElectronOrigin ? 'none' : cookieSameSite,
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    path: '/api',
  });
}

export function clearRefreshCookie(res: Response, req?: Request) {
  const isElectronOrigin = req?.headers?.origin === ELECTRON_ORIGIN;
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: cookieSecure || isElectronOrigin,
    sameSite: isElectronOrigin ? 'none' : cookieSameSite,
    path: '/api',
  });
}

/**
 * Set the device-trust cookie (`howl_device_id`). 90-day sliding window;
 * on every successful login we re-issue the cookie so it stays rolling.
 * httpOnly so JS can't exfiltrate it via an XSS. path=/api restricts it to
 * API calls (the server is the only consumer). Electron follows the same
 * SameSite=None branch as the refresh cookie since its origin is howl-app://.
 */
export function setDeviceCookie(res: Response, rawToken: string, req?: Request) {
  const isElectronOrigin = req?.headers?.origin === ELECTRON_ORIGIN;
  res.cookie(DEVICE_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: cookieSecure || isElectronOrigin,
    sameSite: isElectronOrigin ? 'none' : cookieSameSite,
    maxAge: DEVICE_COOKIE_MAX_AGE_MS,
    path: '/api',
  });
}

export function clearDeviceCookie(res: Response, req?: Request) {
  const isElectronOrigin = req?.headers?.origin === ELECTRON_ORIGIN;
  res.clearCookie(DEVICE_COOKIE_NAME, {
    httpOnly: true,
    secure: cookieSecure || isElectronOrigin,
    sameSite: isElectronOrigin ? 'none' : cookieSameSite,
    path: '/api',
  });
}

export { REFRESH_COOKIE_NAME, DEVICE_COOKIE_NAME };
