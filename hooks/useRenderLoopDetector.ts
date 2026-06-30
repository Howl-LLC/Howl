// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useRef } from 'react';

const THRESHOLD = 50; // React's limit is ~50 nested updates
const WINDOW_MS = 1000; // 1 second window

/**
 * Development-only hook that detects infinite re-render loops BEFORE
 * React crashes with error #185. Logs the component name and render
 * count to console.error so you can identify the looping component.
 *
 * Usage: useRenderLoopDetector('App'); // at top of component
 *
 * No-ops in production builds (stripped by Vite's dead code elimination).
 */
export function useRenderLoopDetector(componentName: string): void {
  if (import.meta.env.PROD) return; // stripped in production

  const renderCountRef = useRef(0);
  const windowStartRef = useRef(Date.now());

  const now = Date.now();
  if (now - windowStartRef.current > WINDOW_MS) {
    renderCountRef.current = 0;
    windowStartRef.current = now;
  }

  renderCountRef.current++;

  if (renderCountRef.current > THRESHOLD) {
    console.error(
      `[RenderLoopDetector] ${componentName} rendered ${renderCountRef.current} times in ${WINDOW_MS}ms — likely infinite loop!`,
      new Error().stack
    );
  }
}
