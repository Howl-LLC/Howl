// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { prisma } from '../db.js';
import { type AdminAuthRequest } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { adminPollsQuery, adminPollActionSchema } from '../schemas.js';
import { logAction, validateUuidParam, adminLimiter } from './adminHelpers.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'adminPolls' });
const router = Router();

// GET /api/admin/polls
router.get('/polls', adminLimiter, validate(adminPollsQuery), async (req: AdminAuthRequest, res: Response) => {
  const q = (req.query.q as string || '').trim();
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const status = (req.query.status as string) || 'all';
  const limit = 50;
  const skip = (page - 1) * limit;

  const conditions: Prisma.PollWhereInput[] = [];

  if (q) {
    conditions.push({ question: { contains: q, mode: 'insensitive' } });
  }

  const now = new Date();
  if (status === 'active') {
    // active = not closed AND (no expiry OR expiry in future)
    conditions.push({
      closedAt: null,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    });
  } else if (status === 'closed') {
    // closed = closedAt set OR expiresAt in past
    conditions.push({
      OR: [
        { closedAt: { not: null } },
        { expiresAt: { lte: now } },
      ],
    });
  }

  const where: Prisma.PollWhereInput = conditions.length > 0 ? { AND: conditions } : {};

  const [polls, total] = await Promise.all([
    prisma.poll.findMany({
      where,
      include: {
        _count: { select: { votes: true, options: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.poll.count({ where }),
  ]);

  // Resolve author info
  const authorIds = [...new Set(polls.map(p => p.authorId))];
  const authors = authorIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, username: true, discriminator: true, avatar: true },
        take: 50,
      })
    : [];
  const authorMap = new Map(authors.map(u => [u.id, u]));

  // Resolve server info for channel-based polls
  const channelIds = polls.map(p => p.channelId).filter((id): id is string => !!id);
  const channels = channelIds.length > 0
    ? await prisma.channel.findMany({
        where: { id: { in: [...new Set(channelIds)] } },
        select: { id: true, name: true, server: { select: { id: true, name: true } } },
        take: 50,
      })
    : [];
  const channelMap = new Map(channels.map(c => [c.id, c]));

  res.json({
    polls: polls.map(p => {
      const channel = p.channelId ? channelMap.get(p.channelId) : null;
      return {
        id: p.id,
        question: p.question,
        allowMultiple: p.allowMultiple,
        anonymous: p.anonymous,
        expiresAt: p.expiresAt?.toISOString() || null,
        closedAt: p.closedAt?.toISOString() || null,
        createdAt: p.createdAt.toISOString(),
        voteCount: p._count.votes,
        optionCount: p._count.options,
        author: authorMap.get(p.authorId) || null,
        location: channel
          ? { type: 'server' as const, channelId: channel.id, channelName: channel.name, serverId: channel.server.id, serverName: channel.server.name }
          : p.dmChannelId
            ? { type: 'dm' as const, dmChannelId: p.dmChannelId }
            : { type: 'unknown' as const },
      };
    }),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

// PATCH /api/admin/polls/:pollId/close
router.patch('/polls/:pollId/close', adminLimiter, validate(adminPollActionSchema), async (req: AdminAuthRequest, res: Response) => {
  const pollId = validateUuidParam(req.params.pollId);
  if (!pollId) return res.status(400).json({ error: 'Invalid pollId format' });

  const poll = await prisma.poll.findUnique({
    where: { id: pollId },
    select: { id: true, authorId: true, question: true, closedAt: true },
  });
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (poll.closedAt) return res.status(400).json({ error: 'Poll is already closed' });

  await prisma.poll.update({
    where: { id: pollId },
    data: { closedAt: new Date() },
  });
  await logAction(req.adminId!, 'close_poll', poll.authorId, { pollId, question: poll.question });

  log.info({ adminId: req.adminId, pollId }, 'admin closed poll');
  res.json({ success: true });
});

// DELETE /api/admin/polls/:pollId
router.delete('/polls/:pollId', adminLimiter, validate(adminPollActionSchema), async (req: AdminAuthRequest, res: Response) => {
  const pollId = validateUuidParam(req.params.pollId);
  if (!pollId) return res.status(400).json({ error: 'Invalid pollId format' });

  const poll = await prisma.poll.findUnique({
    where: { id: pollId },
    select: { id: true, authorId: true, question: true },
  });
  if (!poll) return res.status(404).json({ error: 'Poll not found' });

  // Cascade: PollVote (via PollOption) and PollOption are cascade-deleted by Prisma
  await prisma.poll.delete({ where: { id: pollId } });
  await logAction(req.adminId!, 'delete_poll', poll.authorId, { pollId, question: poll.question });

  log.info({ adminId: req.adminId, pollId, question: poll.question }, 'admin deleted poll');
  res.json({ success: true });
});

export default router;
