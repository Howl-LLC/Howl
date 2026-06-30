// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression: dmKeyManager.unlock() must run the REAL key-load path without
 * crashing.
 *
 * A refactor once introduced an infinite-recursion typo in the private
 * `loadChannelKeysFromBlob` — its first line could call itself instead of
 * populating `_channelKeys` from `contents.channelKeys`. The blob still
 * decrypts first (so the password is correct), then `loadChannelKeysFromBlob`
 * throws `RangeError: Maximum call stack size exceeded`. The UI unlock handler
 * reports any unlock error as "encryption password is wrong", so such a bug
 * would surface as a full E2EE-DM-unlock outage for every user on that build.
 *
 * Why a gap like that can slip through: `e2eeUnlockFlow.test.ts` stubs
 * checkSetup/tryAutoUnlock via vi.spyOn and never calls the real `unlock()`,
 * and the rotation tests only exercise the pure `dmCrypto` layer — so
 * `loadChannelKeysFromBlob` had no test that actually executed it. This test
 * closes that gap by doing a real setup() -> lock() -> unlock() round-trip
 * against the real singleton, mocking only the network. It fails (RangeError)
 * on the buggy version and passes on the fix.
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

const setupDmKeys = apiClient.setupDmKeys as ReturnType<typeof vi.fn>;
const getDmKeyBundle = apiClient.getDmKeyBundle as ReturnType<typeof vi.fn>;

const PASSWORD = 'correct horse battery staple';

beforeEach(() => {
  setupDmKeys.mockReset();
  getDmKeyBundle.mockReset();
});

describe('dmKeyManager.unlock — real key-load round-trip', () => {
  it('decrypts the blob and loads channel keys without throwing (guards loadChannelKeysFromBlob recursion)', async () => {
    // 1. Real setup() produces a real password-encrypted blob and "uploads" it.
    setupDmKeys.mockResolvedValue({ blobVersion: 1 });
    await setup(PASSWORD);

    // Capture exactly what setup() uploaded — the unlock path re-derives the
    // key from this salt and decrypts this blob (AAD binds bundle.publicKey).
    const uploaded = setupDmKeys.mock.calls[0][0] as {
      publicKey: string;
      encryptedBlob: string;
      blobSalt: string;
    };

    // 2. Clear in-memory state so unlock() must rebuild it from the blob.
    lock();
    expect(isUnlocked()).toBe(false);

    // 3. Serve the captured bundle back and unlock with the same password.
    getDmKeyBundle.mockResolvedValue({
      publicKey: uploaded.publicKey,
      encryptedBlob: uploaded.encryptedBlob,
      blobSalt: uploaded.blobSalt,
      blobVersion: 1,
      passwordDerived: false,
    });

    // The crux: on the buggy version this rejects with RangeError (infinite
    // recursion) AFTER a correct-password decrypt; the fix lets it resolve.
    await expect(unlock(PASSWORD)).resolves.toBeUndefined();
    expect(isUnlocked()).toBe(true);
  }, 30000);
});
