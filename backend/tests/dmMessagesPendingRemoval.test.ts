// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';

let alice: TestUser; // active
let bob: TestUser;   // pendingRemoval
let dmChannelId: string;

beforeEach(async () => {
  await cleanupTestData();
  alice = await createTestUser();
  bob = await createTestUser();
  const channel = await prisma.dMChannel.create({
    data: { isGroup: true, ownerId: alice.id, participants: { create: [{ userId: alice.id }, { userId: bob.id, pendingRemoval: new Date() }] } },
    select: { id: true },
  });
  dmChannelId = channel.id;
});
afterAll(cleanupTestData);

describe('a pendingRemoval member is denied every message seam', () => {
  it('403 on GET messages', async () => {
    const res = await request(app).get(`/api/v1/dms/${dmChannelId}/messages`).set('Authorization', authHeader(bob.token));
    expect(res.status).toBe(403);
  });
  it('403 on POST send', async () => {
    const res = await request(app).post(`/api/v1/dms/${dmChannelId}/messages`).set('Authorization', authHeader(bob.token)).send({ content: 'hi' });
    expect(res.status).toBe(403);
  });
  it('403 on GET pins', async () => {
    const res = await request(app).get(`/api/v1/dms/${dmChannelId}/pins`).set('Authorization', authHeader(bob.token));
    expect(res.status).toBe(403);
  });
  // For the seams below the participant 403 guard precedes the message-existence
  // 404 lookup, so a random/non-existent messageId still hits 403 (the guard
  // fires first). Verified by reading each handler in routes/dmMessages.ts.
  it('403 on POST pin', async () => {
    const res = await request(app).post(`/api/v1/dms/${dmChannelId}/messages/${randomUUID()}/pin`).set('Authorization', authHeader(bob.token));
    expect(res.status).toBe(403);
  });
  it('403 on DELETE unpin', async () => {
    const res = await request(app).delete(`/api/v1/dms/${dmChannelId}/messages/${randomUUID()}/pin`).set('Authorization', authHeader(bob.token));
    expect(res.status).toBe(403);
  });
  it('403 on PATCH edit', async () => {
    const res = await request(app).patch(`/api/v1/dms/${dmChannelId}/messages/${randomUUID()}`).set('Authorization', authHeader(bob.token)).send({ content: 'edited' });
    expect(res.status).toBe(403);
  });
  it('403 on DELETE message', async () => {
    const res = await request(app).delete(`/api/v1/dms/${dmChannelId}/messages/${randomUUID()}`).set('Authorization', authHeader(bob.token));
    expect(res.status).toBe(403);
  });
  it('403 on PUT reactions', async () => {
    const res = await request(app).put(`/api/v1/dms/${dmChannelId}/messages/${randomUUID()}/reactions`).set('Authorization', authHeader(bob.token)).send({ emoji: '👍' });
    expect(res.status).toBe(403);
  });
  it('an ACTIVE member still reads (not 403)', async () => {
    const res = await request(app).get(`/api/v1/dms/${dmChannelId}/messages`).set('Authorization', authHeader(alice.token));
    expect(res.status).not.toBe(403);
  });
});

describe('dm-mention skips a pendingRemoval member', () => {
  it('does not increment mentionCount for a pendingRemoval mentioned user', async () => {
    // alice (active) and bob (pendingRemoval) share an UNENCRYPTED group (mention
    // tracking only runs for unencrypted group channels). `encrypted` is omitted
    // so it takes the schema default of false — passing `encrypted: false`
    // explicitly trips the db.ts downgrade guard.
    const channel = await prisma.dMChannel.create({
      data: { isGroup: true, ownerId: alice.id, participants: { create: [{ userId: alice.id }, { userId: bob.id, pendingRemoval: new Date() }] } },
      select: { id: true },
    });
    const res = await request(app).post(`/api/v1/dms/${channel.id}/messages`).set('Authorization', authHeader(alice.token)).send({ content: `hey @${bob.username}` });
    expect(res.status).toBe(201);
    // Give the fire-and-forget mention task a tick to run.
    await new Promise((r) => setTimeout(r, 50));
    const row = await prisma.dMParticipant.findUnique({ where: { userId_dmChannelId: { userId: bob.id, dmChannelId: channel.id } } });
    expect(row?.mentionCount ?? 0).toBe(0);
  });
});
