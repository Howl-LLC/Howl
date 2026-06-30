// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Discovery-eligibility refresh worker.
 *
 * Nightly job that walks every `discoveryEnabled=true` server and recomputes
 * `ServerSettings.eligibleForDiscoverySince` based on the latest size, age,
 * activity, and community-mode quality state. Required because the cached
 * column is set/cleared lazily on owner reads — without a sweep, a server
 * that drops below thresholds (member loss, activity falloff) would stay
 * listed on /discover until an owner happens to re-open the settings panel.
 *
 * Idempotent. Bounded batches. No DM tables touched.
 */

import { Worker, Job } from 'bullmq';
import { Prisma } from '../../../generated/prisma-client-v7/client.js';
import { redisConnection, queuesEnabled } from '../connection.js';
import { prisma } from '../../db.js';
import { logger } from '../../logger.js';
import { discoveryEligibilityJobSchema } from '../workerSchemas.js';
import { evaluateDiscoveryEligibility } from '../../utils/discoveryEligibility.js';
import { invalidateDiscoveryEligibility } from '../../services/discoveryEligibilityCache.js';

const log = logger.child({ module: 'worker:discovery-eligibility-refresh' });

const SERVER_BATCH_SIZE = 500;
// Hard upper bound on the cursor loop. 1M servers ÷ 500/batch = 2000 ticks;
// 4000 is a generous safety margin so a runaway cursor can't loop forever.
const MAX_BATCHES = 4000;

interface BatchResult {
  count: number;
  becameEligible: number;
  becameIneligible: number;
  unchanged: number;
  nextCursor: string | null;
}

async function processBatch(cursor: string | null): Promise<BatchResult> {
  const args: Prisma.ServerSettingsFindManyArgs = {
    where: { discoveryEnabled: true },
    select: {
      serverId: true,
      eligibleForDiscoverySince: true,
    },
    orderBy: { serverId: 'asc' },
    take: SERVER_BATCH_SIZE,
  };
  if (cursor) {
    args.skip = 1;
    args.cursor = { serverId: cursor };
  }

  // Type the result explicitly so the cursor advance below is well-typed.
  const settings = await prisma.serverSettings.findMany(args) as Array<{
    serverId: string;
    eligibleForDiscoverySince: Date | null;
  }>;

  let becameEligible = 0;
  let becameIneligible = 0;
  let unchanged = 0;

  for (const row of settings) {
    try {
      const result = await evaluateDiscoveryEligibility(row.serverId);
      const wasEligible = row.eligibleForDiscoverySince !== null;

      if (result.eligible && !wasEligible) {
        await prisma.serverSettings.update({
          where: { serverId: row.serverId },
          data: { eligibleForDiscoverySince: new Date() },
        });
        await invalidateDiscoveryEligibility(row.serverId);
        becameEligible++;
        log.info({ serverId: row.serverId }, 'server became discovery-eligible');
      } else if (!result.eligible && wasEligible) {
        await prisma.serverSettings.update({
          where: { serverId: row.serverId },
          data: { eligibleForDiscoverySince: null },
        });
        await invalidateDiscoveryEligibility(row.serverId);
        becameIneligible++;
        log.info(
          {
            serverId: row.serverId,
            failedChecks: result.checks.filter((c) => !c.met).map((c) => c.key),
          },
          'server lost discovery eligibility',
        );
      } else {
        unchanged++;
      }
    } catch (err) {
      // One server failing shouldn't poison the whole batch — log and move on.
      log.error({ err, serverId: row.serverId }, 'eligibility refresh failed for server');
    }
  }

  const nextCursor = settings.length === SERVER_BATCH_SIZE ? settings[settings.length - 1].serverId : null;
  return { count: settings.length, becameEligible, becameIneligible, unchanged, nextCursor };
}

export async function runDiscoveryEligibilityRefresh(): Promise<{
  totalServers: number;
  becameEligible: number;
  becameIneligible: number;
  unchanged: number;
}> {
  let cursor: string | null = null;
  let totalServers = 0;
  let totalBecameEligible = 0;
  let totalBecameIneligible = 0;
  let totalUnchanged = 0;

  for (let i = 0; i < MAX_BATCHES; i++) {
    const batch: BatchResult = await processBatch(cursor);
    totalServers += batch.count;
    totalBecameEligible += batch.becameEligible;
    totalBecameIneligible += batch.becameIneligible;
    totalUnchanged += batch.unchanged;
    if (batch.nextCursor === null) break;
    cursor = batch.nextCursor;
  }

  log.info(
    {
      totalServers,
      becameEligible: totalBecameEligible,
      becameIneligible: totalBecameIneligible,
      unchanged: totalUnchanged,
    },
    'discovery-eligibility refresh complete',
  );

  return {
    totalServers,
    becameEligible: totalBecameEligible,
    becameIneligible: totalBecameIneligible,
    unchanged: totalUnchanged,
  };
}

async function processJob(job: Job): Promise<void> {
  const parsed = discoveryEligibilityJobSchema.safeParse(job.data);
  if (!parsed.success) {
    log.error(
      { jobId: job.id, errors: parsed.error.flatten() },
      'invalid discovery-eligibility-refresh job payload',
    );
    return;
  }
  await runDiscoveryEligibilityRefresh();
}

export function startDiscoveryEligibilityRefreshWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;

  const worker = new Worker('discovery-eligibility-refresh', processJob, {
    connection: redisConnection,
    concurrency: 1,
    // Refresh can take a while on a large fleet; 30 min covers ~1k servers
    // at ~1.5s each plus headroom for DB contention. Matches the
    // server-stats worker.
    lockDuration: 30 * 60 * 1000,
  });

  worker.on('failed', (job, err) => {
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (job && job.attemptsMade >= maxAttempts) {
      log.error(
        { jobId: job.id, err, attemptsMade: job.attemptsMade },
        'DEAD_LETTER: discovery-eligibility-refresh job permanently failed after all retries',
      );
    } else {
      log.warn({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'discovery-eligibility-refresh job failed (will retry)');
    }
  });

  log.info('discovery-eligibility-refresh worker started');
  return worker;
}
