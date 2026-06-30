// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { electOldestRemaining } from '../src/routes/dms.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';

// Seed an encrypted group DM directly (bypasses key-bundle setup the create
// endpoint requires). owner joined first, then each member in order. When
// mls=true also create the saved-tier MlsGroup row — the ONLY server MLS signal.
async function seedGroup(ownerId: string, memberIds: string[], mls: boolean) {
  const channel = await prisma.dMChannel.create({
    data: { isGroup: true, encrypted: true, ownerId },
  });
  let t = Date.now();
  await prisma.dMParticipant.create({ data: { userId: ownerId, dmChannelId: channel.id, joinedAt: new Date(t++) } });
  for (const uid of memberIds) {
    await prisma.dMParticipant.create({ data: { userId: uid, dmChannelId: channel.id, joinedAt: new Date(t++) } });
  }
  if (mls) {
    await prisma.mlsGroup.create({ data: { dmChannelId: channel.id, tier: 'saved' } });
  }
  return channel;
}

let owner: TestUser, m1: TestUser, m2: TestUser;

beforeEach(async () => {
  await cleanupTestData();
  owner = await createTestUser();
  m1 = await createTestUser();
  m2 = await createTestUser();
});

afterAll(cleanupTestData);

describe('POST /api/v1/dms/:dmChannelId/leave — MLS two-phase self-leave', () => {
  it('MLS group: leave marks the leaver pendingRemoval (row survives), channel NOT torn down', async () => {
    const ch = await seedGroup(owner.id, [m1.id, m2.id], true); // owner, m1, m2 all remain real
    const res = await request(app)
      .post(`/api/v1/dms/${ch.id}/leave`)
      .set('Authorization', authHeader(m2.token));
    expect(res.status).toBe(204);

    const still = await prisma.dMParticipant.findUnique({
      where: { userId_dmChannelId: { userId: m2.id, dmChannelId: ch.id } },
    });
    expect(still).not.toBeNull();
    expect(still!.pendingRemoval).not.toBeNull();

    const channelStill = await prisma.dMChannel.findUnique({ where: { id: ch.id } });
    expect(channelStill).not.toBeNull();
  });

  it('MLS group: owner leaving transfers ownership to the oldest NON-pendingRemoval member', async () => {
    // owner oldest, then m1, then m2. m1 is already pendingRemoval, so the oldest
    // REAL remaining member is m2 — transfer must skip the marked m1.
    const ch = await seedGroup(owner.id, [m1.id, m2.id], true);
    await prisma.dMParticipant.update({
      where: { userId_dmChannelId: { userId: m1.id, dmChannelId: ch.id } },
      data: { pendingRemoval: new Date() },
    });

    const res = await request(app)
      .post(`/api/v1/dms/${ch.id}/leave`)
      .set('Authorization', authHeader(owner.token));
    expect(res.status).toBe(204);

    const after = await prisma.dMChannel.findUnique({ where: { id: ch.id }, select: { ownerId: true } });
    expect(after?.ownerId).toBe(m2.id);
  });

  it('MLS group: leave emits dm-key-rotation-needed carrying the EXPLICIT leaverId (post-splice fix)', async () => {
    // owner oldest, then m1, then m2. m2 leaves; owner is the elected oldest-remaining
    // committer. The repurposed election MUST carry leaverId = the leaver (m2) so the
    // elected member targets the right leaf — the local roster is mutated by
    // dm-participant-left before the election fires, so the server is authoritative.
    const ch = await seedGroup(owner.id, [m1.id, m2.id], true);

    const io = app.get('io') as import('socket.io').Server;
    const rotationPayloads: Array<Record<string, unknown>> = [];
    const origTo = io.to.bind(io);
    io.to = ((room: string) => {
      const emitter = origTo(room);
      const origEmit = emitter.emit.bind(emitter);
      emitter.emit = ((event: string, ...args: unknown[]) => {
        if (event === 'dm-key-rotation-needed') rotationPayloads.push(args[0] as Record<string, unknown>);
        return origEmit(event, ...args);
      }) as typeof emitter.emit;
      return emitter;
    }) as typeof io.to;

    try {
      const res = await request(app)
        .post(`/api/v1/dms/${ch.id}/leave`)
        .set('Authorization', authHeader(m2.token));
      expect(res.status).toBe(204);
    } finally {
      io.to = origTo as typeof io.to;
    }

    expect(rotationPayloads.length).toBeGreaterThan(0);
    for (const p of rotationPayloads) {
      expect(p.leaverId).toBe(m2.id);
      // leaverId is the departed member, NOT a remaining member nor the elected committer.
      expect(p.memberIds).not.toContain(m2.id);
      expect(p.oldestMemberId).toBe(owner.id);
    }
  });

});

describe('electOldestRemaining (pure helper)', () => {
  const d = (n: number) => new Date(n);

  it('elects the oldest member when all are connected', () => {
    const entries = [
      { userId: 'leaver', joinedAt: d(1), pendingRemoval: null },
      { userId: 'm1', joinedAt: d(2), pendingRemoval: null },
      { userId: 'm2', joinedAt: d(3), pendingRemoval: null },
    ];
    const result = electOldestRemaining(entries, 'leaver', new Set(['m1', 'm2']));
    expect(result).toEqual({ oldestMemberId: 'm1', memberIds: ['m1', 'm2'] });
  });

  it('prefers the oldest ONLINE member when the absolute-oldest is offline', () => {
    const entries = [
      { userId: 'leaver', joinedAt: d(1), pendingRemoval: null },
      { userId: 'oldOffline', joinedAt: d(2), pendingRemoval: null },
      { userId: 'youngOnline', joinedAt: d(3), pendingRemoval: null },
    ];
    const result = electOldestRemaining(entries, 'leaver', new Set(['youngOnline']));
    expect(result).toEqual({ oldestMemberId: 'youngOnline', memberIds: ['oldOffline', 'youngOnline'] });
  });

  it('falls back to the absolute oldest when NO real member is connected', () => {
    const entries = [
      { userId: 'leaver', joinedAt: d(1), pendingRemoval: null },
      { userId: 'oldOffline', joinedAt: d(2), pendingRemoval: null },
      { userId: 'youngOffline', joinedAt: d(3), pendingRemoval: null },
    ];
    const result = electOldestRemaining(entries, 'leaver', new Set());
    expect(result).toEqual({ oldestMemberId: 'oldOffline', memberIds: ['oldOffline', 'youngOffline'] });
  });

  it('returns null when only the leaver remains (no real member)', () => {
    const entries = [{ userId: 'leaver', joinedAt: d(1), pendingRemoval: null }];
    const result = electOldestRemaining(entries, 'leaver', new Set());
    expect(result).toBeNull();
  });
});
