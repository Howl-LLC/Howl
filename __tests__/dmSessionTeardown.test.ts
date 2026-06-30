// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Session-end teardown scrubs in-memory E2EE keys.
 *
 * There is no page reload on logout (login/logout are in-SPA transitions), so
 * if the session-end path does not lock/reset dmKeyManager, the prior user's
 * X25519/Ed25519 private keys + Argon2id-derived AES key + all channel keys
 * stay live in module memory and remain readable via the exported getters
 * until the next user unlocks. On a shared device that is a cross-account
 * private-key exposure.
 *
 * The testable seam is dmEncryption.ts:
 *  - clearAllDmEncryptionData()    full sign-out  -> reset() (scrub keys + setup state)
 *  - lockEncryptionForSessionEnd() idle / cross-tab / session-expiry
 *                                  -> lock() (scrub decrypted keys, keep the
 *                                     on-disk wrapped credential for re-unlock)
 *
 * Mirrors the real-crypto harness in dmKeyManagerUnlockRoundTrip.test.ts:
 * real setup() -> unlock() round-trip, mocking only the network.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/api', () => ({
  apiClient: {
    setupDmKeys: vi.fn(),
    getDmKeyBundle: vi.fn(),
  },
}));

import { apiClient } from '../services/api';
import { setup, unlock, lock, isUnlocked } from '../services/dmKeyManager';
import * as dmEncryption from '../services/dmEncryption';

const setupDmKeys = apiClient.setupDmKeys as ReturnType<typeof vi.fn>;
const getDmKeyBundle = apiClient.getDmKeyBundle as ReturnType<typeof vi.fn>;

const PASSWORD = 'correct horse battery staple';

async function setupAndUnlock(): Promise<void> {
  setupDmKeys.mockResolvedValue({ blobVersion: 1 });
  await setup(PASSWORD);
  const uploaded = setupDmKeys.mock.calls[0][0] as {
    publicKey: string;
    encryptedBlob: string;
    blobSalt: string;
  };
  lock();
  getDmKeyBundle.mockResolvedValue({
    publicKey: uploaded.publicKey,
    encryptedBlob: uploaded.encryptedBlob,
    blobSalt: uploaded.blobSalt,
    blobVersion: 1,
    passwordDerived: false,
  });
  await unlock(PASSWORD);
}

beforeEach(() => {
  setupDmKeys.mockReset();
  getDmKeyBundle.mockReset();
  // start every test from a known locked state (singleton persists across tests)
  lock();
});

describe('session-end teardown scrubs in-memory E2EE keys', () => {
  it('clearAllDmEncryptionData() (full sign-out) locks the key manager', async () => {
    await setupAndUnlock();
    expect(isUnlocked()).toBe(true);

    dmEncryption.clearAllDmEncryptionData();

    expect(isUnlocked()).toBe(false);
  }, 30000);

  it('lockEncryptionForSessionEnd() (idle / cross-tab / session-expiry) locks the key manager', async () => {
    await setupAndUnlock();
    expect(isUnlocked()).toBe(true);

    dmEncryption.lockEncryptionForSessionEnd();

    expect(isUnlocked()).toBe(false);
  }, 30000);
});
