// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';

// Seed an encrypted group DM directly (bypasses the key-bundle setup the create
// endpoint requires). owner joined first, then m1.
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

let owner: TestUser, m1: TestUser, m2: TestUser, m3: TestUser;

beforeEach(async () => {
  await cleanupTestData();
  owner = await createTestUser();
  m1 = await createTestUser();
  m2 = await createTestUser();
  m3 = await createTestUser();
});

afterAll(cleanupTestData);

describe('POST /api/v1/dms/:dmChannelId/members – owner-only add policy', () => {
  it('non-owner participant cannot add members: 403', async () => {
    // owner + m1 are participants; owner is the group owner.
    const ch = await seedGroup(owner.id, [m1.id]);
    // m1 (a non-owner participant) attempts to add m3.
    const res = await request(app)
      .post(`/api/v1/dms/${ch.id}/members`)
      .set('Authorization', authHeader(m1.token))
      .send({ memberIds: [m3.id] });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Only the group owner can add members' });
    // m3 was not added.
    const added = await prisma.dMParticipant.findUnique({
      where: { userId_dmChannelId: { userId: m3.id, dmChannelId: ch.id } },
    });
    expect(added).toBeNull();
  });

  it('owner can add a member: 200', async () => {
    const ch = await seedGroup(owner.id, [m1.id]);
    const res = await request(app)
      .post(`/api/v1/dms/${ch.id}/members`)
      .set('Authorization', authHeader(owner.token))
      .send({ memberIds: [m2.id] });
    expect(res.status).toBe(200);
    const added = await prisma.dMParticipant.findUnique({
      where: { userId_dmChannelId: { userId: m2.id, dmChannelId: ch.id } },
    });
    expect(added).not.toBeNull();
  });
});
