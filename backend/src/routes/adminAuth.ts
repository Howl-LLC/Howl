// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { hashToken, generateRefreshToken, hashIp } from '../utils/sessionUtils.js';
import { markAdminRefreshConsumed, getConsumedAdminRefresh } from '../utils/adminRefreshReuse.js';
import { ADMIN_JWT_SECRET, authenticateAdminToken, authenticateAdminOrEnrollment, invalidateAdminSessionCache, invalidateAdminSessionCacheForUser, type AdminAuthRequest } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { adminLoginSchema, adminMfaEnableSchema, adminMfaDisableSchema, adminMfaVerifySchema, adminChangePasswordSchema } from '../schemas.js';
import { logger } from '../logger.js';
import { getLoginLockout, setLoginLockout, deleteLoginLockout } from '../redis.js';
import { hashEmail, encryptSecret, decryptSecret } from '../services/mfaCrypto.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { markTokenUsedOnce, isTokenAlreadyUsed } from '../utils/singleUseToken.js';

const log = logger.child({ module: 'adminAuth' });

const router = Router();

// Periodic cleanup of expired admin sessions (runs every 6 hours)
const ADMIN_SESSION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
async function cleanupExpiredAdminSessions() {
  try {
    const result = await prisma.adminSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (result.count > 0) {
      log.info({ count: result.count }, 'Cleaned up expired admin sessions');
    }
  } catch (err) {
    log.error({ err }, 'Failed to clean up expired admin sessions');
  }
}
// Run once on startup (after a short delay to let DB connect), then on interval
setTimeout(cleanupExpiredAdminSessions, 30_000);
const _adminSessionCleanupTimer = setInterval(cleanupExpiredAdminSessions, ADMIN_SESSION_CLEANUP_INTERVAL_MS);
_adminSessionCleanupTimer.unref();

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_COOKIE_NAME = 'howl_admin_refresh';
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_ADMIN_LOGIN_ATTEMPTS = 5;
const ADMIN_LOCKOUT_DURATION_MS = 30 * 60 * 1000;

// Single-use admin MFA token enforcement is delegated to markTokenUsedOnce
// so the SET NX is atomic across replicas.

function setRefreshCookie(res: Response, refreshToken: string) {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    path: '/api/admin/auth',
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/admin/auth',
  });
}

const adminLoginLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:admin-login:'),
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 100,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminRefreshLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:admin-refresh:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many refresh attempts.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/admin/auth/login
router.post('/login', adminLoginLimiter, validate(adminLoginSchema), async (req, res) => {
  try {
    const { email, password } = req.body as { email: string; password: string };

    const raw = (email ?? '').trim();
    const normalized = raw.toLowerCase();
    const isEmail = normalized.includes('@');

    const lockEntry = await getLoginLockout(`admin:${normalized}`);
    if (lockEntry && Date.now() < lockEntry.lockedUntil) {
      const mins = Math.ceil((lockEntry.lockedUntil - Date.now()) / 60000);
      return res.status(429).json({ error: `Account temporarily locked. Try again in ${mins} minute(s).` });
    }

    // Look up by email (hash) or by username
    const DUMMY_HASH = '$2b$12$LJ3m4ys3Lg3Sv4vQx5w8XOQz0rZ4v5b6Y7c8D9eAf0gBhCiDjEkFl';
    const admin = isEmail
      ? await prisma.adminUser.findUnique({ where: { emailHash: hashEmail(normalized) } })
      : await prisma.adminUser.findFirst({ where: { username: { equals: raw, mode: 'insensitive' } } });
    const hashToCompare = admin?.passwordHash || DUMMY_HASH;
    const valid = await bcrypt.compare(password, hashToCompare);

    if (!admin || !valid) {
      const entry = lockEntry || { count: 0, lockedUntil: 0 };
      entry.count++;
      if (entry.count >= MAX_ADMIN_LOGIN_ATTEMPTS) {
        entry.lockedUntil = Date.now() + ADMIN_LOCKOUT_DURATION_MS;
        log.warn({ email: normalized, attempts: entry.count }, 'Admin account locked after failed attempts');
      }
      await setLoginLockout(`admin:${normalized}`, entry);
      if (process.env.NODE_ENV !== 'production') {
        log.warn({ email: normalized }, 'Admin login: invalid credentials');
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await deleteLoginLockout(`admin:${normalized}`);

    // Admin login requires BOTH TOTP and at least one registered passkey.
    // If either factor is missing, route the admin to the enrollment wizard
    // via a short-lived enrollment token instead of issuing an admin JWT.
    const passkeyCount = await prisma.adminPasskey.count({ where: { adminUserId: admin.id } });
    const totpReady = admin.mfaEnabled && !!admin.mfaTotpSecret;
    const fullyEnrolled = totpReady && passkeyCount > 0;

    if (!fullyEnrolled) {
      const enrollmentToken = jwt.sign(
        { adminId: admin.id, scope: 'admin-enrollment' },
        ADMIN_JWT_SECRET,
        { expiresIn: '15m' },
      );
      log.info(
        { adminId: admin.id, mfaEnabled: admin.mfaEnabled, passkeyCount },
        'Admin login: enrollment required',
      );
      return res.json({
        enrollmentRequired: true,
        enrollmentToken,
        mfaEnabled: totpReady,
        passkeyCount,
      });
    }

    // Fully enrolled: issue MFA challenge token. Final JWT is issued only
    // after the full TOTP → passkey chain completes.
    const mfaToken = jwt.sign(
      { adminId: admin.id, scope: 'admin-mfa-login' },
      ADMIN_JWT_SECRET,
      { expiresIn: '5m' },
    );
    log.info({ adminId: admin.id }, 'Admin login: MFA required');
    return res.json({ mfaRequired: true, mfaToken });
  } catch (err) {
    log.error({ err }, 'Admin login error');
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/admin/auth/refresh
router.post('/refresh', adminRefreshLimiter, async (req, res) => {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!refreshToken) {
      return res.status(401).json({ error: 'No refresh token' });
    }

    const rtHash = hashToken(refreshToken);
    const session = await prisma.adminSession.findFirst({
      where: { refreshTokenHash: rtHash },
      include: { adminUser: { select: { id: true } } },
    });

    if (!session) {
      // Refresh-token reuse detection. If this hash was the one we just
      // rotated for some admin within the last 60s, the fact that someone
      // is trying to re-use it signals possible theft — kill every session
      // for that admin and force re-auth. Mirrors the user-side reuse
      // detection in routes/auth.ts.
      const compromisedAdminId = await getConsumedAdminRefresh(rtHash);
      if (compromisedAdminId) {
        await prisma.adminSession.deleteMany({ where: { adminUserId: compromisedAdminId } }).catch(() => {});
        invalidateAdminSessionCacheForUser(compromisedAdminId);
        log.warn(
          { securityEvent: 'admin_refresh_reuse', adminId: compromisedAdminId, ipMasked: req.ip ? hashIp(req.ip) : null },
          'admin refresh-token reuse detected; all sessions killed',
        );
      }
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    if (session.expiresAt && session.expiresAt < new Date()) {
      await prisma.adminSession.delete({ where: { id: session.id } }).catch(() => {});
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    const ABSOLUTE_ADMIN_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7 days absolute max
    if (session.createdAt && Date.now() - new Date(session.createdAt).getTime() > ABSOLUTE_ADMIN_SESSION_LIFETIME_MS) {
      await prisma.adminSession.delete({ where: { id: session.id } }).catch(() => {});
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    invalidateAdminSessionCache(session.tokenHash);

    const newToken = jwt.sign({ adminId: session.adminUserId, scope: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const newRefreshToken = generateRefreshToken();

    await prisma.adminSession.update({
      where: { id: session.id },
      data: {
        tokenHash: hashToken(newToken),
        refreshTokenHash: hashToken(newRefreshToken),
        lastActiveAt: new Date(),
      },
    });

    // Record the just-rotated refresh hash so any subsequent /refresh call
    // using it triggers the reuse-detection branch above.
    await markAdminRefreshConsumed(rtHash, session.adminUserId).catch((err) => {
      log.warn({ err }, 'Failed to record consumed admin refresh hash');
    });

    setRefreshCookie(res, newRefreshToken);
    res.json({ token: newToken });
  } catch (err) {
    log.error({ err }, 'Admin refresh error');
    res.status(500).json({ error: 'Refresh failed' });
  }
});

// GET /api/admin/auth/me
router.get('/me', authenticateAdminToken, async (req: AdminAuthRequest, res) => {
  try {
    const admin = await prisma.adminUser.findUnique({
      where: { id: req.adminId! },
      select: { id: true, email: true, username: true, role: true, forcePasswordChange: true, createdAt: true },
    });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    let plainEmail: string;
    try { plainEmail = decryptSecret(admin.email); } catch { plainEmail = admin.email; }
    res.json({ ...admin, email: plainEmail });
  } catch (err) {
    log.error({ err }, 'Admin me error');
    res.status(500).json({ error: 'Failed to fetch admin info' });
  }
});

const adminLogoutLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:admin-logout:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/admin/auth/logout
router.post('/logout', adminLogoutLimiter, authenticateAdminToken, async (req: AdminAuthRequest, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token) {
      const tHash = hashToken(token);
      invalidateAdminSessionCache(tHash);
      await prisma.adminSession.deleteMany({ where: { tokenHash: tHash } });
    }
    invalidateAdminSessionCacheForUser(req.adminId!);
    clearRefreshCookie(res);
    res.json({ success: true });
  } catch (err) {
    log.error({ err }, 'Admin logout error');
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Admin Change Password

const adminChangePasswordLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:admin-change-pw:'),
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many password change attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/admin/auth/change-password
router.post('/change-password', adminChangePasswordLimiter, authenticateAdminToken, validate(adminChangePasswordSchema), async (req: AdminAuthRequest, res) => {
  try {
    const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };

    const admin = await prisma.adminUser.findUnique({
      where: { id: req.adminId! },
      select: { id: true, passwordHash: true },
    });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    const validPw = await bcrypt.compare(currentPassword, admin.passwordHash);
    if (!validPw) return res.status(401).json({ error: 'Incorrect current password' });

    const newHash = await bcrypt.hash(newPassword, 12);
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { passwordHash: newHash, forcePasswordChange: false },
    });

    // Invalidate all OTHER sessions (keep current session alive)
    const authHeader = req.headers['authorization'];
    const currentToken = authHeader?.split(' ')[1];
    const currentHash = currentToken ? hashToken(currentToken) : null;

    if (currentHash) {
      await prisma.adminSession.deleteMany({
        where: { adminUserId: admin.id, tokenHash: { not: currentHash } },
      });
    }
    invalidateAdminSessionCacheForUser(admin.id);

    log.info({ adminId: admin.id }, 'Admin password changed');
    res.json({ success: true });
  } catch (err) {
    log.error({ err }, 'Admin change password error');
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Step-up

const adminStepUpLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:admin-stepup:'),
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many step-up attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/admin/auth/step-up { password }
// Fresh password confirmation required before destructive admin actions.
// Sets a 5-minute Redis flag that downstream `requireAdminStepUp` middleware checks.
router.post('/step-up', adminStepUpLimiter, authenticateAdminToken, async (req: AdminAuthRequest, res) => {
  try {
    const { password } = req.body as { password?: string };
    if (!password || typeof password !== 'string' || password.length < 1) {
      return res.status(400).json({ error: 'Password required' });
    }
    const admin = await prisma.adminUser.findUnique({
      where: { id: req.adminId! },
      select: { id: true, passwordHash: true },
    });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });
    const { setAdminStepUp } = await import('../utils/adminStepUp.js');
    await setAdminStepUp(admin.id);
    res.json({ success: true, expiresInSeconds: 300 });
  } catch (err) {
    log.error({ err }, 'Admin step-up error');
    res.status(500).json({ error: 'Step-up failed' });
  }
});

// Admin MFA

const adminMfaLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:admin-mfa:'),
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many MFA attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/admin/auth/mfa/status
router.get('/mfa/status', authenticateAdminToken, async (req: AdminAuthRequest, res) => {
  try {
    const admin = await prisma.adminUser.findUnique({
      where: { id: req.adminId! },
      select: { mfaEnabled: true },
    });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    res.json({ mfaEnabled: admin.mfaEnabled });
  } catch (err) {
    log.error({ err }, 'Admin MFA status error');
    res.status(500).json({ error: 'Failed to fetch MFA status' });
  }
});

// POST /api/admin/auth/mfa/setup
// Accepts admin JWT (for an already-authenticated admin) OR enrollment token
// (during the post-login enrollment wizard, before a full session exists).
router.post('/mfa/setup', adminMfaLimiter, authenticateAdminOrEnrollment, async (req: AdminAuthRequest, res) => {
  try {
    const admin = await prisma.adminUser.findUnique({
      where: { id: req.adminId! },
      select: { id: true, email: true, mfaEnabled: true },
    });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    if (admin.mfaEnabled) return res.status(400).json({ error: 'MFA is already enabled' });

    const otplib = await import('otplib');
    const secret = otplib.generateSecret();

    let plainEmail: string;
    try { plainEmail = decryptSecret(admin.email); } catch { plainEmail = admin.email; }

    const uri = otplib.generateURI({ secret, label: plainEmail, issuer: 'Howl Admin' });

    const QRCode = await import('qrcode');
    const qrCodeDataUrl = await QRCode.toDataURL(uri);

    const setupToken = jwt.sign(
      { adminId: admin.id, totpSecret: encryptSecret(secret), scope: 'admin-mfa-setup' },
      ADMIN_JWT_SECRET,
      { expiresIn: '5m' },
    );

    res.json({ setupToken, uri, qrCodeDataUrl });
  } catch (err) {
    log.error({ err }, 'Admin MFA setup error');
    res.status(500).json({ error: 'MFA setup failed' });
  }
});

// POST /api/admin/auth/mfa/enable
// Accepts admin JWT or enrollment token; see /mfa/setup for rationale.
router.post('/mfa/enable', adminMfaLimiter, authenticateAdminOrEnrollment, validate(adminMfaEnableSchema), async (req: AdminAuthRequest, res) => {
  try {
    const { setupToken, code } = req.body as { setupToken: string; code: string };

    let decoded: { adminId: string; totpSecret: string; scope: string };
    try {
      decoded = jwt.verify(setupToken, ADMIN_JWT_SECRET, { algorithms: ['HS256'] }) as typeof decoded;
    } catch {
      return res.status(400).json({ error: 'Setup expired. Please start again.' });
    }
    if (decoded.scope !== 'admin-mfa-setup' || decoded.adminId !== req.adminId) {
      return res.status(400).json({ error: 'Invalid setup token' });
    }

    const otplib = await import('otplib');
    const secret = decryptSecret(decoded.totpSecret);
    const result = otplib.verifySync({ token: code, secret });
    if (!result.valid) return res.status(400).json({ error: 'Invalid code. Please try again.' });

    await prisma.adminUser.update({
      where: { id: req.adminId! },
      data: { mfaEnabled: true, mfaTotpSecret: decoded.totpSecret },
    });

    log.info({ adminId: req.adminId }, 'Admin MFA enabled');
    res.json({ success: true });
  } catch (err) {
    log.error({ err }, 'Admin MFA enable error');
    res.status(500).json({ error: 'Failed to enable MFA' });
  }
});

// POST /api/admin/auth/mfa/disable
router.post('/mfa/disable', adminMfaLimiter, authenticateAdminToken, validate(adminMfaDisableSchema), async (req: AdminAuthRequest, res) => {
  try {
    const { password, code } = req.body as { password: string; code: string };

    const admin = await prisma.adminUser.findUnique({
      where: { id: req.adminId! },
      select: { id: true, passwordHash: true, mfaTotpSecret: true, mfaEnabled: true },
    });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    if (!admin.mfaEnabled || !admin.mfaTotpSecret) return res.status(400).json({ error: 'MFA is not enabled' });

    const validPw = await bcrypt.compare(password, admin.passwordHash);
    if (!validPw) return res.status(401).json({ error: 'Incorrect password' });

    const otplib = await import('otplib');
    const secret = decryptSecret(admin.mfaTotpSecret);
    const result = otplib.verifySync({ token: code, secret });
    if (!result.valid) return res.status(400).json({ error: 'Invalid TOTP code' });

    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { mfaEnabled: false, mfaTotpSecret: null },
    });

    log.info({ adminId: admin.id }, 'Admin MFA disabled');
    res.json({ success: true });
  } catch (err) {
    log.error({ err }, 'Admin MFA disable error');
    res.status(500).json({ error: 'Failed to disable MFA' });
  }
});

// POST /api/admin/auth/mfa/verify (public — called after login returns mfaRequired)
router.post('/mfa/verify', adminLoginLimiter, validate(adminMfaVerifySchema), async (req, res) => {
  try {
    const { mfaToken, code } = req.body as { mfaToken: string; code: string };

    let decoded: { adminId: string; scope: string };
    try {
      decoded = jwt.verify(mfaToken, ADMIN_JWT_SECRET, { algorithms: ['HS256'] }) as typeof decoded;
    } catch (err: any) {
      if (err?.name === 'TokenExpiredError') return res.status(401).json({ error: 'MFA token expired. Please log in again.' });
      return res.status(401).json({ error: 'Invalid MFA token' });
    }
    if (decoded.scope !== 'admin-mfa-login') return res.status(401).json({ error: 'Invalid MFA token' });

    // Replay-protection check. Mark used only after the code verifies — a wrong
    // TOTP digit shouldn't burn the mfaToken and force a full re-login.
    // Brute force is bounded by adminLoginLimiter. The pre-check below is a
    // best-effort short-circuit; markTokenUsedOnce's atomic SET NX is what
    // actually enforces single-use across replicas.
    const fingerprint = crypto.createHash('sha256').update(mfaToken).digest('hex').slice(0, 32);
    if (await isTokenAlreadyUsed('admin:used-mfa-token', fingerprint)) {
      return res.status(400).json({ error: 'MFA token already used. Please log in again.' });
    }

    const admin = await prisma.adminUser.findUnique({
      where: { id: decoded.adminId },
      select: { id: true, email: true, username: true, role: true, forcePasswordChange: true, mfaTotpSecret: true, mfaEnabled: true },
    });
    if (!admin || !admin.mfaTotpSecret || !admin.mfaEnabled) {
      return res.status(400).json({ error: 'MFA not configured' });
    }

    const otplib = await import('otplib');
    const secret = decryptSecret(admin.mfaTotpSecret);
    const result = otplib.verifySync({ token: code, secret });
    if (!result.valid) return res.status(401).json({ error: 'Invalid verification code' });

    const claimed = await markTokenUsedOnce('admin:used-mfa-token', fingerprint, 600);
    if (!claimed) return res.status(400).json({ error: 'MFA token already used. Please log in again.' });

    // TOTP verified. Instead of issuing the final admin JWT, issue a
    // passkey-login token — the user must still complete the WebAuthn step
    // via /passkey/login/begin + /finish before a session is created.
    const passkeyToken = jwt.sign(
      { adminId: admin.id, scope: 'admin-passkey-login' },
      ADMIN_JWT_SECRET,
      { expiresIn: '5m' },
    );
    log.info({ adminId: admin.id }, 'Admin TOTP verified; passkey required');
    res.json({ passkeyRequired: true, passkeyToken });
  } catch (err) {
    log.error({ err }, 'Admin MFA verify error');
    res.status(500).json({ error: 'MFA verification failed' });
  }
});

export default router;
