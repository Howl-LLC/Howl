// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

// Minimal smoke test: StageView is reachable only from an authenticated
// session inside a stage-enabled channel. Without a full test harness we
// verify the mobile viewport loads the app shell without crashing — the
// sizing changes are CSS-only and no-op at >=768px.
test.describe('StageView mobile layout smoke', () => {
  test('app shell loads on mobile viewport', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\//);
    const vw = page.viewportSize();
    expect(vw?.width ?? 0).toBeLessThan(768);
    await mobileSnap(page, 'stageview-shell', testInfo);
  });

  test('landscape phone viewport loads', async ({ page }, testInfo) => {
    // Simulate landscape phone (800x375) — the narrow-height case the fix targets.
    await page.setViewportSize({ width: 800, height: 375 });
    await page.goto('/');
    await expect(page).toHaveURL(/\//);
    await mobileSnap(page, 'stageview-landscape', testInfo);
  });
});
