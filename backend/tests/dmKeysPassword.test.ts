// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for PUT /api/v1/dms/keys/password — the signingPublicKey column write.
 *
 * A password change re-encrypts the blob (whose privateSigningKey = the account AIK)
 * under a new key/salt. The client now sends the matching signingPublicKey so the
 * column moves atomically with the blob — closing the column != blob divergence class
 * (the roaming-rotation poison behind the MLS "encryption still loading" wedge).
 * A legacy client that omits it must leave the column untouched.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';

const PUB = Buffer.from('p'.repeat(32)).toString('base64');
const SIGN_OLD = Buffer.from('old-aik-from-a-roaming-rotation!!').toString('base64');
const SIGN_NEW = Buffer.from('canonical-aik-inside-the-newblob!').toString('base64');
const BLOB_OLD = Buffer.from('blob-old').toString('base64');
const BLOB_NEW = Buffer.from('blob-new').toString('base64');
const SALT_OLD = Buffer.from('salt-old').toString('base64');
const SALT_NEW = Buffer.from('salt-new').toString('base64');
const REC_BLOB = Buffer.from('rec-new').toString('base64');
const REC_NONCE = Buffer.from('rnonce-new').toString('base64');

let user: TestUser;

beforeAll(async () => {
  user = await createTestUser();
});

afterAll(async () => {
  await prisma.dmKeyBundle.deleteMany({});
  await cleanupTestData();
});

async function seedBundle(signingPublicKey: string, blobVersion: number): Promise<void> {
  await prisma.dmKeyBundle.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      publicKey: PUB,
      signingPublicKey,
      encryptedBlob: BLOB_OLD,
      blobSalt: SALT_OLD,
      blobVersion,
      recoveryBlob: REC_BLOB,
      recoveryNonce: REC_NONCE,
      passwordDerived: false,
    },
    update: {
      signingPublicKey,
      encryptedBlob: BLOB_OLD,
      blobSalt: SALT_OLD,
      blobVersion,
      passwordDerived: false,
      serverEscrowBlob: null,
    },
  });
}

describe('PUT /api/v1/dms/keys/password', () => {
  it('writes signingPublicKey atomically with the re-encrypted blob (heals a poisoned column)', async () => {
    await seedBundle(SIGN_OLD, 3);

    const res = await request(app)
      .put('/api/v1/dms/keys/password')
      .set('Authorization', authHeader(user.token))
      .send({
        encryptedBlob: BLOB_NEW,
        blobSalt: SALT_NEW,
        blobVersion: 3,
        recoveryBlob: REC_BLOB,
        recoveryNonce: REC_NONCE,
        recoveryMode: 'key',
        signingPublicKey: SIGN_NEW,
      });

    expect(res.status).toBe(200);
    expect(res.body.blobVersion).toBe(4);

    const bundle = await prisma.dmKeyBundle.findUnique({
      where: { userId: user.id },
      select: { signingPublicKey: true, encryptedBlob: true, blobSalt: true, blobVersion: true },
    });
    expect(bundle?.signingPublicKey).toBe(SIGN_NEW);
    expect(bundle?.encryptedBlob).toBe(BLOB_NEW);
    expect(bundle?.blobSalt).toBe(SALT_NEW);
    expect(bundle?.blobVersion).toBe(4);
  });

  it('leaves the signingPublicKey column untouched when the client omits it', async () => {
    await seedBundle(SIGN_OLD, 1);

    const res = await request(app)
      .put('/api/v1/dms/keys/password')
      .set('Authorization', authHeader(user.token))
      .send({
        encryptedBlob: BLOB_NEW,
        blobSalt: SALT_NEW,
        blobVersion: 1,
        recoveryBlob: REC_BLOB,
        recoveryNonce: REC_NONCE,
        recoveryMode: 'key',
      });

    expect(res.status).toBe(200);
    const bundle = await prisma.dmKeyBundle.findUnique({
      where: { userId: user.id },
      select: { signingPublicKey: true },
    });
    expect(bundle?.signingPublicKey).toBe(SIGN_OLD);
  });
});
