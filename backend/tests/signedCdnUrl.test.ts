// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for signCdnUrl — the HMAC-signed CDN URL helper that replaces
 * permanently-valid public URLs with short-lived, edge-validated signatures.
 *
 * Format: `${CDN_BASE_URL}/${key}?exp=<unix-seconds>&sig=<base64url HMAC-SHA256>`
 * Signed message: `${key}:${exp}`
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createHmac } from 'crypto';

const TEST_CDN_BASE = 'https://cdn.example.test';
const TEST_SECRET = 'test-secret-at-least-32-chars-long-xxxxx';

describe('signCdnUrl', () => {
  const originalBase = process.env.CDN_BASE_URL;
  const originalSecret = process.env.CDN_SIGNING_SECRET;
  const originalTtl = process.env.CDN_URL_TTL_SECONDS;

  beforeEach(() => {
    process.env.CDN_BASE_URL = TEST_CDN_BASE;
    process.env.CDN_SIGNING_SECRET = TEST_SECRET;
    delete process.env.CDN_URL_TTL_SECONDS;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.CDN_BASE_URL = originalBase;
    process.env.CDN_SIGNING_SECRET = originalSecret;
    process.env.CDN_URL_TTL_SECONDS = originalTtl;
    vi.useRealTimers();
    vi.resetModules();
  });

  it('produces URL with base, key, exp, and sig', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));

    const { signCdnUrl } = await import('../src/services/cdnSign.js');
    const url = signCdnUrl('uploads/abc.png');

    const parsed = new URL(url);
    expect(`${parsed.protocol}//${parsed.host}`).toBe(TEST_CDN_BASE);
    expect(parsed.pathname).toBe('/uploads/abc.png');
    expect(parsed.searchParams.get('exp')).toBeTruthy();
    expect(parsed.searchParams.get('sig')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is deterministic for the same inputs + secret + clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));

    const { signCdnUrl } = await import('../src/services/cdnSign.js');
    const a = signCdnUrl('uploads/file.jpg');
    const b = signCdnUrl('uploads/file.jpg');
    expect(a).toBe(b);
  });

  it('signature round-trips against crypto.createHmac', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));

    const { signCdnUrl } = await import('../src/services/cdnSign.js');
    const key = 'uploads/roundtrip.webp';
    const url = signCdnUrl(key);
    const parsed = new URL(url);
    const exp = parsed.searchParams.get('exp')!;
    const sig = parsed.searchParams.get('sig')!;

    const expected = createHmac('sha256', TEST_SECRET)
      .update(`${key}:${exp}`)
      .digest('base64url');

    expect(sig).toBe(expected);
  });

  it('exp is ~now + default TTL (300s)', async () => {
    const fixedNow = new Date('2026-04-20T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const { signCdnUrl } = await import('../src/services/cdnSign.js');
    const url = signCdnUrl('uploads/ttl.png');
    const exp = Number(new URL(url).searchParams.get('exp'));
    const nowSec = Math.floor(fixedNow.getTime() / 1000);

    expect(exp).toBeGreaterThanOrEqual(nowSec + 300 - 1);
    expect(exp).toBeLessThanOrEqual(nowSec + 300 + 1);
  });

  it('honors CDN_URL_TTL_SECONDS override', async () => {
    process.env.CDN_URL_TTL_SECONDS = '60';
    const fixedNow = new Date('2026-04-20T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const { signCdnUrl } = await import('../src/services/cdnSign.js');
    const url = signCdnUrl('uploads/short.png');
    const exp = Number(new URL(url).searchParams.get('exp'));
    const nowSec = Math.floor(fixedNow.getTime() / 1000);

    expect(exp).toBeGreaterThanOrEqual(nowSec + 60 - 1);
    expect(exp).toBeLessThanOrEqual(nowSec + 60 + 1);
  });
});
