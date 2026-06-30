// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import crypto from 'crypto';
import { isValidHexKey32 } from './keyValidation.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = process.env.DM_ENCRYPTION_KEY;
  // Require a STRICT 32-byte hex key. The old length-only
  // check (`hex.length < 64`) accepted a 64-char non-hex value and then silently
  // `Buffer.from(hex,'hex')`-truncated it to a short/weak key. isValidHexKey32
  // enforces exactly /^[0-9a-fA-F]{64}$/ (the same gate as MFA/escrow keys).
  if (!isValidHexKey32(hex)) {
    if (process.env.NODE_ENV === 'test') {
      return crypto.createHash('sha256').update('test-only-dm-encryption-key').digest();
    }
    throw new Error('DM_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars). Set it in backend/.env.');
  }
  return Buffer.from(hex as string, 'hex');
}

export function encryptDmContent(plaintext: string): { ciphertext: string; iv: string } {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Append auth tag to ciphertext so it travels as one base64 blob
  const combined = Buffer.concat([encrypted, tag]);
  return {
    ciphertext: combined.toString('base64'),
    iv: iv.toString('base64'),
  };
}

export function decryptDmContent(ciphertext: string, iv: string): string {
  const key = getKey();
  const combined = Buffer.from(ciphertext, 'base64');
  const ivBuf = Buffer.from(iv, 'base64');
  const encrypted = combined.subarray(0, combined.length - TAG_LENGTH);
  const tag = combined.subarray(combined.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuf);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** Check if content looks like a v2 E2E envelope (stored with wrong encryptionVersion). */
function isE2eEnvelope(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return (parsed?.v === 1 || parsed?.v === 2) && typeof parsed?.iv === 'string' && typeof parsed?.ct === 'string';
  } catch {
    return false;
  }
}

export function decryptMessageContent(msg: { content: string; contentIv?: string | null }): string {
  // If content is a v2 E2E envelope (stored with encryptionVersion=1 during migration),
  // don't try to server-decrypt — return as-is for client-side decryption
  if (isE2eEnvelope(msg.content)) return msg.content;
  if (msg.contentIv) {
    return decryptDmContent(msg.content, msg.contentIv);
  }
  return msg.content;
}
