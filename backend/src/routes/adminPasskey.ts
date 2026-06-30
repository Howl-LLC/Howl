// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Admin passkey (WebAuthn) + post-login enrollment wizard.
 *
 * - Passkey is a mandatory second factor for admin login, alongside TOTP.
 * - Enrollment: when an admin logs in without mfaEnabled OR without any
 *   passkey, /login returns an enrollmentToken. The wizard calls
 *   /mfa/setup, /mfa/enable, then passkey/register/begin + /finish here,
 *   and finally /enrollment/complete which issues the real admin JWT.
 * - Login: /passkey/login/begin + /finish are called after /mfa/verify
 *   succeeds (which returns a passkeyToken). /finish issues the real JWT.
 * - Settings: authenticated admins can list / add / delete their own
 *   passkeys (DELETE requires step-up so a momentarily-hijacked session
 *   can't prune all factors).
 */

import { Router, Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { hashToken, hashIp, generateRefreshToken } from '../utils/sessionUtils.js';
import {
  ADMIN_JWT_SECRET,
  authenticateAdminOrEnrollment,
  authenticateAdminToken,
  requireAdminStepUp,
  type AdminAuthRequest,
} from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import {
  adminPasskeyRegisterFinishSchema,
  adminPasskeyLoginBeginSchema,
  adminPasskeyLoginFinishSchema,
  adminPasskeyDeleteSchema,
  adminEnrollmentCompleteSchema,
} from '../schemas.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../services/mfaCrypto.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { markTokenUsedOnce } from '../utils/singleUseToken.js';

const log = logger.child({ module: 'adminPasskey' });

const router = Router();

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_COOKIE_NAME = 'howl_admin_refresh';
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_EXPIRY_DAYS = 7;
const MAX_ADMIN_PASSKEYS = 5;

// Admin WebAuthn config. The admin panel runs at a different origin
// than the main frontend (admin.howlpro.com vs app.howlpro.com), so
// we can't share WEBAUTHN_ORIGIN / WEBAUTHN_RP_ID. Derive admin-specific
// values from ADMIN_ORIGIN (already required for CORS); allow an
// ADMIN_WEBAUTHN_RP_ID override when you want a parent-domain RP ID
// (e.g. "howlpro.com" so passkeys work across subdomains).
function getAdminWebAuthn(): { origin: string; rpID: string } {
  const origin = (process.env.ADMIN_ORIGIN?.split(',')[0]?.trim()) || 'http://localhost:3001';
  const defaultRpId = (() => {
    try { return new URL(origin).hostname; } catch { return 'localhost'; }
  })();
  const rpID = process.env.ADMIN_WEBAUTHN_RP_ID?.trim() || defaultRpId;
  return { origin, rpID };
}

// Single-use token / challenge enforcement is delegated to markTokenUsedOnce
// so the SET NX is atomic across replicas (avoids a TOCTOU on cluster mode).
function tokenFingerprint(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
}

function setRefreshCookie(res: Response, refreshToken: string) {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    path: '/api/admin/auth',
  });
}

function parseDevice(ua: string) {
  let os = 'Unknown';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  // eslint-disable-next-line security/detect-unsafe-regex -- simple alternation, no nested quantifiers
  const browserMatch = ua.match(/(Chrome|Firefox|Safari|Edge|Opera)[/\s]?(\d+)?/i);
  const deviceName = browserMatch ? `${browserMatch[1]} on ${os}` : `Browser on ${os}`;
  return { os, deviceName };
}

async function issueAdminSessionToken(adminId: string, req: import('express').Request, res: Response): Promise<string> {
  const token = jwt.sign({ adminId, scope: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
  const refreshToken = generateRefreshToken();
  const ua = (req.headers['user-agent'] ?? 'Unknown') as string;
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip ?? null;
  const { os, deviceName } = parseDevice(ua);
  await prisma.adminSession.create({
    data: {
      adminUserId: adminId,
      tokenHash: hashToken(token),
      refreshTokenHash: hashToken(refreshToken),
      deviceName,
      os,
      ip: typeof ip === 'string' ? hashIp(ip) : undefined,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  setRefreshCookie(res, refreshToken);
  return token;
}

// Rate limiters

const passkeyWriteLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:admin-passkey-write:'),
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many passkey operations. Try again later.' },
  standardHeaders: true, legacyHeaders: false,
});

const passkeyReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:admin-passkey-read:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: true, legacyHeaders: false,
});

const passkeyLoginLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:admin-passkey-login:'),
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  message: { error: 'Too many passkey login attempts. Try again later.' },
  standardHeaders: true, legacyHeaders: false,
});

// Register: begin + finish (authed admin OR enrollment token)

router.post('/passkey/register/begin', passkeyWriteLimiter, authenticateAdminOrEnrollment, async (req: AdminAuthRequest, res: Response) => {
  try {
    const admin = await prisma.adminUser.findUnique({
      where: { id: req.adminId! },
      select: { id: true, username: true, passkeys: true },
    });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    if (admin.passkeys.length >= MAX_ADMIN_PASSKEYS) {
      return res.status(400).json({ error: `Maximum of ${MAX_ADMIN_PASSKEYS} passkeys allowed` });
    }

    const { rpID } = getAdminWebAuthn();
    const { generateRegistrationOptions } = await import('@simplewebauthn/server');
    const options = await generateRegistrationOptions({
      rpName: 'Howl Admin',
      rpID,
      userName: admin.username,
      userDisplayName: admin.username,
      attestationType: 'none',
      excludeCredentials: admin.passkeys.map((c) => ({
        id: c.credentialId,
        transports: c.transports ? JSON.parse(c.transports) : undefined,
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });

    const challengeToken = jwt.sign(
      { challenge: options.challenge, adminId: admin.id, scope: 'admin-passkey-register' },
      ADMIN_JWT_SECRET,
      { expiresIn: '5m' },
    );
    res.json({ options, challengeToken });
  } catch (err) {
    log.error({ err }, 'Admin passkey register/begin error');
    res.status(500).json({ error: 'Failed to start passkey registration' });
  }
});

router.post('/passkey/register/finish', passkeyWriteLimiter, authenticateAdminOrEnrollment, validate(adminPasskeyRegisterFinishSchema), async (req: AdminAuthRequest, res: Response) => {
  try {
    const { challengeToken, credential, friendlyName } = req.body as { challengeToken: string; credential: any; friendlyName: string };

    let decoded: { challenge: string; adminId: string; scope: string };
    try {
      decoded = jwt.verify(challengeToken, ADMIN_JWT_SECRET, { algorithms: ['HS256'] }) as typeof decoded;
    } catch {
      return res.status(400).json({ error: 'Challenge expired' });
    }
    if (decoded.scope !== 'admin-passkey-register' || decoded.adminId !== req.adminId) {
      return res.status(400).json({ error: 'Invalid challenge' });
    }

    const claimed = await markTokenUsedOnce('admin-passkey:used-token', tokenFingerprint(decoded.challenge), 600);
    if (!claimed) return res.status(400).json({ error: 'Challenge already used' });

    const { origin, rpID } = getAdminWebAuthn();
    const { verifyRegistrationResponse } = await import('@simplewebauthn/server');
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: decoded.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Passkey verification failed' });
    }

    const { credential: regCredential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    const existingCount = await prisma.adminPasskey.count({ where: { adminUserId: req.adminId! } });
    if (existingCount >= MAX_ADMIN_PASSKEYS) {
      return res.status(400).json({ error: `Maximum of ${MAX_ADMIN_PASSKEYS} passkeys allowed` });
    }

    await prisma.adminPasskey.create({
      data: {
        adminUserId: req.adminId!,
        credentialId: regCredential.id,
        publicKey: Buffer.from(regCredential.publicKey).toString('base64'),
        counter: regCredential.counter,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        transports: credential.response?.transports ? JSON.stringify(credential.response.transports) : null,
        friendlyName,
      },
    });

    log.info({ adminId: req.adminId }, 'Admin passkey registered');
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    log.error({ err, message }, 'Admin passkey register/finish error');
    res.status(500).json({ error: 'Failed to register passkey', detail: message });
  }
});

// Login: begin + finish (requires passkeyToken from /mfa/verify)

router.post('/passkey/login/begin', passkeyLoginLimiter, validate(adminPasskeyLoginBeginSchema), async (req, res) => {
  try {
    const { passkeyToken } = req.body as { passkeyToken: string };

    let decoded: { adminId: string; scope: string };
    try {
      decoded = jwt.verify(passkeyToken, ADMIN_JWT_SECRET, { algorithms: ['HS256'] }) as typeof decoded;
    } catch (err: any) {
      if (err?.name === 'TokenExpiredError') return res.status(401).json({ error: 'Passkey token expired. Please log in again.' });
      return res.status(401).json({ error: 'Invalid passkey token' });
    }
    if (decoded.scope !== 'admin-passkey-login') {
      return res.status(401).json({ error: 'Invalid token scope' });
    }

    const credentials = await prisma.adminPasskey.findMany({
      where: { adminUserId: decoded.adminId },
      select: { credentialId: true, transports: true },
      take: MAX_ADMIN_PASSKEYS,
    });
    if (credentials.length === 0) {
      return res.status(400).json({ error: 'No passkeys registered for this admin' });
    }

    const { rpID } = getAdminWebAuthn();
    const { generateAuthenticationOptions } = await import('@simplewebauthn/server');
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: credentials.map((c) => ({
        id: c.credentialId,
        transports: c.transports ? JSON.parse(c.transports) : undefined,
      })),
      userVerification: 'preferred',
    });

    const challengeToken = jwt.sign(
      { challenge: options.challenge, adminId: decoded.adminId, scope: 'admin-passkey-auth' },
      ADMIN_JWT_SECRET,
      { expiresIn: '5m' },
    );
    res.json({ options, challengeToken });
  } catch (err) {
    log.error({ err }, 'Admin passkey login/begin error');
    res.status(500).json({ error: 'Failed to start passkey login' });
  }
});

router.post('/passkey/login/finish', passkeyLoginLimiter, validate(adminPasskeyLoginFinishSchema), async (req, res) => {
  try {
    const { challengeToken, credential } = req.body as { challengeToken: string; credential: any };

    let decoded: { challenge: string; adminId: string; scope: string };
    try {
      decoded = jwt.verify(challengeToken, ADMIN_JWT_SECRET, { algorithms: ['HS256'] }) as typeof decoded;
    } catch (err: any) {
      if (err?.name === 'TokenExpiredError') return res.status(401).json({ error: 'Challenge expired' });
      return res.status(401).json({ error: 'Invalid challenge token' });
    }
    if (decoded.scope !== 'admin-passkey-auth') {
      return res.status(401).json({ error: 'Invalid token scope' });
    }

    const claimed = await markTokenUsedOnce('admin-passkey:used-token', tokenFingerprint(decoded.challenge), 600);
    if (!claimed) return res.status(400).json({ error: 'Challenge already used' });

    const stored = await prisma.adminPasskey.findUnique({ where: { credentialId: credential.id } });
    if (!stored || stored.adminUserId !== decoded.adminId) {
      return res.status(401).json({ error: 'Unknown passkey' });
    }

    const { origin, rpID } = getAdminWebAuthn();
    const { verifyAuthenticationResponse } = await import('@simplewebauthn/server');
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: decoded.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: stored.credentialId,
        publicKey: Buffer.from(stored.publicKey, 'base64'),
        counter: stored.counter,
        transports: stored.transports ? JSON.parse(stored.transports) : undefined,
      },
    });

    if (!verification.verified) {
      return res.status(401).json({ error: 'Passkey verification failed' });
    }

    await prisma.adminPasskey.update({
      where: { id: stored.id },
      data: {
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: new Date(),
      },
    });

    const admin = await prisma.adminUser.findUnique({
      where: { id: decoded.adminId },
      select: { id: true, email: true, username: true, role: true, forcePasswordChange: true },
    });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    const token = await issueAdminSessionToken(admin.id, req, res);
    await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } }).catch(() => {});

    log.info({ adminId: admin.id }, 'Admin passkey login');

    let plainEmail: string;
    try { plainEmail = decryptSecret(admin.email); } catch { plainEmail = admin.email; }

    res.json({
      token,
      user: { id: admin.id, email: plainEmail, username: admin.username, role: admin.role, forcePasswordChange: admin.forcePasswordChange },
    });
  } catch (err) {
    log.error({ err }, 'Admin passkey login/finish error');
    res.status(500).json({ error: 'Passkey login failed' });
  }
});

// List / delete own passkeys (authed + step-up for delete)

router.get('/passkey', passkeyReadLimiter, authenticateAdminToken, async (req: AdminAuthRequest, res: Response) => {
  try {
    const passkeys = await prisma.adminPasskey.findMany({
      where: { adminUserId: req.adminId! },
      select: { id: true, friendlyName: true, deviceType: true, backedUp: true, lastUsedAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_ADMIN_PASSKEYS + 1,
    });
    res.json({ passkeys });
  } catch (err) {
    log.error({ err }, 'List admin passkeys error');
    res.status(500).json({ error: 'Failed to list passkeys' });
  }
});

router.delete('/passkey/:id', passkeyWriteLimiter, authenticateAdminToken, requireAdminStepUp, validate(adminPasskeyDeleteSchema), validateUuidParams('id'), async (req: AdminAuthRequest, res: Response) => {
  try {
    const passkey = await prisma.adminPasskey.findUnique({ where: { id: req.params.id as string } });
    if (!passkey || passkey.adminUserId !== req.adminId) {
      return res.status(404).json({ error: 'Passkey not found' });
    }
    await prisma.adminPasskey.delete({ where: { id: passkey.id } });
    log.info({ adminId: req.adminId, passkeyId: passkey.id }, 'Admin passkey deleted');
    res.json({ success: true });
  } catch (err) {
    log.error({ err }, 'Delete admin passkey error');
    res.status(500).json({ error: 'Failed to delete passkey' });
  }
});

// Enrollment completion (issues real admin JWT after both factors set)

router.post('/enrollment/complete', passkeyWriteLimiter, validate(adminEnrollmentCompleteSchema), async (req, res) => {
  try {
    const { enrollmentToken } = req.body as { enrollmentToken: string };

    let decoded: { adminId: string; scope: string };
    try {
      decoded = jwt.verify(enrollmentToken, ADMIN_JWT_SECRET, { algorithms: ['HS256'] }) as typeof decoded;
    } catch (err: any) {
      if (err?.name === 'TokenExpiredError') return res.status(401).json({ error: 'Enrollment token expired. Please log in again.' });
      return res.status(401).json({ error: 'Invalid enrollment token' });
    }
    if (decoded.scope !== 'admin-enrollment') {
      return res.status(401).json({ error: 'Invalid token scope' });
    }

    // Single-use: consume the enrollment token
    const acquired = await markTokenUsedOnce('admin-passkey:used-token', tokenFingerprint(enrollmentToken), 900);
    if (!acquired) return res.status(400).json({ error: 'Enrollment token already used. Please log in again.' });

    const admin = await prisma.adminUser.findUnique({
      where: { id: decoded.adminId },
      select: {
        id: true, email: true, username: true, role: true, forcePasswordChange: true,
        mfaEnabled: true,
        _count: { select: { passkeys: true } },
      },
    });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    if (!admin.mfaEnabled || admin._count.passkeys === 0) {
      return res.status(400).json({
        error: 'Enrollment incomplete',
        mfaEnabled: admin.mfaEnabled,
        passkeyCount: admin._count.passkeys,
      });
    }

    const token = await issueAdminSessionToken(admin.id, req, res);
    await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } }).catch(() => {});

    log.info({ adminId: admin.id }, 'Admin enrollment complete');

    let plainEmail: string;
    try { plainEmail = decryptSecret(admin.email); } catch { plainEmail = admin.email; }

    res.json({
      token,
      user: { id: admin.id, email: plainEmail, username: admin.username, role: admin.role, forcePasswordChange: admin.forcePasswordChange },
    });
  } catch (err) {
    log.error({ err }, 'Admin enrollment/complete error');
    res.status(500).json({ error: 'Enrollment completion failed' });
  }
});

export default router;
