// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Mode-switch device-content-key transitions.
 *
 *  - enablePasswordDerived (Self->Server): if remembered, re-persist content
 *    keys in SERVER (no-TTL) mode.
 *  - disablePasswordDerived (Server->Self): re-persist in SELF (30d) mode under
 *    the NEW passphrase's keys (escrow removal handled server-side).
 *  - changePassword (Server password change): re-persist content keys under the
 *    new keys after the rekey RPC, so the device key isn't orphaned.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const { mlsClient, coordinator, apiClient } = vi.hoisted(() => {
  const listeners = new Set<(e: 'mls-ready' | 'mls-locked') => void>();
  const mlsEvents = { on(cb: (e: 'mls-ready' | 'mls-locked') => void) { listeners.add(cb); return () => listeners.delete(cb); } };
  return {
    mlsClient: { publishKeyPackages: vi.fn() },
    coordinator: {
      activate: vi.fn(() => Promise.resolve()), rekey: vi.fn(() => Promise.resolve()),
      deactivate: vi.fn(), reconcileChannelClassifications: vi.fn(() => Promise.resolve()), mlsEvents,
    },
    apiClient: {
      setupDmKeys: vi.fn(), getDmKeyBundle: vi.fn(), getPendingKeyDeliveries: vi.fn(() => Promise.resolve([])),
      updateDmKeysSigningKey: vi.fn(), enablePasswordDerived: vi.fn(() => Promise.resolve()),
      disablePasswordDerived: vi.fn(() => Promise.resolve()), changeDmKeysPassword: vi.fn(),
    },
  };
});
vi.mock('../services/mls/mlsClient', () => mlsClient);
vi.mock('../services/mls/mlsCoordinator', () => coordinator);
vi.mock('../services/api', () => ({ apiClient }));

import * as mlsGroupStore from '../services/mls/mlsGroupStore';
import * as dmKeyManager from '../services/dmKeyManager';
import { loadContentKeys, __resetDbHandle } from '../services/deviceContentKeyStore';

const PASSWORD = 'correct horse battery staple';
const NEW_PW = 'a whole new passphrase here';
const USER_ID = '00000000-0000-4000-8000-0000000000f2';

// Read the raw content-key record straight from the store's IDB so we can assert the
// cleartext TTL (expiresAt). loadContentKeys() omits expiresAt and slides a Self TTL,
// so it cannot prove the Server no-TTL property. Mirrors deviceContentKeyStore's
// constants (DB_NAME / STORE_NAME / RECORD_ID).
function readRawContentKeyRecord(): Promise<{ mode: string; expiresAt: number | null } | null> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('howl_e2e_content_keys', 1);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('keys', 'readonly');
      const r = tx.objectStore('keys').get('content_keys');
      r.onsuccess = () => resolve((r.result as { mode: string; expiresAt: number | null }) ?? null);
      r.onerror = () => reject(r.error);
    };
    open.onerror = () => reject(open.error);
  });
}

async function freshSetup() {
  let captured!: { publicKey: string; encryptedBlob: string; blobSalt: string };
  apiClient.setupDmKeys.mockImplementation(async (a: typeof captured) => { captured = a; return { blobVersion: 1 }; });
  (await import('../services/dmEncryption')).initializeEncryption(USER_ID);
  await dmKeyManager.setup(PASSWORD, USER_ID);
  apiClient.getDmKeyBundle.mockResolvedValue({
    publicKey: captured.publicKey, encryptedBlob: captured.encryptedBlob,
    blobSalt: captured.blobSalt, blobVersion: 1, passwordDerived: false,
  });
  return captured;
}

describe('mode-switch content-key transitions', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    __resetDbHandle();
    mlsGroupStore.__testHooks.resetDbHandle();
    vi.clearAllMocks();
    localStorage.clear();
    apiClient.getPendingKeyDeliveries.mockResolvedValue([]);
    dmKeyManager.setAutoUnlockEnabled(true);
  });

  it('Self->Server: enablePasswordDerived re-persists remembered keys in SERVER (no-TTL) mode', async () => {
    await freshSetup();
    await dmKeyManager.rememberOnDevice(PASSWORD); // Self mode
    expect((await loadContentKeys())!.mode).toBe('self');

    await dmKeyManager.enablePasswordDerived();

    // Same-device transition flips the persisted mode to server (no TTL).
    expect((await loadContentKeys())!.mode).toBe('server');
  }, 30000);

  it('Server->Self: disablePasswordDerived re-persists remembered keys in SELF (30d) mode', async () => {
    await freshSetup();
    dmKeyManager.__test_setPasswordDerived(true);
    await dmKeyManager.rememberOnDevice(PASSWORD); // Server mode
    expect((await loadContentKeys())!.mode).toBe('server');

    apiClient.changeDmKeysPassword.mockResolvedValue({ blobVersion: 2 });
    await dmKeyManager.disablePasswordDerived(NEW_PW, USER_ID);

    expect((await loadContentKeys())!.mode).toBe('self');
  }, 30000);

  it('Self->Server cross-device: silent boot re-stamps a stale Self sibling record to Server (no-TTL)', async () => {
    // enablePasswordDerived (Self->Server) does NOT rotate the blob, so a sibling
    // device remembered in Self still decrypts the unrotated server blob on its next
    // silent boot. Without the boot-time reconcile the persisted record stays
    // mode:'self' (30-day TTL) even though the account is now Server (no-TTL), so it
    // wrongly expires after 30 idle days. The reconcile re-stamps it to Server.
    const setup = await freshSetup();
    await dmKeyManager.rememberOnDevice(PASSWORD); // Self mode (passwordDerived false)
    expect((await loadContentKeys())!.mode).toBe('self');

    dmKeyManager.lock();

    // Account flipped to Server elsewhere; blob is UNROTATED so the SAME persisted
    // blobKey still decrypts. Only passwordDerived flips true on the served bundle.
    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: setup.publicKey,
      encryptedBlob: setup.encryptedBlob,
      blobSalt: setup.blobSalt,
      blobVersion: 1,
      passwordDerived: true,
    });

    const installed = await dmKeyManager.installFromDeviceContentKeys();
    expect(installed).toBe(true);
    expect(dmKeyManager.isUnlocked()).toBe(true);

    // Reconciled to Server mode...
    expect((await loadContentKeys())!.mode).toBe('server');
    // ...with NO TTL. loadContentKeys() omits expiresAt (and would slide a Self TTL),
    // so read the raw record straight from the store's IDB to prove expiresAt === null.
    const raw = await readRawContentKeyRecord();
    expect(raw).not.toBeNull();
    expect(raw!.expiresAt).toBeNull();
  }, 30000);

  it('Server password change re-persists content keys under the new keys (not orphaned)', async () => {
    const setup = await freshSetup();
    dmKeyManager.__test_setPasswordDerived(true);
    await dmKeyManager.rememberOnDevice(PASSWORD); // persists the OLD server-mode blobKey
    const before = await loadContentKeys();
    expect(before).not.toBeNull();

    // Capture the rotated server blob. changePassword re-encrypts the blob under the
    // NEW password's key/salt and ships it via changeDmKeysPassword. The arg shape is
    // { encryptedBlob, blobSalt, blobVersion, recoveryBlob, recoveryNonce, recoveryMode,
    //   ...escrow }; publicKey is NOT sent (the identity is unchanged by a password
    // change) so the install oracle below reuses the original setup publicKey for AAD.
    let captured!: { encryptedBlob: string; blobSalt: string };
    apiClient.changeDmKeysPassword.mockImplementation(
      async (arg: { encryptedBlob: string; blobSalt: string }) => { captured = arg; return { blobVersion: 3 }; },
    );
    await dmKeyManager.changePassword(PASSWORD, NEW_PW);

    // Still remembered (re-persisted under the new keys), still server mode.
    const after = await loadContentKeys();
    expect(after).not.toBeNull();
    expect(after!.mode).toBe('server');

    // Teeth: use the device-key INSTALL path as an oracle. Lock the vault, then serve
    // the ROTATED server blob and re-install from the persisted device content keys.
    // _installFromDeviceWrappedContentKeys decrypts the served blob with the PERSISTED
    // blobKey (no Argon2id); on failure it clears the keys and returns false. So a
    // successful fresh install against the rotated blob proves the re-persisted blobKey
    // is the NEW one. A stale/missing re-persist (old key still stored) cannot decrypt
    // the rotated blob and would fail-closed (installed === false, not unlocked).
    dmKeyManager.lock();
    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: setup.publicKey, // unchanged by the password rotation
      encryptedBlob: captured.encryptedBlob,
      blobSalt: captured.blobSalt,
      blobVersion: 3,
      passwordDerived: true,
    });
    const installed = await dmKeyManager.installFromDeviceContentKeys();
    expect(installed).toBe(true);
    expect(dmKeyManager.isUnlocked()).toBe(true);
  }, 30000);
});
