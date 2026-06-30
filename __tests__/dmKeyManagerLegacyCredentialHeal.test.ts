// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Legacy MLS-credential self-heal on unlock.
 *
 * A device whose device-local `identity` row holds a PRE-v2 credential (the old
 * `utf8(`${userId}:${deviceId}`)` form, not the 169-byte AIK-cross-signed v2
 * struct) silently wedged MLS: loadOrMintLocalIdentity adopted the legacy buffer
 * because its length was truthy, so the leaf-only heal guard never fired,
 * currentMlsBundle()'s strict v2 decode threw into a bare catch -> null, and
 * activate() was never called ("Secure messaging is locked").
 *
 * The fix treats an UNDECODABLE stored credential as leaf-only (null) so the
 * existing first-unlock cross-sign path rebuilds a v2 credential under the SAME
 * deviceId + signing key, republishes KeyPackages, and activates MLS. A valid v2
 * credential is left untouched (no needless republish).
 *
 * Harness (mocks, WebCrypto polyfill, setup/lock/unlock round-trip) is modeled on
 * dmKeyManagerMlsUnlock.test.ts. The one material difference: decodeMlsCredential-
 * Identity THROWS for the seeded legacy credential (mirroring the real strict
 * decode) and succeeds for the v2-shaped `${userId}:${deviceId}` mock credentials.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

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
      getIdentity: vi.fn((): Promise<{
        userId: string; deviceId: string;
        signaturePublicKey: Uint8Array; signaturePrivateKey: Uint8Array; credentialIdentity: Uint8Array;
      } | null> => Promise.resolve(null)),
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

import { setup, unlock, lock, isUnlocked } from '../services/dmKeyManager';
import { fromBase64, toBase64 } from '../services/cryptoHelpers';

const PASSWORD = 'correct horse battery staple';
const USER_ID = 'user-alice';

const MLS_SIG_PUB = new Uint8Array([10, 11, 12, 13]);
const MLS_SIG_PRIV = new Uint8Array([20, 21, 22, 23, 24, 25]);

// The seeded device-local credential: a pre-v2 legacy buffer that the strict v2
// decode rejects. Non-empty (truthy length) so it reproduces the wedge — the old
// code adopted any non-empty buffer.
const LEGACY_CRED = new TextEncoder().encode('legacy-pre-v2-credential');

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

beforeEach(() => {
  vi.clearAllMocks();

  identity.mintLeafKeypair.mockResolvedValue({
    signKey: new Uint8Array(MLS_SIG_PRIV),
    publicKey: new Uint8Array(MLS_SIG_PUB),
  });
  identity.buildCrossSignedCredentialIdentity.mockImplementation(
    (userId: string, deviceId: string) => new TextEncoder().encode(`${userId}:${deviceId}`),
  );
  // Decode like the real strict codec FOR THE INPUT UNDER TEST: the legacy seed
  // throws (mirroring the 169-byte length check). Everything else decodes (the
  // `${userId}:${deviceId}` v2 mock form), matching the permissive behaviour of the
  // proven dmKeyManagerMlsUnlock harness so transient/zeroized intermediate buffers
  // (which the product never feeds the gate) don't spuriously throw.
  // The v2 mock credential is `${userId}:${deviceId}[:${base64 aikPub}]`. An optional
  // 3rd `:`-part carries the embedded AIK so the AIK-divergence heal can be exercised;
  // when absent (the buildCrossSignedCredentialIdentity mock omits it) the AIK is zeros.
  identity.decodeMlsCredentialIdentity.mockImplementation((bytes: Uint8Array) => {
    if (bytesEqual(bytes, LEGACY_CRED)) {
      throw new Error('decodeMlsCredentialIdentity: unexpected length');
    }
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

/**
 * Run a real setup() to obtain a genuine v2 blob, capture it, lock(), then serve
 * the captured bundle back and unlock(). Clears setup()'s MLS calls so assertions
 * observe only unlock's behavior. The seeded device-local identity (getIdentity)
 * is what unlock loads.
 */
async function setupCaptureLockThenUnlock(
  seedIdentity?: (blobAikB64: string) => void,
): Promise<void> {
  apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });
  await setup(PASSWORD, USER_ID);

  const uploaded = apiClient.setupDmKeys.mock.calls[0][0] as {
    publicKey: string; signingPublicKey: string; encryptedBlob: string; blobSalt: string;
  };

  lock();
  expect(isUnlocked()).toBe(false);
  mlsGroupStore.putIdentity.mockClear();
  mlsClient.publishKeyPackages.mockClear();
  coordinator.activate.mockClear();
  identity.mintLeafKeypair.mockClear();
  identity.buildCrossSignedCredentialIdentity.mockClear();

  // Tests exercising the v2 LOAD path seed the device-local identity AFTER setup (which
  // itself reads getIdentity to mint), keying the seeded credential's embedded AIK off
  // the blob AIK just uploaded — so a "matching" credential is genuinely in lockstep
  // with what unlock derives from the blob.
  if (seedIdentity) seedIdentity(uploaded.signingPublicKey);

  apiClient.getDmKeyBundle.mockResolvedValue({
    publicKey: uploaded.publicKey,
    encryptedBlob: uploaded.encryptedBlob,
    blobSalt: uploaded.blobSalt,
    blobVersion: 1,
    passwordDerived: false,
  });

  (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

  await expect(unlock(PASSWORD)).resolves.toBeUndefined();
  expect(isUnlocked()).toBe(true);
}

describe('dmKeyManager: legacy MLS-credential self-heal on unlock', () => {
  it('re-cross-signs + republishes + activates when the stored credential is an undecodable pre-v2 buffer', async () => {
    // Device-local identity holds a LEGACY (undecodable) credential under the SAME
    // signing key + deviceId. This is the wedge: the old code adopted it and never
    // activated MLS.
    mlsGroupStore.getIdentity.mockResolvedValue({
      userId: USER_ID, deviceId: 'dev-legacy',
      signaturePublicKey: new Uint8Array([1, 2, 3]),
      signaturePrivateKey: new Uint8Array([4, 5, 6]),
      credentialIdentity: LEGACY_CRED,
    });

    await setupCaptureLockThenUnlock();

    // Heal: the leaf-only cross-sign path runs, rebuilding a v2 credential under the
    // SAME deviceId + signing key and republishing this device's KeyPackages.
    expect(identity.buildCrossSignedCredentialIdentity).toHaveBeenCalledTimes(1);
    expect(identity.buildCrossSignedCredentialIdentity.mock.calls[0][1]).toBe('dev-legacy'); // same deviceId
    expect(mlsGroupStore.putIdentity).toHaveBeenCalled();
    expect(mlsClient.publishKeyPackages).toHaveBeenCalled();
    // The wedge is gone: MLS activated, and with the HEALED v2 credential (not the
    // legacy buffer) — proven by the activate bundle decoding to v2.
    expect(coordinator.activate).toHaveBeenCalledTimes(1);
    const bundle = coordinator.activate.mock.calls[0][0];
    expect(bundle.deviceId).toBe('dev-legacy');
    expect(new TextDecoder().decode(bundle.identity.credentialIdentity)).toBe(`${USER_ID}:dev-legacy`);
  }, 30000);

  it('leaves a valid v2 credential whose embedded AIK matches the blob untouched: no re-cross-sign, no republish', async () => {
    await setupCaptureLockThenUnlock((blobAik) => {
      mlsGroupStore.getIdentity.mockResolvedValue({
        userId: USER_ID, deviceId: 'dev-v2',
        signaturePublicKey: new Uint8Array([1, 2, 3]),
        signaturePrivateKey: new Uint8Array([4, 5, 6]),
        // Decodable v2 with the embedded AIK EQUAL to the account AIK in the blob.
        credentialIdentity: new TextEncoder().encode(`${USER_ID}:dev-v2:${blobAik}`),
      });
    });

    expect(identity.buildCrossSignedCredentialIdentity).not.toHaveBeenCalled();
    expect(mlsGroupStore.putIdentity).not.toHaveBeenCalled();
    expect(mlsClient.publishKeyPackages).not.toHaveBeenCalled();
    // Already-decodable, AIK-matching identity still activates MLS (it was never wedged).
    expect(coordinator.activate).toHaveBeenCalledTimes(1);
  }, 30000);

  it('re-cross-signs + republishes + activates when a valid v2 credential embeds a STALE AIK (roaming-rotation poison)', async () => {
    // The roaming-identity incident: a rotation swapped the account AIK (+ the
    // signingPublicKey column) but left this device's credential cross-signed under the
    // OLD AIK. The credential is a well-formed v2 struct, so the undecodable-heal does
    // NOT fire — only the AIK-divergence heal catches it. Without it, every published
    // KeyPackage embeds the stale AIK, the publish gate rejects them, and DMs wedge with
    // "encryption still loading".
    const STALE_AIK = toBase64(new Uint8Array(32).fill(0xaa)); // != the real blob AIK
    let blobAik = '';
    await setupCaptureLockThenUnlock((b) => {
      blobAik = b;
      mlsGroupStore.getIdentity.mockResolvedValue({
        userId: USER_ID, deviceId: 'dev-diverged',
        signaturePublicKey: new Uint8Array([1, 2, 3]),
        signaturePrivateKey: new Uint8Array([4, 5, 6]),
        credentialIdentity: new TextEncoder().encode(`${USER_ID}:dev-diverged:${STALE_AIK}`),
      });
    });

    // Heal: rebuild a v2 credential under the SAME deviceId + signing key, cross-signed
    // with the CURRENT blob AIK (not the stale one), and republish this device's KeyPackages.
    expect(identity.buildCrossSignedCredentialIdentity).toHaveBeenCalledTimes(1);
    const buildCall = identity.buildCrossSignedCredentialIdentity.mock.calls[0];
    expect(buildCall[1]).toBe('dev-diverged'); // same deviceId
    // The 4th arg is the AIK pub used to re-cross-sign: the CURRENT blob AIK, not the stale one.
    expect(toBase64(buildCall[3] as Uint8Array)).toBe(blobAik);
    expect(toBase64(buildCall[3] as Uint8Array)).not.toBe(STALE_AIK);
    expect(mlsGroupStore.putIdentity).toHaveBeenCalled();
    expect(mlsClient.publishKeyPackages).toHaveBeenCalled();
    // The wedge is gone: MLS activated with the healed credential under the new deviceId.
    expect(coordinator.activate).toHaveBeenCalledTimes(1);
    const bundle = coordinator.activate.mock.calls[0][0];
    expect(bundle.deviceId).toBe('dev-diverged');
  }, 30000);
});
