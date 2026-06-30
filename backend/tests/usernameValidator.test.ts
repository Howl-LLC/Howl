// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Pure-function tests for `validateUsername` and `containsProfanity`.
 *
 * No DB, no fixtures — these are unit tests for the validator module itself.
 * Schema-integration tests live in `usernameSchema.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  validateUsername,
  containsProfanity,
  RESERVED_NAMES,
  errorMessageForReason,
} from '../src/utils/usernameValidator.js';

describe('validateUsername', () => {
  describe('accepts safe usernames', () => {
    it.each([
      'alice',
      'Alice',
      'alice42',
      'mr_smith.42',
      'john-doe',
      'JaneDoe2026',
      'a_b_c',
      'aaaa', // 4 consecutive same — under the cap
      'modesty', // contains 'mod' as substring but not exact match
      'cassidy', // contains 'ass' substring — word boundaries protect us
      'racoon', // contains 'coon' substring — word boundaries protect us
      'scunthorpe', // classic false-positive
      'analyst',
      'cockburn',
    ])('accepts %s', (input) => {
      const result = validateUsername(input);
      expect(result.ok).toBe(true);
    });
  });

  describe('rejects with character_set', () => {
    it.each([
      ['Cyrillic homoglyph', 'Аdmin'],
      ['CJK', '李明'],
      ['Greek', 'Αλφα'],
      ['emoji', '🦊fox'],
      ['accented Latin', 'café'],
      ['vertical bar', 'a|b'],
      ['vertical bar barcode', '|||||'],
      ['space', 'alice bob'],
      ['plus', 'alice+bob'],
      ['at sign', 'alice@bob'],
    ])('rejects %s — %s', (_label, input) => {
      const result = validateUsername(input);
      expect(result).toEqual({ ok: false, reason: 'character_set' });
    });
  });

  describe('rejects with zero_width', () => {
    it('rejects U+200B left over after stripping', () => {
      const result = validateUsername('mod​');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // zero_width fires before character_set, so this should be flagged as zero_width
        expect(result.reason).toBe('zero_width');
      }
    });
    it('rejects U+202E RTL override', () => {
      const result = validateUsername('a‮b');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('zero_width');
    });
    it('rejects U+FEFF byte-order mark', () => {
      const result = validateUsername('a﻿b');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('zero_width');
    });
  });

  describe('rejects with punctuation', () => {
    it.each([
      'alice.',
      'alice_',
      'alice-',
      '.alice',
      '_alice',
      '-alice',
      'a..b',
      'a__b',
      'a--b',
      'a._b',
      'a-_b',
      '....',
      '_____',
    ])('rejects %s', (input) => {
      const result = validateUsername(input);
      expect(result).toEqual({ ok: false, reason: 'punctuation' });
    });
  });

  describe('rejects with repetition', () => {
    it.each([
      'aaaaa',
      'AAAAA',
      'aXXXXX',
      'xxxxxxxxxx',
      '11111',
    ])('rejects %s', (input) => {
      const result = validateUsername(input);
      expect(result).toEqual({ ok: false, reason: 'repetition' });
    });
  });

  describe('rejects with reserved', () => {
    it.each([
      'admin',
      'Admin',
      'ADMIN',
      'administrator',
      'system',
      'moderator',
      'mod',
      'staff',
      'support',
      'howl',
      'bot',
      'null',
      'undefined',
      'everyone',
      'here',
      'root',
    ])('rejects %s', (input) => {
      const result = validateUsername(input);
      expect(result).toEqual({ ok: false, reason: 'reserved' });
    });
    it('exposes the full reserved list', () => {
      expect(RESERVED_NAMES.length).toBeGreaterThan(0);
      for (const name of RESERVED_NAMES) {
        expect(validateUsername(name)).toEqual({ ok: false, reason: 'reserved' });
      }
    });
  });

  describe('rejects with profanity', () => {
    it.each([
      'nigger',
      'Nigger',
      'NIGGER',
      'n1gger', // leetspeak
      'faggot',
      'kike',
      'tranny',
      'retard',
      'spic',
    ])('rejects %s', (input) => {
      const result = validateUsername(input);
      expect(result).toEqual({ ok: false, reason: 'profanity' });
    });
  });
});

describe('containsProfanity', () => {
  it('matches severe slurs', () => {
    expect(containsProfanity('nigger')).toBe(true);
    expect(containsProfanity('faggot')).toBe(true);
    expect(containsProfanity('kike')).toBe(true);
  });

  it('matches across word boundaries (server nicknames have spaces)', () => {
    expect(containsProfanity('hello nigger world')).toBe(true);
  });

  it('matches leetspeak / confusables', () => {
    expect(containsProfanity('n1gger')).toBe(true);
    expect(containsProfanity('f4gg0t')).toBe(true);
  });

  it('does not match clean text', () => {
    expect(containsProfanity('Alice from accounting')).toBe(false);
    expect(containsProfanity('scunthorpe')).toBe(false);
    expect(containsProfanity('cassidy')).toBe(false);
  });
});

describe('errorMessageForReason', () => {
  it('returns a non-empty string for every reason code', () => {
    const reasons: Array<Parameters<typeof errorMessageForReason>[0]> = [
      'character_set',
      'punctuation',
      'repetition',
      'reserved',
      'profanity',
      'zero_width',
    ];
    for (const r of reasons) {
      expect(errorMessageForReason(r)).toBeTruthy();
      expect(errorMessageForReason(r).length).toBeGreaterThan(10);
    }
  });
});
