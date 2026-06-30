// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Shared BullMQ Redis connection configuration.
 *
 * BullMQ needs its own connection (separate from Socket.IO adapter).
 * When REDIS_URL is unset, queues fall back to synchronous execution
 * so the app works identically in local dev without Redis.
 */

import { logger } from '../logger.js';
import { parseRedisUrl } from '../utils/redisUrl.js';

const log = logger.child({ module: 'bullmq' });

const REDIS_URL = process.env.REDIS_URL || '';
export const queuesEnabled = !!REDIS_URL;

export const redisConnection = queuesEnabled
  ? {
      ...parseRedisUrl(REDIS_URL),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    }
  : undefined;

if (queuesEnabled) {
  log.info('BullMQ queues enabled');
} else {
  log.info('REDIS_URL not set — jobs will run inline (single-instance mode)');
}
