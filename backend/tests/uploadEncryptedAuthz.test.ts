// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { extractUploadFilename } from '../src/services/uploadProvenance.js';
import {
  createTestUser,
  createTestServer,
  createTestChannel,
  authHeader,
  cleanupTestData,
} from './helpers.js';
import type { TestUser } from './helpers.js';

/**
 * `POST /upload?encrypted=true` skips ALL server-side
 * content safety (MIME magic-byte, EXIF strip, decompression-bomb, SHA-256/NCMEC,
 * PDQ/CSAM) because the bytes are E2E ciphertext. The flag was self-asserted and
 * unbound to a DM, and the resulting `/api/uploads/<uuid>` URL was attachable to a
 * plaintext, multi-recipient server channel. These tests pin the two-layer fix:
 *   (1) request-time binding — an encrypted upload must target a DM the caller is
 *       an ACTIVE participant of; encrypted=true on any non-DM source is rejected.
 *   (2) send-time provenance — an encrypted (scan-skipped) blob cannot be attached
 *       to a plaintext server channel.
 */

let counter = 0;
const encBytes = () => Buffer.from(`opaque-ciphertext-not-real-content-${counter++}`);
const enc = { filename: 'blob.enc', contentType: 'application/octet-stream' };

let uploader: TestUser;
let outsider: TestUser;
let dmIn: string; // DM the uploader is an active participant of
let dmOut: string; // DM the uploader is NOT in (outsider only)
let groupDm: string; // group DM the uploader owns
let serverId: string;
let channelId: string;
let threadId: string;

/** Mint an encrypted (scan-skipped) blob bound to a DM the uploader is in. */
async function mintEncryptedBlob(sourceId = dmIn, filename = 'blob.enc'): Promise<string> {
  const up = await request(app)
    .post(`/api/upload?encrypted=true&source=dm&sourceId=${sourceId}`)
    .set('Authorization', authHeader(uploader.token))
    .attach('file', encBytes(), { filename, contentType: 'application/octet-stream' });
  expect(up.status).toBe(201);
  return up.body.url as string;
}

beforeAll(async () => {
  uploader = await createTestUser();
  outsider = await createTestUser();
  const din = await prisma.dMChannel.create({
    data: { encrypted: true, participants: { create: [{ userId: uploader.id }, { userId: outsider.id }] } },
  });
  dmIn = din.id;
  const dout = await prisma.dMChannel.create({
    data: { encrypted: true, participants: { create: [{ userId: outsider.id }] } },
  });
  dmOut = dout.id;
  const gdm = await prisma.dMChannel.create({
    data: { isGroup: true, encrypted: true, ownerId: uploader.id, participants: { create: [{ userId: uploader.id }, { userId: outsider.id }] } },
  });
  groupDm = gdm.id;
  const server = await createTestServer(uploader.id);
  serverId = server.id;
  const channel = await createTestChannel(server.id);
  channelId = channel.id;
  // Seed a parent message + thread so the thread-attach surface can be exercised.
  const parent = await prisma.message.create({
    data: { id: randomUUID(), channelId, authorId: uploader.id, content: 'parent' },
  });
  const thread = await prisma.thread.create({
    data: { id: randomUUID(), channelId, serverId, parentMessageId: parent.id, name: 'thread', authorId: uploader.id },
  });
  threadId = thread.id;
});

afterAll(async () => {
  await cleanupTestData();
});

describe('POST /upload — encrypted blob must be bound to a DM the caller is in', () => {
  it('rejects encrypted=true with source=channel (400)', async () => {
    const res = await request(app)
      .post('/api/upload?encrypted=true&source=channel')
      .set('Authorization', authHeader(uploader.token))
      .attach('file', encBytes(), enc);
    expect(res.status).toBe(400);
  });

  it('rejects encrypted=true with no source param (defaults to non-DM) (400)', async () => {
    const res = await request(app)
      .post('/api/upload?encrypted=true')
      .set('Authorization', authHeader(uploader.token))
      .attach('file', encBytes(), enc);
    expect(res.status).toBe(400);
  });

  it('rejects encrypted=true source=dm for a DM the caller is NOT in (403)', async () => {
    const res = await request(app)
      .post(`/api/upload?encrypted=true&source=dm&sourceId=${dmOut}`)
      .set('Authorization', authHeader(uploader.token))
      .attach('file', encBytes(), enc);
    expect(res.status).toBe(403);
  });

  it('accepts encrypted=true source=dm for a DM the caller IS in, and records encrypted provenance', async () => {
    const res = await request(app)
      .post(`/api/upload?encrypted=true&source=dm&sourceId=${dmIn}`)
      .set('Authorization', authHeader(uploader.token))
      .attach('file', encBytes(), enc);
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/^\/api\/uploads\//);
    const filename = String(res.body.url).split('/').pop()!;
    const prov = await prisma.imageHash.findFirst({ where: { filename } });
    expect(prov).not.toBeNull();
    expect(prov?.encrypted).toBe(true);
    expect(prov?.source).toBe('dm');
    expect(prov?.sourceId).toBe(dmIn);
  });
});

describe('Channel message send refuses an encrypted DM blob', () => {
  it('rejects attaching an encrypted DM blob URL to a plaintext server channel (400)', async () => {
    const up = await request(app)
      .post(`/api/upload?encrypted=true&source=dm&sourceId=${dmIn}`)
      .set('Authorization', authHeader(uploader.token))
      .attach('file', encBytes(), enc);
    expect(up.status).toBe(201);

    const res = await request(app)
      .post(`/api/messages/channels/${channelId}`)
      .set('Authorization', authHeader(uploader.token))
      .send({ content: 'look at this', attachmentUrl: up.body.url });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/encrypted/i);
  });

  it('rejects an encrypted DM blob even with a query string appended to the URL (bypass guard)', async () => {
    const up = await request(app)
      .post(`/api/upload?encrypted=true&source=dm&sourceId=${dmIn}`)
      .set('Authorization', authHeader(uploader.token))
      .attach('file', encBytes(), enc);
    expect(up.status).toBe(201);

    // The serve route ignores a trailing ?query, so the provenance check must
    // normalize it away — otherwise `<uuid>.enc?x` slips past the filename lookup.
    const res = await request(app)
      .post(`/api/messages/channels/${channelId}`)
      .set('Authorization', authHeader(uploader.token))
      .send({ content: 'sneaky', attachmentUrl: `${up.body.url}?cachebust=1` });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/encrypted/i);
  });

  it('still allows a normal (non-encrypted) upload URL on a server channel (201)', async () => {
    const res = await request(app)
      .post(`/api/messages/channels/${channelId}`)
      .set('Authorization', authHeader(uploader.token))
      .send({ content: 'hi', attachmentUrl: '/api/uploads/not-an-encrypted-blob.png' });
    expect(res.status).toBe(201);
  });

  it('allows a REAL scanned upload (encrypted:false provenance row) on a channel — pins the encrypted:true filter', async () => {
    // A genuine non-encrypted upload writes an ImageHash row with encrypted:false.
    const up = await request(app)
      .post('/api/upload')
      .set('Authorization', authHeader(uploader.token))
      .attach('file', Buffer.from('plain notes file'), 'notes.txt');
    expect(up.status).toBe(201);
    const filename = String(up.body.url).split('/').pop()!;
    const prov = await prisma.imageHash.findFirst({ where: { filename } });
    expect(prov?.encrypted).toBe(false); // scanned upload recorded as not-encrypted
    const res = await request(app)
      .post(`/api/messages/channels/${channelId}`)
      .set('Authorization', authHeader(uploader.token))
      .send({ content: 'real file', attachmentUrl: up.body.url });
    expect(res.status).toBe(201);
  });

  it('rejects an encrypted DM blob attached via a trailing-slash URL (serve route ignores the slash)', async () => {
    const url = await mintEncryptedBlob();
    const res = await request(app)
      .post(`/api/messages/channels/${channelId}`)
      .set('Authorization', authHeader(uploader.token))
      .send({ content: 'trailing', attachmentUrl: `${url}/` });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/encrypted/i);
  });

  it('rejects an encrypted DM blob attached via the absolute backend-origin URL', async () => {
    const url = await mintEncryptedBlob();
    // Mirror the server's own allowed-origin computation so the URL passes the
    // origin gate and reaches the provenance check via its absolute form.
    const backendOrigin = (process.env.FRONTEND_ORIGIN || 'http://localhost:5000').split(',')[0].trim();
    const res = await request(app)
      .post(`/api/messages/channels/${channelId}`)
      .set('Authorization', authHeader(uploader.token))
      .send({ content: 'absolute', attachmentUrl: `${backendOrigin}${url}` });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/encrypted/i);
  });
});

describe('Encrypted uploads are forced to a non-image .enc extension (masquerade defense)', () => {
  it('keeps a .enc filename even when the client claims an image originalname', async () => {
    const up = await request(app)
      .post(`/api/upload?encrypted=true&source=dm&sourceId=${dmIn}`)
      .set('Authorization', authHeader(uploader.token))
      .attach('file', encBytes(), { filename: 'evil.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect(String(up.body.url)).toMatch(/\.enc$/);
    expect(String(up.body.url)).not.toMatch(/\.png/);
    const filename = String(up.body.url).split('/').pop()!;
    const prov = await prisma.imageHash.findFirst({ where: { filename } });
    expect(prov?.encrypted).toBe(true);
  });
});

describe('Group DM uploads + other attach surfaces (comprehensive closure)', () => {
  it('accepts an encrypted upload bound to a group DM the caller owns (201)', async () => {
    const up = await request(app)
      .post(`/api/upload?encrypted=true&source=dm&sourceId=${groupDm}`)
      .set('Authorization', authHeader(uploader.token))
      .attach('file', encBytes(), enc);
    expect(up.status).toBe(201);
  });

  it('rejects an encrypted DM blob attached to a thread message (400)', async () => {
    const url = await mintEncryptedBlob();
    const res = await request(app)
      .post(`/api/servers/${serverId}/threads/${threadId}/messages`)
      .set('Authorization', authHeader(uploader.token))
      .send({ content: 'thread sneak', attachment: { url, name: 'x.enc' } });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/encrypted/i);
  });
});

describe('Extension-checked asset surfaces reject the query-suffix masquerade (.enc-forcing defense)', () => {
  // A `.enc` blob URL with a fake image ext in the query (`<uuid>.enc?x.png`) must
  // NOT pass the extension allowlists — the serve route would strip the query and
  // serve the unscanned `.enc` blob.
  it('emoji create rejects an /api/uploads/*.enc URL with a ?fake.png suffix (imageUploadUrlSchema)', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/emoji`)
      .set('Authorization', authHeader(uploader.token))
      .send({ name: 'sneaky', imageUrl: `/api/uploads/${randomUUID()}.enc?x.png` });
    expect(res.status).toBe(400);
  });

  it('server icon update rejects an /api/uploads/*.enc URL with a ?fake.png suffix (isAllowedImageUrl)', async () => {
    const res = await request(app)
      .patch(`/api/servers/${serverId}`)
      .set('Authorization', authHeader(uploader.token))
      .send({ icon: `/api/uploads/${randomUUID()}.enc?x.png` });
    expect(res.status).toBe(400);
  });
});

describe('extractUploadFilename — normalizes every URL form the serve route accepts', () => {
  it('matches the serve route across relative, /v1, absolute, trailing-slash, query and %-encoding', () => {
    expect(extractUploadFilename('/api/uploads/abc.enc')).toBe('abc.enc');
    expect(extractUploadFilename('/api/v1/uploads/abc.enc')).toBe('abc.enc');
    expect(extractUploadFilename('https://api.example.com/api/uploads/abc.enc')).toBe('abc.enc');
    expect(extractUploadFilename('/api/uploads/abc.enc/')).toBe('abc.enc'); // trailing slash
    expect(extractUploadFilename('/api/uploads/abc.enc?cachebust=1')).toBe('abc.enc');
    expect(extractUploadFilename('/api/uploads/abc.enc#frag')).toBe('abc.enc');
    expect(extractUploadFilename('/api/uploads/a%62c.enc')).toBe('abc.enc'); // %62 = 'b'
    expect(extractUploadFilename('https://cdn.klipy.com/sticker.png')).toBeNull(); // not a local upload
    expect(extractUploadFilename('')).toBeNull();
  });
});
