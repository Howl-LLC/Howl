// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * The KeyPackage-consume route limits per (caller, target), not by target alone.
 * A target-only budget would let a SINGLE abuser spend the
 * whole shared allowance and 429 every legitimate group-adder of the same victim
 * (Impact a). Both limiters are package-counted, with the per-(caller,target) cap
 * kept well below the per-target aggregate, so one account can never saturate the
 * shared budget — for ANY device count. These tests pre-seed the real limiter
 * state (arrange) and then exercise the route (act).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/server.js';
import { createTestUser, authHeader, cleanupTestData, seedMlsPublisherAik, type TestUser } from '../helpers.js';
import { prisma } from '../../src/db.js';
import { HarnessClient } from './harnessClient.js';
import { recordKpConsume, recordKpConsumeCaller, KP_CONSUME_CALLER_MAX } from '../../src/redis.js';

let target: TestUser;     // single-device victim
let multiTarget: TestUser; // multi-device victim
let abuser: TestUser;
let honest: TestUser;
let honest2: TestUser;
const multiDevices = [randomUUID(), randomUUID(), randomUUID()];

async function publish(uId: string, dId: string, token: string, count: number, lastResort = false) {
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
  multiTarget = await createTestUser();
  abuser = await createTestUser();
  honest = await createTestUser();
  honest2 = await createTestUser();
  await publish(target.id, randomUUID(), target.token, 3);
  for (const dev of multiDevices) await publish(multiTarget.id, dev, multiTarget.token, 3);
});
afterAll(async () => {
  await prisma.mlsKeyPackage.deleteMany({});
  await cleanupTestData();
});

describe('per-(caller,target) consume limit', () => {
  it('429s a single abuser at its per-(caller,target) cap but still serves a DIFFERENT caller (Impact a)', async () => {
    // Arrange: the abuser has drained its entire per-(caller,target) budget.
    await recordKpConsumeCaller(abuser.id, target.id, KP_CONSUME_CALLER_MAX);

    const blocked = await request(app).get(`/api/v1/mls/keypackages/${target.id}`).set('Authorization', authHeader(abuser.token));
    expect(blocked.status).toBe(429);

    // A legitimate adder is NOT starved by the abuser monopolising the budget.
    const honestRes = await request(app).get(`/api/v1/mls/keypackages/${target.id}`).set('Authorization', authHeader(honest.token));
    expect(honestRes.status).toBe(200);
    expect(honestRes.body.keyPackages[0].isLastResort).toBe(false);
  });

  it('a MULTI-DEVICE victim: one caller draining its full budget cannot 429 an honest adder (monopoly resistance)', async () => {
    // Arrange: one abuser's entire per-(caller,target) budget contributes at most
    // KP_CONSUME_CALLER_MAX packages to the shared per-target aggregate.
    await recordKpConsume(multiTarget.id, KP_CONSUME_CALLER_MAX);

    // An honest, different adder of this multi-device victim is unaffected — the
    // aggregate (<= CALLER_MAX) stays far below KP_CONSUME_RATE_MAX.
    const honestRes = await request(app).get(`/api/v1/mls/keypackages/${multiTarget.id}`).set('Authorization', authHeader(honest2.token));
    expect(honestRes.status).toBe(200);
    expect(honestRes.body.keyPackages).toHaveLength(multiDevices.length); // all devices served (multi-device path)
    expect(honestRes.body.keyPackages.every((p: { isLastResort: boolean }) => !p.isLastResort)).toBe(true);
  });
});
