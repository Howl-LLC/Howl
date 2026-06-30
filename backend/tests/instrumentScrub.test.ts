// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { scrubBreadcrumb } from '../src/instrument.js';

describe('ORC-05 — backend Sentry breadcrumb scrubbing', () => {
  // Real @sentry/node shape: the SDK strips the query from data.url (path only) and
  // puts the raw query in data['http.query'] (outgoingHttpRequest.js:117,122). This
  // is the field that leaks the Steam API ?key=... on outgoing requests.
  it('strips sensitive params from http.query (the field the node SDK actually emits)', () => {
    const b = scrubBreadcrumb({
      category: 'http',
      data: {
        url: 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/',
        'http.query': '?key=STEAM_SECRET&steamids=123&access_token=tok',
      },
    });
    expect(b.data?.['http.query']).not.toContain('key=STEAM_SECRET');
    expect(b.data?.['http.query']).not.toContain('access_token=');
    expect(b.data?.['http.query']).toContain('steamids=123'); // non-sensitive preserved
  });

  it('empties http.query when every param is sensitive', () => {
    const b = scrubBreadcrumb({ category: 'http', data: { 'http.query': '?token=abc&code=xyz' } });
    expect(b.data?.['http.query']).toBe('');
  });

  it('also strips query from a browser-shaped data.url and drops request bodies', () => {
    const b = scrubBreadcrumb({
      category: 'http',
      data: { url: 'https://api.howl/x?token=secret&keep=1', request_body: '{"password":"p"}' },
    });
    expect(b.data?.url).not.toContain('token=');
    expect(b.data?.url).toContain('keep=1');
    expect((b.data as Record<string, unknown>).request_body).toBeUndefined();
  });

  it('leaves non-http breadcrumbs untouched', () => {
    const b = scrubBreadcrumb({ category: 'console', message: 'hello', data: { 'http.query': '?token=1' } });
    expect((b.data as Record<string, unknown>)['http.query']).toBe('?token=1');
  });
});
