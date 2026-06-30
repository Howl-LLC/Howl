// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Middleware that blocks API access for users who haven't verified their email.
 *
 * Must be applied AFTER authenticateToken on routes that need it.
 * In practice it is mounted as a blanket middleware on the v1 router with
 * path-based exemptions for the endpoints required to *complete* verification
 * (verify-email, resend-verification, logout, /me, SSO callbacks, etc.).
 *
 * Existing users with emailVerified=true (including grandfathered SSO users)
 * pass through immediately. Only newly created SSO users from unverified
 * providers will be blocked until they verify.
 */
import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { JWT_SECRET, type AuthRequest } from './auth.js';

const VERIFIED_CACHE_TTL_MS = 60_000;
const MAX_VERIFIED_CACHE_SIZE = 10_000;

interface VerifiedEntry {
  emailVerified: boolean;
  expiresAt: number;
}

const verifiedCache = new Map<string, VerifiedEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of verifiedCache) {
    if (now > entry.expiresAt) verifiedCache.delete(key);
  }
}, 60_000).unref();

/** Call after email verification completes to clear stale cache. */
export function invalidateVerifiedEmailCache(userId: string): void {
  verifiedCache.delete(userId);
}

/**
 * Express middleware mounted on the v1 router.  It peeks at the Authorization
 * header, decodes the JWT (without full session validation -- authenticateToken
 * handles that), and checks whether the user has verified their email.
 *
 * Exempt paths must be skipped by the caller before invoking this middleware.
 */
export async function requireVerifiedEmail(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  // If no auth header, skip -- the route's own authenticateToken will reject.
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) { next(); return; }

  try {
    // Reuse JWT payload if requireOnboarding already decoded this token
    const existing = (req as any)._jwtPayload as { userId: string } | undefined;
    const decoded = existing ?? jwt.verify(authHeader.slice(7), JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string };
    const userId = decoded.userId;

    const now = Date.now();
    let entry = verifiedCache.get(userId);
    if (!entry || now > entry.expiresAt) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { emailVerified: true },
      });
      entry = {
        emailVerified: user?.emailVerified ?? false,
        expiresAt: now + VERIFIED_CACHE_TTL_MS,
      };
      if (verifiedCache.size >= MAX_VERIFIED_CACHE_SIZE) {
        const oldest = verifiedCache.keys().next().value;
        if (oldest !== undefined) verifiedCache.delete(oldest);
      }
      verifiedCache.set(userId, entry);
    }

    if (!entry.emailVerified) {
      res.status(403).json({
        error: 'Please verify your email address to continue.',
        email_verification_required: true,
      });
      return;
    }

    next();
  } catch {
    // Token invalid or expired -- let downstream authenticateToken handle the error.
    next();
  }
}
