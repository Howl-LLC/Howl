// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { Server } from 'socket.io';
import { prisma } from '../db.js';
import { isInSet, removeFromSet, getSetMembers, getActiveStageSpeakers } from '../routes/stages.js';
import { removeUserFromAllStreams, clearOwnedStreams } from '../redis.js';
import { rotateStageLeaderAndKey } from './voiceE2eeRotation.js';
import { removeLiveKitParticipant } from './livekitAdmin.js';
import { scheduleGraceEnd } from '../stageGraceTimers.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'stage-eviction' });

/**
 * Disconnect a user from every stage in a server on ban/kick/timeout.
 *
 * Moderation evictions already drop the user from their VOICE LiveKit room +
 * Redis state, but a STAGE is a separate room/membership: the SFU room is
 * `stage:${channelId}` (not `voice:`), and presence lives in the
 * speakers/audience/hands Redis sets — none of which the voice path touches.
 * So a banned/kicked speaker kept publishing to the stage SFU until their
 * (≤15m TTL) cached LiveKit JWT expired.
 *
 * This mirrors the involuntary teardown in connection.ts's abrupt-disconnect
 * cleanup: set removal, stream-viewer cleanup, speaker-leader key
 * rotation for forward secrecy, and the empty-stage grace timer — and ADDS the
 * `removeLiveKitParticipant` call that a real socket disconnect gets for free
 * but a ban/kick/timeout does not. Best-effort and per-channel fault-isolated:
 * one bad channel never aborts eviction from the others.
 */
export async function evictUserFromServerStages(
  io: Server,
  userId: string,
  serverId: string,
): Promise<void> {
  const stageChannels = await prisma.channel.findMany({
    where: { serverId, type: 'stage' },
    select: { id: true },
    take: 500,
  });

  for (const { id: channelId } of stageChannels) {
    try {
      const wasSpeaker = await isInSet(channelId, 'speakers', userId);
      const wasAudience = await isInSet(channelId, 'audience', userId);
      const wasHand = await isInSet(channelId, 'hands', userId);
      if (!wasSpeaker && !wasAudience && !wasHand) continue;

      // Drop the SFU connection so a cached LiveKit JWT
      // cannot keep publishing/subscribing on the stage after eviction.
      removeLiveKitParticipant(`stage:${channelId}`, userId).catch(() => {});

      // Stream viewer cleanup (mirror connection.ts disconnect).
      const stageCtx = { kind: 'stage' as const, scopeId: channelId };
      const viewerRemoved = await removeUserFromAllStreams(userId, stageCtx).catch(() => []);
      for (const r of viewerRemoved) {
        io.to(`channel:${channelId}`).emit('viewer:changed', {
          context: stageCtx, streamOwnerId: r.streamOwnerId, streamType: r.streamType, remove: [userId],
        });
      }
      const ownedCleared = await clearOwnedStreams(userId, stageCtx).catch(() => []);
      for (const r of ownedCleared) {
        io.to(`channel:${channelId}`).emit('viewer:cleared', {
          context: stageCtx, streamOwnerId: userId, streamType: r.streamType,
        });
      }

      await removeFromSet(channelId, 'audience', userId).catch(() => {});
      await removeFromSet(channelId, 'hands', userId).catch(() => {});

      if (wasSpeaker) {
        await removeFromSet(channelId, 'speakers', userId).catch(() => {});
        io.to(`channel:${channelId}`).emit('stage-speaker-removed', { channelId, userId });
        const updatedSpeakers = await getActiveStageSpeakers(channelId).catch(() => []);
        io.to(`server:${serverId}`).emit('server-stage-participants', {
          serverId, channelId, participants: updatedSpeakers,
        });
        // Forward secrecy: advance the leader pointer + rotate the SFrame key so
        // the evicted speaker's held key no longer decrypts the session, exactly
        // as stage-leave / moderator-remove / abrupt-disconnect do.
        await rotateStageLeaderAndKey(io, channelId).catch(() => null);
      } else {
        io.to(`channel:${channelId}`).emit('stage-audience-left', { userId, channelId });
      }

      // Auto-end with grace if the stage is now empty.
      const remainingSpeakers = await getSetMembers(channelId, 'speakers').catch(() => []);
      const remainingAudience = await getSetMembers(channelId, 'audience').catch(() => []);
      if (remainingSpeakers.length === 0 && remainingAudience.length === 0) {
        scheduleGraceEnd(channelId, io);
      }
    } catch (err) {
      log.warn({ err, userId, channelId, serverId }, 'stage eviction failed for channel');
    }
  }
}
