// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/db.js';
import { createTestUser, cleanupTestData, type TestUser } from '../helpers.js';

let user: TestUser;
let dmChannelId: string;

beforeAll(async () => {
  user = await createTestUser();
  const channel = await prisma.dMChannel.create({
    data: { participants: { create: [{ userId: user.id }] } },
    select: { id: true },
  });
  dmChannelId = channel.id;
});

afterAll(async () => {
  await prisma.mlsWelcome.deleteMany({});
  await prisma.mlsCommit.deleteMany({});
  await prisma.mlsKeyPackage.deleteMany({});
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
});

describe('MLS Prisma models', () => {
  it('round-trips Bytes and BigInt on MlsGroup', async () => {
    const groupInfo = Buffer.from([1, 2, 3, 255, 0, 128]);
    const group = await prisma.mlsGroup.create({
      data: {
        dmChannelId,
        tier: 'saved',
        cipherSuite: 83,
        currentEpoch: 0n,
        groupInfo,
        groupInfoEpoch: 0n,
      },
    });
    expect(group.currentEpoch).toBe(0n);
    const read = await prisma.mlsGroup.findUnique({ where: { id: group.id } });
    expect(read?.groupInfo).toEqual(new Uint8Array([1, 2, 3, 255, 0, 128]));
    expect(typeof read?.currentEpoch).toBe('bigint');
  });

  it('enforces @@unique([dmChannelId, tier]) (create-once)', async () => {
    await expect(
      prisma.mlsGroup.create({ data: { dmChannelId, tier: 'saved', currentEpoch: 0n } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('defaults cipherSuite to the X-Wing codepoint 83', async () => {
    // distinct tier avoids the @@unique([dmChannelId, tier]) collision with the
    // 'saved' group created above; cipherSuite is omitted so the DB default is exercised.
    const group2 = await prisma.mlsGroup.create({
      data: { dmChannelId, tier: 'otr', currentEpoch: 0n },
    });
    expect(group2.cipherSuite).toBe(83);
  });

  it('enforces @@unique([groupId, epoch]) on MlsCommit', async () => {
    const group = await prisma.mlsGroup.findFirst({ where: { dmChannelId } });
    const base = { groupId: group!.id, commitData: Buffer.from([9]), epoch: 5n };
    await prisma.mlsCommit.create({ data: { ...base, idempotencyKey: randomUUID() } });
    await expect(
      prisma.mlsCommit.create({ data: { ...base, idempotencyKey: randomUUID() } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('cascades MLS rows when the DMChannel is deleted', async () => {
    await prisma.dMChannel.delete({ where: { id: dmChannelId } });
    expect(await prisma.mlsGroup.count({ where: { dmChannelId } })).toBe(0);
    // recreate for afterAll symmetry is unnecessary; cleanupTestData handles the rest.
  });
});
