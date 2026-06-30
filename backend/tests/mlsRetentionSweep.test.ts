// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * MLS persistence retention reapers.
 *
 * Before this sweep nothing ever deleted consumed/expired MlsKeyPackage rows
 * (consume only tombstones consumedAt; the pool cap counts only AVAILABLE rows)
 * or stale/orphaned MlsWelcome rows (GET /welcomes is non-destructive; the
 * DMChannel->MlsGroup delete cascade does NOT reach MlsWelcome because groupId
 * has no FK). These sweeps bound that growth and drop welcomes whose group no
 * longer exists — without a schema migration (reaper-only).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../src/db.js';
import { createTestUser, cleanupTestData, type TestUser } from './helpers.js';
import { sweepExpiredKeyPackages, sweepStaleWelcomes } from '../src/queues/workers/cleanup.worker.js';

let user: TestUser;
const bytes = (n: number) => new Uint8Array([n, n, n]);
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);
const daysAhead = (d: number) => new Date(Date.now() + d * 24 * 60 * 60 * 1000);

beforeEach(async () => { await cleanupTestData(); user = await createTestUser(); });
afterAll(cleanupTestData);

async function kp(opts: { ref: string; isLastResort?: boolean; notAfter: Date; consumedAt?: Date | null; createdAt?: Date }) {
  return prisma.mlsKeyPackage.create({
    data: {
      userId: user.id, deviceId: 'dev-1', keyPackageRef: opts.ref, keyPackage: bytes(1),
      isLastResort: opts.isLastResort ?? false, notAfter: opts.notAfter,
      consumedAt: opts.consumedAt ?? null, createdAt: opts.createdAt ?? new Date(),
    },
    select: { id: true },
  });
}

async function liveGroup(): Promise<string> {
  const ch = await prisma.dMChannel.create({ data: { isGroup: true, ownerId: user.id }, select: { id: true } });
  const g = await prisma.mlsGroup.create({ data: { dmChannelId: ch.id, tier: 'saved', currentEpoch: 1n }, select: { id: true } });
  return g.id;
}

async function welcome(opts: { groupId: string; epoch: bigint; createdAt?: Date }) {
  return prisma.mlsWelcome.create({
    data: { recipientId: user.id, groupId: opts.groupId, epoch: opts.epoch, welcomeData: bytes(2), createdAt: opts.createdAt ?? new Date() },
    select: { id: true },
  });
}

describe('MLS KeyPackage retention reaper', () => {
  it('deletes consumed + naturally-expired packages but preserves last-resort, live, and recent-consumed', async () => {
    const consumedOld = await kp({ ref: 'a', notAfter: daysAhead(30), consumedAt: daysAgo(10) }); // delete
    const expiredOld = await kp({ ref: 'b', notAfter: daysAgo(10) });                              // delete
    const live = await kp({ ref: 'c', notAfter: daysAhead(30) });                                  // keep
    const lastResort = await kp({ ref: 'd', isLastResort: true, notAfter: daysAgo(10) });          // keep (reusable)
    const recentConsumed = await kp({ ref: 'e', notAfter: daysAhead(30), consumedAt: daysAgo(1) });// keep (within grace)

    const count = await sweepExpiredKeyPackages();
    expect(count).toBe(2);

    const survivors = await prisma.mlsKeyPackage.findMany({ select: { id: true } });
    const ids = survivors.map((r) => r.id).sort();
    expect(ids).toEqual([live.id, lastResort.id, recentConsumed.id].sort());
    expect(ids).not.toContain(consumedOld.id);
    expect(ids).not.toContain(expiredOld.id);
  });

  it('is a no-op on an empty table', async () => {
    expect(await sweepExpiredKeyPackages()).toBe(0);
  });
});

describe('MLS Welcome retention reaper', () => {
  it('deletes welcomes older than the delivery TTL, preserves recent ones', async () => {
    const groupId = await liveGroup();
    const old = await welcome({ groupId, epoch: 1n, createdAt: daysAgo(20) }); // delete (TTL)
    const recent = await welcome({ groupId, epoch: 2n, createdAt: daysAgo(1) }); // keep

    const { byTtl } = await sweepStaleWelcomes();
    expect(byTtl).toBeGreaterThanOrEqual(1);

    const survivors = await prisma.mlsWelcome.findMany({ select: { id: true } });
    const ids = survivors.map((r) => r.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(old.id);
  });

  it('deletes orphan welcomes whose groupId has no live MlsGroup, even when recent', async () => {
    const groupId = await liveGroup();
    const resolvable = await welcome({ groupId, epoch: 1n, createdAt: daysAgo(1) }); // keep
    const orphan = await welcome({ groupId: '00000000-0000-0000-0000-0000000000ff', epoch: 1n, createdAt: daysAgo(1) }); // delete (orphan)

    const { orphaned } = await sweepStaleWelcomes();
    expect(orphaned).toBeGreaterThanOrEqual(1);

    const survivors = await prisma.mlsWelcome.findMany({ select: { id: true } });
    const ids = survivors.map((r) => r.id);
    expect(ids).toContain(resolvable.id);
    expect(ids).not.toContain(orphan.id);
  });

  it('does NOT delete a valid pending Welcome whose epoch is ahead of the group currentEpoch', async () => {
    const groupId = await liveGroup(); // currentEpoch 1n
    const pendingAhead = await welcome({ groupId, epoch: 99n, createdAt: daysAgo(1) }); // keep (resolves on groupId only)

    await sweepStaleWelcomes();

    const survivors = await prisma.mlsWelcome.findMany({ select: { id: true } });
    expect(survivors.map((r) => r.id)).toContain(pendingAhead.id);
  });

  it('is a no-op on an empty table', async () => {
    expect(await sweepStaleWelcomes()).toEqual({ byTtl: 0, orphaned: 0 });
  });
});
