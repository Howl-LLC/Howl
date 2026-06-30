// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Spotify activity polling worker.
 *
 * Runs as a repeatable BullMQ job (default: every 30s).
 * Calls pollSpotifyActivities() which handles broadcasting via broadcastActivityChange.
 */

import { Worker, Job } from 'bullmq';
import { redisConnection, queuesEnabled } from '../connection.js';
import { logger } from '../../logger.js';
import { pollSpotifyActivities } from '../../services/spotifyActivity.js';

const log = logger.child({ module: 'worker:spotify-activity' });

async function processJob(_job: Job): Promise<void> {
  const changes = await pollSpotifyActivities();
  log.info({ polled: true, changed: changes.length }, 'spotify activity poll complete');
}

export function startSpotifyActivityWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;

  const worker = new Worker('spotify-activity', processJob, {
    connection: redisConnection,
    concurrency: 1,
    // 3 min — sequential polling with 100ms delay handles ~1500 users per cycle;
    // lockDuration must exceed worst-case cycle time to prevent stall-retry.
    lockDuration: 180_000,
  });

  worker.on('failed', (job, err) => {
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (job && job.attemptsMade >= maxAttempts) {
      log.error({ jobId: job.id, err, attemptsMade: job.attemptsMade }, 'DEAD_LETTER: spotify activity job permanently failed');
    } else {
      log.warn({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'spotify activity job failed (will retry)');
    }
  });

  log.info('spotify activity worker started');
  return worker;
}
