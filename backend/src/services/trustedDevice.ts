// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Trusted-device service — used by the new-device verification feature.
 *
 * A "trusted device" is a browser/device that has cleared the email-code
 * challenge at least once. Subsequent password logins with a matching
 * `howl_device_id` cookie skip the challenge. Only relevant for users
 * without TOTP/passkey MFA — MFA users always run their existing MFA
 * challenge regardless of device trust.
 *
 * The cookie carries a random base64url token; the server only ever
 * stores the SHA-256 hash. That mirrors how refresh tokens are stored
 * on the Session table and keeps raw tokens out of any backup.
 */
import crypto from 'crypto';
import type { TrustedDevice } from '../../generated/prisma-client-v7/client.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { hashIp } from '../utils/sessionUtils.js';

const log = logger.child({ module: 'trustedDevice' });

/** 90 days of sliding trust — matches refresh-cookie lifetime in authHelpers.ts. */
export const TRUSTED_DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Length of the random cookie token (bytes before base64url encoding). */
const COOKIE_TOKEN_BYTES = 32;

function sha256(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateCookieToken(): string {
  return crypto.randomBytes(COOKIE_TOKEN_BYTES).toString('base64url');
}

function parseUserAgent(ua: string): { label: string; deviceType: string } {
  let deviceType = 'web';
  let os = 'Unknown';
  if (/Electron/i.test(ua)) deviceType = 'desktop';
  else if (/Mobile|Android|iPhone|iPad/i.test(ua)) deviceType = 'mobile';

  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';

  // eslint-disable-next-line security/detect-unsafe-regex
  const browserMatch = ua.match(/(Chrome|Firefox|Safari|Edge|Opera|Electron)[/\s]?(\d+)?/i);
  const label = browserMatch
    ? `${browserMatch[1]} on ${os}`
    : `${deviceType === 'desktop' ? 'Desktop' : deviceType === 'mobile' ? 'Mobile' : 'Browser'} on ${os}`;

  return { label, deviceType };
}

export interface IssueTrustedDeviceResult {
  device: TrustedDevice;
  /** Raw cookie token — caller sets this in the `howl_device_id` httpOnly cookie. Never log. */
  rawCookieToken: string;
}

/**
 * Create a TrustedDevice row and return the raw cookie token the caller
 * should set in the response cookie. The raw value is NEVER persisted.
 */
export async function issueTrustedDevice(
  userId: string,
  ua: string,
  rawIp: string | null,
): Promise<IssueTrustedDeviceResult> {
  const { label, deviceType } = parseUserAgent(ua || 'Unknown');
  const rawCookieToken = generateCookieToken();
  const tokenHash = sha256(rawCookieToken);
  const ipH = rawIp ? hashIp(rawIp) : null;
  const device = await prisma.trustedDevice.create({
    data: {
      userId,
      tokenHash,
      label,
      deviceType,
      ipHashFirstSeen: ipH,
      ipHashLastSeen: ipH,
      expiresAt: new Date(Date.now() + TRUSTED_DEVICE_TTL_MS),
    },
  });
  return { device, rawCookieToken };
}

export interface DeviceTrustResult {
  trusted: boolean;
  device?: TrustedDevice;
}

/**
 * Look up whether `rawCookieToken` maps to a valid, non-expired
 * TrustedDevice row for the given user. Returns `{ trusted: false }` on
 * any mismatch — never reveals whether a row exists for a different user.
 */
export async function isDeviceTrusted(
  userId: string,
  rawCookieToken: string,
): Promise<DeviceTrustResult> {
  if (!rawCookieToken) return { trusted: false };
  const tokenHash = sha256(rawCookieToken);
  const device = await prisma.trustedDevice.findUnique({ where: { tokenHash } });
  if (!device) return { trusted: false };
  if (device.userId !== userId) return { trusted: false };
  if (device.expiresAt.getTime() <= Date.now()) return { trusted: false };
  return { trusted: true, device };
}

/**
 * Slide the 90-day expiry forward on every login. Also updates
 * `ipHashLastSeen` and `lastSeenAt` so the Settings → Devices table
 * shows useful recency info.
 */
export async function bumpDeviceLastSeen(
  deviceId: string,
  rawIp: string | null,
): Promise<void> {
  const ipH = rawIp ? hashIp(rawIp) : null;
  await prisma.trustedDevice.update({
    where: { id: deviceId },
    data: {
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + TRUSTED_DEVICE_TTL_MS),
      ...(ipH ? { ipHashLastSeen: ipH } : {}),
    },
  }).catch((err) => {
    // Don't fail login if the bump fails — the next refresh/login will retry.
    log.warn({ err, deviceId }, 'bumpDeviceLastSeen failed');
  });
}

/**
 * Revoke all trusted devices for a user. Called on password
 * change/reset, email change, and the explicit "revoke all devices"
 * button in settings. Does not revoke active sessions — that is the
 * caller's responsibility (existing session-revocation code paths).
 */
export async function revokeAllForUser(userId: string): Promise<number> {
  const { count } = await prisma.trustedDevice.deleteMany({ where: { userId } });
  return count;
}

/** Revoke a single device with ownership check. Returns false if the id
 *  doesn't belong to the user (treats as not found — anti-enumeration). */
export async function revokeDevice(
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const { count } = await prisma.trustedDevice.deleteMany({
    where: { id: deviceId, userId },
  });
  return count > 0;
}

export interface TrustedDeviceListRow {
  id: string;
  label: string | null;
  deviceType: string | null;
  lastSeenAt: Date;
  expiresAt: Date;
  createdAt: Date;
  activeSessions: Array<{
    id: string;
    deviceName: string;
    deviceType: string;
    os: string;
    lastActiveAt: Date;
  }>;
}

/** Return the user's trusted devices with their active sessions nested.
 *  Used by Settings → Devices. */
export async function listForUser(
  userId: string,
): Promise<TrustedDeviceListRow[]> {
  const rows = await prisma.trustedDevice.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
    include: {
      sessions: {
        where: {
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: {
          id: true,
          deviceName: true,
          deviceType: true,
          os: true,
          lastActiveAt: true,
        },
        orderBy: { lastActiveAt: 'desc' },
      },
    },
  });
  return rows.map((d) => ({
    id: d.id,
    label: d.label,
    deviceType: d.deviceType,
    lastSeenAt: d.lastSeenAt,
    expiresAt: d.expiresAt,
    createdAt: d.createdAt,
    activeSessions: d.sessions,
  }));
}
