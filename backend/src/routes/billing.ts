// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { createCheckoutSchema, startTrialSchema, giftSchema, assignGiftSchema, redeemSchema, claimGiftSchema, powerUpCheckoutSchema, refundSchema } from '../schemas.js';
import { postGiftDmCard, markGiftDmCardClaimed } from '../services/giftDmCard.js';
import { decryptSecret } from '../services/mfaCrypto.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { redis } from '../redis.js';
import { getEffectivePlan } from '../utils.js';
import { getIO } from '../socketIO.js';
import { getClientIp } from '../utils/clientIp.js';

const redeemLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:redeem:'),
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many redeem attempts. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId || getClientIp(req) || 'unknown',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const log = logger.child({ module: 'billing' });

const router = Router();

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
});

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set. Add it to backend/.env to enable billing.');
    // Pin API version so SDK upgrades don't silently change response shapes
    // (e.g. 2026-02-25.clover removed Invoice.charge in favor of Invoice.payments).
    _stripe = new Stripe(key, { apiVersion: '2026-02-25.clover' });
  }
  return _stripe;
}

const ESSENTIAL_PRICE_ID = process.env.STRIPE_ESSENTIAL_PRICE_ID || '';
const PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID || '';
const POWER_UP_PRICE_ID = process.env.STRIPE_POWER_UP_PRICE_ID || process.env.STRIPE_BOOST_PRICE_ID || '';

function getSubPeriodEnd(sub: Stripe.Subscription): Date | null {
  const ts = sub.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000) : null;
}

/**
 * Emit `subscription-updated` to the user's personal Socket.IO room.
 * Fires after every DB write that changes billing state so connected
 * clients can update immediately without polling.
 */
function emitSubscriptionUpdated(userId: string, data: {
  stripePlan: string | null;
  stripeStatus: string | null;
  stripePeriodEnd: Date | string | null;
  powerUpPaidSlots?: number;
}): void {
  try {
    const io = getIO();
    io.to(`user:${userId}`).emit('subscription-updated', {
      stripePlan: data.stripePlan,
      stripeStatus: data.stripeStatus,
      stripePeriodEnd: data.stripePeriodEnd instanceof Date
        ? data.stripePeriodEnd.toISOString()
        : data.stripePeriodEnd,
      ...(data.powerUpPaidSlots !== undefined ? { powerUpPaidSlots: data.powerUpPaidSlots } : {}),
    });
  } catch {
    // Socket.IO may not be initialized in tests — silently skip
  }
}

async function getOrCreateStripeCustomer(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, stripeCustomerId: true, email: true },
  });
  if (!user) throw new Error('User not found');

  if (user.stripeCustomerId) return user.stripeCustomerId;

  let plainEmail: string;
  try { plainEmail = decryptSecret(user.email); } catch { plainEmail = user.email; }

  const customer = await getStripe().customers.create({
    email: plainEmail,
    metadata: { howlUserId: userId },
  });

  // Atomic: only set if still null (another concurrent request may have won the race)
  const updated = await prisma.user.updateMany({
    where: { id: userId, stripeCustomerId: null },
    data: { stripeCustomerId: customer.id },
  });

  if (updated.count === 0) {
    // Another request won — clean up our orphaned Stripe customer and return the existing one
    await getStripe().customers.del(customer.id).catch(() => {});
    const refreshed = await prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
    if (!refreshed?.stripeCustomerId) throw new Error('Failed to get Stripe customer ID');
    return refreshed.stripeCustomerId;
  }

  return customer.id;
}

const billingReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:billing-read:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const billingSessionLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:billing-session:'),
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req: any) => (req as AuthRequest).userId || getClientIp(req) || 'unknown',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
  message: { error: 'Too many requests. Please try again later.' },
});

const giftLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:gift:'),
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req: any) => (req as AuthRequest).userId || getClientIp(req) || 'unknown',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
  message: { error: 'Too many requests. Please try again later.' },
});

const refundLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:refund:'),
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { error: 'Too many refund requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const REFUND_WINDOW_MS = 5 * 24 * 60 * 60 * 1000; // 5 days in milliseconds
const MAX_REFUNDABLE_AMOUNT_CENTS = 10000; // $100 safety ceiling

// POST /api/billing/create-checkout
router.post('/create-checkout', authenticateToken, billingSessionLimiter, validate(createCheckoutSchema), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const { plan } = req.body as { plan: 'essential' | 'pro' };

    const priceId = plan === 'essential' ? ESSENTIAL_PRICE_ID : PRO_PRICE_ID;
    if (!priceId) {
      return res.status(500).json({ error: 'This plan is not available at the moment.' });
    }

    // Prevent concurrent subscription creation
    const lockKey = `checkout:lock:${req.userId}`;
    if (redis) {
      const acquired = await redis.set(lockKey, '1', 'EX', 30, 'NX');
      if (!acquired) {
        return res.status(429).json({ error: 'A checkout is already in progress' });
      }
    }
    try {
      // Check if user already has an active subscription
      const existingUser = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { stripeSubscriptionId: true, stripeStatus: true },
      });
      // Block second-checkout for any "live" subscription state, not just
      // 'active'. A user in 'trialing' or 'past_due' still has a Stripe
      // subscription on file — letting them check out again creates a
      // duplicate that the webhook will then orphan when it overwrites the
      // user's stripeSubscriptionId.
      const liveStatuses = new Set(['active', 'trialing', 'past_due']);
      if (existingUser?.stripeSubscriptionId && existingUser.stripeStatus && liveStatuses.has(existingUser.stripeStatus)) {
        return res.status(400).json({ error: 'You already have a subscription. Manage it from your subscription settings.' });
      }

      const customerId = await getOrCreateStripeCustomer(req.userId);

      const allowedOrigin = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000').split(',')[0].trim();
      const baseUrl = allowedOrigin.replace(/\/$/, '');

      const session = await getStripe().checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${baseUrl}?billing=success`,
        cancel_url: `${baseUrl}?billing=cancel`,
        payment_method_collection: 'always',
        metadata: { howlUserId: req.userId, plan },
      });

      return res.json({ url: session.url });
    } finally {
      if (redis) await redis.del(lockKey).catch(() => {});
    }
  } catch (err) {
    log.error({ err }, 'create-checkout error');
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/billing/start-trial — Step 1: Collect card via setup mode
router.post('/start-trial', authenticateToken, billingSessionLimiter, validate(startTrialSchema), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const { plan } = req.body as { plan: 'essential' | 'pro' };

    const priceId = plan === 'essential' ? ESSENTIAL_PRICE_ID : PRO_PRICE_ID;
    if (!priceId) {
      return res.status(500).json({ error: 'This plan is not available at the moment.' });
    }

    // Layer 1: User-level eligibility check
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { hasUsedTrial: true, stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true },
    });

    if (user?.hasUsedTrial) {
      return res.status(400).json({ error: 'You have already used your free trial.' });
    }
    if (user && getEffectivePlan(user) !== 'free') {
      return res.status(400).json({ error: 'You already have an active subscription.' });
    }

    // Check for existing pending setup (prevent spamming)
    const existingPending = await prisma.pendingTrialSetup.findFirst({
      where: { userId: req.userId, status: 'pending', expiresAt: { gt: new Date() } },
    });
    if (existingPending) {
      return res.status(429).json({ error: 'You already have a pending trial setup. Please complete or wait for it to expire.' });
    }

    const customerId = await getOrCreateStripeCustomer(req.userId);

    const allowedOrigin = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000').split(',')[0].trim();
    const baseUrl = allowedOrigin.replace(/\/$/, '');

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    // Create setup-mode checkout session (card save only, no charge)
    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      mode: 'setup',
      payment_method_types: ['card'],
      success_url: `${baseUrl}?trial-setup=pending&setupId={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}?trial-setup=canceled`,
      metadata: {
        howlUserId: req.userId,
        plan,
        isTrialSetup: 'true',
      },
      expires_at: Math.floor(expiresAt.getTime() / 1000),
    });

    // Record pending setup
    await prisma.pendingTrialSetup.create({
      data: {
        userId: req.userId,
        plan,
        stripeCheckoutSessionId: session.id,
        stripeCustomerId: customerId,
        status: 'pending',
        expiresAt,
      },
    });

    return res.json({ url: session.url, setupId: session.id });
  } catch (err) {
    log.error({ err }, 'start-trial error');
    return res.status(500).json({ error: 'Failed to start trial setup' });
  }
});

// GET /api/billing/trial-status/:setupId — Frontend polls this after redirect
router.get('/trial-status/:setupId', authenticateToken, billingReadLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const { setupId } = req.params;
    if (!setupId || typeof setupId !== 'string') {
      return res.status(400).json({ error: 'Missing setupId' });
    }

    const setup = await prisma.pendingTrialSetup.findUnique({
      where: { stripeCheckoutSessionId: setupId },
    });

    if (!setup) return res.status(404).json({ error: 'Setup not found' });

    // Security: only the user who created the setup can check its status
    if (setup.userId !== req.userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Check if expired
    if (setup.status === 'pending' && setup.expiresAt < new Date()) {
      await prisma.pendingTrialSetup.update({
        where: { id: setup.id },
        data: { status: 'expired' },
      });
      return res.json({ status: 'expired', message: 'Trial setup expired. Please try again.' });
    }

    return res.json({
      status: setup.status,
      trialResult: setup.trialResult,
      message: setup.resultMessage,
      plan: setup.plan,
    });
  } catch (err) {
    log.error({ err }, 'trial-status error');
    return res.status(500).json({ error: 'Failed to check trial status' });
  }
});

// POST /api/billing/create-portal
router.post('/create-portal', authenticateToken, billingSessionLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, stripeCustomerId: true },
    });
    if (!user?.stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found. Subscribe to a plan first.' });
    }

    const allowedOrigin = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000').split(',')[0].trim();
    const baseUrl = allowedOrigin.replace(/\/$/, '');

    const session = await getStripe().billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: baseUrl,
    });

    return res.json({ url: session.url });
  } catch (err) {
    log.error({ err }, 'create-portal error');
    return res.status(500).json({ error: 'Failed to create billing portal session' });
  }
});

// GET /api/billing/trial-eligibility — Check if user can start a free trial
router.get('/trial-eligibility', authenticateToken, billingReadLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        hasUsedTrial: true,
        stripePlan: true,
        stripeStatus: true,
        stripePeriodEnd: true,
        stripeSubscriptionId: true,
      },
    });

    const isSubscribed = user ? getEffectivePlan(user) !== 'free' : false;
    const eligible = !user?.hasUsedTrial && !isSubscribed;

    return res.json({
      eligible,
      reason: isSubscribed
        ? 'already_subscribed'
        : user?.hasUsedTrial
        ? 'trial_already_used'
        : null,
    });
  } catch (err) {
    log.error({ err }, 'trial-eligibility error');
    return res.status(500).json({ error: 'Failed to check trial eligibility' });
  }
});

// GET /api/billing/subscription
router.get('/subscription', authenticateToken, billingReadLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        stripePlan: true,
        stripeStatus: true,
        stripePeriodEnd: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        hasUsedTrial: true,
        trialStartedAt: true,
      },
    });

    const effectivePlan = user ? getEffectivePlan(user) : 'free';
    if (!user || effectivePlan === 'free') {
      return res.json({ plan: null, status: null, currentPeriodEnd: null, hasUsedTrial: user?.hasUsedTrial ?? false, trialStartedAt: null, cancelAtPeriodEnd: false });
    }

    let cancelAtPeriodEnd = false;
    if (user.stripeSubscriptionId && user.stripeStatus === 'active') {
      try {
        const sub = await getStripe().subscriptions.retrieve(user.stripeSubscriptionId);
        cancelAtPeriodEnd = sub.cancel_at_period_end === true;
      } catch {
        // Stripe unreachable — assume not canceling (safe default)
      }
    }

    return res.json({
      plan: user.stripePlan,
      status: user.stripeStatus,
      currentPeriodEnd: user.stripePeriodEnd?.toISOString() ?? null,
      hasUsedTrial: user.hasUsedTrial ?? false,
      trialStartedAt: user.trialStartedAt?.toISOString() ?? null,
      cancelAtPeriodEnd,
    });
  } catch (err) {
    log.error({ err }, 'get-subscription error');
    return res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// Gift code helpers

function generateGiftCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `HOWL-${seg()}-${seg()}-${seg()}`;
}

// POST /api/billing/gift — Send a gift subscription to another user
router.post('/gift', authenticateToken, giftLimiter, validate(giftSchema), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const { plan, durationMonths, recipientUsername } = req.body as {
      plan?: string; durationMonths?: number; recipientUsername?: string;
    };

    if (plan !== 'essential' && plan !== 'pro') {
      return res.status(400).json({ error: 'Plan must be "essential" or "pro".' });
    }
    if (!durationMonths || !Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 12) {
      return res.status(400).json({ error: 'Duration must be 1-12 months.' });
    }

    const sender = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { stripeCustomerId: true },
    });
    if (!sender) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const priceId = plan === 'essential' ? ESSENTIAL_PRICE_ID : PRO_PRICE_ID;
    if (!priceId) {
      return res.status(500).json({ error: 'This plan is not available for gifting at the moment.' });
    }

    let recipientId: string | null = null;
    if (recipientUsername) {
      const parts = recipientUsername.split('#');
      if (parts.length !== 2) return res.status(400).json({ error: 'Use format username#0000.' });
      const [name, disc] = parts;
      const recipient = await prisma.user.findUnique({
        where: { username_discriminator: { username: name, discriminator: disc } },
        select: { id: true },
      });
      if (!recipient) return res.status(404).json({ error: 'User not found.' });
      if (recipient.id === req.userId) return res.status(400).json({ error: 'Cannot gift to yourself.' });
      recipientId = recipient.id;
    }

    let code = '';
    for (let attempts = 0; attempts < 10; attempts++) {
      const candidate = generateGiftCode();
      const exists = await prisma.giftSubscription.findUnique({ where: { code: candidate } });
      if (!exists) { code = candidate; break; }
    }
    if (!code) return res.status(500).json({ error: 'Unable to generate unique gift code. Please try again.' });

    const allowedOrigin = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000').split(',')[0].trim();
    const baseUrl = allowedOrigin.replace(/\/$/, '');

    const giftRecord = await prisma.giftSubscription.create({
      data: {
        code,
        plan,
        durationMonths,
        senderId: req.userId,
        recipientId,
        recipientUsername: recipientUsername || null,
        status: 'payment_pending',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const customerId = await getOrCreateStripeCustomer(req.userId);
    const stripePrice = await getStripe().prices.retrieve(priceId);
    const unitAmount = stripePrice.unit_amount!;
    const totalAmount = unitAmount * durationMonths;

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: stripePrice.currency,
          product_data: {
            name: `Howl ${plan === 'essential' ? 'Essential' : 'Pro'} Gift · ${durationMonths} month${durationMonths > 1 ? 's' : ''}`,
          },
          unit_amount: totalAmount,
        },
        quantity: 1,
      }],
      success_url: `${baseUrl}?gift=success`,
      cancel_url: `${baseUrl}?gift=cancel`,
      metadata: { howlGiftId: giftRecord.id, giftCode: code },
    });

    return res.json({ url: session.url, code });
  } catch (err) {
    log.error({ err }, 'gift error');
    return res.status(500).json({ error: 'Failed to create gift' });
  }
});

// POST /api/billing/redeem — Redeem a gift code
router.post('/redeem', authenticateToken, redeemLimiter, validate(redeemSchema), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const { code } = req.body as { code?: string };
    if (!code || typeof code !== 'string') return res.status(400).json({ error: 'Code is required.' });

    const normalised = code.trim().toUpperCase();
    const gift = await prisma.giftSubscription.findUnique({ where: { code: normalised } });
    if (!gift) return res.status(404).json({ error: 'Invalid or unknown code.' });
    if (gift.status !== 'pending') return res.status(400).json({ error: 'This code is not available for redemption.' });
    if (gift.expiresAt && gift.expiresAt < new Date()) {
      await prisma.giftSubscription.update({ where: { id: gift.id }, data: { status: 'expired' } });
      return res.status(400).json({ error: 'This code has expired.' });
    }
    if (gift.recipientId && gift.recipientId !== req.userId) {
      return res.status(403).json({ error: 'This gift was sent to a different user.' });
    }
    if (gift.senderId === req.userId) {
      return res.status(400).json({ error: 'You cannot redeem your own gift.' });
    }

    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + gift.durationMonths);

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true },
    });

    const MAX_GIFT_STACK_MONTHS = 24;
    let newPeriodEnd = periodEnd;
    if (user?.stripePlan === gift.plan && user.stripePeriodEnd && user.stripePeriodEnd > new Date()) {
      newPeriodEnd = new Date(user.stripePeriodEnd);
      newPeriodEnd.setMonth(newPeriodEnd.getMonth() + gift.durationMonths);
      const maxEnd = new Date();
      maxEnd.setMonth(maxEnd.getMonth() + MAX_GIFT_STACK_MONTHS);
      if (newPeriodEnd > maxEnd) newPeriodEnd = maxEnd;
    }

    await prisma.$transaction(async (tx) => {
      // Atomic recipient guard: if the gift has been assigned to another user
      // mid-flight (TOCTOU), the WHERE clause excludes us and updateMany
      // returns count 0. The pre-transaction check above is a fast 403 path;
      // this is the source of truth.
      const claimed = await tx.giftSubscription.updateMany({
        where: {
          id: gift.id,
          status: 'pending',
          OR: [
            { recipientId: null },
            { recipientId: req.userId },
          ],
        },
        data: { status: 'redeemed', recipientId: req.userId, redeemedAt: new Date() },
      });
      if (claimed.count === 0) throw new Error('Gift already redeemed or sent to a different user');
      await tx.user.update({
        where: { id: req.userId },
        data: {
          stripePlan: gift.plan,
          stripeStatus: 'active',
          stripePeriodEnd: newPeriodEnd,
        },
      });
    });

    emitSubscriptionUpdated(req.userId, {
      stripePlan: gift.plan,
      stripeStatus: 'active',
      stripePeriodEnd: newPeriodEnd,
    });

    // If the gift had an associated DM card, flip it to "Claimed" state.
    markGiftDmCardClaimed(gift.id).catch(err => log.warn({ err, giftId: gift.id }, 'mark gift dm card claimed failed'));

    return res.json({
      success: true,
      plan: gift.plan,
      durationMonths: gift.durationMonths,
      periodEnd: newPeriodEnd.toISOString(),
    });
  } catch (err) {
    log.error({ err }, 'redeem error');
    return res.status(500).json({ error: 'Failed to redeem code' });
  }
});

// GET /api/billing/gifts — Get user's sent and received gifts
router.get('/gifts', authenticateToken, billingReadLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const [sent, received] = await Promise.all([
      prisma.giftSubscription.findMany({
        where: { senderId: req.userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true, code: true, plan: true, durationMonths: true,
          recipientUsername: true, status: true, createdAt: true, expiresAt: true,
          recipient: { select: { username: true, discriminator: true, avatar: true } },
        },
      }),
      prisma.giftSubscription.findMany({
        where: { recipientId: req.userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true, plan: true, durationMonths: true, status: true,
          createdAt: true, redeemedAt: true,
          sender: { select: { username: true, discriminator: true, avatar: true } },
        },
      }),
    ]);

    return res.json({ sent, received });
  } catch (err) {
    log.error({ err }, 'get-gifts error');
    return res.status(500).json({ error: 'Failed to fetch gifts' });
  }
});

// POST /api/billing/gifts/:giftId/assign — Assign a recipient to a purchased gift
router.post('/gifts/:giftId/assign', authenticateToken, giftLimiter, validate(assignGiftSchema), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const giftId = req.params.giftId as string;
    const { recipientUsername } = req.body as { recipientUsername: string };

    const gift = await prisma.giftSubscription.findUnique({ where: { id: giftId } });
    if (!gift || gift.senderId !== req.userId) {
      return res.status(404).json({ error: 'Gift not found.' });
    }
    if (gift.status !== 'pending') {
      return res.status(400).json({ error: 'Gift is not in a valid state for assignment.' });
    }
    if (gift.expiresAt && new Date(gift.expiresAt) < new Date()) {
      return res.status(400).json({ error: 'Gift has expired.' });
    }
    if (gift.recipientId) {
      return res.status(400).json({ error: 'Gift already has a recipient assigned.' });
    }

    const parts = recipientUsername.split('#');
    if (parts.length !== 2) return res.status(400).json({ error: 'Use format username#0000.' });
    const [name, disc] = parts;
    const recipient = await prisma.user.findUnique({
      where: { username_discriminator: { username: name, discriminator: disc } },
      select: { id: true },
    });
    if (!recipient) return res.status(404).json({ error: 'User not found.' });
    if (recipient.id === req.userId) return res.status(400).json({ error: 'Cannot assign a gift to yourself.' });

    const result = await prisma.giftSubscription.updateMany({
      where: { id: giftId, recipientId: null },
      data: { recipientId: recipient.id, recipientUsername: recipientUsername.trim() },
    });
    if (result.count === 0) return res.status(409).json({ error: 'Gift was already assigned.' });

    const updated = await prisma.giftSubscription.findUnique({
      where: { id: giftId },
      select: { id: true, code: true, plan: true, durationMonths: true, recipientUsername: true },
    });

    // Best-effort DM notification — posts a `kind:'gift'` system card into the
    // sender↔recipient 1:1 DM channel if one exists. No new channel is created
    // (E2EE bootstrap requires client keys); the recipient still sees the gift
    // in their Gift Inventory's Received list with a Claim button regardless.
    if (updated) {
      postGiftDmCard({
        senderId: req.userId,
        recipientId: recipient.id,
        giftId,
        plan: updated.plan,
        durationMonths: updated.durationMonths,
      }).catch(err => log.warn({ err, giftId }, 'gift dm card post failed'));
    }

    return res.json({ success: true, gift: updated });
  } catch (err) {
    log.error({ err }, 'assign-gift error');
    return res.status(500).json({ error: 'Failed to assign gift' });
  }
});

// POST /api/billing/gifts/:giftId/claim — Claim a gift assigned to me
// (no code exchange). The recipientId is enforced atomically inside the
// transaction's WHERE clause, so concurrent claim attempts cannot race
// past each other and the assignment cannot be bypassed mid-flight.
router.post('/gifts/:giftId/claim', authenticateToken, redeemLimiter, validate(claimGiftSchema), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const giftId = req.params.giftId as string;

    const gift = await prisma.giftSubscription.findUnique({ where: { id: giftId } });
    if (!gift) return res.status(404).json({ error: 'Gift not found.' });
    if (gift.recipientId !== req.userId) {
      return res.status(403).json({ error: 'This gift was sent to a different user.' });
    }
    if (gift.status !== 'pending') {
      return res.status(400).json({ error: 'This gift is no longer claimable.' });
    }
    if (gift.expiresAt && gift.expiresAt < new Date()) {
      await prisma.giftSubscription.update({ where: { id: gift.id }, data: { status: 'expired' } });
      return res.status(400).json({ error: 'This gift has expired.' });
    }

    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + gift.durationMonths);

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true },
    });

    const MAX_GIFT_STACK_MONTHS = 24;
    let newPeriodEnd = periodEnd;
    if (user?.stripePlan === gift.plan && user.stripePeriodEnd && user.stripePeriodEnd > new Date()) {
      newPeriodEnd = new Date(user.stripePeriodEnd);
      newPeriodEnd.setMonth(newPeriodEnd.getMonth() + gift.durationMonths);
      const maxEnd = new Date();
      maxEnd.setMonth(maxEnd.getMonth() + MAX_GIFT_STACK_MONTHS);
      if (newPeriodEnd > maxEnd) newPeriodEnd = maxEnd;
    }

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.giftSubscription.updateMany({
        where: {
          id: gift.id,
          status: 'pending',
          recipientId: req.userId,
        },
        data: { status: 'redeemed', redeemedAt: new Date() },
      });
      if (claimed.count === 0) throw new Error('Gift no longer claimable');
      await tx.user.update({
        where: { id: req.userId },
        data: { stripePlan: gift.plan, stripeStatus: 'active', stripePeriodEnd: newPeriodEnd },
      });
    });

    emitSubscriptionUpdated(req.userId, {
      stripePlan: gift.plan,
      stripeStatus: 'active',
      stripePeriodEnd: newPeriodEnd,
    });

    markGiftDmCardClaimed(gift.id).catch(err => log.warn({ err, giftId: gift.id }, 'mark gift dm card claimed failed'));

    return res.json({
      success: true,
      plan: gift.plan,
      durationMonths: gift.durationMonths,
      periodEnd: newPeriodEnd.toISOString(),
    });
  } catch (err) {
    log.error({ err }, 'claim-gift error');
    return res.status(500).json({ error: 'Failed to claim gift' });
  }
});

// Power-up subscription helpers & routes

async function revokeExcessPowerUps(userId: string, newPaidSlots: number): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true },
  });
  const freeSlots = (user && getEffectivePlan(user) === 'pro') ? 2 : 0;
  const totalAllowed = freeSlots + newPaidSlots;

  const deployedPowerUps = await prisma.serverPowerUp.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, serverId: true },
    take: 500,
  });

  if (deployedPowerUps.length <= totalAllowed) {
    await prisma.user.update({ where: { id: userId }, data: { powerUpPaidSlots: newPaidSlots } });
    return;
  }

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
    prisma.user.update({ where: { id: userId }, data: { powerUpPaidSlots: newPaidSlots } }),
  ]);
}

// POST /api/billing/power-up-checkout — purchase power-up slots
router.post('/power-up-checkout', authenticateToken, billingSessionLimiter, validate(powerUpCheckoutSchema), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    if (!POWER_UP_PRICE_ID) return res.status(500).json({ error: 'Power-up purchasing is not available at the moment.' });

    const { quantity } = req.body as { quantity: number };
    const customerId = await getOrCreateStripeCustomer(req.userId);

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { powerUpSubscriptionId: true },
    });

    if (user?.powerUpSubscriptionId) {
      try {
        const existingSub = await getStripe().subscriptions.retrieve(user.powerUpSubscriptionId);
        if (existingSub.status === 'active' || existingSub.status === 'trialing') {
          const portalSession = await getStripe().billingPortal.sessions.create({
            customer: customerId,
            return_url: `${(process.env.FRONTEND_ORIGIN || 'http://localhost:3000').split(',')[0].trim().replace(/\/$/, '')}`,
            flow_data: {
              type: 'subscription_update_confirm',
              subscription_update_confirm: {
                subscription: user.powerUpSubscriptionId,
                items: [{ id: existingSub.items.data[0].id, quantity, price: POWER_UP_PRICE_ID }],
              },
            },
          });
          return res.json({ portalUrl: portalSession.url });
        }
      } catch { /* subscription may be invalid, fall through to create new */ }
    }

    const allowedOrigin = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000').split(',')[0].trim();
    const baseUrl = allowedOrigin.replace(/\/$/, '');

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: POWER_UP_PRICE_ID, quantity }],
      success_url: `${baseUrl}?powerUp=success`,
      cancel_url: `${baseUrl}?powerUp=cancel`,
      metadata: { howlUserId: req.userId, type: 'power_up_purchase' },
    });

    return res.json({ url: session.url });
  } catch (err) {
    log.error({ err }, 'power-up-checkout error');
    return res.status(500).json({ error: 'Failed to create power-up checkout session' });
  }
});

// POST /api/billing/power-up-manage — manage existing power-up subscription
router.post('/power-up-manage', authenticateToken, billingSessionLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { powerUpSubscriptionId: true, stripeCustomerId: true },
    });
    if (!user?.powerUpSubscriptionId) return res.status(400).json({ error: 'No power-up subscription found.' });
    if (!user.stripeCustomerId) return res.status(400).json({ error: 'No billing account found.' });

    const portalSession = await getStripe().billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${(process.env.FRONTEND_ORIGIN || 'http://localhost:3000').split(',')[0].trim().replace(/\/$/, '')}`,
    });

    return res.json({ url: portalSession.url });
  } catch (err) {
    log.error({ err }, 'power-up-manage error');
    return res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// GET /api/billing/payment-methods — List Stripe payment methods
router.get('/payment-methods', authenticateToken, billingReadLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { stripeCustomerId: true },
    });
    if (!user?.stripeCustomerId) return res.json({ methods: [] });

    const methods = await getStripe().paymentMethods.list({
      customer: user.stripeCustomerId,
      type: 'card',
    });

    const formatted = methods.data.map(m => ({
      id: m.id,
      brand: m.card?.brand || 'unknown',
      last4: m.card?.last4 || '****',
      expMonth: m.card?.exp_month,
      expYear: m.card?.exp_year,
      isDefault: false,
    }));

    // Mark the default payment method
    try {
      const customer = await getStripe().customers.retrieve(user.stripeCustomerId) as Stripe.Customer;
      const defaultPm = typeof customer.invoice_settings?.default_payment_method === 'string'
        ? customer.invoice_settings.default_payment_method
        : (customer.invoice_settings?.default_payment_method as Stripe.PaymentMethod | null)?.id;
      if (defaultPm) {
        const match = formatted.find(m => m.id === defaultPm);
        if (match) match.isDefault = true;
      }
    } catch (err) { log.warn({ err }, 'Could not determine default payment method'); }

    return res.json({ methods: formatted });
  } catch (err) {
    log.error({ err }, 'payment-methods error');
    return res.status(500).json({ error: 'Failed to fetch payment methods' });
  }
});

// GET /api/billing/transactions — List Stripe invoices/transactions
router.get('/transactions', authenticateToken, billingReadLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { stripeCustomerId: true },
    });
    if (!user?.stripeCustomerId) return res.json({ transactions: [] });

    const invoices = await getStripe().invoices.list({
      customer: user.stripeCustomerId,
      limit: 50,
    });

    const transactions = invoices.data.map(inv => ({
      id: inv.id,
      amount: inv.amount_paid,
      currency: inv.currency,
      status: inv.status,
      description: inv.lines?.data?.[0]?.description || 'Howl subscription',
      created: new Date((inv.created || 0) * 1000).toISOString(),
      invoiceUrl: inv.hosted_invoice_url || null,
      invoicePdf: inv.invoice_pdf || null,
    }));

    return res.json({ transactions });
  } catch (err) {
    log.error({ err }, 'transactions error');
    return res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Stripe API 2026-02-25.clover removed Invoice.charge; payments now flow
// through Invoice.payments. Caller must `expand: ['data.payments']` on the list.
// Exported for unit testing — see tests/refundChargeExtraction.test.ts
export async function getInvoiceChargeIds(stripe: Stripe, invoice: Stripe.Invoice): Promise<string[]> {
  const ids: string[] = [];
  for (const ip of invoice.payments?.data ?? []) {
    if (ip.status !== 'paid') continue;
    const payment = ip.payment;
    if (payment.type === 'charge' && payment.charge) {
      ids.push(typeof payment.charge === 'string' ? payment.charge : payment.charge.id);
    } else if (payment.type === 'payment_intent' && payment.payment_intent) {
      const piId = typeof payment.payment_intent === 'string' ? payment.payment_intent : payment.payment_intent.id;
      try {
        const pi = await stripe.paymentIntents.retrieve(piId);
        if (pi.latest_charge) {
          ids.push(typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge.id);
        }
      } catch {
        // PI retrieval failures are non-fatal — caller treats absence as ineligible
      }
    }
  }
  return ids;
}

// Cross-account anti-bypass: a refund "burns" the user's emailHash, stripeCustomerId,
// and paymentMethodFingerprint into RefundUsage. Account-delete + re-signup keeps
// these identifiers tied to the prior refund, so a fresh User row can't get a fresh refund.
type RefundIdentity = {
  emailHash: string | null;
  stripeCustomerId: string | null;
  paymentMethodFingerprint: string | null;
};

export async function isRefundUsageBlocked(
  type: 'subscription' | 'gift' | 'power_up',
  ids: RefundIdentity,
): Promise<boolean> {
  const orFilters: { emailHash?: string; stripeCustomerId?: string; paymentMethodFingerprint?: string }[] = [];
  if (ids.emailHash) orFilters.push({ emailHash: ids.emailHash });
  if (ids.stripeCustomerId) orFilters.push({ stripeCustomerId: ids.stripeCustomerId });
  if (ids.paymentMethodFingerprint) orFilters.push({ paymentMethodFingerprint: ids.paymentMethodFingerprint });
  if (orFilters.length === 0) return false;
  const hit = await prisma.refundUsage.findFirst({
    where: { type, OR: orFilters },
    select: { id: true },
  });
  return !!hit;
}

function getChargeCardFingerprint(charge: Stripe.Charge): string | null {
  return charge.payment_method_details?.card?.fingerprint ?? null;
}

// Infer refund type from a Stripe charge for out-of-band refunds (Stripe Dashboard).
// Stripe API 2026-02-25.clover removed Charge.invoice, so we can't go charge→invoice
// directly. Instead: gift via PI lookup, then walk customer invoices to find one
// containing this charge and check its subscription ID against the user's records.
// Returns null if we can't tell — caller should default cautiously and log.
export async function inferDashboardRefundType(
  charge: Stripe.Charge,
  user: { id: string; stripeCustomerId: string | null; stripeSubscriptionId: string | null; powerUpSubscriptionId: string | null },
): Promise<'subscription' | 'gift' | 'power_up' | null> {
  const piId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (piId) {
    const gift = await prisma.giftSubscription.findFirst({
      where: { senderId: user.id, stripePaymentIntentId: piId },
      select: { id: true },
    });
    if (gift) return 'gift';
  }

  if (!user.stripeCustomerId) return null;
  try {
    const stripe = getStripe();
    const invoices = await stripe.invoices.list({
      customer: user.stripeCustomerId,
      limit: 50,
      expand: ['data.payments'],
    });
    for (const inv of invoices.data) {
      const chargeIds = await getInvoiceChargeIds(stripe, inv);
      if (!chargeIds.includes(charge.id)) continue;
      const invAny = inv as unknown as { parent?: { subscription_details?: { subscription?: string | { id: string } } }; subscription?: string | { id: string } };
      const subRef = invAny.parent?.subscription_details?.subscription ?? invAny.subscription;
      const subId = typeof subRef === 'string' ? subRef : subRef?.id;
      if (subId) {
        if (subId === user.stripeSubscriptionId) return 'subscription';
        if (subId === user.powerUpSubscriptionId) return 'power_up';
      }
    }
  } catch {
    // Swallow — fall back to caller default.
  }
  return null;
}

type EligibilityHit = {
  eligible: true;
  chargeId: string;
  amount: number;
  currency: string;
  chargeDate: string;
  paymentMethodFingerprint: string | null;
  giftId: string | null; // populated only for type === 'gift'
};
type EligibilityResult = { eligible: false; reason: string } | EligibilityHit;

async function findEligibleCharge(
  userId: string,
  type: 'subscription' | 'gift' | 'power_up',
  user: {
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    powerUpSubscriptionId: string | null;
    hasUsedSubscriptionRefund: boolean;
    hasUsedGiftRefund: boolean;
    hasUsedPowerUpRefund: boolean;
    emailHash: string | null;
  }
): Promise<EligibilityResult> {
  const usedFlag = type === 'subscription' ? user.hasUsedSubscriptionRefund
    : type === 'gift' ? user.hasUsedGiftRefund
    : user.hasUsedPowerUpRefund;
  if (usedFlag) return { eligible: false, reason: 'already_refunded' };

  // Early cross-account block (pre-Stripe — cheap). Catches account-delete bypass
  // when emailHash or stripeCustomerId match a prior refund. Card-fingerprint match
  // is checked per-charge below since fingerprint requires retrieving the charge.
  if (await isRefundUsageBlocked(type, {
    emailHash: user.emailHash,
    stripeCustomerId: user.stripeCustomerId,
    paymentMethodFingerprint: null,
  })) {
    return { eligible: false, reason: 'already_refunded' };
  }

  if (!user.stripeCustomerId) return { eligible: false, reason: 'no_billing_account' };

  const stripe = getStripe();
  const now = Date.now();

  try {
    if (type === 'subscription') {
      if (!user.stripeSubscriptionId) return { eligible: false, reason: 'no_active_subscription' };

      const invoices = await stripe.invoices.list({
        customer: user.stripeCustomerId,
        subscription: user.stripeSubscriptionId,
        limit: 5,
        expand: ['data.payments'],
      });

      // Collect charge IDs from invoices, then batch-check existing refunds
      const subChargeEntries: { chargeId: string }[] = [];
      for (const inv of invoices.data) {
        if (inv.status !== 'paid') continue;
        const ids = await getInvoiceChargeIds(stripe, inv);
        for (const chargeId of ids) subChargeEntries.push({ chargeId });
      }
      const subChargeIds = subChargeEntries.map(e => e.chargeId);
      const subExistingRefunds = subChargeIds.length > 0
        ? await prisma.refund.findMany({
            where: { stripeChargeId: { in: subChargeIds } },
            select: { stripeChargeId: true },
            take: subChargeIds.length,
          })
        : [];
      const subRefundedIds = new Set(subExistingRefunds.map(r => r.stripeChargeId));

      for (const { chargeId } of subChargeEntries) {
        if (subRefundedIds.has(chargeId)) continue;
        const charge = await stripe.charges.retrieve(chargeId);
        if (charge.refunded) continue;
        const chargeDate = new Date(charge.created * 1000);
        if (now - chargeDate.getTime() > REFUND_WINDOW_MS) continue;
        if (charge.amount > MAX_REFUNDABLE_AMOUNT_CENTS) continue;

        const chargeCustomerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
        if (chargeCustomerId !== user.stripeCustomerId) continue;

        const fingerprint = getChargeCardFingerprint(charge);
        if (fingerprint && await isRefundUsageBlocked(type, { emailHash: null, stripeCustomerId: null, paymentMethodFingerprint: fingerprint })) {
          return { eligible: false, reason: 'already_refunded' };
        }

        return { eligible: true, chargeId, amount: charge.amount, currency: charge.currency, chargeDate: chargeDate.toISOString(), paymentMethodFingerprint: fingerprint, giftId: null };
      }
      return { eligible: false, reason: 'no_eligible_charge' };
    }

    if (type === 'gift') {
      const recentGift = await prisma.giftSubscription.findFirst({
        where: {
          senderId: userId,
          status: 'pending',
          createdAt: { gte: new Date(now - REFUND_WINDOW_MS) },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, stripePaymentIntentId: true, createdAt: true },
      });
      if (!recentGift) return { eligible: false, reason: 'no_eligible_gift' };

      const charges = await stripe.charges.list({
        customer: user.stripeCustomerId,
        limit: 20,
        created: { gte: Math.floor((now - REFUND_WINDOW_MS) / 1000) },
      });

      // Batch-check existing refunds for all gift charges at once
      const giftChargeIds = charges.data
        .filter(c => !c.refunded && c.status === 'succeeded')
        .map(c => c.id);
      const giftExistingRefunds = giftChargeIds.length > 0
        ? await prisma.refund.findMany({
            where: { stripeChargeId: { in: giftChargeIds } },
            select: { stripeChargeId: true },
            take: giftChargeIds.length,
          })
        : [];
      const giftRefundedIds = new Set(giftExistingRefunds.map(r => r.stripeChargeId));

      for (const charge of charges.data) {
        if (charge.refunded || charge.status !== 'succeeded') continue;
        if (charge.amount > MAX_REFUNDABLE_AMOUNT_CENTS) continue;

        const chargeCustomerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
        if (chargeCustomerId !== user.stripeCustomerId) continue;

        if (recentGift.stripePaymentIntentId) {
          const chargePi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
          if (chargePi !== recentGift.stripePaymentIntentId) continue;
        }

        const chargeDate = new Date(charge.created * 1000);
        if (now - chargeDate.getTime() > REFUND_WINDOW_MS) continue;

        if (giftRefundedIds.has(charge.id)) continue;

        const fingerprint = getChargeCardFingerprint(charge);
        if (fingerprint && await isRefundUsageBlocked(type, { emailHash: null, stripeCustomerId: null, paymentMethodFingerprint: fingerprint })) {
          return { eligible: false, reason: 'already_refunded' };
        }

        return { eligible: true, chargeId: charge.id, amount: charge.amount, currency: charge.currency, chargeDate: chargeDate.toISOString(), paymentMethodFingerprint: fingerprint, giftId: recentGift.id };
      }
      return { eligible: false, reason: 'no_eligible_charge' };
    }

    if (type === 'power_up') {
      if (!user.powerUpSubscriptionId) return { eligible: false, reason: 'no_active_power_up' };

      const invoices = await stripe.invoices.list({
        customer: user.stripeCustomerId,
        subscription: user.powerUpSubscriptionId,
        limit: 5,
        expand: ['data.payments'],
      });

      // Collect charge IDs from invoices, then batch-check existing refunds
      const puChargeEntries: { chargeId: string }[] = [];
      for (const inv of invoices.data) {
        if (inv.status !== 'paid') continue;
        const ids = await getInvoiceChargeIds(stripe, inv);
        for (const chargeId of ids) puChargeEntries.push({ chargeId });
      }
      const puChargeIds = puChargeEntries.map(e => e.chargeId);
      const puExistingRefunds = puChargeIds.length > 0
        ? await prisma.refund.findMany({
            where: { stripeChargeId: { in: puChargeIds } },
            select: { stripeChargeId: true },
            take: puChargeIds.length,
          })
        : [];
      const puRefundedIds = new Set(puExistingRefunds.map(r => r.stripeChargeId));

      for (const { chargeId } of puChargeEntries) {
        if (puRefundedIds.has(chargeId)) continue;
        const charge = await stripe.charges.retrieve(chargeId);
        if (charge.refunded) continue;
        const chargeDate = new Date(charge.created * 1000);
        if (now - chargeDate.getTime() > REFUND_WINDOW_MS) continue;
        if (charge.amount > MAX_REFUNDABLE_AMOUNT_CENTS) continue;

        const chargeCustomerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
        if (chargeCustomerId !== user.stripeCustomerId) continue;

        const fingerprint = getChargeCardFingerprint(charge);
        if (fingerprint && await isRefundUsageBlocked(type, { emailHash: null, stripeCustomerId: null, paymentMethodFingerprint: fingerprint })) {
          return { eligible: false, reason: 'already_refunded' };
        }

        return { eligible: true, chargeId, amount: charge.amount, currency: charge.currency, chargeDate: chargeDate.toISOString(), paymentMethodFingerprint: fingerprint, giftId: null };
      }
      return { eligible: false, reason: 'no_eligible_charge' };
    }
  } catch (err) {
    log.error({ err, userId, type }, 'Error checking refund eligibility');
    return { eligible: false, reason: 'check_failed' };
  }

  return { eligible: false, reason: 'unknown_type' };
}

router.get('/refund-eligibility', authenticateToken, billingReadLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        powerUpSubscriptionId: true,
        hasUsedSubscriptionRefund: true,
        hasUsedGiftRefund: true,
        hasUsedPowerUpRefund: true,
        emailHash: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [subscription, gift, power_up] = await Promise.all([
      findEligibleCharge(req.userId, 'subscription', user),
      findEligibleCharge(req.userId, 'gift', user),
      findEligibleCharge(req.userId, 'power_up', user),
    ]);

    return res.json({
      subscription,
      gift,
      power_up,
      hasUsed: {
        subscription: user.hasUsedSubscriptionRefund,
        gift: user.hasUsedGiftRefund,
        power_up: user.hasUsedPowerUpRefund,
      },
      policy: {
        windowDays: REFUND_WINDOW_MS / (24 * 60 * 60 * 1000),
        maxAmountUsd: MAX_REFUNDABLE_AMOUNT_CENTS / 100,
        perCategoryLimit: 1,
      },
    });
  } catch (err) {
    log.error({ err }, 'refund-eligibility error');
    return res.status(500).json({ error: 'Failed to check refund eligibility' });
  }
});

router.post('/refund', authenticateToken, refundLimiter, validate(refundSchema), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });

    const { type, reason } = req.body as { type: 'subscription' | 'gift' | 'power_up'; reason?: string };

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        stripeStatus: true,
        powerUpSubscriptionId: true,
        powerUpPaidSlots: true,
        hasUsedSubscriptionRefund: true,
        hasUsedGiftRefund: true,
        hasUsedPowerUpRefund: true,
        emailHash: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.stripeStatus === 'admin_granted') {
      return res.status(400).json({ error: 'Admin-granted plans cannot be self-refunded.' });
    }

    const eligibility = await findEligibleCharge(req.userId, type, user);
    if (!eligibility.eligible) {
      return res.status(400).json({ error: `Refund not available: ${eligibility.reason}` });
    }

    const { chargeId, amount, currency, paymentMethodFingerprint, giftId: eligibleGiftId } = eligibility;

    // The $100 cap (MAX_REFUNDABLE_AMOUNT_CENTS) is denominated in cents and only
    // sound for USD. Reject non-USD until pricing supports multi-currency caps.
    if (currency !== 'usd') {
      log.warn({ userId: req.userId, chargeId, currency }, 'Refund attempted in unsupported currency');
      return res.status(400).json({ error: 'Refunds are currently only supported for USD charges. Contact support.' });
    }

    const lockKey = `refund:lock:${req.userId}`;
    if (redis) {
      const lockAcquired = await redis.set(lockKey, '1', 'EX', 30, 'NX');
      if (!lockAcquired) {
        return res.status(429).json({ error: 'A refund is already being processed. Please wait.' });
      }
    }

    try {
      const stripe = getStripe();

      // Re-verify against Stripe before any DB writes — catches Dashboard refunds
      // that happened in the gap between eligibility and now.
      const charge = await stripe.charges.retrieve(chargeId);
      if (charge.refunded) {
        return res.status(400).json({ error: 'This charge has already been refunded.' });
      }

      const chargeCustomerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
      if (chargeCustomerId !== user.stripeCustomerId) {
        log.warn({ userId: req.userId, chargeId, expected: user.stripeCustomerId, got: chargeCustomerId }, 'Refund customer ID mismatch');
        return res.status(400).json({ error: 'Charge does not belong to this account.' });
      }

      const usedField = type === 'subscription' ? 'hasUsedSubscriptionRefund'
        : type === 'gift' ? 'hasUsedGiftRefund'
        : 'hasUsedPowerUpRefund';

      // Atomic per-account claim. Rolled back below on any failure path.
      const claimed = await prisma.user.updateMany({
        where: { id: req.userId, [usedField]: false },
        data: { [usedField]: true },
      });
      if (claimed.count === 0) {
        return res.status(400).json({ error: 'You have already used your refund for this category.' });
      }

      // Saga step 1: insert pending Refund row BEFORE Stripe call. The unique
      // constraint on stripeChargeId catches concurrent attempts on the same
      // charge (defense-in-depth against the per-user lock + boolean claim).
      let refundRecord;
      try {
        refundRecord = await prisma.refund.create({
          data: {
            userId: req.userId,
            type,
            stripeChargeId: chargeId,
            amount,
            currency,
            reason: reason || null,
            initiatedBy: 'user',
            status: 'pending',
            paymentMethodFingerprint: paymentMethodFingerprint ?? null,
          },
        });
      } catch (err: unknown) {
        await prisma.user.update({ where: { id: req.userId }, data: { [usedField]: false } });
        const msg = err instanceof Error ? err.message : 'unknown';
        log.warn({ err: msg, chargeId }, 'Pending refund insert collided');
        return res.status(409).json({ error: 'A refund for this charge is already in progress or completed.' });
      }

      // Saga step 2: for gift refunds, atomically flip the gift identified at
      // eligibility time — NOT a re-query. Prevents the prior race
      // where eligibility found gift A but the refund flow grabbed gift B.
      if (type === 'gift') {
        if (!eligibleGiftId) {
          await prisma.refund.delete({ where: { id: refundRecord.id } }).catch(() => {});
          await prisma.user.update({ where: { id: req.userId }, data: { [usedField]: false } });
          return res.status(500).json({ error: 'Refund failed: gift identity missing.' });
        }
        const { count: giftLocked } = await prisma.giftSubscription.updateMany({
          where: { id: eligibleGiftId, status: 'pending' },
          data: { status: 'refunded', redeemedAt: new Date() },
        });
        if (giftLocked === 0) {
          await prisma.refund.delete({ where: { id: refundRecord.id } }).catch(() => {});
          await prisma.user.update({ where: { id: req.userId }, data: { [usedField]: false } });
          return res.status(409).json({ error: 'Gift code was already redeemed or refunded' });
        }
      }

      // Saga step 3: issue Stripe refund with idempotencyKey = Refund.id so a
      // network retry on this attempt cannot create duplicate Stripe refunds.
      let stripeRefund: Stripe.Refund;
      try {
        stripeRefund = await stripe.refunds.create(
          { charge: chargeId },
          { idempotencyKey: `refund-${refundRecord.id}` },
        );
      } catch (stripeErr: unknown) {
        if (type === 'gift' && eligibleGiftId) {
          await prisma.giftSubscription.updateMany({
            where: { id: eligibleGiftId, status: 'refunded' },
            data: { status: 'pending', redeemedAt: null },
          });
        }
        await prisma.refund.update({
          where: { id: refundRecord.id },
          data: { status: 'failed', completedAt: new Date() },
        }).catch(() => {});
        await prisma.user.update({ where: { id: req.userId }, data: { [usedField]: false } });
        const msg = stripeErr instanceof Error ? stripeErr.message : 'unknown';
        log.error({ err: msg, userId: req.userId, chargeId }, 'Stripe refund failed');
        return res.status(500).json({ error: 'Refund failed. Please try again or contact support.' });
      }

      // Post-refund per-type cleanup. Stripe has refunded the money; from here
      // any failure leaves the Refund row pending and the webhook will reconcile.
      if (type === 'subscription') {
        if (user.stripeSubscriptionId) {
          await stripe.subscriptions.cancel(user.stripeSubscriptionId).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : 'unknown';
            log.warn({ err: msg, subscriptionId: user.stripeSubscriptionId }, 'Failed to cancel subscription after refund — may already be canceled');
          });
        }

        await prisma.user.update({
          where: { id: req.userId },
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

        // Pro grants 2 free power-up slots. Refunding Pro removes those
        // free slots, so any deployed power-ups exceeding the user's remaining
        // allowance (paid power-ups only) must be revoked.
        await revokeExcessPowerUps(req.userId, user.powerUpPaidSlots ?? 0);

        const currentUser = await prisma.user.findUnique({
          where: { id: req.userId },
          select: { username: true, discriminator: true },
        });
        if (currentUser) {
          const taken = await prisma.user.findMany({
            where: { username: { equals: currentUser.username, mode: 'insensitive' } },
            select: { discriminator: true },
            take: 10000,
          });
          const takenSet = new Set(taken.map(u => u.discriminator));
          const available: string[] = [];
          for (let i = 0; i <= 9999 && available.length < 100; i++) {
            const d = i.toString().padStart(4, '0');
            if (!takenSet.has(d)) available.push(d);
          }
          if (available.length > 0) {
            const newDisc = available[crypto.randomInt(available.length)];
            await prisma.user.update({ where: { id: req.userId }, data: { discriminator: newDisc } });
          }
        }
      } else if (type === 'power_up') {
        if (user.powerUpSubscriptionId) {
          await stripe.subscriptions.cancel(user.powerUpSubscriptionId).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : 'unknown';
            log.warn({ err: msg, subscriptionId: user.powerUpSubscriptionId }, 'Failed to cancel power-up subscription after refund');
          });
        }
        await revokeExcessPowerUps(req.userId, 0);
        await prisma.user.update({
          where: { id: req.userId },
          data: { powerUpSubscriptionId: null, powerUpPaidSlots: 0 },
        });
      }

      // Saga step 4: finalize Refund row.
      await prisma.refund.update({
        where: { id: refundRecord.id },
        data: {
          status: 'completed',
          stripeRefundId: stripeRefund.id,
          completedAt: new Date(),
        },
      });

      // Saga step 5: write RefundUsage so account-delete + re-signup can't
      // bypass the per-category limit. Stores all three identifiers
      // so any future user matching on email, customer, or card is blocked.
      await prisma.refundUsage.create({
        data: {
          type,
          emailHash: user.emailHash,
          stripeCustomerId: user.stripeCustomerId,
          paymentMethodFingerprint: paymentMethodFingerprint ?? null,
          refundId: refundRecord.id,
        },
      });

      log.info({ userId: req.userId, refundId: refundRecord.id, type, chargeId, amount }, 'Self-serve refund completed');

      if (type === 'subscription') {
        emitSubscriptionUpdated(req.userId, { stripePlan: null, stripeStatus: 'canceled', stripePeriodEnd: null });
      } else if (type === 'power_up') {
        const freshUser = await prisma.user.findUnique({
          where: { id: req.userId },
          select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true },
        });
        emitSubscriptionUpdated(req.userId, {
          stripePlan: freshUser?.stripePlan ?? null,
          stripeStatus: freshUser?.stripeStatus ?? null,
          stripePeriodEnd: freshUser?.stripePeriodEnd ?? null,
          powerUpPaidSlots: 0,
        });
      }

      return res.json({ success: true, refundId: refundRecord.id, amount, currency, type });
    } finally {
      if (redis) {
        await redis.del(lockKey).catch(() => {});
      }
    }
  } catch (err) {
    log.error({ err }, 'refund error');
    return res.status(500).json({ error: 'Failed to process refund' });
  }
});

// POST /api/billing/webhook — Stripe sends raw body; must use express.raw() on this route
router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string | undefined;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    log.error('STRIPE_WEBHOOK_SECRET not configured — rejecting webhook');
    return res.status(500).json({ error: 'Webhook endpoint unavailable' });
  }
  if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    log.error({ err }, 'Webhook signature verification failed');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Idempotency: atomic insert-first guard
  // DB insert is the single source of truth; Redis is a fast-path optimization.
  // Insert BEFORE the handler runs so concurrent deliveries of the same event.id
  // (Stripe at-least-once retries, load-balanced replicas) can't both pass.
  const eventKey = `stripe:event:${event.id}`;
  if (redis) {
    const already = await redis.get(eventKey);
    if (already) {
      log.info({ eventId: event.id }, 'Skipping duplicate Stripe event');
      return res.json({ received: true });
    }
  }
  const inserted = await prisma.$executeRaw`
    INSERT INTO "StripeEvent" (id, "processedAt") VALUES (${event.id}, NOW())
    ON CONFLICT (id) DO NOTHING
  `;
  if (inserted === 0) {
    if (redis) await redis.set(eventKey, '1', 'EX', 86400).catch(() => {});
    log.info({ eventId: event.id }, 'Skipping duplicate Stripe event (DB)');
    return res.json({ received: true });
  }
  // First-time event — populate Redis fast-path for subsequent duplicate deliveries.
  if (redis) await redis.set(eventKey, '1', 'EX', 86400).catch(() => {});

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;

        // Handle setup-mode trial checkout
        if (session.mode === 'setup' && session.metadata?.isTrialSetup === 'true') {
          const trialUserId = session.metadata?.howlUserId;
          const trialPlan = session.metadata?.plan;
          if (!trialUserId || !trialPlan) break;

          const pendingSetup = await prisma.pendingTrialSetup.findUnique({
            where: { stripeCheckoutSessionId: session.id },
          });
          if (!pendingSetup || pendingSetup.status !== 'pending') {
            log.warn({ sessionId: session.id }, 'Trial setup not found or already processed');
            break;
          }

          // Race condition guard
          const trialUser = await prisma.user.findUnique({
            where: { id: trialUserId },
            select: { hasUsedTrial: true, stripePlan: true, stripeStatus: true },
          });
          if (trialUser?.hasUsedTrial || (trialUser?.stripePlan && trialUser.stripeStatus === 'active')) {
            await prisma.pendingTrialSetup.update({
              where: { id: pendingSetup.id },
              data: { status: 'failed', trialResult: 'failed', resultMessage: 'Trial is no longer available for this account.', processedAt: new Date() },
            });
            break;
          }

          try {
            // Get the SetupIntent to find the PaymentMethod
            const setupIntentId = typeof session.setup_intent === 'string'
              ? session.setup_intent
              : session.setup_intent?.id;

            if (!setupIntentId) {
              log.error({ sessionId: session.id }, 'No setup_intent on trial setup session');
              await prisma.pendingTrialSetup.update({
                where: { id: pendingSetup.id },
                data: { status: 'failed', trialResult: 'failed', resultMessage: 'Card verification failed. Please try again.', processedAt: new Date() },
              });
              break;
            }

            const setupIntent = await getStripe().setupIntents.retrieve(setupIntentId);
            const paymentMethodId = typeof setupIntent.payment_method === 'string'
              ? setupIntent.payment_method
              : setupIntent.payment_method?.id;

            if (!paymentMethodId) {
              log.error({ sessionId: session.id, setupIntentId }, 'No payment_method on SetupIntent');
              await prisma.pendingTrialSetup.update({
                where: { id: pendingSetup.id },
                data: { status: 'failed', trialResult: 'failed', resultMessage: 'Card verification failed. Please try again.', processedAt: new Date() },
              });
              break;
            }

            // Retrieve the PaymentMethod to get the card fingerprint
            const trialPm = await getStripe().paymentMethods.retrieve(paymentMethodId);
            const trialFingerprint = trialPm.card?.fingerprint ?? null;

            // Layer 2: Card fingerprint check
            let trialAllowed = true;
            if (trialFingerprint) {
              const existingFingerprint = await prisma.trialCardFingerprint.findUnique({
                where: { fingerprint: trialFingerprint },
              });

              if (existingFingerprint) {
                trialAllowed = false;
                log.warn({
                  userId: trialUserId,
                  fingerprint: trialFingerprint,
                  previousUserId: existingFingerprint.userId,
                }, 'Trial abuse detected — card fingerprint already used');
              }
            } else {
              // No fingerprint available — fail open, allow trial
              log.warn({ userId: trialUserId, paymentMethodId }, 'Could not retrieve card fingerprint — allowing trial');
            }

            const trialPriceId = trialPlan === 'essential' ? ESSENTIAL_PRICE_ID : PRO_PRICE_ID;
            if (!trialPriceId) {
              await prisma.pendingTrialSetup.update({
                where: { id: pendingSetup.id },
                data: { status: 'failed', trialResult: 'failed', resultMessage: 'This plan is not available at the moment.', processedAt: new Date() },
              });
              break;
            }

            if (trialAllowed) {
              // Clean card — create subscription WITH trial
              const subscription = await getStripe().subscriptions.create({
                customer: pendingSetup.stripeCustomerId,
                items: [{ price: trialPriceId }],
                default_payment_method: paymentMethodId,
                trial_period_days: 7,
                metadata: { howlUserId: trialUserId, plan: trialPlan, isTrial: 'true' },
              });

              // Record fingerprint
              if (trialFingerprint) {
                await prisma.trialCardFingerprint.create({
                  data: {
                    fingerprint: trialFingerprint,
                    userId: trialUserId,
                    stripeCustomerId: pendingSetup.stripeCustomerId,
                    plan: trialPlan,
                  },
                }).catch((fpErr: unknown) => {
                  log.warn({ err: fpErr }, 'Fingerprint already recorded (race condition)');
                });
              }

              // Atomic: only set trial if hasUsedTrial is still false (prevents race)
              const trialPeriodEnd = getSubPeriodEnd(subscription);
              const trialClaimed = await prisma.user.updateMany({
                where: { id: trialUserId, hasUsedTrial: false },
                data: {
                  stripeSubscriptionId: subscription.id,
                  stripePlan: trialPlan,
                  stripeStatus: subscription.status,
                  stripePeriodEnd: trialPeriodEnd,
                  hasUsedTrial: true,
                  trialStartedAt: new Date(),
                },
              });
              if (trialClaimed.count === 0) {
                log.warn({ userId: trialUserId }, 'Trial already claimed by concurrent request — canceling subscription');
                await getStripe().subscriptions.cancel(subscription.id).catch(() => {});
                await prisma.pendingTrialSetup.update({
                  where: { id: pendingSetup.id },
                  data: { status: 'failed', trialResult: 'failed', resultMessage: 'Trial is no longer available for this account.', processedAt: new Date() },
                });
                break;
              }

              emitSubscriptionUpdated(trialUserId, { stripePlan: trialPlan, stripeStatus: subscription.status, stripePeriodEnd: trialPeriodEnd });

              await prisma.pendingTrialSetup.update({
                where: { id: pendingSetup.id },
                data: {
                  status: 'started',
                  trialResult: 'started',
                  resultMessage: 'Your 7-day free trial has started!',
                  paymentMethodId,
                  fingerprint: trialFingerprint,
                  processedAt: new Date(),
                },
              });

              log.info({ userId: trialUserId, subscriptionId: subscription.id, plan: trialPlan }, 'Trial started successfully');
            } else {
              // Flagged card — do NOT create subscription
              await prisma.user.update({
                where: { id: trialUserId },
                data: { hasUsedTrial: true },
              });

              await prisma.pendingTrialSetup.update({
                where: { id: pendingSetup.id },
                data: {
                  status: 'card_ineligible',
                  trialResult: 'card_ineligible',
                  resultMessage: 'This card isn\'t eligible for a free trial. You can subscribe to start immediately.',
                  paymentMethodId,
                  fingerprint: trialFingerprint,
                  processedAt: new Date(),
                },
              });

              log.info({ userId: trialUserId, fingerprint: trialFingerprint }, 'Trial denied — card fingerprint already used');
            }
          } catch (trialErr) {
            log.error({ err: trialErr, userId: trialUserId }, 'Trial setup processing failed — failing closed (no trial granted)');
            await prisma.pendingTrialSetup.update({
              where: { id: pendingSetup.id },
              data: {
                status: 'failed',
                trialResult: 'failed',
                resultMessage: 'Something went wrong verifying your card. Please try again.',
                processedAt: new Date(),
              },
            }).catch(() => {});
          }
          break;
        }

        // Handle power-up purchase checkout
        if (session.metadata?.type === 'power_up_purchase' || session.metadata?.type === 'boost_purchase') {
          const powerUpUserId = session.metadata?.howlUserId;
          if (!powerUpUserId) break;

          // Verify customer ID matches
          const puUser = await prisma.user.findUnique({
            where: { id: powerUpUserId },
            select: { stripeCustomerId: true },
          });
          const puSessionCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
          if (!puUser || (puSessionCustomerId && puUser.stripeCustomerId && puSessionCustomerId !== puUser.stripeCustomerId)) {
            log.warn({ userId: powerUpUserId, expected: puUser?.stripeCustomerId, got: puSessionCustomerId }, 'power-up checkout customer ID mismatch — skipping');
            break;
          }

          const powerUpSubId =
            typeof session.subscription === 'string'
              ? session.subscription
              : (session.subscription as Stripe.Subscription | null)?.id;

          if (powerUpSubId) {
            const puSub = await getStripe().subscriptions.retrieve(powerUpSubId);
            const quantity = puSub.items.data[0]?.quantity ?? 0;
            await prisma.user.update({
              where: { id: powerUpUserId },
              data: { powerUpSubscriptionId: powerUpSubId, powerUpPaidSlots: quantity },
            });
            // Fetch fresh user state for the emit (plan info lives on the user, not the power-up sub)
            const freshPuUser = await prisma.user.findUnique({
              where: { id: powerUpUserId },
              select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true },
            });
            emitSubscriptionUpdated(powerUpUserId, {
              stripePlan: freshPuUser?.stripePlan ?? null,
              stripeStatus: freshPuUser?.stripeStatus ?? null,
              stripePeriodEnd: freshPuUser?.stripePeriodEnd ?? null,
              powerUpPaidSlots: quantity,
            });
          }
          break;
        }

        // Handle gift checkout (UNCHANGED)
        const howlGiftId = session.metadata?.howlGiftId;
        if (howlGiftId) {
          await prisma.giftSubscription.updateMany({
            where: { id: howlGiftId, status: 'payment_pending' },
            data: { status: 'pending' },
          });
          break;
        }

        // Handle subscription checkout
        const howlUserId = session.metadata?.howlUserId;
        const plan = session.metadata?.plan;
        if (!howlUserId || !plan) break;

        const subscriptionId =
          typeof session.subscription === 'string'
            ? session.subscription
            : (session.subscription as Stripe.Subscription | null)?.id;

        if (subscriptionId) {
          const checkoutUser = await prisma.user.findUnique({
            where: { id: howlUserId },
            select: { stripeCustomerId: true, stripeStatus: true },
          });
          const sessionCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
          if (!checkoutUser || (sessionCustomerId && checkoutUser.stripeCustomerId && sessionCustomerId !== checkoutUser.stripeCustomerId)) {
            log.warn({ userId: howlUserId, expected: checkoutUser?.stripeCustomerId, got: sessionCustomerId }, 'checkout.session.completed customer ID mismatch — skipping');
            break;
          }
          if (checkoutUser.stripeStatus === 'admin_granted') {
            log.info({ userId: howlUserId }, 'checkout.session.completed skipped — admin-granted plan');
            break;
          }

          const sub = await getStripe().subscriptions.retrieve(subscriptionId, {
            expand: ['default_payment_method'],
          });
          const periodEnd = getSubPeriodEnd(sub);
          await prisma.user.update({
            where: { id: howlUserId },
            data: {
              stripeSubscriptionId: subscriptionId,
              stripePlan: plan,
              stripeStatus: sub.status,
              stripePeriodEnd: periodEnd,
            },
          });
          emitSubscriptionUpdated(howlUserId, { stripePlan: plan, stripeStatus: sub.status, stripePeriodEnd: periodEnd });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const user = await prisma.user.findFirst({
          where: { stripeSubscriptionId: sub.id },
          select: { id: true, stripePlan: true, stripeStatus: true, stripeCustomerId: true },
        });
        if (!user) {
          // Check if this is a power-up subscription
          const powerUpUser = await prisma.user.findFirst({
            where: { powerUpSubscriptionId: sub.id },
            select: { id: true, powerUpPaidSlots: true },
          });
          if (powerUpUser) {
            const newQuantity = sub.items.data[0]?.quantity ?? 0;
            if (sub.status === 'active' || sub.status === 'trialing') {
              await prisma.user.update({
                where: { id: powerUpUser.id },
                data: { powerUpPaidSlots: newQuantity },
              });
            } else if (sub.status === 'canceled' || sub.status === 'unpaid' || sub.status === 'past_due') {
              await revokeExcessPowerUps(powerUpUser.id, newQuantity);
            }
            const freshPuState = await prisma.user.findUnique({
              where: { id: powerUpUser.id },
              select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, powerUpPaidSlots: true },
            });
            emitSubscriptionUpdated(powerUpUser.id, {
              stripePlan: freshPuState?.stripePlan ?? null,
              stripeStatus: freshPuState?.stripeStatus ?? null,
              stripePeriodEnd: freshPuState?.stripePeriodEnd ?? null,
              powerUpPaidSlots: freshPuState?.powerUpPaidSlots ?? 0,
            });
          }
          break;
        }
        if (user.stripeStatus === 'admin_granted') break;

        const subCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
        if (subCustomerId && user.stripeCustomerId && subCustomerId !== user.stripeCustomerId) {
          log.warn({ userId: user.id, expected: user.stripeCustomerId, got: subCustomerId }, 'subscription.updated customer ID mismatch — skipping');
          break;
        }

        const priceId = sub.items.data[0]?.price?.id;
        let plan: string | null = user.stripePlan;
        if (priceId === ESSENTIAL_PRICE_ID) plan = 'essential';
        else if (priceId === PRO_PRICE_ID) plan = 'pro';
        else {
          log.warn({ priceId, userId: user?.id, subscriptionId: sub.id }, 'Unknown Stripe price ID in subscription update');
        }

        const oldPlan = user.stripePlan;
        const cosmeticClear: Record<string, any> = {};

        // Downgrade from Pro: clear Pro-only cosmetics
        if (oldPlan === 'pro' && plan !== 'pro') {
          cosmeticClear.nameColor = null;
          cosmeticClear.nameFont = null;
          cosmeticClear.nameEffect = null;
          cosmeticClear.avatarEffect = null;
        }
        // Downgrade to free: clear Essential+ cosmetics
        if (!plan || (plan !== 'essential' && plan !== 'pro')) {
          cosmeticClear.banner = null;
          cosmeticClear.backgroundImage = null;
        }

        const updatedPeriodEnd = getSubPeriodEnd(sub);
        await prisma.user.update({
          where: { id: user.id },
          data: {
            stripePlan: plan,
            stripeStatus: sub.status,
            stripePeriodEnd: updatedPeriodEnd,
            ...cosmeticClear,
          },
        });
        emitSubscriptionUpdated(user.id, { stripePlan: plan, stripeStatus: sub.status, stripePeriodEnd: updatedPeriodEnd });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const user = await prisma.user.findFirst({
          where: { stripeSubscriptionId: sub.id },
          select: { id: true, stripeStatus: true, stripeCustomerId: true },
        });
        if (user) {
          const delSubCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
          if (delSubCustomerId && user.stripeCustomerId && delSubCustomerId !== user.stripeCustomerId) {
            log.warn({ userId: user.id, expected: user.stripeCustomerId, got: delSubCustomerId }, 'subscription.deleted customer ID mismatch — skipping');
            break;
          }
        }
        if (!user) {
          // Check if this is a power-up subscription
          const powerUpUser = await prisma.user.findFirst({
            where: { powerUpSubscriptionId: sub.id },
            select: { id: true },
          });
          if (powerUpUser) {
            await revokeExcessPowerUps(powerUpUser.id, 0);
            await prisma.user.update({
              where: { id: powerUpUser.id },
              data: { powerUpSubscriptionId: null, powerUpPaidSlots: 0 },
            });
            const freshDelPuState = await prisma.user.findUnique({
              where: { id: powerUpUser.id },
              select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true },
            });
            emitSubscriptionUpdated(powerUpUser.id, {
              stripePlan: freshDelPuState?.stripePlan ?? null,
              stripeStatus: freshDelPuState?.stripeStatus ?? null,
              stripePeriodEnd: freshDelPuState?.stripePeriodEnd ?? null,
              powerUpPaidSlots: 0,
            });
          } else {
            log.info({ subscriptionId: sub.id }, 'Skipping stale subscription.deleted event — no matching user (newer subscription may have replaced it)');
          }
          break;
        }
        if (user.stripeStatus === 'admin_granted') {
          await prisma.user.update({ where: { id: user.id }, data: { stripeSubscriptionId: null } });
          break;
        }

        await prisma.user.update({
          where: { id: user.id },
          data: {
            stripeSubscriptionId: null,
            stripePlan: null,
            stripeStatus: 'canceled',
            stripePeriodEnd: null,
            // Clear all plan-gated cosmetics on subscription deletion
            nameColor: null,
            nameFont: null,
            nameEffect: null,
            avatarEffect: null,
            banner: null,
            backgroundImage: null,
          },
        });

        emitSubscriptionUpdated(user.id, { stripePlan: null, stripeStatus: 'canceled', stripePeriodEnd: null });

        // Reset custom discriminator to a random available one
        const currentUser = await prisma.user.findUnique({
          where: { id: user.id },
          select: { username: true, discriminator: true },
        });
        if (currentUser) {
          const taken = await prisma.user.findMany({
            where: { username: { equals: currentUser.username, mode: 'insensitive' } },
            select: { discriminator: true },
            take: 10000,
          });
          const takenSet = new Set(taken.map(u => u.discriminator));
          const available: string[] = [];
          for (let i = 0; i <= 9999 && available.length < 100; i++) {
            const d = i.toString().padStart(4, '0');
            if (!takenSet.has(d)) available.push(d);
          }
          if (available.length > 0) {
            const newDisc = available[crypto.randomInt(available.length)];
            await prisma.user.update({
              where: { id: user.id },
              data: { discriminator: newDisc },
            });
          }
        }
        break;
      }

      case 'customer.subscription.trial_will_end': {
        // Fires 3 days before trial ends
        const trialSub = event.data.object as Stripe.Subscription;
        const trialUser = await prisma.user.findFirst({
          where: { stripeSubscriptionId: trialSub.id },
          select: { id: true },
        });
        if (trialUser) {
          log.info({ userId: trialUser.id, subscriptionId: trialSub.id }, 'Trial ending in 3 days');
        }
        break;
      }

      case 'charge.dispute.created': {
        const dispute = event.data.object as Stripe.Dispute;
        const charge = dispute.charge;
        const chargeObj = typeof charge === 'string'
          ? await getStripe().charges.retrieve(charge)
          : charge;
        if (!chargeObj) break;
        const customerId = typeof chargeObj.customer === 'string' ? chargeObj.customer : chargeObj.customer?.id;
        if (!customerId) break;

        const disputeUser = await prisma.user.findFirst({
          where: { stripeCustomerId: customerId },
          select: { id: true, stripeStatus: true, stripeSubscriptionId: true, stripePlan: true, stripePeriodEnd: true },
        });
        if (!disputeUser) break;
        if (disputeUser.stripeStatus === 'admin_granted') break;

        await prisma.user.update({
          where: { id: disputeUser.id },
          data: {
            stripeStatus: 'disputed',
            nameColor: null,
            nameFont: null,
            nameEffect: null,
            avatarEffect: null,
            banner: null,
            backgroundImage: null,
          },
        });

        // Cancel the Stripe subscription to prevent future charges
        if (disputeUser.stripeSubscriptionId) {
          try {
            await getStripe().subscriptions.cancel(disputeUser.stripeSubscriptionId, {
              prorate: false,
            });
            log.info({ userId: disputeUser.id, subscriptionId: disputeUser.stripeSubscriptionId }, 'Canceled subscription due to dispute');
          } catch (cancelErr) {
            log.error({ err: cancelErr, userId: disputeUser.id }, 'Failed to cancel subscription on dispute');
          }
        }

        emitSubscriptionUpdated(disputeUser.id, {
          stripePlan: disputeUser.stripePlan,
          stripeStatus: 'disputed',
          stripePeriodEnd: disputeUser.stripePeriodEnd,
        });

        log.warn({ userId: disputeUser.id, disputeId: dispute.id }, 'Charge disputed — user downgraded');
        break;
      }

      case 'charge.dispute.closed': {
        const closedDispute = event.data.object as Stripe.Dispute;
        if (closedDispute.status === 'won') {
          // Dispute resolved in our favor — restore user's plan
          const closedCharge = typeof closedDispute.charge === 'string'
            ? await getStripe().charges.retrieve(closedDispute.charge)
            : closedDispute.charge;
          if (!closedCharge?.customer) break;
          const closedCustId = typeof closedCharge.customer === 'string' ? closedCharge.customer : closedCharge.customer.id;
          const closedDisputeUser = await prisma.user.findFirst({ where: { stripeCustomerId: closedCustId } });
          if (closedDisputeUser && closedDisputeUser.stripeStatus === 'disputed') {
            await prisma.user.update({
              where: { id: closedDisputeUser.id },
              data: { stripeStatus: 'active' },
            });
            emitSubscriptionUpdated(closedDisputeUser.id, {
              stripePlan: closedDisputeUser.stripePlan,
              stripeStatus: 'active',
              stripePeriodEnd: closedDisputeUser.stripePeriodEnd,
            });
            log.info({ userId: closedDisputeUser.id, disputeId: closedDispute.id }, 'Dispute won — restored user plan');
          }
        }
        break;
      }

      case 'charge.refunded': {
        const refundedCharge = event.data.object as Stripe.Charge;
        const refundChargeId = refundedCharge.id;
        const refundCustomerId = typeof refundedCharge.customer === 'string' ? refundedCharge.customer : refundedCharge.customer?.id;
        const fingerprint = refundedCharge.payment_method_details?.card?.fingerprint ?? null;

        const existing = await prisma.refund.findUnique({
          where: { stripeChargeId: refundChargeId },
          select: { id: true, status: true },
        });

        if (existing) {
          // Reconcile: a self-serve / admin saga that crashed mid-flight will
          // have left a 'pending' row. The webhook is our confirmation that the
          // refund actually completed on Stripe — finalize it.
          if (existing.status === 'pending') {
            await prisma.refund.update({
              where: { id: existing.id },
              data: {
                status: 'completed',
                stripeRefundId: refundedCharge.refunds?.data?.[0]?.id ?? null,
                completedAt: new Date(),
              },
            });
            log.info({ chargeId: refundChargeId, refundId: existing.id }, 'Reconciled stale pending refund via webhook');
          } else {
            log.info({ chargeId: refundChargeId, refundId: existing.id, status: existing.status }, 'charge.refunded — already tracked, skipping');
          }
          break;
        }

        // No existing row → out-of-band refund (Stripe Dashboard / API direct).
        if (!refundCustomerId) break;

        const refundUser = await prisma.user.findFirst({
          where: { stripeCustomerId: refundCustomerId },
          select: { id: true, stripeCustomerId: true, stripeSubscriptionId: true, powerUpSubscriptionId: true, emailHash: true },
        });
        if (!refundUser) break;

        const inferredType = await inferDashboardRefundType(refundedCharge, refundUser);
        const finalType = inferredType ?? 'subscription';
        if (!inferredType) {
          log.warn({ chargeId: refundChargeId, userId: refundUser.id }, 'Could not infer refund type from dashboard refund — defaulting to subscription');
        }
        const usedField = finalType === 'subscription' ? 'hasUsedSubscriptionRefund'
          : finalType === 'gift' ? 'hasUsedGiftRefund'
          : 'hasUsedPowerUpRefund';

        // Burn the per-category boolean and write RefundUsage atomically
        // so the user can't subsequently self-serve another refund in this category,
        // and account-delete + re-signup can't bypass via a fresh User row.
        try {
          await prisma.$transaction([
            prisma.refund.create({
              data: {
                userId: refundUser.id,
                type: finalType,
                stripeChargeId: refundChargeId,
                stripeRefundId: refundedCharge.refunds?.data?.[0]?.id ?? null,
                amount: refundedCharge.amount_refunded,
                currency: refundedCharge.currency,
                reason: 'Processed via Stripe Dashboard',
                initiatedBy: 'admin',
                adminOverride: true,
                adminOverrideReason: 'Stripe Dashboard refund, not processed through Howl',
                status: 'completed',
                paymentMethodFingerprint: fingerprint,
                completedAt: new Date(),
              },
            }),
            prisma.user.update({
              where: { id: refundUser.id },
              data: { [usedField]: true },
            }),
            prisma.refundUsage.create({
              data: {
                type: finalType,
                emailHash: refundUser.emailHash,
                stripeCustomerId: refundCustomerId,
                paymentMethodFingerprint: fingerprint,
              },
            }),
          ]);
        } catch (err: unknown) {
          log.warn({ err, chargeId: refundChargeId }, 'Failed to atomically record dashboard refund');
        }

        log.info({ userId: refundUser.id, chargeId: refundChargeId, type: finalType, amount: refundedCharge.amount_refunded }, 'Dashboard refund recorded with flag burn');
        break;
      }

      case 'checkout.session.expired': {
        const expiredSession = event.data.object as Stripe.Checkout.Session;
        const expiredGiftId = expiredSession.metadata?.howlGiftId;
        if (expiredGiftId) {
          const updated = await prisma.giftSubscription.updateMany({
            where: { id: expiredGiftId, status: 'payment_pending' },
            data: { status: 'cancelled' },
          });
          if (updated.count > 0) {
            log.info({ giftId: expiredGiftId }, 'Gift checkout expired — marked cancelled');
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        // In Stripe v20 SDK the invoice subscription ref is in parent.subscription_details
        const invoice = event.data.object as Record<string, any>;
        const subRef =
          invoice.parent?.subscription_details?.subscription ??
          invoice.subscription;
        const subId = typeof subRef === 'string' ? subRef : subRef?.id;
        if (!subId) break;

        const user = await prisma.user.findFirst({
          where: { stripeSubscriptionId: subId },
          select: { id: true, stripeStatus: true, stripePlan: true, stripePeriodEnd: true },
        });
        if (!user) break;
        if (user.stripeStatus === 'admin_granted') break;

        await prisma.user.update({
          where: { id: user.id },
          data: { stripeStatus: 'past_due' },
        });
        emitSubscriptionUpdated(user.id, {
          stripePlan: user.stripePlan,
          stripeStatus: 'past_due',
          stripePeriodEnd: user.stripePeriodEnd,
        });
        break;
      }

      case 'invoice.payment_succeeded': {
        const successInvoice = event.data.object as Stripe.Invoice;
        const successCustId = typeof successInvoice.customer === 'string' ? successInvoice.customer : successInvoice.customer?.id;
        if (!successCustId) break;
        const successUser = await prisma.user.findFirst({ where: { stripeCustomerId: successCustId } });
        if (!successUser || successUser.stripeStatus === 'admin_granted') break;

        // Restore from past_due to active
        if (successUser.stripeStatus === 'past_due') {
          const successSubRef = (successInvoice as any).parent?.subscription_details?.subscription ?? (successInvoice as any).subscription;
          const successSubId = typeof successSubRef === 'string' ? successSubRef : successSubRef?.id;
          if (successSubId) {
            const successSub = await getStripe().subscriptions.retrieve(successSubId);
            const successPeriodEnd = getSubPeriodEnd(successSub);
            await prisma.user.update({
              where: { id: successUser.id },
              data: {
                stripeStatus: 'active',
                stripePeriodEnd: successPeriodEnd,
              },
            });
            emitSubscriptionUpdated(successUser.id, {
              stripePlan: successUser.stripePlan,
              stripeStatus: 'active',
              stripePeriodEnd: successPeriodEnd,
            });
            log.info({ userId: successUser.id }, 'Restored from past_due after successful payment');
          }
        }
        break;
      }
    }
    // Idempotency row was inserted atomically before the handler ran. On thrown
    // errors, the row intentionally remains: handler branches are app-level
    // idempotent (e.g., trial branch's `updateMany({ hasUsedTrial: false })`
    // guard) and keeping the row prevents re-triggering side effects on retry.
  } catch (err) {
    log.error({ err }, 'Webhook handler error');
    return res.status(500).json({ error: 'Webhook processing failed' });
  }

  res.json({ received: true });
});

// Dynamic prices

let priceCache: {
  essential: { amount: number; currency: string; interval: string } | null;
  pro: { amount: number; currency: string; interval: string } | null;
  powerUp: { amount: number; currency: string; interval: string } | null;
  fetchedAt: number;
} = { essential: null, pro: null, powerUp: null, fetchedAt: 0 };
const PRICE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// GET /api/billing/prices — public (no auth), cached
router.get('/prices', billingReadLimiter, async (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (priceCache.fetchedAt > 0 && now - priceCache.fetchedAt < PRICE_CACHE_TTL_MS) {
      return res.json({ essential: priceCache.essential, pro: priceCache.pro, powerUp: priceCache.powerUp });
    }

    const stripe = getStripe();
    const [essentialPrice, proPrice, powerUpPrice] = await Promise.all([
      ESSENTIAL_PRICE_ID ? stripe.prices.retrieve(ESSENTIAL_PRICE_ID).catch(() => null) : null,
      PRO_PRICE_ID ? stripe.prices.retrieve(PRO_PRICE_ID).catch(() => null) : null,
      POWER_UP_PRICE_ID ? stripe.prices.retrieve(POWER_UP_PRICE_ID).catch(() => null) : null,
    ]);

    const formatPrice = (p: Stripe.Price | null) => {
      if (!p) return null;
      return {
        amount: (p.unit_amount ?? 0) / 100,
        currency: p.currency,
        interval: p.recurring?.interval ?? 'month',
      };
    };

    priceCache = { essential: formatPrice(essentialPrice), pro: formatPrice(proPrice), powerUp: formatPrice(powerUpPrice), fetchedAt: now };
    return res.json({ essential: priceCache.essential, pro: priceCache.pro, powerUp: priceCache.powerUp });
  } catch (err) {
    log.error({ err }, 'fetch-prices error');
    return res.json({
      essential: { amount: 2.99, currency: 'usd', interval: 'month' },
      pro: { amount: 8.99, currency: 'usd', interval: 'month' },
      powerUp: { amount: 3.99, currency: 'usd', interval: 'month' },
    });
  }
});

export default router;
