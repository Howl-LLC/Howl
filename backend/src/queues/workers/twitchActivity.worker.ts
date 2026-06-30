// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Twitch live status polling worker.
 *
 * Runs as a repeatable BullMQ job (default: every 60s).
 * Calls pollTwitchActivities() which handles broadcasting via fetchAndBroadcastActivities.
 */

import { Worker, Job } from 'bullmq';
import { redisConnection, queuesEnabled } from '../connection.js';
import { logger } from '../../logger.js';
import { pollTwitchActivities } from '../../services/twitchActivity.js';

const log = logger.child({ module: 'worker:twitch-activity' });

async function processJob(_job: Job): Promise<void> {
  const changes = await pollTwitchActivities();
  log.info({ polled: true, changed: changes.length }, 'twitch activity poll complete');
}

export function startTwitchActivityWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;

  const worker = new Worker('twitch-activity', processJob, {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: 180_000,
  });

  worker.on('failed', (job, err) => {
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (job && job.attemptsMade >= maxAttempts) {
      log.error({ jobId: job.id, err, attemptsMade: job.attemptsMade }, 'DEAD_LETTER: twitch activity job permanently failed');
    } else {
      log.warn({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'twitch activity job failed (will retry)');
    }
  });

  log.info('twitch activity worker started');
  return worker;
}
