// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { HarnessClient } from './harnessClient.js';
import { createTestUser, authHeader, cleanupTestData, seedMlsPublisherAik } from '../helpers.js';
import { prisma } from '../../src/db.js';
import { app } from '../../src/server.js';

const post = (path: string, token: string, body: unknown) =>
  request(app).post(path).set('Authorization', authHeader(token)).send(body);
const get = (path: string, token: string) => request(app).get(path).set('Authorization', authHeader(token));

describe('MLS per-device identity: two devices of one user are distinct leaves', () => {
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let aliceDeviceA: HarnessClient;
  let bobClient: HarnessClient;
  let groupId: string;

  beforeAll(async () => {
    alice = await createTestUser();
    bob = await createTestUser();
    const channel = await prisma.dMChannel.create({
      data: { participants: { create: [{ userId: alice.id }, { userId: bob.id }] } },
      select: { id: true },
    });
    const dmChannelId = channel.id;

    // Copy conformance's setup: publish bob's KP, create the group, commit(Add bob),
    // bob joins from the Welcome, republish GroupInfo. Group ends at epoch 1.
    const aliceDevA = '00000000-0000-4000-8000-0000000000a1';
    const bobDev = '00000000-0000-4000-8000-0000000000b1';
    aliceDeviceA = await HarnessClient.create(alice.id, aliceDevA);
    bobClient = await HarnessClient.create(bob.id, bobDev);

    const bobKp = await bobClient.publishKeyPackageB64();
    await seedMlsPublisherAik(bob.id, bobClient.aikPublicKeyB64());
    const pub = await post('/api/v1/mls/keypackages', bob.token, { deviceId: bobDev, keyPackages: [{ keyPackage: bobKp }] });
    expect(pub.status).toBe(201);

    await aliceDeviceA.createGroup();
    const created = await post('/api/v1/mls/groups', alice.token, { dmChannelId, groupInfo: await aliceDeviceA.publishGroupInfoB64() });
    expect(created.status).toBe(201);
    groupId = created.body.groupId;

    const consumedKp = (await get(`/api/v1/mls/keypackages/${bob.id}`, alice.token)).body.keyPackages[0].keyPackage as string;
    const add = await aliceDeviceA.commitAdd(consumedKp);
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
  });

  afterAll(async () => {
    await prisma.mlsWelcome.deleteMany({});
    await prisma.mlsCommit.deleteMany({});
    await prisma.mlsKeyPackage.deleteMany({});
    await prisma.mlsGroup.deleteMany({});
    await cleanupTestData();
  });

  it('alice device B joins as a DISTINCT leaf; device A + bob apply without throwing; all decrypt a post-join message', async () => {
    const deviceB = '00000000-0000-4000-8000-0000000000b2'; // DISTINCT from device A
    const aliceB = await HarnessClient.create(alice.id, deviceB);

    // Fetch the current GroupInfo the SAME way conformance's carol external-join does.
    // After create + Add bob the group is at epoch 1, so B rides baseEpoch '1' -> epoch '2'.
    const gi = await get(`/api/v1/mls/groups/${groupId}/group-info`, alice.token);
    const ext = await aliceB.joinExternal(gi.body.groupInfo);
    const res = await post(`/api/v1/mls/groups/${groupId}/commits`, alice.token, {
      baseEpoch: '1',
      mode: 'external',
      commit: ext.externalCommitB64,
      groupInfo: await aliceB.publishGroupInfoB64(),
      idempotencyKey: randomUUID(),
    });
    expect(res.status).toBe(200);
    expect(res.body.epoch).toBe('2');
    const newEpoch = BigInt(res.body.epoch);

    for (const [client, token] of [[aliceDeviceA, alice.token], [bobClient, bob.token]] as const) {
      const catchup = await get(`/api/v1/mls/groups/${groupId}/commits?sinceEpoch=1`, token);
      const c = catchup.body.commits.find((x: { baseEpoch: string }) => x.baseEpoch === '1');
      expect(c).toBeDefined();
      await client.processCommit(c.commit); // MUST NOT throw (the regression)
      expect(await client.currentEpoch()).toBe(newEpoch);
    }

    const ct = await aliceB.encrypt('hello from device B');
    expect(await bobClient.decrypt(ct)).toBe('hello from device B');
    expect(await aliceDeviceA.decrypt(ct)).toBe('hello from device B');
  });
});
