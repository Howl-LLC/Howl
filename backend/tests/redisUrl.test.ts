// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { parseRedisUrl } from '../src/utils/redisUrl.js';

describe('parseRedisUrl', () => {
  it('parses a basic redis:// URL', () => {
    expect(parseRedisUrl('redis://default:secret@host:6379')).toEqual({
      host: 'host',
      port: 6379,
      username: 'default',
      password: 'secret',
    });
  });

  it('parses rediss:// (TLS) URLs', () => {
    const r = parseRedisUrl('rediss://default:secret@host:6379');
    expect(r.tls).toEqual({ rejectUnauthorized: true });
  });

  it('handles a password containing literal @', () => {
    // Real-world failure: rotated password with a literal @ broke `new URL()`.
    const r = parseRedisUrl('redis://default:abc@def@redis.internal:6379');
    expect(r.host).toBe('redis.internal');
    expect(r.password).toBe('abc@def');
  });

  it('handles a password containing % and # and ! and $', () => {
    const pw = 'htvX63zGtE%vZtVX#y%y3!NcD4U$$N';
    const r = parseRedisUrl(`redis://default:${pw}@redis.internal:6379`);
    expect(r.password).toBe(pw);
    expect(r.host).toBe('redis.internal');
  });

  it('parses a URL without credentials', () => {
    const r = parseRedisUrl('redis://localhost:6379');
    expect(r).toEqual({ host: 'localhost', port: 6379 });
  });

  it('parses a URL without password (user only)', () => {
    const r = parseRedisUrl('redis://default@host:6379');
    expect(r.username).toBe('default');
    expect(r.password).toBeUndefined();
  });

  it('parses a URL without user (password only)', () => {
    const r = parseRedisUrl('redis://:secret@host:6379');
    expect(r.username).toBeUndefined();
    expect(r.password).toBe('secret');
  });

  it('defaults port to 6379 when omitted', () => {
    expect(parseRedisUrl('redis://default:secret@host').port).toBe(6379);
  });

  it('parses the database number from the path', () => {
    const r = parseRedisUrl('redis://default:secret@host:6379/2');
    expect(r.db).toBe(2);
  });

  it('parses an IPv6 host', () => {
    const r = parseRedisUrl('redis://default:secret@[::1]:6379');
    expect(r.host).toBe('::1');
    expect(r.port).toBe(6379);
  });

  it('throws on a non-redis scheme', () => {
    expect(() => parseRedisUrl('http://host:6379')).toThrow(/scheme/);
  });
});
