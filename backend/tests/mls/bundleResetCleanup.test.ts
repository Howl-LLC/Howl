// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from '../helpers.js';
import { prisma } from '../../src/db.js';

let user: TestUser;
let peer: TestUser;
let deviceId: string;

beforeAll(async () => {
  user = await createTestUser();
  peer = await createTestUser();
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
  // A pending Welcome sealed to the resetter's (about to be destroyed) init keys, and
  // one addressed to a PEER — the reset must purge only the resetter's.
  await prisma.mlsWelcome.createMany({
    data: [
      { recipientId: user.id, groupId: randomUUID(), epoch: 1n, welcomeData: Buffer.from('w') },
      { recipientId: peer.id, groupId: randomUUID(), epoch: 1n, welcomeData: Buffer.from('w') },
    ],
  });
  // A now-orphaned AIK rotation chain + head (the reset ends the lineage; re-setup
  // mints an unlinked genesis AIK).
  await prisma.aikRotation.create({
    data: { userId: user.id, seq: 1, oldAik: 'old', newAik: 'new', signature: 's', context: 'howl:mls:aik-rotation:v1' },
  });
  await prisma.aikHead.create({
    data: { userId: user.id, seq: 1, aik: 'new', signature: 's' },
  });
});

afterAll(async () => {
  await prisma.mlsWelcome.deleteMany({});
  await prisma.aikRotation.deleteMany({});
  await prisma.aikHead.deleteMany({});
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

  it('purges the resetter pending MlsWelcome rows (sealed to destroyed init keys) but not others', async () => {
    expect(await prisma.mlsWelcome.count({ where: { recipientId: user.id } })).toBe(0);
    expect(await prisma.mlsWelcome.count({ where: { recipientId: peer.id } })).toBe(1);
  });

  it('clears the now-orphaned AIK rotation chain and head', async () => {
    expect(await prisma.aikRotation.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.aikHead.count({ where: { userId: user.id } })).toBe(0);
  });
});
