// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

test.describe('IncomingDMCallModal — narrow viewport', () => {
  test('landing renders on narrow mobile viewport (regression surface for modal safe-area / stacking)', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\//);
    await mobileSnap(page, 'incoming-dm-call-modal-landing', testInfo);
  });
});
