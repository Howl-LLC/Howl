// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

test.describe('AppLayout mobile viewport', () => {
  test('landing route renders and stays within viewport width on mobile', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\//);
    await page.waitForLoadState('domcontentloaded');
    // No horizontal overflow: document/body width ≤ viewport width (allow 1px rounding).
    const { docWidth, bodyWidth, innerWidth } = await page.evaluate(() => ({
      docWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(docWidth).toBeLessThanOrEqual(innerWidth + 1);
    expect(bodyWidth).toBeLessThanOrEqual(innerWidth + 1);
    await mobileSnap(page, 'app-layout-root', testInfo);
  });
});
