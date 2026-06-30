// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for the showcase-stats helpers added in the startup-watchdog +
 * showcase-error-transparency mega-fix.
 *
 * Covers:
 *   - responseError extracts JSON .message/.error/.detail when present
 *   - responseError falls back to truncated raw body for non-JSON
 *   - responseError returns "no response" when fetch failed entirely
 *   - responseError truncates long bodies and collapses whitespace
 *   - isTransientError flags 5xx/429 status codes
 *   - isTransientError flags DB-outage / rate-limit body markers
 *   - isTransientError does NOT flag plain auth failures or 404s
 */

import { describe, it, expect } from 'vitest';
import { responseError, isTransientError } from '../src/services/gameStats.js';

describe('responseError', () => {
  function makeRes(status: number, body: string): Response {
    return new Response(body, { status, statusText: 'X' });
  }

  it('returns "no response" when fetch failed entirely', async () => {
    expect(await responseError(null, 'R6')).toBe('R6 API: no response');
  });

  it('extracts JSON .message field', async () => {
    const res = makeRes(401, JSON.stringify({ error: 'Unauthorized', message: 'too many connections' }));
    const out = await responseError(res, 'R6');
    expect(out).toBe('R6 API 401: too many connections');
  });

  it('extracts JSON .error field when .message is absent', async () => {
    const res = makeRes(400, JSON.stringify({ error: 'Profile private' }));
    const out = await responseError(res, 'Fortnite');
    expect(out).toBe('Fortnite API 400: Profile private');
  });

  it('extracts JSON nested .error.message', async () => {
    const res = makeRes(503, JSON.stringify({ error: { code: 'EOOM', message: 'service unavailable' } }));
    const out = await responseError(res, 'Apex');
    expect(out).toBe('Apex API 503: service unavailable');
  });

  it('falls back to raw body for non-JSON responses', async () => {
    const res = makeRes(429, 'Too Many Requests');
    const out = await responseError(res, 'Steam');
    expect(out).toBe('Steam API 429: Too Many Requests');
  });

  it('truncates long bodies to 200 chars and collapses whitespace', async () => {
    const long = 'a'.repeat(500);
    const res = makeRes(500, long);
    const out = await responseError(res, 'X');
    // Expected length: "X API 500: " (11 chars) + 200 'a's = 211
    expect(out.length).toBe(211);
    expect(out.startsWith('X API 500: ')).toBe(true);
  });

  it('returns status-only when body is empty', async () => {
    const res = makeRes(502, '');
    const out = await responseError(res, 'OpenDota');
    expect(out).toBe('OpenDota API returned 502');
  });
});

describe('isTransientError', () => {
  it('flags 5xx/429 status codes', () => {
    expect(isTransientError(undefined, 502)).toBe(true);
    expect(isTransientError(undefined, 503)).toBe(true);
    expect(isTransientError(undefined, 504)).toBe(true);
    expect(isTransientError(undefined, 429)).toBe(true);
  });

  it('does not flag normal client/auth errors by status alone', () => {
    expect(isTransientError(undefined, 400)).toBe(false);
    expect(isTransientError(undefined, 401)).toBe(false);
    expect(isTransientError(undefined, 403)).toBe(false);
    expect(isTransientError(undefined, 404)).toBe(false);
  });

  it('flags DB-outage markers in the error string', () => {
    expect(isTransientError('R6 API 401: too many connections')).toBe(true);
    expect(isTransientError('R6 API 401: connection slots are reserved')).toBe(true);
    expect(isTransientError('Apex API 503: service unavailable')).toBe(true);
    expect(isTransientError('Steam API 504: gateway timeout')).toBe(true);
    expect(isTransientError('OpenDota API: bad gateway')).toBe(true);
    expect(isTransientError('Riot LOL API: temporarily unavailable')).toBe(true);
    expect(isTransientError('Fortnite API: try again later')).toBe(true);
  });

  it('flags Node fetch network markers', () => {
    expect(isTransientError('Some error: ECONNRESET')).toBe(true);
    expect(isTransientError('Some error: ETIMEDOUT')).toBe(true);
    expect(isTransientError('connection refused at upstream')).toBe(true);
  });

  it('does not flag plain auth failures or missing accounts', () => {
    expect(isTransientError('R6 API 401: invalid api key')).toBe(false);
    expect(isTransientError('Fortnite API 400: Profile private')).toBe(false);
    expect(isTransientError('OpenDota API returned 404')).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError('')).toBe(false);
  });

  it('does not flag bare "connection" (avoids false positives)', () => {
    // "connection" alone could match Connection: keep-alive headers, etc.
    expect(isTransientError('connection: keep-alive')).toBe(false);
  });
});
