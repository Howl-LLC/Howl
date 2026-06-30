// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * serverRecover() recovery activation.
 *
 * serverRecover brings parity with recover(): install the device identity via
 * bootstrapMlsIdentity, await reconcileChannelClassifications BEFORE the unlock
 * flip (no forward-secrecy downgrade), guard the flip with ensureLive(epoch) (no
 * logout-during-recovery resurrection), then activateMls. Without this, MLS stays
 * dark after a Server recovery until a full reload (no at-rest/history keys, no
 * activated identity, no reconciled classifications, no published KeyPackages).
 *
 * Real dmCrypto, mocked MLS leaves + network. A real escrow rawBlob is captured
 * from a password-derived recover().
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

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
      getIdentity: vi.fn((): Promise<unknown | null> => Promise.resolve(null)),
      deleteIdentity: vi.fn(() => Promise.resolve()),
      deleteAllKpPrivate: vi.fn(() => Promise.resolve()),
      clearHistory: vi.fn(() => Promise.resolve()),
      clearAll: vi.fn(() => Promise.resolve()),
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
      serverRecover: vi.fn(),
    },
  };
});

vi.mock('../services/mls/mlsIdentity', () => identity);
vi.mock('../services/mls/mlsClient', () => mlsClient);
vi.mock('../services/mls/mlsGroupStore', () => mlsGroupStore);
vi.mock('../services/mls/mlsCoordinator', () => coordinator);
vi.mock('../services/api', () => ({ apiClient }));

import {
  setup, recover, serverRecover, lock, reset, isUnlocked,
  signVoiceJoinBlob,
} from '../services/dmKeyManager';

// getMlsSignaturePublicKey/getMlsDeviceId were removed. They mirrored the
// bundle handed to coordinator.activate(); re-express the "MLS identity is
// installed/active" invariant via that surviving observable.
function mlsWasActivated(): boolean {
  return coordinator.activate.mock.calls.length > 0;
}

const PASSWORD = 'correct horse battery staple';
const USER_ID = 'user-alice';
const MLS_SIG_PUB = new Uint8Array([10, 11, 12, 13]);
const MLS_SIG_PRIV = new Uint8Array([20, 21, 22, 23, 24, 25]);

beforeEach(() => {
  vi.clearAllMocks();

  // Two-phase: boot mints a leaf-only keypair; recover/serverRecover cross-signs + publishes.
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

  // Faithfully model the per-tab at-rest / history keys: set on unlock/setup/recover,
  // nulled on lock; the getters reflect the last set value.
  let _heldKey: CryptoKey | null = null;
  mlsGroupStore.setAtRestKey.mockImplementation((k: CryptoKey | null) => { _heldKey = k; });
  mlsGroupStore.getAtRestKey.mockImplementation(() => _heldKey);
  let _heldHistoryKey: CryptoKey | null = null;
  mlsGroupStore.setHistoryKey.mockImplementation((k: CryptoKey | null) => { _heldHistoryKey = k; });
  mlsGroupStore.getHistoryKey.mockImplementation(() => _heldHistoryKey);

  apiClient.getPendingKeyDeliveries.mockResolvedValue([]);
});

/**
 * Obtain a genuine escrow rawBlob: a password-derived recover() sends
 * rawBlobForEscrow = btoa(JSON.stringify(stripMlsForEscrow(contents))), which is
 * exactly the escrow payload serverRecover() decodes. Captured from a real setup()
 * + password-derived recover().
 */
async function captureEscrowRawBlob(): Promise<string> {
  reset();
  let pubKey = ''; let blobSalt = ''; let recoveryBlob = ''; let recoveryNonce = '';
  apiClient.setupDmKeys.mockImplementation(async (a: {
    publicKey: string; blobSalt: string; recoveryBlob: string; recoveryNonce: string;
  }) => {
    pubKey = a.publicKey; blobSalt = a.blobSalt;
    recoveryBlob = a.recoveryBlob; recoveryNonce = a.recoveryNonce;
    return { blobVersion: 1 };
  });
  const { recoveryKey } = await setup(PASSWORD, USER_ID);

  reset();
  apiClient.getDmKeyBundle.mockResolvedValue({
    publicKey: pubKey, encryptedBlob: 'unused-by-recover', blobSalt,
    blobVersion: 5, recoveryBlob, recoveryNonce, recoveryMode: 'key', passwordDerived: true,
  });
  let rawBlob = '';
  apiClient.recoverDmKeys.mockImplementation(async (a: { rawBlobForEscrow?: string }) => {
    rawBlob = a.rawBlobForEscrow!;
    return { blobVersion: 6 };
  });
  (await import('../services/dmEncryption')).initializeEncryption(USER_ID);
  await recover(recoveryKey, 'mid-pw');
  expect(rawBlob).toBeTruthy();
  return rawBlob;
}

/** Reset to a clean pre-serverRecover state and wire the serverRecover network mocks. */
async function primeServerRecover(rawBlob: string): Promise<void> {
  reset();
  apiClient.serverRecover.mockResolvedValue({ rawBlob });
  apiClient.recoverDmKeys.mockResolvedValue({ blobVersion: 9 });
  apiClient.getPendingKeyDeliveries.mockResolvedValue([]);
  mlsGroupStore.getIdentity.mockResolvedValue(null); // fresh device → mint
  (await import('../services/dmEncryption')).initializeEncryption(USER_ID);
}

describe('serverRecover() activates MLS', () => {
  it('installs at-rest/history keys, mints a fresh device identity, publishes KeyPackages, and activates the coordinator', async () => {
    const rawBlob = await captureEscrowRawBlob();
    await primeServerRecover(rawBlob);
    mlsGroupStore.putIdentity.mockClear();
    mlsClient.publishKeyPackages.mockClear();
    coordinator.activate.mockClear();
    mlsGroupStore.setAtRestKey.mockClear();
    mlsGroupStore.setHistoryKey.mockClear();
    identity.mintLeafKeypair.mockClear();
    identity.buildCrossSignedCredentialIdentity.mockClear();

    await serverRecover('reset-pw');

    expect(isUnlocked()).toBe(true);
    expect(mlsGroupStore.setAtRestKey).toHaveBeenLastCalledWith(expect.anything());
    expect(mlsGroupStore.setHistoryKey).toHaveBeenLastCalledWith(expect.anything());
    expect(mlsGroupStore.getHistoryKey()).not.toBeNull();
    // Two-phase: a fresh device persists the identity TWICE (leaf-only at mint, then
    // cross-signed), and publishes its KeyPackages once on the cross-sign.
    expect(mlsGroupStore.putIdentity).toHaveBeenCalledTimes(2);
    expect(identity.mintLeafKeypair).toHaveBeenCalledTimes(1);
    expect(identity.buildCrossSignedCredentialIdentity).toHaveBeenCalledTimes(1);
    expect(mlsClient.publishKeyPackages).toHaveBeenCalledTimes(1);
    expect(coordinator.activate).toHaveBeenCalledTimes(1);
    // The activated identity is the freshly-minted MLS identity (truthy sig + deviceId).
    const actBundle = coordinator.activate.mock.calls[0][0];
    expect(actBundle.identity.signaturePublicKey).toBeTruthy();
    expect(actBundle.deviceId).toBeTruthy();
  }, 30000);

  it('awaits reconcileChannelClassifications BEFORE _isUnlocked flips (no forward-secrecy downgrade)', async () => {
    const rawBlob = await captureEscrowRawBlob();
    await primeServerRecover(rawBlob);
    coordinator.reconcileChannelClassifications.mockClear();

    // Park serverRecover INSIDE reconcile so we can observe the vault state while
    // reconcile is still pending. A snapshot-at-emit assertion is vacuous here: the
    // awaits between the reconcile call and emit('unlocked') (clearHistory,
    // _claimPendingDeliveriesImpl) drain any deferred flag, so it reads true at emit
    // even for a fire-and-forget reconcile. Parking proves the ordering directly:
    // because reconcile is AWAITED before the flip, _isUnlocked must still be false
    // while reconcile has not resolved; a fire-and-forget reconcile would already
    // have flipped it true by the time this checkpoint runs.
    let reconcileReachedResolve!: () => void;
    const reconcileReached = new Promise<void>((res) => { reconcileReachedResolve = res; });
    let releaseReconcile!: () => void;
    coordinator.reconcileChannelClassifications.mockImplementation(() => {
      reconcileReachedResolve();
      return new Promise<void>((res) => { releaseReconcile = () => res(undefined); });
    });

    const p = serverRecover('reset-pw');
    await reconcileReached;                 // serverRecover is now parked at the awaited reconcile
    expect(isUnlocked()).toBe(false);       // flip has NOT happened while reconcile is pending
    releaseReconcile();                     // resolve reconcile → the flip may now proceed

    await p;
    expect(isUnlocked()).toBe(true);
    expect(coordinator.reconcileChannelClassifications).toHaveBeenCalledTimes(1);
  }, 30000);

  it('aborts the unlock flip when lock() fires during the in-flight bootstrap publish (ensureLive guard)', async () => {
    const rawBlob = await captureEscrowRawBlob();
    await primeServerRecover(rawBlob);
    coordinator.activate.mockClear();

    // Park serverRecover at the awaited KeyPackage publish so we can fire lock() mid-flight.
    let publishReachedResolve: () => void;
    const publishReached = new Promise<void>((res) => { publishReachedResolve = res; });
    let releasePublish: () => void;
    mlsClient.publishKeyPackages.mockImplementation(() => {
      publishReachedResolve();
      return new Promise<{ published: number; remaining: number }>((res) => { releasePublish = () => res({ published: 1, remaining: 1 }); });
    });

    const p = serverRecover('reset-pw');
    await publishReached;          // serverRecover is now parked at the publish await
    lock();                        // forced teardown bumps the abort epoch
    expect(isUnlocked()).toBe(false);
    releasePublish!();             // let serverRecover continue to its pre-flip ensureLive(epoch)

    await expect(p).rejects.toThrow(/aborted by teardown/); // pinned to the ensureLive guard, not any throw
    expect(isUnlocked()).toBe(false);            // the flip was aborted, not resurrected
    expect(coordinator.activate).not.toHaveBeenCalled();
  }, 30000);

  it('fails closed when identity mint fails: MLS inactive (keys nulled, no activate), legacy intact', async () => {
    const rawBlob = await captureEscrowRawBlob();
    await primeServerRecover(rawBlob);
    coordinator.activate.mockClear();
    mlsGroupStore.setAtRestKey.mockClear();
    mlsGroupStore.setHistoryKey.mockClear();
    mlsGroupStore.putIdentity.mockRejectedValue(new Error('idb write failed')); // mint persist throws

    await expect(serverRecover('reset-pw')).resolves.toBeUndefined();
    expect(isUnlocked()).toBe(true);                       // legacy vault still unlocks

    expect(mlsWasActivated()).toBe(false);                  // MLS not activated (no ephemeral identity)
    expect(mlsGroupStore.setAtRestKey).toHaveBeenLastCalledWith(null);
    expect(mlsGroupStore.setHistoryKey).toHaveBeenLastCalledWith(null);
    expect(mlsGroupStore.getHistoryKey()).toBeNull();
    // legacy Ed25519 identity intact, observed via the surviving
    // signVoiceJoinBlob() consumer (its blob.sigPub is the signing public key).
    expect(signVoiceJoinBlob('chan-srv-mls', 0)!.blob.sigPub).toBeTruthy();
  }, 30000);

  it('still purges the old (unreadable) history archive while installing the go-forward history key', async () => {
    const rawBlob = await captureEscrowRawBlob();
    await primeServerRecover(rawBlob);
    mlsGroupStore.clearHistory.mockClear();
    mlsGroupStore.setHistoryKey.mockClear();

    await serverRecover('reset-pw');

    expect(mlsGroupStore.clearHistory).toHaveBeenCalledTimes(1);
    expect(mlsGroupStore.setHistoryKey).toHaveBeenLastCalledWith(expect.anything());
    expect(mlsGroupStore.getHistoryKey()).not.toBeNull();   // clearHistory purges rows, not the key
  }, 30000);

  it('still re-encrypts and uploads the escrow blob (deriveUnlockMaterial swap is byte-transparent)', async () => {
    const rawBlob = await captureEscrowRawBlob();
    await primeServerRecover(rawBlob);
    let recoverArgs: { recoveryMode?: string; rawBlobForEscrow?: string; encryptedBlob?: string } | undefined;
    apiClient.recoverDmKeys.mockImplementation(async (a: typeof recoverArgs) => { recoverArgs = a; return { blobVersion: 9 }; });

    await serverRecover('reset-pw');

    expect(recoverArgs?.recoveryMode).toBe('server-escrowed');
    expect(recoverArgs?.rawBlobForEscrow).toBeTruthy();
    expect(recoverArgs?.encryptedBlob).toBeTruthy();
  }, 30000);
});

describe('recovery forces a fresh identity (revocation)', () => {
  it('serverRecover deletes the prior identity + KP privates BEFORE load-or-mint, then mints a fresh device', async () => {
    const rawBlob = await captureEscrowRawBlob();
    await primeServerRecover(rawBlob);

    // Pre-seed a PRIOR identity so, absent the delete, load-or-mint would REUSE it.
    const PRIOR_DEV = '00000000-0000-4000-8000-0000000000aa';
    mlsGroupStore.getIdentity.mockResolvedValue({
      userId: USER_ID, deviceId: PRIOR_DEV,
      signaturePublicKey: new Uint8Array(MLS_SIG_PUB),
      signaturePrivateKey: new Uint8Array(MLS_SIG_PRIV),
      credentialIdentity: new TextEncoder().encode(`${USER_ID}:${PRIOR_DEV}`),
    });

    // Order tracking: delete* must run before getIdentity (load) and putIdentity (mint).
    // Clear the call counters first - captureEscrowRawBlob() ran a recover() that also
    // invokes the delete primitives, and we want to count only the serverRecover() pass.
    mlsGroupStore.deleteIdentity.mockClear();
    mlsGroupStore.deleteAllKpPrivate.mockClear();
    mlsGroupStore.getIdentity.mockClear();
    mlsGroupStore.putIdentity.mockClear();
    coordinator.activate.mockClear();
    const order: string[] = [];
    mlsGroupStore.deleteIdentity.mockImplementation(() => { order.push('deleteIdentity'); return Promise.resolve(); });
    mlsGroupStore.deleteAllKpPrivate.mockImplementation(() => { order.push('deleteAllKpPrivate'); return Promise.resolve(); });
    mlsGroupStore.getIdentity.mockImplementation(() => {
      order.push('getIdentity');
      // After the delete, recovery must mint fresh → model the row as GONE.
      return Promise.resolve(order.includes('deleteIdentity') ? null : undefined);
    });
    mlsGroupStore.putIdentity.mockImplementation(() => { order.push('putIdentity'); return Promise.resolve(); });

    await serverRecover('reset-pw');

    expect(mlsGroupStore.deleteIdentity).toHaveBeenCalledTimes(1);
    expect(mlsGroupStore.deleteAllKpPrivate).toHaveBeenCalledTimes(1);
    // delete-before-load-before-mint
    expect(order.indexOf('deleteIdentity')).toBeLessThan(order.indexOf('getIdentity'));
    expect(order.indexOf('getIdentity')).toBeLessThan(order.indexOf('putIdentity'));

    // The activated bundle carries a FRESH deviceId, not PRIOR_DEV (revocation).
    const actBundle = coordinator.activate.mock.calls[0][0];
    expect(actBundle.deviceId).not.toBe(PRIOR_DEV);
    expect(actBundle.deviceId).toBeTruthy();
  }, 30000);

  it('serverRecover still completes (vault unlocks, MLS activates) when the revocation delete THROWS', async () => {
    const rawBlob = await captureEscrowRawBlob();
    await primeServerRecover(rawBlob);
    coordinator.activate.mockClear();
    mlsGroupStore.deleteIdentity.mockRejectedValue(new Error('idb delete failed'));

    // The delete failure is swallowed (defensive); recovery must NOT reject.
    await expect(serverRecover('reset-pw')).resolves.toBeUndefined();
    expect(isUnlocked()).toBe(true);
    // Bootstrap still ran → MLS activated despite the failed delete.
    expect(coordinator.activate).toHaveBeenCalledTimes(1);
  }, 30000);
});
