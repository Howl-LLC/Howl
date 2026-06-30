// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Layer 2: fetchAndDecryptFile cross-checks the reassembled
 * plaintext length against the MLS-authenticated file size.
 *
 * This is the only control that catches a trailing WHOLE-chunk drop (or a
 * length-changing duplication) on a legacy v2 blob: the per-chunk IV check in
 * decryptChunked accepts a truncated-but-self-consistent chunk prefix (it is
 * byte-for-byte indistinguishable from a file that genuinely ended there), so the
 * authenticated size sealed in the message envelope is what rejects it.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { encryptFile, generateFileKey } from '../services/fileCrypto';
import { fetchAndDecryptFile } from '../services/dmEncryption';
import { toArrayBuffer } from '../services/cryptoHelpers';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

afterEach(() => { vi.unstubAllGlobals(); });

const CHUNK_SIZE = 64 * 1024;
const IV_SIZE = 12, TAG_SIZE = 16, HEADER_SIZE = 12;
const ENC_CHUNK = IV_SIZE + CHUNK_SIZE + TAG_SIZE;

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let off = 0; off < len; off += 65536) globalThis.crypto.getRandomValues(out.subarray(off, Math.min(off + 65536, len)));
  return out;
}
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

/** Mock the two-hop fetch fetchAndDecryptFile performs: `?as=json` -> {url}, then the CDN blob. */
function stubFetch(servedBlob: Blob) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (String(input).includes('as=json')) {
      return { ok: true, json: async () => ({ url: 'https://cdn.test/object' }) } as unknown as Response;
    }
    return { ok: true, blob: async () => servedBlob } as unknown as Response;
  }));
}

describe('fetchAndDecryptFile authenticated-size cross-check (Layer 2)', () => {
  it('returns the plaintext when the decrypted size matches the authenticated size', async () => {
    const fileKey = generateFileKey();
    const plaintext = randomBytes(3 * CHUNK_SIZE);
    const enc = await encryptFile(new Blob([toArrayBuffer(plaintext)]), fileKey);
    stubFetch(enc);

    const out = await fetchAndDecryptFile('/api/uploads/abc', b64(fileKey), plaintext.length);
    expect(out).not.toBeNull();
    expect((await out!.arrayBuffer()).byteLength).toBe(plaintext.length);
  });

  it('returns null when the decrypted size does not match the authenticated size (length tamper)', async () => {
    const fileKey = generateFileKey();
    const plaintext = randomBytes(3 * CHUNK_SIZE);
    const enc = await encryptFile(new Blob([toArrayBuffer(plaintext)]), fileKey);
    stubFetch(enc);

    // Authenticated size claims one byte more than the blob decrypts to.
    const out = await fetchAndDecryptFile('/api/uploads/abc', b64(fileKey), plaintext.length + 1);
    expect(out).toBeNull();
  });

  it('rejects a real trailing-whole-chunk-drop that the per-chunk IV check accepts', async () => {
    const fileKey = generateFileKey();
    const plaintext = randomBytes(3 * CHUNK_SIZE); // 3 uniform full chunks
    const encBytes = new Uint8Array(await (await encryptFile(new Blob([toArrayBuffer(plaintext)]), fileKey)).arrayBuffer());
    // Drop the last chunk and decrement the v3 count -> a valid 2-chunk blob.
    const header = new Uint8Array(encBytes.subarray(0, HEADER_SIZE));
    header[8] = 2; header[9] = 0; header[10] = 0; header[11] = 0; // chunkCount = 2 (LE)
    const truncated = new Blob([
      toArrayBuffer(header),
      toArrayBuffer(encBytes.subarray(HEADER_SIZE, HEADER_SIZE + 2 * ENC_CHUNK)),
    ]);
    stubFetch(truncated);

    // The authenticated size is the ORIGINAL 3-chunk plaintext length -> mismatch -> null.
    const out = await fetchAndDecryptFile('/api/uploads/abc', b64(fileKey), plaintext.length);
    expect(out).toBeNull();
  });

  it('without an expectedSize, returns the plaintext (no cross-check; Layer 1 still applies)', async () => {
    const fileKey = generateFileKey();
    const plaintext = randomBytes(CHUNK_SIZE);
    const enc = await encryptFile(new Blob([toArrayBuffer(plaintext)]), fileKey);
    stubFetch(enc);

    const out = await fetchAndDecryptFile('/api/uploads/abc', b64(fileKey));
    expect(out).not.toBeNull();
    expect((await out!.arrayBuffer()).byteLength).toBe(plaintext.length);
  });
});
