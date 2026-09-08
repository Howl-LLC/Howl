// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Voice age gate — realtime roster + reconnect bootstrap.
 *
 * scoped the voice `server:` legs by VISIBILITY (private channels →
 * viewers only) but explicitly deferred age: an age-restricted PUBLIC voice
 * channel still broadcast its occupant roster to minor members, and the
 * reconnect bootstrap still handed a minor the roster of a voice channel they
 * cannot join. Now that `join-voice-channel` is age-gated, those two indicator
 * surfaces must drop minors too — the voice analog of tests/stageAgeGateScope:
 *
 *   - `emitVoicePresenceScoped` → `emitChannelEventToViewers({ dropMinors })`:
 *     an age-restricted voice channel takes the per-viewer path (public OR
 *     private) and minors are dropped there.
 * - `emitServersInitialState` (reconnect bootstrap): the voice roster
 *     snapshot drops age-restricted voice channels for a minor via
 *     `filterVisibleChannelIds` `{ isMinor }`.
 *
 * `getVoiceParticipantsBatch` is stubbed for the bootstrap suite so the test
 * exercises the visibility/age filter, not the Redis seeding path — mirrors
 * tests/stageAgeGateScope.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../src/redis.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/redis.js')>();
  return {
    ...mod,
    // Every requested voice channel reports one occupant so the bootstrap builds
    // a non-empty roster for it; the test asserts which CHANNELS survive the
    // visibility/age filter, not the roster contents.
    getVoiceParticipantsBatch: vi.fn(async (ids: string[]) => {
      const m = new Map<string, Array<{ userId: string; username: string }>>();
      for (const id of ids) m.set(id, [{ userId: 'seed', username: 'seed' }]);
      return m;
    }),
  };
});

import { emitVoicePresenceScoped } from '../src/utils/channelVisibility.js';
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
async function addMember(serverId: string, dob: Date, roleIds: string[] = []): Promise<TestUser> {
  const u = await createTestUser();
  await prisma.user.update({ where: { id: u.id }, data: { dateOfBirth: dob } });
  await prisma.serverMember.create({ data: { userId: u.id, serverId, role: 'member' } });
  for (const roleId of roleIds) await prisma.memberRole.create({ data: { userId: u.id, serverId, roleId } });
  return u;
}
async function makeVoiceChannel(serverId: string, categoryId: string | null, opts: { isPrivate?: boolean; ageRestricted?: boolean } = {}): Promise<string> {
  const maxPos = await prisma.channel.aggregate({ where: { serverId, categoryId }, _max: { position: true } });
  const ch = await prisma.channel.create({
    data: {
      id: randomUUID(), name: `voice-${randomUUID().slice(0, 8)}`, type: 'voice', serverId, categoryId,
      position: (maxPos._max.position ?? -1) + 1, isPrivate: opts.isPrivate ?? false, ageRestricted: opts.ageRestricted ?? false,
    },
  });
  return ch.id;
}
async function channelOverride(channelId: string, targetType: 'role' | 'member', targetId: string, permissions: Record<string, boolean | null>) {
  await prisma.channelPermissionOverride.create({ data: { channelId, targetType, targetId, permissions } });
}

const ADULT_DOB = new Date('1990-01-01');
function minorDob(): Date {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 14);
  return d;
}

/** Fake Socket.IO server: captures `io.to(room).emit(...)` and serves
 *  `io.in(room).fetchSockets()` from a fixed roster (each socket carries a
 *  `user:${id}` room). */
function makeIo(serverRoomUserIds: string[]) {
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const sockets = serverRoomUserIds.map((uid) => ({ rooms: new Set([`user:${uid}`]) }));
  const io = {
    to: (room: string) => ({ emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); } }),
    in: (_room: string) => ({ fetchSockets: async () => sockets }),
  } as unknown as import('socket.io').Server;
  return { io, emitted };
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

// ── realtime roster: emitVoicePresenceScoped drops minors on age-restricted ──
describe('emitVoicePresenceScoped — age-restricted voice drops minor viewers', () => {
  let owner: TestUser, adult: TestUser, minor: TestUser, staff: TestUser;
  let serverId: string, categoryId: string, staffRoleId: string;
  let arPubVoice: string, pubVoice: string, arPrivVoice: string;

  beforeAll(async () => {
    owner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    categoryId = server.categories[0].id;
    await makeEveryoneRole(serverId, { viewChannels: true, readMessageHistory: true, connect: true });
    staffRoleId = await makeRole(serverId, 'Staff', { viewChannels: true, readMessageHistory: true, connect: true });
    adult = await addMember(serverId, ADULT_DOB);
    minor = await addMember(serverId, minorDob());
    staff = await addMember(serverId, minorDob(), [staffRoleId]); // minor WITH the private-view override
    arPubVoice = await makeVoiceChannel(serverId, categoryId, { ageRestricted: true }); // public + age-restricted
    pubVoice = await makeVoiceChannel(serverId, categoryId); // public control
    arPrivVoice = await makeVoiceChannel(serverId, categoryId, { isPrivate: true, ageRestricted: true }); // private + age-restricted
    await channelOverride(arPrivVoice, 'role', staffRoleId, { viewChannels: true });
  });

  afterAll(async () => {
    await prisma.channelPermissionOverride.deleteMany({ where: { channel: { serverId } } });
    await prisma.memberRole.deleteMany({ where: { serverId } });
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('age-restricted PUBLIC voice: delivered per-viewer to adults, never the minor or the server room', async () => {
    const { io, emitted } = makeIo([owner.id, adult.id, minor.id]);
    await emitVoicePresenceScoped({
      io,
      channel: { id: arPubVoice, serverId, isPrivate: false, categoryId, ageRestricted: true },
      event: 'server-voice-participants',
      payload: { serverId, channelId: arPubVoice, participants: [] },
    });
    const rooms = new Set(emitted.map((e) => e.room));
    expect(rooms.has(`user:${owner.id}`)).toBe(true);
    expect(rooms.has(`user:${adult.id}`)).toBe(true);
    expect(rooms.has(`user:${minor.id}`)).toBe(false);   // minor dropped
    expect(rooms.has(`server:${serverId}`)).toBe(false); // never the whole-server broadcast
  });

  it('non-age-restricted PUBLIC voice: single server-room broadcast (unchanged, minors included)', async () => {
    const { io, emitted } = makeIo([owner.id, adult.id, minor.id]);
    await emitVoicePresenceScoped({
      io,
      channel: { id: pubVoice, serverId, isPrivate: false, categoryId, ageRestricted: false },
      event: 'server-voice-participants',
      payload: { serverId, channelId: pubVoice, participants: [] },
    });
    expect(emitted).toEqual([
      { room: `server:${serverId}`, event: 'server-voice-participants', payload: { serverId, channelId: pubVoice, participants: [] } },
    ]);
  });

  it('age-restricted PRIVATE voice: only adult viewers — minor viewer (with override) and non-viewer both dropped', async () => {
    const { io, emitted } = makeIo([owner.id, adult.id, minor.id, staff.id]);
    await emitVoicePresenceScoped({
      io,
      channel: { id: arPrivVoice, serverId, isPrivate: true, categoryId, ageRestricted: true },
      event: 'server-voice-participants',
      payload: { serverId, channelId: arPrivVoice, participants: [] },
    });
    const rooms = new Set(emitted.map((e) => e.room));
    expect(rooms.has(`user:${owner.id}`)).toBe(true);    // owner bypass, adult
    expect(rooms.has(`user:${staff.id}`)).toBe(false);   // has view override but is a MINOR → dropped
    expect(rooms.has(`user:${minor.id}`)).toBe(false);   // no override AND minor → dropped
    expect(rooms.has(`user:${adult.id}`)).toBe(false);   // adult but no view override on a private channel → dropped
    expect(rooms.has(`server:${serverId}`)).toBe(false);
  });
});

// ── reconnect bootstrap: emitServersInitialState drops age-restricted for minor
describe('emitServersInitialState — age-restricted voice dropped from minor bootstrap', () => {
  let owner: TestUser, adult: TestUser, minor: TestUser;
  let serverId: string, categoryId: string;
  let arVoice: string, safeVoice: string;

  beforeAll(async () => {
    owner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    categoryId = server.categories[0].id;
    await makeEveryoneRole(serverId, { viewChannels: true, readMessageHistory: true, connect: true });
    adult = await addMember(serverId, ADULT_DOB);
    minor = await addMember(serverId, minorDob());
    arVoice = await makeVoiceChannel(serverId, categoryId, { ageRestricted: true });
    safeVoice = await makeVoiceChannel(serverId, categoryId);
  });

  afterAll(async () => {
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('minor: bootstrap includes the safe voice channel but NOT the age-restricted one', async () => {
    const { socket, emitted } = makeSocket();
    await emitServersInitialState(socket, [serverId], minor.id);
    const chans = voiceInitChannels(emitted);
    expect(chans).toContain(safeVoice);
    expect(chans).not.toContain(arVoice);
  });

  it('adult member: bootstrap includes BOTH voice channels', async () => {
    const { socket, emitted } = makeSocket();
    await emitServersInitialState(socket, [serverId], adult.id);
    const chans = voiceInitChannels(emitted);
    expect(chans).toContain(safeVoice);
    expect(chans).toContain(arVoice);
  });
});
