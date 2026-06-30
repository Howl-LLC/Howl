// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';
import sharp from 'sharp';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { publishFlaggedHashUpdate } from '../src/redis.js';
import {
  createTestUser,
  authHeader,
  cleanupTestData,
} from './helpers.js';
import type { TestUser } from './helpers.js';

// Match upload.ts's loader so the test exercises the same PDQ binding.
const { PDQ } = createRequire(import.meta.url)('pdq-wasm') as typeof import('pdq-wasm');

/**
 * Build a deterministic PNG that PDQ can hash. Uses sharp's raw → PNG
 * encoder so the file round-trips through upload.ts's sharp pipeline
 * without surprises, and gives PDQ enough non-uniform structure that
 * the hash isn't degenerate.
 */
async function buildTestPng(seed: number): Promise<Buffer> {
  const w = 256, h = 256;
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      data[i] = (x + seed) & 0xff;
      data[i + 1] = (y * 2 + seed) & 0xff;
      data[i + 2] = ((x ^ y) + seed) & 0xff;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

let testUser: TestUser;

beforeAll(async () => {
  testUser = await createTestUser();
});

afterAll(async () => {
  await cleanupTestData();
});

describe('POST /api/upload', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/upload')
      .attach('file', Buffer.from('hello'), 'test.txt');

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 without a file', async () => {
    const res = await request(app)
      .post('/api/upload')
      .set('Authorization', authHeader(testUser.token));

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 201 with a valid file upload', async () => {
    const res = await request(app)
      .post('/api/upload')
      .set('Authorization', authHeader(testUser.token))
      .attach('file', Buffer.from('test file content'), 'sample.txt');

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('url');
    expect(res.body).toHaveProperty('name', 'sample.txt');
    expect(res.body).toHaveProperty('contentType');
    expect(res.body).toHaveProperty('size');
  });

  it('records SHA-256 on a non-image upload (hash=null, sha256=set)', async () => {
    // Non-image uploads (video, audio, PDF, zip, plain text) get an
    // ImageHash row with hash=null and sha256=populated so user-reported
    // CSAM in any media type can include a cross-provider exact-match hash
    // in the eventual NCMEC CyberTipline report. PDQ-matching code paths
    // skip these via `hash: { not: null }`.
    const bytes = Buffer.from('non-image upload contents — sha256 should land');
    const res = await request(app)
      .post('/api/upload')
      .set('Authorization', authHeader(testUser.token))
      .attach('file', bytes, 'notes.txt');
    expect(res.status).toBe(201);

    const filename = (res.body.url as string).split('/').pop();
    expect(filename).toBeTruthy();

    // imageHash.create is fire-and-forget on the upload path; poll briefly.
    let row: Awaited<ReturnType<typeof prisma.imageHash.findFirst>> = null;
    for (let i = 0; i < 20 && !row; i++) {
      row = await prisma.imageHash.findFirst({ where: { filename } });
      if (!row) await new Promise((r) => setTimeout(r, 50));
    }
    expect(row).not.toBeNull();
    expect(row!.hash).toBeNull();
    expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // SHA-256 of the exact bytes we sent — verify round-trip rather than
    // trusting whatever the route happened to compute.
    const expected = require('crypto').createHash('sha256').update(bytes).digest('hex');
    expect(row!.sha256).toBe(expected);
  });
});

describe('GET /api/uploads/:filename', () => {
  it('returns 404 for a nonexistent file', async () => {
    const res = await request(app).get('/api/uploads/nonexistent-file.png');

    expect(res.status).toBe(404);
  });

  it('returns 400 for path traversal attempts', async () => {
    const res = await request(app).get('/api/uploads/..%2F..%2Fetc%2Fpasswd');

    expect(res.status).toBe(400);
  });

  it('returns signed URL as JSON when ?as=json is requested (local disk fallback)', async () => {
    // Without S3/CDN configured (test env), the route returns the relative
    // same-origin path so the caller can fetch it directly.
    const res = await request(app).get('/api/uploads/some-uuid.png?as=json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toHaveProperty('url');
    expect(typeof res.body.url).toBe('string');
    expect(res.body.url).toBe('/api/uploads/some-uuid.png');
  });

  it('rejects path traversal even with ?as=json', async () => {
    const res = await request(app).get('/api/uploads/..%2F..%2Fetc%2Fpasswd?as=json');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/upload — PDQ flagged-hash auto-block (CSAM)', () => {
  beforeAll(async () => {
    // upload.ts kicks off PDQ.init() as a fire-and-forget at module load.
    // Make sure WASM is actually ready before exercising the PDQ codepath —
    // otherwise computePDQHash() silently returns null and the auto-block
    // path never fires.
    await PDQ.init();
  });

  it('blocks an upload whose PDQ hash matches a FlaggedHash row and persists an auto-MessageReport with reporterId=null', async () => {
    const png = await buildTestPng(0xab);

    // 1. Bootstrap upload — captures the file's actual PDQ hash via the
    //    ImageHash row that the route writes for non-flagged images.
    //    The imageHash.create inside upload.ts is fire-and-forget, so poll.
    const bootstrap = await request(app)
      .post('/api/upload')
      .set('Authorization', authHeader(testUser.token))
      .attach('file', png, 'csam-regression.png');
    expect(bootstrap.status).toBe(201);

    let imageHash: Awaited<ReturnType<typeof prisma.imageHash.findFirst>> = null;
    for (let i = 0; i < 20 && !imageHash; i++) {
      imageHash = await prisma.imageHash.findFirst({
        where: { uploaderId: testUser.id, source: 'channel' },
        orderBy: { createdAt: 'desc' },
      });
      if (!imageHash) await new Promise((r) => setTimeout(r, 50));
    }
    expect(imageHash).not.toBeNull();
    expect(imageHash!.flagMatch).toBe(false);
    const pdqHex = imageHash!.hash;
    expect(pdqHex).toMatch(/^[0-9a-f]{64}$/);

    // 2. Flag the hash and bust the 60s in-process cache so the next
    //    upload re-reads FlaggedHash. publishFlaggedHashUpdate falls back
    //    to direct handler invocation when Redis isn't configured (test env).
    await prisma.flaggedHash.create({
      data: { hash: pdqHex, reason: 'csam', source: 'manual' },
    });
    publishFlaggedHashUpdate();

    // 3. Re-upload the same image — must be blocked.
    // Set an explicit UA so the forensic-capture assertion below has a known
    // value to round-trip; supertest doesn't send a default UA in this env.
    const blocked = await request(app)
      .post('/api/upload')
      .set('Authorization', authHeader(testUser.token))
      .set('User-Agent', 'csam-regression-test/1.0')
      .attach('file', png, 'csam-regression-2.png');
    expect(blocked.status).toBe(403);
    expect(blocked.body).toHaveProperty('error');

    // 4. Auto-MessageReport must exist with reporterId=null. Regression for
    //    the original `reporterId: 'system'` bug, which violated the User FK
    //    and left blocked uploads with no admin-visible audit trail.
    //    The insert is fire-and-forget on the upload path, so poll briefly.
    let autoReport: Awaited<ReturnType<typeof prisma.messageReport.findFirst>> = null;
    for (let i = 0; i < 20 && !autoReport; i++) {
      autoReport = await prisma.messageReport.findFirst({
        where: {
          authorId: testUser.id,
          reason: 'csam',
          messageType: 'channel',
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!autoReport) await new Promise((r) => setTimeout(r, 50));
    }
    expect(autoReport).not.toBeNull();
    expect(autoReport!.reporterId).toBeNull();
    expect(autoReport!.status).toBe('pending');
    expect(autoReport!.attachmentUrl).toMatch(/^\/api\/uploads\/.+\.png$/);
    expect(autoReport!.details).toContain(pdqHex);
    expect(autoReport!.contentSource).toBe('server');

    // 2026-04-27 hardening — forensic + identity-snapshot fields populated.
    // SHA-256 is required for cross-provider exact-match in NCMEC reports,
    // uploaderIp/userAgent are the §2258A handoff token to the ISP, and
    // the *Snapshot fields survive a future user.delete (FK is SetNull).
    expect(autoReport!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(autoReport!.preservedAt).toBeInstanceOf(Date);
    expect(autoReport!.authorUsernameSnapshot).toBe(testUser.username);
    expect(autoReport!.authorRegisteredAtSnapshot).toBeInstanceOf(Date);
    // Supertest sends from 127.0.0.1 in the test harness; just confirm
    // *something* non-null landed rather than asserting an exact IP so the
    // test isn't tied to harness internals. UA is the value we explicitly set.
    expect(autoReport!.uploaderIp).not.toBeNull();
    expect(autoReport!.uploaderUserAgent).toBe('csam-regression-test/1.0');
    // Provenance: this report was populated synchronously at the upload
    // request, so evidenceSource must be 'upload-block' (gold standard).
    // intendedSource defaults to 'channel' when no ?source= query is set.
    expect(autoReport!.evidenceSource).toBe('upload-block');
    expect(autoReport!.evidenceCapturedAt).toBeInstanceOf(Date);
    expect(autoReport!.intendedSource).toBe('channel');
  });
});
