// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Display fingerprint for an account identity key (AIK), for the key-change
 * acknowledge UI. SHA-256 over a labeled (userId, key) pair so the same key renders
 * differently per account (a cross-user collision can't be faked by key reuse),
 * truncated to 128 bits and grouped for out-of-band comparison. Display-only —
 * never used by the verification path.
 */
export async function aikFingerprint(userId: string, aikB64: string): Promise<string> {
  const data = new TextEncoder().encode(`howl:aik-fp:v1|${userId}|${aikB64}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  let hex = '';
  for (let i = 0; i < 16; i++) hex += digest[i].toString(16).padStart(2, '0');
  return hex.match(/.{4}/g)!.join(' ');
}
