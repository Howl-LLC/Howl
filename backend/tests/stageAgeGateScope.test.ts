// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Stage age gate — realtime roster + reconnect bootstrap.
 *
 * The visibility pass dropped NON-VIEWERS from the stage `server:` legs but still delivered a
 * PUBLIC `ageRestricted = true` stage's speaker roster to minor members (who CAN
 * view the channel). This locks the age drop on the two indicator surfaces:
 *
 *   - `emitStageEventScoped` → `emitChannelEventToViewers({ dropMinors })`: an
 *     age-restricted stage is never `provablyOpen`, so it takes the per-viewer
 *     path; minors are dropped there.
 * - `emitServersInitialState` (reconnect bootstrap): the roster snapshot
 *     drops age-restricted stages for a minor via `filterVisibleChannelIds`
 *     `{ isMinor }`.
 *
 * `getActiveStageSpeakers` (Redis session + speaker set) is stubbed for the
 * bootstrap suite so the test exercises the visibility/age filter, not the Redis
 * seeding path — mirrors tests/stageBootstrapScope.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../src/routes/stages.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/routes/stages.js')>();
  return { ...mod, getActiveStageSpeakers: vi.fn(async () => [{ userId: 'seed', username: 'seed' }]) };
});

import { emitStageEventScoped } from '../src/utils/channelVisibility.js';
import { emitServersInitialState } from '../src/socketHandlers/channels.js';
import { createTestUser, createTestServer, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';

async function makeEveryoneRole(serverId: string, permissions: Record<string, boolean>): Promise<string> {
  const role = await prisma.serverRole.create({
    data: { id: randomUUID(), serverId, name: '@everyone', position: 0, isEveryone: true, permissions },
  });
  return role.id;
}
async function addMember(serverId: string, dob: Date): Promise<TestUser> {
  const u = await createTestUser();
  await prisma.user.update({ where: { id: u.id }, data: { dateOfBirth: dob } });
  await prisma.serverMember.create({ data: { userId: u.id, serverId, role: 'member' } });
  return u;
}
async function makeStageChannel(serverId: string, categoryId: string | null, ageRestricted: boolean): Promise<string> {
  const maxPos = await prisma.channel.aggregate({ where: { serverId, categoryId }, _max: { position: true } });
  const ch = await prisma.channel.create({
    data: {
      id: randomUUID(), name: `stage-${randomUUID().slice(0, 8)}`, type: 'stage', serverId, categoryId,
      position: (maxPos._max.position ?? -1) + 1, isPrivate: false, ageRestricted,
    },
  });
  return ch.id;
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
function stageInitChannels(emitted: ReturnType<typeof makeSocket>['emitted']): string[] {
  const ev = emitted.find((e) => e.event === 'server-stage-participants-initial');
  return ev ? Object.keys(ev.payload.participantsByChannel) : [];
}

// ── realtime roster: emitStageEventScoped drops minors on age-restricted ─────
describe('emitStageEventScoped — age-restricted stage drops minor viewers', () => {
  let owner: TestUser, adult: TestUser, minor: TestUser;
  let serverId: string, categoryId: string;
  let arStage: string, pubStage: string;

  beforeAll(async () => {
    owner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    categoryId = server.categories[0].id;
    await makeEveryoneRole(serverId, { viewChannels: true, readMessageHistory: true });
    adult = await addMember(serverId, ADULT_DOB);
    minor = await addMember(serverId, minorDob());
    arStage = await makeStageChannel(serverId, categoryId, true);   // public + age-restricted
    pubStage = await makeStageChannel(serverId, categoryId, false); // public control
  });

  afterAll(async () => {
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('age-restricted public stage: delivered per-viewer to adults, never the minor or the server room', async () => {
    const { io, emitted } = makeIo([owner.id, adult.id, minor.id]);
    await emitStageEventScoped({ io, channelId: arStage, serverId, event: 'server-stage-participants', payload: { ok: 1 } });
    const rooms = new Set(emitted.map((e) => e.room));
    expect(rooms.has(`user:${owner.id}`)).toBe(true);
    expect(rooms.has(`user:${adult.id}`)).toBe(true);
    expect(rooms.has(`user:${minor.id}`)).toBe(false);   // minor dropped
    expect(rooms.has(`server:${serverId}`)).toBe(false); // never the whole-server broadcast
  });

  it('non-age-restricted public stage: single server-room broadcast (unchanged, minors included)', async () => {
    const { io, emitted } = makeIo([owner.id, adult.id, minor.id]);
    await emitStageEventScoped({ io, channelId: pubStage, serverId, event: 'server-stage-participants', payload: { ok: 1 } });
    expect(emitted).toEqual([{ room: `server:${serverId}`, event: 'server-stage-participants', payload: { ok: 1 } }]);
  });
});

// ── reconnect bootstrap: emitServersInitialState drops age-restricted for minor ─
describe('emitServersInitialState — age-restricted stage dropped from minor bootstrap', () => {
  let owner: TestUser, adult: TestUser, minor: TestUser;
  let serverId: string, categoryId: string;
  let arStage: string, safeStage: string;

  beforeAll(async () => {
    owner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    categoryId = server.categories[0].id;
    await makeEveryoneRole(serverId, { viewChannels: true, readMessageHistory: true });
    adult = await addMember(serverId, ADULT_DOB);
    minor = await addMember(serverId, minorDob());
    arStage = await makeStageChannel(serverId, categoryId, true);
    safeStage = await makeStageChannel(serverId, categoryId, false);
  });

  afterAll(async () => {
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('minor: bootstrap includes the safe stage but NOT the age-restricted stage', async () => {
    const { socket, emitted } = makeSocket();
    await emitServersInitialState(socket, [serverId], minor.id);
    const chans = stageInitChannels(emitted);
    expect(chans).toContain(safeStage);
    expect(chans).not.toContain(arStage);
  });

  it('adult member: bootstrap includes BOTH stages', async () => {
    const { socket, emitted } = makeSocket();
    await emitServersInitialState(socket, [serverId], adult.id);
    const chans = stageInitChannels(emitted);
    expect(chans).toContain(safeStage);
    expect(chans).toContain(arStage);
  });
});
