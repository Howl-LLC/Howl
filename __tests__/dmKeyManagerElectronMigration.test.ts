// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Electron safeStorage (e1:) tier preserved on the legacy migration read path.
 * An Electron device whose legacy stash was wrapped
 * via window.electron.safeStorage (e1: prefix) must still unwrap on the
 * tryAutoUnlock fallback and migrate to the new content-key store.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
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
const USER_ID = '00000000-0000-4000-8000-0000000000e1';
const REMEMBER_KEY = 'howl_e2e_remember';
const REMEMBER_LAST_USED_KEY = 'howl_e2e_remember_last_used';

describe('Electron e1: legacy migration', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    __resetDbHandle();
    mlsGroupStore.__testHooks.resetDbHandle();
    vi.clearAllMocks();
    localStorage.clear();
    apiClient.getPendingKeyDeliveries.mockResolvedValue([]);
    dmKeyManager.setAutoUnlockEnabled(true);
  });

  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('unwraps an e1: stash via safeStorage and migrates to the content-key store', async () => {
    // Mock Electron safeStorage: e1: ciphertext is reversible plaintext for test.
    (window as unknown as { electron: unknown }).electron = {
      safeStorage: {
        isAvailable: async () => true,
        encryptString: async (s: string) => 'ENC(' + s + ')',
        decryptString: async (c: string) => c.replace(/^ENC\(/, '').replace(/\)$/, ''),
      },
    };

    // Real setup() + serve the bundle.
    let captured!: { publicKey: string; encryptedBlob: string; blobSalt: string };
    apiClient.setupDmKeys.mockImplementation(async (a: typeof captured) => { captured = a; return { blobVersion: 1 }; });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);
    await dmKeyManager.setup(PASSWORD, USER_ID);
    dmKeyManager.lock();
    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: captured.publicKey, encryptedBlob: captured.encryptedBlob,
      blobSalt: captured.blobSalt, blobVersion: 1, passwordDerived: false,
    });

    // Plant a legacy e1: stash (the safeStorage-wrapped password).
    localStorage.setItem(REMEMBER_KEY, 'e1:ENC(' + PASSWORD + ')');
    localStorage.setItem(REMEMBER_LAST_USED_KEY, String(Date.now()));

    const ok = await dmKeyManager.tryAutoUnlock();
    expect(ok).toBe(true);
    expect(dmKeyManager.isUnlocked()).toBe(true);
    // Migrated: content keys persisted, legacy stash deleted.
    expect(await loadContentKeys()).not.toBeNull();
    expect(localStorage.getItem(REMEMBER_KEY)).toBeNull();
  }, 30000);
});
