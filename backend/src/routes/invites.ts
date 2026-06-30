// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest, JWT_SECRET } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { joinInviteSchema, invitePreviewSchema } from '../schemas.js';
import { getEffectivePlan, loadPermissionContext, computeMyPermissions, pickDisplayRole } from '../utils.js';
import { filterVisibleChannelIds } from '../utils/channelVisibility.js';
import { emitInviteToVisibleSockets, serializeInvite } from './serverInvites.js';
import { getClientIp } from '../utils/clientIp.js';
import { invalidatePermissionContext } from '../redis.js';
import { loadIsMinor } from '../utils/ageGate.js';
import { applyAutoAssignRoles, postJoinWelcomeMessage } from '../utils/joinWelcome.js';

// Permissive auth: if a valid Bearer token is present, set req.userId so
// downstream rate-limit keying buckets authenticated viewers per-user instead
// of per-IP. Mirrors the optionalAuth helper in routes/publicServer.ts.
// Anonymous and malformed-token requests fall through silently.
function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const header = req.headers['authorization'];
  const token = header && header.split(' ')[1];
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { userId?: string; purpose?: string };
    if (decoded?.userId && !decoded.purpose) {
      req.userId = decoded.userId;
    }
  } catch { /* swallow — treat as anonymous */ }
  next();
}

const MAX_SERVERS_FREE = 100;
const MAX_SERVERS_PRO = 200;

const router = Router();

const inviteJoinLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:invite:'),
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many invite joins. Try again later.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
  skip: (req) => RATE_LIMIT_DEFAULTS.skip(req) || !(req as AuthRequest).userId,
});

// POST /api/invites/join – join a server by invite code
router.post('/join', authenticateToken, inviteJoinLimiter, validate(joinInviteSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { code } = req.body as { code?: string };
  const trimmed = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!trimmed) return res.status(400).json({ error: 'Invite code is required' });

  const invite = await prisma.invite.findUnique({
    where: { code: trimmed },
    include: { server: { include: { channels: { orderBy: { createdAt: 'asc' } } } } },
  });
  if (!invite) return res.status(404).json({ error: 'Invalid or expired invite' });
  if (invite.expiresAt && invite.expiresAt < new Date()) return res.status(404).json({ error: 'Invite has expired' });
  if (invite.maxUses != null && invite.useCount >= invite.maxUses) return res.status(404).json({ error: 'Invite has reached max uses' });

  const [ban, familyRestriction] = await Promise.all([
    prisma.serverBan.findUnique({ where: { serverId_userId: { serverId: invite.serverId, userId: req.userId } } }),
    prisma.familyRestriction.findFirst({
      where: { familyLink: { childId: req.userId, status: 'active' }, blockServerJoin: true },
    }),
  ]);
  if (ban) {
    return res.status(403).json({ error: 'You are banned from this server.' });
  }
  if (familyRestriction) {
    return res.status(403).json({ error: 'A parent account has restricted you from joining new servers.' });
  }

  const [serverCount, joinerUser] = await Promise.all([
    prisma.serverMember.count({ where: { userId: req.userId } }),
    prisma.user.findUnique({ where: { id: req.userId! }, select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true } }),
  ]);
  const joinerPlan = joinerUser ? getEffectivePlan(joinerUser) : 'free';
  const serverLimit = (joinerPlan === 'essential' || joinerPlan === 'pro') ? MAX_SERVERS_PRO : MAX_SERVERS_FREE;
  if (serverCount >= serverLimit) {
    return res.status(403).json({ error: `You've reached the maximum of ${serverLimit} servers. ${serverLimit === MAX_SERVERS_FREE ? 'Upgrade to Howl Pro to join up to 200 servers.' : ''}` });
  }

  const existingCtx = await loadPermissionContext(req.userId, invite.serverId);
  if (existingCtx) {
    const isOwner = existingCtx.member.role?.toLowerCase() === 'owner';
    const myPermissions = computeMyPermissions(existingCtx);
    // Fetch role details for display. Use raw member's roleId as fallback for legacy single-role callers.
    const displayRoleIdCandidates = existingCtx.roles.filter(r => !r.isEveryone).map(r => r.id);
    const displayRoles = displayRoleIdCandidates.length > 0
      ? await prisma.serverRole.findMany({
          where: { id: { in: displayRoleIdCandidates } },
          select: { id: true, name: true, color: true, style: true, position: true, displaySeparately: true, isEveryone: true },
        })
      : [];
    const display = pickDisplayRole(displayRoles);
    return res.status(200).json({
      id: invite.server.id,
      name: invite.server.name,
      icon: invite.server.icon ?? undefined,
      banner: (invite.server as { banner?: string | null }).banner ?? undefined,
      myRole: isOwner ? 'owner' : (display?.name ?? 'member'),
      myRoles: displayRoles.filter(r => !r.isEveryone).map(r => ({ id: r.id, name: r.name, color: r.color, style: r.style, position: r.position, displaySeparately: r.displaySeparately })),
      myPermissions,
      channels: invite.server.channels.filter((c) => !(c as { isPrivate?: boolean }).isPrivate).map((c) => ({ id: c.id, name: c.name, description: (c as { description?: string | null }).description ?? undefined, type: c.type })),
    });
  }

  // Enforce server settings before join
  const [settings, joiner] = await Promise.all([
    prisma.serverSettings.findUnique({ where: { serverId: invite.serverId } }),
    prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, createdAt: true, username: true, discriminator: true, avatar: true, status: true } }),
  ]);

  // Apply-to-join servers redirect new joiners through the application flow
  // instead of joining directly. Existing members were already short-circuited
  // above (the `existingCtx` branch) so reaching this point means the user
  // would otherwise be a fresh joiner. Wrapped defensively so a malformed
  // questions blob can't break the direct-join path for non-apply servers.
  if (settings?.joinMethod === 'apply_to_join') {
    let questions: unknown[] = [];
    try {
      const raw = (settings as { applicationQuestions?: unknown }).applicationQuestions;
      if (Array.isArray(raw)) questions = raw;
    } catch { /* ignore — fall through with empty questions */ }

    // Surface any in-flight pending application so the frontend can skip the
    // form entirely on a second visit and show "you've already applied"
    // instead of letting the user re-fill and round-trip a 409. We only
    // surface 'pending' here — rejected applications are designed to allow
    // re-application, and accepted ones would have hit the existingCtx
    // branch above as a member.
    const existingApplication = await prisma.serverApplication.findFirst({
      where: { serverId: invite.serverId, userId: req.userId, status: 'pending' },
      select: { id: true, status: true, createdAt: true },
    });

    return res.status(202).json({
      status: 'application_required',
      serverId: invite.serverId,
      serverName: invite.server.name,
      questions,
      existingApplication: existingApplication
        ? { status: 'pending' as const, createdAt: existingApplication.createdAt.toISOString() }
        : null,
    });
  }

  // Verification level check
  if (settings) {
    const level = settings.verificationLevel;
    if (level !== 'none') {

      if (level === 'low' || level === 'medium' || level === 'high') {
        const gateCheck = await prisma.user.findUnique({ where: { id: req.userId }, select: { emailVerified: true } });
        if (!gateCheck?.emailVerified) {
          return res.status(403).json({ error: 'You must have a verified email to join this server.' });
        }
      }
      if (level === 'medium' || level === 'high') {
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
        if (joiner && joiner.createdAt > fiveMinAgo) {
          return res.status(403).json({ error: 'Your account must be at least 5 minutes old to join this server.' });
        }
      }
      if (level === 'high') {
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
        if (joiner && joiner.createdAt > tenMinAgo) {
          return res.status(403).json({ error: 'Your account must be at least 10 minutes old to join this server.' });
        }
      }
    }
  }

  // Atomically claim one invite use before creating the member record, so we
  // never end up with a phantom member if the invite was concurrently exhausted.
  const updatedRows = await prisma.$executeRaw`
    UPDATE "Invite"
    SET "useCount" = "useCount" + 1
    WHERE id = ${invite.id}
      AND ("maxUses" IS NULL OR "useCount" < "maxUses")
      AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
  `;
  if (updatedRows === 0) {
    return res.status(409).json({ error: 'Invite has reached its maximum uses or has expired. Please try again.' });
  }

  const newUseCount = invite.useCount + 1;
  if (invite.maxUses != null && newUseCount >= invite.maxUses) {
    await prisma.invite.delete({ where: { id: invite.id } }).catch(() => {});
  }

  const memberRole = await prisma.serverRole.findFirst({
    where: { serverId: invite.serverId, name: 'Member', isEveryone: false },
  });
  await prisma.serverMember.upsert({
    where: { userId_serverId: { userId: req.userId!, serverId: invite.serverId } },
    create: {
      userId: req.userId!,
      serverId: invite.serverId,
      role: 'member',
      roleId: memberRole?.id ?? undefined,
      isTemporary: invite.temporary,
      temporaryExpiresAt: invite.temporary ? invite.expiresAt : null,
    },
    update: {}, // Already a member — no-op (race-condition safety net)
  });
  // Also seed the MemberRole join row so the new multi-role system knows about the Member assignment.
  // @everyone is implicit at permission-resolution time (never materialized here).
  if (memberRole) {
    await prisma.memberRole.upsert({
      where: { userId_serverId_roleId: { userId: req.userId!, serverId: invite.serverId, roleId: memberRole.id } },
      create: { userId: req.userId!, serverId: invite.serverId, roleId: memberRole.id },
      update: {},
    });
  }
  // Drop any stale cached entry so subsequent loadPermissionContext seeds
  // the cache with the now-current row.
  await invalidatePermissionContext(invite.serverId, req.userId!);

  // Grant any configured auto-assign roles and recompute the member's display
  // role. MUST run before `joinedMember` is read below so the
  // `server-member-joined` emit reflects the hoisted role.
  await applyAutoAssignRoles(invite.serverId, req.userId!);

  const io = req.app.get('io') as import('socket.io').Server | undefined;

  // Welcome message
  if (joiner) {
    await postJoinWelcomeMessage(invite.serverId, { id: joiner.id, username: joiner.username }, io);
  }

  const joinedMember = await prisma.serverMember.findUnique({
    where: { userId_serverId: { userId: req.userId, serverId: invite.serverId } },
    include: { serverRole: true },
  });
  // Compute myPermissions via multi-role union (includes @everyone baseline).
  const joinedCtx = await loadPermissionContext(req.userId!, invite.serverId);
  const joinPerms = joinedCtx ? computeMyPermissions(joinedCtx) : {};

  {
    if (io && joiner) {
      // Auto-subscribe the new member's live sockets to the server room and
      // every channel their permission context actually allows them to read.
      // Delegates to `filterVisibleChannelIds` so the override chain (channel
      // + category + @everyone + role) matches the authoritative
      // `join-channel` handler. Without the full chain, a category with a
      // restrictive `@everyone: {readMessageHistory: false}` override — the
      // standard pattern for locking down public channels — would be
      // bypassed at invite time, delivering plaintext `new-message`
      // broadcasts to users who cannot read the channel.
      io.in(`user:${req.userId!}`).socketsJoin(`server:${invite.serverId}`);
      if (joinedCtx) {
        const [channels, isMinor] = await Promise.all([
          prisma.channel.findMany({
            where: { serverId: invite.serverId, type: { in: ['text', 'stage', 'forum'] }, isPrivate: false },
            select: { id: true, isPrivate: true, categoryId: true, ageRestricted: true },
            take: 1000,
          }),
          loadIsMinor(req.userId!),
        ]);
        const visibleIds = await filterVisibleChannelIds(joinedCtx, channels, { isMinor });
        for (const id of visibleIds) {
          io.in(`user:${req.userId!}`).socketsJoin(`channel:${id}`);
        }
      }
      io.to(`server:${invite.serverId}`).emit('server-member-joined', {
        serverId: invite.serverId,
        user: { id: joiner.id, username: joiner.username, discriminator: joiner.discriminator, avatar: joiner.avatar ?? undefined, status: joiner.status ?? 'online' },
        role: joinedMember?.serverRole?.name ?? 'member',
        roleColor: joinedMember?.serverRole?.color ?? undefined,
      });

      // Notify admins/creator/shareable-viewers that the invite's useCount
      // changed so the Server Settings → Invites list updates in real time.
      // If the invite was auto-deleted because it just hit maxUses, send a
      // delete instead — the original code path that deleted the invite
      // didn't broadcast at all, leaving the row stuck in admins' lists.
      const inviteWasDeleted = invite.maxUses != null && newUseCount >= invite.maxUses;
      if (inviteWasDeleted) {
        io.to(`server:${invite.serverId}`).emit('server-invite-deleted', {
          serverId: invite.serverId,
          inviteId: invite.id,
        });
      } else {
        const inviteCreator = await prisma.user.findUnique({
          where: { id: invite.createdById },
          select: { id: true, username: true, discriminator: true, avatar: true },
        });
        await emitInviteToVisibleSockets({
          io,
          serverId: invite.serverId,
          event: 'server-invite-updated',
          invite: serializeInvite({ ...invite, useCount: newUseCount }, inviteCreator),
        });
      }
    }
  }

  res.status(200).json({
    id: invite.server.id,
    name: invite.server.name,
    icon: invite.server.icon ?? undefined,
    banner: (invite.server as { banner?: string | null }).banner ?? undefined,
    myRole: joinedMember?.serverRole?.name ?? 'member',
    myPermissions: joinPerms,
    channels: invite.server.channels.filter((c) => !(c as { isPrivate?: boolean }).isPrivate).map((c) => ({ id: c.id, name: c.name, description: (c as { description?: string | null }).description ?? undefined, type: c.type })),
  });
}));

// Public invite preview
// Keyed by userId-or-real-client-IP via optionalAuth + getClientIp so each
// visitor gets their own bucket regardless of NAT/CGN/Cloudflare-PoP siblings.
const invitePreviewLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:invite-preview:'),
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

router.get('/:code/preview', optionalAuth, invitePreviewLimiter, validate(invitePreviewSchema), asyncHandler(async (req, res) => {
  const code = (String(req.params.code ?? '')).trim().toUpperCase().replace(/[^A-Z0-9\-_]/g, '');
  if (!code || code.length < 3 || code.length > 32) return res.status(404).json({ error: 'Not found' });

  const invite = await prisma.invite.findUnique({
    where: { code },
    include: {
      server: {
        select: {
          id: true, name: true, icon: true, banner: true, bannerPositionY: true, bannerZoom: true,
          settings: { select: { description: true, joinMethod: true } },
          _count: { select: { members: true } },
        },
      },
    },
  });

  if (!invite) return res.status(404).json({ error: 'Not found' });
  if (invite.expiresAt && invite.expiresAt < new Date()) return res.status(404).json({ error: 'Not found' });
  if (invite.maxUses != null && invite.useCount >= invite.maxUses) return res.status(404).json({ error: 'Not found' });

  // Real online count: members whose user status is not 'offline'
  const onlineCount = await prisma.serverMember.count({
    where: { serverId: invite.server.id, user: { status: { not: 'offline' } } },
  });

  res.json({
    serverId: invite.server.id,
    serverName: invite.server.name,
    serverIcon: invite.server.icon,
    serverBanner: invite.server.banner,
    serverBannerPositionY: invite.server.bannerPositionY,
    serverBannerZoom: invite.server.bannerZoom,
    description: invite.server.settings?.description ?? null,
    memberCount: invite.server._count.members,
    onlineCount,
    code: invite.code,
    expiresAt: invite.expiresAt?.toISOString() ?? null,
    joinMethod: invite.server.settings?.joinMethod ?? 'invite_only',
  });
}));

export default router;
