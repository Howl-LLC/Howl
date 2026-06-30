// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * The DM channel list serializer surfaces an additive `mlsGroupId` field by
 * joining the saved-tier MlsGroup row on dmChannelId. It is `null` when no
 * group exists and the group id string when one does. The field is a
 * Welcome→channel mapping convenience only; it cannot drive protocol selection.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';

let userA: TestUser;
let userB: TestUser;
let plainChannelId: string;
let mlsChannelId: string;
let mlsGroupId: string;

beforeAll(async () => {
  userA = await createTestUser();
  userB = await createTestUser();

  const plain = await prisma.dMChannel.create({
    data: { encrypted: true, participants: { create: [{ userId: userA.id }, { userId: userB.id }] } },
    select: { id: true },
  });
  plainChannelId = plain.id;

  const withGroup = await prisma.dMChannel.create({
    data: { encrypted: true, participants: { create: [{ userId: userA.id }, { userId: userB.id }] } },
    select: { id: true },
  });
  mlsChannelId = withGroup.id;
  const group = await prisma.mlsGroup.create({
    data: { dmChannelId: mlsChannelId, tier: 'saved' },
    select: { id: true },
  });
  mlsGroupId = group.id;
});

afterAll(async () => {
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
});

describe('GET /api/dms — additive mlsGroupId on DM channel payload', () => {
  it('includes mlsGroupId=null when the channel has no saved MLS group', async () => {
    const res = await request(app)
      .get('/api/dms')
      .set('Authorization', authHeader(userA.token));
    expect(res.status).toBe(200);
    const entry = (res.body as Array<{ id: string; mlsGroupId: string | null }>).find(d => d.id === plainChannelId);
    expect(entry).toBeTruthy();
    expect(entry!.mlsGroupId).toBeNull();
  });

  it('includes mlsGroupId=<groupId> when a saved MLS group exists for the channel', async () => {
    const res = await request(app)
      .get('/api/dms')
      .set('Authorization', authHeader(userA.token));
    expect(res.status).toBe(200);
    const entry = (res.body as Array<{ id: string; mlsGroupId: string | null }>).find(d => d.id === mlsChannelId);
    expect(entry).toBeTruthy();
    expect(entry!.mlsGroupId).toBe(mlsGroupId);
  });
});
