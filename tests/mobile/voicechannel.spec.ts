// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { test, expect } from '@playwright/test';
import { mobileSnap } from './helpers';

test.describe('VoiceChannel mobile viewport', () => {
  test('landing page renders without horizontal overflow on iPhone viewport', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\//);
    // Guard against horizontal overflow on the initial viewport — the primary
    // symptom of the VoiceChannel tile-width issues on narrow phones.
    const overflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth - document.documentElement.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
    await mobileSnap(page, 'voicechannel-baseline', testInfo);
  });
});
