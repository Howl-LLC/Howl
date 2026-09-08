// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { checkUploadAttachment } from '../services/uploadProvenance.js';
import { createThreadSchema, editThreadSchema, editThreadMessageSchema, sendThreadMessageSchema, getThreadMessagesQuery, reactMessageSchema } from '../schemas.js';
import { getParam, hasPermission, loadPermissionContext, assertChannelVisible, assertChannelReadable, AUTHOR_USER_SELECT } from '../utils.js';
import { logger } from '../logger.js';
import { deleteUploadedFile } from './upload.js';
import { createAuditLog } from './serverSettings.js';
import { getMentionedUserIds } from './messages.js';
import { loadChannelNotifyGate, filterUsersWhoCanViewChannel } from '../utils/channelVisibility.js';
import { denyIfAgeGated, loadIsMinor } from '../utils/ageGate.js';
import { applyBadgePrefs } from '../utils/badges.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'threads' });

const MAX_ACTIVE_THREADS_PER_CHANNEL = 100;
const MAX_ACTIVE_THREADS_PER_SERVER = 1000;

// Rate limiters

const threadReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:thread-read:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const threadMutationLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:thread-mutate:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many thread actions. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const threadMsgLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:thread-msg:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many messages. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

// Helpers

/**
 * load a channel row + its override chain for the shared read/visibility
 * gate. This file had ZERO channel-level permission logic — every handler
 * authorized on server membership plus a server-level `hasPermission`, never the
 * channel's `isPrivate` / override chain — so a member could read and write
 * threads in private channels they cannot see. Callers pass `thread.channelId`
 * (NOT the URL `:channelId`, which some handlers never cross-check). Returns null
 * when the channel is missing or not in this server (caller returns 404).
 */
async function loadChannelForGate(channelId: string, serverId: string) {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, serverId: true, isPrivate: true, categoryId: true, ageRestricted: true },
  });
  if (!channel || channel.serverId !== serverId) return null;
  const [chOverrides, catOverrides] = await Promise.all([
    prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 200 }),
    channel.categoryId
      ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 200 })
      : Promise.resolve([]),
  ]);
  return { channel, chOverrides, catOverrides };
}

function normalizeThreadMessage(msg: any) {
  const author = msg.author ?? {};
  return {
    id: msg.id,
    threadId: msg.threadId,
    authorId: msg.authorId,
    authorUsername: author.username,
    authorDiscriminator: author.discriminator,
    authorAvatar: author.avatar ?? null,
    content: msg.content,
    type: msg.type,
    systemPayload: msg.systemPayload,
    replyToMessageId: msg.replyToMessageId,
    attachmentUrl: msg.attachmentUrl,
    attachmentName: msg.attachmentName,
    attachmentContentType: msg.attachmentContentType,
    attachmentWidth: msg.attachmentWidth,
    attachmentHeight: msg.attachmentHeight,
    createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : msg.createdAt,
    editedAt: msg.editedAt instanceof Date ? msg.editedAt.toISOString() : (msg.editedAt ?? null),
    reactions: (msg.reactions ?? []).map((r: any) => ({
      emoji: r.emoji,
      count: r._count?.emoji ?? 1,
      users: r.users ?? [],
    })),
  };
}

const THREAD_MESSAGE_SELECT = {
  id: true, threadId: true, authorId: true, content: true, type: true,
  systemPayload: true, replyToMessageId: true,
  attachmentUrl: true, attachmentName: true, attachmentContentType: true,
  attachmentWidth: true, attachmentHeight: true,
  createdAt: true, editedAt: true,
};

// Router

const router = Router({ mergeParams: true });

// Server-level thread listing

// GET /api/v1/servers/:serverId/threads — list all non-archived threads for a server
router.get(
  '/:serverId/threads',
  validateUuidParams('serverId'),
  authenticateToken,
  threadReadLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');

    const [member, permCtx, isMinor] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
      }),
      loadPermissionContext(req.userId, serverId),
      loadIsMinor(req.userId),
    ]);
    if (!member || !permCtx) return res.status(403).json({ error: 'Not a server member' });

    // Scope the server-wide list to the member's actually-readable
    // channels. The old `channel.isPrivate:false` filter was a crude boolean that
    // (a) leaked threads in PUBLIC channels whose @everyone readMessageHistory is
    // denied via override, (b) ignored the age gate, and (c) hid private-channel
    // threads the member CAN see. Mirror search.ts's per-channel `.ok` filter — a
    // list, so denial is silent omission, never a per-channel 404/403 oracle.
    const channels = await prisma.channel.findMany({
      where: { serverId },
      select: { id: true, isPrivate: true, categoryId: true, ageRestricted: true },
      take: 1000,
    });
    const ageVisible = isMinor ? channels.filter((c) => !c.ageRestricted) : channels;
    const chIds = ageVisible.map((c) => c.id);
    const catIds = [...new Set(ageVisible.map((c) => c.categoryId).filter(Boolean))] as string[];
    const [chOverrides, catOverrides] = await Promise.all([
      chIds.length ? prisma.channelPermissionOverride.findMany({ where: { channelId: { in: chIds } }, orderBy: { id: 'asc' }, take: 10000 }) : Promise.resolve([]),
      catIds.length ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: { in: catIds } }, orderBy: { id: 'asc' }, take: 10000 }) : Promise.resolve([]),
    ]);
    const visibleChannelIds = ageVisible
      .filter((ch) => assertChannelReadable(
        permCtx,
        ch,
        chOverrides.filter((o) => o.channelId === ch.id),
        ch.categoryId ? catOverrides.filter((o) => o.categoryId === ch.categoryId) : [],
      ).ok)
      .map((ch) => ch.id);
    if (visibleChannelIds.length === 0) return res.json([]);

    const threads = await prisma.thread.findMany({
      where: { serverId, archived: false, channelId: { in: visibleChannelIds } },
      orderBy: { lastActivityAt: 'desc' },
      take: 200,
      select: {
        id: true,
        channelId: true,
        serverId: true,
        parentMessageId: true,
        name: true,
        authorId: true,
        archived: true,
        autoArchive: true,
        autoArchiveDuration: true,
        lastActivityAt: true,
        createdAt: true,
        _count: { select: { messages: true } },
      },
    });

    res.json(threads.map(t => ({
      id: t.id,
      channelId: t.channelId,
      serverId: t.serverId,
      parentMessageId: t.parentMessageId,
      name: t.name,
      authorId: t.authorId,
      archived: t.archived,
      autoArchive: t.autoArchive,
      autoArchiveDuration: t.autoArchiveDuration,
      lastActivityAt: t.lastActivityAt.toISOString(),
      createdAt: t.createdAt.toISOString(),
      messageCount: t._count.messages,
    })));
  }),
);

// Thread CRUD

// POST /api/v1/servers/:serverId/channels/:channelId/threads
router.post(
  '/:serverId/channels/:channelId/threads',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  threadMutationLimiter,
  validate(createThreadSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');

    const [channel, member, permCtx] = await Promise.all([
      prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, serverId: true, type: true, isPrivate: true, categoryId: true, ageRestricted: true } }),
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!channel || channel.serverId !== serverId) return res.status(404).json({ error: 'Channel not found' });
    if (!member) return res.status(403).json({ error: 'Not a server member' });
    // (write): block creating a thread in a private channel the member
    // cannot see. Visibility (404) runs BEFORE the channel-type 400 so a private
    // NON-text channel does not leak its existence/type (mirrors forum.ts, which
    // gates before its forum-type check); createThreads follows. This also
    // transitively closes the ownership-gated PATCH/DELETE thread paths, which
    // only become member-reachable once a member can author a thread here.
    const [chOverrides, catOverrides] = await Promise.all([
      prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 200 }),
      channel.categoryId ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 200 }) : Promise.resolve([]),
    ]);
    const vis = assertChannelVisible(permCtx, channel, chOverrides, catOverrides);
    if (!vis.ok) return res.status(vis.status).json({ error: vis.error });
    // Age gate AFTER the visibility gate (a non-viewer already got 404): a minor
    // who CAN see this public age-restricted channel is blocked from creating a
    // thread in it, mirroring the messages.ts send-path denyIfAgeGated.
    const ageDeny = await denyIfAgeGated(channel, req.userId);
    if (ageDeny) return res.status(403).json(ageDeny);
    if (channel.type !== 'text') return res.status(400).json({ error: 'Threads can only be created in text channels' });
    if (!hasPermission(permCtx,'createThreads')) return res.status(403).json({ error: 'Missing createThreads permission' });

    const { name, parentMessageId, autoArchive, autoArchiveDuration } = req.body as {
      name: string; parentMessageId: string; autoArchive: boolean; autoArchiveDuration: string;
    };

    // Verify parent message exists in this channel
    const parentMessage = await prisma.message.findUnique({
      where: { id: parentMessageId },
      select: { id: true, channelId: true },
    });
    if (!parentMessage || parentMessage.channelId !== channelId) {
      return res.status(400).json({ error: 'Parent message not found in this channel' });
    }

    // Check for existing thread on this message
    const existingThread = await prisma.thread.findFirst({
      where: { parentMessageId, channelId },
      select: { id: true },
    });
    if (existingThread) return res.status(409).json({ error: 'A thread already exists for this message' });

    // Cap active threads per channel
    const activeThreadCount = await prisma.thread.count({
      where: { channelId, archived: false },
    });
    if (activeThreadCount >= MAX_ACTIVE_THREADS_PER_CHANNEL) {
      return res.status(400).json({ error: `Maximum of ${MAX_ACTIVE_THREADS_PER_CHANNEL} active threads per channel reached` });
    }

    const serverActiveCount = await prisma.thread.count({ where: { serverId, archived: false } });
    if (serverActiveCount >= MAX_ACTIVE_THREADS_PER_SERVER) {
      return res.status(400).json({ error: `Maximum of ${MAX_ACTIVE_THREADS_PER_SERVER} active threads per server` });
    }

    const durationMinutes = parseInt(autoArchiveDuration, 10);

    const thread = await prisma.thread.create({
      data: {
        channelId,
        serverId,
        parentMessageId,
        name: name.trim(),
        authorId: req.userId,
        autoArchive,
        autoArchiveDuration: durationMinutes,
      },
    });

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    const threadPayload = {
      id: thread.id,
      channelId,
      serverId,
      parentMessageId,
      name: thread.name,
      authorId: thread.authorId,
      archived: false,
      autoArchive: thread.autoArchive,
      autoArchiveDuration: thread.autoArchiveDuration,
      lastActivityAt: thread.lastActivityAt.toISOString(),
      createdAt: thread.createdAt.toISOString(),
      messageCount: 0,
    };
    // for a PRIVATE channel, fan the thread (incl. its name + the private
    // channelId) only to the channel room — every viewer is already joined there,
    // the same room live `new-message` uses — never the server-wide room, which
    // includes members who cannot see the channel. Public channels keep the
    // server-room copy so members who have not opened the channel still update
    // their thread list / unread state.
    const threadScope = channel.isPrivate
      ? io?.to(`channel:${channelId}`)
      : io?.to(`channel:${channelId}`).to(`server:${serverId}`);
    threadScope?.emit('thread-created', threadPayload);

    await createAuditLog(serverId, req.userId, 'thread_create', 'channel', channelId, { threadId: thread.id, name: thread.name }).catch(() => {});
    log.info({ userId: req.userId, threadId: thread.id, channelId }, 'thread created');
    res.status(201).json({
      id: thread.id,
      channelId,
      serverId,
      parentMessageId,
      name: thread.name,
      authorId: thread.authorId,
      archived: false,
      autoArchive: thread.autoArchive,
      autoArchiveDuration: thread.autoArchiveDuration,
      lastActivityAt: thread.lastActivityAt.toISOString(),
      createdAt: thread.createdAt.toISOString(),
      messageCount: 0,
    });
  }),
);

// GET /api/v1/servers/:serverId/channels/:channelId/threads
router.get(
  '/:serverId/channels/:channelId/threads',
  validateUuidParams('serverId', 'channelId'),
  authenticateToken,
  threadReadLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a server member' });
    // gate the thread list (embeds message BODIES via the lastMessage
    // preview) behind the channel read gate, replacing the server-level
    // readMessageHistory check. A nonexistent/foreign channelId now returns 404
    // (was 200 []) so private→404 and nonexistent are indistinguishable.
    const gateInputs = await loadChannelForGate(channelId, serverId);
    if (!gateInputs) return res.status(404).json({ error: 'Channel not found' });
    const gate = assertChannelReadable(permCtx, gateInputs.channel, gateInputs.chOverrides, gateInputs.catOverrides);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
    // Age gate AFTER the read gate: a minor who cannot see the channel already
    // got 404 above; only a minor who CAN read a public age-restricted channel
    // reaches here and is 403'd. The lastMessage preview embeds 18+ bodies.
    const ageDeny = await denyIfAgeGated(gateInputs.channel, req.userId);
    if (ageDeny) return res.status(403).json(ageDeny);

    const archived = req.query.archived === 'true';
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    const threads = await prisma.thread.findMany({
      where: { channelId, serverId, archived },
      orderBy: { lastActivityAt: 'desc' },
      take: limit,
      include: {
        _count: { select: { messages: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, select: THREAD_MESSAGE_SELECT },
      },
    });

    res.json(threads.map((t) => ({
      id: t.id,
      channelId: t.channelId,
      serverId: t.serverId,
      parentMessageId: t.parentMessageId,
      name: t.name,
      authorId: t.authorId,
      archived: t.archived,
      autoArchive: t.autoArchive,
      autoArchiveDuration: t.autoArchiveDuration,
      lastActivityAt: t.lastActivityAt.toISOString(),
      createdAt: t.createdAt.toISOString(),
      messageCount: t._count.messages,
      lastMessage: t.messages[0] ? normalizeThreadMessage(t.messages[0]) : null,
    })));
  }),
);

// GET /api/v1/servers/:serverId/channels/:channelId/threads/:threadId
router.get(
  '/:serverId/channels/:channelId/threads/:threadId',
  validateUuidParams('serverId', 'channelId', 'threadId'),
  authenticateToken,
  threadReadLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const threadId = getParam(req, 'threadId');

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a server member' });

    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      include: {
        _count: { select: { messages: true } },
      },
    });
    if (!thread || thread.serverId !== serverId) return res.status(404).json({ error: 'Thread not found' });
    // gate on thread.channelId — this handler never cross-checks the URL
    // :channelId against the thread, so gating on the URL param would be a silent
    // no-op (an attacker could pass a public channel's id). Denial surfaces as
    // 'Thread not found'/404, indistinguishable from a missing thread above.
    {
      const gateInputs = await loadChannelForGate(thread.channelId, serverId);
      if (!gateInputs) return res.status(404).json({ error: 'Thread not found' });
      const gate = assertChannelReadable(permCtx, gateInputs.channel, gateInputs.chOverrides, gateInputs.catOverrides);
      if (!gate.ok) {
        if (gate.status === 404) return res.status(404).json({ error: 'Thread not found' });
        return res.status(gate.status).json({ error: gate.error });
      }
      const ageDeny = await denyIfAgeGated(gateInputs.channel, req.userId);
      if (ageDeny) return res.status(403).json(ageDeny);
    }

    // Get unique participants
    const participantRows = await prisma.threadMessage.findMany({
      where: { threadId },
      select: { authorId: true },
      distinct: ['authorId'],
      take: 50,
    });
    const participantIds = participantRows.map((p) => p.authorId);
    const participants = participantIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: participantIds } },
          select: { id: true, username: true, avatar: true },
          take: 50,
        })
      : [];

    res.json({
      id: thread.id,
      channelId: thread.channelId,
      serverId: thread.serverId,
      parentMessageId: thread.parentMessageId,
      name: thread.name,
      authorId: thread.authorId,
      archived: thread.archived,
      autoArchive: thread.autoArchive,
      autoArchiveDuration: thread.autoArchiveDuration,
      lastActivityAt: thread.lastActivityAt.toISOString(),
      createdAt: thread.createdAt.toISOString(),
      messageCount: thread._count.messages,
      participants,
    });
  }),
);

// PATCH /api/v1/servers/:serverId/channels/:channelId/threads/:threadId
router.patch(
  '/:serverId/channels/:channelId/threads/:threadId',
  validateUuidParams('serverId', 'channelId', 'threadId'),
  authenticateToken,
  threadMutationLimiter,
  validate(editThreadSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');
    const threadId = getParam(req, 'threadId');

    const [thread, member, permCtx] = await Promise.all([
      prisma.thread.findUnique({ where: { id: threadId }, select: { authorId: true, channelId: true, serverId: true, channel: { select: { isPrivate: true } } } }),
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    // membership first, then gate the URL channel, THEN the resource
    // existence check — so a non-member gets a uniform 403 (not 403-if-real vs
    // 404-if-absent) and the gate round-trip is paid whether or not the thread
    // exists (matches forum.ts). The resource check still binds thread→channelId,
    // so a visible channel spoofed in the URL cannot reach a private-channel thread.
    if (!member || !permCtx) return res.status(403).json({ error: 'Not a server member' });
    const gate = await loadChannelForGate(channelId, serverId);
    if (!gate) return res.status(404).json({ error: 'Thread not found' });
    const vis = assertChannelVisible(permCtx, gate.channel, gate.chOverrides, gate.catOverrides);
    if (!vis.ok) return res.status(404).json({ error: 'Thread not found' });
    // Age gate AFTER the visibility gate: this moderator-capable PATCH echoes the
    // thread's stored name in its response (and lets a moderator edit/archive
    // others' threads), so a minor must not reach an age-restricted thread's 18+
    // name here — the read path (thread detail) is age-gated too.
    const ageDeny = await denyIfAgeGated(gate.channel, req.userId);
    if (ageDeny) return res.status(403).json(ageDeny);
    if (!thread || thread.channelId !== channelId || thread.serverId !== serverId) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    if (thread.authorId !== req.userId && !hasPermission(permCtx,'manageMessages')) {
      return res.status(403).json({ error: 'Not authorized to edit this thread' });
    }

    const { name, archived, autoArchive, autoArchiveDuration } = req.body as {
      name?: string; archived?: boolean; autoArchive?: boolean; autoArchiveDuration?: string;
    };

    const data: Record<string, unknown> = { editedAt: new Date() };
    if (name !== undefined) data.name = name.trim();
    if (archived !== undefined) {
      data.archived = archived;
      data.archivedAt = archived ? new Date() : null;
      if (!archived) data.lastActivityAt = new Date();
    }
    if (autoArchive !== undefined) data.autoArchive = autoArchive;
    if (autoArchiveDuration !== undefined) data.autoArchiveDuration = parseInt(autoArchiveDuration, 10);

    const updated = await prisma.thread.update({ where: { id: threadId }, data });

    const payload = {
      id: updated.id,
      channelId: updated.channelId,
      serverId,
      name: updated.name,
      archived: updated.archived,
      autoArchive: updated.autoArchive,
      autoArchiveDuration: updated.autoArchiveDuration,
      lastActivityAt: updated.lastActivityAt.toISOString(),
    };

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (archived !== undefined) {
      // private channel -> channel room only (viewers are joined there),
      // never the server-wide room. Public channels keep the server-room copy.
      const archiveScope = thread.channel?.isPrivate
        ? io?.to(`channel:${channelId}`)
        : io?.to(`channel:${channelId}`).to(`server:${serverId}`);
      archiveScope?.emit('thread-archived', payload);
      io?.to(`thread:${threadId}`).emit('thread-archived', payload);
    } else {
      io?.to(`channel:${channelId}`).emit('thread-updated', payload);
    }

    if (archived !== undefined) {
      await createAuditLog(serverId, req.userId, archived ? 'thread_archive' : 'thread_unarchive', 'channel', channelId, { threadId }).catch(() => {});
    }
    log.info({ userId: req.userId, threadId, action: archived !== undefined ? 'archive' : 'edit' }, 'thread updated');
    res.json(payload);
  }),
);

// DELETE /api/v1/servers/:serverId/channels/:channelId/threads/:threadId
router.delete(
  '/:serverId/channels/:channelId/threads/:threadId',
  validateUuidParams('serverId', 'channelId', 'threadId'),
  authenticateToken,
  threadMutationLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const channelId = getParam(req, 'channelId');
    const threadId = getParam(req, 'threadId');

    const [thread, member, permCtx] = await Promise.all([
      prisma.thread.findUnique({ where: { id: threadId }, select: { authorId: true, channelId: true, serverId: true } }),
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    // membership first, gate the URL channel, THEN the resource check —
    // uniform 403 for a non-member and no fast-404 timing split (matches forum.ts).
    if (!member || !permCtx) return res.status(403).json({ error: 'Not a server member' });
    const gate = await loadChannelForGate(channelId, serverId);
    if (!gate) return res.status(404).json({ error: 'Thread not found' });
    const vis = assertChannelVisible(permCtx, gate.channel, gate.chOverrides, gate.catOverrides);
    if (!vis.ok) return res.status(404).json({ error: 'Thread not found' });
    if (!thread || thread.channelId !== channelId || thread.serverId !== serverId) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    if (thread.authorId !== req.userId && !hasPermission(permCtx,'manageMessages')) {
      return res.status(403).json({ error: 'Not authorized to delete this thread' });
    }

    // Clean up attachments
    const attachments = await prisma.threadMessage.findMany({
      where: { threadId, attachmentUrl: { not: null } },
      select: { attachmentUrl: true },
      take: 1000,
    });
    for (const a of attachments) {
      if (a.attachmentUrl) deleteUploadedFile(a.attachmentUrl).catch(() => {});
    }

    await prisma.thread.delete({ where: { id: threadId } });

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`channel:${channelId}`).emit('thread-deleted', { threadId, channelId });

    await createAuditLog(serverId, req.userId, 'thread_delete', 'channel', channelId, { threadId }).catch(() => {});
    log.info({ userId: req.userId, threadId }, 'thread deleted');
    res.status(204).end();
  }),
);

// Thread Messages

// POST /api/v1/servers/:serverId/threads/:threadId/messages
router.post(
  '/:serverId/threads/:threadId/messages',
  validateUuidParams('serverId', 'threadId'),
  authenticateToken,
  threadMsgLimiter,
  validate(sendThreadMessageSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const threadId = getParam(req, 'threadId');

    const [thread, member, permCtx] = await Promise.all([
      prisma.thread.findUnique({ where: { id: threadId }, select: { id: true, serverId: true, channelId: true, archived: true, channel: { select: { isPrivate: true } } } }),
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    // membership first, so a non-member gets a uniform 403 rather than
    // 403-if-the-thread-exists vs 404-if-not.
    if (!member) return res.status(403).json({ error: 'Not a server member' });
    if (!thread || thread.serverId !== serverId) return res.status(404).json({ error: 'Thread not found' });
    // (write): block posting into a thread in a private channel the member
    // cannot see. Visibility (404) runs BEFORE the archived 400 so an archived
    // thread in a private channel does not leak its existence; sendMessagesInThreads
    // follows. loadChannelForGate resolves the channel fresh (incl. categoryId +
    // overrides); a null return is a 404, never a fail-open through the optional
    // thread.channel.
    {
      const gateInputs = await loadChannelForGate(thread.channelId, serverId);
      if (!gateInputs) return res.status(404).json({ error: 'Thread not found' });
      const vis = assertChannelVisible(permCtx, gateInputs.channel, gateInputs.chOverrides, gateInputs.catOverrides);
      if (!vis.ok) return res.status(404).json({ error: 'Thread not found' });
      // Age gate AFTER the visibility gate: a minor who CAN see this public
      // age-restricted channel is blocked from posting into its thread (mirrors
      // messages.ts send-path denyIfAgeGated).
      const ageDeny = await denyIfAgeGated(gateInputs.channel, req.userId);
      if (ageDeny) return res.status(403).json(ageDeny);
    }
    if (thread.archived) return res.status(400).json({ error: 'Thread is archived' });
    if (!hasPermission(permCtx,'sendMessagesInThreads')) return res.status(403).json({ error: 'Missing sendMessagesInThreads permission' });

    const { content, replyToMessageId, attachment } = req.body as {
      content: string; replyToMessageId?: string; attachment?: { url: string; name: string; contentType?: string; width?: number | null; height?: number | null };
    };

    if (!content?.trim() && !attachment) {
      return res.status(400).json({ error: 'Message content or attachment is required' });
    }
    // Refuse an encrypted (scan-skipped) DM blob on this plaintext,
    // multi-recipient thread surface. Fail-closed on a provenance lookup error.
    if (attachment) {
      const prov = await checkUploadAttachment(attachment.url);
      if (!prov.ok) return res.status(prov.status).json({ error: prov.error });
    }

    const data: Record<string, unknown> = {
      threadId,
      authorId: req.userId,
      content: content ?? '',
      replyToMessageId: replyToMessageId ?? null,
    };
    if (attachment) {
      data.attachmentUrl = attachment.url;
      data.attachmentName = attachment.name;
      data.attachmentContentType = attachment.contentType ?? null;
      data.attachmentWidth = attachment.width ?? null;
      data.attachmentHeight = attachment.height ?? null;
    }

    const msg = await prisma.threadMessage.create({
      data: data as any,
      include: { thread: { select: { channelId: true } } },
    });

    // Update thread lastActivityAt
    await prisma.thread.update({
      where: { id: threadId },
      data: { lastActivityAt: new Date() },
    });

    const author = await prisma.user.findUnique({ where: { id: req.userId }, select: AUTHOR_USER_SELECT });
    const normalized = {
      ...normalizeThreadMessage({ ...msg, author }),
      authorBadges: author ? applyBadgePrefs(author) : [],
    };

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) {
      // Emit to anyone currently viewing the thread
      const threadRoom = io.sockets.adapter.rooms.get(`thread:${threadId}`);
      const notifiedSocketIds = threadRoom ? Array.from(threadRoom) : [];
      io.to(`thread:${threadId}`).emit('thread-message', normalized);

      // Fallback: reach each thread participant's user: room so unread counts
      // bump even when they're not actively viewing the thread. "Participant"
      // = anyone who has posted in the thread (capped to most recent 100).
      // The thread's OP (`thread.authorId`) and the current poster are
      // included implicitly because their messages are in ThreadMessage.
      try {
        const recentAuthors = await prisma.threadMessage.findMany({
          where: { threadId },
          distinct: ['authorId'],
          select: { authorId: true },
          take: 100,
        });
        const participantIds = new Set(recentAuthors.map(r => r.authorId));
        // Belt-and-suspenders: include the thread's OP author in case they
        // never replied themselves.
        if (msg.thread?.channelId) {
          const threadMeta = await prisma.thread.findUnique({
            where: { id: threadId },
            select: { authorId: true },
          });
          if (threadMeta?.authorId) participantIds.add(threadMeta.authorId);
        }
        // Don't notify the poster of their own message.
        participantIds.delete(req.userId);
        for (const uid of participantIds) {
          io.to(`user:${uid}`).except(notifiedSocketIds).emit('thread-message', normalized);
        }
      } catch {
        // Don't let participant-fallback errors break the primary emit.
      }
    }

    // Parse @mentions and create notifications (fire-and-forget, batched resolution)
    const contentStr = (content ?? '').trim();
    if (contentStr && io) {
      void (async () => {
        const mentionUserIds = await getMentionedUserIds(prisma, contentStr, serverId);
        let ids = mentionUserIds.filter(uid => uid !== req.userId);
        if (ids.length === 0) return;

        // intersect the mention set with who can VIEW the parent channel,
        // unless it is provably open. This path has no age filter of its own, so
        // drop minors for an age-gated channel. Fail closed if the channel is gone.
        const gate = await loadChannelNotifyGate(thread.channelId);
        const provablyOpen = gate?.provablyOpen ?? false;
        if (!provablyOpen) {
          if (!gate) return;
          const viewers = await filterUsersWhoCanViewChannel({ gate, candidateUserIds: ids, dropMinors: gate.channel.ageRestricted });
          ids = ids.filter(uid => viewers.has(uid));
        }
        if (ids.length === 0) return;

        const authorName = author?.username ?? 'Someone';
        const preview = contentStr.length > 200 ? contentStr.slice(0, 200) + '…' : contentStr;
        const notifTitle = `${authorName} mentioned you in a thread`;

        // Emit server-channel-activity for the parent channel. + route
        // to the server room only when provably open; otherwise (private OR
        // baseline/override-restricted) to the channel room (viewers only).
        io.to(provablyOpen ? `server:${serverId}` : `channel:${thread.channelId}`).emit('server-channel-activity', {
          serverId, channelId: thread.channelId, messageId: msg.id, mentionUserIds: ids,
        });

        await prisma.notification.createMany({
          data: ids.map(uid => ({
            userId: uid, serverId, channelId: thread.channelId, threadId,
            type: 'thread_mention', title: notifTitle, body: preview,
            metadata: { messageId: msg.id, authorId: req.userId, authorUsername: authorName },
          })),
        }).catch(() => {});
        for (const uid of ids) {
          prisma.threadReadState.upsert({
            where: { userId_threadId: { userId: uid, threadId } },
            create: { userId: uid, threadId, mentionCount: 1 },
            update: { mentionCount: { increment: 1 } },
          }).catch(() => {});
          io.to(`user:${uid}`).emit('notification-created', {
            serverId, channelId: thread.channelId, threadId,
            type: 'thread_mention', title: notifTitle, body: preview,
            metadata: { messageId: msg.id }, createdAt: new Date().toISOString(),
          });
        }
      })().catch(() => {});
    }

    res.status(201).json(normalized);
  }),
);

// GET /api/v1/servers/:serverId/threads/:threadId/messages
router.get(
  '/:serverId/threads/:threadId/messages',
  validateUuidParams('serverId', 'threadId'),
  authenticateToken,
  threadReadLimiter,
  validate(getThreadMessagesQuery),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const threadId = getParam(req, 'threadId');

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a server member' });

    const thread = await prisma.thread.findUnique({ where: { id: threadId }, select: { serverId: true, channelId: true } });
    if (!thread || thread.serverId !== serverId) return res.status(404).json({ error: 'Thread not found' });
    // the highest-severity leak in this file — a full, cursor-paginated
    // private thread transcript. The channel was never resolved (select was
    // { serverId } only); gate on thread.channelId, replacing the server-level
    // readMessageHistory check.
    {
      const gateInputs = await loadChannelForGate(thread.channelId, serverId);
      if (!gateInputs) return res.status(404).json({ error: 'Thread not found' });
      const gate = assertChannelReadable(permCtx, gateInputs.channel, gateInputs.chOverrides, gateInputs.catOverrides);
      if (!gate.ok) {
        if (gate.status === 404) return res.status(404).json({ error: 'Thread not found' });
        return res.status(gate.status).json({ error: gate.error });
      }
      const ageDeny = await denyIfAgeGated(gateInputs.channel, req.userId);
      if (ageDeny) return res.status(403).json(ageDeny);
    }

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const before = req.query.before as string | undefined;
    const after = req.query.after as string | undefined;

    const where: any = { threadId };
    if (before) {
      const cursor = await prisma.threadMessage.findUnique({ where: { id: before }, select: { createdAt: true } });
      if (cursor) where.createdAt = { lt: cursor.createdAt };
    } else if (after) {
      const cursor = await prisma.threadMessage.findUnique({ where: { id: after }, select: { createdAt: true } });
      if (cursor) where.createdAt = { gt: cursor.createdAt };
    }

    const messages = await prisma.threadMessage.findMany({
      where,
      orderBy: { createdAt: before ? 'desc' : 'asc' },
      take: limit,
      include: {
        reactions: true,
      },
    });

    // Fetch authors in batch
    const authorIds = [...new Set(messages.map((m) => m.authorId))];
    const authors = authorIds.length > 0
      ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: AUTHOR_USER_SELECT, take: 200 })
      : [];
    const authorsMap = new Map(authors.map((a) => [a.id, a]));

    const sorted = before ? messages.reverse() : messages;
    const normalized = sorted.map((m) => {
      const author = authorsMap.get(m.authorId);
      // Group reactions by emoji
      const reactionGroups = new Map<string, { emoji: string; count: number; me: boolean }>();
      for (const r of m.reactions) {
        const existing = reactionGroups.get(r.emoji);
        if (existing) {
          existing.count++;
          if (r.userId === req.userId) existing.me = true;
        } else {
          reactionGroups.set(r.emoji, { emoji: r.emoji, count: 1, me: r.userId === req.userId! });
        }
      }
      return {
        ...normalizeThreadMessage({ ...m, author }),
        reactions: [...reactionGroups.values()],
        authorBadges: author ? applyBadgePrefs(author) : [],
      };
    });

    res.json(normalized);
  }),
);

// PATCH /api/v1/servers/:serverId/threads/:threadId/messages/:messageId
router.patch(
  '/:serverId/threads/:threadId/messages/:messageId',
  validateUuidParams('serverId', 'threadId', 'messageId'),
  authenticateToken,
  threadMsgLimiter,
  validate(editThreadMessageSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const threadId = getParam(req, 'threadId');
    const messageId = getParam(req, 'messageId');
    const { content } = req.body as { content: string };

    // membership first, so a non-member gets a uniform 403 rather than
    // 403-if-the-thread-exists vs 404-if-not. The thread lookup (needed for the
    // channel gate — this route has no channelId param) follows the membership check.
    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });

    // Cross-tenant guard: thread must belong to URL serverId before we touch the message.
    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { serverId: true, channelId: true },
    });
    if (!thread || thread.serverId !== serverId) return res.status(404).json({ error: 'Thread not found' });

    // Gate channel visibility before the message lookup so a non-viewer cannot use
    // the 404-vs-403 differential as a private-thread existence oracle.
    const gate = await loadChannelForGate(thread.channelId, serverId);
    if (!gate) return res.status(404).json({ error: 'Thread not found' });
    const vis = assertChannelVisible(permCtx, gate.channel, gate.chOverrides, gate.catOverrides);
    if (!vis.ok) return res.status(404).json({ error: 'Thread not found' });

    const msg = await prisma.threadMessage.findUnique({
      where: { id: messageId },
      select: { authorId: true, threadId: true },
    });
    if (!msg || msg.threadId !== threadId) return res.status(404).json({ error: 'Message not found' });
    if (msg.authorId !== req.userId) return res.status(403).json({ error: 'Can only edit your own messages' });

    const updated = await prisma.threadMessage.update({
      where: { id: messageId },
      data: { content: content.trim(), editedAt: new Date() },
    });

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`thread:${threadId}`).emit('thread-message-edited', {
      id: updated.id,
      threadId,
      content: updated.content,
      editedAt: updated.editedAt?.toISOString(),
    });

    res.json({ id: updated.id, content: updated.content, editedAt: updated.editedAt?.toISOString() });
  }),
);

// DELETE /api/v1/servers/:serverId/threads/:threadId/messages/:messageId
router.delete(
  '/:serverId/threads/:threadId/messages/:messageId',
  validateUuidParams('serverId', 'threadId', 'messageId'),
  authenticateToken,
  threadMsgLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const threadId = getParam(req, 'threadId');
    const messageId = getParam(req, 'messageId');

    const [msg, member, permCtx] = await Promise.all([
      prisma.threadMessage.findUnique({
        where: { id: messageId },
        select: { authorId: true, threadId: true, attachmentUrl: true },
      }),
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    // membership first, so a non-member gets a uniform 403 rather than
    // 403-if-the-thread-exists vs 404-if-not.
    if (!member || !permCtx) return res.status(403).json({ error: 'Not a server member' });
    // Cross-tenant guard: thread must belong to URL serverId before we touch the message.
    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { serverId: true, channelId: true },
    });
    if (!thread || thread.serverId !== serverId) return res.status(404).json({ error: 'Thread not found' });
    // Gate channel visibility before the message existence check so a non-viewer
    // cannot use the 404-vs-403 differential as an existence oracle.
    const gate = await loadChannelForGate(thread.channelId, serverId);
    if (!gate) return res.status(404).json({ error: 'Thread not found' });
    const vis = assertChannelVisible(permCtx, gate.channel, gate.chOverrides, gate.catOverrides);
    if (!vis.ok) return res.status(404).json({ error: 'Thread not found' });
    if (!msg || msg.threadId !== threadId) return res.status(404).json({ error: 'Message not found' });

    if (msg.authorId !== req.userId && !hasPermission(permCtx,'manageMessages')) {
      return res.status(403).json({ error: 'Not authorized to delete this message' });
    }

    if (msg.attachmentUrl) deleteUploadedFile(msg.attachmentUrl).catch(() => {});

    await prisma.threadMessage.delete({ where: { id: messageId } });

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`thread:${threadId}`).emit('thread-message-deleted', { id: messageId, threadId });

    res.status(204).end();
  }),
);

// POST /api/v1/servers/:serverId/threads/:threadId/messages/:messageId/reactions
router.post(
  '/:serverId/threads/:threadId/messages/:messageId/reactions',
  validateUuidParams('serverId', 'threadId', 'messageId'),
  authenticateToken,
  threadMsgLimiter,
  validate(reactMessageSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const threadId = getParam(req, 'threadId');
    const messageId = getParam(req, 'messageId');
    const { emoji } = req.body as { emoji: string };

    // membership first, so a non-member gets a uniform 403 rather than
    // 403-if-the-thread-exists vs 404-if-not.
    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a member of this server' });

    // Cross-tenant guard: thread must belong to URL serverId before we touch the message.
    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { serverId: true, channelId: true },
    });
    if (!thread || thread.serverId !== serverId) return res.status(404).json({ error: 'Thread not found' });
    // (write): block reacting to a message in a thread in a private channel
    // the member cannot see. Visibility only; addReactions follows. Placed before
    // the message lookup so the 404 message-existence oracle also closes.
    {
      const gateInputs = await loadChannelForGate(thread.channelId, serverId);
      if (!gateInputs) return res.status(404).json({ error: 'Thread not found' });
      const vis = assertChannelVisible(permCtx, gateInputs.channel, gateInputs.chOverrides, gateInputs.catOverrides);
      if (!vis.ok) return res.status(404).json({ error: 'Thread not found' });
    }
    if (!hasPermission(permCtx,'addReactions')) return res.status(403).json({ error: 'Missing addReactions permission' });

    const msg = await prisma.threadMessage.findUnique({
      where: { id: messageId },
      select: { threadId: true },
    });
    if (!msg || msg.threadId !== threadId) return res.status(404).json({ error: 'Message not found' });

    await prisma.threadMessageReaction.upsert({
      where: { messageId_userId_emoji: { messageId, userId: req.userId, emoji } },
      create: { messageId, userId: req.userId, emoji },
      update: {},
    });

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`thread:${threadId}`).emit('thread-message-reaction-added', { messageId, threadId, emoji, userId: req.userId });

    res.json({ success: true });
  }),
);

// DELETE /api/v1/servers/:serverId/threads/:threadId/messages/:messageId/reactions/:emoji
router.delete(
  '/:serverId/threads/:threadId/messages/:messageId/reactions/:emoji',
  validateUuidParams('serverId', 'threadId', 'messageId'),
  authenticateToken,
  threadMsgLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const threadId = getParam(req, 'threadId');
    const messageId = getParam(req, 'messageId');
    const emoji = decodeURIComponent(getParam(req, 'emoji'));

    // Verify server membership
    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });
    // (write): mirror the POST-reaction twin. This handler never resolved the
    // thread, so a non-viewer could inject a thread-message-reaction-removed event
    // into a private channel's thread room. Add the cross-tenant guard + the
    // visibility gate on the thread's real channelId before the emit.
    {
      const thread = await prisma.thread.findUnique({ where: { id: threadId }, select: { serverId: true, channelId: true } });
      if (!thread || thread.serverId !== serverId) return res.status(404).json({ error: 'Thread not found' });
      const gateInputs = await loadChannelForGate(thread.channelId, serverId);
      if (!gateInputs) return res.status(404).json({ error: 'Thread not found' });
      const vis = assertChannelVisible(permCtx, gateInputs.channel, gateInputs.chOverrides, gateInputs.catOverrides);
      if (!vis.ok) return res.status(404).json({ error: 'Thread not found' });
    }

    // Bind messageId to the gated thread (mirrors the POST twin), so the visibility
    // gate on threadId is not bypassed by a messageId from another (private) thread.
    const msg = await prisma.threadMessage.findUnique({ where: { id: messageId }, select: { threadId: true } });
    if (!msg || msg.threadId !== threadId) return res.status(404).json({ error: 'Message not found' });

    await prisma.threadMessageReaction.deleteMany({
      where: { messageId, userId: req.userId, emoji },
    });

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`thread:${threadId}`).emit('thread-message-reaction-removed', { messageId, threadId, emoji, userId: req.userId });

    res.json({ success: true });
  }),
);

// Thread read state

const threadMarkReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:thread-mark-read:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

router.post('/:serverId/threads/:threadId/read', validateUuidParams('serverId', 'threadId'), authenticateToken, threadMarkReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const threadId = getParam(req, 'threadId');

  const [thread, member, permCtx] = await Promise.all([
    prisma.thread.findUnique({ where: { id: threadId }, select: { serverId: true, channelId: true } }),
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      select: { userId: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  // membership first (non-member → uniform 403, not 403-if-exists vs 404),
  // then the thread existence check.
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a server member' });
  if (!thread || thread.serverId !== serverId) return res.status(404).json({ error: 'Thread not found' });

  // mark-read is a READ-shaped op (it records "read up to here"), so gate on
  // the READABLE predicate, not just visibility — a member with viewChannels but
  // NOT readMessageHistory must not write a ThreadReadState for a thread they
  // cannot read. Map the readable-denied outcome to 404 too, so present-unreadable
  // and absent are indistinguishable (no 204/403-vs-404 existence oracle).
  const gate = await loadChannelForGate(thread.channelId, serverId);
  if (!gate) return res.status(404).json({ error: 'Thread not found' });
  const readable = assertChannelReadable(permCtx, gate.channel, gate.chOverrides, gate.catOverrides);
  if (!readable.ok) return res.status(404).json({ error: 'Thread not found' });

  await prisma.threadReadState.upsert({
    where: { userId_threadId: { userId: req.userId, threadId } },
    create: { userId: req.userId, threadId, lastReadAt: new Date(), mentionCount: 0 },
    update: { lastReadAt: new Date(), mentionCount: 0 },
  });

  res.status(204).send();
}));

export default router;
