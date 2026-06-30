// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from '../helpers.js';
import { prisma } from '../../src/db.js';
import { HarnessClient } from './harnessClient.js';

let alice: TestUser;
let outsider: TestUser;
let groupId: string;
let client: HarnessClient;
let initialGiB64: string;
let channelId: string;

beforeAll(async () => {
  alice = await createTestUser();
  outsider = await createTestUser();
  const channel = await prisma.dMChannel.create({ data: { participants: { create: [{ userId: alice.id }] } }, select: { id: true } });
  channelId = channel.id;
  client = await HarnessClient.create(alice.id, '00000000-0000-4000-8000-00000000aa11');
  await client.createGroup();
  initialGiB64 = await client.publishGroupInfoB64();
  const created = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId: channel.id, groupInfo: initialGiB64 });
  groupId = created.body.groupId;
});
afterAll(async () => {
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
});

describe('GET /api/v1/mls/groups/:groupId/group-info', () => {
  it('returns the current GroupInfo + epoch', async () => {
    const res = await request(app).get(`/api/v1/mls/groups/${groupId}/group-info`).set('Authorization', authHeader(alice.token));
    expect(res.status).toBe(200);
    expect(res.body.groupInfo).toBe(initialGiB64);
    expect(res.body.groupInfoEpoch).toBe('0');
  });

  it('rejects a non-participant with 403', async () => {
    const res = await request(app).get(`/api/v1/mls/groups/${groupId}/group-info`).set('Authorization', authHeader(outsider.token));
    expect(res.status).toBe(403);
  });

  it('404s for an unknown group', async () => {
    const res = await request(app).get(`/api/v1/mls/groups/${randomUUID()}/group-info`).set('Authorization', authHeader(alice.token));
    expect(res.status).toBe(404);
  });

  it('rejects a participant marked pendingRemoval with 403', async () => {
    const leaving = await createTestUser();
    await prisma.dMParticipant.create({
      data: { dmChannelId: channelId, userId: leaving.id, pendingRemoval: new Date() },
    });
    const res = await request(app)
      .get(`/api/v1/mls/groups/${groupId}/group-info`)
      .set('Authorization', authHeader(leaving.token));
    expect(res.status).toBe(403);
  });
});
