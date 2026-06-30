// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Producer helpers — enqueue jobs with fallback to inline execution.
 *
 * When Redis is available, jobs are enqueued to BullMQ.
 * When Redis is not available, the operation runs inline (synchronously)
 * so local dev works without Redis.
 */

import { emailQueue, imageQueue, importQueue, notificationQueue, cleanupQueue, dataExportQueue, steamActivityQueue, spotifyActivityQueue, eventReminderQueue, threadArchiveQueue, showcaseRefreshQueue, twitchActivityQueue, youtubeActivityQueue, analyticsQueue, serverStatsQueue, discoveryEligibilityQueue } from './index.js';
import { sendVerificationEmail, sendPasswordResetEmail, sendMfaSmsCode, sendDataExportReadyEmail, sendEmailChangedNotification, sendAdminDisabledMfaEmail, sendAdminChangedEmailNotification, sendAdminDeletedSessionsEmail, sendAdminPasswordResetEmail, sendPasswordInstalledEmail, sendEmailChangedWithRevertEmail, sendNewDeviceLoginEmail, sendDeviceVerificationEmail, sendUsernameResetRequiredEmail } from '../services/email.js';
import { logger } from '../logger.js';
import type { EmailJobData } from './workers/email.worker.js';
import type { ImageJobData } from './workers/image.worker.js';
import type { ImportJobData } from './workers/import.worker.js';
import type { NotificationJobData } from './workers/notification.worker.js';
import type { CleanupJobData } from './workers/cleanup.worker.js';
import type { DataExportJobData } from './workers/export.worker.js';

const log = logger.child({ module: 'producers' });

// Email

export async function enqueueEmail(data: EmailJobData): Promise<void> {
  if (emailQueue) {
    await emailQueue.add(data.type, data, {
      priority: data.type === 'mfaSms' ? 1 : 2,
      removeOnComplete: true,
      removeOnFail: 50,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    return;
  }
  // Inline fallback
  try {
    switch (data.type) {
      case 'verification':
        await sendVerificationEmail(data.to, data.code);
        break;
      case 'passwordReset':
        await sendPasswordResetEmail(data.to, data.code);
        break;
      case 'mfaSms':
        await sendMfaSmsCode(data.phone, data.code);
        break;
      case 'dataExportReady':
        await sendDataExportReadyEmail(data.to, data.code);
        break;
      case 'emailChanged':
        await sendEmailChangedNotification(data.to, data.newEmail);
        break;
      case 'adminDisabledMfa':
        await sendAdminDisabledMfaEmail(data.to);
        break;
      case 'adminChangedEmail':
        await sendAdminChangedEmailNotification(data.to, data.addressee, data.newEmail);
        break;
      case 'adminDeletedSessions':
        await sendAdminDeletedSessionsEmail(data.to);
        break;
      case 'adminPasswordReset':
        await sendAdminPasswordResetEmail(data.to);
        break;
      case 'passwordInstalled':
        await sendPasswordInstalledEmail(data.to);
        break;
      case 'emailChangedWithRevert':
        await sendEmailChangedWithRevertEmail(data.to, data.newEmail, data.revertUrl);
        break;
      case 'newDeviceLogin':
        await sendNewDeviceLoginEmail(data.to, {
          deviceName: data.deviceName,
          ipMasked: data.ipMasked,
          loginAt: new Date(data.loginAtIso),
          revokeUrl: data.revokeUrl,
        });
        break;
      case 'deviceVerify':
        await sendDeviceVerificationEmail(data.to, {
          code: data.code,
          deviceLabel: data.deviceLabel,
          ipMasked: data.ipMasked,
        });
        break;
      case 'usernameResetRequired':
        await sendUsernameResetRequiredEmail(data.to, {
          oldUsername: data.oldUsername,
          newUsername: data.newUsername,
          reason: data.reason,
        });
        break;
    }
  } catch (err) {
    log.error({ err, data: { type: data.type } }, 'inline email failed');
  }
}

// Image Processing

export async function enqueueImageProcessing(data: ImageJobData): Promise<void> {
  if (imageQueue) {
    await imageQueue.add('compress', data);
    return;
  }
  // Inline fallback: compression already handled in upload.ts when queues are disabled
}

// Discord Import

export async function enqueueDiscordImport(data: ImportJobData): Promise<string | null> {
  if (importQueue) {
    const job = await importQueue.add('discord-import', data);
    return job.id ?? null;
  }
  return null; // caller should fall back to inline processing
}

// Notifications

export async function enqueueNotification(data: NotificationJobData): Promise<void> {
  if (notificationQueue) {
    await notificationQueue.add(data.type, data, {
      removeOnComplete: { age: 300, count: 5000 },
      removeOnFail: 50,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    return;
  }
  // Inline fallback: handled directly in caller
}

// Cleanup

export async function enqueueCleanup(data: CleanupJobData): Promise<void> {
  if (cleanupQueue) {
    await cleanupQueue.add(data.task, data);
    return;
  }
  // Inline fallback for admin-triggered tasks that need to run even without
  // BullMQ (single-instance dev). Cron-only tasks fall through unhandled —
  // they are scheduled via upsertJobScheduler and only run when queues exist.
  if (data.task === 'imageHashSweep') {
    try {
      const { sweepImageHashes } = await import('./workers/cleanup.worker.js');
      // Run async — admin endpoints expect a fast 202, not the sweep result.
      sweepImageHashes().catch(err => log.error({ err }, 'inline imageHashSweep failed'));
    } catch (err) {
      log.error({ err }, 'inline imageHashSweep import failed');
    }
  }
}

// Data Export

export async function enqueueDataExport(data: DataExportJobData): Promise<void> {
  if (dataExportQueue) {
    await dataExportQueue.add('export', data, { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } });
    return;
  }
  // Inline fallback for local dev without Redis
  log.info({ requestId: data.requestId }, 'running data export inline (no Redis)');
  try {
    const { processExportInline } = await import('./workers/export.worker.js');
    await processExportInline(data);
  } catch (err) {
    log.error({ err, requestId: data.requestId }, 'inline data export failed');
  }
}

/** Schedule the recurring cleanup jobs (call once at startup). */
export async function scheduleRecurringCleanup(): Promise<void> {
  if (!cleanupQueue) return;

  // Lightweight tasks — run together at 03:00 UTC
  await cleanupQueue.upsertJobScheduler('cleanup-lightweight', { pattern: '0 3 * * *' }, {
    name: 'lightweight',
    data: { task: 'lightweight' } satisfies CleanupJobData,
  });

  // Heavy tasks — stagger throughout the night to avoid DB contention
  await cleanupQueue.upsertJobScheduler('cleanup-messageRetention', { pattern: '30 2 * * *' }, {
    name: 'messageRetention',
    data: { task: 'messageRetention' } satisfies CleanupJobData,
  });

  await cleanupQueue.upsertJobScheduler('cleanup-orphanAttachments', { pattern: '0 4 * * *' }, {
    name: 'orphanAttachments',
    data: { task: 'orphanAttachments' } satisfies CleanupJobData,
    // Forensic retention overrides for THIS job only — the global queue
    // defaults (1h completed, 24h failed) can evict the BullMQ records for a
    // failed cleanup before it can be investigated. 24h completed + 7d failed
    // lets us inspect processedOn/finishedOn/attemptsMade/failedReason after the fact.
    opts: {
      removeOnComplete: { age: 86_400, count: 30 },
      removeOnFail: { age: 604_800, count: 30 },
    },
  });

  await cleanupQueue.upsertJobScheduler('cleanup-stalePresence', { pattern: '*/5 * * * *' }, {
    name: 'stalePresence',
    data: { task: 'stalePresence' } satisfies CleanupJobData,
  });

  await cleanupQueue.upsertJobScheduler('cleanup-expiredTemporaryMembers', { pattern: '*/5 * * * *' }, {
    name: 'expiredTemporaryMembers',
    data: { task: 'expiredTemporaryMembers' } satisfies CleanupJobData,
  });

  // Re-fire the Remove trigger for stuck pendingRemoval rows whose elected
  // committer was offline when the owner authorized the removal.
  await cleanupQueue.upsertJobScheduler('cleanup-mlsStalePendingRemoval', { pattern: '*/15 * * * *' }, {
    name: 'mlsStalePendingRemoval',
    data: { task: 'mlsStalePendingRemoval' } satisfies CleanupJobData,
  });

  // Prune consumed/expired MlsKeyPackage + stale/orphaned MlsWelcome rows
  // (no other path deletes them). Daily is ample for a retention backstop.
  await cleanupQueue.upsertJobScheduler('cleanup-mlsRetentionSweep', { pattern: '0 5 * * *' }, {
    name: 'mlsRetentionSweep',
    data: { task: 'mlsRetentionSweep' } satisfies CleanupJobData,
  });

  log.info('scheduled cleanup jobs: lightweight@03:00, messageRetention@02:30, orphanAttachments@04:00, stalePresence@*/5min, expiredTemporaryMembers@*/5min, mlsStalePendingRemoval@*/15min, mlsRetentionSweep@05:00');
}

// Steam Activity Polling

const STEAM_POLL_INTERVAL_MS = Math.max(30_000, parseInt(process.env.STEAM_POLL_INTERVAL_MS || '60000', 10) || 60_000);

export async function scheduleSteamActivityPolling(): Promise<void> {
  if (!steamActivityQueue) return;

  await steamActivityQueue.upsertJobScheduler('steam-activity-poll', {
    every: STEAM_POLL_INTERVAL_MS,
  }, {
    name: 'poll',
    data: {},
  });

  log.info({ intervalMs: STEAM_POLL_INTERVAL_MS }, 'scheduled steam activity polling');
}

// Spotify Activity Polling

const SPOTIFY_POLL_INTERVAL_MS = Math.max(15_000, parseInt(process.env.SPOTIFY_POLL_INTERVAL_MS || '30000', 10) || 30_000);

export async function scheduleSpotifyActivityPolling(): Promise<void> {
  if (!spotifyActivityQueue) return;

  await spotifyActivityQueue.upsertJobScheduler('spotify-activity-poll', {
    every: SPOTIFY_POLL_INTERVAL_MS,
  }, {
    name: 'poll',
    data: {},
  });

  log.info({ intervalMs: SPOTIFY_POLL_INTERVAL_MS }, 'scheduled spotify activity polling');
}

// Event Reminder Polling

const EVENT_REMINDER_INTERVAL_MS = 60_000;

export async function scheduleEventReminderPolling(): Promise<void> {
  if (!eventReminderQueue) return;

  await eventReminderQueue.upsertJobScheduler('event-reminder-check', {
    every: EVENT_REMINDER_INTERVAL_MS,
  }, {
    name: 'check-reminders',
    data: {},
  });

  log.info({ intervalMs: EVENT_REMINDER_INTERVAL_MS }, 'scheduled event reminder polling');
}

// Thread Auto-Archive Polling

const THREAD_ARCHIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export async function scheduleThreadArchivePolling(): Promise<void> {
  if (!threadArchiveQueue) return;

  await threadArchiveQueue.upsertJobScheduler('thread-archive-check', {
    every: THREAD_ARCHIVE_INTERVAL_MS,
  }, {
    name: 'check-thread-archive',
    data: {},
  });

  log.info({ intervalMs: THREAD_ARCHIVE_INTERVAL_MS }, 'scheduled thread archive polling');
}

// Showcase Stats Refresh

const SHOWCASE_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes — checks which caches are stale

export async function scheduleShowcaseRefreshPolling(): Promise<void> {
  if (!showcaseRefreshQueue) return;

  await showcaseRefreshQueue.upsertJobScheduler('showcase-refresh-poll', {
    every: SHOWCASE_REFRESH_INTERVAL_MS,
  }, {
    name: 'refresh-stale',
    data: {},
  });

  log.info({ intervalMs: SHOWCASE_REFRESH_INTERVAL_MS }, 'scheduled showcase stats refresh polling');
}

// Twitch Live Status Polling

const TWITCH_POLL_INTERVAL_MS = 60_000; // 60 seconds

export async function scheduleTwitchActivityPolling(): Promise<void> {
  if (!twitchActivityQueue) return;

  await twitchActivityQueue.upsertJobScheduler('twitch-activity-poll', {
    every: TWITCH_POLL_INTERVAL_MS,
  }, {
    name: 'poll',
    data: {},
  });

  log.info({ intervalMs: TWITCH_POLL_INTERVAL_MS }, 'scheduled twitch activity polling');
}

// YouTube Live Status Polling

const YOUTUBE_POLL_INTERVAL_MS = 90_000; // 90 seconds (conserve YouTube API quota)

export async function scheduleYouTubeActivityPolling(): Promise<void> {
  if (!youtubeActivityQueue) return;

  await youtubeActivityQueue.upsertJobScheduler('youtube-activity-poll', {
    every: YOUTUBE_POLL_INTERVAL_MS,
  }, {
    name: 'poll',
    data: {},
  });

  log.info({ intervalMs: YOUTUBE_POLL_INTERVAL_MS }, 'scheduled youtube activity polling');
}

// Analytics Snapshots

export async function scheduleAnalyticsJobs(): Promise<void> {
  if (!analyticsQueue) return;

  await analyticsQueue.upsertJobScheduler('analytics-hourly', { pattern: '0 * * * *' }, {
    name: 'snapshot',
    data: { type: 'snapshot' },
  });

  await analyticsQueue.upsertJobScheduler('analytics-purge', { pattern: '0 4 * * *' }, {
    name: 'purge',
    data: { type: 'purge' },
  });

  await analyticsQueue.upsertJobScheduler('protocol-snapshot-hourly', { pattern: '0 * * * *' }, {
    name: 'protocol-snapshot',
    data: { type: 'protocol-snapshot' },
  });

  await analyticsQueue.upsertJobScheduler('protocol-purge-daily', { pattern: '15 4 * * *' }, {
    name: 'protocol-purge',
    data: { type: 'protocol-purge' },
  });

  log.info('scheduled analytics jobs: snapshot@hourly, purge@04:00, protocol-snapshot@hourly, protocol-purge@04:15');
}

// Server stats rollup (public/community-servers)

/**
 * Schedule the daily server-stats rollup at 00:30 UTC.
 *
 * The job computes one DailyServerStats row per server for the *previous*
 * UTC day. We pick 00:30 (rather than 00:00) so the worker doesn't race
 * with the cleanup-lightweight job at 03:00 nor with timezone-edge writes
 * still trickling in around the day boundary.
 *
 * DM E2E sanctity: the worker queries Server / ServerMember / Channel /
 * Message only — DM tables are not touched.
 */
export async function scheduleServerStatsJobs(): Promise<void> {
  if (!serverStatsQueue) return;

  await serverStatsQueue.upsertJobScheduler('server-stats-daily', { pattern: '30 0 * * *' }, {
    name: 'daily',
    data: { type: 'daily' },
  });

  log.info('scheduled server stats jobs: daily@00:30 UTC');
}

// Discovery-eligibility refresh (size/age/activity gates for /discover)

/**
 * Schedule the nightly discovery-eligibility refresh at 01:00 UTC. Walks
 * every `discoveryEnabled=true` server and recomputes
 * `ServerSettings.eligibleForDiscoverySince` so cached eligibility doesn't
 * drift when membership/activity changes between owner reads.
 *
 * Runs after the server-stats rollup (00:30 UTC) so the activity gate
 * reads the freshest stats.
 */
export async function scheduleDiscoveryEligibilityJobs(): Promise<void> {
  if (!discoveryEligibilityQueue) return;

  await discoveryEligibilityQueue.upsertJobScheduler(
    'discovery-eligibility-daily',
    { pattern: '0 1 * * *' },
    {
      name: 'daily',
      data: {},
    },
  );

  log.info('scheduled discovery-eligibility refresh: daily@01:00 UTC');
}
