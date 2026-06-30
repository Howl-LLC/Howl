// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from '../helpers.js';
import { prisma } from '../../src/db.js';
import { HarnessClient } from './harnessClient.js';

let alice: TestUser;
let bob: TestUser;

async function setupGroupWithBob(): Promise<{ dmChannelId: string; groupId: string; aliceClient: HarnessClient; bobDev: string }> {
  const channel = await prisma.dMChannel.create({
    data: { isGroup: true, ownerId: alice.id, participants: { create: [{ userId: alice.id }, { userId: bob.id }] } },
    select: { id: true },
  });
  const aliceDev = randomUUID();
  const bobDev = randomUUID();
  const aliceClient = await HarnessClient.create(alice.id, aliceDev);
  await aliceClient.createGroup();
  const created = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId: channel.id, groupInfo: await aliceClient.publishGroupInfoB64() });
  const groupId = created.body.groupId;

  // Add bob via MLS; epoch -> 1. Group member commits MUST be public now (the
  // accept-both seam is closed), matching the real client (commitAddMembersWithRebase).
  const bobClient = await HarnessClient.create(bob.id, bobDev);
  const add = await aliceClient.commitAdd(await bobClient.publishKeyPackageB64(), { wireAsPublicMessage: true });
  const addRes = await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(alice.token))
    .send({ baseEpoch: '0', mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID(), welcomes: [{ recipientId: bob.id, welcomeData: add.welcomeB64 }] });
  expect(addRes.status).toBe(200);
  return { dmChannelId: channel.id, groupId, aliceClient, bobDev };
}

beforeAll(async () => { alice = await createTestUser(); bob = await createTestUser(); });
afterAll(async () => {
  await prisma.mlsWelcome.deleteMany({});
  await prisma.mlsCommit.deleteMany({});
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
});

describe('POST /commits — owner-only Remove authorization (group, public)', () => {
  it('ACCEPTS a public Remove of a pendingRemoval member; advances epoch; finalizes the row', async () => {
    const { dmChannelId, groupId, aliceClient, bobDev } = await setupGroupWithBob();
    // Owner authorizes the removal at the REST layer (two-phase): mark pendingRemoval.
    await prisma.dMParticipant.update({ where: { userId_dmChannelId: { userId: bob.id, dmChannelId } }, data: { pendingRemoval: new Date() } });
    const rem = await aliceClient.commitRemove([{ userId: bob.id, deviceId: bobDev }], { wireAsPublicMessage: true });
    const res = await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '1', mode: 'member', commit: rem.commitB64, groupInfo: rem.groupInfoB64, idempotencyKey: randomUUID(), removedUserIds: [bob.id] });
    expect(res.status).toBe(200);
    expect(res.body.epoch).toBe('2');
    const row = await prisma.dMParticipant.findUnique({ where: { userId_dmChannelId: { userId: bob.id, dmChannelId } } });
    expect(row).toBeNull(); // advisory finalize deleted the pendingRemoval row
  });

  it('REJECTS a public Remove of a member who is NOT pendingRemoval (403 unauthorized_remove); epoch unchanged', async () => {
    const { groupId, aliceClient, bobDev } = await setupGroupWithBob();
    const rem = await aliceClient.commitRemove([{ userId: bob.id, deviceId: bobDev }], { wireAsPublicMessage: true });
    const res = await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '1', mode: 'member', commit: rem.commitB64, groupInfo: rem.groupInfoB64, idempotencyKey: randomUUID() });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('unauthorized_remove');
    const group = await prisma.mlsGroup.findUnique({ where: { id: groupId } });
    expect(group?.currentEpoch).toBe(1n);
  });

  it('REJECTS a multi-target public Remove when only ONE target is pendingRemoval (all-or-nothing 403); epoch unchanged', async () => {
    const carol = await createTestUser();
    const channel = await prisma.dMChannel.create({
      data: { isGroup: true, ownerId: alice.id, participants: { create: [{ userId: alice.id }, { userId: bob.id }, { userId: carol.id }] } },
      select: { id: true },
    });
    const aliceDev = randomUUID();
    const bobDev = randomUUID();
    const carolDev = randomUUID();
    const aliceClient = await HarnessClient.create(alice.id, aliceDev);
    await aliceClient.createGroup();
    const created = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId: channel.id, groupInfo: await aliceClient.publishGroupInfoB64() });
    const groupId = created.body.groupId;

    // Add bob (epoch 0 -> 1); aliceClient's local tree advances inside commitAdd.
    const bobClient = await HarnessClient.create(bob.id, bobDev);
    const addBob = await aliceClient.commitAdd(await bobClient.publishKeyPackageB64(), { wireAsPublicMessage: true });
    const addBobRes = await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '0', mode: 'member', commit: addBob.commitB64, groupInfo: addBob.groupInfoB64, idempotencyKey: randomUUID(), welcomes: [{ recipientId: bob.id, welcomeData: addBob.welcomeB64 }] });
    expect(addBobRes.status).toBe(200);

    // Add carol (epoch 1 -> 2); aliceClient's local tree advances again.
    const carolClient = await HarnessClient.create(carol.id, carolDev);
    const addCarol = await aliceClient.commitAdd(await carolClient.publishKeyPackageB64(), { wireAsPublicMessage: true });
    const addCarolRes = await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '1', mode: 'member', commit: addCarol.commitB64, groupInfo: addCarol.groupInfoB64, idempotencyKey: randomUUID(), welcomes: [{ recipientId: carol.id, welcomeData: addCarol.welcomeB64 }] });
    expect(addCarolRes.status).toBe(200);

    // Owner marks ONLY bob pendingRemoval; carol stays active.
    await prisma.dMParticipant.update({ where: { userId_dmChannelId: { userId: bob.id, dmChannelId: channel.id } }, data: { pendingRemoval: new Date() } });

    // One public commit removing BOTH bob and carol. `.every()` is all-or-nothing:
    // carol is not authorized, so the whole commit is rejected.
    const rem = await aliceClient.commitRemove([{ userId: bob.id, deviceId: bobDev }, { userId: carol.id, deviceId: carolDev }], { wireAsPublicMessage: true });
    const res = await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '2', mode: 'member', commit: rem.commitB64, groupInfo: rem.groupInfoB64, idempotencyKey: randomUUID(), removedUserIds: [bob.id, carol.id] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('unauthorized_remove');
    const group = await prisma.mlsGroup.findUnique({ where: { id: groupId } });
    expect(group?.currentEpoch).toBe(2n);
  });

  it('REJECTS a private group member commit (wrong_wireformat) — the accept-both seam is closed', async () => {
    // Previously the accept-both seam admitted a PRIVATE group member commit with
    // NO Remove-authz enforcement (parseRemovedLeaves cannot read a PrivateMessage).
    // Group member commits now require public, so this is rejected outright.
    const { groupId, aliceClient } = await setupGroupWithBob();
    const upd = await aliceClient.selfUpdate(); // private, no proposals
    const res = await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '1', mode: 'member', commit: upd.commitB64, groupInfo: upd.groupInfoB64, idempotencyKey: randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('wrong_wireformat');
    const group = await prisma.mlsGroup.findUnique({ where: { id: groupId } });
    expect(group?.currentEpoch).toBe(1n); // unchanged: rejected at the wireformat gate
  });

  it('REJECTS a public member commit on a 1:1 channel (wrong_wireformat)', async () => {
    const channel = await prisma.dMChannel.create({ data: { isGroup: false, participants: { create: [{ userId: alice.id }] } }, select: { id: true } });
    const c = await HarnessClient.create(alice.id, randomUUID());
    await c.createGroup();
    const created = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId: channel.id, groupInfo: await c.publishGroupInfoB64() });
    const other = await HarnessClient.create(randomUUID(), randomUUID());
    const add = await c.commitAdd(await other.publishKeyPackageB64(), { wireAsPublicMessage: true });
    const res = await request(app).post(`/api/v1/mls/groups/${created.body.groupId}/commits`).set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '0', mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('wrong_wireformat');
  });

  // Positive companion to the wrong_wireformat rejection above: locks the path the
  // client fix (createDmGroup -> createGroupDmGroup with wireAsPublicMessage=false)
  // now exercises. A PRIVATE member Add on a 1:1 (isGroup=false) is the wireformat
  // the backend non-group gate (routes/mls.ts `else if (!isGroup)`) requires, and
  // must be ACCEPTED. Guards against the two-halves drift (client public vs backend
  // private) that broke 1:1 establishment.
  it('ACCEPTS a private member Add on a 1:1 channel (isGroup=false); advances epoch 0 -> 1', async () => {
    const channel = await prisma.dMChannel.create({ data: { isGroup: false, participants: { create: [{ userId: alice.id }, { userId: bob.id }] } }, select: { id: true } });
    const aliceClient = await HarnessClient.create(alice.id, randomUUID());
    await aliceClient.createGroup();
    const created = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId: channel.id, groupInfo: await aliceClient.publishGroupInfoB64() });
    const groupId = created.body.groupId;
    const bobClient = await HarnessClient.create(bob.id, randomUUID());
    // Private add (commitAdd defaults wireAsPublicMessage=false) — byte-identical to
    // what createDmGroup now emits for a 1:1.
    const add = await aliceClient.commitAdd(await bobClient.publishKeyPackageB64());
    const res = await request(app).post(`/api/v1/mls/groups/${groupId}/commits`).set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '0', mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID(), welcomes: [{ recipientId: bob.id, welcomeData: add.welcomeB64 }] });
    expect(res.status).toBe(200);
    expect(res.body.epoch).toBe('1');
  });
});
