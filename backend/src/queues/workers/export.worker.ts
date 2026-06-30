// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Data export worker — assembles a user's full data export asynchronously.
 *
 * 1. Gathers all user data (same as the instant GDPR export)
 * 2. Writes JSON to disk (backend/exports/{requestId}.json)
 * 3. Updates DataExportRequest status to "ready" with 14-day expiry
 * 4. Sends a notification email with a download link
 */

import { Worker, Job } from 'bullmq';
import crypto from 'crypto';
import { redisConnection, queuesEnabled } from '../connection.js';
import { prisma } from '../../db.js';
import { logger } from '../../logger.js';
import { exportJobSchema } from '../workerSchemas.js';
import { buildExportData } from '../../services/exportBuilder.js';
import { enqueueEmail } from '../producers.js';
import fs from 'fs/promises';
import path from 'path';
import { EXPORTS_DIR } from '../../exportsDir.js';

const log = logger.child({ module: 'worker:export' });
const EXPORT_RETENTION_DAYS = 14;

export interface DataExportJobData {
  requestId: string;
  userId: string;
}

export async function processExportInline(data: DataExportJobData): Promise<void> {
  return doExport(data.requestId, data.userId);
}

async function processExport(job: Job<DataExportJobData>) {
  const parsed = exportJobSchema.safeParse(job.data);
  if (!parsed.success) {
    log.error({ jobId: job.id, errors: parsed.error.flatten() }, 'invalid export job payload');
    return;
  }
  return doExport(parsed.data.requestId, parsed.data.userId);
}

async function doExport(requestId: string, userId: string) {

  await prisma.dataExportRequest.update({
    where: { id: requestId },
    data: { status: 'processing' },
  });

  try {
    const exportData = await buildExportData(userId);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- EXPORTS_DIR is a trusted server-config constant, not user input
    await fs.mkdir(EXPORTS_DIR, { recursive: true });

    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(requestId)) {
      throw new Error(`Invalid requestId format: ${requestId}`);
    }
    const filePath = path.join(EXPORTS_DIR, `${requestId}.json`);
    const safeFilePath = path.resolve(filePath);
    if (!safeFilePath.startsWith(path.resolve(EXPORTS_DIR) + path.sep) && safeFilePath !== path.resolve(EXPORTS_DIR)) {
      throw new Error('Path traversal detected in export file path');
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(filePath, JSON.stringify(exportData, null, 2), 'utf-8');

    const expiresAt = new Date(Date.now() + EXPORT_RETENTION_DAYS * 24 * 3600 * 1000);

    const secureToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(secureToken).digest('hex');
    await prisma.dataExportRequest.update({
      where: { id: requestId },
      data: { status: 'ready', filePath, expiresAt, downloadToken: tokenHash },
    });

    {
      const apiBase = process.env.API_BASE_URL || 'http://localhost:5000/api';
      // Email link uses the plaintext token; DB stores only the hash
      const downloadUrl = `${apiBase}/gdpr/download/${requestId}?token=${secureToken}`;

      await enqueueEmail({
        type: 'dataExportReady',
        to: exportData.profile.email,
        code: downloadUrl,
      } as any);
    }

    log.info({ requestId, userId }, 'data export completed');
  } catch (err: any) {
    log.error({ err, requestId, userId }, 'data export failed');

    await prisma.dataExportRequest.update({
      where: { id: requestId },
      data: { status: 'failed', error: 'Export processing failed' },
    }).catch(() => {});

    throw err;
  }
}

export function startExportWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;
  const worker = new Worker('data-export', processExport, {
    connection: redisConnection,
    concurrency: 2,
    lockDuration: 600_000,
  });
  worker.on('failed', async (job, err) => {
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (job && job.attemptsMade >= maxAttempts) {
      // Export jobs are GDPR user-data exports; never echo job.data into
      // logs. Keep only the request + user IDs.
      log.error({ jobId: job.id, err, requestId: job.data?.requestId, userId: job.data?.userId, attemptsMade: job.attemptsMade }, 'DEAD_LETTER: export job permanently failed after all retries');
      await prisma.dataExportRequest.update({
        where: { id: job.data.requestId },
        data: { status: 'failed', error: 'Export failed after all retries. Please request a new export.' },
      }).catch(() => {});
    } else {
      log.warn({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'export job failed (will retry)');
    }
  });
  worker.on('completed', (job) => log.debug({ jobId: job.id }, 'export job completed'));
  log.info('data-export worker started');
  return worker;
}
