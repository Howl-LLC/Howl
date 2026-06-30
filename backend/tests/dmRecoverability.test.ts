// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { computeServerReadable } from '../src/routes/dms.js';

const base = {
  isGroup: false,
  selfUserId: 'me',
  peerUserIds: ['peer'],
  escrowCapable: new Set<string>(),
  masterKeyConfigured: true,
};

describe('computeServerReadable (pure helper)', () => {
  it('both Self (no escrow) → false', () => {
    expect(computeServerReadable({ ...base, channelEncrypted: true })).toBe(false);
  });
  it('self escrowed → true', () => {
    expect(computeServerReadable({ ...base, channelEncrypted: true, escrowCapable: new Set(['me']) })).toBe(true);
  });
  it('peer escrowed → true', () => {
    expect(computeServerReadable({ ...base, channelEncrypted: true, escrowCapable: new Set(['peer']) })).toBe(true);
  });
  it('legacy non-E2E DM → true regardless of custody', () => {
    expect(computeServerReadable({ ...base, channelEncrypted: false })).toBe(true);
  });
  it('master key not configured → false (escrow unusable)', () => {
    expect(computeServerReadable({ ...base, channelEncrypted: true, escrowCapable: new Set(['peer']), masterKeyConfigured: false })).toBe(false);
  });
  it('master key not configured but legacy → still true', () => {
    expect(computeServerReadable({ ...base, channelEncrypted: false, masterKeyConfigured: false })).toBe(true);
  });
  it('group DM → undefined (out of scope)', () => {
    expect(computeServerReadable({ ...base, channelEncrypted: true, isGroup: true })).toBe(undefined);
  });
});

import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, authHeader, cleanupTestData } from './helpers.js';
import { afterAll } from 'vitest';

async function createDmChannel(userIds: string[], isGroup = false, encrypted = true): Promise<string> {
  const channel = await prisma.dMChannel.create({
    data: {
      isGroup,
      encrypted,
      ...(isGroup ? { ownerId: userIds[0] } : {}),
      participants: { create: userIds.map((userId) => ({ userId })) },
    },
    select: { id: true },
  });
  return channel.id;
}

async function seedEscrowedBundle(userId: string): Promise<void> {
  await prisma.dmKeyBundle.create({
    data: {
      userId,
      publicKey: 'AA==',
      encryptedBlob: 'AA==',
      blobSalt: 'AA==',
      recoveryBlob: 'AA==',
      recoveryNonce: 'AA==',
      passwordDerived: true,
      serverEscrowBlob: 'AA==',
    },
  });
}

afterAll(async () => {
  await prisma.dmKeyBundle.deleteMany({});
  await cleanupTestData();
});

describe('GET /api/dms - serverReadable', () => {
  it('serverReadable=true when the peer is on Server recovery', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await seedEscrowedBundle(b.id);
    const channelId = await createDmChannel([a.id, b.id]);
    const res = await request(app).get('/api/dms').set('Authorization', authHeader(a.token));
    expect(res.status).toBe(200);
    const entry = (res.body as Array<{ id: string; serverReadable?: boolean }>).find((d) => d.id === channelId);
    expect(entry?.serverReadable).toBe(true);
  });

  it('serverReadable=false when both are on Self recovery', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const channelId = await createDmChannel([a.id, b.id]);
    const res = await request(app).get('/api/dms').set('Authorization', authHeader(a.token));
    const entry = (res.body as Array<{ id: string; serverReadable?: boolean }>).find((d) => d.id === channelId);
    expect(entry?.serverReadable).toBe(false);
  });

  it('omits serverReadable for group DMs', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const c = await createTestUser();
    const channelId = await createDmChannel([a.id, b.id, c.id], true);
    const res = await request(app).get('/api/dms').set('Authorization', authHeader(a.token));
    const entry = (res.body as Array<{ id: string; serverReadable?: boolean }>).find((d) => d.id === channelId);
    expect(entry).toBeTruthy();
    expect(entry?.serverReadable).toBeUndefined();
  });
});

describe('POST /api/dms - serverReadable', () => {
  it('serverReadable=true when the other user is on Server recovery', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await seedEscrowedBundle(b.id);
    const res = await request(app)
      .post('/api/v1/dms')
      .set('Authorization', authHeader(a.token))
      .send({ otherUserId: b.id });
    expect([200, 201]).toContain(res.status);
    expect(res.body.serverReadable).toBe(true);
  });

  it('serverReadable=false when both are on Self recovery', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const res = await request(app)
      .post('/api/v1/dms')
      .set('Authorization', authHeader(a.token))
      .send({ otherUserId: b.id });
    expect([200, 201]).toContain(res.status);
    expect(res.body.serverReadable).toBe(false);
  });
});
