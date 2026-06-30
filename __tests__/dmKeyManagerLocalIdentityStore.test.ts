// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Per-device MLS identity: loadOrMintLocalIdentity persists the device's MLS
 * identity DEVICE-LOCAL (mlsGroupStore.putIdentity, at-rest) and reloads it
 * on a later call instead of re-minting.
 *
 * The device identity rides the persistent, vault-INDEPENDENT device wrap key
 * (wrapVersion 2), NOT the vault at-rest key. So a vault password change (which
 * rotates the at-rest key) no longer makes the stored record undecryptable: the
 * identity SURVIVES the rotation and reloads WITHOUT a re-mint (this avoids a
 * leaf-identity collision). A fresh mint happens only when the identity row is
 * gone — i.e. after a true encryption reset (clearAll wipes STORE_IDENTITY +
 * STORE_DEVICEKEY).
 *
 * Unlike the sibling dmKeyManagerLocalIdentity.test.ts (which MOCKS mlsGroupStore),
 * this file keeps mlsGroupStore AND mlsIdentity REAL (fake-indexeddb-backed) so the
 * assertions exercise real persistence + the real device-wrap survival / post-reset
 * fresh-mint paths. Only the side-effecting deps (api, mlsClient, mlsCoordinator)
 * are mocked, purely so importing dmKeyManager is safe.
 *
 * Harness (WebCrypto polyfill, fake-indexeddb, fresh IDBFactory per test) is copied
 * from dmKeyManagerMlsUnlock.test.ts, minus the mlsGroupStore / mlsIdentity mocks.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

// jsdom does not ship WebCrypto; pull Node's webcrypto so the real mlsIdentity
// signing path runs and crypto.randomUUID() exists for the minted deviceId.
beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

// Mock only the side-effecting deps so importing dmKeyManager is safe.
// mlsGroupStore + mlsIdentity stay REAL (the whole point of this file).
const { mlsClient, coordinator, apiClient } = vi.hoisted(() => {
  const listeners = new Set<(e: 'mls-ready' | 'mls-locked') => void>();
  const mlsEvents = { on(cb: (e: 'mls-ready' | 'mls-locked') => void) { listeners.add(cb); return () => listeners.delete(cb); } };
  return {
    mlsClient: {
      publishKeyPackages: vi.fn(),
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
  };
});

vi.mock('../services/mls/mlsClient', () => mlsClient);
vi.mock('../services/mls/mlsCoordinator', () => coordinator);
vi.mock('../services/api', () => ({ apiClient }));

import * as mlsGroupStore from '../services/mls/mlsGroupStore';
import * as dmKeyManager from '../services/dmKeyManager';

describe('dmKeyManager — loadOrMintLocalIdentity', () => {
  const UID = '00000000-0000-4000-8000-0000000000f1';

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    mlsGroupStore.setAtRestKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    mlsGroupStore.__testHooks.resetDbHandle();
  });

  // Two-phase: the boot mint is LEAF-ONLY — it persists the leaf keypair with
  // an EMPTY credential identity and r.bundle is null (currentMlsBundle() withholds the
  // bundle until the cross-sign). So these assertions read the STORED row's deviceId
  // (the durable persistence signal) instead of r.bundle.deviceId.
  it('mints + persists a fresh leaf identity when none exists, signalling minted=true', async () => {
    const r = await dmKeyManager.__testHooks.loadOrMintLocalIdentity(UID);
    expect(r.minted).toBe(true);
    expect(r.bundle).toBeNull(); // leaf-only: not cross-signed yet
    const stored = await mlsGroupStore.getIdentity(UID);
    expect(stored).not.toBeNull();
    expect(stored!.deviceId.length).toBeGreaterThan(0);
    expect(stored!.credentialIdentity.length).toBe(0); // empty = uncross-signed
  });

  it('reloads the SAME identity on a second call (no re-mint / no churn)', async () => {
    await dmKeyManager.__testHooks.loadOrMintLocalIdentity(UID);
    const firstStored = await mlsGroupStore.getIdentity(UID);
    const second = await dmKeyManager.__testHooks.loadOrMintLocalIdentity(UID);
    expect(second.minted).toBe(false);
    const secondStored = await mlsGroupStore.getIdentity(UID);
    expect(secondStored!.deviceId).toBe(firstStored!.deviceId);
  });

  it('does NOT re-mint across an at-rest key rotation (the device-wrapped identity survives)', async () => {
    await dmKeyManager.__testHooks.loadOrMintLocalIdentity(UID);
    const firstStored = await mlsGroupStore.getIdentity(UID);
    // A vault password change rotates the at-rest key. The identity rides the
    // persistent device wrap key (wrapVersion 2), independent of the vault, so it
    // MUST survive the rotation and reload without a re-mint (no leaf-identity collision).
    mlsGroupStore.setAtRestKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    const second = await dmKeyManager.__testHooks.loadOrMintLocalIdentity(UID);
    expect(second.minted).toBe(false);
    const secondStored = await mlsGroupStore.getIdentity(UID);
    expect(secondStored!.deviceId).toBe(firstStored!.deviceId);
  });

  it('mints fresh after a reset clears the device identity + device wrap key (post-reset)', async () => {
    await dmKeyManager.__testHooks.loadOrMintLocalIdentity(UID);
    const firstStored = await mlsGroupStore.getIdentity(UID);
    // An encryption reset wipes STORE_IDENTITY + STORE_DEVICEKEY (clearAll). With the
    // identity row gone, loadOrMint mints a fresh device identity under a fresh device
    // wrap key.
    await mlsGroupStore.clearAll();
    const second = await dmKeyManager.__testHooks.loadOrMintLocalIdentity(UID);
    expect(second.minted).toBe(true);
    const secondStored = await mlsGroupStore.getIdentity(UID);
    expect(secondStored!.deviceId).not.toBe(firstStored!.deviceId);
  });
});
