// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Analytics snapshot + purge worker.
 *
 * Job types:
 *   - snapshot: counts online users per region from connected sockets, inserts AnalyticsSnapshot rows
 *   - purge: deletes AnalyticsSnapshot records older than 6 months
 *   - protocol-snapshot: counts (buildDate, platform, protocolVersion) buckets across
 *     connected sockets, inserts ProtocolDistributionSnapshot rows for version adoption tracking
 *   - protocol-purge: deletes ProtocolDistributionSnapshot records older than 60 days
 */

import { Worker, Job } from 'bullmq';
import { redisConnection, queuesEnabled } from '../connection.js';
import { prisma } from '../../db.js';
import { logger } from '../../logger.js';
import { analyticsJobSchema } from '../workerSchemas.js';
import { getIO } from '../../socketIO.js';

const log = logger.child({ module: 'worker:analytics' });

export type ProtocolSocketLike = {
  data?: { protocolContext?: { buildDate: string | null; protocolVersion: number | null } };
  handshake: { headers: Record<string, unknown> };
};

export function bucketProtocolSockets(sockets: ReadonlyArray<ProtocolSocketLike>): Array<{
  buildDate: string | null;
  platform: string;
  protocolVersion: number | null;
  count: number;
}> {
  type BucketKey = { buildDate: string | null; platform: string; protocolVersion: number | null };
  const buckets = new Map<string, { key: BucketKey; count: number }>();

  for (const socket of sockets) {
    const ctx = socket.data?.protocolContext;
    const buildDate = ctx?.buildDate ?? null;
    const protocolVersion = ctx?.protocolVersion ?? null;
    const ua = (socket.handshake.headers['user-agent'] as string | undefined) ?? '';
    const platform = /Electron\//.test(ua) ? 'electron' : (ua ? 'web' : 'unknown');

    const bucketKey: BucketKey = { buildDate, platform, protocolVersion };
    const mapKey = JSON.stringify(bucketKey);
    const existing = buckets.get(mapKey);
    if (existing) {
      existing.count += 1;
    } else {
      buckets.set(mapKey, { key: bucketKey, count: 1 });
    }
  }

  return Array.from(buckets.values()).map(({ key, count }) => ({
    ...key,
    count,
  }));
}

const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;

async function processJob(job: Job): Promise<void> {
  const parsed = analyticsJobSchema.safeParse(job.data);
  if (!parsed.success) {
    log.error({ jobId: job.id, errors: parsed.error.flatten() }, 'invalid analytics job payload');
    return;
  }

  const { type } = parsed.data;

  if (type === 'snapshot') {
    await takeSnapshot();
  } else if (type === 'purge') {
    await purgeOldSnapshots();
  } else if (type === 'protocol-snapshot') {
    await takeProtocolSnapshot();
  } else if (type === 'protocol-purge') {
    await purgeProtocolSnapshots();
  }
}

async function takeSnapshot(): Promise<void> {
  let io;
  try {
    io = getIO();
  } catch {
    log.warn('Socket.IO not initialized — skipping analytics snapshot');
    return;
  }

  const sockets = await io.sockets.fetchSockets();
  const regionCounts = new Map<string, number>();

  for (const socket of sockets) {
    const region: string = socket.data.region ?? 'AF';
    regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
  }

  if (regionCounts.size === 0) {
    log.debug('no connected sockets — skipping snapshot');
    return;
  }

  const now = new Date();
  const rows = Array.from(regionCounts.entries()).map(([region, onlineCount]) => ({
    timestamp: now,
    region,
    onlineCount,
  }));

  await prisma.analyticsSnapshot.createMany({
    data: rows,
    skipDuplicates: true,
  });

  log.info({ regions: regionCounts.size, totalOnline: sockets.length }, 'analytics snapshot recorded');
}

async function purgeOldSnapshots(): Promise<void> {
  const sixMonthsAgo = new Date(Date.now() - SIX_MONTHS_MS);

  const result = await prisma.analyticsSnapshot.deleteMany({
    where: { timestamp: { lt: sixMonthsAgo } },
  });

  log.info({ deleted: result.count, olderThan: sixMonthsAgo.toISOString() }, 'purged old analytics snapshots');
}

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

async function takeProtocolSnapshot(): Promise<void> {
  let io;
  try {
    io = getIO();
  } catch {
    log.warn('Socket.IO not initialized — skipping protocol snapshot');
    return;
  }

  const sockets = await io.sockets.fetchSockets();
  const bucketed = bucketProtocolSockets(sockets as unknown as ProtocolSocketLike[]);

  if (bucketed.length === 0) {
    log.debug('no connected sockets — skipping protocol snapshot');
    return;
  }

  const now = new Date();
  const rows = bucketed.map(b => ({ ...b, timestamp: now }));

  await prisma.protocolDistributionSnapshot.createMany({
    data: rows,
    skipDuplicates: true,
  });

  log.info({ buckets: rows.length, totalOnline: sockets.length }, 'protocol distribution snapshot recorded');
}

async function purgeProtocolSnapshots(): Promise<void> {
  const cutoff = new Date(Date.now() - SIXTY_DAYS_MS);
  const result = await prisma.protocolDistributionSnapshot.deleteMany({
    where: { timestamp: { lt: cutoff } },
  });
  log.info({ deleted: result.count, olderThan: cutoff.toISOString() }, 'purged old protocol distribution snapshots');
}

export function startAnalyticsWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;

  const worker = new Worker('analytics', processJob, {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: 30_000,
  });

  worker.on('failed', (job, err) => {
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (job && job.attemptsMade >= maxAttempts) {
      log.error({ jobId: job.id, err, attemptsMade: job.attemptsMade }, 'DEAD_LETTER: analytics job permanently failed after all retries');
    } else {
      log.warn({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'analytics job failed (will retry)');
    }
  });

  log.info('analytics worker started');
  return worker;
}
