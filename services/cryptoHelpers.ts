// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Shared low-level helpers for the encryption layer.
 * Pure functions, no state, no imports — safe to import from any crypto module.
 */

/** Encode a Uint8Array to a base64 string (loop-based to avoid stack overflow on large arrays). */
export function toBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}

/** Decode a base64 string to a Uint8Array. */
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** Convert a Uint8Array to an ArrayBuffer for Web Crypto API compatibility. */
export function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}

/** Zero-fill a Uint8Array before dereferencing (best-effort memory cleanup). */
export function zeroFill(arr: Uint8Array | null | undefined): void {
  if (arr) arr.fill(0);
}
