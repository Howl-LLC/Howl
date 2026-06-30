// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { hashToken } from '../utils/sessionUtils.js';
import { onSessionInvalidation } from '../redis.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'auth' });

export const JWT_SECRET = process.env.JWT_SECRET || (() => { throw new Error('JWT_SECRET must be set. For tests, set JWT_SECRET in your test setup.'); })();

export interface AuthRequest extends Request {
  userId?: string;
}

const SESSION_CACHE_TTL_MS = 30_000;
const SESSION_WRITE_DEBOUNCE_MS = 5 * 60_000;
const SUSPENDED_CACHE_TTL_MS = 60_000;
const MAX_SESSION_CACHE_SIZE = 10_000;
const MAX_SUSPENDED_CACHE_SIZE = 10_000;
const MAX_LAST_ACTIVE_SIZE = 10_000;
const sessionCache = new Map<string, { valid: boolean; expiresAt: number; userId: string }>();
const suspendedCache = new Map<string, { suspended: boolean; expiresAt: number }>();
const lastActiveWriteTimestamps = new Map<string, number>();

function pruneSessionCache() {
  const now = Date.now();
  for (const [key, entry] of sessionCache) {
    if (now > entry.expiresAt) sessionCache.delete(key);
  }
  for (const [key, ts] of lastActiveWriteTimestamps) {
    if (now - ts > SESSION_WRITE_DEBOUNCE_MS * 2) lastActiveWriteTimestamps.delete(key);
  }
  for (const [key, entry] of suspendedCache) {
    if (now > entry.expiresAt) suspendedCache.delete(key);
  }
}
setInterval(pruneSessionCache, 60_000).unref();

// Ensure REST API session cache respects cross-instance session revocations
onSessionInvalidation((tokenHash: string) => {
  sessionCache.set(tokenHash, { valid: false, expiresAt: Date.now() + SESSION_CACHE_TTL_MS, userId: '' });
});

function debouncedSessionWrite(tokenHash: string) {
  const now = Date.now();
  const last = lastActiveWriteTimestamps.get(tokenHash);
  if (last && now - last < SESSION_WRITE_DEBOUNCE_MS) return;
  if (lastActiveWriteTimestamps.size >= MAX_LAST_ACTIVE_SIZE && !lastActiveWriteTimestamps.has(tokenHash)) {
    const oldest = lastActiveWriteTimestamps.keys().next().value;
    if (oldest !== undefined) lastActiveWriteTimestamps.delete(oldest);
  }
  lastActiveWriteTimestamps.set(tokenHash, now);
  prisma.session.updateMany({
    where: { tokenHash },
    data: { lastActiveAt: new Date() },
  }).catch(() => {});
}

export function invalidateSessionCache(tokenHash: string) {
  sessionCache.delete(tokenHash);
}

export function invalidateSessionCacheForUser(userId: string): void {
  for (const [key, entry] of sessionCache) {
    if (entry.userId === userId) {
      sessionCache.delete(key);
    }
  }
  suspendedCache.delete(userId);
}

export function markUserSuspended(userId: string): void {
  if (suspendedCache.size >= MAX_SUSPENDED_CACHE_SIZE) {
    const oldest = suspendedCache.keys().next().value;
    if (oldest !== undefined) suspendedCache.delete(oldest);
  }
  suspendedCache.set(userId, { suspended: true, expiresAt: Date.now() + SUSPENDED_CACHE_TTL_MS });
  invalidateSessionCacheForUser(userId);
}

export const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  try {
    // Reuse JWT payload if requireOnboarding already verified this token (avoids double decode)
    const decoded = ((req as any)._jwtPayload as { userId: string } | undefined)
      ?? jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string };
    // Reject MFA-purpose tokens — they are not valid session tokens
    if ((decoded as any).purpose) {
      return res.status(401).json({ error: 'Invalid token type' });
    }
    const tHash = hashToken(token);
    const now = Date.now();

    const cached = sessionCache.get(tHash);
    if (cached && now < cached.expiresAt) {
      if (!cached.valid) {
        return res.status(401).json({ error: 'Session revoked' });
      }
      // LRU: delete and re-insert to move to end of Map iteration order
      sessionCache.delete(tHash);
      sessionCache.set(tHash, cached);
      req.userId = decoded.userId;
      debouncedSessionWrite(tHash);
      return next();
    }

    const session = await prisma.session.findUnique({ where: { tokenHash: tHash }, select: { id: true } });
    if (sessionCache.size >= MAX_SESSION_CACHE_SIZE) {
      const oldest = sessionCache.keys().next().value;
      if (oldest !== undefined) sessionCache.delete(oldest);
    }
    sessionCache.set(tHash, { valid: !!session, expiresAt: now + SESSION_CACHE_TTL_MS, userId: decoded.userId });

    if (!session) {
      return res.status(401).json({ error: 'Session revoked' });
    }

    const suspCached = suspendedCache.get(decoded.userId);
    let isSuspended: boolean;
    if (suspCached && now < suspCached.expiresAt) {
      isSuspended = suspCached.suspended;
    } else {
      const u = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { suspended: true } });
      isSuspended = !!u?.suspended;
      if (suspendedCache.size >= MAX_SUSPENDED_CACHE_SIZE) {
        const oldest = suspendedCache.keys().next().value;
        if (oldest !== undefined) suspendedCache.delete(oldest);
      }
      suspendedCache.set(decoded.userId, { suspended: isSuspended, expiresAt: now + SUSPENDED_CACHE_TTL_MS });
    }
    if (isSuspended) {
      sessionCache.delete(tHash);
      return res.status(403).json({ error: 'Your account has been suspended.' });
    }

    req.userId = decoded.userId;
    debouncedSessionWrite(tHash);
    next();
  } catch (err) {
    log.error({ err }, 'Token verification error');
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
