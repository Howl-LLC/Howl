// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { decodeKeyPackage, makeKeyPackageRef } from 'ts-mls/keyPackage.js';
import { getImpl } from '../../services/mls/ciphersuite';
// Backend modules are the source of truth for the identity bytes + AS rules.
import { encodeMlsIdentity } from '../../backend/src/mls/credential';
import { validateAndBindKeyPackage } from '../../backend/src/mls/as';
import { bufToB64 } from '../../backend/src/mls/serialization';
import {
  encodeMlsCredentialIdentity,
  buildCrossSignedCredentialIdentity,
  createIdentity,
  generateKeyPackages,
  KEYPACKAGE_BATCH_SIZE,
  KEYPACKAGE_LOW_WATER,
  KEYPACKAGE_LIFETIME_MS,
} from '../../services/mls/mlsIdentity';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

// Ephemeral test AIK (Ed25519). createIdentity is now 4-arg and cross-signs the
// freshly-minted leaf with this AIK; makeTestIdentity threads it through.
const aik = nacl.sign.keyPair();
const aikPub = aik.publicKey;
const aikPriv = aik.secretKey;
function makeTestIdentity(userId: string, deviceId: string) {
  return createIdentity(userId, deviceId, aikPub, aikPriv);
}

describe('mlsIdentity', () => {
  it('credential identity bytes equal the backend encodeMlsIdentity', () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const crossSig = new Uint8Array(64).fill(9);
    const ours = encodeMlsCredentialIdentity(userId, deviceId, aikPub, crossSig);
    const theirs = encodeMlsIdentity(userId, deviceId, aikPub, crossSig);
    expect(Array.from(ours)).toEqual(Array.from(theirs));
  });

  it('exposes the contracted replenishment constants', () => {
    expect(KEYPACKAGE_BATCH_SIZE).toBe(20);
    expect(KEYPACKAGE_LOW_WATER).toBe(5);
    expect(KEYPACKAGE_LIFETIME_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('createIdentity builds a stable signing keypair + AIK cross-signed credential', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const bundle = await createIdentity(userId, deviceId, aikPub, aikPriv);
    expect(bundle.userId).toBe(userId);
    expect(bundle.deviceId).toBe(deviceId);
    expect(bundle.identity.signaturePublicKey.length).toBeGreaterThan(0);
    expect(bundle.identity.signaturePrivateKey.length).toBeGreaterThan(0);
    // The credential is the v2 cross-sign of the freshly-minted leaf signing key.
    expect(Array.from(bundle.identity.credentialIdentity)).toEqual(
      Array.from(buildCrossSignedCredentialIdentity(
        userId, deviceId, bundle.identity.signaturePublicKey, aikPub, aikPriv,
      )),
    );
  });

  it('generateKeyPackages yields single-use packages + exactly one last-resort, all on the stable signing key', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const bundle = await makeTestIdentity(userId, deviceId);
    const kps = await generateKeyPackages(bundle.identity, 3, true);
    expect(kps.length).toBe(4); // 3 single-use + 1 last-resort
    expect(kps.filter((k) => k.isLastResort).length).toBe(1);
    expect(kps.filter((k) => !k.isLastResort).length).toBe(3);

    // Each carries publishable bytes, a ref, and stored private material.
    for (const kp of kps) {
      expect(kp.keyPackage.length).toBeGreaterThan(0);
      expect(kp.keyPackageRef.length).toBeGreaterThan(0);
      expect(kp.privateKeyPackage.length).toBeGreaterThan(0);
    }

    // All packages share ONE signing key (stable identity) but have distinct refs.
    const impl = await getImpl();
    const sigKeys = new Set<string>();
    const refs = new Set<string>();
    for (const kp of kps) {
      const decoded = decodeKeyPackage(new Uint8Array(kp.keyPackage), 0);
      expect(decoded).not.toBeUndefined();
      sigKeys.add(Buffer.from(decoded![0].leafNode.signaturePublicKey).toString('base64'));
      const ref = await makeKeyPackageRef(decoded![0], impl.hash);
      refs.add(Buffer.from(ref).toString('base64'));
    }
    expect(sigKeys.size).toBe(1);
    expect(refs.size).toBe(4);
  });

  it('a generated KeyPackage validates against the backend AS rules', async () => {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const bundle = await makeTestIdentity(userId, deviceId);
    const [kp] = await generateKeyPackages(bundle.identity, 1, false);
    const b64 = Buffer.from(kp.keyPackage).toString('base64');
    const result = await validateAndBindKeyPackage(b64, userId, deviceId, bufToB64(aikPub));
    expect(result.ok).toBe(true);
  });

  it('requests a real (non-max) lifetime within the 30-day window', async () => {
    const bundle = await makeTestIdentity(randomUUID(), randomUUID());
    const [kp] = await generateKeyPackages(bundle.identity, 1, false);
    const decoded = decodeKeyPackage(new Uint8Array(kp.keyPackage), 0);
    const notAfterMs = Number(decoded![0].leafNode.lifetime.notAfter) * 1000;
    const nowMs = Date.now();
    expect(notAfterMs).toBeGreaterThan(nowMs);
    // within ~30 days + a minute of slack, and definitely not int64-max
    expect(notAfterMs).toBeLessThanOrEqual(nowMs + KEYPACKAGE_LIFETIME_MS + 60_000);
  });

  it('emits a last-resort leaf with a ~100-year lifetime and single-use with ~30d', async () => {
    const bundle = await makeTestIdentity(randomUUID(), randomUUID());
    const kps = await generateKeyPackages(bundle.identity, 1, true);
    expect(kps.length).toBe(2);
    const single = kps.find((k) => !k.isLastResort)!;
    const lastResort = kps.find((k) => k.isLastResort)!;

    const singleNotAfter = Number(
      decodeKeyPackage(new Uint8Array(single.keyPackage), 0)![0].leafNode.lifetime.notAfter,
    ) * 1000;
    const lrNotAfter = Number(
      decodeKeyPackage(new Uint8Array(lastResort.keyPackage), 0)![0].leafNode.lifetime.notAfter,
    ) * 1000;
    const nowMs = Date.now();

    // single-use stays on the 30-day window
    expect(singleNotAfter).toBeGreaterThan(nowMs);
    expect(singleNotAfter).toBeLessThanOrEqual(nowMs + KEYPACKAGE_LIFETIME_MS + 60_000);

    // last-resort is ~100 years out (far past the 30-day window) and a valid finite Date
    const tenYearsMs = nowMs + 10 * 365 * 24 * 60 * 60 * 1000;
    expect(lrNotAfter).toBeGreaterThan(tenYearsMs);
    expect(Number.isFinite(lrNotAfter)).toBe(true);
    expect(new Date(lrNotAfter).getTime()).toBe(lrNotAfter); // not Invalid Date
  });
});
