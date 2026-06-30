// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/server.js';
import { createTestUser, authHeader, cleanupTestData, seedMlsPublisherAik, type TestUser } from '../helpers.js';
import { prisma } from '../../src/db.js';
import { HarnessClient } from './harnessClient.js';

let target: TestUser;
let consumer: TestUser;
let targetDevice: string;

async function publish(uId: string, dId: string, token: string, count: number, lastResort = false) {
  // One client per (user, device): every KeyPackage carries this client's AIK, which
  // we seed as the account's published signingPublicKey so the AS cross-signature gate
  // passes. Distinct init/HPKE keys per call still yield distinct refs.
  const c = await HarnessClient.create(uId, dId);
  await seedMlsPublisherAik(uId, c.aikPublicKeyB64());
  const kps = [];
  for (let i = 0; i < count; i++) {
    kps.push({ keyPackage: await c.publishKeyPackageWithStableSigningKeyB64(), isLastResort: lastResort });
  }
  const res = await request(app).post('/api/v1/mls/keypackages').set('Authorization', authHeader(token)).send({ deviceId: dId, keyPackages: kps });
  expect(res.status).toBe(201);
}

beforeAll(async () => {
  target = await createTestUser();
  consumer = await createTestUser();
  targetDevice = randomUUID();
});
afterAll(async () => {
  await prisma.mlsKeyPackage.deleteMany({});
  await cleanupTestData();
});

describe('GET /api/v1/mls/keypackages/:userId (consume)', () => {
  it('consumes one single-use KeyPackage per device and tombstones it', async () => {
    await publish(target.id, targetDevice, target.token, 2);
    const res = await request(app)
      .get(`/api/v1/mls/keypackages/${target.id}`)
      .set('Authorization', authHeader(consumer.token));
    expect(res.status).toBe(200);
    expect(res.body.keyPackages).toHaveLength(1);
    expect(res.body.keyPackages[0].deviceId).toBe(targetDevice);
    expect(res.body.keyPackages[0].keyPackage).toEqual(expect.any(String));
    expect(res.body.keyPackages[0].isLastResort).toBe(false);
    const consumed = await prisma.mlsKeyPackage.count({ where: { userId: target.id, deviceId: targetDevice, consumedAt: { not: null } } });
    expect(consumed).toBe(1);
  });

  it('falls back to the reusable last-resort package when the single-use pool is empty', async () => {
    const t = await createTestUser();
    const dev = randomUUID();
    await publish(t.id, dev, t.token, 1, true); // only a last-resort
    const res = await request(app).get(`/api/v1/mls/keypackages/${t.id}`).set('Authorization', authHeader(consumer.token));
    expect(res.status).toBe(200);
    expect(res.body.keyPackages[0].isLastResort).toBe(true);
    const res2 = await request(app).get(`/api/v1/mls/keypackages/${t.id}`).set('Authorization', authHeader(consumer.token));
    expect(res2.status).toBe(200);
    expect(res2.body.keyPackages[0].isLastResort).toBe(true);
  });

  it('returns 404 when the target has no devices/packages at all', async () => {
    const empty = await createTestUser();
    const res = await request(app).get(`/api/v1/mls/keypackages/${empty.id}`).set('Authorization', authHeader(consumer.token));
    expect(res.status).toBe(404);
  });

  it('atomic consume: N concurrent fetchers each get a DISTINCT single-use package (exactly-one-winner per row)', async () => {
    const t = await createTestUser();
    const dev = randomUUID();
    await publish(t.id, dev, t.token, 5);
    const fetchers = Array.from({ length: 5 }, () =>
      request(app).get(`/api/v1/mls/keypackages/${t.id}`).set('Authorization', authHeader(consumer.token)),
    );
    const results = await Promise.all(fetchers);
    const refs = results.map((r) => r.body.keyPackages?.[0]?.keyPackageRef).filter(Boolean);
    expect(new Set(refs).size).toBe(refs.length); // no two fetchers consumed the same row
    expect(refs.length).toBeGreaterThan(0);
  });
});

describe('GET /api/v1/mls/keypackages/count', () => {
  it('reports the remaining single-use count for the caller device', async () => {
    const t = await createTestUser();
    const dev = randomUUID();
    await publish(t.id, dev, t.token, 3);
    const res = await request(app)
      .get('/api/v1/mls/keypackages/count')
      .query({ deviceId: dev })
      .set('Authorization', authHeader(t.token));
    expect(res.status).toBe(200);
    expect(res.body.remaining).toBe(3);
  });
});
