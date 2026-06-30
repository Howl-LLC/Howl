// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useRef, useCallback, useMemo } from 'react';

// Exported Types

export interface UseSwipeGestureOptions {
  /** Direction(s) to detect. Default: 'horizontal' */
  direction?: 'left' | 'right' | 'horizontal' | 'vertical' | 'both';
  /** Distance threshold (px) to commit. Default: 80 */
  threshold?: number;
  /** Velocity (px/ms) that auto-commits regardless of distance. Default: 0.5 */
  velocityThreshold?: number;
  /** Callback when swipe commits */
  onSwipe?: (dir: 'left' | 'right' | 'up' | 'down') => void;
  /** Callback during drag with current offset. Use for transform tracking. */
  onDrag?: (dx: number, dy: number) => void;
  /** Callback when drag ends without committing (snap back) */
  onCancel?: () => void;
  /** Whether the gesture is enabled. Default: true */
  enabled?: boolean;
  /**
   * If set, only activate when touch starts within this many px of the
   * relevant edge (e.g., edgeThreshold=30 + direction='right' → left 30px).
   * Default: undefined (trigger from anywhere)
   */
  edgeThreshold?: number;
  /** Max cross-axis movement (px) before gesture is cancelled. Default: 50 */
  maxCrossAxis?: number;
  /** When true (keyboard visible), don't start new gestures. */
  keyboardOpen?: boolean;
}

export interface SwipeState {
  /** Current horizontal offset during drag */
  dx: number;
  /** Current vertical offset during drag */
  dy: number;
  /** Whether a swipe is currently in progress */
  swiping: boolean;
  /** Direction the user is swiping, set after axis lock */
  direction: 'left' | 'right' | 'up' | 'down' | null;
}

// Internal Types

interface VelocityEntry {
  x: number;
  y: number;
  t: number;
}

interface TrackingState {
  active: boolean;
  startX: number;
  startY: number;
  axisLocked: boolean;
  lockedAxis: 'horizontal' | 'vertical' | null;
  velocityHistory: VelocityEntry[];
  velocityIndex: number;
  velocityCount: number;
  reducedMotion: boolean;
}

type SwipeDirection = 'left' | 'right' | 'up' | 'down';
type ConfigDirection = NonNullable<UseSwipeGestureOptions['direction']>;

// Constants

const AXIS_LOCK_THRESHOLD = 8;
const VELOCITY_HISTORY_SIZE = 4;
const VELOCITY_WINDOW_MS = 100;
const INPUT_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

// Electron detection (cached at module level)

let _isElectron: boolean | null = null;

function checkElectron(): boolean {
  if (_isElectron === null) {
    if (typeof window === 'undefined') {
      _isElectron = false;
    } else {
      const win = window as unknown as Record<string, unknown>;
      _isElectron = !!((win.electron as { isElectron?: boolean } | undefined)?.isElectron) || !!win.__ELECTRON_WINDOW__;
    }
  }
  return _isElectron;
}

// Helpers (pure, zero-allocation)

function isHorizontalConfig(dir: ConfigDirection): boolean {
  return dir === 'left' || dir === 'right' || dir === 'horizontal';
}

function isVerticalConfig(dir: ConfigDirection): boolean {
  return dir === 'vertical';
}

function getSwipeDirection(
  dx: number,
  dy: number,
  axis: 'horizontal' | 'vertical',
): SwipeDirection {
  return axis === 'horizontal'
    ? (dx > 0 ? 'right' : 'left')
    : (dy > 0 ? 'down' : 'up');
}

function isDirectionAllowed(
  swipeDir: SwipeDirection,
  allowed: ConfigDirection,
): boolean {
  switch (allowed) {
    case 'left': return swipeDir === 'left';
    case 'right': return swipeDir === 'right';
    case 'horizontal': return swipeDir === 'left' || swipeDir === 'right';
    case 'vertical': return swipeDir === 'up' || swipeDir === 'down';
    case 'both': return true;
  }
}

function isWithinEdge(
  touchX: number,
  touchY: number,
  rect: DOMRect,
  direction: ConfigDirection,
  edge: number,
): boolean {
  switch (direction) {
    case 'right':
      return touchX - rect.left <= edge;
    case 'left':
      return rect.right - touchX <= edge;
    case 'horizontal':
      return touchX - rect.left <= edge || rect.right - touchX <= edge;
    case 'vertical':
      return touchY - rect.top <= edge || rect.bottom - touchY <= edge;
    case 'both':
      return (
        touchX - rect.left <= edge ||
        rect.right - touchX <= edge ||
        touchY - rect.top <= edge ||
        rect.bottom - touchY <= edge
      );
  }
}

/** Returns true when velocity vector points the same way as `dir`. */
function isVelocityAligned(dir: SwipeDirection, v: number): boolean {
  return dir === 'right' || dir === 'down' ? v > 0 : v < 0;
}

/**
 * Computes signed velocity (px/ms) from the circular buffer over the last
 * VELOCITY_WINDOW_MS. Positive = right/down, negative = left/up.
 */
function computeVelocity(
  history: VelocityEntry[],
  count: number,
  nextIndex: number,
  now: number,
  axis: 'horizontal' | 'vertical',
): number {
  if (count < 2) return 0;

  const size = Math.min(count, VELOCITY_HISTORY_SIZE);
  let oldest: VelocityEntry | null = null;
  let newest: VelocityEntry | null = null;

  // Walk backwards from the most-recent entry
  for (let i = 0; i < size; i++) {
    const idx =
      (nextIndex - 1 - i + VELOCITY_HISTORY_SIZE) % VELOCITY_HISTORY_SIZE;
    const entry = history[idx];
    if (now - entry.t > VELOCITY_WINDOW_MS) break;
    if (!newest) newest = entry;
    oldest = entry;
  }

  if (!oldest || !newest || oldest === newest) return 0;

  const dt = newest.t - oldest.t;
  if (dt <= 0) return 0;

  return axis === 'horizontal'
    ? (newest.x - oldest.x) / dt
    : (newest.y - oldest.y) / dt;
}

// Hook

export function useSwipeGesture(options: UseSwipeGestureOptions) {
  // Latest options always available without stale closures
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const stateRef = useRef<SwipeState>({
    dx: 0,
    dy: 0,
    swiping: false,
    direction: null,
  });

  const trackingRef = useRef<TrackingState>({
    active: false,
    startX: 0,
    startY: 0,
    axisLocked: false,
    lockedAxis: null,
    velocityHistory: Array.from({ length: VELOCITY_HISTORY_SIZE }, () => ({
      x: 0,
      y: 0,
      t: 0,
    })),
    velocityIndex: 0,
    velocityCount: 0,
    reducedMotion: false,
  });

  const resetTracking = useCallback(() => {
    const t = trackingRef.current;
    t.active = false;
    t.axisLocked = false;
    t.lockedAxis = null;
    t.velocityIndex = 0;
    t.velocityCount = 0;

    const s = stateRef.current;
    s.dx = 0;
    s.dy = 0;
    s.swiping = false;
    s.direction = null;
  }, []);

  // touchStart

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (checkElectron()) return;

      const opts = optionsRef.current;
      if (opts.enabled === false) return;
      if (opts.keyboardOpen) return;

      // Multi-touch while gesture active → cancel
      if (e.touches.length > 1) {
        if (trackingRef.current.active) {
          resetTracking();
          opts.onCancel?.();
        }
        return;
      }

      // Don't capture gestures on form elements
      if ((e.target as HTMLElement).closest?.(INPUT_SELECTOR)) return;

      const touch = e.touches[0];
      const direction = opts.direction ?? 'horizontal';

      // Edge-zone gating
      if (opts.edgeThreshold != null) {
        const rect = e.currentTarget.getBoundingClientRect();
        if (
          !isWithinEdge(
            touch.clientX,
            touch.clientY,
            rect,
            direction,
            opts.edgeThreshold,
          )
        ) {
          return;
        }
      }

      // Re-entrancy: cancel any still-active gesture before starting a new one
      const t = trackingRef.current;
      if (t.active && stateRef.current.swiping) {
        opts.onCancel?.();
      }

      // Start tracking
      t.active = true;
      t.startX = touch.clientX;
      t.startY = touch.clientY;
      t.axisLocked = false;
      t.lockedAxis = null;
      t.velocityIndex = 0;
      t.velocityCount = 0;
      t.reducedMotion = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches;

      // Seed velocity buffer with the start position
      const entry = t.velocityHistory[0];
      entry.x = touch.clientX;
      entry.y = touch.clientY;
      entry.t = e.timeStamp;
      t.velocityIndex = 1;
      t.velocityCount = 1;

      const s = stateRef.current;
      s.dx = 0;
      s.dy = 0;
      s.swiping = false;
      s.direction = null;
    },
    [resetTracking],
  );

  // touchMove

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (checkElectron()) return;

      const t = trackingRef.current;
      if (!t.active) return;

      // Multi-touch → cancel
      if (e.touches.length > 1) {
        const wasSwiping = stateRef.current.swiping;
        resetTracking();
        if (wasSwiping) optionsRef.current.onCancel?.();
        return;
      }

      const touch = e.touches[0];
      const rawDx = touch.clientX - t.startX;
      const rawDy = touch.clientY - t.startY;
      const opts = optionsRef.current;
      const direction = opts.direction ?? 'horizontal';
      const maxCrossAxis = opts.maxCrossAxis ?? 50;

      // Record velocity — mutate existing entry (zero allocation)
      const vEntry = t.velocityHistory[t.velocityIndex];
      vEntry.x = touch.clientX;
      vEntry.y = touch.clientY;
      vEntry.t = e.timeStamp;
      t.velocityIndex = (t.velocityIndex + 1) % VELOCITY_HISTORY_SIZE;
      if (t.velocityCount < VELOCITY_HISTORY_SIZE) t.velocityCount++;

      // Axis locking (8 px dead-zone)
      if (!t.axisLocked) {
        const absDx = Math.abs(rawDx);
        const absDy = Math.abs(rawDy);

        if (absDx < AXIS_LOCK_THRESHOLD && absDy < AXIS_LOCK_THRESHOLD) {
          return; // still inside dead-zone
        }

        t.axisLocked = true;

        if (absDx >= absDy) {
          t.lockedAxis = 'horizontal';
          // Wanted vertical-only → release so scroll can happen
          if (isVerticalConfig(direction)) {
            resetTracking();
            return;
          }
        } else {
          t.lockedAxis = 'vertical';
          // Wanted horizontal-only → release
          if (isHorizontalConfig(direction)) {
            resetTracking();
            return;
          }
        }
      }

      // Prevent browser scroll only on the axis we own
      if (
        (t.lockedAxis === 'horizontal' &&
          (isHorizontalConfig(direction) || direction === 'both')) ||
        (t.lockedAxis === 'vertical' &&
          (isVerticalConfig(direction) || direction === 'both'))
      ) {
        e.preventDefault();
      }

      // Cross-axis exceeded → cancel
      if (
        t.lockedAxis === 'horizontal' &&
        Math.abs(rawDy) > maxCrossAxis
      ) {
        resetTracking();
        opts.onCancel?.();
        return;
      }
      if (
        t.lockedAxis === 'vertical' &&
        Math.abs(rawDx) > maxCrossAxis
      ) {
        resetTracking();
        opts.onCancel?.();
        return;
      }

      // Direction clamping (inline — no allocation)
      let dx = rawDx;
      const dy = rawDy;
      if (direction === 'right' && dx < 0) dx = 0;
      else if (direction === 'left' && dx > 0) dx = 0;

      // Update exposed state ref
      const s = stateRef.current;
      s.dx = dx;
      s.dy = dy;
      s.swiping = true;

      const primary = t.lockedAxis === 'horizontal' ? dx : dy;
      s.direction =
        primary !== 0 ? getSwipeDirection(dx, dy, t.lockedAxis!) : null;

      // Reduced-motion: skip intermediate drags; consumer gets one final call
      if (!t.reducedMotion) {
        opts.onDrag?.(dx, dy);
      }
    },
    [resetTracking],
  );

  // touchEnd

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (checkElectron()) return;

      const t = trackingRef.current;
      if (!t.active) return;

      // Remaining fingers → cancel
      if (e.touches.length > 0) {
        const wasSwiping = stateRef.current.swiping;
        resetTracking();
        if (wasSwiping) optionsRef.current.onCancel?.();
        return;
      }

      const s = stateRef.current;
      const opts = optionsRef.current;
      const direction = opts.direction ?? 'horizontal';
      const threshold = opts.threshold ?? 80;
      const velocityThreshold = opts.velocityThreshold ?? 0.5;

      // Never axis-locked → not a meaningful gesture
      if (!t.axisLocked || !t.lockedAxis) {
        resetTracking();
        return;
      }

      // Determine actual swipe direction from raw end position
      const changedTouch = e.changedTouches[0];
      const rawEndDx = changedTouch.clientX - t.startX;
      const rawEndDy = changedTouch.clientY - t.startY;
      const swipeDir = getSwipeDirection(rawEndDx, rawEndDy, t.lockedAxis);

      // Direction not allowed by config → cancel
      if (!isDirectionAllowed(swipeDir, direction)) {
        if (s.swiping) opts.onCancel?.();
        resetTracking();
        return;
      }

      // Distance uses clamped values (identical to raw for allowed direction)
      const distance =
        t.lockedAxis === 'horizontal' ? Math.abs(s.dx) : Math.abs(s.dy);
      const distanceMet = distance >= threshold;

      // Velocity: signed, must also point in the swipe direction
      const velocity = computeVelocity(
        t.velocityHistory,
        t.velocityCount,
        t.velocityIndex,
        e.timeStamp,
        t.lockedAxis,
      );
      const velocityMet =
        Math.abs(velocity) >= velocityThreshold &&
        isVelocityAligned(swipeDir, velocity);

      if (distanceMet || velocityMet) {
        // Commit
        if (t.reducedMotion) opts.onDrag?.(s.dx, s.dy);
        opts.onSwipe?.(swipeDir);
      } else if (s.swiping) {
        // Below threshold → snap back
        if (t.reducedMotion) opts.onDrag?.(0, 0);
        opts.onCancel?.();
      }

      resetTracking();
    },
    [resetTracking],
  );

  const bind = useMemo(
    () => ({ onTouchStart, onTouchMove, onTouchEnd }),
    [onTouchStart, onTouchMove, onTouchEnd],
  );

  return { bind, state: stateRef };
}
