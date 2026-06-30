// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { authenticateToken, type AuthRequest, JWT_SECRET } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { mfaCodeSchema, mfaTokenSchema, mfaTokenCodeSchema, phoneSetupSchema, passkeyRegisterSchema, passkeyAuthVerifySchema, passkeyLoginVerifySchema, disableMfaSchema, passkeyEnrollmentReauthSchema } from '../schemas.js';
import { createSession, hashToken, generateRefreshToken } from '../utils/sessionUtils.js';
import { invalidateSessionCacheForUser } from '../middleware/auth.js';
import { encryptSecret, decryptSecret } from '../services/mfaCrypto.js';
import { generateVerificationCode } from '../services/email.js';
import { enqueueEmail } from '../queues/producers.js';
import { logger } from '../logger.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { redis, deleteLoginLockout } from '../redis.js';
import { markTokenUsedOnce, isTokenAlreadyUsed } from '../utils/singleUseToken.js';
import { setRefreshCookie, setDeviceCookie, sensitiveActionLimiter } from './authHelpers.js';
import { issueTrustedDevice } from '../services/trustedDevice.js';
import { ACCESS_TOKEN_EXPIRY, hashCode } from './auth.js';
import { storeSsoCode } from '../utils/ssoCode.js';
import { getEffectivePlan } from '../utils.js';
import { computeBadges } from '../utils/badges.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { cappedMapSet } from '../socketHandlers/infrastructure.js';
import { emitUserSecurityEvent } from '../services/securityEvents.js';

const log = logger.child({ module: 'mfa' });

// In-memory fallback for MFA passkey sessions (Redis preferred). Used-token /
// challenge replay protection is delegated to markTokenUsedOnce — see
// utils/singleUseToken.ts.
const pendingMfaSessions = new Map<string, { mfaToken: string; expiresAt: number }>();

const router = Router();

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
});

const phoneCodeLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:mfa-phone:'),
  windowMs: 5 * 60 * 1000,
  max: 3,
  message: { error: 'Too many code requests. Try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const mfaVerifyLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:mfa-verify:'),
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Too many verification attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const passkeyLoginLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:passkey-login:'),
  windowMs: 60_000,
  max: 20,
  skipSuccessfulRequests: true,
  message: { error: 'Too many passkey login attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const MFA_USER_SELECT = {
  id: true, suspended: true, deactivated: true, username: true, discriminator: true,
  email: true, avatar: true, banner: true, bannerPositionY: true, bannerZoom: true, status: true,
  stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true,
  nameColor: true, nameFont: true, nameEffect: true, avatarEffect: true,
  mfaEnabled: true, badges: true, backgroundImage: true, backgroundOpacity: true,
  backgroundBlur: true, bgGifAlwaysPlay: true, createdAt: true,
} as const;

function buildMfaUserResponse(user: any) {
  let plainEmail: string;
  try { plainEmail = decryptSecret(user.email); } catch { plainEmail = user.email; }
  const currentStatus = user.status === 'offline' ? 'online' : user.status;
  return {
    id: user.id, username: user.username, discriminator: user.discriminator,
    email: plainEmail, avatar: user.avatar, banner: user.banner ?? null,
    bannerPositionY: user.bannerPositionY ?? 50, bannerZoom: user.bannerZoom ?? 100,
    status: currentStatus,
    stripePlan: user.stripePlan, effectivePlan: getEffectivePlan(user),
    nameColor: user.nameColor, nameFont: user.nameFont,
    nameEffect: user.nameEffect, avatarEffect: user.avatarEffect,
    badges: computeBadges(user), mfaEnabled: user.mfaEnabled,
    backgroundImage: user.backgroundImage, backgroundOpacity: user.backgroundOpacity,
    backgroundBlur: user.backgroundBlur, bgGifAlwaysPlay: user.bgGifAlwaysPlay,
  };
}

// TOTP (Authenticator App)

router.post('/totp/setup', sensitiveActionLimiter, authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, email: true, mfaTotpSecret: true, mfaEnabled: true, passwordHash: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.mfaEnabled) {
    const password = typeof req.headers['x-confirm-password'] === 'string'
      ? req.headers['x-confirm-password']
      : (req.body?.password as string | undefined);
    if (!password) return res.status(400).json({ error: 'Password is required to reconfigure MFA' });
    if (!user.passwordHash) return res.status(400).json({ error: 'SSO accounts cannot reconfigure MFA this way' });
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(403).json({ error: 'Incorrect password' });
  }

  const otplib = await import('otplib');
  const QRCode = await import('qrcode');

  const secret = otplib.generateSecret();
  let plainEmail: string;
  try { plainEmail = decryptSecret(user.email); } catch { plainEmail = user.email; }
  const otpauthUrl = otplib.generateURI({ secret, label: plainEmail, issuer: 'Howl' });
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

  // Store in a short-lived JWT instead of writing to DB before verification
  const setupToken = jwt.sign(
    { userId: req.userId, totpSecret: encryptSecret(secret), purpose: 'totp-setup' },
    JWT_SECRET,
    { expiresIn: '10m' }
  );

  res.json({ secret, qrCodeUrl: qrCodeDataUrl, setupToken });
}));

router.post('/totp/enable', sensitiveActionLimiter, authenticateToken, validate(mfaCodeSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { code, setupToken } = req.body as { code?: string; setupToken?: string };
  if (!code) return res.status(400).json({ error: 'Verification code required' });

  let encryptedSecret: string;

  if (setupToken) {
    // New flow: secret comes from JWT setupToken (not persisted to DB yet)
    let decoded: { userId: string; totpSecret: string; purpose: string };
    try {
      decoded = jwt.verify(setupToken, JWT_SECRET, { algorithms: ['HS256'] }) as typeof decoded;
    } catch {
      return res.status(400).json({ error: 'Setup expired. Please start again.' });
    }
    if (decoded.purpose !== 'totp-setup' || decoded.userId !== req.userId) {
      return res.status(400).json({ error: 'Invalid setup token' });
    }
    encryptedSecret = decoded.totpSecret;
  } else {
    // Backwards-compat fallback: read from DB (for in-flight setups started before deploy)
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, mfaTotpSecret: true } });
    if (!user || !user.mfaTotpSecret) return res.status(400).json({ error: 'TOTP not set up. Call /totp/setup first.' });
    encryptedSecret = user.mfaTotpSecret;
  }

  const otplib2 = await import('otplib');
  const secret = decryptSecret(encryptedSecret);
  const result = otplib2.verifySync({ token: code, secret });
  if (!result.valid) return res.status(400).json({ error: 'Invalid code. Please try again.' });

  const authHeader = req.headers['authorization'];
  const currentToken = authHeader?.split(' ')[1];
  const currentHash = currentToken ? hashToken(currentToken) : null;

  await prisma.$transaction([
    prisma.user.update({ where: { id: req.userId }, data: { mfaEnabled: true, mfaTotpSecret: encryptedSecret } }),
    prisma.session.deleteMany({
      where: { userId: req.userId!, ...(currentHash ? { tokenHash: { not: currentHash } } : {}) },
    }),
  ]);
  invalidateSessionCacheForUser(req.userId!);
  // Audit trail for TOTP enable.
  void emitUserSecurityEvent(req.userId!, 'mfa_totp_enabled', req);
  res.json({ success: true, mfaEnabled: true });
}));

router.post('/totp/verify', mfaVerifyLimiter, validate(mfaTokenCodeSchema), async (req, res) => {
  try {
    const { mfaToken, code } = req.body as { mfaToken?: string; code?: string };
    if (!mfaToken || !code) return res.status(400).json({ error: 'mfaToken and code required' });

    const decoded = jwt.verify(mfaToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string; emailHash?: string };
    if (decoded.purpose !== 'mfa') return res.status(401).json({ error: 'Invalid MFA token' });

    // Replay-protection check. We mark the token used only after the code
    // verifies — otherwise a single typo burns the mfaToken and forces a
    // full re-login. Brute force is bounded by mfaVerifyLimiter. The
    // pre-check short-circuits expensive work; markTokenUsedOnce's atomic
    // SET NX is what actually enforces single-use across replicas.
    const mfaTokenFingerprint = crypto.createHash('sha256').update(mfaToken).digest('hex').slice(0, 32);
    if (await isTokenAlreadyUsed('mfa:used-challenge', mfaTokenFingerprint)) {
      return res.status(400).json({ error: 'MFA token already used. Please log in again.' });
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { ...MFA_USER_SELECT, mfaTotpSecret: true } });
    if (!user || !user.mfaTotpSecret) return res.status(400).json({ error: 'TOTP not configured' });
    if (user.suspended) return res.status(403).json({ error: 'Your account has been suspended.' });

    if (user.deactivated) {
      await prisma.user.update({ where: { id: user.id }, data: { deactivated: false, deactivatedAt: null, status: 'online' } });
    }

    const otplib3 = await import('otplib');
    const secret = decryptSecret(user.mfaTotpSecret);
    const result3 = otplib3.verifySync({ token: code, secret });
    if (!result3.valid) return res.status(401).json({ error: 'Invalid verification code' });

    const claimed = await markTokenUsedOnce('mfa:used-challenge', mfaTokenFingerprint, 600);
    if (!claimed) return res.status(400).json({ error: 'MFA token already used. Please log in again.' });

    if (decoded.emailHash) await deleteLoginLockout(`user:${decoded.emailHash}`);
    if (user.status === 'offline') {
      await prisma.user.update({ where: { id: user.id }, data: { status: 'online' } });
    }
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshToken = generateRefreshToken();
    await createSession(user.id, token, req, refreshToken).catch(() => {});
    setRefreshCookie(res, refreshToken, req);

    // Login success via TOTP step-up.
    void emitUserSecurityEvent(user.id, 'login_success', req, { via: 'mfa-totp' });

    res.json({ user: buildMfaUserResponse(user), token });
  } catch (err: any) {
    if (err?.name === 'TokenExpiredError') return res.status(401).json({ error: 'MFA token expired. Please log in again.' });
    res.status(401).json({ error: 'Invalid MFA token' });
  }
});

// PASSKEY (WebAuthn)
const MAX_PASSKEYS = 10;

/**
 * Passkey enrollment re-auth gate.
 *
 * Threat model: a hijacked session (XSS, stolen access token, hostile browser
 * extension, brief unattended session) enrolls an attacker-controlled passkey.
 * Because `/passkey/login-verify` is passwordless and auto-trusts the device,
 * that passkey is a permanent backdoor that survives password change, password
 * reset, and trusted-device revocation. Mirror the `/totp/setup` pattern but
 * require re-auth regardless of current `mfaEnabled` state — the attack works
 * on fresh accounts too.
 *
 * Accepts either:
 *   - `password` in the body OR the `x-confirm-password` header (parity with
 *     `/totp/setup`), validated via bcrypt against `user.passwordHash`.
 *   - `mfaCode` in the body for MFA-enabled SSO-only accounts (no password),
 *     validated against the decrypted TOTP secret.
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, status, error }` on
 * failure. Callers should forward `status`/`error` to the client unchanged.
 */
async function checkPasskeyEnrollmentReauth(
  userId: string,
  body: { password?: string; mfaCode?: string } | undefined,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true, mfaEnabled: true, mfaTotpSecret: true },
  });
  if (!user) return { ok: false, status: 404, error: 'User not found' };

  const headerPassword = typeof headers['x-confirm-password'] === 'string'
    ? (headers['x-confirm-password'] as string)
    : undefined;
  const password = headerPassword || body?.password;
  const mfaCode = body?.mfaCode;

  if (user.passwordHash) {
    if (!password) {
      return { ok: false, status: 400, error: 'Password is required to enroll a passkey' };
    }
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return { ok: false, status: 403, error: 'Incorrect password' };
    return { ok: true };
  }

  // SSO-only account (no password). Fall back to TOTP if MFA is enabled.
  if (user.mfaEnabled && user.mfaTotpSecret) {
    if (!mfaCode) {
      return { ok: false, status: 400, error: 'MFA verification code is required to enroll a passkey' };
    }
    const otplib = await import('otplib');
    const secret = decryptSecret(user.mfaTotpSecret);
    const result = otplib.verifySync({ token: mfaCode, secret });
    if (!result.valid) return { ok: false, status: 401, error: 'Invalid MFA code' };
    return { ok: true };
  }

  // No password installed AND no MFA to fall back on — reject with a clear
  // message directing the user to install a password first via /me/password
  // (which is itself gated by an email/MFA step-up).
  return {
    ok: false,
    status: 400,
    error: 'Install a password first before enrolling a passkey',
  };
}

router.post('/passkey/register-options', sensitiveActionLimiter, authenticateToken, validate(passkeyEnrollmentReauthSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const reauth = await checkPasskeyEnrollmentReauth(req.userId, req.body, req.headers);
  if (!reauth.ok) return res.status(reauth.status).json({ error: reauth.error });

  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, username: true, passkeyCredentials: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.passkeyCredentials.length >= MAX_PASSKEYS) {
    return res.status(400).json({ error: `Maximum of ${MAX_PASSKEYS} passkeys allowed` });
  }

  const { generateRegistrationOptions } = await import('@simplewebauthn/server');
  const options = await generateRegistrationOptions({
    rpName: 'Howl',
    rpID: process.env.WEBAUTHN_RP_ID || 'localhost',
    userName: user.username,
    userDisplayName: user.username,
    attestationType: 'none',
    excludeCredentials: user.passkeyCredentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });

  // Store challenge temporarily in session-like fashion (using a short JWT)
  const challengeToken = jwt.sign({ challenge: options.challenge, userId: req.userId }, JWT_SECRET, { expiresIn: '5m' });
  res.json({ options, challengeToken });
}));

router.post('/passkey/register-verify', sensitiveActionLimiter, authenticateToken, validate(passkeyRegisterSchema), async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { challengeToken, credential, name } = req.body as { challengeToken?: string; credential?: any; name?: string };
  if (!challengeToken || !credential) return res.status(400).json({ error: 'Missing required fields' });

  const reauth = await checkPasskeyEnrollmentReauth(req.userId, req.body, req.headers);
  if (!reauth.ok) return res.status(reauth.status).json({ error: reauth.error });

  try {
    const decoded = jwt.verify(challengeToken, JWT_SECRET, { algorithms: ['HS256'] }) as { challenge: string; userId: string };
    if (decoded.userId !== req.userId) return res.status(401).json({ error: 'User mismatch' });

    // Atomic single-use challenge enforcement (SET NX across replicas).
    const challengeClaimed = await markTokenUsedOnce('mfa:used-challenge', decoded.challenge, 600);
    if (!challengeClaimed) return res.status(400).json({ error: 'Challenge already used' });

    const { verifyRegistrationResponse } = await import('@simplewebauthn/server');
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: decoded.challenge,
      expectedOrigin: process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000',
      expectedRPID: process.env.WEBAUTHN_RP_ID || 'localhost',
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Passkey verification failed' });
    }

    const { credential: regCredential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    const existingCount = await prisma.passkeyCredential.count({ where: { userId: req.userId } });
    if (existingCount >= MAX_PASSKEYS) {
      return res.status(400).json({ error: `Maximum of ${MAX_PASSKEYS} passkeys allowed` });
    }

    await prisma.passkeyCredential.create({
      data: {
        userId: req.userId,
        credentialId: regCredential.id,
        publicKey: Buffer.from(regCredential.publicKey).toString('base64'),
        counter: regCredential.counter,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        transports: credential.response?.transports ? JSON.stringify(credential.response.transports) : null,
        name: name || 'My Passkey',
      },
    });

    const authHeader = req.headers['authorization'];
    const currentToken = authHeader?.split(' ')[1];
    const currentHash = currentToken ? hashToken(currentToken) : null;

    await prisma.$transaction([
      prisma.user.update({ where: { id: req.userId }, data: { mfaEnabled: true } }),
      prisma.session.deleteMany({
        where: { userId: req.userId!, ...(currentHash ? { tokenHash: { not: currentHash } } : {}) },
      }),
    ]);
    invalidateSessionCacheForUser(req.userId!);
    // Audit trail for passkey enrollment.
    void emitUserSecurityEvent(req.userId!, 'passkey_added', req, { via: 'register-verify' });
    res.json({ success: true, mfaEnabled: true });
  } catch (err: any) {
    log.error({ err }, 'Passkey register error');
    res.status(400).json({ error: 'Passkey registration failed' });
  }
});

router.post('/passkey/auth-options', mfaVerifyLimiter, validate(mfaTokenSchema), async (req, res) => {
  try {
    const { mfaToken } = req.body as { mfaToken?: string };
    if (!mfaToken) return res.status(400).json({ error: 'mfaToken required' });

    const decoded = jwt.verify(mfaToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string; emailHash?: string };
    if (decoded.purpose !== 'mfa') return res.status(401).json({ error: 'Invalid MFA token' });

    const credentials = await prisma.passkeyCredential.findMany({ where: { userId: decoded.userId }, take: 20 });
    const { generateAuthenticationOptions } = await import('@simplewebauthn/server');

    const options = await generateAuthenticationOptions({
      rpID: process.env.WEBAUTHN_RP_ID || 'localhost',
      allowCredentials: credentials.map((c) => ({
        id: c.credentialId,
      })),
      userVerification: 'preferred',
    });

    const challengeToken = jwt.sign({ challenge: options.challenge, userId: decoded.userId, emailHash: decoded.emailHash }, JWT_SECRET, { expiresIn: '5m' });
    res.json({ options, challengeToken });
  } catch (err: any) {
    if (err?.name === 'TokenExpiredError') return res.status(401).json({ error: 'MFA token expired' });
    res.status(401).json({ error: 'Invalid MFA token' });
  }
});

router.post('/passkey/auth-verify', mfaVerifyLimiter, validate(passkeyAuthVerifySchema), async (req, res) => {
  try {
    const { challengeToken, credential } = req.body as { challengeToken?: string; credential?: any };
    if (!challengeToken || !credential) return res.status(400).json({ error: 'Missing required fields' });

    const decoded = jwt.verify(challengeToken, JWT_SECRET, { algorithms: ['HS256'] }) as { challenge: string; userId: string; emailHash?: string };

    // Atomic single-use challenge enforcement (SET NX across replicas).
    const challengeClaimed = await markTokenUsedOnce('mfa:used-challenge', decoded.challenge, 600);
    if (!challengeClaimed) return res.status(400).json({ error: 'Challenge already used' });

    const stored = await prisma.passkeyCredential.findUnique({ where: { credentialId: credential.id } });
    if (!stored || stored.userId !== decoded.userId) return res.status(401).json({ error: 'Unknown passkey' });

    const { verifyAuthenticationResponse } = await import('@simplewebauthn/server');
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: decoded.challenge,
      expectedOrigin: process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000',
      expectedRPID: process.env.WEBAUTHN_RP_ID || 'localhost',
      credential: {
        id: stored.credentialId,
        publicKey: Buffer.from(stored.publicKey, 'base64'),
        counter: stored.counter,
        transports: stored.transports ? JSON.parse(stored.transports) : undefined,
      },
    });

    if (!verification.verified) return res.status(401).json({ error: 'Passkey verification failed' });

    await prisma.passkeyCredential.update({ where: { id: stored.id }, data: { counter: verification.authenticationInfo.newCounter } });

    const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: MFA_USER_SELECT });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.suspended) return res.status(403).json({ error: 'Your account has been suspended.' });

    if (user.deactivated) {
      await prisma.user.update({ where: { id: user.id }, data: { deactivated: false, deactivatedAt: null, status: 'online' } });
    }

    if (decoded.emailHash) await deleteLoginLockout(`user:${decoded.emailHash}`);
    if (user.status === 'offline') {
      await prisma.user.update({ where: { id: user.id }, data: { status: 'online' } });
    }
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshToken = generateRefreshToken();
    await createSession(user.id, token, req, refreshToken).catch(() => {});
    setRefreshCookie(res, refreshToken, req);

    // Login success via passkey step-up.
    void emitUserSecurityEvent(user.id, 'login_success', req, { via: 'mfa-passkey' });

    res.json({ user: buildMfaUserResponse(user), token });
  } catch (err: any) {
    log.error({ err }, 'Passkey auth error');
    if (err?.name === 'TokenExpiredError') return res.status(401).json({ error: 'Challenge expired' });
    res.status(401).json({ error: 'Passkey authentication failed' });
  }
});

// MFA SESSION (opaque Redis token for browser passkey hop)

router.post('/passkey/create-mfa-session', mfaVerifyLimiter, asyncHandler(async (req, res) => {
  const { mfaToken } = req.body as { mfaToken?: string };
  if (!mfaToken || typeof mfaToken !== 'string') return res.status(400).json({ error: 'Missing mfaToken' });

  try {
    jwt.verify(mfaToken, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(400).json({ error: 'Invalid mfaToken' });
  }

  const sessionId = crypto.randomBytes(32).toString('base64url');
  if (redis) {
    await redis.set(`mfa-session:${sessionId}`, mfaToken, 'EX', 300);
  } else {
    cappedMapSet(pendingMfaSessions, sessionId, { mfaToken, expiresAt: Date.now() + 300_000 }, 100);
  }
  res.json({ sessionId });
}));

router.post('/passkey/consume-mfa-session', mfaVerifyLimiter, asyncHandler(async (req, res) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) return res.status(400).json({ error: 'Missing sessionId' });

  let mfaToken: string | null = null;
  if (redis) {
    mfaToken = await redis.get(`mfa-session:${sessionId}`);
    if (mfaToken) await redis.del(`mfa-session:${sessionId}`);
  } else {
    const entry = pendingMfaSessions.get(sessionId);
    pendingMfaSessions.delete(sessionId);
    if (entry && Date.now() < entry.expiresAt) mfaToken = entry.mfaToken;
  }

  if (!mfaToken) return res.status(400).json({ error: 'Invalid or expired session' });
  res.json({ mfaToken });
}));

// PASSKEY MFA AUTH-VERIFY-FOR-CODE (browser SSO flow)

router.post('/passkey/auth-verify-for-code', mfaVerifyLimiter, validate(passkeyAuthVerifySchema), async (req, res) => {
  try {
    const { challengeToken, credential } = req.body as { challengeToken?: string; credential?: any };
    if (!challengeToken || !credential) return res.status(400).json({ error: 'Missing required fields' });

    const decoded = jwt.verify(challengeToken, JWT_SECRET, { algorithms: ['HS256'] }) as { challenge: string; userId: string; emailHash?: string };

    // Atomic single-use challenge enforcement (SET NX across replicas).
    const challengeClaimed = await markTokenUsedOnce('mfa:used-challenge', decoded.challenge, 600);
    if (!challengeClaimed) return res.status(400).json({ error: 'Challenge already used' });

    const stored = await prisma.passkeyCredential.findUnique({ where: { credentialId: credential.id } });
    if (!stored || stored.userId !== decoded.userId) return res.status(401).json({ error: 'Unknown passkey' });

    const { verifyAuthenticationResponse } = await import('@simplewebauthn/server');
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: decoded.challenge,
      expectedOrigin: process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000',
      expectedRPID: process.env.WEBAUTHN_RP_ID || 'localhost',
      credential: {
        id: stored.credentialId,
        publicKey: Buffer.from(stored.publicKey, 'base64'),
        counter: stored.counter,
        transports: stored.transports ? JSON.parse(stored.transports) : undefined,
      },
    });

    if (!verification.verified) return res.status(401).json({ error: 'Passkey verification failed' });

    await prisma.passkeyCredential.update({ where: { id: stored.id }, data: { counter: verification.authenticationInfo.newCounter } });

    const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { id: true, suspended: true, deactivated: true, status: true } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.suspended) return res.status(403).json({ error: 'Your account has been suspended.' });

    if (user.deactivated) {
      await prisma.user.update({ where: { id: user.id }, data: { deactivated: false, deactivatedAt: null, status: 'online' } });
    }

    if (decoded.emailHash) await deleteLoginLockout(`user:${decoded.emailHash}`);
    if (user.status === 'offline') {
      await prisma.user.update({ where: { id: user.id }, data: { status: 'online' } });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshToken = generateRefreshToken();
    await createSession(user.id, token, req, refreshToken).catch(() => {});

    // Session is minted here; /exchange-code later just hands the
    // already-created token to the browser. Emit now so the audit entry
    // lands at the actual auth moment.
    void emitUserSecurityEvent(user.id, 'login_success', req, { via: 'mfa-passkey-browser' });

    const ssoCode = await storeSsoCode({ kind: 'session', token, refreshToken });
    res.json({ code: ssoCode });
  } catch (err: any) {
    log.error({ err }, 'Passkey auth-verify-for-code error');
    if (err?.name === 'TokenExpiredError') return res.status(401).json({ error: 'Challenge expired' });
    res.status(401).json({ error: 'Passkey authentication failed' });
  }
});

// PASSWORDLESS PASSKEY LOGIN

router.post('/passkey/login-options', passkeyLoginLimiter, asyncHandler(async (_req: AuthRequest, res: Response) => {
  const { generateAuthenticationOptions } = await import('@simplewebauthn/server');
  const options = await generateAuthenticationOptions({
    rpID: process.env.WEBAUTHN_RP_ID || 'localhost',
    userVerification: 'preferred',
  });
  const challengeToken = jwt.sign({ challenge: options.challenge, purpose: 'passkey-login' }, JWT_SECRET, { expiresIn: '5m' });
  res.json({ options, challengeToken });
}));

router.post('/passkey/login-verify', passkeyLoginLimiter, validate(passkeyLoginVerifySchema), async (req, res) => {
  try {
    const { challengeToken, credential } = req.body as { challengeToken?: string; credential?: any };
    if (!challengeToken || !credential) return res.status(400).json({ error: 'Missing required fields' });

    const decoded = jwt.verify(challengeToken, JWT_SECRET, { algorithms: ['HS256'] }) as { challenge: string; purpose?: string };
    if (decoded.purpose !== 'passkey-login') return res.status(401).json({ error: 'Invalid challenge token' });

    // Atomic single-use challenge enforcement (SET NX across replicas).
    const challengeClaimed = await markTokenUsedOnce('mfa:used-challenge', decoded.challenge, 600);
    if (!challengeClaimed) return res.status(400).json({ error: 'Challenge already used' });

    // Discover user from credential (no userId in token — this is passwordless)
    const stored = await prisma.passkeyCredential.findUnique({ where: { credentialId: credential.id } });
    if (!stored) return res.status(401).json({ error: 'Unknown passkey' });

    const { verifyAuthenticationResponse } = await import('@simplewebauthn/server');
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: decoded.challenge,
      expectedOrigin: process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000',
      expectedRPID: process.env.WEBAUTHN_RP_ID || 'localhost',
      credential: {
        id: stored.credentialId,
        publicKey: Buffer.from(stored.publicKey, 'base64'),
        counter: stored.counter,
        transports: stored.transports ? JSON.parse(stored.transports) : undefined,
      },
    });

    if (!verification.verified) return res.status(401).json({ error: 'Unknown passkey' });

    await prisma.passkeyCredential.update({ where: { id: stored.id }, data: { counter: verification.authenticationInfo.newCounter } });

    const user = await prisma.user.findUnique({ where: { id: stored.userId }, select: MFA_USER_SELECT });
    if (!user) return res.status(401).json({ error: 'Unknown passkey' });
    if (user.suspended) return res.status(403).json({ error: 'Your account has been suspended.' });

    if (user.deactivated) {
      await prisma.user.update({ where: { id: user.id }, data: { deactivated: false, deactivatedAt: null, status: 'online' } });
    }

    if (user.status === 'offline') {
      await prisma.user.update({ where: { id: user.id }, data: { status: 'online' } });
    }
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshToken = generateRefreshToken();

    // Passwordless passkey login is a cryptographic proof at least as
    // strong as SSO. Auto-trust the device so if the user later adds a
    // password, they aren't email-challenged on the very browser they
    // just passkey'd from. Mirrors the SSO auto-trust block in sso.ts.
    const ua = (req.headers['user-agent'] ?? 'Unknown') as string;
    const rawIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip ?? null;
    let trustedDeviceId: string | null = null;
    try {
      const { device, rawCookieToken } = await issueTrustedDevice(user.id, ua, rawIp);
      trustedDeviceId = device.id;
      setDeviceCookie(res, rawCookieToken, req);
    } catch (trustErr) {
      log.warn({ err: trustErr, userId: user.id }, 'passkey auto-trust failed');
    }

    await createSession(user.id, token, req, refreshToken, trustedDeviceId).catch(() => {});
    setRefreshCookie(res, refreshToken, req);

    // Passwordless passkey login. Device was auto-trusted on success so
    // emit login_new_device only when the trust actually landed.
    void emitUserSecurityEvent(user.id, 'login_success', req, { via: 'passkey-passwordless' });
    if (trustedDeviceId) {
      void emitUserSecurityEvent(user.id, 'login_new_device', req, { via: 'passkey-passwordless' });
    }

    res.json({ user: buildMfaUserResponse(user), token });
  } catch (err: any) {
    log.error({ err }, 'Passkey login error');
    if (err?.name === 'TokenExpiredError') return res.status(401).json({ error: 'Challenge expired' });
    res.status(401).json({ error: 'Passkey authentication failed' });
  }
});

// PASSKEY LOGIN-FOR-CODE (browser SSO flow)

router.post('/passkey/login-for-code', passkeyLoginLimiter, validate(passkeyLoginVerifySchema), async (req, res) => {
  try {
    const { challengeToken, credential } = req.body as { challengeToken?: string; credential?: any };
    if (!challengeToken || !credential) return res.status(400).json({ error: 'Missing required fields' });

    const decoded = jwt.verify(challengeToken, JWT_SECRET, { algorithms: ['HS256'] }) as { challenge: string; purpose?: string };
    if (decoded.purpose !== 'passkey-login') return res.status(401).json({ error: 'Invalid challenge token' });

    // Atomic single-use challenge enforcement (SET NX across replicas).
    const challengeClaimed = await markTokenUsedOnce('mfa:used-challenge', decoded.challenge, 600);
    if (!challengeClaimed) return res.status(400).json({ error: 'Challenge already used' });

    const stored = await prisma.passkeyCredential.findUnique({ where: { credentialId: credential.id } });
    if (!stored) return res.status(401).json({ error: 'Unknown passkey' });

    const { verifyAuthenticationResponse } = await import('@simplewebauthn/server');
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: decoded.challenge,
      expectedOrigin: process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000',
      expectedRPID: process.env.WEBAUTHN_RP_ID || 'localhost',
      credential: {
        id: stored.credentialId,
        publicKey: Buffer.from(stored.publicKey, 'base64'),
        counter: stored.counter,
        transports: stored.transports ? JSON.parse(stored.transports) : undefined,
      },
    });

    if (!verification.verified) return res.status(401).json({ error: 'Passkey authentication failed' });

    await prisma.passkeyCredential.update({ where: { id: stored.id }, data: { counter: verification.authenticationInfo.newCounter } });

    const user = await prisma.user.findUnique({ where: { id: stored.userId }, select: { id: true, suspended: true, deactivated: true, status: true } });
    if (!user) return res.status(401).json({ error: 'Unknown passkey' });
    if (user.suspended) return res.status(403).json({ error: 'Your account has been suspended.' });

    if (user.deactivated) {
      await prisma.user.update({ where: { id: user.id }, data: { deactivated: false, deactivatedAt: null, status: 'online' } });
    }
    if (user.status === 'offline') {
      await prisma.user.update({ where: { id: user.id }, data: { status: 'online' } });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshToken = generateRefreshToken();

    // Auto-trust the device — piped through storeSsoCode → /sso/exchange-code
    // which calls setDeviceCookie on the consuming response. Same mechanism
    // the Google/Apple/Steam SSO flows use for their deep-link handshake.
    const ua = (req.headers['user-agent'] ?? 'Unknown') as string;
    const rawIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip ?? null;
    let trustedDeviceId: string | null = null;
    let deviceToken: string | undefined;
    try {
      const { device, rawCookieToken } = await issueTrustedDevice(user.id, ua, rawIp);
      trustedDeviceId = device.id;
      deviceToken = rawCookieToken;
    } catch (trustErr) {
      log.warn({ err: trustErr, userId: user.id }, 'passkey-for-code auto-trust failed');
    }

    await createSession(user.id, token, req, refreshToken, trustedDeviceId).catch(() => {});

    // Passwordless passkey login via browser/SSO handoff. Auto-trust landed
    // above → emit login_new_device when the device record was actually issued.
    void emitUserSecurityEvent(user.id, 'login_success', req, { via: 'passkey-passwordless-browser' });
    if (trustedDeviceId) {
      void emitUserSecurityEvent(user.id, 'login_new_device', req, { via: 'passkey-passwordless-browser' });
    }

    const ssoCode = await storeSsoCode({ kind: 'session', token, refreshToken, deviceToken });
    res.json({ code: ssoCode });
  } catch (err: any) {
    log.error({ err }, 'Passkey login-for-code error');
    if (err?.name === 'TokenExpiredError') return res.status(401).json({ error: 'Challenge expired' });
    res.status(401).json({ error: 'Passkey authentication failed' });
  }
});

// PASSKEY REGISTER-SESSION (authenticated, for browser flow)

router.post('/passkey/register-session', sensitiveActionLimiter, authenticateToken, validate(passkeyEnrollmentReauthSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  // Gate re-auth at the entry point of the browser flow. The issued sessionToken
  // has a 5-minute TTL and is verified by /browser-register-options and
  // /browser-register-verify (which run without authenticateToken). Because the
  // sessionToken can only be minted after this re-auth check passes, the
  // browser-* flows are transitively gated and need no additional re-auth
  // check of their own.
  const reauth = await checkPasskeyEnrollmentReauth(req.userId, req.body, req.headers);
  if (!reauth.ok) return res.status(reauth.status).json({ error: reauth.error });

  const sessionToken = jwt.sign(
    { userId: req.userId, purpose: 'passkey-register' },
    JWT_SECRET,
    { expiresIn: '5m' }
  );
  res.json({ sessionToken });
}));

// PASSKEY BROWSER-REGISTER-OPTIONS (sessionToken auth)
// Re-auth is proven by holding a `passkey-register` sessionToken, which can
// only be minted by the gated /passkey/register-session route (5 min TTL).
// No additional re-auth check needed here.

router.post('/passkey/browser-register-options', sensitiveActionLimiter, asyncHandler(async (req, res) => {
  const { sessionToken } = req.body as { sessionToken?: string };
  if (!sessionToken) return res.status(400).json({ error: 'Missing session token' });

  let userId: string;
  try {
    const decoded = jwt.verify(sessionToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
    if (decoded.purpose !== 'passkey-register') throw new Error('Invalid purpose');
    userId = decoded.userId;
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, passkeyCredentials: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.passkeyCredentials.length >= MAX_PASSKEYS) {
    return res.status(400).json({ error: `Maximum of ${MAX_PASSKEYS} passkeys allowed` });
  }

  const { generateRegistrationOptions } = await import('@simplewebauthn/server');
  const options = await generateRegistrationOptions({
    rpName: 'Howl',
    rpID: process.env.WEBAUTHN_RP_ID || 'localhost',
    userName: user.username,
    userDisplayName: user.username,
    attestationType: 'none',
    excludeCredentials: user.passkeyCredentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });

  const challengeToken = jwt.sign({ challenge: options.challenge, userId }, JWT_SECRET, { expiresIn: '5m' });
  res.json({ options, challengeToken });
}));

// PASSKEY BROWSER-REGISTER-VERIFY (sessionToken auth)
// Same re-auth design as /browser-register-options — the sessionToken proves
// fresh password/TOTP re-auth via /register-session.

router.post('/passkey/browser-register-verify', sensitiveActionLimiter, asyncHandler(async (req, res) => {
  const { sessionToken, challengeToken, credential, name } = req.body as {
    sessionToken?: string; challengeToken?: string; credential?: any; name?: string;
  };
  if (!sessionToken || !challengeToken || !credential) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  let userId: string;
  try {
    const decoded = jwt.verify(sessionToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
    if (decoded.purpose !== 'passkey-register') throw new Error('Invalid purpose');
    userId = decoded.userId;
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  try {
    const decoded = jwt.verify(challengeToken, JWT_SECRET, { algorithms: ['HS256'] }) as { challenge: string; userId: string };
    if (decoded.userId !== userId) return res.status(401).json({ error: 'User mismatch' });

    // Atomic single-use challenge enforcement (SET NX across replicas).
    const challengeClaimed = await markTokenUsedOnce('mfa:used-challenge', decoded.challenge, 600);
    if (!challengeClaimed) return res.status(400).json({ error: 'Challenge already used' });

    const { verifyRegistrationResponse } = await import('@simplewebauthn/server');
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: decoded.challenge,
      expectedOrigin: process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000',
      expectedRPID: process.env.WEBAUTHN_RP_ID || 'localhost',
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Passkey verification failed' });
    }

    const { credential: regCredential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    const existingCount = await prisma.passkeyCredential.count({ where: { userId } });
    if (existingCount >= MAX_PASSKEYS) {
      return res.status(400).json({ error: `Maximum of ${MAX_PASSKEYS} passkeys allowed` });
    }

    await prisma.passkeyCredential.create({
      data: {
        userId,
        credentialId: regCredential.id,
        publicKey: Buffer.from(regCredential.publicKey).toString('base64'),
        counter: regCredential.counter,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        transports: credential.response?.transports ? JSON.stringify(credential.response.transports) : null,
        name: (typeof name === 'string' ? name.trim().slice(0, 100) : '') || 'My Passkey',
      },
    });

    // Enable MFA if not already (same as register-verify)
    await prisma.user.update({ where: { id: userId }, data: { mfaEnabled: true } });

    // Audit trail for passkey enrollment.
    void emitUserSecurityEvent(userId, 'passkey_added', req, { via: 'browser-register-verify' });

    res.json({ success: true });
  } catch (err: any) {
    log.error({ err }, 'Browser passkey register error');
    if (err?.name === 'TokenExpiredError') return res.status(401).json({ error: 'Challenge expired' });
    res.status(400).json({ error: 'Passkey registration failed' });
  }
}));

// PASSKEY DELETE

router.delete('/passkey/:passkeyId', sensitiveActionLimiter, authenticateToken, validate(disableMfaSchema), validateUuidParams('passkeyId'), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const { password } = req.body as { password?: string };
  if (!password) return res.status(400).json({ error: 'Password required' });

  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, passwordHash: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.passwordHash) return res.status(400).json({ error: 'Set a password first to manage MFA methods' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Incorrect password' });

  const passkey = await prisma.passkeyCredential.findUnique({
    where: { id: req.params.passkeyId as string },
    select: { id: true, userId: true },
  });

  if (!passkey || passkey.userId !== req.userId) {
    return res.status(404).json({ error: 'Passkey not found' });
  }

  await prisma.passkeyCredential.delete({ where: { id: passkey.id } });

  // If this was the last passkey and no other MFA methods exist, disable MFA
  const remaining = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { mfaTotpSecret: true, mfaPhoneVerified: true, _count: { select: { passkeyCredentials: true } } },
  });

  if (remaining && !remaining.mfaTotpSecret && !remaining.mfaPhoneVerified && remaining._count.passkeyCredentials === 0) {
    await prisma.user.update({ where: { id: req.userId }, data: { mfaEnabled: false } });
  }

  // Audit trail for passkey removal. Passkey IDs are not secrets
  // (/status already lists them) so including the id is safe.
  void emitUserSecurityEvent(req.userId, 'passkey_removed', req, { passkeyId: passkey.id });

  res.json({ success: true });
}));

// TOTP DISABLE

router.post('/totp/disable', sensitiveActionLimiter, authenticateToken, validate(disableMfaSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { password } = req.body as { password?: string };
  if (!password) return res.status(400).json({ error: 'Password required' });

  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, passwordHash: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.passwordHash) return res.status(400).json({ error: 'Set a password first to manage MFA methods' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Incorrect password' });

  await prisma.user.update({ where: { id: req.userId }, data: { mfaTotpSecret: null } });

  // Audit trail for TOTP disable.
  void emitUserSecurityEvent(req.userId, 'mfa_totp_disabled', req);

  const remaining = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { mfaPhoneVerified: true, _count: { select: { passkeyCredentials: true } } },
  });
  if (remaining && !remaining.mfaPhoneVerified && remaining._count.passkeyCredentials === 0) {
    await prisma.user.update({ where: { id: req.userId }, data: { mfaEnabled: false } });
  }

  res.json({ success: true });
}));

// Guard: reject phone MFA routes unless an SMS provider is configured. Remove this guard once Twilio (or similar) is wired up.
const requireSmsProvider = (_req: any, res: any, next: any) => {
  if (!process.env.SMS_PROVIDER_CONFIGURED) return res.status(501).json({ error: 'SMS MFA is not yet available.' });
  next();
};

// PHONE DISABLE

router.post('/phone/disable', requireSmsProvider, sensitiveActionLimiter, authenticateToken, validate(disableMfaSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { password } = req.body as { password?: string };
  if (!password) return res.status(400).json({ error: 'Password required' });

  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, passwordHash: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.passwordHash) return res.status(400).json({ error: 'Set a password first to manage MFA methods' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Incorrect password' });

  await prisma.user.update({ where: { id: req.userId }, data: { mfaPhone: null, mfaPhoneVerified: false } });

  const remaining = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { mfaTotpSecret: true, _count: { select: { passkeyCredentials: true } } },
  });
  if (remaining && !remaining.mfaTotpSecret && remaining._count.passkeyCredentials === 0) {
    await prisma.user.update({ where: { id: req.userId }, data: { mfaEnabled: false } });
  }

  res.json({ success: true });
}));

// PHONE SMS

const SMS_CODE_TTL_S = 5 * 60; // 5 minutes
const MAX_SMS_CODES = 10_000;
// In-memory fallback for dev (single instance). Redis is used in production.
const smsCodesMem = new Map<string, { code: string; expires: number }>();

async function setSmsCode(key: string, code: string): Promise<void> {
  const hashed = hashCode(code);
  if (redis) {
    await redis.setex(`sms:${key}`, SMS_CODE_TTL_S, hashed);
  } else {
    if (smsCodesMem.size >= MAX_SMS_CODES) {
      const oldest = smsCodesMem.keys().next().value;
      if (oldest !== undefined) smsCodesMem.delete(oldest);
    }
    smsCodesMem.set(key, { code: hashed, expires: Date.now() + SMS_CODE_TTL_S * 1000 });
  }
}

async function getSmsCode(key: string): Promise<string | null> {
  if (redis) {
    return await redis.get(`sms:${key}`);
  }
  const entry = smsCodesMem.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { smsCodesMem.delete(key); return null; }
  return entry.code;
}

async function deleteSmsCode(key: string): Promise<void> {
  if (redis) {
    await redis.del(`sms:${key}`);
  } else {
    smsCodesMem.delete(key);
  }
}

router.post('/phone/setup', requireSmsProvider, phoneCodeLimiter, authenticateToken, validate(phoneSetupSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { phoneNumber } = req.body as { phoneNumber?: string };
  if (!phoneNumber || !/^\+\d{10,15}$/.test(phoneNumber)) {
    return res.status(400).json({ error: 'Valid phone number in E.164 format required (e.g. +15551234567)' });
  }

  const code = generateVerificationCode();
  await setSmsCode(`setup:${req.userId}`, code);
  await prisma.user.update({ where: { id: req.userId }, data: { mfaPhone: encryptSecret(phoneNumber), mfaPhoneVerified: false } });
  enqueueEmail({ type: 'mfaSms', phone: phoneNumber, code }).catch((e) => log.error({ err: e }, 'SMS enqueue error'));

  res.json({ success: true });
}));

router.post('/phone/verify-setup', requireSmsProvider, phoneCodeLimiter, authenticateToken, validate(mfaCodeSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { code } = req.body as { code?: string };
  if (!code) return res.status(400).json({ error: 'Verification code required' });

  const storedHash = await getSmsCode(`setup:${req.userId}`);
  if (!storedHash) return res.status(400).json({ error: 'Invalid code' });
  const inputHash = hashCode(String(code).trim());
  try {
    if (!crypto.timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(inputHash, 'hex'))) {
      return res.status(400).json({ error: 'Invalid code' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid code' });
  }

  await deleteSmsCode(`setup:${req.userId}`);

  const authHeader = req.headers['authorization'];
  const currentToken = authHeader?.split(' ')[1];
  const currentHash = currentToken ? hashToken(currentToken) : null;

  await prisma.$transaction([
    prisma.user.update({ where: { id: req.userId }, data: { mfaPhoneVerified: true, mfaEnabled: true } }),
    prisma.session.deleteMany({
      where: { userId: req.userId!, ...(currentHash ? { tokenHash: { not: currentHash } } : {}) },
    }),
  ]);
  invalidateSessionCacheForUser(req.userId!);
  res.json({ success: true, mfaEnabled: true });
}));

router.post('/phone/send', requireSmsProvider, phoneCodeLimiter, validate(mfaTokenSchema), async (req, res) => {
  try {
    const { mfaToken } = req.body as { mfaToken?: string };
    if (!mfaToken) return res.status(400).json({ error: 'mfaToken required' });

    const decoded = jwt.verify(mfaToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string };
    if (decoded.purpose !== 'mfa') return res.status(401).json({ error: 'Invalid MFA token' });

    const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { id: true, mfaPhone: true, mfaPhoneVerified: true } });
    if (!user || !user.mfaPhone || !user.mfaPhoneVerified) return res.status(400).json({ error: 'Phone MFA not set up' });

    const phone = decryptSecret(user.mfaPhone);
    const code = generateVerificationCode();
    await setSmsCode(`mfa:${user.id}`, code);
    enqueueEmail({ type: 'mfaSms', phone, code }).catch((e) => log.error({ err: e }, 'SMS enqueue error'));

    res.json({ success: true });
  } catch (err: any) {
    if (err?.name === 'TokenExpiredError') return res.status(401).json({ error: 'MFA token expired' });
    res.status(401).json({ error: 'Invalid MFA token' });
  }
});

router.post('/phone/verify', requireSmsProvider, mfaVerifyLimiter, validate(mfaTokenCodeSchema), async (req, res) => {
  try {
    const { mfaToken, code } = req.body as { mfaToken?: string; code?: string };
    if (!mfaToken || !code) return res.status(400).json({ error: 'mfaToken and code required' });

    const decoded = jwt.verify(mfaToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string; emailHash?: string };
    if (decoded.purpose !== 'mfa') return res.status(401).json({ error: 'Invalid MFA token' });

    // Replay-protection check. Mark used only after the code verifies — see /totp/verify.
    const mfaTokenFingerprint = crypto.createHash('sha256').update(mfaToken).digest('hex').slice(0, 32);
    if (await isTokenAlreadyUsed('mfa:used-challenge', mfaTokenFingerprint)) {
      return res.status(400).json({ error: 'MFA token already used. Please log in again.' });
    }

    const storedHash = await getSmsCode(`mfa:${decoded.userId}`);
    if (!storedHash) return res.status(400).json({ error: 'Invalid code' });
    const inputHash = hashCode(String(code).trim());
    try {
      if (!crypto.timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(inputHash, 'hex'))) {
        return res.status(400).json({ error: 'Invalid code' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid code' });
    }

    const claimed = await markTokenUsedOnce('mfa:used-challenge', mfaTokenFingerprint, 600);
    if (!claimed) return res.status(400).json({ error: 'MFA token already used. Please log in again.' });

    await deleteSmsCode(`mfa:${decoded.userId}`);

    const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: MFA_USER_SELECT });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.suspended) return res.status(403).json({ error: 'Your account has been suspended.' });

    if (user.deactivated) {
      await prisma.user.update({ where: { id: user.id }, data: { deactivated: false, deactivatedAt: null, status: 'online' } });
    }

    if (decoded.emailHash) await deleteLoginLockout(`user:${decoded.emailHash}`);
    if (user.status === 'offline') {
      await prisma.user.update({ where: { id: user.id }, data: { status: 'online' } });
    }
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshToken = generateRefreshToken();
    await createSession(user.id, token, req, refreshToken).catch(() => {});
    setRefreshCookie(res, refreshToken, req);

    res.json({ user: buildMfaUserResponse(user), token });
  } catch (err: any) {
    if (err?.name === 'TokenExpiredError') return res.status(401).json({ error: 'MFA token expired' });
    res.status(401).json({ error: 'Invalid MFA token' });
  }
});

// DISABLE MFA

router.post('/disable', sensitiveActionLimiter, authenticateToken, validate(disableMfaSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { password } = req.body as { password?: string };
  if (!password) return res.status(400).json({ error: 'Password required' });

  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, passwordHash: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.passwordHash) return res.status(400).json({ error: 'SSO accounts cannot disable MFA this way' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Incorrect password' });

  const authHeader = req.headers['authorization'];
  const currentToken = authHeader?.split(' ')[1];
  const currentHash = currentToken ? hashToken(currentToken) : null;

  await prisma.passkeyCredential.deleteMany({ where: { userId: req.userId } });
  await prisma.$transaction([
    prisma.user.update({
      where: { id: req.userId },
      data: { mfaEnabled: false, mfaTotpSecret: null, mfaPhone: null, mfaPhoneVerified: false, mfaRecoveryCodes: Prisma.JsonNull },
    }),
    prisma.session.deleteMany({
      where: { userId: req.userId!, ...(currentHash ? { tokenHash: { not: currentHash } } : {}) },
    }),
  ]);
  invalidateSessionCacheForUser(req.userId!);
  // Audit trail for the full MFA-nuke path (one row per removed factor
  // so the user's feed shows what disappeared).
  void emitUserSecurityEvent(req.userId!, 'mfa_totp_disabled', req, { via: 'disable-all' });
  void emitUserSecurityEvent(req.userId!, 'passkey_removed', req, { via: 'disable-all' });
  res.json({ success: true, mfaEnabled: false });
}));

// GET MFA STATUS

router.get('/status', authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const user = await prisma.user.findUnique({ where: { id: req.userId }, include: { passkeyCredentials: { select: { id: true, name: true, createdAt: true } } } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const recoveryCodes = user.mfaRecoveryCodes as { hash: string; used: boolean }[] | null;
  const hasRecoveryCodes = Array.isArray(recoveryCodes) && recoveryCodes.some((c) => !c.used);

  res.json({
    mfaEnabled: user.mfaEnabled,
    totpConfigured: !!user.mfaTotpSecret,
    phoneConfigured: user.mfaPhoneVerified && !!user.mfaPhone,
    phoneLast4: user.mfaPhone ? decryptSecret(user.mfaPhone).slice(-4) : null,
    passkeys: user.passkeyCredentials,
    hasRecoveryCodes,
    hasPassword: !!user.passwordHash,
  });
}));

// Recovery Codes

function generateRecoveryCode(): string {
  return crypto.randomBytes(8).toString('hex');
}

router.post('/recovery-codes/generate', sensitiveActionLimiter, authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, mfaEnabled: true, passwordHash: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.mfaEnabled) return res.status(400).json({ error: 'MFA must be enabled to generate recovery codes' });

  const password = typeof req.headers['x-confirm-password'] === 'string'
    ? req.headers['x-confirm-password']
    : (req.body?.password as string | undefined);
  if (!password) return res.status(400).json({ error: 'Password is required to regenerate recovery codes' });
  if (!user.passwordHash) return res.status(400).json({ error: 'SSO accounts cannot regenerate recovery codes this way' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(403).json({ error: 'Incorrect password' });

  const plaintextCodes = Array.from({ length: 10 }, () => generateRecoveryCode());
  const hashedEntries = await Promise.all(
    plaintextCodes.map(async (code) => ({ hash: await bcrypt.hash(code, 10), used: false }))
  );

  await prisma.user.update({
    where: { id: req.userId },
    data: { mfaRecoveryCodes: hashedEntries },
  });

  // Audit trail for recovery-code regeneration. Never include the plaintext
  // codes (obvious) nor the hashes (less-obvious: they're bcrypt verifiers).
  void emitUserSecurityEvent(req.userId, 'mfa_recovery_regen', req);

  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  res.json({ codes: plaintextCodes });
}));

router.post('/recovery/verify', mfaVerifyLimiter, validate(mfaTokenCodeSchema), async (req, res) => {
  try {
    const { mfaToken, code } = req.body as { mfaToken?: string; code?: string };
    if (!mfaToken || !code) return res.status(400).json({ error: 'mfaToken and code required' });

    const decoded = jwt.verify(mfaToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string; emailHash?: string };
    if (decoded.purpose !== 'mfa') return res.status(401).json({ error: 'Invalid MFA token' });

    // Replay-protection check. Mark used only after the code verifies — see /totp/verify.
    const mfaTokenFingerprint = crypto.createHash('sha256').update(mfaToken).digest('hex').slice(0, 32);
    if (await isTokenAlreadyUsed('mfa:used-challenge', mfaTokenFingerprint)) {
      return res.status(400).json({ error: 'MFA token already used. Please log in again.' });
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { ...MFA_USER_SELECT, mfaRecoveryCodes: true } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.suspended) return res.status(403).json({ error: 'Your account has been suspended.' });

    if (user.deactivated) {
      await prisma.user.update({ where: { id: user.id }, data: { deactivated: false, deactivatedAt: null, status: 'online' } });
    }

    const recoveryCodes = user.mfaRecoveryCodes as { hash: string; used: boolean }[] | null;
    if (!Array.isArray(recoveryCodes)) return res.status(401).json({ error: 'No recovery codes configured' });

    const normalizedCode = code.trim().toLowerCase();
    let matchIdx = -1;
    for (let i = 0; i < recoveryCodes.length; i++) {
      if (recoveryCodes[i].used) continue;
      const match = await bcrypt.compare(normalizedCode, recoveryCodes[i].hash);
      if (match) { matchIdx = i; break; }
    }

    if (matchIdx === -1) return res.status(401).json({ error: 'Invalid recovery code' });

    const claimed = await markTokenUsedOnce('mfa:used-challenge', mfaTokenFingerprint, 600);
    if (!claimed) return res.status(400).json({ error: 'MFA token already used. Please log in again.' });

    // Atomic update via transaction to prevent double-use race condition
    try {
      await prisma.$transaction(async (tx) => {
        const freshUser = await tx.user.findUnique({
          where: { id: user.id },
          select: { mfaRecoveryCodes: true },
        });
        const freshCodes = freshUser?.mfaRecoveryCodes as { hash: string; used: boolean }[] | null;
        if (!Array.isArray(freshCodes)) throw new Error('No recovery codes');
        if (freshCodes[matchIdx].used) throw new Error('Recovery code already used');

        freshCodes[matchIdx].used = true;
        await tx.user.update({
          where: { id: user.id },
          data: { mfaRecoveryCodes: freshCodes, ...(user.status === 'offline' ? { status: 'online' } : {}) },
        });
      }, { isolationLevel: 'Serializable' });
    } catch (txErr: any) {
      if (txErr?.message === 'Recovery code already used') {
        return res.status(401).json({ error: 'Recovery code already used' });
      }
      throw txErr;
    }

    if (decoded.emailHash) await deleteLoginLockout(`user:${decoded.emailHash}`);
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshToken = generateRefreshToken();
    await createSession(user.id, token, req, refreshToken).catch(() => {});
    setRefreshCookie(res, refreshToken, req);

    // Login success via recovery code (canonical "I lost my second factor"
    // path; useful to see in the user's feed).
    void emitUserSecurityEvent(user.id, 'login_success', req, { via: 'mfa-recovery-code' });

    res.json({ user: buildMfaUserResponse(user), token });
  } catch (err: any) {
    if (err?.name === 'TokenExpiredError') return res.status(401).json({ error: 'MFA token expired. Please log in again.' });
    res.status(401).json({ error: 'Invalid MFA token' });
  }
});

export default router;
