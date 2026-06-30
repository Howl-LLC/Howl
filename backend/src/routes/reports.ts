// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { encryptSecret } from '../services/mfaCrypto.js';
import { decryptMessageContent } from '../services/dmCrypto.js';
import { stripControlChars } from '../schemas.js';
import { getClientIp } from '../utils/clientIp.js';

const router = Router();

const reportLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:report:'),
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many reports. Please wait before submitting another.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const VALID_REASONS = ['spam', 'harassment', 'csam', 'violence', 'other'] as const;

const reportMessageSchema = z.object({
  body: z.object({
    messageId: z.string().uuid('Invalid message ID format'),
    messageType: z.enum(['dm', 'channel']),
    channelId: z.string().uuid('Invalid channel ID format').optional(),
    dmChannelId: z.string().uuid('Invalid DM channel ID format').optional(),
    reason: z.enum(VALID_REASONS),
    details: z.string().max(1000).transform(stripControlChars).optional(),
    plaintext: z.string().max(10000).transform(stripControlChars).optional(),
  }).strict(),
});

router.post('/', authenticateToken, reportLimiter, validate(reportMessageSchema), asyncHandler(async (req, res: Response) => {
  const authReq = req as AuthRequest;
  if (!authReq.userId) return res.status(401).json({ error: 'Missing user' });

  const data = req.body as {
    messageId: string;
    messageType: 'dm' | 'channel';
    channelId?: string;
    dmChannelId?: string;
    reason: typeof VALID_REASONS[number];
    details?: string;
    plaintext?: string;
  };

  // Fetch the actual message from the database — never trust client-supplied content,
  // authorId, or attachmentUrl, as these could be fabricated to frame another user.
  let authorId: string;
  let content: string;
  let attachmentUrl: string | null;
  let contentSource = 'server';

  if (data.messageType === 'channel') {
    if (!data.channelId) {
      return res.status(400).json({ error: 'channelId is required for channel message reports' });
    }
    const channel = await prisma.channel.findUnique({
      where: { id: data.channelId },
      select: { serverId: true },
    });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const member = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: authReq.userId, serverId: channel.serverId } },
      select: { userId: true },
    });
    if (!member) return res.status(403).json({ error: 'You are not a member of this server' });

    const message = await prisma.message.findUnique({
      where: { id: data.messageId },
      select: { authorId: true, content: true, attachmentUrl: true, channelId: true },
    });
    if (!message || message.channelId !== data.channelId) {
      return res.status(404).json({ error: 'Message not found' });
    }
    authorId = message.authorId;
    content = message.content;
    attachmentUrl = message.attachmentUrl ?? null;
    // Channel messages are server-authoritative, so contentSource remains at
    // its default ('server').
  } else {
    if (!data.dmChannelId) {
      return res.status(400).json({ error: 'dmChannelId is required for DM message reports' });
    }
    const participant = await prisma.dMParticipant.findUnique({
      where: { userId_dmChannelId: { userId: authReq.userId, dmChannelId: data.dmChannelId } },
      select: { userId: true },
    });
    if (!participant) {
      return res.status(403).json({ error: 'You are not a participant in this DM' });
    }

    const [message, dmChannel] = await Promise.all([
      prisma.dMMessage.findUnique({
        where: { id: data.messageId },
        select: { authorId: true, content: true, contentIv: true, attachmentUrl: true, dmChannelId: true },
      }),
      prisma.dMChannel.findUnique({
        where: { id: data.dmChannelId },
        select: { encrypted: true },
      }),
    ]);
    if (!message || message.dmChannelId !== data.dmChannelId) {
      return res.status(404).json({ error: 'Message not found' });
    }
    authorId = message.authorId;
    attachmentUrl = message.attachmentUrl ?? null;

    if (dmChannel?.encrypted) {
      if (data.plaintext) {
        // E2E DM (MLS): the server cannot decrypt. The reporter voluntarily
        // disclosed their decrypted copy; store it marked reporter_disclosed.
        // There is no server-side cryptographic verification (the legacy
        // v2-envelope verification was removed with the X25519 scheme).
        content = data.plaintext;
        contentSource = 'reporter_disclosed';
      } else {
        content = '[E2E encrypted - content not disclosed at report time]';
        contentSource = 'unavailable';
      }
    } else {
      // Non-encrypted DM channel - server has plaintext
      content = decryptMessageContent(message);
      contentSource = 'server';
    }
  }

  if (authorId === authReq.userId) {
    return res.status(400).json({ error: 'You cannot report your own messages' });
  }

  const existing = await prisma.messageReport.findFirst({
    where: {
      reporterId: authReq.userId,
      messageId: data.messageId,
      status: { in: ['pending', 'reviewed'] },
    },
    select: { id: true },
  });
  if (existing) {
    return res.status(409).json({ error: 'You have already reported this message' });
  }

  // Snapshot the reported user's identity at report-create time so the
  // record survives a future self-delete by the accused. The User row is
  // SetNull on cascade; without these fields a 60-day-old user-reported
  // CSAM whose author has since deleted leaves admins with no identity to
  // act on. Username/discriminator/emailHash/createdAt are not privacy-
  // sensitive (the username is already public, emailHash is HMAC-keyed,
  // createdAt is on every public profile) — snapshotting just locks in
  // what was already accessible. Raw IP/UA capture stays gated behind
  // admin confirmation in adminReports.ts; that's the privacy-sensitive
  // dimension and we do not freeze it for unconfirmed accusations.
  const authorSnapshot = await prisma.user.findUnique({
    where: { id: authorId },
    select: { username: true, discriminator: true, emailHash: true, createdAt: true },
  }).catch(() => null);

  const report = await prisma.messageReport.create({
    data: {
      reporterId: authReq.userId,
      messageType: data.messageType,
      messageId: data.messageId,
      channelId: data.channelId || null,
      dmChannelId: data.dmChannelId || null,
      authorId,
      authorUsernameSnapshot: authorSnapshot?.username ?? null,
      authorDiscriminatorSnapshot: authorSnapshot?.discriminator ?? null,
      authorEmailHashSnapshot: authorSnapshot?.emailHash ?? null,
      authorRegisteredAtSnapshot: authorSnapshot?.createdAt ?? null,
      content: encryptSecret(content),
      attachmentUrl,
      reason: data.reason,
      details: data.details ? encryptSecret(data.details) : null,
      contentSource,
      // Mark §2258A preservation start at report submission for CSAM. For
      // other reasons preservation isn't legally required; admins can act
      // on those without the timestamp.
      preservedAt: data.reason === 'csam' ? new Date() : null,
    },
  });

  return res.status(201).json({ id: report.id, status: report.status });
}));

const myReportsLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:myreports:'),
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

router.get('/my', authenticateToken, myReportsLimiter, asyncHandler(async (req, res: Response) => {
  const authReq = req as AuthRequest;
  if (!authReq.userId) return res.status(401).json({ error: 'Missing user' });

  const reports = await prisma.messageReport.findMany({
    where: { reporterId: authReq.userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      messageType: true,
      reason: true,
      status: true,
      createdAt: true,
    },
  });

  return res.json(reports);
}));

export default router;
