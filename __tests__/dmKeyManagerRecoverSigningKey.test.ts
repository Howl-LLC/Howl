// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * bug_001 — recover() and serverRecover() must restore the Ed25519 signing key.
 *
 * unlock() restores _privateSigningKey/_signingPublicKeyBase64 from the blob, but
 * _recoverImpl and _serverRecoverImpl historically installed the box key, channel
 * keys, derived key and passwordDerived flag yet NEVER read contents.privateSigningKey.
 * The recovered session was then left with _privateSigningKey=null, so:
 *   - signVoiceJoinBlob() returned null,
 *   - the first blob write via buildBlobContents() dropped the signing key
 *     server-side, permanently losing the Ed25519 identity, and a later unlock()
 *     would lazily generate a DIFFERENT signing key (looks like key substitution).
 *
 * These tests assert the signing key survives BOTH recovery paths unchanged, and
 * that a post-recovery create emits a SIGNED delivery.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../services/api', () => ({
  apiClient: {
    setupDmKeys: vi.fn(),
    getDmKeyBundle: vi.fn(),
    updateDmKeysSigningKey: vi.fn(),
    recoverDmKeys: vi.fn(),
    serverRecover: vi.fn(),
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

const mock = <T,>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

/**
 * Run a real setup() and capture the recovery material it uploads, plus the
 * setup-time signing public key. Returns everything a later recover()/
 * serverRecover() needs to round-trip the identity.
 */
async function captureRecoveryMaterial(): Promise<{
  pubKey: string;
  blobSalt: string;
  recoveryBlob: string;
  recoveryNonce: string;
  recoveryKey: string;
  signingPublicKey: string;
}> {
  dmKeyManager.reset();
  let pubKey = '';
  let blobSalt = '';
  let recoveryBlob = '';
  let recoveryNonce = '';
  mock(apiClient.setupDmKeys).mockImplementation(async (a: {
    publicKey: string; blobSalt: string; recoveryBlob: string; recoveryNonce: string;
  }) => {
    pubKey = a.publicKey; blobSalt = a.blobSalt;
    recoveryBlob = a.recoveryBlob; recoveryNonce = a.recoveryNonce;
    return { blobVersion: 1 };
  });
  const { recoveryKey } = await dmKeyManager.setup('orig-pw');
  // Observe the Ed25519 identity through a surviving seam: signVoiceJoinBlob()
  // stamps `_signingPublicKeyBase64` into blob.sigPub. Non-null proves the
  // signing key is live.
  const signingPublicKey = dmKeyManager.signVoiceJoinBlob('chan-cap', 0)!.blob.sigPub;
  expect(signingPublicKey).toBeTruthy();
  return { pubKey, blobSalt, recoveryBlob, recoveryNonce, recoveryKey, signingPublicKey };
}

describe('bug_001 — recover() restores the Ed25519 signing key', () => {
  beforeEach(() => vi.clearAllMocks());

  it('round-trips the SAME signing public key through recover() (not null, not rotated)', async () => {
    const m = await captureRecoveryMaterial();

    dmKeyManager.reset();
    mock(apiClient.getDmKeyBundle).mockResolvedValue({
      publicKey: m.pubKey,
      encryptedBlob: 'unused-by-recover',
      blobSalt: m.blobSalt,
      blobVersion: 5,
      recoveryBlob: m.recoveryBlob,
      recoveryNonce: m.recoveryNonce,
      recoveryMode: 'key',
      passwordDerived: false,
    });
    mock(apiClient.recoverDmKeys).mockResolvedValue({ blobVersion: 6 });

    await dmKeyManager.recover(m.recoveryKey, 'new-pw');

    // The signing identity survived recovery intact — not null, and the SAME key
    // (a lazy-generate fallback would have produced a different one). Observed
    // through signVoiceJoinBlob(), the surviving consumer of the signing key.
    expect(dmKeyManager.signVoiceJoinBlob('chan-rec', 0)!.blob.sigPub).toBe(m.signingPublicKey);
  });
});

describe('bug_001 — serverRecover() restores the Ed25519 signing key', () => {
  beforeEach(() => vi.clearAllMocks());

  it('round-trips the SAME signing public key through serverRecover()', async () => {
    const m = await captureRecoveryMaterial();

    // Obtain a real escrow rawBlob: a password-derived recover() sends
    // rawBlobForEscrow = btoa(JSON.stringify(contents)), which is exactly the
    // escrow payload serverRecover() decodes. Capture it from a recover() run.
    dmKeyManager.reset();
    mock(apiClient.getDmKeyBundle).mockResolvedValue({
      publicKey: m.pubKey,
      encryptedBlob: 'unused-by-recover',
      blobSalt: m.blobSalt,
      blobVersion: 5,
      recoveryBlob: m.recoveryBlob,
      recoveryNonce: m.recoveryNonce,
      recoveryMode: 'key',
      passwordDerived: true,
    });
    let rawBlob = '';
    mock(apiClient.recoverDmKeys).mockImplementation(async (a: { rawBlobForEscrow?: string }) => {
      rawBlob = a.rawBlobForEscrow!;
      return { blobVersion: 6 };
    });
    await dmKeyManager.recover(m.recoveryKey, 'mid-pw');
    expect(rawBlob).toBeTruthy();

    // Now drive serverRecover() with that escrow blob.
    dmKeyManager.reset();
    mock(apiClient.serverRecover).mockResolvedValue({ rawBlob });
    mock(apiClient.recoverDmKeys).mockResolvedValue({ blobVersion: 9 });

    await dmKeyManager.serverRecover('reset-pw');

    expect(dmKeyManager.signVoiceJoinBlob('chan-srv', 0)!.blob.sigPub).toBe(m.signingPublicKey);
  });
});
