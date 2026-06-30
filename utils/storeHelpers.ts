// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Direct store update passthrough.
 *
 * Previously wrapped in React.startTransition to work around React #185,
 * but the actual root cause was uncached getSnapshot returns in Zustand
 * selectors (creating new {} on every call). With selectors fixed,
 * startTransition is unnecessary and can cause subtle timing issues.
 */
export function deferStoreUpdate(fn: () => void): void {
  fn();
}
