// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * remember-on-device repointed to the content-key store.
 *
 * isRememberedOnDevice() now reflects the device CONTENT-KEY store (not the
 * legacy wrapped-password localStorage stash). rememberOnDevice() persists the
 * live content keys (Self mode by default). forgetDevice() clears them.
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
import { hasFreshContentKeys, loadContentKeys, __resetDbHandle } from '../services/deviceContentKeyStore';

const PASSWORD = 'correct horse battery staple';
const USER_ID = '00000000-0000-4000-8000-0000000000b1';

describe('dmKeyManager remember-on-device — content-key store', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    __resetDbHandle();
    mlsGroupStore.__testHooks.resetDbHandle();
    vi.clearAllMocks();
    apiClient.getPendingKeyDeliveries.mockResolvedValue([]);
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });
    localStorage.clear();
    dmKeyManager.setAutoUnlockEnabled(true);
  });

  it('isRememberedOnDevice is false before remember, true after rememberOnDevice', async () => {
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);
    await dmKeyManager.setup(PASSWORD, USER_ID);

    expect(await dmKeyManager.isRememberedOnDevice()).toBe(false);
    await dmKeyManager.rememberOnDevice(PASSWORD);
    expect(await dmKeyManager.isRememberedOnDevice()).toBe(true);
    expect(await hasFreshContentKeys()).toBe(true);
    // Self mode by default when not password-derived.
    expect((await loadContentKeys())!.mode).toBe('self');
  }, 30000);

  it('forgetDevice clears the content keys', async () => {
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);
    await dmKeyManager.setup(PASSWORD, USER_ID);
    await dmKeyManager.rememberOnDevice(PASSWORD);
    await dmKeyManager.forgetDevice();
    expect(await dmKeyManager.isRememberedOnDevice()).toBe(false);
    expect(await loadContentKeys()).toBeNull();
  }, 30000);

  it('Server mode (passwordDerived) persists with NO TTL', async () => {
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);
    await dmKeyManager.setup(PASSWORD, USER_ID);
    // Force password-derived (Server) mode in-memory.
    dmKeyManager.__test_setPasswordDerived(true);
    await dmKeyManager.rememberOnDevice(PASSWORD);
    expect((await loadContentKeys())!.mode).toBe('server');
  }, 30000);

  it('full sign-out via reset() wipes the device content-key store; lock() preserves it', async () => {
    const { putContentKeys, hasFreshContentKeys, __resetDbHandle } =
      await import('../services/deviceContentKeyStore');
    __resetDbHandle();
    const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await putContentKeys({ blobKey: k, atRestKey: k, historyKey: k, mode: 'server' });
    expect(await hasFreshContentKeys()).toBe(true);

    // lock() is the idle/preserve path - it scrubs memory only, must NOT clear the store.
    dmKeyManager.lock();
    expect(await hasFreshContentKeys()).toBe(true);

    // reset() is the full sign-out / encryption-reset path - it MUST clear the store.
    await dmKeyManager.reset();
    expect(await hasFreshContentKeys()).toBe(false);
  });
});
