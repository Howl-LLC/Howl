// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import type { AddressInfo } from 'net';
import { app, httpServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';

let baseUrl: string;
const clients: ClientSocket[] = [];

function connect(token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const sock = ioClient(baseUrl, { transports: ['websocket'], auth: { token }, forceNew: true, reconnection: false });
    clients.push(sock);
    sock.on('connect', () => resolve(sock));
    sock.on('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

// Resolve with the first `new-dm-channel` whose id matches, or null after the window.
function waitForNewDmChannel(sock: ClientSocket, dmChannelId: string, windowMs = 800): Promise<{ id: string; mlsGroupId?: string | null } | null> {
  return new Promise((resolve) => {
    const onEvent = (payload: { id: string; mlsGroupId?: string | null }) => {
      if (payload.id === dmChannelId) { sock.off('new-dm-channel', onEvent); resolve(payload); }
    };
    sock.on('new-dm-channel', onEvent);
    setTimeout(() => { sock.off('new-dm-channel', onEvent); resolve(null); }, windowMs);
  });
}

// Seed an MLS-classified group DM: encrypted group channel + saved-tier MlsGroup.
async function seedMlsGroup(ownerId: string, memberIds: string[]) {
  const channel = await prisma.dMChannel.create({ data: { isGroup: true, encrypted: true, ownerId } });
  let t = Date.now();
  await prisma.dMParticipant.create({ data: { userId: ownerId, dmChannelId: channel.id, joinedAt: new Date(t++) } });
  for (const uid of memberIds) {
    await prisma.dMParticipant.create({ data: { userId: uid, dmChannelId: channel.id, joinedAt: new Date(t++) } });
  }
  const group = await prisma.mlsGroup.create({ data: { dmChannelId: channel.id, tier: 'saved' }, select: { id: true } });
  return { channelId: channel.id, mlsGroupId: group.id };
}

let owner: TestUser, member: TestUser, newcomer: TestUser;

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(() => { for (const c of clients) if (c.connected) c.disconnect(); clients.length = 0; });

afterAll(async () => {
  for (const c of clients) if (c.connected) c.disconnect();
  clients.length = 0;
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('POST /api/v1/dms/:id/members — MLS add bypass + real mlsGroupId', () => {
  it('owner adds a member to an MLS group: keyless add emits the real mlsGroupId on new-dm-channel', async () => {
    owner = await createTestUser();
    member = await createTestUser();
    newcomer = await createTestUser();
    const { channelId, mlsGroupId } = await seedMlsGroup(owner.id, [member.id]);

    const newcomerSock = await connect(newcomer.token);
    const payloadP = waitForNewDmChannel(newcomerSock, channelId);

    const res = await request(app)
      .post(`/api/v1/dms/${channelId}/members`)
      .set('Authorization', authHeader(owner.token))
      .send({ memberIds: [newcomer.id] }); // NO encryptedKeys / senderPublicKey — MLS add

    expect(res.status).toBe(200);

    const created = await prisma.dMParticipant.findUnique({
      where: { userId_dmChannelId: { userId: newcomer.id, dmChannelId: channelId } },
    });
    expect(created).not.toBeNull();

    const payload = await payloadP;
    expect(payload).not.toBeNull();
    expect(payload!.mlsGroupId).toBe(mlsGroupId);
  });
});
