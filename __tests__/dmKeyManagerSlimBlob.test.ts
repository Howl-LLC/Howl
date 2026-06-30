// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Blob disposition:
 *  - an OLD fat blob (channelKeys/channelKeyHistory/mlsIdentity/deviceId/
 *    blobFormatVersion present) still unlocks: the dead fields are ignored.
 *  - the next persisted blob is SLIM: privateKey + privateSigningKey +
 *    archiveKey only.
 *  - archiveKey is loaded NON-FRESH from a blob that already carries one,
 *    across unlock, recover, and serverRecover (a missed carve-out silently
 *    mints a fresh key and orphans the archive).
 *  - the escrow paths carry no dead legacy fields.
 *
 * Harness mirrors __tests__/dmKeyManagerArchiveKey.test.ts: real dmCrypto,
 * mocked MLS leaves + network, decrypting the captured blob args.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import {
  deriveUnlockMaterial,
  parseRecoveryKey,
  decryptRecoveryBlob,
  encryptRecoveryBlob,
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
      updateDmKeysSigningKey: vi.fn(),
      updateDmKeysBlob: vi.fn(),
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
  VaultIntegrityError,
} from '../services/dmKeyManager';

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a whole new password phrase';
const USER_ID = 'user-alice';
const MLS_SIG_PUB = new Uint8Array([10, 11, 12, 13]);
const MLS_SIG_PRIV = new Uint8Array([20, 21, 22, 23, 24, 25]);

const SLIM_KEYS = ['privateKey', 'privateSigningKey', 'archiveKey', 'archiveKeyVersion'];
const DEAD_KEYS = ['channelKeys', 'channelKeyHistory', 'mlsIdentity', 'deviceId', 'blobFormatVersion'];

beforeEach(() => {
  vi.clearAllMocks();

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
});

/** Decrypt a packed encryptedBlob (base64(iv ‖ AES-GCM ct)) given the
 *  password+salt and the AAD public key. */
async function decryptPackedBlob(encryptedBlob: string, password: string, blobSalt: string, publicKey: string): Promise<BlobContents> {
  const { blobKey } = await deriveUnlockMaterial(password, fromBase64(blobSalt));
  const packed = fromBase64(encryptedBlob);
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const aad = new TextEncoder().encode('howl:blob:' + publicKey);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, blobKey, ct);
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Encrypt arbitrary BlobContents into the packed wire shape under the password's
 *  blob key, so getDmKeyBundle can hand a FAT (legacy) blob back to unlock(). */
async function encryptPackedBlob(contents: object, password: string, blobSalt: string, publicKey: string): Promise<string> {
  const { blobKey } = await deriveUnlockMaterial(password, fromBase64(blobSalt));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode('howl:blob:' + publicKey);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    blobKey,
    new TextEncoder().encode(JSON.stringify(contents)),
  ));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return btoa(String.fromCharCode(...packed));
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

describe('slim blob', () => {
  it('unlock() on a fat blob succeeds and loads the EXISTING archiveKey', async () => {
    reset();
    const s = await doSetup();
    const KNOWN_B64 = toBase64(getArchiveKey()!);
    lock();

    // Decrypt the genuine slim blob, fatten it with dead legacy fields, re-encrypt.
    const slim = await decryptPackedBlob(s.encryptedBlob, PASSWORD, s.blobSalt, s.publicKey);
    const fat = {
      ...slim,
      channelKeys: { 'c1': toBase64(new Uint8Array(32).fill(7)) },
      channelKeyHistory: { 'c1': [toBase64(new Uint8Array(32).fill(8))] },
      mlsIdentity: { signaturePublicKey: 'x', signaturePrivateKey: 'y', credentialIdentity: 'z' },
      deviceId: 'old-device',
      blobFormatVersion: 2,
      archiveKey: KNOWN_B64,
    };
    const fatBlob = await encryptPackedBlob(fat, PASSWORD, s.blobSalt, s.publicKey);

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: s.publicKey,
      encryptedBlob: fatBlob,
      blobSalt: s.blobSalt,
      blobVersion: 1,
      passwordDerived: false,
    });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await unlock(PASSWORD);

    expect(toBase64(getArchiveKey()!)).toBe(KNOWN_B64);
  }, 30000);

  it('the next persistBlob writes the slim shape (no channelKeys / channelKeyHistory / mlsIdentity / deviceId / blobFormatVersion)', async () => {
    // A blob with no archiveKey forces unlock to re-persist via
    // updateDmKeysSigningKey, whose encryptedBlob arg is buildBlobContents().
    reset();
    const s = await doSetup();
    lock();

    const slim = await decryptPackedBlob(s.encryptedBlob, PASSWORD, s.blobSalt, s.publicKey);
    const fat = {
      ...slim,
      channelKeys: { 'c1': toBase64(new Uint8Array(32).fill(7)) },
      channelKeyHistory: { 'c1': [toBase64(new Uint8Array(32).fill(8))] },
      mlsIdentity: { signaturePublicKey: 'x', signaturePrivateKey: 'y', credentialIdentity: 'z' },
      deviceId: 'old-device',
      blobFormatVersion: 2,
    };
    delete (fat as { archiveKey?: string }).archiveKey; // no archiveKey → forces re-persist
    const fatBlob = await encryptPackedBlob(fat, PASSWORD, s.blobSalt, s.publicKey);

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: s.publicKey,
      encryptedBlob: fatBlob,
      blobSalt: s.blobSalt,
      blobVersion: 1,
      passwordDerived: false,
    });
    let uploaded!: { encryptedBlob: string };
    apiClient.updateDmKeysSigningKey.mockImplementation(async (a: typeof uploaded) => { uploaded = a; return { blobVersion: 2 }; });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await unlock(PASSWORD);

    expect(apiClient.updateDmKeysSigningKey).toHaveBeenCalledTimes(1);
    const written = await decryptPackedBlob(uploaded.encryptedBlob, PASSWORD, s.blobSalt, s.publicKey);
    // No dead field survives a re-persist.
    for (const dead of DEAD_KEYS) expect(written).not.toHaveProperty(dead);
    // Only slim keys present.
    for (const k of Object.keys(written)) expect(SLIM_KEYS).toContain(k);
  }, 30000);

  it('recover() loads the existing archiveKey from the recovery blob (not fresh)', async () => {
    reset();
    const s = await doSetup();
    const known = Array.from(getArchiveKey()!);
    lock();

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: s.publicKey,
      encryptedBlob: 'unused-by-recover',
      blobSalt: s.blobSalt,
      blobVersion: 5,
      recoveryBlob: s.recoveryBlob,
      recoveryNonce: s.recoveryNonce,
      recoveryMode: 'key',
      passwordDerived: false,
    });
    apiClient.recoverDmKeys.mockResolvedValue({ blobVersion: 6 });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await recover(s.recoveryKey, NEW_PASSWORD);

    expect(Array.from(getArchiveKey()!)).toEqual(known); // SAME bytes, not minted fresh
  }, 30000);

  it('serverRecover() loads the existing archiveKey from the escrow blob (not fresh)', async () => {
    // Capture a genuine escrow rawBlob, then serverRecover from it.
    reset();
    const s = await doSetup();
    const known = Array.from(getArchiveKey()!);
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

    reset();
    apiClient.serverRecover.mockResolvedValue({ rawBlob });
    apiClient.recoverDmKeys.mockResolvedValue({ blobVersion: 9 });
    mlsGroupStore.getIdentity.mockResolvedValue(null);
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await serverRecover('reset-pw');

    expect(Array.from(getArchiveKey()!)).toEqual(known); // loaded from escrow, not minted
  }, 30000);

  it('unlock() on a blob with NO archiveKey mints one (lazy mint)', async () => {
    reset();
    const s = await doSetup();
    lock();

    const slim = await decryptPackedBlob(s.encryptedBlob, PASSWORD, s.blobSalt, s.publicKey);
    delete (slim as { archiveKey?: string }).archiveKey;
    const noArchiveBlob = await encryptPackedBlob(slim, PASSWORD, s.blobSalt, s.publicKey);

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: s.publicKey,
      encryptedBlob: noArchiveBlob,
      blobSalt: s.blobSalt,
      blobVersion: 1,
      passwordDerived: false,
    });
    apiClient.updateDmKeysSigningKey.mockResolvedValue({ blobVersion: 2 });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await unlock(PASSWORD);

    expect(getArchiveKey()).not.toBeNull();
    expect(getArchiveKey()!.length).toBe(32);
  }, 30000);

  it('getRawBlobForEscrow / stripMlsForEscrow output carries no dead fields', async () => {
    // enablePasswordDerived-equivalent escrow capture: a password-derived recover()
    // re-escrows stripMlsForEscrow(contents). Fatten the recovery blob first so the
    // strip has dead fields to drop, then assert the escrow rawBlob has none.
    reset();
    const s = await doSetup();
    lock();

    // Forge a FAT recovery blob carrying dead legacy fields.
    const recKeyBytes = parseRecoveryKey(s.recoveryKey);
    const recContents = await decryptRecoveryBlob(s.recoveryBlob, s.recoveryNonce, recKeyBytes, 'howl:recovery:v1:' + s.publicKey);
    const fatRec = {
      ...recContents,
      channelKeys: { 'c1': toBase64(new Uint8Array(32).fill(7)) },
      channelKeyHistory: { 'c1': [toBase64(new Uint8Array(32).fill(8))] },
      mlsIdentity: { signaturePublicKey: 'x', signaturePrivateKey: 'y', credentialIdentity: 'z' },
      deviceId: 'old-device',
      blobFormatVersion: 2,
    };
    const { ciphertext: fatRecBlob, nonce: fatRecNonce } = await encryptRecoveryBlob(fatRec as BlobContents, recKeyBytes, 'howl:recovery:v1:' + s.publicKey);

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: s.publicKey,
      encryptedBlob: 'unused-by-recover',
      blobSalt: s.blobSalt,
      blobVersion: 5,
      recoveryBlob: fatRecBlob,
      recoveryNonce: fatRecNonce,
      recoveryMode: 'key',
      passwordDerived: true, // → rawBlobForEscrow is sent
    });
    let recoverArgs!: { rawBlobForEscrow?: string };
    apiClient.recoverDmKeys.mockImplementation(async (a: typeof recoverArgs) => { recoverArgs = a; return { blobVersion: 6 }; });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await recover(s.recoveryKey, NEW_PASSWORD);

    const escrow: BlobContents = JSON.parse(atob(recoverArgs.rawBlobForEscrow!));
    for (const dead of DEAD_KEYS) expect(escrow).not.toHaveProperty(dead);
  }, 30000);

  it('escrow blob never carries MLS identity material (only slim keys)', async () => {
    // Forge a FAT recovery blob carrying MLS identity material AND dead legacy
    // fields, then drive a password-derived recover() and assert the re-escrowed
    // rawBlobForEscrow carries NONE of it. buildBlobContents() omits the MLS
    // identity (per-device, device-local); stripMlsForEscrow defensively drops
    // any that a returning user's old v2 blob still presents. This guards both.
    reset();
    const s = await doSetup();
    lock();

    const recKeyBytes = parseRecoveryKey(s.recoveryKey);
    const recContents = await decryptRecoveryBlob(s.recoveryBlob, s.recoveryNonce, recKeyBytes, 'howl:recovery:v1:' + s.publicKey);
    const fatRec = {
      ...recContents,
      // MLS identity material that must NEVER reach the server.
      mlsIdentity: {
        signaturePublicKey: toBase64(new Uint8Array(MLS_SIG_PUB)),
        signaturePrivateKey: toBase64(new Uint8Array(MLS_SIG_PRIV)),
        credentialIdentity: toBase64(new TextEncoder().encode(`${USER_ID}:dev-1`)),
      },
      deviceId: 'old-device',
      blobFormatVersion: 2,
      // dead legacy DM keys, also forbidden in escrow.
      channelKeys: { 'c1': toBase64(new Uint8Array(32).fill(7)) },
      channelKeyHistory: { 'c1': [toBase64(new Uint8Array(32).fill(8))] },
    };
    const { ciphertext: fatRecBlob, nonce: fatRecNonce } = await encryptRecoveryBlob(fatRec as BlobContents, recKeyBytes, 'howl:recovery:v1:' + s.publicKey);

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: s.publicKey,
      encryptedBlob: 'unused-by-recover',
      blobSalt: s.blobSalt,
      blobVersion: 5,
      recoveryBlob: fatRecBlob,
      recoveryNonce: fatRecNonce,
      recoveryMode: 'key',
      passwordDerived: true, // -> rawBlobForEscrow is sent
    });
    let recoverArgs!: { rawBlobForEscrow?: string };
    apiClient.recoverDmKeys.mockImplementation(async (a: typeof recoverArgs) => { recoverArgs = a; return { blobVersion: 6 }; });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await recover(s.recoveryKey, NEW_PASSWORD);

    const escrowJson = atob(recoverArgs.rawBlobForEscrow!);
    const escrow: BlobContents = JSON.parse(escrowJson);

    // No MLS identity field survives, under any of its known names.
    for (const forbidden of ['mlsIdentity', 'deviceId', 'blobFormatVersion', 'channelKeys', 'channelKeyHistory']) {
      expect(escrow).not.toHaveProperty(forbidden);
    }
    // Belt-and-suspenders: the forged MLS private key bytes never appear ANYWHERE
    // in the escrow JSON, even if a future field renamed the identity.
    expect(escrowJson).not.toContain(toBase64(new Uint8Array(MLS_SIG_PRIV)));
    // Only the slim Self/voice/archive keys are allowed in escrow.
    const ALLOWED_ESCROW_KEYS = ['privateKey', 'privateSigningKey', 'archiveKey', 'archiveKeyVersion'];
    for (const k of Object.keys(escrow)) expect(ALLOWED_ESCROW_KEYS).toContain(k);
  }, 30000);

  it('recover() rejects a recovery blob whose server-advertised publicKey != its sealing identity', async () => {
    // The genuine setup recovery blob is sealed under recoveryAAD(s.publicKey). A
    // server that advertises a DIFFERENT publicKey in the bundle makes recover()
    // reconstruct a mismatched AAD → AES-GCM fails → recovery is rejected (no
    // silent cross-identity splice), even though the recovery KEY itself is correct.
    reset();
    const s = await doSetup();
    lock();

    const wrongPublicKey = toBase64(new Uint8Array(32).fill(1));
    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: wrongPublicKey,
      encryptedBlob: 'unused-by-recover',
      blobSalt: s.blobSalt,
      blobVersion: 5,
      recoveryBlob: s.recoveryBlob,
      recoveryNonce: s.recoveryNonce,
      recoveryMode: 'key',
      passwordDerived: false,
    });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await expect(recover(s.recoveryKey, NEW_PASSWORD)).rejects.toBeTruthy();
  }, 30000);
});

describe('no silent no-AAD fallback + identity assertion', () => {
  it('rejects a packed blob sealed WITHOUT AAD (no silent fallback)', async () => {
    reset();
    const s = await doSetup();
    lock();

    // Forge a server blob encrypted under the real HKDF blobKey but with NO
    // additionalData — the pre-AAD shape the old fallback silently accepted.
    const slim = await decryptPackedBlob(s.encryptedBlob, PASSWORD, s.blobSalt, s.publicKey);
    const { blobKey } = await deriveUnlockMaterial(PASSWORD, fromBase64(s.blobSalt));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, blobKey, new TextEncoder().encode(JSON.stringify(slim)),
    ));
    const packed = new Uint8Array(iv.length + ct.length);
    packed.set(iv, 0); packed.set(ct, iv.length);
    const noAadBlob = btoa(String.fromCharCode(...packed));

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: s.publicKey,
      encryptedBlob: noAadBlob,
      blobSalt: s.blobSalt,
      blobVersion: 1,
      passwordDerived: false,
    });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await expect(unlock(PASSWORD)).rejects.toBeTruthy();
  }, 30000);

  it('rejects a blob whose inner identity != server publicKey with VaultIntegrityError', async () => {
    reset();
    const s = await doSetup();
    lock();

    // Correct key + correct AAD, but the inner privateKey belongs to a DIFFERENT
    // X25519 identity than the publicKey the server advertises → substitution.
    const slim = await decryptPackedBlob(s.encryptedBlob, PASSWORD, s.blobSalt, s.publicKey);
    const tampered = { ...slim, privateKey: toBase64(new Uint8Array(32).fill(2)) };
    const tamperedBlob = await encryptPackedBlob(tampered, PASSWORD, s.blobSalt, s.publicKey);

    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: s.publicKey,
      encryptedBlob: tamperedBlob,
      blobSalt: s.blobSalt,
      blobVersion: 1,
      passwordDerived: false,
    });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);

    await expect(unlock(PASSWORD)).rejects.toThrow(VaultIntegrityError);
  }, 30000);
});
