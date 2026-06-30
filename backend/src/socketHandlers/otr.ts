// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { SocketContext } from './types.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { checkSocketRateLimit } from '../redis.js';
import {
  isValidUUID,
  parseSocketPayload,
  otrMessagePayload,
  otrAckPayload,
  otrPullPayload,
} from '../socketSchemas.js';
import { enqueueOtr, pullOtr, ackOtr, type OtrEnvelope } from '../otrQueue.js';

/**
 * OTR ("Off the Record") ephemeral socket delivery.
 *
 * OTR application messages are the ONE inbound socket send path: opaque MLS
 * application ciphertext, relayed verbatim and NEVER persisted as a DMMessage.
 * The handler sees only ciphertext — never inspect, log, or filter content.
 *
 * - otr-message: rate-limit → parse → uuid-validate → the sender must be a
 *   participant AND the channel must have a tier='otr' MlsGroup matching the
 *   named mlsGroupId. Fan out the envelope to BOTH participants' `user:<id>`
 *   rooms (the sender's originating socket is auto-excluded by socket.to()),
 *   and enqueue for any non-sender participant with no live socket (offline).
 * - otr-ack: drain the queued item for clientMsgId.
 * - otr-pull: ordered, non-destructive replay of the recipient's queue.
 */
export function registerOtrHandlers(ctx: SocketContext): void {
  const { io, socket, userId } = ctx;

  socket.on('otr-message', async (raw: unknown) => {
    try {
      // Mirror the durable DM send posture (8/10s) with a namespaced counter.
      if (!(await checkSocketRateLimit(`otr:${userId}`, 8, 10_000))) {
        socket.emit('rate-limited');
        return;
      }
      const payload = parseSocketPayload(otrMessagePayload, raw);
      if (!payload) return;
      const { dmChannelId, mlsGroupId, clientMsgId, ciphertext } = payload;
      if (!isValidUUID(dmChannelId) || !isValidUUID(mlsGroupId) || !isValidUUID(clientMsgId)) return;

      // Sender must be a participant; the channel must have a tier='otr' group
      // matching mlsGroupId. (Eligibility was enforced at create; OTR teardown
      // deletes the group, so a missing group here means OTR is no longer valid.)
      const [participant, group] = await Promise.all([
        prisma.dMParticipant.findUnique({
          where: { userId_dmChannelId: { userId, dmChannelId } },
          select: { userId: true },
        }),
        prisma.mlsGroup.findUnique({
          where: { id: mlsGroupId },
          select: { dmChannelId: true, tier: true },
        }),
      ]);
      if (!participant) return;
      if (!group || group.tier !== 'otr' || group.dmChannelId !== dmChannelId) return;

      const env: OtrEnvelope = {
        clientMsgId,
        authorId: userId,
        dmChannelId,
        mlsGroupId,
        ciphertext,
        createdAt: Date.now(),
      };

      // Fan out to BOTH participants' rooms (sender's originating socket is
      // auto-excluded by socket.to()). Enqueue for any non-sender participant
      // with no live socket. Opaque ciphertext only — never inspect.
      const participants = await prisma.dMParticipant.findMany({
        where: { dmChannelId },
        select: { userId: true },
        take: 1000,
      });
      for (const { userId: pid } of participants) {
        socket.to(`user:${pid}`).emit('otr-message', env);
      }
      for (const { userId: pid } of participants) {
        if (pid === userId) continue;
        const room = io.sockets.adapter.rooms.get(`user:${pid}`);
        if (!room || room.size === 0) await enqueueOtr(pid, env);
      }
    } catch (err) {
      logger.error({ err, userId, event: 'otr-message' }, 'socket handler error');
    }
  });

  socket.on('otr-ack', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(`otr:${userId}`, 30, 10_000))) return;
      const payload = parseSocketPayload(otrAckPayload, raw);
      if (!payload || !isValidUUID(payload.clientMsgId)) return;
      await ackOtr(userId, payload.clientMsgId);
    } catch (err) {
      logger.error({ err, userId, event: 'otr-ack' }, 'socket handler error');
    }
  });

  socket.on('otr-pull', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(`otr:${userId}`, 30, 10_000))) return;
      if (!parseSocketPayload(otrPullPayload, raw)) return;
      const pending = await pullOtr(userId); // ordered; non-destructive (delete-on-ack)
      for (const env of pending) socket.emit('otr-message', env);
    } catch (err) {
      logger.error({ err, userId, event: 'otr-pull' }, 'socket handler error');
    }
  });
}
