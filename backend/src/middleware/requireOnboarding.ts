// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Middleware that blocks API access for users who haven't completed onboarding
 * (SSO users who haven't provided DOB + ToS consent) or who are missing a
 * date of birth (legacy accounts created before the DOB requirement).
 *
 * Must be applied AFTER authenticateToken on routes that need it.
 * In practice it is mounted as a blanket middleware on the v1 router with
 * path-based exemptions for the auth endpoints required to *complete* onboarding.
 */
import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { JWT_SECRET, type AuthRequest } from './auth.js';

const ONBOARDING_CACHE_TTL_MS = 60_000;
const MAX_ONBOARDING_CACHE_SIZE = 10_000;

interface OnboardingEntry {
  needsOnboarding: boolean;
  hasDateOfBirth: boolean;
  expiresAt: number;
}

const onboardingCache = new Map<string, OnboardingEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of onboardingCache) {
    if (now > entry.expiresAt) onboardingCache.delete(key);
  }
}, 60_000).unref();

/** Call after onboarding completes or DOB is set to clear stale cache. */
export function invalidateOnboardingCache(userId: string): void {
  onboardingCache.delete(userId);
}

/**
 * Express middleware mounted on the v1 router.  It peeks at the Authorization
 * header, decodes the JWT (without full session validation — authenticateToken
 * handles that), and checks the user's onboarding / DOB status.
 *
 * Exempt paths (relative to wherever the router is mounted) must be skipped
 * by the caller before invoking this middleware.
 */
export async function requireOnboarding(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  // If no auth header, skip — the route's own authenticateToken will reject.
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) { next(); return; }

  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string };
    const userId = decoded.userId;

    // Store verified JWT payload on req so authenticateToken can skip redundant decode
    (req as any)._jwtPayload = decoded;
    const now = Date.now();

    let entry = onboardingCache.get(userId);
    if (!entry || now > entry.expiresAt) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { needsOnboarding: true, dateOfBirth: true },
      });
      entry = {
        needsOnboarding: !!user?.needsOnboarding,
        hasDateOfBirth: !!user?.dateOfBirth,
        expiresAt: now + ONBOARDING_CACHE_TTL_MS,
      };
      if (onboardingCache.size >= MAX_ONBOARDING_CACHE_SIZE) {
        const oldest = onboardingCache.keys().next().value;
        if (oldest !== undefined) onboardingCache.delete(oldest);
      }
      onboardingCache.set(userId, entry);
    }

    if (entry.needsOnboarding) {
      res.status(403).json({
        error: 'Please complete account setup before using Howl.',
        needsOnboarding: true,
      });
      return;
    }

    if (!entry.hasDateOfBirth) {
      res.status(403).json({
        error: 'Please set your date of birth to continue.',
        needsDateOfBirth: true,
      });
      return;
    }

    next();
  } catch {
    // Token invalid or expired — let downstream authenticateToken handle the error.
    next();
  }
}
