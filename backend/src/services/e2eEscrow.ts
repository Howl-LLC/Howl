// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import crypto from 'crypto';
import { isValidHexKey32, parseHexKey32 } from './keyValidation.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * The deterministic SHA-256 test escrow key must be reachable ONLY in an explicit
 * test run. Gating on NODE_ENV alone is a footgun: a prod deploy that erroneously
 * sets NODE_ENV=test would silently escrow every opted-in user under a public,
 * source-visible constant. Requiring an additional opt-in flag fails closed.
 * The flag is set by the test harness (tests/setup.ts) and MUST NOT
 * be set in any deployed environment.
 */
function testEscrowKeyAllowed(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.ALLOW_TEST_ESCROW_KEY === '1';
}

/**
 * Get the raw master key from env var.
 * SERVER_E2E_MASTER_KEY must be a 32-byte hex string (64 chars).
 */
function getMasterKey(): Buffer {
  const hex = process.env.SERVER_E2E_MASTER_KEY;
  if (!isValidHexKey32(hex)) {
    // A present, full-length-but-malformed value is never silently degraded:
    // parseHexKey32 throws (naming the var) in every environment, including test.
    if (hex && hex.length >= 64) {
      return parseHexKey32(hex, 'SERVER_E2E_MASTER_KEY');
    }
    // Absent/short keys keep the SHA-256 test fallback, but ONLY inside an explicit
    // test run (NODE_ENV=test AND ALLOW_TEST_ESCROW_KEY=1). Fails closed otherwise
    // so a prod misconfig with NODE_ENV=test can never reach the constant.
    if (testEscrowKeyAllowed()) {
      return crypto.createHash('sha256').update('test-only-e2e-escrow-key').digest();
    }
    throw new Error('SERVER_E2E_MASTER_KEY environment variable is required (64-char hex string).');
  }
  return parseHexKey32(hex, 'SERVER_E2E_MASTER_KEY');
}

/**
 * Derive a per-user escrow key as HKDF(masterKey) with the userId in the salt
 * slot. Per-user derivation gives domain separation — one user's key cannot
 * decrypt another user's escrow ciphertext — but userId is a low-entropy public
 * DB id, so the salt adds no real entropy (RFC 5869 §3.1: the master key is
 * already uniformly random, so a salt isn't needed for strength here).
 *
 * Blast radius — do NOT misread per-user derivation as isolation from a
 * master-key compromise. SERVER_E2E_MASTER_KEY is a SINGLE POINT OF FAILURE:
 * anyone holding it can deterministically reconstruct EVERY opted-in user's
 * escrow key (userId is a public DB id) and decrypt all of their escrowed vault
 * identity + archiveKey out of band — exactly as a single shared AES key would.
 * The HKDF only prevents cross-user reuse of the same ciphertext; it is NOT a
 * safeguard against master-key exposure. Treat the master key as a crown-jewel
 * secret — ideally a KMS/HSM (decrypt-only, rate-limited, audit-logged), not a
 * plain env var.
 *
 * NOTE: the userId is deliberately kept in the HKDF SALT. Moving it into `info`
 * with a fixed salt is pure idiom with zero security gain and rotates every
 * user's derived key, which would break the Server-recovery path of every
 * already-escrowed user; the salt placement preserves byte-compatibility with
 * already-encrypted blobs.
 */
function deriveUserKey(userId: string): Buffer {
  const masterKey = getMasterKey();
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, userId, 'howl-e2e-escrow', 32));
}

/**
 * Encrypt raw blob contents for server-side escrow.
 * Returns base64(IV || ciphertext || authTag).
 */
export function encryptEscrow(userId: string, rawBlobJson: string): string {
  const key = deriveUserKey(userId);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(rawBlobJson, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, encrypted, tag]);
  return combined.toString('base64');
}

/**
 * Decrypt server-side escrow blob. Returns raw blob JSON string.
 * Throws on any failure (wrong key, tampered data, etc.).
 */
export function decryptEscrow(userId: string, escrowBlob: string): string {
  const key = deriveUserKey(userId);
  const combined = Buffer.from(escrowBlob, 'base64');
  if (combined.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Escrow blob too short');
  }
  const iv = combined.subarray(0, IV_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH, combined.length - TAG_LENGTH);
  const tag = combined.subarray(combined.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * Check if the master key is configured. Used at startup and endpoints.
 */
export function isMasterKeyConfigured(): boolean {
  const hex = process.env.SERVER_E2E_MASTER_KEY;
  if (!isValidHexKey32(hex)) {
    // Mirror getMasterKey()'s branch split: a present, full-length-but-malformed
    // value is NOT configured in any environment (the getter throws on it, so the
    // 503 guard must reject rather than let encryptEscrow throw later). Only an
    // absent/short key keeps the test fallback that getMasterKey() also honors.
    if (hex && hex.length >= 64) {
      return false;
    }
    return testEscrowKeyAllowed();
  }
  return true;
}
