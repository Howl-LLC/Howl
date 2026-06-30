// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
const fp = await import('../../electron/streamdeck/fingerprint.js').then((m) => m.default ?? m);

describe('streamdeck/fingerprint', () => {
  it('is deterministic for the same inputs', () => {
    const a = fp.derive({ pluginId: 'com.howlpro.streamdeck', challenge: 'a'.repeat(64), installId: 'abc' });
    const b = fp.derive({ pluginId: 'com.howlpro.streamdeck', challenge: 'a'.repeat(64), installId: 'abc' });
    expect(a).toEqual(b);
    expect(a.words).toHaveLength(4);
  });

  it('changes when any input changes', () => {
    const base = fp.derive({ pluginId: 'com.howlpro.streamdeck', challenge: 'a'.repeat(64), installId: 'abc' });
    const v1 = fp.derive({ pluginId: 'com.evil.typosquat', challenge: 'a'.repeat(64), installId: 'abc' });
    const v2 = fp.derive({ pluginId: 'com.howlpro.streamdeck', challenge: 'b'.repeat(64), installId: 'abc' });
    const v3 = fp.derive({ pluginId: 'com.howlpro.streamdeck', challenge: 'a'.repeat(64), installId: 'xyz' });
    expect(v1.words).not.toEqual(base.words);
    expect(v2.words).not.toEqual(base.words);
    expect(v3.words).not.toEqual(base.words);
  });

  it('returns valid BIP-39 words', () => {
    const BIP39 = require('../../electron/streamdeck/bip39-english.js') as string[];
    const res = fp.derive({ pluginId: 'com.howlpro.streamdeck', challenge: 'c'.repeat(64), installId: 'i' });
    for (const w of res.words) expect(BIP39).toContain(w);
  });
});
