// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';
import * as e2eEscrow from '../src/services/e2eEscrow.js';

describe('E2E Escrow Service', () => {
  beforeAll(() => {
    process.env.SERVER_E2E_MASTER_KEY = 'a'.repeat(64);
  });

  it('encrypts and decrypts escrow correctly', async () => {
    const { encryptEscrow, decryptEscrow } = await import('../src/services/e2eEscrow.js');
    const userId = 'test-user-123';
    const rawBlob = JSON.stringify({ privateKey: 'abc', channelKeys: { ch1: 'key1' } });

    const encrypted = encryptEscrow(userId, rawBlob);
    expect(encrypted).not.toContain(rawBlob);

    const decrypted = decryptEscrow(userId, encrypted);
    expect(decrypted).toBe(rawBlob);
  });

  it('produces different ciphertexts for same input (random IV)', async () => {
    const { encryptEscrow } = await import('../src/services/e2eEscrow.js');
    const userId = 'test-user-123';
    const rawBlob = '{"privateKey":"abc","channelKeys":{}}';

    const a = encryptEscrow(userId, rawBlob);
    const b = encryptEscrow(userId, rawBlob);
    expect(a).not.toBe(b);
  });

  it('derives different keys for different userIds', async () => {
    const { encryptEscrow, decryptEscrow } = await import('../src/services/e2eEscrow.js');
    const rawBlob = '{"privateKey":"abc","channelKeys":{}}';

    const encrypted = encryptEscrow('user-A', rawBlob);
    expect(() => decryptEscrow('user-B', encrypted)).toThrow();
  });

  it('rejects tampered ciphertext', async () => {
    const { encryptEscrow, decryptEscrow } = await import('../src/services/e2eEscrow.js');
    const encrypted = encryptEscrow('user-A', '{"test":true}');
    const buf = Buffer.from(encrypted, 'base64');
    buf[20] ^= 0xFF;
    expect(() => decryptEscrow('user-A', buf.toString('base64'))).toThrow();
  });

  it('rejects truncated ciphertext', async () => {
    const { decryptEscrow } = await import('../src/services/e2eEscrow.js');
    expect(() => decryptEscrow('user-A', Buffer.from('short').toString('base64'))).toThrow();
  });

  it('isMasterKeyConfigured returns true when key is set', async () => {
    const { isMasterKeyConfigured } = await import('../src/services/e2eEscrow.js');
    expect(isMasterKeyConfigured()).toBe(true);
  });

  it('decrypts a known-answer blob from the canonical derivation (pins wire compat for existing escrow rows)', async () => {
    const { decryptEscrow } = await import('../src/services/e2eEscrow.js');
    // Vector computed out-of-band under HKDF(ikm=masterKey('a'*64), salt=userId,
    // info='howl-e2e-escrow') with a fixed IV — i.e. the canonical escrow key
    // derivation. If this fails, the derivation changed and every existing
    // serverEscrowBlob row would stop decrypting.
    const KAT_BLOB = 'BwcHBwcHBwcHBwcH1yVMrdPfqK4E/KJJfqJhGqHlA88FAQIf864cAA==';
    expect(decryptEscrow('escrow-kat-user', KAT_BLOB)).toBe('{"kat":true}');
  });
});

/**
 * A missing master key must FAIL an escrow-bearing write with 503, never silently
 * null serverEscrowBlob while committing the blob and returning 200. That
 * antipattern would destroy a password-derived user's only Server-recovery path
 * during an unrelated DM-send.
 *
 * NOTE on the harness: with the test escrow fallback enabled (NODE_ENV==='test'
 * AND ALLOW_TEST_ESCROW_KEY==='1', set in tests/setup.ts),
 * `isMasterKeyConfigured()` returns `true` even with SERVER_E2E_MASTER_KEY absent,
 * so simply deleting the env var does NOT exercise the guard under vitest. We
 * therefore spy on the live module export to force the "missing key" condition the
 * route actually branches on — driving the real route code, not a fake. The env
 * var is also cleared/restored to keep the spy the single source of the false return.
 */
describe('missing master key must fail the write, not null escrow', () => {
  let escrowUser: TestUser;

  beforeAll(async () => {
    process.env.SERVER_E2E_MASTER_KEY = 'a'.repeat(64);
    escrowUser = await createTestUser();
    // Seed a password-derived bundle with a real escrow blob at a known version.
    const initialEscrow = e2eEscrow.encryptEscrow(
      escrowUser.id,
      JSON.stringify({ privateKey: 'seed', channelKeys: {} }),
    );
    await prisma.dmKeyBundle.create({
      data: {
        userId: escrowUser.id,
        publicKey: Buffer.from('p'.repeat(32)).toString('base64'),
        encryptedBlob: Buffer.from('blob-initial').toString('base64'),
        blobSalt: Buffer.from('salt-initial').toString('base64'),
        recoveryBlob: Buffer.from('rec-initial').toString('base64'),
        recoveryNonce: Buffer.from('rnonce-initial').toString('base64'),
        passwordDerived: true,
        recoveryMode: 'server-escrowed',
        serverEscrowBlob: initialEscrow,
      },
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma.dMParticipant.deleteMany({});
    await prisma.dMChannel.deleteMany({});
    await prisma.dmKeyBundle.deleteMany({});
    await cleanupTestData();
  });

  it('PUT /dms/keys/blob → 503 and leaves blobVersion + escrow unchanged when the master key is unavailable', async () => {
    const before = await prisma.dmKeyBundle.findUniqueOrThrow({
      where: { userId: escrowUser.id },
      select: { blobVersion: true, serverEscrowBlob: true },
    });

    const spy = vi.spyOn(e2eEscrow, 'isMasterKeyConfigured').mockReturnValue(false);
    try {
      const res = await request(app)
        .put('/api/v1/dms/keys/blob')
        .set('Authorization', authHeader(escrowUser.token))
        .send({
          encryptedBlob: 'AAAA',
          blobVersion: before.blobVersion,
          rawBlobForEscrow: Buffer.from('{"x":1}').toString('base64'),
        });
      expect(res.status).toBe(503);
    } finally {
      spy.mockRestore();
    }

    const after = await prisma.dmKeyBundle.findUniqueOrThrow({
      where: { userId: escrowUser.id },
      select: { blobVersion: true, serverEscrowBlob: true },
    });
    // The whole write rolled back: version not bumped, escrow not nulled.
    expect(after.blobVersion).toBe(before.blobVersion);
    expect(after.serverEscrowBlob).toBe(before.serverEscrowBlob);
    expect(after.serverEscrowBlob).not.toBeNull();
  });

  it('PUT /dms/keys/blob - blob and escrow move together: a successful escrow-bearing write updates BOTH atomically', async () => {
    // The ordering invariant (escrow computed before the only blob write, both in
    // one transaction) is pinned here on the transactional write site. escrowUser
    // is the describe's password-derived bundle with a real escrow blob.
    const before = await prisma.dmKeyBundle.findUniqueOrThrow({
      where: { userId: escrowUser.id },
      select: { blobVersion: true, serverEscrowBlob: true },
    });
    const res = await request(app)
      .put('/api/v1/dms/keys/blob')
      .set('Authorization', authHeader(escrowUser.token))
      .send({
        encryptedBlob: Buffer.from('new-blob').toString('base64'),
        blobVersion: before.blobVersion,
        rawBlobForEscrow: Buffer.from(JSON.stringify({ privateKey: 'x' })).toString('base64'),
      });
    expect(res.status).toBe(200);
    const after = await prisma.dmKeyBundle.findUniqueOrThrow({
      where: { userId: escrowUser.id },
      select: { blobVersion: true, serverEscrowBlob: true, encryptedBlob: true },
    });
    expect(after.blobVersion).toBe(before.blobVersion + 1);
    expect(after.encryptedBlob).toBe(Buffer.from('new-blob').toString('base64'));
    expect(after.serverEscrowBlob).toBeTruthy();
    expect(after.serverEscrowBlob).not.toBe(before.serverEscrowBlob);
  });

  // recover() sends rawBlobForEscrow for a password-derived user, so the /recover
  // route's escrow refresh is exercised on every recovery-key recover. The route is
  // NON-transactional, so its guard short-circuits BEFORE the updateMany — a missing
  // master key must 503 with the blob NOT reset and escrow NOT nulled (otherwise an
  // ordinary recovery during an ops misconfig would wipe the user's Server-recovery
  // path).
  it('POST /dms/keys/recover → 503 and leaves blob + escrow unchanged when the master key is unavailable', async () => {
    const before = await prisma.dmKeyBundle.findUniqueOrThrow({
      where: { userId: escrowUser.id },
      select: { blobVersion: true, serverEscrowBlob: true, encryptedBlob: true },
    });

    const spy = vi.spyOn(e2eEscrow, 'isMasterKeyConfigured').mockReturnValue(false);
    let res;
    try {
      res = await request(app)
        .post('/api/v1/dms/keys/recover')
        .set('Authorization', authHeader(escrowUser.token))
        .send({
          encryptedBlob: Buffer.from('recover-blob').toString('base64'),
          blobSalt: Buffer.from('recover-salt').toString('base64'),
          recoveryBlob: Buffer.from('recover-rec').toString('base64'),
          recoveryNonce: Buffer.from('recover-nonce').toString('base64'),
          recoveryMode: 'key',
          rawBlobForEscrow: Buffer.from('{"x":3}').toString('base64'),
        });
    } finally {
      spy.mockRestore();
    }
    expect(res!.status).toBe(503);

    const after = await prisma.dmKeyBundle.findUniqueOrThrow({
      where: { userId: escrowUser.id },
      select: { blobVersion: true, serverEscrowBlob: true, encryptedBlob: true },
    });
    // Short-circuited before the updateMany: nothing changed.
    expect(after.blobVersion).toBe(before.blobVersion);
    expect(after.encryptedBlob).toBe(before.encryptedBlob);
    expect(after.serverEscrowBlob).toBe(before.serverEscrowBlob);
    expect(after.serverEscrowBlob).not.toBeNull();
  });

  // PUT /signing-key parity with /blob and /password
  // The lazy Ed25519 / archiveKey re-upload is a live routine blob-mutating write.
  // It must honor the same "blob + escrow move together or not at all" invariant: a
  // missing master key fails the WHOLE write (503, rollback) for a Server-recovery
  // user, never a blob + version bump that leaves serverEscrowBlob lagging the live
  // blob (which a later /server-recover would then return stale).
  it('PUT /dms/keys/signing-key → 503 and leaves blobVersion + blob + signingPublicKey + escrow unchanged when the master key is unavailable', async () => {
    const before = await prisma.dmKeyBundle.findUniqueOrThrow({
      where: { userId: escrowUser.id },
      select: { blobVersion: true, serverEscrowBlob: true, encryptedBlob: true, signingPublicKey: true },
    });

    const spy = vi.spyOn(e2eEscrow, 'isMasterKeyConfigured').mockReturnValue(false);
    try {
      const res = await request(app)
        .put('/api/v1/dms/keys/signing-key')
        .set('Authorization', authHeader(escrowUser.token))
        .send({
          signingPublicKey: Buffer.from('s'.repeat(32)).toString('base64'),
          encryptedBlob: Buffer.from('sk-blob-new').toString('base64'),
          blobVersion: before.blobVersion,
          rawBlobForEscrow: Buffer.from('{"x":7}').toString('base64'),
        });
      expect(res.status).toBe(503);
    } finally {
      spy.mockRestore();
    }

    const after = await prisma.dmKeyBundle.findUniqueOrThrow({
      where: { userId: escrowUser.id },
      select: { blobVersion: true, serverEscrowBlob: true, encryptedBlob: true, signingPublicKey: true },
    });
    // Whole write rolled back: version not bumped, blob/signing-key/escrow untouched.
    expect(after.blobVersion).toBe(before.blobVersion);
    expect(after.encryptedBlob).toBe(before.encryptedBlob);
    expect(after.signingPublicKey).toBe(before.signingPublicKey);
    expect(after.serverEscrowBlob).toBe(before.serverEscrowBlob);
    expect(after.serverEscrowBlob).not.toBeNull();
  });

  it('PUT /dms/keys/signing-key — blob + escrow move together: a successful escrow-bearing write bumps version, sets signingPublicKey, and refreshes escrow atomically', async () => {
    const before = await prisma.dmKeyBundle.findUniqueOrThrow({
      where: { userId: escrowUser.id },
      select: { blobVersion: true, serverEscrowBlob: true },
    });
    const newSigning = Buffer.from('S'.repeat(32)).toString('base64');
    const res = await request(app)
      .put('/api/v1/dms/keys/signing-key')
      .set('Authorization', authHeader(escrowUser.token))
      .send({
        signingPublicKey: newSigning,
        encryptedBlob: Buffer.from('sk-blob-ok').toString('base64'),
        blobVersion: before.blobVersion,
        rawBlobForEscrow: Buffer.from(JSON.stringify({ privateKey: 'sk' })).toString('base64'),
      });
    expect(res.status).toBe(200);
    const after = await prisma.dmKeyBundle.findUniqueOrThrow({
      where: { userId: escrowUser.id },
      select: { blobVersion: true, serverEscrowBlob: true, encryptedBlob: true, signingPublicKey: true },
    });
    expect(after.blobVersion).toBe(before.blobVersion + 1);
    expect(after.encryptedBlob).toBe(Buffer.from('sk-blob-ok').toString('base64'));
    expect(after.signingPublicKey).toBe(newSigning);
    expect(after.serverEscrowBlob).toBeTruthy();
    expect(after.serverEscrowBlob).not.toBe(before.serverEscrowBlob);
  });

  it('PUT /dms/keys/signing-key — a Self (passwordDerived=false) user never gets a serverEscrowBlob, even if rawBlobForEscrow is sent (confidentiality)', async () => {
    const selfUser = await createTestUser();
    await prisma.dmKeyBundle.create({
      data: {
        userId: selfUser.id,
        publicKey: Buffer.from('q'.repeat(32)).toString('base64'),
        encryptedBlob: Buffer.from('self-blob').toString('base64'),
        blobSalt: Buffer.from('self-salt').toString('base64'),
        recoveryBlob: Buffer.from('self-rec').toString('base64'),
        recoveryNonce: Buffer.from('self-nonce').toString('base64'),
        passwordDerived: false,
      },
    });
    const res = await request(app)
      .put('/api/v1/dms/keys/signing-key')
      .set('Authorization', authHeader(selfUser.token))
      .send({
        signingPublicKey: Buffer.from('z'.repeat(32)).toString('base64'),
        encryptedBlob: Buffer.from('self-blob-2').toString('base64'),
        blobVersion: 1,
        rawBlobForEscrow: Buffer.from('{"leak":"attempt"}').toString('base64'),
      });
    expect(res.status).toBe(200);
    const after = await prisma.dmKeyBundle.findUniqueOrThrow({
      where: { userId: selfUser.id },
      select: { serverEscrowBlob: true, passwordDerived: true },
    });
    // The escrow gate is on bundle.passwordDerived: a Self user's secrets never
    // become server-readable, regardless of a (mis-sent) rawBlobForEscrow.
    expect(after.passwordDerived).toBe(false);
    expect(after.serverEscrowBlob).toBeNull();
  });

});

// A password-derived row that receives a blob write WITHOUT rawBlobForEscrow (a
// stale per-tab gate, no 409 to trigger reconcile) silently lags escrow behind the
// live blob. The route flags exactly that case as `escrowStale` so the client can
// converge its gate and re-send escrow once.
describe('escrowStale flag on a stale-gate omission', () => {
  let pdUser: TestUser;     // password-derived
  let plainUser: TestUser;  // not password-derived

  beforeAll(async () => {
    process.env.SERVER_E2E_MASTER_KEY = 'a'.repeat(64);
    pdUser = await createTestUser();
    await prisma.dmKeyBundle.create({
      data: {
        userId: pdUser.id,
        publicKey: Buffer.from('q'.repeat(32)).toString('base64'),
        encryptedBlob: Buffer.from('pd-blob').toString('base64'),
        blobSalt: Buffer.from('pd-salt').toString('base64'),
        recoveryBlob: Buffer.from('pd-rec').toString('base64'),
        recoveryNonce: Buffer.from('pd-rnonce').toString('base64'),
        passwordDerived: true,
        recoveryMode: 'server-escrowed',
        serverEscrowBlob: e2eEscrow.encryptEscrow(randomUUID(), JSON.stringify({ privateKey: 'seed', channelKeys: {} })),
      },
    });
    plainUser = await createTestUser();
    await prisma.dmKeyBundle.create({
      data: {
        userId: plainUser.id,
        publicKey: Buffer.from('w'.repeat(32)).toString('base64'),
        encryptedBlob: Buffer.from('plain-blob').toString('base64'),
        blobSalt: Buffer.from('plain-salt').toString('base64'),
        recoveryBlob: Buffer.from('plain-rec').toString('base64'),
        recoveryNonce: Buffer.from('plain-rnonce').toString('base64'),
        passwordDerived: false,
        recoveryMode: 'key',
      },
    });
  });

  afterAll(async () => {
    await prisma.dmKeyBundle.deleteMany({});
    await cleanupTestData();
  });

  it('PUT /dms/keys/blob → escrowStale:true when a password-derived row omits rawBlobForEscrow', async () => {
    const before = await prisma.dmKeyBundle.findUniqueOrThrow({
      where: { userId: pdUser.id },
      select: { blobVersion: true, serverEscrowBlob: true },
    });
    const res = await request(app)
      .put('/api/v1/dms/keys/blob')
      .set('Authorization', authHeader(pdUser.token))
      .send({ encryptedBlob: 'CCCC', blobVersion: before.blobVersion }); // escrow OMITTED
    expect(res.status).toBe(200);
    expect(res.body.escrowStale).toBe(true);
    expect(res.body.blobVersion).toBe(before.blobVersion + 1);
    // Blob bumped, but escrow stayed at the old snapshot — the lag the client heals.
    const after = await prisma.dmKeyBundle.findUniqueOrThrow({
      where: { userId: pdUser.id },
      select: { serverEscrowBlob: true },
    });
    expect(after.serverEscrowBlob).toBe(before.serverEscrowBlob);
  });

  it('PUT /dms/keys/blob → no escrowStale when escrow IS sent', async () => {
    const before = await prisma.dmKeyBundle.findUniqueOrThrow({
      where: { userId: pdUser.id },
      select: { blobVersion: true },
    });
    const res = await request(app)
      .put('/api/v1/dms/keys/blob')
      .set('Authorization', authHeader(pdUser.token))
      .send({
        encryptedBlob: 'DDDD',
        blobVersion: before.blobVersion,
        rawBlobForEscrow: Buffer.from(JSON.stringify({ privateKey: 'seed2', channelKeys: {} })).toString('base64'),
      });
    expect(res.status).toBe(200);
    expect(res.body.escrowStale).toBeUndefined();
  });

  it('PUT /dms/keys/blob → no escrowStale for a non-password-derived user (never asked to escrow)', async () => {
    const before = await prisma.dmKeyBundle.findUniqueOrThrow({
      where: { userId: plainUser.id },
      select: { blobVersion: true },
    });
    const res = await request(app)
      .put('/api/v1/dms/keys/blob')
      .set('Authorization', authHeader(plainUser.token))
      .send({ encryptedBlob: 'EEEE', blobVersion: before.blobVersion }); // escrow OMITTED
    expect(res.status).toBe(200);
    expect(res.body.escrowStale).toBeUndefined();
  });
});

// The deterministic SHA-256 test escrow key must NEVER be reachable on
// NODE_ENV==='test' alone — a prod deploy misconfigured with NODE_ENV=test would
// otherwise silently escrow every opted-in user under a public, source-visible
// constant. The fallback also requires an explicit ALLOW_TEST_ESCROW_KEY flag
// (set by tests/setup.ts) and fails closed without it.
describe('test escrow key requires an explicit opt-in flag', () => {
  let savedKey: string | undefined;
  let savedFlag: string | undefined;
  beforeAll(() => {
    savedKey = process.env.SERVER_E2E_MASTER_KEY;
    savedFlag = process.env.ALLOW_TEST_ESCROW_KEY;
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.SERVER_E2E_MASTER_KEY; else process.env.SERVER_E2E_MASTER_KEY = savedKey;
    if (savedFlag === undefined) delete process.env.ALLOW_TEST_ESCROW_KEY; else process.env.ALLOW_TEST_ESCROW_KEY = savedFlag;
  });

  it('fails closed when the master key is absent AND the flag is unset', () => {
    delete process.env.SERVER_E2E_MASTER_KEY;
    delete process.env.ALLOW_TEST_ESCROW_KEY;
    expect(e2eEscrow.isMasterKeyConfigured()).toBe(false);
    expect(() => e2eEscrow.encryptEscrow('user-x', '{"k":1}')).toThrow();
  });

  it('allows the deterministic fallback only when the flag is set', () => {
    delete process.env.SERVER_E2E_MASTER_KEY;
    process.env.ALLOW_TEST_ESCROW_KEY = '1';
    expect(e2eEscrow.isMasterKeyConfigured()).toBe(true);
    const ct = e2eEscrow.encryptEscrow('user-x', '{"k":1}');
    expect(e2eEscrow.decryptEscrow('user-x', ct)).toBe('{"k":1}');
  });
});
