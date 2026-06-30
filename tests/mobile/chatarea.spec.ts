// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

// Minimal smoke test for the ChatArea mobile viewport fix.
// Unauthenticated, so we only verify the app loads on a mobile viewport
// without layout errors. Full keyboard/safe-area behaviour is tested via
// component-level integration in chat sessions; this is the harness-level
// sanity check for the ChatArea unit.
test.describe('ChatArea mobile viewport', () => {
  test('app mounts without layout errors on mobile viewport', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');
    await expect(page).toHaveURL(/\//);

    // Viewport sanity: iPhone 13 width is 390px (well below the 768px breakpoint).
    const vw = page.viewportSize();
    expect(vw).not.toBeNull();
    expect(vw!.width).toBeLessThan(768);

    // No runtime errors from mounting the React tree (incl. ChatArea imports).
    expect(errors).toEqual([]);

    await mobileSnap(page, 'chatarea-landing', testInfo);
  });
});
