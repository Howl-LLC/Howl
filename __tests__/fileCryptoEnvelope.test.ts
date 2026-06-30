// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * HWL4 attachment envelope — key commitment, Padmé padding,
 * chunk-index + realSize AAD ordering/length integrity.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { encryptFile, decryptFile, generateFileKey } from '../services/fileCrypto';
import { toArrayBuffer } from '../services/cryptoHelpers';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const HWL4 = [0x48, 0x57, 0x4c, 0x34];

function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) {
    globalThis.crypto.getRandomValues(out.subarray(off, Math.min(off + 65536, n)));
  }
  return out;
}
function blobOf(u8: Uint8Array): Blob { return new Blob([toArrayBuffer(u8)]); }
function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
async function u8(b: Blob): Promise<Uint8Array> { return new Uint8Array(await b.arrayBuffer()); }

describe('HWL4 envelope', () => {
  it('writes the HWL4 magic and round-trips a small file exactly', async () => {
    const key = generateFileKey();
    const pt = new TextEncoder().encode('hello attachment');
    const enc = await encryptFile(blobOf(pt), key);
    const head = await u8(enc.slice(0, 4));
    expect([head[0], head[1], head[2], head[3]]).toEqual(HWL4);
    expect(eq(await u8(await decryptFile(enc, key)), pt)).toBe(true);
  });

  it('round-trips empty, single-chunk, exact-boundary, and multi-chunk files', async () => {
    for (const n of [0, 1, 1000, 64 * 1024, 64 * 1024 + 1, 150 * 1024]) {
      const key = generateFileKey();
      const pt = bytes(n);
      const dec = await decryptFile(await encryptFile(blobOf(pt), key), key);
      expect(dec.size).toBe(n);                       // padding fully stripped
      expect(eq(await u8(dec), pt)).toBe(true);
    }
  });

  it('pads ciphertext to a Padmé bucket larger than the plaintext', async () => {
    const key = generateFileKey();
    const pt = bytes(1000);                            // padme(1000) = 1024
    const enc = await encryptFile(blobOf(pt), key);
    // header(52) + 1 chunk(IV 12 + 1024 plaintext + 16 tag) = 52 + 1052 = 1104
    expect(enc.size).toBe(52 + 12 + 1024 + 16);
  });

  it('rejects decryption under a different file key at the commitment check', async () => {
    const pt = bytes(2048);
    const enc = await encryptFile(blobOf(pt), generateFileKey());
    await expect(decryptFile(enc, generateFileKey()))
      .rejects.toThrow(/commitment/i);
  });

  it('rejects a tampered commitment tag', async () => {
    const key = generateFileKey();
    const enc = await u8(await encryptFile(blobOf(bytes(2048)), key));
    enc[20] ^= 0xff;                                   // flip a COMMIT_TAG byte (offset 20)
    await expect(decryptFile(blobOf(enc), key)).rejects.toThrow(/commitment/i);
  });

  it('rejects a tampered REAL_SIZE header (AAD binding)', async () => {
    const key = generateFileKey();
    const enc = await u8(await encryptFile(blobOf(bytes(2048)), key));
    enc[12] ^= 0x01;                                   // flip a REAL_SIZE byte (offset 12) → AAD mismatch
    await expect(decryptFile(blobOf(enc), key)).rejects.toThrow();
  });

  it('rejects swapped chunks in a multi-chunk file (chunk-index AAD)', async () => {
    const key = generateFileKey();
    const enc = await u8(await encryptFile(blobOf(bytes(150 * 1024)), key));
    // encChunkSize = IV(12) + CHUNK_SIZE(65536) + TAG(16) = 65564; chunks start at 52
    const A = 52, B = 52 + 65564;
    const tmp = enc.slice(A, A + 65564);
    enc.copyWithin(A, B, B + 65564);
    enc.set(tmp, B);
    await expect(decryptFile(blobOf(enc), key)).rejects.toThrow();
  });

  it('rejects a non-HWL4 (legacy/unknown) magic — clean cutover', async () => {
    const key = generateFileKey();
    const legacy = new Uint8Array([0x48, 0x57, 0x4c, 0x33, /* "HWL3" */ ...bytes(60)]);
    await expect(decryptFile(blobOf(legacy), key)).rejects.toThrow(/format/i);
  });
});
