// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { Server as IOServer } from 'socket.io';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { clearStageState, getStageSessionId, getSetSize } from './routes/stages.js';
import { getIsShuttingDown } from './shutdown.js';
import { cappedTimerMapSet } from './socketHandlers/infrastructure.js';

/**
 * Stage grace-period auto-end.
 *
 * When the last participant leaves a stage, we don't end the session
 * immediately. Instead we start a 60s timer; if someone rejoins within that
 * window (network blip, brief tab switch, accidental leave) the timer is
 * cancelled and the session continues. After the window, the stage ends for
 * real — endedAt is set, Redis state is cleared, clients receive stage-ended.
 *
 * Timers live in an in-memory Map keyed by channelId. They are lost on
 * backend restart, which is acceptable: the session's Redis keys have a 24h
 * TTL, and clients won't see the stage as active once Redis expires.
 */

const GRACE_PERIOD_MS = 60_000;
const MAX_GRACE_TIMERS = 10_000;
const graceTimers = new Map<string, NodeJS.Timeout>();

/**
 * Schedule an auto-end 60s from now. Idempotent — if a timer is already
 * pending for this channel, this is a no-op (the existing timer keeps its
 * original fire time, so repeated leave events don't reset the countdown).
 */
export function scheduleGraceEnd(channelId: string, io: IOServer): void {
  if (graceTimers.has(channelId)) return;
  const timer = setTimeout(() => {
    graceTimers.delete(channelId);
    void endStageIfStillEmpty(channelId, io);
  }, GRACE_PERIOD_MS);
  cappedTimerMapSet(graceTimers, channelId, timer, MAX_GRACE_TIMERS, clearTimeout);
  logger.info({ channelId, graceMs: GRACE_PERIOD_MS, event: 'stage-grace-scheduled' }, 'stage grace period started');
}

/**
 * Cancel a pending grace-period end. Called when someone rejoins the stage
 * or the host explicitly ends it.
 */
export function cancelGraceEnd(channelId: string): void {
  const timer = graceTimers.get(channelId);
  if (!timer) return;
  clearTimeout(timer);
  graceTimers.delete(channelId);
  logger.info({ channelId, event: 'stage-grace-cancelled' }, 'stage grace period cancelled');
}

/**
 * Commit the end: set endedAt, clear Redis, emit stage-ended to channel +
 * server rooms. Safe to invoke multiple times — getStageSessionId returns
 * null after the first clear, so subsequent calls early-return.
 */
async function endStageCore(channelId: string, io: IOServer): Promise<void> {
  const sessionId = await getStageSessionId(channelId).catch(() => null);
  if (!sessionId) return;
  await prisma.stageSession.update({
    where: { id: sessionId },
    data: { endedAt: new Date() },
  }).catch(() => {});
  await clearStageState(channelId).catch(() => {});
  const ch = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { serverId: true },
  }).catch(() => null);
  if (ch?.serverId && !getIsShuttingDown()) {
    io.to(`channel:${channelId}`).emit('stage-ended', { sessionId, channelId });
    io.to(`server:${ch.serverId}`).emit('stage-ended', { sessionId, channelId });
    io.to(`server:${ch.serverId}`).emit('server-stage-participants', {
      serverId: ch.serverId, channelId, participants: [],
    });
  }
  logger.info({ channelId, sessionId, event: 'stage-grace-ended' }, 'stage ended after grace period');
}

/**
 * Grace-timer callback. Re-checks Redis participant counts before committing
 * the end — guards against any rejoin path that bypassed cancelGraceEnd.
 */
async function endStageIfStillEmpty(channelId: string, io: IOServer): Promise<void> {
  const speakers = await getSetSize(channelId, 'speakers').catch(() => 0);
  const audience = await getSetSize(channelId, 'audience').catch(() => 0);
  if (speakers > 0 || audience > 0) {
    logger.info({ channelId, speakers, audience, event: 'stage-grace-aborted-on-rejoin' }, 'stage re-populated before grace expired — not ending');
    return;
  }
  await endStageCore(channelId, io);
}
