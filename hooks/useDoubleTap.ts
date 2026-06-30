// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useRef, useCallback, useEffect } from 'react';

// Exported Types

export interface UseDoubleTapOptions {
  /** Callback when double-tap is detected */
  onDoubleTap: (e: React.TouchEvent | React.MouseEvent) => void;
  /** Max time between taps in ms. Default: 300 */
  interval?: number;
  /** Max distance between taps in px. Default: 30 */
  maxDistance?: number;
  /** Whether enabled. Default: true */
  enabled?: boolean;
}

// Constants

const DEFAULT_INTERVAL = 300;
const DEFAULT_MAX_DISTANCE = 30;
const SCROLL_MOVE_THRESHOLD = 10;
const MAX_TAP_DURATION = 400;
const TARGET_EXCLUSION =
  'button, a, [role="button"], .msg-action-btn, .reaction-btn';

// Electron detection (cached)

let _isElectron: boolean | null = null;

function checkElectron(): boolean {
  if (_isElectron === null) {
    if (typeof window === 'undefined') {
      _isElectron = false;
    } else {
      const win = window as unknown as Record<string, unknown>;
      _isElectron =
        !!((win.electron as { isElectron?: boolean } | undefined)?.isElectron) || !!win.__ELECTRON_WINDOW__;
    }
  }
  return _isElectron;
}

// Global touch-start tracker
// A single passive capture-phase listener records the most recent
// touchStart position and timestamp. This lets onTouchEnd-only
// handlers detect scroll movement and tap duration without
// returning their own onTouchStart (which would conflict with
// longPressBindings on the same element).

const _lastTouchStart = { x: 0, y: 0, t: 0 };

if (typeof document !== 'undefined') {
  document.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      if (e.touches.length === 1) {
        const touch = e.touches[0];
        _lastTouchStart.x = touch.clientX;
        _lastTouchStart.y = touch.clientY;
        _lastTouchStart.t = e.timeStamp;
      }
    },
    { passive: true, capture: true },
  );
}

// Helpers

function distSq(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return dx * dx + dy * dy;
}

/** Reject taps that were part of a scroll (>10px move) or long-press (>400ms). */
function isValidTap(
  endX: number,
  endY: number,
  endTime: number,
): boolean {
  if (
    distSq(endX, endY, _lastTouchStart.x, _lastTouchStart.y) >
    SCROLL_MOVE_THRESHOLD * SCROLL_MOVE_THRESHOLD
  ) {
    return false;
  }
  if (endTime - _lastTouchStart.t > MAX_TAP_DURATION) {
    return false;
  }
  return true;
}

function isExcludedTarget(target: EventTarget | null): boolean {
  return !!(
    target && (target as HTMLElement).closest?.(TARGET_EXCLUSION)
  );
}

// Hook: useDoubleTap

interface TapState {
  x: number;
  y: number;
  time: number;
  pending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Detects double-tap gestures (touch-only). Returns an `onTouchEnd`
 * handler to spread onto the target element.
 *
 * Uses `onTouchEnd` rather than `onTouchStart` so that scrolls
 * and long-presses are naturally filtered — the finger has already
 * lifted by the time we evaluate the tap.
 */
export function useDoubleTap(options: UseDoubleTapOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const tapRef = useRef<TapState>({
    x: 0,
    y: 0,
    time: 0,
    pending: false,
    timer: null,
  });

  // Clear pending timeout on unmount
  useEffect(() => {
    return () => {
      if (tapRef.current.timer !== null) {
        clearTimeout(tapRef.current.timer);
      }
    };
  }, []);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (checkElectron()) return;

    const opts = optionsRef.current;
    if (opts.enabled === false) return;
    if (isExcludedTarget(e.target)) return;
    if (e.changedTouches.length !== 1) return;

    const touch = e.changedTouches[0];
    const x = touch.clientX;
    const y = touch.clientY;
    const time = e.timeStamp;

    // Reject scrolls and long-presses
    if (!isValidTap(x, y, time)) {
      const tap = tapRef.current;
      if (tap.timer !== null) {
        clearTimeout(tap.timer);
        tap.timer = null;
      }
      tap.pending = false;
      return;
    }

    const interval = opts.interval ?? DEFAULT_INTERVAL;
    const maxDist = opts.maxDistance ?? DEFAULT_MAX_DISTANCE;
    const tap = tapRef.current;

    if (tap.pending) {
      const withinTime = time - tap.time <= interval;
      const withinDist =
        distSq(x, y, tap.x, tap.y) <= maxDist * maxDist;

      if (withinTime && withinDist) {
        // Double-tap committed
        if (tap.timer !== null) {
          clearTimeout(tap.timer);
          tap.timer = null;
        }
        tap.pending = false;

        e.preventDefault(); // suppress ghost click
        navigator.vibrate?.(10);
        opts.onDoubleTap(e);
        return;
      }
    }

    // Record as first tap (or replace a stale one)
    if (tap.timer !== null) clearTimeout(tap.timer);

    tap.x = x;
    tap.y = y;
    tap.time = time;
    tap.pending = true;
    tap.timer = setTimeout(() => {
      tap.pending = false;
      tap.timer = null;
    }, interval);
  }, []);

  return { onTouchEnd };
}

// Non-hook: doubleTapBindings
// Module-level Map keyed by a caller-supplied stable key
// (e.g. message ID) so state survives React re-renders.

interface DtEntry {
  x: number;
  y: number;
  time: number;
  timer: ReturnType<typeof setTimeout>;
}

const _dtState = new Map<string, DtEntry>();

/**
 * Non-hook double-tap utility safe for use inside loops and
 * conditionals. Returns props to spread onto the target element.
 *
 * `key` must be a stable identifier (e.g. `msg.id`) so that
 * first-tap state persists across React re-renders within
 * the detection window.
 *
 * State is stored in a module-level Map keyed by `key`,
 * cleaned up on timeout expiry or double-tap commit.
 */
export function doubleTapBindings(
  callback: (e: React.TouchEvent | React.MouseEvent) => void,
  key: string,
  options?: { interval?: number; maxDistance?: number },
): {
  onTouchEnd: (e: React.TouchEvent) => void;
} {
  return {
    onTouchEnd: (e: React.TouchEvent) => {
      if (checkElectron()) return;
      if (isExcludedTarget(e.target)) return;
      if (e.changedTouches.length !== 1) return;

      const touch = e.changedTouches[0];
      const x = touch.clientX;
      const y = touch.clientY;
      const time = e.timeStamp;

      if (!isValidTap(x, y, time)) {
        const entry = _dtState.get(key);
        if (entry) {
          clearTimeout(entry.timer);
          _dtState.delete(key);
        }
        return;
      }

      const interval = options?.interval ?? DEFAULT_INTERVAL;
      const maxDist = options?.maxDistance ?? DEFAULT_MAX_DISTANCE;
      const entry = _dtState.get(key);

      if (entry) {
        const withinTime = time - entry.time <= interval;
        const withinDist =
          distSq(x, y, entry.x, entry.y) <= maxDist * maxDist;

        if (withinTime && withinDist) {
          // Double-tap committed
          clearTimeout(entry.timer);
          _dtState.delete(key);

          e.preventDefault();
          navigator.vibrate?.(10);
          callback(e);
          return;
        }

        // Stale or too far — clear and fall through to new first tap
        clearTimeout(entry.timer);
        _dtState.delete(key);
      }

      // Record as first tap
      _dtState.set(key, {
        x,
        y,
        time,
        timer: setTimeout(() => {
          _dtState.delete(key);
        }, interval),
      });
    },
  };
}
