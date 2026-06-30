// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Per-device identity: the roaming password/recovery blob must NO
 * LONGER carry the MLS identity (deviceId + Ed25519 signing keypair + credential).
 *
 * Root cause of the multi-device leaf COLLISION: buildBlobContents() stamped the
 * MLS identity into the blob, so a second device that unlocked the same account
 * decrypted a blob carrying the FIRST device's deviceId + signing key and reused
 * it — two devices sharing one MLS leaf. Removing the stamp makes each device
 * mint a distinct identity (now held device-local in mlsGroupStore).
 *
 * This drives a real setup(), captures the encryptedBlob dmKeyManager uploads via
 * apiClient.setupDmKeys, re-derives the blob key from the captured salt/password
 * (deriveUnlockMaterial — the same single-Argon2id path setup uses), decrypts it
 * with the captured public-key AAD, and asserts the decoded contents carry NO MLS
 * material but DO still carry the legacy X25519 privateKey.
 *
 * Harness (mocks, WebCrypto polyfill, fake-indexeddb, setupDmKeys capture) is
 * copied from dmKeyManagerMlsUnlock.test.ts.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

// jsdom does not ship WebCrypto; pull Node's webcrypto so the real dmCrypto
// blob/Argon2 path runs and crypto.randomUUID() exists for the minted deviceId.
beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

// Mock the MLS leaf modules + network (real dmCrypto stays unmocked)
const { identity, mlsClient, mlsGroupStore, coordinator, apiClient } = vi.hoisted(() => {
  const listeners = new Set<(e: 'mls-ready' | 'mls-locked') => void>();
  const mlsEvents = { on(cb: (e: 'mls-ready' | 'mls-locked') => void) { listeners.add(cb); return () => listeners.delete(cb); } };
  return {
    identity: {
      mintLeafKeypair: vi.fn(),
      buildCrossSignedCredentialIdentity: vi.fn(),
      decodeMlsCredentialIdentity: vi.fn(),
      generateKeyPackages: vi.fn(),
      KEYPACKAGE_BATCH_SIZE: 20,
    },
    mlsClient: {
      publishKeyPackages: vi.fn(),
    },
    mlsGroupStore: {
      setAtRestKey: vi.fn(),
      getAtRestKey: vi.fn((): CryptoKey | null => null),
      setHistoryKey: vi.fn(),
      getHistoryKey: vi.fn((): CryptoKey | null => null),
      putKpPrivate: vi.fn(),
      putIdentity: vi.fn(() => Promise.resolve()),
      getIdentity: vi.fn(() => Promise.resolve(null)),
      clearHistory: vi.fn(() => Promise.resolve()),
      rekeyAtRestStores: vi.fn(() => Promise.resolve()),
    },
    coordinator: {
      activate: vi.fn(),
      rekey: vi.fn(() => Promise.resolve()),
      deactivate: vi.fn(),
      reconcileChannelClassifications: vi.fn(),
      mlsEvents,
    },
    apiClient: {
      setupDmKeys: vi.fn(),
      getDmKeyBundle: vi.fn(),
      getPendingKeyDeliveries: vi.fn(),
      updateDmKeysSigningKey: vi.fn(),
      recoverDmKeys: vi.fn(),
    },
  };
});

vi.mock('../services/mls/mlsIdentity', () => identity);
vi.mock('../services/mls/mlsClient', () => mlsClient);
vi.mock('../services/mls/mlsGroupStore', () => mlsGroupStore);
vi.mock('../services/mls/mlsCoordinator', () => coordinator);
vi.mock('../services/api', () => ({ apiClient }));

import { setup } from '../services/dmKeyManager';
// Real crypto helpers — re-derive the blob key the same way setup() does and
// decode base64 so the test reads exactly what setup() wrote.
import { deriveUnlockMaterial, type BlobContents } from '../services/dmCrypto';
import { fromBase64, toArrayBuffer } from '../services/cryptoHelpers';

const PASSWORD = 'correct horse battery staple';
const USER_ID = 'user-alice';

const MLS_SIG_PUB = new Uint8Array([10, 11, 12, 13]);
const MLS_SIG_PRIV = new Uint8Array([20, 21, 22, 23, 24, 25]);

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.indexedDB = new IDBFactory();

  // Two-phase: boot mints a leaf-only keypair; setup cross-signs + publishes.
  identity.mintLeafKeypair.mockResolvedValue({
    signKey: new Uint8Array(MLS_SIG_PRIV),
    publicKey: new Uint8Array(MLS_SIG_PUB),
  });
  identity.buildCrossSignedCredentialIdentity.mockImplementation(
    (userId: string, deviceId: string) => new TextEncoder().encode(`${userId}:${deviceId}`),
  );
  identity.decodeMlsCredentialIdentity.mockImplementation((bytes: Uint8Array) => {
    const [userId, deviceId] = new TextDecoder().decode(bytes).split(':');
    return { version: 2, userId, deviceId, aikPub: new Uint8Array(32), crossSig: new Uint8Array(64) };
  });

  identity.generateKeyPackages.mockResolvedValue([
    { keyPackage: new Uint8Array([1, 2, 3]), keyPackageRef: new Uint8Array([9, 9]), privateKeyPackage: new Uint8Array([4, 5, 6]), isLastResort: false },
  ]);
  mlsClient.publishKeyPackages.mockResolvedValue({ published: 1, remaining: 1 });
  mlsGroupStore.putKpPrivate.mockResolvedValue(undefined);
  mlsGroupStore.putIdentity.mockResolvedValue(undefined);
  mlsGroupStore.getIdentity.mockResolvedValue(null);
  coordinator.activate.mockResolvedValue(undefined);
  coordinator.reconcileChannelClassifications.mockResolvedValue(undefined);

  let _heldKey: CryptoKey | null = null;
  mlsGroupStore.setAtRestKey.mockImplementation((k: CryptoKey | null) => { _heldKey = k; });
  mlsGroupStore.getAtRestKey.mockImplementation(() => _heldKey);
  let _heldHistoryKey: CryptoKey | null = null;
  mlsGroupStore.setHistoryKey.mockImplementation((k: CryptoKey | null) => { _heldHistoryKey = k; });
  mlsGroupStore.getHistoryKey.mockImplementation(() => _heldHistoryKey);

  apiClient.getPendingKeyDeliveries.mockResolvedValue([]);
});

/**
 * Replicates dmKeyManager's decryptBlobPacked: base64(12-byte IV || AES-GCM ct),
 * AES-256-GCM under the derived blob key, AAD = 'howl:blob:' + uploaded publicKey.
 */
async function decryptUploadedBlob(encryptedBlob: string, key: CryptoKey, aad: string): Promise<BlobContents> {
  const combined = fromBase64(encryptedBlob);
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: new TextEncoder().encode(aad) },
    key,
    toArrayBuffer(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

/** Run a real setup() and return the decoded contents of the blob it uploaded. */
async function setupAndDecodeUploadedBlob(): Promise<BlobContents> {
  apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });

  await setup(PASSWORD, USER_ID);

  // Sanity: setup() actually minted + cross-signed an MLS identity on this run. If
  // it didn't, the "no MLS material" assertion would pass vacuously (an empty MLS
  // path), which would NOT prove the stamp was removed.
  expect(identity.mintLeafKeypair).toHaveBeenCalledTimes(1);
  expect(identity.buildCrossSignedCredentialIdentity).toHaveBeenCalledTimes(1);

  const uploaded = apiClient.setupDmKeys.mock.calls[0][0] as {
    publicKey: string;
    encryptedBlob: string;
    blobSalt: string;
  };

  const { blobKey } = await deriveUnlockMaterial(PASSWORD, fromBase64(uploaded.blobSalt));
  return decryptUploadedBlob(uploaded.encryptedBlob, blobKey, 'howl:blob:' + uploaded.publicKey);
}

describe('dmKeyManager — blob carries no MLS material', () => {
  it('a freshly built/uploaded blob contains no mlsIdentity / deviceId / blobFormatVersion', async () => {
    const decoded = await setupAndDecodeUploadedBlob();

    expect(decoded).not.toHaveProperty('mlsIdentity');
    expect(decoded).not.toHaveProperty('deviceId');
    expect(decoded).not.toHaveProperty('blobFormatVersion');
    // Legacy X25519 secret key still roams in the blob — only the MLS identity moved.
    expect(decoded).toHaveProperty('privateKey');
  });
});
