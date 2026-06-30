// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from '../helpers.js';
import { prisma } from '../../src/db.js';

let user: TestUser;
let deviceId: string;

beforeAll(async () => {
  user = await createTestUser();
  deviceId = randomUUID();
  await prisma.dmKeyBundle.create({
    data: {
      userId: user.id,
      publicKey: 'x',
      encryptedBlob: 'x',
      blobSalt: 'y',
      recoveryBlob: 'r',
      recoveryNonce: 'n',
      passwordDerived: false,
    },
  });
  await prisma.mlsKeyPackage.createMany({
    data: [
      {
        userId: user.id,
        deviceId,
        keyPackageRef: randomUUID(),
        keyPackage: Buffer.from('a'),
        isLastResort: false,
        notAfter: new Date(Date.now() + 86_400_000),
      },
      {
        userId: user.id,
        deviceId,
        keyPackageRef: randomUUID(),
        keyPackage: Buffer.from('b'),
        isLastResort: true,
        notAfter: new Date(Date.now() + 100 * 365 * 86_400_000),
      },
    ],
  });
});

afterAll(async () => {
  await prisma.mlsKeyPackage.deleteMany({});
  await prisma.dmKeyBundle.deleteMany({});
  await cleanupTestData();
});

describe('DELETE /api/dms/keys/bundle — MLS KeyPackage cleanup', () => {
  it('deletes all of the user MLS KeyPackage rows (single-use AND last-resort)', async () => {
    const before = await prisma.mlsKeyPackage.count({ where: { userId: user.id } });
    expect(before).toBe(2);

    const res = await request(app)
      .delete('/api/dms/keys/bundle')
      .set('Authorization', authHeader(user.token));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const after = await prisma.mlsKeyPackage.count({ where: { userId: user.id } });
    expect(after).toBe(0);
    // No orphaned no-expiry last-resort row a future adder could still consume.
    const lastResort = await prisma.mlsKeyPackage.count({ where: { userId: user.id, isLastResort: true } });
    expect(lastResort).toBe(0);
  });
});
