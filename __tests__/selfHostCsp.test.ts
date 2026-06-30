// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { applySelfHostCsp } from '../scripts/selfHostCsp';

const sample = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' wss://api.howlpro.com https://api.howlpro.com; media-src 'self' https://cdn.howlpro.com;">`;

describe('applySelfHostCsp', () => {
  it('replaces the meta CSP with a domain-agnostic self-host policy', () => {
    const out = applySelfHostCsp(sample);
    expect(out).not.toContain('howlpro.com');
    expect(out).toContain("connect-src 'self' https: wss:");
    expect(out).toContain("default-src 'self'");
  });
  it('leaves html without a CSP meta untouched', () => {
    expect(applySelfHostCsp('<html></html>')).toBe('<html></html>');
  });
});
