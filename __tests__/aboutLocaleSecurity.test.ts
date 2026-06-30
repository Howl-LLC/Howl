// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import enUS from '../src/locales/en-US.json';
import enGB from '../src/locales/en-GB.json';

const REQUIRED = [
  'about.story', 'about.storyBody1', 'about.storyBody2',
  'about.values', 'about.valuesPrivate', 'about.valuesNotForSale', 'about.valuesFeatures', 'about.valuesIndependent',
  'about.security', 'about.securityIntro',
  'about.securityPqTitle', 'about.securityPqBody',
  'about.securityMlsTitle', 'about.securityMlsBody',
  'about.securityKeysTitle', 'about.securityKeysBody',
  'about.securityFsTitle', 'about.securityFsBody',
  'about.securityCallsTitle', 'about.securityCallsBody',
  'about.securityFilesTitle', 'about.securityFilesBody',
  'about.securityDevicesTitle', 'about.securityDevicesBody',
  'about.securityTransparency',
];

describe('about page story/values/security i18n keys', () => {
  it('all required keys exist in en-US', () => {
    const missing = REQUIRED.filter((k) => !(k in (enUS as unknown as Record<string, string>)));
    expect(missing).toEqual([]);
  });

  it('all required keys exist in en-GB', () => {
    const missing = REQUIRED.filter((k) => !(k in (enGB as unknown as Record<string, string>)));
    expect(missing).toEqual([]);
  });

  it('makes accurate, non-overstated security claims', () => {
    const u = enUS as unknown as Record<string, string>;
    expect(u['about.securityPqBody']).toMatch(/X-Wing/);
    expect(u['about.securityPqBody']).toMatch(/ML-KEM-768/);
    expect(u['about.securityMlsTitle']).toMatch(/RFC 9420/);
    expect(u['about.securityKeysBody']).toMatch(/Argon2id/);
    expect(u['about.securityFilesBody']).toMatch(/AES-256-GCM/);
    // Honesty guardrails: never claim post-quantum signatures.
    const all = REQUIRED.map((k) => u[k] ?? '').join(' ');
    expect(all).not.toMatch(/post-quantum signature/i);
    // Transparency note must carve out server channels AND GIFs/embeds.
    expect(u['about.securityTransparency']).toMatch(/server and community channels/i);
    expect(u['about.securityTransparency']).toMatch(/GIF/);
  });
});
