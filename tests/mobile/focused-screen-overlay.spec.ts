// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

test.describe('FocusedScreenOverlay — mobile viewport', () => {
  test('app renders on mobile without breaking from overlay changes', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\//);
    await mobileSnap(page, 'focused-screen-overlay-home', testInfo);
  });
});
