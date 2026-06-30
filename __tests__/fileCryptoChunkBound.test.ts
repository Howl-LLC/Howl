// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * HWL4 chunk-header DoS bound. The chunked decrypt reads CHUNK_SIZE/CHUNK_COUNT
 * from an unauthenticated header before any chunk is authenticated; a hostile
 * header (e.g. CHUNK_COUNT = 0xFFFFFFFF) must be rejected before any loop/alloc.
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

const HEADER_SIZE = 52;
const CHUNK_SIZE = 64 * 1024;
const IV_SIZE = 12;
const TAG_SIZE = 16;
const HWL4 = [0x48, 0x57, 0x4c, 0x34];

function writeU32LE(a: Uint8Array, v: number, o: number) {
  a[o] = v & 0xff; a[o + 1] = (v >> 8) & 0xff; a[o + 2] = (v >> 16) & 0xff; a[o + 3] = (v >> 24) & 0xff;
}
/** Build an HWL4 header carrying an attacker-chosen chunkSize/chunkCount. The
 *  COMMIT_TAG is arbitrary: the DoS bound runs BEFORE the commitment check. */
function badHeader(chunkSize: number, chunkCount: number): Uint8Array {
  const h = new Uint8Array(HEADER_SIZE);
  h.set(HWL4, 0); writeU32LE(h, chunkSize, 4); writeU32LE(h, chunkCount, 8);
  return h;
}
function blobFrom(...parts: Uint8Array[]): Blob { return new Blob(parts.map((p) => toArrayBuffer(p))); }
function rand(n: number): Uint8Array {
  const o = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) globalThis.crypto.getRandomValues(o.subarray(i, Math.min(i + 65536, n)));
  return o;
}

describe('fileCrypto HWL4 — chunk-header DoS bound', () => {
  it('round-trips single- and multi-chunk files', async () => {
    for (const n of [19, 150 * 1024]) {
      const key = generateFileKey();
      const enc = await encryptFile(blobFrom(rand(n)), key);
      const dec = new Uint8Array(await (await decryptFile(enc, key)).arrayBuffer());
      expect(dec.length).toBe(n);
    }
  });

  it('rejects an oversized chunkCount (0xFFFFFFFF) fast (no billion-iteration loop)', async () => {
    const key = generateFileKey();
    const body = rand(IV_SIZE + TAG_SIZE + 4);
    const t0 = Date.now();
    await expect(decryptFile(blobFrom(badHeader(CHUNK_SIZE, 0xffffffff), body), key))
      .rejects.toThrow(/invalid chunk count header/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('rejects a chunkCount exceeding the ciphertext length', async () => {
    const key = generateFileKey();
    const body = rand(IV_SIZE + TAG_SIZE + 4);
    await expect(decryptFile(blobFrom(badHeader(CHUNK_SIZE, 5000), body), key))
      .rejects.toThrow(/chunk count exceeds ciphertext length/);
  });

  it('rejects an oversized chunkSize header', async () => {
    const key = generateFileKey();
    const body = rand(IV_SIZE + TAG_SIZE + 4);
    await expect(decryptFile(blobFrom(badHeader(0xffffffff, 1), body), key))
      .rejects.toThrow(/invalid chunk size header/);
  });

  it('rejects a zero chunkCount header', async () => {
    const key = generateFileKey();
    const body = rand(IV_SIZE + TAG_SIZE + 4);
    await expect(decryptFile(blobFrom(badHeader(CHUNK_SIZE, 0), body), key))
      .rejects.toThrow(/invalid chunk count header/);
  });

  it('a valid header but wrong key fails at the commitment check, not the loop', async () => {
    const key = generateFileKey();
    const enc = await encryptFile(blobFrom(rand(1000)), key);
    await expect(decryptFile(enc, generateFileKey())).rejects.toThrow(/commitment/i);
  });
});
