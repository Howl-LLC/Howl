// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Central queue registry.
 *
 * Each queue is a BullMQ Queue instance when Redis is available,
 * or null when running without Redis (jobs run inline).
 *
 * Producers import queues from here, workers are started from workers/index.ts.
 */

import { Queue } from 'bullmq';
import { queuesEnabled, redisConnection } from './connection.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'queues' });

function createQueue(name: string): Queue | null {
  if (!queuesEnabled || !redisConnection) return null;
  const q = new Queue(name, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600, count: 10000 },
      removeOnFail: { age: 86400, count: 1000 },
    },
  });
  log.info({ queue: name }, 'queue created');
  return q;
}

export const emailQueue = createQueue('email');
export const imageQueue = createQueue('image-processing');
export const importQueue = createQueue('discord-import');
export const notificationQueue = createQueue('notifications');
export const cleanupQueue = createQueue('cleanup');
export const dataExportQueue = createQueue('data-export');
export const steamActivityQueue = createQueue('steam-activity');
export const spotifyActivityQueue = createQueue('spotify-activity');
export const eventReminderQueue = createQueue('event-reminder');
export const threadArchiveQueue = createQueue('thread-archive');
export const showcaseRefreshQueue = createQueue('showcase-refresh');
export const calendarQueue = createQueue('calendar');
export const notificationCleanupQueue = createQueue('notification-cleanup');
export const twitchActivityQueue = createQueue('twitch-activity');
export const youtubeActivityQueue = createQueue('youtube-activity');
export const analyticsQueue = createQueue('analytics');
export const serverStatsQueue = createQueue('server-stats');
export const discoveryEligibilityQueue = createQueue('discovery-eligibility-refresh');

/** All queues for Bull Board and graceful shutdown. */
export const allQueues = [emailQueue, imageQueue, importQueue, notificationQueue, cleanupQueue, dataExportQueue, steamActivityQueue, spotifyActivityQueue, eventReminderQueue, threadArchiveQueue, showcaseRefreshQueue, calendarQueue, notificationCleanupQueue, twitchActivityQueue, youtubeActivityQueue, analyticsQueue, serverStatsQueue, discoveryEligibilityQueue].filter(Boolean) as Queue[];
