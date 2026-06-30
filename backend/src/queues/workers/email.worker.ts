// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Email / SMS delivery worker.
 *
 * Job data variants:
 *   { type: 'verification', to: string, code: string }
 *   { type: 'passwordReset', to: string, code: string }
 *   { type: 'mfaSms', phone: string, code: string }
 *   { type: 'dataExportReady', to: string, code: string }
 *   { type: 'emailChanged', to: string, newEmail: string }
 */

import { Worker, Job } from 'bullmq';
import { redisConnection, queuesEnabled } from '../connection.js';
import { sendVerificationEmail, sendPasswordResetEmail, sendMfaSmsCode, sendDataExportReadyEmail, sendEmailChangedNotification, sendAdminDisabledMfaEmail, sendAdminChangedEmailNotification, sendAdminDeletedSessionsEmail, sendAdminPasswordResetEmail, sendPasswordInstalledEmail, sendEmailChangedWithRevertEmail, sendNewDeviceLoginEmail, sendDeviceVerificationEmail, sendUsernameResetRequiredEmail } from '../../services/email.js';
import { logger } from '../../logger.js';
import { emailJobSchema } from '../workerSchemas.js';

const log = logger.child({ module: 'worker:email' });

export type EmailJobData =
  | { type: 'verification'; to: string; code: string }
  | { type: 'passwordReset'; to: string; code: string }
  | { type: 'mfaSms'; phone: string; code: string }
  | { type: 'dataExportReady'; to: string; code: string }
  | { type: 'emailChanged'; to: string; newEmail: string }
  // admin-action notifications
  | { type: 'adminDisabledMfa'; to: string }
  | { type: 'adminChangedEmail'; to: string; addressee: 'old' | 'new'; newEmail: string }
  | { type: 'adminDeletedSessions'; to: string }
  | { type: 'adminPasswordReset'; to: string }
  // password-installed notification
  | { type: 'passwordInstalled'; to: string }
  // email-changed-with-revert
  | { type: 'emailChangedWithRevert'; to: string; newEmail: string; revertUrl: string }
  // new-device login notification
  | { type: 'newDeviceLogin'; to: string; deviceName: string; ipMasked: string; loginAtIso: string; revokeUrl: string }
  // Device-verification challenge (one-time code for new-device login)
  | { type: 'deviceVerify'; to: string; code: string; deviceLabel: string; ipMasked: string }
  // Username reset notification (post-cleanup-script email)
  | { type: 'usernameResetRequired'; to: string; oldUsername: string; newUsername: string; reason: 'profanity' | 'sanitization' };

async function processEmail(job: Job<EmailJobData>) {
  const parsed = emailJobSchema.safeParse(job.data);
  if (!parsed.success) {
    log.error({ jobId: job.id, errors: parsed.error.flatten() }, 'invalid email job payload');
    return;
  }
  const data = parsed.data;

  switch (data.type) {
    case 'verification':
      await sendVerificationEmail(data.to, data.code);
      log.info({ jobId: job.id, to: data.to }, 'verification email sent');
      break;
    case 'passwordReset':
      await sendPasswordResetEmail(data.to, data.code);
      log.info({ jobId: job.id, to: data.to }, 'password reset email sent');
      break;
    case 'mfaSms':
      await sendMfaSmsCode(data.phone, data.code);
      log.info({ jobId: job.id, phone: data.phone.slice(0, 6) + '***' }, 'MFA SMS sent');
      break;
    case 'dataExportReady':
      await sendDataExportReadyEmail(data.to, data.code);
      log.info({ jobId: job.id, to: data.to }, 'data export ready email sent');
      break;
    case 'emailChanged':
      await sendEmailChangedNotification(data.to, data.newEmail);
      log.info({ jobId: job.id }, 'email changed notification sent');
      break;
    case 'adminDisabledMfa':
      await sendAdminDisabledMfaEmail(data.to);
      log.info({ jobId: job.id, to: data.to }, 'admin-disabled-mfa notification sent');
      break;
    case 'adminChangedEmail':
      await sendAdminChangedEmailNotification(data.to, data.addressee, data.newEmail);
      log.info({ jobId: job.id, to: data.to, addressee: data.addressee }, 'admin-changed-email notification sent');
      break;
    case 'adminDeletedSessions':
      await sendAdminDeletedSessionsEmail(data.to);
      log.info({ jobId: job.id, to: data.to }, 'admin-deleted-sessions notification sent');
      break;
    case 'adminPasswordReset':
      await sendAdminPasswordResetEmail(data.to);
      log.info({ jobId: job.id, to: data.to }, 'admin-password-reset notification sent');
      break;
    case 'passwordInstalled':
      await sendPasswordInstalledEmail(data.to);
      log.info({ jobId: job.id, to: data.to }, 'password-installed notification sent');
      break;
    case 'emailChangedWithRevert':
      await sendEmailChangedWithRevertEmail(data.to, data.newEmail, data.revertUrl);
      log.info({ jobId: job.id }, 'email-changed-with-revert notification sent');
      break;
    case 'newDeviceLogin':
      await sendNewDeviceLoginEmail(data.to, {
        deviceName: data.deviceName,
        ipMasked: data.ipMasked,
        loginAt: new Date(data.loginAtIso),
        revokeUrl: data.revokeUrl,
      });
      log.info({ jobId: job.id }, 'new-device login notification sent');
      break;
    case 'deviceVerify':
      await sendDeviceVerificationEmail(data.to, {
        code: data.code,
        deviceLabel: data.deviceLabel,
        ipMasked: data.ipMasked,
      });
      log.info({ jobId: job.id, to: data.to }, 'device verification code email sent');
      break;
    case 'usernameResetRequired':
      await sendUsernameResetRequiredEmail(data.to, {
        oldUsername: data.oldUsername,
        newUsername: data.newUsername,
        reason: data.reason,
      });
      log.info({ jobId: job.id, to: data.to, reason: data.reason }, 'username reset required email sent');
      break;
  }
}

export function startEmailWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;
  const worker = new Worker('email', processEmail, {
    connection: redisConnection,
    concurrency: Math.max(1, parseInt(process.env.EMAIL_WORKER_CONCURRENCY || '10', 10) || 10),
    lockDuration: 30_000,
  });
  worker.on('failed', (job, err) => {
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (job && job.attemptsMade >= maxAttempts) {
      // Do NOT spread `job.data` into the log; email payloads carry
      // `to`/`code`/`phone`/`newEmail`/`revokeUrl`/`revertUrl`. Narrowing
      // to the job type alone is cheaper to triage and strictly safer than
      // hoping the redactor catches every shape the worker evolves into.
      log.error({ jobId: job.id, err, type: job.data?.type, attemptsMade: job.attemptsMade }, 'DEAD_LETTER: email job permanently failed after all retries');
    } else {
      log.warn({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'email job failed (will retry)');
    }
  });
  worker.on('completed', (job) => log.debug({ jobId: job.id }, 'email job completed'));
  log.info('email worker started');
  return worker;
}
