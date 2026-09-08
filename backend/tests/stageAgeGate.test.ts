// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Stage age gate — access + read surfaces.
 *
 * The visibility pass hid a private / restricted stage's existence, topic, and roster from
 * NON-VIEWERS, but the age-gate class was deferred: a minor member of a PUBLIC
 * `ageRestricted = true` stage channel could still JOIN the audience, READ the
 * live session (topic + speaker roster) via GET /stage, READ past sessions via
 * GET /stage/history, and — as a `manageStages` host who started the stage and
 * thereby landed in the Redis speaker set — mint a stage LiveKit media token.
 *
 * The scenario is deliberately a PUBLIC age-restricted stage so the channel
 * view/read gate passes for everyone and ONLY the age gate distinguishes the
 * minor (403 `age_restricted` / socket ack error) from the adult.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { app, httpServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { addToSet, clearStageState } from '../src/routes/stages.js';
import { createTestUser, createTestServer, authHeader, cleanupTestData, type TestUser } from './helpers.js';

const BASELINE_PERMS = { viewChannels: true, readMessageHistory: true, connect: true };

function expectAgeGated(res: { status: number; body: any }, label: string) {
  expect(res.status, label).toBe(403);
  expect(res.body.error, label).toBe('age_restricted');
  expect(typeof res.body.message, label).toBe('string');
}

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

describe('Stage age gate — join / GET /stage / history / livekit token', () => {
  let owner: TestUser;  // adult (helper default DOB 2000-01-15), owner → manageStages bypass
  let adult: TestUser;  // explicit adult DOB
  let minor: TestUser;  // 14 today
  let s: string;
  let arStage: string;    // public stage, ageRestricted = true (active + ended sessions)
  let safeStage: string;  // public stage, ageRestricted = false (scoping control)

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      if (httpServer.listening) return resolve();
      httpServer.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    owner = await createTestUser();
    adult = await createTestUser();
    await prisma.user.update({ where: { id: adult.id }, data: { dateOfBirth: new Date('1990-01-01') } });
    minor = await createTestUser();
    const fourteen = new Date();
    fourteen.setUTCFullYear(fourteen.getUTCFullYear() - 14);
    await prisma.user.update({ where: { id: minor.id }, data: { dateOfBirth: fourteen } });

    const server = await createTestServer(owner.id);
    s = server.id;
    const categoryId = server.categories[0].id;
    await prisma.serverMember.create({ data: { userId: adult.id, serverId: s, role: 'member' } });
    await prisma.serverMember.create({ data: { userId: minor.id, serverId: s, role: 'member' } });
    await prisma.serverRole.create({
      data: { id: randomUUID(), serverId: s, name: '@everyone', position: 0, isEveryone: true, permissions: BASELINE_PERMS },
    });

    const mkStage = (name: string, ageRestricted: boolean) =>
      prisma.channel.create({
        data: { id: randomUUID(), serverId: s, name, type: 'stage', categoryId, position: 0, isPrivate: false, ageRestricted },
      });
    arStage = (await mkStage('ar-stage', true)).id;
    safeStage = (await mkStage('safe-stage', false)).id;

    // Active session on the AR stage (owner is an adult → can start).
    const start = await request(app)
      .post(`/api/v1/servers/${s}/channels/${arStage}/stage/start`)
      .set('Authorization', authHeader(owner.token))
      .send({ maxSpeakers: 10, textChatEnabled: true, allowEmojis: true, allowStickers: true, allowGifs: true });
    expect(start.status).toBe(201);

    // A past (ended) session so GET /stage/history returns a row.
    await prisma.stageSession.create({
      data: {
        channelId: arStage, serverId: s, topic: 'ADULT-ONLY-HISTORY', maxSpeakers: 10, startedById: owner.id,
        startedAt: new Date(Date.now() - 60_000), endedAt: new Date(Date.now() - 30_000),
      },
    });
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.disconnect();
  });

  afterAll(async () => {
    await clearStageState(arStage).catch(() => {});
    await prisma.notification.deleteMany({ where: { serverId: s } }).catch(() => {});
    await prisma.stageSession.deleteMany({ where: { serverId: s } }).catch(() => {});
    await cleanupTestData();
  });

  // ── GET /stage (live session: topic + roster) ──────────────────────────────
  it('GET /stage — minor 403 age_restricted, adult 200, safe stage not gated', async () => {
    const minorRes = await request(app)
      .get(`/api/v1/servers/${s}/channels/${arStage}/stage`)
      .set('Authorization', authHeader(minor.token));
    expectAgeGated(minorRes, 'GET /stage minor');

    const adultRes = await request(app)
      .get(`/api/v1/servers/${s}/channels/${arStage}/stage`)
      .set('Authorization', authHeader(adult.token));
    expect(adultRes.status, 'GET /stage adult').toBe(200);

    const safeRes = await request(app)
      .get(`/api/v1/servers/${s}/channels/${safeStage}/stage`)
      .set('Authorization', authHeader(minor.token));
    expect(safeRes.status, 'GET /stage minor on safe stage').toBe(200); // gate is scoped, not blanket
  });

  // ── GET /stage/history (past session topics) ───────────────────────────────
  it('GET /stage/history — minor 403 age_restricted, adult 200', async () => {
    const minorRes = await request(app)
      .get(`/api/v1/servers/${s}/channels/${arStage}/stage/history`)
      .set('Authorization', authHeader(minor.token));
    expectAgeGated(minorRes, 'GET /stage/history minor');
    expect(JSON.stringify(minorRes.body), 'history leaked adult topic').not.toMatch(/ADULT-ONLY-HISTORY/);

    const adultRes = await request(app)
      .get(`/api/v1/servers/${s}/channels/${arStage}/stage/history`)
      .set('Authorization', authHeader(adult.token));
    expect(adultRes.status, 'GET /stage/history adult').toBe(200);
  });

  // ── livekit token (media path) — the minor-host-via-start bypass ───────────
  it('POST /livekit/token stage — minor in speaker set is denied age_restricted; adult is not', async () => {
    // Simulate the bypass: a minor host who started the stage lands in the
    // speaker set (POST /stage/start line ~344). Without the parallel age gate
    // they could mint a media token despite the socket join gate.
    await addToSet(arStage, 'speakers', minor.id);
    await addToSet(arStage, 'speakers', adult.id);

    const minorRes = await request(app)
      .post('/api/v1/livekit/token')
      .set('Authorization', authHeader(minor.token))
      .send({ roomName: `stage:${arStage}`, participantName: 'Minor' });
    expect(minorRes.status, 'token minor').toBe(403);
    expect(minorRes.body.error, 'token minor').toBe('age_restricted');

    const adultRes = await request(app)
      .post('/api/v1/livekit/token')
      .set('Authorization', authHeader(adult.token))
      .send({ roomName: `stage:${arStage}`, participantName: 'Adult' });
    expect(adultRes.body?.error, 'token adult not age-gated').not.toBe('age_restricted');
  });

  // ── socket stage-join-audience (authoritative membership gate) ─────────────
  it('stage-join-audience — minor is denied, adult joins the active session', async () => {
    const minorSock = await connectSocket(minor.token);
    const minorResp = await joinStage(minorSock, arStage);
    expect(minorResp.ok, 'minor join blocked').toBe(false);
    expect(minorResp.error ?? '', 'minor join age message').toMatch(/age-restricted|18 or older/i);

    const adultSock = await connectSocket(adult.token);
    const adultResp = await joinStage(adultSock, arStage);
    expect(adultResp.ok, 'adult join allowed').toBe(true);
  });

  it('stage-join-audience — minor joins a NON-age-restricted stage normally (scoped, not blanket)', async () => {
    // safeStage has no active session, so the join fails at the session check —
    // NOT the age gate. Proves the gate is conditional on ageRestricted.
    const minorSock = await connectSocket(minor.token);
    const resp = await joinStage(minorSock, safeStage);
    expect(resp.error ?? '').not.toMatch(/age-restricted|18 or older/i);
  });
});
