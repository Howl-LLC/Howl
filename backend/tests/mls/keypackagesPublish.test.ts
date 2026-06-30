// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/server.js';
import { createTestUser, authHeader, cleanupTestData, seedMlsPublisherAik, type TestUser } from '../helpers.js';
import { prisma } from '../../src/db.js';
import { HarnessClient } from './harnessClient.js';
import { MLS_KEYPACKAGE_POOL_CAP } from '../../src/routes/mls.js';
import { MLS_KEYPACKAGE_MAX_LIFETIME_MS, MLS_LASTRESORT_MAX_LIFETIME_MS } from '../../src/mls/as.js';
import { generateKeyPackageWithKey, defaultCapabilities, type Credential, type Lifetime } from 'ts-mls';
import { encodeKeyPackage } from 'ts-mls/keyPackage.js';
import { getImpl } from '../../src/mls/ciphersuite.js';
import { encodeMlsIdentity, buildDeviceXsigMessage } from '../../src/mls/credential.js';
import { bufToB64 } from '../../src/mls/serialization.js';

let user: TestUser;
let deviceId: string;
let userClient: HarnessClient;

beforeAll(async () => {
  user = await createTestUser();
  deviceId = randomUUID();
  // One client per (user, device): every published KeyPackage carries this client's
  // AIK, which we seed as the account's published signingPublicKey.
  userClient = await HarnessClient.create(user.id, deviceId);
  await seedMlsPublisherAik(user.id, userClient.aikPublicKeyB64());
});
afterAll(async () => {
  await prisma.mlsKeyPackage.deleteMany({});
  await cleanupTestData();
});

type Aik = { publicKey: Uint8Array; signKey: Uint8Array };

// Mint a REAL cross-signed v2 KeyPackage with an explicit lifetime. The caller owns
// the test AIK and must seed its pub as the account's signingPublicKey so the AS
// cross-sig gate passes. Used to mint >30d packages directly (HarnessClient hardcodes
// 30d) so the AS clamp difference (single-use 30d vs last-resort ~100yr) is observable.
async function kpWithAikB64(userId: string, dId: string, aik: Aik, notAfterSec: bigint): Promise<string> {
  const impl = await getImpl();
  const leaf = await impl.signature.keygen();
  const crossSig = await impl.signature.sign(aik.signKey, buildDeviceXsigMessage(userId, dId, leaf.publicKey));
  const credential: Credential = { credentialType: 'basic', identity: encodeMlsIdentity(userId, dId, aik.publicKey, crossSig) };
  const lifetime: Lifetime = { notBefore: 0n, notAfter: notAfterSec };
  const { publicPackage } = await generateKeyPackageWithKey(credential, defaultCapabilities(), lifetime, [], leaf, impl);
  return bufToB64(encodeKeyPackage(publicPackage));
}

const longLivedKpB64 = (userId: string, dId: string, aik: Aik) =>
  kpWithAikB64(userId, dId, aik, BigInt(Math.floor(Date.now() / 1000) + 200 * 365 * 24 * 60 * 60));
const thirtyDayKpB64 = (userId: string, dId: string, aik: Aik) =>
  kpWithAikB64(userId, dId, aik, BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30));

describe('POST /api/v1/mls/keypackages', () => {
  it('publishes a valid batch (AS-bound) and reports remaining', async () => {
    const kp1 = await userClient.publishKeyPackageWithStableSigningKeyB64();
    const kp2 = await userClient.publishKeyPackageWithStableSigningKeyB64();
    const res = await request(app)
      .post('/api/v1/mls/keypackages')
      .set('Authorization', authHeader(user.token))
      .send({ deviceId, keyPackages: [{ keyPackage: kp1 }, { keyPackage: kp2 }] });
    expect(res.status).toBe(201);
    expect(res.body.published).toBe(2);
    expect(res.body.remaining).toBeGreaterThanOrEqual(2);
    const rows = await prisma.mlsKeyPackage.findMany({ where: { userId: user.id, deviceId } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].keyPackage.length).toBeGreaterThan(0); // public bytes stored
  });

  it('rejects a KeyPackage whose credential identity is not the caller (400 identity_mismatch)', async () => {
    // A foreign client mints a KeyPackage for a different user; its identity won't
    // match the caller, so identity_mismatch fires before the cross-sig gate.
    const foreignClient = await HarnessClient.create(randomUUID(), randomUUID());
    const foreignKp = await foreignClient.publishKeyPackageB64();
    const res = await request(app)
      .post('/api/v1/mls/keypackages')
      .set('Authorization', authHeader(user.token))
      .send({ deviceId, keyPackages: [{ keyPackage: foreignKp }] });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('identity_mismatch');
  });

  it('rejects malformed KeyPackage bytes (400 malformed)', async () => {
    const res = await request(app)
      .post('/api/v1/mls/keypackages')
      .set('Authorization', authHeader(user.token))
      .send({ deviceId, keyPackages: [{ keyPackage: Buffer.from([1, 2, 3]).toString('base64') }] });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('malformed');
  });

  it('rejects a publish when the account has no published AIK (400 no_aik)', async () => {
    // A fresh user with NO DmKeyBundle.signingPublicKey on file must fail closed.
    const noAikUser = await createTestUser();
    const noAikDevice = randomUUID();
    const noAikClient = await HarnessClient.create(noAikUser.id, noAikDevice);
    const kp = await noAikClient.publishKeyPackageB64();
    const res = await request(app)
      .post('/api/v1/mls/keypackages')
      .set('Authorization', authHeader(noAikUser.token))
      .send({ deviceId: noAikDevice, keyPackages: [{ keyPackage: kp }] });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('no_aik');
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).post('/api/v1/mls/keypackages').send({ deviceId, keyPackages: [] });
    expect(res.status).toBe(401);
  });

  it('enforces the per-device pool cap (409 pool_full)', async () => {
    const capUser = await createTestUser();
    const capDevice = randomUUID();
    const capClient = await HarnessClient.create(capUser.id, capDevice);
    await seedMlsPublisherAik(capUser.id, capClient.aikPublicKeyB64());
    let published = 0;
    while (published < MLS_KEYPACKAGE_POOL_CAP) {
      const batchSize = Math.min(50, MLS_KEYPACKAGE_POOL_CAP - published);
      const kps = [];
      for (let i = 0; i < batchSize; i++) kps.push({ keyPackage: await capClient.publishKeyPackageWithStableSigningKeyB64() });
      const ok = await request(app)
        .post('/api/v1/mls/keypackages')
        .set('Authorization', authHeader(capUser.token))
        .send({ deviceId: capDevice, keyPackages: kps });
      expect(ok.status).toBe(201);
      published += batchSize;
    }
    const overflow = await request(app)
      .post('/api/v1/mls/keypackages')
      .set('Authorization', authHeader(capUser.token))
      .send({ deviceId: capDevice, keyPackages: [{ keyPackage: await capClient.publishKeyPackageWithStableSigningKeyB64() }] });
    expect(overflow.status).toBe(409);
    expect(overflow.body.error).toBe('pool_full');
  }, 30000);

  // ref-dedup is keyed on makeKeyPackageRef (a hash of the WHOLE KeyPackage),
  // not on the device signing key. One device publishes many single-use
  // KeyPackages that SHARE one signing key but differ in init/HPKE key, so each
  // must store as a distinct row.
  it('stores two same-signing-key/distinct-init-key KeyPackages as distinct refs (ref-based dedup)', async () => {
    const dupUser = await createTestUser();
    const dupDevice = randomUUID();
    const client = await HarnessClient.create(dupUser.id, dupDevice);
    await seedMlsPublisherAik(dupUser.id, client.aikPublicKeyB64());
    const kpA = await client.publishKeyPackageWithStableSigningKeyB64();
    const kpB = await client.publishKeyPackageWithStableSigningKeyB64();
    expect(kpA).not.toBe(kpB); // distinct wire bytes (distinct init/HPKE key)

    const res = await request(app)
      .post('/api/v1/mls/keypackages')
      .set('Authorization', authHeader(dupUser.token))
      .send({ deviceId: dupDevice, keyPackages: [{ keyPackage: kpA }, { keyPackage: kpB }] });
    expect(res.status).toBe(201);
    expect(res.body.published).toBe(2);

    const rows = await prisma.mlsKeyPackage.findMany({ where: { userId: dupUser.id, deviceId: dupDevice } });
    expect(rows.length).toBe(2);
    const refs = new Set(rows.map((r) => r.keyPackageRef));
    expect(refs.size).toBe(2); // two distinct refs despite the shared signing key

    // Republishing the SAME KeyPackage is idempotent (skipDuplicates on @unique ref).
    const dup = await request(app)
      .post('/api/v1/mls/keypackages')
      .set('Authorization', authHeader(dupUser.token))
      .send({ deviceId: dupDevice, keyPackages: [{ keyPackage: kpA }] });
    expect(dup.status).toBe(201);
    const after = await prisma.mlsKeyPackage.findMany({ where: { userId: dupUser.id, deviceId: dupDevice } });
    expect(after.length).toBe(2); // still 2 — duplicate ref skipped
  });

  it('persists a last-resort with a ~100yr notAfter and a single-use with ~30d', async () => {
    const lrUser = await createTestUser();
    const lrDevice = randomUUID();
    const lrAik = await (await getImpl()).signature.keygen();
    await seedMlsPublisherAik(lrUser.id, bufToB64(lrAik.publicKey));
    const singleKp = await thirtyDayKpB64(lrUser.id, lrDevice, lrAik);
    const lrKp = await longLivedKpB64(lrUser.id, lrDevice, lrAik);
    const res = await request(app)
      .post('/api/v1/mls/keypackages')
      .set('Authorization', authHeader(lrUser.token))
      .send({ deviceId: lrDevice, keyPackages: [{ keyPackage: singleKp, isLastResort: false }, { keyPackage: lrKp, isLastResort: true }] });
    expect(res.status).toBe(201);
    expect(res.body.published).toBe(2);
    const rows = await prisma.mlsKeyPackage.findMany({ where: { userId: lrUser.id, deviceId: lrDevice } });
    const single = rows.find((r) => !r.isLastResort)!;
    const lastResort = rows.find((r) => r.isLastResort)!;
    const nowMs = Date.now();
    expect(single.notAfter.getTime()).toBeLessThanOrEqual(nowMs + MLS_KEYPACKAGE_MAX_LIFETIME_MS + 60_000);
    expect(lastResort.notAfter.getTime()).toBeGreaterThan(nowMs + 1000 * 60 * 60 * 24 * 365);
    expect(lastResort.notAfter.getTime()).toBeLessThanOrEqual(nowMs + MLS_LASTRESORT_MAX_LIFETIME_MS + 60_000);
    expect(Number.isNaN(lastResort.notAfter.getTime())).toBe(false);
  });

  it('republishing a last-resort leaves exactly one live last-resort (server supersede)', async () => {
    const supUser = await createTestUser();
    const supDevice = randomUUID();
    const supAik = await (await getImpl()).signature.keygen();
    await seedMlsPublisherAik(supUser.id, bufToB64(supAik.publicKey));
    const first = await longLivedKpB64(supUser.id, supDevice, supAik);
    const r1 = await request(app).post('/api/v1/mls/keypackages').set('Authorization', authHeader(supUser.token)).send({ deviceId: supDevice, keyPackages: [{ keyPackage: first, isLastResort: true }] });
    expect(r1.status).toBe(201);
    let lrRows = await prisma.mlsKeyPackage.findMany({ where: { userId: supUser.id, deviceId: supDevice, isLastResort: true } });
    expect(lrRows.length).toBe(1);
    const firstRef = lrRows[0].keyPackageRef;
    const second = await longLivedKpB64(supUser.id, supDevice, supAik);
    expect(second).not.toBe(first);
    const r2 = await request(app).post('/api/v1/mls/keypackages').set('Authorization', authHeader(supUser.token)).send({ deviceId: supDevice, keyPackages: [{ keyPackage: second, isLastResort: true }] });
    expect(r2.status).toBe(201);
    lrRows = await prisma.mlsKeyPackage.findMany({ where: { userId: supUser.id, deviceId: supDevice, isLastResort: true } });
    expect(lrRows.length).toBe(1);
    expect(lrRows[0].keyPackageRef).not.toBe(firstRef);
  });

  it('rejects an intra-batch publish carrying two last-resort KeyPackages (no partial publish)', async () => {
    const batchUser = await createTestUser();
    const batchDevice = randomUUID();
    const batchAik = await (await getImpl()).signature.keygen();
    await seedMlsPublisherAik(batchUser.id, bufToB64(batchAik.publicKey));
    const first = await longLivedKpB64(batchUser.id, batchDevice, batchAik);
    const second = await longLivedKpB64(batchUser.id, batchDevice, batchAik);
    expect(second).not.toBe(first);
    const res = await request(app)
      .post('/api/v1/mls/keypackages')
      .set('Authorization', authHeader(batchUser.token))
      .send({
        deviceId: batchDevice,
        keyPackages: [
          { keyPackage: first, isLastResort: true },
          { keyPackage: second, isLastResort: true },
        ],
      });
    expect(res.status).toBe(400); // rejected by validate() before the handler runs
    const lrCount = await prisma.mlsKeyPackage.count({
      where: { userId: batchUser.id, deviceId: batchDevice, isLastResort: true },
    });
    expect(lrCount).toBe(0); // no rows created => no partial publish
  });
});
