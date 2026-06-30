// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { prisma } from '../db.js';
import { type AdminAuthRequest, requireAdminStepUp } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { adminUserSearchQuery, adminAuditLogQuery, adminUpdatePlanSchema, adminUpdateEmailSchema, adminUpdateUsernameSchema, adminSuspendSchema, adminUserAuditLogQuery, adminRefundSchema, adminManageBadgeSchema } from '../schemas.js';
import { getEffectivePlan } from '../utils.js';
import { hashCode } from './auth.js';
import { generateVerificationCode } from '../services/email.js';
import { enqueueEmail } from '../queues/producers.js';
import { decryptSecret, hashEmail, encryptSecret } from '../services/mfaCrypto.js';
import { logAction, validateUuidParam, adminLimiter } from './adminHelpers.js';
import { logger } from '../logger.js';
import { redis } from '../redis.js';
import { getIO } from '../socketIO.js';
import { computeBadges, ADMIN_GRANTABLE_BADGES } from '../utils/badges.js';
import { invalidateVerifiedEmailCache } from '../middleware/requireVerifiedEmail.js';

const log = logger.child({ module: 'adminUsers' });
const router = Router();

/**
 * Check whether a User-table row belongs to someone who also has an AdminUser account,
 * by comparing emailHash (SHA-256 of lowercase email) across both tables.
 * Returns the AdminUser.id if found, or null.
 */
async function findAdminIdForUser(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailHash: true } }).catch(() => null);
  if (!user?.emailHash) return null;
  const adminUser = await prisma.adminUser.findFirst({ where: { emailHash: user.emailHash }, select: { id: true } }).catch(() => null);
  return adminUser?.id ?? null;
}

async function guardAdminOnAdmin(req: AdminAuthRequest, res: Response, targetUserId: string): Promise<boolean> {
  const linkedAdminId = await findAdminIdForUser(targetUserId);
  if (!linkedAdminId) return true; // target user is not an admin — allow
  if (req.adminId === linkedAdminId) return true; // admin modifying their own user account — allow
  res.status(403).json({ error: 'Cannot modify another admin\'s user account' });
  return false;
}

/** Decrypt an at-rest-encrypted email; fall back to the raw value if it's
 *  already plaintext (legacy rows that predate email-encryption). Returns
 *  `null` only if the input is empty. */
function tryDecryptEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  try { return decryptSecret(value); } catch { return value; }
}

/**
 * Build audit context for every destructive action, so the audit log carries
 * who did it, from where, and on what device. Caller merges this into their
 * own action-specific details.
 */
async function buildAuditContext(req: AdminAuthRequest): Promise<Record<string, unknown>> {
  const admin = req.adminId
    ? await prisma.adminUser.findUnique({
        where: { id: req.adminId },
        select: { username: true, email: true },
      }).catch(() => null)
    : null;
  const uaRaw = req.headers['user-agent'];
  const actorUA = typeof uaRaw === 'string' ? uaRaw.slice(0, 500) : null;
  return {
    actorIp: req.ip ?? null,
    actorUA,
    adminDisplayName: admin?.username ?? null,
  };
}

// GET /api/admin/users?q=...&page=1&limit=20&role=...&plan=...&status=...&verified=...
router.get('/users', adminLimiter, validate(adminUserSearchQuery), async (req: AdminAuthRequest, res: Response) => {
  const q = (req.query.q as string || '').trim();
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
  const skip = (page - 1) * limit;

  const conditions: Prisma.UserWhereInput[] = [];

  if (q) {
    const orConditions: Prisma.UserWhereInput[] = [
      { username: { contains: q, mode: 'insensitive' } },
      ...(q.length === 36 ? [{ id: q }] : []),
      ...(/^\d{4}$/.test(q) ? [{ discriminator: q }] : []),
    ];
    if (q.includes('@')) {
      orConditions.push({ emailHash: hashEmail(q) });
    }
    conditions.push({ OR: orConditions });
  }

  const plan = req.query.plan as string | undefined;
  if (plan === 'free') conditions.push({ stripePlan: null });
  else if (plan === 'essential' || plan === 'pro') conditions.push({ stripePlan: plan });

  const status = req.query.status as string | undefined;
  if (status === 'online') conditions.push({ status: { not: 'offline' } });
  else if (status === 'offline') conditions.push({ status: 'offline' });

  const verified = req.query.verified as string | undefined;
  if (verified === 'true') conditions.push({ emailVerified: true });
  else if (verified === 'false') conditions.push({ emailVerified: false });

  const where: Prisma.UserWhereInput = conditions.length > 0 ? { AND: conditions } : {};

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true, username: true, discriminator: true, email: true,
        avatar: true, status: true, stripePlan: true,
        createdAt: true, mfaEnabled: true, emailVerified: true,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  const decryptedUsers = users.map(u => {
    let pe: string;
    try { pe = decryptSecret(u.email); } catch { pe = u.email; }
    return { ...u, email: pe };
  });
  res.json({ users: decryptedUsers, total, page, pages: Math.ceil(total / limit) });
});

// GET /api/admin/users/:userId
router.get('/users/:userId', adminLimiter, async (req: AdminAuthRequest, res: Response) => {
  const userId = validateUuidParam(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid userId format' });
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, username: true, discriminator: true, email: true,
      avatar: true, banner: true, status: true, dateOfBirth: true,
      createdAt: true, stripePlan: true, stripeStatus: true,
      stripePeriodEnd: true, stripeCustomerId: true, stripeSubscriptionId: true,
      emailVerified: true, mfaEnabled: true, mfaTotpSecret: true,
      mfaPhone: true, mfaPhoneVerified: true,
      nameColor: true, nameFont: true, nameEffect: true, avatarEffect: true,
      lastDiscriminatorChange: true, suspended: true, suspendedAt: true, suspendReason: true,
      role: true, deactivated: true, deactivatedAt: true, needsOnboarding: true,
      tosAcceptedAt: true, privacyPolicyAcceptedAt: true, legalConsentVersion: true,
      powerUpSubscriptionId: true, powerUpPaidSlots: true,
      hasUsedSubscriptionRefund: true, hasUsedGiftRefund: true, hasUsedPowerUpRefund: true,
      badges: true,
      ssoAccounts: { select: { id: true, provider: true, email: true } },
      sessions: { select: { id: true, deviceName: true, os: true, lastActiveAt: true, createdAt: true }, orderBy: { lastActiveAt: 'desc' }, take: 10 },
      serverMembers: { select: { serverId: true, role: true, server: { select: { name: true } } }, take: 200 },
      _count: { select: { friendRequestsSent: true, friendRequestsReceived: true, blockedUsers: true } },
      connectedApps: { select: { id: true, provider: true, createdAt: true } },
      familyLinksAsParent: {
        select: {
          id: true, childId: true, status: true, createdAt: true,
          child: { select: { username: true, discriminator: true, avatar: true } },
        },
      },
      familyLinksAsChild: {
        select: {
          id: true, parentId: true, status: true, createdAt: true,
          parent: { select: { username: true, discriminator: true, avatar: true } },
        },
      },
    },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const hasMfaTotp = !!user.mfaTotpSecret;
  const hasMfaPhone = !!user.mfaPhone && user.mfaPhoneVerified;
  let phoneLast4: string | null = null;
  try { if (user.mfaPhone) phoneLast4 = decryptSecret(user.mfaPhone).slice(-4); } catch { /* legacy unencrypted */ }

  let plainEmail: string;
  try { plainEmail = decryptSecret(user.email); } catch { plainEmail = user.email; }

  const ssoAccountsDecrypted = user.ssoAccounts.map(sso => {
    let ssoEmail: string | null = sso.email;
    if (sso.email) {
      try { ssoEmail = decryptSecret(sso.email); } catch { /* legacy unencrypted or corrupt */ }
    }
    return { ...sso, email: ssoEmail };
  });

  const computedBadges = computeBadges(user);

  res.json({
    ...user,
    email: plainEmail,
    ssoAccounts: ssoAccountsDecrypted,
    mfaTotpSecret: undefined,
    mfaPhone: undefined,
    hasMfaTotp,
    hasMfaPhone,
    phoneLast4,
    computedBadges,
  });
});

// PATCH /api/admin/users/:userId/badges
router.patch('/users/:userId/badges', adminLimiter, validate(adminManageBadgeSchema), async (req: AdminAuthRequest, res: Response) => {
  const userId = validateUuidParam(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid userId format' });

  const { action, badge } = req.body as { action: 'add' | 'remove'; badge: string };

  if (!ADMIN_GRANTABLE_BADGES.has(badge)) {
    return res.status(400).json({ error: `Badge "${badge}" is not admin-grantable. Allowed: ${[...ADMIN_GRANTABLE_BADGES].join(', ')}` });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, badges: true,
      stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true,
      createdAt: true,
    },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  let updatedBadges: string[];
  if (action === 'add') {
    const current = new Set(user.badges ?? []);
    current.add(badge);
    updatedBadges = Array.from(current);
  } else {
    updatedBadges = (user.badges ?? []).filter((b: string) => b !== badge);
  }

  await prisma.user.update({
    where: { id: userId },
    data: { badges: updatedBadges },
  });
  await logAction(req.adminId!, 'manage_badge', userId, { action, badge });

  const updatedUser = { ...user, badges: updatedBadges };
  const computedBadges = computeBadges(updatedUser);

  res.json({ success: true, badges: updatedBadges, computedBadges });
});

// POST /api/admin/users/:userId/reset-password
//
// Never return a plaintext temp password here: that would turn a single
// admin panel view into a one-step account takeover. Instead set a random
// (unknowable) password hash, invalidate all sessions, and email the
// affected user telling them to reset via the normal "forgot password"
// flow. The admin response never contains the password.
router.post('/users/:userId/reset-password', adminLimiter, requireAdminStepUp, async (req: AdminAuthRequest, res: Response) => {
  const userId = validateUuidParam(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid userId format' });
  if (!(await guardAdminOnAdmin(req, res, userId))) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Random password nobody sees — forces the user through /forgot-password.
  const unknowable = crypto.randomBytes(32).toString('base64url');
  const hash = await bcrypt.hash(unknowable, 12);

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash: hash } }),
    prisma.session.deleteMany({ where: { userId } }),
  ]);
  await logAction(req.adminId!, 'reset_password', userId, await buildAuditContext(req));

  // Notify the affected user.
  const plainEmailForReset = tryDecryptEmail(user.email);
  if (plainEmailForReset) {
    enqueueEmail({ type: 'adminPasswordReset', to: plainEmailForReset }).catch((err) => {
      log.warn({ err, userId }, 'adminPasswordReset enqueue failed');
    });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, notificationSent: !!plainEmailForReset });
});

// POST /api/admin/users/:userId/send-reset-email
router.post('/users/:userId/send-reset-email', adminLimiter, async (req: AdminAuthRequest, res: Response) => {
  const userId = validateUuidParam(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid userId format' });
  if (!(await guardAdminOnAdmin(req, res, userId))) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const code = generateVerificationCode();
  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordResetCode: hashCode(code),
      passwordResetExpiry: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  let plainEmail: string;
  try { plainEmail = decryptSecret(user.email); } catch { plainEmail = user.email; }
  enqueueEmail({ type: 'passwordReset', to: plainEmail, code }).catch(() => {});
  await logAction(req.adminId!, 'send_reset_email', userId);

  res.json({ success: true });
});

// POST /api/admin/users/:userId/disable-mfa
router.post('/users/:userId/disable-mfa', adminLimiter, requireAdminStepUp, async (req: AdminAuthRequest, res: Response) => {
  const userId = validateUuidParam(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid userId format' });
  if (!(await guardAdminOnAdmin(req, res, userId))) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaTotpSecret: null, mfaPhone: null, mfaPhoneVerified: false },
    }),
    prisma.passkeyCredential.deleteMany({ where: { userId } }),
  ]);
  await logAction(req.adminId!, 'disable_mfa', userId, await buildAuditContext(req));

  // Notify the affected user.
  const plainEmailForMfa = tryDecryptEmail(user.email);
  if (plainEmailForMfa) {
    enqueueEmail({ type: 'adminDisabledMfa', to: plainEmailForMfa }).catch((err) => {
      log.warn({ err, userId }, 'adminDisabledMfa enqueue failed');
    });
  }

  res.json({ success: true });
});

// PATCH /api/admin/users/:userId/plan
router.patch('/users/:userId/plan', adminLimiter, validate(adminUpdatePlanSchema), async (req: AdminAuthRequest, res: Response) => {
  const userId = validateUuidParam(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid userId format' });
  if (!(await guardAdminOnAdmin(req, res, userId))) return;
  const { plan, durationMonths } = req.body as { plan: string | null; durationMonths?: number };

  const validPlans = [null, 'essential', 'pro'];
  if (!validPlans.includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan. Use null, "essential", or "pro".' });
  }

  // durationMonths: 0 = permanent, 1-12 = months, undefined = permanent for paid plans
  if (plan && durationMonths !== undefined && durationMonths !== 0) {
    if (!Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 12) {
      return res.status(400).json({ error: 'Duration must be 0 (permanent) or 1-12 months' });
    }
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, stripePlan: true, stripeStatus: true, stripeSubscriptionId: true, stripePeriodEnd: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const hadStripeSubscription = !!user.stripeSubscriptionId;

  // Cancel existing Stripe subscription to prevent double-billing when admin grants a plan
  if (hadStripeSubscription && user.stripeSubscriptionId && plan) {
    try {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (stripeKey) {
        const { default: Stripe } = await import('stripe');
        const stripe = new Stripe(stripeKey);
        await stripe.subscriptions.cancel(user.stripeSubscriptionId);
        log.info({ userId, subscriptionId: user.stripeSubscriptionId }, 'Cancelled Stripe subscription during admin plan grant');
      }
    } catch (cancelErr) {
      log.warn({ err: cancelErr, userId }, 'Failed to cancel Stripe subscription during admin plan grant');
    }
  }

  let periodEnd: Date | null = null;
  const isPermanent = !durationMonths || durationMonths === 0;
  if (plan && !isPermanent) {
    periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + durationMonths!);
  }

  const newStatus = plan ? (isPermanent ? 'admin_granted' : 'active') : null;

  await prisma.user.update({
    where: { id: userId },
    data: {
      stripePlan: plan,
      stripeStatus: newStatus,
      stripePeriodEnd: plan ? periodEnd : null,
      stripeSubscriptionId: plan ? null : user.stripeSubscriptionId, // Clear sub ID when admin-granting
    },
  });
  await logAction(req.adminId!, 'grant_plan', userId, {
    plan,
    permanent: plan ? isPermanent : false,
    durationMonths: plan && !isPermanent ? durationMonths : null,
    periodEnd: periodEnd?.toISOString() || null,
    hadStripeSubscription,
  });

  // Emit real-time subscription update so the user's client reflects the change immediately
  try {
    const io = getIO();
    io.to(`user:${userId}`).emit('subscription-updated', {
      stripePlan: plan,
      stripeStatus: plan ? (isPermanent ? 'admin_granted' : 'active') : null,
      stripePeriodEnd: periodEnd?.toISOString() ?? null,
    });
  } catch {
    // Socket.IO may not be initialized in tests
  }

  res.json({ success: true, plan, periodEnd: periodEnd?.toISOString() || null, permanent: plan ? isPermanent : false, hadStripeSubscription });
});

// PATCH /api/admin/users/:userId/email
router.patch('/users/:userId/email', adminLimiter, requireAdminStepUp, validate(adminUpdateEmailSchema), async (req: AdminAuthRequest, res: Response) => {
  const userId = validateUuidParam(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid userId format' });
  if (!(await guardAdminOnAdmin(req, res, userId))) return;
  const { email } = req.body as { email: string };

  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });

  const normalizedNew = email.toLowerCase().trim();
  const newEmailHash = hashEmail(normalizedNew);
  const [existing, user] = await Promise.all([
    prisma.user.findUnique({ where: { emailHash: newEmailHash }, select: { id: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } }),
  ]);
  if (existing && existing.id !== userId) return res.status(400).json({ error: 'Email already in use by another account' });
  if (!user) return res.status(404).json({ error: 'User not found' });

  let oldPlainEmail: string;
  try { oldPlainEmail = decryptSecret(user.email); } catch { oldPlainEmail = user.email; }
  await prisma.user.update({ where: { id: userId }, data: { email: encryptSecret(normalizedNew), emailHash: newEmailHash, emailVerified: false } });
  invalidateVerifiedEmailCache(userId);
  // Mask emails in audit log to avoid persisting plaintext PII in logs
  const maskEmail = (e: string) => { const [local, domain] = e.split('@'); return local && domain ? `${local.slice(0, 2)}***@${domain}` : '***'; };
  await logAction(req.adminId!, 'change_email', userId, {
    oldEmail: maskEmail(oldPlainEmail),
    newEmail: maskEmail(normalizedNew),
    emailVerifiedReset: true,
    ...(await buildAuditContext(req)),
  });

  // Notify BOTH the old and the new address.
  if (oldPlainEmail) {
    enqueueEmail({ type: 'adminChangedEmail', to: oldPlainEmail, addressee: 'old', newEmail: normalizedNew }).catch((err) => {
      log.warn({ err, userId }, 'adminChangedEmail (old) enqueue failed');
    });
  }
  enqueueEmail({ type: 'adminChangedEmail', to: normalizedNew, addressee: 'new', newEmail: normalizedNew }).catch((err) => {
    log.warn({ err, userId }, 'adminChangedEmail (new) enqueue failed');
  });

  res.json({ success: true, email });
});

// PATCH /api/admin/users/:userId/username
router.patch('/users/:userId/username', adminLimiter, validate(adminUpdateUsernameSchema), async (req: AdminAuthRequest, res: Response) => {
  const userId = validateUuidParam(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid userId format' });
  if (!(await guardAdminOnAdmin(req, res, userId))) return;
  const { username, discriminator } = req.body as { username?: string; discriminator?: string };

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, discriminator: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const newUsername = username || user.username;
  const newDiscriminator = discriminator || user.discriminator;

  if (newUsername.length < 2 || newUsername.length > 32) return res.status(400).json({ error: 'Username must be 2-32 characters' });
  if (!/^\d{4}$/.test(newDiscriminator)) return res.status(400).json({ error: 'Discriminator must be a 4-digit string (0001-9999)' });

  if (newUsername !== user.username || newDiscriminator !== user.discriminator) {
    const conflict = await prisma.user.findFirst({
      where: { username: newUsername, discriminator: newDiscriminator, NOT: { id: userId } },
    });
    if (conflict) return res.status(400).json({ error: `${newUsername}#${newDiscriminator} is already taken` });
  }

  await prisma.user.update({ where: { id: userId }, data: { username: newUsername, discriminator: newDiscriminator } });
  await logAction(req.adminId!, 'change_username', userId, { oldUsername: user.username, oldDiscriminator: user.discriminator, newUsername, newDiscriminator });

  res.json({ success: true, username: newUsername, discriminator: newDiscriminator });
});

// POST /api/admin/users/:userId/suspend
router.post('/users/:userId/suspend', adminLimiter, validate(adminSuspendSchema), async (req: AdminAuthRequest, res: Response) => {
  const userId = validateUuidParam(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid userId format' });
  if (!(await guardAdminOnAdmin(req, res, userId))) return;
  const { reason } = req.body as { reason?: string };

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, suspended: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.suspended) return res.status(400).json({ error: 'User is already suspended' });

  await prisma.$transaction([
    prisma.session.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: { suspended: true, suspendedAt: new Date(), suspendReason: reason ?? null, status: 'offline' },
    }),
  ]);
  await logAction(req.adminId!, 'suspend_user', userId, { reason });

  res.json({ success: true });
});

// POST /api/admin/users/:userId/unsuspend
router.post('/users/:userId/unsuspend', adminLimiter, async (req: AdminAuthRequest, res: Response) => {
  const userId = validateUuidParam(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid userId format' });
  if (!(await guardAdminOnAdmin(req, res, userId))) return;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, suspended: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.suspended) return res.status(400).json({ error: 'User is not suspended' });

  await prisma.user.update({
    where: { id: userId },
    data: { suspended: false, suspendedAt: null, suspendReason: null },
  });
  await logAction(req.adminId!, 'unsuspend_user', userId);

  res.json({ success: true });
});

// POST /api/admin/users/:userId/verify-email
router.post('/users/:userId/verify-email', adminLimiter, async (req: AdminAuthRequest, res: Response) => {
  const userId = validateUuidParam(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid userId format' });
  if (!(await guardAdminOnAdmin(req, res, userId))) return;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  await prisma.user.update({ where: { id: userId }, data: { emailVerified: true, emailVerifyCode: null, emailVerifyExpiry: null } });
  invalidateVerifiedEmailCache(userId);
  await logAction(req.adminId!, 'verify_email', userId);

  res.json({ success: true });
});

// DELETE /api/admin/users/:userId/sessions
router.delete('/users/:userId/sessions', adminLimiter, requireAdminStepUp, async (req: AdminAuthRequest, res: Response) => {
  const userId = validateUuidParam(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid userId format' });
  if (!(await guardAdminOnAdmin(req, res, userId))) return;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const result = await prisma.session.deleteMany({ where: { userId } });
  await logAction(req.adminId!, 'revoke_sessions', userId, { count: result.count, ...(await buildAuditContext(req)) });

  // Notify the affected user (only if sessions were actually revoked —
  // admins might hit this on a user with zero live sessions as a no-op).
  if (result.count > 0) {
    const plainEmailForSessions = tryDecryptEmail(user.email);
    if (plainEmailForSessions) {
      enqueueEmail({ type: 'adminDeletedSessions', to: plainEmailForSessions }).catch((err) => {
        log.warn({ err, userId }, 'adminDeletedSessions enqueue failed');
      });
    }
  }

  res.json({ success: true, revokedCount: result.count });
});

// GET /api/admin/audit-log?page=1&limit=25&action=...&adminId=...&targetUserId=...&targetName=...
router.get('/audit-log', adminLimiter, validate(adminAuditLogQuery), async (req: AdminAuthRequest, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 25));
  const skip = (page - 1) * limit;

  const where: Prisma.AdminAuditLogWhereInput = {};
  if (req.query.action) where.action = req.query.action as string;
  if (req.query.adminId) where.adminId = req.query.adminId as string;
  if (req.query.targetUserId) where.targetUserId = req.query.targetUserId as string;

  const targetName = (req.query.targetName as string || '').trim();
  if (targetName) {
    const matchingUsers = await prisma.user.findMany({
      where: { username: { contains: targetName, mode: 'insensitive' } },
      select: { id: true },
      take: 100,
    });
    where.targetUserId = { in: matchingUsers.map(u => u.id) };
  }

  const [entries, total] = await Promise.all([
    prisma.adminAuditLog.findMany({
      where,
      include: { admin: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.adminAuditLog.count({ where }),
  ]);

  const targetUserIds = [...new Set(entries.map(e => e.targetUserId).filter((id): id is string => !!id))];
  const targetUsers = targetUserIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: targetUserIds } },
        select: { id: true, username: true, discriminator: true, avatar: true },
        take: 200,
      })
    : [];
  const targetUserMap = new Map(targetUsers.map(u => [u.id, u]));

  const enrichedEntries = entries.map(e => ({
    ...e,
    targetUser: e.targetUserId ? targetUserMap.get(e.targetUserId) || null : null,
  }));

  res.json({ entries: enrichedEntries, total, page, pages: Math.ceil(total / limit) });
});

// GET /api/admin/users/:userId/audit-log?page=1&limit=10
router.get('/users/:userId/audit-log', adminLimiter, validate(adminUserAuditLogQuery), async (req: AdminAuthRequest, res: Response) => {
  const userId = validateUuidParam(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid userId format' });
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10));
  const skip = (page - 1) * limit;

  const where: Prisma.AdminAuditLogWhereInput = { targetUserId: userId };

  const [entries, total] = await Promise.all([
    prisma.adminAuditLog.findMany({
      where,
      include: { admin: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.adminAuditLog.count({ where }),
  ]);

  res.json({ entries, total, page, pages: Math.ceil(total / limit) });
});

// GET /api/admin/users/:userId/billing-history
router.get('/users/:userId/billing-history', adminLimiter, async (req: AdminAuthRequest, res: Response) => {
  const userId = validateUuidParam(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid userId format' });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, stripeCustomerId: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Fetch Stripe charges (if customer exists)
  let stripeCharges: Array<{
    id: string;
    amount: number;
    currency: string;
    status: string;
    description: string | null;
    created: number;
    refunded: boolean;
    refundedAmount: number;
    paymentMethod: string | null;
    invoiceId: string | null;
  }> = [];

  if (user.stripeCustomerId) {
    try {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (stripeKey) {
        const { default: Stripe } = await import('stripe');
        const stripe = new Stripe(stripeKey);
        const charges = await stripe.charges.list({
          customer: user.stripeCustomerId,
          limit: 50,
        });
        stripeCharges = charges.data.map((c) => ({
          id: c.id,
          amount: c.amount,
          currency: c.currency,
          status: c.status,
          description: c.description,
          created: c.created,
          refunded: c.refunded,
          refundedAmount: c.amount_refunded,
          paymentMethod: c.payment_method_details?.type ?? null,
          invoiceId: (() => { const inv = (c as any).invoice; return typeof inv === 'string' ? inv : inv?.id ?? null; })(),
        }));
      }
    } catch (err: any) {
      log.warn({ err: err.message, userId }, 'Failed to fetch Stripe charges for admin billing history');
    }
  }

  // Fetch gift subscriptions (sent and received)
  const [giftsSent, giftsReceived] = await Promise.all([
    prisma.giftSubscription.findMany({
      where: { senderId: userId },
      select: {
        id: true, code: true, plan: true, durationMonths: true, status: true,
        createdAt: true, redeemedAt: true, expiresAt: true,
        recipientUsername: true, stripePaymentIntentId: true,
        recipient: { select: { username: true, discriminator: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.giftSubscription.findMany({
      where: { recipientId: userId },
      select: {
        id: true, code: true, plan: true, durationMonths: true, status: true,
        createdAt: true, redeemedAt: true, expiresAt: true,
        stripePaymentIntentId: true,
        sender: { select: { username: true, discriminator: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  // Fetch trial attempts
  const trialAttempts = await prisma.pendingTrialSetup.findMany({
    where: { userId },
    select: {
      id: true, plan: true, status: true, trialResult: true,
      resultMessage: true, fingerprint: true, createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  await logAction(req.adminId!, 'view_billing_history', userId);

  res.json({
    stripeCustomerId: user.stripeCustomerId,
    stripeCharges,
    giftsSent,
    giftsReceived,
    trialAttempts,
  });
});

// POST /api/admin/users/:userId/refund — Admin-initiated refund with optional override.
//
// Step-up auth required: refunds move money out of Stripe and could be the target of
// stolen-session abuse. Same bar as reset-password / disable-mfa / email-change.
router.post('/users/:userId/refund', adminLimiter, requireAdminStepUp, validate(adminRefundSchema), async (req: AdminAuthRequest, res: Response) => {
  try {
    const userId = validateUuidParam(req.params.userId as string);
    if (!userId) return res.status(400).json({ error: 'Invalid user ID' });

    const { chargeId, type, override, overrideReason, reason } = req.body as {
      chargeId: string;
      type: 'subscription' | 'gift' | 'power_up';
      override?: boolean;
      overrideReason?: string;
      reason?: string;
    };

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        stripeStatus: true,
        stripePlan: true,
        stripePeriodEnd: true,
        powerUpSubscriptionId: true,
        powerUpPaidSlots: true,
        hasUsedSubscriptionRefund: true,
        hasUsedGiftRefund: true,
        hasUsedPowerUpRefund: true,
        emailHash: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.stripeCustomerId) return res.status(400).json({ error: 'User has no Stripe account' });

    const usedField = type === 'subscription' ? 'hasUsedSubscriptionRefund'
      : type === 'gift' ? 'hasUsedGiftRefund'
      : 'hasUsedPowerUpRefund';

    // Per-admin-action lock: same key space as self-serve so an admin and a user
    // can't race against each other on the same account.
    const lockKey = `refund:lock:${userId}`;
    if (redis) {
      const lockAcquired = await redis.set(lockKey, '1', 'EX', 30, 'NX');
      if (!lockAcquired) {
        return res.status(429).json({ error: 'A refund is already being processed for this user. Please wait.' });
      }
    }

    try {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) return res.status(500).json({ error: 'Stripe not configured' });
      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(stripeKey, { apiVersion: '2026-02-25.clover' });

      let charge;
      try {
        charge = await stripe.charges.retrieve(chargeId);
      } catch {
        return res.status(404).json({ error: 'Charge not found on Stripe' });
      }

      const chargeCustomerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
      if (chargeCustomerId !== user.stripeCustomerId) {
        return res.status(400).json({ error: 'Charge does not belong to this user' });
      }
      if (charge.refunded) {
        return res.status(400).json({ error: 'Charge is already refunded on Stripe' });
      }

      if (!override) {
        const chargeDate = new Date(charge.created * 1000);
        const REFUND_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
        if (Date.now() - chargeDate.getTime() > REFUND_WINDOW_MS) {
          return res.status(400).json({ error: 'Charge is outside the 5-day refund window. Use override to bypass.' });
        }
      }

      // Per-account boolean claim. Atomic when !override (rejects if already used);
      // unconditional when override (admin explicitly bypassing).
      if (override) {
        await prisma.user.update({
          where: { id: userId },
          data: { [usedField]: true },
        });
      } else {
        const claimed = await prisma.user.updateMany({
          where: { id: userId, [usedField]: false },
          data: { [usedField]: true },
        });
        if (claimed.count === 0) {
          return res.status(400).json({ error: `User has already used their ${type} refund. Use override to bypass.` });
        }
      }

      const paymentMethodFingerprint = charge.payment_method_details?.card?.fingerprint ?? null;

      // Saga: insert pending Refund row BEFORE Stripe call. Unique constraint on
      // stripeChargeId is the DB-level guard against a same-charge double-refund.
      let refundRecord;
      try {
        refundRecord = await prisma.refund.create({
          data: {
            userId,
            type,
            stripeChargeId: chargeId,
            amount: charge.amount,
            currency: charge.currency,
            reason: reason || null,
            initiatedBy: 'admin',
            adminId: req.adminId,
            adminOverride: !!override,
            adminOverrideReason: overrideReason || null,
            status: 'pending',
            paymentMethodFingerprint,
          },
        });
      } catch (err: unknown) {
        if (!override) {
          await prisma.user.update({ where: { id: userId }, data: { [usedField]: false } });
        }
        const msg = err instanceof Error ? err.message : 'unknown';
        log.warn({ err: msg, chargeId }, 'Admin pending refund insert collided');
        return res.status(409).json({ error: 'A refund for this charge is already in progress or completed.' });
      }

      // Issue Stripe refund with idempotencyKey = Refund.id (network retry-safe).
      let stripeRefund;
      try {
        stripeRefund = await stripe.refunds.create(
          { charge: chargeId },
          { idempotencyKey: `refund-${refundRecord.id}` },
        );
      } catch (err: unknown) {
        await prisma.refund.update({
          where: { id: refundRecord.id },
          data: { status: 'failed', completedAt: new Date() },
        }).catch(() => {});
        if (!override) {
          await prisma.user.update({ where: { id: userId }, data: { [usedField]: false } });
        }
        const msg = err instanceof Error ? err.message : 'unknown';
        log.error({ err: msg, chargeId, userId }, 'Admin Stripe refund failed');
        return res.status(500).json({ error: `Stripe refund failed: ${msg}` });
      }

      // Post-refund per-type cleanup.
      if (type === 'subscription') {
        if (user.stripeSubscriptionId) {
          await stripe.subscriptions.cancel(user.stripeSubscriptionId).catch(() => {});
        }
        await prisma.user.update({
          where: { id: userId },
          data: {
            stripeSubscriptionId: null,
            stripePlan: null,
            stripeStatus: 'canceled',
            stripePeriodEnd: null,
            nameColor: null,
            nameFont: null,
            nameEffect: null,
            avatarEffect: null,
            banner: null,
            backgroundImage: null,
          },
        });
        // Revoke power-ups now exceeding the post-refund allowance.
        const deployedPowerUps = await prisma.serverPowerUp.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          select: { id: true, serverId: true },
          take: 500,
        });
        const allowedAfter = user.powerUpPaidSlots ?? 0;
        if (deployedPowerUps.length > allowedAfter) {
          const toRemove = deployedPowerUps.slice(0, deployedPowerUps.length - allowedAfter);
          const serverDecrements = new Map<string, number>();
          for (const b of toRemove) {
            serverDecrements.set(b.serverId, (serverDecrements.get(b.serverId) ?? 0) + 1);
          }
          await prisma.$transaction([
            prisma.serverPowerUp.deleteMany({ where: { id: { in: toRemove.map(b => b.id) } } }),
            ...Array.from(serverDecrements.entries()).map(([serverId, count]) =>
              prisma.$executeRaw`UPDATE "Server" SET "powerUpCount" = GREATEST("powerUpCount" - ${count}, 0) WHERE id = ${serverId}::uuid`
            ),
          ]);
        }
      } else if (type === 'gift') {
        const giftToRefund = await prisma.giftSubscription.findFirst({
          where: { senderId: userId, status: 'pending' },
          orderBy: { createdAt: 'desc' },
        });
        if (giftToRefund) {
          await prisma.giftSubscription.updateMany({
            where: { id: giftToRefund.id, status: 'pending' },
            data: { status: 'refunded' },
          });
        }
      } else if (type === 'power_up') {
        if (user.powerUpSubscriptionId) {
          await stripe.subscriptions.cancel(user.powerUpSubscriptionId).catch(() => {});
        }
        await prisma.user.update({
          where: { id: userId },
          data: { powerUpSubscriptionId: null, powerUpPaidSlots: 0 },
        });
        const userForPlan = await prisma.user.findUnique({
          where: { id: userId },
          select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true },
        });
        const proFreeSlots = (userForPlan && getEffectivePlan(userForPlan) === 'pro') ? 2 : 0;
        const totalAllowed = proFreeSlots;

        const deployedPowerUps = await prisma.serverPowerUp.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          select: { id: true, serverId: true },
          take: 500,
        });

        if (deployedPowerUps.length > totalAllowed) {
          const toRemove = deployedPowerUps.slice(0, deployedPowerUps.length - totalAllowed);
          const serverDecrements = new Map<string, number>();
          for (const b of toRemove) {
            serverDecrements.set(b.serverId, (serverDecrements.get(b.serverId) ?? 0) + 1);
          }
          await prisma.$transaction([
            prisma.serverPowerUp.deleteMany({ where: { id: { in: toRemove.map(b => b.id) } } }),
            ...Array.from(serverDecrements.entries()).map(([serverId, count]) =>
              prisma.$executeRaw`UPDATE "Server" SET "powerUpCount" = GREATEST("powerUpCount" - ${count}, 0) WHERE id = ${serverId}::uuid`
            ),
          ]);
        }
      }

      // Saga: finalize Refund row.
      await prisma.refund.update({
        where: { id: refundRecord.id },
        data: {
          status: 'completed',
          stripeRefundId: stripeRefund.id,
          completedAt: new Date(),
        },
      });

      // Burn cross-account tracking row even on admin override — we want future
      // self-serve eligibility checks to know this account got its category refund.
      await prisma.refundUsage.create({
        data: {
          type,
          emailHash: user.emailHash,
          stripeCustomerId: user.stripeCustomerId,
          paymentMethodFingerprint,
          refundId: refundRecord.id,
        },
      });

      await logAction(req.adminId!, 'refund_issued', userId, {
        refundId: refundRecord.id,
        chargeId,
        type,
        amount: charge.amount,
        currency: charge.currency,
        override: !!override,
        overrideReason: overrideReason || null,
      });

      log.info({ adminId: req.adminId, userId, refundId: refundRecord.id, type, chargeId, amount: charge.amount, override: !!override }, 'Admin refund completed');

      return res.json({
        success: true,
        refundId: refundRecord.id,
        stripeRefundId: stripeRefund.id,
        amount: charge.amount,
        currency: charge.currency,
        type,
      });
    } finally {
      if (redis) {
        await redis.del(lockKey).catch(() => {});
      }
    }
  } catch (err) {
    log.error({ err }, 'admin refund error');
    return res.status(500).json({ error: 'Failed to process refund' });
  }
});

export default router;
