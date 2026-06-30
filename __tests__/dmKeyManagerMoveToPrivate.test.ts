// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * MLS move-to-Private key rotation - shared test harness.
 *
 * When a user moves from Server recovery to Private, the three secrets the
 * escrow exposed (archiveKey, X25519 box key, Ed25519 signing key) are rotated
 * and the server DM-history archive is cleared / re-synced. This file is the
 * canonical mock harness reused by every move-to-Private task. It is modeled on
 * dmKeyManagerArchiveKey.test.ts (real dmCrypto, mocked MLS leaves + network),
 * with extra mocks for the history syncer + locks that the rotation code paths
 * touch.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import {
  deriveUnlockMaterial,
  parseRecoveryKey,
  decryptRecoveryBlob,
  type BlobContents,
} from '../services/dmCrypto';
import { fromBase64, toBase64 } from '../services/cryptoHelpers';

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
      createIdentity: vi.fn(),
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
      markAllHistoryUnsynced: vi.fn(() => Promise.resolve()),
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
      updateDmKeysBlob: vi.fn(),
      updateDmKeysRoamingIdentity: vi.fn(),
      getAikChain: vi.fn(async () => ({ chain: [], head: null })),
      deleteDmHistoryArchive: vi.fn(() => Promise.resolve({ deleted: 0 })),
      recoverDmKeys: vi.fn(),
      serverRecover: vi.fn(),
      changeDmKeysPassword: vi.fn(),
      enablePasswordDerived: vi.fn(),
      disablePasswordDerived: vi.fn(),
    },
  };
});

vi.mock('../services/mls/mlsIdentity', () => identity);
vi.mock('../services/mls/mlsClient', () => mlsClient);
vi.mock('../services/mls/mlsGroupStore', () => mlsGroupStore);
vi.mock('../services/mls/mlsCoordinator', () => coordinator);
vi.mock('../services/api', () => ({ apiClient }));
// Move-to-Private code paths drive the history syncer + lease; mock both.
// stopHistorySync MUST be present: lock()/reset() dynamically import it.
vi.mock('../services/mls/mlsHistoryArchiveSync', () => ({
  startHistorySync: vi.fn(),
  drainHistoryNow: vi.fn(),
  stopHistorySync: vi.fn(),
}));
vi.mock('../services/mls/mlsHistoryLocks', () => ({
  hasHistorySyncLease: vi.fn(() => true),
}));
// Move-to-Private restores the full active archive under the OLD key BEFORE the
// destructive re-seal, and the resync enumerates the active-channel set from previews;
// mock both (the real functions are integration-tested in mlsHistoryRestore.test.ts).
// Defaults = a complete restore + an empty active set so the rotation proceeds.
vi.mock('../services/mls/mlsHistoryRestore', () => ({
  restoreActiveArchiveForRotation: vi.fn(() => Promise.resolve({ ok: true, channelIds: [] })),
  getActiveArchiveChannelIds: vi.fn(() => Promise.resolve([])),
}));

import {
  setup, reset, lock, recover, getArchiveKey, getArchiveKeyVersion, isRekeyInProgress,
  getMinAcceptableArchiveKeyVersion,
  enablePasswordDerived, disablePasswordDerived, resumePendingRotation,
  getPublicKey,
  __test_pendingArchiveResync, __test_setPendingArchiveResync,
  setVoiceSessionActiveProbe, setVoiceSessionActiveFlag,
  __test_pendingIdentityRotation, __test_setPendingIdentityRotation,
  __test_isVoiceSessionActive,
} from '../services/dmKeyManager';
import * as histSync from '../services/mls/mlsHistoryArchiveSync';
import * as histRestore from '../services/mls/mlsHistoryRestore';
import { hasHistorySyncLease } from '../services/mls/mlsHistoryLocks';

const PASSWORD = 'correct horse battery staple';
const USER_ID = '11111111-1111-4111-8111-111111111111'; // UUID: the AIK rotation link signs over it
const MLS_SIG_PUB = new Uint8Array([10, 11, 12, 13]);
const MLS_SIG_PRIV = new Uint8Array([20, 21, 22, 23, 24, 25]);

beforeEach(() => {
  vi.clearAllMocks();
  // The pending-rotation flags persist in localStorage across tests in the same
  // jsdom env (lock()/reset() null only the in-memory copy). Clear BOTH up front so
  // a flag a prior disable-flow test left set can't drive a later test's resume.
  __test_setPendingArchiveResync(null);
  __test_setPendingIdentityRotation(null);
  setVoiceSessionActiveProbe(null);
  // Default the pre-rotation restore to a COMPLETE success + an empty active set so
  // archive-rotation tests proceed; the failure path overrides per-test. (clearAllMocks
  // keeps the impl, but be explicit so a per-test mockResolvedValueOnce can't bleed.)
  vi.mocked(histRestore.restoreActiveArchiveForRotation).mockResolvedValue({ ok: true, channelIds: [] });
  vi.mocked(histRestore.getActiveArchiveChannelIds).mockResolvedValue([]);

  identity.createIdentity.mockImplementation(async (userId: string, deviceId: string) => ({
    identity: {
      signaturePublicKey: new Uint8Array(MLS_SIG_PUB),
      signaturePrivateKey: new Uint8Array(MLS_SIG_PRIV),
      credentialIdentity: new TextEncoder().encode(`${userId}:${deviceId}`),
    },
    userId,
    deviceId,
  }));
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
  // Default the identity publish to a valid response so archive-focused
  // tests (which now also trigger the identity rotation in the disable tail) don't
  // throw on an unprimed mock. Identity-focused tests override this.
  apiClient.updateDmKeysRoamingIdentity.mockResolvedValue({ blobVersion: 5 });
});

/** Decrypt a packed encryptedBlob (base64(iv ‖ AES-GCM ct)) the way
 *  decryptBlobPacked does, given the password+salt and the AAD public key. */
async function decryptPackedBlob(encryptedBlob: string, password: string, blobSalt: string, publicKey: string): Promise<BlobContents> {
  const { blobKey } = await deriveUnlockMaterial(password, fromBase64(blobSalt));
  const packed = fromBase64(encryptedBlob);
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const aad = new TextEncoder().encode('howl:blob:' + publicKey);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    blobKey,
    ct,
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Run a real setup() and return everything needed to reconstruct/decrypt blobs. */
async function doSetup(): Promise<{
  publicKey: string;
  encryptedBlob: string;
  blobSalt: string;
  recoveryBlob: string;
  recoveryNonce: string;
  recoveryKey: string;
}> {
  let captured!: {
    publicKey: string; encryptedBlob: string; blobSalt: string;
    recoveryBlob: string; recoveryNonce: string;
  };
  apiClient.setupDmKeys.mockImplementation(async (a: typeof captured) => {
    captured = a;
    return { blobVersion: 1 };
  });
  (await import('../services/dmEncryption')).initializeEncryption(USER_ID);
  const { recoveryKey } = await setup(PASSWORD, USER_ID);
  return { ...captured, recoveryKey };
}

describe('Move-to-Private: archiveKeyVersion groundwork', () => {
  it('setup() stamps archiveKeyVersion=1 into the blob and getArchiveKeyVersion() reads 1', async () => {
    reset();
    const s = await doSetup();

    const fromEncrypted = await decryptPackedBlob(s.encryptedBlob, PASSWORD, s.blobSalt, s.publicKey);

    expect(getArchiveKey()).not.toBeNull();
    expect(getArchiveKeyVersion()).toBe(1);
    expect(fromEncrypted.archiveKey).toBeTruthy();
    expect(fromEncrypted.archiveKeyVersion).toBe(1);
  }, 30000);
});

describe('Move-to-Private: pending-archive-resync flag', () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });
  it('defaults null and round-trips the owning userId through localStorage + the test setter', () => {
    expect(__test_pendingArchiveResync()).toBeNull();
    __test_setPendingArchiveResync(USER_ID);
    expect(__test_pendingArchiveResync()).toBe(USER_ID);
    expect(localStorage.getItem('howl_e2e_pending_archive_resync')).toBe(USER_ID);
    __test_setPendingArchiveResync(null);
    expect(__test_pendingArchiveResync()).toBeNull();
    expect(localStorage.getItem('howl_e2e_pending_archive_resync')).toBeNull();
  });
});

describe('Move-to-Private: archive rotation in the disable tail', () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); __test_setPendingArchiveResync(null); });

  it('rotates archiveKey to v2, clears+resyncs the server archive, and never escrows the new key', async () => {
    const s = await doSetup();

    // Server-recovery mode: enable escrow before disabling, so the disable flow
    // runs its escrow-bearing step 1 (passwordDerived=true) and only flips false
    // right before the archive rotation.
    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    await enablePasswordDerived();

    const archiveBefore = Array.from(getArchiveKey()!);
    expect(getArchiveKeyVersion()).toBe(1);

    // Prime the disable-flow network mocks.
    apiClient.getDmKeyBundle.mockResolvedValue({
      blobVersion: 1,
      passwordDerived: true,
      encryptedBlob: s.encryptedBlob,
      blobSalt: s.blobSalt,
    });
    // changeDmKeysPassword is now called twice: the pre-rotation write + the atomic
    // recovery-blob rebuild that commits the rotated archiveKey to BOTH blobs at v2.
    let bv = 1;
    apiClient.changeDmKeysPassword.mockImplementation(async () => ({ blobVersion: ++bv }));
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 3 });
    apiClient.updateDmKeysRoamingIdentity.mockResolvedValue({ blobVersion: 7 });
    setVoiceSessionActiveProbe(() => false);

    await disablePasswordDerived('new private passphrase', USER_ID);

    // The rotation kicks the syncer via a dynamic import(); let the microtask resolve.
    await new Promise((r) => setTimeout(r, 0));

    // archiveKey rotated to a fresh value at version 2.
    const archiveAfter = Array.from(getArchiveKey()!);
    expect(archiveAfter).not.toEqual(archiveBefore);
    expect(getArchiveKeyVersion()).toBe(2);

    // Server archive cleared (carrying the rotated generation), local rows flipped
    // unsynced, syncer kicked - each once.
    expect(apiClient.deleteDmHistoryArchive).toHaveBeenCalledTimes(1);
    expect(apiClient.deleteDmHistoryArchive).toHaveBeenCalledWith(2);
    expect(mlsGroupStore.markAllHistoryUnsynced).toHaveBeenCalledTimes(1);
    expect(vi.mocked(histSync.drainHistoryNow)).toHaveBeenCalledTimes(1);

    // Every post-disable write carried NO escrow (the rotated secrets are never
    // escrowed): the v2 recovery-blob rebuild (last changeDmKeysPassword) and the
    // identity publish both omit rawBlobForEscrow.
    const cpCalls = apiClient.changeDmKeysPassword.mock.calls;
    expect(cpCalls[cpCalls.length - 1][0].rawBlobForEscrow).toBeUndefined();
    expect(apiClient.updateDmKeysRoamingIdentity.mock.calls[0][0].rawBlobForEscrow).toBeUndefined();

    // Cleanup confirmed; the resume flag is clear.
    expect(__test_pendingArchiveResync()).toBeNull();
  }, 30000);
});

describe('Move-to-Private: restore the full active archive under the OLD key before the destructive re-seal', () => {
  beforeEach(() => {
    reset(); vi.clearAllMocks(); __test_setPendingArchiveResync(null);
    vi.mocked(histRestore.restoreActiveArchiveForRotation).mockResolvedValue({ ok: true, channelIds: [] });
    vi.mocked(histRestore.getActiveArchiveChannelIds).mockResolvedValue([]);
  });

  async function primeDisable(s: Awaited<ReturnType<typeof doSetup>>): Promise<void> {
    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    await enablePasswordDerived();
    apiClient.getDmKeyBundle.mockResolvedValue({ blobVersion: 1, passwordDerived: true, encryptedBlob: s.encryptedBlob, blobSalt: s.blobSalt });
    let bv = 1; apiClient.changeDmKeysPassword.mockImplementation(async () => ({ blobVersion: ++bv }));
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 3 });
    apiClient.updateDmKeysRoamingIdentity.mockResolvedValue({ blobVersion: 7 });
    setVoiceSessionActiveProbe(() => false);
  }

  it('restores under the OLD key BEFORE deleting the server archive, and re-arms only active channels', async () => {
    const s = await doSetup();
    await primeDisable(s);
    vi.mocked(histRestore.restoreActiveArchiveForRotation).mockResolvedValue({ ok: true, channelIds: ['ch-a', 'ch-b'] });
    // The re-arm scopes to the SERVER-authoritative active set (previews), NOT the capped
    // client DM store - so a >50-channel user never loses history to the bulk delete.
    vi.mocked(histRestore.getActiveArchiveChannelIds).mockResolvedValue(['ch-a', 'ch-b']);

    await disablePasswordDerived('np restore-first', USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    // The pre-rotation restore ran exactly once...
    expect(histRestore.restoreActiveArchiveForRotation).toHaveBeenCalledTimes(1);
    // ...and BEFORE the destructive DELETE (no window where the server archive is gone
    // but the device has not yet pulled the full history under the old key).
    const restoreOrder = vi.mocked(histRestore.restoreActiveArchiveForRotation).mock.invocationCallOrder[0];
    const deleteOrder = apiClient.deleteDmHistoryArchive.mock.invocationCallOrder[0];
    expect(restoreOrder).toBeLessThan(deleteOrder);
    // The re-arm is scoped to the active set, and runs BEFORE the delete (a crash after it
    // still re-uploads via the normal syncer - no loss window).
    expect(mlsGroupStore.markAllHistoryUnsynced).toHaveBeenCalledWith(['ch-a', 'ch-b']);
    const markOrder = vi.mocked(mlsGroupStore.markAllHistoryUnsynced).mock.invocationCallOrder[0];
    expect(markOrder).toBeLessThan(deleteOrder);
    // The archive still rotated to v2.
    expect(getArchiveKeyVersion()).toBe(2);
  }, 30000);

  it('ABORTS the archive rotation (stays v1, no DELETE) when the pre-rotation restore is incomplete, but still returns the recovery key + rotates identity', async () => {
    const s = await doSetup();
    await primeDisable(s);
    vi.mocked(histRestore.restoreActiveArchiveForRotation).mockResolvedValue({ ok: false, channelIds: [] });

    const { recoveryKey } = await disablePasswordDerived('np restore-fail', USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    expect(recoveryKey).toBeTruthy();
    // Fail-closed: the archive is NOT rotated and the server archive is NOT wiped, so no
    // history can be lost to an incomplete re-upload. The user can retry move-to-Private.
    expect(getArchiveKeyVersion()).toBe(1);
    expect(apiClient.deleteDmHistoryArchive).not.toHaveBeenCalled();
    expect(mlsGroupStore.markAllHistoryUnsynced).not.toHaveBeenCalled();
    // The identity rotation is independent (no history dependency) and still happened.
    expect(apiClient.updateDmKeysRoamingIdentity).toHaveBeenCalledTimes(1);
  }, 30000);
});

describe('Move-to-Private: cross-tab archiveKey generation broadcast', () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); __test_setPendingArchiveResync(null); });

  it('the rotating tab broadcasts the new generation; getMinAcceptableArchiveKeyVersion is account-scoped', async () => {
    const s = await doSetup();

    // Server-recovery mode first, so the disable flow runs the Phase-1 rotation.
    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    await enablePasswordDerived();
    apiClient.getDmKeyBundle.mockResolvedValue({
      blobVersion: 1,
      passwordDerived: true,
      encryptedBlob: s.encryptedBlob,
      blobSalt: s.blobSalt,
    });
    apiClient.changeDmKeysPassword.mockResolvedValue({ blobVersion: 2 });
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 3 });
    apiClient.updateDmKeysBlob.mockResolvedValue({ blobVersion: 3 });

    // Before the rotation: no broadcast yet -> the floor is 1.
    expect(getMinAcceptableArchiveKeyVersion(USER_ID)).toBe(1);

    await disablePasswordDerived('np broadcast', USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    // The rotating tab bumped the archiveKey to v2 and broadcast that generation,
    // so a sibling tab on this account must seal/upload at >= v2 (fail-close below it).
    expect(getArchiveKeyVersion()).toBe(2);
    expect(getMinAcceptableArchiveKeyVersion(USER_ID)).toBe(2);
    expect(localStorage.getItem('howl_e2e_archive_min_version')).toBe(`${USER_ID}:2`);

    // Account-scoped: a DIFFERENT account never inherits this floor.
    expect(getMinAcceptableArchiveKeyVersion('other-user')).toBe(1);
  }, 30000);
});

describe('Move-to-Private: crash-resume of an interrupted archive rotation', () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); __test_setPendingArchiveResync(null); });

  it('resumePendingRotation() re-runs the idempotent cleanup WITHOUT re-minting when the durable blob is already v2', async () => {
    const s = await doSetup();

    // Drive a full disable so the archiveKey is already rotated to v2.
    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    await enablePasswordDerived();
    apiClient.getDmKeyBundle.mockResolvedValue({
      blobVersion: 1,
      passwordDerived: true,
      encryptedBlob: s.encryptedBlob,
      blobSalt: s.blobSalt,
    });
    apiClient.changeDmKeysPassword.mockResolvedValue({ blobVersion: 2 });
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 3 });
    apiClient.updateDmKeysBlob.mockResolvedValue({ blobVersion: 3 });

    await disablePasswordDerived('new private passphrase', USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    expect(getArchiveKeyVersion()).toBe(2);
    const keyAfter = Array.from(getArchiveKey()!);

    // Simulate a dangling crash flag + reset counters; re-prime the resume path's mocks.
    __test_setPendingArchiveResync(USER_ID);
    vi.clearAllMocks();
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 0 });

    await resumePendingRotation(USER_ID);
    // The cleanup kicks the syncer via a dynamic import(); let the microtask resolve.
    await new Promise((r) => setTimeout(r, 0));

    // No re-mint: version stays 2 and the key bytes are unchanged.
    expect(getArchiveKeyVersion()).toBe(2);
    expect(Array.from(getArchiveKey()!)).toEqual(keyAfter);

    // The idempotent cleanup ran exactly once each.
    expect(apiClient.deleteDmHistoryArchive).toHaveBeenCalledTimes(1);
    expect(mlsGroupStore.markAllHistoryUnsynced).toHaveBeenCalledTimes(1);
    expect(vi.mocked(histSync.drainHistoryNow)).toHaveBeenCalledTimes(1);

    // Cleanup confirmed; the resume flag is clear again.
    expect(__test_pendingArchiveResync()).toBeNull();
  }, 30000);
});

describe('Move-to-Private: re-enabling Server recovery clears a stale pending-identity-rotation flag', () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); __test_setPendingIdentityRotation(null); });

  it('enablePasswordDerived() clears _pendingIdentityRotation so resume cannot wedge on the passwordDerived guard', async () => {
    await doSetup();
    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    // A prior Self recover() sets this flag; if the user then re-enables Server recovery,
    // a leftover flag would make every resume throw "Refusing identity rotation while
    // passwordDerived=true" forever.
    __test_setPendingIdentityRotation(USER_ID);
    expect(__test_pendingIdentityRotation()).toBe(USER_ID);

    await enablePasswordDerived();

    expect(__test_pendingIdentityRotation()).toBeNull();
  });
});

describe('Move-to-Private: pending-identity-rotation flag + voice-session probe', () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); setVoiceSessionActiveProbe(null); });

  it('identity flag defaults null and round-trips the owning userId through localStorage + the test setter', () => {
    expect(__test_pendingIdentityRotation()).toBeNull();
    __test_setPendingIdentityRotation(USER_ID);
    expect(__test_pendingIdentityRotation()).toBe(USER_ID);
    expect(localStorage.getItem('howl_e2e_pending_identity_rotation')).toBe(USER_ID);
    __test_setPendingIdentityRotation(null);
    expect(__test_pendingIdentityRotation()).toBeNull();
    expect(localStorage.getItem('howl_e2e_pending_identity_rotation')).toBeNull();
  });

  it('isVoiceSessionActive reflects the registered probe and survives a throwing probe', () => {
    // No probe registered -> false.
    expect(__test_isVoiceSessionActive()).toBe(false);

    setVoiceSessionActiveProbe(() => true);
    expect(__test_isVoiceSessionActive()).toBe(true);

    setVoiceSessionActiveProbe(() => false);
    expect(__test_isVoiceSessionActive()).toBe(false);

    // A probe that throws is caught and reported as not-active (fail-safe).
    setVoiceSessionActiveProbe(() => { throw new Error('probe boom'); });
    expect(__test_isVoiceSessionActive()).toBe(false);
  });
});

/** Prime the disable-flow network mocks (escrow on, then disable to Private),
 *  shared by the quiesce + sticky-version tests. Mirrors the archive-rotation test setup. */
function primeDisableMocks(s: { encryptedBlob: string; blobSalt: string }): void {
  apiClient.enablePasswordDerived.mockResolvedValue(undefined);
  apiClient.getDmKeyBundle.mockResolvedValue({
    blobVersion: 1,
    passwordDerived: true,
    encryptedBlob: s.encryptedBlob,
    blobSalt: s.blobSalt,
  });
  apiClient.changeDmKeysPassword.mockResolvedValue({ blobVersion: 2 });
  apiClient.disablePasswordDerived.mockResolvedValue(undefined);
  apiClient.updateDmKeysBlob.mockResolvedValue({ blobVersion: 3 });
}

describe('Move-to-Private: syncer quiesced across the rotation', () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); __test_setPendingArchiveResync(null); });

  it('isRekeyInProgress() is true during the archive delete and clears after the rotation', async () => {
    const s = await doSetup();
    primeDisableMocks(s);
    await enablePasswordDerived();

    // Capture isRekeyInProgress() at the moment the rotation deletes the archive:
    // that delete runs INSIDE the mint->persist->delete->markUnsynced quiesce window.
    let rekeyDuringDelete: boolean | undefined;
    apiClient.deleteDmHistoryArchive.mockImplementation(async () => {
      rekeyDuringDelete = isRekeyInProgress();
      return { deleted: 0 };
    });

    await disablePasswordDerived('np quiesce', USER_ID);
    // The rotation kicks the syncer via a dynamic import(); let the microtask resolve.
    await new Promise((r) => setTimeout(r, 0));

    expect(rekeyDuringDelete).toBe(true);          // syncer was paused during the rotation
    expect(isRekeyInProgress()).toBe(false);       // and resumed after
  }, 30000);
});

describe('Move-to-Private: archiveKeyVersion is not a sticky global', () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); __test_setPendingArchiveResync(null); });

  it('reset() and a fresh setup() reset archiveKeyVersion to 1 after a rotate-to-v2', async () => {
    const s = await doSetup();
    primeDisableMocks(s);
    await enablePasswordDerived();
    await disablePasswordDerived('np sticky', USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    // The disable flow rotated the archive key to v2.
    expect(getArchiveKeyVersion()).toBe(2);

    // reset() must clear the sticky global back to 1.
    reset();
    expect(getArchiveKeyVersion()).toBe(1);

    // A fresh setup() on the same module must STAMP version 1 into its blob, not
    // inherit a stale 2 (which would make this account silently skip its own
    // move-to-Private rotation later).
    const s2 = await doSetup();
    const blob2 = await decryptPackedBlob(s2.encryptedBlob, PASSWORD, s2.blobSalt, s2.publicKey);
    expect(blob2.archiveKeyVersion).toBe(1);
    expect(getArchiveKeyVersion()).toBe(1);
  }, 30000);

  it('lock() resets archiveKeyVersion to 1 after a rotate-to-v2', async () => {
    const s = await doSetup();
    primeDisableMocks(s);
    await enablePasswordDerived();
    await disablePasswordDerived('np lock', USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    expect(getArchiveKeyVersion()).toBe(2);
    lock();
    expect(getArchiveKeyVersion()).toBe(1);
  }, 30000);
});

describe('Move-to-Private: pending flag is account-scoped', () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); __test_setPendingArchiveResync(null); });
  it('resumePendingRotation(currentUser) ignores a flag owned by a DIFFERENT account', async () => {
    // unlock the vault as USER_ID via a full setup (so resume's _isUnlocked/_derivedKey are satisfied)
    await doSetup();
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 0 });
    // a crash-orphaned flag from another account lingers in localStorage:
    __test_setPendingArchiveResync('some-other-user');
    await resumePendingRotation(USER_ID);
    expect(apiClient.deleteDmHistoryArchive).not.toHaveBeenCalled();   // no-op for the bystander account
    expect(__test_pendingArchiveResync()).toBe('some-other-user');      // and the other account's flag is left intact for IT to resume
    // The matching-account positive resync path is covered by the crash-resume and the
    // lease-holder adopt tests (resume never re-mints v2 here, by design).
  }, 30000);
});

describe('Move-to-Private: roaming-identity rotation in the disable tail', () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
    __test_setPendingArchiveResync(null);
    __test_setPendingIdentityRotation(null);
    setVoiceSessionActiveProbe(null);
  });

  it('rotates identity + publishes NEW pubkeys when NOT in a voice/stage session', async () => {
    const s = await doSetup();
    const pubBefore = getPublicKey();
    expect(pubBefore).toBe(s.publicKey);

    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    await enablePasswordDerived();

    apiClient.getDmKeyBundle.mockResolvedValue({
      blobVersion: 1,
      passwordDerived: true,
      encryptedBlob: s.encryptedBlob,
      blobSalt: s.blobSalt,
    });
    // Capture the NEW blobSalt the disable flow re-derives for the new passphrase.
    let newBlobSalt: string | undefined;
    apiClient.changeDmKeysPassword.mockImplementation(async (a: { blobSalt: string }) => {
      newBlobSalt = a.blobSalt;
      return { blobVersion: 2 };
    });
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 3 });
    apiClient.updateDmKeysBlob.mockResolvedValue({ blobVersion: 3 });

    // Capture the roaming-identity publish.
    let idArgs: { publicKey: string; signingPublicKey: string; encryptedBlob: string; blobVersion: number; rawBlobForEscrow?: string } | undefined;
    apiClient.updateDmKeysRoamingIdentity.mockImplementation(async (a: typeof idArgs) => {
      idArgs = a;
      return { blobVersion: 5 };
    });

    // NOT in a voice/stage session -> rotation runs inline.
    setVoiceSessionActiveProbe(() => false);

    const NEW_PASSPHRASE = 'new private passphrase';
    await disablePasswordDerived(NEW_PASSPHRASE, USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    // Published exactly once, with a NEW X25519 public key (the identity rotated).
    expect(apiClient.updateDmKeysRoamingIdentity).toHaveBeenCalledTimes(1);
    expect(idArgs).toBeDefined();
    expect(idArgs!.publicKey).not.toBe(pubBefore);
    expect(getPublicKey()).toBe(idArgs!.publicKey);

    // The re-sealed blob decrypts under the NEW passphrase's salt + the NEW pubkey AAD.
    expect(newBlobSalt).toBeDefined();
    const blob = await decryptPackedBlob(idArgs!.encryptedBlob, NEW_PASSPHRASE, newBlobSalt!, idArgs!.publicKey);
    expect(blob.privateKey).toBeTruthy();

    // Private mode -> no escrow rides the publish.
    expect(idArgs!.rawBlobForEscrow).toBeUndefined();

    // Pending flag cleared on success.
    expect(__test_pendingIdentityRotation()).toBeNull();
  }, 30000);

  it('DEFERS identity rotation during a voice/stage session, then completes on resume', async () => {
    const s = await doSetup();

    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    await enablePasswordDerived();

    apiClient.getDmKeyBundle.mockResolvedValue({
      blobVersion: 1,
      passwordDerived: true,
      encryptedBlob: s.encryptedBlob,
      blobSalt: s.blobSalt,
    });
    apiClient.changeDmKeysPassword.mockResolvedValue({ blobVersion: 2 });
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 0 });
    apiClient.updateDmKeysBlob.mockResolvedValue({ blobVersion: 3 });

    let idArgs: { publicKey: string; blobVersion: number } | undefined;
    apiClient.updateDmKeysRoamingIdentity.mockImplementation(async (a: typeof idArgs) => {
      idArgs = a;
      return { blobVersion: 5 };
    });

    // In a voice/stage session -> rotation must DEFER.
    let inSession = true;
    setVoiceSessionActiveProbe(() => inSession);

    await disablePasswordDerived('np deferred', USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    // Not published; the flag is pending for THIS account.
    expect(apiClient.updateDmKeysRoamingIdentity).not.toHaveBeenCalled();
    expect(__test_pendingIdentityRotation()).toBe(USER_ID);

    // Session ends -> resume completes the rotation.
    inSession = false;
    await resumePendingRotation(USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    expect(apiClient.updateDmKeysRoamingIdentity).toHaveBeenCalledTimes(1);
    expect(idArgs).toBeDefined();
    expect(__test_pendingIdentityRotation()).toBeNull();
  }, 30000);
});

describe('Move-to-Private: the post-disable recovery blob carries the rotated secrets', () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
    __test_setPendingArchiveResync(null);
    __test_setPendingIdentityRotation(null);
    setVoiceSessionActiveProbe(null);
  });

  it('the LAST changeDmKeysPassword recovery blob holds the rotated archiveKey (v2) + rotated identity', async () => {
    const s = await doSetup();
    const idBefore = getPublicKey();

    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    await enablePasswordDerived();

    apiClient.getDmKeyBundle.mockResolvedValue({
      blobVersion: 1,
      passwordDerived: true,
      encryptedBlob: s.encryptedBlob,
      blobSalt: s.blobSalt,
    });
    // Both changeDmKeysPassword calls (pre-rotation + rebuild) must resolve. Hand back an
    // incrementing blobVersion so the CAS in _rebuildRecoveryBlob converges.
    let bv = 1;
    apiClient.changeDmKeysPassword.mockImplementation(async () => ({ blobVersion: ++bv }));
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 3 });
    apiClient.updateDmKeysBlob.mockResolvedValue({ blobVersion: 3 });
    apiClient.updateDmKeysRoamingIdentity.mockResolvedValue({ blobVersion: 7 });

    // NOT in a voice/stage session -> identity rotation runs inline, so the
    // rebuilt recovery blob must capture the ROTATED identity, not just the v2 key.
    setVoiceSessionActiveProbe(() => false);

    const { recoveryKey } = await disablePasswordDerived('np part1', USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    // changeDmKeysPassword was called twice: the pre-rotation blob and the
    // rotated blob. Assert on the LAST call's recovery blob.
    const calls = apiClient.changeDmKeysPassword.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const last = calls[calls.length - 1][0];

    const recBytes = parseRecoveryKey(recoveryKey);
    const aad = 'howl:recovery:v1:' + getPublicKey();
    const recovered = await decryptRecoveryBlob(last.recoveryBlob, last.recoveryNonce, recBytes, aad);

    // v2 archiveKey rode the recovery blob, and it matches the live rotated key:
    expect(recovered.archiveKeyVersion).toBe(2);
    expect(recovered.archiveKey).toBe(toBase64(getArchiveKey()!));

    // Identity rotated: the recovery blob carries the rotated private key, and the
    // recovered public key matches the live (rotated) identity, not the pre-rotation one.
    expect(recovered.privateKey).toBeTruthy();
    const recPub = toBase64(
      (await import('tweetnacl')).default.box.keyPair.fromSecretKey(fromBase64(recovered.privateKey)).publicKey,
    );
    expect(recPub).toBe(getPublicKey());
    expect(recPub).not.toBe(idBefore);
  }, 30000);

  it('a recovery-blob rebuild failure does NOT swallow the recovery key', async () => {
    const s = await doSetup();

    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    await enablePasswordDerived();

    apiClient.getDmKeyBundle.mockResolvedValue({
      blobVersion: 1,
      passwordDerived: true,
      encryptedBlob: s.encryptedBlob,
      blobSalt: s.blobSalt,
    });
    // The pre-rotation write succeeds; the rebuild (2nd call) throws hard (non-409).
    let call = 0;
    apiClient.changeDmKeysPassword.mockImplementation(async () => {
      call += 1;
      if (call >= 2) throw Object.assign(new Error('boom'), { status: 500 });
      return { blobVersion: 2 };
    });
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 0 });
    apiClient.updateDmKeysBlob.mockResolvedValue({ blobVersion: 3 });
    apiClient.updateDmKeysRoamingIdentity.mockResolvedValue({ blobVersion: 7 });
    setVoiceSessionActiveProbe(() => false);

    const { recoveryKey } = await disablePasswordDerived('np rebuild-fail', USER_ID);
    expect(recoveryKey).toBeTruthy();
    expect(recoveryKey.length).toBeGreaterThan(0);
  }, 30000);
});

describe('Move-to-Private: a Self-mode recover schedules an identity re-rotation', () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
    __test_setPendingArchiveResync(null);
    __test_setPendingIdentityRotation(null);
    setVoiceSessionActiveProbe(null);
  });

  /** Build a Self-recovery getDmKeyBundle mock from a real setup()'s recovery blob. */
  function primeRecoverBundle(s: Awaited<ReturnType<typeof doSetup>>, passwordDerived: boolean): void {
    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: s.publicKey,
      encryptedBlob: 'unused-by-recover',
      blobSalt: s.blobSalt,
      blobVersion: 5,
      recoveryBlob: s.recoveryBlob,
      recoveryNonce: s.recoveryNonce,
      recoveryMode: 'key',
      passwordDerived,
    });
    apiClient.recoverDmKeys.mockResolvedValue({ blobVersion: 6 });
    apiClient.updateDmKeysSigningKey.mockResolvedValue({ blobVersion: 7 });
  }

  it('a Self-mode recover() sets the pending identity-rotation flag to the recovered user', async () => {
    const s = await doSetup();
    lock();
    primeRecoverBundle(s, /* passwordDerived */ false);
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    expect(__test_pendingIdentityRotation()).toBeNull();
    await recover(s.recoveryKey, 'a whole new password phrase');

    expect(__test_pendingIdentityRotation()).toBe(USER_ID);
  }, 30000);

  it('a Server-mode recover() does NOT set the pending identity-rotation flag', async () => {
    const s = await doSetup();
    lock();
    primeRecoverBundle(s, /* passwordDerived */ true);
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    expect(__test_pendingIdentityRotation()).toBeNull();
    await recover(s.recoveryKey, 'a whole new password phrase');

    // Server-recovery users remain escrow-readable; no identity re-rotation scheduled.
    expect(__test_pendingIdentityRotation()).toBeNull();
  }, 30000);
});

describe('Move-to-Private: a failed identity publish rolls back the in-memory identity', () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
    __test_setPendingArchiveResync(null);
    __test_setPendingIdentityRotation(null);
    setVoiceSessionActiveProbe(null);
  });

  it('a failed identity publish rolls back the in-memory identity so the rebuilt main blob stays decryptable under the durable publicKey', async () => {
    const s = await doSetup();
    const oldPub = getPublicKey();
    expect(oldPub).toBe(s.publicKey);

    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    await enablePasswordDerived();

    apiClient.getDmKeyBundle.mockResolvedValue({
      blobVersion: 1,
      passwordDerived: true,
      encryptedBlob: s.encryptedBlob,
      blobSalt: s.blobSalt,
    });
    // Capture the NEW blobSalt the disable re-derives + each blob the rebuild writes.
    let newBlobSalt: string | undefined;
    let lastChangeBlob: string | undefined;
    apiClient.changeDmKeysPassword.mockImplementation(async (a: { blobSalt: string; encryptedBlob: string }) => {
      newBlobSalt = a.blobSalt;
      lastChangeBlob = a.encryptedBlob;
      return { blobVersion: 2 };
    });
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 0 });
    apiClient.updateDmKeysBlob.mockResolvedValue({ blobVersion: 3 });

    // The roaming-identity publish (the ONLY write that updates the durable publicKey
    // column) fails hard (non-409). Without rollback, the in-memory pub is ahead of the
    // unchanged column, and _rebuildRecoveryBlob re-seals the main blob under the
    // unpublished NEW-pub -> the next normal unlock's OLD-pub AAD decrypt fails.
    apiClient.updateDmKeysRoamingIdentity.mockRejectedValue(
      Object.assign(new Error('boom'), { status: 500 }),
    );

    // NOT in a voice/stage session -> the identity rotation runs inline (and fails).
    setVoiceSessionActiveProbe(() => false);

    const NEW_PASSPHRASE = 'np rollback';
    // The disable is best-effort: it must STILL resolve and return a recovery key.
    const { recoveryKey } = await disablePasswordDerived(NEW_PASSPHRASE, USER_ID);
    await new Promise((r) => setTimeout(r, 0));
    expect(recoveryKey).toBeTruthy();

    // (b) The rotation failed, so the identity flag is still set for this account.
    expect(__test_pendingIdentityRotation()).toBe(USER_ID);

    // The in-memory identity rolled back to OLD so the live pubkey matches the
    // unpublished durable publicKey column.
    expect(getPublicKey()).toBe(oldPub);

    // (a) The LAST changeDmKeysPassword (the _rebuildRecoveryBlob) sealed the main
    // blob under the OLD/pre-disable pubkey AAD -> it decrypts under OLD-pub. Before
    // the fix it was sealed under the unpublished NEW-pub and this decrypt would throw.
    expect(newBlobSalt).toBeDefined();
    expect(lastChangeBlob).toBeDefined();
    const blob = await decryptPackedBlob(lastChangeBlob!, NEW_PASSPHRASE, newBlobSalt!, oldPub!);
    expect(blob.privateKey).toBeTruthy();
  }, 30000);
});

describe('Move-to-Private: resumePendingRotation is best-effort', () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
    __test_setPendingArchiveResync(null);
    __test_setPendingIdentityRotation(null);
    setVoiceSessionActiveProbe(null);
  });

  it('resumePendingRotation swallows a resync failure (no unhandled rejection) and leaves the flag set', async () => {
    const s = await doSetup();
    // Drive a full disable so the archiveKey is durably v2 (broadcast min=2), enabling a
    // matching resume to actually perform the destructive resync (resume never mints v2).
    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    await enablePasswordDerived();
    apiClient.getDmKeyBundle.mockResolvedValue({ blobVersion: 1, passwordDerived: true, encryptedBlob: s.encryptedBlob, blobSalt: s.blobSalt });
    let bv = 1;
    apiClient.changeDmKeysPassword.mockImplementation(async () => ({ blobVersion: ++bv }));
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 0 });
    apiClient.updateDmKeysRoamingIdentity.mockResolvedValue({ blobVersion: 7 });
    setVoiceSessionActiveProbe(() => false);
    await disablePasswordDerived('np besteffort', USER_ID);
    await new Promise((r) => setTimeout(r, 0));
    expect(getArchiveKeyVersion()).toBe(2);

    // Re-arm the flag and make the resync's DELETE fail transiently mid-resume.
    __test_setPendingArchiveResync(USER_ID);
    apiClient.deleteDmHistoryArchive.mockRejectedValue(
      Object.assign(new Error('offline'), { status: 503 }),
    );

    // Must NOT reject (best-effort), and must leave the flag set so a later safe boot retries.
    await expect(resumePendingRotation(USER_ID)).resolves.toBeUndefined();
    expect(__test_pendingArchiveResync()).toBe(USER_ID);
  }, 30000);
});

describe('Move-to-Private: the recovery blob reaches v2 BEFORE the server archive is deleted', () => {
  beforeEach(() => {
    reset(); vi.clearAllMocks();
    __test_setPendingArchiveResync(null); __test_setPendingIdentityRotation(null);
    setVoiceSessionActiveProbe(null);
    vi.mocked(hasHistorySyncLease).mockReturnValue(true);
  });

  it('rebuilds the recovery blob (v2) BEFORE deleteDmHistoryArchive, and the DELETE carries the rotated keyVersion', async () => {
    const s = await doSetup();
    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    await enablePasswordDerived();
    apiClient.getDmKeyBundle.mockResolvedValue({ blobVersion: 1, passwordDerived: true, encryptedBlob: s.encryptedBlob, blobSalt: s.blobSalt });
    let bv = 1;
    apiClient.changeDmKeysPassword.mockImplementation(async () => ({ blobVersion: ++bv }));
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    let deleteKeyVersion: number | undefined;
    apiClient.deleteDmHistoryArchive.mockImplementation(async (kv?: number) => { deleteKeyVersion = kv; return { deleted: 3 }; });
    apiClient.updateDmKeysRoamingIdentity.mockResolvedValue({ blobVersion: 7 });
    setVoiceSessionActiveProbe(() => false);

    await disablePasswordDerived('np high1-order', USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    // The recovery-blob rebuild is the LAST changeDmKeysPassword; it MUST commit
    // (durably, atomically with the main blob) before the destructive DELETE - else a
    // partial failure between them strands the recovery blob at v1 while the server
    // archive is v2, which silently loses ALL history on a later Self recover().
    const cpOrder = apiClient.changeDmKeysPassword.mock.invocationCallOrder;
    const delOrder = apiClient.deleteDmHistoryArchive.mock.invocationCallOrder;
    expect(cpOrder.length).toBeGreaterThanOrEqual(2);
    expect(delOrder.length).toBe(1);
    expect(cpOrder[cpOrder.length - 1]).toBeLessThan(delOrder[0]);

    // The DELETE carried the rotated generation so the server bumps its min-version floor.
    expect(getArchiveKeyVersion()).toBe(2);
    expect(deleteKeyVersion).toBe(2);
  }, 30000);

  it('ABORTS the server-archive delete + rolls the archiveKey back to v1 when the recovery-blob rebuild fails (no data-loss window), still returning the recovery key', async () => {
    const s = await doSetup();
    const archiveBefore = Array.from(getArchiveKey()!);
    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    await enablePasswordDerived();
    apiClient.getDmKeyBundle.mockResolvedValue({ blobVersion: 1, passwordDerived: true, encryptedBlob: s.encryptedBlob, blobSalt: s.blobSalt });
    // The pre-rotation write (1st changeDmKeysPassword) succeeds; the recovery rebuild (2nd) throws hard.
    let call = 0;
    apiClient.changeDmKeysPassword.mockImplementation(async () => {
      call += 1;
      if (call >= 2) throw Object.assign(new Error('boom'), { status: 500 });
      return { blobVersion: 2 };
    });
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 0 });
    apiClient.updateDmKeysRoamingIdentity.mockResolvedValue({ blobVersion: 7 });
    setVoiceSessionActiveProbe(() => false);

    const { recoveryKey } = await disablePasswordDerived('np high1-fail', USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    // The destructive resync NEVER ran (the recovery blob could not reach v2).
    expect(apiClient.deleteDmHistoryArchive).not.toHaveBeenCalled();
    expect(mlsGroupStore.markAllHistoryUnsynced).not.toHaveBeenCalled();
    // archiveKey rolled back to v1 so future uploads stay readable by the v1 recovery blob.
    expect(getArchiveKeyVersion()).toBe(1);
    expect(Array.from(getArchiveKey()!)).toEqual(archiveBefore);
    // The user still gets their recovery key, and nothing is owed to resume (resume
    // cannot rebuild the recovery blob without the ephemeral recovery key).
    expect(recoveryKey).toBeTruthy();
    expect(__test_pendingArchiveResync()).toBeNull();
  }, 30000);

  it('a LOST-ACK on the rebuild (commit landed, client threw) is detected via the durable blobVersion and STILL completes the resync (no torn v2-blobs/v1-archive)', async () => {
    const s = await doSetup();
    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    await enablePasswordDerived();
    // getDmKeyBundle reports a blobVersion FAR past the pre-rebuild value, so the catch
    // concludes the atomic commit DID land (lost ack) and keeps v2 + finishes the resync.
    apiClient.getDmKeyBundle.mockResolvedValue({ blobVersion: 99, passwordDerived: true, encryptedBlob: s.encryptedBlob, blobSalt: s.blobSalt });
    // The pre-rotation write (1st changeDmKeysPassword) succeeds; the recovery rebuild (2nd) throws as if
    // the ack was lost AFTER the server committed both blobs at v2.
    let call = 0;
    apiClient.changeDmKeysPassword.mockImplementation(async () => {
      call += 1;
      if (call >= 2) throw Object.assign(new Error('socket hang up'), {}); // no .status -> lost ack
      return { blobVersion: 2 };
    });
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 3 });
    apiClient.updateDmKeysRoamingIdentity.mockResolvedValue({ blobVersion: 7 });
    setVoiceSessionActiveProbe(() => false);

    const { recoveryKey } = await disablePasswordDerived('np lostack', USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    // The commit landed, so the archiveKey stays v2 and the destructive resync ran (server
    // archive now matches the durable v2 blobs - no silent loss on a later recover()).
    expect(getArchiveKeyVersion()).toBe(2);
    expect(apiClient.deleteDmHistoryArchive).toHaveBeenCalledWith(2);
    expect(mlsGroupStore.markAllHistoryUnsynced).toHaveBeenCalledTimes(1);
    expect(__test_pendingArchiveResync()).toBeNull();
    expect(recoveryKey).toBeTruthy();
  }, 30000);
});

describe('Move-to-Private: destructive archive resync is gated on the history-sync lease', () => {
  beforeEach(() => {
    reset(); vi.clearAllMocks();
    __test_setPendingArchiveResync(null); __test_setPendingIdentityRotation(null);
    setVoiceSessionActiveProbe(null);
    vi.mocked(hasHistorySyncLease).mockReturnValue(true);
  });

  it('disabling from a NON-lease tab commits v2 durably but does NOT delete the server archive inline; the resync is left owed', async () => {
    vi.mocked(hasHistorySyncLease).mockReturnValue(false);
    const s = await doSetup();
    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    await enablePasswordDerived();
    apiClient.getDmKeyBundle.mockResolvedValue({ blobVersion: 1, passwordDerived: true, encryptedBlob: s.encryptedBlob, blobSalt: s.blobSalt });
    let bv = 1;
    apiClient.changeDmKeysPassword.mockImplementation(async () => ({ blobVersion: ++bv }));
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 0 });
    apiClient.updateDmKeysRoamingIdentity.mockResolvedValue({ blobVersion: 7 });
    setVoiceSessionActiveProbe(() => false);

    await disablePasswordDerived('np high2-nonlease', USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    // v2 minted + committed durably (the recovery rebuild ran), so future privacy holds.
    expect(getArchiveKeyVersion()).toBe(2);
    // ... but the destructive resync did NOT run on this non-lease tab (it cannot drain).
    expect(apiClient.deleteDmHistoryArchive).not.toHaveBeenCalled();
    expect(mlsGroupStore.markAllHistoryUnsynced).not.toHaveBeenCalled();
    // The resync is owed; the lease-holding tab finishes it.
    expect(__test_pendingArchiveResync()).toBe(USER_ID);
  }, 30000);

  it('resume completes the owed resync once this v2-capable (disabling) tab acquires the lease', async () => {
    // Disable from a NON-lease tab: v2 is minted + committed durably, but the destructive
    // resync is left owed (this tab cannot drain without the lease).
    vi.mocked(hasHistorySyncLease).mockReturnValue(false);
    const s = await doSetup();
    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    await enablePasswordDerived();
    apiClient.getDmKeyBundle.mockResolvedValue({ blobVersion: 1, passwordDerived: true, encryptedBlob: s.encryptedBlob, blobSalt: s.blobSalt });
    let bv = 1;
    apiClient.changeDmKeysPassword.mockImplementation(async () => ({ blobVersion: ++bv }));
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 0 });
    apiClient.updateDmKeysRoamingIdentity.mockResolvedValue({ blobVersion: 7 });
    setVoiceSessionActiveProbe(() => false);

    await disablePasswordDerived('np handoff', USER_ID);
    await new Promise((r) => setTimeout(r, 0));
    expect(getArchiveKeyVersion()).toBe(2);
    expect(apiClient.deleteDmHistoryArchive).not.toHaveBeenCalled();
    expect(__test_pendingArchiveResync()).toBe(USER_ID);

    // The stale sibling released the lease; this v2-capable tab acquires it. resume (fired
    // from the lease-acquired continuation) finishes the resync under the rotated key.
    vi.mocked(hasHistorySyncLease).mockReturnValue(true);
    await resumePendingRotation(USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    expect(apiClient.deleteDmHistoryArchive).toHaveBeenCalledTimes(1);
    expect(apiClient.deleteDmHistoryArchive).toHaveBeenCalledWith(2);
    expect(mlsGroupStore.markAllHistoryUnsynced).toHaveBeenCalledTimes(1);
    expect(__test_pendingArchiveResync()).toBeNull();
  }, 30000);
});

describe('Move-to-Private: identity rotation is single-flighted by a cross-tab lock', () => {
  beforeEach(() => {
    reset(); vi.clearAllMocks();
    __test_setPendingArchiveResync(null); __test_setPendingIdentityRotation(null);
    setVoiceSessionActiveProbe(null);
    vi.mocked(hasHistorySyncLease).mockReturnValue(true);
  });
  afterEach(() => { try { delete (navigator as unknown as { locks?: unknown }).locks; } catch { /* ignore */ } });

  function primeIdentityDisable(s: { encryptedBlob: string; blobSalt: string }): void {
    apiClient.enablePasswordDerived.mockResolvedValue(undefined);
    apiClient.getDmKeyBundle.mockResolvedValue({ blobVersion: 1, passwordDerived: true, encryptedBlob: s.encryptedBlob, blobSalt: s.blobSalt });
    let bv = 1;
    apiClient.changeDmKeysPassword.mockImplementation(async () => ({ blobVersion: ++bv }));
    apiClient.disablePasswordDerived.mockResolvedValue(undefined);
    apiClient.deleteDmHistoryArchive.mockResolvedValue({ deleted: 0 });
    apiClient.updateDmKeysRoamingIdentity.mockResolvedValue({ blobVersion: 7 });
    setVoiceSessionActiveProbe(() => false);
  }

  it('requests the dedicated identity-rotation lock and BAILS (no second divergent publish) when a sibling already holds it', async () => {
    const s = await doSetup();
    await enablePasswordDerived();
    primeIdentityDisable(s);
    const requested: string[] = [];
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      // ifAvailable + held-by-sibling -> the callback receives null.
      request: vi.fn(async (name: string, _opts: unknown, cb: (l: unknown) => Promise<unknown>) => { requested.push(name); return cb(null); }),
    } });

    await disablePasswordDerived('np idlock-held', USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    expect(requested).toContain('howl-mls-identity-rotation');
    // The lock was held elsewhere, so THIS tab did not publish a new identity; the flag
    // stays set so the holder / a later resume completes it (no divergent double-publish).
    expect(apiClient.updateDmKeysRoamingIdentity).not.toHaveBeenCalled();
    expect(__test_pendingIdentityRotation()).toBe(USER_ID);
  }, 30000);

  it('rotates + publishes under the lock when it is granted', async () => {
    const s = await doSetup();
    await enablePasswordDerived();
    primeIdentityDisable(s);
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: vi.fn(async (_name: string, _opts: unknown, cb: (l: unknown) => Promise<unknown>) => cb({ mode: 'exclusive' })),
    } });

    await disablePasswordDerived('np idlock-granted', USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    expect(apiClient.updateDmKeysRoamingIdentity).toHaveBeenCalledTimes(1);
    expect(__test_pendingIdentityRotation()).toBeNull();
  }, 30000);
});

describe('Move-to-Private: cross-tab voice-session flag defers identity rotation account-wide', () => {
  beforeEach(() => {
    reset(); vi.clearAllMocks();
    setVoiceSessionActiveProbe(null);
    setVoiceSessionActiveFlag(null);
  });

  it('isVoiceSessionActive(userId) is true when a SIBLING tab stamped the account flag, even with the local probe false', () => {
    // Local probe says NOT in a session (this tab is idle)...
    setVoiceSessionActiveProbe(() => false);
    expect(__test_isVoiceSessionActive(USER_ID)).toBe(false);

    // ...but a sibling tab of THIS account is in a voice/stage call (cross-tab flag).
    setVoiceSessionActiveFlag(USER_ID);
    expect(__test_isVoiceSessionActive(USER_ID)).toBe(true);
    expect(localStorage.getItem('howl_e2e_voice_active')).toMatch(new RegExp(`^${USER_ID}:\\d+$`));

    // Account-scoped: a DIFFERENT account is NOT gated by this flag.
    expect(__test_isVoiceSessionActive('other-user')).toBe(false);

    // Cleared on leave.
    setVoiceSessionActiveFlag(null);
    expect(__test_isVoiceSessionActive(USER_ID)).toBe(false);
  });
});
