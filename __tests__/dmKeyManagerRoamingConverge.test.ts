// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Converge-on-rotate: the roaming-identity rotation re-cross-signs this device's MLS
 * credential and republishes its KeyPackages under the NEW AIK.
 *
 * Root cause of the DM "encryption still loading" wedge: a roaming-identity
 * rotation mints a fresh Ed25519 AIK and writes it to the DmKeyBundle.signingPublicKey
 * column, but the device's MLS credential + already-published KeyPackages stay
 * cross-signed under the OLD AIK. The publish gate pins each KeyPackage's embedded AIK
 * to the column, so every package mismatches the new column, the pool drains, and
 * GET /mls/keypackages 404s account-wide.
 *
 * The fix makes _rotateRoamingIdentityImpl converge after a successful publish: null
 * the credential, persist a leaf-only record, and re-cross-sign + republish under the
 * new AIK. This test drives the rotation via resumePendingRotation (Self mode) and
 * asserts the credential is rebuilt with the rotated AIK and KeyPackages republished.
 *
 * Harness mirrors dmKeyManagerLegacyCredentialHeal.test.ts (MLS leaf mocks active so
 * MLS genuinely provisions), plus the move-to-Private rotation exports.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { fromBase64, toBase64 } from '../services/cryptoHelpers';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

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
    mlsClient: { publishKeyPackages: vi.fn() },
    mlsGroupStore: {
      setAtRestKey: vi.fn(),
      getAtRestKey: vi.fn((): CryptoKey | null => null),
      setHistoryKey: vi.fn(),
      getHistoryKey: vi.fn((): CryptoKey | null => null),
      putKpPrivate: vi.fn(),
      putIdentity: vi.fn(() => Promise.resolve()),
      getIdentity: vi.fn((): Promise<unknown | null> => Promise.resolve(null)),
      deleteIdentity: vi.fn(() => Promise.resolve()),
      deleteAllKpPrivate: vi.fn(() => Promise.resolve()),
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
      updateDmKeysRoamingIdentity: vi.fn(),
      getAikChain: vi.fn(async () => ({ chain: [], head: null })),
    },
  };
});

vi.mock('../services/mls/mlsIdentity', () => identity);
vi.mock('../services/mls/mlsClient', () => mlsClient);
vi.mock('../services/mls/mlsGroupStore', () => mlsGroupStore);
vi.mock('../services/mls/mlsCoordinator', () => coordinator);
vi.mock('../services/api', () => ({ apiClient }));
// The rotation paths touch the history syncer + lease; mock both.
vi.mock('../services/mls/mlsHistoryArchiveSync', () => ({
  startHistorySync: vi.fn(),
  drainHistoryNow: vi.fn(),
  stopHistorySync: vi.fn(),
}));
vi.mock('../services/mls/mlsHistoryLocks', () => ({
  hasHistorySyncLease: vi.fn(() => true),
}));

import {
  setup, resumePendingRotation, getPublicKey, isUnlocked,
  __test_setPendingIdentityRotation, __test_pendingIdentityRotation,
  setVoiceSessionActiveProbe,
} from '../services/dmKeyManager';

const PASSWORD = 'correct horse battery staple';
const USER_ID = '11111111-1111-4111-8111-111111111111'; // UUID: the AIK rotation link signs over it
const MLS_SIG_PUB = new Uint8Array([10, 11, 12, 13]);
const MLS_SIG_PRIV = new Uint8Array([20, 21, 22, 23, 24, 25]);

beforeEach(() => {
  vi.clearAllMocks();
  __test_setPendingIdentityRotation(null);
  setVoiceSessionActiveProbe(null);

  identity.mintLeafKeypair.mockResolvedValue({
    signKey: new Uint8Array(MLS_SIG_PRIV),
    publicKey: new Uint8Array(MLS_SIG_PUB),
  });
  // Embed the AIK (4th arg) so a re-cross-signed credential carries the rotated AIK.
  identity.buildCrossSignedCredentialIdentity.mockImplementation(
    (userId: string, deviceId: string, _leaf: Uint8Array, aikPub: Uint8Array) =>
      new TextEncoder().encode(`${userId}:${deviceId}:${toBase64(aikPub)}`),
  );
  identity.decodeMlsCredentialIdentity.mockImplementation((bytes: Uint8Array) => {
    const [userId, deviceId, aikB64] = new TextDecoder().decode(bytes).split(':');
    const aikPub = aikB64 ? fromBase64(aikB64) : new Uint8Array(32);
    return { version: 2, userId, deviceId, aikPub, crossSig: new Uint8Array(64) };
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

/** Run a real setup() (MLS active via mocks) and return the uploaded bundle. */
async function doSetup(): Promise<{ publicKey: string; signingPublicKey: string }> {
  apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });
  (await import('../services/dmEncryption')).initializeEncryption(USER_ID);
  await setup(PASSWORD, USER_ID);
  expect(isUnlocked()).toBe(true);
  const uploaded = apiClient.setupDmKeys.mock.calls[0][0] as { publicKey: string; signingPublicKey: string };
  return uploaded;
}

describe('dmKeyManager: roaming-identity rotation converges the MLS credential onto the new AIK', () => {
  it('re-cross-signs + republishes KeyPackages under the rotated AIK after a Self-mode rotation', async () => {
    const uploaded = await doSetup();
    const oldPub = getPublicKey();
    expect(oldPub).toBe(uploaded.publicKey);
    const oldAik = uploaded.signingPublicKey;

    // Capture the rotation publish (the ONLY write that swaps the durable AIK column).
    let idArgs: { publicKey: string; signingPublicKey: string; encryptedBlob: string; blobVersion: number } | undefined;
    apiClient.updateDmKeysRoamingIdentity.mockImplementation(async (a: typeof idArgs) => {
      idArgs = a;
      return { blobVersion: 5 };
    });

    // Count ONLY the convergence's MLS calls (setup already minted + published once).
    identity.buildCrossSignedCredentialIdentity.mockClear();
    mlsGroupStore.putIdentity.mockClear();
    mlsClient.publishKeyPackages.mockClear();

    // Arm + run the rotation (Self mode, not in a voice session).
    setVoiceSessionActiveProbe(() => false);
    __test_setPendingIdentityRotation(USER_ID);
    await resumePendingRotation(USER_ID);

    // The rotation published a NEW identity (new X25519 + new Ed25519 AIK).
    expect(apiClient.updateDmKeysRoamingIdentity).toHaveBeenCalledTimes(1);
    expect(idArgs).toBeDefined();
    expect(idArgs!.signingPublicKey).not.toBe(oldAik);
    expect(getPublicKey()).toBe(idArgs!.publicKey);

    // Convergence: the credential was re-cross-signed exactly once, under the NEW AIK
    // (matching the just-published signingPublicKey), NOT the old one.
    expect(identity.buildCrossSignedCredentialIdentity).toHaveBeenCalledTimes(1);
    const buildCall = identity.buildCrossSignedCredentialIdentity.mock.calls[0];
    expect(toBase64(buildCall[3] as Uint8Array)).toBe(idArgs!.signingPublicKey);
    expect(toBase64(buildCall[3] as Uint8Array)).not.toBe(oldAik);

    // KeyPackages republished under the new AIK so the pool is not drained.
    expect(mlsClient.publishKeyPackages).toHaveBeenCalled();

    // The re-cross-signed (full, non-empty) credential was persisted device-local under
    // the new AIK; on the happy path NO leaf-only reset occurs.
    const persistedCreds = mlsGroupStore.putIdentity.mock.calls.map(
      (c) => (c as unknown[])[4] as Uint8Array | undefined,
    );
    expect(persistedCreds.some((cred) => cred !== undefined && cred.length > 0)).toBe(true);
    expect(persistedCreds.some((cred) => cred !== undefined && cred.length === 0)).toBe(false);

    // Pending flag cleared on success.
    expect(__test_pendingIdentityRotation()).toBeNull();
  }, 30000);

  it('a republish failure resets the device-local identity to leaf-only (so the next unlock republishes) without breaking the rotation', async () => {
    const uploaded = await doSetup();

    // crossSignAndPublishLocalIdentity persists the re-cross-signed credential BEFORE the
    // network republish. If the republish throws (offline / transient), the convergence
    // must (a) NOT reject out of the rotation, (b) still clear the pending flag, and
    // (c) RESET the device-local record to leaf-only — otherwise the next unlock would
    // adopt the valid-but-unpublished credential (its AIK already matches the blob, so the
    // divergence heal never fires) and never retry the republish.
    mlsClient.publishKeyPackages.mockRejectedValue(new Error('publish boom'));
    apiClient.updateDmKeysRoamingIdentity.mockResolvedValue({ blobVersion: 5 });

    setVoiceSessionActiveProbe(() => false);
    __test_setPendingIdentityRotation(USER_ID);

    await expect(resumePendingRotation(USER_ID)).resolves.toBeUndefined();
    expect(apiClient.updateDmKeysRoamingIdentity).toHaveBeenCalledTimes(1);
    expect(__test_pendingIdentityRotation()).toBeNull();
    expect(getPublicKey()).not.toBe(uploaded.publicKey); // identity rotated

    // The failure path reset the device-local credential to leaf-only (empty) so the next
    // unlock's null-credential path re-cross-signs + republishes the full batch.
    const leafOnlyReset = mlsGroupStore.putIdentity.mock.calls.find(
      (c) => ((c as unknown[])[4] as Uint8Array | undefined)?.length === 0,
    );
    expect(leafOnlyReset).toBeDefined();
  }, 30000);
});
