// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Verifies that checkSetup() distinguishes "server says no bundle" (404) from
 * transient backend errors (5xx, network/timeout, post-refresh 401), so an
 * established user with encryption is never mis-classified as needing setup.
 *
 * Background: a bare `catch { _hasBundle = false }` previously collapsed every
 * error into "user has no bundle", which then surfaced the EncryptionChoice /
 * EncryptionPassphrase setup modal in App.tsx for users who already had keys.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/api', () => ({
  apiClient: {
    getDmKeyBundle: vi.fn(),
  },
}));

import { apiClient } from '../services/api';
import { checkSetup, isSetup, isSetupChecked } from '../services/dmKeyManager';

const getBundle = apiClient.getDmKeyBundle as ReturnType<typeof vi.fn>;

function httpError(status: number, message = `Request failed with status ${status}`) {
  return Object.assign(new Error(message), { status });
}

describe('dmKeyManager.checkSetup — error classification', () => {
  beforeEach(() => {
    getBundle.mockReset();
  });

  it('returns true when the server returns a bundle', async () => {
    getBundle.mockResolvedValueOnce({
      publicKey: 'pk',
      encryptedBlob: 'blob',
      blobSalt: 'salt',
      blobVersion: 1,
      passwordDerived: false,
    });

    const result = await checkSetup();

    expect(result).toBe(true);
    expect(isSetup()).toBe(true);
    expect(isSetupChecked()).toBe(true);
  });

  it('returns false when the server authoritatively responds 404', async () => {
    getBundle.mockRejectedValueOnce(httpError(404, 'Secure DMs not set up'));

    const result = await checkSetup();

    expect(result).toBe(false);
    expect(isSetup()).toBe(false);
    expect(isSetupChecked()).toBe(true);
  });

  it('throws on 5xx and leaves prior _hasBundle=true intact', async () => {
    // Establish a known-good state first.
    getBundle.mockResolvedValueOnce({
      publicKey: 'pk',
      encryptedBlob: 'blob',
      blobSalt: 'salt',
      blobVersion: 1,
      passwordDerived: false,
    });
    await checkSetup();
    expect(isSetup()).toBe(true);

    // Transient 5xx should not flip isSetup() to false.
    getBundle.mockRejectedValueOnce(httpError(503, 'Server error. Please try again in a moment.'));
    await expect(checkSetup()).rejects.toMatchObject({ status: 503 });
    expect(isSetup()).toBe(true);
  });

  it('throws on a rewrapped network error (no status field)', async () => {
    // Mirror what api/core.ts does for AbortError / fetch failure: a bare Error
    // with no status property.
    getBundle.mockRejectedValueOnce(
      new Error("Can't reach the server. Check your connection and that the API is available."),
    );

    await expect(checkSetup()).rejects.toThrow(/Can't reach the server/);
  });

  it('throws on 401 (refresh exhaustion) — does not silently demote to no-bundle', async () => {
    getBundle.mockRejectedValueOnce(httpError(401, 'Unauthorized'));
    await expect(checkSetup()).rejects.toMatchObject({ status: 401 });
  });
});
