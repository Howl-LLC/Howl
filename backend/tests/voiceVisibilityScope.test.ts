// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * the voice-presence server-room broadcasts.
 *
 * Every voice-presence change (`server-voice-participants`) fanned its
 * `server:${serverId}` leg — the occupant roster of userId/username/avatar — to
 * the WHOLE server, leaking a PRIVATE voice channel's roster to members who
 * cannot VIEW the channel. `emitVoicePresenceScoped` keys on `isPrivate` (the
 * authoritative voice-join gate: a public voice channel skips the override
 * check entirely, only a private one consults viewChannels-via-override), so:
 *
 *   - public voice channel → the single `server:` broadcast (unchanged, no
 *     fan-out amplification, the dominant case);
 *   - private voice channel → only server members who can VIEW it (per-viewer
 *     emit, viewChannels via the channel/category override chain), never the
 *     server room and never a non-viewer;
 *   - a user in the server room who is not (or no longer) a member → excluded.
 *
 * This file covers the VISIBILITY dimension only (isPrivate keying). The AGE
 * dimension — a minor cannot join, so an age-restricted roster drops minors —
 * now that `join-voice-channel` IS age-gated, is covered separately in
 * tests/voiceAgeGateScope.test.ts and tests/voiceAgeGate.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { emitVoicePresenceScoped } from '../src/utils/channelVisibility.js';
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
async function makeVoiceChannel(serverId: string, categoryId: string | null, opts: { isPrivate?: boolean } = {}): Promise<string> {
  const maxPos = await prisma.channel.aggregate({ where: { serverId, categoryId }, _max: { position: true } });
  const ch = await prisma.channel.create({
    data: {
      id: randomUUID(), name: `voice-${randomUUID().slice(0, 8)}`, type: 'voice', serverId, categoryId,
      position: (maxPos._max.position ?? -1) + 1, isPrivate: opts.isPrivate ?? false,
    },
  });
  return ch.id;
}
async function channelOverride(channelId: string, targetType: 'role' | 'member', targetId: string, permissions: Record<string, boolean | null>) {
  await prisma.channelPermissionOverride.create({ data: { channelId, targetType, targetId, permissions } });
}

/** Fake Socket.IO server: captures every `io.to(room).emit(event, payload)` and
 *  serves `io.in(room).fetchSockets()` from a fixed roster (each socket carries a
 *  `user:${id}` room, as every authenticated socket does). */
function makeIo(serverRoomUserIds: string[]) {
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const sockets = serverRoomUserIds.map((uid) => ({ rooms: new Set([`user:${uid}`]) }));
  const io = {
    to: (room: string) => ({ emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); } }),
    in: (_room: string) => ({ fetchSockets: async () => sockets }),
  } as unknown as import('socket.io').Server;
  return { io, emitted };
}

describe('emitVoicePresenceScoped', () => {
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
    pubVoice = await makeVoiceChannel(serverId, categoryId);
    privVoice = await makeVoiceChannel(serverId, categoryId, { isPrivate: true });
    await channelOverride(privVoice, 'role', staffRoleId, { viewChannels: true });
  });

  afterAll(async () => {
    await prisma.channelPermissionOverride.deleteMany({ where: { channel: { serverId } } });
    await prisma.memberRole.deleteMany({ where: { serverId } });
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('public voice channel: one server-room broadcast, no per-user emits', async () => {
    const { io, emitted } = makeIo([owner.id, plain.id, staff.id]);
    await emitVoicePresenceScoped({
      io,
      channel: { id: pubVoice, serverId, isPrivate: false, categoryId, ageRestricted: false },
      event: 'server-voice-participants',
      payload: { serverId, channelId: pubVoice, participants: [] },
    });
    expect(emitted).toEqual([
      { room: `server:${serverId}`, event: 'server-voice-participants', payload: { serverId, channelId: pubVoice, participants: [] } },
    ]);
    expect(emitted.some((e) => e.room.startsWith('user:'))).toBe(false);
  });

  it('private voice channel: delivers only to viewers (owner + role grant), never the server room or the non-viewer', async () => {
    const { io, emitted } = makeIo([owner.id, plain.id, staff.id]);
    await emitVoicePresenceScoped({
      io,
      channel: { id: privVoice, serverId, isPrivate: true, categoryId, ageRestricted: false },
      event: 'server-voice-participants',
      payload: { serverId, channelId: privVoice, participants: [] },
    });
    const rooms = new Set(emitted.map((e) => e.room));
    expect(rooms).toEqual(new Set([`user:${owner.id}`, `user:${staff.id}`]));
    expect(rooms.has(`server:${serverId}`)).toBe(false);
    expect(rooms.has(`user:${plain.id}`)).toBe(false);
    for (const e of emitted) expect(e).toMatchObject({ event: 'server-voice-participants', payload: { channelId: privVoice } });
  });

  it('user in the server room who is not a member is excluded from the private-channel roster', async () => {
    const outsider = await createTestUser(); // NOT a server member
    const { io, emitted } = makeIo([owner.id, outsider.id]);
    await emitVoicePresenceScoped({
      io,
      channel: { id: privVoice, serverId, isPrivate: true, categoryId, ageRestricted: false },
      event: 'server-voice-participants',
      payload: { serverId, channelId: privVoice, participants: [] },
    });
    const rooms = new Set(emitted.map((e) => e.room));
    expect(rooms.has(`user:${outsider.id}`)).toBe(false);
    expect(rooms.has(`user:${owner.id}`)).toBe(true); // owner bypass still delivered
  });
});

// A private voice channel reachable ONLY by a channel override (no server-wide
// viewChannels) — matches the authoritative voice-join gate, which for a private
// channel checks `viewChannels` via the override chain with `requireOverride`.
describe('emitVoicePresenceScoped — override-only private access', () => {
  let owner: TestUser, overrideOnly: TestUser, noAccess: TestUser;
  let serverId: string, categoryId: string, roleId: string;
  let privGranted: string;

  beforeAll(async () => {
    owner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    categoryId = server.categories[0].id;
    await makeEveryoneRole(serverId, {}); // no server-wide grants
    roleId = await makeRole(serverId, 'OverrideOnly', {});
    overrideOnly = await addMember(serverId, [roleId]);
    noAccess = await addMember(serverId);
    privGranted = await makeVoiceChannel(serverId, categoryId, { isPrivate: true });
    await channelOverride(privGranted, 'role', roleId, { viewChannels: true });
  });

  afterAll(async () => {
    await prisma.channelPermissionOverride.deleteMany({ where: { channel: { serverId } } });
    await prisma.memberRole.deleteMany({ where: { serverId } });
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('override-granted member gets the roster; a member with no grant does not', async () => {
    const { io, emitted } = makeIo([owner.id, overrideOnly.id, noAccess.id]);
    await emitVoicePresenceScoped({
      io,
      channel: { id: privGranted, serverId, isPrivate: true, categoryId, ageRestricted: false },
      event: 'server-voice-participants',
      payload: { serverId, channelId: privGranted, participants: [] },
    });
    const rooms = new Set(emitted.map((e) => e.room));
    expect(rooms.has(`user:${overrideOnly.id}`)).toBe(true);
    expect(rooms.has(`user:${noAccess.id}`)).toBe(false);
    expect(rooms.has(`server:${serverId}`)).toBe(false);
  });
});
