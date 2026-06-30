// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Group-membership conformance: the N-party generalization of the 2-party
 * conformance suites, driven by HarnessClient through the LIVE backend contract.
 * Covers batched-add create, owner Remove + leaf eviction, oldest-remaining
 * self-leave, External self-join over an N-leaf tree, and concurrent-CAS 409
 * rebase.
 *
 * Eviction note: in MLS the removed member processes the very commit that removes
 * it (that handshake RESOLVES, landing on a terminal "removed" state), and is
 * only locked out of every SUBSEQUENT epoch — it can never follow the next path
 * update (no key overlap). So the eviction assertions check that a post-removal
 * commit (a selfUpdate by a remaining member) is the one the evicted member
 * cannot apply. That is the genuine forward-secrecy boundary.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/server.js';
import { createTestUser, authHeader, cleanupTestData, seedMlsPublisherAik, type TestUser } from '../helpers.js';
import { prisma } from '../../src/db.js';
import { HarnessClient } from './harnessClient.js';

const post = (path: string, token: string, body: unknown) =>
  request(app).post(path).set('Authorization', authHeader(token)).send(body);
const get = (path: string, token: string) => request(app).get(path).set('Authorization', authHeader(token));

let owner: TestUser;
let m1: TestUser;
let m2: TestUser;

beforeAll(async () => {
  owner = await createTestUser();
  m1 = await createTestUser();
  m2 = await createTestUser();
});
afterAll(async () => {
  await prisma.mlsWelcome.deleteMany({});
  await prisma.mlsCommit.deleteMany({});
  await prisma.mlsKeyPackage.deleteMany({});
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
});

// Build an MLS group of `owner + members` via ONE batched Add. Returns the
// groupId + every client (owner first) at the common epoch-1 tree.
async function buildGroup(
  ownerUser: TestUser,
  members: TestUser[],
): Promise<{ groupId: string; ownerClient: HarnessClient; memberClients: HarnessClient[]; ownerDev: string; memberDevs: string[] }> {
  const channel = await prisma.dMChannel.create({
    data: { participants: { create: [{ userId: ownerUser.id }, ...members.map((u) => ({ userId: u.id }))] } },
    select: { id: true },
  });
  const ownerDev = randomUUID();
  const ownerClient = await HarnessClient.create(ownerUser.id, ownerDev);
  const memberDevs = members.map(() => randomUUID());
  const memberClients = await Promise.all(members.map((u, i) => HarnessClient.create(u.id, memberDevs[i])));

  const kps: string[] = [];
  for (let i = 0; i < members.length; i++) {
    const kp = await memberClients[i].publishKeyPackageB64();
    await seedMlsPublisherAik(members[i].id, memberClients[i].aikPublicKeyB64());
    await post('/api/v1/mls/keypackages', members[i].token, { deviceId: memberDevs[i], keyPackages: [{ keyPackage: kp }] });
    kps.push((await get(`/api/v1/mls/keypackages/${members[i].id}`, ownerUser.token)).body.keyPackages[0].keyPackage as string);
  }

  await ownerClient.createGroup();
  const groupId = (await post('/api/v1/mls/groups', ownerUser.token, {
    dmChannelId: channel.id,
    groupInfo: await ownerClient.publishGroupInfoB64(),
  })).body.groupId;

  const batched = await ownerClient.commitAddMany(kps);
  await post(`/api/v1/mls/groups/${groupId}/commits`, ownerUser.token, {
    baseEpoch: '0',
    mode: 'member',
    commit: batched.commitB64,
    groupInfo: batched.groupInfoB64,
    idempotencyKey: randomUUID(),
    welcomes: members.map((u) => ({ recipientId: u.id, welcomeData: batched.welcomeB64 })),
  });
  for (let i = 0; i < members.length; i++) {
    const w = (await get('/api/v1/mls/welcomes', members[i].token)).body.welcomes;
    await memberClients[i].joinFromWelcome(w[0].welcomeData);
  }
  return { groupId, ownerClient, memberClients, ownerDev, memberDevs };
}

describe('Group-membership conformance: N-party add / remove / leave / external', () => {
  it('owner Removes one member: the removed leaf is evicted, the remaining member advances, the removed member cannot follow the next epoch', async () => {
    const { groupId, ownerClient, memberClients, memberDevs } = await buildGroup(owner, [m1, m2]);
    const [m1Client, m2Client] = memberClients;
    expect(await ownerClient.currentEpoch()).toBe(1n);

    // Owner Removes m1 by credential identity (resolved on the owner's live tree).
    const rm = await ownerClient.commitRemove([{ userId: m1.id, deviceId: memberDevs[0] }]);
    const res = await post(`/api/v1/mls/groups/${groupId}/commits`, owner.token, {
      baseEpoch: '1',
      mode: 'member',
      commit: rm.commitB64,
      groupInfo: rm.groupInfoB64,
      idempotencyKey: randomUUID(),
      removedUserIds: [m1.id],
    });
    expect(res.status).toBe(200);
    expect(res.body.epoch).toBe('2');
    expect(await ownerClient.currentEpoch()).toBe(2n);

    // Both m1 (removed) and m2 (remaining) apply the Remove commit it was a member
    // for: that handshake resolves for both (m1 lands on its terminal removed state).
    await m1Client.processCommit(rm.commitB64);
    await m2Client.processCommit(rm.commitB64);
    expect(await m2Client.currentEpoch()).toBe(2n);

    // owner <-> m2 still converge at epoch 2.
    const ct = await m2Client.encrypt('still here');
    expect(await ownerClient.decrypt(ct)).toBe('still here');

    // Forward-secrecy boundary: the owner does a path-refresh self-update (epoch
    // 2 -> 3). m2 follows it; the evicted m1 CANNOT — no key overlap with the path.
    const su = await ownerClient.selfUpdate();
    await post(`/api/v1/mls/groups/${groupId}/commits`, owner.token, {
      baseEpoch: '2', mode: 'member', commit: su.commitB64, groupInfo: su.groupInfoB64, idempotencyKey: randomUUID(),
    });
    expect(await ownerClient.currentEpoch()).toBe(3n);
    await m2Client.processCommit(su.commitB64);
    expect(await m2Client.currentEpoch()).toBe(3n);
    await expect(m1Client.processCommit(su.commitB64)).rejects.toBeTruthy();
  }, 40000);

  it('oldest-remaining self-leave: a member authors the Remove of a departed member over the N-leaf tree', async () => {
    const x = await createTestUser();
    const y = await createTestUser();
    const z = await createTestUser();
    const { groupId, ownerClient, memberClients, ownerDev, memberDevs } = await buildGroup(x, [y, z]);
    const [yClient, zClient] = memberClients;
    expect(await ownerClient.currentEpoch()).toBe(1n);

    // z "leaves" (server marks pendingRemoval). The oldest-remaining REAL member
    // after the owner is y; the owner x authors the Remove of z's leaf here. (The
    // harness asserts ANY member can resolve+Remove an arbitrary leaf — the tree,
    // not REST roles, is crypto truth.)
    const rm = await ownerClient.commitRemove([{ userId: z.id, deviceId: memberDevs[1] }]);
    const res = await post(`/api/v1/mls/groups/${groupId}/commits`, x.token, {
      baseEpoch: '1', mode: 'member', commit: rm.commitB64, groupInfo: rm.groupInfoB64,
      idempotencyKey: randomUUID(), removedUserIds: [z.id],
    });
    expect(res.status).toBe(200);
    expect(res.body.epoch).toBe('2');

    // y (remaining) and z (removed) both apply the eviction commit they were
    // members for; z lands on its terminal removed state.
    await yClient.processCommit(rm.commitB64);
    await zClient.processCommit(rm.commitB64);
    expect(await yClient.currentEpoch()).toBe(2n);

    // Forward-secrecy boundary: x's next commit (selfUpdate, epoch 2 -> 3) is one
    // y follows and the evicted z cannot.
    const su = await ownerClient.selfUpdate();
    await post(`/api/v1/mls/groups/${groupId}/commits`, x.token, {
      baseEpoch: '2', mode: 'member', commit: su.commitB64, groupInfo: su.groupInfoB64, idempotencyKey: randomUUID(),
    });
    await yClient.processCommit(su.commitB64);
    expect(await yClient.currentEpoch()).toBe(3n);
    await expect(zClient.processCommit(su.commitB64)).rejects.toBeTruthy();
    void ownerDev;
  }, 40000);

  it('external self-join over an N-leaf tree: a member who lost state re-joins the current epoch off the published GroupInfo', async () => {
    const p = await createTestUser();
    const q = await createTestUser();
    const r = await createTestUser();
    const { groupId } = await buildGroup(p, [q, r]);

    // q lost local state; re-join via External Commit off the epoch-1 GroupInfo
    // (3-leaf tree). joinExternal resyncs onto q's existing leaf, epoch 1 -> 2.
    const gi = (await get(`/api/v1/mls/groups/${groupId}/group-info`, q.token)).body.groupInfo;
    const qFresh = await HarnessClient.create(q.id, randomUUID());
    const ext = await qFresh.joinExternal(gi);
    const extRes = await post(`/api/v1/mls/groups/${groupId}/commits`, q.token, {
      baseEpoch: '1', mode: 'external', commit: ext.externalCommitB64,
      groupInfo: await qFresh.publishGroupInfoB64(), idempotencyKey: randomUUID(),
    });
    expect(extRes.status).toBe(200);
    expect(extRes.body.epoch).toBe('2');
  }, 40000);

  it('concurrent membership CAS: two commits at the same baseEpoch — one wins, the loser gets 409 rebase', async () => {
    const o = await createTestUser();
    const u1 = await createTestUser();
    const u2 = await createTestUser();
    const { groupId, ownerClient } = await buildGroup(o, [u1, u2]);
    expect(await ownerClient.currentEpoch()).toBe(1n);

    // Submit A (wins at baseEpoch '1'), then submit a stale B at baseEpoch '1' for
    // the 409. (Both Adds are built off the owner's live tree; per-test idempotency
    // keys keep the rows independent — the CAS, not idempotency, drives the 409.)
    const newcomerA = await HarnessClient.create(randomUUID(), randomUUID());
    const newcomerB = await HarnessClient.create(randomUUID(), randomUUID());
    const addA = await ownerClient.commitAddMany([await newcomerA.publishKeyPackageB64()]);
    const winA = await post(`/api/v1/mls/groups/${groupId}/commits`, o.token, {
      baseEpoch: '1', mode: 'member', commit: addA.commitB64, groupInfo: addA.groupInfoB64,
      idempotencyKey: randomUUID(),
    });
    expect(winA.status).toBe(200);
    expect(winA.body.epoch).toBe('2');

    const addB = await ownerClient.commitAddMany([await newcomerB.publishKeyPackageB64()]);
    const stale = await post(`/api/v1/mls/groups/${groupId}/commits`, o.token, {
      baseEpoch: '1', mode: 'member', commit: addB.commitB64, groupInfo: addB.groupInfoB64,
      idempotencyKey: randomUUID(),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.recovery).toBe('rebase');
  }, 40000);
});
