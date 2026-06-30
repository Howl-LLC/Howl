// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

test.describe('DMCallView mobile viewport', () => {
  test('landing renders on mobile viewport', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\//);
    await mobileSnap(page, 'dmcallview-baseline', testInfo);
  });
});
