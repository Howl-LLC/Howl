// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * one-time legacy localStorage->device migration.
 *
 * A returning user with a legacy wrapped-password stash (REMEMBER_KEY) gets it
 * honored ONCE on the next successful unlock: live content keys are persisted to
 * the new store, verified by readback, THEN the localStorage entries are
 * deleted. The migration is idempotent and does NOT drop the credential if a
 * crash happens between write and delete (the content keys are already
 * persisted), and does not recreate localStorage afterward.
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
      setupDmKeys: vi.fn(), getDmKeyBundle: vi.fn(),
      getPendingKeyDeliveries: vi.fn(() => Promise.resolve([])), updateDmKeysSigningKey: vi.fn(),
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
const USER_ID = '00000000-0000-4000-8000-0000000000c1';
const REMEMBER_KEY = 'howl_e2e_remember';
const REMEMBER_LAST_USED_KEY = 'howl_e2e_remember_last_used';

async function setupAndServeBundle() {
  let captured!: { publicKey: string; encryptedBlob: string; blobSalt: string };
  apiClient.setupDmKeys.mockImplementation(async (a: typeof captured) => { captured = a; return { blobVersion: 1 }; });
  (await import('../services/dmEncryption')).initializeEncryption(USER_ID);
  await dmKeyManager.setup(PASSWORD, USER_ID);
  dmKeyManager.lock();
  apiClient.getDmKeyBundle.mockResolvedValue({
    publicKey: captured.publicKey, encryptedBlob: captured.encryptedBlob,
    blobSalt: captured.blobSalt, blobVersion: 1, passwordDerived: false,
  });
}

describe('legacy remember migration', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    __resetDbHandle();
    mlsGroupStore.__testHooks.resetDbHandle();
    vi.clearAllMocks();
    localStorage.clear();
    apiClient.getPendingKeyDeliveries.mockResolvedValue([]);
    dmKeyManager.setAutoUnlockEnabled(true);
  });

  it('migrates a legacy stash on unlock: persists content keys, then deletes localStorage', async () => {
    await setupAndServeBundle();
    // Simulate a legacy wrapped-password stash (w1: read-path format).
    localStorage.setItem(REMEMBER_KEY, 'w1:' + btoa(PASSWORD));
    localStorage.setItem(REMEMBER_LAST_USED_KEY, String(Date.now()));

    await dmKeyManager.unlock(PASSWORD);

    // Content keys are now persisted to the new store...
    expect(await loadContentKeys()).not.toBeNull();
    // ...and the legacy localStorage entries are gone (and not recreated).
    expect(localStorage.getItem(REMEMBER_KEY)).toBeNull();
    expect(localStorage.getItem(REMEMBER_LAST_USED_KEY)).toBeNull();
  }, 30000);

  it('is a no-op when there is no legacy stash (does not create localStorage)', async () => {
    await setupAndServeBundle();
    await dmKeyManager.unlock(PASSWORD);
    expect(localStorage.getItem(REMEMBER_KEY)).toBeNull();
    // No legacy stash => no auto-persist (user never opted in on this device).
    expect(await loadContentKeys()).toBeNull();
  }, 30000);

  it('does not drop the credential if delete-old fails after write-new (crash safety)', async () => {
    await setupAndServeBundle();
    localStorage.setItem(REMEMBER_KEY, 'w1:' + btoa(PASSWORD));
    localStorage.setItem(REMEMBER_LAST_USED_KEY, String(Date.now()));

    // Make the localStorage delete throw (simulating a crash between write+delete).
    const realRemove = localStorage.removeItem.bind(localStorage);
    let firstCall = true;
    vi.spyOn(localStorage, 'removeItem').mockImplementation((k: string) => {
      if (firstCall) { firstCall = false; throw new Error('storage gone'); }
      realRemove(k);
    });

    await dmKeyManager.unlock(PASSWORD);

    // The content keys were written BEFORE the delete attempt, so the credential
    // is preserved even though the localStorage cleanup threw.
    expect(await loadContentKeys()).not.toBeNull();
    (localStorage.removeItem as ReturnType<typeof vi.fn>).mockRestore?.();
  }, 30000);
});
