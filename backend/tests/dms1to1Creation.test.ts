// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for POST /api/v1/dms - keyless 1:1 DM creation.
 *
 * The create is keyless: MLS (Welcome / External Commit) is the sole key
 * distribution, so the route accepts { otherUserId } alone, creates the
 * channel encrypted=true, writes NO PendingKeyDelivery dead-drop, and the
 * legacy key fields (encryptedKey + nonce + senderPublicKey) are REJECTED by
 * the .strict() body schema.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';

const FAKE_PUB = Buffer.from('a'.repeat(32)).toString('base64');
const FAKE_ENCRYPTED_KEY = Buffer.from('e'.repeat(48)).toString('base64');
const FAKE_NONCE = Buffer.from('n'.repeat(24)).toString('base64');

let userA: TestUser;
let userB: TestUser;
let userC: TestUser;

beforeAll(async () => {
  userA = await createTestUser();
  userB = await createTestUser();
  userC = await createTestUser();
});

afterAll(cleanupTestData);

describe('POST /api/v1/dms - keyless 1:1 create', () => {
  it('creates a keyless 1:1 DM: 201, encrypted=true, no dead-drop', async () => {
    const res = await request(app)
      .post('/api/v1/dms')
      .set('Authorization', authHeader(userA.token))
      .send({ otherUserId: userB.id });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.encrypted).toBe(true);
    expect(res.body.otherUser?.id).toBe(userB.id);

    const row = await prisma.dMChannel.findUnique({ where: { id: res.body.id } });
    expect(row?.encrypted).toBe(true);
  });

  it('dedups to the existing channel: 200 with the same id', async () => {
    const first = await request(app)
      .post('/api/v1/dms')
      .set('Authorization', authHeader(userA.token))
      .send({ otherUserId: userC.id });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/v1/dms')
      .set('Authorization', authHeader(userA.token))
      .send({ otherUserId: userC.id });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it('rejects self-DM (400)', async () => {
    const res = await request(app)
      .post('/api/v1/dms')
      .set('Authorization', authHeader(userA.token))
      .send({ otherUserId: userA.id });
    expect(res.status).toBe(400);
  });

  it('rejects the legacy keyed body shape (Zod 400, strict schema)', async () => {
    const res = await request(app)
      .post('/api/v1/dms')
      .set('Authorization', authHeader(userA.token))
      .send({
        otherUserId: userB.id,
        encryptedKey: FAKE_ENCRYPTED_KEY,
        nonce: FAKE_NONCE,
        senderPublicKey: FAKE_PUB,
      });
    expect(res.status).toBe(400);
  });

  it('blocked users cannot create a DM (403)', async () => {
    const blocked = await createTestUser();
    await request(app)
      .post('/api/v1/friends/block')
      .set('Authorization', authHeader(blocked.token))
      .send({ userId: userA.id });

    const res = await request(app)
      .post('/api/v1/dms')
      .set('Authorization', authHeader(userA.token))
      .send({ otherUserId: blocked.id });
    expect(res.status).toBe(403);
  });
});
