// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { createSession, hashToken, generateRefreshToken } from '../utils/sessionUtils.js';
import { authenticateToken, JWT_SECRET, invalidateSessionCache, invalidateSessionCacheForUser, type AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { passwordSchema, registerSchema, loginSchema, verifyEmailSchema, resendVerificationSchema, changePasswordSchema, changeEmailSchema, confirmEmailCodeSchema, forgotPasswordSchema, resetPasswordSchema, completeOnboardingSchema, verifyDeviceSendSchema, verifyDeviceConfirmSchema } from '../schemas.js';
import { generateVerificationCode } from '../services/email.js';
import { enqueueEmail } from '../queues/producers.js';
import { verifyCaptcha } from '../services/captcha.js';
import { logger } from '../logger.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { computeBadges } from '../utils/badges.js';
import { getEffectivePlan } from '../utils.js';
import { hashEmail, encryptSecret, decryptSecret, decryptOrPlain } from '../services/mfaCrypto.js';
import { sensitiveActionLimiter, setRefreshCookie, clearRefreshCookie, setDeviceCookie, clearDeviceCookie, REFRESH_COOKIE_NAME, DEVICE_COOKIE_NAME } from './authHelpers.js';
import { getLoginLockout, setLoginLockout, deleteLoginLockout, setVerifyMapping, getVerifyMapping, deleteVerifyMapping, publishSessionInvalidation, redis } from '../redis.js';
import { markTokenUsedOnce } from '../utils/singleUseToken.js';
import { isDeviceTrusted, bumpDeviceLastSeen, issueTrustedDevice, listForUser, revokeDevice, revokeAllForUser } from '../services/trustedDevice.js';
import { createEmailChallenge, verifyChallenge } from '../services/loginVerification.js';
import { invalidateOnboardingCache } from '../middleware/requireOnboarding.js';
import { invalidateVerifiedEmailCache } from '../middleware/requireVerifiedEmail.js';
import { emitUserSecurityEvent } from '../services/securityEvents.js';
import { getClientIp } from '../utils/clientIp.js';
import { isSelfHost, getRegistrationMode, emailVerificationDisabled } from '../selfHost.js';
import { tryClaimFirstAdmin, BootstrapTokenError } from '../services/selfHostBootstrap.js';

const log = logger.child({ module: 'auth' });

/** Current version of ToS/Privacy Policy. Update when policies change materially. */
export const CURRENT_LEGAL_VERSION = '2026-03-04';

export const BCRYPT_ROUNDS = 12;

function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}
export const ACCESS_TOKEN_EXPIRY = '15m';

/** Mask an email for display in the verification modal, e.g.
 *  "ma***@gmail.com". Keeps the first char + 3 stars + domain so the
 *  user recognises which address they signed up with without leaking it
 *  to a snooping bystander. */
function maskEmail(email: string): string {
  const [localPart, domain] = email.split('@');
  if (!localPart || !domain) return '(unknown)';
  const visible = localPart.slice(0, Math.min(2, localPart.length));
  return `${visible}${'*'.repeat(3)}@${domain}`;
}

const router = Router();

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
});

// Limit login/register attempts to reduce brute-force risk.
// Per-account lockout (5 failures → 30min, see /login below) is the primary
// protection; this cap is just to stop shared NATs (corporate offices,
// Cloudflare Warp, mobile carriers) from flooding the auth endpoints.
// Keyed per-(emailHash + IP) when an email is in the body, so corporate NATs
// with many users no longer share a single budget. Routes without an email
// in the body (e.g. /verify-email, which uses an opaque userId + code) fall
// through to per-IP keying.
const authLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:auth:'),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts; try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const body = req.body as { email?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.toLowerCase().trim() : null;
    const ip = getClientIp(req) ?? 'anonymous';
    if (email) {
      const emailHash = crypto.createHash('sha256').update(email).digest('hex').slice(0, 32);
      return `e:${emailHash}:${ip}`;
    }
    return ip;
  },
});

const refreshLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:refresh:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many refresh attempts.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Key per-session (refresh cookie) instead of per-IP. Shared NATs (corporate
  // offices, Cloudflare Warp, mobile carriers) routinely put thousands of users
  // behind one egress IP — per-IP keying turns 10/min into a shared budget that
  // multi-tab token refreshes blow through, cascading into spurious logouts.
  // Hashed so the raw token never lands in the rate-limit store.
  keyGenerator: (req) => {
    const cookie = req.cookies?.[REFRESH_COOKIE_NAME];
    if (typeof cookie === 'string' && cookie.length > 0) {
      return 'sess:' + crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 32);
    }
    return getClientIp(req) ?? 'anonymous';
  },
});

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000;
// A parallel account-wide counter watches for distributed brute-force
// attempts (lots of IPs, a few attempts each). At this threshold we log a
// warning so ops can act, without converting a single user's mistakes plus
// some unrelated attacker traffic into a full lockout that the user can't
// self-recover from.
const ACCOUNT_WIDE_ALERT_THRESHOLD = 20;

/**
 * Progressive backoff on the per-(email, IP) counter.
 *  5 ≤ count < 10  → 30 minutes
 * 10 ≤ count < 20  → 6 hours
 * 20 ≤ count       → 24 hours
 * Attacker cost scales super-linearly per IP while legitimate users on a
 * different IP stay unaffected.
 */
function lockoutDurationMs(count: number): number {
  if (count >= 20) return 24 * 60 * 60 * 1000;
  if (count >= 10) return 6 * 60 * 60 * 1000;
  return LOCKOUT_DURATION_MS;
}


/** Stable-ish hash of the client IP for use as a lockout sub-key. */
function hashIp(ip: string | undefined): string {
  // Any non-empty string works — we just want a compact, non-reversible shard key.
  return crypto.createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 16);
}

const MAX_VERIFY_ATTEMPTS = 5;

// GET /api/auth/db-check — verify database is reachable (dev only)
router.get('/db-check', async (_req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  } catch (err: any) {
    log.error({ err }, 'DB check error');
    res.status(503).json({ ok: false, error: 'Database connection failed' });
  }
});

// POST /api/auth/register
router.post('/register', authLimiter, validate(registerSchema), async (req, res) => {
  try {
    const { username, email, password, captchaToken, dateOfBirth, parentalConsentAcknowledged } = req.body;

    const dob = new Date(dateOfBirth);
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const monthDiff = today.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age--;
    if (age < 13) {
      return res.status(403).json({ error: 'You must be at least 13 years old to create an account.' });
    }
    // Per ToS §3: 13–17 must affirm parental/guardian consent. We don't try
    // to verify the consent itself (that's a real product, not a flag) — we
    // record that the user acknowledged the requirement at signup. Adult
    // signups bypass this check; the bit gets persisted as `true` for them
    // anyway because consent isn't applicable.
    const requiresParentalConsent = age >= 13 && age < 18;
    if (requiresParentalConsent && parentalConsentAcknowledged !== true) {
      return res.status(403).json({
        error: 'A parent or legal guardian must consent to your use of Howl. Please confirm consent to continue.',
        code: 'PARENTAL_CONSENT_REQUIRED',
      });
    }

    const captchaOk = await verifyCaptcha(captchaToken, (req as any).ip);
    if (!captchaOk) return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });

    const normalizedEmail = email.toLowerCase().trim();
    const emailH = hashEmail(normalizedEmail);

    // Self-host onboarding: the first registrant on a fresh instance claims admin;
    // afterwards REGISTRATION_MODE governs self-registration.
    if (isSelfHost()) {
      let firstAdmin: Awaited<ReturnType<typeof tryClaimFirstAdmin>> = null;
      try {
        firstAdmin = await tryClaimFirstAdmin({ username, normalizedEmail, password, dob, bootstrapToken: req.body.bootstrapToken });
      } catch (e) {
        if (e instanceof BootstrapTokenError) {
          return res.status(403).json({ error: 'A valid setup token is required to create the first admin account.', code: 'BOOTSTRAP_TOKEN_REQUIRED' });
        }
        throw e;
      }
      if (firstAdmin) {
        const token = jwt.sign({ userId: firstAdmin.id }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
        const refreshToken = generateRefreshToken();
        await createSession(firstAdmin.id, token, req, refreshToken).catch(() => {});
        setRefreshCookie(res, refreshToken, req);
        return res.status(200).json({ token, user: { id: firstAdmin.id, username: firstAdmin.username, discriminator: firstAdmin.discriminator } });
      }
      if (getRegistrationMode() === 'closed') {
        return res.status(403).json({ error: 'Registration is closed on this instance. Ask the instance admin for an account.' });
      }
    }
    const autoVerify = emailVerificationDisabled();

    const existingEmail = await prisma.user.findUnique({ where: { emailHash: emailH }, select: { id: true, emailVerified: true, emailVerifyExpiry: true } });
    if (existingEmail) {
      if (!existingEmail.emailVerified) {
        const recentlySent = existingEmail.emailVerifyExpiry && (existingEmail.emailVerifyExpiry.getTime() - Date.now()) > 14 * 60 * 1000;
        if (!recentlySent) {
          const verifyCode = generateVerificationCode();
          const verifyExpiry = new Date(Date.now() + 15 * 60 * 1000);
          await prisma.user.update({ where: { id: existingEmail.id }, data: { emailVerifyCode: hashCode(verifyCode), emailVerifyExpiry: verifyExpiry } });
          enqueueEmail({ type: 'verification', to: normalizedEmail, code: verifyCode }).catch((e) => log.error({ err: e }, 'email enqueue error'));
        }
      }
      // Always return opaque UUID with mapping — user can still verify (anti-enumeration)
      const opaqueId = crypto.randomUUID();
      await setVerifyMapping(opaqueId, existingEmail.id);
      return res.status(200).json({ requiresVerification: true, userId: opaqueId });
    }

    // Random discriminator with retry-on-conflict instead of O(10K) scan
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const verifyCode = generateVerificationCode();
    const verifyExpiry = new Date(Date.now() + 15 * 60 * 1000);

    const MAX_DISCRIM_RETRIES = 10;
    let user: any;
    for (let attempt = 0; attempt < MAX_DISCRIM_RETRIES; attempt++) {
      const discriminator = crypto.randomInt(10000).toString().padStart(4, '0');
      try {
        user = await prisma.user.create({
          data: {
            username, discriminator,
            email: encryptSecret(normalizedEmail),
            emailHash: emailH,
            passwordHash,
            dateOfBirth: dob,
            status: 'offline',
            emailVerified: autoVerify,
            ...(autoVerify ? {} : { emailVerifyCode: hashCode(verifyCode), emailVerifyExpiry: verifyExpiry }),
            tosAcceptedAt: new Date(),
            privacyPolicyAcceptedAt: new Date(),
            legalConsentVersion: CURRENT_LEGAL_VERSION,
            // Adults: bit defaults to true (not applicable). 13–17: only the
            // affirmative case reaches this branch (the route returned 403
            // above otherwise) so this is always true here too.
            parentalConsentAcknowledged: true,
            ...(age < 18 ? {
              allowDmFromServerMembers: false,
              friendRequestsEveryone: false,
              messageRequestsFilter: true,
            } : {}),
          },
        });
        break;
      } catch (createErr: any) {
        // P2002 = unique constraint violation (username+discriminator or emailHash)
        if (createErr?.code === 'P2002') {
          const fields = createErr.meta?.target;
          if (Array.isArray(fields) && fields.includes('emailHash')) {
            // Race condition — another request just created this email. Map the opaque UUID so the user can still verify.
            const raceUser = await prisma.user.findUnique({ where: { emailHash: emailH }, select: { id: true } });
            const opaqueId = crypto.randomUUID();
            if (raceUser) await setVerifyMapping(opaqueId, raceUser.id);
            return res.status(200).json({ requiresVerification: true, userId: opaqueId });
          }
          if (attempt === MAX_DISCRIM_RETRIES - 1) {
            return res.status(400).json({ error: 'All discriminators for this username are taken. Please choose a different username.' });
          }
          continue;
        }
        throw createErr;
      }
    }

    if (autoVerify) {
      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
      const refreshToken = generateRefreshToken();
      await createSession(user.id, token, req, refreshToken).catch(() => {});
      setRefreshCookie(res, refreshToken, req);
      return res.status(200).json({ token, user: { id: user.id, username: user.username, discriminator: user.discriminator } });
    }

    enqueueEmail({ type: 'verification', to: normalizedEmail, code: verifyCode }).catch((e) => log.error({ err: e }, 'email enqueue error'));

    const opaqueId = crypto.randomUUID();
    await setVerifyMapping(opaqueId, user.id);
    res.status(200).json({ requiresVerification: true, userId: opaqueId });
  } catch (err: any) {
    log.error({ err }, 'Register error');
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/verify-email
router.post('/verify-email', authLimiter, validate(verifyEmailSchema), async (req, res) => {
  try {
    const { userId, code, captchaToken } = req.body as { userId?: string; code?: string; captchaToken?: string };
    if (!userId || !code) return res.status(400).json({ error: 'userId and code are required' });

    // Resolve opaque verification UUID → real userId (anti-enumeration)
    const realUserId = await getVerifyMapping(userId) ?? userId;

    const captchaOk = await verifyCaptcha(captchaToken, (req as any).ip);
    if (!captchaOk) return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });

    const attempts = await getLoginLockout(`verify:${userId}`);
    if (attempts && attempts.count >= MAX_VERIFY_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many failed attempts. Please request a new verification code.' });
    }

    const user = await prisma.user.findUnique({ where: { id: realUserId }, select: { id: true, emailVerified: true, emailVerifyCode: true, emailVerifyExpiry: true, username: true, discriminator: true, email: true, avatar: true, banner: true, bannerPositionY: true, bannerZoom: true, status: true, badges: true, stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true, createdAt: true, mfaEnabled: true, nameColor: true, nameFont: true, nameEffect: true, avatarEffect: true, backgroundImage: true, backgroundOpacity: true, backgroundBlur: true, bgGifAlwaysPlay: true } });
    if (!user) return res.status(400).json({ error: 'Invalid or expired verification code' });
    if (user.emailVerified) return res.status(400).json({ error: 'Invalid or expired verification code' });

    if (!user.emailVerifyCode || !timingSafeEqual(user.emailVerifyCode, hashCode(code))) {
      // Track failed verification attempts per userId (Redis-backed for multi-instance support)
      const current = await getLoginLockout(`verify:${userId}`) || { count: 0, lockedUntil: 0 };
      current.count++;
      await setLoginLockout(`verify:${userId}`, current);
      if (current.count >= MAX_VERIFY_ATTEMPTS) {
        // Invalidate the code to force re-send
        await prisma.user.update({ where: { id: realUserId }, data: { emailVerifyCode: null, emailVerifyExpiry: null } }).catch(() => {});
      }
      return res.status(400).json({ error: 'Invalid verification code' });
    }
    if (!user.emailVerifyExpiry || new Date() > user.emailVerifyExpiry) {
      return res.status(400).json({ error: 'Verification code has expired. Request a new one.' });
    }

    await prisma.user.update({
      where: { id: realUserId },
      data: { emailVerified: true, emailVerifyCode: null, emailVerifyExpiry: null, status: 'online' },
    });
    invalidateVerifiedEmailCache(realUserId);
    await deleteVerifyMapping(userId);

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshToken = generateRefreshToken();
    // Auto-trust signup device — the user just proved they control the
    // email address. Challenging them again on their next login from the
    // same browser is pointless churn.
    let signupTrustedDeviceId: string | null = null;
    try {
      const ua = (req.headers['user-agent'] ?? 'Unknown') as string;
      const rawIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip ?? null;
      const { device, rawCookieToken } = await issueTrustedDevice(user.id, ua, rawIp);
      signupTrustedDeviceId = device.id;
      setDeviceCookie(res, rawCookieToken, req);
    } catch (err) {
      log.warn({ err, userId: user.id }, 'signup auto-trust failed');
    }
    await createSession(user.id, token, req, refreshToken, signupTrustedDeviceId).catch(() => {});
    setRefreshCookie(res, refreshToken, req);

    let plainEmail: string;
    try { plainEmail = decryptSecret(user.email); } catch { plainEmail = user.email; }

    res.json({
      user: {
        id: user.id, username: user.username, discriminator: user.discriminator,
        email: plainEmail, avatar: user.avatar, banner: user.banner ?? null,
        bannerPositionY: user.bannerPositionY ?? 50, bannerZoom: user.bannerZoom ?? 100,
        status: 'online', stripePlan: user.stripePlan, effectivePlan: getEffectivePlan(user),
        badges: computeBadges(user), mfaEnabled: user.mfaEnabled ?? false,
        nameColor: user.nameColor ?? null, nameFont: user.nameFont ?? null,
        nameEffect: user.nameEffect ?? null, avatarEffect: user.avatarEffect ?? null,
        backgroundImage: user.backgroundImage ?? null, backgroundOpacity: user.backgroundOpacity,
        backgroundBlur: user.backgroundBlur, bgGifAlwaysPlay: user.bgGifAlwaysPlay,
      },
      token,
    });
  } catch (err: any) {
    log.error({ err }, 'Verify email error');
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Per-(userId + IP) tuple keying so a shared NAT (corporate / CGNAT) doesn't
// starve all signups behind a single 2/min IP bucket. The unauth body carries
// the opaque verification UUID (resolved server-side via getVerifyMapping); each
// signup gets its own bucket. resendBurstLimiter stays per-IP (default
// keyGenerator) as the coarse backstop against scripted abuse.
const resendLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:resend:'),
  windowMs: 60 * 1000,
  max: 2,
  message: { error: 'Please wait before requesting another code.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Authenticated route (POST /resend-verification-authenticated): per-user.
    // Note: authenticateToken runs AFTER this limiter, so req.userId is normally
    // unset here — kept for safety in case upstream middleware ever pre-populates it.
    const userId = (req as { userId?: string }).userId;
    if (userId) return 'u:' + userId;

    // Unauth route (POST /resend-verification): per-(verify-userId + IP) tuple.
    // Body is not yet validated at limiter time — guard against malformed input
    // and let validate() afterward reject it with 400.
    const rawId = (req.body as { userId?: unknown })?.userId;
    const id = typeof rawId === 'string' && rawId.length > 0
      ? rawId.toLowerCase().trim().slice(0, 64)
      : '';
    const ip = getClientIp(req) ?? 'anon';
    return id ? `id:${id}|${ip}` : `ip:${ip}`;
  },
});
const resendBurstLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS, store: createRateLimitStore('rl:resend-burst:'), windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many verification emails requested. Try again in 15 minutes.' }, standardHeaders: true, legacyHeaders: false });

// POST /api/auth/resend-verification
router.post('/resend-verification', resendLimiter, resendBurstLimiter, validate(resendVerificationSchema), async (req, res) => {
  try {
    const { userId, captchaToken } = req.body as { userId?: string; captchaToken?: string };
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const captchaOk = await verifyCaptcha(captchaToken, (req as any).ip);
    if (!captchaOk) return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });

    // Resolve opaque verification UUID → real userId (anti-enumeration)
    const realUserId = await getVerifyMapping(userId) ?? userId;

    const user = await prisma.user.findUnique({ where: { id: realUserId }, select: { id: true, email: true, emailVerified: true } });
    if (!user) return res.json({ success: true }); // Anti-enumeration: always succeed
    if (user.emailVerified) return res.json({ success: true }); // Already done

    const verifyCode = generateVerificationCode();
    const verifyExpiry = new Date(Date.now() + 15 * 60 * 1000);

    await prisma.user.update({ where: { id: realUserId }, data: { emailVerifyCode: hashCode(verifyCode), emailVerifyExpiry: verifyExpiry } });
    let plainEmail: string;
    try { plainEmail = decryptSecret(user.email); } catch { plainEmail = user.email; }
    enqueueEmail({ type: 'verification', to: plainEmail, code: verifyCode }).catch((e) => log.error({ err: e }, 'email enqueue error'));

    res.json({ success: true });
  } catch (err: any) {
    log.error({ err }, 'Resend verification error');
    res.status(500).json({ error: 'Failed to resend code' });
  }
});

// POST /api/auth/verify-email-authenticated — verify email for already-authenticated SSO users
// Skips CAPTCHA and opaque userId since the user has a valid JWT.
const verifyAuthenticatedSchema = z.object({ body: z.object({ code: z.string().min(6).max(6) }) });
router.post('/verify-email-authenticated', authLimiter, authenticateToken, validate(verifyAuthenticatedSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body as { code: string };

  const attempts = await getLoginLockout(`verify:${req.userId}`);
  if (attempts && attempts.count >= MAX_VERIFY_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many failed attempts. Please request a new verification code.' });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      id: true, emailVerified: true, emailVerifyCode: true, emailVerifyExpiry: true,
      username: true, discriminator: true, email: true, avatar: true, banner: true,
      bannerPositionY: true, bannerZoom: true, status: true, badges: true,
      stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true,
      createdAt: true, mfaEnabled: true, nameColor: true, nameFont: true, nameEffect: true,
      avatarEffect: true, backgroundImage: true, backgroundOpacity: true, backgroundBlur: true,
      bgGifAlwaysPlay: true,
    },
  });
  if (!user) return res.status(400).json({ error: 'Invalid or expired verification code' });
  if (user.emailVerified) return res.json({ alreadyVerified: true });

  if (!user.emailVerifyCode || !timingSafeEqual(user.emailVerifyCode, hashCode(code))) {
    const current = await getLoginLockout(`verify:${req.userId}`) || { count: 0, lockedUntil: 0 };
    current.count++;
    await setLoginLockout(`verify:${req.userId}`, current);
    if (current.count >= MAX_VERIFY_ATTEMPTS) {
      await prisma.user.update({ where: { id: req.userId }, data: { emailVerifyCode: null, emailVerifyExpiry: null } }).catch(() => {});
    }
    return res.status(400).json({ error: 'Invalid verification code' });
  }
  if (!user.emailVerifyExpiry || new Date() > user.emailVerifyExpiry) {
    return res.status(400).json({ error: 'Verification code has expired. Request a new one.' });
  }

  await prisma.user.update({
    where: { id: req.userId },
    data: { emailVerified: true, emailVerifyCode: null, emailVerifyExpiry: null },
  });
  invalidateVerifiedEmailCache(req.userId);

  let plainEmail: string;
  try { plainEmail = decryptSecret(user.email); } catch { plainEmail = user.email; }

  res.json({
    user: {
      id: user.id, username: user.username, discriminator: user.discriminator,
      email: plainEmail, avatar: user.avatar, banner: user.banner ?? null,
      bannerPositionY: user.bannerPositionY ?? 50, bannerZoom: user.bannerZoom ?? 100,
      status: user.status, stripePlan: user.stripePlan, effectivePlan: getEffectivePlan(user),
      badges: computeBadges(user), mfaEnabled: user.mfaEnabled ?? false,
      nameColor: user.nameColor ?? null, nameFont: user.nameFont ?? null,
      nameEffect: user.nameEffect ?? null, avatarEffect: user.avatarEffect ?? null,
      backgroundImage: user.backgroundImage ?? null, backgroundOpacity: user.backgroundOpacity,
      backgroundBlur: user.backgroundBlur, bgGifAlwaysPlay: user.bgGifAlwaysPlay,
      emailVerified: true,
    },
  });
}));

// POST /api/auth/resend-verification-authenticated — resend for already-authenticated SSO users
// Skips CAPTCHA since the user has a valid JWT (stronger anti-abuse than CAPTCHA alone).
// Rate-limited by the same resendLimiter + burst limiter.
router.post('/resend-verification-authenticated', resendLimiter, resendBurstLimiter, authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, email: true, emailVerified: true } });
  if (!user) return res.json({ success: true });
  if (user.emailVerified) return res.json({ success: true });

  const verifyCode = generateVerificationCode();
  const verifyExpiry = new Date(Date.now() + 15 * 60 * 1000);

  await prisma.user.update({ where: { id: req.userId }, data: { emailVerifyCode: hashCode(verifyCode), emailVerifyExpiry: verifyExpiry } });
  let plainEmail: string;
  try { plainEmail = decryptSecret(user.email); } catch { plainEmail = user.email; }
  enqueueEmail({ type: 'verification', to: plainEmail, code: verifyCode }).catch((e) => log.error({ err: e }, 'email enqueue error'));

  res.json({ success: true });
}));

// POST /api/auth/login
router.post('/login', authLimiter, validate(loginSchema), async (req, res) => {
  try {
    const { email, password, captchaToken } = req.body;

    const captchaOk = await verifyCaptcha(captchaToken, (req as any).ip);
    if (!captchaOk) return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });

    const lockKey = email.toLowerCase().trim();
    const emailH = hashEmail(lockKey);
    // Shard the lockout by (email, IP) so an attacker from one IP cannot lock
    // the victim out of logins from a different IP (their real device). A
    // distributed attacker still has to burn one counter per IP to make any
    // progress.
    const ipH = hashIp(req.ip);
    const tupleKey = `user:${emailH}:${ipH}`;
    const lockEntry = await getLoginLockout(tupleKey);
    if (lockEntry && Date.now() < lockEntry.lockedUntil) {
      const mins = Math.ceil((lockEntry.lockedUntil - Date.now()) / 60000);
      return res.status(429).json({ error: `Too many failed attempts from this device. Try again in ${mins} minute(s).` });
    }

    const user = await prisma.user.findUnique({
      where: { emailHash: emailH },
      select: {
        id: true, passwordHash: true, emailVerified: true, emailVerifyExpiry: true,
        email: true, mfaEnabled: true, mfaTotpSecret: true, mfaPhone: true,
        mfaPhoneVerified: true, status: true, username: true, discriminator: true,
        avatar: true, banner: true, bannerPositionY: true, bannerZoom: true, stripePlan: true, stripeStatus: true,
        stripePeriodEnd: true, stripeSubscriptionId: true,
        badges: true, createdAt: true, suspended: true, deactivated: true,
        nameColor: true, nameFont: true, nameEffect: true, avatarEffect: true,
        backgroundImage: true, backgroundOpacity: true, backgroundBlur: true, bgGifAlwaysPlay: true,
      },
    });

    // Constant-time comparison: always run bcrypt to prevent timing-based user enumeration
    const DUMMY_HASH = '$2b$12$LJ3m4ys3Lg3Sv4vQx5w8XOQz0rZ4v5b6Y7c8D9eAf0gBhCiDjEkFl';
    const hashToCompare = user?.passwordHash || DUMMY_HASH;
    const valid = await bcrypt.compare(password, hashToCompare);

    if (!user || !valid) {
      const entry = lockEntry || { count: 0, lockedUntil: 0 };
      entry.count++;
      if (entry.count >= MAX_LOGIN_ATTEMPTS) {
        // Progressive backoff. Scales with persistent abuse from the same IP
        // without punishing a legitimate user's occasional typo from a
        // different device.
        entry.lockedUntil = Date.now() + lockoutDurationMs(entry.count);
      }
      await setLoginLockout(tupleKey, entry);

      // Account-wide counter: strictly observational — logs a warning at the
      // threshold so ops can investigate a distributed brute-force attempt
      // without introducing a new DoS vector. Do NOT convert this counter
      // into a hard lockout; that would let one IP lock the victim out of
      // logins from a different IP (their real device).
      const wideKey = `user-wide:${emailH}`;
      const wideEntry = await getLoginLockout(wideKey);
      const wideNext = (wideEntry?.count ?? 0) + 1;
      await setLoginLockout(wideKey, { count: wideNext, lockedUntil: 0 });
      if (wideNext === ACCOUNT_WIDE_ALERT_THRESHOLD) {
        log.warn({ emailH, count: wideNext }, 'account-wide failed-login threshold reached (distributed brute-force suspected)');
      }

      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.passwordHash) {
      return res.status(401).json({ error: 'This account uses social login. Please sign in with Google, Apple, or Steam.' });
    }

    if (user.suspended) {
      return res.status(403).json({ error: 'Your account has been suspended. Please contact support for more information.' });
    }

    if (user.deactivated) {
      await prisma.user.update({
        where: { id: user.id },
        data: { deactivated: false, deactivatedAt: null, status: 'online' },
      });
    }

    let plainEmail: string;
    try { plainEmail = decryptSecret(user.email); } catch { plainEmail = user.email; }

    if (!user.emailVerified && !emailVerificationDisabled()) {
      const recentlySent = user.emailVerifyExpiry && (user.emailVerifyExpiry.getTime() - Date.now()) > 14 * 60 * 1000;
      if (!recentlySent) {
        const verifyCode = generateVerificationCode();
        const verifyExpiry = new Date(Date.now() + 15 * 60 * 1000);
        await prisma.user.update({ where: { id: user.id }, data: { emailVerifyCode: hashCode(verifyCode), emailVerifyExpiry: verifyExpiry } });
        enqueueEmail({ type: 'verification', to: plainEmail, code: verifyCode }).catch((e) => log.error({ err: e }, 'email enqueue error'));
      }
      const opaqueId = crypto.randomUUID();
      await setVerifyMapping(opaqueId, user.id);
      return res.status(200).json({ requiresVerification: true, userId: opaqueId });
    }

    // MFA check
    if (user.mfaEnabled) {
      const methods: string[] = [];
      if (user.mfaTotpSecret) methods.push('totp');
      // Only advertise SMS MFA if a provider is configured (sendMfaSmsCode throws in prod without one)
      if (user.mfaPhoneVerified && user.mfaPhone && process.env.SMS_PROVIDER_CONFIGURED) methods.push('sms');
      const passkeys = await prisma.passkeyCredential.count({ where: { userId: user.id } });
      if (passkeys > 0) methods.push('passkey');

      const mfaToken = jwt.sign({ userId: user.id, purpose: 'mfa', emailHash: emailH }, JWT_SECRET, { expiresIn: '5m' });
      return res.json({ mfaRequired: true, mfaToken, methods });
    }

    // Device-verification gate (only reached when the user has NO MFA enrolled).
    // MFA users already run TOTP/passkey/recovery every login, so device trust
    // would be redundant for them. Users without MFA get challenged on every
    // new browser/device via a 6-digit email code; a 90-day sliding cookie
    // (howl_device_id) skips the challenge on repeat visits.
    const rawDeviceToken = (req.cookies as Record<string, string> | undefined)?.[DEVICE_COOKIE_NAME];
    const trustResult = rawDeviceToken
      ? await isDeviceTrusted(user.id, rawDeviceToken)
      : { trusted: false as const };

    // On a self-host instance with no email provider, the 6-digit device-verify
    // code can never be delivered, so challenging here would permanently lock out
    // admin-provisioned users on their first login. emailVerificationDisabled()
    // (self-host AND no RESEND_API_KEY) skips the gate; configuring email re-arms it.
    if (!trustResult.trusted && !emailVerificationDisabled()) {
      const methods: string[] = ['email'];
      // SMS is wired for parity; UI grays the tab when the env flag is off.
      if (process.env.SMS_PROVIDER_CONFIGURED && user.mfaPhoneVerified && user.mfaPhone) methods.push('sms');

      const verifyToken = jwt.sign(
        // Include a unique jti so consecutive logins in the same second
        // (e.g., a retry after a typo) produce distinct tokens — otherwise
        // the single-use mark collides on the shared fingerprint and the
        // legitimate retry gets rejected.
        { userId: user.id, purpose: 'device-verify', emailHash: emailH, jti: crypto.randomUUID() },
        JWT_SECRET,
        { expiresIn: '5m' },
      );
      log.info({ userId: user.id, event: 'device-verification-required' }, 'new-device login challenge issued');
      return res.json({
        verificationRequired: true,
        verifyToken,
        methods,
        emailMasked: maskEmail(plainEmail),
      });
    }

    // Trusted device — slide the 90-day expiry forward.
    if (trustResult.device) {
      bumpDeviceLastSeen(trustResult.device.id, req.ip ?? null).catch(() => {});
    }

    // Successful login clears BOTH the per-(email,IP) and the account-wide
    // counters — the latter so a legitimate login resets noise quickly.
    await deleteLoginLockout(tupleKey);
    await deleteLoginLockout(`user-wide:${emailH}`);

    if (user.status === 'offline') {
      await prisma.user.update({ where: { id: user.id }, data: { status: 'online' } });
    }
    const currentStatus = user.status === 'offline' ? 'online' : user.status;

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshToken = generateRefreshToken();
    await createSession(user.id, token, req, refreshToken, trustResult.device?.id ?? null).catch(() => {});
    setRefreshCookie(res, refreshToken, req);
    // Trusted-device happy path reaches here. No new-device event because the
    // caller already presented a known howl_device_id cookie; new-device
    // logins flow through /verify-device/confirm instead.
    void emitUserSecurityEvent(user.id, 'login_success', req, { via: 'password', trustedDevice: true });
    res.json({
      user: {
        id: user.id, username: user.username, discriminator: user.discriminator,
        email: plainEmail, avatar: user.avatar, banner: user.banner ?? null,
        bannerPositionY: user.bannerPositionY ?? 50, bannerZoom: user.bannerZoom ?? 100,
        status: currentStatus, stripePlan: user.stripePlan, effectivePlan: getEffectivePlan(user),
        badges: computeBadges(user), mfaEnabled: user.mfaEnabled,
        nameColor: user.nameColor, nameFont: user.nameFont,
        nameEffect: user.nameEffect, avatarEffect: user.avatarEffect,
        backgroundImage: user.backgroundImage, backgroundOpacity: user.backgroundOpacity,
        backgroundBlur: user.backgroundBlur, bgGifAlwaysPlay: user.bgGifAlwaysPlay,
      },
      token,
    });
  } catch (err: any) {
    log.error({ err }, 'Login error');
    res.status(500).json({ error: 'Login failed' });
  }
});

// Device-verification endpoints (new-device login challenge)
// Called from Login.tsx after the login route responds with verificationRequired.
// Flow:
//   POST /verify-device/send   — resolve verifyToken, enqueue email code
//   POST /verify-device/confirm — validate code, (optionally) set trust cookie,
//                                 issue real session

const deviceVerifySendLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:device-verify-send:'),
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { error: 'Too many verification codes requested. Try again in 10 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const deviceVerifyConfirmLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:device-verify-confirm:'),
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Single-use mark for the device-verify JWT, applied AFTER a successful
 * verifyChallenge. Prevents a replayed verifyToken from minting a second
 * session (the challenge row's consumedAt enforces single-use of the CODE
 * but a replayed token against a freshly-seeded code — only reachable in
 * tests or via admin paths — could otherwise double-issue).
 *
 * Uses Redis SET NX EX so the mark-or-fail is atomic across replicas.
 * Returns `true` if this caller successfully claimed the token,
 * `false` if it was already used.
 */
async function markDeviceVerifyJwtUsed(jwtRaw: string): Promise<boolean> {
  const fingerprint = crypto.createHash('sha256').update(jwtRaw).digest('hex').slice(0, 32);
  return markTokenUsedOnce('auth:used-device-verify', fingerprint, 600);
}

function verifyDeviceVerifyToken(token: string): { userId: string; emailHash?: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; purpose?: string; emailHash?: string };
    if (decoded.purpose !== 'device-verify') return null;
    return { userId: decoded.userId, emailHash: decoded.emailHash };
  } catch {
    return null;
  }
}

// POST /api/auth/verify-device/send — send a 6-digit code via email (or SMS)
router.post('/verify-device/send', deviceVerifySendLimiter, validate(verifyDeviceSendSchema), asyncHandler(async (req: Request, res: Response) => {
  const { verifyToken, method } = req.body as { verifyToken: string; method: 'email' | 'sms' };

  const decoded = verifyDeviceVerifyToken(verifyToken);
  if (!decoded) return res.status(401).json({ error: 'Invalid or expired verification session. Please log in again.' });

  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
    select: { id: true, email: true, mfaPhone: true, mfaPhoneVerified: true, suspended: true, deactivated: true },
  });
  if (!user || user.suspended) return res.status(401).json({ error: 'Invalid verification session.' });

  if (method === 'sms') {
    if (!process.env.SMS_PROVIDER_CONFIGURED || !user.mfaPhoneVerified || !user.mfaPhone) {
      return res.status(501).json({ error: 'SMS verification is not available on your account. Use email instead.' });
    }
  }

  const rawIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip ?? null;
  const ipH = rawIp ? hashIp(rawIp) : null;

  const { codePlain } = await createEmailChallenge(user.id, ipH, method);

  if (method === 'email') {
    let plainEmail: string;
    try { plainEmail = decryptSecret(user.email); } catch { plainEmail = user.email; }
    const ua = (req.headers['user-agent'] ?? 'Unknown') as string;
    const deviceLabel = (() => {
      let label = 'Unknown device';
      if (/Electron/i.test(ua)) label = 'Howl Desktop';
      else if (/Chrome/i.test(ua)) label = 'Chrome';
      else if (/Firefox/i.test(ua)) label = 'Firefox';
      else if (/Safari/i.test(ua)) label = 'Safari';
      else if (/Edge/i.test(ua)) label = 'Edge';
      return label;
    })();
    const ipMasked = (() => {
      if (!rawIp) return '(unknown)';
      if (rawIp.includes(':')) return rawIp.split(':').slice(0, 3).join(':') + ':***';
      const parts = rawIp.split('.');
      if (parts.length !== 4) return '(unknown)';
      return `${parts[0]}.${parts[1]}.***.***`;
    })();
    enqueueEmail({ type: 'deviceVerify', to: plainEmail, code: codePlain, deviceLabel, ipMasked })
      .catch((err) => log.error({ err }, 'deviceVerify email enqueue error'));
  } else {
    // SMS path is reserved — we only reach here when SMS_PROVIDER_CONFIGURED.
    // For now we enqueue an mfaSms job so when a provider wires up, this just works.
    enqueueEmail({ type: 'mfaSms', phone: user.mfaPhone!, code: codePlain })
      .catch((err) => log.error({ err }, 'deviceVerify SMS enqueue error'));
  }

  res.json({ ok: true });
}));

// POST /api/auth/verify-device/confirm — validate code, mint session
router.post('/verify-device/confirm', deviceVerifyConfirmLimiter, validate(verifyDeviceConfirmSchema), asyncHandler(async (req: Request, res: Response) => {
  const { verifyToken, code, trustDevice } = req.body as { verifyToken: string; code: string; trustDevice: boolean };

  const decoded = verifyDeviceVerifyToken(verifyToken);
  if (!decoded) return res.status(401).json({ error: 'Invalid or expired verification session. Please log in again.' });

  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
    select: {
      id: true, suspended: true, deactivated: true, username: true, discriminator: true,
      email: true, avatar: true, banner: true, bannerPositionY: true, bannerZoom: true,
      status: true, stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true,
      badges: true, createdAt: true, mfaEnabled: true,
      nameColor: true, nameFont: true, nameEffect: true, avatarEffect: true,
      backgroundImage: true, backgroundOpacity: true, backgroundBlur: true, bgGifAlwaysPlay: true,
    },
  });
  if (!user) return res.status(401).json({ error: 'Invalid verification session.' });
  if (user.suspended) return res.status(403).json({ error: 'Your account has been suspended. Please contact support for more information.' });

  const result = await verifyChallenge(user.id, code);
  if (!result.ok) {
    if (result.reason === 'attempts') return res.status(429).json({ error: 'Too many incorrect attempts. Please log in again.' });
    if (result.reason === 'expired') return res.status(400).json({ error: 'Verification code expired. Please log in again.' });
    if (result.reason === 'not_found') return res.status(400).json({ error: 'No pending code. Please request a new one.' });
    return res.status(401).json({ error: 'Invalid verification code' });
  }

  // Code verified. Now single-use the verifyToken so a replay with a
  // freshly-seeded code can't double-issue. markUsed runs AFTER the
  // challenge row is consumed, so a single mistyped code doesn't burn
  // the JWT — only a successful code burn does.
  const firstUse = await markDeviceVerifyJwtUsed(verifyToken);
  if (!firstUse) return res.status(400).json({ error: 'Verification token already used. Please log in again.' });

  if (user.deactivated) {
    await prisma.user.update({ where: { id: user.id }, data: { deactivated: false, deactivatedAt: null, status: 'online' } });
  }
  if (user.status === 'offline') {
    await prisma.user.update({ where: { id: user.id }, data: { status: 'online' } });
  }
  const currentStatus = user.status === 'offline' ? 'online' : user.status;

  // Clear the per-(email, IP) lockout counter on successful challenge —
  // the user has now proven two factors (password + code), no reason to
  // hold the IP in penalty.
  if (decoded.emailHash) {
    const ipH = hashIp(req.ip ?? '');
    await deleteLoginLockout(`user:${decoded.emailHash}:${ipH}`).catch(() => {});
    await deleteLoginLockout(`user-wide:${decoded.emailHash}`).catch(() => {});
  }

  // Optional device trust — user checkbox. Skipped on shared machines.
  let trustedDeviceId: string | null = null;
  if (trustDevice) {
    const ua = (req.headers['user-agent'] ?? 'Unknown') as string;
    const rawIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip ?? null;
    const { device, rawCookieToken } = await issueTrustedDevice(user.id, ua, rawIp);
    trustedDeviceId = device.id;
    setDeviceCookie(res, rawCookieToken, req);
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
  const refreshToken = generateRefreshToken();
  await createSession(user.id, token, req, refreshToken, trustedDeviceId).catch(() => {});
  setRefreshCookie(res, refreshToken, req);

  let plainEmail: string;
  try { plainEmail = decryptSecret(user.email); } catch { plainEmail = user.email; }

  log.info({ userId: user.id, trusted: !!trustedDeviceId, event: 'device-verification-success' }, 'device verification cleared');

  // /verify-device/confirm only fires after a device-challenge email/SMS code
  // is entered, so every success here is a first-seen device on this account.
  // Emit both login_success and login_new_device so the owner sees the "new
  // device just signed in" row in their feed.
  void emitUserSecurityEvent(user.id, 'login_success', req, { via: 'device-verify', trustedDevice: !!trustedDeviceId });
  void emitUserSecurityEvent(user.id, 'login_new_device', req, { trusted: !!trustedDeviceId });

  res.json({
    user: {
      id: user.id, username: user.username, discriminator: user.discriminator,
      email: plainEmail, avatar: user.avatar, banner: user.banner ?? null,
      bannerPositionY: user.bannerPositionY ?? 50, bannerZoom: user.bannerZoom ?? 100,
      status: currentStatus, stripePlan: user.stripePlan, effectivePlan: getEffectivePlan(user),
      badges: computeBadges(user), mfaEnabled: user.mfaEnabled,
      nameColor: user.nameColor, nameFont: user.nameFont,
      nameEffect: user.nameEffect, avatarEffect: user.avatarEffect,
      backgroundImage: user.backgroundImage, backgroundOpacity: user.backgroundOpacity,
      backgroundBlur: user.backgroundBlur, bgGifAlwaysPlay: user.bgGifAlwaysPlay,
    },
    token,
  });
}));

// GET /api/auth/trusted-devices — list the caller's trusted devices
router.get('/trusted-devices', authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const devices = await listForUser(req.userId);
  res.json({ devices });
}));

// DELETE /api/auth/trusted-devices/:id — revoke a trust row (and associated sessions cascade-null)
router.delete('/trusted-devices/:id', sensitiveActionLimiter, authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const id = req.params.id;
  if (!id || typeof id !== 'string' || id.length > 64) return res.status(400).json({ error: 'Invalid device id' });
  const removed = await revokeDevice(req.userId, id);
  if (!removed) return res.status(404).json({ error: 'Device not found' });
  // If this was the caller's own device, clear the cookie too so the next
  // login triggers the challenge from scratch.
  const rawToken = (req.cookies as Record<string, string> | undefined)?.[DEVICE_COOKIE_NAME];
  if (rawToken) {
    const stillTrusted = await isDeviceTrusted(req.userId, rawToken);
    if (!stillTrusted.trusted) clearDeviceCookie(res, req);
  }
  res.json({ ok: true });
}));

// DELETE /api/auth/trusted-devices — revoke all of the caller's trusted devices
router.delete('/trusted-devices', sensitiveActionLimiter, authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const count = await revokeAllForUser(req.userId);
  clearDeviceCookie(res, req);
  res.json({ ok: true, count });
}));

// SSO password-install step-up store (Redis with in-memory fallback)
// Installing a password on an SSO-only account requires a second factor.
// We generate a 6-digit email code, hash it into this store, and require the
// user to submit the plaintext in a follow-up call within 15 minutes.
const pendingPasswordInstalls = new Map<string, { codeHash: string; expiresAt: number }>();
const PENDING_PASSWORD_INSTALL_TTL_MS = 15 * 60 * 1000;

async function setPendingPasswordInstall(userId: string, codeHash: string) {
  const entry = { codeHash, expiresAt: Date.now() + PENDING_PASSWORD_INSTALL_TTL_MS };
  if (redis) {
    await redis.set(`pending-pw-install:${userId}`, JSON.stringify(entry), 'EX', 900);
  } else {
    if (pendingPasswordInstalls.size >= 10_000) {
      const oldest = pendingPasswordInstalls.keys().next().value;
      if (oldest !== undefined) pendingPasswordInstalls.delete(oldest);
    }
    pendingPasswordInstalls.set(userId, entry);
  }
}

async function getPendingPasswordInstall(userId: string): Promise<{ codeHash: string; expiresAt: number } | null> {
  if (redis) {
    const raw = await redis.get(`pending-pw-install:${userId}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  const entry = pendingPasswordInstalls.get(userId);
  if (!entry || Date.now() > entry.expiresAt) {
    pendingPasswordInstalls.delete(userId);
    return null;
  }
  return entry;
}

async function deletePendingPasswordInstall(userId: string) {
  if (redis) await redis.del(`pending-pw-install:${userId}`);
  else pendingPasswordInstalls.delete(userId);
}

// PATCH /api/auth/me/password – change password
router.patch('/me/password', sensitiveActionLimiter, authenticateToken, validate(changePasswordSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { currentPassword, newPassword, mfaCode, emailCode } = req.body as {
    currentPassword?: string; newPassword?: string; mfaCode?: string; emailCode?: string;
  };
  if (!newPassword) return res.status(400).json({ error: 'New password is required' });

  const pwCheck = passwordSchema.safeParse(newPassword);
  if (!pwCheck.success) {
    const issues = pwCheck.error.issues.map((i) => i.message);
    return res.status(400).json({ error: issues.join('. ') });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, passwordHash: true, email: true, mfaEnabled: true, mfaTotpSecret: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (!user.passwordHash) {
    // First-time password install on an SSO-only account. Require a step-up:
    // without one, any holder of an active session could install a permanent
    // password, turning a session-only hijack into permanent takeover. Require
    // either the MFA code (if MFA enabled) or an email-delivered code
    // (otherwise).

    if (user.mfaEnabled && user.mfaTotpSecret) {
      if (!mfaCode) return res.status(403).json({ error: 'MFA verification code is required', mfaRequired: true });
      const otplib = await import('otplib');
      const secret = decryptSecret(user.mfaTotpSecret);
      const result = otplib.verifySync({ token: mfaCode, secret });
      if (!result.valid) return res.status(401).json({ error: 'Invalid MFA code' });
    } else {
      // Email-code challenge. Two-step:
      //   1. No emailCode → generate + email a 6-digit code, return { requiresEmailCode: true }.
      //   2. With emailCode → validate against pending store, then commit.
      if (!emailCode) {
        const code = generateVerificationCode();
        await setPendingPasswordInstall(req.userId, hashCode(code));
        const plainEmail = (() => {
          try { return decryptSecret(user.email); } catch { return user.email; }
        })();
        if (plainEmail) {
          enqueueEmail({ type: 'verification', to: plainEmail, code }).catch((err) =>
            log.error({ err }, 'password-install email enqueue error'),
          );
        }
        return res.status(202).json({ requiresEmailCode: true });
      }
      const pending = await getPendingPasswordInstall(req.userId);
      if (!pending) return res.status(400).json({ error: 'No pending password-install code. Please try again.' });
      if (!timingSafeEqual(hashCode(emailCode.trim()), pending.codeHash)) {
        return res.status(401).json({ error: 'Invalid verification code' });
      }
      await deletePendingPasswordInstall(req.userId);
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await prisma.user.update({ where: { id: req.userId }, data: { passwordHash } });

    // Record the install on the user's own audit feed.
    void emitUserSecurityEvent(req.userId, 'password_changed', req, { firstInstall: true });

    // Notify the account holder that a password was installed.
    const plainEmail = (() => {
      try { return decryptSecret(user.email); } catch { return user.email; }
    })();
    if (plainEmail) {
      enqueueEmail({ type: 'passwordInstalled', to: plainEmail }).catch((err) =>
        log.error({ err }, 'passwordInstalled email enqueue error'),
      );
    }
    return res.json({ success: true });
  }

  // Existing password — require current password
  if (!currentPassword) return res.status(400).json({ error: 'Current password is required' });
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const authHeader = req.headers['authorization'];
  const currentToken = authHeader?.split(' ')[1];
  const currentHash = currentToken ? hashToken(currentToken) : null;
  const sessionsToInvalidate = await prisma.session.findMany({
    where: {
      userId: req.userId,
      ...(currentHash ? { tokenHash: { not: currentHash } } : {}),
    },
    select: { tokenHash: true },
    take: 100,
  });
  await prisma.$transaction([
    prisma.user.update({ where: { id: req.userId }, data: { passwordHash } }),
    prisma.session.deleteMany({
      where: {
        userId: req.userId,
        ...(currentHash ? { tokenHash: { not: currentHash } } : {}),
      },
    }),
    // Defensive: a password change is the canonical "my account may have
    // been compromised" event. Revoke all trusted devices so any stolen
    // howl_device_id cookie can't skip the next login's device challenge.
    prisma.trustedDevice.deleteMany({ where: { userId: req.userId } }),
  ]);
  invalidateSessionCacheForUser(req.userId!);
  for (const s of sessionsToInvalidate) {
    publishSessionInvalidation(s.tokenHash);
  }
  // Keep the caller's own browser trusted — they just authenticated with the
  // old password a moment ago. Issue a fresh trust row + cookie.
  try {
    const ua = (req.headers['user-agent'] ?? 'Unknown') as string;
    const rawIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip ?? null;
    const { rawCookieToken } = await issueTrustedDevice(req.userId, ua, rawIp);
    setDeviceCookie(res, rawCookieToken, req);
  } catch (err) {
    log.warn({ err, userId: req.userId }, 'password-change: re-issue trusted device failed');
  }
  // Audit trail for account owner.
  void emitUserSecurityEvent(req.userId, 'password_changed', req);
  res.json({ success: true });
}));

// Pending email change store (Redis with in-memory fallback)
//
// Stores hashes of two codes: one sent to the OLD email (proving the session
// holder controls the current mailbox), and one to the NEW email (proving the
// destination is reachable). Both must be submitted on verify.
//
// `codeHash` is kept (alias for `codeHashNew`) so older in-flight entries from
// before deploy continue to verify via the legacy single-code path.
type PendingEmailChange = {
  newEmail: string;
  newEmailHash: string;
  codeHashNew: string;
  codeHashOld: string;
  oldEmail: string;
  oldEmailHash: string;
  expiresAt: number;
  // legacy field kept so rows written pre-fix can still verify via the
  // old single-code path — remove after the 15-minute TTL window has expired
  // across all replicas post-deploy.
  codeHash?: string;
};

const pendingEmailChanges = new Map<string, PendingEmailChange>();
const PENDING_EMAIL_TTL_MS = 15 * 60 * 1000;

async function setPendingEmailChange(userId: string, data: Omit<PendingEmailChange, 'expiresAt'>) {
  const entry: PendingEmailChange = { ...data, expiresAt: Date.now() + PENDING_EMAIL_TTL_MS };
  if (redis) {
    await redis.set(`pending-email:${userId}`, JSON.stringify(entry), 'EX', 900);
  } else {
    if (pendingEmailChanges.size >= 10_000) {
      const oldest = pendingEmailChanges.keys().next().value;
      if (oldest !== undefined) pendingEmailChanges.delete(oldest);
    }
    pendingEmailChanges.set(userId, entry);
  }
}

async function getPendingEmailChange(userId: string): Promise<PendingEmailChange | null> {
  if (redis) {
    const raw = await redis.get(`pending-email:${userId}`);
    if (!raw) return null;
    const data = JSON.parse(raw) as PendingEmailChange;
    if (Date.now() > data.expiresAt) return null;
    return data;
  }
  const entry = pendingEmailChanges.get(userId);
  if (!entry || Date.now() > entry.expiresAt) {
    pendingEmailChanges.delete(userId);
    return null;
  }
  return entry;
}

async function deletePendingEmailChange(userId: string) {
  if (redis) {
    await redis.del(`pending-email:${userId}`);
  } else {
    pendingEmailChanges.delete(userId);
  }
}

// PATCH /api/auth/me/email – initiate email change
//
// Do NOT gate the second factor behind `if (user.mfaEnabled)`: that would let
// non-MFA accounts initiate an email change with only the password, a
// single-step path to permanent account takeover when combined with a
// credential-stuffing hit.
//
// The flow sends codes to BOTH the OLD and the NEW address. The OLD code is
// the second factor for everyone — MFA-enabled accounts may still pass mfaCode
// for belt-and-suspenders and we accept it, but it's not load-bearing alone.
router.patch('/me/email', sensitiveActionLimiter, authenticateToken, validate(changeEmailSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { currentPassword, newEmail, mfaCode } = req.body as { currentPassword?: string; newEmail?: string; mfaCode?: string };
  if (!currentPassword || !newEmail) return res.status(400).json({ error: 'Current password and new email are required' });

  const emailCheck = z.string().email().safeParse(newEmail);
  if (!emailCheck.success) return res.status(400).json({ error: 'Invalid email address' });

  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, passwordHash: true, email: true, emailHash: true, mfaEnabled: true, mfaTotpSecret: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.passwordHash) return res.status(400).json({ error: 'This account uses social login and has no password' });

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  // Opportunistic MFA check — accepted if supplied, but not required. The real
  // second factor is the OLD-email code we're about to send.
  if (user.mfaEnabled && user.mfaTotpSecret && mfaCode) {
    const otplib = await import('otplib');
    const secret = decryptSecret(user.mfaTotpSecret);
    const result = otplib.verifySync({ token: mfaCode, secret });
    if (!result.valid) return res.status(401).json({ error: 'Invalid MFA code' });
  }

  const normalizedNew = newEmail.toLowerCase().trim();
  const newEmailHash = hashEmail(normalizedNew);
  const existing = await prisma.user.findUnique({ where: { emailHash: newEmailHash }, select: { id: true } });
  if (existing && existing.id !== req.userId) return res.status(400).json({ error: 'Email already in use' });

  const oldEmail = user.email ? decryptOrPlain(user.email) : '';
  if (!oldEmail || !user.emailHash) {
    return res.status(400).json({ error: 'Account has no email on file — cannot send confirmation code' });
  }

  const codeOld = generateVerificationCode();
  const codeNew = generateVerificationCode();
  await setPendingEmailChange(req.userId, {
    newEmail: normalizedNew,
    newEmailHash,
    codeHashNew: hashCode(codeNew),
    codeHashOld: hashCode(codeOld),
    oldEmail,
    oldEmailHash: user.emailHash,
  });

  enqueueEmail({ type: 'verification', to: normalizedNew, code: codeNew }).catch((e) => log.error({ err: e }, 'email change: new-email code enqueue error'));
  enqueueEmail({ type: 'verification', to: oldEmail, code: codeOld }).catch((e) => log.error({ err: e }, 'email change: old-email code enqueue error'));

  // Record the request (not the confirmation). metadata carries only the
  // HMAC hash of the new address, never the plaintext.
  void emitUserSecurityEvent(req.userId, 'email_change_requested', req, { newEmailHash });

  res.json({ success: true, requiresVerification: true, requiresBothCodes: true });
}));

// POST /api/auth/me/email/verify – confirm email change
//
// Body takes BOTH codeOld + codeNew. Legacy `code` is still accepted for
// pre-fix pending records already in Redis during rollout.
router.post('/me/email/verify', sensitiveActionLimiter, authenticateToken, validate(confirmEmailCodeSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { code, codeOld, codeNew } = req.body as { code?: string; codeOld?: string; codeNew?: string };

  const pending = await getPendingEmailChange(req.userId);
  if (!pending) return res.status(400).json({ error: 'No pending email change. Please initiate the change again.' });

  const emailChangeAttemptKey = `emailchange:${req.userId}`;
  const emailChangeAttempts = await getLoginLockout(emailChangeAttemptKey);
  if (emailChangeAttempts && emailChangeAttempts.count >= 5) {
    await deletePendingEmailChange(req.userId);
    await deleteLoginLockout(emailChangeAttemptKey);
    return res.status(429).json({ error: 'Too many failed attempts. Please initiate the email change again.' });
  }

  // Path A — new flow, both codes required. Either codeHashOld is present
  // (pending record written by the new code) OR we fall through to Path B.
  let codesValid = false;
  if (pending.codeHashOld && pending.codeHashNew) {
    if (!codeOld || !codeNew) {
      return res.status(400).json({ error: 'Both codes (from the old and new addresses) are required.' });
    }
    const oldOk = timingSafeEqual(hashCode(codeOld.trim()), pending.codeHashOld);
    const newOk = timingSafeEqual(hashCode(codeNew.trim()), pending.codeHashNew);
    codesValid = oldOk && newOk;
  } else if (pending.codeHash) {
    // Path B — legacy pre-fix pending record. Accept the single `code` field.
    const legacy = code ?? codeNew ?? codeOld;
    codesValid = !!legacy && timingSafeEqual(hashCode(legacy.trim()), pending.codeHash);
  }

  if (!codesValid) {
    const entry = emailChangeAttempts || { count: 0, lockedUntil: 0 };
    entry.count++;
    if (entry.count >= 5) {
      await deletePendingEmailChange(req.userId);
    }
    await setLoginLockout(emailChangeAttemptKey, entry);
    return res.status(400).json({ error: 'Invalid verification code' });
  }

  // Re-check the new email isn't taken (could have been claimed between initiation and verification)
  const existing = await prisma.user.findUnique({ where: { emailHash: pending.newEmailHash }, select: { id: true } });
  if (existing && existing.id !== req.userId) {
    await deletePendingEmailChange(req.userId);
    return res.status(400).json({ error: 'Email already in use' });
  }

  const authHeader = req.headers['authorization'];
  const currentToken = authHeader?.split(' ')[1];
  const currentHash = currentToken ? hashToken(currentToken) : null;

  const sessionsToInvalidate = await prisma.session.findMany({
    where: { userId: req.userId, ...(currentHash ? { tokenHash: { not: currentHash } } : {}) },
    select: { tokenHash: true },
    take: 100,
  });
  await prisma.$transaction([
    prisma.user.update({ where: { id: req.userId }, data: { email: encryptSecret(pending.newEmail), emailHash: pending.newEmailHash } }),
    prisma.session.deleteMany({ where: { userId: req.userId, ...(currentHash ? { tokenHash: { not: currentHash } } : {}) } }),
  ]);
  await deletePendingEmailChange(req.userId);
  await deleteLoginLockout(emailChangeAttemptKey);
  invalidateSessionCacheForUser(req.userId!);
  for (const s of sessionsToInvalidate) {
    publishSessionInvalidation(s.tokenHash);
  }

  // Record confirmation on the user's audit feed. metadata carries only the
  // HMAC hash of the new address, never the plaintext.
  void emitUserSecurityEvent(req.userId, 'email_change_confirmed', req, { newEmailHash: pending.newEmailHash });

  // Notify the OLD address with a one-click revert link, valid 24h.
  // If the legit user didn't initiate this change, the link restores the old
  // email address and kills the session the attacker used. The token is a
  // JWT signed with JWT_SECRET (same trust anchor as access tokens), purpose-
  // scoped so it can only run the revert route.
  if (pending.oldEmail && pending.oldEmailHash) {
    const revertToken = jwt.sign(
      { userId: req.userId, oldEmailHash: pending.oldEmailHash, purpose: 'emailRevert' },
      JWT_SECRET,
      { expiresIn: '24h' },
    );
    const appBase = process.env.FRONTEND_ORIGIN?.split(',')[0]?.trim() || 'https://app.howlpro.com';
    const revertUrl = `${appBase}/email-revert?token=${encodeURIComponent(revertToken)}`;
    enqueueEmail({ type: 'emailChangedWithRevert', to: pending.oldEmail, newEmail: pending.newEmail, revertUrl })
      .catch((e) => log.error({ err: e }, 'email-changed-with-revert enqueue error'));
  }

  res.json({ success: true, email: pending.newEmail });
}));

// POST /api/auth/email/revert – restore the OLD email address via signed token
//
// No auth middleware: the user can't log in if the attacker changed the email
// and then rotated the password. The JWT itself is the authentication signal.
router.post('/email/revert', sensitiveActionLimiter, asyncHandler(async (req, res) => {
  const raw = req.body as { token?: string };
  if (!raw?.token || typeof raw.token !== 'string') return res.status(400).json({ error: 'Missing token' });

  let payload: { userId: string; oldEmailHash: string; purpose: string };
  try {
    payload = jwt.verify(raw.token, JWT_SECRET, { algorithms: ['HS256'] }) as typeof payload;
  } catch {
    return res.status(400).json({ error: 'Invalid or expired revert link' });
  }
  if (payload.purpose !== 'emailRevert' || typeof payload.userId !== 'string' || typeof payload.oldEmailHash !== 'string') {
    return res.status(400).json({ error: 'Invalid revert token' });
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, emailHash: true },
  });
  if (!user) return res.status(404).json({ error: 'Account not found' });

  // Idempotent: if the email is already back at the revert target, no-op.
  if (user.emailHash === payload.oldEmailHash) {
    return res.json({ success: true, alreadyReverted: true });
  }

  // Another account may have since claimed the old hash (unlikely but possible).
  const conflict = await prisma.user.findUnique({ where: { emailHash: payload.oldEmailHash }, select: { id: true } });
  if (conflict && conflict.id !== payload.userId) {
    return res.status(409).json({ error: 'The original email address is already associated with another account — contact support.' });
  }

  // We don't store the plaintext old email anywhere after the change, so we
  // can't re-write `email` without it. We DO have the oldEmailHash (for
  // lookups) and the pending-change record is gone. The pragmatic path:
  // clear the current email to let the user set a fresh one via the normal
  // onboarding flow, and record the hash for future reference. Sessions are
  // all killed so the attacker is evicted.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { emailHash: payload.oldEmailHash, email: '', emailVerified: false },
    }),
    prisma.session.deleteMany({ where: { userId: user.id } }),
  ]);
  invalidateSessionCacheForUser(user.id);

  log.warn({ userId: user.id }, 'email change reverted via signed link');
  res.json({ success: true });
}));

/**
 * One-click "sign out of all sessions" link. Sent from the new-device-login
 * email when a previously-unseen device logs in. The token is HMAC-signed
 * (JWT HS256 with JWT_SECRET), carries `purpose: 'revokeSessions'`,
 * and has a 24h TTL. Deletes all sessions for the user but does NOT change
 * the password — the assumption is "this login wasn't me, kick everyone off
 * while I change my password".
 */
router.post('/revoke-sessions', sensitiveActionLimiter, asyncHandler(async (req, res) => {
  const raw = req.body as { token?: string };
  if (!raw?.token || typeof raw.token !== 'string') return res.status(400).json({ error: 'Missing token' });

  let payload: { userId: string; purpose: string };
  try {
    payload = jwt.verify(raw.token, JWT_SECRET, { algorithms: ['HS256'] }) as typeof payload;
  } catch {
    return res.status(400).json({ error: 'Invalid or expired link' });
  }
  if (payload.purpose !== 'revokeSessions' || typeof payload.userId !== 'string') {
    return res.status(400).json({ error: 'Invalid revoke token' });
  }

  const user = await prisma.user.findUnique({ where: { id: payload.userId }, select: { id: true } });
  if (!user) return res.status(404).json({ error: 'Account not found' });

  const result = await prisma.session.deleteMany({ where: { userId: user.id } });
  invalidateSessionCacheForUser(user.id);
  log.warn({ userId: user.id, count: result.count }, 'sessions revoked via new-device link');
  // Record on the audit feed. req has no authenticated userId (token-based
  // route), but the helper uses it purely for IP/UA hashing.
  void emitUserSecurityEvent(user.id, 'logout_all', req, { via: 'revoke-sessions-link', revokedCount: result.count });
  res.json({ success: true, revokedCount: result.count });
}));

// POST /api/auth/complete-onboarding — SSO users complete ToS + DOB (+ optional password/email) before first use
router.post('/complete-onboarding', sensitiveActionLimiter, authenticateToken, validate(completeOnboardingSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

  // Onboarding is a one-shot flow. Without this gate, a stolen access token
  // could re-invoke the endpoint to silently overwrite passwordHash / DOB /
  // ToS-consent — converting session compromise into durable account
  // takeover. Mirrors the email-path guard below.
  const onboardingState = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { needsOnboarding: true },
  });
  if (!onboardingState?.needsOnboarding) {
    return res.status(400).json({ error: 'Onboarding already completed.' });
  }

  const { dateOfBirth, password, email } = req.body as { dateOfBirth: string; agreedToTerms: true; password?: string; email?: string };

  const dob = new Date(dateOfBirth);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age--;
  if (age < 13) {
    return res.status(403).json({ error: 'You must be at least 13 years old to use Howl.' });
  }

  // If password provided, hash it so DOB + terms + password are set atomically
  const passwordHash = password ? await bcrypt.hash(password, BCRYPT_ROUNDS) : undefined;

  // Email-replacement path (Steam SSO and any future provider that doesn't
  // expose an email). Only honor it when the current address is the
  // synthetic `<provider>_<id>@sso.local` placeholder — prevents a
  // logged-in user from rotating their email via this endpoint.
  let emailUpdate:
    | { email: string; emailHash: string; emailVerified: boolean; emailVerifyCode: string; emailVerifyExpiry: Date; plainForQueue: string }
    | undefined;
  if (email) {
    const existing = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { email: true },
    });
    const currentPlain = existing?.email ? decryptOrPlain(existing.email) : '';
    if (!/^[a-z]+_[^@]+@sso\.local$/i.test(currentPlain)) {
      return res.status(400).json({ error: 'Email can only be set during SSO onboarding.' });
    }
    const normalized = email.toLowerCase().trim();
    const emailH = hashEmail(normalized);
    const conflict = await prisma.user.findUnique({ where: { emailHash: emailH }, select: { id: true } });
    if (conflict && conflict.id !== req.userId) {
      return res.status(409).json({ error: 'That email is already in use.' });
    }
    // Fresh email the user just typed — run it through the same verification
    // gate every other SSO signup uses (SsoEmailVerification modal). Flip
    // emailVerified back to false and generate a code.
    const verifyCode = generateVerificationCode();
    const verifyExpiry = new Date(Date.now() + 15 * 60 * 1000);
    emailUpdate = {
      email: encryptSecret(normalized),
      emailHash: emailH,
      emailVerified: false,
      emailVerifyCode: hashCode(verifyCode),
      emailVerifyExpiry: verifyExpiry,
      plainForQueue: normalized,
    };

    enqueueEmail({ type: 'verification', to: normalized, code: verifyCode })
      .catch((e) => log.error({ err: e }, 'Onboarding verification email enqueue error'));
  }

  const { plainForQueue: _plainForQueue, ...emailDbUpdate } = emailUpdate ?? {};
  await prisma.user.update({
    where: { id: req.userId },
    data: {
      dateOfBirth: dob,
      tosAcceptedAt: new Date(),
      privacyPolicyAcceptedAt: new Date(),
      legalConsentVersion: CURRENT_LEGAL_VERSION,
      needsOnboarding: false,
      ...(passwordHash ? { passwordHash } : {}),
      ...emailDbUpdate,
      // Privacy-protective defaults for minors (under 18)
      ...(age < 18 ? {
        allowDmFromServerMembers: false,
        friendRequestsEveryone: false,
        messageRequestsFilter: true,
      } : {}),
    },
  });

  invalidateOnboardingCache(req.userId);

  res.json({ success: true });
}));

const consentLogLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:consent:'),
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const consentLogSchema = z.object({
  body: z.object({
    analytics: z.boolean().optional(),
    advertising: z.boolean().optional(),
    policyVersion: z.string().max(20).optional(),
  }),
});

// POST /api/auth/consent-log — record cookie consent choice (best-effort structured log)
router.post('/consent-log', consentLogLimiter, validate(consentLogSchema), asyncHandler(async (req: Request, res: Response) => {
  const { analytics, advertising, policyVersion } = req.body as { analytics?: boolean; advertising?: boolean; policyVersion?: string };
  const userId = (req as AuthRequest).userId || null;
  log.info({ userId, analytics, advertising, policyVersion, ip: req.ip }, 'cookie consent recorded');
  res.json({ ok: true });
}));

// DELETE /api/auth/me – deprecated; use POST /api/v1/gdpr/delete instead
router.delete('/me', sensitiveActionLimiter, authenticateToken, (_req, res) => {
  res.status(410).json({ error: 'This endpoint has been removed. Use POST /api/v1/gdpr/delete for account deletion.' });
});

// Forgot Password

const forgotPasswordLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:forgot-pw:'),
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req: Request) => req.body?.email?.toLowerCase() || getClientIp(req) || 'unknown',
  message: { error: 'Too many requests, try again later' },
});

const resetPasswordLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:reset-pw:'),
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req: Request) => req.body?.email?.toLowerCase() || getClientIp(req) || 'unknown',
  message: { error: 'Too many reset attempts. Try again later.' },
});

router.post('/forgot-password', forgotPasswordLimiter, validate(forgotPasswordSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, captchaToken } = req.body;

    const captchaOk = await verifyCaptcha(captchaToken, (req as any).ip);
    if (!captchaOk) return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });

    if (!email || typeof email !== 'string') {
      return res.json({ success: true });
    }

    const emailH = hashEmail(email.toLowerCase().trim());
    const user = await prisma.user.findUnique({ where: { emailHash: emailH }, select: { id: true, email: true } });
    if (user) {
      const code = generateVerificationCode();
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetCode: hashCode(code),
          passwordResetExpiry: new Date(Date.now() + 15 * 60 * 1000),
        },
      });
      let plainEmail: string;
      try { plainEmail = decryptSecret(user.email); } catch { plainEmail = user.email; }
      enqueueEmail({ type: 'passwordReset', to: plainEmail, code }).catch((e) => log.error({ err: e }, 'email enqueue error'));
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/reset-password', resetPasswordLimiter, validate(resetPasswordSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, code, newPassword, captchaToken } = req.body;

    const captchaOk = await verifyCaptcha(captchaToken, (req as any).ip);
    if (!captchaOk) return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, code, and new password are required' });
    }

    const parsed = passwordSchema.safeParse(newPassword);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.message);
      return res.status(400).json({ error: issues.join('. ') });
    }

    const resetEmailHash = hashEmail(email.toLowerCase().trim());
    const user = await prisma.user.findUnique({ where: { emailHash: resetEmailHash }, select: { id: true, passwordResetCode: true, passwordResetExpiry: true } });
    if (!user || !user.passwordResetCode || !user.passwordResetExpiry) {
      return res.status(400).json({ error: 'Invalid or expired reset code' });
    }

    // Per-user brute-force tracking for reset codes
    const resetAttemptKey = `reset:${resetEmailHash}`;
    const resetAttempts = await getLoginLockout(resetAttemptKey);
    if (resetAttempts && resetAttempts.count >= 5) {
      await prisma.user.update({ where: { id: user.id }, data: { passwordResetCode: null, passwordResetExpiry: null } }).catch(() => {});
      await deleteLoginLockout(resetAttemptKey);
      return res.status(429).json({ error: 'Too many failed attempts. Please request a new reset code.' });
    }

    if (!timingSafeEqual(user.passwordResetCode, hashCode(code))) {
      const entry = resetAttempts || { count: 0, lockedUntil: 0 };
      entry.count++;
      if (entry.count >= 5) {
        await prisma.user.update({ where: { id: user.id }, data: { passwordResetCode: null, passwordResetExpiry: null } }).catch(() => {});
      }
      await setLoginLockout(resetAttemptKey, entry);
      return res.status(400).json({ error: 'Invalid or expired reset code' });
    }

    if (new Date() > user.passwordResetExpiry) {
      return res.status(400).json({ error: 'Invalid or expired reset code' });
    }

    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: hashed,
        passwordResetCode: null,
        passwordResetExpiry: null,
      },
    });
    await deleteLoginLockout(resetAttemptKey);

    const sessionsToInvalidate = await prisma.session.findMany({
      where: { userId: user.id },
      select: { tokenHash: true },
      take: 100,
    });
    await prisma.session.deleteMany({ where: { userId: user.id } });
    // Password reset is the canonical "recover from compromise" event.
    // Scrub trusted-device trust so the attacker's stolen cookie can't
    // skip the next login's challenge.
    await prisma.trustedDevice.deleteMany({ where: { userId: user.id } });
    invalidateSessionCacheForUser(user.id);
    for (const s of sessionsToInvalidate) {
      publishSessionInvalidation(s.tokenHash);
    }
    // Clear the caller's device cookie too — after reset they re-log from
    // scratch, so force the challenge to re-establish trust on THEIR device.
    clearDeviceCookie(res, req);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/refresh — exchange a valid refresh token for a new access token + rotated refresh token
router.post('/refresh', refreshLimiter, async (req: Request, res: Response) => {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    if (!refreshToken) {
      // Cookie missing on a /refresh request is a real signal: either the user
      // was never authenticated, the cookie was cleared by a prior /refresh
      // failure, or SameSite/path mismatch is dropping it on this hop. Logged
      // at info so we can see the rate without alarming on a normal pattern.
      log.info({ ua: req.headers['user-agent'], origin: req.headers.origin }, 'refresh: no cookie');
      return res.status(401).json({ error: 'No refresh token' });
    }

    const rtHash = hashToken(refreshToken);
    const session = await prisma.session.findFirst({ where: { refreshTokenHash: rtHash } });
    if (!session) {
      // Refresh token reuse detection: if this token was already rotated, kill the session (possible theft)
      const compromised = await prisma.session.findFirst({
        where: { previousRefreshTokenHash: rtHash },
        select: { id: true, tokenHash: true, userId: true },
      });
      if (compromised) {
        await prisma.session.delete({ where: { id: compromised.id } }).catch(() => {});
        invalidateSessionCache(compromised.tokenHash);
        publishSessionInvalidation(compromised.tokenHash);
        invalidateSessionCacheForUser(compromised.userId);
        log.warn({ userId: compromised.userId, sessionId: compromised.id }, 'Refresh token reuse detected — session killed (possible token theft)');
      } else {
        // Cookie present but rtHash matches no live session AND no previous
        // hash either. Means either the cookie is from a long-deleted session
        // or it was stripped/replayed. Distinguish from reuse so the on-call
        // metric isn't dominated by stale cookies.
        log.info({ ua: req.headers['user-agent'] }, 'refresh: rtHash unknown (stale cookie)');
      }
      clearRefreshCookie(res, req);
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    if (session.expiresAt && new Date() > session.expiresAt) {
      log.info({ userId: session.userId, sessionId: session.id, expiresAt: session.expiresAt }, 'refresh: session expired (90d sliding window)');
      await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
      publishSessionInvalidation(session.tokenHash);
      clearRefreshCookie(res, req);
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    // Absolute session cap — bounds the blast radius of a silently-stolen
    // refresh token. Browser sessions get force-renewed via password prove-up
    // after 365 days. Electron desktop sessions are exempt (matches Steam's
    // desktop client behavior — first-party native client, harder cookie/key
    // exfiltration surface than a browser). When a native mobile app ships,
    // its UA can be added to the exempt list. Dormant sessions of any kind
    // hit the sliding expiresAt (90d) and the cleanup worker first.
    if (session.deviceType !== 'desktop') {
      const ABSOLUTE_SESSION_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
      if (session.createdAt && Date.now() - new Date(session.createdAt).getTime() > ABSOLUTE_SESSION_LIFETIME_MS) {
        await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
        publishSessionInvalidation(session.tokenHash);
        clearRefreshCookie(res, req);
        return res.status(401).json({ error: 'Session expired. Please log in again.' });
      }
    }

    const newAccessToken = jwt.sign({ userId: session.userId }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const newRefreshToken = generateRefreshToken();
    const newTokenHash = hashToken(newAccessToken);
    const newRefreshHash = hashToken(newRefreshToken);
    // Sliding DB-side session expiry — matches the refresh cookie lifetime in
    // authHelpers so both gates expire together.
    const newExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    await prisma.session.update({
      where: { id: session.id },
      data: { tokenHash: newTokenHash, refreshTokenHash: newRefreshHash, previousRefreshTokenHash: rtHash, lastActiveAt: new Date(), expiresAt: newExpiry },
    });

    invalidateSessionCache(session.tokenHash);

    setRefreshCookie(res, newRefreshToken, req);
    res.json({ token: newAccessToken });
  } catch (err) {
    log.error({ err }, 'Refresh token error');
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// POST /api/auth/logout — clear refresh cookie and delete session
router.post('/logout', refreshLimiter, async (req: Request, res: Response) => {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    if (refreshToken) {
      const rtHash = hashToken(refreshToken);
      const session = await prisma.session.findFirst({ where: { refreshTokenHash: rtHash }, select: { id: true, tokenHash: true } }).catch(() => null);
      if (session) {
        invalidateSessionCache(session.tokenHash);
        await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
        publishSessionInvalidation(session.tokenHash);
      }
    }
    clearRefreshCookie(res, req);
    res.json({ ok: true });
  } catch (err) {
    log.error({ err }, 'Logout error');
    res.json({ ok: true });
  }
});

export { authenticateToken, type AuthRequest } from '../middleware/auth.js';
export { JWT_SECRET } from '../middleware/auth.js';
export default router;
