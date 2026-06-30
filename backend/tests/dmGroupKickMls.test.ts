// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';

// Spy on the SFU eject only; everything else in livekitAdmin stays real
// (the real removeLiveKitParticipant silently no-ops without LiveKit creds,
// so this mock changes observability, not behavior).
vi.mock('../src/services/livekitAdmin.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/services/livekitAdmin.js')>();
  return { ...mod, removeLiveKitParticipant: vi.fn(async () => {}) };
});

import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { removeLiveKitParticipant } from '../src/services/livekitAdmin.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';

// owner joined first, then each member in order.
async function seedGroup(ownerId: string, memberIds: string[]) {
  const channel = await prisma.dMChannel.create({
    data: { isGroup: true, encrypted: true, ownerId },
  });
  let t = Date.now();
  await prisma.dMParticipant.create({ data: { userId: ownerId, dmChannelId: channel.id, joinedAt: new Date(t++) } });
  for (const uid of memberIds) {
    await prisma.dMParticipant.create({ data: { userId: uid, dmChannelId: channel.id, joinedAt: new Date(t++) } });
  }
  return channel;
}

// Mark a channel as MLS by creating its saved-tier group row (the ONLY server MLS signal).
async function seedMlsGroup(dmChannelId: string) {
  return prisma.mlsGroup.create({ data: { dmChannelId, tier: 'saved' } });
}

let owner: TestUser, m1: TestUser, m2: TestUser;

beforeEach(async () => {
  await cleanupTestData();
  owner = await createTestUser();
  m1 = await createTestUser();
  m2 = await createTestUser();
});

afterAll(cleanupTestData);

describe('DELETE /api/v1/dms/:dmChannelId/members/:targetUserId — MLS two-phase kick', () => {
  it('MLS group: owner kick marks pendingRemoval, participant row survives', async () => {
    const ch = await seedGroup(owner.id, [m1.id, m2.id]);
    await seedMlsGroup(ch.id);

    const res = await request(app)
      .delete(`/api/v1/dms/${ch.id}/members/${m2.id}`)
      .set('Authorization', authHeader(owner.token));
    expect(res.status).toBe(200);

    const still = await prisma.dMParticipant.findUnique({
      where: { userId_dmChannelId: { userId: m2.id, dmChannelId: ch.id } },
    });
    expect(still).not.toBeNull();
    expect(still!.pendingRemoval).not.toBeNull();
  });

  it('MLS group: owner-only and self-kick guards still hold', async () => {
    const ch = await seedGroup(owner.id, [m1.id, m2.id]);
    await seedMlsGroup(ch.id);

    const nonOwner = await request(app)
      .delete(`/api/v1/dms/${ch.id}/members/${m2.id}`)
      .set('Authorization', authHeader(m1.token));
    expect(nonOwner.status).toBe(403);

    const selfKick = await request(app)
      .delete(`/api/v1/dms/${ch.id}/members/${owner.id}`)
      .set('Authorization', authHeader(owner.token));
    expect(selfKick.status).toBe(403);

    // target untouched after the rejected non-owner kick (no pendingRemoval set)
    const still = await prisma.dMParticipant.findUnique({
      where: { userId_dmChannelId: { userId: m2.id, dmChannelId: ch.id } },
    });
    expect(still!.pendingRemoval).toBeNull();
  });

  it('MLS group: legacy dm-key-rotation-needed is suppressed on kick', async () => {
    const ch = await seedGroup(owner.id, [m1.id, m2.id]);
    await seedMlsGroup(ch.id);

    const io = app.get('io') as import('socket.io').Server;
    const events: string[] = [];
    const origTo = io.to.bind(io);
    io.to = ((room: string) => {
      const emitter = origTo(room);
      const origEmit = emitter.emit.bind(emitter);
      emitter.emit = ((event: string, ...args: unknown[]) => {
        events.push(event);
        return origEmit(event, ...args);
      }) as typeof emitter.emit;
      return emitter;
    }) as typeof io.to;

    try {
      const res = await request(app)
        .delete(`/api/v1/dms/${ch.id}/members/${m2.id}`)
        .set('Authorization', authHeader(owner.token));
      expect(res.status).toBe(200);
    } finally {
      io.to = origTo as typeof io.to;
    }

    expect(events).not.toContain('dm-key-rotation-needed');
  });

  it('MLS group: kick hard-ejects the target from the LiveKit dm-call room (SFU backstop)', async () => {
    const ch = await seedGroup(owner.id, [m1.id, m2.id]);
    await seedMlsGroup(ch.id);
    vi.mocked(removeLiveKitParticipant).mockClear();

    const res = await request(app)
      .delete(`/api/v1/dms/${ch.id}/members/${m2.id}`)
      .set('Authorization', authHeader(owner.token));
    expect(res.status).toBe(200);

    expect(removeLiveKitParticipant).toHaveBeenCalledWith(`dm-call:${ch.id}`, m2.id);
  });

  it('legacy group: kick hard-ejects the target from the LiveKit dm-call room too', async () => {
    const ch = await seedGroup(owner.id, [m1.id, m2.id]);
    vi.mocked(removeLiveKitParticipant).mockClear();

    const res = await request(app)
      .delete(`/api/v1/dms/${ch.id}/members/${m2.id}`)
      .set('Authorization', authHeader(owner.token));
    expect(res.status).toBe(200);

    expect(removeLiveKitParticipant).toHaveBeenCalledWith(`dm-call:${ch.id}`, m2.id);
  });

  it('rejected kick (non-owner) does not touch the SFU', async () => {
    const ch = await seedGroup(owner.id, [m1.id, m2.id]);
    await seedMlsGroup(ch.id);
    vi.mocked(removeLiveKitParticipant).mockClear();

    const res = await request(app)
      .delete(`/api/v1/dms/${ch.id}/members/${m2.id}`)
      .set('Authorization', authHeader(m1.token));
    expect(res.status).toBe(403);

    expect(removeLiveKitParticipant).not.toHaveBeenCalled();
  });
});
