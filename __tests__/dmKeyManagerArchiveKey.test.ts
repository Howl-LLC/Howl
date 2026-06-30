// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Cross-device history archive — stable per-account archiveKey.
 *
 * The stable per-account `archiveKey` must:
 *  (a) be minted at setup() and ride BOTH the encryptedBlob and the recoveryBlob,
 *  (b) load (not regenerate / not re-upload) on an unlock() of a blob that already
 *      carries it,
 *  (c) be lazily minted + re-uploaded on an unlock() of a blob that predates the
 *      archive key,
 *  (d) be null after lock(),
 *  (e) survive recover() and serverRecover() byte-for-byte (loaded, not regenerated)
 *      and ride the re-uploaded blob.
 *
 * Modeled on dmKeyManagerServerRecoverMls.test.ts: real dmCrypto, mocked MLS
 * leaves + network. Assertions DECRYPT the captured blob args (recoveryBlob via
 * decryptRecoveryBlob, encryptedBlob via a re-derived blob key) and check the raw
 * 32-byte archiveKey, not just that a mock was called.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import {
  deriveUnlockMaterial,
  parseRecoveryKey,
  decryptRecoveryBlob,
  encryptRecoveryBlob,
  type BlobContents,
} from '../services/dmCrypto';
import { fromBase64 } from '../services/cryptoHelpers';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

// Mock the MLS leaf modules + network (real dmCrypto stays unmocked)
const { identity, mlsClient, mlsGroupStore, coordinator, apiClient, emitMls } = vi.hoisted(() => {
  const listeners = new Set<(e: 'mls-ready' | 'mls-locked') => void>();
  const mlsEvents = { on(cb: (e: 'mls-ready' | 'mls-locked') => void) { listeners.add(cb); return () => listeners.delete(cb); } };
  return {
    emitMls: (e: 'mls-ready' | 'mls-locked') => { for (const cb of listeners) cb(e); },
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
  setup, unlock, recover, serverRecover, lock, reset, getArchiveKey,
} from '../services/dmKeyManager';

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a whole new password phrase';
const USER_ID = 'user-alice';
const MLS_SIG_PUB = new Uint8Array([10, 11, 12, 13]);
const MLS_SIG_PRIV = new Uint8Array([20, 21, 22, 23, 24, 25]);

beforeEach(() => {
  vi.clearAllMocks();

  // Two-phase: boot mints a leaf-only keypair; setup/unlock cross-signs + publishes.
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

describe('stable archiveKey lifecycle', () => {
  it('(a) setup() mints a 32-byte archiveKey that rides BOTH the encryptedBlob and recoveryBlob', async () => {
    reset();
    const s = await doSetup();

    const fromEncrypted = await decryptPackedBlob(s.encryptedBlob, PASSWORD, s.blobSalt, s.publicKey);
    const fromRecovery = await decryptRecoveryBlob(s.recoveryBlob, s.recoveryNonce, parseRecoveryKey(s.recoveryKey), 'howl:recovery:v1:' + s.publicKey);

    expect(fromEncrypted.archiveKey).toBeTruthy();
    expect(fromRecovery.archiveKey).toBeTruthy();
    expect(fromBase64(fromEncrypted.archiveKey!).length).toBe(32);
    // Same key in both blobs.
    expect(fromRecovery.archiveKey).toBe(fromEncrypted.archiveKey);
    // And it matches the live in-memory key.
    expect(getArchiveKey()).not.toBeNull();
    expect(Array.from(getArchiveKey()!)).toEqual(Array.from(fromBase64(fromEncrypted.archiveKey!)));
  }, 30000);

  it('(b) unlock() of a blob WITH an archiveKey loads it without re-uploading', async () => {
    reset();
    const s = await doSetup();
    const setArchiveKey = Array.from(getArchiveKey()!);
    lock();
    expect(getArchiveKey()).toBeNull();

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: s.publicKey,
      encryptedBlob: s.encryptedBlob,
      blobSalt: s.blobSalt,
      blobVersion: 1,
      passwordDerived: false,
    });

    await unlock(PASSWORD);

    expect(getArchiveKey()).not.toBeNull();
    expect(Array.from(getArchiveKey()!)).toEqual(setArchiveKey); // SAME bytes
    expect(apiClient.updateDmKeysSigningKey).not.toHaveBeenCalled(); // no re-upload
  }, 30000);

  it('(c) unlock() of a blob predating the archiveKey mints one and re-uploads', async () => {
    reset();
    const s = await doSetup();
    lock();

    // Forge a blob predating the archiveKey: strip archiveKey, re-encrypt under the same blob key.
    const contents = await decryptPackedBlob(s.encryptedBlob, PASSWORD, s.blobSalt, s.publicKey);
    delete contents.archiveKey;
    const { blobKey } = await deriveUnlockMaterial(PASSWORD, fromBase64(s.blobSalt));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode('howl:blob:' + s.publicKey);
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      blobKey,
      new TextEncoder().encode(JSON.stringify(contents)),
    ));
    const packed = new Uint8Array(iv.length + ct.length);
    packed.set(iv, 0);
    packed.set(ct, iv.length);
    const preArchiveKeyBlob = btoa(String.fromCharCode(...packed));

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: s.publicKey,
      encryptedBlob: preArchiveKeyBlob,
      blobSalt: s.blobSalt,
      blobVersion: 1,
      passwordDerived: false,
    });
    let uploaded!: { encryptedBlob: string; blobVersion: number };
    apiClient.updateDmKeysSigningKey.mockImplementation(async (a: typeof uploaded) => { uploaded = a; return { blobVersion: 2 }; });

    await unlock(PASSWORD);

    // A fresh archiveKey was minted...
    expect(getArchiveKey()).not.toBeNull();
    expect(getArchiveKey()!.length).toBe(32);
    // ...and re-uploaded inside the re-persisted blob.
    expect(apiClient.updateDmKeysSigningKey).toHaveBeenCalledTimes(1);
    const reuploaded = await decryptPackedBlob(uploaded.encryptedBlob, PASSWORD, s.blobSalt, s.publicKey);
    expect(reuploaded.archiveKey).toBeTruthy();
    expect(Array.from(fromBase64(reuploaded.archiveKey!))).toEqual(Array.from(getArchiveKey()!));
  }, 30000);

  it('(d) getArchiveKey() is null after lock()', async () => {
    reset();
    await doSetup();
    expect(getArchiveKey()).not.toBeNull();
    lock();
    expect(getArchiveKey()).toBeNull();
  }, 30000);

  it('(e) recover() of a blob carrying archiveKey preserves the SAME bytes and re-uploads them', async () => {
    reset();
    const s = await doSetup();
    const setArchiveKey = Array.from(getArchiveKey()!);
    lock();

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: s.publicKey,
      encryptedBlob: 'unused-by-recover',
      blobSalt: s.blobSalt,
      blobVersion: 5,
      recoveryBlob: s.recoveryBlob,
      recoveryNonce: s.recoveryNonce,
      recoveryMode: 'key',
      passwordDerived: true,
    });
    let recoverArgs!: { encryptedBlob: string; blobSalt: string; rawBlobForEscrow?: string };
    apiClient.recoverDmKeys.mockImplementation(async (a: typeof recoverArgs) => { recoverArgs = a; return { blobVersion: 6 }; });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await recover(s.recoveryKey, NEW_PASSWORD);

    // Same key survives recovery (not regenerated).
    expect(Array.from(getArchiveKey()!)).toEqual(setArchiveKey);
    // And it rode the re-uploaded blob (re-encrypted under the NEW password).
    const reuploaded = await decryptPackedBlob(recoverArgs.encryptedBlob, NEW_PASSWORD, recoverArgs.blobSalt, s.publicKey);
    expect(Array.from(fromBase64(reuploaded.archiveKey!))).toEqual(setArchiveKey);
    // And it rode the escrow (password-derived → rawBlobForEscrow carries it).
    const escrow: BlobContents = JSON.parse(atob(recoverArgs.rawBlobForEscrow!));
    expect(Array.from(fromBase64(escrow.archiveKey!))).toEqual(setArchiveKey);
  }, 30000);

  it('(f) recover() of a recovery blob predating the archiveKey by a password-derived user mints one INTO the escrow blob', async () => {
    // Guard: a Server-recovery (passwordDerived) user recovering from a recovery
    // blob that predates the archiveKey must mint the archiveKey AND stamp it into
    // the escrow rawBlob, or a later serverRecover() mints a DIFFERENT key and diverges
    // from encryptedBlob/recoveryBlob, breaking cross-device archive reads.
    reset();
    const s = await doSetup();
    lock();

    // Forge a recovery blob predating the archiveKey: decrypt the genuine one, strip archiveKey,
    // re-encrypt under the SAME recovery key.
    const recoveryKeyBytes = parseRecoveryKey(s.recoveryKey);
    const recContents = await decryptRecoveryBlob(s.recoveryBlob, s.recoveryNonce, recoveryKeyBytes, 'howl:recovery:v1:' + s.publicKey);
    delete recContents.archiveKey;
    const { ciphertext: preArchiveKeyRecoveryBlob, nonce: preArchiveKeyRecoveryNonce } =
      await encryptRecoveryBlob(recContents, recoveryKeyBytes, 'howl:recovery:v1:' + s.publicKey);

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: s.publicKey,
      encryptedBlob: 'unused-by-recover',
      blobSalt: s.blobSalt,
      blobVersion: 5,
      recoveryBlob: preArchiveKeyRecoveryBlob,
      recoveryNonce: preArchiveKeyRecoveryNonce,
      recoveryMode: 'key',
      passwordDerived: true,
    });
    let recoverArgs!: { encryptedBlob: string; blobSalt: string; rawBlobForEscrow?: string };
    apiClient.recoverDmKeys.mockImplementation(async (a: typeof recoverArgs) => { recoverArgs = a; return { blobVersion: 6 }; });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await recover(s.recoveryKey, NEW_PASSWORD);

    // A fresh archiveKey was minted.
    expect(getArchiveKey()).not.toBeNull();
    expect(getArchiveKey()!.length).toBe(32);
    const mintedKey = Array.from(getArchiveKey()!);
    // It rode the re-uploaded blob.
    const reuploaded = await decryptPackedBlob(recoverArgs.encryptedBlob, NEW_PASSWORD, recoverArgs.blobSalt, s.publicKey);
    expect(Array.from(fromBase64(reuploaded.archiveKey!))).toEqual(mintedKey);
    // And — the same guard — it ALSO rode the escrow rawBlob (the same minted key,
    // not absent). Without the fix the escrow lacks archiveKey entirely.
    const escrow: BlobContents = JSON.parse(atob(recoverArgs.rawBlobForEscrow!));
    expect(escrow.archiveKey).toBeTruthy();
    expect(Array.from(fromBase64(escrow.archiveKey!))).toEqual(mintedKey);
  }, 30000);

  it('(e) serverRecover() of an escrow blob carrying archiveKey preserves the SAME bytes and re-uploads them', async () => {
    // Capture a genuine escrow rawBlob from a password-derived recover().
    reset();
    const s = await doSetup();
    const setArchiveKey = Array.from(getArchiveKey()!);
    lock();

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: s.publicKey,
      encryptedBlob: 'unused-by-recover',
      blobSalt: s.blobSalt,
      blobVersion: 5,
      recoveryBlob: s.recoveryBlob,
      recoveryNonce: s.recoveryNonce,
      recoveryMode: 'key',
      passwordDerived: true,
    });
    let rawBlob = '';
    apiClient.recoverDmKeys.mockImplementation(async (a: { rawBlobForEscrow?: string }) => { rawBlob = a.rawBlobForEscrow!; return { blobVersion: 6 }; });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);
    await recover(s.recoveryKey, NEW_PASSWORD);
    expect(rawBlob).toBeTruthy();

    // Now serverRecover() from that escrow rawBlob.
    reset();
    apiClient.serverRecover.mockResolvedValue({ rawBlob });
    let recoverArgs!: { encryptedBlob: string; blobSalt: string; rawBlobForEscrow?: string };
    apiClient.recoverDmKeys.mockImplementation(async (a: typeof recoverArgs) => { recoverArgs = a; return { blobVersion: 9 }; });
    apiClient.getPendingKeyDeliveries.mockResolvedValue([]);
    mlsGroupStore.getIdentity.mockResolvedValue(null);
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await serverRecover('reset-pw');

    // Same key survives server-recovery (loaded from escrow, not regenerated).
    expect(Array.from(getArchiveKey()!)).toEqual(setArchiveKey);
    // And it rode BOTH the re-encrypted blob and the re-escrowed rawBlob.
    expect(s.publicKey).toBeTruthy();
    const reuploaded = await decryptPackedBlob(recoverArgs.encryptedBlob, 'reset-pw', recoverArgs.blobSalt, s.publicKey);
    expect(Array.from(fromBase64(reuploaded.archiveKey!))).toEqual(setArchiveKey);
    const escrow: BlobContents = JSON.parse(atob(recoverArgs.rawBlobForEscrow!));
    expect(Array.from(fromBase64(escrow.archiveKey!))).toEqual(setArchiveKey);
  }, 30000);

  it('(g) auto-recovery after mls-locked re-activates with the RETAINED history key, not the nulled store mirror', async () => {
    // Guards a history-blind receive: the auto-recovery that re-activates MLS after
    // a sibling tab tore down the shared worker must NOT re-activate with a null
    // history key when the retained key (_liveHistoryKey, alive while unlocked)
    // is available — otherwise messages received in the re-activated window decrypt + display
    // but are never archived, so they relock to 🔒 after a reload. It reads the STORE mirror
    // (mlsGroupStore.getHistoryKey()), which an identity-reload teardown can null
    // while the tab stays unlocked; it must fall back to the retained key.
    reset();
    const s = await doSetup();
    lock();
    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: s.publicKey, encryptedBlob: s.encryptedBlob, blobSalt: s.blobSalt,
      blobVersion: 1, passwordDerived: false,
    });
    await unlock(PASSWORD); // real unlock: installs the live history key (_liveHistoryKey) + store mirror

    // The real history key installed at THIS unlock (the LAST non-null setHistoryKey arg —
    // the same CryptoKey object _liveHistoryKey retains; setup+unlock each derive a distinct
    // object from the same bytes, so identity matters).
    const nonNull = mlsGroupStore.setHistoryKey.mock.calls.map((c) => c[0]).filter((k) => k !== null);
    const installedHistoryKey = nonNull[nonNull.length - 1] as CryptoKey;
    expect(installedHistoryKey).toBeTruthy();

    // Simulate the divergence: the STORE mirror is nulled while the tab stays unlocked
    // (so getHistoryKey() === null) but the retained _liveHistoryKey survives.
    mlsGroupStore.setHistoryKey(null);
    expect(mlsGroupStore.getHistoryKey()).toBeNull();
    coordinator.activate.mockClear();

    // A sibling tab tore down the shared worker -> 'mls-locked' broadcast -> auto-recovery.
    emitMls('mls-locked');
    await new Promise((r) => setTimeout(r, 0));

    expect(coordinator.activate).toHaveBeenCalledTimes(1);
    const historyArg = coordinator.activate.mock.calls[0][2];
    expect(historyArg).not.toBeNull();           // NOT history-blind
    expect(historyArg).toBe(installedHistoryKey); // the SAME retained key
  }, 30000);
});
