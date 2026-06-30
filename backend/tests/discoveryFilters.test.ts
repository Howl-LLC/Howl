// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Pure-function tests for the discovery directory filter helpers.
 * No database / no Express required.
 */

import { describe, it, expect } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  escapeLikePattern,
  isUnderEighteen,
  normaliseTags,
  DISCOVERY_CATEGORIES,
  DISCOVERY_CATEGORY_LABELS,
} from '../src/utils/discoveryFilters.js';

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a date + uuid pair', () => {
    const sortValue = '2026-04-25T05:00:00.000Z';
    const id = '11111111-1111-1111-1111-111111111111';
    const cursor = encodeCursor(sortValue, id);
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual({ sortValue, id });
  });

  it('round-trips a numeric sort value', () => {
    const cursor = encodeCursor('000000001234', 'abcd');
    expect(decodeCursor(cursor)).toEqual({ sortValue: '000000001234', id: 'abcd' });
  });

  it('returns null on missing input', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('returns null on malformed input', () => {
    expect(decodeCursor('not-base64-!!')).toBeNull();
    // No pipe separator after decoding — invalid.
    expect(decodeCursor(Buffer.from('hello', 'utf8').toString('base64url'))).toBeNull();
    // Pipe at end (empty id) — invalid.
    expect(decodeCursor(Buffer.from('foo|', 'utf8').toString('base64url'))).toBeNull();
  });

  it('caps absurdly long ids and sort values', () => {
    const longId = 'a'.repeat(200);
    const cursor = encodeCursor('foo', longId);
    expect(decodeCursor(cursor)).toBeNull();
  });
});

// `resolveNsfwFilter` and `User.explicitContentFilter` no longer exist.
// Discovery eligibility is derived from per-channel `Channel.ageRestricted`
// instead, so the unit tests for the removed helper were dropped here.

describe('isUnderEighteen', () => {
  it('treats null DOB as under-18 (fail closed)', () => {
    expect(isUnderEighteen(null)).toBe(true);
    expect(isUnderEighteen(undefined)).toBe(true);
  });

  it('returns false for clearly-adult DOB', () => {
    expect(isUnderEighteen(new Date('1990-01-01'))).toBe(false);
  });

  it('returns true for clearly-minor DOB', () => {
    const today = new Date();
    const recent = new Date(today.getFullYear() - 10, today.getMonth(), today.getDate());
    expect(isUnderEighteen(recent)).toBe(true);
  });

  it('handles birthday-not-yet-this-year correctly', () => {
    const today = new Date();
    // Born 18 years ago but birthday is tomorrow — still 17.
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const dob = new Date(today.getFullYear() - 18, tomorrow.getMonth(), tomorrow.getDate());
    expect(isUnderEighteen(dob)).toBe(true);
  });
});

describe('escapeLikePattern', () => {
  it('escapes %, _, and backslashes', () => {
    expect(escapeLikePattern('foo%bar')).toBe('foo\\%bar');
    expect(escapeLikePattern('foo_bar')).toBe('foo\\_bar');
    expect(escapeLikePattern('foo\\bar')).toBe('foo\\\\bar');
    expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('leaves harmless characters alone', () => {
    expect(escapeLikePattern('foo bar')).toBe('foo bar');
    expect(escapeLikePattern('hello.world')).toBe('hello.world');
  });
});

describe('normaliseTags', () => {
  it('lowercases and trims', () => {
    expect(normaliseTags(['  Foo ', 'BAR'])).toEqual(['foo', 'bar']);
  });

  it('caps at 5 entries', () => {
    expect(normaliseTags(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('deduplicates after normalisation', () => {
    expect(normaliseTags(['Foo', 'foo', 'FOO'])).toEqual(['foo']);
  });

  it('rejects malformed tags silently', () => {
    expect(normaliseTags(['valid', 'has space', '_leading-underscore', '-leading-dash', 'bad!chars'])).toEqual(['valid']);
  });

  it('handles non-array input', () => {
    expect(normaliseTags(undefined)).toEqual([]);
    // @ts-expect-error — testing runtime guard
    expect(normaliseTags('not an array')).toEqual([]);
  });
});

describe('DISCOVERY_CATEGORIES + DISCOVERY_CATEGORY_LABELS', () => {
  it('every category has a label', () => {
    for (const key of DISCOVERY_CATEGORIES) {
      expect(DISCOVERY_CATEGORY_LABELS[key]).toBeTypeOf('string');
      expect(DISCOVERY_CATEGORY_LABELS[key].length).toBeGreaterThan(0);
    }
  });

  it('labels object has no extra keys', () => {
    expect(Object.keys(DISCOVERY_CATEGORY_LABELS).sort()).toEqual([...DISCOVERY_CATEGORIES].sort());
  });
});
