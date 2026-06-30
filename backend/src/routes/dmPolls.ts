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
import { createPollSchema, editPollSchema, pollVoteSchema } from '../schemas.js';
import { getParam } from '../utils.js';
import { logger } from '../logger.js';
import { getClientIp } from '../utils/clientIp.js';

const log = logger.child({ module: 'dm-polls' });

// Rate limiters

const dmPollReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:dm-poll-read:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const dmPollMutationLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:dm-poll-mutate:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many poll actions. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const dmPollVoteLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:dm-poll-vote:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many votes. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

// Helpers

const POLL_INCLUDE = {
  options: { orderBy: { position: 'asc' as const } },
  votes: { select: { optionId: true, userId: true } },
};

function normalizePoll(poll: any, currentUserId: string) {
  const isExpired = poll.expiresAt && new Date(poll.expiresAt) <= new Date();
  const isClosed = !!poll.closedAt || isExpired;

  const optionVoteCounts = new Map<string, number>();
  const myVotes: string[] = [];
  let totalVotes = 0;

  for (const vote of poll.votes ?? []) {
    optionVoteCounts.set(vote.optionId, (optionVoteCounts.get(vote.optionId) ?? 0) + 1);
    totalVotes++;
    if (vote.userId === currentUserId) myVotes.push(vote.optionId);
  }

  return {
    id: poll.id,
    channelId: poll.channelId,
    dmChannelId: poll.dmChannelId,
    serverId: poll.serverId,
    authorId: poll.authorId,
    question: poll.question,
    allowMultiple: poll.allowMultiple,
    anonymous: poll.anonymous,
    duration: poll.duration,
    expiresAt: poll.expiresAt?.toISOString() ?? null,
    closedAt: poll.closedAt?.toISOString() ?? null,
    closed: isClosed,
    createdAt: poll.createdAt.toISOString(),
    options: poll.options.map((opt: any) => ({
      id: opt.id,
      text: opt.text,
      emoji: opt.emoji ?? null,
      position: opt.position,
      voteCount: optionVoteCounts.get(opt.id) ?? 0,
    })),
    myVotes,
    totalVotes,
  };
}

function isPollClosed(poll: { closedAt: Date | null; expiresAt: Date | null }): boolean {
  if (poll.closedAt) return true;
  if (poll.expiresAt && new Date(poll.expiresAt) <= new Date()) return true;
  return false;
}

async function verifyDmParticipant(userId: string, dmChannelId: string) {
  return prisma.dMParticipant.findUnique({
    where: { userId_dmChannelId: { userId, dmChannelId } },
    select: { userId: true },
  });
}

// Router

const router = Router();

// POST /api/v1/dms/:dmChannelId/polls
router.post(
  '/:dmChannelId/polls',
  validateUuidParams('dmChannelId'),
  authenticateToken,
  dmPollMutationLimiter,
  validate(createPollSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const dmChannelId = getParam(req, 'dmChannelId');

    const participant = await verifyDmParticipant(req.userId, dmChannelId);
    if (!participant) return res.status(403).json({ error: 'Not in this DM' });

    // Cap: max 50 active (non-closed, non-expired) polls per DM channel
    const activePollCount = await prisma.poll.count({
      where: { dmChannelId, closedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    });
    if (activePollCount >= 50) {
      return res.status(400).json({ error: 'Maximum of 50 active polls per channel' });
    }

    const { question, options: rawOptions, allowMultiple, anonymous, duration } = req.body as {
      question: string; options: (string | { text: string; emoji?: string })[]; allowMultiple: boolean; anonymous: boolean; duration: string;
    };

    // Normalize options: accept both string[] and { text, emoji }[] formats
    const normalizedOptions = rawOptions.map((opt) =>
      typeof opt === 'string' ? { text: opt, emoji: null } : { text: opt.text, emoji: opt.emoji ?? null }
    );

    const durationMinutes = duration === 'none' ? null : parseInt(duration, 10);
    const expiresAt = durationMinutes ? new Date(Date.now() + durationMinutes * 60 * 1000) : null;

    const poll = await prisma.poll.create({
      data: {
        dmChannelId,
        authorId: req.userId,
        question,
        allowMultiple,
        anonymous,
        duration: durationMinutes,
        expiresAt,
        options: {
          create: normalizedOptions.map((opt, i) => ({ text: opt.text, emoji: opt.emoji, position: i })),
        },
      },
      include: POLL_INCLUDE,
    });

    const normalized = normalizePoll(poll, req.userId);
    const io = req.app.get('io') as import('socket.io').Server | undefined;

    // Create a system DM message so the poll renders in the DM chat timeline
    const systemMsg = await prisma.dMMessage.create({
      data: {
        dmChannelId,
        authorId: req.userId,
        content: '',
        type: 'system',
        systemPayload: { kind: 'poll', pollId: poll.id },
      },
    });

    // Emit poll-created FIRST so channelPolls has the data before the system message triggers a render
    io?.to(`dm:${dmChannelId}`).emit('poll-created', normalized);

    const author = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, username: true, discriminator: true, avatar: true },
    });
    io?.to(`dm:${dmChannelId}`).emit('new-dm-message', {
      id: systemMsg.id,
      dmChannelId,
      authorId: req.userId,
      authorUsername: author?.username ?? 'Unknown',
      authorDiscriminator: author?.discriminator ?? '0000',
      authorAvatar: author?.avatar ?? null,
      content: '',
      type: 'system',
      systemPayload: { kind: 'poll', pollId: poll.id },
      createdAt: systemMsg.createdAt.toISOString(),
      editedAt: null,
      reactions: [],
      replyToMessageId: null,
      attachmentUrl: null,
      attachmentName: null,
      attachmentContentType: null,
      attachmentWidth: null,
      attachmentHeight: null,
      forwarded: false,
    });

    log.info({ userId: req.userId, pollId: poll.id, dmChannelId }, 'dm poll created');
    res.status(201).json(normalized);
  }),
);

// GET /api/v1/dms/:dmChannelId/polls
router.get(
  '/:dmChannelId/polls',
  validateUuidParams('dmChannelId'),
  authenticateToken,
  dmPollReadLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const dmChannelId = getParam(req, 'dmChannelId');

    const participant = await verifyDmParticipant(req.userId, dmChannelId);
    if (!participant) return res.status(403).json({ error: 'Not in this DM' });

    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const polls = await prisma.poll.findMany({
      where: { dmChannelId },
      include: POLL_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.json(polls.map((p) => normalizePoll(p, req.userId!)));
  }),
);

// GET /api/v1/dms/:dmChannelId/polls/:pollId
router.get(
  '/:dmChannelId/polls/:pollId',
  validateUuidParams('dmChannelId', 'pollId'),
  authenticateToken,
  dmPollReadLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const dmChannelId = getParam(req, 'dmChannelId');
    const pollId = getParam(req, 'pollId');

    const participant = await verifyDmParticipant(req.userId, dmChannelId);
    if (!participant) return res.status(403).json({ error: 'Not in this DM' });

    const poll = await prisma.poll.findUnique({
      where: { id: pollId },
      include: POLL_INCLUDE,
    });
    if (!poll || poll.dmChannelId !== dmChannelId) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    res.json(normalizePoll(poll, req.userId));
  }),
);

// POST /api/v1/dms/:dmChannelId/polls/:pollId/vote
router.post(
  '/:dmChannelId/polls/:pollId/vote',
  validateUuidParams('dmChannelId', 'pollId'),
  authenticateToken,
  dmPollVoteLimiter,
  validate(pollVoteSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const dmChannelId = getParam(req, 'dmChannelId');
    const pollId = getParam(req, 'pollId');
    const { optionId } = req.body as { optionId: string };

    const participant = await verifyDmParticipant(req.userId, dmChannelId);
    if (!participant) return res.status(403).json({ error: 'Not in this DM' });

    const poll = await prisma.poll.findUnique({
      where: { id: pollId },
      include: { options: { select: { id: true } } },
    });
    if (!poll || poll.dmChannelId !== dmChannelId) {
      return res.status(404).json({ error: 'Poll not found' });
    }
    if (isPollClosed(poll)) return res.status(400).json({ error: 'Poll is closed' });
    if (!poll.options.some((o) => o.id === optionId)) {
      return res.status(400).json({ error: 'Invalid option' });
    }

    const userId = req.userId!;
    await prisma.$transaction(async (tx) => {
      if (!poll.allowMultiple) {
        await tx.pollVote.deleteMany({ where: { pollId, userId } });
      }

      await tx.pollVote.upsert({
        where: { pollId_optionId_userId: { pollId, optionId, userId } },
        create: { pollId, optionId, userId },
        update: {},
      });
    }, { isolationLevel: 'Serializable' });

    const updated = await prisma.poll.findUnique({
      where: { id: pollId },
      include: POLL_INCLUDE,
    });
    const normalized = normalizePoll(updated, req.userId);

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`dm:${dmChannelId}`).emit('poll-vote-updated', {
      pollId,
      dmChannelId,
      options: normalized.options,
      totalVotes: normalized.totalVotes,
    });

    res.json(normalized);
  }),
);

// DELETE /api/v1/dms/:dmChannelId/polls/:pollId/vote/:optionId
router.delete(
  '/:dmChannelId/polls/:pollId/vote/:optionId',
  validateUuidParams('dmChannelId', 'pollId', 'optionId'),
  authenticateToken,
  dmPollVoteLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const dmChannelId = getParam(req, 'dmChannelId');
    const pollId = getParam(req, 'pollId');
    const optionId = getParam(req, 'optionId');

    const participant = await verifyDmParticipant(req.userId, dmChannelId);
    if (!participant) return res.status(403).json({ error: 'Not in this DM' });

    const poll = await prisma.poll.findUnique({
      where: { id: pollId },
      select: { dmChannelId: true, closedAt: true, expiresAt: true },
    });
    if (!poll || poll.dmChannelId !== dmChannelId) {
      return res.status(404).json({ error: 'Poll not found' });
    }
    if (isPollClosed(poll)) return res.status(400).json({ error: 'Poll is closed' });

    await prisma.pollVote.deleteMany({
      where: { pollId, optionId, userId: req.userId },
    });

    const updated = await prisma.poll.findUnique({
      where: { id: pollId },
      include: POLL_INCLUDE,
    });
    const normalized = normalizePoll(updated, req.userId);

    const io = req.app.get('io') as import('socket.io').Server | undefined;
    io?.to(`dm:${dmChannelId}`).emit('poll-vote-updated', {
      pollId,
      dmChannelId,
      options: normalized.options,
      totalVotes: normalized.totalVotes,
    });

    res.json(normalized);
  }),
);

// PATCH /api/v1/dms/:dmChannelId/polls/:pollId
router.patch(
  '/:dmChannelId/polls/:pollId',
  validateUuidParams('dmChannelId', 'pollId'),
  authenticateToken,
  dmPollMutationLimiter,
  validate(editPollSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const dmChannelId = getParam(req, 'dmChannelId');
    const pollId = getParam(req, 'pollId');

    const participant = await verifyDmParticipant(req.userId, dmChannelId);
    if (!participant) return res.status(403).json({ error: 'Not in this DM' });

    const poll = await prisma.poll.findUnique({
      where: { id: pollId },
      select: { authorId: true, dmChannelId: true },
    });
    if (!poll || poll.dmChannelId !== dmChannelId) {
      return res.status(404).json({ error: 'Poll not found' });
    }
    if (poll.authorId !== req.userId) {
      return res.status(403).json({ error: 'Only the poll creator can edit this poll' });
    }

    const { question, allowMultiple, anonymous, duration, closePoll } = req.body as {
      question?: string; allowMultiple?: boolean; anonymous?: boolean; duration?: string; closePoll?: boolean;
    };

    const data: Record<string, unknown> = { editedAt: new Date() };
    if (question !== undefined) data.question = question;
    if (allowMultiple !== undefined) data.allowMultiple = allowMultiple;
    if (anonymous !== undefined) data.anonymous = anonymous;
    if (duration !== undefined) {
      const mins = duration === 'none' ? null : parseInt(duration, 10);
      data.duration = mins;
      data.expiresAt = mins ? new Date(Date.now() + mins * 60 * 1000) : null;
    }
    if (closePoll) data.closedAt = new Date();

    const updated = await prisma.poll.update({
      where: { id: pollId },
      data,
      include: POLL_INCLUDE,
    });

    const normalized = normalizePoll(updated, req.userId);
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (closePoll) {
      io?.to(`dm:${dmChannelId}`).emit('poll-closed', { pollId });
    } else {
      io?.to(`dm:${dmChannelId}`).emit('poll-updated', normalized);
    }

    log.info({ userId: req.userId, pollId, action: closePoll ? 'close' : 'edit' }, 'dm poll updated');
    res.json(normalized);
  }),
);

// DELETE /api/v1/dms/:dmChannelId/polls/:pollId
router.delete(
  '/:dmChannelId/polls/:pollId',
  validateUuidParams('dmChannelId', 'pollId'),
  authenticateToken,
  dmPollMutationLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const dmChannelId = getParam(req, 'dmChannelId');
    const pollId = getParam(req, 'pollId');

    const participant = await verifyDmParticipant(req.userId, dmChannelId);
    if (!participant) return res.status(403).json({ error: 'Not in this DM' });

    const poll = await prisma.poll.findUnique({
      where: { id: pollId },
      select: { authorId: true, dmChannelId: true },
    });
    if (!poll || poll.dmChannelId !== dmChannelId) {
      return res.status(404).json({ error: 'Poll not found' });
    }
    if (poll.authorId !== req.userId) {
      return res.status(403).json({ error: 'Only the poll creator can delete this poll' });
    }

    await prisma.poll.delete({ where: { id: pollId } });

    // Delete the associated system DM message so "Loading poll…" doesn't linger
    const systemMsgs = await prisma.dMMessage.findMany({
      where: { dmChannelId, type: 'system' },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, systemPayload: true },
    });
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    for (const sm of systemMsgs) {
      const payload = sm.systemPayload as Record<string, unknown> | null;
      if (payload?.kind === 'poll' && payload?.pollId === pollId) {
        await prisma.dMMessage.delete({ where: { id: sm.id } }).catch(() => {});
        io?.to(`dm:${dmChannelId}`).emit('dm-message-deleted', { id: sm.id, dmChannelId });
        break;
      }
    }

    io?.to(`dm:${dmChannelId}`).emit('poll-deleted', { pollId });

    log.info({ userId: req.userId, pollId }, 'dm poll deleted');
    res.status(204).end();
  }),
);

// GET /api/v1/dms/:dmChannelId/polls/:pollId/options/:optionId/voters
router.get(
  '/:dmChannelId/polls/:pollId/options/:optionId/voters',
  validateUuidParams('dmChannelId', 'pollId', 'optionId'),
  authenticateToken,
  dmPollReadLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const dmChannelId = getParam(req, 'dmChannelId');
    const pollId = getParam(req, 'pollId');
    const optionId = getParam(req, 'optionId');

    const participant = await verifyDmParticipant(req.userId, dmChannelId);
    if (!participant) return res.status(403).json({ error: 'Not in this DM' });

    const poll = await prisma.poll.findUnique({
      where: { id: pollId },
      select: { dmChannelId: true, anonymous: true },
    });
    if (!poll || poll.dmChannelId !== dmChannelId) return res.status(404).json({ error: 'Poll not found' });
    if (poll.anonymous) return res.status(403).json({ error: 'Voter list is not available for anonymous polls' });

    const limit = Math.min(Number(req.query.limit) || 100, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const [voters, total] = await Promise.all([
      prisma.pollVote.findMany({
        where: { pollId, optionId },
        select: { userId: true, createdAt: true },
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'asc' },
      }),
      prisma.pollVote.count({ where: { pollId, optionId } }),
    ]);

    const userIds = voters.map((v) => v.userId);
    const users = userIds.length > 0
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, discriminator: true, avatar: true }, take: 100 })
      : [];
    const usersMap = new Map(users.map((u) => [u.id, u]));

    res.json({
      voters: voters.map((v) => ({ ...usersMap.get(v.userId), votedAt: v.createdAt })),
      total,
      limit,
      offset,
    });
  }),
);

export default router;
