// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

/**
 * MessageInput: visual-viewport pinning + safe-area.
 *
 * Public entry points (login/landing) don't render MessageInput, so this
 * test focuses on what can be verified without a logged-in session:
 * the page renders, and the Visual Viewport API is available on the
 * iPhone 13 emulation (the foundation the composer pinning relies on).
 */
test.describe('MessageInput mobile viewport', () => {
  test('page loads and visualViewport API is available on iPhone 13', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\//);

    const vv = await page.evaluate(() => {
      const v = window.visualViewport;
      return v
        ? { height: v.height, offsetTop: v.offsetTop, innerHeight: window.innerHeight }
        : null;
    });
    expect(vv).not.toBeNull();
    expect(vv!.height).toBeGreaterThan(0);

    await mobileSnap(page, 'message-input-landing', testInfo);
  });
});
