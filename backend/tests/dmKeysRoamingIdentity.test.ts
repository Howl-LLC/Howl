// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for PUT /api/v1/dms/keys/roaming-identity.
 *
 * Move-to-Private rotation of the roaming identity: rotates the X25519 box
 * public key + Ed25519 signing public key + re-sealed encryptedBlob atomically
 * under a blobVersion CAS. Mirrors the PUT /signing-key route.
 *
 * Coverage:
 *  1. Atomic rotate of publicKey + signingPublicKey + encryptedBlob with the
 *     blobVersion bumped by one.
 *  2. 409 on a stale blobVersion (currentVersion echoed back).
 *  3. NO re-escrow when passwordDerived=false even if rawBlobForEscrow is sent
 *     (the move-to-Private invariant: the rotated identity is never escrowed).
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';

const PUB_OLD = Buffer.from('p'.repeat(32)).toString('base64');
const PUB_NEW = Buffer.from('q'.repeat(32)).toString('base64');
const SIGN_OLD = Buffer.from('s'.repeat(32)).toString('base64');
const SIGN_NEW = Buffer.from('t'.repeat(32)).toString('base64');
const BLOB_OLD = Buffer.from('blob-old').toString('base64');
const BLOB_NEW = Buffer.from('blob-new').toString('base64');
const BLOB_SALT = Buffer.from('salt').toString('base64');
const RECOVERY_BLOB = Buffer.from('rec').toString('base64');
const RECOVERY_NONCE = Buffer.from('rnonce').toString('base64');
const RAW_FOR_ESCROW = Buffer.from('raw-blob-contents').toString('base64');

let user: TestUser;

beforeAll(async () => {
  user = await createTestUser();
});

afterAll(async () => {
  await prisma.dmKeyBundle.deleteMany({});
  await cleanupTestData();
});

describe('PUT /api/v1/dms/keys/roaming-identity', () => {
  it('atomically rotates publicKey + signingPublicKey + blob and bumps blobVersion', async () => {
    await prisma.dmKeyBundle.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        publicKey: PUB_OLD,
        signingPublicKey: SIGN_OLD,
        encryptedBlob: BLOB_OLD,
        blobSalt: BLOB_SALT,
        blobVersion: 3,
        recoveryBlob: RECOVERY_BLOB,
        recoveryNonce: RECOVERY_NONCE,
        passwordDerived: false,
      },
      update: {
        publicKey: PUB_OLD,
        signingPublicKey: SIGN_OLD,
        encryptedBlob: BLOB_OLD,
        blobVersion: 3,
        passwordDerived: false,
        serverEscrowBlob: null,
      },
    });

    const res = await request(app)
      .put('/api/v1/dms/keys/roaming-identity')
      .set('Authorization', authHeader(user.token))
      .send({
        publicKey: PUB_NEW,
        signingPublicKey: SIGN_NEW,
        encryptedBlob: BLOB_NEW,
        blobVersion: 3,
      });

    expect(res.status).toBe(200);
    expect(res.body.blobVersion).toBe(4);

    const bundle = await prisma.dmKeyBundle.findUnique({
      where: { userId: user.id },
      select: {
        publicKey: true,
        signingPublicKey: true,
        encryptedBlob: true,
        blobVersion: true,
      },
    });
    expect(bundle?.publicKey).toBe(PUB_NEW);
    expect(bundle?.signingPublicKey).toBe(SIGN_NEW);
    expect(bundle?.encryptedBlob).toBe(BLOB_NEW);
    expect(bundle?.blobVersion).toBe(4);
  });

  it('returns 409 with currentVersion on a stale blobVersion', async () => {
    // Bundle is now at blobVersion 4 (from the prior test). Send a stale 3.
    const res = await request(app)
      .put('/api/v1/dms/keys/roaming-identity')
      .set('Authorization', authHeader(user.token))
      .send({
        publicKey: PUB_NEW,
        signingPublicKey: SIGN_NEW,
        encryptedBlob: BLOB_NEW,
        blobVersion: 3,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Version conflict');
    expect(res.body.currentVersion).toBe(4);
  });

  it('does NOT re-escrow when passwordDerived=false even if rawBlobForEscrow is sent', async () => {
    const selfUser = await createTestUser();
    await prisma.dmKeyBundle.upsert({
      where: { userId: selfUser.id },
      create: {
        userId: selfUser.id,
        publicKey: PUB_OLD,
        signingPublicKey: SIGN_OLD,
        encryptedBlob: BLOB_OLD,
        blobSalt: BLOB_SALT,
        blobVersion: 1,
        recoveryBlob: RECOVERY_BLOB,
        recoveryNonce: RECOVERY_NONCE,
        passwordDerived: false,
        serverEscrowBlob: null,
      },
      update: {
        publicKey: PUB_OLD,
        signingPublicKey: SIGN_OLD,
        encryptedBlob: BLOB_OLD,
        blobVersion: 1,
        passwordDerived: false,
        serverEscrowBlob: null,
      },
    });

    const res = await request(app)
      .put('/api/v1/dms/keys/roaming-identity')
      .set('Authorization', authHeader(selfUser.token))
      .send({
        publicKey: PUB_NEW,
        signingPublicKey: SIGN_NEW,
        encryptedBlob: BLOB_NEW,
        blobVersion: 1,
        rawBlobForEscrow: RAW_FOR_ESCROW,
      });

    expect(res.status).toBe(200);

    const bundle = await prisma.dmKeyBundle.findUnique({
      where: { userId: selfUser.id },
      select: { serverEscrowBlob: true, passwordDerived: true },
    });
    // The move-to-Private invariant: the rotated identity is never escrowed for
    // a Self-recovery (passwordDerived=false) user.
    expect(bundle?.passwordDerived).toBe(false);
    expect(bundle?.serverEscrowBlob).toBeNull();
  });
});
