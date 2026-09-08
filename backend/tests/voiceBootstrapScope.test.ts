// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * the voice-roster (re)connect bootstrap.
 *
 * On every socket (re)connect, `emitServersInitialState` sent the
 * `server-voice-participants-initial` snapshot for EVERY active voice channel in
 * the server with NO per-channel visibility filter, re-leaking a PRIVATE voice
 * channel's occupant roster to a non-viewer on reconnect. This locks the fix:
 * the snapshot is filtered to the connecting user's viewChannels-visible voice
 * channels (public always included; private only via the override chain).
 *
 * `getVoiceParticipantsBatch` (Redis) is stubbed so every voice channel appears
 * occupied and the test exercises the NEW visibility filter, not Redis seeding —
 * mirrors tests/stageBootstrapScope.test.ts's targeted mock.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../src/redis.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/redis.js')>();
  return {
    ...mod,
    getVoiceParticipantsBatch: vi.fn(async (ids: string[]) =>
      new Map(ids.map((id) => [id, [{ userId: 'seed', username: 'seed' }]])),
    ),
  };
});

import { emitServersInitialState } from '../src/socketHandlers/channels.js';
import { createTestUser, createTestServer, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';

async function makeEveryoneRole(serverId: string, permissions: Record<string, boolean>): Promise<string> {
  const role = await prisma.serverRole.create({
    data: { id: randomUUID(), serverId, name: '@everyone', position: 0, isEveryone: true, permissions },
  });
  return role.id;
}
async function makeRole(serverId: string, name: string, permissions: Record<string, boolean>): Promise<string> {
  const role = await prisma.serverRole.create({
    data: { id: randomUUID(), serverId, name, position: 1, isEveryone: false, permissions },
  });
  return role.id;
}
async function addMember(serverId: string, roleIds: string[] = []): Promise<TestUser> {
  const u = await createTestUser();
  await prisma.serverMember.create({ data: { userId: u.id, serverId, role: 'member' } });
  for (const roleId of roleIds) await prisma.memberRole.create({ data: { userId: u.id, serverId, roleId } });
  return u;
}
async function makeVoiceChannel(serverId: string, categoryId: string | null, isPrivate: boolean): Promise<string> {
  const maxPos = await prisma.channel.aggregate({ where: { serverId, categoryId }, _max: { position: true } });
  const ch = await prisma.channel.create({
    data: {
      id: randomUUID(), name: `voice-${randomUUID().slice(0, 8)}`, type: 'voice', serverId, categoryId,
      position: (maxPos._max.position ?? -1) + 1, isPrivate,
    },
  });
  return ch.id;
}

function makeSocket() {
  const emitted: Array<{ event: string; payload: { serverId: string; participantsByChannel: Record<string, unknown> } }> = [];
  const socket = { emit: (event: string, payload: unknown) => { emitted.push({ event, payload: payload as never }); } } as unknown as import('socket.io').Socket;
  return { socket, emitted };
}

function voiceInitChannels(emitted: ReturnType<typeof makeSocket>['emitted']): string[] {
  const ev = emitted.find((e) => e.event === 'server-voice-participants-initial');
  return ev ? Object.keys(ev.payload.participantsByChannel) : [];
}

describe('emitServersInitialState — voice-roster bootstrap visibility filter', () => {
  let owner: TestUser, plain: TestUser, staff: TestUser;
  let serverId: string, categoryId: string, staffRoleId: string;
  let pubVoice: string, privVoice: string;

  beforeAll(async () => {
    owner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    categoryId = server.categories[0].id;
    await makeEveryoneRole(serverId, { viewChannels: true, readMessageHistory: true });
    staffRoleId = await makeRole(serverId, 'Staff', { viewChannels: true, readMessageHistory: true });
    plain = await addMember(serverId);
    staff = await addMember(serverId, [staffRoleId]);
    pubVoice = await makeVoiceChannel(serverId, categoryId, false);
    privVoice = await makeVoiceChannel(serverId, categoryId, true);
    await prisma.channelPermissionOverride.create({
      data: { channelId: privVoice, targetType: 'role', targetId: staffRoleId, permissions: { viewChannels: true } },
    });
  });

  afterAll(async () => {
    await prisma.channelPermissionOverride.deleteMany({ where: { channel: { serverId } } });
    await prisma.memberRole.deleteMany({ where: { serverId } });
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('always emits the voice-initial event (fires the client onInitial handler)', async () => {
    const { socket, emitted } = makeSocket();
    await emitServersInitialState(socket, [serverId], plain.id);
    expect(emitted.some((e) => e.event === 'server-voice-participants-initial')).toBe(true);
  });

  it('non-viewer receives the PUBLIC voice roster but NOT the private one', async () => {
    const { socket, emitted } = makeSocket();
    await emitServersInitialState(socket, [serverId], plain.id);
    const chans = voiceInitChannels(emitted);
    expect(chans).toContain(pubVoice);
    expect(chans).not.toContain(privVoice);
  });

  it('role-granted viewer receives BOTH voice rosters', async () => {
    const { socket, emitted } = makeSocket();
    await emitServersInitialState(socket, [serverId], staff.id);
    const chans = voiceInitChannels(emitted);
    expect(chans).toContain(pubVoice);
    expect(chans).toContain(privVoice);
  });

  it('owner (bypass) receives BOTH voice rosters', async () => {
    const { socket, emitted } = makeSocket();
    await emitServersInitialState(socket, [serverId], owner.id);
    const chans = voiceInitChannels(emitted);
    expect(chans).toContain(pubVoice);
    expect(chans).toContain(privVoice);
  });
});
