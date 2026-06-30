// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// ts-mls is ESM-only and its default crypto provider relies on
// globalThis.crypto.subtle + crypto.getRandomValues. The repo runs tests under
// jsdom (vitest.config.ts), which does not ship WebCrypto, so we install Node's
// webcrypto polyfill in beforeAll — the same pattern as __tests__/dmCrypto.test.ts.
import { describe, it, expect, beforeAll } from 'vitest';
import { getImpl, MLS_CIPHERSUITE_NAME, MLS_CIPHERSUITE_ID, supportedCapabilities, filterAdvertisedCiphersuites } from '../../services/mls/ciphersuite';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

describe('ts-mls is a usable frontend dependency', () => {
  it('exposes the pinned ciphersuite constants', () => {
    expect(MLS_CIPHERSUITE_NAME).toBe('MLS_256_XWING_AES256GCM_SHA512_Ed25519');
    expect(MLS_CIPHERSUITE_ID).toBe(83);
  });

  it('instantiates ciphersuite id 83', async () => {
    const impl = await getImpl();
    expect(impl.name).toBe('MLS_256_XWING_AES256GCM_SHA512_Ed25519');
  });

  it('memoizes the impl (same promise on repeated calls)', () => {
    const a = getImpl();
    const b = getImpl();
    expect(a).toBe(b);
  });

  it('advertises the active suite + GREASE only (no other real suite, no x509)', () => {
    const caps = supportedCapabilities();
    expect(caps.ciphersuites).toContain('MLS_256_XWING_AES256GCM_SHA512_Ed25519');
    // The ONLY real (MLS_*) suite advertised is the one whose dep we installed.
    const realSuites = caps.ciphersuites.filter((c) => String(c).startsWith('MLS_'));
    expect(realSuites).toEqual(['MLS_256_XWING_AES256GCM_SHA512_Ed25519']);
    // Any non-real entries are GREASE codepoints (numeric strings), restored for
    // protocol-ossification testing.
    for (const c of caps.ciphersuites) {
      if (!String(c).startsWith('MLS_')) expect(/^\d+$/.test(String(c))).toBe(true);
    }
    // Spread must preserve the other capability fields (not return a bare object).
    expect(caps.versions).toContain('mls10');
    expect(caps.credentials).toContain('basic');
    expect(caps.credentials).not.toContain('x509'); // validator only honors 'basic'
  });

  it('filterAdvertisedCiphersuites keeps active suite + GREASE, drops other real suites (deterministic)', () => {
    // GREASE in defaultCapabilities() is probabilistic, so assert the filter directly
    // against a controlled input: a regression that re-drops GREASE (back to only the
    // active suite) would fail this; the public-function test alone would not.
    const input = [
      'MLS_256_XWING_AES256GCM_SHA512_Ed25519',
      'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519', // other real suite -> dropped
      '10794', '2570', // GREASE codepoints (numeric strings) -> retained
    ] as unknown as Parameters<typeof filterAdvertisedCiphersuites>[0];
    expect(filterAdvertisedCiphersuites(input)).toEqual([
      'MLS_256_XWING_AES256GCM_SHA512_Ed25519', '10794', '2570',
    ]);
  });
});
