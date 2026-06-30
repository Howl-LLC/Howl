// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { app, httpServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, createTestServer, authHeader, cleanupTestData } from './helpers.js';

// The SFU eviction on timeout is useless if the timed-out user can immediately
// re-join the stage. Voice's join-voice-channel gates on
// isMemberTimedOut (voice.ts:250); stage-join-audience must do the same, else
// the eviction is trivially undone. We drive the gate through the real socket
// handler. The test vehicle is a timed-out OWNER (full perms → reaches the gate
// without needing @everyone-role seeding for a non-owner member).

let baseUrl: string;
const clients: ClientSocket[] = [];

function connectSocket(token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { transports: ['websocket'], auth: { token }, forceNew: true, reconnection: false });
    clients.push(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('Socket connection timeout')), 5000);
  });
}

function joinStage(socket: ClientSocket, channelId: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stage-join-audience ack timeout')), 5000);
    socket.emit('stage-join-audience', channelId, (resp: { ok: boolean; error?: string }) => {
      clearTimeout(timer);
      resolve(resp);
    });
  });
}

async function createStageChannel(serverId: string): Promise<string> {
  const cat = await prisma.channelCategory.findFirst({ where: { serverId } });
  const maxPos = await prisma.channel.aggregate({ where: { serverId, categoryId: cat?.id ?? null }, _max: { position: true } });
  const ch = await prisma.channel.create({
    data: {
      id: randomUUID(),
      name: `stage-${Date.now()}-${Math.floor(performance.now())}`,
      type: 'stage',
      serverId,
      categoryId: cat?.id ?? null,
      position: (maxPos._max.position ?? -1) + 1,
    },
  });
  return ch.id;
}

describe('stage-join-audience rejects timed-out members', () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      if (httpServer.listening) return resolve();
      httpServer.listen(0, () => resolve());
    });
    const addr = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.disconnect();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it('rejects a timed-out member from joining a stage as audience', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    const stageCh = await createStageChannel(server.id);
    // Time the owner out (the gate is a pure timeoutUntil check, role-agnostic).
    await prisma.serverMember.update({
      where: { userId_serverId: { userId: owner.id, serverId: server.id } },
      data: { timeoutUntil: new Date(Date.now() + 60 * 60 * 1000) },
    });

    const sock = await connectSocket(owner.token);
    const resp = await joinStage(sock, stageCh);

    expect(resp.ok).toBe(false);
    expect(resp.error ?? '').toMatch(/timed out/i);
  });

  it('does NOT block a member who is not timed out at the timeout gate', async () => {
    // No live stage session is started here, so the join still fails — but with
    // "No active stage", NOT the timeout rejection. This proves the gate is
    // conditional on isMemberTimedOut and never over-blocks a normal member.
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    const stageCh = await createStageChannel(server.id);

    const sock = await connectSocket(owner.token);
    const resp = await joinStage(sock, stageCh);

    expect(resp.error ?? '').not.toMatch(/timed out/i);
  });

  it('refuses to mint a stage LiveKit token for a timed-out member (defense in depth)', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    const stageCh = await createStageChannel(server.id);
    await prisma.serverMember.update({
      where: { userId_serverId: { userId: owner.id, serverId: server.id } },
      data: { timeoutUntil: new Date(Date.now() + 60 * 60 * 1000) },
    });

    const res = await request(app)
      .post('/api/v1/livekit/token')
      .set('Authorization', authHeader(owner.token))
      .send({ roomName: `stage:${stageCh}`, participantName: 'Owner' });

    expect(res.status).toBe(403);
    expect(res.body.error ?? '').toMatch(/timed out/i);
  });
});
