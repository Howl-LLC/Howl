// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { prisma } from '../db.js';
import { encryptDmContent } from './dmCrypto.js';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { AUTHOR_USER_SELECT, getEffectivePlan } from '../utils.js';
import { getIO } from '../socketIO.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'giftDmCard' });

interface PostGiftCardArgs {
  senderId: string;
  recipientId: string;
  giftId: string;
  plan: string;
  durationMonths: number;
}

/**
 * Post a `{kind:'gift'}` system DM to the existing 1:1 DM channel between
 * sender and recipient, if one exists. Returns the inserted message id, or
 * null if no DM channel exists.
 *
 * Does NOT create a new DM channel — that requires E2EE key bootstrap from
 * the client. If no channel exists, the recipient still sees the gift via
 * the Gift Inventory's Received list with its Claim button, so the gift is
 * never stranded.
 */
export async function postGiftDmCard(args: PostGiftCardArgs): Promise<string | null> {
  const { senderId, recipientId, giftId, plan, durationMonths } = args;

  const candidates = await prisma.dMChannel.findMany({
    where: {
      isGroup: false,
      AND: [
        { participants: { some: { userId: senderId } } },
        { participants: { some: { userId: recipientId } } },
      ],
    },
    take: 5,
    include: { participants: { select: { userId: true } } },
  });
  const channel = candidates.find(c => c.participants.length === 2);
  if (!channel) return null;

  const systemPayload = { kind: 'gift', giftId, plan, durationMonths };
  const plaintext = 'sent a gift';
  const enc = channel.encrypted ? null : encryptDmContent(plaintext);

  const rows = await prisma.$queryRaw<Array<{
    id: string; dmChannelId: string; authorId: string; content: string;
    contentIv: string | null; type: string; systemPayload: unknown; createdAt: Date;
  }>>(Prisma.sql`
    INSERT INTO "DMMessage" (id, "dmChannelId", "authorId", content, "contentIv", type, "systemPayload", "createdAt")
    VALUES (gen_random_uuid(), ${channel.id}, ${senderId},
            ${enc ? enc.ciphertext : plaintext}, ${enc ? enc.iv : null},
            'system', ${JSON.stringify(systemPayload)}::jsonb, NOW())
    RETURNING id, "dmChannelId", "authorId", content, "contentIv", type, "systemPayload", "createdAt"
  `);
  const msg = rows[0];
  if (!msg) return null;

  const author = await prisma.user.findUnique({ where: { id: senderId }, select: AUTHOR_USER_SELECT });
  const payload = {
    id: msg.id,
    dmChannelId: msg.dmChannelId,
    authorId: msg.authorId,
    content: plaintext,
    type: 'system',
    systemPayload: msg.systemPayload,
    createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : new Date(msg.createdAt).toISOString(),
    authorUsername: author?.username ?? null,
    authorDiscriminator: author?.discriminator ?? null,
    authorAvatar: author?.avatar ?? null,
    authorStripePlan: author ? getEffectivePlan(author) : null,
    authorNameColor: author?.nameColor ?? null,
    authorNameFont: author?.nameFont ?? null,
    authorNameEffect: author?.nameEffect ?? null,
    authorAvatarEffect: author?.avatarEffect ?? null,
  };

  try {
    const io = getIO();
    io.to(`dm:${channel.id}`).emit('dm-system-message', payload);
    io.to(`user:${recipientId}`).emit('dm-system-message', payload);
    io.to(`user:${senderId}`).emit('dm-system-message', payload);
  } catch {
    // Socket.IO may not be initialized in tests — silently skip
  }
  return msg.id;
}

/**
 * Update the systemPayload of any existing gift DM card for this giftId,
 * setting `claimedAt`. Frontend re-renders the card to show "Claimed" state.
 */
export async function markGiftDmCardClaimed(giftId: string): Promise<void> {
  const cards = await prisma.dMMessage.findMany({
    where: {
      type: 'system',
      AND: [
        { systemPayload: { path: ['kind'], equals: 'gift' } },
        { systemPayload: { path: ['giftId'], equals: giftId } },
      ],
    },
    select: { id: true, dmChannelId: true, systemPayload: true },
    take: 5,
  });

  for (const card of cards) {
    const next = {
      ...(card.systemPayload as Record<string, unknown>),
      claimedAt: new Date().toISOString(),
    };
    try {
      await prisma.dMMessage.update({
        where: { id: card.id },
        data: { systemPayload: next as Prisma.InputJsonValue },
      });
    } catch (err) {
      log.warn({ err, cardId: card.id, giftId }, 'failed to mark gift dm card claimed');
      continue;
    }
    try {
      const io = getIO();
      io.to(`dm:${card.dmChannelId}`).emit('dm-system-message-updated', {
        id: card.id, dmChannelId: card.dmChannelId, systemPayload: next,
      });
    } catch {
      // Socket.IO may not be initialized in tests — silently skip
    }
  }
}
