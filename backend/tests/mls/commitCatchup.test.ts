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
let dmChannelId: string;

async function submitNextCommit(baseEpoch: string) {
  const joiner = await HarnessClient.create(randomUUID(), randomUUID());
  const add = await client.commitAdd(await joiner.publishKeyPackageB64());
  const res = await request(app)
    .post(`/api/v1/mls/groups/${groupId}/commits`)
    .set('Authorization', authHeader(alice.token))
    .send({ baseEpoch, mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID() });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  alice = await createTestUser();
  outsider = await createTestUser();
  const channel = await prisma.dMChannel.create({ data: { participants: { create: [{ userId: alice.id }] } }, select: { id: true } });
  dmChannelId = channel.id;
  client = await HarnessClient.create(alice.id, '00000000-0000-4000-8000-0000000000f1');
  await client.createGroup();
  const created = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId, groupInfo: await client.publishGroupInfoB64() });
  groupId = created.body.groupId;
  await submitNextCommit('0');
  await submitNextCommit('1');
  await submitNextCommit('2');
});
afterAll(async () => {
  await prisma.mlsCommit.deleteMany({});
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
});

describe('GET /api/v1/mls/groups/:groupId/commits', () => {
  it('returns commits at/after sinceEpoch, ordered by epoch', async () => {
    const res = await request(app)
      .get(`/api/v1/mls/groups/${groupId}/commits`)
      .query({ sinceEpoch: '0' })
      .set('Authorization', authHeader(alice.token));
    expect(res.status).toBe(200);
    expect(res.body.commits.map((c: { baseEpoch: string }) => c.baseEpoch)).toEqual(['0', '1', '2']);
    expect(res.body.commits[0].commit).toEqual(expect.any(String));
    expect(res.body.commits[0].resultingEpoch).toBe('1');
  });

  it('honors sinceEpoch as a lower bound', async () => {
    const res = await request(app).get(`/api/v1/mls/groups/${groupId}/commits`).query({ sinceEpoch: '2' }).set('Authorization', authHeader(alice.token));
    expect(res.body.commits.map((c: { baseEpoch: string }) => c.baseEpoch)).toEqual(['2']);
  });

  it('caps results at the limit', async () => {
    const res = await request(app).get(`/api/v1/mls/groups/${groupId}/commits`).query({ sinceEpoch: '0', limit: '2' }).set('Authorization', authHeader(alice.token));
    expect(res.body.commits).toHaveLength(2);
  });

  it('rejects a non-participant with 403', async () => {
    const res = await request(app).get(`/api/v1/mls/groups/${groupId}/commits`).query({ sinceEpoch: '0' }).set('Authorization', authHeader(outsider.token));
    expect(res.status).toBe(403);
  });

  it('rejects a participant marked pendingRemoval with 403', async () => {
    const leaving = await createTestUser();
    await prisma.dMParticipant.create({
      data: { dmChannelId, userId: leaving.id, pendingRemoval: new Date() },
    });
    const res = await request(app)
      .get(`/api/v1/mls/groups/${groupId}/commits`)
      .query({ sinceEpoch: '0' })
      .set('Authorization', authHeader(leaving.token));
    expect(res.status).toBe(403);
  });
});
