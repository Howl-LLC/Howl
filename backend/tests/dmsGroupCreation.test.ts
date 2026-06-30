// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for POST /api/v1/dms/group - new group DMs are MLS-only.
 *
 * createGroupDmSchema accepts ONLY memberIds; the legacy encryptedKeys /
 * senderPublicKey fields no longer exist. A keyless create succeeds (201);
 * the MLS Welcome is the sole key distribution. A body that still carries the
 * legacy keyed fields is rejected (Zod 400, strict schema).
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';

let userA: TestUser;
let userB: TestUser;

beforeAll(async () => {
  userA = await createTestUser();
  userB = await createTestUser();
});

afterAll(cleanupTestData);

describe('POST /api/v1/dms/group — MLS-only keyless create', () => {
  it('succeeds (201) with only memberIds', async () => {
    const res = await request(app)
      .post('/api/v1/dms/group')
      .set('Authorization', authHeader(userA.token))
      .send({ memberIds: [userB.id] }); // MLS create, keyless

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.isGroup).toBe(true);
    expect(res.body.created).toBe(true);
    expect(res.body.encrypted).toBe(true);
    expect(res.body.otherUsers).toHaveLength(1);
    expect(res.body.otherUsers[0].id).toBe(userB.id);

    // Channel + both participants created.
    const participants = await prisma.dMParticipant.findMany({
      where: { dmChannelId: res.body.id as string },
      select: { userId: true },
    });
    const ids = new Set(participants.map((p) => p.userId));
    expect(ids.has(userA.id)).toBe(true);
    expect(ids.has(userB.id)).toBe(true);
  });

  it('rejects the legacy keyed group-create body (Zod 400, strict schema)', async () => {
    const userC = await createTestUser();
    const FAKE = Buffer.from('e'.repeat(48)).toString('base64');
    const FAKE_N = Buffer.from('n'.repeat(24)).toString('base64');
    const FAKE_PUB = Buffer.from('p'.repeat(32)).toString('base64');
    const res = await request(app)
      .post('/api/v1/dms/group')
      .set('Authorization', authHeader(userA.token))
      .send({
        memberIds: [userC.id],
        encryptedKeys: [{ recipientId: userC.id, encryptedKey: FAKE, nonce: FAKE_N }],
        senderPublicKey: FAKE_PUB,
      });
    expect(res.status).toBe(400);
  });
});
