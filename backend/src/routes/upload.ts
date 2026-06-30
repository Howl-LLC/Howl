// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import multer from 'multer';
import { randomUUID, createHash } from 'crypto';
import { fileTypeFromBuffer } from 'file-type';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '../logger.js';
import { getEffectivePlan } from '../utils.js';
import sharp from 'sharp';
import { createRequire } from 'module';
import type { PDQ as PDQType } from 'pdq-wasm';
import { enqueueImageProcessing } from '../queues/producers.js';
import { queuesEnabled } from '../queues/connection.js';
import { onFlaggedHashInvalidation, redis } from '../redis.js';

const log = logger.child({ module: 'upload' });

// pdq-wasm@0.3.9's ESM build gates Node-mode WASM loading on
// `typeof require !== 'undefined'`, which is false in pure ESM Node — so a
// plain `import { PDQ } from 'pdq-wasm'` makes PDQ.init() throw and silently
// disables CSAM upload-blocking in production. Loading via createRequire
// gives the package a real CJS require in its loader scope. Remove this
// shim once pdq-wasm ships an ESM-clean release.
const __require = createRequire(import.meta.url);
const { PDQ } = __require('pdq-wasm') as { PDQ: typeof PDQType };

// Track init readiness as a tri-state we can both `await` and read sync.
// Why: a previous version called `.catch(log)` and then synchronously used
// PDQ.hash on the upload path. If init failed (or hadn't resolved yet), every
// upload silently skipped the CSAM check. The handler now awaits this promise
// before hashing and the /api/health endpoint surfaces the state.
let pdqInitState: 'pending' | 'ready' | 'failed' = 'pending';
const pdqInitPromise: Promise<boolean> = PDQ.init()
  .then(() => { pdqInitState = 'ready'; return true; })
  .catch(err => {
    pdqInitState = 'failed';
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'PDQ.init failed — CSAM upload-block is disabled');
    return false;
  });

export function getPdqInitState(): 'pending' | 'ready' | 'failed' {
  return pdqInitState;
}

let _flaggedHashCache: string[] | null = null;
let _flaggedHashCacheTime = 0;
const FLAGGED_HASH_CACHE_TTL = 60 * 1000; // 60 seconds

// Listen for flagged hash updates from other instances via Redis pub/sub
onFlaggedHashInvalidation(() => {
  _flaggedHashCache = null;
  _flaggedHashCacheTime = 0;
});

// Hard ceiling on how many hashes we'll load into the in-memory linear-scan
// cache. Beyond this we'd need an indexed match structure (BK-tree or
// multi-index hashing) — flagged as future work. For NCMEC's full ~6M-hash
// corpus we will need that work; for the early/manual + smaller-corpus phase
// 500k is generous (linear scan stays sub-100ms).
const MAX_FLAGGED_HASHES_IN_MEMORY = 500_000;
const FLAGGED_HASH_PAGE_SIZE = 5_000;

/**
 * Load every active flagged hash. Active = (snapshotId IS NULL) — manual
 * entries are always live — OR (snapshot.isActive=true) for ingested
 * corpora. Result is paged from Postgres (5k/batch) and capped to
 * MAX_FLAGGED_HASHES_IN_MEMORY; exceeding the cap logs an error and the
 * upload route then fail-closes the next match call (the cap ceiling is
 * exactly what triggers the indexed-matcher project).
 */
async function getFlaggedHashes(prisma: any): Promise<string[]> {
  const now = Date.now();
  if (_flaggedHashCache && now - _flaggedHashCacheTime < FLAGGED_HASH_CACHE_TTL) {
    return _flaggedHashCache;
  }
  const collected: string[] = [];
  let cursor: string | undefined;
  while (collected.length < MAX_FLAGGED_HASHES_IN_MEMORY) {
    const batch: { id: string; hash: string }[] = await prisma.flaggedHash.findMany({
      where: {
        OR: [
          { snapshotId: null },
          { snapshot: { isActive: true } },
        ],
      },
      select: { id: true, hash: true },
      take: FLAGGED_HASH_PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    if (batch.length === 0) break;
    for (const row of batch) collected.push(row.hash);
    if (batch.length < FLAGGED_HASH_PAGE_SIZE) break;
    cursor = batch[batch.length - 1].id;
  }
  if (collected.length >= MAX_FLAGGED_HASHES_IN_MEMORY) {
    log.error(
      { loaded: collected.length, cap: MAX_FLAGGED_HASHES_IN_MEMORY },
      'flagged-hash cache hit the in-memory ceiling — additional rows are NOT being matched. Add an indexed matcher (BK-tree / MIH) before ingesting corpora at this scale.',
    );
  }
  _flaggedHashCache = collected;
  _flaggedHashCacheTime = now;
  return collected;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = Router();

const MAX_FILE_SIZE_FREE = 50 * 1024 * 1024;
const MAX_FILE_SIZE_ESSENTIAL = 100 * 1024 * 1024;
const MAX_FILE_SIZE_PRO = 500 * 1024 * 1024;

const SERVER_UPLOAD_LIMITS = [
  50 * 1024 * 1024,
  75 * 1024 * 1024,
  100 * 1024 * 1024,
  125 * 1024 * 1024,
];

function powerUpTier(count: number): number {
  if (count >= 14) return 3;
  if (count >= 7) return 2;
  if (count >= 2) return 1;
  return 0;
}

// Per-user concurrent upload limit
const CONCURRENT_UPLOAD_LIMIT = 3;

async function acquireUploadSlot(userId: string): Promise<boolean> {
  if (!redis) return true;
  try {
    const key = `upload:active:${userId}`;
    const current = await redis.incr(key);
    if (current === 1) await redis.expire(key, 300); // 5min safety TTL
    if (current > CONCURRENT_UPLOAD_LIMIT) {
      await redis.decr(key);
      return false;
    }
    return true;
  } catch {
    return true; // fail open on Redis error
  }
}

async function releaseUploadSlot(userId: string): Promise<void> {
  if (!redis) return;
  try {
    const result = await redis.decr(`upload:active:${userId}`);
    if (result <= 0) await redis.del(`upload:active:${userId}`);
  } catch { /* best effort */ }
}

// S3 configuration (optional — falls back to local disk when S3_BUCKET is unset)
import { getS3Client, S3_BUCKET, S3_PREFIX, s3Enabled, CDN_BASE_URL, CDN_SIGNING_SECRET } from '../services/s3.js';
import { purgeCdnUrls } from '../services/cloudflarePurge.js';
import { signCdnUrl } from '../services/cdnSign.js';
import { getClientIp } from '../utils/clientIp.js';
import { resolveUploadOwner, identifyServeViewer, authorizeUploadAccess, UPLOAD_ACL_ENABLED } from '../services/uploadAcl.js';
const s3 = getS3Client();

// Local disk fallback
const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
try {
  fs.mkdirSync(uploadsDir, { recursive: true });
} catch (e) {
  // Non-fatal here — the per-upload destination callback retries and falls
  // back to the OS temp dir. Logged so a missing/read-only uploads dir (a
  // prod container with an ephemeral or read-only FS) is visible rather than
  // silently turning every upload into a generic 500.
  log.error({ err: e instanceof Error ? e.message : String(e), uploadsDir }, 'failed to create uploads dir at startup');
}

// Always use disk storage to avoid buffering large files in memory.
// Temp files are prefixed with tmp_ and cleaned up after processing.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    // Ensure the staging dir exists & is writable before multer writes the
    // temp file. If the app-relative uploads/ dir can't be created (read-only
    // or missing FS layer in some prod containers), fall back to the OS temp
    // dir, which is reliably writable. In production the final object lives in
    // S3/R2 anyway, so the temp location doesn't affect where the file ends up
    // — this prevents an unwritable uploads/ dir from 500-ing every upload.
    try {
      fs.mkdirSync(uploadsDir, { recursive: true });
      cb(null, uploadsDir);
    } catch (e) {
      log.error(
        { err: e instanceof Error ? e.message : String(e), uploadsDir },
        'uploads dir unwritable — staging upload in OS temp dir instead',
      );
      cb(null, os.tmpdir());
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `tmp_${randomUUID()}${ext}`);
  },
});

const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4',
  'application/pdf',
  'text/plain',
  'application/zip', 'application/x-zip-compressed',
  // application/json intentionally excluded — no chat use case justifies it,
  // and it could carry exploit payloads or be confused with API responses.
]);
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.msi', '.ps1', '.vbs', '.js', '.wsh', '.wsf',
  '.scr', '.com', '.pif', '.hta', '.cpl', '.reg', '.inf',
  '.dll', '.sys', '.sh', '.bash', '.app', '.dmg',
  '.html', '.htm', '.xhtml', '.svg', '.xml', '.php', '.jsp', '.asp', '.aspx',
  '.mhtml', '.mht', '.shtml',
]);

const BINARY_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4',
  'application/pdf', 'application/zip', 'application/x-zip-compressed',
]);

function fileFilter(req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return cb(new Error(`File type not allowed: ${ext}`));
  }
  // Encrypted uploads send raw ciphertext blobs as application/octet-stream —
  // MIME validation is meaningless on encrypted bytes.
  const isEncrypted = req.query.encrypted === 'true';
  if (!isEncrypted && !ALLOWED_MIMES.has(file.mimetype)) {
    return cb(new Error(`File type not allowed: ${file.mimetype}`));
  }
  cb(null, true);
}

/** Create a multer instance with a specific file size limit. */
function createUpload(maxFileSize: number) {
  return multer({ storage, limits: { fileSize: maxFileSize }, fileFilter });
}

const COMPRESSIBLE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif',
]);
const MAX_DIMENSION = 4096;
const MAX_PIXEL_COUNT = 100_000_000; // 100 megapixels — rejects decompression bombs
const MAX_GIF_FRAMES = 500;

/**
 * Validate image dimensions before any heavy processing to reject
 * decompression bombs (e.g. a tiny JPEG that decodes to a multi-GB bitmap).
 */
async function validateImageSafety(buffer: Buffer, mimetype: string): Promise<void> {
  const isGif = mimetype === 'image/gif';
  const metadata = await sharp(buffer, {
    animated: isGif,
    limitInputPixels: MAX_PIXEL_COUNT,
  }).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const pages = metadata.pages ?? 1;
  if (width * height > MAX_PIXEL_COUNT) {
    throw new Error(`Image too large: ${width}x${height} exceeds ${MAX_PIXEL_COUNT} pixel limit`);
  }
  if (isGif && pages > MAX_GIF_FRAMES) {
    throw new Error(`GIF has ${pages} frames, exceeding the ${MAX_GIF_FRAMES} frame limit`);
  }
}

/**
 * Compress an image buffer with sharp. Animated GIFs are passed through
 * (sharp handles animated: true). Returns the compressed buffer, the
 * (possibly changed) mimetype, and a replacement file extension.
 */
async function compressImage(
  buffer: Buffer,
  mimetype: string,
): Promise<{ buffer: Buffer; mimetype: string; ext: string }> {
  await validateImageSafety(buffer, mimetype);
  const isGif = mimetype === 'image/gif';

  if (isGif) {
    const pipeline = sharp(buffer, { animated: true, limitInputPixels: MAX_PIXEL_COUNT })
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .keepIccProfile()
      .gif();
    return { buffer: await pipeline.toBuffer(), mimetype: 'image/gif', ext: '.gif' };
  }

  let pipeline = sharp(buffer, { limitInputPixels: MAX_PIXEL_COUNT })
    .rotate()
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .keepIccProfile();

  switch (mimetype) {
    case 'image/jpeg':
      pipeline = pipeline.jpeg({ quality: 82, mozjpeg: true });
      return { buffer: await pipeline.toBuffer(), mimetype: 'image/jpeg', ext: '.jpg' };
    case 'image/png': {
      const meta = await sharp(buffer, { limitInputPixels: MAX_PIXEL_COUNT }).metadata();
      const is16bit = meta.depth === 'ushort';
      if (is16bit) {
        // Preserve 16-bit depth for HDR/wide-gamut PNGs (e.g. ProRAW exports, medical imaging)
        pipeline = pipeline.png({ compressionLevel: 8 });
      } else {
        pipeline = pipeline.png({ quality: 82, compressionLevel: 8 });
      }
      return { buffer: await pipeline.toBuffer(), mimetype: 'image/png', ext: '.png' };
    }
    case 'image/webp':
      pipeline = pipeline.webp({ quality: 82 });
      return { buffer: await pipeline.toBuffer(), mimetype: 'image/webp', ext: '.webp' };
    case 'image/avif':
      pipeline = pipeline.avif({ quality: 70, bitdepth: 10 });
      return { buffer: await pipeline.toBuffer(), mimetype: 'image/avif', ext: '.avif' };
    default:
      return { buffer, mimetype, ext: '' };
  }
}

const THUMB_SIZE = 256;
const THUMB_PREFIX = 'thumb_';
const FRAME_PREFIX = 'frame_';

/**
 * Generate a 256px thumbnail as WebP. Returns null for non-image or on error.
 */
async function generateThumbnail(buffer: Buffer, mimetype: string): Promise<{ buffer: Buffer; mimetype: string } | null> {
  if (!COMPRESSIBLE_MIMES.has(mimetype)) return null;
  try {
    const thumbBuffer = await sharp(buffer, { animated: false, limitInputPixels: MAX_PIXEL_COUNT })
      .rotate()
      .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
    return { buffer: thumbBuffer, mimetype: 'image/webp' };
  } catch {
    return null;
  }
}

/**
 * Generate a full-resolution static first frame as WebP (for GIF freeze-on-blur).
 * Unlike thumbnails (256px), frozen frames preserve original dimensions so the
 * frozen image is pixel-identical to the last displayed GIF frame size.
 */
async function generateFrozenFrame(buffer: Buffer, mimetype: string): Promise<{ buffer: Buffer; mimetype: string } | null> {
  if (mimetype !== 'image/gif') return null;
  try {
    const frameBuffer = await sharp(buffer, { animated: false, limitInputPixels: MAX_PIXEL_COUNT })
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    return { buffer: frameBuffer, mimetype: 'image/webp' };
  } catch {
    return null;
  }
}

const PDQ_IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
]);

// Cap on frames sampled per animated upload. Hashing is ~constant-time per
// frame so cost scales linearly; 5 catches first/middle/last + two interior
// samples, which defeats the standard "hide the abusive frame on frame 2"
// evasion without making large GIFs disproportionately expensive.
const MAX_FRAMES_TO_HASH = 5;

function pickFrameSample(total: number, max: number): number[] {
  if (total <= 1) return [0];
  if (total <= max) return Array.from({ length: total }, (_, i) => i);
  const indices = new Set<number>([0, total - 1]);
  const stride = (total - 1) / (max - 1);
  for (let i = 1; i < max - 1; i++) {
    indices.add(Math.round(i * stride));
  }
  return Array.from(indices).sort((a, b) => a - b);
}

/**
 * Returns one PDQ hash per sampled frame. Single-frame inputs (PNG/JPEG/non-
 * animated WebP) return a one-element array. Returns [] if hashing fails or
 * the MIME isn't a supported image format. Frames that fail to decode are
 * skipped — partial coverage is better than aborting the whole upload's
 * safety check on one bad frame.
 */
async function computePDQHashes(buffer: Buffer, mimetype: string): Promise<string[]> {
  if (!PDQ_IMAGE_MIMES.has(mimetype)) return [];
  try {
    const meta = await sharp(buffer, { limitInputPixels: MAX_PIXEL_COUNT }).metadata();
    const totalPages = (meta.pages && meta.pages > 1) ? meta.pages : 1;
    const indices = pickFrameSample(totalPages, MAX_FRAMES_TO_HASH);

    const hashes: string[] = [];
    for (const idx of indices) {
      try {
        const { data, info } = await sharp(buffer, {
          animated: false,
          page: idx,
          limitInputPixels: MAX_PIXEL_COUNT,
        })
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const result = PDQ.hash({ data, width: info.width, height: info.height, channels: 3 });
        hashes.push(PDQ.toHex(result.hash));
      } catch (frameErr) {
        log.warn({ err: frameErr, frameIndex: idx, totalPages }, 'PDQ frame hash failed (skipping)');
      }
    }
    return hashes;
  } catch (err) {
    log.warn({ err }, 'PDQ hash computation failed');
    return [];
  }
}

async function uploadToS3(key: string, body: Buffer | fs.ReadStream, contentType: string): Promise<void> {
  const managed = new Upload({
    client: s3!,
    params: {
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    },
    partSize: 10 * 1024 * 1024, // 10MB parts for multipart upload
    queueSize: 4,
  });
  await managed.done();
}

async function getS3SignedUrl(key: string): Promise<string> {
  const ext = path.extname(key).toLowerCase();
  const SAFE_INLINE = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.mp4', '.webm', '.mp3', '.ogg', '.wav']);
  const disposition = SAFE_INLINE.has(ext) ? 'inline' : 'attachment';
  const MIME_MAP_S3: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
    '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
  };
  const contentType = MIME_MAP_S3[ext] || 'application/octet-stream';
  return getSignedUrl(s3!, new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ResponseContentDisposition: disposition,
    ResponseContentType: contentType,
  }), { expiresIn: 900 });
}

const uploadServeLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:upload-serve:'),
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many file requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * GET /api/uploads/:filename
 * Serve an uploaded file. No auth so <img> tags can load avatars/banners.
 * With S3: 302 redirect to a presigned URL.
 * Without S3 (or file not on S3): serve from local disk.
 */
router.get('/uploads/:filename', uploadServeLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const raw = req.params.filename;
  const filename = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (!filename || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  // Per-resource ACL (flag-gated). Resolve the file's owning channel/DM from the
  // authoritative Message/DMMessage row; gate non-public owners against the
  // requesting viewer. Public assets (avatars/banners/emoji/legacy) and the
  // pre-post preview window have no message row and stay unauthenticated, so
  // <img> tags keep working. Any resolve/identify/authorize DB error fails closed
  // (503, retryable) rather than falling through to an unauthenticated serve.
  if (UPLOAD_ACL_ENABLED) {
    try {
      const owner = await resolveUploadOwner(filename);
      if (owner.kind !== 'public') {
        const viewerId = await identifyServeViewer(req);
        const allowed = viewerId ? await authorizeUploadAccess(viewerId, owner) : false;
        if (!allowed) return res.status(403).json({ error: 'Forbidden' });
      }
    } catch {
      return res.status(503).json({ error: 'Unable to serve file. Please try again in a moment.' });
    }
  }

  // Clients that fetch cross-origin (e.g. encrypted DM attachments via fetch())
  // can't cleanly follow our 302 to cdn.howlpro.com — the browser either strips
  // Origin on the redirected request or gates the response read on CORS headers
  // the Worker can't always set. `?as=json` returns the signed URL as data so
  // the client can fetch the CDN directly in a second step.
  const wantsJson = req.query.as === 'json';

  // Try S3 first
  if (s3Enabled) {
    const key = `${S3_PREFIX}${filename}`;
    try {
      // If a CDN custom domain is configured, redirect there directly (no presigned URL needed)
      if (CDN_BASE_URL && CDN_SIGNING_SECRET) {
        const cdnUrl = signCdnUrl(key);
        if (wantsJson) {
          res.setHeader('Cache-Control', 'no-store');
          return res.json({ url: cdnUrl });
        }
        // Keep this redirect's cache short (5 minutes): a long `immutable`
        // max-age here would let browsers and the Cloudflare edge keep serving
        // the 302 for a year even after the underlying R2 object is deleted.
        // The target CDN asset itself still carries its own long cache, which we
        // purge on delete via cloudflarePurge.ts.
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('Referrer-Policy', 'no-referrer');
        return res.redirect(302, cdnUrl);
      }

      // Fallback: presigned URL (for local dev or when CDN is not configured)
      let signedUrl: string | null = null;
      const cacheKey = `s3url:${filename}`;
      if (redis) {
        const cached = await redis.get(cacheKey);
        if (cached) signedUrl = cached;
      }
      if (!signedUrl) {
        signedUrl = await getS3SignedUrl(key);
        if (redis) {
          await redis.setex(cacheKey, 600, signedUrl);
        }
      }
      if (wantsJson) {
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ url: signedUrl });
      }
      return res.redirect(302, signedUrl);
    } catch { /* fall through to local disk */ }
  }

  if (wantsJson) {
    // No CDN, no S3 — the file lives on local disk and the client can fetch the
    // same-origin relative URL directly without a redirect hop.
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ url: `/api/uploads/${encodeURIComponent(filename)}` });
  }

  // Fall back to local disk (for pre-migration files or local dev)
  const filePath = path.resolve(uploadsDir, filename);
  const resolvedDir = path.resolve(uploadsDir);
  if (!filePath.startsWith(resolvedDir)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  try {
    await fsp.access(filePath);
  } catch {
    return res.status(404).send();
  }
  const ext = path.extname(filename).toLowerCase();
  const MIME_MAP: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
    '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
  };
  const contentType = MIME_MAP[ext] || 'application/octet-stream';
  const disposition = MIME_MAP[ext] ? 'inline' : 'attachment';
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', disposition);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  // Defense-in-depth: restrict uploaded file responses from executing scripts
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) next(err);
  });
});

const uploadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:upload:'),
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Too many uploads. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

/** POST /api/upload — single file upload. Uses max(userPlan, serverTier) for size limit. */
router.post('/upload', authenticateToken, uploadLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  let maxBytes = MAX_FILE_SIZE_FREE;
  let maxLabel = '50MB';
  try {
    if (req.userId) {
      let planBytes = MAX_FILE_SIZE_FREE;
      const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true } });
      const effectivePlan = u ? getEffectivePlan(u) : 'free';
      if (effectivePlan === 'pro') planBytes = MAX_FILE_SIZE_PRO;
      else if (effectivePlan === 'essential') planBytes = MAX_FILE_SIZE_ESSENTIAL;

      let serverBytes = 0;
      const serverId = typeof req.query.serverId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.query.serverId) ? req.query.serverId : null;
      if (serverId && req.userId) {
        const [server, membership] = await Promise.all([
          prisma.server.findUnique({ where: { id: serverId }, select: { powerUpCount: true } }),
          prisma.serverMember.findUnique({ where: { userId_serverId: { userId: req.userId, serverId } }, select: { userId: true } }),
        ]);
        if (server && membership) serverBytes = SERVER_UPLOAD_LIMITS[powerUpTier(server.powerUpCount)];
      }

      maxBytes = Math.max(planBytes, serverBytes);
      const mb = Math.round(maxBytes / (1024 * 1024));
      maxLabel = `${mb}MB`;
    }
  } catch { /* fall through to free limit */ }

  // Early rejection based on Content-Length header to avoid buffering oversized
  // uploads into memory/disk. This is advisory — Content-Length can be spoofed,
  // so the authoritative file.size check after upload is retained below.
  const contentLength = parseInt(req.headers['content-length'] ?? '', 10);
  if (contentLength && contentLength > maxBytes) {
    return res.status(413).json({ error: `File too large. Your maximum upload size is ${maxLabel}. Upgrade your plan for larger uploads.` });
  }

  if (!(await acquireUploadSlot(req.userId!))) {
    return res.status(429).json({ error: 'Too many concurrent uploads. Please wait for current uploads to finish.' });
  }

  const singleUpload = createUpload(maxBytes).single('file');
  singleUpload(req, res, async (err: unknown) => {
    try {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `File too large. Your maximum upload size is ${maxLabel}.` });
      }
      if (err instanceof Error && err.message.startsWith('File type not allowed')) {
        return res.status(400).json({ error: err.message });
      }
      // Any other multer/storage error becomes a generic 500 via the global
      // handler. Log it with its errno first so the root cause (e.g. ENOSPC =
      // disk full, EACCES/EROFS = unwritable staging dir) is visible in prod
      // logs instead of an opaque "Internal server error" on every upload.
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          code: (err as { code?: string } | null)?.code,
          name: (err as { name?: string } | null)?.name,
        },
        'upload failed in multer/storage middleware',
      );
      return next(err);
    }
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    if (file.size > maxBytes) {
      // Clean up disk file if using disk storage
      if ('path' in file && (file as any).path) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        fsp.unlink((file as any).path).catch(() => {});
      }
      return res.status(400).json({ error: `File too large. Your maximum upload size is ${maxLabel}. Upgrade your plan for larger uploads.` });
    }

    const isEncryptedUpload = req.query.encrypted === 'true';
    let fileBuffer: Buffer | null = file.buffer ?? null;
    let fileMimetype = file.mimetype;
    let fileSize = file.size;
    let origExt = path.extname(file.originalname) || '';

    if (!fileBuffer && 'path' in file && (file as any).path) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      try { fileBuffer = await fsp.readFile((file as any).path); } catch { /* proceed without buffer */ }
    }

    if (fileBuffer && BINARY_MIMES.has(fileMimetype) && !isEncryptedUpload) {
      const detected = await fileTypeFromBuffer(fileBuffer);
      if (!detected || !ALLOWED_MIMES.has(detected.mime)) {
        if ('path' in file && (file as any).path) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          fsp.unlink((file as any).path).catch(() => {});
        }
        return res.status(400).json({ error: 'File content does not match its declared type.' });
      }
      fileMimetype = detected.mime;
      if (detected.ext) origExt = '.' + detected.ext;
    }

    // Encrypted uploads bypass MIME detection (bytes are encrypted), but we still
    // enforce the declared MIME type is in the allowlist to prevent serving
    // dangerous content types.
    if (isEncryptedUpload && fileMimetype !== 'application/octet-stream' && !ALLOWED_MIMES.has(fileMimetype)) {
      if ('path' in file && (file as any).path) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        fsp.unlink((file as any).path).catch(() => {});
      }
      return res.status(400).json({ error: 'File type not allowed.' });
    }

    // Resolve intended-target context once, up here, so both the auto-flag
    // MessageReport write (BEFORE save, to prevent TOCTOU) and the post-save
    // ImageHash row see the same validated values without recomputing.
    const VALID_SOURCES = new Set(['channel', 'dm', 'avatar', 'banner', 'server-icon', 'server-banner', 'emoji', 'sticker', 'role-icon']);
    const rawSource = typeof req.query.source === 'string' ? req.query.source : 'channel';
    const intendedSource = VALID_SOURCES.has(rawSource) ? rawSource : 'channel';
    const rawSourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : null;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const intendedSourceId = rawSourceId && UUID_RE.test(rawSourceId) ? rawSourceId : null;

    // An encrypted upload skips ALL content safety
    // (MIME/EXIF/decompression-bomb/NCMEC/PDQ) because the bytes are E2E
    // ciphertext. That skip is legitimate ONLY for a DM the caller is actually
    // in. Bind the self-asserted `encrypted` flag to a server-verified DM
    // context: reject encrypted=true on any non-DM source (channel/avatar/etc.)
    // and require an active-participant sourceId for source=dm. Without this any
    // authenticated user could mint an unscanned blob and attach it to a
    // plaintext, multi-recipient server channel (the send-time provenance check
    // in routes/messages.ts is the matching second layer).
    if (isEncryptedUpload) {
      const cleanupAndReject = (status: number, error: string) => {
        if ('path' in file && (file as any).path) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from multer's file object, not user input
          fsp.unlink((file as any).path).catch(() => {});
        }
        return res.status(status).json({ error });
      };
      if (intendedSource !== 'dm') {
        return cleanupAndReject(400, 'Encrypted uploads must target a direct message.');
      }
      if (!intendedSourceId) {
        return cleanupAndReject(400, 'Encrypted uploads require a direct message id.');
      }
      // Mirrors dmMessages.isActiveDmParticipant (inlined to avoid a circular
      // import — dmMessages.ts imports deleteUploadedFile from this file). A
      // pendingRemoval participant is NOT active and must not mint blobs.
      const participant = await prisma.dMParticipant.findFirst({
        where: { dmChannelId: intendedSourceId, userId: req.userId!, pendingRemoval: null },
        select: { userId: true },
      }).catch(() => null);
      if (!participant) {
        return cleanupAndReject(403, 'You are not a participant of this direct message.');
      }
    }

    const isCompressible = fileBuffer && COMPRESSIBLE_MIMES.has(fileMimetype) && !isEncryptedUpload;

    if (isCompressible && !queuesEnabled) {
      try {
        const compressed = await compressImage(fileBuffer!, fileMimetype);
        fileBuffer = compressed.buffer;
        fileMimetype = compressed.mimetype;
        fileSize = compressed.buffer.length;
        log.info(
          { original: file.size, compressed: fileSize, ratio: `${((1 - fileSize / file.size) * 100).toFixed(1)}%` },
          'image compressed (inline)',
        );
      } catch (compErr) {
        log.warn({ err: compErr }, 'image compression failed, rejecting upload');
        if ('path' in file && (file as any).path) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          fsp.unlink((file as any).path).catch(() => {});
        }
        return res.status(400).json({ error: 'Invalid or corrupted image file. Please try a different file.' });
      }
    }

    // Force a non-image `.enc` extension for encrypted uploads regardless of
    // the client-supplied originalname. Encrypted bytes skip all
    // content scanning, and the stored filename ends up in the public URL; an
    // attacker-chosen extension (e.g. `evil.png`) would otherwise let the
    // unscanned blob masquerade as an image and pass the extension-only allowlists
    // on the avatar/banner/server-icon/emoji/sticker/soundboard asset surfaces.
    // The real DM client already names encrypted blobs `*.enc`, so this is a no-op
    // for legitimate uploads. (Any-file surfaces — channel/forum/thread messages,
    // role icon — are guarded by the ImageHash provenance check instead.)
    const savedExt = isEncryptedUpload ? '.enc' : origExt;
    const savedFilename = `${randomUUID()}${savedExt}`;

    // SHA-256 of the raw upload bytes. Computed for every non-encrypted
    // upload regardless of media type — including video, audio, PDF, zip —
    // so user-reported CSAM in any of those formats can include a cross-
    // provider exact-match hash in the CyberTipline report. The cost is
    // ~250ms for a 500MB video on commodity hardware; we already have the
    // bytes loaded in `fileBuffer` for MIME validation. Encrypted uploads
    // skip this because hashing ciphertext doesn't help with content
    // matching and we don't want to mislead later code into treating the
    // result as a content hash.
    let sha256Hex: string | null = null;
    if (fileBuffer && !isEncryptedUpload) {
      try { sha256Hex = createHash('sha256').update(fileBuffer).digest('hex'); } catch { sha256Hex = null; }
    }

    // PDQ perceptual hash checking (BEFORE saving to prevent TOCTOU)
    let pdqHashes: string[] = [];
    if (fileBuffer && COMPRESSIBLE_MIMES.has(fileMimetype)) {
      if (isEncryptedUpload) {
        // Encrypted uploads cannot be hashed server-side (bytes are ciphertext).
        // We do NOT trust client-supplied hashes for safety-critical checks.
        // This is a known limitation of client-side E2E encryption.
        log.info({ filename: savedFilename, userId: req.userId }, 'PDQ check skipped for encrypted upload');
      } else {
        // Block the upload until pdq-wasm finished initialising. Returning
        // 503 here is intentional: silently skipping the CSAM check on a
        // hot path is the failure mode we are explicitly preventing.
        const pdqOk = await pdqInitPromise;
        if (!pdqOk) {
          if ('path' in file && (file as any).path) {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from multer's file object, not user input
            fsp.unlink((file as any).path).catch(() => {});
          }
          log.error({ savedFilename }, 'upload rejected: PDQ not ready');
          return res.status(503).json({ error: 'Upload temporarily unavailable. Please try again in a moment.' });
        }
        pdqHashes = await computePDQHashes(fileBuffer, fileMimetype);
      }

      if (pdqHashes.length > 0) {
        try {
          const flaggedHashes = await getFlaggedHashes(prisma);
          // Pre-decode each flagged hash once. Otherwise an animated upload
          // that produces N frame hashes does N*M PDQ.fromHex calls instead
          // of M, which gets expensive once the flagged list is non-trivial.
          const flaggedBytes: Uint8Array[] = [];
          for (const flagged of flaggedHashes) {
            try { flaggedBytes.push(PDQ.fromHex(flagged)); } catch { /* skip malformed cache entry */ }
          }
          let matchedHash: string | null = null;
          outer: for (const frameHex of pdqHashes) {
            const frameBytes = PDQ.fromHex(frameHex);
            for (const fb of flaggedBytes) {
              if (PDQ.areSimilar(frameBytes, fb, 31)) { matchedHash = frameHex; break outer; }
            }
          }

          if (matchedHash) {
            // Clean up temp disk file if using disk storage
            if ('path' in file && (file as any).path) {
              // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from multer's file object, not user input
              fsp.unlink((file as any).path).catch(() => {});
            }

            // Snapshot the uploader's identity into the report. These fields
            // freeze on insert and survive a future user.delete (the FK is
            // SetNull post-2026-04-27 migration) so §2258A(h) preservation
            // still has the human-readable identity even if the user deletes
            // their account before LE follows up.
            const authorSnapshot = await prisma.user.findUnique({
              where: { id: req.userId },
              select: { username: true, discriminator: true, emailHash: true, createdAt: true },
            }).catch(() => null);

            // Forensic IP+UA. `req.ip` already follows trust-proxy config so
            // this is the client's real IP, not the load balancer. UA is the
            // raw header — `parseDevice()` lossy-parses it for display
            // elsewhere, but for an investigator we keep the original.
            const xff = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
            const uploaderIp = xff || req.ip || null;
            const uploaderUserAgent = (req.headers['user-agent'] as string | undefined) || null;

            // Await the auto-report write so a DB blip doesn't drop the audit
            // trail. We still return 403 even if the report fails — blocking
            // a flagged upload always wins over the audit row.
            try {
              await prisma.messageReport.create({
                data: {
                  // reporterId left null — system-generated auto-reports have no
                  // human reporter. The schema is nullable and the admin UI
                  // already renders `reporter: null` correctly.
                  reporterId: null,
                  messageType: 'channel',
                  messageId: savedFilename,
                  authorId: req.userId!,
                  authorUsernameSnapshot: authorSnapshot?.username ?? null,
                  authorDiscriminatorSnapshot: authorSnapshot?.discriminator ?? null,
                  authorEmailHashSnapshot: authorSnapshot?.emailHash ?? null,
                  authorRegisteredAtSnapshot: authorSnapshot?.createdAt ?? null,
                  uploaderIp,
                  uploaderUserAgent,
                  sha256: sha256Hex,
                  intendedSource,
                  intendedSourceId,
                  // Synchronous capture from the actual upload request — the
                  // IP/UA/SHA-256 here are the offending request itself, not
                  // a later best-effort lookup.
                  evidenceSource: 'upload-block',
                  evidenceCapturedAt: new Date(),
                  preservedAt: new Date(),
                  content: '[auto-flagged upload]',
                  attachmentUrl: `/api/uploads/${savedFilename}`,
                  reason: 'csam',
                  details: `PDQ hash match: ${matchedHash}${pdqHashes.length > 1 ? ` (frame match, ${pdqHashes.length} sampled)` : ''}`,
                  contentSource: 'server',
                  status: 'pending',
                },
              });
            } catch (reportErr) {
              log.error({ err: reportErr }, 'failed to create auto-report for flagged hash');
            }

            log.warn({ hash: matchedHash, frameCount: pdqHashes.length, uploader: req.userId }, 'upload blocked by PDQ flagged hash match');
            return res.status(403).json({ error: 'This file cannot be uploaded.' });
          }
        } catch (err) {
          // Fail closed: a DB or PDQ comparison failure means we cannot
          // confirm whether the file matches a flagged hash. Letting the
          // upload proceed in that state is exactly the silent-bypass
          // failure mode we are protecting against.
          log.error({ err }, 'PDQ hash check failed — refusing upload to fail safely');
          if ('path' in file && (file as any).path) {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from multer's file object, not user input
            fsp.unlink((file as any).path).catch(() => {});
          }
          return res.status(503).json({ error: 'Upload temporarily unavailable. Please try again in a moment.' });
        }
      }
    }

    // Record provenance for an encrypted blob BEFORE handing back its URL. An
    // encrypted upload skipped all content scanning, so the
    // channel-send path (routes/messages.ts) must be able to refuse attaching it
    // to a plaintext channel. This is the ONLY ImageHash row an encrypted upload
    // gets — hash + sha256 are null (the bytes are ciphertext); `encrypted: true`
    // is the queryable provenance flag. Written BEFORE save and fail-CLOSED: if we
    // cannot record that this blob skipped scanning, we never return a usable URL
    // (unlike the best-effort post-save hash rows below for scanned uploads).
    if (isEncryptedUpload) {
      try {
        await prisma.imageHash.create({
          data: {
            hash: null,
            sha256: null,
            uploaderId: req.userId!,
            filename: savedFilename,
            source: intendedSource, // always 'dm' here — enforced by the binding above
            sourceId: intendedSourceId,
            encrypted: true,
            flagMatch: false,
          },
        });
      } catch (provErr) {
        log.error(
          { err: provErr instanceof Error ? provErr.message : String(provErr) },
          'failed to record encrypted-upload provenance — rejecting upload',
        );
        if ('path' in file && (file as any).path) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from multer's file object, not user input
          fsp.unlink((file as any).path).catch(() => {});
        }
        return res.status(503).json({ error: 'Upload temporarily unavailable. Please try again in a moment.' });
      }
    }

    // Save original (or inline-compressed) file
    const tempFilePath = (file as any).path as string;
    if (s3Enabled) {
      try {
        const key = `${S3_PREFIX}${savedFilename}`;
        const storedContentType = isEncryptedUpload ? 'application/octet-stream' : fileMimetype;
        if (fileBuffer && COMPRESSIBLE_MIMES.has(fileMimetype) && !isEncryptedUpload) {
          // Image was processed in-memory (compressed/PDQ'd) — upload buffer directly
          await uploadToS3(key, fileBuffer, storedContentType);
        } else {
          // Non-image or encrypted — stream from disk to avoid holding full buffer for S3 upload
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempFilePath is validated above
          const stream = fs.createReadStream(tempFilePath);
          await uploadToS3(key, stream, storedContentType);
        }
      } catch (s3Err) {
        log.error({ err: s3Err }, 'S3 upload failed');
        return res.status(500).json({ error: 'File storage error. Please try again.' });
      }
      // Clean up temp disk file after successful S3 upload
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempFilePath is validated above
      fsp.unlink(tempFilePath).catch(() => {});
    } else if (fileBuffer) {
      const diskPath = path.join(uploadsDir, savedFilename);
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        await fsp.writeFile(diskPath, fileBuffer);
        if (tempFilePath && path.resolve(tempFilePath) !== path.resolve(diskPath)) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          try { await fsp.unlink(tempFilePath); } catch { /* best-effort cleanup */ }
        }
      } catch (writeErr) {
        log.error({ err: writeErr }, 'disk write failed');
        return res.status(500).json({ error: 'File storage error. Please try again.' });
      }
    } else {
      // No buffer available — rename temp file to final destination
      const diskPath = path.join(uploadsDir, savedFilename);
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        await fsp.rename(tempFilePath, diskPath);
      } catch (renameErr) {
        log.error({ err: renameErr }, 'disk rename failed');
        return res.status(500).json({ error: 'File storage error. Please try again.' });
      }
    }

    // Record media hashes for non-flagged files (after save).
    //   - Image uploads: one row per PDQ-sampled frame (so the retroactive
    //     sweep can later catch a match on any frame). hash = PDQ hex,
    //     sha256 = file SHA-256.
    //   - Non-image uploads with SHA-256 (video, audio, PDF, zip): one row
    //     with hash = NULL, sha256 = set. PDQ-matching code paths skip
    //     these via `hash: { not: null }`; admin-action time looks them up
    //     by filename to populate MessageReport.sha256 for NCMEC reports.
    //   - Encrypted uploads: nothing recorded — sha256Hex is null and
    //     there's no content to perceptually hash either.
    if (pdqHashes.length > 0) {
      prisma.imageHash.createMany({
        data: pdqHashes.map(hash => ({
          hash,
          sha256: sha256Hex,
          uploaderId: req.userId!,
          filename: savedFilename,
          source: intendedSource,
          sourceId: intendedSourceId,
          flagMatch: false,
        })),
      }).catch(err => log.error({ err }, 'failed to store image hashes'));
    } else if (sha256Hex) {
      prisma.imageHash.create({
        data: {
          hash: null,
          sha256: sha256Hex,
          uploaderId: req.userId!,
          filename: savedFilename,
          source: intendedSource,
          sourceId: intendedSourceId,
          flagMatch: false,
        },
      }).catch(err => log.error({ err }, 'failed to store media sha256'));
    }

    // When queues are enabled, enqueue background compression (overwrites saved file).
    // Thumbnails & frozen frames are already generated inline below, so tell the
    // worker to skip re-generating them (skipDerivatives).
    if (isCompressible && queuesEnabled && fileBuffer) {
      enqueueImageProcessing({
        filename: savedFilename,
        mimetype: fileMimetype,
        originalSize: file.size,
        skipDerivatives: true,
      }).catch((err) => log.error({ err }, 'image queue enqueue failed'));
    }

    let thumbnailUrl: string | null = null;
    if (fileBuffer && COMPRESSIBLE_MIMES.has(fileMimetype) && !isEncryptedUpload) {
      const thumb = await generateThumbnail(fileBuffer, fileMimetype).catch(() => null);
      if (thumb) {
        const thumbFilename = `${THUMB_PREFIX}${savedFilename.replace(/\.[^.]+$/, '.webp')}`;
        thumbnailUrl = `/api/uploads/${thumbFilename}`;
        if (s3Enabled) {
          uploadToS3(`${S3_PREFIX}${thumbFilename}`, thumb.buffer, thumb.mimetype).catch(err =>
            log.warn({ err }, 'thumbnail S3 upload failed'),
          );
        } else {
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          fsp.writeFile(path.join(uploadsDir, thumbFilename), thumb.buffer).catch(() => {});
        }
      }
    }

    // Generate frozen frame for GIFs (full-resolution static WebP for tab-unfocus freeze)
    if (fileMimetype === 'image/gif' && fileBuffer && !isEncryptedUpload) {
      const frame = await generateFrozenFrame(fileBuffer, fileMimetype).catch(() => null);
      if (frame) {
        const frameFilename = `${FRAME_PREFIX}${savedFilename.replace(/\.[^.]+$/, '.webp')}`;
        if (s3Enabled) {
          uploadToS3(`${S3_PREFIX}${frameFilename}`, frame.buffer, frame.mimetype).catch(err =>
            log.warn({ err }, 'frozen frame S3 upload failed'),
          );
        } else {
          const frameDiskPath = path.join(uploadsDir, frameFilename);
          const safeFramePath = path.resolve(frameDiskPath);
          if (safeFramePath.startsWith(path.resolve(uploadsDir) + path.sep)) {
            // eslint-disable-next-line security/detect-non-literal-fs-filename
            fsp.writeFile(frameDiskPath, frame.buffer).catch(() => {});
          }
        }
      }
    }

    const url = `/api/uploads/${savedFilename}`;
    const safeName = file.originalname.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').slice(0, 255);
    // Extract image dimensions from the final (possibly compressed) buffer
    // for the frontend to reserve exact placeholder space (zero layout shift).
    // Sharp is already imported and used for compression — this adds negligible overhead.
    let imageWidth: number | null = null;
    let imageHeight: number | null = null;
    if (fileBuffer && COMPRESSIBLE_MIMES.has(fileMimetype) && !isEncryptedUpload) {
      try {
        const isAnimated = fileMimetype === 'image/gif';
        const meta = await sharp(fileBuffer, {
          animated: isAnimated,
          limitInputPixels: MAX_PIXEL_COUNT,
        }).metadata();
        imageWidth = meta.width ?? null;
        // For animated GIFs, meta.height is frameHeight × pages (total strip height).
        // Use pageHeight for the actual single-frame height the browser will render.
        imageHeight = (isAnimated ? (meta.pageHeight ?? meta.height) : meta.height) ?? null;
      } catch {
        // Non-fatal — dimensions are optional. Frontend falls back to generic placeholder.
      }
    }

    res.status(201).json({ url, name: safeName, contentType: fileMimetype, size: fileSize, thumbnailUrl, width: imageWidth, height: imageHeight });
    } finally {
      releaseUploadSlot(req.userId!);
    }
  });
});

/**
 * Best-effort deletion of an uploaded file (and its thumbnail) from S3 or local disk.
 * Accepts an attachmentUrl like `/api/uploads/<filename>`.
 */
export async function deleteUploadedFile(attachmentUrl: string): Promise<void> {
  const match = attachmentUrl.match(/\/api\/uploads\/([^/?#]+)/);
  if (!match || !match[1]) return;
  const filename = match[1];
  if (filename.includes('..')) return;
  const thumbFilename = `thumb_${filename.replace(/\.[^.]+$/, '.webp')}`;
  const frameFilename = `frame_${filename.replace(/\.[^.]+$/, '.webp')}`;
  const resolvedDir = path.resolve(uploadsDir);
  const filePath = path.resolve(uploadsDir, filename);
  if (!filePath.startsWith(resolvedDir + path.sep)) return;
  const thumbPath = path.resolve(uploadsDir, thumbFilename);
  if (!thumbPath.startsWith(resolvedDir + path.sep)) return;
  try {
    if (s3Enabled && s3) {
      await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: `${S3_PREFIX}${filename}` }));
      await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: `${S3_PREFIX}${thumbFilename}` })).catch(() => {});
      await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: `${S3_PREFIX}${frameFilename}` })).catch(() => {});
      // Purge the CDN (Cloudflare) cache for the three asset URLs so the
      // browser/edge don't keep serving them after R2 has dropped the object.
      if (CDN_BASE_URL) {
        const prefix = `${CDN_BASE_URL}/${S3_PREFIX}`;
        purgeCdnUrls([
          `${prefix}${filename}`,
          `${prefix}${thumbFilename}`,
          `${prefix}${frameFilename}`,
        ]).catch(() => { /* swallowed in helper */ });
      }
    } else {
      await fsp.unlink(filePath).catch(() => {}); // eslint-disable-line security/detect-non-literal-fs-filename
      await fsp.unlink(thumbPath).catch(() => {}); // eslint-disable-line security/detect-non-literal-fs-filename
      const framePath = path.resolve(uploadsDir, frameFilename);
      if (framePath.startsWith(resolvedDir + path.sep)) {
        await fsp.unlink(framePath).catch(() => {}); // eslint-disable-line security/detect-non-literal-fs-filename
      }
    }
  } catch {
    log.warn({ filename }, 'file cleanup failed (best-effort)');
  }
}

/**
 * Returns the size in bytes of an uploaded file, or null if not found.
 * Accepts an attachmentUrl like `/api/uploads/<filename>`.
 */
export async function getUploadedFileSize(attachmentUrl: string): Promise<number | null> {
  const match = attachmentUrl.match(/\/api\/uploads\/([^/?#]+)/);
  if (!match || !match[1]) return null;
  const filename = match[1];
  if (filename.includes('..')) return null;
  const filePath = path.resolve(uploadsDir, filename);
  if (!filePath.startsWith(path.resolve(uploadsDir) + path.sep)) return null;
  try {
    if (s3Enabled && s3) {
      const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: `${S3_PREFIX}${filename}` }));
      return head.ContentLength ?? null;
    } else {
      const stat = await fsp.stat(filePath); // eslint-disable-line security/detect-non-literal-fs-filename
      return stat.size;
    }
  } catch {
    return null;
  }
}

export default router;
