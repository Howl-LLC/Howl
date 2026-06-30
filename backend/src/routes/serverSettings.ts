// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { serverNotSuspendedByServerId } from '../middleware/serverNotSuspended.js';
import { getParam, hasPermission, loadPermissionContext, effectivePosition, isSafeExternalUrl } from '../utils.js';
import { validate } from '../middleware/validate.js';
import { updateServerSettingsSchema, createBanSchema, auditLogQuery, createEmojiSchema, createStickerSchema, createSoundboardSchema, createAutomodSchema, updateAutomodSchema, createTemplateSchema, updateTemplateSchema, updateAutoRolesSchema } from '../schemas.js';
import { invalidateAutomodCache } from './messages.js';
import {
  getDiscoveryEligibility,
  invalidateDiscoveryEligibility,
} from '../services/discoveryEligibilityCache.js';
import { logger } from '../logger.js';
import { deleteUploadedFile } from './upload.js';
import { getUploadedFileSize } from './upload.js';
import {
  findUserVoiceChannel, removeVoiceParticipant, setVoiceReverseLookup,
  deleteVoiceOverride, getVoiceParticipants,
  invalidatePermissionContext,
} from '../redis.js';
import { removeLiveKitParticipant } from '../services/livekitAdmin.js';
import { evictUserFromServerStages } from '../services/stageEviction.js';
import { scheduleVoiceE2eeRotate } from '../services/voiceE2eeRotation.js';
import { getClientIp } from '../utils/clientIp.js';

const router = Router({ mergeParams: true });

// Block mutations against suspended servers globally on this router.
// The middleware short-circuits read-only verbs (GET/HEAD/OPTIONS) so audit-log
// reads, settings reads, and template reads continue working for compliance /
// owner data export. Mounted before the per-route handlers so every mutation
// path inherits the check without ad-hoc opt-in.
router.use(serverNotSuspendedByServerId('serverId'));

const settingsMutationLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  windowMs: 60 * 1000,
  max: 30,
  store: createRateLimitStore('rl:srv-settings-w:'),
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  message: { error: 'Too many changes, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

const settingsReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:srv-settings-r:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

type MemberCtx = {
  userId: string;
  serverId: string;
  role: string;
  ctx: import('../utils/permissions.js').LoadedPermissionContext;
};

async function requireMember(req: AuthRequest, res: Response): Promise<MemberCtx | null> {
  if (!req.userId) { res.status(401).json({ error: 'Missing user' }); return null; }
  const serverId = getParam(req, 'serverId');
  const ctx = await loadPermissionContext(req.userId, serverId);
  if (!ctx) { res.status(403).json({ error: 'Not a member of this server' }); return null; }
  return { userId: req.userId, serverId, role: ctx.member.role?.toLowerCase() ?? 'member', ctx };
}

async function requirePermission(req: AuthRequest, res: Response, permission: string): Promise<MemberCtx | null> {
  const m = await requireMember(req, res);
  if (!m) return null;
  if (!hasPermission(m.ctx, permission)) { res.status(403).json({ error: `You need the ${permission} permission` }); return null; }
  return m;
}

async function _requireOwner(req: AuthRequest, res: Response): Promise<MemberCtx | null> {
  const m = await requireMember(req, res);
  if (!m) return null;
  if (m.role !== 'owner') { res.status(403).json({ error: 'Owner-only action' }); return null; }
  return m;
}

export async function createAuditLog(serverId: string, actorId: string, action: string, targetType?: string, targetId?: string, details?: Record<string, unknown>) {
  return prisma.auditLog.create({
    data: { serverId, actorId, action, targetType, targetId, details: details ? JSON.parse(JSON.stringify(details)) : undefined },
  });
}

// Tier Limits

const TIER_LIMITS = {
  emoji:      [55, 100, 150, 250],
  sticker:    [10,  15,  30,  60],
  soundboard: [12,  24,  36,  48],
} as const;

function powerUpTier(count: number): number {
  if (count >= 14) return 3;
  if (count >= 7) return 2;
  if (count >= 2) return 1;
  return 0;
}

async function getSlotLimit(serverId: string, kind: keyof typeof TIER_LIMITS): Promise<number> {
  const server = await prisma.server.findUnique({ where: { id: serverId }, select: { powerUpCount: true } });
  const tier = powerUpTier(server?.powerUpCount ?? 0);
  return TIER_LIMITS[kind][tier];
}

// Server Settings

router.get('/settings', authenticateToken, settingsReadLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requireMember(req, res);
    if (!m) return;
    let settings = await prisma.serverSettings.findUnique({ where: { serverId: m.serverId } });
    if (!settings) {
      settings = await prisma.serverSettings.create({ data: { serverId: m.serverId } });
    }
    res.json(settings);
  } catch (err) { next(err); }
});

router.patch('/settings', authenticateToken, settingsMutationLimiter, validate(updateServerSettingsSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'manageServer');
    if (!m) return;
    const body = req.body as Record<string, unknown>;
    const allowed = ['description', 'verificationLevel', 'contentFilter', 'dmSpamFilter', 'welcomeMessage', 'welcomeEnabled', 'defaultNotifications', 'joinMethod', 'rules', 'communityEnabled', 'discoveryEnabled', 'blockedNicknames', 'region', 'rulesChannelId', 'updatesChannelId', 'onboardingEnabled', 'welcomeChannelId'];
    const data: Record<string, unknown> = {};
    for (const k of allowed) {
      if (body[k] !== undefined) data[k] = body[k];
    }
    // If rulesChannelId / updatesChannelId is being set, verify the channel
    // belongs to this server — otherwise an owner could point eligibility
    // checks at a channel from a different server they happen to know the
    // UUID of. Null clears the designation; that's always OK.
    const channelIdFields: Array<keyof typeof data> = ['rulesChannelId', 'updatesChannelId', 'welcomeChannelId'];
    const channelIdsToCheck = channelIdFields
      .map((k) => data[k])
      .filter((v): v is string => typeof v === 'string');
    if (channelIdsToCheck.length > 0) {
      const found = await prisma.channel.findMany({
        where: { id: { in: channelIdsToCheck }, serverId: m.serverId, type: 'text' },
        select: { id: true },
        take: channelIdsToCheck.length,
      });
      const foundIds = new Set(found.map((c) => c.id));
      for (const id of channelIdsToCheck) {
        if (!foundIds.has(id)) {
          return res.status(400).json({ error: 'channel_not_in_server', channelId: id });
        }
      }
    }
    if (data.discoveryEnabled === true) {
      // Discovery x age-restricted mutual exclusion: block discovery if any
      // channel in the server is age-restricted. Runs before the size/age/
      // activity eligibility check so the more actionable error is returned
      // first — owners need to fix the age-restriction before any other gate
      // is meaningful.
      const ageRestrictedChannels = await prisma.channel.findMany({
        where: { serverId: m.serverId, ageRestricted: true },
        select: { id: true },
        take: 1,
      });
      if (ageRestrictedChannels.length > 0) {
        return res.status(400).json({
          error: 'discovery_blocked_by_age_restriction',
          message: 'Remove age restrictions from your channels to list this server in Discovery.',
        });
      }
      // Block enabling discovery from the generic settings PATCH if the
      // server doesn't meet the size/age/activity bars. Same gate as
      // serverCommunity.ts POST /enable + PATCH / so owners can't sneak
      // discoveryEnabled=true through this surface.
      const discoveryResult = await getDiscoveryEligibility(m.serverId);
      if (!discoveryResult.eligible) {
        return res.status(422).json({
          error: 'discovery_eligibility_failed',
          failed: discoveryResult.checks.filter((c) => !c.met),
          thresholds: discoveryResult.thresholds,
        });
      }
    }

    const existing = await prisma.serverSettings.findUnique({ where: { serverId: m.serverId } });

    // Open Door (joinMethod='discoverable') is only allowed when the server
    // is on the public Discover directory. Otherwise an owner could flip
    // joinMethod to 'discoverable' from this surface and bypass the
    // Community/Discovery quality bar that gates discoveryEnabled. Compute
    // the effective state after this PATCH (body override → existing fallback).
    if (data.joinMethod === 'discoverable') {
      const effectiveCommunityEnabled = data.communityEnabled !== undefined
        ? data.communityEnabled === true
        : existing?.communityEnabled === true;
      const effectiveDiscoveryEnabled = data.discoveryEnabled !== undefined
        ? data.discoveryEnabled === true
        : existing?.discoveryEnabled === true;
      if (!effectiveCommunityEnabled || !effectiveDiscoveryEnabled) {
        return res.status(422).json({
          error: 'open_door_requires_discovery',
          detail: 'Open Door is only available for servers listed on Discover. Enable Community Mode and Discovery first.',
        });
      }
    }

    // Auto-demote a stale 'discoverable' joinMethod when discovery is being
    // explicitly turned off. Without this, the row keeps joinMethod='discoverable'
    // even though isPubliclyDiscoverable() will block the public-join path —
    // a confusing state for the owner. The caller's explicit joinMethod (if
    // any) takes precedence; only auto-demote when they didn't specify.
    if (data.discoveryEnabled === false && data.joinMethod === undefined && existing?.joinMethod === 'discoverable') {
      data.joinMethod = 'invite_only';
    }
    let settings;
    if (existing) {
      settings = await prisma.serverSettings.update({ where: { serverId: m.serverId }, data: data as never });
    } else {
      settings = await prisma.serverSettings.create({ data: { serverId: m.serverId, ...data } as never });
    }
    await createAuditLog(m.serverId, m.userId, 'settings_update', 'settings', m.serverId, data);

    // Invalidate the cached eligibility so the next read recomputes from
    // fresh data. Settings PATCH can flip description (eligibility input),
    // discoveryEnabled (changes WHERE filter eligibility), and rules /
    // verificationLevel / etc (community-eligibility inputs that gate
    // discovery via the community_eligible check).
    void invalidateDiscoveryEligibility(m.serverId);
    const io = req.app.get('io');
    if (io) io.to(`server:${m.serverId}`).emit('server-settings-updated', { serverId: m.serverId, settings });
    // Auto-sync the pinned "Server Rules" system message in the designated
    // rules channel whenever rules text or the channel designation changes.
    if (data.rules !== undefined || data.rulesChannelId !== undefined) {
      void syncRulesChannelMessage({
        serverId: m.serverId,
        rulesChannelId: settings.rulesChannelId,
        rules: (settings.rules as unknown) as string[] | null,
        authorId: m.userId,
        io,
      }).catch((err) => {
        // Sync is fire-and-forget — failure logs but never blocks the PATCH response.
        logger.warn({ err, serverId: m.serverId }, 'rules_channel_sync_failed');
      });
    }
    res.json(settings);
  } catch (err) { next(err); }
});

/**
 * Render the rules array as a markdown numbered list inside a system
 * message. Length capped to fit the standard 4000-char message limit;
 * truncated with an indicator if rules grow beyond that.
 */
function formatRulesMessage(rules: string[] | null | undefined): string {
  const entries = Array.isArray(rules) ? rules.filter((r) => typeof r === 'string' && r.trim().length > 0) : [];
  if (entries.length === 0) {
    return '**Server Rules**\n\n_(No rules configured. Edit them in Server Settings → Entry Rules.)_';
  }
  const lines = entries.map((r, i) => `**${i + 1}.** ${r.trim()}`);
  let body = `**Server Rules**\n\n${lines.join('\n')}`;
  const MAX = 3900;
  if (body.length > MAX) body = body.slice(0, MAX) + '\n\n_(rules list truncated)_';
  return body;
}

/**
 * Idempotently keep a single pinned `kind: 'server_rules'` system message
 * in the designated rules channel in sync with `ServerSettings.rules`.
 * Editing the message in place when it already exists avoids polluting
 * the channel with a fresh post on every settings save. If the channel
 * designation moves, the old message is left untouched (orphaned but
 * harmless — moderators can clean up manually).
 */
async function syncRulesChannelMessage(args: {
  serverId: string;
  rulesChannelId: string | null;
  rules: string[] | null;
  authorId: string;
  io: import('socket.io').Server | undefined;
}): Promise<void> {
  const { rulesChannelId, rules, authorId, io } = args;
  if (!rulesChannelId) return;
  const content = formatRulesMessage(rules);
  const existing = await prisma.message.findFirst({
    where: {
      channelId: rulesChannelId,
      type: 'system',
      systemPayload: { path: ['kind'], equals: 'server_rules' },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    if (existing.content === content) return; // no-op when nothing changed
    const updated = await prisma.message.update({
      where: { id: existing.id },
      data: { content, editedAt: new Date() },
    });
    io?.to(`channel:${rulesChannelId}`).emit('message-edited', {
      id: updated.id,
      channelId: rulesChannelId,
      content: updated.content,
      editedAt: updated.editedAt?.toISOString() ?? null,
    });
    return;
  }
  const created = await prisma.message.create({
    data: {
      channelId: rulesChannelId,
      authorId,
      content,
      type: 'system',
      systemPayload: { kind: 'server_rules' },
    },
  });
  // Pin the message so it stays visible regardless of subsequent chat.
  // Failure to pin is non-fatal — the message itself is still posted.
  await prisma.channelPinnedMessage.upsert({
    where: { channelId_messageId: { channelId: rulesChannelId, messageId: created.id } },
    create: { channelId: rulesChannelId, messageId: created.id, pinnedById: authorId },
    update: {},
  }).catch(() => {});
  io?.to(`channel:${rulesChannelId}`).emit('new-message', {
    ...created,
    createdAt: created.createdAt.toISOString(),
    editedAt: null,
    authorUsername: null,
    authorDiscriminator: null,
    authorAvatar: null,
    authorRoleColor: null,
    authorRoleStyle: 'solid',
    authorStripePlan: null,
    authorNameColor: null,
    authorNameFont: null,
    authorNameEffect: null,
  });
}

// Bans

router.get('/bans', authenticateToken, settingsReadLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requireMember(req, res);
    if (!m) return;
    if (!hasPermission(m.ctx, 'banMembers') && !hasPermission(m.ctx, 'viewAuditLog') && !hasPermission(m.ctx, 'manageServer')) {
      return res.status(403).json({ error: 'You need the Ban Members or View Audit Log permission' });
    }
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const [bans, total] = await Promise.all([
      prisma.serverBan.findMany({
        where: { serverId: m.serverId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.serverBan.count({ where: { serverId: m.serverId } }),
    ]);
    const userIds = [...new Set(bans.map(b => b.userId))];
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, discriminator: true, avatar: true } });
    const userMap = new Map(users.map(u => [u.id, u]));
    res.json({
      bans: bans.map(b => {
        const u = userMap.get(b.userId);
        return { id: b.id, userId: b.userId, username: u?.username ?? 'Unknown', discriminator: u?.discriminator, avatar: u?.avatar, reason: b.reason, bannedById: b.bannedById, createdAt: b.createdAt.toISOString() };
      }),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) { next(err); }
});

router.post('/bans', authenticateToken, settingsMutationLimiter, validate(createBanSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'banMembers');
    if (!m) return;
    const { userId, reason } = req.body as { userId?: string; reason?: string };
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (userId === m.userId) return res.status(400).json({ error: 'Cannot ban yourself' });
    const targetCtx = await loadPermissionContext(userId, m.serverId);
    if (targetCtx?.member.role?.toLowerCase() === 'owner') return res.status(400).json({ error: 'Cannot ban the owner' });

    if (targetCtx && m.role !== 'owner') {
      const actorPosition = effectivePosition(m.ctx);
      const targetPosition = effectivePosition(targetCtx);
      if (targetPosition <= actorPosition) {
        return res.status(403).json({ error: 'You cannot ban a member whose role is at or above your own' });
      }
    }

    const txOps = [];
    if (targetCtx) {
      txOps.push(prisma.serverMember.delete({ where: { userId_serverId: { userId, serverId: m.serverId } } }));
    }
    txOps.push(prisma.serverBan.upsert({
      where: { serverId_userId: { serverId: m.serverId, userId } },
      create: { serverId: m.serverId, userId, reason: reason ?? null, bannedById: m.userId },
      update: { reason: reason ?? null, bannedById: m.userId },
    }));
    const results = await prisma.$transaction(txOps);
    const ban = results[results.length - 1];
    if (targetCtx) await invalidatePermissionContext(m.serverId, userId);
    await createAuditLog(m.serverId, m.userId, 'member_ban', 'user', userId, { reason });

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) {
      io.to(`server:${m.serverId}`).emit('server-member-left', { serverId: m.serverId, userId, kicked: true });
      io.to(`server:${m.serverId}`).emit('server-ban-added', { serverId: m.serverId });
      io.to(`user:${userId}`).emit('server-kicked', { serverId: m.serverId });

      const sockets = await io.in(`user:${userId}`).fetchSockets();
      const serverChannels = await prisma.channel.findMany({ where: { serverId: m.serverId }, select: { id: true }, take: 500 });
      const roomsToLeave = [`server:${m.serverId}`, ...serverChannels.map(c => `channel:${c.id}`), ...serverChannels.map(c => `voice:${c.id}`)];
      for (const s of sockets) {
        for (const room of roomsToLeave) s.leave(room);
      }
      // Clean up voice state in Redis
      const voiceChannelId = await findUserVoiceChannel(userId);
      if (voiceChannelId) {
        const voiceChannel = serverChannels.find(c => c.id === voiceChannelId);
        if (voiceChannel) {
          await removeVoiceParticipant(voiceChannelId, userId);
          await setVoiceReverseLookup(userId, null);
          await deleteVoiceOverride(voiceChannelId, userId);
          io.to(`voice:${voiceChannelId}`).emit('voice-user-left', { userId });
          const participants = await getVoiceParticipants(voiceChannelId);
          io.to(`server:${m.serverId}`).emit('server-voice-participants', {
            serverId: m.serverId, channelId: voiceChannelId, participants,
          });
          // Forward secrecy at the ban boundary: rotate the SFrame key so
          // the banned member's retained key no longer protects subsequent media.
          scheduleVoiceE2eeRotate(io, voiceChannelId, participants.length > 0);
          // Drop the banned user from the LiveKit
          // SFU so a cached JWT cannot keep publishing audio after ban.
          removeLiveKitParticipant(`voice:${voiceChannelId}`, userId).catch(() => {});
        }
      }

      // Also drop the banned user from any stage SFU room + sets so a
      // cached LiveKit JWT cannot keep publishing audio after the ban.
      await evictUserFromServerStages(io, userId, m.serverId).catch(() => {});

      // Tell the banned user's client to stop reconnecting to this server
      io.to(`user:${userId}`).emit('server-banned', { serverId: m.serverId });
    }

    res.status(201).json(ban);
  } catch (err) { next(err); }
});

router.delete('/bans/:userId', validateUuidParams('userId'), authenticateToken, settingsMutationLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'banMembers');
    if (!m) return;
    const targetUserId = getParam(req, 'userId');
    const ban = await prisma.serverBan.findUnique({ where: { serverId_userId: { serverId: m.serverId, userId: targetUserId } } });
    if (!ban) return res.status(404).json({ error: 'Ban not found' });
    await prisma.serverBan.delete({ where: { id: ban.id } });
    await createAuditLog(m.serverId, m.userId, 'member_unban', 'user', targetUserId);
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) io.to(`server:${m.serverId}`).emit('server-ban-removed', { serverId: m.serverId, userId: targetUserId });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Auto-assign Roles (Onboarding)

router.get('/auto-roles', authenticateToken, settingsReadLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'manageRoles');
    if (!m) return;
    const rows = await prisma.serverAutoRole.findMany({ where: { serverId: m.serverId }, select: { roleId: true }, take: 5 });
    res.json({ roleIds: rows.map((r) => r.roleId) });
  } catch (err) { next(err); }
});

router.put('/auto-roles', authenticateToken, settingsMutationLimiter, validate(updateAutoRolesSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'manageRoles');
    if (!m) return;
    const { roleIds } = req.body as { roleIds: string[] };
    const unique = [...new Set(roleIds)];
    const roles = await prisma.serverRole.findMany({
      where: { id: { in: unique }, serverId: m.serverId },
      select: { id: true, isEveryone: true, locked: true, hidden: true, position: true },
      take: 5,
    });
    if (roles.length !== unique.length) return res.status(400).json({ error: 'role_not_in_server' });
    const isOwner = m.role === 'owner';
    const actorPosition = effectivePosition(m.ctx);
    for (const r of roles) {
      if (r.isEveryone) return res.status(400).json({ error: 'cannot_auto_assign_everyone' });
      if (r.locked) return res.status(400).json({ error: 'cannot_auto_assign_locked' });
      // A hidden role is display-stripped from non-mods; auto-assigning it to
      // every new member would make it their display role and leak its name/color
      // to non-mods via the server-member-joined broadcast. Forbid at the source.
      if (r.hidden) return res.status(400).json({ error: 'cannot_auto_assign_hidden' });
      // A non-owner cannot auto-assign a role at or above their
      // own effective position (lower position = higher authority). Identical to
      // serverRoles.ts:427. Owner short-circuits.
      if (!isOwner && r.position <= actorPosition) return res.status(403).json({ error: 'role_above_your_position', roleId: r.id });
    }
    await prisma.$transaction([
      prisma.serverAutoRole.deleteMany({ where: { serverId: m.serverId } }),
      prisma.serverAutoRole.createMany({ data: unique.map((roleId) => ({ serverId: m.serverId, roleId })) }),
    ]);
    await createAuditLog(m.serverId, m.userId, 'auto_roles_update', 'server', m.serverId, { roleIds: unique });
    res.json({ roleIds: unique });
  } catch (err) { next(err); }
});

// Audit Log

router.get('/audit-log', authenticateToken, settingsReadLimiter, validate(auditLogQuery), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'viewAuditLog');
    if (!m) return;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const actionFilter = req.query.action as string | undefined;
    const where: Record<string, unknown> = { serverId: m.serverId };
    if (actionFilter) where.action = actionFilter;
    const [entries, total] = await Promise.all([
      prisma.auditLog.findMany({ where: where as never, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.auditLog.count({ where: where as never }),
    ]);
    // actorId is nullable — SetNull preserves audit log on actor delete.
    const actorIds = [...new Set(entries.map(e => e.actorId).filter((id): id is string => id !== null))];
    const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, username: true, avatar: true } });
    const actorMap = new Map(actors.map(a => [a.id, a]));
    res.json({
      entries: entries.map(e => ({
        ...e,
        createdAt: e.createdAt.toISOString(),
        actorUsername: (e.actorId && actorMap.get(e.actorId)?.username) ?? 'Unknown',
        actorAvatar: e.actorId ? actorMap.get(e.actorId)?.avatar : undefined,
      })),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) { next(err); }
});

// Custom Emoji

/**
 * Fan-out helper for the /bootstrap aggregate endpoint: load every custom
 * emoji for the given server set in a single query and group by serverId.
 * Caller MUST pre-verify the user is a member of every server in the list.
 *
 * Cap: 200 emoji per server × 200 servers = 40,000 hard ceiling so a runaway
 * doesn't fan out unbounded. The per-server route is still the right call when
 * you only need one server's emoji.
 */
export async function loadEmojisForServers(serverIds: string[]): Promise<Record<string, unknown[]>> {
  if (serverIds.length === 0) return {};
  const cappedIds = serverIds.slice(0, 200);
  const emojis = await prisma.customEmoji.findMany({
    where: { serverId: { in: cappedIds } },
    orderBy: { createdAt: 'asc' },
    take: 40000,
  });
  const grouped: Record<string, unknown[]> = {};
  for (const id of cappedIds) grouped[id] = [];
  for (const e of emojis) {
    const arr = grouped[e.serverId];
    if (arr) arr.push(e);
  }
  return grouped;
}

router.get('/emoji', authenticateToken, settingsReadLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requireMember(req, res);
    if (!m) return;
    const emojis = await prisma.customEmoji.findMany({ where: { serverId: m.serverId }, orderBy: { createdAt: 'asc' }, take: 200 });
    res.json(emojis);
  } catch (err) { next(err); }
});

router.post('/emoji', authenticateToken, settingsMutationLimiter, validate(createEmojiSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'manageExpressions');
    if (!m) return;
    const { name, imageUrl } = req.body as { name?: string; imageUrl?: string };
    if (!name || !imageUrl) return res.status(400).json({ error: 'name and imageUrl are required' });
    if (!imageUrl.startsWith('/api/uploads/') && !isSafeExternalUrl(imageUrl)) {
      return res.status(400).json({ error: 'Invalid image URL' });
    }
    const [count, limit] = await Promise.all([
      prisma.customEmoji.count({ where: { serverId: m.serverId } }),
      getSlotLimit(m.serverId, 'emoji'),
    ]);
    if (count >= limit) return res.status(403).json({ error: `This server has reached its emoji limit (${limit}). Power up the server to unlock more slots.` });
    const emoji = await prisma.customEmoji.create({ data: { serverId: m.serverId, name: name.trim(), imageUrl, uploadedById: m.userId } });
    await createAuditLog(m.serverId, m.userId, 'emoji_create', 'emoji', emoji.id, { name: emoji.name });
    const io = req.app.get('io');
    if (io) io.to(`server:${m.serverId}`).emit('server-emoji-created', { serverId: m.serverId, emoji });
    res.status(201).json(emoji);
  } catch (err) { next(err); }
});

router.delete('/emoji/:emojiId', validateUuidParams('emojiId'), authenticateToken, settingsMutationLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'manageExpressions');
    if (!m) return;
    const emojiId = getParam(req, 'emojiId');
    const emoji = await prisma.customEmoji.findFirst({ where: { id: emojiId, serverId: m.serverId } });
    if (!emoji) return res.status(404).json({ error: 'Emoji not found' });
    await prisma.customEmoji.delete({ where: { id: emojiId } });
    await createAuditLog(m.serverId, m.userId, 'emoji_delete', 'emoji', emojiId, { name: emoji.name });
    const io = req.app.get('io');
    if (io) io.to(`server:${m.serverId}`).emit('server-emoji-deleted', { serverId: m.serverId, emojiId });
    res.json({ ok: true });
    // Best-effort R2 cleanup of the emoji image — no point holding open requests for it
    if (emoji.imageUrl) deleteUploadedFile(emoji.imageUrl).catch(() => {});
  } catch (err) { next(err); }
});

// Stickers

router.get('/stickers', authenticateToken, settingsReadLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requireMember(req, res);
    if (!m) return;
    const stickers = await prisma.sticker.findMany({ where: { serverId: m.serverId }, orderBy: { createdAt: 'asc' }, take: 200 });
    res.json(stickers);
  } catch (err) { next(err); }
});

router.post('/stickers', authenticateToken, settingsMutationLimiter, validate(createStickerSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'manageExpressions');
    if (!m) return;
    const { name, imageUrl, description } = req.body as { name?: string; imageUrl?: string; description?: string };
    if (!name || !imageUrl) return res.status(400).json({ error: 'name and imageUrl are required' });
    if (!imageUrl.startsWith('/api/uploads/') && !isSafeExternalUrl(imageUrl)) {
      return res.status(400).json({ error: 'Invalid image URL' });
    }
    const [count, limit] = await Promise.all([
      prisma.sticker.count({ where: { serverId: m.serverId } }),
      getSlotLimit(m.serverId, 'sticker'),
    ]);
    if (count >= limit) return res.status(403).json({ error: `This server has reached its sticker limit (${limit}). Power up the server to unlock more slots.` });
    const sticker = await prisma.sticker.create({ data: { serverId: m.serverId, name: name.trim(), imageUrl, description: description ?? null, uploadedById: m.userId } });
    await createAuditLog(m.serverId, m.userId, 'sticker_create', 'sticker', sticker.id, { name: sticker.name });
    const io = req.app.get('io');
    if (io) io.to(`server:${m.serverId}`).emit('server-sticker-created', { serverId: m.serverId, sticker });
    res.status(201).json(sticker);
  } catch (err) { next(err); }
});

router.delete('/stickers/:stickerId', validateUuidParams('stickerId'), authenticateToken, settingsMutationLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'manageExpressions');
    if (!m) return;
    const stickerId = getParam(req, 'stickerId');
    const sticker = await prisma.sticker.findFirst({ where: { id: stickerId, serverId: m.serverId } });
    if (!sticker) return res.status(404).json({ error: 'Sticker not found' });
    await prisma.sticker.delete({ where: { id: stickerId } });
    await createAuditLog(m.serverId, m.userId, 'sticker_delete', 'sticker', stickerId, { name: sticker.name });
    const io = req.app.get('io');
    if (io) io.to(`server:${m.serverId}`).emit('server-sticker-deleted', { serverId: m.serverId, stickerId });
    res.json({ ok: true });
    // Best-effort R2 cleanup of the sticker image
    if (sticker.imageUrl) deleteUploadedFile(sticker.imageUrl).catch(() => {});
  } catch (err) { next(err); }
});

// Soundboard

router.get('/soundboard', authenticateToken, settingsReadLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requireMember(req, res);
    if (!m) return;
    const sounds = await prisma.soundboardSound.findMany({ where: { serverId: m.serverId }, orderBy: { createdAt: 'asc' }, take: 200 });
    res.json(sounds);
  } catch (err) { next(err); }
});

router.post('/soundboard', authenticateToken, settingsMutationLimiter, validate(createSoundboardSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'manageExpressions');
    if (!m) return;
    const { name, audioUrl, emoji, volume } = req.body as { name?: string; audioUrl?: string; emoji?: string; volume?: number };
    if (!name || !audioUrl) return res.status(400).json({ error: 'name and audioUrl are required' });
    if (!audioUrl.startsWith('/api/uploads/') && !isSafeExternalUrl(audioUrl)) {
      return res.status(400).json({ error: 'Invalid audio URL' });
    }
    const [count, limit] = await Promise.all([
      prisma.soundboardSound.count({ where: { serverId: m.serverId } }),
      getSlotLimit(m.serverId, 'soundboard'),
    ]);
    if (count >= limit) return res.status(403).json({ error: `This server has reached its soundboard limit (${limit}). Power up the server to unlock more slots.` });

    // Enforce max file size as a proxy for duration (~2MB ≈ 10-15s for most formats)
    const MAX_SOUNDBOARD_FILE_BYTES = 2 * 1024 * 1024; // 2MB
    if (audioUrl.startsWith('/api/uploads/')) {
      const fileSize = await getUploadedFileSize(audioUrl);
      if (fileSize !== null && fileSize > MAX_SOUNDBOARD_FILE_BYTES) {
        return res.status(400).json({ error: 'Soundboard sounds must be under 2MB (roughly 10 seconds). Upload a shorter clip.' });
      }
    }

    const sound = await prisma.soundboardSound.create({ data: { serverId: m.serverId, name: name.trim(), audioUrl, emoji: emoji ?? null, volume: typeof volume === 'number' ? Math.max(0, Math.min(1, volume)) : 1.0, uploadedById: m.userId } });
    await createAuditLog(m.serverId, m.userId, 'sound_create', 'sound', sound.id, { name: sound.name });
    const io = req.app.get('io');
    if (io) io.to(`server:${m.serverId}`).emit('server-soundboard-created', { serverId: m.serverId, sound });
    res.status(201).json(sound);
  } catch (err) { next(err); }
});

router.delete('/soundboard/:soundId', validateUuidParams('soundId'), authenticateToken, settingsMutationLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'manageExpressions');
    if (!m) return;
    const soundId = getParam(req, 'soundId');
    const sound = await prisma.soundboardSound.findFirst({ where: { id: soundId, serverId: m.serverId } });
    if (!sound) return res.status(404).json({ error: 'Sound not found' });
    await prisma.soundboardSound.delete({ where: { id: soundId } });
    await createAuditLog(m.serverId, m.userId, 'sound_delete', 'sound', soundId, { name: sound.name });
    const io = req.app.get('io');
    if (io) io.to(`server:${m.serverId}`).emit('server-soundboard-deleted', { serverId: m.serverId, soundId });
    res.json({ ok: true });
    // Best-effort R2 cleanup of the audio file
    if (sound.audioUrl) deleteUploadedFile(sound.audioUrl).catch(() => {});
  } catch (err) { next(err); }
});

// AutoMod

router.get('/automod', authenticateToken, settingsReadLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requireMember(req, res);
    if (!m) return;
    if (!hasPermission(m.ctx, 'manageServer')) {
      return res.status(403).json({ error: 'You need the Manage Server permission' });
    }
    const rules = await prisma.automodRule.findMany({ where: { serverId: m.serverId }, orderBy: { createdAt: 'asc' }, take: 50 });
    res.json(rules);
  } catch (err) { next(err); }
});

router.post('/automod', authenticateToken, settingsMutationLimiter, validate(createAutomodSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'manageServer');
    if (!m) return;
    const { name, type, enabled, config } = req.body as { name?: string; type?: string; enabled?: boolean; config?: unknown };
    if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
    const validTypes = ['keyword_filter', 'spam_filter', 'mention_spam', 'link_filter'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
    const rule = await prisma.automodRule.create({ data: { serverId: m.serverId, name: name.trim(), type, enabled: enabled !== false, config: config ?? undefined } });
    invalidateAutomodCache(m.serverId);
    await createAuditLog(m.serverId, m.userId, 'automod_create', 'rule', rule.id, { name: rule.name, type: rule.type });
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) io.to(`server:${m.serverId}`).emit('server-automod-updated', { serverId: m.serverId });
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

router.patch('/automod/:ruleId', validateUuidParams('ruleId'), authenticateToken, settingsMutationLimiter, validate(updateAutomodSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'manageServer');
    if (!m) return;
    const ruleId = getParam(req, 'ruleId');
    const rule = await prisma.automodRule.findFirst({ where: { id: ruleId, serverId: m.serverId } });
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    const body = req.body as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    if (typeof body.name === 'string') data.name = body.name.trim();
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
    if (body.config !== undefined) data.config = body.config;
    const updated = await prisma.automodRule.update({ where: { id: ruleId }, data: data as never });
    invalidateAutomodCache(m.serverId);
    await createAuditLog(m.serverId, m.userId, 'automod_update', 'rule', ruleId, data);
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) io.to(`server:${m.serverId}`).emit('server-automod-updated', { serverId: m.serverId });
    res.json(updated);
  } catch (err) { next(err); }
});

router.delete('/automod/:ruleId', validateUuidParams('ruleId'), authenticateToken, settingsMutationLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'manageServer');
    if (!m) return;
    const ruleId = getParam(req, 'ruleId');
    const rule = await prisma.automodRule.findFirst({ where: { id: ruleId, serverId: m.serverId } });
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    await prisma.automodRule.delete({ where: { id: ruleId } });
    invalidateAutomodCache(m.serverId);
    await createAuditLog(m.serverId, m.userId, 'automod_delete', 'rule', ruleId, { name: rule.name });
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) io.to(`server:${m.serverId}`).emit('server-automod-updated', { serverId: m.serverId });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Server Templates

router.get('/templates', authenticateToken, settingsReadLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requireMember(req, res);
    if (!m) return;
    const templates = await prisma.serverTemplate.findMany({
      where: { serverId: m.serverId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, name: true, description: true, code: true,
        channelSnapshot: true, roleSnapshot: true, categorySnapshot: true, settingsSnapshot: true,
        createdAt: true, usageCount: true,
      },
    });
    res.json(templates);
  } catch (err) { next(err); }
});

router.post('/templates', authenticateToken, settingsMutationLimiter, validate(createTemplateSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'manageServer');
    if (!m) return;
    const { name, description } = req.body as { name?: string; description?: string };
    if (!name) return res.status(400).json({ error: 'name is required' });
    const [categories, channels, roles, settings] = await Promise.all([
      prisma.channelCategory.findMany({
        where: { serverId: m.serverId },
        orderBy: { position: 'asc' },
        take: 100,
        select: { id: true, name: true, position: true },
      }),
      prisma.channel.findMany({
        where: { serverId: m.serverId },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        take: 500,
        select: { name: true, type: true, categoryId: true, position: true },
      }),
      prisma.serverRole.findMany({
        where: { serverId: m.serverId },
        orderBy: { position: 'asc' },
        take: 100,
        select: { name: true, color: true, permissions: true },
      }),
      prisma.serverSettings.findUnique({
        where: { serverId: m.serverId },
        select: { description: true, verificationLevel: true, defaultNotifications: true },
      }),
    ]);
    const categorySnapshot = categories.map((cat) => ({
      name: cat.name,
      position: cat.position,
      channels: channels
        .filter((ch) => ch.categoryId === cat.id)
        .map((ch) => ({ name: ch.name, type: ch.type, position: ch.position })),
    }));
    const settingsSnapshot = settings
      ? {
          description: settings.description ?? undefined,
          verificationLevel: settings.verificationLevel,
          defaultNotifications: settings.defaultNotifications,
        }
      : undefined;
    const template = await prisma.serverTemplate.create({
      data: {
        serverId: m.serverId,
        name: name.trim(),
        description: description ?? null,
        channelSnapshot: channels.map((ch) => ({ name: ch.name, type: ch.type })),
        roleSnapshot: roles,
        categorySnapshot: categorySnapshot,
        settingsSnapshot: settingsSnapshot ?? undefined,
        createdById: m.userId,
      },
    });
    await createAuditLog(m.serverId, m.userId, 'template_create', 'template', template.id, { name: template.name });
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) io.to(`server:${m.serverId}`).emit('server-templates-updated', { serverId: m.serverId });
    res.status(201).json(template);
  } catch (err) { next(err); }
});

router.put('/templates/:templateId', validateUuidParams('templateId'), authenticateToken, settingsMutationLimiter, validate(updateTemplateSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'manageServer');
    if (!m) return;
    const templateId = getParam(req, 'templateId');
    const existing = await prisma.serverTemplate.findFirst({ where: { id: templateId, serverId: m.serverId } });
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    const { name, description } = req.body as { name?: string; description?: string };

    // Re-snapshot current server state
    const [categories, channels, roles, settings] = await Promise.all([
      prisma.channelCategory.findMany({
        where: { serverId: m.serverId },
        orderBy: { position: 'asc' },
        take: 100,
        select: { id: true, name: true, position: true },
      }),
      prisma.channel.findMany({
        where: { serverId: m.serverId },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        take: 500,
        select: { name: true, type: true, categoryId: true, position: true },
      }),
      prisma.serverRole.findMany({
        where: { serverId: m.serverId },
        orderBy: { position: 'asc' },
        take: 100,
        select: { name: true, color: true, permissions: true },
      }),
      prisma.serverSettings.findUnique({
        where: { serverId: m.serverId },
        select: { description: true, verificationLevel: true, defaultNotifications: true },
      }),
    ]);

    const categorySnapshot = categories.map((cat) => ({
      name: cat.name,
      position: cat.position,
      channels: channels
        .filter((ch) => ch.categoryId === cat.id)
        .map((ch) => ({ name: ch.name, type: ch.type, position: ch.position })),
    }));

    const settingsSnapshot = settings
      ? { description: settings.description ?? undefined, verificationLevel: settings.verificationLevel, defaultNotifications: settings.defaultNotifications }
      : undefined;

    const updated = await prisma.serverTemplate.update({
      where: { id: templateId },
      data: {
        ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
        ...(typeof description === 'string' ? { description } : {}),
        channelSnapshot: channels.map((ch) => ({ name: ch.name, type: ch.type })),
        roleSnapshot: roles,
        categorySnapshot: categorySnapshot,
        settingsSnapshot: settingsSnapshot ?? undefined,
      },
    });

    await createAuditLog(m.serverId, m.userId, 'template_update', 'template', templateId, { name: updated.name });
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) io.to(`server:${m.serverId}`).emit('server-templates-updated', { serverId: m.serverId });
    res.json(updated);
  } catch (err) { next(err); }
});

router.delete('/templates/:templateId', validateUuidParams('templateId'), authenticateToken, settingsMutationLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await requirePermission(req, res, 'manageServer');
    if (!m) return;
    const templateId = getParam(req, 'templateId');
    const template = await prisma.serverTemplate.findFirst({ where: { id: templateId, serverId: m.serverId } });
    if (!template) return res.status(404).json({ error: 'Template not found' });
    await prisma.serverTemplate.delete({ where: { id: templateId } });
    await createAuditLog(m.serverId, m.userId, 'template_delete', 'template', templateId, { name: template.name });
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) io.to(`server:${m.serverId}`).emit('server-templates-updated', { serverId: m.serverId });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
