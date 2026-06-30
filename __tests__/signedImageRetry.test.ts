// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import type { SyntheticEvent } from 'react';
import { retryOnExpired, toOriginalUploadPath } from '../utils/signedImageRetry';

function fakeEvent(el: HTMLImageElement): SyntheticEvent<HTMLImageElement> {
  return { currentTarget: el } as unknown as SyntheticEvent<HTMLImageElement>;
}

describe('retryOnExpired', () => {
  it('rewrites src with the original path plus a cache-buster and returns true', () => {
    const img = document.createElement('img');
    img.dataset.originalSrc = '/api/uploads/foo.png';
    const fired = retryOnExpired(fakeEvent(img));
    expect(fired).toBe(true);
    expect(img.src).toMatch(/\/api\/uploads\/foo\.png\?_=\d+$/);
    expect(img.dataset.retried).toBe('1');
  });

  it('preserves an existing query string and uses & for the cache-buster', () => {
    const img = document.createElement('img');
    img.dataset.originalSrc = '/api/uploads/foo.png?v=2';
    retryOnExpired(fakeEvent(img));
    expect(img.src).toMatch(/\/api\/uploads\/foo\.png\?v=2&_=\d+$/);
  });

  it('is a one-shot — a second error does not rewrite again and returns false', () => {
    const img = document.createElement('img');
    img.dataset.originalSrc = '/api/uploads/foo.png';
    retryOnExpired(fakeEvent(img));
    const firstSrc = img.src;
    const second = retryOnExpired(fakeEvent(img));
    expect(second).toBe(false);
    expect(img.src).toBe(firstSrc);
  });

  it('no-ops and returns false when data-original-src is missing', () => {
    const img = document.createElement('img');
    img.src = 'https://example.com/broken.png';
    const fired = retryOnExpired(fakeEvent(img));
    expect(fired).toBe(false);
    expect(img.src).toBe('https://example.com/broken.png');
    expect(img.dataset.retried).toBeUndefined();
  });
});

describe('toOriginalUploadPath', () => {
  it('returns relative /api/uploads paths unchanged', () => {
    expect(toOriginalUploadPath('/api/uploads/abc.png')).toBe('/api/uploads/abc.png');
  });

  it('ignores blob, data, and external URLs', () => {
    expect(toOriginalUploadPath('blob:https://example/xyz')).toBeUndefined();
    expect(toOriginalUploadPath('data:image/png;base64,AAA')).toBeUndefined();
    expect(toOriginalUploadPath('https://i.imgur.com/abc.png')).toBeUndefined();
  });

  it('no-ops on null / undefined / empty', () => {
    expect(toOriginalUploadPath(null)).toBeUndefined();
    expect(toOriginalUploadPath(undefined)).toBeUndefined();
    expect(toOriginalUploadPath('')).toBeUndefined();
  });
});
