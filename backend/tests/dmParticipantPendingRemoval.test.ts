// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../src/db.js';
import { createTestUser, cleanupTestData, type TestUser } from './helpers.js';

let user: TestUser;

beforeEach(async () => {
  await cleanupTestData();
  user = await createTestUser();
});

afterAll(cleanupTestData);

describe('DMParticipant.pendingRemoval (additive column)', () => {
  it('defaults to null on a freshly-created participant', async () => {
    const channel = await prisma.dMChannel.create({ data: { isGroup: true } });
    await prisma.dMParticipant.create({
      data: { userId: user.id, dmChannelId: channel.id },
    });

    const row = await prisma.dMParticipant.findUnique({
      where: { userId_dmChannelId: { userId: user.id, dmChannelId: channel.id } },
    });
    expect(row).not.toBeNull();
    expect(row!.pendingRemoval).toBeNull();
  });

  it('can be set and cleared via the composite key', async () => {
    const channel = await prisma.dMChannel.create({ data: { isGroup: true } });
    await prisma.dMParticipant.create({
      data: { userId: user.id, dmChannelId: channel.id },
    });

    const stamp = new Date();
    await prisma.dMParticipant.update({
      where: { userId_dmChannelId: { userId: user.id, dmChannelId: channel.id } },
      data: { pendingRemoval: stamp },
    });
    const marked = await prisma.dMParticipant.findUnique({
      where: { userId_dmChannelId: { userId: user.id, dmChannelId: channel.id } },
    });
    expect(marked!.pendingRemoval?.getTime()).toBe(stamp.getTime());

    await prisma.dMParticipant.update({
      where: { userId_dmChannelId: { userId: user.id, dmChannelId: channel.id } },
      data: { pendingRemoval: null },
    });
    const cleared = await prisma.dMParticipant.findUnique({
      where: { userId_dmChannelId: { userId: user.id, dmChannelId: channel.id } },
    });
    expect(cleared!.pendingRemoval).toBeNull();
  });

  it('deleteMany of a marked participant filtered on pendingRemoval: { not: null } works (finalize shape)', async () => {
    const channel = await prisma.dMChannel.create({ data: { isGroup: true } });
    await prisma.dMParticipant.create({
      data: { userId: user.id, dmChannelId: channel.id, pendingRemoval: new Date() },
    });

    const { count } = await prisma.dMParticipant.deleteMany({
      where: { dmChannelId: channel.id, userId: { in: [user.id] }, pendingRemoval: { not: null } },
    });
    expect(count).toBe(1);
    const gone = await prisma.dMParticipant.findUnique({
      where: { userId_dmChannelId: { userId: user.id, dmChannelId: channel.id } },
    });
    expect(gone).toBeNull();
  });
});
