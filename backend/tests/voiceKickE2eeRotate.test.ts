// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * The four INVOLUNTARY voice-departure REST
 * paths must rotate the SFrame session key so a removed member's retained key
 * no longer protects subsequent media (forward secrecy at the kick/ban/timeout/
 * leave security boundary).
 *
 * The graceful `leave-voice-channel` (voice.ts) and abrupt-disconnect
 * (connection.ts) paths already call `scheduleVoiceE2eeRotate`; these four REST
 * paths were the unfixed remainder:
 *   1. moderator kick      — DELETE /servers/:id/members/:userId  (servers.ts)
 *   2. ban / GDPR removal  — POST   /servers/:id/bans            (serverSettings.ts)
 *   3. timeout voice-kick  — POST   /servers/:id/members/:userId/timeout (servers.ts)
 *   4. self leave-server   — POST   /servers/:id/leave           (servers.ts)
 *
 * The leave-server path additionally lacked the LiveKit SFU eject the other
 * three already have, so a self-leaver with a cached JWT could keep receiving
 * frames; this asserts both the rotate AND the eject for that path.
 *
 * `scheduleVoiceE2eeRotate` (debounced emit) and `removeLiveKitParticipant`
 * (SFU disconnect) are mocked to spies — their internal behaviour is covered by
 * voiceStageE2eeHelpers.test.ts; here we assert ONLY that each REST path wires
 * them with the right (channelId, participants-remain) contract.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import request from 'supertest';

// Mocks must be declared before the app (and its route handlers) are imported.
vi.mock('../src/services/voiceE2eeRotation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/voiceE2eeRotation.js')>();
  return { ...actual, scheduleVoiceE2eeRotate: vi.fn() };
});
vi.mock('../src/services/livekitAdmin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/livekitAdmin.js')>();
  return { ...actual, removeLiveKitParticipant: vi.fn().mockResolvedValue(undefined) };
});

import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { addVoiceParticipant, setVoiceReverseLookup } from '../src/redis.js';
import { scheduleVoiceE2eeRotate } from '../src/services/voiceE2eeRotation.js';
import { removeLiveKitParticipant } from '../src/services/livekitAdmin.js';
import {
  createTestUser,
  createTestServer,
  authHeader,
  cleanupTestData,
} from './helpers.js';

const scheduleSpy = vi.mocked(scheduleVoiceE2eeRotate);
const ejectSpy = vi.mocked(removeLiveKitParticipant);

afterAll(cleanupTestData);

async function addMember(serverId: string, userId: string, role = 'member'): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId, role } });
}

async function createVoiceChannel(serverId: string): Promise<string> {
  const c = await prisma.channel.create({
    data: { serverId, name: `voice-${Date.now()}`, type: 'voice', position: 1 },
  });
  return c.id;
}

async function joinVoice(channelId: string, userId: string, joinedAt: number): Promise<void> {
  await addVoiceParticipant(channelId, userId, { username: userId, joinedAt } as never);
  await setVoiceReverseLookup(userId, channelId);
}

/** Find the scheduleVoiceE2eeRotate call that targeted a given channel. */
function rotateCallFor(channelId: string): unknown[] | undefined {
  return scheduleSpy.mock.calls.find((c) => c[1] === channelId);
}

describe('involuntary voice-departure REST paths rotate the SFrame key', () => {
  it('moderator kick rotates for the remaining participants (forward secrecy)', async () => {
    const owner = await createTestUser();
    const target = await createTestUser();
    const remaining = await createTestUser();
    const server = await createTestServer(owner.id);
    await addMember(server.id, target.id);
    await addMember(server.id, remaining.id);
    const vc = await createVoiceChannel(server.id);
    await joinVoice(vc, remaining.id, 1000);
    await joinVoice(vc, target.id, 2000);
    scheduleSpy.mockClear();

    const res = await request(app)
      .delete(`/api/servers/${server.id}/members/${target.id}`)
      .set('Authorization', authHeader(owner.token));
    expect(res.status).toBe(200);

    const call = rotateCallFor(vc);
    expect(call).toBeTruthy();
    expect(call![0]).toBeTruthy(); // io
    expect(call![2]).toBe(true);   // participants remain → rotate, not cancel
  });

  it('ban / GDPR removal rotates for the remaining participants', async () => {
    const owner = await createTestUser();
    const target = await createTestUser();
    const remaining = await createTestUser();
    const server = await createTestServer(owner.id);
    await addMember(server.id, target.id);
    await addMember(server.id, remaining.id);
    const vc = await createVoiceChannel(server.id);
    await joinVoice(vc, remaining.id, 1000);
    await joinVoice(vc, target.id, 2000);
    scheduleSpy.mockClear();

    const res = await request(app)
      .post(`/api/servers/${server.id}/bans`)
      .set('Authorization', authHeader(owner.token))
      .send({ userId: target.id });
    expect(res.status).toBe(201);

    const call = rotateCallFor(vc);
    expect(call).toBeTruthy();
    expect(call![2]).toBe(true);
  });

  it('timeout voice-kick rotates for the remaining participants', async () => {
    const owner = await createTestUser();
    const target = await createTestUser();
    const remaining = await createTestUser();
    const server = await createTestServer(owner.id);
    await addMember(server.id, target.id);
    await addMember(server.id, remaining.id);
    const vc = await createVoiceChannel(server.id);
    await joinVoice(vc, remaining.id, 1000);
    await joinVoice(vc, target.id, 2000);
    scheduleSpy.mockClear();

    const res = await request(app)
      .post(`/api/servers/${server.id}/members/${target.id}/timeout`)
      .set('Authorization', authHeader(owner.token))
      .send({ durationSeconds: 300 });
    expect(res.status).toBe(200);

    const call = rotateCallFor(vc);
    expect(call).toBeTruthy();
    expect(call![2]).toBe(true);
  });

  it('self leave-server rotates AND ejects the leaver from the SFU', async () => {
    const owner = await createTestUser();
    const leaver = await createTestUser();
    const server = await createTestServer(owner.id);
    await addMember(server.id, leaver.id);
    const vc = await createVoiceChannel(server.id);
    await joinVoice(vc, owner.id, 1000);   // owner remains in voice
    await joinVoice(vc, leaver.id, 2000);
    scheduleSpy.mockClear();
    ejectSpy.mockClear();

    const res = await request(app)
      .post(`/api/servers/${server.id}/leave`)
      .set('Authorization', authHeader(leaver.token));
    expect(res.status).toBe(200);

    const call = rotateCallFor(vc);
    expect(call).toBeTruthy();
    expect(call![2]).toBe(true);
    // leave-server previously had NEITHER rotate NOR SFU eject.
    expect(ejectSpy).toHaveBeenCalledWith(`voice:${vc}`, leaver.id);
  });

  it('kicking the sole participant cancels rather than rotates (remain=false)', async () => {
    const owner = await createTestUser();
    const target = await createTestUser();
    const server = await createTestServer(owner.id);
    await addMember(server.id, target.id);
    const vc = await createVoiceChannel(server.id);
    await joinVoice(vc, target.id, 2000); // sole participant
    scheduleSpy.mockClear();

    const res = await request(app)
      .delete(`/api/servers/${server.id}/members/${target.id}`)
      .set('Authorization', authHeader(owner.token));
    expect(res.status).toBe(200);

    const call = rotateCallFor(vc);
    expect(call).toBeTruthy();
    expect(call![2]).toBe(false); // room emptied → cancel any pending rotate
  });
});
