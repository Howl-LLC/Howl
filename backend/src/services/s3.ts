// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { S3Client } from '@aws-sdk/client-s3';
import { logger } from '../logger.js';

const log = logger.child({ module: 's3' });

export const S3_BUCKET = process.env.S3_BUCKET || '';
export const S3_REGION = process.env.S3_REGION || process.env.AWS_REGION || 'auto';
export const S3_PREFIX = process.env.S3_KEY_PREFIX || 'uploads/';
export const s3Enabled = !!S3_BUCKET;
export const CDN_BASE_URL = process.env.CDN_BASE_URL || '';
export const CDN_SIGNING_SECRET = process.env.CDN_SIGNING_SECRET || '';

let _s3: S3Client | null = null;

export function getS3Client(): S3Client | null {
  if (!s3Enabled) return null;
  if (_s3) return _s3;

  const opts: ConstructorParameters<typeof S3Client>[0] = {
    region: S3_REGION,
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
  };
  if (process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY) {
    opts.credentials = {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    };
  }
  _s3 = new S3Client(opts);
  log.info({ bucket: S3_BUCKET, region: S3_REGION, endpoint: process.env.S3_ENDPOINT || 'default' }, 'S3-compatible storage initialized');
  return _s3;
}
