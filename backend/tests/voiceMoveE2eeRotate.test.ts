// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Completeness beyond the four REST paths.
 *
 * `move-voice-user` is a moderator-driven INVOLUNTARY removal of a member from
 * the source voice channel (same security class as a kick): the moved member
 * keeps the source channel's SFrame key. This asserts the handler rotates the
 * SOURCE channel's key for the members who remain there.
 *
 * Uses the real Socket.IO server harness (a connected client emits the event);
 * `scheduleVoiceE2eeRotate` is mocked to a spy so we assert the wiring contract
 * without waiting on the 2s debounce (its emit behaviour is covered by
 * voiceStageE2eeHelpers.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { AddressInfo } from 'net';

vi.mock('../src/services/voiceE2eeRotation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/voiceE2eeRotation.js')>();
  return { ...actual, scheduleVoiceE2eeRotate: vi.fn() };
});

import { httpServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { addVoiceParticipant, setVoiceReverseLookup } from '../src/redis.js';
import { scheduleVoiceE2eeRotate } from '../src/services/voiceE2eeRotation.js';
import { createTestUser, createTestServer, cleanupTestData } from './helpers.js';

const scheduleSpy = vi.mocked(scheduleVoiceE2eeRotate);

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

function waitFor(socket: ClientSocket, event: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (data: unknown) => { clearTimeout(t); resolve(data); });
  });
}

async function createVoiceChannel(serverId: string, name: string): Promise<string> {
  const c = await prisma.channel.create({ data: { serverId, name, type: 'voice', position: 1 } });
  return c.id;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(() => {
  for (const c of clients) if (c.connected) c.disconnect();
  clients.length = 0;
});

afterAll(async () => {
  await cleanupTestData();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('moderator move-voice-user rotates the SOURCE channel key', () => {
  it('rotates fromChannel for the members who remain after an involuntary move', async () => {
    const owner = await createTestUser();   // mover (owner ⇒ moveMembers)
    const target = await createTestUser();  // moved member
    const remaining = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverMember.create({ data: { serverId: server.id, userId: target.id, role: 'member' } });
    await prisma.serverMember.create({ data: { serverId: server.id, userId: remaining.id, role: 'member' } });

    const fromCh = await createVoiceChannel(server.id, 'from-voice');
    const toCh = await createVoiceChannel(server.id, 'to-voice');

    // target + remaining are both in fromChannel's voice.
    await addVoiceParticipant(fromCh, target.id, { username: target.username, joinedAt: 2000 } as never);
    await setVoiceReverseLookup(target.id, fromCh);
    await addVoiceParticipant(fromCh, remaining.id, { username: remaining.username, joinedAt: 1000 } as never);
    await setVoiceReverseLookup(remaining.id, fromCh);

    const ownerSock = await connectSocket(owner.token);
    const targetSock = await connectSocket(target.token);
    scheduleSpy.mockClear();

    const moved = waitFor(targetSock, 'voice-moved');
    ownerSock.emit('move-voice-user', { fromChannelId: fromCh, toChannelId: toCh, targetUserId: target.id });
    await moved;

    const call = scheduleSpy.mock.calls.find((c) => c[1] === fromCh);
    expect(call).toBeTruthy();
    expect(call![0]).toBeTruthy(); // io
    expect(call![2]).toBe(true);   // a member still remains in fromChannel
  });
});
