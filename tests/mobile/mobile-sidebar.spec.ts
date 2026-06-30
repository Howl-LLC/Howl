// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

test.describe('MobileSidebar viewport polish', () => {
  test('renders on mobile without overflowing the viewport', async ({ page }, testInfo) => {
    await page.goto('/');

    const viewport = page.viewportSize();
    expect(viewport).toBeTruthy();

    // No horizontal overflow on mobile — guards drawer width regression.
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    if (viewport) {
      expect(documentWidth).toBeLessThanOrEqual(viewport.width + 1);
    }

    await mobileSnap(page, 'mobile-sidebar-landing', testInfo);
  });
});
