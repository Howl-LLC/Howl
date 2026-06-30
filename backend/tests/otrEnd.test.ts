// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Enabling Server recovery (passwordDerived = true) makes a user
 * OTR-INELIGIBLE: an escrowed identity could mint a ghost device into the group.
 * So PUT /dms/keys/password-derived must server-authoritatively AUTO-END every
 * OTR group the user participates in — delete the tier:'otr' MlsGroup server rows
 * for that user's channels — while leaving the tier:'saved' group untouched.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';

describe('PUT /api/v1/dms/keys/password-derived — OTR auto-end', () => {
  let userA: TestUser;
  let userB: TestUser;
  let dmChannelId: string;

  beforeAll(async () => {
    process.env.SERVER_E2E_MASTER_KEY = 'a'.repeat(64);

    userA = await createTestUser();
    userB = await createTestUser();

    // A starts in Private (passwordDerived = false).
    await prisma.dmKeyBundle.create({
      data: {
        userId: userA.id,
        publicKey: Buffer.from('p'.repeat(32)).toString('base64'),
        encryptedBlob: Buffer.from('blob-a').toString('base64'),
        blobSalt: Buffer.from('salt-a').toString('base64'),
        recoveryBlob: Buffer.from('rec-a').toString('base64'),
        recoveryNonce: Buffer.from('rnonce-a').toString('base64'),
        passwordDerived: false,
        recoveryMode: 'key',
      },
    });

    // 1:1 channel between A and B.
    const channel = await prisma.dMChannel.create({
      data: {
        isGroup: false,
        encrypted: true,
        participants: {
          create: [{ userId: userA.id }, { userId: userB.id }],
        },
      },
      select: { id: true },
    });
    dmChannelId = channel.id;

    // Both a tier:'saved' AND a tier:'otr' group on that channel.
    await prisma.mlsGroup.createMany({
      data: [
        { dmChannelId, tier: 'saved' },
        { dmChannelId, tier: 'otr' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.mlsGroup.deleteMany({});
    await prisma.dMParticipant.deleteMany({});
    await prisma.dMChannel.deleteMany({});
    await prisma.dmKeyBundle.deleteMany({});
    await cleanupTestData();
  });

  it('deletes the tier:otr group for A\'s channel but leaves tier:saved intact', async () => {
    const res = await request(app)
      .put('/api/v1/dms/keys/password-derived')
      .set('Authorization', authHeader(userA.token))
      .send({ rawBlobForEscrow: Buffer.from(JSON.stringify({ privateKey: 'x' })).toString('base64') });

    expect(res.status).toBe(200);

    const otrCount = await prisma.mlsGroup.count({ where: { dmChannelId, tier: 'otr' } });
    expect(otrCount).toBe(0);

    const savedCount = await prisma.mlsGroup.count({ where: { dmChannelId, tier: 'saved' } });
    expect(savedCount).toBe(1);
  });
});
