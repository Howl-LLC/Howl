// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { createSession, generateRefreshToken } from '../utils/sessionUtils.js';
import { JWT_SECRET, authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { appleCallbackSchema, ssoExchangeCodeSchema, ssoLinkTokenSchema } from '../schemas.js';
import { logger } from '../logger.js';
import { hashEmail, encryptSecret, decryptSecret } from '../services/mfaCrypto.js';
import { redis } from '../redis.js';
import { setRefreshCookie, setDeviceCookie, sensitiveActionLimiter } from './authHelpers.js';
import { issueTrustedDevice } from '../services/trustedDevice.js';
import { storeSsoCode, consumeSsoCode, type SsoSessionEntry, type SsoMfaEntry } from '../utils/ssoCode.js';
import { generateVerificationCode } from '../services/email.js';
import { enqueueEmail } from '../queues/producers.js';
import { hashCode } from './auth.js';
import crypto from 'crypto';
import { emitUserSecurityEvent } from '../services/securityEvents.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'sso' });

const router = Router();

// LIST LINKED SSO ACCOUNTS
router.get('/accounts', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const accounts = await prisma.ssoAccount.findMany({
      where: { userId: req.userId! },
      select: { id: true, provider: true, email: true, displayName: true, avatarUrl: true },
      take: 10,
    });
    const decrypted = accounts.map(a => {
      let email: string | null = a.email;
      if (a.email) {
        try { email = decryptSecret(a.email); } catch { /* legacy unencrypted or corrupt */ }
      }
      return { ...a, email };
    });
    res.json(decrypted);
  } catch (err) {
    log.error({ err }, 'Failed to list SSO accounts');
    res.status(500).json({ error: 'Failed to load connections' });
  }
});

// UNLINK AN SSO ACCOUNT
router.delete('/accounts/:accountId', validateUuidParams('accountId'), authenticateToken, sensitiveActionLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.params.accountId as string;
    const account = await prisma.ssoAccount.findFirst({
      where: { id: accountId, userId: req.userId! },
    });
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { passwordHash: true } });
    const totalSso = await prisma.ssoAccount.count({ where: { userId: req.userId! } });
    if (!user?.passwordHash && totalSso <= 1) {
      return res.status(400).json({ error: 'Cannot unlink your only sign-in method. Set a password first.' });
    }

    await prisma.ssoAccount.delete({ where: { id: accountId } });
    res.json({ ok: true });
  } catch (err) {
    log.error({ err }, 'Failed to unlink SSO account');
    res.status(500).json({ error: 'Failed to unlink' });
  }
});

// GENERATE LINK TOKEN (for connecting SSO to existing account)
router.post('/link-token', sensitiveActionLimiter, authenticateToken, validate(ssoLinkTokenSchema), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { provider } = req.body as { provider: string };
    const existing = await prisma.ssoAccount.findFirst({
      where: { userId: req.userId, provider },
    });
    if (existing) return res.status(400).json({ error: `${provider} is already connected to your account.` });
    const linkToken = jwt.sign({ userId: req.userId, provider, purpose: 'sso-link' }, JWT_SECRET, { expiresIn: '5m' });
    res.json({ linkToken });
  } catch (err) {
    log.error({ err }, 'Link token generation error');
    res.status(500).json({ error: 'Failed to generate link token' });
  }
});

const FRONTEND_URL = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000').split(',')[0].trim();

const exchangeCodeLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:sso-exchange:'),
  windowMs: 60 * 1000,
  max: 50,
  message: { error: 'Too many code exchange attempts.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/exchange-code', exchangeCodeLimiter, validate(ssoExchangeCodeSchema), async (req: Request, res: Response) => {
  const { code } = req.body as { code: string };

  const entry = await consumeSsoCode(code);
  if (!entry) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }

  // MFA-enrolled users get a step-up challenge instead of a session. The
  // client hands the mfaToken back to /totp/verify (or the passkey / sms
  // equivalents), which mints the access token + refresh cookie. No device
  // trust is issued on this branch.
  if (entry.kind === 'mfa') {
    return res.json({ mfaRequired: true, mfaToken: entry.mfaToken, methods: entry.methods });
  }

  if (entry.refreshToken) {
    setRefreshCookie(res, entry.refreshToken, req);
  }
  // SSO logins without MFA establish device trust — the OAuth provider
  // verified the user's identity and they chose not to add a second factor.
  // Setting the howl_device_id cookie here means a subsequent password
  // login from the same browser skips the email-code challenge.
  if (entry.deviceToken) {
    setDeviceCookie(res, entry.deviceToken, req);
  }
  res.json({ token: entry.token });
});

async function findOrCreateSsoUser(
  provider: string,
  providerId: string,
  email: string | null,
  displayName: string | null,
  req: Request,
  // NOTE: we intentionally ignore the SSO provider's "email_verified" claim.
  // SSO registrations are always gated through the same email-verification
  // modal as email registrations, so users prove inbox access to OUR code
  // rather than us trusting Google/Apple. The only exception is synthetic
  // @sso.local emails (e.g. Steam) — there's nothing to verify.
  _providerClaimsEmailVerified = true,
): Promise<SsoSessionEntry | SsoMfaEntry> {
  const existing = await prisma.ssoAccount.findUnique({
    where: { provider_providerId: { provider, providerId } },
    include: {
      user: {
        select: {
          id: true, suspended: true, deactivated: true, status: true,
          emailHash: true, mfaEnabled: true, mfaTotpSecret: true,
          mfaPhone: true, mfaPhoneVerified: true,
        },
      },
    },
  });

  if (existing) {
    if (existing.user.suspended) {
      throw new Error('Your account has been suspended. Please contact support for more information.');
    }
    if (existing.user.deactivated) {
      await prisma.user.update({
        where: { id: existing.user.id },
        data: { deactivated: false, deactivatedAt: null, status: 'online' },
      });
    }
    // If the user enrolled TOTP/SMS on Howl, require a step-up challenge
    // before issuing a session. An SSO provider's own 2FA is not a
    // substitute — the user selected TOTP specifically to defeat upstream
    // credential compromise of the linked Google/Apple/Steam account.
    //
    // Passkey is intentionally NOT offered here. On the email/password path a
    // passkey acts as a phishing-resistant second factor, but under SSO the
    // IdP has already established the user's identity with a primary
    // credential of at least equivalent strength. Asking for a passkey tap on
    // top of a completed OAuth flow is cosmetic security theater and a major
    // UX friction. Users who want extra assurance on SSO logins should enroll
    // TOTP/SMS (those proofs aren't something an attacker with access to the
    // linked Google/Apple account can perform).
    //
    // Passkey-only users therefore fall through to the session-issuance path
    // below — this is a deliberate tradeoff. Audit trail distinguishes the
    // two cases via distinct `securityEvent` values.
    if (existing.user.mfaEnabled) {
      const methods: string[] = [];
      if (existing.user.mfaTotpSecret) methods.push('totp');
      if (existing.user.mfaPhoneVerified && existing.user.mfaPhone && process.env.SMS_PROVIDER_CONFIGURED) methods.push('sms');

      if (methods.length > 0) {
        const mfaToken = jwt.sign(
          { userId: existing.user.id, purpose: 'mfa', emailHash: existing.user.emailHash },
          JWT_SECRET,
          { expiresIn: '5m' },
        );
        log.info({ securityEvent: 'sso_mfa_challenge', userId: existing.user.id, provider, methods }, 'SSO login requires MFA step-up');
        // Do NOT issue a trusted-device cookie or session here.
        // /totp/verify mints the session after the second factor succeeds.
        return { kind: 'mfa', mfaToken, methods };
      }
      log.info({ securityEvent: 'sso_mfa_skipped_passkey_only', userId: existing.user.id, provider }, 'SSO login skipped MFA step-up (passkey-only user — SSO IdP satisfies primary auth)');
      // fall through to session issuance
    }

    if (existing.user.status === 'offline') {
      await prisma.user.update({ where: { id: existing.user.id }, data: { status: 'online' } });
    }
    const token = jwt.sign({ userId: existing.user.id }, JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = generateRefreshToken();
    // Auto-trust the device — OAuth provider already verified the user.
    const ua = (req.headers['user-agent'] ?? 'Unknown') as string;
    const rawIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip ?? null;
    let deviceToken: string | undefined;
    let trustedDeviceId: string | undefined;
    try {
      const issued = await issueTrustedDevice(existing.user.id, ua, rawIp);
      deviceToken = issued.rawCookieToken;
      trustedDeviceId = issued.device.id;
    } catch (err) {
      log.warn({ err, userId: existing.user.id }, 'SSO auto-trust failed');
    }
    await createSession(existing.user.id, token, req, refreshToken, trustedDeviceId ?? null).catch(() => {});
    // SSO login success. Provider name is safe metadata; it's visible in the
    // user's Connected Apps tab already.
    void emitUserSecurityEvent(existing.user.id, 'login_success', req, { via: 'sso', provider });
    if (trustedDeviceId) {
      void emitUserSecurityEvent(existing.user.id, 'login_new_device', req, { via: 'sso', provider });
    }
    return { kind: 'session', token, refreshToken, deviceToken };
  }

  // DO NOT auto-link SSO to existing email accounts — prevents account takeover.
  // Users must explicitly link SSO from their account settings.

  // Check if an account with this email already exists (different SSO provider).
  // Do NOT auto-link — that would be an account takeover vulnerability.
  // Instead, tell the user to log into their existing account and link from Settings.
  const rawEmailCheck = (email || `${provider}_${providerId}@sso.local`).toLowerCase().trim();
  const emailHashCheck = hashEmail(rawEmailCheck);
  const existingByEmail = await prisma.user.findUnique({
    where: { emailHash: emailHashCheck },
    select: { id: true },
  });
  if (existingByEmail) {
    throw new Error('An account with this email already exists. Please sign in with your existing account and connect this provider from Settings → Connections.');
  }

  // Create new user — sanitize display name from SSO provider (strip control chars, RTL overrides, homoglyphs)
  // eslint-disable-next-line no-control-regex
  const sanitized = displayName?.trim().replace(/[\x00-\x1F\x7F\u200E\u200F\u202A-\u202E\u2066-\u2069\uFFF9-\uFFFB]/g, '').slice(0, 32);
  const username = (sanitized && sanitized.length >= 2) ? sanitized : `user_${providerId.slice(0, 8)}`;
  const rawEmail = (email || `${provider}_${providerId}@sso.local`).toLowerCase().trim();

  // All SSO registrations with a real email are treated as unverified so the
  // user is gated through the same SsoEmailVerification modal as email
  // registrations. Synthetic SSO emails (e.g. Steam's @sso.local) have nothing
  // to verify against — keep them pre-verified.
  const hasRealEmail = !!email && !rawEmail.endsWith('@sso.local');
  const emailVerified = !hasRealEmail;
  const verifyCode = hasRealEmail ? generateVerificationCode() : null;
  const verifyExpiry = verifyCode ? new Date(Date.now() + 15 * 60 * 1000) : null;

  const MAX_DISCRIM_RETRIES = 10;
  let user: any;
  for (let attempt = 0; attempt < MAX_DISCRIM_RETRIES; attempt++) {
    const discriminator = crypto.randomInt(10000).toString().padStart(4, '0');
    try {
      user = await prisma.user.create({
        data: {
          username,
          discriminator,
          email: encryptSecret(rawEmail),
          emailHash: hashEmail(rawEmail),
          passwordHash: null,
          emailVerified,
          ...(verifyCode ? { emailVerifyCode: hashCode(verifyCode), emailVerifyExpiry: verifyExpiry } : {}),
          status: 'online',
          needsOnboarding: true,
          ssoAccounts: { create: { provider, providerId, email: email ? encryptSecret(email) : null } },
        },
      });
      break;
    } catch (createErr: any) {
      if (createErr?.code === 'P2002') {
        const fields = createErr.meta?.target;
        if (Array.isArray(fields) && fields.includes('emailHash')) {
          throw new Error('An account with this email already exists. Please sign in with your existing account and connect this provider from Settings → Connections.', { cause: createErr });
        }
        if (attempt === MAX_DISCRIM_RETRIES - 1) {
          throw new Error('All discriminators for this username are taken. Please try a different name.', { cause: createErr });
        }
        continue;
      }
      throw createErr;
    }
  }

  // Send verification email for providers that don't pre-verify the email
  if (verifyCode && email) {
    enqueueEmail({ type: 'verification', to: rawEmail, code: verifyCode })
      .catch((e) => log.error({ err: e }, 'SSO verification email enqueue error'));
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = generateRefreshToken();
  // Auto-trust the signup device so the user isn't challenged on the next
  // login from this browser (they just verified via OAuth).
  const ua = (req.headers['user-agent'] ?? 'Unknown') as string;
  const rawIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip ?? null;
  let deviceToken: string | undefined;
  let trustedDeviceId: string | undefined;
  try {
    const issued = await issueTrustedDevice(user.id, ua, rawIp);
    deviceToken = issued.rawCookieToken;
    trustedDeviceId = issued.device.id;
  } catch (err) {
    log.warn({ err, userId: user.id }, 'SSO signup auto-trust failed');
  }
  await createSession(user.id, token, req, refreshToken, trustedDeviceId ?? null).catch(() => {});
  // First-ever login for this SSO-provisioned account.
  void emitUserSecurityEvent(user.id, 'login_success', req, { via: 'sso', provider, signup: true });
  void emitUserSecurityEvent(user.id, 'login_new_device', req, { via: 'sso', provider, signup: true });
  // Scope note: a newly-created SSO user has mfaEnabled:false by default, so
  // signup can't reach an MFA-enrolled account — the email-existence check
  // above rejects reuse of a pre-existing email. Auto-trust is retained here
  // for onboarding UX.
  return { kind: 'session', token, refreshToken, deviceToken };
}

/** Map findOrCreateSsoUser error messages to frontend-safe error codes. */
function classifySsoError(err: any): string {
  const msg = err?.message || '';
  if (msg.includes('already exists')) return 'email_exists';
  if (msg.includes('suspended')) return 'suspended';
  if (msg.includes('discriminators')) return 'username_unavailable';
  return 'sso_failed';
}

/**
 * Serve an HTML page that auto-fires a howl:// deep link to the Electron app.
 * Shows a branded success message instead of leaving the tab at an unrenderable howl:// URL.
 */
function sendElectronRedirectPage(res: Response, deepLinkUrl: string): void {
  if (!deepLinkUrl.startsWith('howl://')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(400).send('Invalid redirect protocol');
    return;
  }

  const urlForAttr = deepLinkUrl
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const urlForJs = deepLinkUrl
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Howl</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#020617;color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center}
.c{padding:48px 32px;border-radius:16px;background:rgba(15,23,42,0.8);
border:1px solid rgba(7,111,160,0.15);max-width:380px;width:90%}
h2{margin:0 0 8px;font-size:20px;color:#076FA0}
p{margin:0;font-size:14px;color:rgba(148,163,184,0.8);line-height:1.6}
.s{margin-top:20px;font-size:12px;color:rgba(148,163,184,0.4)}
a{color:#076FA0;text-decoration:none}
a:hover{text-decoration:underline}
</style></head><body>
<div class="c">
<h2>Authentication successful</h2>
<p>Returning to Howl...</p>
<p class="s" id="m" style="display:none">You can close this tab.<br><a href="${urlForAttr}">Click here</a> if Howl didn't open.</p>
</div>
<script>
setTimeout(function(){try{window.location.href="${urlForJs}"}catch(e){}},400);
setTimeout(function(){var m=document.getElementById('m');if(m)m.style.display='block'},2500);
</script>
</body></html>`);
}

const MAX_SSO_ACCOUNTS_PER_USER = 3;

async function linkSsoToUser(userId: string, provider: string, providerId: string, email: string | null): Promise<{ linked: true; provider: string } | { error: string }> {
  const existingLink = await prisma.ssoAccount.findUnique({
    where: { provider_providerId: { provider, providerId } },
  });
  if (existingLink) {
    if (existingLink.userId === userId) {
      return { linked: true, provider }; // Already linked to this user — idempotent
    }
    return { error: 'already_linked_other' };
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, suspended: true } });
  if (!user) return { error: 'user_not_found' };
  if (user.suspended) return { error: 'suspended' };

  const count = await prisma.ssoAccount.count({ where: { userId } });
  if (count >= MAX_SSO_ACCOUNTS_PER_USER) return { error: 'too_many_connections' };

  try {
    await prisma.ssoAccount.create({
      data: {
        userId,
        provider,
        providerId,
        email: email ? encryptSecret(email) : null,
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') return { error: 'already_linked_other' };
    throw err;
  }

  return { linked: true, provider };
}

// GOOGLE
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/auth/sso/google/callback';

const SSO_STATE_COOKIE = 'howl_sso_state';
const SSO_LINK_COOKIE = 'howl_sso_link';
const SSO_STATE_MAX_AGE_MS = 5 * 60 * 1000;

// Electron SSO helpers
const ELECTRON_NONCE_RE = /^[a-f0-9]{32}$/;

/** Extract electron nonce from composite OAuth state, returning the base state for cookie validation. */
function parseElectronState(rawState: string | undefined): { baseState: string; electronNonce: string | null } {
  if (!rawState) return { baseState: '', electronNonce: null };
  const idx = rawState.indexOf(':electron:');
  if (idx === -1) return { baseState: rawState, electronNonce: null };
  const nonce = rawState.slice(idx + ':electron:'.length);
  return {
    baseState: rawState.slice(0, idx),
    electronNonce: ELECTRON_NONCE_RE.test(nonce) ? nonce : null,
  };
}

/** Store an electron SSO nonce in Redis (300s TTL). Returns false if Redis unavailable or nonce invalid. */
async function storeElectronNonce(nonce: string, data: Record<string, string>): Promise<boolean> {
  if (!ELECTRON_NONCE_RE.test(nonce)) return false;
  if (redis) {
    await redis.set(`sso-electron:${nonce}`, JSON.stringify(data), 'EX', 300);
    return true;
  }
  return false; // Electron flow requires Redis
}

/** Consume (single-use) an electron SSO nonce from Redis. Returns null if missing/invalid/no Redis. */
async function consumeElectronNonce(nonce: string): Promise<Record<string, string> | null> {
  if (!ELECTRON_NONCE_RE.test(nonce) || !redis) return null;
  const raw = await redis.get(`sso-electron:${nonce}`);
  if (!raw) return null;
  await redis.del(`sso-electron:${nonce}`);
  try { return JSON.parse(raw); } catch { return null; }
}

function generateSsoState(res: Response): string {
  const state = crypto.randomBytes(32).toString('hex');
  res.cookie(SSO_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SSO_STATE_MAX_AGE_MS,
    path: '/api/auth/sso',
  });
  return state;
}

function validateSsoState(req: Request, res: Response): boolean {
  const cookie = req.cookies?.[SSO_STATE_COOKIE] as string | undefined;
  const query = (req.query?.state ?? req.body?.state) as string | undefined;
  res.clearCookie(SSO_STATE_COOKIE, { path: '/api/auth/sso' });
  if (!cookie || !query || cookie.length !== query.length) return false;
  // Use constant-time comparison to prevent timing attacks on the state parameter
  try {
    return crypto.timingSafeEqual(Buffer.from(cookie, 'utf8'), Buffer.from(query, 'utf8'));
  } catch {
    return false;
  }
}

const ssoInitLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:sso-init:'),
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many SSO requests. Please try again later.' },
  // Prefer link_token (unique per click) over IP so shared networks don't
  // collide. Falls back to IP when no token is present (fresh login init).
  keyGenerator: (req) => {
    const lt = typeof req.query.link_token === 'string' ? req.query.link_token : null;
    if (lt) return `t:${lt.slice(-40)}`;
    return `i:${getClientIp(req) ?? 'anonymous'}`;
  },
});

const ssoCallbackLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:sso-callback:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many SSO callback attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Key on state cookie (unique per SSO flow) instead of IP so shared
  // networks don't collide.
  keyGenerator: (req) => {
    const s = req.cookies?.[SSO_STATE_COOKIE];
    if (typeof s === 'string' && s.length === 64) return `s:${s}`;
    return `i:${getClientIp(req) ?? 'anonymous'}`;
  },
});

router.get('/google', ssoInitLimiter, async (req: Request, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(501).json({ error: 'Google SSO not configured' });

  // Check for link mode (connecting SSO to existing account)
  const linkToken = req.query.link_token as string | undefined;
  if (linkToken) {
    try {
      const decoded = jwt.verify(linkToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; provider: string; purpose?: string };
      if (decoded.purpose !== 'sso-link') throw new Error('Invalid token purpose');
      if (decoded.provider !== 'google') throw new Error('Provider mismatch');
      res.cookie(SSO_LINK_COOKIE, jwt.sign({ userId: decoded.userId, provider: decoded.provider, purpose: 'sso-link' }, JWT_SECRET, { expiresIn: '5m' }), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: SSO_STATE_MAX_AGE_MS,
        path: '/api/auth/sso',
      });
    } catch {
      res.clearCookie(SSO_LINK_COOKIE, { path: '/api/auth/sso' });
      return res.redirect(`${FRONTEND_URL}/settings?sso_error=invalid_link_token`);
    }
  }

  let state = generateSsoState(res);

  // Electron desktop app: use system browser + deep link callback
  const platform = req.query.platform as string | undefined;
  const nonce = req.query.nonce as string | undefined;
  if (platform === 'electron' && nonce && ELECTRON_NONCE_RE.test(nonce)) {
    const stored = await storeElectronNonce(nonce, { provider: 'google' });
    if (!stored) return res.status(503).json({ error: 'Electron SSO requires Redis' });
    state = `${state}:electron:${nonce}`;
  }

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/google/callback', ssoCallbackLimiter, async (req: Request, res: Response) => {
  // Parse electron nonce from composite state before validation
  const { baseState, electronNonce } = parseElectronState(req.query.state as string | undefined);
  if (electronNonce) (req.query as Record<string, unknown>).state = baseState;
  const redirectBase = electronNonce ? 'howl:/' : FRONTEND_URL;
  const nonceSuffix = electronNonce ? `&nonce=${electronNonce}` : '';
  const settingsPath = electronNonce ? '/settings/callback' : '/settings';

    /** Redirect helper — Electron gets an HTML page, web gets a 302 */
    const ssoRedirect = (urlPath: string) => {
      const url = `${redirectBase}${urlPath}`;
      if (electronNonce) return sendElectronRedirectPage(res, url);
      return res.redirect(url);
    };

  try {
    // Electron flows: skip cookie-based CSRF — the Redis nonce provides equivalent protection.
    // Browsers (Firefox ETP, Brave Shields) may partition/strip cookies during cross-app
    // redirect chains initiated by shell.openExternal(), breaking the state cookie round-trip.
    if (electronNonce) {
      res.clearCookie(SSO_STATE_COOKIE, { path: '/api/auth/sso' });
      const nonceData = await consumeElectronNonce(electronNonce);
      if (!nonceData) return ssoRedirect(`/auth/callback?error=invalid_nonce${nonceSuffix}`);
    } else {
      if (!validateSsoState(req, res)) return ssoRedirect(`/auth/callback?error=invalid_state${nonceSuffix}`);
    }

    const code = req.query.code as string;
    if (!code) return ssoRedirect(`/auth/callback?error=missing_code${nonceSuffix}`);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    const tokenData = (await tokenRes.json()) as { access_token?: string; id_token?: string; error?: string };
    if (!tokenData.access_token) return ssoRedirect(`/auth/callback?error=token_exchange_failed${nonceSuffix}`);

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    const profile = (await userRes.json()) as { id: string; email?: string; name?: string; verified_email?: boolean };

    // Check for link mode
    const linkCookie = req.cookies?.[SSO_LINK_COOKIE] as string | undefined;
    res.clearCookie(SSO_LINK_COOKIE, { path: '/api/auth/sso' });
    if (linkCookie) {
      try {
        const decoded = jwt.verify(linkCookie, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; provider?: string; purpose?: string };
        if (decoded.purpose !== 'sso-link') throw new Error('Invalid link cookie');
        if (decoded.provider !== 'google') throw new Error('Provider mismatch');
        const linkResult = await linkSsoToUser(decoded.userId, 'google', profile.id, profile.email || null);
        if ('error' in linkResult) {
          return ssoRedirect(`${settingsPath}?sso_error=${linkResult.error}${nonceSuffix}`);
        }
        return ssoRedirect(`${settingsPath}?sso_linked=google${nonceSuffix}`);
      } catch (err) {
        log.error({ err }, 'SSO link error (Google)');
        return ssoRedirect(`${settingsPath}?sso_error=link_failed${nonceSuffix}`);
      }
    }

    // Google's userinfo endpoint returns verified_email — trust it when true
    const googleEmailVerified = profile.verified_email === true;
    const result = await findOrCreateSsoUser('google', profile.id, profile.email || null, profile.name || null, req, googleEmailVerified);
    const ssoCode = await storeSsoCode(result);
    ssoRedirect(`/auth/callback?code=${encodeURIComponent(ssoCode)}${nonceSuffix}`);
  } catch (err) {
    log.error({ err }, 'Google SSO error');
    ssoRedirect(`/auth/callback?error=${classifySsoError(err)}${nonceSuffix}`);
  }
});

// APPLE
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || '';
const _APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || '';
const _APPLE_KEY_ID = process.env.APPLE_KEY_ID || '';
const APPLE_REDIRECT_URI = process.env.APPLE_REDIRECT_URI || 'http://localhost:5000/api/auth/sso/apple/callback';

router.get('/apple', ssoInitLimiter, async (req: Request, res) => {
  if (!APPLE_CLIENT_ID) return res.status(501).json({ error: 'Apple SSO not configured' });

  // Check for link mode (connecting SSO to existing account)
  const linkToken = req.query.link_token as string | undefined;
  if (linkToken) {
    try {
      const decoded = jwt.verify(linkToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; provider: string; purpose?: string };
      if (decoded.purpose !== 'sso-link') throw new Error('Invalid token purpose');
      if (decoded.provider !== 'apple') throw new Error('Provider mismatch');
      res.cookie(SSO_LINK_COOKIE, jwt.sign({ userId: decoded.userId, provider: decoded.provider, purpose: 'sso-link' }, JWT_SECRET, { expiresIn: '5m' }), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: SSO_STATE_MAX_AGE_MS,
        path: '/api/auth/sso',
      });
    } catch {
      res.clearCookie(SSO_LINK_COOKIE, { path: '/api/auth/sso' });
      return res.redirect(`${FRONTEND_URL}/settings?sso_error=invalid_link_token`);
    }
  }

  let state = generateSsoState(res);

  // Electron desktop app: use system browser + deep link callback
  const platform = req.query.platform as string | undefined;
  const nonce = req.query.nonce as string | undefined;
  if (platform === 'electron' && nonce && ELECTRON_NONCE_RE.test(nonce)) {
    const stored = await storeElectronNonce(nonce, { provider: 'apple' });
    if (!stored) return res.status(503).json({ error: 'Electron SSO requires Redis' });
    state = `${state}:electron:${nonce}`;
  }

  const params = new URLSearchParams({
    client_id: APPLE_CLIENT_ID,
    redirect_uri: APPLE_REDIRECT_URI,
    response_type: 'code id_token',
    scope: 'name email',
    response_mode: 'form_post',
    state,
  });
  res.redirect(`https://appleid.apple.com/auth/authorize?${params}`);
});

let appleJwksCache: { keys: any[]; fetchedAt: number } | null = null;
const APPLE_JWKS_TTL_MS = 60 * 60 * 1000;

async function getAppleJwks(): Promise<any[]> {
  if (appleJwksCache && Date.now() - appleJwksCache.fetchedAt < APPLE_JWKS_TTL_MS) {
    return appleJwksCache.keys;
  }
  const res = await fetch('https://appleid.apple.com/auth/keys', {
    signal: AbortSignal.timeout(5000),
    redirect: 'manual',
  });
  const data = (await res.json()) as { keys: any[] };
  appleJwksCache = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

function rsaJwkToPem(jwk: { n: string; e: string }): string {
  const n = Buffer.from(jwk.n, 'base64url');
  const e = Buffer.from(jwk.e, 'base64url');
  const encodeBigint = (buf: Buffer) => {
    if (buf[0]! >= 0x80) return Buffer.concat([Buffer.from([0x00]), buf]);
    return buf;
  };
  const encodeLength = (len: number): Buffer => {
    if (len < 0x80) return Buffer.from([len]);
    if (len < 0x100) return Buffer.from([0x81, len]);
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  };
  const encodeDer = (tag: number, ...parts: Buffer[]): Buffer => {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
  };
  const nEnc = encodeBigint(n);
  const eEnc = encodeBigint(e);
  const seq = encodeDer(0x30,
    encodeDer(0x02, nEnc),
    encodeDer(0x02, eEnc),
  );
  const algoId = Buffer.from('300d06092a864886f70d0101010500', 'hex');
  const bitString = Buffer.concat([Buffer.from([0x03]), encodeLength(seq.length + 1), Buffer.from([0x00]), seq]);
  const outer = encodeDer(0x30, algoId, bitString);
  const b64 = outer.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
}

router.post('/apple/callback', ssoCallbackLimiter, validate(appleCallbackSchema), async (req: Request, res: Response) => {
  // Parse electron nonce from composite state before validation (Apple uses POST body)
  const { baseState, electronNonce } = parseElectronState(req.body?.state as string | undefined);
  if (electronNonce) req.body.state = baseState;
  const redirectBase = electronNonce ? 'howl:/' : FRONTEND_URL;
  const nonceSuffix = electronNonce ? `&nonce=${electronNonce}` : '';
  const settingsPath = electronNonce ? '/settings/callback' : '/settings';

    /** Redirect helper — Electron gets an HTML page, web gets a 302 */
    const ssoRedirect = (urlPath: string) => {
      const url = `${redirectBase}${urlPath}`;
      if (electronNonce) return sendElectronRedirectPage(res, url);
      return res.redirect(url);
    };

  try {
    // Electron flows: skip cookie-based CSRF — the Redis nonce provides equivalent protection.
    // Browsers (Firefox ETP, Brave Shields) may partition/strip cookies during cross-app
    // redirect chains initiated by shell.openExternal(), breaking the state cookie round-trip.
    if (electronNonce) {
      res.clearCookie(SSO_STATE_COOKIE, { path: '/api/auth/sso' });
      const nonceData = await consumeElectronNonce(electronNonce);
      if (!nonceData) return ssoRedirect(`/auth/callback?error=invalid_nonce${nonceSuffix}`);
    } else {
      if (!validateSsoState(req, res)) return ssoRedirect(`/auth/callback?error=invalid_state${nonceSuffix}`);
    }

    const idToken = req.body?.id_token as string;
    if (!idToken) return ssoRedirect(`/auth/callback?error=missing_token${nonceSuffix}`);

    const parts = idToken.split('.');
    if (parts.length !== 3) return ssoRedirect(`/auth/callback?error=sso_failed${nonceSuffix}`);
    let header: { kid: string; alg: string };
    try {
      header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
    } catch {
      return ssoRedirect(`/auth/callback?error=sso_failed${nonceSuffix}`);
    }
    const jwks = await getAppleJwks();
    const jwk = jwks.find((k: any) => k.kid === header.kid);
    if (!jwk) {
      log.error({ kid: header.kid }, 'Apple JWKS key not found');
      return ssoRedirect(`/auth/callback?error=sso_failed${nonceSuffix}`);
    }

    const publicKey = rsaJwkToPem(jwk);
    const payload = jwt.verify(idToken, publicKey, {
      algorithms: ['RS256'],
      issuer: 'https://appleid.apple.com',
      audience: APPLE_CLIENT_ID,
    }) as { sub: string; email?: string; email_verified?: boolean | string };

    let userName: string | undefined;
    try {
      userName = req.body?.user ? JSON.parse(req.body.user)?.name?.firstName : undefined;
    } catch {
      userName = undefined;
    }
    const appleEmail: string | null = payload.email ?? null;
    // Apple always pre-verifies emails before issuing the account.
    // The email_verified claim in the JWT should always be true/\"true\", but even if
    // absent we trust Apple's verification — they never provide unverified emails.
    const appleEmailVerified = true;

    // Check for link mode
    const linkCookie = req.cookies?.[SSO_LINK_COOKIE] as string | undefined;
    res.clearCookie(SSO_LINK_COOKIE, { path: '/api/auth/sso' });
    if (linkCookie) {
      try {
        const decoded = jwt.verify(linkCookie, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; provider?: string; purpose?: string };
        if (decoded.purpose !== 'sso-link') throw new Error('Invalid link cookie');
        if (decoded.provider !== 'apple') throw new Error('Provider mismatch');
        const linkResult = await linkSsoToUser(decoded.userId, 'apple', payload.sub, appleEmail);
        if ('error' in linkResult) {
          return ssoRedirect(`${settingsPath}?sso_error=${linkResult.error}${nonceSuffix}`);
        }
        return ssoRedirect(`${settingsPath}?sso_linked=apple${nonceSuffix}`);
      } catch (err) {
        log.error({ err }, 'SSO link error (Apple)');
        return ssoRedirect(`${settingsPath}?sso_error=link_failed${nonceSuffix}`);
      }
    }

    const result = await findOrCreateSsoUser('apple', payload.sub, appleEmail, userName ?? null, req, appleEmailVerified);
    const ssoCode = await storeSsoCode(result);
    ssoRedirect(`/auth/callback?code=${encodeURIComponent(ssoCode)}${nonceSuffix}`);
  } catch (err) {
    log.error({ err }, 'Apple SSO error');
    ssoRedirect(`/auth/callback?error=${classifySsoError(err)}${nonceSuffix}`);
  }
});

// STEAM
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
const STEAM_REALM = process.env.STEAM_REALM || 'http://localhost:5000';
const STEAM_RETURN_URL = process.env.STEAM_RETURN_URL || 'http://localhost:5000/api/auth/sso/steam/callback';

router.get('/steam', ssoInitLimiter, async (req: Request, res) => {
  if (!STEAM_API_KEY) return res.status(501).json({ error: 'Steam SSO not configured' });

  // Check for link mode (connecting SSO to existing account)
  const linkToken = req.query.link_token as string | undefined;
  if (linkToken) {
    try {
      const decoded = jwt.verify(linkToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; provider: string; purpose?: string };
      if (decoded.purpose !== 'sso-link') throw new Error('Invalid token purpose');
      if (decoded.provider !== 'steam') throw new Error('Provider mismatch');
      res.cookie(SSO_LINK_COOKIE, jwt.sign({ userId: decoded.userId, provider: decoded.provider, purpose: 'sso-link' }, JWT_SECRET, { expiresIn: '5m' }), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: SSO_STATE_MAX_AGE_MS,
        path: '/api/auth/sso',
      });
    } catch {
      res.clearCookie(SSO_LINK_COOKIE, { path: '/api/auth/sso' });
      return res.redirect(`${FRONTEND_URL}/settings?sso_error=invalid_link_token`);
    }
  }

  let state = generateSsoState(res);

  // Electron desktop app: use system browser + deep link callback
  const platform = req.query.platform as string | undefined;
  const nonce = req.query.nonce as string | undefined;
  if (platform === 'electron' && nonce && ELECTRON_NONCE_RE.test(nonce)) {
    const stored = await storeElectronNonce(nonce, { provider: 'steam' });
    if (!stored) return res.status(503).json({ error: 'Electron SSO requires Redis' });
    state = `${state}:electron:${nonce}`;
  }

  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': `${STEAM_RETURN_URL}?state=${state}`,
    'openid.realm': STEAM_REALM,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  res.redirect(`https://steamcommunity.com/openid/login?${params}`);
});

router.get('/steam/callback', ssoCallbackLimiter, async (req: Request, res: Response) => {
  // Parse electron nonce from composite state before validation
  const { baseState, electronNonce } = parseElectronState(req.query.state as string | undefined);
  if (electronNonce) (req.query as Record<string, unknown>).state = baseState;
  const redirectBase = electronNonce ? 'howl:/' : FRONTEND_URL;
  const nonceSuffix = electronNonce ? `&nonce=${electronNonce}` : '';
  const settingsPath = electronNonce ? '/settings/callback' : '/settings';

    /** Redirect helper — Electron gets an HTML page, web gets a 302 */
    const ssoRedirect = (urlPath: string) => {
      const url = `${redirectBase}${urlPath}`;
      if (electronNonce) return sendElectronRedirectPage(res, url);
      return res.redirect(url);
    };

  try {
    // Electron flows: skip cookie-based CSRF — the Redis nonce provides equivalent protection.
    // Browsers (Firefox ETP, Brave Shields) may partition/strip cookies during cross-app
    // redirect chains initiated by shell.openExternal(), breaking the state cookie round-trip.
    if (electronNonce) {
      res.clearCookie(SSO_STATE_COOKIE, { path: '/api/auth/sso' });
      const nonceData = await consumeElectronNonce(electronNonce);
      if (!nonceData) return ssoRedirect(`/auth/callback?error=invalid_nonce${nonceSuffix}`);
    } else {
      if (!validateSsoState(req, res)) return ssoRedirect(`/auth/callback?error=invalid_state${nonceSuffix}`);
    }

    const claimedId = req.query['openid.claimed_id'] as string;
    if (!claimedId) return ssoRedirect(`/auth/callback?error=missing_steam_id${nonceSuffix}`);

    // Verify the assertion with Steam
    const verifyParams = new URLSearchParams(req.query as Record<string, string>);
    verifyParams.set('openid.mode', 'check_authentication');
    const verifyRes = await fetch(`https://steamcommunity.com/openid/login?${verifyParams}`, {
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    const verifyText = await verifyRes.text();
    if (!verifyText.includes('is_valid:true')) {
      return ssoRedirect(`/auth/callback?error=steam_verify_failed${nonceSuffix}`);
    }

    const steamId = claimedId.split('/').pop()!;

    // Fetch Steam profile
    let displayName: string | null = null;
    try {
      const profileRes = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamId}`, {
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      });
      const profileData = (await profileRes.json()) as { response?: { players?: Array<{ personaname?: string }> } };
      displayName = profileData.response?.players?.[0]?.personaname || null;
    } catch { /* profile fetch is best-effort */ }

    // Check for link mode
    const linkCookie = req.cookies?.[SSO_LINK_COOKIE] as string | undefined;
    res.clearCookie(SSO_LINK_COOKIE, { path: '/api/auth/sso' });
    if (linkCookie) {
      try {
        const decoded = jwt.verify(linkCookie, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string; provider?: string; purpose?: string };
        if (decoded.purpose !== 'sso-link') throw new Error('Invalid link cookie');
        if (decoded.provider !== 'steam') throw new Error('Provider mismatch');
        const linkResult = await linkSsoToUser(decoded.userId, 'steam', steamId, displayName);
        if ('error' in linkResult) {
          return ssoRedirect(`${settingsPath}?sso_error=${linkResult.error}${nonceSuffix}`);
        }
        return ssoRedirect(`${settingsPath}?sso_linked=steam${nonceSuffix}`);
      } catch (err) {
        log.error({ err }, 'SSO link error (Steam)');
        return ssoRedirect(`${settingsPath}?sso_error=link_failed${nonceSuffix}`);
      }
    }

    // Steam provides no email (uses synthetic @sso.local address) — auto-verify
    // since we cannot send a verification email to a non-existent address.
    const result = await findOrCreateSsoUser('steam', steamId, null, displayName, req, true);
    const ssoCode = await storeSsoCode(result);
    ssoRedirect(`/auth/callback?code=${encodeURIComponent(ssoCode)}${nonceSuffix}`);
  } catch (err) {
    log.error({ err }, 'Steam SSO error');
    ssoRedirect(`/auth/callback?error=${classifySsoError(err)}${nonceSuffix}`);
  }
});

export default router;
