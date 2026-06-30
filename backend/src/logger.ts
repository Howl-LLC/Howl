// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Structured JSON logger (pino) with request-ID support.
 *
 * Usage:
 *   import { logger } from './logger.js';
 *   logger.info({ userId, serverId }, 'User joined server');
 *   logger.error({ err, route }, 'Failed to create message');
 *
 * Child loggers for subsystems:
 *   const log = logger.child({ module: 'socket' });
 *   log.info({ channelId }, 'Voice participant joined');
 *
 * In production, pipe raw JSON to CloudWatch / Datadog / ELK.
 * In dev, pino-pretty formats the output for readability.
 */

import pino from 'pino';
import { randomUUID } from 'crypto';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Exported so tests can construct a fresh pino instance with the exact same
 * redact rules and assert sensitive field values don't appear in serialized
 * log output. The set also covers email-worker fields.
 */
export const REDACT_PATHS: readonly string[] = [
  'email',
  'password',
  'passwordHash',
  'content',
  'token',
  'mfaTotpSecret',
  'mfaRecoveryCodes',
  // Email / SMS / notification worker payloads.
  // Top-level because log.info({ to, code }, msg) is the common shape.
  'to',
  'code',
  'phone',
  'newEmail',
  'revokeUrl',
  'revertUrl',
  'ipMasked',
  // BullMQ dead-letter shape: log.error({ data: job.data }, 'DEAD_LETTER').
  'data.to',
  'data.code',
  'data.phone',
  'data.newEmail',
  'data.revokeUrl',
  'data.revertUrl',
  'data.ipMasked',
  'req.headers.authorization',
  'req.headers.cookie',
  '*.email',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.mfaTotpSecret',
  '*.mfaRecoveryCodes',
  '*.to',
  '*.code',
  '*.phone',
  '*.newEmail',
  '*.revokeUrl',
  '*.revertUrl',
  '*.ipMasked',
  'ip',
  '*.ip',
  'req.remoteAddress',
  '*.remoteAddress',
  // 2026-04-26 — defensive redaction for cloud credentials. AWS SDK error
  // objects can include request signing metadata in nested fields; the worker
  // queues currently log the full err object on S3 failures.
  'accessKeyId',
  'secretAccessKey',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'CDN_SIGNING_SECRET',
  'HMAC_SIGNING_SECRET',
  'CLOUDFLARE_API_TOKEN',
  'CF_API_TOKEN',
  'authorization',
  'Authorization',
  '*.accessKeyId',
  '*.secretAccessKey',
  '*.authorization',
  '*.Authorization',
  'err.request.headers.authorization',
  'err.request.headers.Authorization',
];

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  redact: {
    paths: [...REDACT_PATHS],
    censor: '[REDACTED]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

export function generateRequestId(): string {
  return randomUUID().slice(0, 8);
}
