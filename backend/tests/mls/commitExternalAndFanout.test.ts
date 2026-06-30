// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { app, httpServer } from '../../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from '../helpers.js';
import { prisma } from '../../src/db.js';
import { HarnessClient } from './harnessClient.js';

let port: number;
let alice: TestUser; // submitter
let bob: TestUser; // existing member -> should get mls-commit
let carol: TestUser; // added member -> should get mls-welcome
let dmChannelId: string;
let groupId: string;
let aliceClient: HarnessClient;
const sockets: Socket[] = [];

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    sockets.push(s);
  });
}

beforeAll(async () => {
  await new Promise<void>((r) => httpServer.listen(0, r));
  port = (httpServer.address() as { port: number }).port;
  alice = await createTestUser();
  bob = await createTestUser();
  carol = await createTestUser();
  const channel = await prisma.dMChannel.create({
    data: { participants: { create: [{ userId: alice.id }, { userId: bob.id }, { userId: carol.id }] } },
    select: { id: true },
  });
  dmChannelId = channel.id;
  aliceClient = await HarnessClient.create(alice.id, '00000000-0000-4000-8000-0000000000d1');
  await aliceClient.createGroup();
  const gi = await aliceClient.publishGroupInfoB64();
  const created = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId, groupInfo: gi });
  groupId = created.body.groupId;
});
afterEach(() => {
  for (const s of sockets.splice(0)) s.disconnect();
});
afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
  await prisma.mlsWelcome.deleteMany({});
  await prisma.mlsCommit.deleteMany({});
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
});

function waitFor(s: Socket, event: string, ms = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    s.once(event, (p) => { clearTimeout(t); resolve(p); });
  });
}
function neverReceives(s: Socket, event: string, ms = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(true), ms);
    s.once(event, () => { clearTimeout(t); resolve(false); });
  });
}

describe('commit fan-out + external mode', () => {
  it('fans mls-commit to members and to the submitter\'s OTHER devices, mls-welcome to added recipients', async () => {
    const bobSock = await connect(bob.token);
    const carolSock = await connect(carol.token);
    const aliceSock = await connect(alice.token);
    // Per-device identity (change C): the submitter's user room is no longer
    // suppressed, so the submitter's OTHER devices must receive the live commit.
    const aliceSock2 = await connect(alice.token);

    const bobCommit = waitFor(bobSock, 'mls-commit');
    const carolWelcome = waitFor(carolSock, 'mls-welcome');
    const aliceSockGot = waitFor(aliceSock, 'mls-commit');
    const aliceSock2Got = waitFor(aliceSock2, 'mls-commit');
    const carolNoCommit = neverReceives(carolSock, 'mls-commit'); // added member must get ONLY the welcome

    const bobClient = await HarnessClient.create(carol.id, '00000000-0000-4000-8000-0000000000e1');
    const carolKp = await bobClient.publishKeyPackageB64();
    const add = await aliceClient.commitAdd(carolKp);
    const res = await request(app)
      .post(`/api/v1/mls/groups/${groupId}/commits`)
      .set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '0', mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID(), welcomes: [{ recipientId: carol.id, welcomeData: add.welcomeB64 }] });
    expect(res.status).toBe(200);

    const commitPayload = (await bobCommit) as { groupId: string; epoch: string; commit: string };
    expect(commitPayload.groupId).toBe(groupId);
    expect(commitPayload.epoch).toBe('1');
    expect(commitPayload.commit).toBe(add.commitB64);
    const welcomePayload = (await carolWelcome) as { groupId: string; epoch: string };
    expect(welcomePayload.groupId).toBe(groupId);
    // Both of the submitter's devices receive the commit (winner-echo suppression removed).
    expect(((await aliceSockGot) as { groupId: string }).groupId).toBe(groupId);
    expect(((await aliceSock2Got) as { groupId: string }).groupId).toBe(groupId);
    expect(await carolNoCommit).toBe(true); // added member gets the welcome, NOT the commit
  });

  it('external commit: stale base 409s with recovery=refetch_group_info, then re-fetch + resubmit succeeds', async () => {
    const owner = await createTestUser();
    const channel = await prisma.dMChannel.create({
      data: { participants: { create: [{ userId: owner.id }, { userId: carol.id }] } },
      select: { id: true },
    });
    const ownerClient = await HarnessClient.create(owner.id, randomUUID());
    await ownerClient.createGroup();
    const created = await request(app)
      .post('/api/v1/mls/groups')
      .set('Authorization', authHeader(owner.token))
      .send({ dmChannelId: channel.id, groupInfo: await ownerClient.publishGroupInfoB64() });
    const gid = created.body.groupId;

    const gi0 = (await request(app).get(`/api/v1/mls/groups/${gid}/group-info`).set('Authorization', authHeader(carol.token))).body.groupInfo;
    const carolStale = await HarnessClient.create(carol.id, randomUUID());
    const ext0 = await carolStale.joinExternal(gi0);

    const add = await ownerClient.commitAdd(await (await HarnessClient.create(randomUUID(), randomUUID())).publishKeyPackageB64());
    await request(app).post(`/api/v1/mls/groups/${gid}/commits`).set('Authorization', authHeader(owner.token))
      .send({ baseEpoch: '0', mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID() });

    const stale = await request(app)
      .post(`/api/v1/mls/groups/${gid}/commits`)
      .set('Authorization', authHeader(carol.token))
      .send({ baseEpoch: '0', mode: 'external', commit: ext0.externalCommitB64, groupInfo: await carolStale.publishGroupInfoB64(), idempotencyKey: randomUUID() });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('epoch_conflict');
    expect(stale.body.recovery).toBe('refetch_group_info');

    const gi1 = (await request(app).get(`/api/v1/mls/groups/${gid}/group-info`).set('Authorization', authHeader(carol.token))).body.groupInfo;
    const carolFresh = await HarnessClient.create(carol.id, randomUUID());
    const ext1 = await carolFresh.joinExternal(gi1);
    const ok = await request(app)
      .post(`/api/v1/mls/groups/${gid}/commits`)
      .set('Authorization', authHeader(carol.token))
      .send({ baseEpoch: '1', mode: 'external', commit: ext1.externalCommitB64, groupInfo: await carolFresh.publishGroupInfoB64(), idempotencyKey: randomUUID() });
    expect(ok.status).toBe(200);
    expect(ok.body.epoch).toBe('2');
  });

  it('a pendingRemoval member is excluded from the mls-commit fan-out (eviction silence)', async () => {
    // bob is a real member; carol is marked pendingRemoval (kick/leave first phase,
    // before the Remove commit lands). carol must NOT receive the next mls-commit.
    await prisma.dMParticipant.update({
      where: { userId_dmChannelId: { userId: carol.id, dmChannelId } },
      data: { pendingRemoval: new Date() },
    });

    const bobSock = await connect(bob.token);
    const carolSock = await connect(carol.token);

    const bobCommit = waitFor(bobSock, 'mls-commit');
    const carolNoCommit = neverReceives(carolSock, 'mls-commit');

    // alice adds a fresh newcomer (one Add commit, advancing the epoch). The
    // beforeAll group is at epoch 1 here (the first describe block's Add advanced
    // it 0 -> 1), so aliceClient's commit rides baseEpoch '1'.
    const newcomerUser = await createTestUser();
    const newcomer = await HarnessClient.create(newcomerUser.id, randomUUID());
    const newcomerKp = await newcomer.publishKeyPackageB64();
    await prisma.dMParticipant.create({ data: { userId: newcomerUser.id, dmChannelId } });
    const add = await aliceClient.commitAdd(newcomerKp);
    const res = await request(app)
      .post(`/api/v1/mls/groups/${groupId}/commits`)
      .set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '1', mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID(), welcomes: [{ recipientId: newcomerUser.id, welcomeData: add.welcomeB64 }] });
    expect(res.status).toBe(200);

    expect((await bobCommit as { groupId: string }).groupId).toBe(groupId);
    expect(await carolNoCommit).toBe(true); // pendingRemoval -> excluded from fan-out

    // restore carol so other tests in the file are unaffected.
    await prisma.dMParticipant.update({
      where: { userId_dmChannelId: { userId: carol.id, dmChannelId } },
      data: { pendingRemoval: null },
    });
  }, 30000);
});
