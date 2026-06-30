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
import { getParam, hasPermission, loadPermissionContext, AUTHOR_USER_SELECT } from '../utils.js';
import { logger } from '../logger.js';
import { deleteUploadedFile } from './upload.js';
import { createAuditLog } from './serverSettings.js';
import { getMentionedUserIds } from './messages.js';
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

    const member = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
    });
    if (!member) return res.status(403).json({ error: 'Not a server member' });

    const threads = await prisma.thread.findMany({
      where: { serverId, archived: false, channel: { serverId, isPrivate: false } },
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
      prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, serverId: true, type: true } }),
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!channel || channel.serverId !== serverId) return res.status(404).json({ error: 'Channel not found' });
    if (channel.type !== 'text') return res.status(400).json({ error: 'Threads can only be created in text channels' });
    if (!member) return res.status(403).json({ error: 'Not a server member' });
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
    io?.to(`channel:${channelId}`).to(`server:${serverId}`).emit('thread-created', threadPayload);

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
    if (!hasPermission(permCtx,'readMessageHistory')) return res.status(403).json({ error: 'Missing readMessageHistory permission' });

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

    const member = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
    });
    if (!member) return res.status(403).json({ error: 'Not a server member' });

    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      include: {
        _count: { select: { messages: true } },
      },
    });
    if (!thread || thread.serverId !== serverId) return res.status(404).json({ error: 'Thread not found' });

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
      prisma.thread.findUnique({ where: { id: threadId }, select: { authorId: true, channelId: true, serverId: true } }),
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!thread || thread.channelId !== channelId || thread.serverId !== serverId) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    if (!member) return res.status(403).json({ error: 'Not a server member' });
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
      io?.to(`channel:${channelId}`).to(`server:${serverId}`).emit('thread-archived', payload);
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
    if (!thread || thread.channelId !== channelId || thread.serverId !== serverId) {
      return res.status(404).json({ error: 'Thread not found' });
    }
    if (!member) return res.status(403).json({ error: 'Not a server member' });
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
      prisma.thread.findUnique({ where: { id: threadId }, select: { id: true, serverId: true, channelId: true, archived: true } }),
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!thread || thread.serverId !== serverId) return res.status(404).json({ error: 'Thread not found' });
    if (thread.archived) return res.status(400).json({ error: 'Thread is archived' });
    if (!member) return res.status(403).json({ error: 'Not a server member' });
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
      getMentionedUserIds(prisma, contentStr, serverId).then(mentionUserIds => {
        const ids = mentionUserIds.filter(uid => uid !== req.userId);
        if (ids.length === 0) return;

        const authorName = author?.username ?? 'Someone';
        const preview = contentStr.length > 200 ? contentStr.slice(0, 200) + '…' : contentStr;
        const notifTitle = `${authorName} mentioned you in a thread`;

        // Emit server-channel-activity for the parent channel
        io.to(`server:${serverId}`).emit('server-channel-activity', {
          serverId, channelId: thread.channelId, messageId: msg.id, mentionUserIds: ids,
        });

        prisma.notification.createMany({
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
      }).catch(() => {});
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
    if (!hasPermission(permCtx,'readMessageHistory')) return res.status(403).json({ error: 'Missing readMessageHistory permission' });

    const thread = await prisma.thread.findUnique({ where: { id: threadId }, select: { serverId: true } });
    if (!thread || thread.serverId !== serverId) return res.status(404).json({ error: 'Thread not found' });

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

    // Cross-tenant guard: thread must belong to URL serverId before we touch the message.
    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { serverId: true, channelId: true },
    });
    if (!thread || thread.serverId !== serverId) return res.status(404).json({ error: 'Thread not found' });

    // Verify server membership
    const member = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
    });
    if (!member) return res.status(403).json({ error: 'Not a member of this server' });

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

    // Cross-tenant guard: thread must belong to URL serverId before we touch the message.
    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { serverId: true, channelId: true },
    });
    if (!thread || thread.serverId !== serverId) return res.status(404).json({ error: 'Thread not found' });

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
    if (!msg || msg.threadId !== threadId) return res.status(404).json({ error: 'Message not found' });
    if (!member) return res.status(403).json({ error: 'Not a server member' });

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

    // Cross-tenant guard: thread must belong to URL serverId before we touch the message.
    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { serverId: true, channelId: true },
    });
    if (!thread || thread.serverId !== serverId) return res.status(404).json({ error: 'Thread not found' });

    // Verify server membership + addReactions permission
    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a member of this server' });
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
    const member = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
    });
    if (!member) return res.status(403).json({ error: 'Not a member of this server' });

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

  const [thread, member] = await Promise.all([
    prisma.thread.findUnique({ where: { id: threadId }, select: { serverId: true } }),
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      select: { userId: true },
    }),
  ]);
  if (!thread || thread.serverId !== serverId) return res.status(404).json({ error: 'Thread not found' });
  if (!member) return res.status(403).json({ error: 'Not a server member' });

  await prisma.threadReadState.upsert({
    where: { userId_threadId: { userId: req.userId, threadId } },
    create: { userId: req.userId, threadId, lastReadAt: new Date(), mentionCount: 0 },
    update: { lastReadAt: new Date(), mentionCount: 0 },
  });

  res.status(204).send();
}));

export default router;
