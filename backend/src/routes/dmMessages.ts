// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { messageSendLimiter } from '../middleware/messageRateLimit.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { sendDmMessageSchema, editDmMessageSchema, getMessagesQuery, reactMessageSchema } from '../schemas.js';
import { getParam, AUTHOR_USER_SELECT, getEffectivePlan } from '../utils.js';
import { deleteUploadedFile } from './upload.js';
import { getUserIdsWithBlock, hasBlockBetween, getBlockStatus, hasFamilyDmRestriction, canUserDm, dmFetchLimiter } from './dmHelpers.js';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { encryptDmContent, decryptMessageContent } from '../services/dmCrypto.js';
import { getClientIp } from '../utils/clientIp.js';

const dmMutateLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:dm-msg-mutate:'),
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const router = Router();

/**
 * True iff the user is an ACTIVE participant of the channel (a DMParticipant row
 * with pendingRemoval === null). A member whose Remove has been authorized but
 * not yet committed (pendingRemoval set) is denied all message access.
 * Uses findFirst because the pendingRemoval filter is not part of the composite
 * unique key findUnique requires.
 */
async function isActiveDmParticipant(dmChannelId: string, userId: string): Promise<boolean> {
  const row = await prisma.dMParticipant.findFirst({
    where: { dmChannelId, userId, pendingRemoval: null },
    select: { userId: true },
  });
  return row !== null;
}

/**
 * Fan a single event out to a DM channel's participants while skipping any
 * socket whose user has a block with the sender (either direction). Mirrors
 * the `new-dm-message` send-path pattern: walk the dm: room with per-socket
 * userId checks (so multi-tab senders see the event), then `.except()` the
 * just-notified socket ids when emitting to participants' personal `user:`
 * rooms (so other devices receive it without duplicates).
 *
 * Caller can pass a tuple of (event, payload) pairs to emit multiple events
 * with one room scan + one .except() pass — used for the pin path which
 * emits both `dm-system-message` and `dm-message-pinned`.
 */
async function emitToDmExceptBlocked(
  io: import('socket.io').Server,
  dmChannelId: string,
  senderUserId: string,
  participantIds: readonly string[],
  events: ReadonlyArray<[event: string, payload: unknown]>,
): Promise<void> {
  const blockedSet = await getUserIdsWithBlock(senderUserId);
  // Exclude pendingRemoval members (kicked/leaving, row still present until
  // the Remove commit lands) from the realtime fan-out, the
  // same way the new-dm-message send path does. A pending-removal member is at
  // the pre-eviction epoch and must not receive edits/deletes/pins/reactions.
  const pendingRows = await prisma.dMParticipant.findMany({
    where: { dmChannelId, pendingRemoval: { not: null } },
    select: { userId: true },
    take: 200,
  });
  const pendingRemovalSet = new Set(pendingRows.map((p) => p.userId));
  const room = io.sockets.adapter.rooms.get(`dm:${dmChannelId}`);
  const notifiedSocketIds: string[] = [];
  if (room) {
    for (const socketId of room) {
      const socket = io.sockets.sockets.get(socketId);
      const uid = socket && (socket as unknown as { userId?: string }).userId;
      if (!uid || blockedSet.has(uid) || pendingRemovalSet.has(uid)) continue;
      for (const [event, payload] of events) {
        (socket as import('socket.io').Socket).emit(event, payload);
      }
      notifiedSocketIds.push(socketId);
    }
  }
  for (const pid of participantIds) {
    if (blockedSet.has(pid) || pendingRemovalSet.has(pid)) continue;
    const target = io.to(`user:${pid}`).except(notifiedSocketIds);
    for (const [event, payload] of events) {
      target.emit(event, payload);
    }
  }
}

// GET /api/dms/:dmChannelId/messages
router.get('/:dmChannelId/messages', validateUuidParams('dmChannelId'), authenticateToken, dmFetchLimiter, validate(getMessagesQuery), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');
  if (!(await isActiveDmParticipant(dmChannelId, req.userId))) return res.status(403).json({ error: 'Not in this DM' });
  const channel = await prisma.dMChannel.findUnique({
    where: { id: dmChannelId },
    include: { participants: { include: { user: { select: AUTHOR_USER_SELECT } } } },
  });
  const others = channel?.participants.filter((p) => p.userId !== req.userId).map((p) => p.user) ?? [];
  const isGroup = channel?.isGroup ?? false;
  let blockStatus: { blockedByMe?: boolean; blockedByThem?: boolean; blockedParticipantIds?: string[] } = {};
  if (!isGroup && others[0]) {
    const status = await getBlockStatus(req.userId, others[0].id);
    blockStatus = { blockedByMe: status.blockedByMe, blockedByThem: status.blockedByThem };
  } else if (isGroup) {
    const blockedSet = await getUserIdsWithBlock(req.userId);
    blockStatus = { blockedParticipantIds: others.filter((u) => blockedSet.has(u.id)).map((u) => u.id) };
  }

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const before = req.query.before as string | undefined;
  const around = req.query.around as string | undefined;

  const blockedAuthors = isGroup && blockStatus.blockedParticipantIds?.length
    ? blockStatus.blockedParticipantIds
    : null;
  const blockedFilter = blockedAuthors ? { authorId: { notIn: blockedAuthors } } : {};

  let list: any[];
  let hasMore: boolean;
  let hasMoreNewer = false;

  if (around) {
    // Jump-to-message: fetch a window centered on the target. `findFirst` with
    // `dmChannelId` baked into WHERE returns 404 for cross-channel targets.
    const target = await prisma.dMMessage.findFirst({
      where: { id: around, dmChannelId },
      select: { createdAt: true },
    });
    if (!target) return res.status(404).json({ error: 'Message not found' });
    const half = Math.floor(limit / 2);
    const [beforeRows, afterRows] = await Promise.all([
      prisma.dMMessage.findMany({
        where: { dmChannelId, createdAt: { lt: target.createdAt }, ...blockedFilter },
        orderBy: { createdAt: 'desc' },
        take: half + 1,
      }),
      prisma.dMMessage.findMany({
        // gte includes the target. We deliberately do NOT apply blockedFilter here so the
        // user can still reach the explicitly-navigated message even if its author is blocked
        // in this group DM. The block filter is reapplied below to surrounding-after messages.
        where: { dmChannelId, createdAt: { gte: target.createdAt } },
        orderBy: { createdAt: 'asc' },
        take: half + 1,
      }),
    ]);
    hasMore = beforeRows.length > half;
    if (hasMore) beforeRows.pop();
    hasMoreNewer = afterRows.length > half;
    if (hasMoreNewer) afterRows.pop();
    const afterFiltered = blockedAuthors
      ? afterRows.filter((m) => m.id === around || !blockedAuthors.includes(m.authorId))
      : afterRows;
    beforeRows.reverse();
    list = [...beforeRows, ...afterFiltered];
  } else {
    const whereClause: any = { dmChannelId, ...blockedFilter };
    if (before) {
      const cursor = await prisma.dMMessage.findUnique({ where: { id: before }, select: { createdAt: true } });
      if (cursor) {
        whereClause.createdAt = { lt: cursor.createdAt };
      }
    }

    list = await prisma.dMMessage.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    hasMore = list.length > limit;
    if (hasMore) list.pop();
    list.reverse();
  }

  const authorIds = [...new Set(list.map((m) => m.authorId))];
  const replyToIds = list.map((m) => m.replyToMessageId).filter(Boolean) as string[];
  const [authors, replyToMessages, pinnedRows] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: authorIds } }, select: AUTHOR_USER_SELECT }),
    replyToIds.length ? prisma.dMMessage.findMany({ where: { id: { in: replyToIds }, dmChannelId } }) : [],
    prisma.dMPinnedMessage.findMany({ where: { dmChannelId }, select: { messageId: true }, take: 200 }),
  ]);
  const authorMap = Object.fromEntries(authors.map((u) => [u.id, u]));
  const replyToMap = Object.fromEntries(replyToMessages.map((r) => [r.id, r]));
  const replyToAuthorIds = [...new Set(replyToMessages.map((r) => r.authorId))];
  const replyToAuthors = replyToAuthorIds.length ? await prisma.user.findMany({ where: { id: { in: replyToAuthorIds } }, select: AUTHOR_USER_SELECT }) : [];
  const replyToAuthorMap = Object.fromEntries(replyToAuthors.map((u) => [u.id, u]));
  const pinnedMessageIds = pinnedRows.map((p) => p.messageId);
  if (!channel) return res.status(404).json({ error: 'DM channel not found' });
  const isEncrypted = channel.encrypted;

  // Batch-fetch reactions for all messages
  const dmMsgIds = list.map(m => m.id);
  const dmReactionRows = dmMsgIds.length ? await prisma.dMMessageReaction.findMany({
    where: { messageId: { in: dmMsgIds } },
    select: { messageId: true, emoji: true, userId: true },
    orderBy: { createdAt: 'asc' },
    take: 5000,
  }) : [];
  const dmReactionsByMsg = new Map<string, Array<{ emoji: string; userIds: string[] }>>();
  for (const r of dmReactionRows) {
    if (!dmReactionsByMsg.has(r.messageId)) dmReactionsByMsg.set(r.messageId, []);
    const msgReactions = dmReactionsByMsg.get(r.messageId)!;
    const existing = msgReactions.find(x => x.emoji === r.emoji);
    if (existing) existing.userIds.push(r.userId);
    else msgReactions.push({ emoji: r.emoji, userIds: [r.userId] });
  }

  res.json({
    blockStatus,
    pinnedMessageIds,
    hasMore,
    hasMoreNewer,
    encrypted: isEncrypted,
    messages: list.map((m) => {
      const author = authorMap[m.authorId];
      const replyTo = m.replyToMessageId ? (() => {
        const ref = replyToMap[m.replyToMessageId!];
        if (!ref) return null;
        const refAuthor = replyToAuthorMap[ref.authorId];
        return { id: ref.id, authorId: ref.authorId, authorUsername: refAuthor?.username ?? null, content: ref.encryptionVersion >= 2 ? ref.content : decryptMessageContent(ref) };
      })() : null;
      return {
        id: m.id,
        dmChannelId: m.dmChannelId,
        authorId: m.authorId,
        content: m.encryptionVersion >= 2 ? m.content : decryptMessageContent(m),
        type: m.type ?? 'message',
        encrypted: isEncrypted,
        systemPayload: m.systemPayload ?? null,
        createdAt: m.createdAt.toISOString(),
        editedAt: m.editedAt?.toISOString() ?? null,
        authorUsername: author?.username ?? null,
        authorDiscriminator: author?.discriminator ?? null,
        authorAvatar: author?.avatar ?? null,
        authorStripePlan: author ? getEffectivePlan(author) : null,
        authorNameColor: author?.nameColor ?? null,
        authorNameFont: author?.nameFont ?? null,
        authorNameEffect: author?.nameEffect ?? null,
        authorAvatarEffect: author?.avatarEffect ?? null,
        replyTo,
        attachmentUrl: m.attachmentUrl ?? null,
        attachmentName: m.attachmentName ?? null,
        attachmentContentType: m.attachmentContentType ?? null,
        attachmentWidth: m.attachmentWidth ?? null,
        attachmentHeight: m.attachmentHeight ?? null,
        attachmentIsSpoiler: m.attachmentIsSpoiler,
        attachmentAlt: m.attachmentAlt ?? null,
        forwarded: m.forwarded ?? false,
        reactions: dmReactionsByMsg.get(m.id) ?? [],
      };
    }),
  });
}));

// POST /api/dms/:dmChannelId/messages
router.post('/:dmChannelId/messages', validateUuidParams('dmChannelId'), authenticateToken, messageSendLimiter, validate(sendDmMessageSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');
  // Strip Unicode control/BiDi characters from non-encrypted content (encrypted content is opaque ciphertext)
  if (!req.body.encrypted && typeof req.body.content === 'string') {
    // eslint-disable-next-line no-misleading-character-class -- intentional Unicode control/BiDi ranges
    req.body.content = req.body.content.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD\u034F\u180E\uFFF9-\uFFFB]/g, '');
  }
  const { content, replyToMessageId, attachmentUrl, attachmentName, attachmentContentType, attachmentWidth, attachmentHeight, attachmentIsSpoiler: bodyIsSpoiler, attachmentAlt: bodyAlt, forwarded } = req.body as {
    content?: string; replyToMessageId?: string;
    attachmentUrl?: string; attachmentName?: string; attachmentContentType?: string;
    attachmentWidth?: number; attachmentHeight?: number;
    attachmentIsSpoiler?: boolean;
    attachmentAlt?: string;
    forwarded?: boolean;
  };
  const resolvedIsSpoiler = bodyIsSpoiler ?? false;
  // Alt text: trim, treat empty string as null
  const resolvedAlt = typeof bodyAlt === 'string' && bodyAlt.trim().length > 0 ? bodyAlt.trim() : null;
  const [isActive, channel] = await Promise.all([
    isActiveDmParticipant(dmChannelId, req.userId!),
    prisma.dMChannel.findUnique({
      where: { id: dmChannelId },
      include: { participants: true },
    }),
  ]);
  if (!isActive) return res.status(403).json({ error: 'Not in this DM' });
  if (!channel) return res.status(404).json({ error: 'DM channel not found' });
  const isEncryptedChannel = channel.encrypted;
  let contentTrimmed = isEncryptedChannel
    ? (typeof content === 'string' ? content : '')
    : (typeof content === 'string' ? content.trim() : '');
  if (!contentTrimmed && !attachmentUrl) return res.status(400).json({ error: 'Content or attachment is required' });

  if (attachmentUrl) {
    const isLocalUpload = /^\/api\/uploads\//.test(attachmentUrl);
    let isAllowedOrigin = false;
    if (!isLocalUpload) {
      try {
        const backendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5000';
        const parsed = new URL(attachmentUrl);
        const TRUSTED_MEDIA_ORIGINS = ['https://static.klipy.com'];
        isAllowedOrigin = backendOrigin.split(',').some((o) => {
          try { return new URL(o.trim()).origin === parsed.origin; } catch { return false; }
        });
        if (!isAllowedOrigin) {
          isAllowedOrigin = TRUSTED_MEDIA_ORIGINS.includes(parsed.origin);
        }
      } catch { /* invalid URL */ }
    }
    if (!isLocalUpload && !isAllowedOrigin) {
      return res.status(400).json({ error: 'Attachment URL must be a server upload path or match the backend origin' });
    }
  }

  const otherParticipantIds = channel?.participants.filter((p) => p.userId !== req.userId).map((p) => p.userId) ?? [];
  const isGroup = channel?.isGroup ?? false;
  if (!isGroup && otherParticipantIds[0]) {
    const other = otherParticipantIds[0];
    const [blocked, famRestrict1, famRestrict2, canDm] = await Promise.all([
      hasBlockBetween(req.userId, other),
      hasFamilyDmRestriction(req.userId, other),
      hasFamilyDmRestriction(other, req.userId),
      canUserDm(req.userId, other),
    ]);
    if (blocked) {
      const iBlockedThem = await prisma.block.findUnique({
        where: { blockerId_blockedUserId: { blockerId: req.userId, blockedUserId: other } },
        select: { id: true },
      });
      return res.status(403).json({
        error: iBlockedThem ? 'You have blocked this user' : 'This user has blocked you',
      });
    }
    if (famRestrict1) {
      return res.status(403).json({ error: 'A parent account has restricted DMs to friends only.' });
    }
    if (famRestrict2) {
      return res.status(403).json({ error: "This user's privacy settings prevent you from messaging them." });
    }
    if (!canDm) {
      return res.status(403).json({ error: "This user's privacy settings prevent you from messaging them." });
    }
  }
  // Group DMs: writes are allowed regardless of any block between the actor
  // and another participant. The bidirectional invariant is enforced on the
  // emit side (`emitToDmExceptBlocked` / inline `getUserIdsWithBlock` filter
  // below) and on the read side (history + pins filters), so blocked pairs
  // never see each other's actions while both can still participate with the
  // unblocked members of the group. Discord/Slack/Messenger semantics.

  // Validate custom emoji usage in DMs (all custom emojis in DMs are cross-server, requires Essential+)
  if (contentTrimmed && !isEncryptedChannel) {
    const emojiPattern = /:([a-zA-Z0-9_]+):/g;
    const emojiNames = new Set<string>();
    let em: RegExpExecArray | null;
    while ((em = emojiPattern.exec(contentTrimmed)) !== null) emojiNames.add(em[1]);

    if (emojiNames.size > 0) {
      const existing = await prisma.customEmoji.findMany({
        where: { name: { in: [...emojiNames] } },
        select: { name: true },
      });
      const existingNames = new Set(existing.map((e) => e.name));

      if (existingNames.size > 0) {
        const sender = await prisma.user.findUnique({ where: { id: req.userId! }, select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true } });
        const senderPlan = sender ? getEffectivePlan(sender) : 'free';
        if (senderPlan !== 'essential' && senderPlan !== 'pro') {
          const stripped = contentTrimmed.replace(/:([a-zA-Z0-9_]+):/g, (full, name) =>
            existingNames.has(name) ? '' : full
          ).trim();
          if (stripped || attachmentUrl) contentTrimmed = stripped;
        }
      }
    }
  }

  // Reject plaintext forwarded into an encrypted channel — the client must
  // encrypt forwarded content before sending. Accept v2 or v3 envelopes
  // (v3 binds a per-message id into the CLIENT envelope's AAD — not the server
  // `dmCrypto.ts` at-rest codec, which binds none), OR a v4 MLS
  // envelope ({v:4,m:<wire MLSMessage>}). Same v2/v3-only pre-MLS gap as the
  // edit path: without v4 here, forwarding any message into an MLS DM 400s.
  if (isEncryptedChannel && forwarded && contentTrimmed) {
    try {
      const parsed = JSON.parse(contentTrimmed);
      const hasIvCt = typeof parsed?.iv === 'string' && typeof parsed?.ct === 'string';
      const isV2 = parsed?.v === 2 && hasIvCt;
      const isV3 = parsed?.v === 3 && hasIvCt && typeof parsed?.mid === 'string' && parsed.mid.length > 0;
      const isV4 = parsed?.v === 4 && typeof parsed?.m === 'string' && parsed.m.length > 0;
      if (!isV2 && !isV3 && !isV4) {
        return res.status(400).json({ error: 'Forwarded messages to encrypted channels must be encrypted' });
      }
    } catch {
      return res.status(400).json({ error: 'Forwarded messages to encrypted channels must be encrypted' });
    }
  }

  let replyRef: { id: string; authorId: string } | null = null;
  if (replyToMessageId) {
    replyRef = await prisma.dMMessage.findFirst({ where: { id: replyToMessageId, dmChannelId }, select: { id: true, authorId: true } });
    if (!replyRef) return res.status(400).json({ error: 'Reply target message not found' });
  }
  // Encrypted channels require E2E — reject plaintext submissions
  if (isEncryptedChannel && !req.body.encrypted) {
    return res.status(400).json({ error: 'This channel requires end-to-end encryption. Please update your client.' });
  }
  const isE2eMessage = !!(req.body.encrypted && isEncryptedChannel);
  // For non-E2E messages (non-encrypted channels only), encrypt at rest with server key
  const serverEncrypted = (contentTrimmed && !isE2eMessage) ? encryptDmContent(contentTrimmed) : null;
  const message = await prisma.dMMessage.create({
    data: {
      dmChannelId,
      authorId: req.userId,
      content: serverEncrypted ? serverEncrypted.ciphertext : contentTrimmed,
      contentIv: serverEncrypted ? serverEncrypted.iv : null,
      encryptionVersion: isE2eMessage ? 2 : 1,
      replyToMessageId: replyToMessageId || null,
      attachmentUrl: attachmentUrl || null,
      attachmentName: attachmentName || null,
      attachmentContentType: attachmentContentType || null,
      attachmentWidth: attachmentWidth ?? null,
      attachmentHeight: attachmentHeight ?? null,
      attachmentIsSpoiler: resolvedIsSpoiler,
      attachmentAlt: resolvedAlt,
      forwarded: !!forwarded,
    },
  });
  const [author, replyToMsg, replyToAuthor] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.userId }, select: AUTHOR_USER_SELECT }),
    message.replyToMessageId ? prisma.dMMessage.findUnique({ where: { id: message.replyToMessageId } }) : null,
    replyRef ? prisma.user.findUnique({ where: { id: replyRef.authorId }, select: AUTHOR_USER_SELECT }) : null,
  ]);
  const payload = {
    id: message.id,
    dmChannelId: message.dmChannelId,
    authorId: message.authorId,
    content: contentTrimmed,
    createdAt: message.createdAt.toISOString(),
    authorUsername: author?.username ?? null,
    authorDiscriminator: author?.discriminator ?? null,
    authorAvatar: author?.avatar ?? null,
    authorStripePlan: author ? getEffectivePlan(author) : null,
    authorNameColor: author?.nameColor ?? null,
    authorNameFont: author?.nameFont ?? null,
    authorNameEffect: author?.nameEffect ?? null,
    authorAvatarEffect: author?.avatarEffect ?? null,
    replyTo: message.replyToMessageId && replyToMsg ? { id: replyToMsg.id, authorId: replyToMsg.authorId, authorUsername: replyToAuthor?.username ?? null, content: replyToMsg.encryptionVersion >= 2 ? replyToMsg.content : decryptMessageContent(replyToMsg) } : null,
    attachmentUrl: message.attachmentUrl ?? null,
    attachmentName: message.attachmentName ?? null,
    attachmentContentType: message.attachmentContentType ?? null,
    attachmentWidth: message.attachmentWidth ?? null,
    attachmentHeight: message.attachmentHeight ?? null,
    attachmentIsSpoiler: message.attachmentIsSpoiler,
    attachmentAlt: message.attachmentAlt ?? null,
    forwarded: message.forwarded,
    encrypted: isEncryptedChannel,
  };
  const io = req.app.get('io') as import('socket.io').Server;
  if (io) {
    const room = io.sockets.adapter.rooms.get(`dm:${dmChannelId}`);
    const blockedSet = await getUserIdsWithBlock(req.userId);
    // A member marked pendingRemoval (kicked/leaving, row still present
    // until the MLS Remove commit lands) is still at the
    // pre-eviction epoch and could decrypt anything delivered to them. Drop
    // them from the realtime fan-out recipient set — both the dm: room loop
    // and the user: room fallback (the kick route only socketsLeave's the dm:
    // room, not the personal user: room). Persistence is unaffected.
    const pendingRemovalSet = new Set(
      channel.participants.filter((p) => p.pendingRemoval !== null).map((p) => p.userId),
    );
    const notifiedSocketIds: string[] = [];

    // Emit to all sockets in the dm: room — including sender's other devices.
    if (room) {
      for (const socketId of room) {
        const socket = io.sockets.sockets.get(socketId);
        const uid = socket && (socket as unknown as { userId?: string }).userId;
        if (uid && !blockedSet.has(uid) && !pendingRemovalSet.has(uid)) {
          (socket as import('socket.io').Socket).emit('new-dm-message', payload);
          notifiedSocketIds.push(socketId);
        }
      }
    }

    // Fallback: emit to each participant's personal user: room for devices
    // not in the dm: room. Uses .except() to skip sockets already notified
    // above, ensuring multi-device delivery without duplicates.
    const allParticipantIds = channel.participants.map((p) => p.userId);
    for (const pid of allParticipantIds) {
      if (!blockedSet.has(pid) && !pendingRemovalSet.has(pid)) {
        io.to(`user:${pid}`).except(notifiedSocketIds).emit('new-dm-message', payload);
      }
    }
  }

  // Group DM @mention tracking (skip for encrypted channels — content is opaque)
  if (isGroup && !isEncryptedChannel && contentTrimmed) {
    // eslint-disable-next-line security/detect-unsafe-regex
    const MENTION_REGEX = /@(?:<([^>]+)>|(everyone|here|[a-zA-Z0-9_]{1,32}(?:#\d{4})?))/gi;
    const mentions = [...contentTrimmed.matchAll(MENTION_REGEX)].map((m: RegExpMatchArray) => (m[1] || m[2] || '').toLowerCase());
    if (mentions.length > 0) {
      (async () => {
        const participantUserIds = channel.participants.map(p => p.userId).filter(uid => uid !== req.userId);
        if (participantUserIds.length === 0) return;
        const users = await prisma.user.findMany({
          where: { id: { in: participantUserIds } },
          select: { id: true, username: true, discriminator: true },
          take: 50,
        });
        const resolvedIds: string[] = [];
        for (const tag of mentions) {
          if (tag.includes('#')) {
            const idx = tag.lastIndexOf('#');
            const uname = tag.slice(0, idx).toLowerCase();
            const disc = tag.slice(idx + 1);
            const match = users.find(u => u.username.toLowerCase() === uname && (u.discriminator ?? '').padStart(4, '0') === disc.padStart(4, '0'));
            if (match && !resolvedIds.includes(match.id)) resolvedIds.push(match.id);
          } else if (tag !== 'everyone' && tag !== 'here') {
            const match = users.find(u => u.username.toLowerCase() === tag);
            if (match && !resolvedIds.includes(match.id)) resolvedIds.push(match.id);
          }
        }
        if (resolvedIds.length === 0) return;
        // A pendingRemoval member (kicked/leaving, row still present until the
        // MLS Remove commit lands) must not get mention counts/badges during
        // the eviction window. Mirrors the new-dm-message fan-out exclusion
        // above and the read-path closure. Reuses the in-memory participant
        // snapshot (no extra query).
        const removedSet = new Set(
          channel.participants.filter((p) => p.pendingRemoval !== null).map((p) => p.userId),
        );
        const activeIds = resolvedIds.filter((id) => !removedSet.has(id));
        if (activeIds.length === 0) return;
        for (const uid of activeIds) {
          prisma.dMParticipant.update({
            where: { userId_dmChannelId: { userId: uid, dmChannelId } },
            data: { mentionCount: { increment: 1 } },
          }).catch(() => {});
        }
        if (io) {
          // Emit to anyone currently in the dm: room (active conversation viewers)
          const mentionRoom = io.sockets.adapter.rooms.get(`dm:${dmChannelId}`);
          const notifiedSocketIds = mentionRoom ? Array.from(mentionRoom) : [];
          io.to(`dm:${dmChannelId}`).emit('dm-mention', { dmChannelId, mentionUserIds: activeIds });
          // Fallback: also reach each mentioned user's personal user: room so the
          // mention badge fires for devices that aren't currently in the dm: room.
          // .except() dedupes against sockets already notified above.
          for (const uid of activeIds) {
            io.to(`user:${uid}`).except(notifiedSocketIds).emit('dm-mention', { dmChannelId, mentionUserIds: activeIds });
          }
        }
      })().catch(() => {});
    }
  }

  res.status(201).json(payload);
}));

// GET /api/dms/:dmChannelId/pins – list pinned messages in this DM
router.get('/:dmChannelId/pins', validateUuidParams('dmChannelId'), authenticateToken, dmFetchLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');
  if (!(await isActiveDmParticipant(dmChannelId, req.userId))) return res.status(403).json({ error: 'Not in this DM' });
  const [channel, pins] = await Promise.all([
    prisma.dMChannel.findUnique({ where: { id: dmChannelId }, select: { encrypted: true, isGroup: true } }),
    prisma.dMPinnedMessage.findMany({
      where: { dmChannelId },
      orderBy: { pinnedAt: 'asc' },
      take: 200,
    }),
  ]);
  // Mirror the history-fetch filter (GET /:dmChannelId/messages above): in a
  // group DM, drop pinned messages authored by anyone the caller has a block
  // with (either direction). Fail-open on the lookup — if the block table
  // query throws, the existing pin behavior is preserved.
  const blockedAuthorIdsForPins = channel?.isGroup
    ? [...(await getUserIdsWithBlock(req.userId))]
    : [];
  const messageIds = pins.map((p) => p.messageId);
  const messages = messageIds.length
    ? await prisma.dMMessage.findMany({
        where: blockedAuthorIdsForPins.length
          ? { id: { in: messageIds }, dmChannelId, authorId: { notIn: blockedAuthorIdsForPins } }
          : { id: { in: messageIds }, dmChannelId },
      })
    : [];
  const msgMap = new Map(messages.map((m) => [m.id, m]));
  const authorIds = [...new Set(messages.map((m) => m.authorId))];
  const authors = await prisma.user.findMany({ where: { id: { in: authorIds } }, select: AUTHOR_USER_SELECT });
  const authorMap = Object.fromEntries(authors.map((u) => [u.id, u]));
  const list = pins.map((p) => {
    const msg = msgMap.get(p.messageId);
    if (!msg) return null;
    const author = authorMap[msg.authorId];
    return {
      id: msg.id,
      dmChannelId: msg.dmChannelId,
      authorId: msg.authorId,
      content: msg.encryptionVersion >= 2 ? msg.content : decryptMessageContent(msg),
      createdAt: msg.createdAt.toISOString(),
      editedAt: msg.editedAt?.toISOString() ?? null,
      authorUsername: author?.username ?? null,
      authorDiscriminator: author?.discriminator ?? null,
      authorAvatar: author?.avatar ?? null,
      authorStripePlan: author ? getEffectivePlan(author) : null,
      authorNameColor: author?.nameColor ?? null,
      authorNameFont: author?.nameFont ?? null,
      authorNameEffect: author?.nameEffect ?? null,
      authorAvatarEffect: author?.avatarEffect ?? null,
      attachmentUrl: msg.attachmentUrl ?? null,
      attachmentName: msg.attachmentName ?? null,
      attachmentContentType: msg.attachmentContentType ?? null,
      attachmentWidth: msg.attachmentWidth ?? null,
      attachmentHeight: msg.attachmentHeight ?? null,
      attachmentIsSpoiler: msg.attachmentIsSpoiler,
      attachmentAlt: msg.attachmentAlt ?? null,
      forwarded: msg.forwarded ?? false,
      pinnedAt: p.pinnedAt.toISOString(),
      pinnedById: p.pinnedById,
    };
  }).filter(Boolean);
  if (!channel) return res.status(404).json({ error: 'DM channel not found' });
  res.json({ pins: list, encrypted: channel.encrypted });
}));

// POST /api/dms/:dmChannelId/messages/:messageId/pin
router.post('/:dmChannelId/messages/:messageId/pin', validateUuidParams('dmChannelId', 'messageId'), authenticateToken, dmMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');
  const messageId = getParam(req, 'messageId');
  if (!(await isActiveDmParticipant(dmChannelId, req.userId))) return res.status(403).json({ error: 'Not in this DM' });
  const pinChannel = await prisma.dMChannel.findUnique({
    where: { id: dmChannelId },
    select: { isGroup: true, encrypted: true, participants: { select: { userId: true } } },
  });
  if (pinChannel && !pinChannel.isGroup) {
    const otherId = pinChannel.participants.find(p => p.userId !== req.userId)?.userId;
    if (otherId) {
      const blocked = await hasBlockBetween(req.userId, otherId);
      if (blocked) return res.status(403).json({ error: 'Cannot modify pins in this conversation' });
    }
  }
  // Group DMs: no block veto — emit fan-out below filters blocked pairs.
  const message = await prisma.dMMessage.findFirst({
    where: { id: messageId, dmChannelId },
  });
  if (!message) return res.status(404).json({ error: 'Message not found' });
  const MAX_PINS_PER_DM = 50;
  const existingPin = await prisma.dMPinnedMessage.findUnique({ where: { dmChannelId_messageId: { dmChannelId, messageId } } });
  if (!existingPin) {
    const pinCount = await prisma.dMPinnedMessage.count({ where: { dmChannelId } });
    if (pinCount >= MAX_PINS_PER_DM) {
      return res.status(400).json({ error: `Cannot pin more than ${MAX_PINS_PER_DM} messages in a conversation.` });
    }
  }
  await prisma.dMPinnedMessage.upsert({
    where: { dmChannelId_messageId: { dmChannelId, messageId } },
    create: { dmChannelId, messageId, pinnedById: req.userId },
    update: { pinnedById: req.userId, pinnedAt: new Date() },
  });
  const systemPayload = { kind: 'pin', messageId };
  const pinPlaintext = 'pinned a message';
  const pinEnc = pinChannel?.encrypted ? null : encryptDmContent(pinPlaintext);
  const rows = await prisma.$queryRaw<
    Array<{ id: string; dmChannelId: string; authorId: string; content: string; contentIv: string | null; type: string; systemPayload: unknown; createdAt: Date }>
  >(Prisma.sql`
    INSERT INTO "DMMessage" (id, "dmChannelId", "authorId", content, "contentIv", type, "systemPayload", "createdAt")
    VALUES (gen_random_uuid(), ${dmChannelId}, ${req.userId}, ${pinEnc ? pinEnc.ciphertext : pinPlaintext}, ${pinEnc ? pinEnc.iv : null}, 'system', ${JSON.stringify(systemPayload)}::jsonb, NOW())
    RETURNING id, "dmChannelId", "authorId", content, "contentIv", type, "systemPayload", "createdAt"
  `);
  const systemMessage = rows[0];
  if (!systemMessage) {
    return res.status(500).json({ error: 'Failed to create system message' });
  }
  const author = await prisma.user.findUnique({ where: { id: req.userId }, select: AUTHOR_USER_SELECT });
  const payload = {
    id: systemMessage.id,
    dmChannelId: systemMessage.dmChannelId,
    authorId: systemMessage.authorId,
    content: pinPlaintext,
    type: systemMessage.type,
    systemPayload: systemMessage.systemPayload as { kind: string; messageId: string },
    createdAt: systemMessage.createdAt instanceof Date ? systemMessage.createdAt.toISOString() : new Date(systemMessage.createdAt).toISOString(),
    authorUsername: author?.username ?? null,
    authorDiscriminator: author?.discriminator ?? null,
    authorAvatar: author?.avatar ?? null,
    authorStripePlan: author ? getEffectivePlan(author) : null,
    authorNameColor: author?.nameColor ?? null,
    authorNameFont: author?.nameFont ?? null,
    authorNameEffect: author?.nameEffect ?? null,
    authorAvatarEffect: author?.avatarEffect ?? null,
  };
  const io = req.app.get('io') as import('socket.io').Server;
  if (io) {
    const participantIds = pinChannel?.participants.map(p => p.userId) ?? [];
    await emitToDmExceptBlocked(io, dmChannelId, req.userId, participantIds, [
      ['dm-system-message', payload],
      ['dm-message-pinned', { dmChannelId, messageId }],
    ]);
  }
  return res.status(201).json(payload);
}));

// PATCH /api/dms/:dmChannelId/messages/:messageId
router.patch('/:dmChannelId/messages/:messageId', validateUuidParams('dmChannelId', 'messageId'), authenticateToken, dmMutateLimiter, validate(editDmMessageSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');
  const messageId = getParam(req, 'messageId');
  const { content } = req.body as { content?: string };
  if (!content) return res.status(400).json({ error: 'Content is required' });
  const [isActive, message, channel] = await Promise.all([
    isActiveDmParticipant(dmChannelId, req.userId),
    prisma.dMMessage.findFirst({ where: { id: messageId, dmChannelId } }),
    prisma.dMChannel.findUnique({ where: { id: dmChannelId }, select: { encrypted: true, isGroup: true, participants: { select: { userId: true } } } }),
  ]);
  if (!isActive) return res.status(403).json({ error: 'Not in this DM' });
  if (!channel) return res.status(404).json({ error: 'DM channel not found' });
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.authorId !== req.userId) return res.status(403).json({ error: 'You can only edit your own messages' });
  if (message.type === 'system') return res.status(400).json({ error: 'Cannot edit system messages' });
  if (!channel.isGroup) {
    const otherId = channel.participants.find(p => p.userId !== req.userId)?.userId;
    if (otherId) {
      const blocked = await hasBlockBetween(req.userId, otherId);
      if (blocked) return res.status(403).json({ error: 'Cannot edit messages in this conversation' });
    }
  }
  // Group DMs: no block veto — emit fan-out below filters blocked pairs.
  const finalContent = channel.encrypted ? content : content.trim();
  if (!finalContent) return res.status(400).json({ error: 'Content is required' });
  // Encrypted channels require E2E — reject plaintext edits. Accept v2 or v3
  // envelopes (v3 adds a per-message id bound into the CLIENT envelope's AAD —
  // not the server `dmCrypto.ts` at-rest codec, which binds none),
  // OR a v4 MLS envelope ({v:4,m:<wire MLSMessage>}). The v2/v3-only check
  // predates the MLS migration and silently rejected every v4 edit; the send
  // path (POST) already accepts v4 via the `encrypted` flag, so the edit path
  // must too or MLS DMs can never be edited.
  if (channel.encrypted) {
    try {
      const parsed = JSON.parse(finalContent);
      const hasIvCt = typeof parsed?.iv === 'string' && typeof parsed?.ct === 'string';
      const isV2 = parsed?.v === 2 && hasIvCt;
      const isV3 = parsed?.v === 3 && hasIvCt && typeof parsed?.mid === 'string' && parsed.mid.length > 0;
      const isV4 = parsed?.v === 4 && typeof parsed?.m === 'string' && parsed.m.length > 0;
      if (!isV2 && !isV3 && !isV4) {
        return res.status(400).json({ error: 'Edits to encrypted channels must be end-to-end encrypted.' });
      }
    } catch {
      return res.status(400).json({ error: 'Edits to encrypted channels must be end-to-end encrypted.' });
    }
  }
  const editEnc = channel.encrypted ? null : encryptDmContent(finalContent);
  const updated = await prisma.dMMessage.update({
    where: { id: messageId },
    data: {
      content: editEnc ? editEnc.ciphertext : finalContent,
      contentIv: editEnc ? editEnc.iv : null,
      editedAt: new Date(),
    },
  });
  const editPayload = { dmChannelId, messageId, content: finalContent, editedAt: updated.editedAt?.toISOString() ?? null, encrypted: channel.encrypted, authorId: message.authorId };
  const io = req.app.get('io') as import('socket.io').Server;
  if (io) {
    const participantIds = channel.participants.map(p => p.userId);
    await emitToDmExceptBlocked(io, dmChannelId, req.userId, participantIds, [
      ['dm-message-updated', editPayload],
    ]);
  }
  return res.json({ id: updated.id, content: finalContent, editedAt: updated.editedAt?.toISOString() ?? null, encrypted: channel.encrypted });
}));

// DELETE /api/dms/:dmChannelId/messages/:messageId
router.delete('/:dmChannelId/messages/:messageId', validateUuidParams('dmChannelId', 'messageId'), authenticateToken, dmMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');
  const messageId = getParam(req, 'messageId');
  const [isActive, message, deleteChannel] = await Promise.all([
    isActiveDmParticipant(dmChannelId, req.userId),
    prisma.dMMessage.findFirst({ where: { id: messageId, dmChannelId } }),
    prisma.dMChannel.findUnique({ where: { id: dmChannelId }, select: { isGroup: true, participants: { select: { userId: true } } } }),
  ]);
  if (!isActive) return res.status(403).json({ error: 'Not in this DM' });
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.authorId !== req.userId) return res.status(403).json({ error: 'You can only delete your own messages' });
  if (message.type === 'system') return res.status(400).json({ error: 'Cannot delete system messages' });
  // Group DMs: no block veto — emit fan-out below filters blocked pairs.
  await Promise.all([
    prisma.dMPinnedMessage.deleteMany({ where: { dmChannelId, messageId } }),
    prisma.dMMessage.deleteMany({
      where: {
        dmChannelId,
        type: 'system',
        systemPayload: { path: ['kind'], equals: 'pin' },
        AND: { systemPayload: { path: ['messageId'], equals: messageId } },
      },
    }),
    // Delete-for-everyone durability: purge EVERY participant's sealed cross-device
    // history-archive rows for this message (original + edit revisions share the
    // messageId), not just the deleter's. An offline recipient never receives the
    // 'dm-message-deleted' socket event (no durable replay), so their sealed copy
    // would otherwise resurrect the retracted message on a fresh/recovered device.
    // The author was already authorized above; the server only holds opaque
    // ciphertext, so dropping a peer's row leaks nothing and matches the live delete.
    prisma.dmHistoryArchive.deleteMany({ where: { dmChannelId, messageId } }),
  ]);
  await prisma.dMMessage.delete({ where: { id: messageId } });
  if (message.attachmentUrl) {
    const [msgRefs, dmRefs] = await Promise.all([
      prisma.message.count({ where: { attachmentUrl: message.attachmentUrl } }),
      prisma.dMMessage.count({ where: { attachmentUrl: message.attachmentUrl, id: { not: message.id } } }),
    ]);
    if (msgRefs + dmRefs === 0) {
      deleteUploadedFile(message.attachmentUrl).catch(() => {});
    }
  }
  const deletePayload = { dmChannelId, messageId };
  const io = req.app.get('io') as import('socket.io').Server;
  if (io) {
    // Reuse participants from the channel lookup at the top of this handler.
    const delParticipantIds = deleteChannel?.participants.map(p => p.userId) ?? [];
    await emitToDmExceptBlocked(io, dmChannelId, req.userId, delParticipantIds, [
      ['dm-message-deleted', deletePayload],
    ]);
  }
  return res.status(204).send();
}));

// DELETE /api/dms/:dmChannelId/messages/:messageId/pin
router.delete('/:dmChannelId/messages/:messageId/pin', validateUuidParams('dmChannelId', 'messageId'), authenticateToken, dmMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');
  const messageId = getParam(req, 'messageId');
  if (!(await isActiveDmParticipant(dmChannelId, req.userId))) return res.status(403).json({ error: 'Not in this DM' });
  const unpinChannel = await prisma.dMChannel.findUnique({
    where: { id: dmChannelId },
    select: { isGroup: true, participants: { select: { userId: true } } },
  });
  if (unpinChannel && !unpinChannel.isGroup) {
    const otherId = unpinChannel.participants.find(p => p.userId !== req.userId)?.userId;
    if (otherId) {
      const blocked = await hasBlockBetween(req.userId, otherId);
      if (blocked) return res.status(403).json({ error: 'Cannot modify pins in this conversation' });
    }
  }
  // Group DMs: no block veto — emit fan-out below filters blocked pairs.
  await Promise.all([
    prisma.dMPinnedMessage.deleteMany({ where: { dmChannelId, messageId } }),
    prisma.dMMessage.deleteMany({
      where: {
        dmChannelId,
        type: 'system',
        systemPayload: { path: ['kind'], equals: 'pin' },
        AND: { systemPayload: { path: ['messageId'], equals: messageId } },
      },
    }),
  ]);
  const unpinPayload = { dmChannelId, messageId };
  const io = req.app.get('io') as import('socket.io').Server;
  if (io) {
    const unpinParticipantIds = unpinChannel?.participants.map(p => p.userId) ?? [];
    await emitToDmExceptBlocked(io, dmChannelId, req.userId, unpinParticipantIds, [
      ['dm-message-unpinned', unpinPayload],
    ]);
  }
  return res.status(204).send();
}));

// DM Reaction helpers

async function getGroupedDMReactions(messageId: string): Promise<Array<{ emoji: string; userIds: string[] }>> {
  const rows = await prisma.dMMessageReaction.findMany({
    where: { messageId },
    select: { emoji: true, userId: true },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.emoji) ?? [];
    list.push(r.userId);
    map.set(r.emoji, list);
  }
  return Array.from(map.entries()).map(([emoji, userIds]) => ({ emoji, userIds }));
}

const dmReactionLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:dm-reaction:'),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many reactions. Slow down.' },
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

// PUT /api/dms/:dmChannelId/messages/:messageId/reactions — toggle DM reaction
router.put('/:dmChannelId/messages/:messageId/reactions', validateUuidParams('dmChannelId', 'messageId'), authenticateToken, dmReactionLimiter, validate(reactMessageSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const dmChannelId = getParam(req, 'dmChannelId');
  const messageId = getParam(req, 'messageId');
  const { emoji } = req.body as { emoji: string };

  if (!(await isActiveDmParticipant(dmChannelId, req.userId))) return res.status(403).json({ error: 'Not in this DM' });

  const channel = await prisma.dMChannel.findUnique({
    where: { id: dmChannelId },
    select: { isGroup: true, participants: { select: { userId: true } } },
  });
  if (!channel) return res.status(404).json({ error: 'DM channel not found' });

  // Block check
  if (!channel.isGroup) {
    const otherId = channel.participants.find(p => p.userId !== req.userId)?.userId;
    if (otherId) {
      const blocked = await hasBlockBetween(req.userId, otherId);
      if (blocked) return res.status(403).json({ error: 'Cannot react in this conversation' });
    }
  }
  // Group DMs: no block veto — emit fan-out below filters blocked pairs.

  const message = await prisma.dMMessage.findFirst({ where: { id: messageId, dmChannelId } });
  if (!message) return res.status(404).json({ error: 'Message not found' });

  const existing = await prisma.dMMessageReaction.findUnique({
    where: { messageId_userId_emoji: { messageId, userId: req.userId, emoji } },
  });

  if (existing) {
    await prisma.dMMessageReaction.delete({ where: { id: existing.id } });
  } else {
    const uniqueEmojis = await prisma.dMMessageReaction.groupBy({ by: ['emoji'], where: { messageId } });
    if (uniqueEmojis.length >= 20 && !uniqueEmojis.some(g => g.emoji === emoji)) {
      return res.status(400).json({ error: 'Maximum of 20 unique emojis per message.' });
    }
    await prisma.dMMessageReaction.create({ data: { messageId, userId: req.userId, emoji } });
  }

  const reactions = await getGroupedDMReactions(messageId);
  const io = req.app.get('io') as import('socket.io').Server | undefined;
  if (io) {
    const reactionParticipantIds = channel.participants.map(p => p.userId);
    await emitToDmExceptBlocked(io, dmChannelId, req.userId, reactionParticipantIds, [
      ['dm-message-reaction-update', { dmChannelId, messageId, reactions }],
    ]);
  }

  res.json({ reactions });
}));

export default router;
