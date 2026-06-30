// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect, useRef } from 'react';

/**
 * Detects mobile keyboard open/close via the Visual Viewport API.
 * Returns the current visual viewport height (or full viewport when keyboard is closed).
 * On desktop / unsupported browsers, returns window.innerHeight and never fires.
 *
 * The resize handler is debounced (~100ms) to avoid layout thrashing during
 * iOS keyboard animation (~300ms).
 */
export function useKeyboardAware(enabled: boolean) {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window !== 'undefined' ? window.innerHeight : 0,
  );
  const rafRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!enabled) return;

    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return; // No Visual Viewport API — nothing to do

    const fullHeight = window.innerHeight;

    const update = () => {
      // Debounce: wait for keyboard animation to settle
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          const h = vv.height;
          setViewportHeight(h);
          // Keyboard is "open" when visual viewport shrinks significantly (>100px = keyboard, not just address bar)
          setKeyboardOpen(fullHeight - h > 100);
        });
      }, 100);
    };

    vv.addEventListener('resize', update, { passive: true });
    return () => {
      vv.removeEventListener('resize', update);
      clearTimeout(timerRef.current);
      cancelAnimationFrame(rafRef.current);
    };
  }, [enabled]);

  return { keyboardOpen, viewportHeight };
}
