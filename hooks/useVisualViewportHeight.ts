// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect } from 'react';

/**
 * Tracks `window.visualViewport.height` so callers can clamp UI (e.g. a growing
 * editor) against the portion of the viewport the user can actually see — the
 * soft keyboard on iOS/Android shrinks `visualViewport.height` without changing
 * `window.innerHeight`.
 *
 * Pass `enabled=false` (e.g. on desktop) to skip listeners and return the
 * initial `window.innerHeight`. SSR-safe: returns a sensible fallback on the
 * server and during hydration before `visualViewport` is available.
 */
export function useVisualViewportHeight(enabled: boolean): number {
  const [height, setHeight] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerHeight : 800,
  );

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;
    const update = () => setHeight(vv.height);
    update();
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, [enabled]);

  return height;
}
