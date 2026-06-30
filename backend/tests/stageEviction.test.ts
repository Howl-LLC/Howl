// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// A server ban/kick/timeout must disconnect the user from the stage
// LiveKit SFU room (`stage:${channelId}`), not just their voice channel — a
// cached LiveKit JWT (≤15m TTL) otherwise lets a banned speaker keep publishing.
//
// Spy on the SFU eject only; everything else in livekitAdmin stays real (the
// real removeLiveKitParticipant silently no-ops without LiveKit creds, so the
// spy is what lets us assert the exact room name + identity). Mirrors
// tests/dmGroupKickMls.test.ts.
vi.mock('../src/services/livekitAdmin.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/services/livekitAdmin.js')>();
  return { ...mod, removeLiveKitParticipant: vi.fn(async () => {}) };
});

import { removeLiveKitParticipant } from '../src/services/livekitAdmin.js';
import { evictUserFromServerStages } from '../src/services/stageEviction.js';
import { addToSet, isInSet } from '../src/routes/stages.js';
import { createTestUser, createTestServer, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';

// Minimal Socket.IO stub: every io.to(room).emit(event, payload) is captured.
function makeIo() {
  const emit = vi.fn();
  const io = { to: vi.fn(() => ({ emit })) };
  return { io: io as unknown as import('socket.io').Server, emit };
}

async function createStageChannel(serverId: string): Promise<string> {
  const cat = await prisma.channelCategory.findFirst({ where: { serverId } });
  const maxPos = await prisma.channel.aggregate({
    where: { serverId, categoryId: cat?.id ?? null }, _max: { position: true },
  });
  const ch = await prisma.channel.create({
    data: {
      id: randomUUID(),
      name: `stage-${Date.now()}-${Math.floor(performance.now())}`,
      type: 'stage',
      serverId,
      categoryId: cat?.id ?? null,
      position: (maxPos._max.position ?? -1) + 1,
    },
  });
  return ch.id;
}

describe('evictUserFromServerStages drops banned/kicked users from the stage SFU', () => {
  let owner: TestUser;
  let victim: TestUser;
  let other: TestUser;
  let serverId: string;

  beforeAll(async () => {
    owner = await createTestUser();
    victim = await createTestUser();
    other = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
  });

  afterAll(async () => {
    await prisma.channel.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('disconnects an evicted stage SPEAKER from the LiveKit stage room', async () => {
    const stageCh = await createStageChannel(serverId);
    await addToSet(stageCh, 'speakers', victim.id);
    await addToSet(stageCh, 'speakers', other.id); // a speaker remains so the stage isn't auto-ended
    vi.mocked(removeLiveKitParticipant).mockClear();

    const { io } = makeIo();
    await evictUserFromServerStages(io, victim.id, serverId);

    expect(removeLiveKitParticipant).toHaveBeenCalledWith(`stage:${stageCh}`, victim.id);
  });

  it('removes the evicted speaker from the stage speakers set, leaving others untouched', async () => {
    const stageCh = await createStageChannel(serverId);
    await addToSet(stageCh, 'speakers', victim.id);
    await addToSet(stageCh, 'speakers', other.id);

    const { io } = makeIo();
    await evictUserFromServerStages(io, victim.id, serverId);

    expect(await isInSet(stageCh, 'speakers', victim.id)).toBe(false);
    expect(await isInSet(stageCh, 'speakers', other.id)).toBe(true);
  });

  it('also drops an evicted AUDIENCE member from the stage room and set', async () => {
    const stageCh = await createStageChannel(serverId);
    await addToSet(stageCh, 'audience', victim.id);
    await addToSet(stageCh, 'speakers', other.id);
    vi.mocked(removeLiveKitParticipant).mockClear();

    const { io } = makeIo();
    await evictUserFromServerStages(io, victim.id, serverId);

    expect(removeLiveKitParticipant).toHaveBeenCalledWith(`stage:${stageCh}`, victim.id);
    expect(await isInSet(stageCh, 'audience', victim.id)).toBe(false);
  });

  it('does NOT touch the SFU for a user who is not in any stage', async () => {
    const stageCh = await createStageChannel(serverId);
    await addToSet(stageCh, 'speakers', other.id);
    vi.mocked(removeLiveKitParticipant).mockClear();

    const { io } = makeIo();
    await evictUserFromServerStages(io, victim.id, serverId);

    expect(removeLiveKitParticipant).not.toHaveBeenCalled();
  });
});
