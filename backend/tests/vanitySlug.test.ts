// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Pure-function tests for vanity-URL slug validation. No database required.
 *
 * Covers the format rules + reserved-list contract enforced by
 * `validateSlug` in `src/utils/vanitySlug.ts`. The HTTP layer in
 * `routes/serverVanity.ts` builds on these guarantees.
 */

import { describe, it, expect } from 'vitest';
import { validateSlug, normalizeSlug } from '../src/utils/vanitySlug.js';
import { isReservedSlug, RESERVED_SLUGS } from '../src/data/reservedSlugs.js';

describe('validateSlug — accepts well-formed slugs', () => {
  it.each([
    'abc',
    'a1b',
    'my-server',
    'my-cool-server',
    'howlcommunity',
    'a-b-c-d',
    'longest-allowed-slug-of-32chars1',
    '012',
    '0-9',
    'a'.repeat(32),
  ])('accepts %s', (input) => {
    const r = validateSlug(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.slug).toBe(input.toLowerCase());
  });

  it('lower-cases uppercase input', () => {
    const r = validateSlug('My-Server');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.slug).toBe('my-server');
  });

  it('trims whitespace', () => {
    const r = validateSlug('  cool-name  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.slug).toBe('cool-name');
  });
});

describe('validateSlug — rejects format violations', () => {
  it.each([
    ['too short (2)', 'ab'],
    ['too short (1)', 'a'],
    ['empty', ''],
    ['leading dash', '-abc'],
    ['trailing dash', 'abc-'],
    ['double dash', 'foo--bar'],
    ['triple dash', 'foo---bar'],
    ['uppercase letter that contains illegal chars after lowercase', 'foo bar'],
    ['underscore not allowed', 'foo_bar'],
    ['spaces', 'foo bar'],
    ['emoji', 'foo🔥bar'],
    ['unicode letter', 'café'],
    ['too long (33)', 'a'.repeat(33)],
    ['only dashes', '---'],
    ['dot', 'foo.bar'],
    ['slash', 'foo/bar'],
    ['plus', 'foo+bar'],
  ])('rejects %s', (_label, input) => {
    const r = validateSlug(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_format');
  });

  it('rejects non-string input', () => {
    expect(validateSlug(undefined).ok).toBe(false);
    expect(validateSlug(null).ok).toBe(false);
    expect(validateSlug(42).ok).toBe(false);
    expect(validateSlug({}).ok).toBe(false);
    expect(validateSlug([]).ok).toBe(false);
  });
});

describe('validateSlug — reserved names', () => {
  it.each([
    'admin', 'api', 'app', 'discover', 'invite', 'login', 'settings',
    'howl', 'official',
  ])('rejects %s as reserved', (slug) => {
    const r = validateSlug(slug);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('reserved');
  });

  it('reserved match is case-insensitive', () => {
    const r = validateSlug('ADMIN');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('reserved');
  });
});

describe('isReservedSlug', () => {
  it('returns true for known reserved entries', () => {
    expect(isReservedSlug('admin')).toBe(true);
    expect(isReservedSlug('login')).toBe(true);
  });
  it('returns false for non-reserved slugs', () => {
    expect(isReservedSlug('my-cool-community')).toBe(false);
  });
  it('all reserved entries are stored lowercase', () => {
    for (const s of RESERVED_SLUGS) {
      expect(s).toBe(s.toLowerCase());
    }
  });
});

describe('normalizeSlug', () => {
  it('trims and lowercases', () => {
    expect(normalizeSlug('  HelloWorld  ')).toBe('helloworld');
  });
  it('does not validate format', () => {
    // Format rules belong to validateSlug; normalizeSlug is just trim+lower.
    expect(normalizeSlug('---')).toBe('---');
  });
});
