// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Real validateCredential: cross-sig verify + TOFU-pinned-AIK.
// Mirrors mlsEngine.test.ts's webcrypto shim + createGroup/addMember pattern,
// and mlsTrustStore.test.ts's fresh-IDBFactory-per-test setup (the real
// validator pins via the trust store, which lives in IndexedDB).
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import {
  generateKeyPackageWithKey,
  defaultCapabilities,
  type Credential,
  type Lifetime,
} from 'ts-mls';
import { getImpl } from '../../services/mls/ciphersuite';
import { buildCrossSignedCredentialIdentity, decodeMlsCredentialIdentity } from '../../services/mls/mlsIdentity';
import {
  createGroup,
  addMember,
  setCredentialValidator,
  type MlsIdentity,
} from '../../services/mls/mlsEngine';
import { verifyLeafCredential } from '../../services/mls/credentialTrust';
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

// Restore the engine's structural default so an installed real validator never
// leaks across tests (the engine holds it as module-level state).
const structuralDefault = (id: Uint8Array): boolean => {
  try {
    decodeMlsCredentialIdentity(id);
    return true;
  } catch {
    return false;
  }
};
afterEach(() => setCredentialValidator(structuralDefault));

const realLifetime = (): Lifetime => ({
  notBefore: 0n,
  notAfter: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30),
});

/**
 * The real validator under test: decode + cross-sig verify (verifyLeafCredential),
 * then TOFU-pin the embedded AIK via the trust store. Mirrors the activate()
 * closure in mlsCoordinatorCore.ts.
 */
function installRealValidator(): void {
  setCredentialValidator(async (credId: Uint8Array, leafPub: Uint8Array) => {
    const impl = await getImpl();
    const r = await verifyLeafCredential({ credentialIdentity: credId, leafSigningPublicKey: leafPub, impl });
    if (!r.ok || !r.userId || !r.aikPub) return false;
    let deviceId = '';
    try { deviceId = decodeMlsCredentialIdentity(credId).deviceId; } catch { /* rejected above */ }
    return store.pinOrVerifyAik(r.userId, r.aikPub, { deviceId, leafKey: leafPub });
  });
}

/**
 * Build an MLS identity whose v2 credential carries a REAL cross-sig: the leaf
 * signing keypair is minted first, then the supplied AIK cross-signs over that
 * leaf public key. Passing a `wrongAik` for the cross-sig (but a real `claimAik`
 * embedded) is NOT what we do — the credential always embeds the AIK that signed
 * it, so "wrong AIK" means the embedded AIK simply isn't the one we pinned/expect.
 */
async function makeIdentity(
  userId: string,
  deviceId: string,
  aik: nacl.SignKeyPair,
): Promise<MlsIdentity> {
  const impl = await getImpl();
  const { signKey, publicKey } = await impl.signature.keygen();
  const credentialIdentity = buildCrossSignedCredentialIdentity(
    userId, deviceId, publicKey, aik.publicKey, aik.secretKey,
  );
  const credential: Credential = { credentialType: 'basic', identity: credentialIdentity };
  // generateKeyPackageWithKey reuses the supplied signing key, so the MLS leaf's
  // signaturePublicKey === the key the AIK cross-signed (real cross-sig binds it).
  await generateKeyPackageWithKey(
    credential,
    defaultCapabilities(),
    realLifetime(),
    [],
    { signKey, publicKey },
    impl,
  );
  return {
    signaturePublicKey: publicKey,
    signaturePrivateKey: signKey,
    credentialIdentity,
  };
}

/** A join candidate (public KeyPackage bytes) carrying a real cross-sig over its leaf key. */
async function makeCandidate(
  userId: string,
  deviceId: string,
  aik: nacl.SignKeyPair,
): Promise<{ keyPackage: Uint8Array; credentialIdentity: Uint8Array }> {
  const impl = await getImpl();
  const { encodeKeyPackage } = await import('ts-mls/keyPackage.js');
  const { signKey, publicKey } = await impl.signature.keygen();
  const credentialIdentity = buildCrossSignedCredentialIdentity(
    userId, deviceId, publicKey, aik.publicKey, aik.secretKey,
  );
  const credential: Credential = { credentialType: 'basic', identity: credentialIdentity };
  const captured = new Uint8Array(credentialIdentity);
  const { publicPackage } = await generateKeyPackageWithKey(
    credential,
    defaultCapabilities(),
    realLifetime(),
    [],
    { signKey, publicKey },
    impl,
  );
  return { keyPackage: new Uint8Array(encodeKeyPackage(publicPackage)), credentialIdentity: captured };
}

describe('verifyLeafCredential (pure)', () => {
  it('accepts a valid cross-sig over the leaf signing key and returns the embedded aikPub', async () => {
    const impl = await getImpl();
    const aik = nacl.sign.keyPair();
    const { signKey: _s, publicKey: leafPub } = await impl.signature.keygen();
    const userId = randomUUID();
    const deviceId = randomUUID();
    const credId = buildCrossSignedCredentialIdentity(userId, deviceId, leafPub, aik.publicKey, aik.secretKey);
    const r = await verifyLeafCredential({ credentialIdentity: credId, leafSigningPublicKey: leafPub, impl });
    expect(r.ok).toBe(true);
    expect(r.userId).toBe(userId);
    expect(r.aikPub && Buffer.from(r.aikPub).toString('base64')).toBe(Buffer.from(aik.publicKey).toString('base64'));
  });

  it('rejects when the cross-sig is over a DIFFERENT leaf key (crosssig)', async () => {
    const impl = await getImpl();
    const aik = nacl.sign.keyPair();
    const { publicKey: signedLeaf } = await impl.signature.keygen();
    const { publicKey: otherLeaf } = await impl.signature.keygen();
    const credId = buildCrossSignedCredentialIdentity(randomUUID(), randomUUID(), signedLeaf, aik.publicKey, aik.secretKey);
    // Verify against a leaf key that the AIK did NOT sign.
    const r = await verifyLeafCredential({ credentialIdentity: credId, leafSigningPublicKey: otherLeaf, impl });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('crosssig');
  });

  it('rejects on userId mismatch when expectedUserId is supplied', async () => {
    const impl = await getImpl();
    const aik = nacl.sign.keyPair();
    const { publicKey: leafPub } = await impl.signature.keygen();
    const credId = buildCrossSignedCredentialIdentity(randomUUID(), randomUUID(), leafPub, aik.publicKey, aik.secretKey);
    const r = await verifyLeafCredential({ credentialIdentity: credId, leafSigningPublicKey: leafPub, impl, expectedUserId: randomUUID() });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('userid_mismatch');
  });

  it('rejects unparseable credential bytes (parse)', async () => {
    const impl = await getImpl();
    const r = await verifyLeafCredential({ credentialIdentity: new Uint8Array([1, 2, 3]), leafSigningPublicKey: new Uint8Array(32), impl });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('parse');
  });
});

describe('real validator at the add path (cross-sig + TOFU-pinned-AIK)', () => {
  it('(a) accepts a leaf with a valid cross-sig + first-sight AIK (add succeeds)', async () => {
    const aliceAik = nacl.sign.keyPair();
    const bobAik = nacl.sign.keyPair();
    const alice = await makeIdentity(randomUUID(), randomUUID(), aliceAik);
    const aliceState = await createGroup(alice, randomUUID());
    const bob = await makeCandidate(randomUUID(), randomUUID(), bobAik);

    installRealValidator();
    const added = await addMember(aliceState, bob.keyPackage);
    expect(added.welcome.length).toBeGreaterThan(0);
  });

  it('(b) rejects a leaf cross-signed by the WRONG AIK (addMember rejects)', async () => {
    const aliceAik = nacl.sign.keyPair();
    const alice = await makeIdentity(randomUUID(), randomUUID(), aliceAik);
    const aliceState = await createGroup(alice, randomUUID());

    // Build a candidate whose credential's cross-sig is made by an AIK that does
    // NOT match the leaf key embedded in the MLS KeyPackage: cross-sign over a
    // stand-in key (the AIK's own pub), so the cross-sig fails when verified over
    // the real MLS leaf signing key.
    const impl = await getImpl();
    const { encodeKeyPackage } = await import('ts-mls/keyPackage.js');
    const bobAik = nacl.sign.keyPair();
    const { signKey, publicKey: leafPub } = await impl.signature.keygen();
    // crossSig is over bobAik.publicKey, NOT over leafPub -> mismatch at verify.
    const badCredId = buildCrossSignedCredentialIdentity(randomUUID(), randomUUID(), bobAik.publicKey, bobAik.publicKey, bobAik.secretKey);
    const badCredential: Credential = { credentialType: 'basic', identity: badCredId };
    const { publicPackage } = await generateKeyPackageWithKey(
      badCredential, defaultCapabilities(), realLifetime(), [], { signKey, publicKey: leafPub }, impl,
    );
    const badKeyPackage = new Uint8Array(encodeKeyPackage(publicPackage));

    installRealValidator();
    await expect(addMember(aliceState, badKeyPackage)).rejects.toThrow();
  });

  it('(c) rejects a second leaf for a pinned userId carrying a DIFFERENT AIK', async () => {
    const aliceAik = nacl.sign.keyPair();
    const alice = await makeIdentity(randomUUID(), randomUUID(), aliceAik);
    const aliceState = await createGroup(alice, randomUUID());

    const bobUserId = randomUUID();
    const bobAik1 = nacl.sign.keyPair();
    const bobAik2 = nacl.sign.keyPair();
    // Device 1: first sight pins bobAik1 for bobUserId.
    const bobDev1 = await makeCandidate(bobUserId, randomUUID(), bobAik1);
    // Device 2: same userId but cross-signed by a DIFFERENT AIK -> must reject.
    const bobDev2 = await makeCandidate(bobUserId, randomUUID(), bobAik2);

    installRealValidator();
    const added1 = await addMember(aliceState, bobDev1.keyPackage);
    expect(added1.welcome.length).toBeGreaterThan(0);
    // bobAik1 is now pinned for bobUserId; a leaf with bobAik2 for the same user is rejected.
    await expect(addMember(added1.newState, bobDev2.keyPackage)).rejects.toThrow();
  });
});
