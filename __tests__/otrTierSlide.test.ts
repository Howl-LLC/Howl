// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { otrTierSlideClass } from '../utils/otrTierSlide';

describe('otrTierSlideClass', () => {
  it('slides in from the right when entering OTR', () => {
    expect(otrTierSlideClass(true, false)).toBe('otr-slide-from-right');
  });
  it('slides in from the left when returning to Saved', () => {
    expect(otrTierSlideClass(false, false)).toBe('otr-slide-from-left');
  });
  it('applies no transform under reduced motion', () => {
    expect(otrTierSlideClass(true, true)).toBe('');
    expect(otrTierSlideClass(false, true)).toBe('');
  });
});
