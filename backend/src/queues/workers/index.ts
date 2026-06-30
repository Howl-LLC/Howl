// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Worker startup — call startAllWorkers() once from server.ts.
 * Returns all worker instances for graceful shutdown.
 */

import { Worker } from 'bullmq';
import { startEmailWorker } from './email.worker.js';
import { startImageWorker } from './image.worker.js';
import { startImportWorker } from './import.worker.js';
import { startNotificationWorker } from './notification.worker.js';
import { startCleanupWorker } from './cleanup.worker.js';
import { startExportWorker } from './export.worker.js';
import { startSteamActivityWorker } from './steamActivity.worker.js';
import { startSpotifyActivityWorker } from './spotifyActivity.worker.js';
import { startEventReminderWorker } from './eventReminder.worker.js';
import { startThreadArchiveWorker } from './threadArchive.worker.js';
import { startShowcaseRefreshWorker } from './showcaseRefresh.worker.js';
import { startTwitchActivityWorker } from './twitchActivity.worker.js';
import { startYouTubeActivityWorker } from './youtubeActivity.worker.js';
import { startCalendarWorker, startNotificationCleanupWorker } from './calendar.worker.js';
import { startAnalyticsWorker } from './analytics.worker.js';
import { startServerStatsWorker } from './serverStats.worker.js';
import { startDiscoveryEligibilityRefreshWorker } from './discoveryEligibilityRefresh.worker.js';
import { queuesEnabled } from '../connection.js';
import { logger } from '../../logger.js';

const log = logger.child({ module: 'workers' });

export function startAllWorkers(): Worker[] {
  if (!queuesEnabled) {
    log.info('queues disabled — workers not started');
    return [];
  }

  const workers = [
    startEmailWorker(),
    startImageWorker(),
    startImportWorker(),
    startNotificationWorker(),
    startCleanupWorker(),
    startExportWorker(),
    startSteamActivityWorker(),
    startSpotifyActivityWorker(),
    startEventReminderWorker(),
    startThreadArchiveWorker(),
    startShowcaseRefreshWorker(),
    startCalendarWorker(),
    startNotificationCleanupWorker(),
    startTwitchActivityWorker(),
    startYouTubeActivityWorker(),
    startAnalyticsWorker(),
    startServerStatsWorker(),
    startDiscoveryEligibilityRefreshWorker(),
  ].filter(Boolean) as Worker[];

  log.info({ count: workers.length }, 'all workers started');
  return workers;
}
