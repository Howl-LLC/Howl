// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for the server-stats worker + insights read endpoint.
 *
 * Covers:
 *   - Worker happy path: counts members + messages, writes DailyServerStats
 *     row, idempotent on second run.
 *   - Worker excludes non-community-enabled servers from the rollup.
 *   - Read endpoint requires auth.
 *   - Read endpoint requires manageServer permission.
 *   - Read endpoint returns the time-series with correct shape + cache header.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { runServerStatsForDate } from '../src/queues/workers/serverStats.worker.js';
import { createTestUser, createTestServer, createTestChannel, cleanupTestData, authHeader } from './helpers.js';

describe('server stats worker + insights read', () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it('worker computes and stores DailyServerStats for a community-enabled server', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    const channel = server.channels[0];

    await prisma.serverSettings.upsert({
      where: { serverId: server.id },
      create: { serverId: server.id, communityEnabled: true },
      update: { communityEnabled: true },
    });

    await prisma.message.createMany({
      data: [
        { channelId: channel.id, authorId: owner.id, content: 'a' },
        { channelId: channel.id, authorId: owner.id, content: 'b' },
      ],
    });

    const today = new Date().toISOString().slice(0, 10);
    const result = await runServerStatsForDate(today);
    expect(result.totalServers).toBe(1);

    const row = await prisma.dailyServerStats.findUnique({
      where: { serverId_date: { serverId: server.id, date: new Date(`${today}T00:00:00.000Z`) } },
    });
    expect(row).toBeTruthy();
    expect(row!.members).toBe(1);
    expect(row!.joins).toBe(1);
    expect(row!.messages).toBe(2);
    expect(row!.voiceMinutes).toBe(0);
    expect(row!.leaves).toBe(0);
  });

  it('worker is idempotent — running twice does not duplicate rows', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverSettings.upsert({
      where: { serverId: server.id },
      create: { serverId: server.id, communityEnabled: true },
      update: { communityEnabled: true },
    });

    const today = new Date().toISOString().slice(0, 10);
    await runServerStatsForDate(today);
    await runServerStatsForDate(today);

    const rows = await prisma.dailyServerStats.findMany({ where: { serverId: server.id } });
    expect(rows.length).toBe(1);
  });

  it('worker skips servers without communityEnabled', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    // No ServerSettings row at all

    const today = new Date().toISOString().slice(0, 10);
    const result = await runServerStatsForDate(today);
    expect(result.totalServers).toBe(0);

    const rows = await prisma.dailyServerStats.findMany({ where: { serverId: server.id } });
    expect(rows.length).toBe(0);
  });

  it('insights endpoint requires authentication', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);

    const res = await request(app).get(`/api/v1/servers/${server.id}/insights`);
    expect(res.status).toBe(401);
  });

  it('insights endpoint returns 403 for a non-member', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    const stranger = await createTestUser();

    const res = await request(app)
      .get(`/api/v1/servers/${server.id}/insights`)
      .set('Authorization', authHeader(stranger.token));
    expect(res.status).toBe(403);
  });

  it('insights endpoint returns 200 with points for owner', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    const channel = server.channels[0];

    await prisma.serverSettings.upsert({
      where: { serverId: server.id },
      create: { serverId: server.id, communityEnabled: true },
      update: { communityEnabled: true },
    });

    await prisma.message.create({
      data: { channelId: channel.id, authorId: owner.id, content: 'hello' },
    });

    // Backfill yesterday so the read window (which excludes today) sees the row.
    const yesterdayDateStr = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // The worker normally targets yesterday — but the messages were created
    // "today" in test, so simulate a yesterday roll-up by writing one
    // directly. Both code paths exercise the same upsert.
    await prisma.dailyServerStats.create({
      data: {
        serverId: server.id,
        date: new Date(`${yesterdayDateStr}T00:00:00.000Z`),
        members: 1,
        joins: 1,
        leaves: 0,
        messages: 1,
        voiceMinutes: 0,
        retainedAfter7d: 0,
      },
    });

    const res = await request(app)
      .get(`/api/v1/servers/${server.id}/insights?range=7d`)
      .set('Authorization', authHeader(owner.token));

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/private/);
    expect(res.body.from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.to).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Array.isArray(res.body.points)).toBe(true);
    expect(res.body.points.length).toBe(1);
    expect(res.body.points[0]).toMatchObject({
      date: yesterdayDateStr,
      members: 1,
      joins: 1,
      leaves: 0,
      messages: 1,
      voiceMinutes: 0,
      retainedAfter7d: 0,
    });
  });

  it('insights endpoint rejects unknown range value', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);

    const res = await request(app)
      .get(`/api/v1/servers/${server.id}/insights?range=1y`)
      .set('Authorization', authHeader(owner.token));

    expect(res.status).toBe(400);
  });
});
