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
let blocked: TestUser;
let targetDevice: string;

beforeAll(async () => {
  target = await createTestUser();
  blocked = await createTestUser();
  targetDevice = randomUUID();
  const c = await HarnessClient.create(target.id, targetDevice);
  await seedMlsPublisherAik(target.id, c.aikPublicKeyB64());
  await request(app).post('/api/v1/mls/keypackages').set('Authorization', authHeader(target.token)).send({ deviceId: targetDevice, keyPackages: [{ keyPackage: await c.publishKeyPackageB64() }] });
  // target blocks the other user.
  await prisma.block.create({ data: { blockerId: target.id, blockedUserId: blocked.id } });
});
afterAll(async () => {
  await prisma.mlsKeyPackage.deleteMany({});
  await prisma.block.deleteMany({});
  await cleanupTestData();
});

describe('block guard on KeyPackage consume', () => {
  it('refuses to serve a target KeyPackage to a blocked user (403)', async () => {
    const res = await request(app).get(`/api/v1/mls/keypackages/${target.id}`).set('Authorization', authHeader(blocked.token));
    expect(res.status).toBe(403);
    // the target's pool must remain untouched
    const consumed = await prisma.mlsKeyPackage.count({ where: { userId: target.id, consumedAt: { not: null } } });
    expect(consumed).toBe(0);
  });
});

describe('block guard on public-key lookup', () => {
  it('refuses to serve a target public key to a blocked user (403)', async () => {
    const res = await request(app).get(`/api/v1/dms/keys/public-key/${target.id}`).set('Authorization', authHeader(blocked.token));
    expect(res.status).toBe(403);
  });
});
