// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for POST /api/v1/dms/keys/recover.
 *
 * Regression coverage for the bug where recover() left recoveryMode='passphrase'
 * (and the stale recoveryPassphraseSalt) in the DB after re-encrypting the
 * recovery blob with a fresh random 32-byte AES key. On the user's NEXT
 * recovery, the client would read recoveryMode='passphrase' and argon2id the
 * formatted base32 string, producing a wrong key and locking the user out.
 *
 * Fix: client now sends recoveryMode='key' on every recover() call. This test
 * asserts the backend honours that and clears the mode flag.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';

const FAKE_PUB = Buffer.from('p'.repeat(32)).toString('base64');
const FAKE_BLOB_OLD = Buffer.from('blob-old').toString('base64');
const FAKE_BLOB_NEW = Buffer.from('blob-new').toString('base64');
const FAKE_BLOB_SALT_OLD = Buffer.from('salt-old').toString('base64');
const FAKE_BLOB_SALT_NEW = Buffer.from('salt-new').toString('base64');
const FAKE_RECOVERY_BLOB_OLD = Buffer.from('rec-old').toString('base64');
const FAKE_RECOVERY_NONCE_OLD = Buffer.from('rnonce-old').toString('base64');
const FAKE_RECOVERY_BLOB_NEW = Buffer.from('rec-new').toString('base64');
const FAKE_RECOVERY_NONCE_NEW = Buffer.from('rnonce-new').toString('base64');
const FAKE_PASSPHRASE_SALT = Buffer.from('passphrase-salt').toString('base64');

let user: TestUser;

beforeAll(async () => {
  user = await createTestUser();
});

afterAll(async () => {
  await prisma.dmKeyBundle.deleteMany({});
  await cleanupTestData();
});

describe('POST /api/v1/dms/keys/recover', () => {
  it("flips recoveryMode back to 'key' when the client sends recoveryMode='key'", async () => {
    // Seed a bundle in passphrase recovery mode (the buggy precondition: a
    // user who set a custom passphrase, then forgot their password).
    await prisma.dmKeyBundle.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        publicKey: FAKE_PUB,
        encryptedBlob: FAKE_BLOB_OLD,
        blobSalt: FAKE_BLOB_SALT_OLD,
        recoveryBlob: FAKE_RECOVERY_BLOB_OLD,
        recoveryNonce: FAKE_RECOVERY_NONCE_OLD,
        recoveryMode: 'passphrase',
        recoveryPassphraseSalt: FAKE_PASSPHRASE_SALT,
      },
      update: {
        encryptedBlob: FAKE_BLOB_OLD,
        blobSalt: FAKE_BLOB_SALT_OLD,
        recoveryBlob: FAKE_RECOVERY_BLOB_OLD,
        recoveryNonce: FAKE_RECOVERY_NONCE_OLD,
        recoveryMode: 'passphrase',
        recoveryPassphraseSalt: FAKE_PASSPHRASE_SALT,
      },
    });

    const res = await request(app)
      .post('/api/v1/dms/keys/recover')
      .set('Authorization', authHeader(user.token))
      .send({
        encryptedBlob: FAKE_BLOB_NEW,
        blobSalt: FAKE_BLOB_SALT_NEW,
        recoveryBlob: FAKE_RECOVERY_BLOB_NEW,
        recoveryNonce: FAKE_RECOVERY_NONCE_NEW,
        recoveryMode: 'key',
      });

    expect(res.status).toBe(200);

    const bundle = await prisma.dmKeyBundle.findUnique({
      where: { userId: user.id },
      select: {
        recoveryMode: true,
        recoveryBlob: true,
        recoveryNonce: true,
        encryptedBlob: true,
        blobSalt: true,
      },
    });

    // The fix: mode is reset so the next recovery parses the formatted base32
    // recovery key directly instead of running argon2id on it.
    expect(bundle?.recoveryMode).toBe('key');
    // The new blob/salt and recovery blob/nonce all rotated.
    expect(bundle?.encryptedBlob).toBe(FAKE_BLOB_NEW);
    expect(bundle?.blobSalt).toBe(FAKE_BLOB_SALT_NEW);
    expect(bundle?.recoveryBlob).toBe(FAKE_RECOVERY_BLOB_NEW);
    expect(bundle?.recoveryNonce).toBe(FAKE_RECOVERY_NONCE_NEW);
  });

  it('writes the signingPublicKey column atomically with the recovered blob (heals a column poisoned by a roaming rotation)', async () => {
    const STALE_AIK = Buffer.from('stale-aik-from-a-roaming-rotation').toString('base64');
    const BLOB_AIK = Buffer.from('canonical-aik-inside-recovered-bl').toString('base64');

    // Seed a bundle whose signingPublicKey column has diverged from the blob's AIK
    // (the incident's poisoned-column state).
    await prisma.dmKeyBundle.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        publicKey: FAKE_PUB,
        signingPublicKey: STALE_AIK,
        encryptedBlob: FAKE_BLOB_OLD,
        blobSalt: FAKE_BLOB_SALT_OLD,
        recoveryBlob: FAKE_RECOVERY_BLOB_OLD,
        recoveryNonce: FAKE_RECOVERY_NONCE_OLD,
        recoveryMode: 'key',
      },
      update: {
        signingPublicKey: STALE_AIK,
        encryptedBlob: FAKE_BLOB_OLD,
        blobSalt: FAKE_BLOB_SALT_OLD,
        recoveryMode: 'key',
      },
    });

    const res = await request(app)
      .post('/api/v1/dms/keys/recover')
      .set('Authorization', authHeader(user.token))
      .send({
        encryptedBlob: FAKE_BLOB_NEW,
        blobSalt: FAKE_BLOB_SALT_NEW,
        recoveryBlob: FAKE_RECOVERY_BLOB_NEW,
        recoveryNonce: FAKE_RECOVERY_NONCE_NEW,
        recoveryMode: 'key',
        signingPublicKey: BLOB_AIK,
      });

    expect(res.status).toBe(200);

    const bundle = await prisma.dmKeyBundle.findUnique({
      where: { userId: user.id },
      select: { signingPublicKey: true, encryptedBlob: true },
    });
    // The column was healed to the recovered blob's AIK in the SAME write as the blob.
    expect(bundle?.signingPublicKey).toBe(BLOB_AIK);
    expect(bundle?.encryptedBlob).toBe(FAKE_BLOB_NEW);
  });

  it('leaves the signingPublicKey column untouched when the client omits it', async () => {
    const EXISTING_AIK = Buffer.from('existing-aik-must-not-be-cleared!').toString('base64');
    await prisma.dmKeyBundle.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        publicKey: FAKE_PUB,
        signingPublicKey: EXISTING_AIK,
        encryptedBlob: FAKE_BLOB_OLD,
        blobSalt: FAKE_BLOB_SALT_OLD,
        recoveryBlob: FAKE_RECOVERY_BLOB_OLD,
        recoveryNonce: FAKE_RECOVERY_NONCE_OLD,
        recoveryMode: 'key',
      },
      update: { signingPublicKey: EXISTING_AIK, recoveryMode: 'key' },
    });

    const res = await request(app)
      .post('/api/v1/dms/keys/recover')
      .set('Authorization', authHeader(user.token))
      .send({
        encryptedBlob: FAKE_BLOB_NEW,
        blobSalt: FAKE_BLOB_SALT_NEW,
        recoveryBlob: FAKE_RECOVERY_BLOB_NEW,
        recoveryNonce: FAKE_RECOVERY_NONCE_NEW,
        recoveryMode: 'key',
      });

    expect(res.status).toBe(200);
    const bundle = await prisma.dmKeyBundle.findUnique({
      where: { userId: user.id },
      select: { signingPublicKey: true },
    });
    // A legacy client that doesn't send signingPublicKey must not null/overwrite it.
    expect(bundle?.signingPublicKey).toBe(EXISTING_AIK);
  });

  it('returns 404 when the user has no bundle', async () => {
    const stranger = await createTestUser();

    const res = await request(app)
      .post('/api/v1/dms/keys/recover')
      .set('Authorization', authHeader(stranger.token))
      .send({
        encryptedBlob: FAKE_BLOB_NEW,
        blobSalt: FAKE_BLOB_SALT_NEW,
        recoveryBlob: FAKE_RECOVERY_BLOB_NEW,
        recoveryNonce: FAKE_RECOVERY_NONCE_NEW,
        recoveryMode: 'key',
      });

    expect(res.status).toBe(404);
  });
});
