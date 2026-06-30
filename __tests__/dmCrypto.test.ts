// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * dmCrypto coverage.
 *
 * Verifies:
 *   - deriveUnlockMaterial returns a historyKey distinct from atRestKey,
 *     deterministic per password+salt.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { argon2id } from 'hash-wasm';
import { deriveUnlockMaterial, encryptRecoveryBlob, decryptRecoveryBlob } from '../services/dmCrypto';

// jsdom does not ship WebCrypto - pull Node's @peculiar polyfill if missing.
beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

describe('deriveUnlockMaterial - historyKey', () => {
  const salt = new Uint8Array(16).fill(7);

  it('returns a historyKey distinct from atRestKey, deterministic per password+salt', async () => {
    const a = await deriveUnlockMaterial('correct horse battery staple', salt);
    expect(a.historyKey).toBeInstanceOf(CryptoKey);

    // distinct keys: ciphertext under historyKey must not decrypt under atRestKey
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, a.historyKey, new TextEncoder().encode('hi'));
    await expect(
      crypto.subtle.decrypt({ name: 'AES-GCM', iv }, a.atRestKey, ct),
    ).rejects.toBeTruthy();

    // deterministic: same password+salt reproduces a key that decrypts the same ciphertext
    const b = await deriveUnlockMaterial('correct horse battery staple', salt);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, b.historyKey, ct);
    expect(new TextDecoder().decode(pt)).toBe('hi');
  });
});

describe('deriveUnlockMaterial - blobKey domain separation', () => {
  const salt = new Uint8Array(16).fill(9);
  const PW = 'correct horse battery staple';

  it('derives blobKey via HKDF under the howl-blob-key label, distinct from atRest/history and deterministic', async () => {
    const a = await deriveUnlockMaterial(PW, salt);
    expect(a.blobKey).toBeInstanceOf(CryptoKey);

    // domain separation: a blobKey ciphertext must NOT open under atRestKey or historyKey
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, a.blobKey, new TextEncoder().encode('vault'));
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, a.atRestKey, ct)).rejects.toBeTruthy();
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, a.historyKey, ct)).rejects.toBeTruthy();

    // deterministic: same password+salt reproduces a blobKey that opens the ciphertext
    const b = await deriveUnlockMaterial(PW, salt);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, b.blobKey, ct);
    expect(new TextDecoder().decode(pt)).toBe('vault');

    // pins the exact derivation: independently HKDF('howl-blob-key') the raw Argon2id hash
    const rawHash = await argon2id({ password: PW, salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: 'binary' });
    const ikm = await crypto.subtle.importKey('raw', rawHash.buffer as ArrayBuffer, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('howl-blob-key') }, ikm, 256);
    const expected = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['decrypt']);
    const pt2 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, expected, ct);
    expect(new TextDecoder().decode(pt2)).toBe('vault');

    // regression guard: blobKey must NOT equal the raw-hash key (the old behavior)
    const rawKey = await crypto.subtle.importKey('raw', rawHash.buffer as ArrayBuffer, 'AES-GCM', false, ['decrypt']);
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, rawKey, ct)).rejects.toBeTruthy();
  });
});

describe('recovery blob AAD binding', () => {
  const recKey = new Uint8Array(32).fill(3);
  const contents = { privateKey: btoa('x'.repeat(32)) } as any;
  const AAD_A = 'howl:recovery:v1:pubA';
  const AAD_B = 'howl:recovery:v1:pubB';

  it('round-trips under the same identity AAD', async () => {
    const { ciphertext, nonce } = await encryptRecoveryBlob(contents, recKey, AAD_A);
    const out = await decryptRecoveryBlob(ciphertext, nonce, recKey, AAD_A);
    expect(out.privateKey).toBe(contents.privateKey);
  });

  it('fails to open under a different identity AAD (anti-splice)', async () => {
    const { ciphertext, nonce } = await encryptRecoveryBlob(contents, recKey, AAD_A);
    await expect(decryptRecoveryBlob(ciphertext, nonce, recKey, AAD_B)).rejects.toBeTruthy();
  });
});
