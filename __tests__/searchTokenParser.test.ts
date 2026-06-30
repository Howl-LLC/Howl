// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { parseSearchTokens, serializeFilters, parseDateToken } from '../utils/searchTokenParser';

describe('parseSearchTokens', () => {
  // Basic extraction

  it('extracts from: filter', () => {
    const result = parseSearchTokens('from:alice');
    expect(result.from).toBe('alice');
    expect(result.query).toBe('');
  });

  it('extracts in: filter', () => {
    const result = parseSearchTokens('in:general');
    expect(result.in).toBe('general');
    expect(result.query).toBe('');
  });

  it('extracts has: filter', () => {
    const result = parseSearchTokens('has:image');
    expect(result.has).toBe('image');
    expect(result.query).toBe('');
  });

  it('extracts before: filter', () => {
    const result = parseSearchTokens('before:2026-04-01');
    expect(result.before).toBe('2026-04-01T00:00:00.000Z');
    expect(result.query).toBe('');
  });

  it('extracts after: filter', () => {
    const result = parseSearchTokens('after:2026-04-01');
    expect(result.after).toBe('2026-04-01T00:00:00.000Z');
    expect(result.query).toBe('');
  });

  it('extracts mentions: filter', () => {
    const result = parseSearchTokens('mentions:bob');
    expect(result.mentions).toBe('bob');
    expect(result.query).toBe('');
  });

  it('extracts pinned:true filter', () => {
    const result = parseSearchTokens('pinned:true');
    expect(result.pinned).toBe(true);
    expect(result.query).toBe('');
  });

  it('extracts pinned:false filter', () => {
    const result = parseSearchTokens('pinned:false');
    expect(result.pinned).toBe(false);
    expect(result.query).toBe('');
  });

  // Remaining query text

  it('returns remaining text as query', () => {
    const result = parseSearchTokens('hello from:alice world');
    expect(result.from).toBe('alice');
    expect(result.query).toBe('hello world');
  });

  it('handles filters at start of input', () => {
    const result = parseSearchTokens('from:alice hello world');
    expect(result.from).toBe('alice');
    expect(result.query).toBe('hello world');
  });

  it('handles filters at end of input', () => {
    const result = parseSearchTokens('hello world from:alice');
    expect(result.from).toBe('alice');
    expect(result.query).toBe('hello world');
  });

  it('handles filters in middle of input', () => {
    const result = parseSearchTokens('hello from:alice world');
    expect(result.from).toBe('alice');
    expect(result.query).toBe('hello world');
  });

  it('handles back-to-back filters with no text', () => {
    const result = parseSearchTokens('from:alice has:image in:general');
    expect(result.from).toBe('alice');
    expect(result.has).toBe('image');
    expect(result.in).toBe('general');
    expect(result.query).toBe('');
  });

  // Quoted values

  it('parses quoted values with spaces: from:"Super User"', () => {
    const result = parseSearchTokens('from:"Super User"');
    expect(result.from).toBe('Super User');
    expect(result.query).toBe('');
  });

  it('handles colons inside quoted strings', () => {
    const result = parseSearchTokens('from:"user:name"');
    expect(result.from).toBe('user:name');
    expect(result.query).toBe('');
  });

  // Edge cases

  it('last wins for duplicate keys', () => {
    const result = parseSearchTokens('from:alice from:bob');
    expect(result.from).toBe('bob');
  });

  it('ignores empty filter value (from: with nothing after)', () => {
    const result = parseSearchTokens('from: hello');
    // Empty value after colon → treated as text
    expect(result.from).toBeUndefined();
    expect(result.query).toBe('from: hello');
  });

  it('handles special chars in usernames', () => {
    const result = parseSearchTokens('from:user_name-123');
    expect(result.from).toBe('user_name-123');
  });

  it('case-insensitive keys: From:user', () => {
    const result = parseSearchTokens('From:user');
    expect(result.from).toBe('user');
  });

  it('case-insensitive keys: HAS:Image', () => {
    const result = parseSearchTokens('HAS:Image');
    expect(result.has).toBe('image');
  });

  it('unknown keys treated as regular text', () => {
    const result = parseSearchTokens('unknown:value hello');
    expect(result.query).toBe('unknown:value hello');
  });

  it('returns empty query for filter-only input', () => {
    const result = parseSearchTokens('from:alice');
    expect(result.query).toBe('');
  });

  it('normalizes has:embed to has:link', () => {
    const result = parseSearchTokens('has:embed');
    expect(result.has).toBe('link');
  });

  it('normalizes has values to lowercase', () => {
    const result = parseSearchTokens('has:IMAGE');
    expect(result.has).toBe('image');
  });

  it('treats invalid has values as query text', () => {
    const result = parseSearchTokens('has:banana');
    expect(result.has).toBeUndefined();
    expect(result.query).toBe('has:banana');
  });

  it('handles empty string input', () => {
    const result = parseSearchTokens('');
    expect(result.query).toBe('');
    expect(result.from).toBeUndefined();
    expect(result.in).toBeUndefined();
    expect(result.has).toBeUndefined();
    expect(result.before).toBeUndefined();
    expect(result.after).toBeUndefined();
    expect(result.mentions).toBeUndefined();
    expect(result.pinned).toBeUndefined();
  });

  it('handles input with only spaces', () => {
    const result = parseSearchTokens('   ');
    expect(result.query).toBe('');
  });

  it('returns full input as query when no filters present', () => {
    const result = parseSearchTokens('just some normal text');
    expect(result.query).toBe('just some normal text');
  });

  it('preserves filter-like text inside quotes as query text', () => {
    const result = parseSearchTokens('"from:alice"');
    expect(result.from).toBeUndefined();
    expect(result.query).toBe('from:alice');
  });

  // during: expansion

  it('handles during:today — sets after and before', () => {
    const result = parseSearchTokens('during:today');
    expect(result.after).toBeDefined();
    expect(result.before).toBeDefined();
    expect(new Date(result.after!).getTime()).not.toBeNaN();
    expect(new Date(result.before!).getTime()).not.toBeNaN();
    // after should be earlier than before
    expect(new Date(result.after!).getTime()).toBeLessThan(new Date(result.before!).getTime());
    expect(result.query).toBe('');
  });

  it('handles during:yesterday — sets after and before', () => {
    const result = parseSearchTokens('during:yesterday');
    expect(result.after).toBeDefined();
    expect(result.before).toBeDefined();
    expect(new Date(result.after!).getTime()).not.toBeNaN();
    expect(new Date(result.before!).getTime()).not.toBeNaN();
    expect(new Date(result.after!).getTime()).toBeLessThan(new Date(result.before!).getTime());
    expect(result.query).toBe('');
  });

  it('handles during:week — sets after only', () => {
    const result = parseSearchTokens('during:week');
    expect(result.after).toBeDefined();
    expect(result.before).toBeUndefined();
    expect(new Date(result.after!).getTime()).not.toBeNaN();
    expect(result.query).toBe('');
  });

  it('handles during:month — sets after only', () => {
    const result = parseSearchTokens('during:month');
    expect(result.after).toBeDefined();
    expect(result.before).toBeUndefined();
    expect(new Date(result.after!).getTime()).not.toBeNaN();
    expect(result.query).toBe('');
  });

  it('treats unrecognized during: value as query text', () => {
    const result = parseSearchTokens('during:whenever');
    expect(result.after).toBeUndefined();
    expect(result.before).toBeUndefined();
    expect(result.query).toBe('during:whenever');
  });

  // pinned edge cases

  it('treats invalid pinned value as query text', () => {
    const result = parseSearchTokens('pinned:maybe');
    expect(result.pinned).toBeUndefined();
    expect(result.query).toBe('pinned:maybe');
  });

  it('handles pinned:True (case-insensitive value)', () => {
    const result = parseSearchTokens('pinned:True');
    expect(result.pinned).toBe(true);
  });

  // before/after with unparseable dates

  it('passes through unparseable date values as raw strings for before:', () => {
    const result = parseSearchTokens('before:last-tuesday');
    expect(result.before).toBe('last-tuesday');
  });

  it('passes through unparseable date values as raw strings for after:', () => {
    const result = parseSearchTokens('after:soon');
    expect(result.after).toBe('soon');
  });

  // Multiple filters combined

  it('handles multiple different filters with query text', () => {
    const result = parseSearchTokens('search text from:alice in:general has:file pinned:true');
    expect(result.query).toBe('search text');
    expect(result.from).toBe('alice');
    expect(result.in).toBe('general');
    expect(result.has).toBe('file');
    expect(result.pinned).toBe(true);
  });

  // Unclosed quotes

  it('handles unclosed quote in filter value by taking rest as value', () => {
    const result = parseSearchTokens('from:"alice no close');
    expect(result.from).toBe('alice no close');
    expect(result.query).toBe('');
  });

  it('handles unclosed standalone quote by taking rest as query text', () => {
    const result = parseSearchTokens('"unclosed query text');
    expect(result.query).toBe('unclosed query text');
  });

  // has: valid values

  it.each(['file', 'image', 'video', 'link', 'sticker', 'sound', 'attachment'])(
    'accepts has:%s as a valid filter value',
    (val) => {
      const result = parseSearchTokens(`has:${val}`);
      expect(result.has).toBe(val);
      expect(result.query).toBe('');
    },
  );

  // Trailing/leading colon on filter

  it('handles filter key at very end of input with no value', () => {
    const result = parseSearchTokens('from:');
    // "from:" with nothing after → treated as text
    expect(result.from).toBeUndefined();
    expect(result.query).toBe('from:');
  });
});

describe('serializeFilters', () => {
  it('serializes query-only filters', () => {
    const result = serializeFilters({ query: 'hello world' });
    expect(result).toBe('hello world');
  });

  it('serializes filters with query', () => {
    const result = serializeFilters({ query: 'hello', from: 'alice' });
    expect(result).toBe('hello from:alice');
  });

  it('serializes all filter types', () => {
    const result = serializeFilters({
      query: 'text',
      from: 'alice',
      in: 'general',
      has: 'image',
      before: '2026-04-01',
      after: '2026-03-01',
      mentions: 'bob',
      pinned: true,
    });
    expect(result).toContain('text');
    expect(result).toContain('from:alice');
    expect(result).toContain('in:general');
    expect(result).toContain('has:image');
    expect(result).toContain('before:2026-04-01');
    expect(result).toContain('after:2026-03-01');
    expect(result).toContain('mentions:bob');
    expect(result).toContain('pinned:true');
  });

  it('quotes values containing spaces', () => {
    const result = serializeFilters({ query: '', from: 'Super User' });
    expect(result).toContain('from:"Super User"');
  });

  it('quotes mentions values containing spaces', () => {
    const result = serializeFilters({ query: '', mentions: 'Some One' });
    expect(result).toContain('mentions:"Some One"');
  });

  it('quotes in values containing spaces', () => {
    const result = serializeFilters({ query: '', in: 'my channel' });
    expect(result).toContain('in:"my channel"');
  });

  it('handles pinned boolean serialization', () => {
    expect(serializeFilters({ query: '', pinned: true })).toBe('pinned:true');
    expect(serializeFilters({ query: '', pinned: false })).toBe('pinned:false');
  });

  it('omits undefined filters', () => {
    const result = serializeFilters({ query: 'hello', from: undefined, in: undefined });
    expect(result).toBe('hello');
    expect(result).not.toContain('from');
    expect(result).not.toContain('in');
  });

  it('returns empty string when query is empty and no filters', () => {
    const result = serializeFilters({ query: '' });
    expect(result).toBe('');
  });

  it('round-trips: parse then serialize then parse gives same result', () => {
    const inputs = [
      'hello from:alice has:image',
      'from:"Super User" in:general search text',
      'pinned:true has:file before:2026-04-01',
      'just a query',
      'mentions:bob after:2026-01-01',
    ];

    for (const input of inputs) {
      const parsed = parseSearchTokens(input);
      const serialized = serializeFilters(parsed);
      const reparsed = parseSearchTokens(serialized);
      expect(reparsed).toEqual(parsed);
    }
  });
});

describe('parseDateToken', () => {
  it('parses date-only string: 2026-04-01', () => {
    const result = parseDateToken('2026-04-01');
    expect(result).toBe('2026-04-01T00:00:00.000Z');
  });

  it('parses full ISO datetime', () => {
    const result = parseDateToken('2026-04-01T15:30:00.000Z');
    expect(result).toBe('2026-04-01T15:30:00.000Z');
  });

  it('parses today', () => {
    const result = parseDateToken('today');
    expect(result).not.toBeNull();
    // Should be midnight UTC of today
    const parsed = new Date(result!);
    expect(parsed.getUTCHours()).toBe(0);
    expect(parsed.getUTCMinutes()).toBe(0);
    expect(parsed.getUTCSeconds()).toBe(0);
    expect(parsed.getUTCMilliseconds()).toBe(0);
  });

  it('parses yesterday', () => {
    const result = parseDateToken('yesterday');
    expect(result).not.toBeNull();
    const parsed = new Date(result!);
    const now = new Date();
    // Should be one day before today
    const expected = new Date(now);
    expected.setUTCDate(expected.getUTCDate() - 1);
    expected.setUTCHours(0, 0, 0, 0);
    expect(parsed.toISOString()).toBe(expected.toISOString());
  });

  it('returns null for garbage input', () => {
    expect(parseDateToken('not-a-date')).toBeNull();
    expect(parseDateToken('abc')).toBeNull();
    expect(parseDateToken('2026/04/01')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseDateToken('')).toBeNull();
  });

  it('handles case-insensitive keywords', () => {
    expect(parseDateToken('Today')).not.toBeNull();
    expect(parseDateToken('YESTERDAY')).not.toBeNull();
  });

  it('returns null for invalid ISO dates that match the pattern', () => {
    // 2026-13-99 matches the regex but is not a valid date
    expect(parseDateToken('2026-13-99')).toBeNull();
  });

  it('parses ISO datetime with timezone offset', () => {
    const result = parseDateToken('2026-04-01T10:00:00+05:00');
    expect(result).not.toBeNull();
    // Date constructor normalizes to UTC
    expect(result).toBe(new Date('2026-04-01T10:00:00+05:00').toISOString());
  });
});
