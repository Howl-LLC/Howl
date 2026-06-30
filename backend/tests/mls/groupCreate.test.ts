// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from '../helpers.js';
import { prisma } from '../../src/db.js';
import { HarnessClient } from './harnessClient.js';

let alice: TestUser;
let outsider: TestUser;
let dmChannelId: string;
let groupInfoB64: string;

beforeAll(async () => {
  alice = await createTestUser();
  outsider = await createTestUser();
  const channel = await prisma.dMChannel.create({ data: { participants: { create: [{ userId: alice.id }] } }, select: { id: true } });
  dmChannelId = channel.id;
  const client = await HarnessClient.create(alice.id, '00000000-0000-4000-8000-0000000000aa');
  await client.createGroup();
  groupInfoB64 = await client.publishGroupInfoB64();
});
afterAll(async () => {
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
});

describe('POST /api/v1/mls/groups', () => {
  it('creates a group at epoch 0 for a participant', async () => {
    const res = await request(app)
      .post('/api/v1/mls/groups')
      .set('Authorization', authHeader(alice.token))
      .send({ dmChannelId, groupInfo: groupInfoB64 });
    expect(res.status).toBe(201);
    expect(res.body.groupId).toEqual(expect.any(String));
    expect(res.body.currentEpoch).toBe('0'); // string-encoded BigInt
    const group = await prisma.mlsGroup.findUnique({ where: { id: res.body.groupId } });
    expect(group?.currentEpoch).toBe(0n);
    expect(group?.groupInfoEpoch).toBe(0n);
    expect(group?.groupInfo?.length).toBeGreaterThan(0);
  });

  it('rejects a duplicate create with 409 (create-once)', async () => {
    const res = await request(app)
      .post('/api/v1/mls/groups')
      .set('Authorization', authHeader(alice.token))
      .send({ dmChannelId, groupInfo: groupInfoB64 });
    expect(res.status).toBe(409);
  });

  it('rejects a non-participant with 403', async () => {
    const channel = await prisma.dMChannel.create({ data: { participants: { create: [{ userId: alice.id }] } }, select: { id: true } });
    const res = await request(app)
      .post('/api/v1/mls/groups')
      .set('Authorization', authHeader(outsider.token))
      .send({ dmChannelId: channel.id, groupInfo: groupInfoB64 });
    expect(res.status).toBe(403);
  });
});

// Helper: fresh channel + a real epoch-0 MlsGroup owned by alice. Returns ids + the GroupInfo.
async function freshAliceGroup(): Promise<{ channelId: string; groupId: string; giB64: string }> {
  const channel = await prisma.dMChannel.create({ data: { participants: { create: [{ userId: alice.id }] } }, select: { id: true } });
  const client = await HarnessClient.create(alice.id, randomUUID());
  await client.createGroup();
  const giB64 = await client.publishGroupInfoB64();
  const res = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId: channel.id, groupInfo: giB64 });
  expect(res.status).toBe(201);
  return { channelId: channel.id, groupId: res.body.groupId as string, giB64 };
}

const ELEVEN_MIN_AGO = () => new Date(Date.now() - 11 * 60 * 1000);

describe('POST /api/v1/mls/groups — epoch-0 self-heal', () => {
  it('replaces a stale (>10 min, epoch-0) row and returns 201 with a new groupId', async () => {
    const { channelId, groupId: oldId, giB64 } = await freshAliceGroup();
    await prisma.mlsGroup.update({ where: { id: oldId }, data: { createdAt: ELEVEN_MIN_AGO() } });

    const res = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId: channelId, groupInfo: giB64 });
    expect(res.status).toBe(201);
    expect(res.body.groupId).not.toBe(oldId);
    expect(res.body.currentEpoch).toBe('0');

    expect(await prisma.mlsGroup.findUnique({ where: { id: oldId } })).toBeNull(); // old row gone
    expect(await prisma.mlsGroup.count({ where: { dmChannelId: channelId } })).toBe(1); // exactly the replacement
  });

  it('does NOT replace an epoch-0 row younger than the grace window (409)', async () => {
    const { channelId, groupId: oldId, giB64 } = await freshAliceGroup(); // createdAt = now
    const res = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId: channelId, groupInfo: giB64 });
    expect(res.status).toBe(409);
    expect(await prisma.mlsGroup.findUnique({ where: { id: oldId } })).not.toBeNull(); // untouched
  });

  it('does NOT replace a row at epoch >= 1 even when old (409)', async () => {
    const { channelId, groupId: oldId, giB64 } = await freshAliceGroup();
    await prisma.mlsGroup.update({ where: { id: oldId }, data: { createdAt: ELEVEN_MIN_AGO(), currentEpoch: 1n } });
    const res = await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId: channelId, groupInfo: giB64 });
    expect(res.status).toBe(409);
    const row = await prisma.mlsGroup.findUnique({ where: { id: oldId } });
    expect(row?.id).toBe(oldId);
    expect(row?.currentEpoch).toBe(1n);
  });

  it('two concurrent creates against a stale row produce exactly one winner', async () => {
    const { channelId, giB64 } = await freshAliceGroup();
    await prisma.mlsGroup.updateMany({ where: { dmChannelId: channelId }, data: { createdAt: ELEVEN_MIN_AGO() } });

    const [a, b] = await Promise.all([
      request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId: channelId, groupInfo: giB64 }),
      request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId: channelId, groupInfo: giB64 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]); // exactly one heal wins
    expect(await prisma.mlsGroup.count({ where: { dmChannelId: channelId } })).toBe(1);
  });

  it('a commit against the replaced (deleted) group fails closed (404)', async () => {
    const { channelId, groupId: oldId, giB64 } = await freshAliceGroup();
    await prisma.mlsGroup.update({ where: { id: oldId }, data: { createdAt: ELEVEN_MIN_AGO() } });
    await request(app).post('/api/v1/mls/groups').set('Authorization', authHeader(alice.token)).send({ dmChannelId: channelId, groupInfo: giB64 }); // heal -> deletes oldId

    const b64 = Buffer.from('x').toString('base64');
    const res = await request(app)
      .post(`/api/v1/mls/groups/${oldId}/commits`)
      .set('Authorization', authHeader(alice.token))
      .send({ baseEpoch: '0', mode: 'member', commit: b64, groupInfo: b64, idempotencyKey: randomUUID() });
    expect(res.status).toBe(404); // Group not found -> CAS would match zero rows
  });
});
