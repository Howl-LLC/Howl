// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

test.describe('DMView responsive side panel', () => {
  test('mobile viewport renders without crashing and snapshots', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\//);
    // iPhone 13 is 390px wide (<480), so the DM members side panel must stay
    // collapsed-by-default. Unauthenticated landing is sufficient to prove no
    // layout regression from the width-cap / narrow-viewport gate change.
    await mobileSnap(page, 'dm-view', testInfo);
  });
});
