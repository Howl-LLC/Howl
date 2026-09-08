// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * : the auto-archive worker must scope a PRIVATE channel's
 * `thread-archived` broadcast to the `channel:` room only — never the
 * server-wide room — so a member with no viewChannels override cannot learn a
 * private channel's id or a thread's name off the timer. Public channels keep
 * the server-room copy. Mirrors the manual archive path in routes/threads.ts,
 * which is exercised by the socket harness; this locks the worker path, which
 * the harness does not drive.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Job } from 'bullmq';
import { processJob, setThreadArchiveIO } from '../src/queues/workers/threadArchive.worker.js';
import { createTestUser, createTestServer, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';

// Socket.IO stub that records the full room chain per emit, so we can assert
// io.to(a).to(b).emit(...) targeted exactly {a, b}.
function makeIo() {
  const emits: { rooms: string[]; event: string; payload: Record<string, unknown> }[] = [];
  function chain(rooms: string[]) {
    return {
      to: (room: string) => chain([...rooms, room]),
      emit: (event: string, payload: Record<string, unknown>) => {
        emits.push({ rooms, event, payload });
      },
    };
  }
  const io = { to: (room: string) => chain([room]) };
  return { io: io as unknown as import('socket.io').Server, emits };
}

async function seedOverdueThread(
  serverId: string,
  authorId: string,
  isPrivate: boolean,
): Promise<{ channelId: string; threadId: string }> {
  const cat = await prisma.channelCategory.findFirst({ where: { serverId } });
  const maxPos = await prisma.channel.aggregate({
    where: { serverId, categoryId: cat?.id ?? null }, _max: { position: true },
  });
  const channel = await prisma.channel.create({
    data: {
      id: randomUUID(),
      name: `${isPrivate ? 'private' : 'public'}-${Date.now()}-${Math.floor(performance.now())}`,
      type: 'text',
      serverId,
      categoryId: cat?.id ?? null,
      position: (maxPos._max.position ?? -1) + 1,
      isPrivate,
    },
  });
  const thread = await prisma.thread.create({
    data: {
      id: randomUUID(),
      channelId: channel.id,
      parentMessageId: randomUUID(),
      serverId,
      name: `${isPrivate ? 'SECRET' : 'PUBLIC'}-thread-${randomUUID().slice(0, 8)}`,
      authorId,
      archived: false,
      autoArchive: true,
      autoArchiveDuration: 60,
      // well past its 60-minute window so the worker archives it this run
      lastActivityAt: new Date(Date.now() - 1000 * 60 * 60 * 24),
    },
  });
  return { channelId: channel.id, threadId: thread.id };
}

describe('thread-archive worker scopes private channels to the channel room', () => {
  let owner: TestUser;
  let serverId: string;
  let priv: { channelId: string; threadId: string };
  let pub: { channelId: string; threadId: string };
  let emits: ReturnType<typeof makeIo>['emits'];

  beforeAll(async () => {
    owner = await createTestUser();
    const server = await createTestServer(owner.id);
    serverId = server.id;
    priv = await seedOverdueThread(serverId, owner.id, true);
    pub = await seedOverdueThread(serverId, owner.id, false);

    const io = makeIo();
    emits = io.emits;
    setThreadArchiveIO(io.io);
    await processJob({} as Job);
  });

  afterAll(async () => {
    setThreadArchiveIO(undefined as unknown as import('socket.io').Server);
    await prisma.thread.deleteMany({ where: { serverId } });
    await prisma.channel.deleteMany({ where: { serverId } });
    await cleanupTestData();
  });

  it('archives both overdue threads', async () => {
    const p = await prisma.thread.findUniqueOrThrow({ where: { id: priv.threadId } });
    const q = await prisma.thread.findUniqueOrThrow({ where: { id: pub.threadId } });
    expect(p.archived).toBe(true);
    expect(q.archived).toBe(true);
  });

  it('emits the PRIVATE thread-archived to the channel room and thread room only — never server', () => {
    const roomChains = emits
      .filter((e) => e.event === 'thread-archived' && e.payload.id === priv.threadId)
      .map((e) => e.rooms);
    // one channel-scoped emit + one thread-scoped emit
    expect(roomChains).toContainEqual([`channel:${priv.channelId}`]);
    expect(roomChains).toContainEqual([`thread:${priv.threadId}`]);
    // the private channel id / thread name must never reach the server room
    for (const rooms of roomChains) {
      expect(rooms).not.toContain(`server:${serverId}`);
    }
  });

  it('emits the PUBLIC thread-archived to channel + server (unchanged behavior)', () => {
    const roomChains = emits
      .filter((e) => e.event === 'thread-archived' && e.payload.id === pub.threadId)
      .map((e) => e.rooms);
    expect(roomChains).toContainEqual([`channel:${pub.channelId}`, `server:${serverId}`]);
    expect(roomChains).toContainEqual([`thread:${pub.threadId}`]);
  });
});
