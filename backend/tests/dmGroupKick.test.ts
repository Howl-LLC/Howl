// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';

// Seed an encrypted group DM directly (bypasses key-bundle setup the create
// endpoint requires). owner joined first, then m1, then m2.
async function seedGroup(ownerId: string, memberIds: string[]) {
  const channel = await prisma.dMChannel.create({
    data: { isGroup: true, encrypted: true, ownerId },
  });
  let t = Date.now();
  await prisma.dMParticipant.create({ data: { userId: ownerId, dmChannelId: channel.id, joinedAt: new Date(t++) } });
  for (const uid of memberIds) {
    await prisma.dMParticipant.create({ data: { userId: uid, dmChannelId: channel.id, joinedAt: new Date(t++) } });
  }
  return channel;
}

let owner: TestUser, m1: TestUser, m2: TestUser;

beforeEach(async () => {
  await cleanupTestData();
  owner = await createTestUser();
  m1 = await createTestUser();
  m2 = await createTestUser();
});

afterAll(cleanupTestData);

describe('DELETE /api/v1/dms/:dmChannelId/members/:targetUserId', () => {
  it('owner kicks a member: 200, two-phase pendingRemoval (row survives)', async () => {
    const ch = await seedGroup(owner.id, [m1.id, m2.id]);
    const res = await request(app)
      .delete(`/api/v1/dms/${ch.id}/members/${m2.id}`)
      .set('Authorization', authHeader(owner.token));
    expect(res.status).toBe(200);
    // Two-phase removal: the kick now ALWAYS marks pendingRemoval; the
    // participant row is deleted only when an MLS Remove commit finalizes. The
    // members response does not filter pendingRemoval-marked rows.
    const still = await prisma.dMParticipant.findUnique({
      where: { userId_dmChannelId: { userId: m2.id, dmChannelId: ch.id } },
    });
    expect(still).not.toBeNull();
    expect(still!.pendingRemoval).not.toBeNull();
  });

  it('non-owner cannot kick: 403, participant remains', async () => {
    const ch = await seedGroup(owner.id, [m1.id, m2.id]);
    const res = await request(app)
      .delete(`/api/v1/dms/${ch.id}/members/${m2.id}`)
      .set('Authorization', authHeader(m1.token));
    expect(res.status).toBe(403);
    const still = await prisma.dMParticipant.findUnique({
      where: { userId_dmChannelId: { userId: m2.id, dmChannelId: ch.id } },
    });
    expect(still).not.toBeNull();
    expect(still!.pendingRemoval).toBeNull();
  });

  it('owner cannot kick self: 403', async () => {
    const ch = await seedGroup(owner.id, [m1.id, m2.id]);
    const res = await request(app)
      .delete(`/api/v1/dms/${ch.id}/members/${owner.id}`)
      .set('Authorization', authHeader(owner.token));
    expect(res.status).toBe(403);
  });

  it('kicking a non-member: 404', async () => {
    const ch = await seedGroup(owner.id, [m1.id]);
    const res = await request(app)
      .delete(`/api/v1/dms/${ch.id}/members/${m2.id}`)
      .set('Authorization', authHeader(owner.token));
    expect(res.status).toBe(404);
  });

  it('1:1 / non-group channel: 400', async () => {
    const dm = await prisma.dMChannel.create({ data: { isGroup: false, encrypted: true } });
    await prisma.dMParticipant.create({ data: { userId: owner.id, dmChannelId: dm.id } });
    await prisma.dMParticipant.create({ data: { userId: m1.id, dmChannelId: dm.id } });
    const res = await request(app)
      .delete(`/api/v1/dms/${dm.id}/members/${m1.id}`)
      .set('Authorization', authHeader(owner.token));
    expect(res.status).toBe(400);
  });

  it('owner leaving transfers ownership to the oldest remaining member', async () => {
    const ch = await seedGroup(owner.id, [m1.id, m2.id]); // owner oldest, then m1, then m2
    const res = await request(app)
      .post(`/api/v1/dms/${ch.id}/leave`)
      .set('Authorization', authHeader(owner.token));
    expect(res.status).toBe(204);
    const after = await prisma.dMChannel.findUnique({ where: { id: ch.id }, select: { ownerId: true } });
    expect(after?.ownerId).toBe(m1.id); // m1 is now the oldest remaining
  });
});
