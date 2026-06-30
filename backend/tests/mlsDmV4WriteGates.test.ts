// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression guards for the v4 (MLS) wire-format write gates on encrypted DM
 * channels. Two backend write paths used to accept only v2/v3 envelopes and
 * silently 400'd a v4 MLS envelope:
 *   1. EDIT  — PATCH /:dmChannelId/messages/:messageId
 *   2. FORWARD — POST  /:dmChannelId/messages with forwarded:true
 * Both now ALSO accept a v4 envelope ({"v":4,"m":"<base64 wire bytes>"}). The
 * gate only checks v===4 and m is a non-empty string — the server stores opaque
 * ciphertext and never decrypts, so the bytes inside `m` need not be a real MLS
 * message for these wire-format tests.
 *
 * Each test exercises a fresh user pair + channel so the per-user send/mutate
 * rate limiters (8/10s send, 30/60s mutate) are never approached.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';

// A v4 MLS envelope. The base64 in `m` is a placeholder — the gate only checks
// v===4 and that m is a non-empty string; the server never decrypts it.
const V4_ENVELOPE = JSON.stringify({ v: 4, m: 'AAEAAg==' });

let userA: TestUser;
let userB: TestUser;

async function createEncryptedChannel(uid1: string, uid2: string): Promise<string> {
  const ch = await prisma.dMChannel.create({
    data: { encrypted: true, participants: { create: [{ userId: uid1 }, { userId: uid2 }] } },
    select: { id: true },
  });
  return ch.id;
}

beforeAll(async () => {
  userA = await createTestUser();
  userB = await createTestUser();
});

afterAll(async () => {
  await prisma.dMMessage.deleteMany({});
  await prisma.dMChannel.deleteMany({});
  await cleanupTestData();
});

describe('v4 MLS write gates on encrypted DM channels', () => {
  describe('EDIT path — PATCH /:dmChannelId/messages/:messageId', () => {
    it('A1: accepts a v4 MLS envelope when editing an own message (200, stores the v4 string)', async () => {
      const channelId = await createEncryptedChannel(userA.id, userB.id);
      // Seed an own (E2E) message directly; the edit handler never decrypts it.
      const seeded = await prisma.dMMessage.create({
        data: {
          dmChannelId: channelId,
          authorId: userA.id,
          content: JSON.stringify({ v: 4, m: 'b3JpZ2luYWw=' }),
          encryptionVersion: 2,
        },
        select: { id: true },
      });

      const res = await request(app)
        .patch(`/api/v1/dms/${channelId}/messages/${seeded.id}`)
        .set('Authorization', authHeader(userA.token))
        .send({ content: V4_ENVELOPE, encrypted: true });

      expect(res.status).toBe(200);
      expect(res.body.content).toBe(V4_ENVELOPE);
      expect(res.body.encrypted).toBe(true);
    });

    it('A2: still rejects a plaintext edit on an encrypted channel (400)', async () => {
      const channelId = await createEncryptedChannel(userA.id, userB.id);
      const seeded = await prisma.dMMessage.create({
        data: {
          dmChannelId: channelId,
          authorId: userA.id,
          content: JSON.stringify({ v: 4, m: 'b3JpZ2luYWw=' }),
          encryptionVersion: 2,
        },
        select: { id: true },
      });

      const res = await request(app)
        .patch(`/api/v1/dms/${channelId}/messages/${seeded.id}`)
        .set('Authorization', authHeader(userA.token))
        .send({ content: 'hello', encrypted: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Edits to encrypted channels must be end-to-end encrypted.');
    });
  });

  describe('FORWARD path — POST /:dmChannelId/messages (forwarded:true)', () => {
    it('B1: accepts a forwarded v4 MLS envelope (201, forwarded:true persisted)', async () => {
      const channelId = await createEncryptedChannel(userA.id, userB.id);

      const res = await request(app)
        .post(`/api/v1/dms/${channelId}/messages`)
        .set('Authorization', authHeader(userA.token))
        .send({ content: V4_ENVELOPE, encrypted: true, forwarded: true });

      expect(res.status).toBe(201);
      expect(res.body.forwarded).toBe(true);
      expect(res.body.content).toBe(V4_ENVELOPE);
      expect(res.body.encrypted).toBe(true);
    });

    it('B2: still rejects a forwarded plaintext message on an encrypted channel (400)', async () => {
      const channelId = await createEncryptedChannel(userA.id, userB.id);

      // encrypted:true so the request reaches the forward gate (which runs
      // before the encrypted-flag check); the content is non-envelope plaintext.
      const res = await request(app)
        .post(`/api/v1/dms/${channelId}/messages`)
        .set('Authorization', authHeader(userA.token))
        .send({ content: 'forward me', encrypted: true, forwarded: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Forwarded messages to encrypted channels must be encrypted');
    });
  });
});
