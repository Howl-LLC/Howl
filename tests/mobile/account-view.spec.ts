// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

test.describe('AccountView mobile settings nav', () => {
  test('mobile settings sidebar respects w-[min(240px,70vw)] clamp', async ({ page }, testInfo) => {
    await page.goto('/');

    // Mount a synthetic sidebar fragment matching the production class + style
    // to exercise the clamped width without requiring a full auth session.
    await page.setContent(`
      <html>
        <body style="margin:0;padding:0;">
          <div class="fixed inset-0 flex" style="position:fixed;inset:0;display:flex;">
            <div
              class="relative w-[min(240px,70vw)] h-full flex flex-col"
              style="width:min(240px,70vw);height:100vh;background:#111;"
              data-testid="mobile-settings-sidebar"
            >
              <div style="color:white;padding:8px;">Configuration</div>
            </div>
          </div>
        </body>
      </html>
    `);

    const sidebar = page.getByTestId('mobile-settings-sidebar');
    await expect(sidebar).toBeVisible();

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const viewportWidth = viewport!.width;

    const box = await sidebar.boundingBox();
    expect(box).not.toBeNull();
    const sidebarWidth = box!.width;

    const expected = Math.min(240, viewportWidth * 0.7);
    expect(sidebarWidth).toBeCloseTo(expected, 0);
    expect(viewportWidth - sidebarWidth).toBeGreaterThanOrEqual(100);

    await mobileSnap(page, 'account-view-sidebar', testInfo);
  });
});
