// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * COEXISTENCE round-trip for dmKeyManager.
 *
 * dmKeyManager now carries an MLS identity ALONGSIDE the legacy X25519/Ed25519
 * secrecy core. This test proves the coexistence contract end to end against the
 * REAL dmCrypto layer (real Argon2id fallback + real v2 blob encrypt/decrypt),
 * mocking only the MLS leaf modules and the network:
 *
 *  - setup(PASSWORD, USER_ID): mints the MLS identity (createIdentity), publishes
 *    the initial KeyPackage batch ONCE (publishKeyPackages), persists each private
 *    package via putKpPrivate (4-arg), sets the MLS at-rest key, and activates the
 *    coordinator. The uploaded blob is a v2 blob.
 *  - getPublicKey() returns the LEGACY X25519 key (group DMs + voice/stage depend
 *    on it); the NEW getMlsSignaturePublicKey() returns the MLS key.
 *  - lock(): deactivates the coordinator and clears the MLS state.
 *  - unlock(PASSWORD): round-trips the SAME legacy public key from the blob, and
 *    loads the MLS identity from the DEVICE-LOCAL store (per-device identity — the
 *    identity NO LONGER roams in the blob), then activates the coordinator with the
 *    deviceId + an at-rest CryptoKey. NO escrow blob carrying the MLS identity is
 *    uploaded.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

// jsdom does not ship WebCrypto — pull Node's webcrypto if missing (matches
// __tests__/dmCrypto.test.ts). Needed so the real dmCrypto blob/Argon2/HKDF path
// runs and so crypto.randomUUID() exists for the minted deviceId.
beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

// Mock the MLS leaf modules + network (real dmCrypto stays unmocked)
const { identity, mlsClient, mlsGroupStore, coordinator, apiClient } = vi.hoisted(() => ({
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
    getAtRestKey: vi.fn(() => null),
    setHistoryKey: vi.fn(),
    getHistoryKey: vi.fn(() => null),
    putKpPrivate: vi.fn(),
    putIdentity: vi.fn(() => Promise.resolve()),
    getIdentity: vi.fn((): Promise<{
      userId: string; deviceId: string;
      signaturePublicKey: Uint8Array; signaturePrivateKey: Uint8Array; credentialIdentity: Uint8Array;
    } | null> => Promise.resolve(null)),
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
    // dmKeyManager subscribes at module load (MLS auto-recovery); a no-op
    // emitter satisfies the access without driving any recovery in these tests.
    mlsEvents: { on: vi.fn(() => () => {}) },
  },
  apiClient: {
    setupDmKeys: vi.fn(),
    getDmKeyBundle: vi.fn(),
    getPendingKeyDeliveries: vi.fn(),
    updateDmKeysSigningKey: vi.fn(),
    enablePasswordDerived: vi.fn(),
    recoverDmKeys: vi.fn(),
  },
}));

vi.mock('../services/mls/mlsIdentity', () => identity);
vi.mock('../services/mls/mlsClient', () => mlsClient);
vi.mock('../services/mls/mlsGroupStore', () => mlsGroupStore);
vi.mock('../services/mls/mlsCoordinator', () => coordinator);
vi.mock('../services/api', () => ({ apiClient }));

import {
  setup,
  unlock,
  recover,
  lock,
  isUnlocked,
  getPublicKey,
  signVoiceJoinBlob,
  enablePasswordDerived,
} from '../services/dmKeyManager';
import { fromBase64 } from '../services/cryptoHelpers';

// The getMlsSignaturePublicKey/getMlsDeviceId accessors were removed. They
// mirrored currentMlsBundle(), the bundle handed to coordinator.activate(). The
// invariant they pinned (which MLS identity is installed/active) is re-expressed
// here via that activate() bundle - the surviving observable source of truth.
function activatedMlsSigPubB64(): string | undefined {
  const call = coordinator.activate.mock.calls.at(-1);
  return call ? b64(call[0].identity.signaturePublicKey as Uint8Array) : undefined;
}
function activatedMlsDeviceId(): string | undefined {
  const call = coordinator.activate.mock.calls.at(-1);
  return call ? (call[0].deviceId as string) : undefined;
}

const PASSWORD = 'correct horse battery staple';
const USER_ID = 'user-alice';

// Stable MLS identity bytes so unlock can assert the SAME identity round-trips.
const MLS_SIG_PUB = new Uint8Array([10, 11, 12, 13]);
const MLS_SIG_PRIV = new Uint8Array([20, 21, 22, 23, 24, 25]);

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

beforeEach(() => {
  vi.clearAllMocks();

  // Two-phase: boot mints a leaf-only keypair (no credential, no publish); the
  // cross-sign + publish happens at unlock/setup via buildCrossSignedCredentialIdentity.
  // Return FRESH copies each call: dmKeyManager.lock()/clearMlsState() zeroizes the
  // stored identity bytes in place, which would otherwise corrupt these shared
  // constants across tests.
  identity.mintLeafKeypair.mockResolvedValue({
    signKey: new Uint8Array(MLS_SIG_PRIV),
    publicKey: new Uint8Array(MLS_SIG_PUB),
  });
  identity.buildCrossSignedCredentialIdentity.mockImplementation(
    (userId: string, deviceId: string) => new TextEncoder().encode(`${userId}:${deviceId}`),
  );
  identity.decodeMlsCredentialIdentity.mockImplementation((bytes: Uint8Array) => {
    const [userId, deviceId] = new TextDecoder().decode(bytes).split(':');
    // A healthy stored credential embeds the account AIK. Return the AIK this test's
    // real setup() uploaded so loadOrMintLocalIdentity sees no divergence (else the
    // AIK-divergence heal would re-cross-sign a genuinely-healthy credential).
    const blobAik = apiClient.setupDmKeys.mock.calls[0]?.[0]?.signingPublicKey as string | undefined;
    const aikPub = blobAik ? fromBase64(blobAik) : new Uint8Array(32);
    return { version: 2, userId, deviceId, aikPub, crossSig: new Uint8Array(64) };
  });

  identity.generateKeyPackages.mockResolvedValue([
    {
      keyPackage: new Uint8Array([1, 2, 3]),
      keyPackageRef: new Uint8Array([9, 9]),
      privateKeyPackage: new Uint8Array([4, 5, 6]),
      isLastResort: false,
    },
    {
      keyPackage: new Uint8Array([7, 8, 9]),
      keyPackageRef: new Uint8Array([8, 8]),
      privateKeyPackage: new Uint8Array([10, 11, 12]),
      isLastResort: true,
    },
  ]);

  mlsClient.publishKeyPackages.mockResolvedValue({ published: 2, remaining: 2 });
  mlsGroupStore.putKpPrivate.mockResolvedValue(undefined);
  mlsGroupStore.putIdentity.mockResolvedValue(undefined);
  mlsGroupStore.getIdentity.mockResolvedValue(null);
  coordinator.activate.mockResolvedValue(undefined);
  coordinator.reconcileChannelClassifications.mockResolvedValue(undefined);

  // Unlock auto-claims legacy pending deliveries; empty makes it a no-op.
  apiClient.getPendingKeyDeliveries.mockResolvedValue([]);
});

describe('dmKeyManager — MLS coexistence round-trip', () => {
  it('setup mints MLS, publishes KPs once, persists private packages (4-arg), activates coordinator, keeps the legacy identity', async () => {
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });

    const { recoveryKey } = await setup(PASSWORD, USER_ID);
    expect(recoveryKey).toBeTruthy();
    expect(isUnlocked()).toBe(true);

    // Two-phase: setup mints a leaf-only keypair, then cross-signs the leaf with the
    // AIK (carrying our userId) and supplies a real deviceId via crypto.randomUUID().
    expect(identity.mintLeafKeypair).toHaveBeenCalledTimes(1);
    expect(identity.buildCrossSignedCredentialIdentity).toHaveBeenCalledTimes(1);
    const [calledUserId, calledDeviceId] = identity.buildCrossSignedCredentialIdentity.mock.calls[0];
    expect(calledUserId).toBe(USER_ID);
    expect(typeof calledDeviceId).toBe('string');
    expect(calledDeviceId.length).toBeGreaterThan(0);

    // Per-device identity: the at-rest key is now set BEFORE the leaf mint
    // (so putIdentity can encrypt the device-local record), then set again
    // idempotently in the bootstrap block before publishing private KeyPackages —
    // hence two calls, both with the same truthy at-rest key.
    expect(mlsGroupStore.setAtRestKey).toHaveBeenCalledTimes(2);
    expect(mlsGroupStore.setAtRestKey.mock.calls[0][0]).toBeTruthy();
    expect(mlsGroupStore.setAtRestKey.mock.calls[1][0]).toBe(mlsGroupStore.setAtRestKey.mock.calls[0][0]);
    // The device-local identity is persisted TWICE on a fresh device: once leaf-only
    // (empty credential) at mint, then again cross-signed (v2 credential) at unlock.
    expect(mlsGroupStore.putIdentity).toHaveBeenCalledTimes(2);

    // putKpPrivate called with FOUR args per generated package (ref, kp, priv, isLastResort).
    expect(mlsGroupStore.putKpPrivate).toHaveBeenCalledTimes(2);
    const firstPut = mlsGroupStore.putKpPrivate.mock.calls[0];
    expect(firstPut).toHaveLength(4);
    expect(typeof firstPut[0]).toBe('string'); // base64 ref
    expect(firstPut[1]).toBeInstanceOf(Uint8Array); // public KP
    expect(firstPut[2]).toBeInstanceOf(Uint8Array); // private KP
    expect(typeof firstPut[3]).toBe('boolean'); // isLastResort

    // publishKeyPackages called ONCE with the deviceId + base64 public KPs.
    expect(mlsClient.publishKeyPackages).toHaveBeenCalledTimes(1);
    const [pubDeviceId, pubKps] = mlsClient.publishKeyPackages.mock.calls[0];
    expect(pubDeviceId).toBe(calledDeviceId);
    expect(pubKps).toHaveLength(2);
    expect(typeof pubKps[0].keyPackage).toBe('string');
    expect(typeof pubKps[0].isLastResort).toBe('boolean');

    // Coordinator activated with the bundle + an at-rest CryptoKey.
    expect(coordinator.activate).toHaveBeenCalledTimes(1);
    const [actBundle, actKey] = coordinator.activate.mock.calls[0];
    expect(actBundle.userId).toBe(USER_ID);
    expect(actBundle.deviceId).toBe(calledDeviceId);
    expect(actKey).toBeTruthy();

    // COEXISTENCE: getPublicKey() returns the LEGACY X25519 key (truthy), NOT MLS.
    const legacyPub = getPublicKey();
    expect(legacyPub).toBeTruthy();
    // The legacy Ed25519 signing identity is live, observed via the surviving
    // signVoiceJoinBlob() consumer (its blob.sigPub is the signing public key).
    expect(signVoiceJoinBlob('chan-rt', 0)!.blob.sigPub).toBeTruthy();
    // The MLS identity activated is the MLS signature key (distinct from legacy).
    expect(activatedMlsSigPubB64()).toBe(b64(MLS_SIG_PUB));
    expect(activatedMlsSigPubB64()).not.toBe(legacyPub);
    expect(activatedMlsDeviceId()).toBe(calledDeviceId);

    // The uploaded blob is a v2 blob carrying the MLS identity — verified by the
    // unlock round-trip below. NO escrow blob with the MLS identity is uploaded
    // (passwordDerived=false here, so rawBlobForEscrow is never sent at all).
    const setupArg = apiClient.setupDmKeys.mock.calls[0][0] as { rawBlobForEscrow?: string };
    expect(setupArg.rawBlobForEscrow).toBeUndefined();
  }, 30000);

  it('lock deactivates the coordinator and clears MLS state', async () => {
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });
    await setup(PASSWORD, USER_ID);
    expect(activatedMlsSigPubB64()).toBeTruthy(); // MLS was activated at setup

    lock();
    expect(isUnlocked()).toBe(false);
    // MLS state cleared: the coordinator was deactivated.
    expect(coordinator.deactivate).toHaveBeenCalledTimes(1);
    // Legacy state cleared too.
    expect(getPublicKey()).toBeNull();
  }, 30000);

  it('unlock round-trips the SAME legacy public key from the blob; the MLS identity is LOADED from the device-local store (per-device)', async () => {
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });
    await setup(PASSWORD, USER_ID);

    const legacyPubAfterSetup = getPublicKey();

    // Capture exactly what setup() uploaded.
    const uploaded = apiClient.setupDmKeys.mock.calls[0][0] as {
      publicKey: string;
      encryptedBlob: string;
      blobSalt: string;
    };

    lock();
    expect(isUnlocked()).toBe(false);
    coordinator.activate.mockClear();
    identity.mintLeafKeypair.mockClear();
    identity.buildCrossSignedCredentialIdentity.mockClear();
    mlsClient.publishKeyPackages.mockClear();
    mlsGroupStore.putIdentity.mockClear();

    // Serve the captured bundle back and unlock with the same password.
    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: uploaded.publicKey,
      encryptedBlob: uploaded.encryptedBlob,
      blobSalt: uploaded.blobSalt,
      blobVersion: 1,
      passwordDerived: false,
    });

    // Per-device identity: the MLS identity is held DEVICE-LOCAL in
    // mlsGroupStore, NOT in the blob. This device already has an ALREADY-cross-signed
    // identity (non-empty credential), so unlock must LOAD it (reuse, no re-mint, no
    // republish) and activate MLS with it.
    const STORED_SIG_PUB = new Uint8Array([42, 43, 44]);
    mlsGroupStore.getIdentity.mockResolvedValueOnce({
      userId: USER_ID,
      deviceId: 'dev-stored',
      signaturePublicKey: STORED_SIG_PUB,
      signaturePrivateKey: new Uint8Array([50, 51, 52]),
      credentialIdentity: new TextEncoder().encode(`${USER_ID}:dev-stored`),
    });
    // Make the userId resolvable so unlock's device-local load path runs.
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await expect(unlock(PASSWORD)).resolves.toBeUndefined();
    expect(isUnlocked()).toBe(true);

    // Legacy identity round-trips identically (group DMs + voice/stage depend on it).
    expect(getPublicKey()).toBe(legacyPubAfterSetup);

    // The STORED (already-cross-signed) device-local identity is loaded (reused),
    // NOT re-minted and NOT re-cross-signed/re-published.
    expect(identity.mintLeafKeypair).not.toHaveBeenCalled();
    expect(identity.buildCrossSignedCredentialIdentity).not.toHaveBeenCalled();
    expect(mlsGroupStore.putIdentity).not.toHaveBeenCalled();
    expect(mlsClient.publishKeyPackages).not.toHaveBeenCalled();
    // The activated identity reflects the loaded record.
    expect(activatedMlsSigPubB64()).toBe(b64(STORED_SIG_PUB));
    expect(activatedMlsDeviceId()).toBe('dev-stored');
    // MLS is activated with the loaded identity + an at-rest CryptoKey.
    expect(coordinator.activate).toHaveBeenCalledTimes(1);
    const [actBundle, actKey] = coordinator.activate.mock.calls[0];
    expect(actBundle.deviceId).toBe('dev-stored');
    expect(actKey).toBeTruthy();

    // The blob no longer roams the MLS identity, so no signing-key re-persist runs.
    expect(apiClient.updateDmKeysSigningKey).not.toHaveBeenCalled();
  }, 30000);

  it('reconciles channel classification BEFORE marking the vault unlocked (closes the manual-unlock downgrade window)', async () => {
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });
    await setup(PASSWORD, USER_ID);
    const uploaded = apiClient.setupDmKeys.mock.calls[0][0] as {
      publicKey: string;
      encryptedBlob: string;
      blobSalt: string;
    };

    lock();
    expect(isUnlocked()).toBe(false);
    coordinator.activate.mockClear();
    coordinator.reconcileChannelClassifications.mockClear();

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: uploaded.publicKey,
      encryptedBlob: uploaded.encryptedBlob,
      blobSalt: uploaded.blobSalt,
      blobVersion: 1,
      passwordDerived: false,
    });

    // Per-device identity: make the device-local identity resolvable so
    // unlock loads it and activate() IS reached, letting us re-assert the
    // reconcile-before-activate ordering.
    mlsGroupStore.getIdentity.mockResolvedValueOnce({
      userId: USER_ID,
      deviceId: 'dev-stored',
      signaturePublicKey: new Uint8Array([1, 2, 3]),
      signaturePrivateKey: new Uint8Array([4, 5, 6]),
      credentialIdentity: new TextEncoder().encode(`${USER_ID}:dev-stored`),
    });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    // Capture the vault's locked/unlocked state AT THE MOMENT reconcile runs. The
    // reconcile must happen while the vault is still locked: once _isUnlocked is
    // true the coexistence legacy channel keys become usable, so isChannelMls()
    // must already be authoritative or an established-MLS channel whose
    // localStorage classification was lost would silently route to legacy.
    let unlockedAtReconcile: boolean | null = null;
    coordinator.reconcileChannelClassifications.mockImplementation(async () => {
      unlockedAtReconcile = isUnlocked();
    });

    await expect(unlock(PASSWORD)).resolves.toBeUndefined();

    // The key-free classification reconcile still runs exactly once, while the
    // vault is still locked (this is independent of MLS activation).
    expect(coordinator.reconcileChannelClassifications).toHaveBeenCalledTimes(1);
    expect(unlockedAtReconcile).toBe(false);
    // Per-device identity: the device-local identity load wires MLS, so
    // activate() IS now reached on unlock — and it ran AFTER the reconcile (the
    // reconcile is awaited before _isUnlocked flips, then activate fires).
    expect(coordinator.activate).toHaveBeenCalledTimes(1);
  }, 30000);

  it('fresh-device MLS establish: unlocking a no-MLS-local-identity device mints + persists device-local + publishes + activates MLS', async () => {
    // Build a genuine v1 blob via the REAL dmCrypto path: run setup WITHOUT a
    // userId (and with getCurrentUserId unavailable) so no MLS identity is minted.
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });
    // resolveUserId() falls back to dmEncryption.getCurrentUserId(); ensure the
    // session id is cleared so no MLS identity is minted at setup (robust to test
    // ordering within this file — dmEncryption._currentUserId is module state).
    const dmEnc = await import('../services/dmEncryption');
    dmEnc.clearDmEncryptionState();
    await setup(PASSWORD); // v1 blob, no MLS identity minted

    // No MLS identity yet (setup had no resolvable userId), so MLS was not activated.
    expect(coordinator.activate).not.toHaveBeenCalled();
    const uploaded = apiClient.setupDmKeys.mock.calls[0][0] as {
      publicKey: string;
      encryptedBlob: string;
      blobSalt: string;
    };
    const legacyPub = getPublicKey();

    lock();
    coordinator.activate.mockClear();
    identity.mintLeafKeypair.mockClear();
    identity.buildCrossSignedCredentialIdentity.mockClear();
    mlsGroupStore.putIdentity.mockClear();
    mlsClient.publishKeyPackages.mockClear();
    apiClient.updateDmKeysSigningKey.mockResolvedValue({ blobVersion: 2 });

    // Make a userId resolvable for the establish path. The device-local store has
    // no identity (default getIdentity → null), so unlock mints a fresh one.
    const { initializeEncryption } = await import('../services/dmEncryption');
    initializeEncryption(USER_ID);

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: uploaded.publicKey,
      encryptedBlob: uploaded.encryptedBlob,
      blobSalt: uploaded.blobSalt,
      blobVersion: 1,
      passwordDerived: false,
    });

    await expect(unlock(PASSWORD)).resolves.toBeUndefined();

    // Legacy identity unchanged.
    expect(getPublicKey()).toBe(legacyPub);
    // Per-device identity + two-phase: a fresh leaf is minted on unlock and
    // cross-signed, persisted DEVICE-LOCAL (putIdentity twice: leaf + cross-signed) —
    // NOT into the roaming blob — and its KeyPackages are published so peers can Add it.
    expect(identity.mintLeafKeypair).toHaveBeenCalledTimes(1);
    expect(identity.buildCrossSignedCredentialIdentity).toHaveBeenCalledTimes(1);
    expect(activatedMlsSigPubB64()).toBeTruthy();
    expect(mlsGroupStore.putIdentity).toHaveBeenCalledTimes(2);
    expect(mlsClient.publishKeyPackages).toHaveBeenCalledTimes(1);
    // The MLS identity no longer roams the blob, so the mint does NOT trigger a
    // blob re-persist (only a freshly generated legacy signing key would).
    expect(apiClient.updateDmKeysSigningKey).not.toHaveBeenCalled();
    // Coordinator activated with the newly-minted identity + at-rest key.
    expect(coordinator.activate).toHaveBeenCalledTimes(1);
  }, 30000);

  it('fail-closed: a device-local identity PERSIST failure on setup leaves MLS fully inactive (legacy unaffected), never an ephemeral non-persisted identity', async () => {
    // Per-device identity fail-closed contract: mintMlsIdentity() populates the
    // in-memory _mls* fields BEFORE awaiting putIdentity. If putIdentity rejects
    // (e.g. disk full), the in-memory identity is non-persisted — using it would
    // activate MLS under an identity peers can never re-derive on reload. setup()'s
    // catch must therefore clearMlsState() + null the at-rest/history keys so MLS is
    // fully inactive this session; legacy DMs stay fully usable.
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });
    // The mint is attempted (resolvable userId), but the device-local persist fails.
    mlsGroupStore.putIdentity.mockRejectedValueOnce(new Error('disk full'));

    const { recoveryKey } = await setup(PASSWORD, USER_ID);
    expect(recoveryKey).toBeTruthy();

    // Legacy DMs are unaffected — the vault is unlocked and the legacy core works.
    expect(isUnlocked()).toBe(true);
    expect(getPublicKey()).toBeTruthy();
    expect(signVoiceJoinBlob('chan-rt2', 0)!.blob.sigPub).toBeTruthy();

    // clearMlsState() zeroed the in-memory identity → no ephemeral non-persisted
    // identity is active. MLS was NOT activated with the non-persisted identity
    // (the `if (mlsBundle)` bootstrap/activate block is skipped because mlsBundle
    // is null).
    expect(coordinator.activate).not.toHaveBeenCalled();
    expect(mlsClient.publishKeyPackages).not.toHaveBeenCalled();

    // The cleanup nulled the at-rest key so no decryption-capable key lingers on the
    // store with the coordinator inactive (the last setAtRestKey call passed null).
    expect(mlsGroupStore.setAtRestKey).toHaveBeenCalledWith(null);
    const lastAtRest = mlsGroupStore.setAtRestKey.mock.calls.at(-1);
    expect(lastAtRest?.[0]).toBeNull();
    expect(mlsGroupStore.setHistoryKey).toHaveBeenCalledWith(null);
  }, 30000);

  it('unlock fail-ordering: an MLS-activation failure does NOT surface as a wrong password', async () => {
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });
    await setup(PASSWORD, USER_ID);
    const uploaded = apiClient.setupDmKeys.mock.calls[0][0] as {
      publicKey: string;
      encryptedBlob: string;
      blobSalt: string;
    };
    const legacyPub = getPublicKey();
    lock();

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: uploaded.publicKey,
      encryptedBlob: uploaded.encryptedBlob,
      blobSalt: uploaded.blobSalt,
      blobVersion: 1,
      passwordDerived: false,
    });
    // Coordinator activation blows up — the password is still correct.
    coordinator.activate.mockRejectedValueOnce(new Error('mls boom'));

    // unlock must resolve (NOT reject as a bad password) and legacy DMs must work.
    await expect(unlock(PASSWORD)).resolves.toBeUndefined();
    expect(isUnlocked()).toBe(true);
    expect(getPublicKey()).toBe(legacyPub);
  }, 30000);

  it('SECURITY: server-escrow blob (passwordDerived) carries the legacy core but NEVER the MLS identity', async () => {
    // Setup mints the MLS identity, so the in-memory state DOES have an MLS
    // signing private key. Enabling password-derived mode uploads rawBlobForEscrow
    // to the SERVER (server-readable). That escrow MUST NOT contain MLS material —
    // the MLS signing key reaching the server would let it forge the user's MLS
    // identity.
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });
    apiClient.enablePasswordDerived.mockResolvedValue(undefined);

    await setup(PASSWORD, USER_ID);
    // Sanity: the in-memory MLS identity exists and matches our stable bytes, so
    // a leak into escrow would be detectable below.
    expect(activatedMlsSigPubB64()).toBe(b64(MLS_SIG_PUB));

    await enablePasswordDerived();

    // Capture exactly what was uploaded to the server for escrow.
    expect(apiClient.enablePasswordDerived).toHaveBeenCalledTimes(1);
    const escrowArg = apiClient.enablePasswordDerived.mock.calls[0][0] as { rawBlobForEscrow: string };
    expect(typeof escrowArg.rawBlobForEscrow).toBe('string');

    const decodedJson = atob(escrowArg.rawBlobForEscrow);
    const parsed = JSON.parse(decodedJson) as {
      privateKey?: string;
      mlsIdentity?: unknown;
      deviceId?: unknown;
      blobFormatVersion?: unknown;
    };

    // No MLS material in the server-readable escrow.
    expect(parsed.mlsIdentity).toBeUndefined();
    expect(parsed.deviceId).toBeUndefined();
    expect(parsed.blobFormatVersion).toBeUndefined();
    // The base64 of the MLS signing PRIVATE key must not appear anywhere in the blob.
    expect(decodedJson).not.toContain(b64(MLS_SIG_PRIV));
    expect(decodedJson).not.toContain(b64(MLS_SIG_PUB));

    // The legacy core IS still escrowed (server-escrow recovery must keep working).
    expect(typeof parsed.privateKey).toBe('string');
    expect((parsed.privateKey as string).length).toBeGreaterThan(0);
  }, 30000);

  it('SECURITY: recovery-key recover() escrow (passwordDerived) carries the legacy core but NEVER the MLS identity', async () => {
    // Regression guard for the escrow reconcile in recover(): `contents` there is
    // the decrypted v2 RECOVERY blob (it carries the MLS signing private key), and
    // a password-derived user's rawBlobForEscrow
    // reaches the SERVER. It MUST be MLS-stripped, exactly like serverRecover() and
    // enablePasswordDerived(). A verbatim btoa(JSON.stringify(contents)) would leak
    // the MLS signing key to the server (forge-the-identity risk).
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });
    const { recoveryKey } = await setup(PASSWORD, USER_ID);
    // Sanity: the minted MLS identity is in memory, so a leak would be detectable.
    expect(activatedMlsSigPubB64()).toBe(b64(MLS_SIG_PUB));

    // The v2 recovery material setup() produced (decrypts to a blob carrying MLS).
    const uploaded = apiClient.setupDmKeys.mock.calls[0][0] as {
      publicKey: string; blobSalt: string; recoveryBlob: string; recoveryNonce: string;
    };

    lock();

    // passwordDerived → escrow reaches the server, so recover() sends rawBlobForEscrow.
    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: uploaded.publicKey,
      encryptedBlob: 'unused-by-recover',
      blobSalt: uploaded.blobSalt,
      blobVersion: 5,
      recoveryBlob: uploaded.recoveryBlob,
      recoveryNonce: uploaded.recoveryNonce,
      recoveryMode: 'key',
      passwordDerived: true,
    });
    let escrowed: string | undefined;
    apiClient.recoverDmKeys.mockImplementation(async (a: { rawBlobForEscrow?: string }) => {
      escrowed = a.rawBlobForEscrow;
      return { blobVersion: 6 };
    });

    await recover(recoveryKey, 'new-pw');

    // Escrow WAS sent (password-derived), but the MLS material is stripped out.
    expect(typeof escrowed).toBe('string');
    const decodedJson = atob(escrowed!);
    const parsed = JSON.parse(decodedJson) as {
      privateKey?: string;
      mlsIdentity?: unknown;
      deviceId?: unknown;
      blobFormatVersion?: unknown;
    };
    expect(parsed.mlsIdentity).toBeUndefined();
    expect(parsed.deviceId).toBeUndefined();
    expect(parsed.blobFormatVersion).toBeUndefined();
    expect(decodedJson).not.toContain(b64(MLS_SIG_PRIV));
    expect(decodedJson).not.toContain(b64(MLS_SIG_PUB));
    // The legacy core IS still escrowed (server-escrow recovery must keep working).
    expect(typeof parsed.privateKey).toBe('string');
    expect((parsed.privateKey as string).length).toBeGreaterThan(0);
  }, 30000);
});
