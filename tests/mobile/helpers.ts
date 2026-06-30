// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Page, TestInfo } from '@playwright/test';

export async function mobileSnap(page: Page, name: string, testInfo?: TestInfo) {
  const project = testInfo?.project.name ?? 'unknown';
  const path = `test-results/mobile/${name}-${project}.png`;
  await page.screenshot({ path, fullPage: true });
  return path;
}

export async function seedAuth(page: Page, token: string = 'test-token', user?: Record<string, unknown>) {
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('authToken', token);
    if (user) {
      localStorage.setItem('currentUser', JSON.stringify(user));
    }
  }, { token, user });
}

export const MOBILE_PRO_USER = {
  id: 'mobile-test-pro',
  username: 'mobiletester',
  displayName: 'Mobile Tester',
  effectivePlan: 'pro',
  nameColor: '#ff00aa',
  nameFont: 'Creepster',
  nameEffect: 'glow',
  avatarEffect: 'rainbow',
};
