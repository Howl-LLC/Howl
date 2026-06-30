// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import {
  generateKeyPackage,
  defaultCapabilities,
  decodeMlsMessage,
  type Credential,
  type Lifetime,
} from 'ts-mls';
import { encodeKeyPackage, makeKeyPackageRef } from 'ts-mls/keyPackage.js';
import { getImpl } from '../../services/mls/ciphersuite';
import { buildCrossSignedCredentialIdentity } from '../../services/mls/mlsIdentity';
import {
  createGroup,
  addMember,
  joinFromWelcome,
  encryptApp,
  decryptApp,
  encodeState,
  decodeState,
  makeGroupInfo,
  exportSecret,
  selfUpdate,
  processHandshake,
  currentEpoch,
  SFRAME_EXPORTER_LABEL,
  SFRAME_BASE_KEY_LEN,
  type MlsIdentity,
  type KeyPackageCandidate,
} from '../../services/mls/mlsEngine';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const realLifetime = (): Lifetime => ({
  notBefore: 0n,
  notAfter: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30),
});

// Ephemeral test AIK (Ed25519). The structural validator only decodes the v2 struct
// (cross-sig enforcement is handled separately), so cross-signing over a stand-in leaf
// key yields a well-formed 169-byte credential.
const testAik = nacl.sign.keyPair();
const v2Identity = (userId: string, deviceId: string): Uint8Array =>
  buildCrossSignedCredentialIdentity(userId, deviceId, testAik.publicKey, testAik.publicKey, testAik.secretKey);

async function makeIdentity(userId: string, deviceId: string): Promise<MlsIdentity> {
  const impl = await getImpl();
  const credential: Credential = {
    credentialType: 'basic',
    identity: v2Identity(userId, deviceId),
  };
  const { publicPackage, privatePackage } = await generateKeyPackage(
    credential, defaultCapabilities(), realLifetime(), [], impl,
  );
  return {
    signaturePublicKey: publicPackage.leafNode.signaturePublicKey,
    signaturePrivateKey: privatePackage.signaturePrivateKey,
    credentialIdentity: credential.identity,
  };
}

async function makeCandidate(userId: string, deviceId: string): Promise<KeyPackageCandidate> {
  const impl = await getImpl();
  const credential: Credential = {
    credentialType: 'basic',
    identity: v2Identity(userId, deviceId),
  };
  const { publicPackage, privatePackage } = await generateKeyPackage(
    credential, defaultCapabilities(), realLifetime(), [], impl,
  );
  const keyPackageBytes = encodeKeyPackage(publicPackage);
  const ref = await makeKeyPackageRef(publicPackage, impl.hash);
  const privateKeyPackage = new TextEncoder().encode(
    JSON.stringify({
      initPrivateKey: Buffer.from(privatePackage.initPrivateKey).toString('base64'),
      hpkePrivateKey: Buffer.from(privatePackage.hpkePrivateKey).toString('base64'),
      signaturePrivateKey: Buffer.from(privatePackage.signaturePrivateKey).toString('base64'),
      keyPackage: Buffer.from(keyPackageBytes).toString('base64'),
    }),
  );
  return {
    keyPackageRef: Buffer.from(ref).toString('base64'),
    keyPackage: new Uint8Array(keyPackageBytes),
    privateKeyPackage,
    isLastResort: false,
  };
}

describe('mlsEngine serialization + exporter', () => {
  it('encode -> decode round-trip preserves the ability to decrypt', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    let aliceState = await createGroup(alice, randomUUID());
    const bob = await makeCandidate(randomUUID(), randomUUID());
    const added = await addMember(aliceState, bob.keyPackage);
    aliceState = added.newState;
    const bobState = (await joinFromWelcome(added.welcome, [bob])).state;

    // Snapshot Bob, restore, and confirm the restored state decrypts Alice's message.
    const snapshot = encodeState(bobState);
    expect(snapshot).toBeInstanceOf(Uint8Array);
    expect(snapshot.length).toBeGreaterThan(0);
    const restoredBob = decodeState(snapshot);

    const enc = await encryptApp(aliceState, new TextEncoder().encode('survives reload'));
    const dec = await decryptApp(restoredBob, enc.privateMessage);
    expect(new TextDecoder().decode(dec.plaintext)).toBe('survives reload');
  });

  it('decoded state carries a usable clientConfig (authService present)', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    const aliceState = await createGroup(alice, randomUUID());
    const restored = decodeState(encodeState(aliceState));
    expect(restored.clientConfig).toBeDefined();
    expect(restored.clientConfig.authService).toBeDefined();
    expect(restored.clientConfig.keyRetentionConfig).toBeDefined();
  });

  it('clientConfig carries the explicit key-retention bound, reattached on decode', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    const state = await createGroup(alice, randomUUID());
    const restored = decodeState(encodeState(state));
    const krc = restored.clientConfig.keyRetentionConfig;
    expect(krc.retainKeysForGenerations).toBe(10);
    expect(krc.retainKeysForEpochs).toBe(4);
    expect(krc.maximumForwardRatchetSteps).toBe(200);
  });

  it('exportSecret is deterministic for a fixed epoch and returns the requested length', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    const aliceState = await createGroup(alice, randomUUID());
    const ctx = new TextEncoder().encode('howl-call');
    const a = await exportSecret(aliceState, 'howl-sframe', ctx, 32);
    const b = await exportSecret(aliceState, 'howl-sframe', ctx, 32);
    expect(a.length).toBe(32);
    expect(Array.from(a)).toEqual(Array.from(b));
    // A different label yields different bytes.
    const c = await exportSecret(aliceState, 'other-label', ctx, 32);
    expect(Array.from(c)).not.toEqual(Array.from(a));
    // A different length is honored.
    const d = await exportSecret(aliceState, 'howl-sframe', ctx, 16);
    expect(d.length).toBe(16);
  });

  it('two members derive an identical SFrame base key at the same epoch, and it rotates on Commit', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    let aliceState = await createGroup(alice, randomUUID());
    const bob = await makeCandidate(randomUUID(), randomUUID());
    const added = await addMember(aliceState, bob.keyPackage);
    aliceState = added.newState;
    let bobState = (await joinFromWelcome(added.welcome, [bob])).state;
    expect(currentEpoch(aliceState)).toBe(currentEpoch(bobState));

    // Pin the wire-interop literals: any drift silently breaks SFrame
    // cross-implementation agreement (RFC 9605 5.2).
    expect(SFRAME_EXPORTER_LABEL).toBe('SFrame 1.0 Base Key');
    expect(SFRAME_BASE_KEY_LEN).toBe(32);

    const ctx = new Uint8Array(0); // RFC 9605 5.2: empty context, epoch implicitly bound
    const a1 = await exportSecret(aliceState, SFRAME_EXPORTER_LABEL, ctx, SFRAME_BASE_KEY_LEN);
    const b1 = await exportSecret(bobState, SFRAME_EXPORTER_LABEL, ctx, SFRAME_BASE_KEY_LEN);
    expect(a1.length).toBe(32);
    expect(Array.from(a1)).toEqual(Array.from(b1)); // agreement: same epoch, same key

    // Commit (Bob self-update) advances the epoch on both sides.
    const upd = await selfUpdate(bobState);
    bobState = upd.newState;
    aliceState = await processHandshake(aliceState, upd.commit);
    expect(currentEpoch(aliceState)).toBe(currentEpoch(bobState));

    const a2 = await exportSecret(aliceState, SFRAME_EXPORTER_LABEL, ctx, SFRAME_BASE_KEY_LEN);
    const b2 = await exportSecret(bobState, SFRAME_EXPORTER_LABEL, ctx, SFRAME_BASE_KEY_LEN);
    expect(Array.from(a2)).toEqual(Array.from(b2)); // agreement at the new epoch
    expect(Array.from(a2)).not.toEqual(Array.from(a1)); // FS: key rotates with the epoch
  });

  it('makeGroupInfo produces bytes that decode as a GroupInfo message', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    const aliceState = await createGroup(alice, randomUUID());
    const gi = await makeGroupInfo(aliceState);
    expect(gi).toBeInstanceOf(Uint8Array);
    const decoded = decodeMlsMessage(new Uint8Array(gi), 0);
    expect(decoded).not.toBeUndefined();
    expect(decoded![0].wireformat).toBe('mls_group_info');
  });
});
