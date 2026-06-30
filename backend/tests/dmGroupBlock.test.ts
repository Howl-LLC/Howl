// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression tests for bidirectional block on every group-DM action
 * (write paths + emit fan-out + pins read filter).
 *
 * Bug shape this guards against: a check like `hasBlockBetween(req.userId,
 * other)` wrapped in `if (!isGroup)` makes groups skip the check entirely.
 * User A who blocked User B would still receive B's pins/edits/deletes/
 * reactions in real time inside any shared group DM, and B could write to a
 * group containing A.
 *
 * Semantics: writes are allowed; the fan-out filter (via
 * `emitToDmExceptBlocked` and the inline `getUserIdsWithBlock` filter on the
 * send path) prevents blocked pairs from seeing each other's actions while
 * both can still participate with the unblocked members of the group. A
 * write-veto (any block between actor and ANY participant returns 403) is
 * deliberately avoided: it breaks real conversations and interacts badly
 * with frontend retry/refresh logic.
 *
 * Three users (A, B, C) are placed in the same group DM. A blocks B.
 * Assertions:
 *   1. B's send/pin/unpin/edit/react/delete all succeed (200/201/204).
 *   2. None of B's actions reach A's socket (emit fan-out filter).
 *   3. A's reads via `GET /pins` exclude any pins authored by B.
 *   4. C's send reaches BOTH A and B (sanity check on emit fan-out for
 *      an unblocked sender — also pins down the contract for the still-
 *      open frontend bug where B sees no events at all in the group).
 *
 * Postgres-required (uses createTestUser + DM channel fixture). Local run
 * fails at setup; CI's `postgres:16` service container runs it.
 */

import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import type { AddressInfo } from 'net';
import { app, httpServer } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';
import { randomUUID } from 'crypto';

let userA: TestUser; // blocker
let userB: TestUser; // blocked by A — writes succeed but emit is filtered
let userC: TestUser; // unrelated third party — full visibility both ways
let groupId: string;
let aMessageId: string; // A's message that B will react/pin
let bMessageId: string; // B's message that A's pin-read filter must drop
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
  // join-dm is a fire-and-forget emit; give the server a tick to call
  // socket.join before any HTTP request that fans out to dm:<id>.
  return new Promise((resolve) => {
    sock.emit('join-dm', dmChannelId);
    setTimeout(resolve, 100);
  });
}

// Resolves with all events of `event` collected during `windowMs`.
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

  userA = await createTestUser();
  userB = await createTestUser();
  userC = await createTestUser();

  groupId = randomUUID();
  // Group DM channel — default `encrypted: false` (schema default; we omit
  // the field to satisfy the db.ts encryption-downgrade guard which trips
  // on any explicit `encrypted: false`). Block check fires BEFORE the
  // encrypted-channel E2E content check, so plaintext fixtures are fine
  // for the regression scope.
  await prisma.dMChannel.create({
    data: { id: groupId, isGroup: true },
  });
  await prisma.dMParticipant.createMany({
    data: [
      { userId: userA.id, dmChannelId: groupId },
      { userId: userB.id, dmChannelId: groupId },
      { userId: userC.id, dmChannelId: groupId },
    ],
  });

  // Seed: A authors a message (so B has something to react/pin).
  // B authors a message (so A's pin-read can prove the read filter works,
  // and so B has a message of their own to edit/delete).
  const aMsg = await prisma.dMMessage.create({
    data: {
      id: randomUUID(),
      dmChannelId: groupId,
      authorId: userA.id,
      content: 'message from A',
      encryptionVersion: 1,
    },
  });
  aMessageId = aMsg.id;
  const bMsg = await prisma.dMMessage.create({
    data: {
      id: randomUUID(),
      dmChannelId: groupId,
      authorId: userB.id,
      content: 'message from B',
      encryptionVersion: 1,
    },
  });
  bMessageId = bMsg.id;
  // Pre-pin B's message so A's GET /pins read can verify the filter strips it.
  await prisma.dMPinnedMessage.create({
    data: { dmChannelId: groupId, messageId: bMessageId, pinnedById: userB.id },
  });

  // A blocks B (one-direction is sufficient — `getUserIdsWithBlock` looks at
  // both directions).
  await prisma.block.create({
    data: { blockerId: userA.id, blockedUserId: userB.id },
  });
});

// Disconnect each test's sockets before the next one connects. Without this,
// every `connect()` (forceNew) leaves a live socket in the dm: room for the
// whole file; by the later tests ~12-16 accumulated websockets contend on the
// event loop and emit delivery slips past the 600ms collection window, so the
// fan-out assertions fail deterministically. Capping concurrent sockets per
// test keeps delivery well inside the window.
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

describe('group-DM block: writes succeed, emit fan-out filtered', () => {
  it("B's send into the group succeeds and A's socket does NOT receive new-dm-message", async () => {
    const aSock = await connect(userA.token);
    const cSock = await connect(userC.token);
    await Promise.all([joinDm(aSock, groupId), joinDm(cSock, groupId)]);

    const aEvents = collectEvents<{ authorId: string }>(aSock, 'new-dm-message');
    const cEvents = collectEvents<{ authorId: string }>(cSock, 'new-dm-message');

    const res = await request(app)
      .post(`/api/dms/${groupId}/messages`)
      .set('Authorization', authHeader(userB.token))
      .send({ content: 'hi everyone' });
    expect(res.status).toBe(201);

    const [forA, forC] = await Promise.all([aEvents, cEvents]);
    expect(forA.find((e) => e.authorId === userB.id)).toBeUndefined();
    expect(forC.find((e) => e.authorId === userB.id)).toBeDefined();
  });

  it("B's pin succeeds and A's socket does NOT receive dm-message-pinned", async () => {
    const aSock = await connect(userA.token);
    const cSock = await connect(userC.token);
    await Promise.all([joinDm(aSock, groupId), joinDm(cSock, groupId)]);

    const aEvents = collectEvents<{ messageId: string }>(aSock, 'dm-message-pinned');
    const cEvents = collectEvents<{ messageId: string }>(cSock, 'dm-message-pinned');

    const res = await request(app)
      .post(`/api/dms/${groupId}/messages/${aMessageId}/pin`)
      .set('Authorization', authHeader(userB.token));
    expect(res.status).toBe(201);

    const [forA, forC] = await Promise.all([aEvents, cEvents]);
    expect(forA.find((e) => e.messageId === aMessageId)).toBeUndefined();
    expect(forC.find((e) => e.messageId === aMessageId)).toBeDefined();
  });

  it("B's unpin succeeds and A's socket does NOT receive dm-message-unpinned", async () => {
    const aSock = await connect(userA.token);
    const cSock = await connect(userC.token);
    await Promise.all([joinDm(aSock, groupId), joinDm(cSock, groupId)]);

    const aEvents = collectEvents<{ messageId: string }>(aSock, 'dm-message-unpinned');
    const cEvents = collectEvents<{ messageId: string }>(cSock, 'dm-message-unpinned');

    const res = await request(app)
      .delete(`/api/dms/${groupId}/messages/${bMessageId}/pin`)
      .set('Authorization', authHeader(userB.token));
    expect(res.status).toBe(204);

    const [forA, forC] = await Promise.all([aEvents, cEvents]);
    expect(forA.find((e) => e.messageId === bMessageId)).toBeUndefined();
    expect(forC.find((e) => e.messageId === bMessageId)).toBeDefined();
  });

  it("B's edit of their own message succeeds and A's socket does NOT receive dm-message-updated", async () => {
    const aSock = await connect(userA.token);
    const cSock = await connect(userC.token);
    await Promise.all([joinDm(aSock, groupId), joinDm(cSock, groupId)]);

    const aEvents = collectEvents<{ messageId: string }>(aSock, 'dm-message-updated');
    const cEvents = collectEvents<{ messageId: string }>(cSock, 'dm-message-updated');

    const res = await request(app)
      .patch(`/api/dms/${groupId}/messages/${bMessageId}`)
      .set('Authorization', authHeader(userB.token))
      .send({ content: 'edited by B' });
    expect(res.status).toBe(200);

    const [forA, forC] = await Promise.all([aEvents, cEvents]);
    expect(forA.find((e) => e.messageId === bMessageId)).toBeUndefined();
    expect(forC.find((e) => e.messageId === bMessageId)).toBeDefined();
  });

  it("B's reaction on A's message succeeds and A's socket does NOT receive dm-message-reaction-update", async () => {
    const aSock = await connect(userA.token);
    const cSock = await connect(userC.token);
    await Promise.all([joinDm(aSock, groupId), joinDm(cSock, groupId)]);

    const aEvents = collectEvents<{ messageId: string }>(aSock, 'dm-message-reaction-update');
    const cEvents = collectEvents<{ messageId: string }>(cSock, 'dm-message-reaction-update');

    const res = await request(app)
      .put(`/api/dms/${groupId}/messages/${aMessageId}/reactions`)
      .set('Authorization', authHeader(userB.token))
      .send({ emoji: '\u{1F44D}' });
    expect(res.status).toBe(200);

    const [forA, forC] = await Promise.all([aEvents, cEvents]);
    expect(forA.find((e) => e.messageId === aMessageId)).toBeUndefined();
    expect(forC.find((e) => e.messageId === aMessageId)).toBeDefined();
  });

  it("B's delete of their own message succeeds and A's socket does NOT receive dm-message-deleted", async () => {
    // Use a fresh B-authored message so we don't disturb `bMessageId` (still
    // referenced by the pin-read assertion below).
    const bDeletable = await prisma.dMMessage.create({
      data: {
        id: randomUUID(),
        dmChannelId: groupId,
        authorId: userB.id,
        content: 'deletable B msg',
        encryptionVersion: 1,
      },
    });

    const aSock = await connect(userA.token);
    const cSock = await connect(userC.token);
    await Promise.all([joinDm(aSock, groupId), joinDm(cSock, groupId)]);

    const aEvents = collectEvents<{ messageId: string }>(aSock, 'dm-message-deleted');
    const cEvents = collectEvents<{ messageId: string }>(cSock, 'dm-message-deleted');

    const res = await request(app)
      .delete(`/api/dms/${groupId}/messages/${bDeletable.id}`)
      .set('Authorization', authHeader(userB.token));
    expect(res.status).toBe(204);

    const [forA, forC] = await Promise.all([aEvents, cEvents]);
    expect(forA.find((e) => e.messageId === bDeletable.id)).toBeUndefined();
    expect(forC.find((e) => e.messageId === bDeletable.id)).toBeDefined();
  });

  it("A reads /pins — B's previously pinned message is filtered out", async () => {
    // After the unpin assertion above, B's pin is gone. Re-pin B's message
    // directly via prisma so the read-filter assertion stays self-contained
    // regardless of test execution order.
    await prisma.dMPinnedMessage.upsert({
      where: { dmChannelId_messageId: { dmChannelId: groupId, messageId: bMessageId } },
      create: { dmChannelId: groupId, messageId: bMessageId, pinnedById: userB.id },
      update: {},
    });
    const res = await request(app)
      .get(`/api/dms/${groupId}/pins`)
      .set('Authorization', authHeader(userA.token));
    expect(res.status).toBe(200);
    const pinnedIds = (res.body?.pins ?? []).map((p: { id: string }) => p.id);
    expect(pinnedIds).not.toContain(bMessageId);
  });

  it("C's send reaches BOTH A and B — emit fan-out for an unblocked sender is unaffected", async () => {
    // Pins down the bidirectional invariant: A↔B don't see each other's
    // events, but BOTH still receive C's events. This is the contract
    // covered by `emitToDmExceptBlocked` / inline send-path emit using
    // `getUserIdsWithBlock(senderUserId)` — the blocked set is computed
    // for C (the sender), which has no blocks, so the emit must hit
    // every participant.
    const aSock = await connect(userA.token);
    const bSock = await connect(userB.token);
    await Promise.all([joinDm(aSock, groupId), joinDm(bSock, groupId)]);

    const aEvents = collectEvents<{ authorId: string }>(aSock, 'new-dm-message');
    const bEvents = collectEvents<{ authorId: string }>(bSock, 'new-dm-message');

    const res = await request(app)
      .post(`/api/dms/${groupId}/messages`)
      .set('Authorization', authHeader(userC.token))
      .send({ content: 'hello from C' });
    expect(res.status).toBe(201);

    const [forA, forB] = await Promise.all([aEvents, bEvents]);
    expect(forA.find((e) => e.authorId === userC.id)).toBeDefined();
    expect(forB.find((e) => e.authorId === userC.id)).toBeDefined();
  });

  it("A (the blocker) can still send into the group", async () => {
    const res = await request(app)
      .post(`/api/dms/${groupId}/messages`)
      .set('Authorization', authHeader(userA.token))
      .send({ content: 'hello from A' });
    expect(res.status).toBe(201);
  });
});
