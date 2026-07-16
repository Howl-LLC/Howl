// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { serverNotSuspendedByServerId } from '../middleware/serverNotSuspended.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getParam, hasPermission, PUBLIC_USER_SELECT, AUTHOR_USER_SELECT, getEffectivePlan, unionPerms, pickDisplayRole, loadPermissionContext, effectivePosition, canSeeHiddenRoles } from '../utils.js';
import { createAuditLog } from './serverSettings.js';
import { invalidateDiscoveryEligibility } from '../services/discoveryEligibilityCache.js';
import { logger } from '../logger.js';
import { validate } from '../middleware/validate.js';
import { VALID_PERMISSIONS, createServerSchema, createServerFromTemplateSchema, updateServerSchema, createChannelSchema, updateChannelSchema, createCategorySchema, updateCategorySchema, reorderChannelsSchema, reorderCategoriesSchema, setServerOrderSchema, transferOwnershipSchema, updateServerProfileSchema, updatePrivacySchema, serverMembersQuery, timeoutMemberSchema, manageNicknameSchema, completeServerOnboardingSchema } from '../schemas.js';
import { applyBadgePrefs } from '../utils/badges.js';
import { canViewChannel } from '../utils/channelPermissions.js';
import { autoJoinVisibleServerMembers, evictMinorSocketsFromAgeGatedChannel, emitChannelEventToViewers } from '../utils/channelVisibility.js';
import { containsProfanity } from '../utils/usernameValidator.js';
import { resolveActivityWinner } from '../socketHandlers/infrastructure.js';
import { powerUpTier, toRelativeUploadUrl, serverMutationLimiter } from './serverHelpers.js';
import { deleteUploadedFile } from './upload.js';
import { BUILT_IN_TEMPLATES } from '../builtinTemplates.js';
import serverRoleRoutes from './serverRoles.js';
import serverInviteRoutes from './serverInvites.js';
import {
  findUserVoiceChannel, removeVoiceParticipant, setVoiceReverseLookup,
  deleteVoiceOverride, getVoiceParticipants,
  invalidatePermissionContext,
} from '../redis.js';
import { removeLiveKitParticipant } from '../services/livekitAdmin.js';
import { evictUserFromServerStages } from '../services/stageEviction.js';
import { scheduleVoiceE2eeRotate } from '../services/voiceE2eeRotation.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'servers' });

const ALL_PERMISSIONS_GRANTED = Object.freeze(
  Object.fromEntries(VALID_PERMISSIONS.map(k => [k, true]))
);

const serverCreateLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:srv-create:'),
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Server creation limit reached. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

// Per-IP cap: chained before the per-user limiter so spammers using multiple
// accounts from one IP still get throttled. Keyed by req.ip only — never by
// userId — so account rotation doesn't reset the counter.
const serverCreateIpLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:srv-create-ip:'),
  windowMs: 24 * 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many servers created from this network. Try again tomorrow.' },
  keyGenerator: (req) => getClientIp(req) ?? 'anonymous',
});

const serverReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:srv-read:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const ACTIVITY_PUBLIC_SELECT = {
  type: true, name: true, details: true, state: true,
  largeImage: true, smallImage: true, startedAt: true,
  platformId: true, platform: true, durationMs: true,
} as const;

const SECONDARY_ACTIVITY_SELECT = {
  type: true, name: true, details: true, state: true,
  largeImage: true, smallImage: true, startedAt: true,
  platformId: true, platform: true, durationMs: true,
} as const;

const MAX_SERVERS_FREE = 100;
const MAX_SERVERS_PRO = 200;
const MAX_CHANNELS_PER_SERVER = 500;
const MAX_CATEGORIES_PER_SERVER = 50;

const router = Router();

function isAnimatedUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.endsWith('.gif') || lower.includes('.gif?') || lower.includes('animated');
}

const ALLOWED_IMAGE_EXTENSIONS = /\.(png|jpe?g|gif)$/i;

function isAllowedImageUrl(url: string): boolean {
  // Test the extension against the path only. The serve route
  // ignores a ?query/#fragment, so without stripping it `<uuid>.enc?x.png` would
  // pass the allowlist while the server serves the unscanned `.enc` blob.
  return ALLOWED_IMAGE_EXTENSIONS.test(url.split(/[?#]/)[0]);
}

const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;
function isHexColor(val: string): boolean {
  return HEX_COLOR_RE.test(val);
}

// GET /api/servers – slim list of servers the current user is a member of.
//
// Connect-storm hardening: this endpoint runs on every login/reconnect for
// every user. We deliberately omit channels, categories, and per-channel /
// per-category permission overrides — those are fetched lazily by
// GET /api/servers/:serverId on first server-click. Keeping this payload
// small keeps the bootstrap path cheap when ~10K users hit it at once.
//
// Exported as a helper so /api/v1/bootstrap can reuse the same slim shape.
export async function loadUserServers(userId: string): Promise<unknown[]> {
  const memberships = await prisma.serverMember.findMany({
    where: { userId },
    take: 200,
    // User-controlled order in the far-left sidebar (PUT /servers/me/order).
    // joinedAt as the secondary sort keeps newly-joined servers in a stable
    // position when their `position` is still the default 0.
    orderBy: [{ position: 'asc' }, { joinedAt: 'asc' }],
    include: {
      server: {
        select: {
          id: true, name: true, icon: true, banner: true, bannerPositionY: true,
          powerUpCount: true,
          _count: { select: { members: true } },
          settings: { select: { description: true } },
        },
      },
      serverRole: true,
      memberRoles: { include: { role: true } },
    },
  });

  // @everyone is needed so non-owner/admin users get a correct myPermissions
  // bitmap for client-side route guards. One small batch query.
  const serverIds = memberships.map(m => m.server.id);
  const everyoneRoles = await prisma.serverRole.findMany({
    where: { serverId: { in: serverIds }, isEveryone: true },
    select: { id: true, serverId: true, position: true, permissions: true, isEveryone: true },
  });
  const everyoneByServer = new Map(everyoneRoles.map(r => [r.serverId, r]));

  return memberships.map((m) => {
    const isOwner = m.role?.toLowerCase() === 'owner';
    const everyoneRole = everyoneByServer.get(m.server.id);
    const memberRoles = m.memberRoles
      .map(mr => ({ id: mr.role.id, position: mr.role.position, permissions: mr.role.permissions, isEveryone: mr.role.isEveryone }))
      .filter(r => !r.isEveryone);
    const unionedPerms = unionPerms([everyoneRole, ...memberRoles]);
    const isAdmin = isOwner || unionedPerms.administrator === true;
    const canSeeHidden = isOwner || isAdmin || unionedPerms.manageRoles === true;

    const rolesForDisplay = m.memberRoles.map(mr => ({
      id: mr.role.id,
      name: mr.role.name,
      color: mr.role.color,
      style: mr.role.style,
      position: mr.role.position,
      displaySeparately: mr.role.displaySeparately,
      isEveryone: mr.role.isEveryone,
      hidden: mr.role.hidden,
    }));
    const visibleForDisplay = canSeeHidden ? rolesForDisplay : rolesForDisplay.filter(r => !r.hidden);
    const displayRole = pickDisplayRole(visibleForDisplay);

    return {
      id: m.server.id,
      name: m.server.name,
      icon: m.server.icon ?? undefined,
      banner: (m.server as { banner?: string | null }).banner ?? undefined,
      bannerPositionY: (m.server as { bannerPositionY?: number | null }).bannerPositionY ?? 50,
      description: (m.server as any).settings?.description ?? null,
      powerUpCount: m.server.powerUpCount ?? 0,
      memberCount: (m.server as any)._count?.members ?? 0,
      myRole: isOwner ? 'owner' : (displayRole?.name ?? m.serverRole?.name ?? m.role ?? 'member'),
      myRoles: visibleForDisplay.filter(r => !r.isEveryone).map(r => ({
        id: r.id, name: r.name, color: r.color, style: r.style, position: r.position, displaySeparately: r.displaySeparately,
      })),
      myPermissions: (isOwner || isAdmin) ? ALL_PERMISSIONS_GRANTED : unionedPerms,
      acceptedAgeRestrictedChannelIds: m.acceptedAgeRestrictedChannelIds ?? [],
    };
  });
}
router.get('/', authenticateToken, serverReadLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  try {
    const servers = await loadUserServers(req.userId);
    res.json(servers);
  } catch (err) {
    next(err);
  }
});

// Per-user limiter for /servers/me/order. Keyed by userId so a noisy reorder
// from one tab doesn't penalize the other tabs of the same user, but each
// user is still capped at 60 writes/min to prevent runaway loops.
const setServerOrderLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:srv-order:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many reorders. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

// PUT /api/servers/me/order – persist the far-left sidebar server order for
// the authenticated user. Replaces the localStorage-only scheme so the order
// follows the user across devices, browser tabs, and reinstalls.
//
// Accepts the full ordered list of server IDs. Any membership the user holds
// that's missing from the body keeps its existing position (typically 0,
// which sorts to the top with joinedAt as the tiebreaker — matching the
// "newly joined server appears first" behavior of the legacy logic).
router.put('/me/order', authenticateToken, setServerOrderLimiter, validate(setServerOrderSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { serverIds } = req.body as { serverIds: string[] };

  // Verify every ID is a server the user is actually a member of. Anything
  // else is silently ignored — we don't want to leak which servers exist.
  const memberships = await prisma.serverMember.findMany({
    where: { userId: req.userId, serverId: { in: serverIds } },
    select: { serverId: true },
    take: 200,
  });
  const allowed = new Set(memberships.map(m => m.serverId));
  const filtered = serverIds.filter(id => allowed.has(id));

  if (filtered.length === 0) {
    return res.json({ success: true, updated: 0 });
  }

  await prisma.$transaction(
    filtered.map((serverId, index) => prisma.serverMember.update({
      where: { userId_serverId: { userId: req.userId!, serverId } },
      data: { position: index },
      select: { serverId: true },
    })),
  );

  res.json({ success: true, updated: filtered.length });
}));

// GET /api/servers/:serverId – hydrate a single server with channels,
// categories, and override-resolved visibility. Called by the frontend on
// first server-click; the slim GET /api/servers above omits this data.
router.get('/:serverId', validateUuidParams('serverId'), authenticateToken, serverReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');

  const membership = await prisma.serverMember.findUnique({
    where: { userId_serverId: { userId: req.userId, serverId } },
    include: {
      server: {
        include: {
          channels: {
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            take: 500,
            select: {
              id: true, name: true, type: true, description: true, categoryId: true, position: true,
              isPrivate: true, ageRestricted: true, userLimit: true, hideAfterInactivity: true,
              postGuidelines: true, defaultReaction: true, defaultSortOrder: true, defaultLayout: true,
              requireTags: true, postSlowMode: true, messageSlowMode: true, slowMode: true,
            },
          },
          categories: {
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            take: 50,
            select: { id: true, name: true, position: true, isPrivate: true },
          },
          _count: { select: { members: true } },
          settings: { select: { description: true } },
        },
      },
      serverRole: true,
      memberRoles: { include: { role: true } },
    },
  });
  if (!membership) return res.status(403).json({ error: 'Not a member of this server' });

  const [channelOverrides, categoryOverrides, everyoneRole] = await Promise.all([
    prisma.channelPermissionOverride.findMany({
      where: { channel: { serverId } },
      select: { channelId: true, targetType: true, targetId: true, permissions: true },
      take: 10000,
    }),
    prisma.categoryPermissionOverride.findMany({
      where: { category: { serverId } },
      select: { categoryId: true, targetType: true, targetId: true, permissions: true },
      take: 10000,
    }),
    prisma.serverRole.findFirst({
      where: { serverId, isEveryone: true },
      select: { id: true, serverId: true, position: true, permissions: true, isEveryone: true },
    }),
  ]);

  const chOverridesByChannel = new Map<string, typeof channelOverrides>();
  for (const o of channelOverrides) {
    const arr = chOverridesByChannel.get(o.channelId);
    if (arr) arr.push(o); else chOverridesByChannel.set(o.channelId, [o]);
  }
  const catOverridesByCat = new Map<string, typeof categoryOverrides>();
  for (const o of categoryOverrides) {
    const arr = catOverridesByCat.get(o.categoryId);
    if (arr) arr.push(o); else catOverridesByCat.set(o.categoryId, [o]);
  }

  const isOwner = membership.role?.toLowerCase() === 'owner';
  const memberRoles = membership.memberRoles
    .map(mr => ({ id: mr.role.id, position: mr.role.position, permissions: mr.role.permissions, isEveryone: mr.role.isEveryone }))
    .filter(r => !r.isEveryone);
  const unionedPerms = unionPerms([everyoneRole, ...memberRoles]);
  const isAdmin = isOwner || unionedPerms.administrator === true;

  const permCtx = {
    member: { userId: membership.userId, role: membership.role },
    roles: memberRoles,
    everyoneRole: everyoneRole ?? null,
  };

  const visibleChannels = membership.server.channels.filter((c: any) => {
    if (!c.isPrivate) return true;
    if (isOwner || isAdmin) return true;
    const chOvr = chOverridesByChannel.get(c.id) ?? [];
    const catOvr = c.categoryId ? (catOverridesByCat.get(c.categoryId) ?? []) : [];
    return canViewChannel(permCtx, c, chOvr, catOvr);
  });

  const visibleChannelCatIds = new Set(visibleChannels.map((c: any) => c.categoryId).filter(Boolean));
  const visibleCategories = (membership.server as any).categories?.filter((cat: any) => {
    if (!cat.isPrivate) return true;
    if (isOwner || isAdmin) return true;
    return visibleChannelCatIds.has(cat.id);
  }) ?? [];

  const rolesForDisplay = membership.memberRoles.map(mr => ({
    id: mr.role.id,
    name: mr.role.name,
    color: mr.role.color,
    style: mr.role.style,
    position: mr.role.position,
    displaySeparately: mr.role.displaySeparately,
    isEveryone: mr.role.isEveryone,
  }));
  const displayRole = pickDisplayRole(rolesForDisplay);

  res.json({
    id: membership.server.id,
    name: membership.server.name,
    icon: membership.server.icon ?? undefined,
    banner: (membership.server as { banner?: string | null }).banner ?? undefined,
    bannerPositionY: (membership.server as { bannerPositionY?: number | null }).bannerPositionY ?? 50,
    description: (membership.server as any).settings?.description ?? null,
    powerUpCount: membership.server.powerUpCount ?? 0,
    memberCount: (membership.server as any)._count?.members ?? 0,
    myRole: isOwner ? 'owner' : (displayRole?.name ?? membership.serverRole?.name ?? membership.role ?? 'member'),
    myRoles: rolesForDisplay.filter(r => !r.isEveryone).map(r => ({
      id: r.id, name: r.name, color: r.color, style: r.style, position: r.position, displaySeparately: r.displaySeparately,
    })),
    myPermissions: (isOwner || isAdmin) ? ALL_PERMISSIONS_GRANTED : unionedPerms,
    acceptedAgeRestrictedChannelIds: membership.acceptedAgeRestrictedChannelIds ?? [],
    channels: visibleChannels.map((c: any) => ({
      id: c.id,
      name: c.name,
      description: c.description ?? undefined,
      type: c.type as 'text' | 'voice' | 'stage' | 'forum',
      categoryId: c.categoryId ?? null,
      position: c.position ?? 0,
      isPrivate: c.isPrivate ?? false,
      ageRestricted: c.ageRestricted ?? false,
      userLimit: c.userLimit ?? 0,
      hideAfterInactivity: c.hideAfterInactivity ?? null,
      postGuidelines: c.postGuidelines ?? null,
      defaultReaction: c.defaultReaction ?? null,
      defaultSortOrder: c.defaultSortOrder ?? 'recent_activity',
      defaultLayout: c.defaultLayout ?? 'list',
      requireTags: c.requireTags ?? false,
      postSlowMode: c.postSlowMode ?? 0,
      messageSlowMode: c.messageSlowMode ?? 0,
      slowMode: c.slowMode ?? 0,
    })),
    categories: visibleCategories.map((cat: any) => ({
      id: cat.id, name: cat.name, position: cat.position, isPrivate: cat.isPrivate ?? false,
    })),
  });
}));

// GET /api/servers/:serverId/privacy – get user's DM privacy setting for a server
router.get('/:serverId/privacy', validateUuidParams('serverId'), authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const membership = await prisma.serverMember.findUnique({
    where: { userId_serverId: { userId: req.userId, serverId } },
  });
  if (!membership) return res.status(404).json({ error: 'Not a member of this server' });
  res.json({ allowDirectMessages: membership.allowDirectMessages });
}));

// PATCH /api/servers/:serverId/privacy – update user's DM privacy setting for a server
router.patch('/:serverId/privacy', validateUuidParams('serverId'), authenticateToken, serverMutationLimiter, validate(updatePrivacySchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const { allowDirectMessages } = req.body as { allowDirectMessages?: boolean | null };
  const membership = await prisma.serverMember.findUnique({
    where: { userId_serverId: { userId: req.userId, serverId } },
    select: { userId: true, role: true },
  });
  if (!membership) return res.status(404).json({ error: 'Not a member of this server' });
  const updated = await prisma.serverMember.update({
    where: { userId_serverId: { userId: req.userId, serverId } },
    data: { allowDirectMessages: allowDirectMessages ?? null },
  });
  await invalidatePermissionContext(serverId, req.userId);
  res.json({ allowDirectMessages: updated.allowDirectMessages });
}));

// POST /api/servers – create server and add current user as owner, create #general + default roles
router.post('/', authenticateToken, serverCreateIpLimiter, serverCreateLimiter, serverMutationLimiter, validate(createServerSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const [serverCount, user] = await Promise.all([
    prisma.serverMember.count({ where: { userId: req.userId } }),
    prisma.user.findUnique({ where: { id: req.userId }, select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true } }),
  ]);
  const effectivePlan = user ? getEffectivePlan(user) : 'free';
  const limit = (effectivePlan === 'essential' || effectivePlan === 'pro') ? MAX_SERVERS_PRO : MAX_SERVERS_FREE;
  if (serverCount >= limit) {
    return res.status(403).json({ error: `You've reached the maximum of ${limit} servers. ${limit === MAX_SERVERS_FREE ? 'Upgrade to Howl Pro to join up to 200 servers.' : ''}` });
  }
  const { name, icon, template: templateKey } = req.body as { name?: string; icon?: string; template?: string };
  const serverName = typeof name === 'string' && name.trim() ? name.trim() : 'New Server';
  const iconVal: string | null = typeof icon === 'string' ? (toRelativeUploadUrl(icon) ?? icon) : null;
  if (iconVal && !isAllowedImageUrl(iconVal)) {
    return res.status(400).json({ error: 'Only PNG, JPG, and GIF files are allowed for server icons.' });
  }
  if (iconVal && isAnimatedUrl(iconVal)) {
    return res.status(403).json({ error: 'Animated server icons require at least Tier 1 (2 power-ups).' });
  }
  const builtIn = templateKey ? BUILT_IN_TEMPLATES[templateKey] : undefined;
  const server = await prisma.$transaction(async (tx) => {
    const s = await tx.server.create({
      data: {
        name: serverName,
        icon: iconVal,
        ownerId: req.userId!,
        members: { create: { userId: req.userId!, role: 'owner' } },
      },
    });

    // Create categories + channels from built-in template or default
    if (builtIn) {
      for (let ci = 0; ci < builtIn.categories.length; ci++) {
        const catDef = builtIn.categories[ci];
        const cat = await tx.channelCategory.create({
          data: { serverId: s.id, name: catDef.name, position: ci },
        });
        for (let chi = 0; chi < catDef.channels.length; chi++) {
          const chDef = catDef.channels[chi];
          await tx.channel.create({
            data: { serverId: s.id, name: chDef.name, type: chDef.type, categoryId: cat.id, position: chi },
          });
        }
      }
    } else {
      const defaultCategory = await tx.channelCategory.create({
        data: { serverId: s.id, name: 'General', position: 0 },
      });
      await tx.channel.create({
        data: { serverId: s.id, name: 'general', type: 'text', categoryId: defaultCategory.id, position: 0 },
      });
    }

    // Baseline perms that every member gets via @everyone role (was on Member).
    const EVERYONE_BASELINE = {
      viewChannels: true, sendMessages: true, readMessageHistory: true,
      embedLinks: true, attachFiles: true, addReactions: true,
      connect: true, speak: true, video: true, useVoiceActivity: true,
      createInvite: true, changeNickname: true, viewCalendar: true,
      requestToSpeak: true, createPolls: true, createThreads: true,
      sendMessagesInThreads: true, createPosts: true, sendMessagesInPosts: true,
    };

    const [ownerRole, memberRole, everyoneRole] = await Promise.all([
      tx.serverRole.create({ data: { serverId: s.id, name: 'Owner', color: '#f59e0b', style: 'solid', position: 0, locked: true, displaySeparately: true, permissions: { administrator: true } } }),
      // Member is now a display-only default role (empty perms; @everyone provides baseline).
      tx.serverRole.create({ data: { serverId: s.id, name: 'Member', color: '#06b6d4', style: 'solid', position: 1, permissions: {} } }),
      // @everyone sits at the bottom of the list (highest position number — lowest authority in Howl's convention).
      tx.serverRole.create({ data: { serverId: s.id, name: '@everyone', color: '#99aab5', style: 'solid', position: 999, locked: true, isEveryone: true, permissions: EVERYONE_BASELINE } }),
    ]);

    // Create extra roles from built-in template. Template perms are merged on top of @everyone baseline via union.
    if (builtIn) {
      let pos = 2;
      for (const r of builtIn.extraRoles) {
        await tx.serverRole.create({
          data: { serverId: s.id, name: r.name, color: r.color, style: 'solid', position: pos++, permissions: r.permissions },
        });
      }
      await tx.serverSettings.create({ data: { serverId: s.id } });
    } else {
      await tx.serverSettings.create({ data: { serverId: s.id } });
    }

    await tx.serverMember.update({
      where: { userId_serverId: { userId: req.userId!, serverId: s.id } },
      data: { roleId: ownerRole.id },
    });
    // Owner gets the Owner role in the new MemberRole join table too.
    await tx.memberRole.create({
      data: { userId: req.userId!, serverId: s.id, roleId: ownerRole.id },
    });
    // Suppress unused-var lint for memberRole / everyoneRole (referenced for transaction integrity).
    void memberRole; void everyoneRole;
    const full = await tx.server.findUniqueOrThrow({
      where: { id: s.id },
      include: { channels: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }, categories: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] } },
    });
    return { ...full, ownerRoleId: ownerRole.id, memberRoleId: memberRole.id };
  });
  // Defensive: drop any stale (server, owner) cache entry. New server has no
  // peer cached entries to touch.
  await invalidatePermissionContext(server.id, req.userId);
  res.status(201).json({
    id: server.id,
    name: server.name,
    icon: server.icon ?? undefined,
    banner: (server as { banner?: string | null }).banner ?? undefined,
    myRole: 'owner',
    channels: server.channels.map((c: any) => ({ id: c.id, name: c.name, description: c.description ?? undefined, type: c.type, categoryId: c.categoryId ?? null, position: c.position ?? 0 })),
    categories: (server as any).categories?.map((cat: any) => ({ id: cat.id, name: cat.name, position: cat.position })) ?? [],
  });
}));

// POST /api/servers/from-template – create server from a template code
router.post('/from-template', authenticateToken, serverCreateLimiter, serverMutationLimiter, validate(createServerFromTemplateSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const [serverCount, user] = await Promise.all([
    prisma.serverMember.count({ where: { userId: req.userId } }),
    prisma.user.findUnique({ where: { id: req.userId }, select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true } }),
  ]);
  const effectivePlan = user ? getEffectivePlan(user) : 'free';
  const limit = (effectivePlan === 'essential' || effectivePlan === 'pro') ? MAX_SERVERS_PRO : MAX_SERVERS_FREE;
  if (serverCount >= limit) {
    return res.status(403).json({ error: `You've reached the maximum of ${limit} servers. ${limit === MAX_SERVERS_FREE ? 'Upgrade to Howl Pro to join up to 200 servers.' : ''}` });
  }

  const { code, name, icon } = req.body as { code: string; name?: string; icon?: string };

  const iconVal: string | null = typeof icon === 'string' ? (toRelativeUploadUrl(icon) ?? icon) : null;
  if (iconVal && !isAllowedImageUrl(iconVal)) {
    return res.status(400).json({ error: 'Only PNG, JPG, and GIF files are allowed for server icons.' });
  }
  if (iconVal && isAnimatedUrl(iconVal)) {
    return res.status(403).json({ error: 'Animated server icons require at least Tier 1 (2 power-ups).' });
  }

  const template = await prisma.serverTemplate.findUnique({ where: { code } });
  if (!template) return res.status(404).json({ error: 'Template not found' });

  // Parse snapshots safely
  const categorySnap = Array.isArray(template.categorySnapshot)
    ? (template.categorySnapshot as Array<{ name: string; position: number; channels: Array<{ name: string; type: string; position: number }> }>).filter(
        (cat) => typeof cat?.name === 'string' && Array.isArray(cat?.channels)
      )
    : [];
  const channelSnap = Array.isArray(template.channelSnapshot)
    ? (template.channelSnapshot as Array<{ name: string; type: string }>).filter(
        (ch) => typeof ch?.name === 'string' && typeof ch?.type === 'string'
      )
    : [];
  const roleSnap = Array.isArray(template.roleSnapshot)
    ? (template.roleSnapshot as Array<{ name: string; color: string; permissions: Record<string, boolean> }>).filter(
        (r) => typeof r?.name === 'string' && r.name.toLowerCase() !== 'owner'
      )
    : [];

  const serverName = (typeof name === 'string' && name.trim()) ? name.trim() : `${template.name} Server`;

  const server = await prisma.$transaction(async (tx) => {
    const s = await tx.server.create({
      data: {
        name: serverName,
        icon: iconVal,
        ownerId: req.userId!,
        members: { create: { userId: req.userId!, role: 'owner' } },
      },
    });

    // Create categories + channels from categorySnapshot, flat channelSnapshot, or default
    if (categorySnap.length > 0) {
      for (let ci = 0; ci < categorySnap.length; ci++) {
        const catDef = categorySnap[ci];
        const cat = await tx.channelCategory.create({
          data: { serverId: s.id, name: catDef.name, position: catDef.position ?? ci },
        });
        const channels = Array.isArray(catDef.channels) ? catDef.channels : [];
        for (let chi = 0; chi < channels.length; chi++) {
          const chDef = channels[chi];
          await tx.channel.create({
            data: {
              serverId: s.id,
              name: (typeof chDef.name === 'string' ? chDef.name.trim() : 'channel') || 'channel',
              type: chDef.type === 'voice' ? 'voice' : chDef.type === 'stage' ? 'stage' : 'text',
              categoryId: cat.id,
              position: chDef.position ?? chi,
            },
          });
        }
      }
    } else {
      const defaultCategory = await tx.channelCategory.create({
        data: { serverId: s.id, name: 'General', position: 0 },
      });
      const channelData = channelSnap.length > 0
        ? channelSnap.map((ch, i) => ({
            name: ch.name.trim() || 'channel',
            type: ch.type === 'voice' ? 'voice' : ch.type === 'stage' ? 'stage' : 'text',
            categoryId: defaultCategory.id,
            position: i,
          }))
        : [{ name: 'general', type: 'text', categoryId: defaultCategory.id, position: 0 }];
      for (const cd of channelData) {
        await tx.channel.create({ data: { serverId: s.id, ...cd } });
      }
    }

    // Baseline perms that every member gets via @everyone role.
    const EVERYONE_BASELINE = {
      viewChannels: true, sendMessages: true, readMessageHistory: true,
      embedLinks: true, attachFiles: true, addReactions: true,
      connect: true, speak: true, video: true, useVoiceActivity: true,
      createInvite: true, changeNickname: true, viewCalendar: true,
      requestToSpeak: true, createPolls: true, createThreads: true,
      sendMessagesInThreads: true, createPosts: true, sendMessagesInPosts: true,
    };

    // Create Owner + Member + @everyone default roles.
    // Member is now display-only (empty perms; baseline lives in @everyone).
    const [ownerRole, memberRole, everyoneRole] = await Promise.all([
      tx.serverRole.create({ data: { serverId: s.id, name: 'Owner', color: '#f59e0b', style: 'solid', position: 0, locked: true, displaySeparately: true, permissions: { administrator: true } } }),
      tx.serverRole.create({ data: { serverId: s.id, name: 'Member', color: '#06b6d4', style: 'solid', position: 1, permissions: {} } }),
      tx.serverRole.create({ data: { serverId: s.id, name: '@everyone', color: '#99aab5', style: 'solid', position: 999, locked: true, isEveryone: true, permissions: EVERYONE_BASELINE } }),
    ]);
    void everyoneRole;

    // Create additional roles from snapshot (skip Owner/Member since we already created them)
    let pos = 2;
    for (const r of roleSnap) {
      if (r.name.toLowerCase() === 'member') continue;
      const perms = (typeof r.permissions === 'object' && r.permissions !== null) ? r.permissions : {};
      await tx.serverRole.create({
        data: {
          serverId: s.id,
          name: r.name,
          color: typeof r.color === 'string' ? r.color : '#99aab5',
          style: 'solid',
          position: pos++,
          permissions: perms,
        },
      });
    }

    await tx.serverMember.update({
      where: { userId_serverId: { userId: req.userId!, serverId: s.id } },
      data: { roleId: ownerRole.id },
    });
    await tx.memberRole.create({
      data: { userId: req.userId!, serverId: s.id, roleId: ownerRole.id },
    });

    // Create default server settings
    await tx.serverSettings.create({ data: { serverId: s.id } });

    const full = await tx.server.findUniqueOrThrow({
      where: { id: s.id },
      include: { channels: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }, categories: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] } },
    });
    return { ...full, ownerRoleId: ownerRole.id, memberRoleId: memberRole.id };
  });

  // Increment usage count
  await prisma.serverTemplate.update({
    where: { id: template.id },
    data: { usageCount: { increment: 1 } },
  });

  // Defensive: drop any stale (server, owner) cache entry.
  await invalidatePermissionContext(server.id, req.userId);

  res.status(201).json({
    id: server.id,
    name: server.name,
    icon: server.icon ?? undefined,
    banner: (server as { banner?: string | null }).banner ?? undefined,
    myRole: 'owner',
    channels: server.channels.map((c: any) => ({ id: c.id, name: c.name, description: c.description ?? undefined, type: c.type, categoryId: c.categoryId ?? null, position: c.position ?? 0 })),
    categories: (server as any).categories?.map((cat: any) => ({ id: cat.id, name: cat.name, position: cat.position })) ?? [],
  });
}));

// GET /api/servers/template-preview/:code — public template preview for URL resolution
const templatePreviewLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:tmpl-preview:'),
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => getClientIp(req) ?? 'anonymous',
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/template-preview/:code', templatePreviewLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  const code = getParam(req, 'code');
  if (!code || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code)) {
    return res.status(400).json({ error: 'Invalid template code' });
  }

  const template = await prisma.serverTemplate.findUnique({
    where: { code },
    select: {
      name: true,
      description: true,
      code: true,
      channelSnapshot: true,
      roleSnapshot: true,
      categorySnapshot: true,
      settingsSnapshot: true,
      usageCount: true,
      createdAt: true,
      server: { select: { name: true } },
    },
  });

  if (!template) return res.status(404).json({ error: 'Template not found' });

  res.json({
    name: template.name,
    description: template.description,
    code: template.code,
    channelSnapshot: template.channelSnapshot,
    roleSnapshot: template.roleSnapshot,
    categorySnapshot: template.categorySnapshot,
    settingsSnapshot: template.settingsSnapshot,
    usageCount: template.usageCount,
    serverName: template.server.name,
    createdAt: template.createdAt,
  });
}));

// POST /api/servers/:serverId/leave – leave server (must be before other :serverId routes so path is matched)
router.post('/:serverId/leave', validateUuidParams('serverId'), authenticateToken, serverMutationLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const member = await prisma.serverMember.findUnique({
    where: { userId_serverId: { userId: req.userId, serverId } },
    select: { userId: true, role: true },
  });
  if (!member) return res.status(403).json({ error: 'Not a member of this server' });
  const leaveServer = await prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } });
  const isLeavingOwner = leaveServer?.ownerId != null
    ? leaveServer.ownerId === req.userId
    : member.role?.toLowerCase() === 'owner';
  if (isLeavingOwner) {
    return res.status(400).json({ error: 'Owner cannot leave; transfer ownership first' });
  }
  await prisma.serverMember.delete({
    where: { userId_serverId: { userId: req.userId, serverId } },
  });
  await invalidatePermissionContext(serverId, req.userId);

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`server:${serverId}`).emit('server-member-left', { serverId, userId: req.userId, kicked: false });

    // Evict leaving user from server/channel/voice socket rooms
    const sockets = await io.in(`user:${req.userId}`).fetchSockets();
    const serverChannels = await prisma.channel.findMany({ where: { serverId }, select: { id: true }, take: 500 });
    const roomsToLeave = [`server:${serverId}`, ...serverChannels.map(c => `channel:${c.id}`), ...serverChannels.map(c => `voice:${c.id}`)];
    for (const s of sockets) {
      for (const room of roomsToLeave) s.leave(room);
    }

    // Clean up voice state in Redis
    const voiceChannelId = await findUserVoiceChannel(req.userId!);
    if (voiceChannelId) {
      const voiceChannel = serverChannels.find(c => c.id === voiceChannelId);
      if (voiceChannel) {
        await removeVoiceParticipant(voiceChannelId, req.userId!);
        await setVoiceReverseLookup(req.userId!, null);
        await deleteVoiceOverride(voiceChannelId, req.userId!);
        io.to(`voice:${voiceChannelId}`).emit('voice-user-left', { userId: req.userId });
        const participants = await getVoiceParticipants(voiceChannelId);
        io.to(`server:${serverId}`).emit('server-voice-participants', {
          serverId, channelId: voiceChannelId, participants,
        });
        // Forward secrecy at the leave boundary. Rotate the SFrame key so
        // the leaver's retained key no longer protects subsequent media, and
        // hard-disconnect them from the SFU (this path previously had neither),
        // mirroring the kick/ban/timeout paths and voice.ts:439.
        scheduleVoiceE2eeRotate(io, voiceChannelId, participants.length > 0);
        removeLiveKitParticipant(`voice:${voiceChannelId}`, req.userId!).catch(() => {});
      }
    }
  }

  res.status(200).json({ ok: true });
}));

// POST /api/servers/:serverId/transfer-ownership – owner transfers ownership to another member
router.post('/:serverId/transfer-ownership', validateUuidParams('serverId'), authenticateToken, serverMutationLimiter, validate(transferOwnershipSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const { newOwnerId } = req.body as { newOwnerId?: string };
  // Owner-ness is the authoritative Server.ownerId, not the role string.
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { id: true, ownerId: true },
  });
  if (!server) return res.status(404).json({ error: 'Server not found' });
  // Legacy fallback: a server created before ownerId existed (or by an old
  // replica mid-deploy) may not be backfilled yet. Authorize via the member
  // role string; the transaction below heals ownerId as part of the transfer.
  let isCurrentOwner = server.ownerId === req.userId;
  if (server.ownerId == null) {
    const legacyMember = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      select: { role: true },
    });
    isCurrentOwner = legacyMember?.role?.toLowerCase() === 'owner';
  }
  if (!isCurrentOwner) return res.status(403).json({ error: 'Only the owner can transfer ownership' });
  if (!newOwnerId || typeof newOwnerId !== 'string') return res.status(400).json({ error: 'newOwnerId is required' });
  if (newOwnerId === req.userId) return res.status(400).json({ error: 'Cannot transfer to yourself' });
  const newOwnerMember = await prisma.serverMember.findUnique({
    where: { userId_serverId: { userId: newOwnerId, serverId } },
    select: { userId: true, role: true },
  });
  if (!newOwnerMember) return res.status(400).json({ error: 'User is not a member of this server' });
  const [ownerRole, memberRole] = await Promise.all([
    // The Owner role is the locked non-@everyone role; fall back to a name
    // match for servers that predate the locked flag.
    prisma.serverRole.findFirst({
      where: { serverId, isEveryone: false, OR: [{ locked: true }, { name: { equals: 'owner', mode: 'insensitive' } }] },
      orderBy: { locked: 'desc' },
    }),
    prisma.serverRole.findFirst({ where: { serverId, name: { equals: 'member', mode: 'insensitive' } } }),
  ]);
  // Move ownership as one atomic unit: the authoritative Server.ownerId, the
  // administrator-bearing Owner MemberRole (it must move with ownership so the
  // old owner does not retain administrator), the legacy roleId pointer, and
  // the mirrored role string. The old owner drops to Member; the new owner
  // gains the Owner role. MemberRole writes are idempotent (createMany
  // skipDuplicates / deleteMany) so a re-run can't error.
  await prisma.$transaction([
    prisma.server.update({
      where: { id: serverId },
      data: { ownerId: newOwnerId },
    }),
    // Strip the Owner role (and its administrator permission) from the old owner.
    ...(ownerRole
      ? [prisma.memberRole.deleteMany({
          where: { userId: req.userId, serverId, roleId: ownerRole.id },
        })]
      : []),
    // updateMany: a no-op (not a P2025 throw) if the outgoing owner's member
    // row is missing, e.g. a stale ownerId pointing at a departed user.
    prisma.serverMember.updateMany({
      where: { userId: req.userId, serverId },
      data: { role: 'member', roleId: memberRole ? memberRole.id : null },
    }),
    // Grant the Owner role to the new owner so their administrator permission
    // and display badge are durable, not dependent on the role string.
    ...(ownerRole
      ? [prisma.memberRole.createMany({
          data: [{ userId: newOwnerId, serverId, roleId: ownerRole.id, assignedBy: req.userId }],
          skipDuplicates: true,
        })]
      : []),
    prisma.serverMember.update({
      where: { userId_serverId: { userId: newOwnerId, serverId } },
      data: { role: 'owner', ...(ownerRole ? { roleId: ownerRole.id } : {}) },
    }),
  ]);
  await Promise.all([
    invalidatePermissionContext(serverId, req.userId),
    invalidatePermissionContext(serverId, newOwnerId),
  ]);

  await createAuditLog(serverId, req.userId!, 'ownership_transfer', 'server', serverId, { previousOwnerId: req.userId, newOwnerId }).catch(() => {});

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) io.to(`server:${serverId}`).emit('server-ownership-transferred', { serverId, previousOwnerId: req.userId, newOwnerId });

  res.status(200).json({ ok: true });
}));

// PATCH /api/servers/:serverId – update server name/icon (manageServer permission)
router.patch('/:serverId', validateUuidParams('serverId'), authenticateToken, serverMutationLimiter, validate(updateServerSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const [ctx, server] = await Promise.all([
    loadPermissionContext(req.userId, serverId),
    prisma.server.findUnique({ where: { id: serverId }, include: { channels: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }, categories: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] } } }),
  ]);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'manageServer')) return res.status(403).json({ error: 'You need the Manage Server permission' });
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const tier = powerUpTier(server.powerUpCount);
  const body = req.body as { name?: string; icon?: string; banner?: string };
  const data: { name?: string; icon?: string | null; banner?: string | null } = {};
  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
  if (body.icon !== undefined) {
    const iconVal = body.icon === '' || body.icon === null ? null : (toRelativeUploadUrl(body.icon) ?? body.icon);
    if (iconVal && !isAllowedImageUrl(iconVal)) {
      return res.status(400).json({ error: 'Only PNG, JPG, and GIF files are allowed for server icons.' });
    }
    if (iconVal && isAnimatedUrl(iconVal) && tier < 1) {
      return res.status(403).json({ error: 'Animated server icons require at least Tier 1 (2 power-ups).' });
    }
    data.icon = iconVal;
  }
  if (body.banner !== undefined) {
    const bannerVal = body.banner === '' || body.banner === null ? null : (toRelativeUploadUrl(body.banner) ?? body.banner);
    if (bannerVal && !isHexColor(bannerVal) && !isAllowedImageUrl(bannerVal)) {
      return res.status(400).json({ error: 'Only PNG, JPG, and GIF files are allowed for server banners.' });
    }
    if (bannerVal && !isHexColor(bannerVal) && tier < 2) {
      return res.status(403).json({ error: 'Server banners require at least Tier 2 (7 power-ups).' });
    }
    if (bannerVal && !isHexColor(bannerVal) && isAnimatedUrl(bannerVal) && tier < 3) {
      return res.status(403).json({ error: 'Animated server banners require Tier 3 (14 power-ups).' });
    }
    data.banner = bannerVal;
  }
  if (Object.keys(data).length === 0) {
    return res.json({
      id: server.id,
      name: server.name,
      icon: server.icon ?? undefined,
      banner: (server as { banner?: string | null }).banner ?? undefined,
      channels: server.channels.map((c: any) => ({ id: c.id, name: c.name, description: c.description ?? undefined, type: c.type, categoryId: c.categoryId ?? null, position: c.position ?? 0 })),
      categories: (server as any).categories?.map((cat: any) => ({ id: cat.id, name: cat.name, position: cat.position })) ?? [],
    });
  }
  const updated = await prisma.server.update({
    where: { id: serverId },
    data,
    include: { channels: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }, categories: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] } },
  });
  await createAuditLog(serverId, req.userId!, 'server_update', 'settings', serverId, data).catch(() => {});
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) io.to(`server:${serverId}`).emit('server-updated', { serverId, name: updated.name, icon: updated.icon ?? null, banner: (updated as { banner?: string | null }).banner ?? null });
  // Server icon is a discovery-eligibility input — bust the cache so the
  // owner sees the gate flip green within seconds, not minutes.
  if (data.icon !== undefined) {
    void invalidateDiscoveryEligibility(serverId);
  }
  res.json({
    id: updated.id,
    name: updated.name,
    icon: updated.icon ?? undefined,
    banner: (updated as { banner?: string | null }).banner ?? undefined,
    channels: updated.channels.map((c: any) => ({ id: c.id, name: c.name, description: c.description ?? undefined, type: c.type, categoryId: c.categoryId ?? null, position: c.position ?? 0 })),
    categories: (updated as any).categories?.map((cat: any) => ({ id: cat.id, name: cat.name, position: cat.position })) ?? [],
  });
}));

// PATCH /api/servers/:serverId/channels/:channelId – update channel (manageChannels permission)
router.patch('/:serverId/channels/:channelId', validateUuidParams('serverId', 'channelId'), authenticateToken, serverNotSuspendedByServerId('serverId'), serverMutationLimiter, validate(updateChannelSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const channelId = getParam(req, 'channelId');
  const [ctx, channel] = await Promise.all([
    loadPermissionContext(req.userId, serverId),
    prisma.channel.findFirst({ where: { id: channelId, serverId } }),
  ]);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'manageChannels')) return res.status(403).json({ error: 'You need the Manage Channels permission' });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const { name, description, slowMode, isPrivate, ageRestricted, userLimit, hideAfterInactivity,
    postGuidelines, defaultReaction, defaultSortOrder, defaultLayout, requireTags,
    postSlowMode, messageSlowMode } = req.body as Record<string, any>;
  const data: Record<string, unknown> = {};
  if (typeof name === 'string') {
    // Spaces and mixed case are allowed — channels can be named like "Off topic"
    // or "Movie Nights". Just trim outer whitespace.
    const trimmed = name.trim();
    if (trimmed) data.name = trimmed;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'description')) {
    data.description = typeof description === 'string' ? (description.trim() || null) : null;
  }
  if (typeof slowMode === 'number' && slowMode >= 0) data.slowMode = Math.floor(slowMode);
  if (typeof isPrivate === 'boolean') data.isPrivate = isPrivate;
  if (typeof ageRestricted === 'boolean') {
    // Discovery x age-restricted mutual exclusion: block age-restriction if
    // the server is listed in Discovery.
    if (ageRestricted === true) {
      const srvSettings = await prisma.serverSettings.findUnique({
        where: { serverId: channel.serverId },
        select: { discoveryEnabled: true },
      });
      if (srvSettings?.discoveryEnabled) {
        return res.status(400).json({
          error: 'age_restriction_blocked_by_discovery',
          message: 'Remove this server from Discovery to enable age restrictions.',
        });
      }
    }
    data.ageRestricted = ageRestricted;
  }
  if (typeof userLimit === 'number') data.userLimit = userLimit;
  if (Object.prototype.hasOwnProperty.call(req.body, 'hideAfterInactivity')) {
    data.hideAfterInactivity = hideAfterInactivity ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'postGuidelines')) {
    data.postGuidelines = typeof postGuidelines === 'string' ? (postGuidelines.trim() || null) : null;
  }
  if (typeof defaultReaction === 'string') data.defaultReaction = defaultReaction;
  if (typeof defaultSortOrder === 'string') data.defaultSortOrder = defaultSortOrder;
  if (typeof defaultLayout === 'string') data.defaultLayout = defaultLayout;
  if (typeof requireTags === 'boolean') data.requireTags = requireTags;
  if (typeof postSlowMode === 'number') data.postSlowMode = postSlowMode;
  if (typeof messageSlowMode === 'number') data.messageSlowMode = messageSlowMode;
  if (Object.keys(data).length === 0) {
    return res.json({
      id: channel.id,
      name: channel.name,
      description: (channel as any).description ?? undefined,
      type: channel.type,
      categoryId: (channel as any).categoryId ?? null,
      position: (channel as any).position ?? 0,
      slowMode: (channel as any).slowMode ?? 0,
      isPrivate: (channel as any).isPrivate ?? false,
      ageRestricted: (channel as any).ageRestricted ?? false,
      userLimit: (channel as any).userLimit ?? 0,
    });
  }
  const updated = await prisma.channel.update({ where: { id: channelId }, data });
  await createAuditLog(serverId, req.userId!, 'channel_update', 'channel', channelId, data).catch(() => {});
  const io = req.app.get('io');
  // When ageRestricted flips from false → true, evict minor sockets from
  // `channel:${id}` so they stop receiving live `new-message` broadcasts.
  // Auto-subscribe and `join-channel` already gate at re-entry; this closes
  // the toggle-mid-session leak. Fire-and-forget: a failure means affected
  // sockets pick up on next reconnect.
  if (
    io &&
    typeof ageRestricted === 'boolean' &&
    ageRestricted === true &&
    !(channel as { ageRestricted?: boolean }).ageRestricted
  ) {
    void evictMinorSocketsFromAgeGatedChannel({ io: io as import('socket.io').Server, channelId });
  }
  if (io) {
    const metaPayload = {
      serverId,
      channel: {
        id: channelId,
        name: updated.name,
        description: (updated as any).description ?? undefined,
        type: updated.type,
        categoryId: (updated as any).categoryId ?? null,
        position: (updated as any).position ?? 0,
        isPrivate: (updated as any).isPrivate ?? false,
        ageRestricted: (updated as any).ageRestricted ?? false,
        userLimit: (updated as any).userLimit ?? 0,
        hideAfterInactivity: (updated as any).hideAfterInactivity ?? null,
        postGuidelines: (updated as any).postGuidelines ?? null,
        defaultReaction: (updated as any).defaultReaction ?? null,
        defaultSortOrder: (updated as any).defaultSortOrder ?? 'recent_activity',
        defaultLayout: (updated as any).defaultLayout ?? 'list',
        requireTags: (updated as any).requireTags ?? false,
        postSlowMode: (updated as any).postSlowMode ?? 0,
        messageSlowMode: (updated as any).messageSlowMode ?? 0,
        slowMode: (updated as any).slowMode ?? 0,
      },
    };
    if ((updated as any).isPrivate) {
      // Private channel: scope the meta update to viewers only, so a private
      // channel's name/metadata does not broadcast to non-viewers in realtime.
      const chOvr = await prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 10000 });
      const catOvr = (updated as any).categoryId
        ? await prisma.categoryPermissionOverride.findMany({ where: { categoryId: (updated as any).categoryId }, take: 10000 })
        : [];
      await emitChannelEventToViewers({
        io,
        serverId,
        channel: { id: channelId, isPrivate: true, categoryId: (updated as any).categoryId ?? null },
        channelOverrides: chOvr,
        categoryOverrides: catOvr,
        event: 'channel-updated-meta',
        payload: metaPayload,
      });
    } else {
      io.to(`server:${serverId}`).emit('channel-updated-meta', metaPayload);
    }
  }
  res.json({
    id: updated.id,
    name: updated.name,
    description: (updated as any).description ?? undefined,
    type: updated.type,
    categoryId: (updated as any).categoryId ?? null,
    position: (updated as any).position ?? 0,
    slowMode: (updated as any).slowMode ?? 0,
    isPrivate: (updated as any).isPrivate ?? false,
    ageRestricted: (updated as any).ageRestricted ?? false,
    userLimit: (updated as any).userLimit ?? 0,
    hideAfterInactivity: (updated as any).hideAfterInactivity ?? null,
    postGuidelines: (updated as any).postGuidelines ?? null,
    defaultReaction: (updated as any).defaultReaction ?? null,
    defaultSortOrder: (updated as any).defaultSortOrder ?? 'recent_activity',
    defaultLayout: (updated as any).defaultLayout ?? 'list',
    requireTags: (updated as any).requireTags ?? false,
    postSlowMode: (updated as any).postSlowMode ?? 0,
    messageSlowMode: (updated as any).messageSlowMode ?? 0,
  });
}));

// DELETE /api/servers/:serverId/channels/:channelId – delete channel (manageChannels permission)
router.delete('/:serverId/channels/:channelId', validateUuidParams('serverId', 'channelId'), authenticateToken, serverNotSuspendedByServerId('serverId'), serverMutationLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const channelId = getParam(req, 'channelId');
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'manageChannels')) return res.status(403).json({ error: 'You need the Manage Channels permission' });
  const channel = await prisma.channel.findFirst({ where: { id: channelId, serverId } });
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const channelCount = await prisma.channel.count({ where: { serverId } });
  if (channelCount <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last channel in a server. Create another channel first.' });
  }
  // Self Roles cleanup: when deleting a role-picker channel, mark in-flight
  // RoleClaimRequest rows withdrawn so applicants get notified before the
  // cascade fires. Without this, the rows would silently disappear via the
  // RolePickerEntry → cascade chain.
  if (channel.type === 'role_picker') {
    const pendingRequests = await prisma.roleClaimRequest.findMany({
      where: {
        status: 'pending',
        entry: { category: { picker: { channelId } } },
      },
      select: { id: true, userId: true },
    });
    if (pendingRequests.length > 0) {
      await prisma.roleClaimRequest.updateMany({
        where: { id: { in: pendingRequests.map((r) => r.id) } },
        data: { status: 'withdrawn', decidedAt: new Date() },
      });
      const ioRP = req.app.get('io');
      if (ioRP) {
        for (const r of pendingRequests) {
          ioRP.to(`user:${r.userId}`).emit('role-claim-request-updated', {
            serverId, requestId: r.id, status: 'withdrawn',
          });
        }
      }
    }
  }
  // Collect attachment URLs + delete pins in parallel
  const [attachmentUrls] = await Promise.all([
    (async () => {
      const urls: string[] = [];
      let cursor: string | undefined;
      while (true) {
        const batch = await prisma.message.findMany({
          where: { channelId, attachmentUrl: { not: null } },
          select: { id: true, attachmentUrl: true },
          take: 1000,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          orderBy: { id: 'asc' },
        });
        for (const m of batch) {
          if (m.attachmentUrl) urls.push(m.attachmentUrl);
        }
        if (batch.length < 1000) break;
        cursor = batch[batch.length - 1].id;
      }
      return urls;
    })(),
    prisma.channelPinnedMessage.deleteMany({ where: { channelId } }),
  ]);
  // Delete reactions then messages via Prisma to preserve cascades
  await prisma.messageReaction.deleteMany({ where: { message: { channelId } } });
  await prisma.message.deleteMany({ where: { channelId } });
  // Now safe to delete the channel itself
  await prisma.channel.delete({ where: { id: channelId } });
  // Scrub the deleted channelId from members' acceptedAgeRestrictedChannelIds arrays.
  // Uses Prisma's tagged template to prevent SQL injection.
  await prisma.$executeRaw`
    UPDATE "ServerMember"
    SET "acceptedAgeRestrictedChannelIds" = array_remove("acceptedAgeRestrictedChannelIds", ${channelId})
    WHERE "serverId" = ${serverId}
      AND ${channelId} = ANY("acceptedAgeRestrictedChannelIds")
  `;
  await createAuditLog(serverId, req.userId!, 'channel_delete', 'channel', channelId, { name: channel.name, type: channel.type }).catch(() => {});
  const io = req.app.get('io');
  if (io) io.to(`server:${serverId}`).emit('channel-deleted', { serverId, channelId });
  res.status(204).send();
  // Fire-and-forget file cleanup from R2
  if (attachmentUrls.length > 0) {
    Promise.resolve().then(async () => {
      for (let i = 0; i < attachmentUrls.length; i += 10) {
        await Promise.all(
          attachmentUrls.slice(i, i + 10).map(url => deleteUploadedFile(url).catch(() => {}))
        );
      }
    }).catch(() => {});
  }
}));

// DELETE /api/servers/:serverId – owner deletes the server (and leaves)
router.delete('/:serverId', validateUuidParams('serverId'), authenticateToken, serverMutationLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const [serverRow, member] = await Promise.all([
    prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } }),
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      select: { userId: true, role: true },
    }),
  ]);
  if (!serverRow) return res.status(404).json({ error: 'Server not found' });
  if (!member) return res.status(403).json({ error: 'Not a member of this server' });
  // Owner-ness is the authoritative Server.ownerId; the role string is only a
  // fallback for servers that predate the column.
  const isDeleteOwner = serverRow.ownerId != null
    ? serverRow.ownerId === req.userId
    : member.role?.toLowerCase() === 'owner';
  if (!isDeleteOwner) return res.status(403).json({ error: 'Only the owner can delete the server' });

  const rawPassword = typeof req.headers['x-confirm-password'] === 'string'
    ? req.headers['x-confirm-password']
    : (req.body?.password as string | undefined);
  const password = typeof rawPassword === 'string' ? rawPassword.slice(0, 128) : undefined;
  if (!password) return res.status(400).json({ error: 'Password is required to delete a server' });
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { passwordHash: true } });
  if (!user?.passwordHash) return res.status(400).json({ error: 'Cannot verify identity' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(403).json({ error: 'Incorrect password' });

  // Collect all attachment URLs before cascade-deleting
  const serverAttachmentUrls: string[] = [];
  let saCursor: string | undefined;
  const serverChannelIds = await prisma.channel.findMany({
    where: { serverId },
    select: { id: true },
    take: 5000,
  });
  const channelIdList = serverChannelIds.map(c => c.id);
  if (channelIdList.length > 0) {
    while (true) {
      const batch = await prisma.message.findMany({
        where: { channelId: { in: channelIdList }, attachmentUrl: { not: null } },
        select: { id: true, attachmentUrl: true },
        take: 1000,
        ...(saCursor ? { skip: 1, cursor: { id: saCursor } } : {}),
        orderBy: { id: 'asc' },
      });
      for (const m of batch) {
        if (m.attachmentUrl) serverAttachmentUrls.push(m.attachmentUrl);
      }
      if (batch.length < 1000) break;
      saCursor = batch[batch.length - 1].id;
    }
  }
  const serverRecord = await prisma.server.findUnique({
    where: { id: serverId },
    select: { icon: true, banner: true },
  });
  if (serverRecord?.icon && serverRecord.icon.startsWith('/api/uploads/')) serverAttachmentUrls.push(serverRecord.icon);
  if (serverRecord?.banner && serverRecord.banner.startsWith('/api/uploads/')) serverAttachmentUrls.push(serverRecord.banner);

  // Collect uploaded URLs from emoji / sticker / soundboard rows that will
  // cascade-delete via the Server → ServerOwned relations. Without this they
  // get DB-deleted but the R2 files orphan.
  const [emojiRows, stickerRows, soundRows] = await Promise.all([
    prisma.customEmoji.findMany({ where: { serverId }, select: { imageUrl: true }, take: 5000 }),
    prisma.sticker.findMany({ where: { serverId }, select: { imageUrl: true }, take: 5000 }),
    prisma.soundboardSound.findMany({ where: { serverId }, select: { audioUrl: true }, take: 5000 }),
  ]);
  for (const e of emojiRows) if (e.imageUrl) serverAttachmentUrls.push(e.imageUrl);
  for (const s of stickerRows) if (s.imageUrl) serverAttachmentUrls.push(s.imageUrl);
  for (const s of soundRows) if (s.audioUrl) serverAttachmentUrls.push(s.audioUrl);

  // Forum post images + forum message attachments + thread message attachments
  // also live under server channels and would otherwise orphan on cascade.
  if (channelIdList.length > 0) {
    const [forumPosts, forumMsgs, threadMsgs] = await Promise.all([
      prisma.forumPost.findMany({ where: { channelId: { in: channelIdList } }, select: { imageUrl: true }, take: 5000 }),
      prisma.forumMessage.findMany({ where: { forumPost: { channelId: { in: channelIdList } }, attachmentUrl: { not: null } }, select: { attachmentUrl: true }, take: 10000 }),
      prisma.threadMessage.findMany({ where: { thread: { channelId: { in: channelIdList } }, attachmentUrl: { not: null } }, select: { attachmentUrl: true }, take: 10000 }),
    ]);
    for (const p of forumPosts) if (p.imageUrl) serverAttachmentUrls.push(p.imageUrl);
    for (const m of forumMsgs) if (m.attachmentUrl) serverAttachmentUrls.push(m.attachmentUrl);
    for (const m of threadMsgs) if (m.attachmentUrl) serverAttachmentUrls.push(m.attachmentUrl);
  }

  await prisma.server.delete({ where: { id: serverId } });

  // Notify all connected members the server has been deleted
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`server:${serverId}`).emit('server-deleted', { serverId });
    // Force all sockets to leave the server room and channel rooms
    const serverRoom = `server:${serverId}`;
    io.in(serverRoom).socketsLeave(serverRoom);
  }

  res.status(200).json({ ok: true });
  // Fire-and-forget file cleanup from R2
  if (serverAttachmentUrls.length > 0) {
    Promise.resolve().then(async () => {
      for (let i = 0; i < serverAttachmentUrls.length; i += 10) {
        await Promise.all(
          serverAttachmentUrls.slice(i, i + 10).map(url => deleteUploadedFile(url).catch(() => {}))
        );
      }
    }).catch(() => {});
  }
}));

// GET /api/servers/:serverId/members – list members with user info, role, and role style
router.get('/:serverId/members', validateUuidParams('serverId'), authenticateToken, serverReadLimiter, validate(serverMembersQuery), async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  try {
    const [member, viewerCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        select: { userId: true, role: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a member of this server' });
    const seeHidden = canSeeHiddenRoles(viewerCtx);

    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const [members, serverRoles, totalCount, memberRoles] = await Promise.all([
      prisma.serverMember.findMany({
        where: { serverId },
        include: { user: { select: { ...AUTHOR_USER_SELECT, showCurrentActivity: true, activitySharingEnabled: true, activityShareScope: true, activity: { select: ACTIVITY_PUBLIC_SELECT }, secondaryActivity: { select: SECONDARY_ACTIVITY_SELECT }, activityBio: true, shareActivityBio: true, activitySourcePriority: true } }, serverRole: true },
        take: limit,
        skip: offset,
        orderBy: { joinedAt: 'asc' },
      }),
      prisma.serverRole.findMany({ where: { serverId }, take: 250 }),
      prisma.serverMember.count({ where: { serverId } }),
      // Multi-role join table — every non-@everyone role assignment for the
      // members in this page. Indexed on (userId, serverId) already, so this
      // is a single round-trip even for large servers.
      prisma.memberRole.findMany({
        where: { serverId },
        include: { role: { select: { id: true, name: true, color: true, style: true, position: true, displaySeparately: true, isEveryone: true } } },
      }),
    ]);
    // Hidden roles (DISPLAY-only gate): non-mods must not see these in the
    // member-list payload. Mods (manageRoles/admin/owner) see everything.
    const hiddenRoleIds = new Set(serverRoles.filter((r) => r.hidden).map((r) => r.id));
    // Group per-user for O(1) lookup during the member map below.
    const rolesByUser = new Map<string, Array<{ id: string; name: string; color: string; style: string; position: number; displaySeparately: boolean }>>();
    for (const mr of memberRoles) {
      if (mr.role.isEveryone) continue;
      if (!seeHidden && hiddenRoleIds.has(mr.role.id)) continue;
      const arr = rolesByUser.get(mr.userId) ?? [];
      arr.push({ id: mr.role.id, name: mr.role.name, color: mr.role.color, style: mr.role.style, position: mr.role.position, displaySeparately: mr.role.displaySeparately });
      rolesByUser.set(mr.userId, arr);
    }
    const roleByLowerName: Record<string, { color: string; style: string }> = {};
    for (const r of serverRoles) {
      const key = r.name.toLowerCase();
      if (!roleByLowerName[key]) roleByLowerName[key] = { color: r.color, style: r.style };
    }

    // Batch presence check: resolve all user connections in parallel with a concurrency-limited approach
    const isUserConnectedAsync = req.app.get('isUserConnectedAsync') as ((userId: string) => Promise<boolean>) | undefined;
    const getBulkPresence = req.app.get('getBulkPresence') as ((userIds: string[]) => Promise<Map<string, boolean>>) | undefined;

    let presenceMap: Map<string, boolean>;
    const memberUserIds = members.map(m => m.user.id);
    if (getBulkPresence) {
      presenceMap = await getBulkPresence(memberUserIds);
    } else if (isUserConnectedAsync) {
      const results = await Promise.all(memberUserIds.map(id => isUserConnectedAsync(id).then(c => [id, c] as const)));
      presenceMap = new Map(results);
    } else {
      presenceMap = new Map(memberUserIds.map(id => [id, true]));
    }

    const memberResults = members.map((m) => {
        let roleName = m.serverRole?.name ?? m.role ?? 'member';
        let roleColorVal: string | undefined = m.serverRole?.color ?? undefined;
        let roleStyleVal: string = (m.serverRole?.style ?? 'solid') as string;
        const displayRoleHidden = !!m.serverRole && hiddenRoleIds.has(m.serverRole.id);
        if (!seeHidden && displayRoleHidden) {
          const visible = (rolesByUser.get(m.user.id) ?? []).map((r) => ({ ...r, isEveryone: false }));
          const fb = pickDisplayRole(visible);
          roleName = fb?.name ?? 'member';
          roleColorVal = fb?.color ?? undefined;
          roleStyleVal = fb?.style ?? 'solid';
        }
        const fallback = roleName ? roleByLowerName[roleName.toLowerCase()] : undefined;
        const dbStatus = (m.user.status as 'online' | 'idle' | 'dnd' | 'offline' | 'invisible') ?? 'offline';
        const connected = presenceMap.get(m.user.id) ?? false;
        return {
          id: m.user.id,
          username: m.user.username,
          discriminator: m.user.discriminator ?? null,
          avatar: m.user.avatar ?? undefined,
          banner: (m.user as { banner?: string | null }).banner ?? undefined,
          bannerPositionY: (m.user as any).bannerPositionY ?? 50,
          bannerZoom: (m.user as any).bannerZoom ?? 100,
          status: connected ? dbStatus : 'offline',
          role: roleName,
          roleColor: roleColorVal ?? fallback?.color ?? undefined,
          roleStyle: (roleStyleVal ?? fallback?.style ?? 'solid') as string,
          // Multi-role: full non-@everyone role list used by Server Settings
          // → Roles → Members-in-role filter. Without this the UI can only
          // filter by the single display role and members with secondary
          // role assignments that aren't their highest are invisible.
          roles: rolesByUser.get(m.user.id) ?? [],
          memberSince: m.joinedAt.toISOString(),
          joinedPlatform: (m.user as any).showJoinDate !== false ? m.user.createdAt.toISOString() : undefined,
          joinMethod: 'Unknown',
          nickname: m.nickname ?? null,
          serverAvatar: m.serverAvatar ?? null,
          serverBanner: m.serverBanner ?? null,
          nameFont: (m.user as any).nameFont ?? null,
          nameEffect: (m.user as any).nameEffect ?? null,
          nameColor: (m.user as any).nameColor ?? null,
          avatarEffect: (m.user as any).avatarEffect ?? null,
          stripePlan: (m.user as any).stripePlan ?? null,
          effectivePlan: getEffectivePlan(m.user as any),
          activityBio: (connected && dbStatus !== 'invisible') ? ((m.user as any).shareActivityBio !== false ? ((m.user as any).activityBio || null) : null) : null,
          badges: applyBadgePrefs(m.user as any),
          activity: (() => {
            const userAny = m.user as any;
            if (userAny.activitySharingEnabled === false || userAny.showCurrentActivity === 'nobody') return undefined;
            const memberStatus = connected ? dbStatus : 'offline';
            if (memberStatus === 'offline' || memberStatus === 'invisible') return undefined;
            const perServer = m.shareActivity;
            const scope: string = userAny.activityShareScope || 'everyone';
            const checkServerVisibility = () => {
              if (perServer === false) return false;
              return scope === 'everyone'
                || (scope === 'friends_small_servers' && totalCount <= 200)
                || perServer === true;
            };
            if (!checkServerVisibility()) return undefined;
            const winner = resolveActivityWinner(userAny.activity, userAny.activityBio, userAny.shareActivityBio, userAny.activitySourcePriority);
            if (winner === 'activity' && userAny.activity) {
              const a = userAny.activity;
              return {
                type: a.type, name: a.name, details: a.details ?? undefined,
                state: a.state ?? undefined, largeImage: a.largeImage ?? undefined,
                smallImage: a.smallImage ?? undefined, startedAt: a.startedAt.toISOString(),
                platformId: a.platformId ?? undefined, platform: a.platform ?? undefined,
                durationMs: a.durationMs ?? undefined,
              };
            }
            if (winner === 'bio' && userAny.activityBio) {
              return { type: 'bio' as const, name: userAny.activityBio, startedAt: new Date().toISOString() };
            }
            return undefined;
          })(),
          secondaryActivity: (() => {
            const userAny = m.user as any;
            if (userAny.activitySharingEnabled === false || userAny.showCurrentActivity === 'nobody') return undefined;
            const memberStatus2 = connected ? dbStatus : 'offline';
            if (memberStatus2 === 'offline' || memberStatus2 === 'invisible') return undefined;
            const perServer = m.shareActivity;
            const scope: string = userAny.activityShareScope || 'everyone';
            const checkServerVisibility = () => {
              if (perServer === false) return false;
              return scope === 'everyone'
                || (scope === 'friends_small_servers' && totalCount <= 200)
                || perServer === true;
            };
            if (!checkServerVisibility()) return undefined;
            if (!userAny.secondaryActivity) return undefined;
            const a = userAny.secondaryActivity;
            return {
              type: a.type, name: a.name, details: a.details ?? undefined,
              state: a.state ?? undefined, largeImage: a.largeImage ?? undefined,
              smallImage: a.smallImage ?? undefined, startedAt: a.startedAt.toISOString(),
              platformId: a.platformId ?? undefined, platform: a.platform ?? undefined,
              durationMs: a.durationMs ?? undefined,
            };
          })(),
        };
      });
    res.json({ members: memberResults, total: totalCount, hasMore: offset + limit < totalCount });
  } catch (err) {
    log.error({ err }, 'GET /api/servers/:serverId/members error');
    next(err);
  }
});

// DELETE /api/servers/:serverId/members/:userId – kick member (kickMembers permission)
router.delete('/:serverId/members/:userId', validateUuidParams('serverId', 'userId'), authenticateToken, serverMutationLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const targetUserId = getParam(req, 'userId');
  const [actorCtx, targetCtx] = await Promise.all([
    loadPermissionContext(req.userId, serverId),
    loadPermissionContext(targetUserId, serverId),
  ]);
  if (!actorCtx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(actorCtx, 'kickMembers')) return res.status(403).json({ error: 'You need the Kick Members permission' });
  if (!targetCtx) return res.status(404).json({ error: 'User is not a member of this server' });
  if (targetCtx.member.role?.toLowerCase() === 'owner') return res.status(400).json({ error: 'Cannot kick the server owner' });

  const actorPosition = effectivePosition(actorCtx);
  const targetPosition = effectivePosition(targetCtx);
  if (actorCtx.member.role?.toLowerCase() !== 'owner' && targetPosition <= actorPosition) {
    return res.status(403).json({ error: 'You cannot kick a member whose role is at or above your own' });
  }

  await prisma.serverMember.delete({
    where: { userId_serverId: { userId: targetUserId, serverId } },
  });
  await invalidatePermissionContext(serverId, targetUserId);
  await createAuditLog(serverId, req.userId!, 'member_kick', 'user', targetUserId).catch(() => {});

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`server:${serverId}`).emit('server-member-left', { serverId, userId: targetUserId, kicked: true });
    io.to(`user:${targetUserId}`).emit('server-kicked', { serverId });

    const sockets = await io.in(`user:${targetUserId}`).fetchSockets();
    const serverChannels = await prisma.channel.findMany({ where: { serverId }, select: { id: true }, take: 500 });
    const roomsToLeave = [`server:${serverId}`, ...serverChannels.map(c => `channel:${c.id}`), ...serverChannels.map(c => `voice:${c.id}`)];
    for (const s of sockets) {
      for (const room of roomsToLeave) s.leave(room);
    }
    // Clean up voice state in Redis
    const voiceChannelId = await findUserVoiceChannel(targetUserId);
    if (voiceChannelId) {
      const voiceChannel = serverChannels.find(c => c.id === voiceChannelId);
      if (voiceChannel) {
        await removeVoiceParticipant(voiceChannelId, targetUserId);
        await setVoiceReverseLookup(targetUserId, null);
        await deleteVoiceOverride(voiceChannelId, targetUserId);
        io.to(`voice:${voiceChannelId}`).emit('voice-user-left', { userId: targetUserId });
        const participants = await getVoiceParticipants(voiceChannelId);
        io.to(`server:${serverId}`).emit('server-voice-participants', {
          serverId, channelId: voiceChannelId, participants,
        });
        // Forward secrecy at the kick boundary: rotate the SFrame key so
        // the kicked member's retained key no longer protects subsequent media.
        scheduleVoiceE2eeRotate(io, voiceChannelId, participants.length > 0);
        // Drop the kicked user from the LiveKit SFU so a
        // cached JWT cannot keep publishing audio after the kick.
        removeLiveKitParticipant(`voice:${voiceChannelId}`, targetUserId).catch(() => {});
      }
    }

    // Also drop the kicked user from any stage SFU room + sets so a
    // cached LiveKit JWT cannot keep publishing audio after the kick.
    await evictUserFromServerStages(io, targetUserId, serverId).catch(() => {});

    // server-kicked already carries the removal signal for the client
  }

  res.status(200).json({ ok: true });
}));

// GET /api/servers/:serverId/members/@me/profile – get own server profile
router.get('/:serverId/members/@me/profile', validateUuidParams('serverId'), authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const member = await prisma.serverMember.findUnique({
    where: { userId_serverId: { userId: req.userId, serverId } },
  });
  if (!member) return res.status(403).json({ error: 'Not a member of this server' });
  res.json({
    nickname: member.nickname ?? null,
    serverAvatar: member.serverAvatar ?? null,
    serverBanner: member.serverBanner ?? null,
    onboardingCompletedAt: member.onboardingCompletedAt?.toISOString() ?? null,
  });
}));

// PATCH /api/servers/:serverId/members/@me/profile – update own server profile (nickname, avatar, banner)
router.patch('/:serverId/members/@me/profile', validateUuidParams('serverId'), authenticateToken, serverMutationLimiter, validate(updateServerProfileSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });

  const { nickname, serverAvatar, serverBanner } = req.body as {
    nickname?: string | null;
    serverAvatar?: string | null;
    serverBanner?: string | null;
  };

  const data: Record<string, string | null> = {};
  if (nickname !== undefined) {
    if (!hasPermission(ctx, 'changeNickname')) {
      return res.status(403).json({ error: 'You do not have permission to change your nickname in this server.' });
    }
    if (nickname !== null && (nickname.length < 1 || nickname.length > 32)) {
      return res.status(400).json({ error: 'Nickname must be 1-32 characters' });
    }
    if (nickname && containsProfanity(nickname)) {
      return res.status(400).json({ error: 'This nickname contains prohibited language' });
    }
    if (nickname) {
      const settings = await prisma.serverSettings.findUnique({ where: { serverId }, select: { blockedNicknames: true } });
      const blocked = Array.isArray(settings?.blockedNicknames) ? (settings.blockedNicknames as string[]) : [];
      const lowerNick = nickname.toLowerCase();
      if (blocked.some(b => lowerNick.includes(b.toLowerCase()))) {
        return res.status(400).json({ error: 'This nickname is not allowed in this server' });
      }
    }
    data.nickname = nickname;
  }
  if (serverAvatar !== undefined) {
    const avatarVal = serverAvatar ? (toRelativeUploadUrl(serverAvatar) ?? serverAvatar) : serverAvatar;
    if (avatarVal && !isAllowedImageUrl(avatarVal)) {
      return res.status(400).json({ error: 'Only PNG, JPG, and GIF files are allowed for avatars.' });
    }
    data.serverAvatar = avatarVal ?? null;
  }
  if (serverBanner !== undefined) {
    const bannerVal = serverBanner ? (toRelativeUploadUrl(serverBanner) ?? serverBanner) : serverBanner;
    if (bannerVal && !isAllowedImageUrl(bannerVal)) {
      return res.status(400).json({ error: 'Only PNG, JPG, and GIF files are allowed for banners.' });
    }
    data.serverBanner = bannerVal ?? null;
  }

  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No fields to update' });

  const updated = await prisma.serverMember.update({
    where: { userId_serverId: { userId: req.userId, serverId } },
    data,
  });
  await invalidatePermissionContext(serverId, req.userId);

  const payload = {
    userId: req.userId,
    serverId,
    nickname: updated.nickname ?? null,
    serverAvatar: updated.serverAvatar ?? null,
    serverBanner: updated.serverBanner ?? null,
  };

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) io.to(`server:${serverId}`).emit('server-member-profile-updated', payload);

  res.json(payload);
}));

// PATCH /api/servers/:serverId/members/@me/onboarding – mark onboarding complete (idempotent)
router.patch('/:serverId/members/@me/onboarding', validateUuidParams('serverId'), authenticateToken, serverMutationLimiter, validate(completeServerOnboardingSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const member = await prisma.serverMember.findUnique({ where: { userId_serverId: { userId: req.userId, serverId } }, select: { onboardingCompletedAt: true } });
  if (!member) return res.status(403).json({ error: 'Not a member of this server' });
  const stamp = member.onboardingCompletedAt ?? new Date();
  if (!member.onboardingCompletedAt) await prisma.serverMember.update({ where: { userId_serverId: { userId: req.userId, serverId } }, data: { onboardingCompletedAt: stamp } });
  res.json({ onboardingCompletedAt: stamp.toISOString() });
}));

// GET /api/servers/:serverId/members/:userId/mod-view – mod view data for a member
router.get('/:serverId/members/:userId/mod-view', validateUuidParams('serverId', 'userId'), authenticateToken, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const targetUserId = getParam(req, 'userId');
  const [ctx, target, serverRoles, channelsRaw] = await Promise.all([
    loadPermissionContext(req.userId, serverId),
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: targetUserId, serverId } },
      include: { user: { select: PUBLIC_USER_SELECT }, serverRole: true },
    }),
    prisma.serverRole.findMany({
      where: { serverId },
      orderBy: { position: 'asc' },
      take: 250,
    }),
    prisma.channel.findMany({ where: { serverId }, select: { id: true }, take: 500 }),
  ]);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'viewAuditLog') && !hasPermission(ctx, 'kickMembers') && !hasPermission(ctx, 'banMembers') && !hasPermission(ctx, 'manageServer')) {
    return res.status(403).json({ error: 'You need moderation permissions to view this data' });
  }
  if (!target) return res.status(404).json({ error: 'User is not a member of this server' });
  const roleByLowerName: Record<string, { color: string; style: string; permissions: Record<string, boolean> }> = {};
  for (const r of serverRoles) {
    const key = r.name.toLowerCase();
    if (!roleByLowerName[key]) roleByLowerName[key] = { color: r.color, style: r.style, permissions: (r.permissions as Record<string, boolean>) ?? {} };
  }
  const channelIds = channelsRaw.map((c) => c.id);
  const [messageCount, messagesSample] = await Promise.all([
    channelIds.length
      ? prisma.message.count({ where: { channelId: { in: channelIds }, authorId: targetUserId } })
      : 0,
    channelIds.length
      ? prisma.message.findMany({ where: { channelId: { in: channelIds }, authorId: targetUserId }, take: 500, select: { content: true } })
      : [],
  ]);
  const linkRegex = /https?:\/\/[^\s]+/gi;
  let linksCount = 0;
  for (const msg of messagesSample) {
    const matches = msg.content.match(linkRegex);
    if (matches) linksCount += matches.length;
  }
  const roleName = target.serverRole?.name ?? target.role;
  const permSet = roleByLowerName[roleName?.toLowerCase() ?? '']?.permissions ?? {};
  const allPermissionIds = [
    'viewChannels', 'manageChannels', 'manageRoles', 'createExpressions', 'manageExpressions', 'viewAuditLog',
    'manageWebhooks', 'manageServer', 'createInvite', 'changeNickname', 'manageNicknames', 'kickMembers', 'banMembers', 'timeoutMembers',
    'sendMessages', 'sendMessagesInThreads', 'embedLinks', 'attachFiles', 'addReactions', 'mentionEveryone', 'manageMessages', 'readMessageHistory',
    'connect', 'speak', 'video', 'useVoiceActivity', 'muteMembers', 'moveMembers', 'administrator',
  ];
  const modPermissions = allPermissionIds.filter((id) => permSet[id]);
  res.json({
    id: target.user.id,
    username: target.user.username,
    discriminator: target.user.discriminator,
    avatar: target.user.avatar ?? undefined,
    role: roleName,
    roleColor: target.serverRole?.color ?? roleByLowerName[roleName?.toLowerCase() ?? '']?.color,
    roleStyle: target.serverRole?.style ?? roleByLowerName[roleName?.toLowerCase() ?? '']?.style ?? 'solid',
    memberSince: target.joinedAt.toISOString(),
    joinedPlatform: (target.user as any).showJoinDate !== false ? target.user.createdAt.toISOString() : undefined,
    joinMethod: 'Unknown',
    messageCount,
    linksCount,
    mediaCount: 0,
    roles: target.serverRole ? [{ name: target.serverRole.name, color: target.serverRole.color }] : (roleName ? [{ name: roleName, color: roleByLowerName[roleName.toLowerCase()]?.color ?? '#99aab5' }] : []),
    modPermissions,
    passedVerification: true,
  });
}));

// POST /api/servers/:serverId/channels – create channel (manageChannels permission)
router.post('/:serverId/channels', validateUuidParams('serverId'), authenticateToken, serverNotSuspendedByServerId('serverId'), serverMutationLimiter, validate(createChannelSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const { name, type, isPrivate: isPrivateBody } = req.body as { name?: string; type?: string; isPrivate?: boolean };
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'manageChannels')) return res.status(403).json({ error: 'You need the Manage Channels permission' });
  const channelCount = await prisma.channel.count({ where: { serverId } });
  if (channelCount >= MAX_CHANNELS_PER_SERVER) {
    return res.status(403).json({ error: `This server has reached the maximum of ${MAX_CHANNELS_PER_SERVER} channels.` });
  }
  // Spaces and mixed case are allowed in channel names (e.g. "Off topic",
  // "Movie Nights"). Only outer whitespace gets trimmed.
  const channelName = typeof name === 'string' && name.trim() ? name.trim() : 'new-channel';
  const VALID_TYPES = ['text', 'voice', 'stage', 'forum', 'role_picker'] as const;
  const channelType = VALID_TYPES.includes(type as any) ? (type as string) : 'text';
  const categoryId = (req.body as { categoryId?: string | null }).categoryId ?? null;
  if (categoryId) {
    const cat = await prisma.channelCategory.findFirst({ where: { id: categoryId, serverId } });
    if (!cat) return res.status(400).json({ error: 'Category not found in this server' });
  }
  // One-picker-per-server enforcement: pre-check before create. The schema
  // unique on RolePickerChannel.serverId is the defense in depth (catches a
  // race), but a clean 409 with the existing channel id is the better UX.
  if (channelType === 'role_picker') {
    const existing = await prisma.rolePickerChannel.findUnique({
      where: { serverId },
      select: { channelId: true },
    });
    if (existing) {
      return res.status(409).json({
        error: 'A role picker already exists in this server',
        existingChannelId: existing.channelId,
      });
    }
  }
  const maxPos = await prisma.channel.aggregate({
    where: { serverId, categoryId },
    _max: { position: true },
  });
  const position = (maxPos._max.position ?? -1) + 1;
  const channel = await prisma.channel.create({
    data: { serverId, name: channelName, type: channelType, categoryId, position, isPrivate: isPrivateBody === true },
  });
  // Auto-create the RolePickerChannel row that backs the picker channel. If
  // a race slipped past the pre-check above, the unique constraint on
  // serverId fires P2002 — roll back the channel create to keep the server
  // state consistent.
  if (channel.type === 'role_picker') {
    try {
      await prisma.rolePickerChannel.create({
        data: {
          channelId: channel.id,
          serverId: channel.serverId,
          heroTitle: 'Pick the roles that fit you',
          heroDescription: 'Roles control how you appear in the member list and which announcements ping you. Toggle any time — your changes apply instantly.',
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        await prisma.channel.delete({ where: { id: channel.id } }).catch(() => {});
        return res.status(409).json({ error: 'A role picker already exists in this server' });
      }
      throw e;
    }
  }
  await createAuditLog(serverId, req.userId!, 'channel_create', 'channel', channel.id, { name: channel.name, type: channel.type }).catch(() => {});
  const channelPayload = {
    id: channel.id,
    name: channel.name,
    description: (channel as any).description ?? undefined,
    type: channel.type,
    categoryId: (channel as any).categoryId ?? null,
    position: (channel as any).position ?? 0,
    isPrivate: (channel as any).isPrivate ?? false,
  };
  const io = req.app.get('io');
  if (io) {
    // Auto-subscribe currently-connected server members to the new channel
    // via the full server-level + category + channel override chain.
    //
    // We cannot bulk `io.in('server:${serverId}').socketsJoin(...)` even when
    // the channel has no category overrides: the server room is admitted
    // unconditionally for non-banned ServerMembers (see
    // socketHandlers/channels.ts join-server handler and
    // socketHandlers/connection.ts auto-subscribe), but `join-channel`
    // additionally gates on viewChannels + readMessageHistory. Servers that
    // deny readMessageHistory at @everyone and grant it via a Staff role
    // would otherwise leak plaintext new-message broadcasts to non-privileged
    // members through the bulk socketsJoin.
    if (!channelPayload.isPrivate) {
      const catOvrs = channelPayload.categoryId
        ? await prisma.categoryPermissionOverride.findMany({
            where: { categoryId: channelPayload.categoryId },
            take: 1000,
          })
        : [];
      await autoJoinVisibleServerMembers({
        io,
        serverId,
        channelId: channel.id,
        categoryOverrides: catOvrs,
      });
      io.to(`server:${serverId}`).emit('channel-created', { serverId, channel: channelPayload });
    } else {
      // Private channel: its existence/name must NOT broadcast to the whole
      // server room (that would leak it to non-viewers in realtime, even though
      // the GET read path already filters private channels out). Scope
      // `channel-created` to members who can view it — owner/admins plus any
      // category-override holders; a freshly-created private channel has no
      // channel-level overrides yet, so pass [].
      const catOvrs = channelPayload.categoryId
        ? await prisma.categoryPermissionOverride.findMany({
            where: { categoryId: channelPayload.categoryId },
            take: 1000,
          })
        : [];
      await emitChannelEventToViewers({
        io,
        serverId,
        channel: { id: channel.id, isPrivate: true, categoryId: channelPayload.categoryId },
        channelOverrides: [],
        categoryOverrides: catOvrs,
        event: 'channel-created',
        payload: { serverId, channel: channelPayload },
      });
    }
  }
  res.status(201).json(channelPayload);
}));

// POST /api/servers/:serverId/categories – create category (manageChannels permission)
router.post('/:serverId/categories', validateUuidParams('serverId'), authenticateToken, serverNotSuspendedByServerId('serverId'), serverMutationLimiter, validate(createCategorySchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const { name } = req.body as { name: string };
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'manageChannels')) return res.status(403).json({ error: 'You need the Manage Channels permission' });
  const categoryCount = await prisma.channelCategory.count({ where: { serverId } });
  if (categoryCount >= MAX_CATEGORIES_PER_SERVER) {
    return res.status(403).json({ error: `This server has reached the maximum of ${MAX_CATEGORIES_PER_SERVER} categories.` });
  }
  const maxPos = await prisma.channelCategory.aggregate({ where: { serverId }, _max: { position: true } });
  const position = (maxPos._max.position ?? -1) + 1;
  const category = await prisma.channelCategory.create({
    data: { serverId, name: name.trim(), position },
  });
  await createAuditLog(serverId, req.userId, 'category_create', 'category', category.id, { name: category.name }).catch(() => {});
  const io = req.app.get('io');
  if (io) io.to(`server:${serverId}`).emit('category-created', { serverId, category: { id: category.id, name: category.name, position: category.position } });
  res.status(201).json({ id: category.id, name: category.name, position: category.position });
}));

// PATCH /api/servers/:serverId/categories/:categoryId – update category (manageChannels permission)
router.patch('/:serverId/categories/:categoryId', validateUuidParams('serverId', 'categoryId'), authenticateToken, serverNotSuspendedByServerId('serverId'), serverMutationLimiter, validate(updateCategorySchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const categoryId = getParam(req, 'categoryId');
  const [ctx, category] = await Promise.all([
    loadPermissionContext(req.userId, serverId),
    prisma.channelCategory.findFirst({ where: { id: categoryId, serverId } }),
  ]);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'manageChannels')) return res.status(403).json({ error: 'You need the Manage Channels permission' });
  if (!category) return res.status(404).json({ error: 'Category not found' });
  const data: Record<string, unknown> = {};
  if (req.body.name !== undefined) data.name = req.body.name;
  if (req.body.position !== undefined) data.position = req.body.position;
  if (typeof req.body.isPrivate === 'boolean') data.isPrivate = req.body.isPrivate;
  if (Object.keys(data).length === 0) return res.json({ id: category.id, name: category.name, position: category.position, isPrivate: (category as any).isPrivate ?? false });
  const updated = await prisma.channelCategory.update({ where: { id: categoryId }, data });
  await createAuditLog(serverId, req.userId, 'category_update', 'category', categoryId, data).catch(() => {});
  const io = req.app.get('io');
  if (io) io.to(`server:${serverId}`).emit('category-updated', { serverId, category: { id: updated.id, name: updated.name, position: updated.position, isPrivate: (updated as any).isPrivate ?? false } });
  res.json({ id: updated.id, name: updated.name, position: updated.position, isPrivate: (updated as any).isPrivate ?? false });
}));

// DELETE /api/servers/:serverId/categories/:categoryId – delete category (channels become uncategorized via onDelete: SetNull)
router.delete('/:serverId/categories/:categoryId', validateUuidParams('serverId', 'categoryId'), authenticateToken, serverNotSuspendedByServerId('serverId'), serverMutationLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const categoryId = getParam(req, 'categoryId');
  const [ctx, category] = await Promise.all([
    loadPermissionContext(req.userId, serverId),
    prisma.channelCategory.findFirst({ where: { id: categoryId, serverId } }),
  ]);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'manageChannels')) return res.status(403).json({ error: 'You need the Manage Channels permission' });
  if (!category) return res.status(404).json({ error: 'Category not found' });
  await prisma.channelCategory.delete({ where: { id: categoryId } });
  await createAuditLog(serverId, req.userId, 'category_delete', 'category', categoryId, { name: category.name }).catch(() => {});
  const io = req.app.get('io');
  if (io) io.to(`server:${serverId}`).emit('category-deleted', { serverId, categoryId });
  res.json({ success: true });
}));

// PUT /api/servers/:serverId/channels/reorder – bulk reorder channels (manageChannels permission)
router.put('/:serverId/channels/reorder', validateUuidParams('serverId'), authenticateToken, serverNotSuspendedByServerId('serverId'), serverMutationLimiter, validate(reorderChannelsSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const { channels } = req.body as { channels: Array<{ id: string; position: number; categoryId: string | null }> };
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'manageChannels')) return res.status(403).json({ error: 'You need the Manage Channels permission' });
  // Verify all channel IDs belong to this server
  const serverChannels = await prisma.channel.findMany({ where: { serverId }, select: { id: true }, take: MAX_CHANNELS_PER_SERVER });
  const serverChannelIds = new Set(serverChannels.map((c: { id: string }) => c.id));
  for (const ch of channels) {
    if (!serverChannelIds.has(ch.id)) return res.status(400).json({ error: `Channel ${ch.id} not found in this server` });
  }
  // Verify all non-null categoryIds belong to this server
  const nonNullCategoryIds = [...new Set(channels.filter(c => c.categoryId).map(c => c.categoryId!))];
  if (nonNullCategoryIds.length > 0) {
    const serverCategories = await prisma.channelCategory.findMany({
      where: { serverId, id: { in: nonNullCategoryIds } },
      select: { id: true },
      take: MAX_CATEGORIES_PER_SERVER,
    });
    const serverCategoryIds = new Set(serverCategories.map((c: { id: string }) => c.id));
    for (const catId of nonNullCategoryIds) {
      if (!serverCategoryIds.has(catId)) return res.status(400).json({ error: `Category ${catId} not found in this server` });
    }
  }
  await prisma.$transaction(async (tx) => {
    for (const ch of channels) {
      await tx.channel.update({
        where: { id: ch.id },
        data: { position: ch.position, categoryId: ch.categoryId },
      });
    }
  }, { isolationLevel: 'Serializable' });
  const io = req.app.get('io');
  if (io) io.to(`server:${serverId}`).emit('channels-reordered', { serverId, channels: channels.map(c => ({ id: c.id, position: c.position, categoryId: c.categoryId })) });
  res.json({ success: true });
}));

// PUT /api/servers/:serverId/categories/reorder – bulk reorder categories (manageChannels permission)
router.put('/:serverId/categories/reorder', validateUuidParams('serverId'), authenticateToken, serverNotSuspendedByServerId('serverId'), serverMutationLimiter, validate(reorderCategoriesSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const { categories } = req.body as { categories: Array<{ id: string; position: number }> };
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(ctx, 'manageChannels')) return res.status(403).json({ error: 'You need the Manage Channels permission' });
  const serverCategories = await prisma.channelCategory.findMany({ where: { serverId }, select: { id: true }, take: MAX_CATEGORIES_PER_SERVER });
  const serverCategoryIds = new Set(serverCategories.map((c: { id: string }) => c.id));
  for (const cat of categories) {
    if (!serverCategoryIds.has(cat.id)) return res.status(400).json({ error: `Category ${cat.id} not found in this server` });
  }
  await prisma.$transaction(
    categories.map(cat => prisma.channelCategory.update({
      where: { id: cat.id },
      data: { position: cat.position },
    }))
  );
  const io = req.app.get('io');
  if (io) io.to(`server:${serverId}`).emit('categories-reordered', { serverId, categories });
  res.json({ success: true });
}));

// Member Timeout

// POST /api/servers/:serverId/members/:userId/timeout – apply a timeout
router.post('/:serverId/members/:userId/timeout', validateUuidParams('serverId', 'userId'), authenticateToken, serverMutationLimiter, validate(timeoutMemberSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const targetUserId = getParam(req, 'userId');
  if (targetUserId === req.userId) return res.status(400).json({ error: 'You cannot timeout yourself' });

  const [actorCtx, targetCtx] = await Promise.all([
    loadPermissionContext(req.userId, serverId),
    loadPermissionContext(targetUserId, serverId),
  ]);
  if (!actorCtx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(actorCtx, 'timeoutMembers')) return res.status(403).json({ error: 'You need the Timeout Members permission' });
  if (!targetCtx) return res.status(404).json({ error: 'User is not a member of this server' });
  if (targetCtx.member.role?.toLowerCase() === 'owner') return res.status(400).json({ error: 'Cannot timeout the server owner' });

  // Role hierarchy: LOWER position = HIGHER authority. Block
  // when target's effective position is <= actor's (target equal-or-higher).
  // Use multi-role effectivePosition (min across all assigned roles) with
  // `Infinity` fallback so a role-less member is treated as @everyone tier,
  // not as Owner (pos 0).
  if (actorCtx.member.role?.toLowerCase() !== 'owner') {
    const actorPos = effectivePosition(actorCtx);
    const targetPos = effectivePosition(targetCtx);
    if (targetPos <= actorPos) {
      return res.status(403).json({ error: 'You cannot timeout a member whose role is at or above your own' });
    }
  }

  const { durationSeconds, reason } = req.body as { durationSeconds: number; reason?: string };
  const timeoutUntil = new Date(Date.now() + durationSeconds * 1000);

  await prisma.serverMember.update({
    where: { userId_serverId: { userId: targetUserId, serverId } },
    data: { timeoutUntil, timeoutReason: reason ?? null, timedOutById: req.userId },
  });
  await invalidatePermissionContext(serverId, targetUserId);

  await createAuditLog(serverId, req.userId, 'member_timeout', 'user', targetUserId, {
    durationSeconds,
    reason: reason ?? null,
    timeoutUntil: timeoutUntil.toISOString(),
  }).catch(() => {});

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`server:${serverId}`).emit('member-timeout-applied', {
      serverId,
      userId: targetUserId,
      timeoutUntil: timeoutUntil.toISOString(),
      reason: reason ?? null,
      byUserId: req.userId,
    });

    // Kick from voice if currently connected
    const voiceChannelId = await findUserVoiceChannel(targetUserId);
    if (voiceChannelId) {
      const voiceChannel = await prisma.channel.findUnique({ where: { id: voiceChannelId }, select: { serverId: true } });
      if (voiceChannel?.serverId === serverId) {
        await removeVoiceParticipant(voiceChannelId, targetUserId);
        await setVoiceReverseLookup(targetUserId, null);
        await deleteVoiceOverride(voiceChannelId, targetUserId);
        io.to(`voice:${voiceChannelId}`).emit('voice-user-left', { userId: targetUserId });
        io.to(`user:${targetUserId}`).emit('voice-auto-disconnected', { channelId: voiceChannelId });
        const participants = await getVoiceParticipants(voiceChannelId);
        io.to(`server:${serverId}`).emit('server-voice-participants', {
          serverId, channelId: voiceChannelId, participants,
        });
        // Forward secrecy at the timeout boundary: rotate the SFrame key
        // so the timed-out member's retained key no longer protects later media.
        scheduleVoiceE2eeRotate(io, voiceChannelId, participants.length > 0);
        // Drop the timed-out user from the LiveKit SFU so a
        // cached JWT cannot keep publishing audio during the timeout window.
        removeLiveKitParticipant(`voice:${voiceChannelId}`, targetUserId).catch(() => {});
      }
    }

    // Also drop the timed-out user from any stage SFU room + sets so a
    // cached LiveKit JWT cannot keep publishing audio during the timeout window.
    await evictUserFromServerStages(io, targetUserId, serverId).catch(() => {});
  }

  log.info({ serverId, targetUserId, actorId: req.userId, durationSeconds, timeoutUntil: timeoutUntil.toISOString() }, 'member timeout applied');
  res.json({ timeoutUntil: timeoutUntil.toISOString() });
}));

// DELETE /api/servers/:serverId/members/:userId/timeout – remove a timeout
router.delete('/:serverId/members/:userId/timeout', validateUuidParams('serverId', 'userId'), authenticateToken, serverMutationLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const targetUserId = getParam(req, 'userId');

  const actorCtx = await loadPermissionContext(req.userId, serverId);
  if (!actorCtx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(actorCtx, 'timeoutMembers')) return res.status(403).json({ error: 'You need the Timeout Members permission' });

  const target = await prisma.serverMember.findUnique({
    where: { userId_serverId: { userId: targetUserId, serverId } },
  });
  if (!target) return res.status(404).json({ error: 'User is not a member of this server' });

  await prisma.serverMember.update({
    where: { userId_serverId: { userId: targetUserId, serverId } },
    data: { timeoutUntil: null, timeoutReason: null, timedOutById: null },
  });
  await invalidatePermissionContext(serverId, targetUserId);

  await createAuditLog(serverId, req.userId, 'member_timeout_clear', 'user', targetUserId).catch(() => {});

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`server:${serverId}`).emit('member-timeout-cleared', {
      serverId,
      userId: targetUserId,
      byUserId: req.userId,
    });
  }

  log.info({ serverId, targetUserId, actorId: req.userId }, 'member timeout cleared');
  res.json({ ok: true });
}));

// Manage Nicknames

// PATCH /api/servers/:serverId/members/:userId/nickname – moderator nickname change
router.patch('/:serverId/members/:userId/nickname', validateUuidParams('serverId', 'userId'), authenticateToken, serverMutationLimiter, validate(manageNicknameSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const targetUserId = getParam(req, 'userId');

  const [actorCtx, targetCtx] = await Promise.all([
    loadPermissionContext(req.userId, serverId),
    loadPermissionContext(targetUserId, serverId),
  ]);
  if (!actorCtx) return res.status(403).json({ error: 'Not a member of this server' });
  if (!hasPermission(actorCtx, 'manageNicknames')) return res.status(403).json({ error: 'You need the Manage Nicknames permission' });
  if (!targetCtx) return res.status(404).json({ error: 'User is not a member of this server' });
  if (targetCtx.member.role?.toLowerCase() === 'owner') return res.status(400).json({ error: 'Cannot change the server owner\'s nickname' });

  // Role hierarchy: see timeout handler for rationale.
  if (actorCtx.member.role?.toLowerCase() !== 'owner') {
    const actorPos = effectivePosition(actorCtx);
    const targetPos = effectivePosition(targetCtx);
    if (targetPos <= actorPos) {
      return res.status(403).json({ error: 'You cannot change the nickname of a member whose role is at or above your own' });
    }
  }

  const { nickname } = req.body as { nickname: string | null };

  // Validate against profanity and blocked nicknames (same rules as self-edit)
  if (nickname !== null) {
    if (containsProfanity(nickname)) {
      return res.status(400).json({ error: 'This nickname contains prohibited language' });
    }
    const settings = await prisma.serverSettings.findUnique({ where: { serverId }, select: { blockedNicknames: true } });
    const blocked = Array.isArray(settings?.blockedNicknames) ? (settings.blockedNicknames as string[]) : [];
    const lowerNick = nickname.toLowerCase();
    if (blocked.some(b => lowerNick.includes(b.toLowerCase()))) {
      return res.status(400).json({ error: 'This nickname is not allowed in this server' });
    }
  }

  const updated = await prisma.serverMember.update({
    where: { userId_serverId: { userId: targetUserId, serverId } },
    data: { nickname },
  });
  await invalidatePermissionContext(serverId, targetUserId);

  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    io.to(`server:${serverId}`).emit('member-nickname-changed', {
      serverId,
      userId: targetUserId,
      nickname: updated.nickname ?? null,
    });
  }

  log.info({ serverId, targetUserId, actorId: req.userId, nickname: updated.nickname ?? null }, 'member nickname changed by moderator');
  res.json({ nickname: updated.nickname ?? null });
}));

router.use('/', serverRoleRoutes);
router.use('/', serverInviteRoutes);

export default router;
