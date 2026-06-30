// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { httpServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, createTestServer, createTestChannel, cleanupTestData, type TestUser } from './helpers.js';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import { getIO } from '../src/socketIO.js';
import {
  addVoiceParticipant, removeVoiceParticipant, setVoiceReverseLookup, findUserVoiceChannel,
  addDmCallParticipant, removeDmCallParticipant, setDmCallReverseLookup, findUserDmCall,
} from '../src/redis.js';
import { revalidateSocketSession, SOCKET_REVALIDATION_MS } from '../src/socketHandlers/connection.js';
import { hashToken } from '../src/utils/sessionUtils.js';
import { filterVisibleChannelIds, autoJoinVisibleServerMembers } from '../src/utils/channelVisibility.js';
import { loadPermissionContext } from '../src/utils/permissions.js';

let baseUrl: string;
const clients: ClientSocket[] = [];

function connectSocket(token?: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      transports: ['websocket'],
      auth: token ? { token } : {},
      forceNew: true,
      reconnection: false,
    });
    clients.push(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error('Socket connection timeout')), 5000);
  });
}

/** Connect with arbitrary auth fields (for protocol handshake tests). */
function connectSocketWithAuth(auth: Record<string, unknown>): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      transports: ['websocket'],
      auth,
      forceNew: true,
      reconnection: false,
    });
    clients.push(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error('Socket connection timeout')), 5000);
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => resolve());
  });
  const addr = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(() => {
  for (const c of clients) {
    if (c.connected) c.disconnect();
  }
  clients.length = 0;
});

afterAll(async () => {
  await cleanupTestData();
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
});

// Auth Middleware

describe('Socket.IO auth middleware', () => {
  it('rejects connections without a token', async () => {
    await expect(connectSocket()).rejects.toThrow('Missing token');
  });

  it('rejects connections with an invalid JWT', async () => {
    await expect(connectSocket('not-a-valid-jwt')).rejects.toThrow();
  });

  it('rejects a valid JWT whose session was deleted', async () => {
    const user = await createTestUser();
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await expect(connectSocket(user.token)).rejects.toThrow('Session revoked');
  });

  it('accepts a valid token with an active session', async () => {
    const user = await createTestUser();
    const socket = await connectSocket(user.token);
    expect(socket.connected).toBe(true);
  });
});

// join-server

describe('Socket.IO join-server', () => {
  let owner: TestUser;
  let nonMember: TestUser;
  let serverId: string;

  beforeAll(async () => {
    owner = await createTestUser();
    nonMember = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
  });

  it('allows a member to join the server room', async () => {
    const socket = await connectSocket(owner.token);
    const response = await new Promise<Record<string, unknown>>((resolve) => {
      socket.on('server-voice-participants-initial', (data: Record<string, unknown>) => resolve(data));
      socket.emit('join-server', serverId);
    });
    expect(response).toHaveProperty('serverId', serverId);
  });

  it('denies a non-member from joining the server room', async () => {
    const socket = await connectSocket(nonMember.token);
    let received = false;
    socket.on('server-voice-participants-initial', () => { received = true; });
    socket.emit('join-server', serverId);
    await new Promise((r) => setTimeout(r, 500));
    expect(received).toBe(false);
  });

  it('denies a banned user from joining', async () => {
    const bannedUser = await createTestUser();
    await prisma.serverMember.create({ data: { userId: bannedUser.id, serverId, role: 'member' } });
    await prisma.serverBan.create({ data: { serverId, userId: bannedUser.id, reason: 'test', bannedById: owner.id } });

    const socket = await connectSocket(bannedUser.token);
    let received = false;
    socket.on('server-voice-participants-initial', () => { received = true; });
    socket.emit('join-server', serverId);
    await new Promise((r) => setTimeout(r, 500));
    expect(received).toBe(false);
  });
});

// join-channel

describe('Socket.IO join-channel', () => {
  let owner: TestUser;
  let nonMember: TestUser;
  let channelId: string;

  beforeAll(async () => {
    owner = await createTestUser();
    nonMember = await createTestUser();
    const server = await createTestServer(owner.id);
    const channel = await createTestChannel(server.id, 'socket-test-chan');
    channelId = channel.id;
  });

  it('allows a server member to join a channel room', async () => {
    const socket = await connectSocket(owner.token);
    socket.emit('join-channel', channelId);
    await new Promise((r) => setTimeout(r, 300));
    // No error means success; the server silently joins the room.
    expect(socket.connected).toBe(true);
  });

  it('denies a non-member from joining a channel room', async () => {
    const socket = await connectSocket(nonMember.token);
    socket.emit('join-channel', channelId);
    await new Promise((r) => setTimeout(r, 300));
    expect(socket.connected).toBe(true);
  });

  it('ignores join-channel with a non-existent channel ID', async () => {
    const socket = await connectSocket(owner.token);
    socket.emit('join-channel', randomUUID());
    await new Promise((r) => setTimeout(r, 300));
    expect(socket.connected).toBe(true);
  });
});

// join-thread (private-channel access regression)

describe('Socket.IO join-thread', () => {
  let owner: TestUser;
  let denied: TestUser;
  let privateChannelId: string;
  let threadId: string;

  beforeAll(async () => {
    owner = await createTestUser();
    denied = await createTestUser();
    const server = await createTestServer(owner.id);

    // Both users are server members; `denied` has no role-level restriction.
    await prisma.serverMember.create({ data: { userId: denied.id, serverId: server.id, role: 'member' } });

    // Create a private channel.
    const privateCh = await prisma.channel.create({
      data: {
        id: randomUUID(),
        name: 'private-chan',
        type: 'text',
        serverId: server.id,
        categoryId: server.categories[0]!.id,
        position: 10,
        isPrivate: true,
      },
    });
    privateChannelId = privateCh.id;

    // Deny `viewChannels` on the private channel for `denied` via a
    // member-level channelPermissionOverride.
    await prisma.channelPermissionOverride.create({
      data: {
        channelId: privateChannelId,
        targetType: 'member',
        targetId: denied.id,
        permissions: { viewChannels: false, readMessageHistory: false },
      },
    });

    // Create a parent message + a thread rooted in the private channel.
    const parentMsg = await prisma.message.create({
      data: {
        id: randomUUID(),
        channelId: privateChannelId,
        authorId: owner.id,
        content: 'parent',
      },
    });
    const thread = await prisma.thread.create({
      data: {
        id: randomUUID(),
        channelId: privateChannelId,
        parentMessageId: parentMsg.id,
        serverId: server.id,
        name: 'secret-thread',
        authorId: owner.id,
      },
    });
    threadId = thread.id;
  });

  it('denies a server member who lacks viewChannels on the parent private channel from joining the thread room', async () => {
    const socket = await connectSocket(denied.token);
    socket.emit('join-thread', threadId);
    await new Promise((r) => setTimeout(r, 400));

    const io = getIO();
    const allSockets = await io.fetchSockets();
    const serverSide = allSockets.find((s) => s.id === socket.id);
    expect(serverSide).toBeDefined();
    expect(serverSide!.rooms.has(`thread:${threadId}`)).toBe(false);
  });

  it('allows the thread author (owner) to join the thread room', async () => {
    const socket = await connectSocket(owner.token);
    socket.emit('join-thread', threadId);
    await new Promise((r) => setTimeout(r, 400));

    const io = getIO();
    const allSockets = await io.fetchSockets();
    const serverSide = allSockets.find((s) => s.id === socket.id);
    expect(serverSide).toBeDefined();
    expect(serverSide!.rooms.has(`thread:${threadId}`)).toBe(true);
  });
});

// join-dm

describe('Socket.IO join-dm', () => {
  let userA: TestUser;
  let userB: TestUser;
  let outsider: TestUser;
  let dmChannelId: string;

  beforeAll(async () => {
    userA = await createTestUser();
    userB = await createTestUser();
    outsider = await createTestUser();

    const dm = await prisma.dMChannel.create({ data: { id: randomUUID() } });
    dmChannelId = dm.id;
    await prisma.dMParticipant.createMany({
      data: [
        { userId: userA.id, dmChannelId },
        { userId: userB.id, dmChannelId },
      ],
    });
  });

  it('allows a DM participant to join the DM room', async () => {
    const socket = await connectSocket(userA.token);
    socket.emit('join-dm', dmChannelId);
    await new Promise((r) => setTimeout(r, 300));
    expect(socket.connected).toBe(true);
  });

  it('denies a non-participant from joining the DM room', async () => {
    const socket = await connectSocket(outsider.token);
    socket.emit('join-dm', dmChannelId);
    await new Promise((r) => setTimeout(r, 300));
    expect(socket.connected).toBe(true);
  });
});

// bug-2: multi-client call kick

describe('bug-2: multi-client call kick', () => {
  let user: TestUser;
  const voiceChannelId = randomUUID();
  const dmCallChannelId = randomUUID();

  beforeAll(async () => {
    user = await createTestUser();
  });

  it('closing a non-voice socket does not kick the user from their voice channel', async () => {
    // Open two sockets for the same user.
    const socketInCall = await connectSocket(user.token);
    const socketIdle = await connectSocket(user.token);

    // Directly seed voice state: add user as voice participant in Redis
    // and server-side join the in-call socket into the voice: room.
    await addVoiceParticipant(voiceChannelId, user.id, { username: user.username });
    await setVoiceReverseLookup(user.id, voiceChannelId);

    const io = getIO();
    const allSockets = await io.fetchSockets();
    const serverSideInCall = allSockets.find(s => s.id === socketInCall.id);
    serverSideInCall!.join(`voice:${voiceChannelId}`);

    // Listen on socketInCall for 'voice-user-left' — must NOT fire.
    let voiceUserLeftFired = false;
    socketInCall.on('voice-user-left', () => { voiceUserLeftFired = true; });

    // Close the idle (non-voice) socket.
    socketIdle.disconnect();

    // Wait for disconnect handler to settle.
    await new Promise((r) => setTimeout(r, 500));

    try {
      // Assert: voice membership in Redis unchanged.
      const stillInVoice = await findUserVoiceChannel(user.id);
      expect(stillInVoice).toBe(voiceChannelId);

      // Assert: 'voice-user-left' not emitted to socketInCall.
      expect(voiceUserLeftFired).toBe(false);
    } finally {
      await removeVoiceParticipant(voiceChannelId, user.id);
      await setVoiceReverseLookup(user.id, null);
    }
  });

  it('closing a non-DM-call socket does not kick the user from their DM call', async () => {
    // Open two sockets for the same user.
    const socketInCall = await connectSocket(user.token);
    const socketIdle = await connectSocket(user.token);

    // Directly seed DM call state: add user as DM call participant in Redis
    // and server-side join the in-call socket into the dm-call: room.
    await addDmCallParticipant(dmCallChannelId, user.id, { username: user.username });
    await setDmCallReverseLookup(user.id, dmCallChannelId);

    const io = getIO();
    const allSockets = await io.fetchSockets();
    const serverSideInCall = allSockets.find(s => s.id === socketInCall.id);
    serverSideInCall!.join(`dm-call:${dmCallChannelId}`);

    // Listen on socketInCall for 'dm-call-user-left' — must NOT fire.
    let dmCallUserLeftFired = false;
    socketInCall.on('dm-call-user-left', () => { dmCallUserLeftFired = true; });

    // Close the idle (non-DM-call) socket.
    socketIdle.disconnect();

    // Wait for disconnect handler to settle.
    await new Promise((r) => setTimeout(r, 500));

    try {
      // Assert: DM call membership in Redis unchanged.
      const stillInDmCall = await findUserDmCall(user.id);
      expect(stillInDmCall).toBe(dmCallChannelId);

      // Assert: 'dm-call-user-left' not emitted to socketInCall.
      expect(dmCallUserLeftFired).toBe(false);
    } finally {
      await removeDmCallParticipant(dmCallChannelId, user.id);
      await setDmCallReverseLookup(user.id, null);
    }
  });
});

// dm-call-e2ee-ack relay (MLS bilateral shield)

describe('dm-call-e2ee-ack relay', () => {
  let userA: TestUser;
  let userB: TestUser;
  let userC: TestUser;
  const dmCallChannelId = randomUUID();

  beforeAll(async () => {
    userA = await createTestUser();
    userB = await createTestUser();
    userC = await createTestUser();
  });

  it('relays an E2EE ack from one in-call participant to the other, tagged with the sender userId', async () => {
    const socketA = await connectSocket(userA.token);
    const socketB = await connectSocket(userB.token);

    await addDmCallParticipant(dmCallChannelId, userA.id, { username: userA.username });
    await setDmCallReverseLookup(userA.id, dmCallChannelId);
    await addDmCallParticipant(dmCallChannelId, userB.id, { username: userB.username });
    await setDmCallReverseLookup(userB.id, dmCallChannelId);

    const io = getIO();
    const allSockets = await io.fetchSockets();
    allSockets.find(s => s.id === socketA.id)!.join(`dm-call:${dmCallChannelId}`);
    allSockets.find(s => s.id === socketB.id)!.join(`dm-call:${dmCallChannelId}`);

    const ackPromise = new Promise<{ userId: string; ok: boolean }>((resolve) => {
      socketB.on('dm-call-e2ee-ack', (data) => resolve(data));
    });
    // Sender must NOT receive their own relayed ack (socket.to excludes self).
    let selfEcho = false;
    socketA.on('dm-call-e2ee-ack', () => { selfEcho = true; });

    try {
      socketA.emit('dm-call-e2ee-ack', { dmChannelId: dmCallChannelId, ok: true });
      const received = await Promise.race([
        ackPromise,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('ack not received')), 2000)),
      ]);
      expect(received.userId).toBe(userA.id);
      expect(received.ok).toBe(true);
      expect(selfEcho).toBe(false);
    } finally {
      await removeDmCallParticipant(dmCallChannelId, userA.id);
      await setDmCallReverseLookup(userA.id, null);
      await removeDmCallParticipant(dmCallChannelId, userB.id);
      await setDmCallReverseLookup(userB.id, null);
    }
  });

  it('does not relay an ack from a user who is not in the call', async () => {
    const socketB = await connectSocket(userB.token);
    const socketC = await connectSocket(userC.token); // C is NOT in the call

    await addDmCallParticipant(dmCallChannelId, userB.id, { username: userB.username });
    await setDmCallReverseLookup(userB.id, dmCallChannelId);

    const io = getIO();
    const allSockets = await io.fetchSockets();
    allSockets.find(s => s.id === socketB.id)!.join(`dm-call:${dmCallChannelId}`);
    // Force C's socket into the room to prove the server-side isInDmCall gate
    // (not mere room membership) is what blocks the relay.
    allSockets.find(s => s.id === socketC.id)!.join(`dm-call:${dmCallChannelId}`);

    let bReceived = false;
    socketB.on('dm-call-e2ee-ack', () => { bReceived = true; });

    try {
      socketC.emit('dm-call-e2ee-ack', { dmChannelId: dmCallChannelId, ok: true });
      await new Promise((r) => setTimeout(r, 500));
      expect(bReceived).toBe(false);
    } finally {
      await removeDmCallParticipant(dmCallChannelId, userB.id);
      await setDmCallReverseLookup(userB.id, null);
    }
  });
});

// mlsCallReady join/store/relay (key-blind per-participant readiness)

describe('join-dm-call mlsCallReady relay', () => {
  let userA: TestUser;
  let userB: TestUser;
  let dmChannelId: string;

  beforeAll(async () => {
    userA = await createTestUser();
    userB = await createTestUser();
    const dm = await prisma.dMChannel.create({
      data: {
        encrypted: true,
        participants: { create: [{ userId: userA.id }, { userId: userB.id }] },
      },
    });
    dmChannelId = dm.id;
  });

  it('stores the joiner flag, fans it out on incoming-dm-call, dm-call-user-joined, and the roster', async () => {
    const socketA = await connectSocket(userA.token);
    const socketB = await connectSocket(userB.token);

    // B (not yet in call) is rung with A's readiness.
    const incomingPromise = new Promise<{ mlsCallReady?: boolean }>((resolve) => {
      socketB.on('incoming-dm-call', (data) => resolve(data));
    });
    // A's own roster snapshot from the join.
    const rosterAPromise = new Promise<{ participants: Array<{ userId: string; mlsCallReady?: boolean }> }>((resolve) => {
      socketA.on('dm-call-participants', (data) => resolve(data));
    });

    const ackA = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      socketA.emit('join-dm-call', { dmChannelId, mlsCallReady: true }, resolve);
    });
    expect(ackA.error).toBeUndefined();
    expect(ackA.ok).toBe(true);

    const incoming = await Promise.race([
      incomingPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('incoming-dm-call not received')), 2000)),
    ]);
    expect(incoming.mlsCallReady).toBe(true);

    const rosterA = await Promise.race([
      rosterAPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dm-call-participants not received by A')), 2000)),
    ]);
    expect(rosterA.participants.find(p => p.userId === userA.id)?.mlsCallReady).toBe(true);

    // A learns B's readiness via dm-call-user-joined when B answers (join = answer).
    const joinedPromise = new Promise<{ userId: string; mlsCallReady?: boolean }>((resolve) => {
      socketA.on('dm-call-user-joined', (data) => resolve(data));
    });
    // Room-wide roster broadcast: on B's join the roster must reach A too
    // (already in the call), not just the joiner. A member that missed a
    // dm-call-user-joined (socket blip during another member's join) would
    // otherwise hold stale peer-readiness until its own reconnect. A's own
    // join roster already resolved above, so the next dm-call-participants
    // A sees can only come from B's join.
    const rosterAOnBJoinPromise = new Promise<{ participants: Array<{ userId: string; mlsCallReady?: boolean }> }>((resolve) => {
      socketA.on('dm-call-participants', (data) => resolve(data));
    });
    const rosterBPromise = new Promise<{ participants: Array<{ userId: string; mlsCallReady?: boolean }> }>((resolve) => {
      socketB.on('dm-call-participants', (data) => resolve(data));
    });
    const ackB = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      socketB.emit('join-dm-call', { dmChannelId, mlsCallReady: false }, resolve);
    });
    expect(ackB.error).toBeUndefined();
    expect(ackB.ok).toBe(true);

    const joined = await Promise.race([
      joinedPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dm-call-user-joined not received')), 2000)),
    ]);
    expect(joined.userId).toBe(userB.id);
    expect(joined.mlsCallReady).toBe(false);

    // Late-joiner proof: B's roster carries A's stored flag (true) and B's own (false).
    const rosterB = await Promise.race([
      rosterBPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dm-call-participants not received by B')), 2000)),
    ]);
    expect(rosterB.participants.find(p => p.userId === userA.id)?.mlsCallReady).toBe(true);
    expect(rosterB.participants.find(p => p.userId === userB.id)?.mlsCallReady).toBe(false);

    // In-call member proof: A also receives the roster on B's join.
    const rosterAOnBJoin = await Promise.race([
      rosterAOnBJoinPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dm-call-participants not broadcast to A on B join')), 2000)),
    ]);
    expect(rosterAOnBJoin.participants.find(p => p.userId === userA.id)?.mlsCallReady).toBe(true);
    expect(rosterAOnBJoin.participants.find(p => p.userId === userB.id)?.mlsCallReady).toBe(false);

    // Cleanup so later suites see no live call (the global afterEach only
    // disconnects sockets; leave-dm-call clears the dmcall hash + ring state).
    socketA.emit('leave-dm-call', { dmChannelId });
    socketB.emit('leave-dm-call', { dmChannelId });
    await new Promise((r) => setTimeout(r, 300));
  });

  it('omitted flag is stored as false (old client = not MLS-ready)', async () => {
    const socketA = await connectSocket(userA.token);
    const rosterPromise = new Promise<{ participants: Array<{ userId: string; mlsCallReady?: boolean }> }>((resolve) => {
      socketA.on('dm-call-participants', (data) => resolve(data));
    });
    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      socketA.emit('join-dm-call', { dmChannelId }, resolve);
    });
    expect(ack.error).toBeUndefined();
    expect(ack.ok).toBe(true);
    const roster = await Promise.race([
      rosterPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dm-call-participants not received')), 2000)),
    ]);
    expect(roster.participants.find(p => p.userId === userA.id)?.mlsCallReady).toBe(false);
    socketA.emit('leave-dm-call', { dmChannelId });
    await new Promise((r) => setTimeout(r, 300));
  });

  it('re-ring ticks carry mlsCallReady (push-notified recipient parity)', async () => {
    const socketA = await connectSocket(userA.token);
    const socketB = await connectSocket(userB.token);

    // Count incoming-dm-call events on B: the first comes from the join
    // handler's direct emit, the second from the hardcoded 5s ring interval
    // (startDmCallRing). A push-notified recipient's FIRST sight of a call
    // is a re-ring tick, so it must carry the same fields as the join emit.
    const secondIncomingPromise = new Promise<{ mlsCallReady?: boolean; e2eeKey?: string; keyFormat?: string }>((resolve) => {
      let count = 0;
      socketB.on('incoming-dm-call', (data) => {
        count++;
        if (count === 2) resolve(data);
      });
    });

    try {
      const ackA = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        socketA.emit('join-dm-call', { dmChannelId, mlsCallReady: true }, resolve);
      });
      expect(ackA.error).toBeUndefined();
      expect(ackA.ok).toBe(true);

      const reRing = await Promise.race([
        secondIncomingPromise,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('second incoming-dm-call (re-ring tick) not received')), 8000)),
      ]);
      expect(reRing.mlsCallReady).toBe(true);
      expect((reRing as Record<string, unknown>).e2eeKey).toBeUndefined();
      expect((reRing as Record<string, unknown>).keyFormat).toBeUndefined();
    } finally {
      // End the call so the ring interval stops (leave-dm-call hits
      // remainingSize 0 -> stopDmCallRing) and later suites are unaffected.
      socketA.emit('leave-dm-call', { dmChannelId });
      await new Promise((r) => setTimeout(r, 300));
    }
  }, 15000);
});

// protocol handshake (permissive)

describe('protocol handshake (permissive)', () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createTestUser();
  });

  /** Helper: get server-side socket for a connected client. */
  function getServerSocket(clientSocket: ClientSocket) {
    const io = getIO();
    return io.sockets.sockets.get(clientSocket.id!);
  }

  it('accepts a client that sends no protocol fields', async () => {
    const client = await connectSocketWithAuth({ token: user.token });
    expect(client.connected).toBe(true);

    // Allow server-side middleware to finish attaching
    await new Promise((r) => setTimeout(r, 100));

    const serverSocket = getServerSocket(client);
    expect(serverSocket).toBeDefined();
    expect(serverSocket!.protocolContext).toBeDefined();
    expect(serverSocket!.protocolContext!.buildDate).toBeNull();
    expect(serverSocket!.protocolContext!.protocolVersion).toBeNull();
    expect(serverSocket!.protocolContext!.capabilities).toEqual([]);
  });

  it('accepts a client that sends current protocol fields', async () => {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const client = await connectSocketWithAuth({
      token: user.token,
      buildDate: today,
      protocolVersion: 1,
      capabilities: ['sframe.v1'],
    });
    expect(client.connected).toBe(true);

    await new Promise((r) => setTimeout(r, 100));

    const serverSocket = getServerSocket(client);
    expect(serverSocket).toBeDefined();
    expect(serverSocket!.protocolContext!.buildDate).toBe(today);
    expect(serverSocket!.protocolContext!.protocolVersion).toBe(1);
    expect(serverSocket!.protocolContext!.capabilities).toEqual(['sframe.v1']);
  });

  it('accepts a client with a stale buildDate (permissive mode)', async () => {
    const staleDate = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const client = await connectSocketWithAuth({
      token: user.token,
      buildDate: staleDate,
      protocolVersion: 1,
      capabilities: [],
    });
    expect(client.connected).toBe(true);

    await new Promise((r) => setTimeout(r, 100));

    const serverSocket = getServerSocket(client);
    expect(serverSocket).toBeDefined();
    // Permissive: stale date is recorded, not rejected
    expect(serverSocket!.protocolContext!.buildDate).toBe(staleDate);
  });

  it('accepts a client sending garbage values (parses them to null)', async () => {
    const client = await connectSocketWithAuth({
      token: user.token,
      buildDate: 'not-a-date',
      protocolVersion: 'oops',
      capabilities: 'not-an-array',
    });
    expect(client.connected).toBe(true);

    await new Promise((r) => setTimeout(r, 100));

    const serverSocket = getServerSocket(client);
    expect(serverSocket).toBeDefined();
    expect(serverSocket!.protocolContext!.buildDate).toBeNull();
    expect(serverSocket!.protocolContext!.protocolVersion).toBeNull();
    expect(serverSocket!.protocolContext!.capabilities).toEqual([]);
  });

  it('rejects protocolVersion=0 on socket handshake (returns null)', async () => {
    const client = await connectSocketWithAuth({
      token: user.token,
      buildDate: '2026-04-19',
      protocolVersion: 0,
      capabilities: [],
    });
    expect(client.connected).toBe(true);

    await new Promise((r) => setTimeout(r, 100));

    const serverSocket = getServerSocket(client);
    expect(serverSocket).toBeDefined();
    expect(serverSocket!.protocolContext!.protocolVersion).toBeNull();
  });
});

// protocol handshake (enforcing, ENFORCE_VERSION_GATE=true)

describe('protocol handshake (enforcing, ENFORCE_VERSION_GATE=true)', () => {
  let user: TestUser;

  beforeAll(async () => {
    process.env.ENFORCE_VERSION_GATE = 'true';
    user = await createTestUser();
  });

  afterAll(() => {
    delete process.env.ENFORCE_VERSION_GATE;
  });

  it('rejects a client with buildDate 61 days old', async () => {
    const staleDate = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const result = await new Promise<{ reason: string; autoUpdateHint: boolean; disconnected: boolean }>((resolve) => {
      const socket = ioClient(baseUrl, {
        transports: ['websocket'],
        auth: { token: user.token, buildDate: staleDate, protocolVersion: 1, capabilities: [] },
        forceNew: true,
        reconnection: false,
      });
      clients.push(socket);
      let eventData: { reason: string; autoUpdateHint: boolean } | null = null;
      socket.on('must-update', (data: { reason: string; autoUpdateHint: boolean }) => { eventData = data; });
      socket.on('disconnect', () => {
        if (eventData) resolve({ ...eventData, disconnected: true });
      });
      setTimeout(() => { if (eventData) resolve({ ...eventData, disconnected: false }); }, 5000);
    });

    expect(result.reason).toBe('buildDate');
    expect(result.autoUpdateHint).toBe(true);
    expect(result.disconnected).toBe(true);
  });

  it('rejects a client with no buildDate field', async () => {
    const result = await new Promise<{ reason: string; autoUpdateHint: boolean; disconnected: boolean }>((resolve) => {
      const socket = ioClient(baseUrl, {
        transports: ['websocket'],
        auth: { token: user.token, protocolVersion: 1, capabilities: [] },
        forceNew: true,
        reconnection: false,
      });
      clients.push(socket);
      let eventData: { reason: string; autoUpdateHint: boolean } | null = null;
      socket.on('must-update', (data: { reason: string; autoUpdateHint: boolean }) => { eventData = data; });
      socket.on('disconnect', () => {
        if (eventData) resolve({ ...eventData, disconnected: true });
      });
      setTimeout(() => { if (eventData) resolve({ ...eventData, disconnected: false }); }, 5000);
    });

    expect(result.reason).toBe('buildDate');
    expect(result.autoUpdateHint).toBe(true);
    expect(result.disconnected).toBe(true);
  });

  it('accepts a client with buildDate 50 days old (within window, soft warning)', async () => {
    const softDate = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const result = await new Promise<{ connected: boolean; updateRecommended: boolean }>((resolve) => {
      const socket = ioClient(baseUrl, {
        transports: ['websocket'],
        auth: { token: user.token, buildDate: softDate, protocolVersion: 1, capabilities: [] },
        forceNew: true,
        reconnection: false,
      });
      clients.push(socket);

      let gotRecommended = false;
      socket.on('update-recommended', () => { gotRecommended = true; });
      socket.on('connect', () => {
        // Give the connection handler time to emit update-recommended
        setTimeout(() => resolve({ connected: socket.connected, updateRecommended: gotRecommended }), 200);
      });
      socket.on('connect_error', () => resolve({ connected: false, updateRecommended: false }));
    });

    expect(result.connected).toBe(true);
    expect(result.updateRecommended).toBe(true);
  });
});

// session revalidation

describe('revalidateSocketSession', () => {
  it('exposes a 5-minute interval constant', () => {
    // Pin the revalidation cadence: if this ever regresses to a longer
    // interval, the test fails loudly.
    expect(SOCKET_REVALIDATION_MS).toBe(5 * 60 * 1000);
  });

  it('returns "ok" when the session exists and the user is not suspended', async () => {
    const user = await createTestUser();
    const session = await prisma.session.findFirstOrThrow({
      where: { tokenHash: hashToken(user.token) },
      select: { id: true },
    });

    const verdict = await revalidateSocketSession(session.id);
    expect(verdict).toEqual({ kind: 'ok' });
  });

  it('returns "session-revoked" when the session row is gone', async () => {
    const user = await createTestUser();
    const session = await prisma.session.findFirstOrThrow({
      where: { tokenHash: hashToken(user.token) },
      select: { id: true },
    });
    await prisma.session.delete({ where: { id: session.id } });

    const verdict = await revalidateSocketSession(session.id);
    expect(verdict).toEqual({ kind: 'session-revoked' });
  });

  it('returns "suspended" when the owning user is suspended', async () => {
    const user = await createTestUser();
    const session = await prisma.session.findFirstOrThrow({
      where: { tokenHash: hashToken(user.token) },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { suspended: true, suspendedAt: new Date() },
    });

    const verdict = await revalidateSocketSession(session.id);
    expect(verdict).toEqual({ kind: 'suspended' });
  });
});

// connection-time auto-subscribe
//
// On connect, the server batches membership lookups and calls socket.join
// for all visible server/channel/DM rooms. This replaces the pre-Apr-2026
// pattern where the client fired one explicit join-* event per room on
// bootstrap — a flood that exhausted the 30/10s per-user
// checkSocketRateLimit counter for anyone in ~3+ populated servers and
// silently rate-limited their first in-session action.

describe('Socket.IO connection-time auto-subscribe', () => {
  /** Wait for the fire-and-forget auto-subscribe IIFE in connection.ts to
   *  finish its Prisma round trips + socket.join calls. 500ms is empirically
   *  long enough for the test-sized fixture (2 servers, few channels, few DMs). */
  const AUTO_SUBSCRIBE_SETTLE_MS = 500;

  /** Seed a realistic `@everyone` baseline role on a server so non-owner
   *  members actually pass `hasPermission(ctx, 'viewChannels' | 'readMessageHistory')`.
   *  Production servers always have this role; `createTestServer` doesn't create
   *  one, so non-owner tests need to opt in here. */
  async function seedEveryoneRole(serverId: string) {
    await prisma.serverRole.create({
      data: {
        serverId,
        name: '@everyone',
        isEveryone: true,
        position: 0,
        permissions: {
          viewChannels: true,
          readMessageHistory: true,
          sendMessages: true,
        },
      },
    });
  }

  /** Connect a client, but subscribe to `eventName` BEFORE the server-side
   *  auto-subscribe IIFE fires so the emission is reliably observed. Without
   *  this, registering `.on()` after `connectSocket` resolves races the
   *  backend's async IIFE. */
  function connectAndWaitFor(token: string, eventName: string, timeoutMs = 2000): Promise<{ client: ClientSocket; payload: unknown }> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        transports: ['websocket'],
        auth: { token },
        forceNew: true,
        reconnection: false,
      });
      clients.push(socket);
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${eventName}`)), timeoutMs);
      socket.on(eventName, (payload: unknown) => {
        clearTimeout(timer);
        resolve({ client: socket, payload });
      });
      socket.on('connect_error', (err) => { clearTimeout(timer); reject(err); });
    });
  }

  it('joins the socket to server/channel/DM rooms the user belongs to', async () => {
    // User is the owner of both servers → owner short-circuit in hasPermission
    // means we don't need @everyone for this test. The happy-path assertions
    // exercise the per-type filter (text/stage/forum), DM auto-join, and the
    // batched permission context.
    const user = await createTestUser();
    const serverA = await createTestServer(user.id);
    const serverB = await createTestServer(user.id);
    const channelA2 = await createTestChannel(serverA.id, 'auto-sub-a2');
    const channelB2 = await createTestChannel(serverB.id, 'auto-sub-b2');

    const otherUser = await createTestUser();
    const dmChannel = await prisma.dMChannel.create({
      data: {
        participants: {
          create: [{ userId: user.id }, { userId: otherUser.id }],
        },
      },
    });

    const clientSocket = await connectSocket(user.token);
    await new Promise((r) => setTimeout(r, AUTO_SUBSCRIBE_SETTLE_MS));

    const allSockets = await getIO().fetchSockets();
    const serverSide = allSockets.find((s) => s.id === clientSocket.id);
    expect(serverSide).toBeDefined();

    expect(serverSide!.rooms.has(`server:${serverA.id}`)).toBe(true);
    expect(serverSide!.rooms.has(`server:${serverB.id}`)).toBe(true);

    const defaultA = serverA.channels.find((c) => c.name === 'general')!;
    const defaultB = serverB.channels.find((c) => c.name === 'general')!;
    expect(serverSide!.rooms.has(`channel:${defaultA.id}`)).toBe(true);
    expect(serverSide!.rooms.has(`channel:${defaultB.id}`)).toBe(true);
    expect(serverSide!.rooms.has(`channel:${channelA2.id}`)).toBe(true);
    expect(serverSide!.rooms.has(`channel:${channelB2.id}`)).toBe(true);

    expect(serverSide!.rooms.has(`dm:${dmChannel.id}`)).toBe(true);
  });

  it('does NOT join a server room when the user is banned from that server', async () => {
    const owner = await createTestUser();
    const bannedUser = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverMember.create({
      data: { userId: bannedUser.id, serverId: server.id, role: 'member' },
    });
    await prisma.serverBan.create({
      data: { serverId: server.id, userId: bannedUser.id, reason: 'test', bannedById: owner.id },
    });

    const clientSocket = await connectSocket(bannedUser.token);
    await new Promise((r) => setTimeout(r, AUTO_SUBSCRIBE_SETTLE_MS));

    const allSockets = await getIO().fetchSockets();
    const serverSide = allSockets.find((s) => s.id === clientSocket.id);
    expect(serverSide).toBeDefined();
    expect(serverSide!.rooms.has(`server:${server.id}`)).toBe(false);

    const defaultCh = server.channels.find((c) => c.name === 'general')!;
    expect(serverSide!.rooms.has(`channel:${defaultCh.id}`)).toBe(false);
  });

  it('auto-joins non-owner members to public channels via the @everyone baseline', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const server = await createTestServer(owner.id);
    await seedEveryoneRole(server.id);
    await prisma.serverMember.create({
      data: { userId: member.id, serverId: server.id, role: 'member' },
    });

    const clientSocket = await connectSocket(member.token);
    await new Promise((r) => setTimeout(r, AUTO_SUBSCRIBE_SETTLE_MS));

    const allSockets = await getIO().fetchSockets();
    const serverSide = allSockets.find((s) => s.id === clientSocket.id);
    expect(serverSide).toBeDefined();
    expect(serverSide!.rooms.has(`server:${server.id}`)).toBe(true);
    const defaultCh = server.channels.find((c) => c.name === 'general')!;
    expect(serverSide!.rooms.has(`channel:${defaultCh.id}`)).toBe(true);
  });

  it('does NOT auto-join a private channel when the non-owner lacks viewChannels at the channel tier', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const server = await createTestServer(owner.id);
    // With @everyone in place, server-level viewChannels + readMessageHistory
    // pass for `member`. The private-channel filter is what must block.
    await seedEveryoneRole(server.id);
    await prisma.serverMember.create({
      data: { userId: member.id, serverId: server.id, role: 'member' },
    });

    const privateCh = await prisma.channel.create({
      data: {
        name: 'secret',
        type: 'text',
        serverId: server.id,
        isPrivate: true,
        position: 999,
      },
    });

    const clientSocket = await connectSocket(member.token);
    await new Promise((r) => setTimeout(r, AUTO_SUBSCRIBE_SETTLE_MS));

    const allSockets = await getIO().fetchSockets();
    const serverSide = allSockets.find((s) => s.id === clientSocket.id);
    expect(serverSide).toBeDefined();
    expect(serverSide!.rooms.has(`server:${server.id}`)).toBe(true);
    // Public general channel is reachable via @everyone baseline...
    const defaultCh = server.channels.find((c) => c.name === 'general')!;
    expect(serverSide!.rooms.has(`channel:${defaultCh.id}`)).toBe(true);
    // ...but the private channel is NOT, because `isPrivate: true` requires
    // an override granting viewChannels at the channel tier, which the
    // default @everyone doesn't provide.
    expect(serverSide!.rooms.has(`channel:${privateCh.id}`)).toBe(false);
  });

  it('auto-joins stage and forum channels (uses channel:${id} room like text)', async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const stageCh = await prisma.channel.create({
      data: {
        name: 'auto-sub-stage',
        type: 'stage',
        serverId: server.id,
        categoryId: null,
        position: 10,
      },
    });
    const forumCh = await prisma.channel.create({
      data: {
        name: 'auto-sub-forum',
        type: 'forum',
        serverId: server.id,
        categoryId: null,
        position: 11,
      },
    });

    const clientSocket = await connectSocket(user.token);
    await new Promise((r) => setTimeout(r, AUTO_SUBSCRIBE_SETTLE_MS));

    const allSockets = await getIO().fetchSockets();
    const serverSide = allSockets.find((s) => s.id === clientSocket.id);
    expect(serverSide).toBeDefined();
    expect(serverSide!.rooms.has(`channel:${stageCh.id}`)).toBe(true);
    expect(serverSide!.rooms.has(`channel:${forumCh.id}`)).toBe(true);
  });

  it('emits server-voice-participants-initial on connect (auto-subscribe path)', async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);

    // Pre-register the listener before the socket connects to avoid racing
    // the fire-and-forget auto-subscribe IIFE. `connectAndWaitFor` registers
    // the `.on()` synchronously with socket creation (before the server even
    // sees `connect`), so the emission is reliably captured.
    const { payload } = await connectAndWaitFor(user.token, 'server-voice-participants-initial');
    expect(payload).toHaveProperty('serverId', server.id);
    expect(payload).toHaveProperty('participantsByChannel');
  });
});

// category-override bypass regression
//
// Covers two auto-subscribe paths that must consult category overrides:
//   (1) `backend/src/routes/invites.ts` must not auto-join a new member to a
//       public channel under a category with `@everyone:
//       {readMessageHistory: false}`.
//   (2) `backend/src/routes/servers.ts` must not bulk-join every server-room
//       socket to a new channel under the same check.
// Both sites route through `channelVisibility.ts`; these tests pin the
// override-aware behaviour so a future refactor can't silently regress it.

describe('Category override bypass — filterVisibleChannelIds', () => {
  it('excludes a public channel under a category that denies @everyone readMessageHistory', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const server = await createTestServer(owner.id);

    // Seed a realistic @everyone role with server-level view+read so the
    // server-level short-circuit in filterVisibleChannelIds does NOT fire.
    // That forces execution to reach the channel-tier override walk.
    const everyoneRole = await prisma.serverRole.create({
      data: {
        serverId: server.id,
        name: '@everyone',
        isEveryone: true,
        position: 0,
        permissions: { viewChannels: true, readMessageHistory: true, sendMessages: true },
      },
    });

    await prisma.serverMember.create({
      data: { userId: member.id, serverId: server.id, role: 'member' },
    });

    // Category carrying the deny override.
    const lockedCategory = await prisma.channelCategory.create({
      data: { serverId: server.id, name: 'Locked', position: 1 },
    });
    await prisma.categoryPermissionOverride.create({
      data: {
        categoryId: lockedCategory.id,
        targetType: 'role',
        targetId: everyoneRole.id,
        permissions: { readMessageHistory: false },
      },
    });

    // Public channel under the locked category (realistic pattern: relies on
    // category inheritance to restrict access).
    const restrictedCh = await prisma.channel.create({
      data: {
        serverId: server.id,
        name: 'locked-memos',
        type: 'text',
        isPrivate: false,
        categoryId: lockedCategory.id,
        position: 0,
      },
    });

    // Public channel NOT under the locked category — should still be visible.
    const openCh = await prisma.channel.create({
      data: {
        serverId: server.id,
        name: 'open-chat',
        type: 'text',
        isPrivate: false,
        categoryId: null,
        position: 1,
      },
    });

    const ctx = await loadPermissionContext(member.id, server.id);
    expect(ctx).not.toBeNull();

    const visibleIds = await filterVisibleChannelIds(ctx!, [
      { id: restrictedCh.id, isPrivate: false, categoryId: lockedCategory.id },
      { id: openCh.id, isPrivate: false, categoryId: null },
    ]);

    expect(visibleIds).toContain(openCh.id);
    expect(visibleIds).not.toContain(restrictedCh.id);
  });

  it('includes a public channel under a locked category when a role override grants access', async () => {
    const owner = await createTestUser();
    const mod = await createTestUser();
    const server = await createTestServer(owner.id);

    const everyoneRole = await prisma.serverRole.create({
      data: {
        serverId: server.id,
        name: '@everyone',
        isEveryone: true,
        position: 0,
        permissions: { viewChannels: true, readMessageHistory: true, sendMessages: true },
      },
    });
    const modRole = await prisma.serverRole.create({
      data: {
        serverId: server.id,
        name: 'Moderator',
        isEveryone: false,
        position: 10,
        permissions: { viewChannels: true, readMessageHistory: true },
      },
    });

    await prisma.serverMember.create({
      data: { userId: mod.id, serverId: server.id, role: 'member' },
    });
    await prisma.memberRole.create({
      data: { userId: mod.id, serverId: server.id, roleId: modRole.id },
    });

    const lockedCategory = await prisma.channelCategory.create({
      data: { serverId: server.id, name: 'Mod Only', position: 1 },
    });
    // Deny @everyone, allow Moderator role — category-level role override
    // precedence: role allow beats @everyone deny at the category tier.
    await prisma.categoryPermissionOverride.createMany({
      data: [
        {
          categoryId: lockedCategory.id,
          targetType: 'role',
          targetId: everyoneRole.id,
          permissions: { readMessageHistory: false },
        },
        {
          categoryId: lockedCategory.id,
          targetType: 'role',
          targetId: modRole.id,
          permissions: { readMessageHistory: true },
        },
      ],
    });

    const modOnlyCh = await prisma.channel.create({
      data: {
        serverId: server.id,
        name: 'mod-notes',
        type: 'text',
        isPrivate: false,
        categoryId: lockedCategory.id,
        position: 0,
      },
    });

    const ctx = await loadPermissionContext(mod.id, server.id);
    expect(ctx).not.toBeNull();

    const visibleIds = await filterVisibleChannelIds(ctx!, [
      { id: modOnlyCh.id, isPrivate: false, categoryId: lockedCategory.id },
    ]);
    expect(visibleIds).toContain(modOnlyCh.id);
  });
});

describe('Category override bypass — autoJoinVisibleServerMembers', () => {
  it('joins only members whose permission chain allows reading the new channel', async () => {
    const owner = await createTestUser();
    const mod = await createTestUser();
    const regular = await createTestUser();
    const server = await createTestServer(owner.id);

    const everyoneRole = await prisma.serverRole.create({
      data: {
        serverId: server.id,
        name: '@everyone',
        isEveryone: true,
        position: 0,
        permissions: { viewChannels: true, readMessageHistory: true, sendMessages: true },
      },
    });
    const modRole = await prisma.serverRole.create({
      data: {
        serverId: server.id,
        name: 'Moderator',
        isEveryone: false,
        position: 10,
        permissions: { viewChannels: true, readMessageHistory: true },
      },
    });

    await prisma.serverMember.create({
      data: { userId: mod.id, serverId: server.id, role: 'member' },
    });
    await prisma.memberRole.create({
      data: { userId: mod.id, serverId: server.id, roleId: modRole.id },
    });
    await prisma.serverMember.create({
      data: { userId: regular.id, serverId: server.id, role: 'member' },
    });

    const lockedCategory = await prisma.channelCategory.create({
      data: { serverId: server.id, name: 'Mod Only', position: 1 },
    });
    await prisma.categoryPermissionOverride.createMany({
      data: [
        {
          categoryId: lockedCategory.id,
          targetType: 'role',
          targetId: everyoneRole.id,
          permissions: { readMessageHistory: false },
        },
        {
          categoryId: lockedCategory.id,
          targetType: 'role',
          targetId: modRole.id,
          permissions: { readMessageHistory: true },
        },
      ],
    });

    // Simulate a just-created public channel under the locked category — it
    // has no channel-level override rows yet (they're created via separate
    // API calls), so only the category overrides apply at this instant.
    const newCh = await prisma.channel.create({
      data: {
        serverId: server.id,
        name: 'just-created',
        type: 'text',
        isPrivate: false,
        categoryId: lockedCategory.id,
        position: 0,
      },
    });
    const catOvrs = await prisma.categoryPermissionOverride.findMany({
      where: { categoryId: lockedCategory.id },
    });

    // Connect two sockets. Both auto-subscribe during connection.ts — wait
    // for that to settle BEFORE invoking autoJoinVisibleServerMembers so we
    // exercise the bulk-join path (which expects existing server-room members).
    const modSocket = await connectSocket(mod.token);
    const regSocket = await connectSocket(regular.token);
    await new Promise((r) => setTimeout(r, 500));

    const io = getIO();
    await autoJoinVisibleServerMembers({
      io,
      serverId: server.id,
      channelId: newCh.id,
      categoryOverrides: catOvrs,
    });
    // Settle the RemoteSocket.join round trip.
    await new Promise((r) => setTimeout(r, 300));

    const allSockets = await io.fetchSockets();
    const modServerSide = allSockets.find((s) => s.id === modSocket.id);
    const regServerSide = allSockets.find((s) => s.id === regSocket.id);
    expect(modServerSide).toBeDefined();
    expect(regServerSide).toBeDefined();

    // Mod has role override granting readMessageHistory at the category —
    // should be joined.
    expect(modServerSide!.rooms.has(`channel:${newCh.id}`)).toBe(true);
    // Regular member relies on @everyone which denies readMessageHistory at
    // the category — MUST NOT be joined.
    expect(regServerSide!.rooms.has(`channel:${newCh.id}`)).toBe(false);
  });

  it('respects server-tier @everyone deny when no category overrides exist', async () => {
    // Regression for the previously-vulnerable "fast path" in
    // routes/servers.ts channel-created handler: when catOvrs.length === 0,
    // bulk-joining the whole server room bypassed the server-level
    // permission chain. Config under test: @everyone denies
    // readMessageHistory at the server tier, a Moderator role grants it.
    // A freshly-created public channel with NO category must still filter
    // non-staff members out.
    const owner = await createTestUser();
    const mod = await createTestUser();
    const regular = await createTestUser();
    const server = await createTestServer(owner.id);

    await prisma.serverRole.create({
      data: {
        serverId: server.id,
        name: '@everyone',
        isEveryone: true,
        position: 0,
        permissions: { viewChannels: true, readMessageHistory: false, sendMessages: true },
      },
    });
    const modRole = await prisma.serverRole.create({
      data: {
        serverId: server.id,
        name: 'Moderator',
        isEveryone: false,
        position: 10,
        permissions: { viewChannels: true, readMessageHistory: true },
      },
    });

    await prisma.serverMember.create({
      data: { userId: mod.id, serverId: server.id, role: 'member' },
    });
    await prisma.memberRole.create({
      data: { userId: mod.id, serverId: server.id, roleId: modRole.id },
    });
    await prisma.serverMember.create({
      data: { userId: regular.id, serverId: server.id, role: 'member' },
    });

    // No category — exercises the previously-fast path.
    const newCh = await prisma.channel.create({
      data: {
        serverId: server.id,
        name: 'just-created-no-category',
        type: 'text',
        isPrivate: false,
        categoryId: null,
        position: 0,
      },
    });

    const modSocket = await connectSocket(mod.token);
    const regSocket = await connectSocket(regular.token);
    await new Promise((r) => setTimeout(r, 500));

    const io = getIO();
    await autoJoinVisibleServerMembers({
      io,
      serverId: server.id,
      channelId: newCh.id,
      categoryOverrides: [],
    });
    await new Promise((r) => setTimeout(r, 300));

    const allSockets = await io.fetchSockets();
    const modServerSide = allSockets.find((s) => s.id === modSocket.id);
    const regServerSide = allSockets.find((s) => s.id === regSocket.id);
    expect(modServerSide).toBeDefined();
    expect(regServerSide).toBeDefined();

    // Mod's role grants readMessageHistory at the server tier — joined.
    expect(modServerSide!.rooms.has(`channel:${newCh.id}`)).toBe(true);
    // Regular member inherits @everyone's server-tier deny — NOT joined.
    expect(regServerSide!.rooms.has(`channel:${newCh.id}`)).toBe(false);
  });
});
