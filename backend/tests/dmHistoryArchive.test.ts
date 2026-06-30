// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for the cross-device DM history-archive REST routes:
 *   POST   /api/v1/dms/history-archive            — batch upsert (idempotent)
 *   GET    /api/v1/dms/history-archive/previews    — latest row per channel
 *   GET    /api/v1/dms/history-archive/:dmChannelId — paginated full restore
 *   DELETE /api/v1/dms/history-archive/:dmChannelId/:messageId — delete-for-everyone
 *   DELETE /api/v1/dms/history-archive            — bulk wipe (caller-scoped)
 *
 * Each archived row is opaque sealed ciphertext; the server never reads the
 * plaintext. Authz: only ACTIVE DM participants (DMParticipant.pendingRemoval
 * === null) may write/read/delete their OWN (userId-scoped) rows. Cross-user
 * isolation is mandatory.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { app } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';

const CHANNEL_PAGE = 200; // mirrors the route constant

// A short valid base64 ciphertext (schema: ^[A-Za-z0-9+/=]*$, max 32768).
const CT = 'AAAAAAAAAAAAAAAAAAAAAA==';

let envHashCounter = 0;
// Unique hex envelope hash (schema: ^[0-9a-f]{1,128}$).
function envHash(): string {
  return (++envHashCounter).toString(16).padStart(64, '0');
}

function item(over: Partial<{
  dmChannelId: string; envelopeHash: string; ciphertext: string;
  keyVersion: number; messageId: string; msgCreatedAt: string;
}> & { dmChannelId: string }) {
  return {
    dmChannelId: over.dmChannelId,
    envelopeHash: over.envelopeHash ?? envHash(),
    ciphertext: over.ciphertext ?? CT,
    keyVersion: over.keyVersion ?? 1,
    messageId: over.messageId ?? randomUUID(),
    msgCreatedAt: over.msgCreatedAt ?? new Date().toISOString(),
  };
}

// Seed an encrypted 1:1 DM channel with `userId` as an active participant.
async function seedChannel(userId: string): Promise<string> {
  const ch = await prisma.dMChannel.create({ data: { isGroup: false, encrypted: true } });
  await prisma.dMParticipant.create({ data: { userId, dmChannelId: ch.id } });
  return ch.id;
}

let alice: TestUser;
let bob: TestUser;

beforeEach(async () => {
  await prisma.dmHistoryArchive.deleteMany({});
  await prisma.dmHistoryArchiveTombstone.deleteMany({});
  await prisma.dMParticipant.deleteMany({});
  await prisma.dMChannel.deleteMany({});
  alice = await createTestUser();
  bob = await createTestUser();
});

function postArchive(user: TestUser, items: ReturnType<typeof item>[]) {
  return request(app)
    .post('/api/v1/dms/history-archive')
    .set('Authorization', authHeader(user.token))
    .send({ items });
}

afterAll(async () => {
  await cleanupTestData();
});

describe('POST /api/v1/dms/history-archive', () => {
  it('stores rows and reports the count', async () => {
    const ch = await seedChannel(alice.id);
    const res = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch }), item({ dmChannelId: ch })] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stored: 2, evicted: 0 });
    const count = await prisma.dmHistoryArchive.count({ where: { userId: alice.id } });
    expect(count).toBe(2);
  });

  it('is idempotent: re-POST same envelopeHash stores 0, row count unchanged', async () => {
    const ch = await seedChannel(alice.id);
    const row = item({ dmChannelId: ch });
    const first = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [row] });
    expect(first.body).toEqual({ stored: 1, evicted: 0 });

    const second = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [row] });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ stored: 0, evicted: 0 });

    const count = await prisma.dmHistoryArchive.count({ where: { userId: alice.id } });
    expect(count).toBe(1);
  });

  it('stores keyVersion=2 rows verbatim (move-to-Private re-seal generation)', async () => {
    const ch = await seedChannel(alice.id);
    const row = item({ dmChannelId: ch, keyVersion: 2 });
    const res = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [row] });
    expect(res.status).toBe(200);
    const stored = await prisma.dmHistoryArchive.findFirst({ where: { userId: alice.id, dmChannelId: ch } });
    expect(stored?.keyVersion).toBe(2);
  });

  it('a higher keyVersion supersedes a stored lower one (move-to-Private re-seal wins the race)', async () => {
    const ch = await seedChannel(alice.id);
    const hash = envHash();
    const v1 = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch, envelopeHash: hash, keyVersion: 1, ciphertext: 'CT1AAAAAAAAAAAAAAAAAAAA==' })] });
    expect(v1.body).toEqual({ stored: 1, evicted: 0 });

    const v2 = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch, envelopeHash: hash, keyVersion: 2, ciphertext: 'CT2AAAAAAAAAAAAAAAAAAAA==' })] });
    expect(v2.status).toBe(200);
    expect(v2.body).toEqual({ stored: 1, evicted: 0 });

    const rows = await prisma.dmHistoryArchive.findMany({ where: { userId: alice.id, dmChannelId: ch, envelopeHash: hash } });
    expect(rows).toHaveLength(1);
    expect(rows[0].keyVersion).toBe(2);
    expect(rows[0].ciphertext).toBe('CT2AAAAAAAAAAAAAAAAAAAA==');
  });

  it('a lower keyVersion does NOT downgrade a stored higher one (late old-key POST cannot clobber)', async () => {
    const ch = await seedChannel(alice.id);
    const hash = envHash();
    const v2 = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch, envelopeHash: hash, keyVersion: 2, ciphertext: 'CT2AAAAAAAAAAAAAAAAAAAA==' })] });
    expect(v2.body).toEqual({ stored: 1, evicted: 0 });

    const v1 = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch, envelopeHash: hash, keyVersion: 1, ciphertext: 'CT1AAAAAAAAAAAAAAAAAAAA==' })] });
    expect(v1.status).toBe(200);
    expect(v1.body).toEqual({ stored: 0, evicted: 0 });

    const rows = await prisma.dmHistoryArchive.findMany({ where: { userId: alice.id, dmChannelId: ch, envelopeHash: hash } });
    expect(rows).toHaveLength(1);
    expect(rows[0].keyVersion).toBe(2);
    expect(rows[0].ciphertext).toBe('CT2AAAAAAAAAAAAAAAAAAAA==');
  });

  // Atomic-upsert invariant (TOCTOU fix): insert-or-conditionally-supersede is a
  // single atomic op, so a higher keyVersion always wins and a lower one can
  // never downgrade, regardless of POST interleaving. Vitest runs sequentially
  // so the post-DELETE race cannot be truly interleaved here; instead we lock
  // the conditional-upsert SEMANTICS the atomic op guarantees.
  it('a concurrent lower-keyVersion insert cannot strand an old-key row over the re-seal', async () => {
    const ch = await seedChannel(alice.id);
    const hash = envHash();

    // v1 lands first (lagging device still on the old escrow-exposed archiveKey).
    const v1 = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch, envelopeHash: hash, keyVersion: 1, ciphertext: 'CT1AAAAAAAAAAAAAAAAAAAA==' })] });
    expect(v1.body).toEqual({ stored: 1, evicted: 0 });

    // v2 (rotating device) supersedes the stranded v1 row atomically.
    const v2 = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch, envelopeHash: hash, keyVersion: 2, ciphertext: 'CT2AAAAAAAAAAAAAAAAAAAA==' })] });
    expect(v2.status).toBe(200);
    expect(v2.body).toEqual({ stored: 1, evicted: 0 });

    let rows = await prisma.dmHistoryArchive.findMany({ where: { userId: alice.id, dmChannelId: ch, envelopeHash: hash } });
    expect(rows).toHaveLength(1);
    expect(rows[0].keyVersion).toBe(2);
    expect(rows[0].ciphertext).toBe('CT2AAAAAAAAAAAAAAAAAAAA==');

    // A subsequent late v1 POST for the same envelope is a no-op: it must not
    // downgrade the v2 row back to the escrow-exposed old key.
    const lateV1 = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch, envelopeHash: hash, keyVersion: 1, ciphertext: 'CT1AAAAAAAAAAAAAAAAAAAA==' })] });
    expect(lateV1.status).toBe(200);
    expect(lateV1.body).toEqual({ stored: 0, evicted: 0 });

    rows = await prisma.dmHistoryArchive.findMany({ where: { userId: alice.id, dmChannelId: ch, envelopeHash: hash } });
    expect(rows).toHaveLength(1);
    expect(rows[0].keyVersion).toBe(2);
    expect(rows[0].ciphertext).toBe('CT2AAAAAAAAAAAAAAAAAAAA==');

    // Posting the SAME envelope at the SAME keyVersion twice stores once.
    const sameAgain = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch, envelopeHash: hash, keyVersion: 2, ciphertext: 'CT2AAAAAAAAAAAAAAAAAAAA==' })] });
    expect(sameAgain.status).toBe(200);
    expect(sameAgain.body).toEqual({ stored: 0, evicted: 0 });

    expect(await prisma.dmHistoryArchive.count({ where: { userId: alice.id, dmChannelId: ch, envelopeHash: hash } })).toBe(1);
  });

  it('two items in one batch with the same envelopeHash resolve to the higher keyVersion', async () => {
    const ch = await seedChannel(alice.id);
    const hash = envHash();
    const res = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [
        item({ dmChannelId: ch, envelopeHash: hash, keyVersion: 1, ciphertext: 'CT1AAAAAAAAAAAAAAAAAAAA==' }),
        item({ dmChannelId: ch, envelopeHash: hash, keyVersion: 2, ciphertext: 'CT2AAAAAAAAAAAAAAAAAAAA==' }),
      ] });
    expect(res.status).toBe(200);
    // First item inserts (1), second item supersedes it (1).
    expect(res.body).toEqual({ stored: 2, evicted: 0 });

    const rows = await prisma.dmHistoryArchive.findMany({ where: { userId: alice.id, dmChannelId: ch, envelopeHash: hash } });
    expect(rows).toHaveLength(1);
    expect(rows[0].keyVersion).toBe(2);
    expect(rows[0].ciphertext).toBe('CT2AAAAAAAAAAAAAAAAAAAA==');
  });

  it('403 when the user is not a participant of the channel', async () => {
    const ch = await seedChannel(bob.id); // alice is NOT in this channel
    const res = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch })] });
    expect(res.status).toBe(403);
    expect(await prisma.dmHistoryArchive.count({ where: { userId: alice.id } })).toBe(0);
  });

  it('403 when the user is pendingRemoval in the channel', async () => {
    const ch = await seedChannel(alice.id);
    await prisma.dMParticipant.update({
      where: { userId_dmChannelId: { userId: alice.id, dmChannelId: ch } },
      data: { pendingRemoval: new Date() },
    });
    const res = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch })] });
    expect(res.status).toBe(403);
  });

  it('400 when items length exceeds 50', async () => {
    const ch = await seedChannel(alice.id);
    const items = Array.from({ length: 51 }, () => item({ dmChannelId: ch }));
    const res = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items });
    expect(res.status).toBe(400);
  });

  it('400 when a ciphertext exceeds the max length', async () => {
    const ch = await seedChannel(alice.id);
    const res = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch, ciphertext: 'A'.repeat(32769) })] });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/dms/history-archive/previews', () => {
  it('returns the latest row per channel and sets Cache-Control: no-store', async () => {
    const ch = await seedChannel(alice.id);
    const older = item({ dmChannelId: ch, msgCreatedAt: new Date('2026-01-01T00:00:00Z').toISOString() });
    const newer = item({ dmChannelId: ch, msgCreatedAt: new Date('2026-02-01T00:00:00Z').toISOString() });
    await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [older, newer] });

    const res = await request(app)
      .get('/api/v1/dms/history-archive/previews')
      .set('Authorization', authHeader(alice.token));

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].messageId).toBe(newer.messageId);
    expect(res.body.rows[0].msgCreatedAt).toBe(newer.msgCreatedAt);
    expect(res.body.nextCursor).toBeNull();
  });

  it('excludes channels where the caller is pendingRemoval', async () => {
    const active = await seedChannel(alice.id);
    const removed = await seedChannel(alice.id);
    await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: active }), item({ dmChannelId: removed })] });

    await prisma.dMParticipant.update({
      where: { userId_dmChannelId: { userId: alice.id, dmChannelId: removed } },
      data: { pendingRemoval: new Date() },
    });

    const res = await request(app)
      .get('/api/v1/dms/history-archive/previews')
      .set('Authorization', authHeader(alice.token));

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].dmChannelId).toBe(active);
  });
});

describe('GET /api/v1/dms/history-archive/:dmChannelId', () => {
  it('paginates newest-first, respecting the page size and cursor', async () => {
    const ch = await seedChannel(alice.id);
    const total = CHANNEL_PAGE + 5;
    // Seed total rows directly with strictly increasing timestamps.
    const base = Date.parse('2026-01-01T00:00:00Z');
    await prisma.dmHistoryArchive.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        userId: alice.id,
        dmChannelId: ch,
        envelopeHash: envHash(),
        ciphertext: CT,
        keyVersion: 1,
        messageId: randomUUID(),
        msgCreatedAt: new Date(base + i * 1000),
      })),
    });

    const page1 = await request(app)
      .get(`/api/v1/dms/history-archive/${ch}`)
      .set('Authorization', authHeader(alice.token));
    expect(page1.status).toBe(200);
    expect(page1.headers['cache-control']).toBe('no-store');
    expect(page1.body.rows).toHaveLength(CHANNEL_PAGE);
    expect(page1.body.nextCursor).not.toBeNull();
    // Newest-first: first row timestamp >= last row timestamp.
    expect(Date.parse(page1.body.rows[0].msgCreatedAt))
      .toBeGreaterThan(Date.parse(page1.body.rows[CHANNEL_PAGE - 1].msgCreatedAt));

    const page2 = await request(app)
      .get(`/api/v1/dms/history-archive/${ch}?cursor=${page1.body.nextCursor}`)
      .set('Authorization', authHeader(alice.token));
    expect(page2.status).toBe(200);
    expect(page2.body.rows).toHaveLength(5);
    expect(page2.body.nextCursor).toBeNull();

    // No overlap between pages.
    const ids1 = new Set(page1.body.rows.map((r: { id: string }) => r.id));
    for (const r of page2.body.rows) expect(ids1.has(r.id)).toBe(false);
  });

  it('403 for a non-participant', async () => {
    const ch = await seedChannel(bob.id);
    const res = await request(app)
      .get(`/api/v1/dms/history-archive/${ch}`)
      .set('Authorization', authHeader(alice.token));
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/v1/dms/history-archive/:dmChannelId/:messageId', () => {
  it('removes every revision sharing the messageId and is idempotent', async () => {
    const ch = await seedChannel(alice.id);
    const messageId = randomUUID();
    // Original + an edit revision share the messageId across two envelopeHashes.
    await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [
        item({ dmChannelId: ch, messageId }),
        item({ dmChannelId: ch, messageId }),
        item({ dmChannelId: ch }), // unrelated message, must survive
      ] });

    const first = await request(app)
      .delete(`/api/v1/dms/history-archive/${ch}/${messageId}`)
      .set('Authorization', authHeader(alice.token));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ deleted: 2 });

    const remaining = await prisma.dmHistoryArchive.findMany({ where: { userId: alice.id, dmChannelId: ch } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].messageId).not.toBe(messageId);

    const second = await request(app)
      .delete(`/api/v1/dms/history-archive/${ch}/${messageId}`)
      .set('Authorization', authHeader(alice.token));
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ deleted: 0 });
  });

  it('403 for a non-participant', async () => {
    const ch = await seedChannel(bob.id);
    const res = await request(app)
      .delete(`/api/v1/dms/history-archive/${ch}/${randomUUID()}`)
      .set('Authorization', authHeader(alice.token));
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/v1/dms/history-archive', () => {
  it('wipes only the caller rows, leaving other users untouched', async () => {
    const chA = await seedChannel(alice.id);
    const chB = await seedChannel(bob.id);
    await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: chA }), item({ dmChannelId: chA })] });
    await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(bob.token))
      .send({ items: [item({ dmChannelId: chB })] });

    const res = await request(app)
      .delete('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 2 });

    expect(await prisma.dmHistoryArchive.count({ where: { userId: alice.id } })).toBe(0);
    expect(await prisma.dmHistoryArchive.count({ where: { userId: bob.id } })).toBe(1);
  });
});

describe('move-to-Private floor: minArchiveKeyVersion high-water mark', () => {
  // Seed the caller's key bundle so the floor can be raised/read. Defaults to
  // minArchiveKeyVersion=1 per the schema.
  async function seedBundle(userId: string): Promise<void> {
    await prisma.dmKeyBundle.create({
      data: {
        userId,
        publicKey: 'pk',
        encryptedBlob: 'blob',
        blobSalt: 'salt',
        recoveryBlob: 'rblob',
        recoveryNonce: 'rnonce',
      },
    });
  }

  it('DELETE?keyVersion=2 raises the floor to 2 and wipes the archive', async () => {
    const ch = await seedChannel(alice.id);
    await seedBundle(alice.id);
    await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch }), item({ dmChannelId: ch })] });

    const del = await request(app)
      .delete('/api/v1/dms/history-archive?keyVersion=2')
      .set('Authorization', authHeader(alice.token));
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: 2 });

    const bundle = await prisma.dmKeyBundle.findUnique({ where: { userId: alice.id } });
    expect(bundle?.minArchiveKeyVersion).toBe(2);
    expect(await prisma.dmHistoryArchive.count({ where: { userId: alice.id } })).toBe(0);
  });

  it('after the floor is 2, a POST keyVersion=1 is skipped (stored:0, no row)', async () => {
    const ch = await seedChannel(alice.id);
    await seedBundle(alice.id);
    await request(app)
      .delete('/api/v1/dms/history-archive?keyVersion=2')
      .set('Authorization', authHeader(alice.token));

    const res = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch, keyVersion: 1 })] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stored: 0, evicted: 0 });
    expect(await prisma.dmHistoryArchive.count({ where: { userId: alice.id } })).toBe(0);
  });

  it('after the floor is 2, a POST keyVersion=2 succeeds (stored:1)', async () => {
    const ch = await seedChannel(alice.id);
    await seedBundle(alice.id);
    await request(app)
      .delete('/api/v1/dms/history-archive?keyVersion=2')
      .set('Authorization', authHeader(alice.token));

    const res = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch, keyVersion: 2 })] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stored: 1, evicted: 0 });
    expect(await prisma.dmHistoryArchive.count({ where: { userId: alice.id } })).toBe(1);
  });

  it('a mixed batch drops items below the floor and keeps those at/above it', async () => {
    const ch = await seedChannel(alice.id);
    await seedBundle(alice.id);
    await request(app)
      .delete('/api/v1/dms/history-archive?keyVersion=2')
      .set('Authorization', authHeader(alice.token));

    const res = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [
        item({ dmChannelId: ch, keyVersion: 1 }), // below floor, skipped
        item({ dmChannelId: ch, keyVersion: 2 }), // at floor, stored
      ] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stored: 1, evicted: 0 });
    const rows = await prisma.dmHistoryArchive.findMany({ where: { userId: alice.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].keyVersion).toBe(2);
  });

  it('a brand-new user (floor defaults to 1, no bundle) can upload keyVersion=1 rows', async () => {
    const ch = await seedChannel(alice.id);
    // No bundle seeded: the floor must default to 1.
    const res = await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch, keyVersion: 1 })] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stored: 1, evicted: 0 });
    expect(await prisma.dmHistoryArchive.count({ where: { userId: alice.id } })).toBe(1);
  });

  it('a DELETE with a LOWER keyVersion than the stored floor does NOT lower it (GREATEST)', async () => {
    await seedBundle(alice.id);
    // Raise the floor to 2.
    await request(app)
      .delete('/api/v1/dms/history-archive?keyVersion=2')
      .set('Authorization', authHeader(alice.token));
    expect((await prisma.dmKeyBundle.findUnique({ where: { userId: alice.id } }))?.minArchiveKeyVersion).toBe(2);

    // A later DELETE at keyVersion=1 must leave the floor at 2.
    const del = await request(app)
      .delete('/api/v1/dms/history-archive?keyVersion=1')
      .set('Authorization', authHeader(alice.token));
    expect(del.status).toBe(200);
    expect((await prisma.dmKeyBundle.findUnique({ where: { userId: alice.id } }))?.minArchiveKeyVersion).toBe(2);
  });

  it('a DELETE with no keyVersion wipes the archive without touching the floor', async () => {
    const ch = await seedChannel(alice.id);
    await seedBundle(alice.id);
    await request(app)
      .delete('/api/v1/dms/history-archive?keyVersion=2')
      .set('Authorization', authHeader(alice.token));
    await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch, keyVersion: 2 })] });

    const del = await request(app)
      .delete('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token));
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: 1 });
    // Floor unchanged at 2.
    expect((await prisma.dmKeyBundle.findUnique({ where: { userId: alice.id } }))?.minArchiveKeyVersion).toBe(2);
  });

  it('400 on a DELETE with an out-of-range keyVersion (defense-in-depth bounds)', async () => {
    await seedBundle(alice.id);
    // Above the max bound (aligned with the POST items' keyVersion ceiling).
    const res = await request(app)
      .delete('/api/v1/dms/history-archive?keyVersion=1000001')
      .set('Authorization', authHeader(alice.token));
    expect(res.status).toBe(400);
  });
});

describe('archive teardown: encryption reset + GDPR account delete', () => {
  it('DELETE /api/v1/dms/keys/bundle wipes the caller archive rows in the same transaction', async () => {
    const ch = await seedChannel(alice.id);
    await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch }), item({ dmChannelId: ch })] });
    expect(await prisma.dmHistoryArchive.count({ where: { userId: alice.id } })).toBe(2);

    // Seed the key bundle the reset route requires (404s without one).
    await prisma.dmKeyBundle.create({
      data: {
        userId: alice.id,
        publicKey: 'pk',
        encryptedBlob: 'blob',
        blobSalt: 'salt',
        recoveryBlob: 'rblob',
        recoveryNonce: 'rnonce',
      },
    });

    // Seed a tombstone too — the reset must wipe it in the same transaction.
    await prisma.dmHistoryArchiveTombstone.create({ data: { userId: alice.id, dmChannelId: ch, messageId: randomUUID() } });

    const res = await request(app)
      .delete('/api/v1/dms/keys/bundle')
      .set('Authorization', authHeader(alice.token));
    expect(res.status).toBe(200);

    expect(await prisma.dmHistoryArchive.count({ where: { userId: alice.id } })).toBe(0);
    expect(await prisma.dmHistoryArchiveTombstone.count({ where: { userId: alice.id } })).toBe(0);
    expect(await prisma.dmKeyBundle.findUnique({ where: { userId: alice.id } })).toBeNull();
  });

  it('the userId FK cascade removes archive rows AND tombstones when the user is deleted', async () => {
    const ch = await seedChannel(alice.id);
    await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch }), item({ dmChannelId: ch })] });
    await prisma.dmHistoryArchiveTombstone.create({ data: { userId: alice.id, dmChannelId: ch, messageId: randomUUID() } });
    expect(await prisma.dmHistoryArchive.count({ where: { userId: alice.id } })).toBe(2);
    expect(await prisma.dmHistoryArchiveTombstone.count({ where: { userId: alice.id } })).toBe(1);

    // Direct delete asserts the onDelete: Cascade FK that backs the explicit
    // GDPR deleteMany (the full GDPR route requires password/MFA setup).
    await prisma.user.delete({ where: { id: alice.id } });

    expect(await prisma.dmHistoryArchive.count({ where: { userId: alice.id } })).toBe(0);
    expect(await prisma.dmHistoryArchiveTombstone.count({ where: { userId: alice.id } })).toBe(0);
  });
});

describe('per-user row cap (enforced, oldest-first)', () => {
  it('evicts the oldest rows when over the cap and reports { stored, evicted }', async () => {
    process.env.DM_HISTORY_ARCHIVE_MAX_ROWS = '3';
    try {
      const ch = await seedChannel(alice.id);
      const day = (n: number) => item({ dmChannelId: ch, msgCreatedAt: new Date(Date.UTC(2026, 0, n)).toISOString() });
      const r1 = await postArchive(alice, [day(1), day(2), day(3)]);
      expect(r1.body).toEqual({ stored: 3, evicted: 0 });
      const r2 = await postArchive(alice, [day(4), day(5)]); // total 5 > cap 3 → evict 2 oldest
      expect(r2.body).toEqual({ stored: 2, evicted: 2 });

      expect(await prisma.dmHistoryArchive.count({ where: { userId: alice.id } })).toBe(3);
      const rows = await prisma.dmHistoryArchive.findMany({ where: { userId: alice.id }, orderBy: { msgCreatedAt: 'asc' } });
      expect(rows.map((r) => r.msgCreatedAt.getUTCDate())).toEqual([3, 4, 5]); // Jan 1 & 2 evicted
    } finally {
      delete process.env.DM_HISTORY_ARCHIVE_MAX_ROWS;
    }
  });
});

describe('delete-for-everyone is write-once (server tombstone)', () => {
  it('a re-POST of a deleted message is filtered (not resurrected)', async () => {
    const ch = await seedChannel(alice.id);
    const row = item({ dmChannelId: ch });
    expect((await postArchive(alice, [row])).body).toEqual({ stored: 1, evicted: 0 });

    await request(app)
      .delete(`/api/v1/dms/history-archive/${ch}/${row.messageId}`)
      .set('Authorization', authHeader(alice.token))
      .expect(200);
    expect(await prisma.dmHistoryArchive.count({ where: { userId: alice.id } })).toBe(0);

    // Re-POST the SAME row (e.g. a slow drain that captured it pre-delete) → tombstone filters it.
    const re = await postArchive(alice, [row]);
    expect(re.body).toEqual({ stored: 0, evicted: 0 });
    expect(await prisma.dmHistoryArchive.count({ where: { userId: alice.id } })).toBe(0);
  });

  it('DELETE writes an idempotent (write-once) tombstone', async () => {
    const ch = await seedChannel(alice.id);
    const mid = randomUUID();
    for (let i = 0; i < 2; i++) {
      await request(app)
        .delete(`/api/v1/dms/history-archive/${ch}/${mid}`)
        .set('Authorization', authHeader(alice.token))
        .expect(200);
    }
    expect(await prisma.dmHistoryArchiveTombstone.count({ where: { userId: alice.id, dmChannelId: ch, messageId: mid } })).toBe(1);
  });

  it('a non-tombstoned message in the same batch still stores', async () => {
    const ch = await seedChannel(alice.id);
    const deleted = item({ dmChannelId: ch });
    const live = item({ dmChannelId: ch });
    await postArchive(alice, [deleted]);
    await request(app)
      .delete(`/api/v1/dms/history-archive/${ch}/${deleted.messageId}`)
      .set('Authorization', authHeader(alice.token))
      .expect(200);
    // Batch carries the tombstoned row + a fresh one → only the fresh one stores.
    const res = await postArchive(alice, [deleted, live]);
    expect(res.body).toEqual({ stored: 1, evicted: 0 });
    const rows = await prisma.dmHistoryArchive.findMany({ where: { userId: alice.id } });
    expect(rows.map((r) => r.messageId)).toEqual([live.messageId]);
  });
});

describe('cross-user isolation', () => {
  it('user B cannot read or delete user A rows for the same channel', async () => {
    // Both alice and bob are active participants of the same channel.
    const ch = await prisma.dMChannel.create({ data: { isGroup: false, encrypted: true } });
    await prisma.dMParticipant.create({ data: { userId: alice.id, dmChannelId: ch.id } });
    await prisma.dMParticipant.create({ data: { userId: bob.id, dmChannelId: ch.id } });

    const aliceMsg = randomUUID();
    await request(app)
      .post('/api/v1/dms/history-archive')
      .set('Authorization', authHeader(alice.token))
      .send({ items: [item({ dmChannelId: ch.id, messageId: aliceMsg })] });

    // Bob is a participant, so the channel-restore is authorized, but he must
    // only ever see HIS OWN rows (none) — never alice's.
    const read = await request(app)
      .get(`/api/v1/dms/history-archive/${ch.id}`)
      .set('Authorization', authHeader(bob.token));
    expect(read.status).toBe(200);
    expect(read.body.rows).toHaveLength(0);

    // Bob's delete-for-everyone targets only his own rows → alice's row survives.
    const del = await request(app)
      .delete(`/api/v1/dms/history-archive/${ch.id}/${aliceMsg}`)
      .set('Authorization', authHeader(bob.token));
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: 0 });
    expect(await prisma.dmHistoryArchive.count({ where: { userId: alice.id } })).toBe(1);
  });
});

// The authoritative delete-for-everyone path is the DM message DELETE route. It
// must fan the purge out to EVERY participant's sealed archive rows (the per-user
// /history-archive DELETE above is only the deleter's own client-side cleanup; an
// offline recipient never runs it, so its sealed copy would otherwise resurrect
// the retracted message on a fresh/recovered device).
describe('DELETE /api/v1/dms/:dmChannelId/messages/:messageId — delete-for-everyone archive durability', () => {
  it("purges EVERY participant's sealed archive rows for the message, not just the deleter's", async () => {
    const ch = await prisma.dMChannel.create({ data: { isGroup: false, encrypted: true } });
    await prisma.dMParticipant.create({ data: { userId: alice.id, dmChannelId: ch.id } });
    await prisma.dMParticipant.create({ data: { userId: bob.id, dmChannelId: ch.id } });
    const msg = await prisma.dMMessage.create({
      data: { dmChannelId: ch.id, authorId: alice.id, content: 'ciphertext' },
      select: { id: true },
    });
    // Each participant has sealed its own cross-device copy of the message.
    await prisma.dmHistoryArchive.createMany({
      data: [
        { userId: alice.id, dmChannelId: ch.id, envelopeHash: envHash(), ciphertext: CT, keyVersion: 1, messageId: msg.id, msgCreatedAt: new Date() },
        { userId: bob.id, dmChannelId: ch.id, envelopeHash: envHash(), ciphertext: CT, keyVersion: 1, messageId: msg.id, msgCreatedAt: new Date() },
      ],
    });
    expect(await prisma.dmHistoryArchive.count({ where: { dmChannelId: ch.id, messageId: msg.id } })).toBe(2);

    // Author deletes the message for everyone.
    const res = await request(app)
      .delete(`/api/v1/dms/${ch.id}/messages/${msg.id}`)
      .set('Authorization', authHeader(alice.token));
    expect(res.status).toBe(204);

    // Both sealed copies are gone — no fresh-device resurrection for the offline peer.
    expect(await prisma.dmHistoryArchive.count({ where: { dmChannelId: ch.id, messageId: msg.id } })).toBe(0);
  });
});
