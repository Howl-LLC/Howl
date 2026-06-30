// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * File encryption utilities for E2E encrypted DMs.
 * Uses AES-256-GCM via Web Crypto API.
 *
 * HWL4 — the single committing, padded, AAD-bound attachment format. There is no
 * legacy read path (clean cutover).
 *   Header: MAGIC "HWL4"(4) || CHUNK_SIZE(4 LE) || CHUNK_COUNT(4 LE) || REAL_SIZE(8 LE) || COMMIT_TAG(32)
 *   Each chunk: IV(12) || AES-GCM ciphertext (Padmé-padded plaintext + 16-byte tag)
 *   The 32-byte file key is HKDF-expanded into an AES encryption subkey and a
 *   key-commitment tag: the tag is stored in the header and verified by
 *   recomputation before any chunk is decrypted, so a ciphertext commits to
 *   exactly one file key. Plaintext is Padmé-padded and every chunk is
 *   AES-256-GCM bound to (chunkIndex, realSize) as AAD, giving whole-file
 *   ordering/length integrity. Chunk IVs incorporate the chunk index via XOR.
 */

import { toBase64, fromBase64, toArrayBuffer } from './cryptoHelpers';

// HWL4 — the single committing, padded, AAD-bound attachment format. There is no
// legacy read path (clean cutover).
const HWL4_MAGIC = new Uint8Array([0x48, 0x57, 0x4c, 0x34]); // "HWL4"
const HEADER_SIZE = 52;          // MAGIC(4) | CHUNK_SIZE(4) | CHUNK_COUNT(4) | REAL_SIZE(8) | COMMIT_TAG(32)
const COMMIT_TAG_SIZE = 32;
const CHUNK_SIZE = 64 * 1024;    // 64 KiB plaintext per chunk
const AES_GCM_TAG_SIZE = 16;
const IV_SIZE = 12;

// Smallest possible encrypted chunk on the wire: IV + GCM tag (zero-length plaintext is valid GCM).
const MIN_ENC_CHUNK_SIZE = IV_SIZE + AES_GCM_TAG_SIZE;
// Absolute sane upper bound on the header-declared per-chunk plaintext size. The encoder always
// writes exactly CHUNK_SIZE (64 KiB); allow generous headroom for forward-compat but reject the
// 4-billion values a malformed/hostile header could carry.
const MAX_CHUNK_PLAINTEXT_SIZE = 16 * 1024 * 1024; // 16 MiB
// Absolute sane upper bound on the header-declared chunk count, independent of blob length.
// Largest plan upload cap is 500 MiB; at the 64 KiB chunk size that is ~8000 chunks. This cap
// comfortably exceeds that while still rejecting the unbounded values a hostile header could carry.
const MAX_CHUNK_COUNT = 1_000_000;

/** Generate a random 32-byte AES key for file encryption. */
export function generateFileKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Derive a per-chunk IV from a base IV and chunk index.
 * XORs the chunk index (as 4 little-endian bytes) into the last 4 bytes of the IV.
 * This ensures each chunk gets a unique IV and prevents reordering attacks.
 */
function deriveChunkIV(baseIV: Uint8Array, chunkIndex: number): Uint8Array {
  const iv = new Uint8Array(baseIV);
  // XOR chunk index into last 4 bytes (little-endian)
  iv[8] ^= (chunkIndex & 0xff);
  iv[9] ^= ((chunkIndex >> 8) & 0xff);
  iv[10] ^= ((chunkIndex >> 16) & 0xff);
  iv[11] ^= ((chunkIndex >> 24) & 0xff);
  return iv;
}

/**
 * Write a 32-bit unsigned integer in little-endian into a Uint8Array at offset.
 */
function writeUint32LE(arr: Uint8Array, value: number, offset: number): void {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >> 8) & 0xff;
  arr[offset + 2] = (value >> 16) & 0xff;
  arr[offset + 3] = (value >> 24) & 0xff;
}

/**
 * Read a 32-bit unsigned integer in little-endian from a Uint8Array at offset.
 */
function readUint32LE(arr: Uint8Array, offset: number): number {
  return arr[offset] | (arr[offset + 1] << 8) | (arr[offset + 2] << 16) | ((arr[offset + 3] << 24) >>> 0);
}

/** Write a 64-bit unsigned integer in little-endian (value < 2^53). */
function writeUint64LE(arr: Uint8Array, value: number, offset: number): void {
  writeUint32LE(arr, value >>> 0, offset);
  writeUint32LE(arr, Math.floor(value / 0x100000000) >>> 0, offset + 4);
}

/** Read a 64-bit unsigned integer in little-endian (result < 2^53). */
function readUint64LE(arr: Uint8Array, offset: number): number {
  return readUint32LE(arr, offset + 4) * 0x100000000 + readUint32LE(arr, offset);
}

/** Constant-time equality for two equal-length byte arrays (commitment compare). */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Padmé padding (Nikitin et al., PETS 2019): round n UP so the lowest bits are
 * zero, bounding the size leak with ≤ ~12% overhead (far less for large files).
 */
function padmeSize(n: number): number {
  if (n <= 2) return n;
  const e = Math.floor(Math.log2(n));
  const s = Math.floor(Math.log2(e)) + 1;
  const bucket = Math.pow(2, e - s);
  return Math.ceil(n / bucket) * bucket;
}

/** AAD bound into every chunk: chunkIndex(4 LE) || realSize(8 LE). */
function buildChunkAAD(index: number, realSize: number): Uint8Array {
  const aad = new Uint8Array(12);
  writeUint32LE(aad, index, 0);
  writeUint64LE(aad, realSize, 4);
  return aad;
}

/**
 * Derive the AES encryption subkey and a key-commitment tag from the random file
 * key via HKDF-SHA256 under domain-separated labels. The commitTag is stored in
 * the header and verified by recomputation before any decrypt, so a ciphertext
 * commits to exactly one file key (no invisible salamanders).
 */
async function deriveFileSubkeys(fileKey: Uint8Array): Promise<{ encKey: CryptoKey; commitTag: Uint8Array }> {
  const base = await crypto.subtle.importKey('raw', toArrayBuffer(fileKey), 'HKDF', false, ['deriveBits']);
  const enc = new TextEncoder();
  const empty = new Uint8Array(0);
  const encBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: empty, info: enc.encode('howl-file-enc-v4') }, base, 256);
  const commitBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: empty, info: enc.encode('howl-file-commit-v4') }, base, 256);
  const encKey = await crypto.subtle.importKey('raw', encBits, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { encKey, commitTag: new Uint8Array(commitBits) };
}

/**
 * Validate the (unauthenticated) chunked header before allocating or looping on it.
 *
 * The chunked formats carry CHUNK_SIZE/CHUNK_COUNT in a plaintext header that is read before any
 * chunk is authenticated. Without bounds, a hostile blob declaring e.g. CHUNK_COUNT = 0xFFFFFFFF
 * forces ~4.29 billion loop iterations (each slicing the blob and attempting a decrypt), an
 * unbounded-allocation / long-loop DoS. We bound the header against (a) the actual ciphertext byte
 * length — the claimed chunks cannot exceed what the buffer can physically hold — and (b) sane
 * absolute maximums, rejecting malformed/oversized headers early with a clear error.
 *
 * @returns the validated, encoder-style per-chunk encrypted size (encChunkSize).
 */
function validateChunkedHeader(
  chunkPlaintextSize: number,
  chunkCount: number,
  blobSize: number,
): number {
  if (chunkPlaintextSize < 1 || chunkPlaintextSize > MAX_CHUNK_PLAINTEXT_SIZE) {
    throw new Error('Malformed encrypted file: invalid chunk size header');
  }
  if (chunkCount < 1 || chunkCount > MAX_CHUNK_COUNT) {
    throw new Error('Malformed encrypted file: invalid chunk count header');
  }
  // Each chunk occupies at minimum IV + GCM tag bytes on the wire, so the body (everything after
  // the header) cannot hold more than floor(body / MIN_ENC_CHUNK_SIZE) chunks. A header claiming
  // more than the buffer can hold is malformed (or a truncation/DoS attempt) — reject it before the
  // loop rather than slicing past the end of the blob chunkCount times.
  const bodySize = blobSize - HEADER_SIZE;
  if (bodySize < MIN_ENC_CHUNK_SIZE) {
    throw new Error('Malformed encrypted file: truncated body');
  }
  const maxChunksForBlob = Math.floor(bodySize / MIN_ENC_CHUNK_SIZE);
  if (chunkCount > maxChunksForBlob) {
    throw new Error('Malformed encrypted file: chunk count exceeds ciphertext length');
  }
  // Exact-fit geometry: the body must be EXACTLY (chunkCount-1) full wire chunks
  // plus a final chunk in [MIN_ENC_CHUNK_SIZE .. encChunkSize]. The upper-bound
  // check above stops the DoS but still admits an under/over-declared count that
  // mis-slices the body (e.g. a whole-chunk drop with a decremented count, or an
  // interior truncation). Requiring an exact fit rejects those.
  const encChunkSize = IV_SIZE + chunkPlaintextSize + AES_GCM_TAG_SIZE;
  const lastBytes = bodySize - (chunkCount - 1) * encChunkSize;
  if (lastBytes < MIN_ENC_CHUNK_SIZE || lastBytes > encChunkSize) {
    throw new Error('Malformed encrypted file: chunk count does not fit ciphertext length');
  }
  return encChunkSize;
}

/**
 * Encrypt a file blob into the HWL4 envelope: HKDF subkeys + key commitment,
 * Padmé-padded plaintext, per-chunk AES-256-GCM bound to (chunkIndex, realSize).
 * Streams in CHUNK_SIZE pieces; padding is zero-filled on the fly.
 */
export async function encryptFile(file: File | Blob, fileKey: Uint8Array): Promise<Blob> {
  const { encKey, commitTag } = await deriveFileSubkeys(fileKey);
  const realSize = file.size;
  const paddedSize = padmeSize(realSize);
  const chunkCount = Math.max(1, Math.ceil(paddedSize / CHUNK_SIZE));
  const baseIV = crypto.getRandomValues(new Uint8Array(IV_SIZE));

  const header = new Uint8Array(HEADER_SIZE);
  header.set(HWL4_MAGIC, 0);
  writeUint32LE(header, CHUNK_SIZE, 4);
  writeUint32LE(header, chunkCount, 8);
  writeUint64LE(header, realSize, 12);
  header.set(commitTag, 20);

  const parts: BlobPart[] = [header];
  for (let i = 0; i < chunkCount; i++) {
    const chunkStart = i * CHUNK_SIZE;
    const chunkLen = Math.min(chunkStart + CHUNK_SIZE, paddedSize) - chunkStart;
    const realInChunk = Math.max(0, Math.min(realSize - chunkStart, chunkLen));
    const plaintext = new Uint8Array(chunkLen); // zero-filled; padding tail stays zero
    if (realInChunk > 0) {
      const slice = file.slice(chunkStart, chunkStart + realInChunk);
      plaintext.set(new Uint8Array(await slice.arrayBuffer()), 0);
    }
    const iv = deriveChunkIV(baseIV, i);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(buildChunkAAD(i, realSize)) },
      encKey,
      toArrayBuffer(plaintext),
    );
    parts.push(toArrayBuffer(iv));
    parts.push(ciphertext);
  }
  return new Blob(parts);
}

/** True iff the header carries the HWL4 magic. */
function isHWL4(header: Uint8Array): boolean {
  return header.length >= 4 &&
    header[0] === HWL4_MAGIC[0] && header[1] === HWL4_MAGIC[1] &&
    header[2] === HWL4_MAGIC[2] && header[3] === HWL4_MAGIC[3];
}

/**
 * Decrypt an HWL4 attachment blob. Verifies the key commitment before any chunk
 * is decrypted, authenticates (chunkIndex, realSize) per chunk, then strips
 * Padmé padding back to the true length.
 */
export async function decryptFile(encryptedBlob: Blob, fileKey: Uint8Array): Promise<Blob> {
  const headerBytes = new Uint8Array(await encryptedBlob.slice(0, HEADER_SIZE).arrayBuffer());
  if (headerBytes.length < HEADER_SIZE || !isHWL4(headerBytes)) {
    throw new Error('Unsupported or malformed attachment format');
  }
  const chunkPlaintextSize = readUint32LE(headerBytes, 4);
  const chunkCount = readUint32LE(headerBytes, 8);
  const realSize = readUint64LE(headerBytes, 12);
  const storedCommit = headerBytes.subarray(20, 20 + COMMIT_TAG_SIZE);

  // Cheap, key-free DoS bound on the untrusted header before any allocation/loop.
  const encChunkSize = validateChunkedHeader(chunkPlaintextSize, chunkCount, encryptedBlob.size);
  if (realSize > chunkCount * chunkPlaintextSize) {
    throw new Error('Malformed encrypted file: real size exceeds padded capacity');
  }

  // Verify the commitment BEFORE decrypting any chunk (partitioning-oracle resistance).
  const { encKey, commitTag } = await deriveFileSubkeys(fileKey);
  if (!constantTimeEqual(commitTag, storedCommit)) {
    throw new Error('Attachment key commitment mismatch');
  }

  const parts: BlobPart[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunkStart = HEADER_SIZE + i * encChunkSize;
    const chunkEnd = i < chunkCount - 1 ? chunkStart + encChunkSize : encryptedBlob.size;
    const chunkData = new Uint8Array(await encryptedBlob.slice(chunkStart, chunkEnd).arrayBuffer());
    const iv = chunkData.subarray(0, IV_SIZE);
    const ciphertext = chunkData.subarray(IV_SIZE);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(buildChunkAAD(i, realSize)) },
      encKey,
      toArrayBuffer(ciphertext),
    );
    parts.push(plaintext);
  }
  // Strip the Padmé padding back to the true plaintext length.
  return new Blob(parts).slice(0, realSize);
}

/** Generate a thumbnail for image files. Returns null for non-image files. */
export async function generateThumbnail(file: File, maxDim = 256): Promise<{ blob: Blob; width: number; height: number } | null> {
  if (!file.type.startsWith('image/')) return null;

  // Sender side: skip thumbnailing absurd images rather than decoding them.
  const { parseImageDimensions, MAX_DECODE_PIXELS } = await import('./mediaDecodeGuard');
  try {
    const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
    const dims = parseImageDimensions(head);
    if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) return null;
  } catch { /* unparseable — fall through to the existing createImageBitmap path */ }

  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;

  // Calculate scaled dimensions
  const scale = Math.min(maxDim / width, maxDim / height, 1);
  const thumbW = Math.round(width * scale);
  const thumbH = Math.round(height * scale);

  // Use OffscreenCanvas if available, fall back to regular canvas
  let blob: Blob;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(thumbW, thumbH);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, thumbW, thumbH);
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = thumbW;
    canvas.height = thumbH;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, thumbW, thumbH);
    blob = await new Promise<Blob>((resolve) => {
      canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.7);
    });
  }

  bitmap.close();
  return { blob, width: thumbW, height: thumbH };
}

export { toBase64 as fileKeyToBase64, fromBase64 as fileKeyFromBase64 };
