// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression test: DM mutation routes must run authenticateToken
 * BEFORE dmMutateLimiter so the limiter keys per userId, not per shared IP.
 *
 * Without the fix, all requests behind a proxy share edge-IP keys — one user
 * can burn another user's budget, and legit traffic collides with itself.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';
import { randomUUID } from 'crypto';

let userA: TestUser;
let userB: TestUser;
let dmChannelId: string;

beforeAll(async () => {
  userA = await createTestUser();
  userB = await createTestUser();

  // Shared 1:1 DM channel — both users are participants so both can hit /pin.
  dmChannelId = randomUUID();
  await prisma.dMChannel.create({ data: { id: dmChannelId } });
  await prisma.dMParticipant.createMany({
    data: [
      { userId: userA.id, dmChannelId },
      { userId: userB.id, dmChannelId },
    ],
  });
});

afterAll(cleanupTestData);

describe('dmMutateLimiter keys per-user (auth before limiter)', () => {
  // dmMutateLimiter is 30/min per user. Fire 31 requests as user A; expect 30
  // success and at least 1 × 429. Then fire 30 as user B from the same
  // supertest loopback IP — all 30 must succeed, proving per-userId keying.
  it('per-user keying: userA is limited but userB (same IP) is not', async () => {
    const successesA: number[] = [];
    const rateLimitedA: number[] = [];

    for (let i = 0; i < 31; i++) {
      const res = await request(app)
        .post(`/api/dms/${dmChannelId}/pin`)
        .set('Authorization', authHeader(userA.token));
      if (res.status === 200) successesA.push(res.status);
      else if (res.status === 429) rateLimitedA.push(res.status);
    }

    expect(successesA.length).toBe(30);
    expect(rateLimitedA.length).toBeGreaterThanOrEqual(1);

    // User B — different JWT, same loopback IP. If the limiter were still
    // keyed on req.ip, B's requests would land in A's already-exhausted
    // bucket. Per-userId keying gives B a fresh 30.
    const successesB: number[] = [];
    for (let i = 0; i < 30; i++) {
      const res = await request(app)
        .post(`/api/dms/${dmChannelId}/pin`)
        .set('Authorization', authHeader(userB.token));
      if (res.status === 200) successesB.push(res.status);
    }

    expect(successesB.length).toBe(30);
  }, 30_000);
});
