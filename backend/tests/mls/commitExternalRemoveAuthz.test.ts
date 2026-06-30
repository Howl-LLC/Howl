// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from '../helpers.js';
import { prisma } from '../../src/db.js';
import { HarnessClient } from './harnessClient.js';

// External Commit bypasses the owner-only Remove gate. The server ran
// parseRemovedLeaves + the pendingRemoval authz ONLY for `mode === 'member'`, so
// an external commit (also public-wireformat, RFC 9420 §12.4.3.2) could carry an
// inline Remove of an arbitrary victim and the gate never fired. Any participant
// could thus cryptographically evict any member without owner authorization. The
// fix runs the same gate for external commits, with a carve-out for the documented
// self-resync (an external committer removing its OWN prior leaf).

let alice: TestUser;
let bob: TestUser;

interface GroupCtx {
  dmChannelId: string;
  groupId: string;
  aliceClient: HarnessClient;
  aliceDev: string;
  bobDev: string;
}

// Group with alice (owner, leaf 0) + bob (member, leaf 1) at epoch 1. Public
// member Add, matching the real client (commitAddMembersWithRebase).
async function setupGroupAliceBob(): Promise<GroupCtx> {
  const channel = await prisma.dMChannel.create({
    data: { isGroup: true, ownerId: alice.id, participants: { create: [{ userId: alice.id }, { userId: bob.id }] } },
    select: { id: true },
  });
  const aliceDev = randomUUID();
  const bobDev = randomUUID();
  const aliceClient = await HarnessClient.create(alice.id, aliceDev);
  await aliceClient.createGroup();
  const created = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token))
    .send({ dmChannelId: channel.id, groupInfo: await aliceClient.publishGroupInfoB64() });
  const groupId = created.body.groupId;

  const bobClient = await HarnessClient.create(bob.id, bobDev);
  const add = await aliceClient.commitAdd(await bobClient.publishKeyPackageB64(), { wireAsPublicMessage: true });
  const addRes = await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(alice.token))
    .send({ baseEpoch: '0', mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID(), welcomes: [{ recipientId: bob.id, welcomeData: add.welcomeB64 }] });
  expect(addRes.status).toBe(200);
  return { dmChannelId: channel.id, groupId, aliceClient, aliceDev, bobDev };
}

beforeAll(async () => { alice = await createTestUser(); bob = await createTestUser(); });
afterAll(async () => {
  await prisma.mlsWelcome.deleteMany({});
  await prisma.mlsCommit.deleteMany({});
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
});

describe('POST /commits — external-commit Remove authorization', () => {
  it('REJECTS an external commit that removes a non-pendingRemoval member (403 unauthorized_remove); epoch unchanged', async () => {
    const { groupId, aliceClient, aliceDev } = await setupGroupAliceBob();
    const aliceLeaf = aliceClient.leafIndexForUser(alice.id, aliceDev);
    const groupInfoB64 = await aliceClient.publishGroupInfoB64();

    // Bob (a member) external-joins on a new device and splices an inline Remove of
    // Alice's leaf: the audited attack — a non-owner evicts an arbitrary victim.
    const attacker = await HarnessClient.create(bob.id, randomUUID());
    const evil = await attacker.craftExternalCommitRemovingLeaf(groupInfoB64, aliceLeaf);

    const res = await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(bob.token))
      .send({ baseEpoch: '1', mode: 'external', commit: evil.externalCommitB64, groupInfo: groupInfoB64, idempotencyKey: randomUUID() });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('unauthorized_remove');
    const group = await prisma.mlsGroup.findUnique({ where: { id: groupId } });
    expect(group?.currentEpoch).toBe(1n); // rejected before the CAS; epoch untouched
  });

  it('ACCEPTS an external commit that removes ONLY the committer\'s own leaf (self-resync carve-out); advances epoch 1 -> 2', async () => {
    const { groupId, aliceClient, bobDev } = await setupGroupAliceBob();
    const bobLeaf = aliceClient.leafIndexForUser(bob.id, bobDev);
    const groupInfoB64 = await aliceClient.publishGroupInfoB64();

    // The legitimate external resync: a wiped device re-joins and drops its OWN stale
    // leaf. The removed leaf maps to the committer's userId, so the gate lets it through.
    const rejoiner = await HarnessClient.create(bob.id, randomUUID());
    const resync = await rejoiner.craftExternalCommitRemovingLeaf(groupInfoB64, bobLeaf);

    const res = await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(bob.token))
      .send({ baseEpoch: '1', mode: 'external', commit: resync.externalCommitB64, groupInfo: groupInfoB64, idempotencyKey: randomUUID() });
    expect(res.status).toBe(200);
    expect(res.body.epoch).toBe('2');
  });

  it('ACCEPTS an external commit that removes an owner-marked pendingRemoval member; advances epoch', async () => {
    const carol = await createTestUser();
    const channel = await prisma.dMChannel.create({
      data: { isGroup: true, ownerId: alice.id, participants: { create: [{ userId: alice.id }, { userId: bob.id }, { userId: carol.id }] } },
      select: { id: true },
    });
    const aliceClient = await HarnessClient.create(alice.id, randomUUID());
    await aliceClient.createGroup();
    const created = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token))
      .send({ dmChannelId: channel.id, groupInfo: await aliceClient.publishGroupInfoB64() });
    const groupId = created.body.groupId;

    const bobDev = randomUUID();
    const bobClient = await HarnessClient.create(bob.id, bobDev);
    const addBob = await aliceClient.commitAdd(await bobClient.publishKeyPackageB64(), { wireAsPublicMessage: true });
    expect((await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '0', mode: 'member', commit: addBob.commitB64, groupInfo: addBob.groupInfoB64, idempotencyKey: randomUUID(), welcomes: [{ recipientId: bob.id, welcomeData: addBob.welcomeB64 }] })).status).toBe(200);

    const carolDev = randomUUID();
    const carolClient = await HarnessClient.create(carol.id, carolDev);
    const addCarol = await aliceClient.commitAdd(await carolClient.publishKeyPackageB64(), { wireAsPublicMessage: true });
    expect((await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '1', mode: 'member', commit: addCarol.commitB64, groupInfo: addCarol.groupInfoB64, idempotencyKey: randomUUID(), welcomes: [{ recipientId: carol.id, welcomeData: addCarol.welcomeB64 }] })).status).toBe(200);

    // Owner authorizes carol's removal (two-phase): mark pendingRemoval.
    await prisma.dMParticipant.update({ where: { userId_dmChannelId: { userId: carol.id, dmChannelId: channel.id } }, data: { pendingRemoval: new Date() } });

    const carolLeaf = aliceClient.leafIndexForUser(carol.id, carolDev);
    const groupInfoB64 = await aliceClient.publishGroupInfoB64();
    const attacker = await HarnessClient.create(bob.id, randomUUID());
    const ext = await attacker.craftExternalCommitRemovingLeaf(groupInfoB64, carolLeaf);

    const res = await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(bob.token))
      .send({ baseEpoch: '2', mode: 'external', commit: ext.externalCommitB64, groupInfo: groupInfoB64, idempotencyKey: randomUUID() });
    expect(res.status).toBe(200);
    expect(res.body.epoch).toBe('3');
  });
});
