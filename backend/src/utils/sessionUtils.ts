// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { enqueueEmail } from '../queues/producers.js';
import { decryptOrPlain } from '../services/mfaCrypto.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'sessionUtils' });

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(64).toString('base64url');
}

// Matches REFRESH_COOKIE_MAX_AGE_MS in authHelpers.ts. Sliding: every
// successful /auth/refresh call pushes both the DB row's expiresAt and the
// cookie Max-Age forward by this many days. Active web/mobile users stay
// logged in until the 365-day absolute cap in auth.ts /refresh fires;
// active Electron desktop users stay logged in indefinitely.
const REFRESH_TOKEN_EXPIRY_DAYS = 90;

function parseDevice(ua: string) {
  let deviceType = 'web';
  let os = 'Unknown';
  if (/Electron/i.test(ua)) deviceType = 'desktop';
  else if (/Mobile|Android|iPhone|iPad/i.test(ua)) deviceType = 'mobile';

  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';

  // eslint-disable-next-line security/detect-unsafe-regex -- simple alternation, no nested quantifiers
  const browserMatch = ua.match(/(Chrome|Firefox|Safari|Edge|Opera|Electron)[/\s]?(\d+)?/i);
  const deviceName = browserMatch
    ? `${browserMatch[1]} on ${os}`
    : `${deviceType === 'desktop' ? 'Desktop' : deviceType === 'mobile' ? 'Mobile' : 'Browser'} on ${os}`;

  return { deviceType, os, deviceName };
}

const MAX_SESSIONS_PER_USER = 25;

export async function createSession(
  userId: string,
  token: string,
  req: { headers: Record<string, string | string[] | undefined>; ip?: string | null },
  refreshToken?: string,
  trustedDeviceId?: string | null,
) {
  const ua = (req.headers['user-agent'] ?? 'Unknown') as string;
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip ?? null;
  const { deviceType, os, deviceName } = parseDevice(ua);

  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  // Enforce per-user session cap — evict oldest sessions if at limit
  const sessionCount = await prisma.session.count({ where: { userId } });
  if (sessionCount >= MAX_SESSIONS_PER_USER) {
    const excess = sessionCount - MAX_SESSIONS_PER_USER + 1;
    const oldest = await prisma.session.findMany({
      where: { userId },
      orderBy: { lastActiveAt: 'asc' },
      take: excess,
      select: { id: true },
    });
    if (oldest.length > 0) {
      await prisma.session.deleteMany({
        where: { id: { in: oldest.map(s => s.id) } },
      });
    }
  }

  const ipHashed = typeof ip === 'string' ? hashIp(ip) : undefined;

  // New-device alert. Runs BEFORE the session.create so we can look up prior
  // sessions without the one we're about to create. Fire-and-forget: email
  // enqueue failure must never block login.
  if (ipHashed) {
    maybeNotifyNewDevice(userId, ipHashed, deviceName, typeof ip === 'string' ? ip : null).catch((err) => {
      log.warn({ err, userId }, 'new-device notification check failed');
    });
  }

  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      refreshTokenHash: refreshToken ? hashToken(refreshToken) : undefined,
      deviceName,
      deviceType,
      os,
      // `ip` is the truncated SHA-256 used for new-device-detection lookups.
      // `rawIp` and `userAgent` are the investigation-grade values used by
      // T&S workflows and CSAM CyberTipline reports. They are purged to NULL
      // by the cleanup-lightweight worker after 90 days of session inactivity
      // so they don't accumulate as a long-term breach liability — within the
      // window they let us answer NCMEC/LE subpoenas with IP+timestamp tuples
      // that the ISP can resolve to a subscriber. CSAM-specific events
      // permanently snapshot IP+UA onto MessageReport, so retention there is
      // independent of this 90-day window.
      ip: ipHashed,
      rawIp: typeof ip === 'string' ? ip : null,
      userAgent: ua === 'Unknown' ? null : ua,
      expiresAt,
      ...(trustedDeviceId ? { trustedDeviceId } : {}),
    },
  });
}

/**
 * If this (userId, hashedIp) tuple has not been seen on any Session row in the
 * past 30 days, enqueue a new-device email. The email
 * contains a signed revoke-sessions token that the legit owner can click to
 * sign out of all devices.
 *
 * Opt-out via `User.notifyOnNewDevice = false`.
 */
async function maybeNotifyNewDevice(
  userId: string,
  hashedIp: string,
  deviceName: string,
  rawIp: string | null,
): Promise<void> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [existing, user] = await Promise.all([
    prisma.session.findFirst({
      where: { userId, ip: hashedIp, createdAt: { gte: thirtyDaysAgo } },
      select: { id: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, notifyOnNewDevice: true },
    }),
  ]);
  if (existing) return; // known IP → no notification
  if (!user || !user.notifyOnNewDevice || !user.email) return;

  let plainEmail: string;
  try { plainEmail = decryptOrPlain(user.email); } catch { plainEmail = user.email; }
  if (!plainEmail || !plainEmail.includes('@')) return;

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) return;
  const revokeToken = jwt.sign(
    { userId, purpose: 'revokeSessions', iat: Math.floor(Date.now() / 1000) },
    jwtSecret,
    { expiresIn: '24h' },
  );
  const appUrl = process.env.APP_URL || process.env.FRONTEND_URL || 'https://app.howlpro.com';
  const revokeUrl = `${appUrl.replace(/\/$/, '')}/revoke-sessions?token=${encodeURIComponent(revokeToken)}`;

  const ipMasked = maskIpForDisplay(rawIp);

  await enqueueEmail({
    type: 'newDeviceLogin',
    to: plainEmail,
    deviceName,
    ipMasked,
    loginAtIso: new Date().toISOString(),
    revokeUrl,
  });
}

/** Mask an IP for display — keep first two octets (IPv4) or /48 (IPv6). */
function maskIpForDisplay(ip: string | null): string {
  if (!ip) return '(unknown)';
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.slice(0, 3).join(':') + ':***';
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return '(unknown)';
  return `${parts[0]}.${parts[1]}.***.***`;
}
