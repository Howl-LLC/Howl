// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Exclude pendingRemoval members from the DM-message realtime fan-out.
 *
 * Two-phase group-DM eviction (kick/leave) marks a participant `pendingRemoval`
 * but keeps the DMParticipant row until the MLS Remove commit lands. The kick
 * route does `socketsLeave('dm:<id>')` (removing the evictee from the dm: room)
 * but does NOT remove their personal `user:<id>` room. So the new-dm-message
 * fan-out's user-room fallback still reached them, and — since their MLS leaf is
 * still at the pre-eviction epoch — they could decrypt messages sent in the
 * window between the REST kick/leave and the Remove commit.
 *
 * This fix excludes pendingRemoval participants from the realtime fan-out
 * recipient set (both the dm: room loop and the user: room fallback). The
 * message is still PERSISTED; only realtime delivery to a pending-removal member
 * is suppressed. Normal recipients and the sender are unaffected.
 *
 * Three users: owner (sender), normal (must receive), pending (pendingRemoval —
 * must NOT receive). Postgres-required (CI postgres:16 service container).
 */

import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import type { AddressInfo } from 'net';
import { app, httpServer } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';
import { randomUUID } from 'crypto';

let owner: TestUser;   // sender — a normal, non-pendingRemoval member
let normal: TestUser;  // normal recipient — must receive (positive control)
let pending: TestUser; // pendingRemoval recipient — must NOT receive
let groupId: string;
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

function joinDm(sock: ClientSocket, dmChannelId: string): Promise<void> {
  return new Promise((resolve) => {
    sock.emit('join-dm', dmChannelId);
    setTimeout(resolve, 100);
  });
}

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

  owner = await createTestUser();
  normal = await createTestUser();
  pending = await createTestUser();

  groupId = randomUUID();
  // Group DM — default `encrypted: false` (omit the field to satisfy the
  // encryption-downgrade guard which trips on explicit `encrypted: false`).
  // The fan-out recipient set is built the same way for plaintext and E2E
  // channels, so a plaintext fixture exercises the same code path.
  await prisma.dMChannel.create({
    data: { id: groupId, isGroup: true, ownerId: owner.id },
  });
  await prisma.dMParticipant.createMany({
    data: [
      { userId: owner.id, dmChannelId: groupId },
      { userId: normal.id, dmChannelId: groupId },
      // `pending` is marked pendingRemoval directly — mirrors the post-kick state.
      { userId: pending.id, dmChannelId: groupId, pendingRemoval: new Date() },
    ],
  });
});

afterEach(() => {
  for (const c of clients) { if (c.connected) c.disconnect(); }
  clients.length = 0;
});

afterAll(async () => {
  for (const c of clients) { if (c.connected) c.disconnect(); }
  clients.length = 0;
  await cleanupTestData();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('pendingRemoval member excluded from new-dm-message fan-out', () => {
  it('owner send: normal member receives, pendingRemoval member does NOT', async () => {
    const normalSock = await connect(normal.token);
    const pendingSock = await connect(pending.token);
    // Both join the dm: room. The pendingRemoval member must be dropped from
    // BOTH the dm: room loop and the user: room fallback.
    await Promise.all([joinDm(normalSock, groupId), joinDm(pendingSock, groupId)]);

    const normalEvents = collectEvents<{ authorId: string }>(normalSock, 'new-dm-message');
    const pendingEvents = collectEvents<{ authorId: string }>(pendingSock, 'new-dm-message');

    const res = await request(app)
      .post(`/api/dms/${groupId}/messages`)
      .set('Authorization', authHeader(owner.token))
      .send({ content: 'hi from owner' });
    expect(res.status).toBe(201);

    const [forNormal, forPending] = await Promise.all([normalEvents, pendingEvents]);
    // Positive control: the normal member receives the message.
    expect(forNormal.find((e) => e.authorId === owner.id)).toBeDefined();
    // The fix: the pendingRemoval member receives nothing.
    expect(forPending.find((e) => e.authorId === owner.id)).toBeUndefined();
  });

  it('user-room fallback: pendingRemoval member NOT in the dm: room still receives nothing', async () => {
    // Reproduces the exact kick-window path: the evictee was removed from the
    // dm: room via socketsLeave but their user: room survives. Only the normal
    // member joins the dm: room; the pendingRemoval member relies solely on the
    // user: room fallback, which must also exclude them.
    const normalSock = await connect(normal.token);
    const pendingSock = await connect(pending.token);
    await joinDm(normalSock, groupId); // pending deliberately does NOT join dm:

    const normalEvents = collectEvents<{ authorId: string }>(normalSock, 'new-dm-message');
    const pendingEvents = collectEvents<{ authorId: string }>(pendingSock, 'new-dm-message');

    const res = await request(app)
      .post(`/api/dms/${groupId}/messages`)
      .set('Authorization', authHeader(owner.token))
      .send({ content: 'second message' });
    expect(res.status).toBe(201);

    const [forNormal, forPending] = await Promise.all([normalEvents, pendingEvents]);
    expect(forNormal.find((e) => e.authorId === owner.id)).toBeDefined();
    expect(forPending.find((e) => e.authorId === owner.id)).toBeUndefined();
  });

  it('the suppressed message is still persisted to the DB', async () => {
    const before = await prisma.dMMessage.count({ where: { dmChannelId: groupId } });
    const res = await request(app)
      .post(`/api/dms/${groupId}/messages`)
      .set('Authorization', authHeader(owner.token))
      .send({ content: 'persisted regardless' });
    expect(res.status).toBe(201);
    const after = await prisma.dMMessage.count({ where: { dmChannelId: groupId } });
    expect(after).toBe(before + 1);
  });

  it('sibling fan-outs (edit / reaction / delete) also exclude the pendingRemoval member', async () => {
    // Seed an owner-authored message to edit/react/delete.
    const ownerMsg = await prisma.dMMessage.create({
      data: { id: randomUUID(), dmChannelId: groupId, authorId: owner.id, content: 'sibling target', encryptionVersion: 1 },
    });

    const normalSock = await connect(normal.token);
    const pendingSock = await connect(pending.token);
    await Promise.all([joinDm(normalSock, groupId), joinDm(pendingSock, groupId)]);

    // EDIT
    {
      const normalEvents = collectEvents<{ messageId: string }>(normalSock, 'dm-message-updated');
      const pendingEvents = collectEvents<{ messageId: string }>(pendingSock, 'dm-message-updated');
      const res = await request(app)
        .patch(`/api/dms/${groupId}/messages/${ownerMsg.id}`)
        .set('Authorization', authHeader(owner.token))
        .send({ content: 'edited by owner' });
      expect(res.status).toBe(200);
      const [forNormal, forPending] = await Promise.all([normalEvents, pendingEvents]);
      expect(forNormal.find((e) => e.messageId === ownerMsg.id)).toBeDefined();
      expect(forPending.find((e) => e.messageId === ownerMsg.id)).toBeUndefined();
    }

    // REACTION
    {
      const normalEvents = collectEvents<{ messageId: string }>(normalSock, 'dm-message-reaction-update');
      const pendingEvents = collectEvents<{ messageId: string }>(pendingSock, 'dm-message-reaction-update');
      const res = await request(app)
        .put(`/api/dms/${groupId}/messages/${ownerMsg.id}/reactions`)
        .set('Authorization', authHeader(owner.token))
        .send({ emoji: '\u{1F44D}' });
      expect(res.status).toBe(200);
      const [forNormal, forPending] = await Promise.all([normalEvents, pendingEvents]);
      expect(forNormal.find((e) => e.messageId === ownerMsg.id)).toBeDefined();
      expect(forPending.find((e) => e.messageId === ownerMsg.id)).toBeUndefined();
    }

    // DELETE
    {
      const normalEvents = collectEvents<{ messageId: string }>(normalSock, 'dm-message-deleted');
      const pendingEvents = collectEvents<{ messageId: string }>(pendingSock, 'dm-message-deleted');
      const res = await request(app)
        .delete(`/api/dms/${groupId}/messages/${ownerMsg.id}`)
        .set('Authorization', authHeader(owner.token));
      expect(res.status).toBe(204);
      const [forNormal, forPending] = await Promise.all([normalEvents, pendingEvents]);
      expect(forNormal.find((e) => e.messageId === ownerMsg.id)).toBeDefined();
      expect(forPending.find((e) => e.messageId === ownerMsg.id)).toBeUndefined();
    }
  });
});
