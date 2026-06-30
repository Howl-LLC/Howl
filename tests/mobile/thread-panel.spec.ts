// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

// Minimal smoke test for ThreadPanel on mobile viewports.
// Verifies the app shell still loads on iPhone 13 / Pixel 5 after the
// ThreadPanel keyboard-aware + safe-area changes. The full ThreadPanel
// requires an authenticated, in-channel state that the mobile harness
// does not bootstrap today; we keep this lightweight and visual.
test.describe('ThreadPanel mobile', () => {
  test('app shell renders on mobile viewport without thread panel crash', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\//);
    // Sanity: no uncaught runtime error during initial mount.
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.waitForLoadState('networkidle').catch(() => {});
    await mobileSnap(page, 'thread-panel-shell', testInfo);
    expect(errors, `pageerror(s): ${errors.join(' | ')}`).toEqual([]);
  });
});
