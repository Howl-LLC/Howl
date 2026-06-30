// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Server as IOServer } from 'socket.io';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { getParam, hasPermission, loadPermissionContext, getEffectivePlan } from '../utils.js';
import { createAuditLog } from './serverSettings.js';
import { createEventSchema, updateEventSchema, eventMonthQuery, eventRsvpSchema, EVENT_REMINDER_TIMINGS } from '../schemas.js';
import { getClientIp } from '../utils/clientIp.js';

function getIO(req: AuthRequest): IOServer | null {
  return req.app.get('io') as IOServer ?? null;
}

const router = Router({ mergeParams: true });

// Rate limiters

const eventReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:evt-read:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const eventMutationLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:evt-mutate:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const eventRsvpLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:evt-rsvp:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

// Helpers

const REMINDER_OFFSETS: Record<string, number> = {
  AT_START: 0,
  '15_MIN': 15 * 60 * 1000,
  '1_HOUR': 60 * 60 * 1000,
  '1_DAY': 24 * 60 * 60 * 1000,
  '1_WEEK': 7 * 24 * 60 * 60 * 1000,
};

function computeReminderFireTime(startTime: Date, timing: string): Date {
  return new Date(startTime.getTime() - (REMINDER_OFFSETS[timing] ?? 0));
}

const MAX_EVENT_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const RSVP_GRACE_MS = 24 * 60 * 60 * 1000;

function normalizeEvent(event: any, currentUserId?: string) {
  const rsvpCounts = { going: 0, interested: 0, declined: 0 };
  let myRsvp: string | null = null;
  const goingUserIds: string[] = [];
  for (const r of event.rsvps ?? []) {
    if (r.status === 'GOING') { rsvpCounts.going++; if (goingUserIds.length < 3) goingUserIds.push(r.userId); }
    else if (r.status === 'INTERESTED') rsvpCounts.interested++;
    else if (r.status === 'DECLINED') rsvpCounts.declined++;
    if (r.userId === currentUserId) myRsvp = r.status;
  }
  return {
    id: event.id,
    serverId: event.serverId,
    title: event.title,
    description: event.description,
    startTime: event.startTime.toISOString(),
    endTime: event.endTime.toISOString(),
    allDay: event.allDay,
    color: event.color,
    timezone: event.timezone,
    reminderChannelId: event.reminderChannelId,
    createdById: event.createdById,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
    reminders: (event.reminders ?? []).map((r: { id: string; timing: string; sent: boolean }) => ({
      id: r.id, timing: r.timing, sent: r.sent,
    })),
    invitees: (event.invitees ?? []).map((inv: { id: string; scope: string; targetId: string | null }) => ({
      id: inv.id, scope: inv.scope, targetId: inv.targetId,
    })),
    recurrenceRule: event.recurrenceRule ?? 'NONE',
    recurrenceDays: event.recurrenceDays ?? null,
    recurrenceEndDate: event.recurrenceEndDate?.toISOString?.() ?? event.recurrenceEndDate ?? null,
    voiceChannelId: event.voiceChannelId ?? null,
    reminderMentions: event.reminderMentions ?? null,
    rsvpCounts,
    myRsvp,
    rsvpGoingUserIds: goingUserIds,
  };
}

const EVENT_INCLUDE_WITH_RSVPS = {
  reminders: true,
  rsvps: { take: 200 },
  invitees: true,
} as const;

/** Check if a user is invited to an event (by direct invite, role, or EVERYONE scope). */
function isUserInvited(
  event: { invitees?: Array<{ scope: string; targetId: string | null }> },
  userId: string,
  member: { roleId?: string | null; serverRole?: { id: string } | null },
): boolean {
  const invitees = event.invitees ?? [];
  if (invitees.length === 0) return true; // No invitees = visible to all
  const memberRoleId = member.roleId ?? member.serverRole?.id ?? null;
  for (const inv of invitees) {
    if (inv.scope === 'EVERYONE') return true;
    if (inv.scope === 'USER' && inv.targetId === userId) return true;
    if (inv.scope === 'ROLE' && memberRoleId && inv.targetId === memberRoleId) return true;
  }
  return false;
}

const MAX_USER_INVITEES = 20;

// GET /servers/:serverId/events

router.get(
  '/:serverId/events',
  validateUuidParams('serverId'),
  authenticateToken,
  eventReadLimiter,
  validate(eventMonthQuery),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a member of this server' });
    if (!hasPermission(permCtx,'viewCalendar')) {
      return res.status(403).json({ error: 'You need the View Calendar permission' });
    }

    const now = new Date();
    const month = Math.min(Math.max(Number(req.query.month) || (now.getMonth() + 1), 1), 12);
    const year = Math.min(Math.max(Number(req.query.year) || now.getFullYear(), 2020), 2100);

    const rangeStart = new Date(Date.UTC(year, month - 1, 1));
    const rangeEnd = new Date(Date.UTC(year, month, 1));

    const events = await prisma.serverEvent.findMany({
      where: {
        serverId,
        startTime: { lt: rangeEnd },
        OR: [
          // Direct overlap: covers non-recurring events and the original
          // occurrence of a recurring event that lives inside the range.
          { endTime: { gt: rangeStart } },
          // Recurring event whose stored endTime is in a past month but
          // whose recurrence window extends into (or past) this range.
          // Without this branch, a WEEKLY event created in April has
          // endTime=April and would be filtered out of every query for May
          // onward, even though its weekly occurrences clearly belong on
          // those calendars. Indefinite recurrence (recurrenceEndDate=null)
          // is treated as "extends forever".
          {
            recurrenceRule: { not: 'NONE' },
            OR: [
              { recurrenceEndDate: null },
              { recurrenceEndDate: { gt: rangeStart } },
            ],
          },
        ],
      },
      include: EVENT_INCLUDE_WITH_RSVPS,
      orderBy: { startTime: 'asc' },
      take: 500,
    });

    // Filter by invitation visibility: managers and creators see all; others only invited events
    const canManage = hasPermission(permCtx,'manageCalendar');
    const visible = events.filter((e) =>
      canManage || e.createdById === req.userId || isUserInvited(e, req.userId!, member),
    );

    return res.json(visible.map((e) => normalizeEvent(e, req.userId)));
  }),
);

// GET /servers/:serverId/events/:eventId

router.get(
  '/:serverId/events/:eventId',
  validateUuidParams('serverId', 'eventId'),
  authenticateToken,
  eventReadLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const eventId = getParam(req, 'eventId');

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a member of this server' });
    if (!hasPermission(permCtx,'viewCalendar')) {
      return res.status(403).json({ error: 'You need the View Calendar permission' });
    }

    const event = await prisma.serverEvent.findUnique({
      where: { id: eventId },
      include: EVENT_INCLUDE_WITH_RSVPS,
    });
    if (!event || event.serverId !== serverId) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Visibility check
    const canManage = hasPermission(permCtx,'manageCalendar');
    if (!canManage && event.createdById !== req.userId && !isUserInvited(event, req.userId!, member)) {
      return res.status(404).json({ error: 'Event not found' });
    }

    return res.json(normalizeEvent(event, req.userId));
  }),
);

// POST /servers/:serverId/events

router.post(
  '/:serverId/events',
  validateUuidParams('serverId'),
  authenticateToken,
  eventMutationLimiter,
  validate(createEventSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a member of this server' });
    if (!hasPermission(permCtx,'manageCalendar')) {
      return res.status(403).json({ error: 'You need the Manage Calendar permission' });
    }

    const { title, description, startTime, endTime, allDay, color, timezone, reminderChannelId, reminders, invitees, recurrenceRule, recurrenceDays, recurrenceEndDate, voiceChannelId, reminderMentions } = req.body;

    const startDate = new Date(startTime);
    const endDate = new Date(endTime);
    if (endDate <= startDate) {
      return res.status(400).json({ error: 'End time must be after start time' });
    }
    if (endDate.getTime() - startDate.getTime() > MAX_EVENT_DURATION_MS) {
      return res.status(400).json({ error: 'Event duration cannot exceed 30 days' });
    }

    // Validate reminderChannelId belongs to this server and is a text channel
    if (reminderChannelId) {
      const channel = await prisma.channel.findFirst({
        where: { id: reminderChannelId, serverId, type: 'text' },
        select: { id: true },
      });
      if (!channel) {
        return res.status(400).json({ error: 'Reminder channel must be a text channel in this server' });
      }
    }

    // Validate voiceChannelId
    if (voiceChannelId) {
      const vch = await prisma.channel.findFirst({
        where: { id: voiceChannelId, serverId, type: 'voice' },
        select: { id: true },
      });
      if (!vch) {
        return res.status(400).json({ error: 'Voice channel must be a voice channel in this server' });
      }
    }

    // Validate invitees targets
    if (invitees && invitees.length > 0) {
      const userInvitees = invitees.filter((i: { scope: string }) => i.scope === 'USER');
      if (userInvitees.length > MAX_USER_INVITEES) {
        return res.status(400).json({ error: `Maximum ${MAX_USER_INVITEES} individual user invitations per event` });
      }
      for (const inv of invitees) {
        if (inv.scope === 'EVERYONE' && inv.targetId) {
          return res.status(400).json({ error: 'EVERYONE scope must not have a targetId' });
        }
        if (inv.scope === 'ROLE') {
          if (!inv.targetId) return res.status(400).json({ error: 'ROLE scope requires a targetId' });
          const role = await prisma.serverRole.findFirst({ where: { id: inv.targetId, serverId }, select: { id: true } });
          if (!role) return res.status(400).json({ error: `Role ${inv.targetId} not found in this server` });
        }
        if (inv.scope === 'USER') {
          if (!inv.targetId) return res.status(400).json({ error: 'USER scope requires a targetId' });
          const mem = await prisma.serverMember.findUnique({
            where: { userId_serverId: { userId: inv.targetId, serverId } },
            select: { userId: true },
          });
          if (!mem) return res.status(400).json({ error: `User ${inv.targetId} is not a member of this server` });
        }
      }
    }

    // Validate reminderMentions roleIds belong to this server
    if (reminderMentions?.roleIds?.length) {
      const validRoles = await prisma.serverRole.findMany({
        where: { id: { in: reminderMentions.roleIds }, serverId },
        select: { id: true },
      });
      const validIds = new Set(validRoles.map((r: { id: string }) => r.id));
      const invalidIds = reminderMentions.roleIds.filter((id: string) => !validIds.has(id));
      if (invalidIds.length > 0) {
        return res.status(400).json({ error: `Invalid role IDs: ${invalidIds.join(', ')}` });
      }
    }

    // Permission check: @everyone/@here require mentionEveryone permission
    if (reminderMentions?.everyone || reminderMentions?.here) {
      if (!hasPermission(permCtx,'mentionEveryone')) {
        return res.status(403).json({ error: 'You need the Mention Everyone permission to use @everyone or @here in reminders' });
      }
    }

    // Check event cap: 200 free / 500 pro (based on server owner's plan)
    const ownerMember = await prisma.serverMember.findFirst({
      where: { serverId, role: 'owner' },
      select: { userId: true },
    });
    const ownerUser = ownerMember ? await prisma.user.findUnique({
      where: { id: ownerMember.userId },
      select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true },
    }) : null;
    const plan = ownerUser ? getEffectivePlan(ownerUser) : 'free';
    const maxEvents = plan === 'free' ? 200 : 500;

    const eventCount = await prisma.serverEvent.count({ where: { serverId } });
    if (eventCount >= maxEvents) {
      return res.status(403).json({ error: `Event limit reached (${maxEvents}). ${plan === 'free' ? 'Upgrade to Pro for more.' : ''}` });
    }

    // Build reminders, skipping those whose fire time is in the past
    const now = new Date();
    const reminderData = (reminders ?? ([] as typeof EVENT_REMINDER_TIMINGS[number][])).filter((timing: typeof EVENT_REMINDER_TIMINGS[number]) => {
      const fireTime = computeReminderFireTime(startDate, timing);
      return fireTime > now;
    }).map((timing: typeof EVENT_REMINDER_TIMINGS[number]) => ({ timing }));

    const event = await prisma.$transaction(async (tx) => {
      const created = await tx.serverEvent.create({
        data: {
          serverId,
          title,
          description,
          startTime: startDate,
          endTime: endDate,
          allDay: allDay ?? false,
          color: color ?? '#378ADD',
          timezone: timezone ?? 'UTC',
          reminderChannelId: reminderChannelId ?? null,
          createdById: req.userId!,
          recurrenceRule: recurrenceRule ?? 'NONE',
          recurrenceDays: recurrenceDays ?? undefined,
          recurrenceEndDate: recurrenceEndDate ? new Date(recurrenceEndDate) : null,
          voiceChannelId: voiceChannelId ?? null,
          reminderMentions: reminderMentions ?? null,
        },
      });

      if (reminderData.length > 0) {
        await tx.eventReminder.createMany({
          data: reminderData.map((r: { timing: string }) => ({
            eventId: created.id,
            timing: r.timing,
          })),
        });
      }

      if (invitees && invitees.length > 0) {
        await tx.eventInvitee.createMany({
          data: invitees.map((inv: { scope: string; targetId?: string }) => ({
            eventId: created.id,
            scope: inv.scope,
            targetId: inv.scope === 'EVERYONE' ? null : inv.targetId ?? null,
          })),
        });
      }

      return tx.serverEvent.findUnique({
        where: { id: created.id },
        include: EVENT_INCLUDE_WITH_RSVPS,
      });
    });

    await createAuditLog(serverId, req.userId!, 'event_create', 'event', event!.id, { title }).catch(() => {});

    const normalized = normalizeEvent(event, req.userId);
    const io = getIO(req);
    if (io) {
      io.to(`server:${serverId}`).emit('server-event-created', normalized);
      io.to(`server:${serverId}`).emit('calendar-activity', {
        serverId, type: 'change', eventId: event!.id, eventTitle: title,
      });
    }

    return res.status(201).json(normalized);
  }),
);

// PATCH /servers/:serverId/events/:eventId

router.patch(
  '/:serverId/events/:eventId',
  validateUuidParams('serverId', 'eventId'),
  authenticateToken,
  eventMutationLimiter,
  validate(updateEventSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const eventId = getParam(req, 'eventId');

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a member of this server' });
    if (!hasPermission(permCtx,'manageCalendar')) {
      return res.status(403).json({ error: 'You need the Manage Calendar permission' });
    }

    const existing = await prisma.serverEvent.findUnique({ where: { id: eventId } });
    if (!existing || existing.serverId !== serverId) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const { title, description, startTime, endTime, allDay, color, timezone, reminderChannelId, reminders, invitees, recurrenceRule, recurrenceDays, recurrenceEndDate, voiceChannelId, reminderMentions } = req.body;

    const newStart = startTime ? new Date(startTime) : existing.startTime;
    const newEnd = endTime ? new Date(endTime) : existing.endTime;

    if (newEnd <= newStart) {
      return res.status(400).json({ error: 'End time must be after start time' });
    }
    if (newEnd.getTime() - newStart.getTime() > MAX_EVENT_DURATION_MS) {
      return res.status(400).json({ error: 'Event duration cannot exceed 30 days' });
    }

    // Validate reminderChannelId if provided (and not null)
    if (reminderChannelId !== undefined && reminderChannelId !== null) {
      const channel = await prisma.channel.findFirst({
        where: { id: reminderChannelId, serverId, type: 'text' },
        select: { id: true },
      });
      if (!channel) {
        return res.status(400).json({ error: 'Reminder channel must be a text channel in this server' });
      }
    }

    // Validate invitees if provided
    if (invitees !== undefined && invitees.length > 0) {
      const userInvitees = invitees.filter((i: { scope: string }) => i.scope === 'USER');
      if (userInvitees.length > MAX_USER_INVITEES) {
        return res.status(400).json({ error: `Maximum ${MAX_USER_INVITEES} individual user invitations per event` });
      }
      for (const inv of invitees) {
        if (inv.scope === 'EVERYONE' && inv.targetId) {
          return res.status(400).json({ error: 'EVERYONE scope must not have a targetId' });
        }
        if (inv.scope === 'ROLE') {
          if (!inv.targetId) return res.status(400).json({ error: 'ROLE scope requires a targetId' });
          const role = await prisma.serverRole.findFirst({ where: { id: inv.targetId, serverId }, select: { id: true } });
          if (!role) return res.status(400).json({ error: `Role ${inv.targetId} not found in this server` });
        }
        if (inv.scope === 'USER') {
          if (!inv.targetId) return res.status(400).json({ error: 'USER scope requires a targetId' });
          const mem = await prisma.serverMember.findUnique({
            where: { userId_serverId: { userId: inv.targetId, serverId } },
            select: { userId: true },
          });
          if (!mem) return res.status(400).json({ error: `User ${inv.targetId} is not a member of this server` });
        }
      }
    }

    // Validate voiceChannelId if provided
    if (voiceChannelId !== undefined && voiceChannelId !== null) {
      const vch = await prisma.channel.findFirst({
        where: { id: voiceChannelId, serverId, type: 'voice' },
        select: { id: true },
      });
      if (!vch) {
        return res.status(400).json({ error: 'Voice channel must be a voice channel in this server' });
      }
    }

    // Validate reminderMentions roleIds belong to this server
    if (reminderMentions?.roleIds?.length) {
      const validRoles = await prisma.serverRole.findMany({
        where: { id: { in: reminderMentions.roleIds }, serverId },
        select: { id: true },
      });
      const validIds = new Set(validRoles.map((r: { id: string }) => r.id));
      const invalidIds = reminderMentions.roleIds.filter((id: string) => !validIds.has(id));
      if (invalidIds.length > 0) {
        return res.status(400).json({ error: `Invalid role IDs: ${invalidIds.join(', ')}` });
      }
    }

    // Permission check: @everyone/@here require mentionEveryone permission
    if (reminderMentions?.everyone || reminderMentions?.here) {
      if (!hasPermission(permCtx,'mentionEveryone')) {
        return res.status(403).json({ error: 'You need the Mention Everyone permission to use @everyone or @here in reminders' });
      }
    }

    const timesChanged = startTime !== undefined || endTime !== undefined;
    const remindersProvided = reminders !== undefined;

    const updated = await prisma.$transaction(async (tx) => {
      // Build update data, only including provided fields
      const updateData: Record<string, unknown> = {};
      if (title !== undefined) updateData.title = title;
      if (description !== undefined) updateData.description = description;
      if (startTime !== undefined) updateData.startTime = newStart;
      if (endTime !== undefined) updateData.endTime = newEnd;
      if (allDay !== undefined) updateData.allDay = allDay;
      if (color !== undefined) updateData.color = color;
      if (timezone !== undefined) updateData.timezone = timezone;
      if (reminderChannelId !== undefined) updateData.reminderChannelId = reminderChannelId;
      if (recurrenceRule !== undefined) updateData.recurrenceRule = recurrenceRule;
      if (recurrenceDays !== undefined) updateData.recurrenceDays = recurrenceDays;
      if (recurrenceEndDate !== undefined) updateData.recurrenceEndDate = recurrenceEndDate ? new Date(recurrenceEndDate) : null;
      if (voiceChannelId !== undefined) updateData.voiceChannelId = voiceChannelId;
      if (reminderMentions !== undefined) updateData.reminderMentions = reminderMentions;

      await tx.serverEvent.update({ where: { id: eventId }, data: updateData });

      // Recalculate reminders if times changed or reminders explicitly provided
      if (timesChanged || remindersProvided) {
        // Delete all unsent reminders
        await tx.eventReminder.deleteMany({
          where: { eventId, sent: false },
        });

        // Determine which timings to create
        const now = new Date();
        let timingsToCreate: string[];

        if (remindersProvided) {
          // Use the explicitly provided list
          timingsToCreate = (reminders as string[]).filter((timing: string) => {
            const fireTime = computeReminderFireTime(newStart, timing);
            return fireTime > now;
          });
        } else {
          // Times changed but no new reminders list — re-create from existing unsent timings
          // (already deleted above, so fetch the sent ones to know what was originally set)
          const sentReminders = await tx.eventReminder.findMany({
            where: { eventId, sent: true },
            select: { timing: true },
          });
          const sentTimings = new Set(sentReminders.map((r) => r.timing));
          // Re-create all standard timings that weren't already sent and are still in the future
          timingsToCreate = Object.keys(REMINDER_OFFSETS).filter((timing) => {
            if (sentTimings.has(timing)) return false;
            const fireTime = computeReminderFireTime(newStart, timing);
            return fireTime > now;
          });
          // Only re-create if the event originally had reminders (check if any sent exist)
          if (sentReminders.length === 0) {
            // No sent reminders means the event had no reminders originally — keep it that way
            timingsToCreate = [];
          }
        }

        if (timingsToCreate.length > 0) {
          await tx.eventReminder.createMany({
            data: timingsToCreate.map((timing) => ({
              eventId,
              timing,
            })),
          });
        }
      }

      // Full replacement of invitees if provided
      if (invitees !== undefined) {
        await tx.eventInvitee.deleteMany({ where: { eventId } });
        if (invitees.length > 0) {
          await tx.eventInvitee.createMany({
            data: invitees.map((inv: { scope: string; targetId?: string }) => ({
              eventId,
              scope: inv.scope,
              targetId: inv.scope === 'EVERYONE' ? null : inv.targetId ?? null,
            })),
          });
        }
      }

      return tx.serverEvent.findUnique({
        where: { id: eventId },
        include: EVENT_INCLUDE_WITH_RSVPS,
      });
    });

    await createAuditLog(serverId, req.userId!, 'event_update', 'event', eventId, { title: title ?? existing.title }).catch(() => {});

    const normalized = normalizeEvent(updated, req.userId);
    const io = getIO(req);
    if (io) {
      io.to(`server:${serverId}`).emit('server-event-updated', normalized);
      io.to(`server:${serverId}`).emit('calendar-activity', { serverId, type: 'change', eventId });
    }

    return res.json(normalized);
  }),
);

// DELETE /servers/:serverId/events/:eventId

router.delete(
  '/:serverId/events/:eventId',
  validateUuidParams('serverId', 'eventId'),
  authenticateToken,
  eventMutationLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const eventId = getParam(req, 'eventId');

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a member of this server' });
    if (!hasPermission(permCtx,'manageCalendar')) {
      return res.status(403).json({ error: 'You need the Manage Calendar permission' });
    }

    const event = await prisma.serverEvent.findUnique({
      where: { id: eventId },
      select: { id: true, serverId: true, title: true },
    });
    if (!event || event.serverId !== serverId) {
      return res.status(404).json({ error: 'Event not found' });
    }

    await prisma.serverEvent.delete({ where: { id: eventId } });

    await createAuditLog(serverId, req.userId!, 'event_delete', 'event', eventId, { title: event.title }).catch(() => {});

    const io = getIO(req);
    if (io) {
      io.to(`server:${serverId}`).emit('server-event-deleted', { serverId, eventId });
      io.to(`server:${serverId}`).emit('calendar-activity', { serverId, type: 'change', eventId });
    }

    return res.json({ success: true });
  }),
);

// PUT /servers/:serverId/events/:eventId/rsvp

router.put(
  '/:serverId/events/:eventId/rsvp',
  validateUuidParams('serverId', 'eventId'),
  authenticateToken,
  eventRsvpLimiter,
  validate(eventRsvpSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const eventId = getParam(req, 'eventId');

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a member of this server' });
    if (!hasPermission(permCtx,'viewCalendar')) {
      return res.status(403).json({ error: 'You need the View Calendar permission' });
    }

    const event = await prisma.serverEvent.findUnique({
      where: { id: eventId },
      select: { id: true, serverId: true, endTime: true },
    });
    if (!event || event.serverId !== serverId) {
      return res.status(404).json({ error: 'Event not found' });
    }

    if (Date.now() > event.endTime.getTime() + RSVP_GRACE_MS) {
      return res.status(400).json({ error: 'RSVP period has ended for this event' });
    }

    const { status } = req.body;
    const rsvp = await prisma.eventRsvp.upsert({
      where: { eventId_userId: { eventId, userId: req.userId } },
      create: { eventId, userId: req.userId, status },
      update: { status },
    });

    const io = getIO(req);
    if (io) io.to(`server:${serverId}`).emit('server-event-rsvp', { serverId, eventId, userId: req.userId, status });

    return res.json(rsvp);
  }),
);

// DELETE /servers/:serverId/events/:eventId/rsvp

router.delete(
  '/:serverId/events/:eventId/rsvp',
  validateUuidParams('serverId', 'eventId'),
  authenticateToken,
  eventRsvpLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: 'Missing user' });
    const serverId = getParam(req, 'serverId');
    const eventId = getParam(req, 'eventId');

    const [member, permCtx] = await Promise.all([
      prisma.serverMember.findUnique({
        where: { userId_serverId: { userId: req.userId, serverId } },
        include: { serverRole: true },
      }),
      loadPermissionContext(req.userId, serverId),
    ]);
    if (!member) return res.status(403).json({ error: 'Not a member of this server' });
    if (!hasPermission(permCtx,'viewCalendar')) {
      return res.status(403).json({ error: 'You need the View Calendar permission' });
    }

    const event = await prisma.serverEvent.findUnique({
      where: { id: eventId },
      select: { id: true, serverId: true },
    });
    if (!event || event.serverId !== serverId) {
      return res.status(404).json({ error: 'Event not found' });
    }

    await prisma.eventRsvp.deleteMany({ where: { eventId, userId: req.userId } });

    const io = getIO(req);
    if (io) io.to(`server:${serverId}`).emit('server-event-rsvp', { serverId, eventId, userId: req.userId, status: null });

    return res.json({ success: true });
  }),
);

export default router;
