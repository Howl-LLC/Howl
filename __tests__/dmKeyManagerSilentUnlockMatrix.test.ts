// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * silent-unlock acceptance matrix.
 *
 *  - password-no-MFA: unlock(password) succeeds silently (covered elsewhere;
 *    here we assert the device-key path does NOT interfere).
 *  - passkey/MFA/SSO/device-verify (no password): tryAutoUnlock() unlocks ONLY
 *    when a device content key is present; otherwise returns false (caller shows
 *    the lock prompt - fail-closed, never silent plaintext).
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
import { __resetDbHandle, loadContentKeys } from '../services/deviceContentKeyStore';

const PASSWORD = 'correct horse battery staple';
const USER_ID = '00000000-0000-4000-8000-0000000000d1';

async function setupAndServeBundle(passwordDerived: boolean) {
  let captured!: { publicKey: string; encryptedBlob: string; blobSalt: string };
  apiClient.setupDmKeys.mockImplementation(async (a: typeof captured) => { captured = a; return { blobVersion: 1 }; });
  (await import('../services/dmEncryption')).initializeEncryption(USER_ID);
  await dmKeyManager.setup(PASSWORD, USER_ID);
  apiClient.getDmKeyBundle.mockResolvedValue({
    publicKey: captured.publicKey, encryptedBlob: captured.encryptedBlob,
    blobSalt: captured.blobSalt, blobVersion: 1, passwordDerived,
  });
}

describe('silent-unlock matrix', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    __resetDbHandle();
    mlsGroupStore.__testHooks.resetDbHandle();
    vi.clearAllMocks();
    localStorage.clear();
    apiClient.getPendingKeyDeliveries.mockResolvedValue([]);
    dmKeyManager.setAutoUnlockEnabled(true);
  });

  it('no-password login WITH a device content key: tryAutoUnlock unlocks silently', async () => {
    await setupAndServeBundle(true);
    await dmKeyManager.rememberOnDevice(PASSWORD); // persists content keys
    dmKeyManager.lock();

    const ok = await dmKeyManager.tryAutoUnlock();
    expect(ok).toBe(true);
    expect(dmKeyManager.isUnlocked()).toBe(true);
  }, 30000);

  it('no-password login WITHOUT a device content key: tryAutoUnlock returns false (degrade to prompt)', async () => {
    await setupAndServeBundle(true);
    dmKeyManager.lock();
    // No rememberOnDevice() => no device content keys.
    const ok = await dmKeyManager.tryAutoUnlock();
    expect(ok).toBe(false);
    expect(dmKeyManager.isUnlocked()).toBe(false); // fail-closed, never silent plaintext
  }, 30000);

  it('respects the auto-unlock opt-out (no silent install even with a device key)', async () => {
    await setupAndServeBundle(false);
    await dmKeyManager.rememberOnDevice(PASSWORD);
    dmKeyManager.lock();
    dmKeyManager.setAutoUnlockEnabled(false); // opt out

    const ok = await dmKeyManager.tryAutoUnlock();
    expect(ok).toBe(false);
    expect(dmKeyManager.isUnlocked()).toBe(false);
  }, 30000);

  it('stale persisted blobKey (cross-device password change): fails closed, clears content keys, stays locked', async () => {
    // Persist content keys from the current blob...
    let captured!: { publicKey: string; encryptedBlob: string; blobSalt: string };
    apiClient.setupDmKeys.mockImplementation(async (a: typeof captured) => { captured = a; return { blobVersion: 1 }; });
    (await import('../services/dmEncryption')).initializeEncryption(USER_ID);
    await dmKeyManager.setup(PASSWORD, USER_ID);
    await dmKeyManager.rememberOnDevice(PASSWORD);
    expect(await loadContentKeys()).not.toBeNull();
    dmKeyManager.lock();

    // ...then serve a bundle whose blob AAD no longer matches the persisted key
    // (the blob AAD binds the publicKey; a cross-device password change rotates
    // the identity, so the persisted blobKey can no longer auth-decrypt it).
    const tweakedPub = captured.publicKey.slice(0, -2) +
      (captured.publicKey.endsWith('AA') ? 'BB' : 'AA');
    apiClient.getDmKeyBundle.mockResolvedValue({
      publicKey: tweakedPub, encryptedBlob: captured.encryptedBlob,
      blobSalt: captured.blobSalt, blobVersion: 1, passwordDerived: false,
    });

    const ok = await dmKeyManager.tryAutoUnlock();
    expect(ok).toBe(false);
    expect(dmKeyManager.isUnlocked()).toBe(false);
    // Fail-closed: the stale device keys are dropped so the next boot prompts.
    expect(await loadContentKeys()).toBeNull();
  }, 30000);
});
