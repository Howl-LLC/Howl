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
let bob: TestUser;
let stranger: TestUser;
let groupId: string;
let aliceClient: HarnessClient;

beforeAll(async () => {
  alice = await createTestUser();
  bob = await createTestUser();
  stranger = await createTestUser();
  const channel = await prisma.dMChannel.create({ data: { participants: { create: [{ userId: alice.id }, { userId: bob.id }] } }, select: { id: true } });
  aliceClient = await HarnessClient.create(alice.id, '00000000-0000-4000-8000-00000000bb11');
  await aliceClient.createGroup();
  const created = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId: channel.id, groupInfo: await aliceClient.publishGroupInfoB64() });
  groupId = created.body.groupId;

  // alice adds bob, storing a Welcome for bob at epoch 1.
  const bobClient = await HarnessClient.create(bob.id, '00000000-0000-4000-8000-00000000bb22');
  const add = await aliceClient.commitAdd(await bobClient.publishKeyPackageB64());
  await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(alice.token))
    .send({ baseEpoch: '0', mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID(), welcomes: [{ recipientId: bob.id, welcomeData: add.welcomeB64 }] });
});
afterAll(async () => {
  await prisma.mlsWelcome.deleteMany({});
  await prisma.mlsCommit.deleteMany({});
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
});

describe('GET /api/v1/mls/welcomes', () => {
  it('returns the caller pending Welcomes', async () => {
    const res = await request(app).get('/api/v1/mls/welcomes').set('Authorization', authHeader(bob.token));
    expect(res.status).toBe(200);
    expect(res.body.welcomes).toHaveLength(1);
    expect(res.body.welcomes[0].groupId).toBe(groupId);
    expect(res.body.welcomes[0].epoch).toBe('1');
    expect(res.body.welcomes[0].welcomeData).toEqual(expect.any(String));
  });

  it('is recipient-scoped - a stranger sees none', async () => {
    const res = await request(app).get('/api/v1/mls/welcomes').set('Authorization', authHeader(stranger.token));
    expect(res.status).toBe(200);
    expect(res.body.welcomes).toHaveLength(0);
  });
});
