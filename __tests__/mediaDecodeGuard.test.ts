// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { parseImageDimensions } from '../services/mediaDecodeGuard';

function u32be(v: number): number[] { return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]; }

describe('parseImageDimensions', () => {
  it('parses PNG IHDR width/height', () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,           // signature
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,                       // IHDR length+type
      ...u32be(1920), ...u32be(1080),                            // width, height
      8, 6, 0, 0, 0,
    ]);
    expect(parseImageDimensions(png)).toMatchObject({ width: 1920, height: 1080, frames: 1 });
  });

  it('parses GIF logical-screen width/height (little-endian)', () => {
    const gif = new Uint8Array(20);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);            // GIF89a
    gif[6] = 0x40; gif[7] = 0x00;                                 // width 64 LE
    gif[8] = 0x20; gif[9] = 0x00;                                 // height 32 LE
    gif[10] = 0x00;                                               // no global color table
    gif[13] = 0x3b;                                               // trailer
    expect(parseImageDimensions(gif)).toMatchObject({ width: 64, height: 32 });
  });

  it('parses JPEG SOF0 dimensions', () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8,                                                 // SOI
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x00, 0x06, 0x00,       // SOF0: height 0x0400=1024, width 0x0600=1536
    ]);
    expect(parseImageDimensions(jpeg)).toMatchObject({ width: 1536, height: 1024 });
  });

  it('returns null for unparseable bytes', () => {
    expect(parseImageDimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });
});
