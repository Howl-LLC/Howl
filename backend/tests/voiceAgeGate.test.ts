// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Voice age gate — access + media surfaces.
 *
 * scoped the voice roster by VISIBILITY but deferred the age class: a
 * minor member of a PUBLIC `ageRestricted = true` voice channel could still JOIN
 * the channel over `join-voice-channel` and mint a voice LiveKit media token via
 * POST /livekit/token (the `stage` token leg was already age-gated by the stage work;
 * the `voice` leg was not). This locks the age gate on both:
 *
 *   - `join-voice-channel` socket handler — a minor is refused (ack ok:false,
 *     age message) AFTER the view gate (so the flag never leaks to a non-viewer)
 *     and BEFORE the Redis membership write, mirroring `stage-join-audience`.
 *   - POST /livekit/token (roomType `voice`) — a minor already seeded into the
 *     voice participant set is denied 403 `age_restricted`.
 *
 * The scenario is a PUBLIC age-restricted voice channel so the view/connect gate
 * passes for everyone and ONLY the age gate distinguishes the minor from the
 * adult. Mirrors tests/stageAgeGate.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { app, httpServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { addVoiceParticipant, removeVoiceParticipant, setVoiceReverseLookup, isInVoiceChannel } from '../src/redis.js';
import { createTestUser, createTestServer, authHeader, cleanupTestData, type TestUser } from './helpers.js';

async function pollUntil(fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const BASELINE_PERMS = { viewChannels: true, readMessageHistory: true, connect: true, speak: true };

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
function joinVoice(socket: ClientSocket, channelId: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('join-voice-channel ack timeout')), 5000);
    socket.emit('join-voice-channel', { channelId }, (resp: { ok: boolean; error?: string }) => {
      clearTimeout(timer);
      resolve(resp);
    });
  });
}

describe('Voice age gate — join-voice-channel / livekit token', () => {
  let owner: TestUser;  // adult, owner
  let adult: TestUser;  // explicit adult DOB
  let minor: TestUser;  // 14 today
  let s: string;
  let arVoice: string;         // public voice, ageRestricted = true
  let safeVoice: string;       // public voice, ageRestricted = false (scoping control)
  let arPrivateVoice: string;  // PRIVATE voice, ageRestricted = true (F-2 oracle)

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

    const mkVoice = (name: string, ageRestricted: boolean) =>
      prisma.channel.create({
        data: { id: randomUUID(), serverId: s, name, type: 'voice', categoryId, position: 0, isPrivate: false, ageRestricted },
      });
    arVoice = (await mkVoice('ar-voice', true)).id;
    safeVoice = (await mkVoice('safe-voice', false)).id;
    // PRIVATE + age-restricted, with NO @everyone view override — so a plain
    // member (incl. the minor) is a NON-VIEWER of it. Exercises the F-2 ordering.
    arPrivateVoice = (await prisma.channel.create({
      data: { id: randomUUID(), serverId: s, name: 'ar-private-voice', type: 'voice', categoryId, position: 0, isPrivate: true, ageRestricted: true },
    })).id;
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.disconnect();
  });

  afterAll(async () => {
    await Promise.all([
      removeVoiceParticipant(arVoice, minor.id).catch(() => {}),
      removeVoiceParticipant(arVoice, adult.id).catch(() => {}),
      removeVoiceParticipant(safeVoice, minor.id).catch(() => {}),
      removeVoiceParticipant(arPrivateVoice, minor.id).catch(() => {}),
      setVoiceReverseLookup(minor.id, null).catch(() => {}),
      setVoiceReverseLookup(adult.id, null).catch(() => {}),
    ]);
    await cleanupTestData();
  });

  // ── socket join-voice-channel (authoritative membership gate) ──────────────
  it('join-voice-channel — minor is denied on the age-restricted channel with the age message', async () => {
    const minorSock = await connectSocket(minor.token);
    const resp = await joinVoice(minorSock, arVoice);
    expect(resp.ok, 'minor join blocked').toBe(false);
    expect(resp.error ?? '', 'minor join age message').toMatch(/age-restricted|18 or older/i);
  });

  it('join-voice-channel — minor on a NON-age-restricted channel is NOT age-denied (scoped, not blanket)', async () => {
    // safeVoice has no age gate; the minor fails later (no E2EE key bundle), so
    // the error must NOT be the age message — proving the gate is conditional.
    const minorSock = await connectSocket(minor.token);
    const resp = await joinVoice(minorSock, safeVoice);
    expect(resp.error ?? '').not.toMatch(/age-restricted|18 or older/i);
  });

  // ── livekit token (media path) ─────────────────────────────────────────────
  it('POST /livekit/token voice — minor already in the voice set is denied age_restricted; adult is not', async () => {
    // Seed both into the Redis voice participant set so `isInVoiceChannel`
    // passes; without the voice age gate the minor would mint a media token.
    await addVoiceParticipant(arVoice, minor.id, { username: 'Minor' });
    await addVoiceParticipant(arVoice, adult.id, { username: 'Adult' });

    const minorRes = await request(app)
      .post('/api/v1/livekit/token')
      .set('Authorization', authHeader(minor.token))
      .send({ roomName: `voice:${arVoice}`, participantName: 'Minor' });
    expect(minorRes.status, 'token minor').toBe(403);
    expect(minorRes.body.error, 'token minor').toBe('age_restricted');

    const adultRes = await request(app)
      .post('/api/v1/livekit/token')
      .set('Authorization', authHeader(adult.token))
      .send({ roomName: `voice:${arVoice}`, participantName: 'Adult' });
    expect(adultRes.body?.error, 'token adult not age-gated').not.toBe('age_restricted');
  });

  // ── F-2: age check must run AFTER the private-view gate ────────────────────
  it('POST /livekit/token voice — non-viewer minor on a PRIVATE age-restricted channel gets the view denial, NOT age_restricted', async () => {
    // Seed the minor into the Redis voice set so `isInVoiceChannel` passes and
    // execution reaches the private-view override gate (defense-in-depth path).
    // If the age check runs BEFORE the view gate it returns `age_restricted`,
    // leaking the ageRestricted flag to a member who cannot even view the
    // channel — the F-2 oracle. With the reorder the non-viewer gets the generic
    // view denial and never learns the channel is age-restricted.
    await addVoiceParticipant(arPrivateVoice, minor.id, { username: 'Minor' });

    const res = await request(app)
      .post('/api/v1/livekit/token')
      .set('Authorization', authHeader(minor.token))
      .send({ roomName: `voice:${arPrivateVoice}`, participantName: 'Minor' });
    expect(res.status, 'non-viewer minor denied').toBe(403);
    expect(res.body.error, 'must NOT leak the age flag to a non-viewer').not.toBe('age_restricted');
    expect(res.body.error, 'view denial instead of age denial').toMatch(/permission to view this channel/i);
  });

  // ── move-voice-user (second occupant entry path) ───────────────────────────
  it('move-voice-user — a minor target is NOT moved into an age-restricted channel', async () => {
    // Seed the minor as an occupant of the safe (source) channel; ensure they
    // are not lingering in the AR channel from the token test above.
    await removeVoiceParticipant(arVoice, minor.id).catch(() => {});
    await addVoiceParticipant(safeVoice, minor.id, { username: 'Minor' });
    await setVoiceReverseLookup(minor.id, safeVoice);

    // Owner (adult + server owner → moveMembers bypass) issues the move.
    const ownerSock = await connectSocket(owner.token);
    ownerSock.emit('move-voice-user', { targetUserId: minor.id, fromChannelId: safeVoice, toChannelId: arVoice });

    // This handler has no ack; poll for the end state. WITHOUT the age gate the
    // minor lands in the AR channel within ~100ms; WITH it, never.
    const landedInAr = await pollUntil(() => isInVoiceChannel(arVoice, minor.id), 1500);
    expect(landedInAr, 'minor moved into age-restricted channel').toBe(false);
    expect(await isInVoiceChannel(safeVoice, minor.id), 'minor stays in the source channel').toBe(true);
  });
});
