// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from '../helpers.js';
import { prisma } from '../../src/db.js';
import { HarnessClient } from './harnessClient.js';

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;

// Mirror commitRemoveAuthz.test.ts's setupGroupWithBob: owner creates a group DM
// (owner + member are DMParticipants), founds the MLS group, then adds member via a
// private Add (epoch 0 -> 1). `outsider` is deliberately NOT a DMParticipant.
async function setupGroupWithMember(): Promise<{ dmChannelId: string; groupId: string; ownerClient: HarnessClient }> {
  const channel = await prisma.dMChannel.create({
    data: { isGroup: true, ownerId: owner.id, participants: { create: [{ userId: owner.id }, { userId: member.id }] } },
    select: { id: true },
  });
  const ownerClient = await HarnessClient.create(owner.id, randomUUID());
  await ownerClient.createGroup();
  const created = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(owner.token)).send({ dmChannelId: channel.id, groupInfo: await ownerClient.publishGroupInfoB64() });
  const groupId = created.body.groupId;

  // Add member via MLS (private add, accept-both); epoch 0 -> 1.
  const memberClient = await HarnessClient.create(member.id, randomUUID());
  const add = await ownerClient.commitAdd(await memberClient.publishKeyPackageB64(), { wireAsPublicMessage: true });
  const addRes = await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(owner.token))
    .send({ baseEpoch: '0', mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID(), welcomes: [{ recipientId: member.id, welcomeData: add.welcomeB64 }] });
  expect(addRes.status).toBe(200);
  return { dmChannelId: channel.id, groupId, ownerClient };
}

beforeAll(async () => { owner = await createTestUser(); member = await createTestUser(); outsider = await createTestUser(); });
afterAll(async () => {
  await prisma.mlsWelcome.deleteMany({});
  await prisma.mlsCommit.deleteMany({});
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
});

describe('POST /commits — Add authorization (group, public)', () => {
  it('REJECTS a public Add of a non-participant (403 unauthorized_add); epoch unchanged', async () => {
    const { groupId, ownerClient } = await setupGroupWithMember();

    // outsider is NOT a DMParticipant of the channel. A public Add of them must be rejected.
    // No welcome is sent (a welcome to a non-participant would trip the earlier
    // invalid_welcome guard); the Add-authz check on the commit itself is what we exercise.
    const outsiderClient = await HarnessClient.create(outsider.id, randomUUID());
    const add = await ownerClient.commitAdd(await outsiderClient.publishKeyPackageB64(), { wireAsPublicMessage: true });
    const res = await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(owner.token))
      .send({ baseEpoch: '1', mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID() });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('unauthorized_add');
    const group = await prisma.mlsGroup.findUnique({ where: { id: groupId } });
    expect(group?.currentEpoch).toBe(1n);
  });
});
