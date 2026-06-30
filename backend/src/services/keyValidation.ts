// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
export const HEX_32_RE = /^[0-9a-fA-F]{64}$/;

/** True iff `hex` is a present 64-char (32-byte) hex string. */
export function isValidHexKey32(hex: string | undefined): boolean {
  return typeof hex === 'string' && HEX_32_RE.test(hex);
}

/** Decode a 64-char hex string to a 32-byte Buffer, or throw (naming the env var). */
export function parseHexKey32(hex: string | undefined, name: string): Buffer {
  if (!isValidHexKey32(hex)) {
    throw new Error(`${name} must be a 32-byte hex string (64 hex chars).`);
  }
  const buf = Buffer.from(hex as string, 'hex');
  if (buf.length !== 32) {
    throw new Error(`${name} must decode to exactly 32 bytes.`);
  }
  return buf;
}
