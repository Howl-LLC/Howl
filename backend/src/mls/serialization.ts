// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/** Decode a base64 wire string into a Node Buffer for a Prisma Bytes column. */
export function b64ToBuf(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

/** Encode a Prisma Bytes value (Buffer/Uint8Array) to a base64 wire string. */
export function bufToB64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

/**
 * Return a fresh Uint8Array copy of `src`. ts-mls decoders alias views into
 * their input and zeroize consumed buffers back into it; feed copies wherever
 * the same bytes are read more than once (move-not-borrow).
 */
export function copyBytes(src: Uint8Array): Uint8Array {
  return new Uint8Array(src);
}
