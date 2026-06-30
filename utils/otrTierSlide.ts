// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/** Directional slide class for an OTR/Saved tier change. Empty string under
 *  reduced motion (switch instantly, no transform). */
export function otrTierSlideClass(isOtr: boolean, reducedMotion: boolean): string {
  if (reducedMotion) return '';
  return isOtr ? 'otr-slide-from-right' : 'otr-slide-from-left';
}
