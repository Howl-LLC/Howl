// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { encryptDmContent, decryptDmContent, decryptMessageContent } from '../src/services/dmCrypto.js';

describe('dmCrypto', () => {
  describe('encryptDmContent / decryptDmContent round-trip', () => {
    it('encrypts and decrypts a simple string', () => {
      const plaintext = 'Hello, world!';
      const { ciphertext, iv } = encryptDmContent(plaintext);
      expect(ciphertext).not.toBe(plaintext);
      expect(iv).toBeTruthy();
      const decrypted = decryptDmContent(ciphertext, iv);
      expect(decrypted).toBe(plaintext);
    });

    it('handles Unicode and emoji', () => {
      const plaintext = 'こんにちは 🎉🔥 café naïve';
      const { ciphertext, iv } = encryptDmContent(plaintext);
      expect(decryptDmContent(ciphertext, iv)).toBe(plaintext);
    });

    it('handles empty string', () => {
      const { ciphertext, iv } = encryptDmContent('');
      expect(decryptDmContent(ciphertext, iv)).toBe('');
    });

    it('handles long content', () => {
      const plaintext = 'a'.repeat(10000);
      const { ciphertext, iv } = encryptDmContent(plaintext);
      expect(decryptDmContent(ciphertext, iv)).toBe(plaintext);
    });

    it('produces different IVs each time', () => {
      const { iv: iv1 } = encryptDmContent('same text');
      const { iv: iv2 } = encryptDmContent('same text');
      expect(iv1).not.toBe(iv2);
    });

    it('produces different ciphertext each time', () => {
      const { ciphertext: c1 } = encryptDmContent('same text');
      const { ciphertext: c2 } = encryptDmContent('same text');
      expect(c1).not.toBe(c2);
    });
  });

  describe('GCM authentication', () => {
    it('rejects tampered ciphertext', () => {
      const { ciphertext, iv } = encryptDmContent('secret');
      const buf = Buffer.from(ciphertext, 'base64');
      buf[0] ^= 0xff; // flip a byte
      const tampered = buf.toString('base64');
      expect(() => decryptDmContent(tampered, iv)).toThrow();
    });

    it('rejects wrong IV', () => {
      const { ciphertext } = encryptDmContent('secret');
      const wrongIv = Buffer.alloc(12, 0).toString('base64');
      expect(() => decryptDmContent(ciphertext, wrongIv)).toThrow();
    });
  });

  describe('decryptMessageContent', () => {
    it('decrypts when contentIv is present', () => {
      const plaintext = 'test message';
      const { ciphertext, iv } = encryptDmContent(plaintext);
      const result = decryptMessageContent({ content: ciphertext, contentIv: iv });
      expect(result).toBe(plaintext);
    });

    it('returns content as-is when contentIv is null (legacy plaintext)', () => {
      const result = decryptMessageContent({ content: 'plain text', contentIv: null });
      expect(result).toBe('plain text');
    });

    it('returns content as-is when contentIv is undefined', () => {
      const result = decryptMessageContent({ content: 'plain text' });
      expect(result).toBe('plain text');
    });
  });

  // getKey() enforces a strict 32-byte hex key. The strictness is only observable
  // OUTSIDE the test env (in test, an invalid key
  // falls back to the deterministic SHA-256 test key), so these cases simulate a
  // non-test process for the duration of the assertion and restore it after.
  describe('DM_ENCRYPTION_KEY strict-hex validation', () => {
    function withEnv(nodeEnv: string, key: string | undefined, fn: () => void) {
      const origEnv = process.env.NODE_ENV;
      const origKey = process.env.DM_ENCRYPTION_KEY;
      try {
        process.env.NODE_ENV = nodeEnv;
        if (key === undefined) delete process.env.DM_ENCRYPTION_KEY;
        else process.env.DM_ENCRYPTION_KEY = key;
        fn();
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origKey === undefined) delete process.env.DM_ENCRYPTION_KEY;
        else process.env.DM_ENCRYPTION_KEY = origKey;
      }
    }

    it('rejects a 64-char NON-hex key outside the test env', () => {
      withEnv('production', 'z'.repeat(64), () => {
        expect(() => encryptDmContent('x')).toThrow(/32-byte hex/);
      });
    });

    it('rejects a too-short key outside the test env', () => {
      withEnv('production', 'abcd', () => {
        expect(() => encryptDmContent('x')).toThrow(/32-byte hex/);
      });
    });

    it('accepts a valid 64-char hex key outside the test env (round-trips)', () => {
      withEnv('production', 'a'.repeat(64), () => {
        const { ciphertext, iv } = encryptDmContent('hello');
        expect(decryptDmContent(ciphertext, iv)).toBe('hello');
      });
    });
  });
});
