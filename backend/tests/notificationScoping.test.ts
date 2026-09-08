// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * : the notification worker's mention fanout must not leak a
 * private / baseline-restricted channel's name + body preview to non-viewers,
 * in realtime OR durably. Locks the WORKER path (the production path), which the
 * socket harness cannot drive deterministically. Mirrors the earlier
 * threadArchiveScoping precedent.
 *
 * Invariants:
 *  - provably-open public channel @everyone => single server-room broadcast +
 *    rows for all members (unchanged legacy behavior);
 *  - private channel @everyone => NO server-room notification-created; emit and
 *    rows reach ONLY viewers; server-channel-activity goes to the channel room;
 *  - baseline-denied public channel @everyone => same scoping as private;
 *  - age-restricted channel => a minor viewer gets neither frame nor row;
 *  - targeted mention of a non-viewer => nothing.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Job } from 'bullmq';
import { processNotification, setNotificationIO, type NotificationJobData } from '../src/queues/workers/notification.worker.js';
import { createTestUser, createTestServer, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';

// Socket.IO stub: records every emit with its room list. Handles both
// io.to(room).emit(...) and io.to([roomA, roomB]).emit(...).
function makeIo() {
  const emits: { rooms: string[]; event: string; payload: Record<string, unknown> }[] = [];
  const io = {
    to: (room: string | string[]) => ({
      emit: (event: string, payload: Record<string, unknown>) => {
        emits.push({ rooms: Array.isArray(room) ? room : [room], event, payload });
      },
    }),
    in: () => ({ fetchSockets: async () => [] }),
  };
  return { io: io as unknown as import('socket.io').Server, emits };
}

async function everyoneRole(serverId: string, permissions: Record<string, boolean>) {
  await prisma.serverRole.create({ data: { id: randomUUID(), serverId, name: '@everyone', position: 0, isEveryone: true, permissions } });
}
async function role(serverId: string, name: string, permissions: Record<string, boolean>): Promise<string> {
  const r = await prisma.serverRole.create({ data: { id: randomUUID(), serverId, name, position: 1, isEveryone: false, permissions } });
  return r.id;
}
async function member(serverId: string, roleIds: string[] = []): Promise<string> {
  const u = await createTestUser();
  await prisma.serverMember.create({ data: { userId: u.id, serverId, role: 'member' } });
  for (const roleId of roleIds) await prisma.memberRole.create({ data: { userId: u.id, serverId, roleId } });
  return u.id;
}
async function channel(serverId: string, categoryId: string, opts: { isPrivate?: boolean; ageRestricted?: boolean } = {}): Promise<string> {
  const maxPos = await prisma.channel.aggregate({ where: { serverId, categoryId }, _max: { position: true } });
  const c = await prisma.channel.create({
    data: {
      id: randomUUID(), name: `chan-${randomUUID().slice(0, 6)}`, type: 'text', serverId, categoryId,
      position: (maxPos._max.position ?? -1) + 1, isPrivate: opts.isPrivate ?? false, ageRestricted: opts.ageRestricted ?? false,
    },
  });
  return c.id;
}
function mentionJob(serverId: string, channelId: string, authorId: string, content: string): Job<NotificationJobData> {
  return { id: randomUUID(), data: { type: 'mentions', serverId, channelId, messageId: randomUUID(), content, authorId } } as unknown as Job<NotificationJobData>;
}

// The worker writes Notification rows / read-state fire-and-forget (not awaited),
// so give those async writes time to commit before asserting on the DB.
const settle = () => new Promise((r) => setTimeout(r, 500));

function notifTo(emits: ReturnType<typeof makeIo>['emits'], userId: string): typeof emits {
  return emits.filter((e) => e.event === 'notification-created' && e.rooms.includes(`user:${userId}`));
}
function serverRoomNotif(emits: ReturnType<typeof makeIo>['emits'], serverId: string): typeof emits {
  return emits.filter((e) => e.event === 'notification-created' && e.rooms.includes(`server:${serverId}`));
}

describe('notification worker scopes private/restricted channel mentions', () => {
  let ownerId: string, viewerId: string, outsiderId: string;
  let serverId: string, categoryId: string, staffRoleId: string;
  let pubOpen: string, priv: string;

  beforeAll(async () => {
    const owner: TestUser = await createTestUser();
    ownerId = owner.id;
    const server = await createTestServer(ownerId);
    serverId = server.id;
    categoryId = server.categories[0].id;
    await everyoneRole(serverId, { viewChannels: true, readMessageHistory: true });
    staffRoleId = await role(serverId, 'Staff', { viewChannels: true, readMessageHistory: true });
    viewerId = await member(serverId, [staffRoleId]);
    outsiderId = await member(serverId); // only @everyone

    pubOpen = await channel(serverId, categoryId);
    priv = await channel(serverId, categoryId, { isPrivate: true });
    await prisma.channelPermissionOverride.create({ data: { channelId: priv, targetType: 'role', targetId: staffRoleId, permissions: { viewChannels: true, readMessageHistory: true } } });
  });

  afterAll(async () => {
    setNotificationIO(undefined as unknown as import('socket.io').Server);
    await prisma.notification.deleteMany({ where: { serverId } });
    await prisma.channelPermissionOverride.deleteMany({ where: { channel: { serverId } } });
    await prisma.memberRole.deleteMany({ where: { serverId } });
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('public open @everyone: single server-room broadcast + rows for all', async () => {
    const { io, emits } = makeIo();
    setNotificationIO(io);
    await prisma.notification.deleteMany({ where: { serverId } });
    await processNotification(mentionJob(serverId, pubOpen, ownerId, '@everyone open canary'));
    await settle();

    expect(serverRoomNotif(emits, serverId).length).toBe(1);
    // no per-user notification-created for the public open case
    expect(notifTo(emits, outsiderId).length).toBe(0);
    const rows = await prisma.notification.findMany({ where: { serverId, channelId: pubOpen } });
    const rowUsers = new Set(rows.map((r) => r.userId));
    expect(rowUsers.has(viewerId)).toBe(true);
    expect(rowUsers.has(outsiderId)).toBe(true);
    expect(rowUsers.has(ownerId)).toBe(false); // author excluded
  });

  it('private @everyone: no server-room emit; viewer gets frame+row; outsider gets neither', async () => {
    const { io, emits } = makeIo();
    setNotificationIO(io);
    await prisma.notification.deleteMany({ where: { serverId } });
    await processNotification(mentionJob(serverId, priv, ownerId, '@everyone the merger closes friday'));
    await settle();

    // The content-bearing notification-created must NEVER hit the server room.
    expect(serverRoomNotif(emits, serverId).length).toBe(0);
    // server-channel-activity (metadata only) routes to the channel room, not server.
    const activity = emits.filter((e) => e.event === 'server-channel-activity');
    expect(activity.length).toBeGreaterThan(0);
    for (const a of activity) expect(a.rooms).not.toContain(`server:${serverId}`);

    // Viewer (Staff, has the override) receives the realtime frame and a durable row.
    expect(notifTo(emits, viewerId).length).toBe(1);
    // Outsider (only @everyone, no override on a private channel) gets nothing.
    expect(notifTo(emits, outsiderId).length).toBe(0);

    const rows = await prisma.notification.findMany({ where: { serverId, channelId: priv } });
    const rowUsers = new Set(rows.map((r) => r.userId));
    expect(rowUsers.has(viewerId)).toBe(true);
    expect(rowUsers.has(outsiderId)).toBe(false);
    // The leaked body/title must not be in any outsider-visible row.
    expect(rows.some((r) => r.userId === outsiderId)).toBe(false);
  });

  it('fails closed when the channel was deleted before the job ran (null gate)', async () => {
    // Channel deleted in the enqueue->process window: loadChannelNotifyGate
    // returns null. The worker must ABORT the fanout, not skip the filter and
    // fan the preview out to every member.
    const tmp = await channel(serverId, categoryId, { isPrivate: false });
    await prisma.channel.delete({ where: { id: tmp } });
    const { io, emits } = makeIo();
    setNotificationIO(io);
    await prisma.notification.deleteMany({ where: { serverId } });
    await processNotification(mentionJob(serverId, tmp, ownerId, '@everyone deleted-channel canary'));
    await settle();

    expect(emits.filter((e) => e.event === 'notification-created').length).toBe(0);
    expect(emits.filter((e) => e.event === 'server-channel-activity').length).toBe(0);
    const rows = await prisma.notification.findMany({ where: { serverId, channelId: tmp } });
    expect(rows.length).toBe(0);
  });

  it('targeted mention of a non-viewer into a private channel leaks nothing', async () => {
    const outsider = await prisma.user.findUniqueOrThrow({ where: { id: outsiderId }, select: { username: true, discriminator: true } });
    const { io, emits } = makeIo();
    setNotificationIO(io);
    await prisma.notification.deleteMany({ where: { serverId } });
    await processNotification(mentionJob(serverId, priv, ownerId, `@${outsider.username}#${outsider.discriminator} secret`));
    await settle();

    expect(notifTo(emits, outsiderId).length).toBe(0);
    const rows = await prisma.notification.findMany({ where: { serverId, channelId: priv, userId: outsiderId } });
    expect(rows.length).toBe(0);
  });
});

describe('baseline-denied public channel is scoped like private', () => {
  let ownerId: string, staffId: string, plainId: string, serverId: string, categoryId: string, pub: string;

  beforeAll(async () => {
    const owner = await createTestUser();
    ownerId = owner.id;
    const server = await createTestServer(ownerId);
    serverId = server.id;
    categoryId = server.categories[0].id;
    await everyoneRole(serverId, { viewChannels: true, readMessageHistory: false });
    const staffRoleId = await role(serverId, 'Staff', { readMessageHistory: true });
    staffId = await member(serverId, [staffRoleId]);
    plainId = await member(serverId);
    pub = await channel(serverId, categoryId); // public, no overrides
  });

  afterAll(async () => {
    setNotificationIO(undefined as unknown as import('socket.io').Server);
    await prisma.notification.deleteMany({ where: { serverId } });
    await prisma.memberRole.deleteMany({ where: { serverId } });
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('no server-room broadcast; staff (read-granted) gets it, plain member does not', async () => {
    const { io, emits } = makeIo();
    setNotificationIO(io);
    await processNotification(mentionJob(serverId, pub, ownerId, '@everyone prod db creds rotated'));
    await settle();

    expect(serverRoomNotif(emits, serverId).length).toBe(0);
    expect(notifTo(emits, staffId).length).toBe(1);
    expect(notifTo(emits, plainId).length).toBe(0);
    const rows = await prisma.notification.findMany({ where: { serverId, channelId: pub } });
    const rowUsers = new Set(rows.map((r) => r.userId));
    expect(rowUsers.has(staffId)).toBe(true);
    expect(rowUsers.has(plainId)).toBe(false);
  });
});

describe('age-restricted channel drops the minor from the worker fanout', () => {
  let ownerId: string, adultId: string, minorId: string, serverId: string, categoryId: string, ageCh: string;

  beforeAll(async () => {
    const owner = await createTestUser();
    ownerId = owner.id;
    const server = await createTestServer(ownerId);
    serverId = server.id;
    categoryId = server.categories[0].id;
    await everyoneRole(serverId, { viewChannels: true, readMessageHistory: true });
    adultId = await member(serverId);
    minorId = await member(serverId);
    await prisma.user.update({ where: { id: minorId }, data: { dateOfBirth: new Date(Date.now() - 13 * 365 * 24 * 3600 * 1000) } });
    ageCh = await channel(serverId, categoryId, { ageRestricted: true });
  });

  afterAll(async () => {
    setNotificationIO(undefined as unknown as import('socket.io').Server);
    await prisma.notification.deleteMany({ where: { serverId } });
    await prisma.memberRole.deleteMany({ where: { serverId } });
    await prisma.channel.deleteMany({ where: { serverId } });
    await prisma.serverRole.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('minor gets neither the frame nor a durable row; adult gets both; no server-room broadcast', async () => {
    const { io, emits } = makeIo();
    setNotificationIO(io);
    await processNotification(mentionJob(serverId, ageCh, ownerId, '@everyone adults only'));
    await settle();

    expect(serverRoomNotif(emits, serverId).length).toBe(0);
    expect(notifTo(emits, minorId).length).toBe(0);
    expect(notifTo(emits, adultId).length).toBe(1);
    const rows = await prisma.notification.findMany({ where: { serverId, channelId: ageCh } });
    const rowUsers = new Set(rows.map((r) => r.userId));
    expect(rowUsers.has(minorId)).toBe(false);
    expect(rowUsers.has(adultId)).toBe(true);
  });
});
