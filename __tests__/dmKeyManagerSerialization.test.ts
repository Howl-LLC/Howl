// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * dmKeyManager forced-teardown safety and unlock ordering
 * (unlock installs _isUnlocked last).
 *
 * These drive the REAL singleton with a mocked apiClient, reproducing the
 * background-event interleavings (socket key deliveries, reconnect, idle-lock,
 * call-accept) that the mutex must serialize.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

vi.mock('../services/api', () => ({
  apiClient: {
    getDmKeyBundle: vi.fn(),
    setupDmKeys: vi.fn(),
    updateDmKeysSigningKey: vi.fn(),
  },
}));

import { apiClient } from '../services/api';
import * as dmKeyManager from '../services/dmKeyManager';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const mock = <T extends (...a: never[]) => unknown>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

/** Set the singleton up fresh (setup writes initial blob at version 1). */
async function freshSetup(): Promise<void> {
  dmKeyManager.reset();
  mock(apiClient.setupDmKeys).mockResolvedValue({ blobVersion: 1 });
  await dmKeyManager.setup('correct horse battery staple');
}

describe('unlock installs _isUnlocked last', () => {
  beforeEach(() => vi.clearAllMocks());

  it('isUnlocked() stays false while the signing-key upload await is outstanding', async () => {
    await freshSetup();
    // Capture identity BEFORE reset; export a blob with no signing key so unlock
    // takes the generate+upload path (the await we probe).
    const pub = dmKeyManager.getPublicKey()!;
    const salt = dmKeyManager.__test_blobSalt();
    const blob = await dmKeyManager.__test_exportServerBlob({ stripSigning: true });
    dmKeyManager.reset();
    mock(apiClient.getDmKeyBundle).mockResolvedValue({
      publicKey: pub,
      encryptedBlob: blob,
      blobVersion: 1,
      blobSalt: salt,
      passwordDerived: false,
    });
    let observedDuringUpload: boolean | null = null;
    let uploadEntered = false;
    let releaseUpload: (v: unknown) => void = () => {};
    mock(apiClient.updateDmKeysSigningKey).mockImplementation(() => {
      uploadEntered = true;
      observedDuringUpload = dmKeyManager.isUnlocked();
      return new Promise((res) => { releaseUpload = () => res({ blobVersion: 2 }); });
    });

    const unlocking = dmKeyManager.unlock('correct horse battery staple');
    // Wait until unlock() has actually reached the signing-key upload await
    // before releasing it. A single microtask tick is not enough: unlock()
    // first awaits the (real, WASM-backed) Argon2id key derivation, so the
    // upload mock — and thus the real releaseUpload — is not assigned yet at
    // that point. Poll on the mock's entry flag instead.
    for (let i = 0; i < 200 && !uploadEntered; i++) await new Promise((r) => setTimeout(r, 10));
    releaseUpload(null);
    await unlocking;

    expect(observedDuringUpload).toBe(false); // identity material not yet "ready"
    expect(dmKeyManager.isUnlocked()).toBe(true);
  });
});
