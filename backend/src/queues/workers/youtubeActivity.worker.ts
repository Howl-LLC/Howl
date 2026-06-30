// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * YouTube live status polling worker.
 *
 * Runs as a repeatable BullMQ job (default: every 90s).
 * Calls pollYouTubeActivities() which handles broadcasting via fetchAndBroadcastActivities.
 */

import { Worker, Job } from 'bullmq';
import { redisConnection, queuesEnabled } from '../connection.js';
import { logger } from '../../logger.js';
import { pollYouTubeActivities } from '../../services/youtubeActivity.js';

const log = logger.child({ module: 'worker:youtube-activity' });

async function processJob(_job: Job): Promise<void> {
  const changes = await pollYouTubeActivities();
  log.info({ polled: true, changed: changes.length }, 'youtube activity poll complete');
}

export function startYouTubeActivityWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;

  const worker = new Worker('youtube-activity', processJob, {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: 180_000,
  });

  worker.on('failed', (job, err) => {
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (job && job.attemptsMade >= maxAttempts) {
      log.error({ jobId: job.id, err, attemptsMade: job.attemptsMade }, 'DEAD_LETTER: youtube activity job permanently failed');
    } else {
      log.warn({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'youtube activity job failed (will retry)');
    }
  });

  log.info('youtube activity worker started');
  return worker;
}
