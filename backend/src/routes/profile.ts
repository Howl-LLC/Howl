// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { updateProfileSchema, updateStatusSchema, updateDiscriminatorSchema, updatePreferencesSchema, setDateOfBirthSchema } from '../schemas.js';
import { logger } from '../logger.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { computeBadges } from '../utils/badges.js';
import { getEffectivePlan } from '../utils.js';
import { decryptSecret } from '../services/mfaCrypto.js';
import { sensitiveActionLimiter } from './authHelpers.js';
import { invalidateOnboardingCache } from '../middleware/requireOnboarding.js';
import { deleteUploadedFile } from './upload.js';
import { broadcastActivityChange } from '../socketHandlers/infrastructure.js';
import { findUserVoiceChannel, getVoiceParticipantData, addVoiceParticipant, getVoiceParticipants } from '../redis.js';
import { getClientIp } from '../utils/clientIp.js';

const _log = logger.child({ module: 'profile' });

function toRelativeUploadUrl(url: string): string {
  const idx = url.indexOf('/api/uploads/');
  if (idx >= 0) return url.slice(idx);
  return url;
}

const ALLOWED_IMAGE_EXTENSIONS = /\.(png|jpe?g|gif)$/i;

function isAllowedImageUrl(url: string): boolean {
  // Test the extension against the path only. The serve route ignores a
  // ?query/#fragment, so without stripping it `<uuid>.enc?x.png` would pass
  // the allowlist while the server serves the unscanned `.enc` blob.
  return ALLOWED_IMAGE_EXTENSIONS.test(url.split(/[?#]/)[0]);
}

const profileUpdateLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:profile:'),
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Too many profile updates. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const profileReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:profile-read:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const usernameSchema = z.string().min(2).max(32);

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const VALID_NAME_FONTS = ['default', 'serif', 'mono', 'cursive', 'handwritten', 'impact', 'rounded', 'pixel', 'elegant', 'display', 'bold', 'futuristic', 'spaced', 'script', 'verdana', 'comic-sans', 'dyslexie'];
const VALID_AVATAR_EFFECTS = ['none', 'glow-cyan', 'glow-purple', 'glow-gold', 'glow-rose', 'glow-emerald', 'ring-animated', 'ring-rainbow', 'ring-fire', 'sparkle', 'breathe', 'shadow-neon'];
const VALID_NAME_EFFECTS = ['none', 'glow', 'rainbow', 'shimmer', 'fire', 'neon', 'pulse', 'gradient'];

const VALID_STATUSES = ['online', 'idle', 'dnd', 'invisible', 'offline'] as const;

const statusUpdateLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:status:'),
  windowMs: 60 * 1000,
  // Presence churn is cheap and per-user keyed. The previous cap of 10/min was
  // tripped by ordinary focus/blur + auto-idle flapping (each cycle = 2 writes).
  // The client now debounces + dedupes these (utils/selfStatus.ts), but keep a
  // higher cap as defense-in-depth for legitimate manual + auto-idle changes.
  max: 30,
  message: { error: 'Too many status updates. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

const router = Router();

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
});

/**
 * Load the full /auth/me payload for a user. Returns null if the user is gone.
 * Shared with the /bootstrap aggregate endpoint so cold-start clients can
 * fetch profile + settings + servers in a single round trip.
 */
export async function loadCurrentUserProfile(userId: string): Promise<Record<string, unknown> | null> {
  const [user, pwCheck] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, username: true, discriminator: true, email: true,
        avatar: true, banner: true, bannerPositionY: true, bannerZoom: true, status: true, createdAt: true,
        stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true,
        nameColor: true, nameFont: true,
        nameEffect: true, avatarEffect: true,
        badges: true, mfaEnabled: true,
        backgroundImage: true, backgroundOpacity: true, backgroundBlur: true, bgGifAlwaysPlay: true,
        activityBio: true,
        dateOfBirth: true, needsOnboarding: true, emailVerified: true,
        discoveryOptOut: true,
        connectedApps: {
          select: { id: true, provider: true, displayName: true, avatarUrl: true },
          take: 20,
        },
      },
    }),
    prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } }),
  ]);
  if (!user) return null;
  const hasPassword = !!pwCheck?.passwordHash;
  let plainEmail: string;
  try { plainEmail = decryptSecret(user.email); } catch { plainEmail = user.email; }
  return {
    id: user.id,
    username: user.username,
    discriminator: user.discriminator,
    email: plainEmail,
    avatar: user.avatar,
    banner: user.banner ?? null,
    bannerPositionY: user.bannerPositionY ?? 50, bannerZoom: user.bannerZoom ?? 100,
    status: user.status,
    createdAt: user.createdAt,
    stripePlan: user.stripePlan ?? null,
    stripePeriodEnd: user.stripePeriodEnd?.toISOString() ?? null,
    effectivePlan: getEffectivePlan(user),
    nameColor: user.nameColor ?? null,
    nameFont: user.nameFont ?? null,
    nameEffect: user.nameEffect ?? null,
    avatarEffect: user.avatarEffect ?? null,
    badges: computeBadges(user),
    mfaEnabled: user.mfaEnabled,
    hasPassword,
    backgroundImage: user.backgroundImage ?? null,
    backgroundOpacity: user.backgroundOpacity ?? 0.15,
    backgroundBlur: user.backgroundBlur ?? 0,
    bgGifAlwaysPlay: user.bgGifAlwaysPlay ?? false,
    activityBio: user.activityBio ?? null,
    needsDateOfBirth: !user.dateOfBirth,
    needsOnboarding: user.needsOnboarding ?? false,
    emailVerified: user.emailVerified ?? false,
    discoveryOptOut: user.discoveryOptOut,
    connectedApps: user.connectedApps,
    isMinor: user.dateOfBirth ? (() => {
      const today = new Date();
      let a = today.getFullYear() - user.dateOfBirth!.getFullYear();
      const m = today.getMonth() - user.dateOfBirth!.getMonth();
      if (m < 0 || (m === 0 && today.getDate() < user.dateOfBirth!.getDate())) a--;
      return a < 18;
    })() : false,
  };
}

// GET /api/auth/me
router.get('/me', profileReadLimiter, authenticateToken, asyncHandler(async (req: AuthRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const profile = await loadCurrentUserProfile(req.userId);
  if (!profile) return res.status(404).json({ error: 'User not found' });
  return res.json(profile);
}));

// POST /api/auth/me/date-of-birth — set DOB (one-time, for SSO users)
router.post('/me/date-of-birth', authenticateToken, profileUpdateLimiter, validate(setDateOfBirthSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { dateOfBirth: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.dateOfBirth) {
    return res.status(400).json({ error: 'Date of birth is already set and cannot be changed.' });
  }

  const { dateOfBirth } = req.body as { dateOfBirth: string };
  const dob = new Date(dateOfBirth);

  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age--;
  if (age < 13) {
    return res.status(403).json({ error: 'You must be at least 13 years old to use Howl.' });
  }

  await prisma.user.update({
    where: { id: req.userId },
    data: {
      dateOfBirth: dob,
      // Privacy-protective defaults for minors (under 18)
      ...(age < 18 ? {
        allowDmFromServerMembers: false,
        friendRequestsEveryone: false,
        messageRequestsFilter: true,
      } : {}),
    },
  });

  invalidateOnboardingCache(req.userId);

  res.json({ ok: true });
}));

// PATCH /api/auth/me – update profile fields
router.patch('/me', authenticateToken, profileUpdateLimiter, validate(updateProfileSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const body = req.body as {
    username?: string; avatar?: string; banner?: string;
    bannerPositionY?: number; bannerZoom?: number;
    nameColor?: string | null; nameFont?: string | null;
    nameEffect?: string | null; avatarEffect?: string | null;
    backgroundImage?: string | null; backgroundOpacity?: number;
    backgroundBlur?: number; bgGifAlwaysPlay?: boolean;
    activityBio?: string | null;
  };
  const current = await prisma.user.findUnique({ where: { id: req.userId }, select: {
    id: true, stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true,
    username: true, discriminator: true,
    email: true, avatar: true, banner: true, status: true, createdAt: true,
    nameColor: true, nameFont: true, nameEffect: true, avatarEffect: true, badges: true,
    backgroundImage: true, backgroundOpacity: true, backgroundBlur: true, bgGifAlwaysPlay: true,
    activityBio: true,
  } });
  if (!current) return res.status(404).json({ error: 'User not found' });

  const plan = getEffectivePlan(current);
  const updates: Record<string, any> = {};

  if (body.avatar !== undefined) {
    const av = body.avatar === null ? null : (typeof body.avatar === 'string' ? body.avatar : undefined);
    if (av && !isAllowedImageUrl(av)) {
      return res.status(400).json({ error: 'Only PNG, JPG, and GIF files are allowed for avatars.' });
    }
    updates.avatar = av ? toRelativeUploadUrl(av) : av;
  }

  if (body.banner !== undefined) {
    const bannerVal = typeof body.banner === 'string' ? toRelativeUploadUrl(body.banner) : null;
    if (bannerVal && !isAllowedImageUrl(bannerVal)) {
      return res.status(400).json({ error: 'Only PNG, JPG, and GIF files are allowed for banners.' });
    }
    const isImageUrl = bannerVal && (bannerVal.startsWith('/api/uploads/') || bannerVal.startsWith('http'));
    if (isImageUrl && plan !== 'essential' && plan !== 'pro') {
      return res.status(403).json({ error: 'Banner image upload requires Howl Pro Essential or higher.' });
    }
    updates.banner = bannerVal;
  }

  if (body.bannerPositionY !== undefined) {
    updates.bannerPositionY = body.bannerPositionY;
  }

  if (body.bannerZoom !== undefined) {
    updates.bannerZoom = body.bannerZoom;
  }

  if (body.nameColor !== undefined) {
    if (body.nameColor === null || body.nameColor === '') {
      updates.nameColor = null;
    } else if (plan !== 'pro') {
      return res.status(403).json({ error: 'Custom name color requires Howl Pro.' });
    } else if (!HEX_COLOR_RE.test(body.nameColor)) {
      return res.status(400).json({ error: 'Invalid color format. Use #hex (e.g. #ff6600).' });
    } else {
      updates.nameColor = body.nameColor;
    }
  }

  if (body.nameFont !== undefined) {
    if (body.nameFont === null || body.nameFont === '' || body.nameFont === 'default') {
      updates.nameFont = null;
    } else if (plan !== 'pro') {
      return res.status(403).json({ error: 'Custom name font requires Howl Pro.' });
    } else if (!VALID_NAME_FONTS.includes(body.nameFont)) {
      return res.status(400).json({ error: 'Invalid font key.' });
    } else {
      updates.nameFont = body.nameFont;
    }
  }

  if (body.nameEffect !== undefined) {
    if (body.nameEffect === null || body.nameEffect === '' || body.nameEffect === 'none') {
      updates.nameEffect = null;
    } else if (plan !== 'pro') {
      return res.status(403).json({ error: 'Name effects require Howl Pro.' });
    } else if (!VALID_NAME_EFFECTS.includes(body.nameEffect)) {
      return res.status(400).json({ error: 'Invalid name effect.' });
    } else {
      updates.nameEffect = body.nameEffect;
    }
  }

  if (body.avatarEffect !== undefined) {
    if (body.avatarEffect === null || body.avatarEffect === '' || body.avatarEffect === 'none') {
      updates.avatarEffect = null;
    } else if (plan !== 'pro') {
      return res.status(403).json({ error: 'Avatar effects require Howl Pro.' });
    } else if (!VALID_AVATAR_EFFECTS.includes(body.avatarEffect)) {
      return res.status(400).json({ error: 'Invalid avatar effect.' });
    } else {
      updates.avatarEffect = body.avatarEffect;
    }
  }

  if (body.backgroundImage !== undefined) {
    if (body.backgroundImage === null) {
      updates.backgroundImage = null;
    } else {
      if (plan !== 'essential' && plan !== 'pro') {
        return res.status(403).json({ error: 'Custom background requires Howl Pro Essential or higher.' });
      }
      if (!body.backgroundImage.startsWith('/api/uploads/')) {
        return res.status(400).json({ error: 'Background image must be a valid upload URL.' });
      }
      const isGif = body.backgroundImage.toLowerCase().endsWith('.gif');
      if (isGif && plan !== 'pro') {
        return res.status(403).json({ error: 'Animated GIF backgrounds require Howl Pro.' });
      }
      const bgUrl = body.backgroundImage;
      if (!isAllowedImageUrl(bgUrl)) {
        return res.status(400).json({ error: 'Only PNG, JPG, and GIF files are allowed for backgrounds.' });
      }
      updates.backgroundImage = bgUrl;
    }
  }
  if (body.backgroundOpacity !== undefined) {
    updates.backgroundOpacity = body.backgroundOpacity;
  }
  if (body.backgroundBlur !== undefined) {
    updates.backgroundBlur = body.backgroundBlur;
  }
  if (body.bgGifAlwaysPlay !== undefined) {
    updates.bgGifAlwaysPlay = body.bgGifAlwaysPlay;
  }
  if (body.activityBio !== undefined) {
    if (body.activityBio === null || body.activityBio === '') {
      updates.activityBio = null;
    } else {
      updates.activityBio = body.activityBio.trim().slice(0, 128);
    }
  }

  if (body.username !== undefined) {
    const parsed = usernameSchema.safeParse(body.username);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Invalid username';
      return res.status(400).json({ error: message });
    }
    const newUsername = parsed.data.trim();
    if (newUsername.toLowerCase() !== current.username.toLowerCase()) {
      const taken = await prisma.user.findMany({
        where: { username: { equals: newUsername, mode: 'insensitive' } },
        select: { discriminator: true },
        take: 10000,
      });
      const takenSet = new Set(taken.map((u) => u.discriminator));
      const available: string[] = [];
      for (let n = 0; n <= 9999; n++) {
        const d = n.toString().padStart(4, '0');
        if (!takenSet.has(d)) available.push(d);
      }
      if (available.length === 0) {
        return res.status(400).json({
          error: 'All discriminators for this username are taken (0000–9999). Please choose a different username.',
        });
      }
      updates.username = newUsername;
      updates.discriminator = available[crypto.randomInt(available.length)];
    }
  }

  const userRes = (u: any) => {
    let pe: string;
    try { pe = decryptSecret(u.email); } catch { pe = u.email; }
    return {
      id: u.id, username: u.username, discriminator: u.discriminator, email: pe,
      avatar: u.avatar, banner: u.banner ?? null, bannerPositionY: u.bannerPositionY ?? 50, bannerZoom: u.bannerZoom ?? 100, status: u.status, createdAt: u.createdAt,
      stripePlan: u.stripePlan ?? null, effectivePlan: getEffectivePlan(u),
      nameColor: u.nameColor ?? null, nameFont: u.nameFont ?? null,
      nameEffect: u.nameEffect ?? null, avatarEffect: u.avatarEffect ?? null,
      badges: computeBadges(u),
      backgroundImage: u.backgroundImage ?? null,
      backgroundOpacity: u.backgroundOpacity ?? 0.15,
      backgroundBlur: u.backgroundBlur ?? 0,
      bgGifAlwaysPlay: u.bgGifAlwaysPlay ?? false,
      activityBio: u.activityBio ?? null,
    };
  };

  if (Object.keys(updates).length === 0) return res.json(userRes(current));

  const user = await prisma.user.update({ where: { id: req.userId }, data: updates });

  // Eager cleanup of old avatar/banner files (best-effort, non-blocking)
  if (updates.avatar !== undefined && current.avatar && current.avatar !== updates.avatar) {
    deleteUploadedFile(current.avatar).catch(() => {});
  }
  if (updates.banner !== undefined && current.banner && current.banner !== updates.banner) {
    deleteUploadedFile(current.banner).catch(() => {});
  }

  // Live-update voice channel participant data when visual fields change
  const visualFieldsChanged = updates.avatar !== undefined || updates.banner !== undefined
    || updates.bannerPositionY !== undefined || updates.bannerZoom !== undefined;
  if (visualFieldsChanged) {
    (async () => {
      try {
        const voiceChannelId = await findUserVoiceChannel(req.userId!);
        if (!voiceChannelId) return;
        const existing = await getVoiceParticipantData(voiceChannelId, req.userId!);
        if (!existing) return;
        const updated = { ...existing };
        if (updates.avatar !== undefined) updated.avatar = user.avatar ?? undefined;
        if (updates.banner !== undefined) updated.banner = user.banner ?? undefined;
        if (updates.bannerPositionY !== undefined) updated.bannerPositionY = user.bannerPositionY ?? undefined;
        if (updates.bannerZoom !== undefined) updated.bannerZoom = user.bannerZoom ?? undefined;
        await addVoiceParticipant(voiceChannelId, req.userId!, updated);
        const io = req.app.get('io') as import('socket.io').Server | undefined;
        if (io) {
          const participants = await getVoiceParticipants(voiceChannelId);
          io.to(`voice:${voiceChannelId}`).emit('voice-participants', { channelId: voiceChannelId, participants });
          const channel = await prisma.channel.findUnique({ where: { id: voiceChannelId }, select: { serverId: true } });
          if (channel) {
            io.to(`server:${channel.serverId}`).emit('server-voice-participants', { serverId: channel.serverId, channelId: voiceChannelId, participants });
          }
        }
      } catch { /* best-effort, non-blocking */ }
    })();
  }

  // Broadcast bio change as activity update if no real activity is active
  if (updates.activityBio !== undefined) {
    const hasRealActivity = await prisma.userActivity.findUnique({ where: { userId: req.userId }, select: { id: true } });
    if (!hasRealActivity) {
      const newBio = updates.activityBio as string | null;
      const bioPayload = newBio ? { type: 'bio' as const, name: newBio, details: null, state: null, largeImage: null, smallImage: null, startedAt: new Date().toISOString(), platformId: null, platform: null } : null;
      broadcastActivityChange(req.userId, bioPayload).catch(() => {});
    }
  }

  const result = userRes(user);

  // Emit profile-updated to all own sessions (cross-tab / cross-device sync)
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${req.userId}`).emit('profile-updated', result);
  }

  return res.json(result);
}));

// POST /api/auth/me/discriminator — change discriminator (Essential+ only)
router.post('/me/discriminator', authenticateToken, sensitiveActionLimiter, validate(updateDiscriminatorSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { discriminator } = req.body as { discriminator?: string };

  if (!discriminator || !/^\d{4}$/.test(discriminator)) {
    return res.status(400).json({ error: 'Discriminator must be exactly 4 digits (0000–9999).' });
  }
  const numVal = parseInt(discriminator, 10);
  if (numVal < 0 || numVal > 9999) {
    return res.status(400).json({ error: 'Discriminator out of range.' });
  }

  const current = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, username: true, discriminator: true, stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true, lastDiscriminatorChange: true } });
  if (!current) return res.status(404).json({ error: 'User not found' });

  if (current.discriminator === discriminator) {
    return res.json({ discriminator: current.discriminator, changed: false });
  }

  const plan = getEffectivePlan(current);
  if (plan !== 'essential' && plan !== 'pro') {
    return res.status(403).json({ error: 'Changing your discriminator requires Howl Pro Essential or higher.' });
  }

  if (current.lastDiscriminatorChange && Date.now() - current.lastDiscriminatorChange.getTime() < TWO_DAYS_MS) {
    const nextAllowed = new Date(current.lastDiscriminatorChange.getTime() + TWO_DAYS_MS);
    return res.status(429).json({
      error: `You can only change your discriminator once every 48 hours. Try again after ${nextAllowed.toISOString()}.`,
      nextAllowed: nextAllowed.toISOString(),
    });
  }

  const existing = await prisma.user.findUnique({
    where: { username_discriminator: { username: current.username, discriminator } },
  });
  if (existing && existing.id !== current.id) {
    const taken = await prisma.user.findMany({
      where: { username: { equals: current.username, mode: 'insensitive' } },
      select: { discriminator: true },
      take: 10000,
    });
    const takenSet = new Set(taken.map((u) => u.discriminator));
    const suggestions: string[] = [];
    for (let offset = 1; offset <= 10 && suggestions.length < 3; offset++) {
      const above = (numVal + offset) % 10000;
      const below = (numVal - offset + 10000) % 10000;
      const a = above.toString().padStart(4, '0');
      const b = below.toString().padStart(4, '0');
      if (!takenSet.has(a)) suggestions.push(a);
      if (!takenSet.has(b) && suggestions.length < 3) suggestions.push(b);
    }
    return res.status(409).json({
      error: `#${discriminator} is already taken for "${current.username}".`,
      suggestions,
    });
  }

  try {
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: { discriminator, lastDiscriminatorChange: new Date() },
    });

    // Emit to all own sessions for cross-tab / cross-device sync
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) {
      io.to(`user:${req.userId}`).emit('profile-updated', { discriminator: user.discriminator });
    }

    return res.json({ discriminator: user.discriminator, changed: true });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: `#${discriminator} was just taken. Please try another.` });
    }
    throw err;
  }
}));

// PATCH /api/auth/me/status – update current user's presence status
router.patch('/me/status', authenticateToken, statusUpdateLimiter, validate(updateStatusSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { status } = req.body as { status?: string };
  if (!status || !VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
    return res.status(400).json({ error: 'Valid status required: online, idle, dnd, invisible, offline' });
  }
  // Short-circuit no-op writes: only persist + broadcast when the status
  // actually changes. A single atomic updateMany avoids a separate read and
  // skips needless DB writes + socket fan-out for echoed/duplicate updates.
  const result = await prisma.user.updateMany({
    where: { id: req.userId, status: { not: status } },
    data: { status },
  });
  if (result.count > 0) {
    const broadcastPresenceChange = req.app.get('broadcastPresenceChange') as ((userId: string, status: string) => Promise<void>) | undefined;
    if (broadcastPresenceChange) broadcastPresenceChange(req.userId, status);
  }
  return res.json({ status });
}));

// GET /api/auth/me/preferences – get notification + social preferences
router.get('/me/preferences', authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      notifyDesktop: true, notifyUnreadBadge: true, notifyTaskbarFlash: true,
      notifySoundNewMessage: true, notifySoundCurrentChannel: true,
      notifySoundIncomingRing: true, notifyDisableAllSounds: true,
      allowDmFromServerMembers: true, messageRequestsFilter: true,
      friendRequestsEveryone: true, friendRequestsFriendsOfFriends: true,
      friendRequestsServerMembers: true,
      showOnlineStatus: true, showJoinDate: true, showBadges: true,
      showCurrentActivity: true, shareDetectedGames: true, shareSteamActivity: true,
      shareSpotifyActivity: true, shareTwitchActivity: true, shareYouTubeActivity: true,
      activitySharingEnabled: true, activityShareScope: true, activitySourcePriority: true,
      shareActivityBio: true,
      profilePrivate: true,
      badgeDisplay: true,
    },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
}));

// PATCH /api/auth/me/preferences – update notification + social preferences
router.patch('/me/preferences', authenticateToken, profileUpdateLimiter, validate(updatePreferencesSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const allowed = [
    'notifyDesktop', 'notifyUnreadBadge', 'notifyTaskbarFlash',
    'notifySoundNewMessage', 'notifySoundCurrentChannel', 'notifySoundIncomingRing',
    'notifyDisableAllSounds', 'allowDmFromServerMembers', 'messageRequestsFilter',
    'friendRequestsEveryone', 'friendRequestsFriendsOfFriends', 'friendRequestsServerMembers',
    'showJoinDate', 'showBadges', 'shareDetectedGames', 'shareSteamActivity',
    'shareSpotifyActivity', 'shareTwitchActivity', 'shareYouTubeActivity',
    'activitySharingEnabled', 'shareActivityBio',
    'profilePrivate',
    // new-device login email opt-out
    'notifyOnNewDevice',
  ];
  const updates: Record<string, boolean | string | { hidden: string[]; order: string[] }> = {};
  for (const key of allowed) {
    if (typeof req.body[key] === 'boolean') updates[key] = req.body[key];
  }
  // Handle string enum preferences
  if (typeof req.body.showOnlineStatus === 'string') {
    const valid = ['everyone', 'friends_only'];
    if (valid.includes(req.body.showOnlineStatus)) {
      updates.showOnlineStatus = req.body.showOnlineStatus;
    }
  }
  if (typeof req.body.showCurrentActivity === 'string') {
    const valid = ['everyone', 'friends_only', 'nobody'];
    if (valid.includes(req.body.showCurrentActivity)) {
      updates.showCurrentActivity = req.body.showCurrentActivity;
    }
  }
  if (typeof req.body.activityShareScope === 'string') {
    const valid = ['everyone', 'friends_small_servers', 'friends_only'];
    if (valid.includes(req.body.activityShareScope)) {
      updates.activityShareScope = req.body.activityShareScope;
    }
  }
  if (typeof req.body.activitySourcePriority === 'string' && /^[a-z,]+$/.test(req.body.activitySourcePriority) && req.body.activitySourcePriority.length <= 256) {
    updates.activitySourcePriority = req.body.activitySourcePriority;
  }
  if (req.body.badgeDisplay && typeof req.body.badgeDisplay === 'object' && !Array.isArray(req.body.badgeDisplay)) {
    const bd = req.body.badgeDisplay as { hidden?: unknown; order?: unknown };
    updates.badgeDisplay = {
      hidden: Array.isArray(bd.hidden) ? [...new Set(bd.hidden.filter((x: unknown): x is string => typeof x === 'string'))] : [],
      order: Array.isArray(bd.order) ? [...new Set(bd.order.filter((x: unknown): x is string => typeof x === 'string'))] : [],
    };
  }

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid preferences provided' });

  const user = await prisma.user.update({ where: { id: req.userId }, data: updates });
  const prefsPayload = {
    notifyDesktop: user.notifyDesktop,
    notifyUnreadBadge: user.notifyUnreadBadge,
    notifyTaskbarFlash: user.notifyTaskbarFlash,
    notifySoundNewMessage: user.notifySoundNewMessage,
    notifySoundCurrentChannel: user.notifySoundCurrentChannel,
    notifySoundIncomingRing: user.notifySoundIncomingRing,
    notifyDisableAllSounds: user.notifyDisableAllSounds,
    allowDmFromServerMembers: user.allowDmFromServerMembers,
    messageRequestsFilter: user.messageRequestsFilter,
    friendRequestsEveryone: user.friendRequestsEveryone,
    friendRequestsFriendsOfFriends: user.friendRequestsFriendsOfFriends,
    friendRequestsServerMembers: user.friendRequestsServerMembers,
    showOnlineStatus: user.showOnlineStatus,
    showJoinDate: user.showJoinDate,
    showBadges: user.showBadges,
    showCurrentActivity: user.showCurrentActivity,
    shareDetectedGames: user.shareDetectedGames,
    shareSteamActivity: user.shareSteamActivity,
    shareSpotifyActivity: user.shareSpotifyActivity,
    shareTwitchActivity: user.shareTwitchActivity,
    shareYouTubeActivity: user.shareYouTubeActivity,
    activitySharingEnabled: user.activitySharingEnabled,
    activityShareScope: user.activityShareScope,
    activitySourcePriority: user.activitySourcePriority,
    shareActivityBio: user.shareActivityBio,
    profilePrivate: user.profilePrivate,
    notifyOnNewDevice: user.notifyOnNewDevice,
    badgeDisplay: user.badgeDisplay,
  };

  // Emit to all own sessions for cross-tab / cross-device sync
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`user:${req.userId}`).emit('preferences-updated', prefsPayload);
  }

  res.json(prefsPayload);
}));

export default router;
