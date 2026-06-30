// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Completeness: the scheduled cleanup job that
 * purges expired TEMPORARY server members is an INVOLUNTARY removal of a live
 * member (same class as a kick). If that member is sitting in a server voice
 * channel when their membership expires, the remaining members must get a fresh
 * SFrame key (forward secrecy) and the purged member must be dropped from the
 * SFU — mirroring the kick/ban/timeout REST paths.
 *
 * `scheduleVoiceE2eeRotate` and `removeLiveKitParticipant` are mocked to spies;
 * their behaviour is covered elsewhere. Here we assert the worker wires them.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

vi.mock('../src/services/voiceE2eeRotation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/voiceE2eeRotation.js')>();
  return { ...actual, scheduleVoiceE2eeRotate: vi.fn() };
});
vi.mock('../src/services/livekitAdmin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/livekitAdmin.js')>();
  return { ...actual, removeLiveKitParticipant: vi.fn().mockResolvedValue(undefined) };
});

import { prisma } from '../src/db.js';
import { addVoiceParticipant, setVoiceReverseLookup } from '../src/redis.js';
import { scheduleVoiceE2eeRotate } from '../src/services/voiceE2eeRotation.js';
import { removeLiveKitParticipant } from '../src/services/livekitAdmin.js';
import { setCleanupIO, purgeExpiredTemporaryMembers } from '../src/queues/workers/cleanup.worker.js';
import { createTestUser, createTestServer, cleanupTestData } from './helpers.js';

const scheduleSpy = vi.mocked(scheduleVoiceE2eeRotate);
const ejectSpy = vi.mocked(removeLiveKitParticipant);

function fakeIo() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to } as never, to, emit };
}

beforeEach(async () => { await cleanupTestData(); scheduleSpy.mockClear(); ejectSpy.mockClear(); });
afterAll(cleanupTestData);

describe('expired temporary-member purge rotates the voice key', () => {
  it('rotates + SFU-ejects a purged temp member who is still in a voice channel', async () => {
    const owner = await createTestUser();
    const tempMember = await createTestUser();
    const remaining = await createTestUser();
    const server = await createTestServer(owner.id);

    // Expired temporary member (roleId null, temporaryExpiresAt in the past).
    await prisma.serverMember.create({
      data: {
        serverId: server.id, userId: tempMember.id, role: 'member',
        temporaryExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.serverMember.create({ data: { serverId: server.id, userId: remaining.id, role: 'member' } });

    const vc = await prisma.channel.create({ data: { serverId: server.id, name: 'voice', type: 'voice', position: 1 } });
    await addVoiceParticipant(vc.id, tempMember.id, { username: tempMember.username, joinedAt: 2000 } as never);
    await setVoiceReverseLookup(tempMember.id, vc.id);
    await addVoiceParticipant(vc.id, remaining.id, { username: remaining.username, joinedAt: 1000 } as never);
    await setVoiceReverseLookup(remaining.id, vc.id);

    const { io } = fakeIo();
    setCleanupIO(io);

    const purged = await purgeExpiredTemporaryMembers();
    expect(purged).toBe(1);

    // The temp member's membership row is gone.
    const row = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: tempMember.id, serverId: server.id } },
    });
    expect(row).toBeNull();

    // Forward-secrecy rotate for the remaining member + SFU eject of the purged one.
    const call = scheduleSpy.mock.calls.find((c) => c[1] === vc.id);
    expect(call).toBeTruthy();
    expect(call![2]).toBe(true); // a member still remains in the voice channel
    expect(ejectSpy).toHaveBeenCalledWith(`voice:${vc.id}`, tempMember.id);
  });

  it('does not rotate when the purged temp member was not in any voice channel', async () => {
    const owner = await createTestUser();
    const tempMember = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverMember.create({
      data: {
        serverId: server.id, userId: tempMember.id, role: 'member',
        temporaryExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    const { io } = fakeIo();
    setCleanupIO(io);

    const purged = await purgeExpiredTemporaryMembers();
    expect(purged).toBe(1);
    expect(scheduleSpy).not.toHaveBeenCalled();
  });
});
