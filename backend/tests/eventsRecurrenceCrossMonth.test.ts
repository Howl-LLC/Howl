// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression test for the calendar GET /events filter.
 *
 * Before the fix, the endpoint required `endTime > rangeStart` AND
 * `startTime < rangeEnd`. A recurring event's stored endTime is the original
 * occurrence's end (typically minutes/hours after startTime), so a WEEKLY
 * event created in a prior month had its row filtered out of every
 * subsequent month query — recurring events vanished from the calendar
 * after the user navigated past their creation month.
 *
 * The fix relaxes the WHERE clause: recurring rows whose recurrence window
 * (recurrenceEndDate IS NULL OR > rangeStart) overlaps the queried range
 * are returned even when the original endTime is in the past.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import {
  createTestUser,
  createTestServer,
  authHeader,
  cleanupTestData,
  type TestUser,
} from './helpers.js';

let owner: TestUser;
let serverId: string;

beforeAll(async () => {
  await cleanupTestData();
  owner = await createTestUser();
  const server = await createTestServer(owner.id);
  serverId = server.id;
});

afterAll(async () => {
  await cleanupTestData();
});

function previousMonthDate(): Date {
  const d = new Date();
  // Anchor at mid-month of the previous month at 10:00 UTC. Mid-month avoids
  // edge cases when "today" lands on month boundaries.
  d.setUTCDate(15);
  d.setUTCMonth(d.getUTCMonth() - 1);
  d.setUTCHours(10, 0, 0, 0);
  return d;
}

describe('GET /api/v1/servers/:serverId/events — cross-month recurrence', () => {
  it('returns a WEEKLY recurring event created last month when querying this month', async () => {
    const start = previousMonthDate();
    const end = new Date(start.getTime() + 60 * 60 * 1000); // +1 hour
    const recurring = await prisma.serverEvent.create({
      data: {
        serverId,
        title: 'Weekly standup',
        startTime: start,
        endTime: end,
        allDay: false,
        color: '#378ADD',
        timezone: 'UTC',
        createdById: owner.id,
        recurrenceRule: 'WEEKLY',
        recurrenceEndDate: null, // indefinite
      },
    });

    const now = new Date();
    const res = await request(app)
      .get(`/api/v1/servers/${serverId}/events`)
      .query({ month: now.getUTCMonth() + 1, year: now.getUTCFullYear() })
      .set('Authorization', authHeader(owner.token));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: recurring.id, recurrenceRule: 'WEEKLY' })]),
    );
  });

  it('does NOT return a non-recurring event from last month when querying this month', async () => {
    const start = previousMonthDate();
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const oneOff = await prisma.serverEvent.create({
      data: {
        serverId,
        title: 'One-off lunch',
        startTime: start,
        endTime: end,
        allDay: false,
        color: '#378ADD',
        timezone: 'UTC',
        createdById: owner.id,
        recurrenceRule: 'NONE',
        recurrenceEndDate: null,
      },
    });

    const now = new Date();
    const res = await request(app)
      .get(`/api/v1/servers/${serverId}/events`)
      .query({ month: now.getUTCMonth() + 1, year: now.getUTCFullYear() })
      .set('Authorization', authHeader(owner.token));

    expect(res.status).toBe(200);
    expect(res.body.find((e: { id: string }) => e.id === oneOff.id)).toBeUndefined();
  });

  it('does NOT return a recurring event whose recurrenceEndDate is before the queried month', async () => {
    const start = previousMonthDate();
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    // recurrenceEndDate set to 5 days after start — well before this month
    const expiredEnd = new Date(start.getTime() + 5 * 24 * 60 * 60 * 1000);
    const expired = await prisma.serverEvent.create({
      data: {
        serverId,
        title: 'Expired weekly',
        startTime: start,
        endTime: end,
        allDay: false,
        color: '#378ADD',
        timezone: 'UTC',
        createdById: owner.id,
        recurrenceRule: 'WEEKLY',
        recurrenceEndDate: expiredEnd,
      },
    });

    const now = new Date();
    const res = await request(app)
      .get(`/api/v1/servers/${serverId}/events`)
      .query({ month: now.getUTCMonth() + 1, year: now.getUTCFullYear() })
      .set('Authorization', authHeader(owner.token));

    expect(res.status).toBe(200);
    expect(res.body.find((e: { id: string }) => e.id === expired.id)).toBeUndefined();
  });
});
