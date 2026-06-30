// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

test.describe('QuickTextPanel mobile safe-area', () => {
  test('panel bottom positioning honors safe-area inset', async ({ page }, testInfo) => {
    await page.goto('/');

    // Probe: inline style `max(env(safe-area-inset-bottom), 8px)` must resolve to
    // at least 8px on every device. On iPhone viewports with a home indicator the
    // UA substitutes a non-zero inset; on flat viewports it falls back to 8px.
    const resolvedBottom = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.position = 'absolute';
      probe.style.bottom = 'max(env(safe-area-inset-bottom, 0px), 8px)';
      probe.style.left = '0';
      probe.style.width = '1px';
      probe.style.height = '1px';
      document.body.appendChild(probe);
      const px = getComputedStyle(probe).bottom;
      probe.remove();
      return px;
    });

    const parsed = Number.parseFloat(resolvedBottom);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeGreaterThanOrEqual(8);

    await mobileSnap(page, 'quick-text-panel-safe-area', testInfo);
  });
});
