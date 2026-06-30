// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * OTR DM-list surfacing.
 *
 * The DM-list endpoint GET /dms must surface the OTR group alongside the saved
 * group, per DM item:
 *   - mlsGroupId      = the saved-tier group's id (unchanged), or null
 *   - otrMlsGroupId   = the otr-tier group's id, or null when none exists
 *   - otrMlsGroupEpoch = the otr group's currentEpoch as a string, or null
 *
 * The client uses otrMlsGroupId to resolve/join the OTR group. BigInt epochs are
 * serialized via .toString() (never a raw BigInt in JSON).
 *
 * The socket delivery / fan-out portions live further down in this file.
 */
import { describe, it, expect, afterAll, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { AddressInfo } from 'net';
import { app, httpServer } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';
import { parseSocketPayload, otrMessagePayload } from '../src/socketSchemas.js';
import { __resetOtrQueueForTest, type OtrEnvelope } from '../src/otrQueue.js';
import { randomUUID } from 'crypto';

let userA: TestUser;
let userB: TestUser;
let savedOnlyChannelId: string;
let savedOnlyGroupId: string;
let bothChannelId: string;
let bothSavedGroupId: string;
let bothOtrGroupId: string;

beforeAll(async () => {
  userA = await createTestUser();
  userB = await createTestUser();

  // Channel 1: a saved group only (no OTR).
  const savedOnly = await prisma.dMChannel.create({
    data: { encrypted: true, participants: { create: [{ userId: userA.id }, { userId: userB.id }] } },
    select: { id: true },
  });
  savedOnlyChannelId = savedOnly.id;
  const savedOnlyGroup = await prisma.mlsGroup.create({
    data: { dmChannelId: savedOnlyChannelId, tier: 'saved' },
    select: { id: true },
  });
  savedOnlyGroupId = savedOnlyGroup.id;

  // Channel 2: BOTH a saved and an otr group (one row per tier — the
  // @@unique([dmChannelId, tier]) constraint allows exactly one each).
  const both = await prisma.dMChannel.create({
    data: { encrypted: true, participants: { create: [{ userId: userA.id }, { userId: userB.id }] } },
    select: { id: true },
  });
  bothChannelId = both.id;
  const bothSaved = await prisma.mlsGroup.create({
    data: { dmChannelId: bothChannelId, tier: 'saved' },
    select: { id: true },
  });
  bothSavedGroupId = bothSaved.id;
  const bothOtr = await prisma.mlsGroup.create({
    data: { dmChannelId: bothChannelId, tier: 'otr' },
    select: { id: true },
  });
  bothOtrGroupId = bothOtr.id;
});

afterAll(async () => {
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
});

type DmListItem = {
  id: string;
  mlsGroupId: string | null;
  otrMlsGroupId: string | null;
  otrMlsGroupEpoch: string | null;
};

describe('GET /api/dms — OTR group surfaced in the DM-list include', () => {
  it('carries the OTR group id + epoch when an otr group exists, alongside the saved id', async () => {
    const res = await request(app)
      .get('/api/dms')
      .set('Authorization', authHeader(userA.token));
    expect(res.status).toBe(200);
    const entry = (res.body as DmListItem[]).find((d) => d.id === bothChannelId);
    expect(entry).toBeTruthy();
    expect(entry!.mlsGroupId).toBe(bothSavedGroupId);
    expect(entry!.otrMlsGroupId).toBe(bothOtrGroupId);
    expect(entry!.otrMlsGroupEpoch).toBe('0'); // currentEpoch BigInt default 0, serialized as a string
  });

  it('returns otrMlsGroupId=null and otrMlsGroupEpoch=null when only a saved group exists', async () => {
    const res = await request(app)
      .get('/api/dms')
      .set('Authorization', authHeader(userA.token));
    expect(res.status).toBe(200);
    const entry = (res.body as DmListItem[]).find((d) => d.id === savedOnlyChannelId);
    expect(entry).toBeTruthy();
    expect(entry!.mlsGroupId).toBe(savedOnlyGroupId);
    expect(entry!.otrMlsGroupId).toBeNull();
    expect(entry!.otrMlsGroupEpoch).toBeNull();
  });
});

describe('otrMessagePayload — socket schema', () => {
  // Valid v4 UUIDs (version nibble 4, variant nibble 8): Zod 4.x .uuid() rejects
  // the all-ones placeholder, so fixtures must be real RFC-4122 UUIDs.
  const valid = {
    dmChannelId: '11111111-1111-4111-8111-111111111111',
    mlsGroupId: '22222222-2222-4222-8222-222222222222',
    clientMsgId: '33333333-3333-4333-8333-333333333333',
    ciphertext: 'dGVzdC1jaXBoZXJ0ZXh0', // non-empty base64
  };

  it('parse-accepts a valid otr-message payload', () => {
    const parsed = parseSocketPayload(otrMessagePayload, valid);
    expect(parsed).not.toBeNull();
    expect(parsed!.dmChannelId).toBe(valid.dmChannelId);
    expect(parsed!.ciphertext).toBe(valid.ciphertext);
  });

  it('parse-rejects a non-UUID dmChannelId', () => {
    const parsed = parseSocketPayload(otrMessagePayload, { ...valid, dmChannelId: 'not-a-uuid' });
    expect(parsed).toBeNull();
  });

  it('accepts unknown extra fields (passthrough, old-client safe)', () => {
    const parsed = parseSocketPayload(otrMessagePayload, { ...valid, futureField: 'ok' });
    expect(parsed).not.toBeNull();
    expect((parsed as Record<string, unknown>).futureField).toBe('ok');
  });
});

// OTR socket delivery (send / fan-out / enqueue / ack / pull)
//
// Uses the real socket.io client harness (mirrors tests/socket.test.ts). The
// server joins each connected socket to `user:<id>`, so fan-out via
// socket.to(`user:<pid>`) reaches the other participant's live socket and
// auto-excludes the sender's own socket. Redis is null in tests, so the
// in-memory otrQueue path is exercised for the offline → pull case.

describe('Socket.IO OTR delivery', () => {
  let baseUrl: string;
  const sockets: ClientSocket[] = [];

  function connect(token: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        transports: ['websocket'],
        auth: { token },
        forceNew: true,
        reconnection: false,
      });
      sockets.push(socket);
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', (err) => reject(err));
      setTimeout(() => reject(new Error('Socket connection timeout')), 5000);
    });
  }

  // Each test builds its own users + channel so suites don't share state.
  async function makeOtrDm(): Promise<{ sender: TestUser; recipient: TestUser; dmChannelId: string; otrGroupId: string }> {
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const dm = await prisma.dMChannel.create({
      data: { encrypted: true, participants: { create: [{ userId: sender.id }, { userId: recipient.id }] } },
      select: { id: true },
    });
    const grp = await prisma.mlsGroup.create({
      data: { dmChannelId: dm.id, tier: 'otr' },
      select: { id: true },
    });
    return { sender, recipient, dmChannelId: dm.id, otrGroupId: grp.id };
  }

  const ciphertext = 'dGVzdC1vdHItY2lwaGVydGV4dA=='; // opaque base64; never inspected

  beforeAll(async () => {
    await new Promise<void>((resolve) => { httpServer.listen(0, () => resolve()); });
    const addr = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    for (const s of sockets) { if (s.connected) s.disconnect(); }
    sockets.length = 0;
    __resetOtrQueueForTest();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
  });

  it('fans out to the other online participant, excludes the sender, and persists no DMMessage', async () => {
    const { sender, recipient, dmChannelId, otrGroupId } = await makeOtrDm();
    const clientMsgId = randomUUID();

    const senderSock = await connect(sender.token);
    const recipientSock = await connect(recipient.token);
    // Let the connection handler finish joining the `user:<id>` rooms.
    await new Promise((r) => setTimeout(r, 300));

    const recvPromise = new Promise<OtrEnvelope>((resolve) => {
      recipientSock.on('otr-message', (env: OtrEnvelope) => resolve(env));
    });
    let senderSelfEcho = false;
    senderSock.on('otr-message', () => { senderSelfEcho = true; });

    senderSock.emit('otr-message', { dmChannelId, mlsGroupId: otrGroupId, clientMsgId, ciphertext });

    const env = await Promise.race([
      recvPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('otr-message not received')), 2000)),
    ]);
    expect(env.clientMsgId).toBe(clientMsgId);
    expect(env.authorId).toBe(sender.id);
    expect(env.dmChannelId).toBe(dmChannelId);
    expect(env.mlsGroupId).toBe(otrGroupId);
    expect(env.ciphertext).toBe(ciphertext);
    expect(typeof env.createdAt).toBe('number');

    // The sender's own socket must NOT receive the relayed envelope.
    expect(senderSelfEcho).toBe(false);

    // OTR is ephemeral: no durable DMMessage row is ever written.
    const count = await prisma.dMMessage.count({ where: { dmChannelId } });
    expect(count).toBe(0);
  });

  it('queues for an offline recipient, delivers on pull, and clears on ack', async () => {
    const { sender, recipient, dmChannelId, otrGroupId } = await makeOtrDm();
    const clientMsgId = randomUUID();

    // Recipient is NOT connected → no `user:<id>` room → enqueue fires.
    const senderSock = await connect(sender.token);
    await new Promise((r) => setTimeout(r, 200));

    senderSock.emit('otr-message', { dmChannelId, mlsGroupId: otrGroupId, clientMsgId, ciphertext });
    // Let the send handler run its enqueue (no live recipient socket).
    await new Promise((r) => setTimeout(r, 400));

    // Recipient reconnects and pulls the queued envelope.
    const recipientSock = await connect(recipient.token);
    await new Promise((r) => setTimeout(r, 200));

    const pulled = await new Promise<OtrEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('otr-pull returned nothing')), 2000);
      recipientSock.on('otr-message', (env: OtrEnvelope) => { clearTimeout(timer); resolve(env); });
      recipientSock.emit('otr-pull', {});
    });
    expect(pulled.clientMsgId).toBe(clientMsgId);
    expect(pulled.authorId).toBe(sender.id);

    // Ack drains the queued item; a second pull returns nothing.
    recipientSock.emit('otr-ack', { clientMsgId });
    await new Promise((r) => setTimeout(r, 300));

    let secondPullReceived = false;
    recipientSock.on('otr-message', () => { secondPullReceived = true; });
    recipientSock.emit('otr-pull', {});
    await new Promise((r) => setTimeout(r, 500));
    expect(secondPullReceived).toBe(false);
  });

  it('does not deliver when the sender is not a participant of the channel', async () => {
    const { recipient, dmChannelId, otrGroupId } = await makeOtrDm();
    const outsider = await createTestUser();
    const clientMsgId = randomUUID();

    const outsiderSock = await connect(outsider.token);
    const recipientSock = await connect(recipient.token);
    await new Promise((r) => setTimeout(r, 300));

    let recipientReceived = false;
    recipientSock.on('otr-message', () => { recipientReceived = true; });

    // No throw, no delivery: the participant guard rejects the non-participant.
    outsiderSock.emit('otr-message', { dmChannelId, mlsGroupId: otrGroupId, clientMsgId, ciphertext });
    await new Promise((r) => setTimeout(r, 600));

    expect(recipientReceived).toBe(false);
    expect(outsiderSock.connected).toBe(true);
    const count = await prisma.dMMessage.count({ where: { dmChannelId } });
    expect(count).toBe(0);
  });

  it('does not deliver when the channel has no tier:otr group', async () => {
    // A saved-only channel: an otr-message naming the saved group id must be rejected.
    const sender = await createTestUser();
    const recipient = await createTestUser();
    const dm = await prisma.dMChannel.create({
      data: { encrypted: true, participants: { create: [{ userId: sender.id }, { userId: recipient.id }] } },
      select: { id: true },
    });
    const savedGroup = await prisma.mlsGroup.create({
      data: { dmChannelId: dm.id, tier: 'saved' },
      select: { id: true },
    });
    const clientMsgId = randomUUID();

    const senderSock = await connect(sender.token);
    const recipientSock = await connect(recipient.token);
    await new Promise((r) => setTimeout(r, 300));

    let recipientReceived = false;
    recipientSock.on('otr-message', () => { recipientReceived = true; });

    senderSock.emit('otr-message', { dmChannelId: dm.id, mlsGroupId: savedGroup.id, clientMsgId, ciphertext });
    await new Promise((r) => setTimeout(r, 600));

    expect(recipientReceived).toBe(false);
    expect(senderSock.connected).toBe(true);
  });
});
