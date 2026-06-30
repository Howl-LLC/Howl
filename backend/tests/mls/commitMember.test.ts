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
let outsider: TestUser;
let dmChannelId: string;
let groupId: string;
let aliceClient: HarnessClient;

async function createServerGroup(): Promise<void> {
  const channel = await prisma.dMChannel.create({
    data: { participants: { create: [{ userId: alice.id }, { userId: bob.id }] } },
    select: { id: true },
  });
  dmChannelId = channel.id;
  aliceClient = await HarnessClient.create(alice.id, '00000000-0000-4000-8000-0000000000a1');
  await aliceClient.createGroup();
  const gi = await aliceClient.publishGroupInfoB64();
  const res = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId, groupInfo: gi });
  expect(res.status).toBe(201);
  groupId = res.body.groupId;
}

beforeAll(async () => {
  alice = await createTestUser();
  bob = await createTestUser();
  outsider = await createTestUser();
  await createServerGroup();
});
afterAll(async () => {
  await prisma.mlsWelcome.deleteMany({});
  await prisma.mlsCommit.deleteMany({});
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
});

async function buildAddCommit() {
  const bobClient = await HarnessClient.create(bob.id, '00000000-0000-4000-8000-0000000000b1');
  const bobKp = await bobClient.publishKeyPackageB64();
  return aliceClient.commitAdd(bobKp); // { commitB64, welcomeB64, groupInfoB64, newEpoch }
}

describe('POST /api/v1/mls/groups/:groupId/commits (member mode)', () => {
  it('accepts a member commit, advances the epoch, stores the commit + welcome, republishes GroupInfo', async () => {
    const { commitB64, welcomeB64, groupInfoB64 } = await buildAddCommit();
    const idempotencyKey = randomUUID();
    const res = await request(app)
      .post(`/api/v1/mls/groups/${groupId}/commits`)
      .set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '0', mode: 'member', commit: commitB64, groupInfo: groupInfoB64, idempotencyKey, welcomes: [{ recipientId: bob.id, welcomeData: welcomeB64 }] });
    expect(res.status).toBe(200);
    expect(res.body.epoch).toBe('1');

    const group = await prisma.mlsGroup.findUnique({ where: { id: groupId } });
    expect(group?.currentEpoch).toBe(1n);
    expect(group?.groupInfoEpoch).toBe(1n);
    const commit = await prisma.mlsCommit.findFirst({ where: { groupId, epoch: 0n } });
    expect(commit?.idempotencyKey).toBe(idempotencyKey);
    const welcome = await prisma.mlsWelcome.findFirst({ where: { recipientId: bob.id, groupId, epoch: 1n } });
    expect(welcome?.welcomeData.length).toBeGreaterThan(0);
  });

  it('idempotent resubmit (same key) returns the ORIGINAL outcome, not a 409', async () => {
    const idempotencyKey = randomUUID();
    const a = await buildAddCommit();
    const first = await request(app)
      .post(`/api/v1/mls/groups/${groupId}/commits`)
      .set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '1', mode: 'member', commit: a.commitB64, groupInfo: a.groupInfoB64, idempotencyKey });
    expect(first.status).toBe(200);
    const epoch = first.body.epoch;
    const replay = await request(app)
      .post(`/api/v1/mls/groups/${groupId}/commits`)
      .set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '1', mode: 'member', commit: a.commitB64, groupInfo: a.groupInfoB64, idempotencyKey });
    expect(replay.status).toBe(200);
    expect(replay.body.epoch).toBe(epoch);
    expect(replay.body.idempotent).toBe(true);
  });

  it('rejects a stale base epoch with 409 + recovery=rebase', async () => {
    const a = await buildAddCommit();
    const res = await request(app)
      .post(`/api/v1/mls/groups/${groupId}/commits`)
      .set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '0', mode: 'member', commit: a.commitB64, groupInfo: a.groupInfoB64, idempotencyKey: randomUUID() }); // epoch already past 0
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('epoch_conflict');
    expect(res.body.recovery).toBe('rebase');
    expect(typeof res.body.currentEpoch).toBe('string');
  });

  it('rejects a non-participant submitter with 403', async () => {
    const a = await buildAddCommit();
    const res = await request(app)
      .post(`/api/v1/mls/groups/${groupId}/commits`)
      .set('Authorization', authHeader(outsider.token))
      .send({ baseEpoch: '99', mode: 'member', commit: a.commitB64, groupInfo: a.groupInfoB64, idempotencyKey: randomUUID() });
    expect(res.status).toBe(403);
  });

  it('rejects a malformed commit with 400', async () => {
    const res = await request(app)
      .post(`/api/v1/mls/groups/${groupId}/commits`)
      .set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '99', mode: 'member', commit: Buffer.from([1, 2, 3]).toString('base64'), groupInfo: Buffer.from([4]).toString('base64'), idempotencyKey: randomUUID() });
    expect(res.status).toBe(400);
  });

  it('3-way race on the same base epoch collapses to exactly one winner', async () => {
    const channel = await prisma.dMChannel.create({ data: { participants: { create: [{ userId: alice.id }] } }, select: { id: true } });
    const c = await HarnessClient.create(alice.id, '00000000-0000-4000-8000-0000000000c1');
    await c.createGroup();
    const gi = await c.publishGroupInfoB64();
    const created = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId: channel.id, groupInfo: gi });
    const gid = created.body.groupId;

    const commits = await Promise.all([buildOnTop(c), buildOnTop(c), buildOnTop(c)]);
    const submissions = commits.map((cm) =>
      request(app)
        .post(`/api/v1/mls/groups/${gid}/commits`)
        .set('Authorization', authHeader(alice.token))
        .send({ baseEpoch: '0', mode: 'member', commit: cm.commitB64, groupInfo: cm.groupInfoB64, idempotencyKey: randomUUID() }),
    );
    const results = await Promise.all(submissions);
    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(2);
  });

  it('rejects a commit whose Welcome targets a non-participant recipient with 400 (no epoch advance, no 500)', async () => {
    const channel = await prisma.dMChannel.create({ data: { participants: { create: [{ userId: alice.id }] } }, select: { id: true } });
    const c = await HarnessClient.create(alice.id, randomUUID());
    await c.createGroup();
    const created = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId: channel.id, groupInfo: await c.publishGroupInfoB64() });
    const gid = created.body.groupId;
    const joiner = await HarnessClient.create(randomUUID(), randomUUID());
    const add = await c.commitAdd(await joiner.publishKeyPackageB64());
    const res = await request(app)
      .post(`/api/v1/mls/groups/${gid}/commits`)
      .set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '0', mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID(), welcomes: [{ recipientId: randomUUID(), welcomeData: add.welcomeB64 }] });
    expect(res.status).toBe(400);
    const group = await prisma.mlsGroup.findUnique({ where: { id: gid } });
    expect(group?.currentEpoch).toBe(0n); // rejected before the CAS; epoch unchanged
  });
});

// buildOnTop mutates c's local state; successive calls produce wire-distinct commits that all
// claim base epoch 0 on the server, of which the CAS admits exactly one.
async function buildOnTop(c: HarnessClient) {
  const joiner = await HarnessClient.create(randomUUID(), randomUUID());
  const kp = await joiner.publishKeyPackageB64();
  return c.commitAdd(kp);
}

// GROUP member commits must be public so the server-side Remove-authz gate can
// read them. A PRIVATE group member commit (the old accept-both path) is now
// rejected at the wireformat gate, which fires BEFORE welcome/CAS admission.
describe('POST /api/v1/mls/groups/:groupId/commits — group member commit wireformat', () => {
  let gAlice: TestUser;
  let gBob: TestUser;

  beforeAll(async () => {
    gAlice = await createTestUser();
    gBob = await createTestUser();
  });

  async function freshGroup(): Promise<{ gid: string; client: HarnessClient; bobKp: string }> {
    const channel = await prisma.dMChannel.create({
      data: { isGroup: true, participants: { create: [{ userId: gAlice.id }, { userId: gBob.id }] } },
      select: { id: true },
    });
    const client = await HarnessClient.create(gAlice.id, randomUUID());
    await client.createGroup();
    const created = await request(app)
      .post('/api/v1/mls/groups')
      .set('Authorization', authHeader(gAlice.token))
      .send({ dmChannelId: channel.id, groupInfo: await client.publishGroupInfoB64() });
    expect(created.status).toBe(201);
    const bobClient = await HarnessClient.create(gBob.id, randomUUID());
    const bobKp = await bobClient.publishKeyPackageB64();
    return { gid: created.body.groupId, client, bobKp };
  }

  it('rejects a PRIVATE group member commit with 400 wrong_wireformat (no epoch advance)', async () => {
    const { gid, client, bobKp } = await freshGroup();
    const priv = await client.commitAdd(bobKp, { wireAsPublicMessage: false });
    const res = await request(app)
      .post(`/api/v1/mls/groups/${gid}/commits`)
      .set('Authorization', authHeader(gAlice.token))
      .send({ baseEpoch: '0', mode: 'member', commit: priv.commitB64, groupInfo: priv.groupInfoB64, idempotencyKey: randomUUID(), welcomes: [{ recipientId: gBob.id, welcomeData: priv.welcomeB64 }] });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('wrong_wireformat');
    const group = await prisma.mlsGroup.findUnique({ where: { id: gid } });
    expect(group?.currentEpoch).toBe(0n); // rejected at the wireformat gate, before the CAS
  });

  it('accepts a PUBLIC group member commit (the current client form), advancing the epoch', async () => {
    const { gid, client, bobKp } = await freshGroup();
    const pub = await client.commitAdd(bobKp, { wireAsPublicMessage: true });
    const res = await request(app)
      .post(`/api/v1/mls/groups/${gid}/commits`)
      .set('Authorization', authHeader(gAlice.token))
      .send({ baseEpoch: '0', mode: 'member', commit: pub.commitB64, groupInfo: pub.groupInfoB64, idempotencyKey: randomUUID(), welcomes: [{ recipientId: gBob.id, welcomeData: pub.welcomeB64 }] });
    expect(res.status).toBe(200);
    expect(res.body.epoch).toBe('1');
    const group = await prisma.mlsGroup.findUnique({ where: { id: gid } });
    expect(group?.currentEpoch).toBe(1n);
  });
});
