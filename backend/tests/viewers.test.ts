// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { httpServer } from '../src/server.js';
import {
  addStreamViewer, removeStreamViewer, getStreamViewers, getStreamViewersPage,
  clearStreamViewersForContext, removeUserFromAllStreams, clearOwnedStreams,
  addVoiceParticipant, removeVoiceParticipant, setVoiceReverseLookup,
} from '../src/redis.js';
import { createTestUser, createTestServer, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import { getIO } from '../src/socketIO.js';

const ctx = { kind: 'voice' as const, scopeId: '00000000-0000-0000-0000-000000000001' };
const dmCtx = { kind: 'dm' as const, scopeId: '00000000-0000-0000-0000-000000000010' };
const stageCtx = { kind: 'stage' as const, scopeId: '00000000-0000-0000-0000-000000000020' };
const ownerId = '00000000-0000-0000-0000-000000000002';
const viewerA = '00000000-0000-0000-0000-0000000000aa';
const viewerB = '00000000-0000-0000-0000-0000000000bb';

describe('redis: stream viewers', () => {
  beforeEach(async () => {
    await clearStreamViewersForContext(ctx);
    await clearStreamViewersForContext(dmCtx);
    await clearStreamViewersForContext(stageCtx);
  });

  it('addStreamViewer / getStreamViewers round-trip', async () => {
    await addStreamViewer(ctx, ownerId, 'screen', viewerA);
    await addStreamViewer(ctx, ownerId, 'screen', viewerB);
    const list = await getStreamViewers(ctx, ownerId, 'screen');
    expect(list.sort()).toEqual([viewerA, viewerB].sort());
  });

  it('removeStreamViewer removes single entry', async () => {
    await addStreamViewer(ctx, ownerId, 'screen', viewerA);
    await addStreamViewer(ctx, ownerId, 'screen', viewerB);
    await removeStreamViewer(ctx, ownerId, 'screen', viewerA);
    expect(await getStreamViewers(ctx, ownerId, 'screen')).toEqual([viewerB]);
  });

  it('removeUserFromAllStreams clears viewer across all streams in context', async () => {
    await addStreamViewer(ctx, ownerId, 'screen', viewerA);
    await addStreamViewer(ctx, '00000000-0000-0000-0000-000000000099', 'screen', viewerA);
    const cleared = await removeUserFromAllStreams(viewerA, ctx);
    expect(cleared.map(c => c.streamOwnerId).sort()).toHaveLength(2);
    expect(await getStreamViewers(ctx, ownerId, 'screen')).toEqual([]);
  });

  it('getStreamViewersPage paginates', async () => {
    for (let i = 0; i < 250; i++) {
      const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
      await addStreamViewer(ctx, ownerId, 'screen', id);
    }
    const page0 = await getStreamViewersPage(ctx, ownerId, 'screen', 0);
    const page1 = await getStreamViewersPage(ctx, ownerId, 'screen', 1);
    const page2 = await getStreamViewersPage(ctx, ownerId, 'screen', 2);
    expect(page0.viewers).toHaveLength(100);
    expect(page1.viewers).toHaveLength(100);
    expect(page2.viewers).toHaveLength(50);
    expect(page0.nextPage).toBe(1);
    expect(page2.nextPage).toBeUndefined();
  });
});

describe('redis: stream viewer cleanup (leave/disconnect)', () => {
  beforeEach(async () => {
    await clearStreamViewersForContext(ctx);
    await clearStreamViewersForContext(dmCtx);
    await clearStreamViewersForContext(stageCtx);
  });

  it('clearOwnedStreams removes all viewer sets for a specific presenter', async () => {
    // viewerA and viewerB are watching ownerId's screen
    await addStreamViewer(ctx, ownerId, 'screen', viewerA);
    await addStreamViewer(ctx, ownerId, 'screen', viewerB);
    // viewerA is also watching another presenter — should not be affected
    const otherOwner = '00000000-0000-0000-0000-000000000099';
    await addStreamViewer(ctx, otherOwner, 'screen', viewerA);

    const cleared = await clearOwnedStreams(ownerId, ctx);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].streamType).toBe('screen');
    // ownerId's stream is gone
    expect(await getStreamViewers(ctx, ownerId, 'screen')).toEqual([]);
    // Other owner's stream is untouched
    expect(await getStreamViewers(ctx, otherOwner, 'screen')).toEqual([viewerA]);
  });

  it('removeUserFromAllStreams handles DM context', async () => {
    await addStreamViewer(dmCtx, ownerId, 'screen', viewerA);
    const cleared = await removeUserFromAllStreams(viewerA, dmCtx);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].streamOwnerId).toBe(ownerId);
    expect(await getStreamViewers(dmCtx, ownerId, 'screen')).toEqual([]);
  });

  it('removeUserFromAllStreams handles stage context', async () => {
    await addStreamViewer(stageCtx, ownerId, 'screen', viewerA);
    const cleared = await removeUserFromAllStreams(viewerA, stageCtx);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].streamOwnerId).toBe(ownerId);
    expect(await getStreamViewers(stageCtx, ownerId, 'screen')).toEqual([]);
  });

  it('removeUserFromAllStreams does not affect other contexts', async () => {
    await addStreamViewer(ctx, ownerId, 'screen', viewerA);
    await addStreamViewer(dmCtx, ownerId, 'screen', viewerA);
    // Only clear voice context
    const cleared = await removeUserFromAllStreams(viewerA, ctx);
    expect(cleared).toHaveLength(1);
    // DM context untouched
    expect(await getStreamViewers(dmCtx, ownerId, 'screen')).toEqual([viewerA]);
  });

  it('clearOwnedStreams + removeUserFromAllStreams together simulate full leave', async () => {
    // User leaves a voice channel where they were both a screen presenter and a viewer of another screen
    const otherOwner = '00000000-0000-0000-0000-000000000099';
    await addStreamViewer(ctx, viewerA, 'screen', viewerB); // viewerB watches viewerA
    await addStreamViewer(ctx, otherOwner, 'screen', viewerA); // viewerA watches otherOwner

    // viewerA leaves: clear their owned streams + remove them from all streams
    const ownedCleared = await clearOwnedStreams(viewerA, ctx);
    const viewerCleared = await removeUserFromAllStreams(viewerA, ctx);

    expect(ownedCleared).toHaveLength(1); // viewerA's screen share cleaned up
    expect(viewerCleared).toHaveLength(1); // viewerA removed from otherOwner's viewers
    expect(viewerCleared[0].streamOwnerId).toBe(otherOwner);

    // viewerA's owned stream is gone
    expect(await getStreamViewers(ctx, viewerA, 'screen')).toEqual([]);
    // otherOwner's stream no longer has viewerA
    expect(await getStreamViewers(ctx, otherOwner, 'screen')).toEqual([]);
  });
});

// socket: end-to-end viewer events

describe('socket: end-to-end viewer events', () => {
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

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    const addr = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
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

  it('two clients: subscribe broadcasts viewer:changed {add}, unsubscribe broadcasts {remove}', async () => {
    // Setup: two users, a server, a voice channel
    const userA = await createTestUser();
    const userB = await createTestUser();
    const server = await createTestServer(userA.id);
    const serverId = server.id;

    // Add userB as a server member
    await prisma.serverMember.create({
      data: { userId: userB.id, serverId, role: 'member' },
    });

    // Create a voice channel
    const cat = server.categories[0];
    const voiceChannel = await prisma.channel.create({
      data: {
        id: randomUUID(),
        name: 'test-voice',
        type: 'voice',
        serverId,
        categoryId: cat?.id ?? null,
        position: 0,
      },
    });
    const channelId = voiceChannel.id;
    const voiceCtx = { kind: 'voice' as const, scopeId: channelId };

    // Connect both sockets
    const sockA = await connectSocket(userA.token);
    const sockB = await connectSocket(userB.token);

    // Seed voice state in Redis so isInVoiceChannel returns true
    await addVoiceParticipant(channelId, userA.id, { username: userA.username } as any);
    await setVoiceReverseLookup(userA.id, channelId);
    await addVoiceParticipant(channelId, userB.id, { username: userB.username } as any);
    await setVoiceReverseLookup(userB.id, channelId);

    // Join server-side sockets into the voice room so they receive broadcasts
    const io = getIO();
    const allSockets = await io.fetchSockets();
    const serverSideA = allSockets.find(s => s.id === sockA.id);
    const serverSideB = allSockets.find(s => s.id === sockB.id);
    serverSideA!.join(`voice:${channelId}`);
    serverSideB!.join(`voice:${channelId}`);

    // Collect viewer:changed events on userB's socket
    const events: Array<{ add?: string[]; remove?: string[]; streamOwnerId?: string }> = [];
    sockB.on('viewer:changed', (p: any) => events.push(p));

    try {
      // userA subscribes to userB's screen share
      const subAck = await new Promise<any>((resolve) => {
        sockA.emit('viewer:subscribe', {
          context: { kind: 'voice', scopeId: channelId },
          streamOwnerId: userB.id,
          streamType: 'screen',
        }, resolve);
      });
      expect(subAck.ok).toBe(true);

      // Wait for coalesce window (100ms) + margin
      await new Promise(r => setTimeout(r, 200));

      // Verify userB observed the add broadcast
      const addEvent = events.find(
        e => e.add?.includes(userA.id) && e.streamOwnerId === userB.id,
      );
      expect(addEvent).toBeDefined();
      expect(addEvent!.add).toContain(userA.id);

      // userA unsubscribes
      const unsubAck = await new Promise<any>((resolve) => {
        sockA.emit('viewer:unsubscribe', {
          context: { kind: 'voice', scopeId: channelId },
          streamOwnerId: userB.id,
          streamType: 'screen',
        }, resolve);
      });
      expect(unsubAck.ok).toBe(true);

      // Wait for coalesce window + margin
      await new Promise(r => setTimeout(r, 200));

      // Verify userB observed the remove broadcast
      const removeEvent = events.find(
        e => e.remove?.includes(userA.id) && e.streamOwnerId === userB.id,
      );
      expect(removeEvent).toBeDefined();
      expect(removeEvent!.remove).toContain(userA.id);
    } finally {
      // Clean up Redis state
      await removeVoiceParticipant(channelId, userA.id);
      await setVoiceReverseLookup(userA.id, null);
      await removeVoiceParticipant(channelId, userB.id);
      await setVoiceReverseLookup(userB.id, null);
      await clearStreamViewersForContext(voiceCtx);
    }
  }, 15_000);
});
