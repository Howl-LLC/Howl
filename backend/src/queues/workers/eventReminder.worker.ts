// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Event reminder worker.
 *
 * Runs as a repeatable BullMQ job (every 60s).
 * Finds unsent reminders whose fire time has passed, posts system messages
 * to the appropriate channel, and broadcasts via Socket.IO.
 */

import { Worker, Job } from 'bullmq';
import { redisConnection, queuesEnabled } from '../connection.js';
import { prisma } from '../../db.js';
import { logger } from '../../logger.js';
import { getNextOccurrenceAfter } from '../../utils/recurrence.js';
import type { Server as IOServer } from 'socket.io';

const log = logger.child({ module: 'worker:event-reminder' });

const REMINDER_OFFSETS: Record<string, number> = {
  AT_START: 0,
  '15_MIN': 15 * 60 * 1000,
  '1_HOUR': 60 * 60 * 1000,
  '1_DAY': 24 * 60 * 60 * 1000,
  '1_WEEK': 7 * 24 * 60 * 60 * 1000,
};

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function computeFireTime(startTime: Date, timing: string): Date {
  return new Date(startTime.getTime() - (REMINDER_OFFSETS[timing] ?? 0));
}

async function markSent(id: string): Promise<void> {
  await prisma.eventReminder.updateMany({
    where: { id, sent: false },
    data: { sent: true, sentAt: new Date() },
  });
}

let _io: IOServer | null = null;

/** Must be called once at startup so the worker can emit Socket.IO events. */
export function setEventReminderIO(io: IOServer): void {
  _io = io;
}

async function processJob(_job: Job): Promise<void> {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_THRESHOLD_MS);

  // Non-recurring: unsent only. Recurring: always check (filtered by lastFiredForOccurrence in processing).
  const unsent = await prisma.eventReminder.findMany({
    where: {
      OR: [
        { sent: false, event: { OR: [{ recurrenceRule: 'NONE' }, { recurrenceRule: null }] } },
        { event: { recurrenceRule: { notIn: ['NONE'] } } },
      ],
    },
    include: {
      event: {
        select: {
          id: true,
          serverId: true,
          title: true,
          description: true,
          startTime: true,
          endTime: true,
          color: true,
          allDay: true,
          recurrenceRule: true,
          recurrenceDays: true,
          recurrenceEndDate: true,
          reminderChannelId: true,
          voiceChannelId: true,
          reminderMentions: true,
          server: {
            select: {
              id: true,
              channels: {
                where: { type: 'text' },
                orderBy: { position: 'asc' },
                take: 1,
                select: { id: true },
              },
            },
          },
        },
      },
    },
    take: 100,
  });

  for (const reminder of unsent) {
    const event = reminder.event;
    if (!event) { await markSent(reminder.id); continue; }

    const isRecurring = event.recurrenceRule && event.recurrenceRule !== 'NONE';

    // Determine the relevant start time for this reminder
    let effectiveStartTime: Date;
    if (isRecurring) {
      // For recurring events, find the next occurrence after the last one we fired for
      const after = reminder.lastFiredForOccurrence ?? new Date(event.startTime.getTime() - 1);
      const nextOcc = getNextOccurrenceAfter(
        {
          startTime: event.startTime,
          endTime: event.endTime,
          recurrenceRule: event.recurrenceRule!,
          recurrenceDays: event.recurrenceDays as number[] | null,
          recurrenceEndDate: event.recurrenceEndDate,
        },
        after,
      );
      if (!nextOcc) {
        // No more occurrences — mark as permanently sent
        await markSent(reminder.id);
        continue;
      }
      effectiveStartTime = nextOcc.startTime;
    } else {
      effectiveStartTime = event.startTime;
    }

    const fireTime = computeFireTime(effectiveStartTime, reminder.timing);
    if (fireTime > now) continue; // not yet

    // Stale check — skip if fire time was > 24hr ago (only for non-recurring)
    if (!isRecurring && fireTime < staleThreshold) {
      await markSent(reminder.id);
      log.info({ reminderId: reminder.id, eventId: event.id }, 'stale reminder skipped');
      continue;
    }

    // Find target channel
    let channelId = event.reminderChannelId;
    if (channelId) {
      const ch = await prisma.channel.findFirst({
        where: { id: channelId, serverId: event.serverId, type: 'text' },
        select: { id: true },
      });
      if (!ch) channelId = null; // channel deleted, fall back
    }
    if (!channelId) {
      const firstCh = event.server?.channels?.[0];
      if (!firstCh) { await markSent(reminder.id); continue; } // no text channels
      channelId = firstCh.id;
    }

    if (isRecurring) {
      // For recurring events, update lastFiredForOccurrence instead of marking as permanently sent
      const updated = await prisma.eventReminder.updateMany({
        where: { id: reminder.id },
        data: { lastFiredForOccurrence: effectiveStartTime, sentAt: now },
      });
      if (updated.count === 0) continue;
    } else {
      // Idempotent update: only proceed if we're the one to flip sent=true
      const updated = await prisma.eventReminder.updateMany({
        where: { id: reminder.id, sent: false },
        data: { sent: true, sentAt: now },
      });
      if (updated.count === 0) continue; // another worker got it
    }

    // Look up voice channel name if linked
    let voiceChannelName: string | null = null;
    if (event.voiceChannelId) {
      const vch = await prisma.channel.findFirst({
        where: { id: event.voiceChannelId, serverId: event.serverId, type: 'voice' },
        select: { name: true },
      });
      voiceChannelName = vch?.name ?? null;
    }

    // Build mention content from reminderMentions
    let mentionContent = '';
    const mentions = event.reminderMentions as { everyone?: boolean; here?: boolean; roleIds?: string[] } | null;
    if (mentions) {
      const parts: string[] = [];
      if (mentions.everyone) parts.push('@everyone');
      else if (mentions.here) parts.push('@here');
      if (mentions.roleIds?.length) {
        const roles = await prisma.serverRole.findMany({
          where: { id: { in: mentions.roleIds }, serverId: event.serverId },
          select: { id: true, name: true },
          take: 25,
        });
        for (const role of roles) {
          parts.push(`@${role.name}`);
        }
      }
      mentionContent = parts.join(' ');
    }

    // Create system message
    const duration = event.endTime.getTime() - event.startTime.getTime();
    const systemPayload = {
      kind: 'event_reminder',
      eventId: event.id,
      eventTitle: event.title,
      eventDescription: (reminder.timing === 'AT_START' || reminder.timing === '1_DAY' || reminder.timing === '1_WEEK') ? event.description : null,
      eventStartTime: effectiveStartTime.toISOString(),
      eventEndTime: new Date(effectiveStartTime.getTime() + duration).toISOString(),
      eventColor: event.color,
      timing: reminder.timing,
      allDay: event.allDay,
      recurring: !!isRecurring,
      voiceChannelName,
    };

    const msg = await prisma.message.create({
      data: {
        channelId,
        authorId: 'system',
        content: mentionContent,
        type: 'system',
        systemPayload: { ...systemPayload, mentionContent } as object,
      },
    });

    // Broadcast to channel
    if (_io) {
      _io.to(`channel:${channelId}`).emit('new-message', {
        id: msg.id,
        channelId,
        authorId: 'system',
        content: mentionContent,
        type: 'system',
        systemPayload: { ...systemPayload, mentionContent },
        createdAt: msg.createdAt.toISOString(),
      });
    }

    log.info({ reminderId: reminder.id, eventId: event.id, channelId, timing: reminder.timing, recurring: !!isRecurring }, 'reminder sent');

    // Create mention notifications for targeted users
    if (mentionContent && _io) {
      let targetUserIds: string[] = [];

      if (mentions?.everyone) {
        const allMembers = await prisma.serverMember.findMany({
          where: { serverId: event.serverId },
          select: { userId: true },
          take: 5000,
        });
        targetUserIds = allMembers.map(m => m.userId);
      } else if (mentions?.here) {
        const onlineMembers = await prisma.serverMember.findMany({
          where: {
            serverId: event.serverId,
            user: { status: { in: ['online', 'idle', 'dnd'] } },
          },
          select: { userId: true },
          take: 5000,
        });
        targetUserIds = onlineMembers.map(m => m.userId);
      }

      if (mentions?.roleIds?.length) {
        const roleMembers = await prisma.serverMember.findMany({
          where: { roleId: { in: mentions.roleIds }, serverId: event.serverId },
          select: { userId: true },
          take: 10000,
        });
        const roleMemberIds = roleMembers.map(m => m.userId);
        const combined = new Set([...targetUserIds, ...roleMemberIds]);
        targetUserIds = [...combined];
      }

      if (targetUserIds.length > 0) {
        await prisma.notification.createMany({
          data: targetUserIds.map(uid => ({
            userId: uid,
            serverId: event.serverId,
            channelId,
            type: mentions?.everyone ? 'everyone' : 'mention',
            title: `Event reminder: ${event.title}`,
            body: mentionContent,
            metadata: { eventId: event.id, eventTitle: event.title, messageId: msg.id, channelName: null } as object,
          })),
        }).catch(err => log.warn({ err: err instanceof Error ? err.message : err }, 'event mention notification creation failed'));

        for (const uid of targetUserIds) {
          _io.to(`user:${uid}`).emit('notification-created', {
            id: `evt-mention-${msg.id}-${uid}`,
            serverId: event.serverId,
            channelId,
            type: mentions?.everyone ? 'everyone' : 'mention',
            title: `Event reminder: ${event.title}`,
            body: mentionContent,
            metadata: { eventId: event.id, eventTitle: event.title, messageId: msg.id },
            createdAt: new Date().toISOString(),
          });
        }
      }
    }
  }
}

export function startEventReminderWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;

  const worker = new Worker('event-reminder', processJob, {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: 30_000,
  });

  worker.on('failed', (job, err) => {
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (job && job.attemptsMade >= maxAttempts) {
      log.error({ jobId: job.id, err, attemptsMade: job.attemptsMade }, 'DEAD_LETTER: event reminder job permanently failed');
    } else {
      log.warn({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'event reminder job failed (will retry)');
    }
  });

  log.info('event reminder worker started');
  return worker;
}
