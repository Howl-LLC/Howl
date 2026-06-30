// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Non-blocking MLS activation on unlock.
 *
 * An awaiting unlock() (`await activateMls(...)`) would block on
 * mlsCoordinator.activate(). On the worker path activate() blocks on an init RPC
 * (bounded by a 30s timeout), and on the fallback path it runs the full
 * in-process activation. Either way a slow/never-completing MLS activation would
 * keep the whole vault locked: a non-leader tab hangs at unlock and even legacy
 * DMs stay unusable until MLS finishes.
 *
 * Activation is fire-and-forget: unlock() must resolve (emit 'unlocked' /
 * isUnlocked() → true) EVEN WHEN MLS activation never completes. The load-bearing
 * ordering invariant is preserved: the main-thread reconcileChannelClassifications
 * is still AWAITED before _isUnlocked flips, so an established MLS channel is
 * classified 'mls' before the now-usable coexistence legacy keys could route a
 * send to legacy (a forward-secrecy downgrade window).
 *
 * Modeled on dmKeyManagerMlsRoundTrip.test.ts (real dmCrypto, mocked MLS leaves +
 * network). The one difference: mlsCoordinator.activate returns a NEVER-RESOLVING
 * promise for the unlock under test.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

// jsdom does not ship WebCrypto; pull Node's webcrypto so the real dmCrypto
// blob/Argon2 path runs and crypto.randomUUID() exists for the minted deviceId.
beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

// Mock the MLS leaf modules + network (real dmCrypto stays unmocked)
const { identity, mlsClient, mlsGroupStore, coordinator, apiClient, emitMlsEvent } = vi.hoisted(() => {
  // A real mlsEvents emitter so the auto-recovery tests can drive
  // 'mls-locked' through it and assert dmKeyManager re-activates (or not).
  const listeners = new Set<(e: 'mls-ready' | 'mls-locked') => void>();
  const mlsEvents = { on(cb: (e: 'mls-ready' | 'mls-locked') => void) { listeners.add(cb); return () => listeners.delete(cb); } };
  const emitMlsEvent = (e: 'mls-ready' | 'mls-locked') => { for (const cb of listeners) cb(e); };
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
      getIdentity: vi.fn((): Promise<{
        userId: string; deviceId: string;
        signaturePublicKey: Uint8Array; signaturePrivateKey: Uint8Array; credentialIdentity: Uint8Array;
      } | null> => Promise.resolve(null)),
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
    },
    emitMlsEvent,
  };
});

vi.mock('../services/mls/mlsIdentity', () => identity);
vi.mock('../services/mls/mlsClient', () => mlsClient);
vi.mock('../services/mls/mlsGroupStore', () => mlsGroupStore);
vi.mock('../services/mls/mlsCoordinator', () => coordinator);
vi.mock('../services/api', () => ({ apiClient }));

import {
  setup, unlock, lock, recover, reset, isUnlocked, on,
} from '../services/dmKeyManager';
import { fromBase64 } from '../services/cryptoHelpers';

/** Run all microtasks so the fire-and-forget auto-recovery activate() settles. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const PASSWORD = 'correct horse battery staple';
const USER_ID = 'user-alice';

// The AIK (signingPublicKey) the most recent real setup() uploaded. The decode mock
// returns it as the credential's embedded AIK so a "healthy" stored credential matches
// the blob AIK loadOrMintLocalIdentity derives at unlock (no spurious AIK-divergence
// heal). Reset per test; populated by setupCaptureLockThenUnlock after capture.
let capturedBlobAik: string | null = null;

const MLS_SIG_PUB = new Uint8Array([10, 11, 12, 13]);
const MLS_SIG_PRIV = new Uint8Array([20, 21, 22, 23, 24, 25]);

beforeEach(() => {
  vi.clearAllMocks();
  capturedBlobAik = null;

  // Two-phase: boot mints a leaf-only keypair; unlock/recover cross-signs + publishes.
  identity.mintLeafKeypair.mockResolvedValue({
    signKey: new Uint8Array(MLS_SIG_PRIV),
    publicKey: new Uint8Array(MLS_SIG_PUB),
  });
  identity.buildCrossSignedCredentialIdentity.mockImplementation(
    (userId: string, deviceId: string) => new TextEncoder().encode(`${userId}:${deviceId}`),
  );
  identity.decodeMlsCredentialIdentity.mockImplementation((bytes: Uint8Array) => {
    const [userId, deviceId] = new TextDecoder().decode(bytes).split(':');
    // A healthy stored credential embeds the account AIK; return the captured blob AIK
    // so loadOrMintLocalIdentity sees no divergence (else the AIK-heal would re-cross-sign).
    const aikPub = capturedBlobAik ? fromBase64(capturedBlobAik) : new Uint8Array(32);
    return { version: 2, userId, deviceId, aikPub, crossSig: new Uint8Array(64) };
  });

  identity.generateKeyPackages.mockResolvedValue([
    { keyPackage: new Uint8Array([1, 2, 3]), keyPackageRef: new Uint8Array([9, 9]), privateKeyPackage: new Uint8Array([4, 5, 6]), isLastResort: false },
  ]);
  mlsClient.publishKeyPackages.mockResolvedValue({ published: 1, remaining: 1 });
  mlsGroupStore.putKpPrivate.mockResolvedValue(undefined);
  mlsGroupStore.putIdentity.mockResolvedValue(undefined);
  mlsGroupStore.getIdentity.mockResolvedValue(null);
  coordinator.reconcileChannelClassifications.mockResolvedValue(undefined);

  // Faithfully model the per-tab at-rest key: setAtRestKey(x) updates what
  // getAtRestKey() returns (set on unlock/setup, nulled on lock). The
  // auto-recovery reads getAtRestKey() to re-activate after a sibling teardown.
  let _heldKey: CryptoKey | null = null;
  mlsGroupStore.setAtRestKey.mockImplementation((k: CryptoKey | null) => { _heldKey = k; });
  mlsGroupStore.getAtRestKey.mockImplementation(() => _heldKey);

  // Faithfully model the per-tab MLS history key the same way (set on
  // unlock/setup, nulled on lock). getHistoryKey() reflects the last set value so
  // the round-trip assertions read the real holder.
  let _heldHistoryKey: CryptoKey | null = null;
  mlsGroupStore.setHistoryKey.mockImplementation((k: CryptoKey | null) => { _heldHistoryKey = k; });
  mlsGroupStore.getHistoryKey.mockImplementation(() => _heldHistoryKey);

  // Unlock auto-claims legacy pending deliveries; empty makes it a no-op.
  apiClient.getPendingKeyDeliveries.mockResolvedValue([]);
});

describe('dmKeyManager: non-blocking MLS activation on unlock', () => {
  it('unlock() resolves and isUnlocked() becomes true EVEN WHEN mlsCoordinator.activate() never resolves, and reconcile is awaited before the unlock flips', async () => {
    // Setup completes its activation (so we get a real v2 blob to round-trip).
    // The unlock under test gets a NEVER-RESOLVING activate to simulate a worker
    // init RPC / fallback activation that never completes.
    coordinator.activate
      .mockResolvedValueOnce(undefined) // setup()
      .mockImplementation(() => new Promise<void>(() => { /* never resolves */ })); // unlock()

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

    // Per-device identity: the MLS identity no longer roams in the blob,
    // so unlock can't recover it from the blob round-trip. A returning device with
    // a resolvable userId mints a fresh identity on unlock instead (the existing
    // mint-on-unlock path), which is what kicks off the (never-resolving) activate
    // this test probes. Make the userId resolvable so that mint path runs.
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    // Ordering capture: record whether reconcile had already resolved at the
    // moment 'unlocked' is emitted (i.e. at the moment _isUnlocked has flipped
    // true). reconcileChannelClassifications must be awaited BEFORE the flip, so
    // this flag MUST be true when the emit fires.
    let reconcileResolved = false;
    coordinator.reconcileChannelClassifications.mockImplementation(async () => {
      reconcileResolved = true;
    });
    let reconcileResolvedAtUnlockedEmit: boolean | null = null;
    let isUnlockedAtUnlockedEmit: boolean | null = null;
    const off = on((e) => {
      if (e === 'unlocked') {
        reconcileResolvedAtUnlockedEmit = reconcileResolved;
        isUnlockedAtUnlockedEmit = isUnlocked();
      }
    });

    try {
      // LOAD-BEARING: unlock() must NOT hang on the never-resolving activate().
      // If it blocks on activate, this rejects with a
      // timeout. The 5s race ceiling is well under the per-test 30s budget.
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('unlock() did not resolve; it is blocking on MLS activation')), 5000),
      );
      await expect(Promise.race([unlock(PASSWORD), timeout])).resolves.toBeUndefined();
    } finally {
      off();
    }

    // unlock resolved with MLS activation still pending → vault is unlocked.
    expect(isUnlocked()).toBe(true);

    // Activation was still kicked off (fire-and-forget), just not awaited.
    expect(coordinator.activate).toHaveBeenCalledTimes(1);

    // Ordering invariant: reconcile was awaited before _isUnlocked flipped.
    expect(coordinator.reconcileChannelClassifications).toHaveBeenCalledTimes(1);
    expect(isUnlockedAtUnlockedEmit).toBe(true);
    expect(reconcileResolvedAtUnlockedEmit).toBe(true);
  }, 30000);
});

describe('dmKeyManager per-device identity: unlock loads-or-mints the device-local identity', () => {
  /**
   * Shared harness: run a real setup() to obtain a genuine v2 blob, capture what
   * was uploaded, lock(), then serve the captured bundle back and unlock(). The
   * userId is made resolvable (initializeEncryption) so the device-local
   * load/mint path runs on unlock.
   */
  async function setupCaptureLockThenUnlock(): Promise<void> {
    coordinator.activate.mockResolvedValue(undefined);
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });
    await setup(PASSWORD, USER_ID);

    const uploaded = apiClient.setupDmKeys.mock.calls[0][0] as {
      publicKey: string;
      signingPublicKey: string;
      encryptedBlob: string;
      blobSalt: string;
    };
    // The stored credential's embedded AIK must match the blob AIK unlock derives, or
    // the AIK-divergence heal would re-cross-sign a genuinely-healthy credential.
    capturedBlobAik = uploaded.signingPublicKey;

    lock();
    expect(isUnlocked()).toBe(false);
    // Clear the calls setup() made so the assertions only see unlock's behavior.
    mlsGroupStore.putIdentity.mockClear();
    mlsClient.publishKeyPackages.mockClear();
    coordinator.activate.mockClear();
    identity.mintLeafKeypair.mockClear();
    identity.buildCrossSignedCredentialIdentity.mockClear();

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: uploaded.publicKey,
      encryptedBlob: uploaded.encryptedBlob,
      blobSalt: uploaded.blobSalt,
      blobVersion: 1,
      passwordDerived: false,
    });

    // Make the userId resolvable so unlock's device-local load/mint path runs.
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await expect(unlock(PASSWORD)).resolves.toBeUndefined();
    expect(isUnlocked()).toBe(true);
  }

  it('unlock on a device with no local identity mints one and publishes its KeyPackages', async () => {
    mlsGroupStore.getIdentity.mockResolvedValue(null); // fresh device
    await setupCaptureLockThenUnlock();
    // Two-phase: a fresh device persists the identity TWICE — leaf-only at mint,
    // then cross-signed at unlock — and publishes its KeyPackages on the cross-sign.
    expect(mlsGroupStore.putIdentity).toHaveBeenCalledTimes(2);
    expect(identity.mintLeafKeypair).toHaveBeenCalledTimes(1);
    expect(identity.buildCrossSignedCredentialIdentity).toHaveBeenCalledTimes(1);
    expect(mlsClient.publishKeyPackages).toHaveBeenCalled();
  }, 30000);

  it('unlock on a device WITH a local identity reuses it and does NOT republish', async () => {
    mlsGroupStore.getIdentity.mockResolvedValue({
      userId: USER_ID, deviceId: 'dev-existing',
      signaturePublicKey: new Uint8Array([1, 2, 3]),
      signaturePrivateKey: new Uint8Array([4, 5, 6]),
      credentialIdentity: new TextEncoder().encode(`${USER_ID}:dev-existing`),
    });
    await setupCaptureLockThenUnlock();
    expect(identity.mintLeafKeypair).not.toHaveBeenCalled();
    expect(mlsGroupStore.putIdentity).not.toHaveBeenCalled();
    expect(mlsClient.publishKeyPackages).not.toHaveBeenCalled();
  }, 30000);
});

describe('dmKeyManager: lock() clears the main-thread MLS at-rest key', () => {
  it('lock() calls mlsGroupStore.setAtRestKey(null) so decryption capability does not survive lock on the worker path', async () => {
    coordinator.activate.mockResolvedValue(undefined);
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });

    await setup(PASSWORD, USER_ID);
    expect(isUnlocked()).toBe(true);

    // Setup installed the at-rest key on the main-thread store (non-null call).
    expect(mlsGroupStore.setAtRestKey).toHaveBeenCalledWith(expect.anything());

    // The history key (3rd unlock-material key) is threaded the same way —
    // installed (non-null) on the unlock path so the Saved-history archive can write
    // under it, and read back as non-null while unlocked.
    expect(mlsGroupStore.setHistoryKey).toHaveBeenCalledWith(expect.anything());
    expect(mlsGroupStore.getHistoryKey()).not.toBeNull();

    mlsGroupStore.setAtRestKey.mockClear();
    mlsGroupStore.setHistoryKey.mockClear();
    lock();

    // The worker-path deactivate() only scrubs the worker clone; lock() must
    // explicitly null the main-thread at-rest key, or the main thread retains the
    // capability to AES-256-GCM-decrypt persisted MLS state after lock/logout.
    expect(mlsGroupStore.setAtRestKey).toHaveBeenCalledWith(null);
    // lock() must drop the history key everywhere it drops the at-rest key.
    expect(mlsGroupStore.setHistoryKey).toHaveBeenCalledWith(null);
    expect(mlsGroupStore.getHistoryKey()).toBeNull();
    expect(isUnlocked()).toBe(false);
  });
});

describe('dmKeyManager: recover() reconciles classifications before unlocking', () => {
  it('recover() awaits reconcileChannelClassifications BEFORE _isUnlocked flips (no silent legacy-downgrade window on the recovery path)', async () => {
    coordinator.activate.mockResolvedValue(undefined);

    // Run a real setup() to obtain a genuine recovery blob/nonce + recovery key to
    // round-trip through recover() (mirrors dmKeyManagerRecoverSigningKey.test.ts).
    let recoveryBlob = '';
    let recoveryNonce = '';
    let pubKey = '';
    let blobSalt = '';
    apiClient.setupDmKeys.mockImplementation(async (a: {
      publicKey: string; blobSalt: string; recoveryBlob: string; recoveryNonce: string;
    }) => {
      pubKey = a.publicKey; blobSalt = a.blobSalt;
      recoveryBlob = a.recoveryBlob; recoveryNonce = a.recoveryNonce;
      return { blobVersion: 1 };
    });
    const { recoveryKey } = await setup(PASSWORD, USER_ID);

    // Fresh state for the recover under test.
    reset();
    expect(isUnlocked()).toBe(false);
    coordinator.reconcileChannelClassifications.mockClear();

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: pubKey,
      encryptedBlob: 'unused-by-recover',
      blobSalt,
      blobVersion: 5,
      recoveryBlob,
      recoveryNonce,
      recoveryMode: 'key',
      passwordDerived: false,
    });
    apiClient.recoverDmKeys.mockResolvedValue({ blobVersion: 6 });

    // Ordering capture: record whether reconcile had already resolved at the moment
    // 'unlocked' is emitted (i.e. when _isUnlocked flipped). Reconcile must be
    // AWAITED before the flip, so this flag MUST be true when the emit fires.
    let reconcileResolved = false;
    coordinator.reconcileChannelClassifications.mockImplementation(async () => {
      reconcileResolved = true;
    });
    let reconcileResolvedAtUnlockedEmit: boolean | null = null;
    let isUnlockedAtUnlockedEmit: boolean | null = null;
    const off = on((e) => {
      if (e === 'unlocked') {
        reconcileResolvedAtUnlockedEmit = reconcileResolved;
        isUnlockedAtUnlockedEmit = isUnlocked();
      }
    });

    try {
      await recover(recoveryKey, 'new-password');
    } finally {
      off();
    }

    expect(isUnlocked()).toBe(true);
    // Reconcile ran exactly once and was awaited before the unlock flipped.
    expect(coordinator.reconcileChannelClassifications).toHaveBeenCalledTimes(1);
    expect(isUnlockedAtUnlockedEmit).toBe(true);
    expect(reconcileResolvedAtUnlockedEmit).toBe(true);
  }, 30000);
});

describe('dmKeyManager per-device identity: recover() mints a FRESH device-local identity under the new at-rest key', () => {
  it('recover() with no readable local identity mints one device-local (putIdentity once) and publishes its KeyPackages', async () => {
    coordinator.activate.mockResolvedValue(undefined);

    // Run a real setup() to obtain a genuine recovery blob/nonce + recovery key.
    let recoveryBlob = '';
    let recoveryNonce = '';
    let pubKey = '';
    let blobSalt = '';
    apiClient.setupDmKeys.mockImplementation(async (a: {
      publicKey: string; blobSalt: string; recoveryBlob: string; recoveryNonce: string;
    }) => {
      pubKey = a.publicKey; blobSalt = a.blobSalt;
      recoveryBlob = a.recoveryBlob; recoveryNonce = a.recoveryNonce;
      return { blobVersion: 1 };
    });
    const { recoveryKey } = await setup(PASSWORD, USER_ID);

    // Fresh state for the recover under test, and clear setup()'s MLS calls so the
    // assertions only observe recover()'s mint/publish behavior.
    reset();
    expect(isUnlocked()).toBe(false);
    mlsGroupStore.putIdentity.mockClear();
    mlsClient.publishKeyPackages.mockClear();
    coordinator.activate.mockClear();
    identity.mintLeafKeypair.mockClear();
    identity.buildCrossSignedCredentialIdentity.mockClear();

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: pubKey,
      encryptedBlob: 'unused-by-recover',
      blobSalt,
      blobVersion: 5,
      recoveryBlob,
      recoveryNonce,
      recoveryMode: 'key',
      passwordDerived: false,
    });
    apiClient.recoverDmKeys.mockResolvedValue({ blobVersion: 6 });

    // recover rotates the at-rest key; the OLD device-local record is unreadable
    // under the NEW key, so getIdentity resolves null → recover must MINT a fresh
    // identity under the new at-rest key. resolveUserId(undefined) falls back to
    // dmEncryption.getCurrentUserId(); make it resolvable so the mint path runs.
    mlsGroupStore.getIdentity.mockResolvedValue(null);
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await recover(recoveryKey, 'new-password');
    expect(isUnlocked()).toBe(true);

    // Two-phase: a fresh device-local identity is persisted TWICE under the new
    // at-rest key — leaf-only at mint, then cross-signed — and its initial
    // KeyPackages are published once (on the cross-sign) so peers can Add this device.
    expect(mlsGroupStore.putIdentity).toHaveBeenCalledTimes(2);
    expect(identity.mintLeafKeypair).toHaveBeenCalledTimes(1);
    expect(identity.buildCrossSignedCredentialIdentity).toHaveBeenCalledTimes(1);
    expect(mlsClient.publishKeyPackages).toHaveBeenCalledTimes(1);
    // MLS was activated with the freshly-minted identity (truthy sig + deviceId).
    // getMlsSignaturePublicKey/getMlsDeviceId were removed; the activate()
    // bundle is the surviving observable they mirrored.
    expect(coordinator.activate).toHaveBeenCalledTimes(1);
    const actBundle = coordinator.activate.mock.calls.at(-1)![0];
    expect(actBundle.identity.signaturePublicKey).toBeTruthy();
    expect(actBundle.deviceId).toBeTruthy();
  }, 30000);
});

describe('dmKeyManager: auto-recover MLS after a sibling tab tore down the shared worker', () => {
  it("re-activates MLS on an UNEXPECTED 'mls-locked' while this tab is still unlocked (sibling tab idle-locked the shared worker)", async () => {
    coordinator.activate.mockResolvedValue(undefined);
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });

    await setup(PASSWORD, USER_ID);
    expect(isUnlocked()).toBe(true);
    // Setup activated MLS once and installed the at-rest key on the per-tab store.
    expect(coordinator.activate).toHaveBeenCalledTimes(1);
    expect(mlsGroupStore.getAtRestKey()).toBeTruthy();

    coordinator.activate.mockClear();

    // A SIBLING tab's idle-lock tore down the shared worker; the worker host
    // broadcasts 'mls-locked' to every tab. THIS tab is still unlocked, so it must
    // auto-recover by re-activating MLS under its own identity + retained at-rest key.
    emitMlsEvent('mls-locked');
    await flush();

    expect(coordinator.activate).toHaveBeenCalledTimes(1);
    // Re-activation used the still-held at-rest key (2nd positional arg).
    expect(coordinator.activate.mock.calls[0][1]).toBe(mlsGroupStore.getAtRestKey());
  });

  it("does NOT re-activate on an 'mls-locked' that THIS tab initiated via lock() (self-trigger guard)", async () => {
    coordinator.activate.mockResolvedValue(undefined);
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });

    await setup(PASSWORD, USER_ID);
    expect(isUnlocked()).toBe(true);
    coordinator.activate.mockClear();

    // Our own lock(): sets _isUnlocked=false synchronously, then deactivates MLS.
    // The resulting broadcast 'mls-locked' must NOT resurrect the vault we just locked.
    lock();
    expect(isUnlocked()).toBe(false);

    emitMlsEvent('mls-locked');
    await flush();

    expect(coordinator.activate).not.toHaveBeenCalled();
  });

  it("does not loop: a single in-flight recovery dedups concurrent 'mls-locked' bursts", async () => {
    // Keep the recovery activation pending so the _autoRecovering latch is held
    // across a burst of duplicate 'mls-locked' events.
    let resolveActivate: (() => void) | undefined;
    coordinator.activate.mockImplementationOnce(() => Promise.resolve()); // setup()
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });
    await setup(PASSWORD, USER_ID);
    expect(isUnlocked()).toBe(true);
    coordinator.activate.mockClear();

    coordinator.activate.mockImplementation(() => new Promise<void>((res) => { resolveActivate = () => res(); }));

    emitMlsEvent('mls-locked');
    emitMlsEvent('mls-locked');
    emitMlsEvent('mls-locked');
    await flush();

    // Only ONE recovery despite three events (anti-flap latch).
    expect(coordinator.activate).toHaveBeenCalledTimes(1);

    // After the in-flight recovery settles, a fresh 'mls-locked' can recover again.
    resolveActivate?.();
    await flush();
    emitMlsEvent('mls-locked');
    await flush();
    expect(coordinator.activate).toHaveBeenCalledTimes(2);

    // Settle the 2nd recovery too so the module-level _autoRecovering latch is
    // cleared (its .finally fires) and does not leak into later tests in this file.
    resolveActivate?.();
    await flush();
  });

  it("resets the _autoRecovering latch via .finally even when the recovery activate() REJECTS, so a later 'mls-locked' still recovers", async () => {
    coordinator.activate.mockImplementationOnce(() => Promise.resolve()); // setup()
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });
    await setup(PASSWORD, USER_ID);
    expect(isUnlocked()).toBe(true);
    coordinator.activate.mockClear();

    // First auto-recovery REJECTS. The handler swallows it in .catch() (no throw
    // escapes) and the .finally() MUST still clear the _autoRecovering latch.
    coordinator.activate.mockRejectedValueOnce(new Error('worker init RPC failed'));
    emitMlsEvent('mls-locked');
    await flush();

    // Recovery was attempted and the rejection was handled gracefully.
    expect(coordinator.activate).toHaveBeenCalledTimes(1);

    // A later 'mls-locked' must recover AGAIN. This only happens if .finally reset
    // the latch despite the prior rejection; otherwise _autoRecovering stays true
    // and this second event is dropped at the dedup guard.
    coordinator.activate.mockResolvedValueOnce(undefined);
    emitMlsEvent('mls-locked');
    await flush();
    expect(coordinator.activate).toHaveBeenCalledTimes(2);
  });
});
