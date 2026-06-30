// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/** Compute power-up tier from the raw power-up count. */
export function powerUpTier(count: number): number {
  if (count >= 14) return 3;
  if (count >= 7) return 2;
  if (count >= 2) return 1;
  return 0;
}
