// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { isValidHexKey32, parseHexKey32, HEX_32_RE } from '../src/services/keyValidation.js';

describe('mfaCrypto malformed-key hardening', () => {
  it('encryptSecret throws on a present-but-malformed MFA_ENCRYPTION_KEY (bypasses test fallback)', async () => {
    const original = process.env.MFA_ENCRYPTION_KEY;
    process.env.MFA_ENCRYPTION_KEY = 'z'.repeat(64); // length ok, not hex
    try {
      const { encryptSecret } = await import('../src/services/mfaCrypto.js');
      expect(() => encryptSecret('totp-secret')).toThrow(/MFA_ENCRYPTION_KEY/);
    } finally {
      if (original === undefined) delete process.env.MFA_ENCRYPTION_KEY;
      else process.env.MFA_ENCRYPTION_KEY = original;
    }
  });
});

describe('e2eEscrow isMasterKeyConfigured agrees with getMasterKey on malformed key', () => {
  it('returns false for a present-but-malformed SERVER_E2E_MASTER_KEY (would throw in getMasterKey)', async () => {
    const original = process.env.SERVER_E2E_MASTER_KEY;
    process.env.SERVER_E2E_MASTER_KEY = 'z'.repeat(64); // length ok, not hex
    try {
      const { isMasterKeyConfigured } = await import('../src/services/e2eEscrow.js');
      // Malformed key: getMasterKey() throws even under NODE_ENV=test, so the 503
      // guard must report NOT configured rather than pass and throw in encryptEscrow.
      expect(isMasterKeyConfigured()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.SERVER_E2E_MASTER_KEY;
      else process.env.SERVER_E2E_MASTER_KEY = original;
    }
  });

  it('returns true for a valid 64-char hex SERVER_E2E_MASTER_KEY', async () => {
    const original = process.env.SERVER_E2E_MASTER_KEY;
    process.env.SERVER_E2E_MASTER_KEY = 'a'.repeat(64);
    try {
      const { isMasterKeyConfigured } = await import('../src/services/e2eEscrow.js');
      expect(isMasterKeyConfigured()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.SERVER_E2E_MASTER_KEY;
      else process.env.SERVER_E2E_MASTER_KEY = original;
    }
  });
});

describe('keyValidation', () => {
  it('accepts a 64-char hex key and returns 32 bytes', () => {
    const hex = 'a'.repeat(64);
    expect(isValidHexKey32(hex)).toBe(true);
    expect(parseHexKey32(hex, 'TEST_KEY').length).toBe(32);
  });

  it('rejects undefined / short / non-hex / wrong-length keys', () => {
    expect(isValidHexKey32(undefined)).toBe(false);
    expect(isValidHexKey32('a'.repeat(63))).toBe(false);
    expect(isValidHexKey32('a'.repeat(65))).toBe(false);
    expect(isValidHexKey32('z'.repeat(64))).toBe(false); // length ok, not hex
    expect(HEX_32_RE.test('a'.repeat(64))).toBe(true);
  });

  it('parseHexKey32 throws on a present-but-malformed key (names the var)', () => {
    expect(() => parseHexKey32('z'.repeat(64), 'MFA_ENCRYPTION_KEY')).toThrow(/MFA_ENCRYPTION_KEY/);
    expect(() => parseHexKey32(undefined, 'SERVER_E2E_MASTER_KEY')).toThrow(/SERVER_E2E_MASTER_KEY/);
  });
});
