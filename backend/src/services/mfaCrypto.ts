// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import crypto from 'crypto';
import { isValidHexKey32, parseHexKey32 } from './keyValidation.js';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const hex = process.env.MFA_ENCRYPTION_KEY;
  if (!isValidHexKey32(hex)) {
    // A present, full-length-but-malformed value is never silently degraded:
    // parseHexKey32 throws (naming the var) in every environment, including test.
    if (hex && hex.length >= 64) {
      return parseHexKey32(hex, 'MFA_ENCRYPTION_KEY');
    }
    // Absent/short keys keep the SHA-256 test fallback (dev/test only).
    if (process.env.NODE_ENV === 'test') {
      return crypto.createHash('sha256').update('test-only-mfa-key').digest();
    }
    throw new Error('MFA_ENCRYPTION_KEY environment variable is required (64-char hex string). Set it in backend/.env.');
  }
  return parseHexKey32(hex, 'MFA_ENCRYPTION_KEY');
}

function getEmailHmacKey(): string {
  const key = process.env.EMAIL_HMAC_KEY;
  if (!key || key.length < 32) {
    if (process.env.NODE_ENV === 'test') return 'test-only-email-hmac-key-minimum-32chars';
    throw new Error('EMAIL_HMAC_KEY environment variable is required (min 32 chars). Set it in backend/.env.');
  }
  return key;
}

/** HMAC-SHA256 email hash (keyed, not rainbow-table-vulnerable). */
export function hashEmail(email: string): string {
  return crypto.createHmac('sha256', getEmailHmacKey()).update(email.toLowerCase().trim()).digest('hex');
}

/** Legacy unkeyed SHA-256 hash — used only during migration to find old records. */
export function hashEmailLegacy(email: string): string {
  return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(ciphertext: string): string {
  const key = getKey();
  const [ivHex, tagHex, encHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** Decrypt or return plaintext for pre-migration rows that aren't yet encrypted. */
export function decryptOrPlain(value: string): string {
  try { return decryptSecret(value); } catch { return value; }
}
