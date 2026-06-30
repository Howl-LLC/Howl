// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression tests for `sanitizeLogString`.
 *
 * OAuth callbacks land at `/api/v1/sso/<provider>/callback?code=...&state=...`
 * and `/api/v1/connected-apps/<provider>/callback?code=...&state=...`. Before
 * this fix `pino-http` logged the full URL verbatim, leaking the short-lived
 * single-use authorization code to anyone with log-read access.
 *
 * These tests exercise the pure util with no Express / Pino / Postgres
 * dependencies so they run fast and without infra.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeLogString } from '../src/utils/sanitizeLogString.js';

describe('sanitizeLogString', () => {
  it('preserves URLs without query strings', () => {
    expect(sanitizeLogString('/api/health')).toBe('/api/health');
    expect(sanitizeLogString('/')).toBe('/');
    expect(sanitizeLogString('')).toBe('');
  });

  it('strips control chars (prior behavior preserved)', () => {
    expect(sanitizeLogString('/api/x\x00')).toBe('/api/x');
    expect(sanitizeLogString('/a\nb')).toBe('/ab');
    expect(sanitizeLogString('/\x1b[31mred\x1b[0m')).toBe('/[31mred[0m');
  });

  it('strips control chars inside query strings as well as paths', () => {
    // Control char inside the path, safe query after.
    expect(sanitizeLogString('/api\x00/x?foo=1')).toBe('/api/x?foo=1');
  });

  it('redacts code/state/access_token/id_token/nonce/token/key from query', () => {
    const url = '/api/v1/sso/google/callback?code=abc123&state=xyz&safe=ok';
    const out = sanitizeLogString(url);
    expect(out).toContain('code=[REDACTED]');
    expect(out).toContain('state=[REDACTED]');
    expect(out).toContain('safe=ok');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('xyz');
  });

  it('redacts every sensitive param name individually', () => {
    const cases: Array<[string, string]> = [
      ['code', 'oauth_code_value'],
      ['state', 'state_nonce_value'],
      ['access_token', 'at_value'],
      ['id_token', 'jwt_value'],
      ['token', 'token_value'],
      ['key', 'api_key_value'],
      ['nonce', 'nonce_value'],
    ];
    for (const [param, value] of cases) {
      const out = sanitizeLogString(`/x?${param}=${value}`);
      expect(out).toBe(`/x?${param}=[REDACTED]`);
      expect(out).not.toContain(value);
    }
  });

  it('preserves param order', () => {
    const url = '/cb?a=1&code=SECRET&b=2&state=ALSO_SECRET&c=3';
    const out = sanitizeLogString(url);
    expect(out).toBe('/cb?a=1&code=[REDACTED]&b=2&state=[REDACTED]&c=3');
  });

  it('handles malformed query strings (bare param, empty value, repeated =)', () => {
    // Bare param with no `=` — leave untouched (not a key=value pair).
    expect(sanitizeLogString('/x?foo')).toBe('/x?foo');

    // Sensitive param with empty value — still redact.
    expect(sanitizeLogString('/x?code=')).toBe('/x?code=[REDACTED]');

    // `=` inside value — only the first `=` splits key from value.
    expect(sanitizeLogString('/x?code=a=b=c')).toBe('/x?code=[REDACTED]');

    // Empty query string after `?`.
    expect(sanitizeLogString('/x?')).toBe('/x?');

    // Repeated sensitive param.
    expect(sanitizeLogString('/x?code=1&code=2')).toBe('/x?code=[REDACTED]&code=[REDACTED]');
  });

  it('does not touch non-sensitive params with similar names', () => {
    // `codec` is not `code`. `stated` is not `state`.
    const url = '/x?codec=h264&stated=true&keyword=ok';
    const out = sanitizeLogString(url);
    expect(out).toContain('codec=h264');
    expect(out).toContain('stated=true');
    expect(out).toContain('keyword=ok');
  });

  it('handles URL-encoded sensitive keys', () => {
    // Not a realistic shape (clients don't URL-encode standard param names),
    // but decodeURIComponent of the raw key still matches.
    const out = sanitizeLogString('/x?%63%6f%64%65=secret');
    expect(out).not.toContain('secret');
    expect(out).toContain('[REDACTED]');
  });

  it('is case-sensitive on param names (OAuth spec requires this)', () => {
    // `CODE` (upper-case) is NOT the spec param; leave untouched.
    const out = sanitizeLogString('/x?CODE=visible');
    expect(out).toBe('/x?CODE=visible');
  });

  it('redacts realistic connected-apps callback URL', () => {
    const url = '/api/v1/connected-apps/spotify/callback?code=AQABc1X&state=abc123';
    const out = sanitizeLogString(url);
    expect(out).not.toContain('AQABc1X');
    expect(out).not.toContain('abc123');
    expect(out).toBe('/api/v1/connected-apps/spotify/callback?code=[REDACTED]&state=[REDACTED]');
  });

  it('redacts realistic sso callback URL', () => {
    const url = '/api/v1/sso/google/callback?code=4%2F0AX4X&state=xyz&scope=openid';
    const out = sanitizeLogString(url);
    expect(out).not.toContain('4%2F0AX4X');
    expect(out).not.toContain('state=xyz');
    expect(out).toContain('scope=openid');
  });
});
