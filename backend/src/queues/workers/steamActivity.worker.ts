// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Steam activity polling worker.
 *
 * Runs as a repeatable BullMQ job (default: every 60s).
 * Calls pollSteamActivities() which handles broadcasting via broadcastActivityChange.
 */

import { Worker, Job } from 'bullmq';
import { redisConnection, queuesEnabled } from '../connection.js';
import { logger } from '../../logger.js';
import { pollSteamActivities } from '../../services/steamActivity.js';

const log = logger.child({ module: 'worker:steam-activity' });

async function processJob(_job: Job): Promise<void> {
  const changes = await pollSteamActivities();
  log.info({ polled: true, changed: changes.length }, 'steam activity poll complete');
}

export function startSteamActivityWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;

  const worker = new Worker('steam-activity', processJob, {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: 30_000, // 30s job timeout
  });

  worker.on('failed', (job, err) => {
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (job && job.attemptsMade >= maxAttempts) {
      log.error({ jobId: job.id, err, attemptsMade: job.attemptsMade }, 'DEAD_LETTER: steam activity job permanently failed');
    } else {
      log.warn({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'steam activity job failed (will retry)');
    }
  });

  log.info('steam activity worker started');
  return worker;
}
