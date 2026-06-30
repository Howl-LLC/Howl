// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { app, httpServer } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';
import { HarnessClient } from './mls/harnessClient.js';

let port: number;
let alice: TestUser; // owner/submitter
let bob: TestUser; // staying member
let carol: TestUser; // pendingRemoval target
let dave: TestUser; // named in the hint but NOT pendingRemoval
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

// The handler treats the commit as opaque (no-inspect rule): an Add-shaped member
// commit is a valid mls_private_message and exercises the finalize/fan-out branches
// identically to a real Remove.
async function buildMemberCommit(): Promise<{ commitB64: string; groupInfoB64: string }> {
  const joiner = await HarnessClient.create(randomUUID(), randomUUID());
  const kp = await joiner.publishKeyPackageB64();
  const add = await aliceClient.commitAdd(kp);
  return { commitB64: add.commitB64, groupInfoB64: add.groupInfoB64 };
}

async function seedGroup(): Promise<void> {
  const channel = await prisma.dMChannel.create({
    data: { participants: { create: [{ userId: alice.id }, { userId: bob.id }, { userId: carol.id }, { userId: dave.id }] } },
    select: { id: true },
  });
  dmChannelId = channel.id;
  aliceClient = await HarnessClient.create(alice.id, randomUUID());
  await aliceClient.createGroup();
  const gi = await aliceClient.publishGroupInfoB64();
  const created = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId, groupInfo: gi });
  expect(created.status).toBe(201);
  groupId = created.body.groupId;
}

beforeAll(async () => {
  await new Promise<void>((r) => httpServer.listen(0, r));
  port = (httpServer.address() as { port: number }).port;
  alice = await createTestUser();
  bob = await createTestUser();
  carol = await createTestUser();
  dave = await createTestUser();
  await seedGroup();
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

describe('POST /mls/groups/:groupId/commits — removedUserIds finalize', () => {
  it('deletes ONLY the pendingRemoval participant named in removedUserIds; leaves an unmarked named participant intact', async () => {
    await prisma.dMParticipant.update({
      where: { userId_dmChannelId: { userId: carol.id, dmChannelId } },
      data: { pendingRemoval: new Date() },
    });

    const { commitB64, groupInfoB64 } = await buildMemberCommit();
    const res = await request(app)
      .post(`/api/v1/mls/groups/${groupId}/commits`)
      .set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '0', mode: 'member', commit: commitB64, groupInfo: groupInfoB64, idempotencyKey: randomUUID(), removedUserIds: [carol.id, dave.id] });
    expect(res.status).toBe(200);
    expect(res.body.epoch).toBe('1');

    const carolRow = await prisma.dMParticipant.findUnique({ where: { userId_dmChannelId: { userId: carol.id, dmChannelId } } });
    expect(carolRow).toBeNull(); // pendingRemoval + named -> finalized
    const daveRow = await prisma.dMParticipant.findUnique({ where: { userId_dmChannelId: { userId: dave.id, dmChannelId } } });
    expect(daveRow).not.toBeNull(); // named but NOT pendingRemoval -> survives (advisory, never delete an unmarked row)
  });

  it('excludes a pendingRemoval member from the mls-commit fan-out (silence is the signal)', async () => {
    const owner = await createTestUser();
    const stayer = await createTestUser();
    const evicted = await createTestUser();
    const channel = await prisma.dMChannel.create({
      data: { participants: { create: [{ userId: owner.id }, { userId: stayer.id }, { userId: evicted.id }] } },
      select: { id: true },
    });
    const ownerClient = await HarnessClient.create(owner.id, randomUUID());
    await ownerClient.createGroup();
    const created = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(owner.token)).send({ dmChannelId: channel.id, groupInfo: await ownerClient.publishGroupInfoB64() });
    const gid = created.body.groupId;

    await prisma.dMParticipant.update({
      where: { userId_dmChannelId: { userId: evicted.id, dmChannelId: channel.id } },
      data: { pendingRemoval: new Date() },
    });

    const stayerSock = await connect(stayer.token);
    const evictedSock = await connect(evicted.token);
    const stayerCommit = waitFor(stayerSock, 'mls-commit');
    const evictedNoCommit = neverReceives(evictedSock, 'mls-commit');

    const joiner = await HarnessClient.create(randomUUID(), randomUUID());
    const add = await ownerClient.commitAdd(await joiner.publishKeyPackageB64());
    // NOTE: evicted is intentionally NOT in removedUserIds here, so the in-tx finalize
    // delete does NOT remove the row. The only thing that can keep the pendingRemoval
    // member out of the fan-out is the `pendingRemoval: null` filter on allParticipants —
    // this isolates the exclusion behavior from the finalize delete (two-phase eviction:
    // a member can be marked pendingRemoval before the commit that names them lands).
    const res = await request(app)
      .post(`/api/v1/mls/groups/${gid}/commits`)
      .set('Authorization', authHeader(owner.token))
      .send({ baseEpoch: '0', mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID() });
    expect(res.status).toBe(200);

    const payload = (await stayerCommit) as { groupId: string; epoch: string; commit: string };
    expect(payload.groupId).toBe(gid);
    expect(payload.commit).toBe(add.commitB64);
    expect(await evictedNoCommit).toBe(true); // pendingRemoval member never gets the eviction commit
  });
});

// drive a REAL HarnessClient Remove commit through the full route stack.
// The conformance suite (mls/groupMembership.conformance.test.ts) drives a real
// Remove but never marks pendingRemoval first, so it does NOT exercise the DB
// finalize-deletes-pendingRemoval path nor the fan-out exclusion. These three
// tests close that gap with a genuine crypto Remove (no fake Add-shaped blob):
//   1. real-Remove finalize deletes ONLY the pendingRemoval target
//   2. a named-but-UNMARKED hinted target survives (advisory, never deletes an
//      unmarked row — security-relevant)
//   3. a pendingRemoval member never receives the eviction mls-commit (fan-out
//      exclusion; silence is the signal)
// The kick/leave/add ROUTE lifecycle is covered by dmGroupKickMls / dmGroupLeave
// / dmGroupMlsAddCreate and is deliberately NOT re-tested here.
//
// resolveLeafIndex matches the leaf by `${userId}:${deviceId}` credential
// identity, so the deviceId passed to commitRemove MUST equal the one used when
// the member's HarnessClient (and thus its leaf) was created. We pin a fixed
// deviceId per member and reuse it in BOTH create() and commitRemove().

/**
 * Seed a fresh real MLS group: owner founds it (epoch 0), then adds each member
 * by a real commitAdd (one per member, so epoch == members.length). Each member
 * client is created with the supplied deviceId so its leaf carries the
 * `${userId}:${deviceId}` identity that commitRemove later resolves. Returns the
 * groupId + dmChannelId + owner client + final epoch (the baseEpoch for a Remove).
 */
async function seedRealMlsGroup(
  owner: TestUser,
  members: { user: TestUser; deviceId: string }[],
): Promise<{ groupId: string; dmChannelId: string; ownerClient: HarnessClient; epoch: number }> {
  const channel = await prisma.dMChannel.create({
    data: { participants: { create: [{ userId: owner.id }, ...members.map((m) => ({ userId: m.user.id }))] } },
    select: { id: true },
  });
  const ownerClient = await HarnessClient.create(owner.id, randomUUID());
  await ownerClient.createGroup();
  const created = await request(app)
    .post('/api/v1/mls/groups')
    .set('Authorization', authHeader(owner.token))
    .send({ dmChannelId: channel.id, groupInfo: await ownerClient.publishGroupInfoB64() });
  expect(created.status).toBe(201);
  const gid = created.body.groupId as string;

  let epoch = 0;
  for (const m of members) {
    const memberClient = await HarnessClient.create(m.user.id, m.deviceId);
    const kp = await memberClient.publishKeyPackageB64();
    const add = await ownerClient.commitAdd(kp);
    const res = await request(app)
      .post(`/api/v1/mls/groups/${gid}/commits`)
      .set('Authorization', authHeader(owner.token))
      .send({ baseEpoch: String(epoch), mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID() });
    expect(res.status).toBe(200);
    epoch += 1;
    expect(res.body.epoch).toBe(String(epoch));
  }
  return { groupId: gid, dmChannelId: channel.id, ownerClient, epoch };
}

// A pendingRemoval submitter must NOT be able to
// submit a commit (e.g. External-Commit their own leaf back in, racing the
// Remove). The submitter-authorization pre-check and the in-tx TOCTOU re-check
// both filter `pendingRemoval: null`. The OWNER authoring the Remove is NOT
// pendingRemoval, so their commit is still authorized — only the pendingRemoval
// member's OWN commits are rejected (same 403 the not-a-participant path returns).
describe('POST /mls/groups/:groupId/commits — pendingRemoval submitter rejected', () => {
  it('rejects a commit from a pendingRemoval submitter (403) and does NOT advance the epoch; the owner is unaffected', async () => {
    const owner = await createTestUser();
    const removed = await createTestUser(); // marked pendingRemoval, still a participant row
    const { groupId, dmChannelId, ownerClient, epoch } = await seedRealMlsGroup(owner, [
      { user: removed, deviceId: randomUUID() },
    ]);
    expect(epoch).toBe(1);

    // Server has marked `removed` pendingRemoval; the Remove commit has not landed yet,
    // so the participant ROW still exists (this is the race window the fix closes).
    await prisma.dMParticipant.update({
      where: { userId_dmChannelId: { userId: removed.id, dmChannelId } },
      data: { pendingRemoval: new Date() },
    });

    const epochBefore = (await prisma.mlsGroup.findUnique({ where: { id: groupId }, select: { currentEpoch: true } }))!.currentEpoch;

    // A WELL-FORMED member commit (owner authors it). The commit bytes are valid, so the
    // request would pass classifyCommit and reach the CAS if admission let it through.
    // Under the OLD code the pendingRemoval submitter passed the participant-existence
    // pre-check and this returned 200 (RED). Under the fix, admission rejects with 403
    // BEFORE the commit is classified — the bytes are irrelevant.
    const add = await ownerClient.commitAdd(await (await HarnessClient.create(randomUUID(), randomUUID())).publishKeyPackageB64());
    const res = await request(app)
      .post(`/api/v1/mls/groups/${groupId}/commits`)
      .set('Authorization', authHeader(removed.token))
      .send({ baseEpoch: '1', mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID() });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not a participant of this DM channel');

    // The pendingRemoval member's commit was NOT applied: epoch unchanged, no commit row,
    // and the member's row was NOT re-established by them (it lingers, awaiting the Remove).
    const epochAfter = (await prisma.mlsGroup.findUnique({ where: { id: groupId }, select: { currentEpoch: true } }))!.currentEpoch;
    expect(epochAfter).toBe(epochBefore);
    const rows = await prisma.mlsCommit.count({ where: { groupId, epoch: 1n } });
    expect(rows).toBe(0);

    // Positive control: the OWNER (not pendingRemoval) can still submit on the SAME group,
    // proving the filter rejects only the pendingRemoval submitter, never the owner.
    const ownerRes = await request(app)
      .post(`/api/v1/mls/groups/${groupId}/commits`)
      .set('Authorization', authHeader(owner.token))
      .send({ baseEpoch: '1', mode: 'member', commit: add.commitB64, groupInfo: add.groupInfoB64, idempotencyKey: randomUUID() });
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.body.epoch).toBe('2');
  }, 40000);
});

describe('POST /mls/groups/:groupId/commits — REAL commitRemove through the route', () => {
  it('real Remove finalize deletes ONLY the pendingRemoval target named in removedUserIds; the owner survives', async () => {
    const owner = await createTestUser();
    const m1 = await createTestUser();
    const m1Dev = randomUUID();
    const { groupId, dmChannelId, ownerClient, epoch } = await seedRealMlsGroup(owner, [{ user: m1, deviceId: m1Dev }]);
    expect(epoch).toBe(1);

    // Server marks m1 pendingRemoval (the REST kick/leave route does this; here we
    // set it directly so this test isolates the finalize path, not the kick route).
    await prisma.dMParticipant.update({
      where: { userId_dmChannelId: { userId: m1.id, dmChannelId } },
      data: { pendingRemoval: new Date() },
    });

    // Owner authors a REAL Remove of m1's leaf (resolved by ${m1.id}:${m1Dev}) and
    // submits it at baseEpoch '1'. A fake blob would 400 at classifyCommit.
    const rm = await ownerClient.commitRemove([{ userId: m1.id, deviceId: m1Dev }]);
    const res = await request(app)
      .post(`/api/v1/mls/groups/${groupId}/commits`)
      .set('Authorization', authHeader(owner.token))
      .send({ baseEpoch: '1', mode: 'member', commit: rm.commitB64, groupInfo: rm.groupInfoB64, idempotencyKey: randomUUID(), removedUserIds: [m1.id] });
    expect(res.status).toBe(200);
    expect(res.body.epoch).toBe('2');

    const m1Row = await prisma.dMParticipant.findUnique({ where: { userId_dmChannelId: { userId: m1.id, dmChannelId } } });
    expect(m1Row).toBeNull(); // pendingRemoval + named -> finalized away
    const ownerRow = await prisma.dMParticipant.findUnique({ where: { userId_dmChannelId: { userId: owner.id, dmChannelId } } });
    expect(ownerRow).not.toBeNull(); // owner survives the finalize
  }, 40000);

  it('advisory: a hinted-but-UNMARKED target survives a real Remove (the in-tx delete never touches an unmarked row)', async () => {
    const owner = await createTestUser();
    const m1 = await createTestUser();
    const m1Dev = randomUUID();
    const { groupId, dmChannelId, ownerClient, epoch } = await seedRealMlsGroup(owner, [{ user: m1, deviceId: m1Dev }]);
    expect(epoch).toBe(1);

    // m1 is NOT marked pendingRemoval. The owner still names m1 in removedUserIds.
    const rm = await ownerClient.commitRemove([{ userId: m1.id, deviceId: m1Dev }]);
    const res = await request(app)
      .post(`/api/v1/mls/groups/${groupId}/commits`)
      .set('Authorization', authHeader(owner.token))
      .send({ baseEpoch: '1', mode: 'member', commit: rm.commitB64, groupInfo: rm.groupInfoB64, idempotencyKey: randomUUID(), removedUserIds: [m1.id] });
    expect(res.status).toBe(200);
    expect(res.body.epoch).toBe('2');

    // The finalize's `pendingRemoval: { not: null }` filter must spare the unmarked
    // row: removedUserIds is an advisory hint, never an authorization to delete.
    const m1Row = await prisma.dMParticipant.findUnique({ where: { userId_dmChannelId: { userId: m1.id, dmChannelId } } });
    expect(m1Row).not.toBeNull();
  }, 40000);

  it('a pendingRemoval member NEVER receives the eviction mls-commit from a real Remove, while a remaining member does', async () => {
    const owner = await createTestUser();
    const m1 = await createTestUser(); // pendingRemoval target
    const m2 = await createTestUser(); // remaining member
    const m1Dev = randomUUID();
    const m2Dev = randomUUID();
    const { groupId, dmChannelId, ownerClient, epoch } = await seedRealMlsGroup(owner, [
      { user: m1, deviceId: m1Dev },
      { user: m2, deviceId: m2Dev },
    ]);
    expect(epoch).toBe(2);

    await prisma.dMParticipant.update({
      where: { userId_dmChannelId: { userId: m1.id, dmChannelId } },
      data: { pendingRemoval: new Date() },
    });

    const m1Sock = await connect(m1.token);
    const m2Sock = await connect(m2.token);
    const m2Commit = waitFor(m2Sock, 'mls-commit');
    const m1NoCommit = neverReceives(m1Sock, 'mls-commit');

    const rm = await ownerClient.commitRemove([{ userId: m1.id, deviceId: m1Dev }]);
    const res = await request(app)
      .post(`/api/v1/mls/groups/${groupId}/commits`)
      .set('Authorization', authHeader(owner.token))
      .send({ baseEpoch: '2', mode: 'member', commit: rm.commitB64, groupInfo: rm.groupInfoB64, idempotencyKey: randomUUID(), removedUserIds: [m1.id] });
    expect(res.status).toBe(200);
    expect(res.body.epoch).toBe('3');

    // m2 (remaining) gets the eviction commit; m1 (pendingRemoval) is excluded from
    // the fan-out by the `pendingRemoval: null` filter — silence is the signal.
    const payload = (await m2Commit) as { groupId: string; epoch: string; commit: string };
    expect(payload.groupId).toBe(groupId);
    expect(payload.epoch).toBe('3');
    expect(payload.commit).toBe(rm.commitB64);
    expect(await m1NoCommit).toBe(true);
  }, 40000);
});
