// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Adder-side consumed-KeyPackage trust check.
// Tests assertConsumedKeyPackageTrusted directly: the single choke point that
// every consume->add path runs before a peer's KeyPackage is fed to addMembers.
// Mints real KeyPackages via generateKeyPackages(bundle.identity, ...) where the
// bundle is built with createIdentity(userId, deviceId, aikPub, aikPriv), so each
// candidate carries a genuine AIK cross-sig over its leaf signing key.
// Trust-store state (the TOFU AIK pin) lives in IndexedDB, so we use a fresh
// IDBFactory per test (mirrors mlsTrustStore.test.ts / validateCredential.test.ts).
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { encodeKeyPackage } from 'ts-mls/keyPackage.js';
import { getImpl } from '../../services/mls/ciphersuite';
import { createIdentity, generateKeyPackages, buildCrossSignedCredentialIdentity } from '../../services/mls/mlsIdentity';
import { copyBytes } from '../../services/mls/mlsEngine';
import { assertConsumedKeyPackageTrusted, KeyPackageUntrustedError } from '../../services/mls/credentialTrust';
import * as store from '../../services/mls/mlsGroupStore';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory(); // fresh trust store per test
  store.__testHooks.resetDbHandle();
});

/** Mint one real, validly cross-signed KeyPackage for (userId, deviceId, aik). */
async function mintKeyPackage(userId: string, deviceId: string, aik: nacl.SignKeyPair): Promise<Uint8Array> {
  const bundle = await createIdentity(userId, deviceId, aik.publicKey, aik.secretKey);
  const [pkg] = await generateKeyPackages(bundle.identity, 1, false);
  return pkg.keyPackage;
}

describe('assertConsumedKeyPackageTrusted (adder-side gate)', () => {
  it('resolves for a valid cross-sig + matching requested userId + first-sight AIK', async () => {
    const impl = await getImpl();
    const userId = randomUUID();
    const aik = nacl.sign.keyPair();
    const bytes = await mintKeyPackage(userId, randomUUID(), aik);
    await expect(
      assertConsumedKeyPackageTrusted(bytes, userId, impl, store.pinOrVerifyAik, copyBytes),
    ).resolves.toBeUndefined();
  });

  it('resolves when the AIK matches the already-pinned AIK (second device, same user)', async () => {
    const impl = await getImpl();
    const userId = randomUUID();
    const aik = nacl.sign.keyPair(); // ONE account AIK shared across devices
    const dev1 = await mintKeyPackage(userId, randomUUID(), aik);
    const dev2 = await mintKeyPackage(userId, randomUUID(), aik);
    // First sight pins the AIK; the second device matches it -> still trusted.
    await expect(assertConsumedKeyPackageTrusted(dev1, userId, impl, store.pinOrVerifyAik, copyBytes)).resolves.toBeUndefined();
    await expect(assertConsumedKeyPackageTrusted(dev2, userId, impl, store.pinOrVerifyAik, copyBytes)).resolves.toBeUndefined();
  });

  it('throws (aik_mismatch) for a second leaf with a DIFFERENT AIK for a pinned userId', async () => {
    const impl = await getImpl();
    const userId = randomUUID();
    const aik1 = nacl.sign.keyPair();
    const aik2 = nacl.sign.keyPair(); // different account AIK, same userId
    const dev1 = await mintKeyPackage(userId, randomUUID(), aik1);
    const dev2 = await mintKeyPackage(userId, randomUUID(), aik2);
    await expect(assertConsumedKeyPackageTrusted(dev1, userId, impl, store.pinOrVerifyAik, copyBytes)).resolves.toBeUndefined();
    await expect(assertConsumedKeyPackageTrusted(dev2, userId, impl, store.pinOrVerifyAik, copyBytes))
      .rejects.toMatchObject({ name: 'KeyPackageUntrustedError', reason: 'aik_mismatch' });
  });

  it('throws (userid_mismatch) when the credential userId != the requested userId', async () => {
    const impl = await getImpl();
    const credUserId = randomUUID();
    const requestedUserId = randomUUID(); // different from the credential's userId
    const aik = nacl.sign.keyPair();
    const bytes = await mintKeyPackage(credUserId, randomUUID(), aik);
    await expect(assertConsumedKeyPackageTrusted(bytes, requestedUserId, impl, store.pinOrVerifyAik, copyBytes))
      .rejects.toBeInstanceOf(KeyPackageUntrustedError);
    await expect(assertConsumedKeyPackageTrusted(bytes, requestedUserId, impl, store.pinOrVerifyAik, copyBytes))
      .rejects.toMatchObject({ reason: 'userid_mismatch' });
  });

  it('throws (crosssig) when the leaf is cross-signed by the WRONG AIK (binding broken)', async () => {
    // Build a KeyPackage whose credential's cross-sig is over a stand-in key, NOT
    // over the leaf signing key embedded in the MLS KeyPackage -> cross-sig fails
    // when verified over the real leaf key (the leaf still self-signs validly).
    const impl = await getImpl();
    const userId = randomUUID();
    const aik = nacl.sign.keyPair();
    const { signKey, publicKey: leafPub } = await impl.signature.keygen();
    // crossSig is over aik.publicKey (a stand-in), NOT over leafPub.
    const badCredId = buildCrossSignedCredentialIdentity(userId, randomUUID(), aik.publicKey, aik.publicKey, aik.secretKey);
    const { generateKeyPackageWithKey, defaultCapabilities } = await import('ts-mls');
    const { publicPackage } = await generateKeyPackageWithKey(
      { credentialType: 'basic', identity: badCredId },
      defaultCapabilities(),
      { notBefore: 0n, notAfter: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30) },
      [],
      { signKey, publicKey: leafPub },
      impl,
    );
    const bytes = new Uint8Array(encodeKeyPackage(publicPackage));
    await expect(assertConsumedKeyPackageTrusted(bytes, userId, impl, store.pinOrVerifyAik, copyBytes))
      .rejects.toMatchObject({ name: 'KeyPackageUntrustedError', reason: 'crosssig' });
  });

  it('throws (bad_signature) when the KeyPackage self-signature is tampered', async () => {
    const impl = await getImpl();
    const userId = randomUUID();
    const aik = nacl.sign.keyPair();
    const bytes = await mintKeyPackage(userId, randomUUID(), aik);
    // Flip a trailing byte: the KeyPackage signature is at the end of the encoding,
    // so this corrupts the self-signature without disturbing the leaf credential.
    const tampered = copyBytes(bytes);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(assertConsumedKeyPackageTrusted(tampered, userId, impl, store.pinOrVerifyAik, copyBytes))
      .rejects.toMatchObject({ name: 'KeyPackageUntrustedError', reason: 'bad_signature' });
  });

  it('throws (malformed) for undecodable KeyPackage bytes', async () => {
    const impl = await getImpl();
    const userId = randomUUID();
    await expect(assertConsumedKeyPackageTrusted(new Uint8Array([1, 2, 3]), userId, impl, store.pinOrVerifyAik, copyBytes))
      .rejects.toBeInstanceOf(KeyPackageUntrustedError);
  });
});
