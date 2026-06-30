// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

test.describe('Lexical editors visualViewport-aware max-height', () => {
  test('mobile viewport renders without crashing and snapshots', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\//);
    // iPhone 13 is 390×844. The LexicalChatEditor / LexicalEditEditor clamp
    // their content-editable max-height to vh * 0.35 on mobile (<768px) so a
    // long message can't push the send / save controls offscreen when the
    // soft keyboard is open. Unauthenticated landing is sufficient to prove
    // the mount-time hook wiring doesn't throw or regress layout.
    await mobileSnap(page, 'lexical-editors', testInfo);
  });
});
