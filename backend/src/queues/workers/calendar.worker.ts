// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Calendar activity worker.
 *
 * Runs as a repeatable BullMQ job (every 60s).
 * Emits calendar-activity socket events for upcoming/live events
 * and creates persistent Notification records for server members.
 *
 * Also runs a daily cleanup job for notifications older than 90 days.
 */

import { Worker } from 'bullmq';
import { redisConnection, queuesEnabled } from '../connection.js';
import { calendarQueue, notificationCleanupQueue } from '../index.js';
import { prisma } from '../../db.js';
import { logger } from '../../logger.js';
import type { Server as IOServer } from 'socket.io';

const log = logger.child({ module: 'worker:calendar' });

let _io: IOServer | null = null;

/** Must be called once at startup so the worker can emit Socket.IO events. */
export function setCalendarIO(io: IOServer): void {
  _io = io;
}

async function processCalendarCheck(): Promise<void> {
  if (!_io) return;
  const now = new Date();
  const soonThreshold = new Date(now.getTime() + 15 * 60 * 1000); // 15 min from now

  // 1. Events starting within 15 minutes (not yet notified as 'soon')
  const upcomingEvents = await prisma.serverEvent.findMany({
    where: {
      startTime: { gt: now, lte: soonThreshold },
      endTime: { gt: now },
    },
    select: { id: true, serverId: true, title: true, startTime: true },
    take: 100,
  });

  for (const event of upcomingEvents) {
    // Idempotency: check if we already created a 'calendar_soon' notification for this event recently
    const existing = await prisma.notification.findFirst({
      where: {
        type: 'calendar_soon',
        metadata: { path: ['eventId'], equals: event.id },
        createdAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) },
      },
      select: { id: true },
    });
    if (existing) continue;

    // Emit calendar-activity socket event
    _io.to(`server:${event.serverId}`).emit('calendar-activity', {
      serverId: event.serverId,
      type: 'soon',
      eventId: event.id,
      eventTitle: event.title,
      startTime: event.startTime.toISOString(),
    });

    // Create notifications for server members (batch)
    const members = await prisma.serverMember.findMany({
      where: { serverId: event.serverId },
      select: { userId: true },
      take: 5000,
    });

    if (members.length > 0) {
      const minutesUntil = Math.max(1, Math.round((event.startTime.getTime() - now.getTime()) / 60000));
      await prisma.notification.createMany({
        data: members.map(m => ({
          userId: m.userId,
          serverId: event.serverId,
          type: 'calendar_soon',
          title: 'Event starting soon',
          body: `${event.title} in ${minutesUntil} minutes`,
          metadata: { eventId: event.id, eventTitle: event.title, startTime: event.startTime.toISOString() },
        })),
        skipDuplicates: true,
      }).catch(err => log.warn({ err: err instanceof Error ? err.message : err }, 'calendar soon notification creation failed'));
    }
  }

  // 2. Events that just started (startTime <= now AND endTime > now)
  const liveEvents = await prisma.serverEvent.findMany({
    where: {
      startTime: { lte: now },
      endTime: { gt: now },
    },
    select: { id: true, serverId: true, title: true, startTime: true, endTime: true },
    take: 100,
  });

  for (const event of liveEvents) {
    // Only create 'live' notification once per event (permanent dedup by eventId in metadata)
    const alreadyNotified = await prisma.notification.findFirst({
      where: {
        type: 'calendar_live',
        metadata: { path: ['eventId'], equals: event.id },
      },
      select: { id: true },
    });

    _io.to(`server:${event.serverId}`).emit('calendar-activity', {
      serverId: event.serverId,
      type: 'live',
      eventId: event.id,
      eventTitle: event.title,
    });

    if (!alreadyNotified) {
      const members = await prisma.serverMember.findMany({
        where: { serverId: event.serverId },
        select: { userId: true },
        take: 5000,
      });
      if (members.length > 0) {
        await prisma.notification.createMany({
          data: members.map(m => ({
            userId: m.userId,
            serverId: event.serverId,
            type: 'calendar_live',
            title: 'Event happening now',
            body: event.title,
            metadata: { eventId: event.id, eventTitle: event.title },
          })),
          skipDuplicates: true,
        }).catch(err => log.warn({ err: err instanceof Error ? err.message : err }, 'calendar live notification creation failed'));
      }
    }
  }

  // 3. Events that just ended (endTime between now-2min and now) — emit 'ended' to clear dots
  const recentlyEnded = await prisma.serverEvent.findMany({
    where: {
      endTime: { gt: new Date(now.getTime() - 2 * 60 * 1000), lte: now },
    },
    select: { id: true, serverId: true },
    take: 100,
  });

  for (const event of recentlyEnded) {
    _io.to(`server:${event.serverId}`).emit('calendar-activity', {
      serverId: event.serverId,
      type: 'ended',
      eventId: event.id,
    });
  }
}

export function startCalendarWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection || !calendarQueue) return null;

  // Add repeatable job (every 60s) — idempotent, safe to call multiple times
  calendarQueue.add('check-events', {}, {
    repeat: { every: 60_000 },
    removeOnComplete: 10,
    removeOnFail: 10,
  }).catch(() => {});

  const worker = new Worker('calendar', async () => {
    await processCalendarCheck();
  }, {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: 30_000,
  });

  worker.on('failed', (job, err) => {
    log.warn({ jobId: job?.id, err: err instanceof Error ? err.message : err }, 'calendar check failed');
  });

  log.info('calendar worker started');
  return worker;
}

// Notification cleanup (daily)

export function startNotificationCleanupWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection || !notificationCleanupQueue) return null;

  notificationCleanupQueue.add('cleanup', {}, {
    repeat: { every: 24 * 60 * 60 * 1000 },
    removeOnComplete: 5,
    removeOnFail: 5,
  }).catch(() => {});

  const worker = new Worker('notification-cleanup', async () => {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const result = await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
    log.info({ deleted: result.count }, 'notification cleanup complete');
  }, {
    connection: redisConnection,
    concurrency: 1,
  });

  worker.on('failed', (job, err) => {
    log.warn({ jobId: job?.id, err: err instanceof Error ? err.message : err }, 'notification cleanup failed');
  });

  log.info('notification cleanup worker started');
  return worker;
}
