// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Passwordless install from device-persisted content keys.
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
      activate: vi.fn(() => Promise.resolve()),
      rekey: vi.fn(() => Promise.resolve()),
      deactivate: vi.fn(),
      reconcileChannelClassifications: vi.fn(() => Promise.resolve()),
      mlsEvents,
    },
    apiClient: {
      setupDmKeys: vi.fn(),
      getDmKeyBundle: vi.fn(),
      getPendingKeyDeliveries: vi.fn(() => Promise.resolve([])),
      updateDmKeysSigningKey: vi.fn(),
    },
  };
});

vi.mock('../services/mls/mlsClient', () => mlsClient);
vi.mock('../services/mls/mlsCoordinator', () => coordinator);
vi.mock('../services/api', () => ({ apiClient }));

import * as mlsGroupStore from '../services/mls/mlsGroupStore';
import * as dmKeyManager from '../services/dmKeyManager';
import { putContentKeys, __resetDbHandle } from '../services/deviceContentKeyStore';
import { deriveUnlockMaterial } from '../services/dmCrypto';
import { fromBase64 } from '../services/cryptoHelpers';

const PASSWORD = 'correct horse battery staple';
const USER_ID = '00000000-0000-4000-8000-0000000000a1';

describe('dmKeyManager.installFromDeviceContentKeys — passwordless install', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    __resetDbHandle();
    mlsGroupStore.__testHooks.resetDbHandle();
    vi.clearAllMocks();
    apiClient.getPendingKeyDeliveries.mockResolvedValue([]);
  });

  it('unlocks with NO password when device content keys are present', async () => {
    let captured!: { publicKey: string; encryptedBlob: string; blobSalt: string };
    apiClient.setupDmKeys.mockImplementation(async (a: typeof captured) => { captured = a; return { blobVersion: 1 }; });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);
    await dmKeyManager.setup(PASSWORD, USER_ID);

    const { blobKey, atRestKey, historyKey } = await deriveUnlockMaterial(PASSWORD, fromBase64(captured.blobSalt));
    await putContentKeys({ blobKey, atRestKey, historyKey, mode: 'server' });

    dmKeyManager.lock();
    expect(dmKeyManager.isUnlocked()).toBe(false);
    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: captured.publicKey,
      encryptedBlob: captured.encryptedBlob,
      blobSalt: captured.blobSalt,
      blobVersion: 1,
      passwordDerived: true,
    });

    const ok = await dmKeyManager.installFromDeviceContentKeys();
    expect(ok).toBe(true);
    expect(dmKeyManager.isUnlocked()).toBe(true);
  }, 30000);

  it('returns false (no unlock) when there are no device content keys', async () => {
    dmKeyManager.lock();
    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: 'x', encryptedBlob: 'x', blobSalt: 'x', blobVersion: 1, passwordDerived: true,
    });
    const ok = await dmKeyManager.installFromDeviceContentKeys();
    expect(ok).toBe(false);
    expect(dmKeyManager.isUnlocked()).toBe(false);
  }, 30000);
});
