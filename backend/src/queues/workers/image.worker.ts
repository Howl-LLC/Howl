// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Image processing worker.
 *
 * Receives the raw file buffer, compresses it, and writes the result to
 * disk or S3. The upload route stores the original immediately and enqueues
 * this job; the worker replaces the file with the compressed version.
 *
 * Job data:
 *   { filename: string, buffer: string (base64), mimetype: string, originalSize: number }
 */

import { Worker, Job } from 'bullmq';
import { redisConnection, queuesEnabled } from '../connection.js';
import { logger } from '../../logger.js';
import { imageJobSchema } from '../workerSchemas.js';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const log = logger.child({ module: 'worker:image' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, '..', '..', '..', 'uploads');

import { getS3Client, S3_BUCKET, S3_PREFIX, s3Enabled } from '../../services/s3.js';
const s3 = getS3Client();

const MAX_DIMENSION = 4096;
const MAX_INPUT_PIXELS = 100_000_000;

async function compressImage(buffer: Buffer, mimetype: string): Promise<{ buffer: Buffer; mimetype: string }> {
  const metadata = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  if (metadata.width && metadata.height && metadata.width * metadata.height > MAX_INPUT_PIXELS) {
    throw new Error('Image dimensions too large');
  }

  const isGif = mimetype === 'image/gif';
  const pipeline = sharp(buffer, { animated: isGif, limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .keepIccProfile();

  switch (mimetype) {
    case 'image/jpeg':
      return { buffer: await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer(), mimetype: 'image/jpeg' };
    case 'image/png': {
      const is16bit = metadata.depth === 'ushort';
      const pngOpts = is16bit ? { compressionLevel: 8 } : { quality: 82, compressionLevel: 8 };
      return { buffer: await pipeline.png(pngOpts).toBuffer(), mimetype: 'image/png' };
    }
    case 'image/webp':
      return { buffer: await pipeline.webp({ quality: 82 }).toBuffer(), mimetype: 'image/webp' };
    case 'image/avif':
      return { buffer: await pipeline.avif({ quality: 70, bitdepth: 10 }).toBuffer(), mimetype: 'image/avif' };
    case 'image/gif':
      return { buffer: await pipeline.gif().toBuffer(), mimetype: 'image/gif' };
    default:
      return { buffer, mimetype };
  }
}

const THUMB_SIZE = 256;
const THUMB_PREFIX = 'thumb_';
const FRAME_PREFIX = 'frame_';

async function generateThumbnail(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer, { animated: false, limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer();
}

async function generateFrozenFrame(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer, { animated: false, limitInputPixels: MAX_INPUT_PIXELS })
    .webp({ quality: 82 })
    .toBuffer();
}

export interface ImageJobData {
  filename: string;
  mimetype: string;
  originalSize: number;
  /** When true, thumbnails and frozen frames were already generated inline by the upload route. */
  skipDerivatives?: boolean;
}

async function processImage(job: Job<ImageJobData>) {
  const parsed = imageJobSchema.safeParse(job.data);
  if (!parsed.success) {
    log.error({ jobId: job.id, errors: parsed.error.flatten() }, 'invalid image job payload');
    return;
  }
  const { filename, mimetype, originalSize, skipDerivatives } = parsed.data as ImageJobData;
  const diskPath = path.join(uploadsDir, filename);
  const safeDiskPath = path.resolve(diskPath);
  if (!safeDiskPath.startsWith(path.resolve(uploadsDir) + path.sep) && safeDiskPath !== path.resolve(uploadsDir)) {
    log.warn({ filename }, 'path traversal attempt detected, skipping');
    return;
  }
  let rawBuffer: Buffer;
  try {
    await fs.access(diskPath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    rawBuffer = await fs.readFile(diskPath);
  } catch {
    if (s3Enabled && s3) {
      try {
        const key = `${S3_PREFIX}${filename}`;
        const response = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
        const chunks: Buffer[] = [];
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk));
        }
        rawBuffer = Buffer.concat(chunks);
      } catch (s3Err) {
        log.warn({ filename, err: s3Err }, 'source file not found on disk or S3, skipping compression');
        return;
      }
    } else {
      log.warn({ filename }, 'source file not found on disk, skipping compression');
      return;
    }
  }
  const compressed = await compressImage(rawBuffer, mimetype);

  const ratio = ((1 - compressed.buffer.length / originalSize) * 100).toFixed(1);
  log.info({ jobId: job.id, filename, originalSize, compressed: compressed.buffer.length, ratio: `${ratio}%` }, 'image compressed');

  // Save compressed full-size image
  if (s3Enabled && s3) {
    const key = `${S3_PREFIX}${filename}`;
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: compressed.buffer,
      ContentType: compressed.mimetype,
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  } else {
    const diskPath = path.join(uploadsDir, filename);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(diskPath, compressed.buffer);
  }

  // Generate and save thumbnail (skip if already done inline by upload route)
  if (!skipDerivatives) try {
    const thumbBuffer = await generateThumbnail(compressed.buffer);
    const thumbFilename = `${THUMB_PREFIX}${filename.replace(/\.[^.]+$/, '.webp')}`;
    if (s3Enabled && s3) {
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${S3_PREFIX}${thumbFilename}`,
        Body: thumbBuffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      }));
    } else {
      const thumbDiskPath = path.join(uploadsDir, thumbFilename);
      const safeThumbPath = path.resolve(thumbDiskPath);
      if (!safeThumbPath.startsWith(path.resolve(uploadsDir) + path.sep) && safeThumbPath !== path.resolve(uploadsDir)) {
        log.warn({ thumbFilename }, 'thumbnail path traversal attempt detected, skipping');
      } else {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        await fs.writeFile(thumbDiskPath, thumbBuffer);
      }
    }
    log.debug({ jobId: job.id, thumbFilename, thumbSize: thumbBuffer.length }, 'thumbnail generated');
  } catch (thumbErr) {
    log.warn({ err: thumbErr, jobId: job.id }, 'thumbnail generation failed');
  }

  // Generate frozen frame for GIFs (full-resolution static WebP for tab-unfocus freeze)
  if (mimetype === 'image/gif' && !skipDerivatives) {
    try {
      const frameBuffer = await generateFrozenFrame(compressed.buffer);
      const frameFilename = `${FRAME_PREFIX}${filename.replace(/\.[^.]+$/, '.webp')}`;
      if (s3Enabled && s3) {
        await s3.send(new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: `${S3_PREFIX}${frameFilename}`,
          Body: frameBuffer,
          ContentType: 'image/webp',
          CacheControl: 'public, max-age=31536000, immutable',
        }));
      } else {
        const frameDiskPath = path.join(uploadsDir, frameFilename);
        const safeFramePath = path.resolve(frameDiskPath);
        if (!safeFramePath.startsWith(path.resolve(uploadsDir) + path.sep) && safeFramePath !== path.resolve(uploadsDir)) {
          log.warn({ frameFilename }, 'frame path traversal attempt detected, skipping');
        } else {
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          await fs.writeFile(frameDiskPath, frameBuffer);
        }
      }
      log.debug({ jobId: job.id, frameFilename, frameSize: frameBuffer.length }, 'frozen frame generated');
    } catch (frameErr) {
      log.warn({ err: frameErr, jobId: job.id }, 'frozen frame generation failed');
    }
  }
}

export function startImageWorker(): Worker | null {
  if (!queuesEnabled || !redisConnection) return null;
  const worker = new Worker('image-processing', processImage, {
    connection: redisConnection,
    concurrency: Math.max(1, parseInt(process.env.IMAGE_WORKER_CONCURRENCY || '3', 10) || 3),
    lockDuration: 60_000,
  });
  worker.on('failed', (job, err) => {
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (job && job.attemptsMade >= maxAttempts) {
      // Image jobs reference user-uploaded filenames; don't spread
      // job.data. Keep the filename (already UUID-based, not the user's
      // original name — see services/fileStorage.ts) and mimetype for
      // correlation.
      log.error({ jobId: job.id, err, filename: job.data?.filename, mimetype: job.data?.mimetype, attemptsMade: job.attemptsMade }, 'DEAD_LETTER: image job permanently failed after all retries');
    } else {
      log.warn({ jobId: job?.id, err, attempt: job?.attemptsMade }, 'image job failed (will retry)');
    }
  });
  worker.on('completed', (job) => log.debug({ jobId: job.id }, 'image job completed'));
  log.info('image worker started');
  return worker;
}
