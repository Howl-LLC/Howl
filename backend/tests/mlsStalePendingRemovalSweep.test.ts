// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { prisma } from '../src/db.js';
import { createTestUser, cleanupTestData, type TestUser } from './helpers.js';
import { sweepStalePendingRemovals } from '../src/queues/workers/cleanup.worker.js';

let owner: TestUser;
let leaver: TestUser;

beforeEach(async () => { await cleanupTestData(); owner = await createTestUser(); leaver = await createTestUser(); });
afterAll(cleanupTestData);

function fakeIo() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to } as any, to, emit };
}

describe('mls stale-pendingRemoval sweep', () => {
  it('re-fires dm-key-rotation-needed for a stuck removal and does NOT delete the row', async () => {
    const channel = await prisma.dMChannel.create({
      data: { isGroup: true, ownerId: owner.id, participants: { create: [{ userId: owner.id }, { userId: leaver.id, pendingRemoval: new Date(Date.now() - 60 * 60 * 1000) }] } },
      select: { id: true },
    });
    await prisma.mlsGroup.create({ data: { dmChannelId: channel.id, tier: 'saved', currentEpoch: 1n } });

    const { io, to, emit } = fakeIo();
    const swept = await sweepStalePendingRemovals(io, 30 * 60 * 1000); // older than 30 min

    expect(swept).toBeGreaterThanOrEqual(1);
    expect(to).toHaveBeenCalledWith(`user:${owner.id}`);
    expect(emit).toHaveBeenCalledWith('dm-key-rotation-needed', expect.objectContaining({ dmChannelId: channel.id, leaverId: leaver.id }));
    const row = await prisma.dMParticipant.findUnique({ where: { userId_dmChannelId: { userId: leaver.id, dmChannelId: channel.id } } });
    expect(row).not.toBeNull(); // sweep never deletes
  });

  it('prefers an ONLINE younger member over an OFFLINE absolute-oldest committer', async () => {
    // Three real members: an OLDEST (offline) owner, a YOUNGER (online) member,
    // and the leaver (pendingRemoval, 1h old). joinedAt is set explicitly so the
    // owner is unambiguously the absolute-oldest.
    const youngerOnline = await createTestUser();
    const oldestJoinedAt = new Date(Date.now() - 10_000);
    const youngerJoinedAt = new Date(Date.now() - 5_000);
    const channel = await prisma.dMChannel.create({
      data: {
        isGroup: true,
        ownerId: owner.id,
        participants: {
          create: [
            { userId: owner.id, joinedAt: oldestJoinedAt },
            { userId: youngerOnline.id, joinedAt: youngerJoinedAt },
            { userId: leaver.id, pendingRemoval: new Date(Date.now() - 60 * 60 * 1000) },
          ],
        },
      },
      select: { id: true },
    });
    await prisma.mlsGroup.create({ data: { dmChannelId: channel.id, tier: 'saved', currentEpoch: 1n } });

    const { io, emit } = fakeIo();
    // Inject a presence checker where ONLY the younger member is online.
    const swept = await sweepStalePendingRemovals(io, 30 * 60 * 1000, async (uid) => uid === youngerOnline.id);

    expect(swept).toBeGreaterThanOrEqual(1);
    // The election must target the ONLINE younger member, NOT the offline absolute-oldest owner.
    expect(emit).toHaveBeenCalledWith(
      'dm-key-rotation-needed',
      expect.objectContaining({
        dmChannelId: channel.id,
        leaverId: leaver.id,
        oldestMemberId: youngerOnline.id,
      }),
    );
  });

  it('ignores a FRESH pendingRemoval row (younger than the threshold)', async () => {
    const channel = await prisma.dMChannel.create({
      data: { isGroup: true, ownerId: owner.id, participants: { create: [{ userId: owner.id }, { userId: leaver.id, pendingRemoval: new Date() }] } },
      select: { id: true },
    });
    await prisma.mlsGroup.create({ data: { dmChannelId: channel.id, tier: 'saved', currentEpoch: 1n } });
    const { io, emit } = fakeIo();
    const swept = await sweepStalePendingRemovals(io, 30 * 60 * 1000);
    expect(swept).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });
});
