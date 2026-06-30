// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Application-layer PADME padding for MLS application messages.
 *
 * ts-mls's PaddingConfig is a closed union (padUntilLength | alwaysPad) that
 * cannot express PADME bucketing, so we pad the plaintext at the encryptApp /
 * decryptApp chokepoint: VERSION(1) || u32LE(realLen) || plaintext, zero-padded
 * to a Padmé bucket. These are the pure unit tests for the frame helpers; the
 * real two-party end-to-end property lives in mlsEngine.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { padApplicationPlaintext, unpadApplicationPlaintext } from '../../services/mls/mlsEngine';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('MLS application-layer PADME padding', () => {
  it('round-trips plaintext of various lengths exactly', () => {
    for (const len of [0, 1, 5, 255, 256, 257, 300, 1000, 5000]) {
      const pt = new Uint8Array(len).map((_, i) => i & 0xff);
      const back = unpadApplicationPlaintext(padApplicationPlaintext(pt));
      expect(back.length).toBe(len);
      expect([...back]).toEqual([...pt]);
    }
  });

  it('frames as version(0x01) || u32 length, pads to >= input+5, trailing bytes zero', () => {
    const pt = enc('x'.repeat(300));
    const padded = padApplicationPlaintext(pt);
    expect(padded[0]).toBe(0x01); // version
    expect(padded.length).toBeGreaterThanOrEqual(300 + 5);
    for (let i = 5 + 300; i < padded.length; i++) expect(padded[i]).toBe(0); // pad is zero
  });

  it('buckets different lengths in the same Padmé class to an identical padded length', () => {
    // framed = 5 + len. 305 and 320 both round up to the same bucket (320).
    const a = padApplicationPlaintext(enc('a'.repeat(300)));
    const b = padApplicationPlaintext(enc('b'.repeat(315)));
    expect(a.length).toBe(b.length);
  });

  it('separates clearly different sizes into different buckets', () => {
    const small = padApplicationPlaintext(enc('a'.repeat(300)));
    const large = padApplicationPlaintext(enc('a'.repeat(5000)));
    expect(large.length).toBeGreaterThan(small.length);
  });

  it('fails closed on an unknown padding version', () => {
    const padded = padApplicationPlaintext(enc('hello'));
    padded[0] = 0x02;
    expect(() => unpadApplicationPlaintext(padded)).toThrow();
  });

  it('fails closed on an out-of-range declared length', () => {
    const padded = padApplicationPlaintext(enc('hello'));
    new DataView(padded.buffer, padded.byteOffset, padded.byteLength).setUint32(1, 0xffffffff, true);
    expect(() => unpadApplicationPlaintext(padded)).toThrow();
  });

  it('fails closed on a truncated frame', () => {
    expect(() => unpadApplicationPlaintext(new Uint8Array([0x01, 0x00]))).toThrow();
  });
});
