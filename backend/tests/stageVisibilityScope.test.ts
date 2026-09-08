// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * the stage lifecycle server-room broadcasts.
 *
 * Every stage action fanned its `server:${serverId}` leg (existence, topic, and
 * the speaker roster of userId/username/avatar) to the WHOLE server, leaking a
 * private / override-restricted stage channel's activity to non-viewers, in
 * realtime AND durably (the `stage_started` notification rows, 90d via
 * GET /notifications). These lock:
 *
 *   - `emitStageEventScoped`: provably-open public channel → single `server:`
 *     broadcast (unchanged, no fan-out amplification); otherwise → only members
 *     who can VIEW the channel (per-viewer emit); deleted channel → nothing
 *     (fail-closed).
 * - `filterVisibleChannelIds` `viewOnly`: bootstrap gate must key on
 *     viewChannels alone (matching the authoritative stage-join handler), NOT
 *     readMessageHistory.
 *   - the durable `stage_started` notification is intersected with the channel
 *     viewers (route end-to-end).
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import {
  emitStageEventScoped,
  filterVisibleChannelIds,
} from '../src/utils/channelVisibility.js';
import { loadPermissionContext } from '../src/utils.js';
import { clearStageState } from '../src/routes/stages.js';
import { createTestUser, createTestServer, authHeader, cleanupTestData, type TestUser } from './helpers.js';
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
async function makeStageChannel(serverId: string, categoryId: string | null, opts: { isPrivate?: boolean } = {}): Promise<string> {
  const maxPos = await prisma.channel.aggregate({ where: { serverId, categoryId }, _max: { position: true } });
  const ch = await prisma.channel.create({
    data: {
      id: randomUUID(), name: `stage-${randomUUID().slice(0, 8)}`, type: 'stage', serverId, categoryId,
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

// ── emitStageEventScoped ─────────────────────────────────────────────────────
describe('emitStageEventScoped', () => {
  let owner: TestUser, plain: TestUser, staff: TestUser;
  let serverId: string, categoryId: string, staffRoleId: string;
  let pubStage: string, privStage: string;

  beforeAll(async () => {
    owner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    categoryId = server.categories[0].id;
    await makeEveryoneRole(serverId, { viewChannels: true, readMessageHistory: true });
    staffRoleId = await makeRole(serverId, 'Staff', { viewChannels: true, readMessageHistory: true });
    plain = await addMember(serverId);
    staff = await addMember(serverId, [staffRoleId]);
    pubStage = await makeStageChannel(serverId, categoryId);
    privStage = await makeStageChannel(serverId, categoryId, { isPrivate: true });
    await channelOverride(privStage, 'role', staffRoleId, { viewChannels: true, readMessageHistory: true });
  });

  afterAll(async () => {
    await prisma.channelPermissionOverride.deleteMany({ where: { channel: { serverId } } });
    await prisma.memberRole.deleteMany({ where: { serverId } });
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('provably-open public channel: one server-room broadcast, no per-user emits', async () => {
    const { io, emitted } = makeIo([owner.id, plain.id, staff.id]);
    await emitStageEventScoped({ io, channelId: pubStage, serverId, event: 'server-stage-participants', payload: { ok: 1 } });
    expect(emitted).toEqual([{ room: `server:${serverId}`, event: 'server-stage-participants', payload: { ok: 1 } }]);
    expect(emitted.some((e) => e.room.startsWith('user:'))).toBe(false);
  });

  it('private channel: delivers only to viewers (owner + role grant), never the server room or the non-viewer', async () => {
    const { io, emitted } = makeIo([owner.id, plain.id, staff.id]);
    await emitStageEventScoped({ io, channelId: privStage, serverId, event: 'server-stage-participants', payload: { ok: 1 } });
    const rooms = new Set(emitted.map((e) => e.room));
    expect(rooms).toEqual(new Set([`user:${owner.id}`, `user:${staff.id}`]));
    expect(rooms.has(`server:${serverId}`)).toBe(false);
    expect(rooms.has(`user:${plain.id}`)).toBe(false);
    for (const e of emitted) expect(e).toMatchObject({ event: 'server-stage-participants', payload: { ok: 1 } });
  });

  it('deleted / non-existent channel: fail-closed, emits nothing', async () => {
    const { io, emitted } = makeIo([owner.id, plain.id, staff.id]);
    await emitStageEventScoped({ io, channelId: randomUUID(), serverId, event: 'server-stage-participants', payload: { ok: 1 } });
    expect(emitted).toEqual([]);
  });
});

// ── filterVisibleChannelIds viewOnly ─────────────────────────────────────────
describe('filterVisibleChannelIds — viewOnly ', () => {
  let owner: TestUser, plain: TestUser, staff: TestUser;
  let serverId: string, categoryId: string, staffRoleId: string;
  let privViewNoRead: string, privNoGrant: string;

  beforeAll(async () => {
    owner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    categoryId = server.categories[0].id;
    await makeEveryoneRole(serverId, { viewChannels: true, readMessageHistory: true });
    staffRoleId = await makeRole(serverId, 'Staff', { viewChannels: true, readMessageHistory: true });
    plain = await addMember(serverId);
    staff = await addMember(serverId, [staffRoleId]);
    // Private stage: Staff granted viewChannels but explicitly DENIED readMessageHistory.
    privViewNoRead = await makeStageChannel(serverId, categoryId, { isPrivate: true });
    await channelOverride(privViewNoRead, 'role', staffRoleId, { viewChannels: true, readMessageHistory: false });
    // Private stage with NO grant to Staff — must stay excluded even in viewOnly.
    privNoGrant = await makeStageChannel(serverId, categoryId, { isPrivate: true });
  });

  afterAll(async () => {
    await prisma.channelPermissionOverride.deleteMany({ where: { channel: { serverId } } });
    await prisma.memberRole.deleteMany({ where: { serverId } });
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('viewChannels-granted-but-read-denied private channel: excluded by default, INCLUDED under viewOnly', async () => {
    const ctx = await loadPermissionContext(staff.id, serverId);
    expect(ctx).not.toBeNull();
    const descriptors = [{ id: privViewNoRead, isPrivate: true, categoryId }];
    const def = await filterVisibleChannelIds(ctx!, descriptors);
    expect(def).toEqual([]); // readMessageHistory denied → not readable
    const viewOnly = await filterVisibleChannelIds(ctx!, descriptors, { viewOnly: true });
    expect(viewOnly).toEqual([privViewNoRead]); // can SEE it → gets the stage roster
  });

  it('viewOnly still requires a viewChannels override on a private channel (no over-inclusion)', async () => {
    const ctx = await loadPermissionContext(plain.id, serverId);
    const viewOnly = await filterVisibleChannelIds(ctx!, [{ id: privNoGrant, isPrivate: true, categoryId }], { viewOnly: true });
    expect(viewOnly).toEqual([]); // plain member has no grant → still excluded
  });
});

// ── viewOnly admits OVERRIDE-ONLY access (no server-wide viewChannels) ────────
// Locks the bootstrap≡realtime fidelity fix: a member whose only access to a
// private stage is a channel/category override — in a server where @everyone
// does NOT grant viewChannels server-wide — can join the stage + gets realtime
// roster updates, so the reconnect bootstrap must not drop them.
describe('filterVisibleChannelIds — viewOnly admits override-only private access', () => {
  let owner: TestUser, overrideOnly: TestUser;
  let serverId: string, categoryId: string, roleId: string;
  let privGranted: string, privUngranted: string, pubCh: string;

  beforeAll(async () => {
    owner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    categoryId = server.categories[0].id;
    // @everyone grants NEITHER viewChannels nor readMessageHistory server-wide.
    await makeEveryoneRole(serverId, {});
    // Role with NO server-wide perms — access comes purely from a channel override.
    roleId = await makeRole(serverId, 'OverrideOnly', {});
    overrideOnly = await addMember(serverId, [roleId]);
    privGranted = await makeStageChannel(serverId, categoryId, { isPrivate: true });
    await channelOverride(privGranted, 'role', roleId, { viewChannels: true });
    privUngranted = await makeStageChannel(serverId, categoryId, { isPrivate: true });
    pubCh = await makeStageChannel(serverId, categoryId); // public
  });

  afterAll(async () => {
    await prisma.channelPermissionOverride.deleteMany({ where: { channel: { serverId } } });
    await prisma.memberRole.deleteMany({ where: { serverId } });
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('default filter drops everything (no server-wide viewChannels); viewOnly admits the override-granted private channel', async () => {
    const ctx = await loadPermissionContext(overrideOnly.id, serverId);
    expect(ctx).not.toBeNull();
    const descriptors = [
      { id: privGranted, isPrivate: true, categoryId },
      { id: privUngranted, isPrivate: true, categoryId },
      { id: pubCh, isPrivate: false, categoryId },
    ];
    // Default (read-gated) callers still short-circuit — unchanged behavior.
    expect(await filterVisibleChannelIds(ctx!, descriptors)).toEqual([]);
    // viewOnly: override-granted private + public are visible; ungranted private is NOT.
    const viewOnly = await filterVisibleChannelIds(ctx!, descriptors, { viewOnly: true });
    expect(new Set(viewOnly)).toEqual(new Set([privGranted, pubCh]));
    expect(viewOnly).not.toContain(privUngranted);
  });
});

// ── durable stage_started notification is intersected with channel viewers ────
describe('POST /stage/start — durable stage_started notification scoping', () => {
  let owner: TestUser, viewer: TestUser, outsider: TestUser;
  let serverId: string, categoryId: string, staffRoleId: string;
  let privStage: string;

  beforeAll(async () => {
    owner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    categoryId = server.categories[0].id;
    await makeEveryoneRole(serverId, { viewChannels: true, readMessageHistory: true });
    staffRoleId = await makeRole(serverId, 'Staff', { viewChannels: true, readMessageHistory: true, manageStages: false });
    viewer = await addMember(serverId, [staffRoleId]); // can view the private stage
    outsider = await addMember(serverId);               // member, but NOT a viewer of the private stage
    privStage = await makeStageChannel(serverId, categoryId, { isPrivate: true });
    await channelOverride(privStage, 'role', staffRoleId, { viewChannels: true, readMessageHistory: true });
  });

  afterAll(async () => {
    await clearStageState(privStage).catch(() => {});
    await prisma.notification.deleteMany({ where: { serverId } });
    await prisma.stageSession.deleteMany({ where: { serverId } });
    await prisma.channelPermissionOverride.deleteMany({ where: { channel: { serverId } } });
    await prisma.memberRole.deleteMany({ where: { serverId } });
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('notifies the private-stage viewer but NOT the non-viewer member', async () => {
    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/channels/${privStage}/stage/start`)
      .set('Authorization', authHeader(owner.token))
      .send({ maxSpeakers: 10, textChatEnabled: true, allowEmojis: true, allowStickers: true, allowGifs: true });
    expect(res.status).toBe(201);

    // The notification write is a fire-and-forget IIFE — poll for the viewer's
    // row (deterministic) rather than a fixed sleep, then assert the non-viewer
    // never gets one.
    let viewerRow = null;
    for (let i = 0; i < 40 && !viewerRow; i++) {
      viewerRow = await prisma.notification.findFirst({ where: { userId: viewer.id, channelId: privStage, type: 'stage_started' } });
      if (!viewerRow) await new Promise((r) => setTimeout(r, 100));
    }
    const outsiderRow = await prisma.notification.findFirst({ where: { userId: outsider.id, channelId: privStage, type: 'stage_started' } });
    expect(viewerRow).not.toBeNull();     // viewer is notified
    expect(outsiderRow).toBeNull();       // non-viewer must NOT be
  });
});
