// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Shared voice/stage E2EE key-rotation scheduling.
 *
 * Extracted so the graceful-leave handlers (`leave-voice-channel`,
 * `stage-leave`), the moderator-remove REST path, AND the abrupt-disconnect
 * cleanup in `connection.ts` all rotate keys through the *same* logic and
 * cannot drift apart again.
 *
 * Behavior guarantees:
 *   - Abrupt voice key-holder disconnect rotates (forward secrecy on the
 *     common close/crash departure case, not just graceful Leave).
 *   - Abrupt stage host disconnect advances the `setStageLeader` pointer AND
 *     emits `stage-e2ee-rotate`, so the leader-gated `stage-e2ee-distribute`
 *     does not reject every remaining speaker for the rest of the session.
 *
 * Forward secrecy holds because the new leader generates a fresh session key
 * on receipt of the rotate; the departed member's retained key no longer
 * protects subsequent media.
 */
import type { Server } from 'socket.io';
import { prisma } from '../db.js';
import { getVoiceParticipants } from '../redis.js';
import { electVoiceLeader } from './voiceLeaderElection.js';
import {
  getSetMembers, getStageSessionId, setStageLeader,
} from '../routes/stages.js';
import { cappedTimerMapSet } from '../socketHandlers/infrastructure.js';

/**
 * Debounced E2EE key rotation per voice channel.
 * When multiple users leave within the debounce window, we rotate once —
 * preserving forward secrecy (the old key is discarded) while avoiding N
 * rotations for N departures. Each rotation still generates a fresh key and
 * distributes to all remaining participants.
 *
 * Module-scoped (shared across all sockets on this instance), matching the
 * original `voice.ts` map this was extracted from.
 */
const e2eeRotationTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const E2EE_ROTATION_DEBOUNCE_MS = 2_000;
const MAX_E2EE_ROTATION_TIMERS = 10_000;

/**
 * Schedule (or re-arm) a debounced `voice-e2ee-rotate` for a voice channel.
 *
 * Call after the departing participant has already been removed from Redis.
 * Re-reads the participant set after the debounce window so the elected leader
 * (via `electVoiceLeader` — the signed-joinTimestamp election the clients use)
 * reflects the actual remaining set. If no participants remain at fire time,
 * no rotate is emitted.
 *
 * Passing `participantsRemain: false` cancels any pending rotate for the
 * channel (the room emptied) — mirrors the graceful-leave else-branch.
 */
export function scheduleVoiceE2eeRotate(
  io: Server,
  channelId: string,
  participantsRemain: boolean,
): void {
  if (!participantsRemain) {
    const existing = e2eeRotationTimers.get(channelId);
    if (existing) {
      clearTimeout(existing);
      e2eeRotationTimers.delete(channelId);
    }
    return;
  }

  const existing = e2eeRotationTimers.get(channelId);
  if (existing) clearTimeout(existing);
  cappedTimerMapSet(e2eeRotationTimers, channelId, setTimeout(async () => {
    e2eeRotationTimers.delete(channelId);
    // Re-fetch participants after the debounce window to get the actual
    // remaining set — a debounced burst of departures collapses to one rotate.
    const currentParticipants = await getVoiceParticipants(channelId);
    if (currentParticipants.length > 0) {
      // Elect by signed joinTimestamp so the rotate's newLeaderUserId matches
      // what the clients re-elect after the departure.
      const newLeaderUserId = electVoiceLeader(channelId, currentParticipants) ?? currentParticipants[0].userId;
      io.to(`voice:${channelId}`).emit('voice-e2ee-rotate', {
        channelId,
        newLeaderUserId,
      });
    }
  }, E2EE_ROTATION_DEBOUNCE_MS), MAX_E2EE_ROTATION_TIMERS, clearTimeout);
}

/**
 * Advance the stage leader pointer and emit `stage-e2ee-rotate` when a speaker
 * departs and speakers remain. Idempotent and safe to call from any departure
 * path (graceful `stage-leave`, moderator-remove, abrupt disconnect).
 *
 * Reads the *current* speaker set itself (caller must have already removed the
 * departing speaker), picks the new host (session `startedById` if still a
 * speaker, else the first remaining speaker), advances `setStageLeader` BEFORE
 * emitting so any racing `stage-e2ee-distribute` sees the new pointer, then
 * broadcasts `stage-e2ee-rotate` to the whole channel.
 *
 * No-op when no speakers remain. Returns the new host userId (or null).
 */
export async function rotateStageLeaderAndKey(
  io: Server,
  channelId: string,
): Promise<string | null> {
  const remainingSpeakers = await getSetMembers(channelId, 'speakers');
  if (remainingSpeakers.length === 0) return null;

  const sessionId = await getStageSessionId(channelId);
  const session = sessionId
    ? await prisma.stageSession.findUnique({
        where: { id: sessionId },
        select: { startedById: true },
      })
    : null;
  const newHostUserId = (session?.startedById && remainingSpeakers.includes(session.startedById))
    ? session.startedById
    : remainingSpeakers[0];

  // Advance the authoritative leader pointer BEFORE emitting the rotate so
  // any racing `stage-e2ee-distribute` sees the new value.
  await setStageLeader(channelId, newHostUserId);
  io.to(`channel:${channelId}`).emit('stage-e2ee-rotate', { channelId, newHostUserId });
  return newHostUserId;
}
