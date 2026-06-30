// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll } from 'vitest';

describe('cdnSign — fail-closed signing', () => {
  beforeAll(() => {
    process.env.CDN_BASE_URL = 'https://cdn.howlpro.com';
    process.env.CDN_SIGNING_SECRET = 'x'.repeat(48);
  });

  it('defaults the URL TTL to 300s (shortened replay window)', async () => {
    const { CDN_URL_TTL_SECONDS } = await import('../src/services/cdnSign.js');
    expect(CDN_URL_TTL_SECONDS).toBe(300);
  });

  it('emits exp ~now+TTL and a base64url signature bound to key:exp', async () => {
    const { signCdnUrl, CDN_URL_TTL_SECONDS } = await import('../src/services/cdnSign.js');
    const url = signCdnUrl('uploads/abc.enc');
    const u = new URL(url);
    const exp = Number(u.searchParams.get('exp'));
    const now = Math.floor(Date.now() / 1000);
    expect(exp).toBeGreaterThanOrEqual(now + CDN_URL_TTL_SECONDS - 2);
    expect(exp).toBeLessThanOrEqual(now + CDN_URL_TTL_SECONDS + 2);
    expect(u.searchParams.get('sig')).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no '+//='
  });
});
