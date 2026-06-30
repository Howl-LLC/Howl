// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { prisma } from '../db.js';
import { hashEmail } from '../services/mfaCrypto.js';
import { logger } from '../logger.js';
import type { AdminAuthRequest } from './adminAuth.js';

const log = logger.child({ module: 'cf-access-auth' });

// The middleware runs in permissive mode when CF_ACCESS_ENFORCE !== 'true'.
// A missing header is logged-and-allowed so wiring can be verified before
// attaching the Access Application in CF. A present but invalid header is
// still rejected — that catches misconfiguration early.

function teamDomain(): string | null {
  const raw = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
  if (!raw) return null;
  return raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function expectedIssuer(): string | null {
  const td = teamDomain();
  return td ? `https://${td}` : null;
}

function jwksUrl(): URL | null {
  const td = teamDomain();
  return td ? new URL(`https://${td}/cdn-cgi/access/certs`) : null;
}

let cachedJwks: JWTVerifyGetKey | null = null;
let cachedJwksUrl: string | null = null;

function getJwks(): JWTVerifyGetKey | null {
  const u = jwksUrl();
  if (!u) return null;
  if (!cachedJwks || cachedJwksUrl !== u.toString()) {
    cachedJwks = createRemoteJWKSet(u);
    cachedJwksUrl = u.toString();
  }
  return cachedJwks;
}

let warnedDevNoop = false;

export async function cfAccessAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // CORS preflight — no auth, no body; the actual request that follows is
  // checked on its own.
  if (req.method === 'OPTIONS') {
    next();
    return;
  }

  const isProd = process.env.NODE_ENV === 'production';
  const td = teamDomain();

  // Dev mode with no config → no-op, so local development doesn't require
  // a Cloudflare Access tunnel or test JWT.
  if (!isProd && !td) {
    if (!warnedDevNoop) {
      log.warn('CF_ACCESS_TEAM_DOMAIN not set — Cloudflare Access gate is disabled (dev only)');
      warnedDevNoop = true;
    }
    next();
    return;
  }

  if (isProd && (!td || !process.env.CF_ACCESS_AUD)) {
    // Startup guards in server.ts should prevent reaching this branch in prod.
    // Kept as belt-and-suspenders so a misconfigured prod doesn't silently pass.
    log.error('CF Access env not configured in production — blocking admin request');
    res.status(503).json({ error: 'Admin access is not configured' });
    return;
  }

  const header =
    (req.headers['cf-access-jwt-assertion'] as string | undefined) ??
    (req.headers['Cf-Access-Jwt-Assertion' as unknown as string] as string | undefined);

  const enforce = process.env.CF_ACCESS_ENFORCE === 'true';

  if (!header) {
    if (!enforce) {
      log.warn(
        { path: req.originalUrl, method: req.method },
        'admin request without Cf-Access-Jwt-Assertion (permissive mode)',
      );
      next();
      return;
    }
    res.status(403).json({ error: 'cf_access_required' });
    return;
  }

  const jwks = getJwks();
  if (!jwks) {
    log.error('JWKS not available despite team domain being set');
    res.status(503).json({ error: 'Admin access is not configured' });
    return;
  }

  try {
    const { payload } = await jwtVerify(header, jwks, {
      issuer: expectedIssuer()!,
      audience: process.env.CF_ACCESS_AUD!,
    });

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null;
    if (!email) {
      log.warn({ sub: payload.sub }, 'CF Access JWT missing email claim');
      res.status(403).json({ error: 'cf_access_invalid' });
      return;
    }

    const admin = await prisma.adminUser.findUnique({
      where: { emailHash: hashEmail(email) },
      select: { id: true },
    });
    if (!admin) {
      log.warn({ email }, 'CF Access email is not a registered admin');
      res.status(403).json({ error: 'cf_access_email_not_admin' });
      return;
    }

    (req as AdminAuthRequest).cfAccessEmail = email;
    next();
  } catch (err: unknown) {
    const reason =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: string }).code)
        : err instanceof Error
          ? err.message
          : 'unknown';
    log.warn({ reason }, 'cf_access_verify_failed');
    res.status(403).json({ error: 'cf_access_invalid' });
  }
}
