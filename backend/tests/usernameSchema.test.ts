// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for the composed `usernameSchema`.
 *
 * Schema chain (in order):
 *   1. min(2)/max(32)
 *   2. HTML-metacharacter refine (rejects injection payloads)
 *   3. trim
 *   4. transform(stripControlChars) — removes BiDi / zero-width chars
 *   5. validateUsername refine — ASCII allowlist, punctuation, repetition,
 *      reserved names, profanity, leftover zero-width detection
 *
 * The pure-function unit tests for step 5 live in `usernameValidator.test.ts`;
 * this file only exercises the integrated chain end-to-end.
 */

import { describe, it, expect } from 'vitest';
import { usernameSchema } from '../src/schemas.js';

describe('usernameSchema', () => {
  describe('accepts safe inputs', () => {
    it.each([
      'ada',
      'ada.lovelace',
      'ada_lovelace_42',
      'ADA-LOVELACE',
      'user123',
      'JaneDoe2026',
    ])('accepts %s', (input) => {
      const res = usernameSchema.safeParse(input);
      expect(res.success).toBe(true);
    });
  });

  describe('rejects unicode at the username layer (use per-server nicknames instead)', () => {
    it.each([
      '李明',
      'Αλφα',
      'Владимир',
      '🦊fox',
      'café', // accented Latin
      'Аdmin', // Cyrillic А homoglyph
    ])('rejects %s', (input) => {
      const res = usernameSchema.safeParse(input);
      expect(res.success).toBe(false);
    });
  });

  describe('rejects HTML-metacharacter payloads', () => {
    it.each([
      '<img src=x onerror=alert(1)>',
      '<script>alert(1)</script>',
      '"><svg/onload=alert(1)>',
      'foo"bar',
      'foo<bar',
      'foo>bar',
      "foo'bar",
      'foo&bar',
    ])('rejects %s', (input) => {
      const res = usernameSchema.safeParse(input);
      expect(res.success).toBe(false);
    });
  });

  describe('length bounds', () => {
    it('rejects length 1', () => {
      expect(usernameSchema.safeParse('a').success).toBe(false);
    });
    it('rejects length 33', () => {
      expect(usernameSchema.safeParse('ab'.repeat(17)).success).toBe(false);
    });
    it('accepts length 2 and 32', () => {
      expect(usernameSchema.safeParse('ab').success).toBe(true);
      expect(usernameSchema.safeParse('ab'.repeat(16)).success).toBe(true);
    });
  });

  describe('strips control chars before content validation', () => {
    it('removes U+202E (RTL override) — leftover passes ASCII allowlist', () => {
      const res = usernameSchema.safeParse('name‮vil');
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toBe('namevil');
    });
    it('removes U+200B (zero-width space)', () => {
      const res = usernameSchema.safeParse('aa​bb');
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toBe('aabb');
    });
  });

  describe('content rules (full chain)', () => {
    it('rejects severe slurs', () => {
      expect(usernameSchema.safeParse('niggеr').success).toBe(false); // Cyrillic e
      expect(usernameSchema.safeParse('n1gger').success).toBe(false); // leetspeak
      expect(usernameSchema.safeParse('faggot').success).toBe(false);
    });
    it('rejects reserved names', () => {
      expect(usernameSchema.safeParse('admin').success).toBe(false);
      expect(usernameSchema.safeParse('Admin').success).toBe(false);
      expect(usernameSchema.safeParse('SYSTEM').success).toBe(false);
    });
    it('rejects punctuation spam', () => {
      expect(usernameSchema.safeParse('....').success).toBe(false);
      expect(usernameSchema.safeParse('___').success).toBe(false);
      expect(usernameSchema.safeParse('_alice').success).toBe(false);
      expect(usernameSchema.safeParse('alice.').success).toBe(false);
    });
    it('rejects 5+ consecutive same characters', () => {
      expect(usernameSchema.safeParse('aaaaa').success).toBe(false);
    });
    it('accepts 4 consecutive same characters', () => {
      expect(usernameSchema.safeParse('aaaa').success).toBe(true);
    });
    it('rejects vertical-bar barcode spam', () => {
      expect(usernameSchema.safeParse('|||||').success).toBe(false);
    });
  });
});
