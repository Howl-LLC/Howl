// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

test.describe('FloatingUserStatusBar safe-area bottom', () => {
  test('mobile viewport renders without crashing and snapshots', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\//);
    await mobileSnap(page, 'floating-user-status-bar', testInfo);
  });
});
