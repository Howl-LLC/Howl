// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { hashToken } from '../utils/sessionUtils.js';
import { hasAdminStepUp } from '../utils/adminStepUp.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'adminAuth' });

/**
 * Require a password re-prompt within the last 5 minutes for destructive
 * endpoints. Apply AFTER `authenticateAdminToken`.
 */
export const requireAdminStepUp = async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
  if (!req.adminId) return res.status(401).json({ error: 'Missing admin ID' });
  const ok = await hasAdminStepUp(req.adminId);
  if (!ok) return res.status(401).json({ error: 'Step-up required', requiresStepUp: true });
  next();
};

export const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || (() => { throw new Error('ADMIN_JWT_SECRET must be set. For tests, set ADMIN_JWT_SECRET in your test setup.'); })();

export interface AdminAuthRequest extends Request {
  adminId?: string;
  adminRole?: string;
  cfAccessEmail?: string;
  /** Present only when auth came via an admin-enrollment token. */
  enrollment?: { jti: string; needs: Array<'totp' | 'passkey'> };
}

export const requireSuperAdmin = async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
  if (!req.adminId) return res.status(401).json({ error: 'Missing admin ID' });
  const admin = await prisma.adminUser.findUnique({
    where: { id: req.adminId },
    select: { role: true },
  });
  if (!admin || (admin.role !== 'superadmin' && admin.role !== 'owner')) {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  req.adminRole = admin.role;
  next();
};

const SESSION_CACHE_TTL_MS = 30_000;
const SESSION_WRITE_DEBOUNCE_MS = 5 * 60_000;
const MAX_ADMIN_SESSION_CACHE_SIZE = 1_000;
const MAX_ADMIN_LAST_ACTIVE_SIZE = 1_000;
const adminSessionCache = new Map<string, { valid: boolean; expiresAt: number; adminId: string }>();
const lastActiveWriteTimestamps = new Map<string, number>();

function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of adminSessionCache) {
    if (now > entry.expiresAt) adminSessionCache.delete(key);
  }
  for (const [key, ts] of lastActiveWriteTimestamps) {
    if (now - ts > SESSION_WRITE_DEBOUNCE_MS * 2) lastActiveWriteTimestamps.delete(key);
  }
}
setInterval(pruneCache, 60_000).unref();

function debouncedAdminSessionWrite(tokenHash: string) {
  const now = Date.now();
  const last = lastActiveWriteTimestamps.get(tokenHash);
  if (last && now - last < SESSION_WRITE_DEBOUNCE_MS) return;
  if (lastActiveWriteTimestamps.size >= MAX_ADMIN_LAST_ACTIVE_SIZE && !lastActiveWriteTimestamps.has(tokenHash)) {
    const oldest = lastActiveWriteTimestamps.keys().next().value;
    if (oldest !== undefined) lastActiveWriteTimestamps.delete(oldest);
  }
  lastActiveWriteTimestamps.set(tokenHash, now);
  prisma.adminSession.updateMany({
    where: { tokenHash },
    data: { lastActiveAt: new Date() },
  }).catch(() => {});
}

export function invalidateAdminSessionCache(tokenHash: string) {
  adminSessionCache.delete(tokenHash);
}

export function invalidateAdminSessionCacheForUser(adminId: string): void {
  for (const [key, entry] of adminSessionCache) {
    if (entry.adminId === adminId) adminSessionCache.delete(key);
  }
}

export const enforcePasswordChange = async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
  if (!req.adminId) return next();
  try {
    const admin = await prisma.adminUser.findUnique({
      where: { id: req.adminId },
      select: { forcePasswordChange: true },
    });
    if (!admin || !admin.forcePasswordChange) return next();
    // Fail closed. The change-password / logout / me / mfa endpoints live under
    // /admin/auth/*, which never runs this middleware (server.ts mounts it with
    // cfAccessAuth only), so there is nothing to allowlist here. The previous
    // originalUrl.includes() allowlist was bypassable via a query string such as
    // ?x=/admin/auth/logout, because originalUrl carries the query. (D-PWCHANGE)
    return res.status(403).json({ error: 'Password change required', forcePasswordChange: true });
  } catch {
    return next();
  }
};

/**
 * Accepts either a normal admin JWT (scope: 'admin', must match a live
 * AdminSession) or a short-lived enrollment JWT (scope: 'admin-enrollment',
 * no session required). Used by the enrollment wizard so an admin who
 * finished password + TOTP but hasn't yet registered a passkey can call
 * /mfa/setup, /mfa/enable, and the passkey register endpoints before a
 * real session exists.
 */
export const authenticateAdminOrEnrollment = async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET, { algorithms: ['HS256'] }) as { adminId: string; scope?: string };
    if (decoded.scope === 'admin') {
      const tHash = hashToken(token);
      const session = await prisma.adminSession.findUnique({ where: { tokenHash: tHash }, select: { id: true } });
      if (!session) return res.status(401).json({ error: 'Session revoked' });
      req.adminId = decoded.adminId;
      return next();
    }
    if (decoded.scope === 'admin-enrollment') {
      // enrollment tokens must carry { jti, needs } so the
      // ceremonies can be bound to this specific token. Old-format tokens
      // fail closed. (Claim check is inlined; importing the enrollment util
      // here would create an import cycle via ADMIN_JWT_SECRET.)
      const { jti, needs } = decoded as unknown as { jti?: unknown; needs?: unknown };
      if (
        typeof jti !== 'string' || jti.length === 0 ||
        !Array.isArray(needs) || needs.length === 0 ||
        !needs.every((n) => n === 'totp' || n === 'passkey')
      ) {
        return res.status(401).json({ error: 'Invalid token scope' });
      }
      req.adminId = decoded.adminId;
      req.enrollment = { jti, needs: needs as Array<'totp' | 'passkey'> };
      return next();
    }
    return res.status(401).json({ error: 'Invalid token scope' });
  } catch (err) {
    log.error({ err }, 'Admin/enrollment token verification error');
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

export const authenticateAdminToken = async (req: AdminAuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET, { algorithms: ['HS256'] }) as { adminId: string; scope?: string };
    if (decoded.scope !== 'admin') {
      return res.status(401).json({ error: 'Invalid token scope' });
    }

    const tHash = hashToken(token);
    const now = Date.now();

    const cached = adminSessionCache.get(tHash);
    if (cached && now < cached.expiresAt) {
      if (!cached.valid) return res.status(401).json({ error: 'Session revoked' });
      req.adminId = decoded.adminId;
      debouncedAdminSessionWrite(tHash);
      return next();
    }

    const session = await prisma.adminSession.findUnique({ where: { tokenHash: tHash }, select: { id: true } });
    if (adminSessionCache.size >= MAX_ADMIN_SESSION_CACHE_SIZE) {
      const oldest = adminSessionCache.keys().next().value;
      if (oldest !== undefined) adminSessionCache.delete(oldest);
    }
    adminSessionCache.set(tHash, { valid: !!session, expiresAt: now + SESSION_CACHE_TTL_MS, adminId: decoded.adminId });

    if (!session) {
      return res.status(401).json({ error: 'Session revoked' });
    }

    req.adminId = decoded.adminId;
    debouncedAdminSessionWrite(tHash);
    next();
  } catch (err) {
    log.error({ err }, 'Admin token verification error');
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
