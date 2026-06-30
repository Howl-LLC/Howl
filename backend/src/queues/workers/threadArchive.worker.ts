// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Worker, Job } from 'bullmq';
import { redisConnection, queuesEnabled } from '../connection.js';
import { prisma } from '../../db.js';
import { logger } from '../../logger.js';
import type { Server as IOServer } from 'socket.io';

const log = logger.child({ module: 'worker:thread-archive' });

let io: IOServer | undefined;

export function setThreadArchiveIO(ioServer: IOServer): void {
  io = ioServer;
}

async function processJob(_job: Job): Promise<void> {
  const now = new Date();

  // Find threads that are:
  // - not archived
  // - have autoArchive enabled
  // - lastActivityAt is older than autoArchiveDuration minutes ago
  const candidates = await prisma.thread.findMany({
    where: {
      archived: false,
      autoArchive: true,
    },
    select: {
      id: true,
      channelId: true,
      serverId: true,
      name: true,
      autoArchiveDuration: true,
      lastActivityAt: true,
    },
    take: 200,
  });

  let archivedCount = 0;
  for (const thread of candidates) {
    const expiresAt = new Date(thread.lastActivityAt.getTime() + thread.autoArchiveDuration * 60 * 1000);
    if (expiresAt > now) continue;

    await prisma.thread.update({
      where: { id: thread.id },
      data: { archived: true, archivedAt: now },
    });

    const payload = {
      id: thread.id,
      channelId: thread.channelId,
      serverId: thread.serverId,
      name: thread.name,
      archived: true,
    };

    io?.to(`channel:${thread.channelId}`).to(`server:${thread.serverId}`).emit('thread-archived', payload);
    io?.to(`thread:${thread.id}`).emit('thread-archived', payload);

    archivedCount++;
  }

  if (archivedCount > 0) {
    log.info({ archivedCount }, 'auto-archived inactive threads');
  }
}

export function startThreadArchiveWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;

  const worker = new Worker('thread-archive', processJob, {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: 30_000,
  });

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, 'thread archive job failed');
  });

  log.info('thread archive worker started');
  return worker;
}
