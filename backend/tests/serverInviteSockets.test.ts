// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { app, httpServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import {
  createTestUser, createTestServer, authHeader, cleanupTestData, type TestUser,
} from './helpers.js';
import type { AddressInfo } from 'net';

// Reuse the role-permission seeding pattern from serverInvites.test.ts.
async function addMemberWithPermissions(
  serverId: string,
  userId: string,
  permissions: Record<string, boolean>,
) {
  let everyone = await prisma.serverRole.findFirst({ where: { serverId, isEveryone: true } });
  if (!everyone) {
    everyone = await prisma.serverRole.create({
      data: {
        serverId, name: '@everyone', position: 999, locked: true, isEveryone: true,
        permissions: {} as any,
      },
    });
  }
  let role: Awaited<ReturnType<typeof prisma.serverRole.findFirst>> | null = null;
  if (Object.keys(permissions).length > 0) {
    role = await prisma.serverRole.create({
      data: {
        serverId, name: `Role-${Math.random().toString(36).slice(2, 8)}`,
        position: 5, permissions: permissions as any,
      },
    });
  }
  await prisma.serverMember.create({
    data: { userId, serverId, role: 'member', roleId: role?.id ?? null },
  });
  if (role) {
    await prisma.memberRole.create({ data: { userId, serverId, roleId: role.id } });
  }
}

let baseUrl: string;
const clients: ClientSocket[] = [];

function connect(token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const sock = ioClient(baseUrl, {
      transports: ['websocket'], auth: { token }, forceNew: true, reconnection: false,
    });
    clients.push(sock);
    sock.on('connect', () => resolve(sock));
    sock.on('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function joinServer(sock: ClientSocket, serverId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onInitial = (data: { serverId: string }) => {
      if (data.serverId === serverId) {
        sock.off('server-voice-participants-initial', onInitial);
        resolve();
      }
    };
    sock.on('server-voice-participants-initial', onInitial);
    sock.emit('join-server', serverId);
    setTimeout(() => reject(new Error('join-server timeout')), 3000);
  });
}

// Resolves with an array of received events of the given name within `windowMs`.
function collectEvents<T>(sock: ClientSocket, event: string, windowMs = 600): Promise<T[]> {
  return new Promise((resolve) => {
    const events: T[] = [];
    const onEvent = (payload: T) => events.push(payload);
    sock.on(event, onEvent);
    setTimeout(() => {
      sock.off(event, onEvent);
      resolve(events);
    }, windowMs);
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(() => {
  for (const c of clients) { if (c.connected) c.disconnect(); }
  clients.length = 0;
});

afterAll(async () => {
  await cleanupTestData();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('Socket.IO emit filtering — server-invite-created', () => {
  let admin: TestUser;
  let creator: TestUser;
  let plain: TestUser;
  let serverId: string;

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser();
    creator = await createTestUser();
    plain = await createTestUser();
    const server = await createTestServer(admin.id);
    serverId = server.id;
    await addMemberWithPermissions(serverId, creator.id, { createInvite: true });
    await addMemberWithPermissions(serverId, plain.id, {});
  });

  it('non-shareable invite from admin reaches admin only (not plain member, no createInvite-only members not creator)', async () => {
    const adminSock = await connect(admin.token);
    const plainSock = await connect(plain.token);
    await Promise.all([joinServer(adminSock, serverId), joinServer(plainSock, serverId)]);

    const adminEvents = collectEvents<{ invite: { code: string } }>(adminSock, 'server-invite-created');
    const plainEvents = collectEvents<{ invite: { code: string } }>(plainSock, 'server-invite-created');

    const res = await request(app)
      .post(`/api/servers/${serverId}/invites`)
      .set('Authorization', authHeader(admin.token))
      .send({ shareable: false, label: 'VIPs' });
    expect(res.status).toBe(201);

    const [forAdmin, forPlain] = await Promise.all([adminEvents, plainEvents]);
    expect(forAdmin).toHaveLength(1);
    expect(forAdmin[0]!.invite.code).toBe(res.body.code);
    expect(forPlain).toHaveLength(0);
  });

  it('non-shareable invite from creator reaches admin and creator, not plain member', async () => {
    const adminSock = await connect(admin.token);
    const creatorSock = await connect(creator.token);
    const plainSock = await connect(plain.token);
    await Promise.all([
      joinServer(adminSock, serverId),
      joinServer(creatorSock, serverId),
      joinServer(plainSock, serverId),
    ]);

    const adminEvents = collectEvents<{ invite: { code: string } }>(adminSock, 'server-invite-created');
    const creatorEvents = collectEvents<{ invite: { code: string } }>(creatorSock, 'server-invite-created');
    const plainEvents = collectEvents<{ invite: { code: string } }>(plainSock, 'server-invite-created');

    const res = await request(app)
      .post(`/api/servers/${serverId}/invites`)
      .set('Authorization', authHeader(creator.token))
      .send({});
    expect(res.status).toBe(201);

    const [forAdmin, forCreator, forPlain] = await Promise.all([adminEvents, creatorEvents, plainEvents]);
    expect(forAdmin).toHaveLength(1);
    expect(forCreator).toHaveLength(1);
    expect(forPlain).toHaveLength(0);
  });

  it('shareable invite reaches all server members', async () => {
    const adminSock = await connect(admin.token);
    const plainSock = await connect(plain.token);
    await Promise.all([joinServer(adminSock, serverId), joinServer(plainSock, serverId)]);

    const adminEvents = collectEvents<{ invite: { code: string } }>(adminSock, 'server-invite-created');
    const plainEvents = collectEvents<{ invite: { code: string } }>(plainSock, 'server-invite-created');

    const res = await request(app)
      .post(`/api/servers/${serverId}/invites`)
      .set('Authorization', authHeader(admin.token))
      .send({ shareable: true });
    expect(res.status).toBe(201);

    const [forAdmin, forPlain] = await Promise.all([adminEvents, plainEvents]);
    expect(forAdmin).toHaveLength(1);
    expect(forPlain).toHaveLength(1);
  });
});

describe('Socket.IO emit filtering — PATCH lockdown ratchet', () => {
  let admin: TestUser;
  let plain: TestUser;
  let serverId: string;
  let inviteId: string;

  beforeEach(async () => {
    await cleanupTestData();
    admin = await createTestUser();
    plain = await createTestUser();
    const server = await createTestServer(admin.id);
    serverId = server.id;
    await addMemberWithPermissions(serverId, plain.id, {});
    const inv = await prisma.invite.create({
      data: { code: `LOCK${Math.random().toString(36).slice(2, 8).toUpperCase()}`, serverId, createdById: admin.id, shareable: true },
    });
    inviteId = inv.id;
  });

  it('shareable: true → false sends server-invite-deleted to invisible viewers', async () => {
    const adminSock = await connect(admin.token);
    const plainSock = await connect(plain.token);
    await Promise.all([joinServer(adminSock, serverId), joinServer(plainSock, serverId)]);

    const adminUpdated = collectEvents<{ invite: { id: string } }>(adminSock, 'server-invite-updated');
    const plainUpdated = collectEvents<{ invite: { id: string } }>(plainSock, 'server-invite-updated');
    const plainDeleted = collectEvents<{ inviteId: string }>(plainSock, 'server-invite-deleted');

    const res = await request(app)
      .patch(`/api/servers/${serverId}/invites/${inviteId}`)
      .set('Authorization', authHeader(admin.token))
      .send({ shareable: false });
    expect(res.status).toBe(200);

    const [forAdminUpd, forPlainUpd, forPlainDel] = await Promise.all([adminUpdated, plainUpdated, plainDeleted]);
    expect(forAdminUpd).toHaveLength(1);
    expect(forPlainUpd).toHaveLength(0);
    expect(forPlainDel).toHaveLength(1);
    expect(forPlainDel[0]!.inviteId).toBe(inviteId);
  });

  it('shareable: false → true sends update to plain member newly able to see it', async () => {
    await prisma.invite.update({ where: { id: inviteId }, data: { shareable: false } });

    const adminSock = await connect(admin.token);
    const plainSock = await connect(plain.token);
    await Promise.all([joinServer(adminSock, serverId), joinServer(plainSock, serverId)]);

    const adminUpdated = collectEvents<{ invite: { id: string } }>(adminSock, 'server-invite-updated');
    const plainUpdated = collectEvents<{ invite: { id: string } }>(plainSock, 'server-invite-updated');

    const res = await request(app)
      .patch(`/api/servers/${serverId}/invites/${inviteId}`)
      .set('Authorization', authHeader(admin.token))
      .send({ shareable: true });
    expect(res.status).toBe(200);

    const [forAdminUpd, forPlainUpd] = await Promise.all([adminUpdated, plainUpdated]);
    expect(forAdminUpd).toHaveLength(1);
    expect(forPlainUpd).toHaveLength(1);
  });

  it('shareable: false → false (other field changed) does not leak invite to plain member', async () => {
    await prisma.invite.update({ where: { id: inviteId }, data: { shareable: false } });

    const adminSock = await connect(admin.token);
    const plainSock = await connect(plain.token);
    await Promise.all([joinServer(adminSock, serverId), joinServer(plainSock, serverId)]);

    const adminUpdated = collectEvents<{ invite: { id: string } }>(adminSock, 'server-invite-updated');
    const plainUpdated = collectEvents<{ invite: { id: string } }>(plainSock, 'server-invite-updated');
    const plainDeleted = collectEvents<{ inviteId: string }>(plainSock, 'server-invite-deleted');

    const res = await request(app)
      .patch(`/api/servers/${serverId}/invites/${inviteId}`)
      .set('Authorization', authHeader(admin.token))
      .send({ label: 'Renamed' });
    expect(res.status).toBe(200);

    const [forAdminUpd, forPlainUpd, forPlainDel] = await Promise.all([adminUpdated, plainUpdated, plainDeleted]);
    expect(forAdminUpd).toHaveLength(1);
    expect(forPlainUpd).toHaveLength(0);
    expect(forPlainDel).toHaveLength(0);
  });
});
