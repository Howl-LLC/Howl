// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/server.js';
import { createTestUser, authHeader, cleanupTestData, seedMlsPublisherAik, type TestUser } from '../helpers.js';
import { prisma } from '../../src/db.js';
import { HarnessClient } from './harnessClient.js';

let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
let dmChannelId: string;

beforeAll(async () => {
  alice = await createTestUser();
  bob = await createTestUser();
  carol = await createTestUser();
  const channel = await prisma.dMChannel.create({
    data: { participants: { create: [{ userId: alice.id }, { userId: bob.id }, { userId: carol.id }] } },
    select: { id: true },
  });
  dmChannelId = channel.id;
});
afterAll(async () => {
  await prisma.mlsWelcome.deleteMany({});
  await prisma.mlsCommit.deleteMany({});
  await prisma.mlsKeyPackage.deleteMany({});
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
});

const post = (path: string, token: string, body: unknown) =>
  request(app).post(path).set('Authorization', authHeader(token)).send(body);
const get = (path: string, token: string) => request(app).get(path).set('Authorization', authHeader(token));

describe('MLS conformance: full DS/AS contract end to end', () => {
  it('publish KP -> fetch/consume -> create -> commit(Add) -> Welcome join -> republish GI -> external join -> relay -> ordered app message', async () => {
    const aliceDev = '00000000-0000-4000-8000-00000000c001';
    const bobDev = '00000000-0000-4000-8000-00000000c002';
    const aliceClient = await HarnessClient.create(alice.id, aliceDev);
    const bobClient = await HarnessClient.create(bob.id, bobDev);

    const bobKp = await bobClient.publishKeyPackageB64();
    await seedMlsPublisherAik(bob.id, bobClient.aikPublicKeyB64());
    const pub = await post('/api/v1/mls/keypackages', bob.token, { deviceId: bobDev, keyPackages: [{ keyPackage: bobKp }] });
    expect(pub.status).toBe(201);

    await aliceClient.createGroup();
    const created = await post('/api/v1/mls/groups', alice.token, { dmChannelId, groupInfo: await aliceClient.publishGroupInfoB64() });
    expect(created.status).toBe(201);
    const groupId = created.body.groupId;

    const fetched = await get(`/api/v1/mls/keypackages/${bob.id}`, alice.token);
    expect(fetched.status).toBe(200);
    const consumedKp = fetched.body.keyPackages[0].keyPackage as string;

    const add = await aliceClient.commitAdd(consumedKp);
    const commitRes = await post(`/api/v1/mls/groups/${groupId}/commits`, alice.token, {
      baseEpoch: '0',
      mode: 'member',
      commit: add.commitB64,
      groupInfo: add.groupInfoB64,
      idempotencyKey: randomUUID(),
      welcomes: [{ recipientId: bob.id, welcomeData: add.welcomeB64 }],
    });
    expect(commitRes.status).toBe(200);
    expect(commitRes.body.epoch).toBe('1');

    const welcomes = await get('/api/v1/mls/welcomes', bob.token);
    expect(welcomes.body.welcomes).toHaveLength(1);
    await bobClient.joinFromWelcome(welcomes.body.welcomes[0].welcomeData);
    expect(await bobClient.currentEpoch()).toBe(1n);

    const ct1 = await bobClient.encrypt('hello from bob');
    expect(await aliceClient.decrypt(ct1)).toBe('hello from bob');

    const gi = await get(`/api/v1/mls/groups/${groupId}/group-info`, alice.token);
    expect(gi.body.groupInfoEpoch).toBe('1');

    const carolClient = await HarnessClient.create(carol.id, '00000000-0000-4000-8000-00000000c003');
    const ext = await carolClient.joinExternal(gi.body.groupInfo);
    const extRes = await post(`/api/v1/mls/groups/${groupId}/commits`, carol.token, {
      baseEpoch: '1',
      mode: 'external',
      commit: ext.externalCommitB64,
      groupInfo: await carolClient.publishGroupInfoB64(),
      idempotencyKey: randomUUID(),
    });
    expect(extRes.status).toBe(200);
    expect(extRes.body.epoch).toBe('2');

    for (const [client, token] of [[aliceClient, alice.token], [bobClient, bob.token]] as const) {
      const catchup = await get(`/api/v1/mls/groups/${groupId}/commits?sinceEpoch=1`, token);
      const extCommit = catchup.body.commits.find((c: { baseEpoch: string }) => c.baseEpoch === '1');
      expect(extCommit).toBeDefined();
      await client.processCommit(extCommit.commit);
      expect(await client.currentEpoch()).toBe(2n);
    }

    const ct2 = await carolClient.encrypt('hello from carol');
    expect(await aliceClient.decrypt(ct2)).toBe('hello from carol');
  }, 30000);

  it('loser-rebase: a stale member commit gets 409 + recovery=rebase', async () => {
    const owner = await createTestUser();
    const channel = await prisma.dMChannel.create({ data: { participants: { create: [{ userId: owner.id }] } }, select: { id: true } });
    const c = await HarnessClient.create(owner.id, randomUUID());
    await c.createGroup();
    const groupId = (await post('/api/v1/mls/groups', owner.token, { dmChannelId: channel.id, groupInfo: await c.publishGroupInfoB64() })).body.groupId;
    const a1 = await c.commitAdd(await (await HarnessClient.create(randomUUID(), randomUUID())).publishKeyPackageB64());
    await post(`/api/v1/mls/groups/${groupId}/commits`, owner.token, { baseEpoch: '0', mode: 'member', commit: a1.commitB64, groupInfo: a1.groupInfoB64, idempotencyKey: randomUUID() });
    const a2 = await c.commitAdd(await (await HarnessClient.create(randomUUID(), randomUUID())).publishKeyPackageB64());
    const stale = await post(`/api/v1/mls/groups/${groupId}/commits`, owner.token, { baseEpoch: '0', mode: 'member', commit: a2.commitB64, groupInfo: a2.groupInfoB64, idempotencyKey: randomUUID() });
    expect(stale.status).toBe(409);
    expect(stale.body.recovery).toBe('rebase');
  }, 20000);

  it('batched add: one commit with N welcomes joins N members at the same epoch', async () => {
    const ownerDev = '00000000-0000-4000-8000-00000000ba01';
    const owner = await createTestUser();
    const m1 = await createTestUser();
    const m2 = await createTestUser();
    const channel = await prisma.dMChannel.create({
      data: { participants: { create: [{ userId: owner.id }, { userId: m1.id }, { userId: m2.id }] } },
      select: { id: true },
    });
    const ownerClient = await HarnessClient.create(owner.id, ownerDev);
    const m1Dev = '00000000-0000-4000-8000-00000000ba02';
    const m2Dev = '00000000-0000-4000-8000-00000000ba03';
    const m1Client = await HarnessClient.create(m1.id, m1Dev);
    const m2Client = await HarnessClient.create(m2.id, m2Dev);

    const m1Kp = await m1Client.publishKeyPackageB64();
    const m2Kp = await m2Client.publishKeyPackageB64();
    await seedMlsPublisherAik(m1.id, m1Client.aikPublicKeyB64());
    await seedMlsPublisherAik(m2.id, m2Client.aikPublicKeyB64());
    await post('/api/v1/mls/keypackages', m1.token, { deviceId: m1Dev, keyPackages: [{ keyPackage: m1Kp }] });
    await post('/api/v1/mls/keypackages', m2.token, { deviceId: m2Dev, keyPackages: [{ keyPackage: m2Kp }] });

    await ownerClient.createGroup();
    const groupId = (await post('/api/v1/mls/groups', owner.token, {
      dmChannelId: channel.id,
      groupInfo: await ownerClient.publishGroupInfoB64(),
    })).body.groupId;

    const consumed1 = (await get(`/api/v1/mls/keypackages/${m1.id}`, owner.token)).body.keyPackages[0].keyPackage as string;
    const consumed2 = (await get(`/api/v1/mls/keypackages/${m2.id}`, owner.token)).body.keyPackages[0].keyPackage as string;

    const batched = await ownerClient.commitAddMany([consumed1, consumed2]);
    const res = await post(`/api/v1/mls/groups/${groupId}/commits`, owner.token, {
      baseEpoch: '0',
      mode: 'member',
      commit: batched.commitB64,
      groupInfo: batched.groupInfoB64,
      idempotencyKey: randomUUID(),
      welcomes: [
        { recipientId: m1.id, welcomeData: batched.welcomeB64 },
        { recipientId: m2.id, welcomeData: batched.welcomeB64 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.epoch).toBe('1');

    const w1 = (await get('/api/v1/mls/welcomes', m1.token)).body.welcomes;
    const w2 = (await get('/api/v1/mls/welcomes', m2.token)).body.welcomes;
    expect(w1).toHaveLength(1);
    expect(w2).toHaveLength(1);
    await m1Client.joinFromWelcome(w1[0].welcomeData);
    await m2Client.joinFromWelcome(w2[0].welcomeData);
    expect(await m1Client.currentEpoch()).toBe(1n);
    expect(await m2Client.currentEpoch()).toBe(1n);

    // All three converge: m1 -> owner round-trips at epoch 1.
    const ct = await m1Client.encrypt('batched hello');
    expect(await ownerClient.decrypt(ct)).toBe('batched hello');
  }, 30000);

  it('expiry: the DS refuses to serve an expired single-use KeyPackage', async () => {
    const t = await createTestUser();
    const dev = randomUUID();
    const kpClient = await HarnessClient.create(t.id, dev);
    await seedMlsPublisherAik(t.id, kpClient.aikPublicKeyB64());
    const pubExpiry = await post('/api/v1/mls/keypackages', t.token, { deviceId: dev, keyPackages: [{ keyPackage: await kpClient.publishKeyPackageB64() }] });
    expect(pubExpiry.status).toBe(201);
    await prisma.mlsKeyPackage.updateMany({ where: { userId: t.id, deviceId: dev }, data: { notAfter: new Date(Date.now() - 1000) } });
    const consumer = await createTestUser();
    const res = await get(`/api/v1/mls/keypackages/${t.id}`, consumer.token);
    expect(res.status).toBe(404); // no live package to serve
  });
});
