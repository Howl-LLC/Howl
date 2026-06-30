// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Draggable PIP position hook.
 *
 * Design:
 *  - Position is stored in a ref and applied via `transform: translate3d(...)`
 *    directly on the DOM node inside `requestAnimationFrame`. There are NO
 *    React state updates during drag, so the PIP tree never re-renders while
 *    the user moves. This is the fast path Discord uses for its mini player.
 *  - During drag the position is clamped so the PIP can never leave the
 *    viewport. Clamp reads `window.innerWidth`/`innerHeight` every frame so
 *    resizes mid-drag don't strand the PIP.
 *  - On pointer-up, we snap to the nearest of four corners. CSS transition on
 *    `transform` handles the animation.
 *  - Pointer capture keeps drag alive even if the pointer moves over iframes
 *    or child elements that would otherwise eat events.
 *  - Corner selection persists to sessionStorage.
 */

type Corner = 'tl' | 'tr' | 'bl' | 'br';

const STORAGE_KEY = 'howl_pip_corner';
const SAFE_INSET = 16;
const CORNERS: readonly Corner[] = ['tl', 'tr', 'bl', 'br'];
// Ease-out-back curve with ~10% overshoot — matches Discord's springy mini-
// player snap. CSS transition stays GPU-accelerated (no rAF / spring loop),
// so this is effectively free at runtime.
const SNAP_TRANSITION = 'transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1)';

interface Params { width: number; height: number }

interface Result {
  /** Attach to the PIP root element. */
  ref: React.RefCallback<HTMLDivElement>;
  /** Base inline style — position/size/z-index. Transform is applied directly to the DOM. */
  style: React.CSSProperties;
  /** Whether a drag is in progress (consumer may want to hide chrome during). */
  isDragging: boolean;
  /** Begin drag on pointer-down. */
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
}

function cornerPosition(c: Corner, width: number, height: number): { x: number; y: number } {
  const W = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const H = typeof window !== 'undefined' ? window.innerHeight : 768;
  switch (c) {
    case 'tl': return { x: SAFE_INSET, y: SAFE_INSET };
    case 'tr': return { x: W - width - SAFE_INSET, y: SAFE_INSET };
    case 'bl': return { x: SAFE_INSET, y: H - height - SAFE_INSET };
    case 'br': return { x: W - width - SAFE_INSET, y: H - height - SAFE_INSET };
  }
}

function nearestCorner(x: number, y: number, width: number, height: number): Corner {
  const W = window.innerWidth, H = window.innerHeight;
  // Use the center of the PIP rather than its top-left so the snap matches
  // which quadrant the user dragged toward.
  const cx = x + width / 2;
  const cy = y + height / 2;
  const isLeft = cx < W / 2;
  const isTop = cy < H / 2;
  return (isTop ? (isLeft ? 'tl' : 'tr') : (isLeft ? 'bl' : 'br')) as Corner;
}

/** Clamp top-left so a box of [width, height] stays inside viewport (with inset). */
function clampToViewport(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const maxX = window.innerWidth - width - SAFE_INSET;
  const maxY = window.innerHeight - height - SAFE_INSET;
  return {
    x: Math.max(SAFE_INSET, Math.min(x, maxX)),
    y: Math.max(SAFE_INSET, Math.min(y, maxY)),
  };
}

export function usePipPosition({ width, height }: Params): Result {
  const elRef = useRef<HTMLDivElement | null>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const pendingPosRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const [corner, setCorner] = useState<Corner>(() => {
    const stored = typeof window !== 'undefined' ? sessionStorage.getItem(STORAGE_KEY) : null;
    return (stored && (CORNERS as readonly string[]).includes(stored) ? stored : 'br') as Corner;
  });
  const [isDragging, setIsDragging] = useState(false);

  // Write transform directly to the DOM — bypasses React render.
  const applyTransform = useCallback((x: number, y: number) => {
    const el = elRef.current;
    if (!el) return;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }, []);

  // Snap to a corner with a spring-eased CSS transition. Safe to call
  // any time — enables the transition, sets the transform, then leaves
  // the transition active so future layout changes (e.g. resize) also
  // animate gently. Clears will-change after to release compositor memory.
  const snapToCorner = useCallback((c: Corner) => {
    const el = elRef.current;
    if (!el) return;
    const target = cornerPosition(c, width, height);
    posRef.current = target;
    el.style.transition = SNAP_TRANSITION;
    el.style.willChange = 'transform';
    applyTransform(target.x, target.y);
    const onEnd = () => {
      if (el) el.style.willChange = '';
      el.removeEventListener('transitionend', onEnd);
    };
    el.addEventListener('transitionend', onEnd);
  }, [width, height, applyTransform]);

  // Position the element at the stored corner on initial mount and whenever
  // dimensions or the corner selection change (without an active drag).
  const syncToCorner = useCallback(() => {
    if (dragOffsetRef.current) return; // don't fight an active drag
    snapToCorner(corner);
  }, [corner, snapToCorner]);

  const ref: React.RefCallback<HTMLDivElement> = useCallback((el) => {
    elRef.current = el;
    if (el) {
      const target = cornerPosition(corner, width, height);
      posRef.current = target;
      // Initial placement without animation — avoids a fly-in on first mount.
      el.style.transition = 'none';
      applyTransform(target.x, target.y);
      // Force layout so the next transform change animates rather than jumping.
      // Reading offsetHeight is a cheap flush.
      void el.offsetHeight;
      el.style.transition = SNAP_TRANSITION;
    }
  }, [corner, width, height, applyTransform]);

  // Persist corner and re-snap when it changes.
  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, corner); } catch { /* sessionStorage unavailable */ }
    syncToCorner();
  }, [corner, syncToCorner]);

  // Resize handler: re-snap to the current corner using the new viewport dims.
  // Skip while dragging — the drag clamp handles mid-drag resizes naturally.
  useEffect(() => {
    const onResize = () => {
      if (!dragOffsetRef.current) syncToCorner();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [syncToCorner]);

  // Also re-snap when the PIP dimensions change (e.g. desktop <-> mobile size).
  useEffect(() => {
    syncToCorner();
  }, [width, height, syncToCorner]);

  // Drag lifecycle
  // Pointer-move/up handlers live on window so the drag survives the pointer
  // leaving the PIP rectangle. Pointer capture on the element doubles up for
  // iframe/overlay safety.

  const scheduleFrame = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const next = pendingPosRef.current;
      if (!next) return;
      const clamped = clampToViewport(next.x, next.y, width, height);
      posRef.current = clamped;
      applyTransform(clamped.x, clamped.y);
    });
  }, [width, height, applyTransform]);

  const onPointerMoveWin = useCallback((e: PointerEvent) => {
    if (!dragOffsetRef.current) return;
    pendingPosRef.current = {
      x: e.clientX - dragOffsetRef.current.dx,
      y: e.clientY - dragOffsetRef.current.dy,
    };
    scheduleFrame();
  }, [scheduleFrame]);

  const onPointerUpWin = useCallback(() => {
    // Prefer the latest pending pointer position over posRef — on very fast
    // drags, pointerup can fire before the next RAF commits pendingPosRef
    // into posRef, which would otherwise snap based on the stale starting
    // position rather than wherever the user actually released.
    const end = pendingPosRef.current ?? posRef.current;
    dragOffsetRef.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingPosRef.current = null;
    window.removeEventListener('pointermove', onPointerMoveWin);
    window.removeEventListener('pointerup', onPointerUpWin);
    window.removeEventListener('pointercancel', onPointerUpWin);
    setIsDragging(false);
    if (end) {
      const clamped = clampToViewport(end.x, end.y, width, height);
      const c = nearestCorner(clamped.x, clamped.y, width, height);
      // setCorner triggers the useEffect which calls syncToCorner -> snapToCorner.
      // If the corner didn't change, syncToCorner still runs on first render of
      // the callback, so call snapToCorner directly to animate to the snapped
      // position (otherwise the PIP would stay where the user let go).
      if (c === corner) snapToCorner(c);
      else setCorner(c);
    }
  }, [onPointerMoveWin, width, height, corner, snapToCorner]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore non-primary buttons and modifier clicks (drop onto this target
    // semantics may be added later).
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const el = elRef.current;
    if (!el) return;
    const start = posRef.current ?? cornerPosition(corner, width, height);
    dragOffsetRef.current = { dx: e.clientX - start.x, dy: e.clientY - start.y };
    pendingPosRef.current = start;
    try { el.setPointerCapture(e.pointerId); } catch { /* pointer already captured */ }
    // Disable snap transition during drag — we want immediate response.
    el.style.transition = 'none';
    el.style.willChange = 'transform';
    setIsDragging(true);
    window.addEventListener('pointermove', onPointerMoveWin, { passive: true });
    window.addEventListener('pointerup', onPointerUpWin);
    window.addEventListener('pointercancel', onPointerUpWin);
  }, [corner, width, height, onPointerMoveWin, onPointerUpWin]);

  // Cleanup on unmount: remove any lingering window listeners if the PIP
  // unmounted mid-drag (e.g. user ended the call while dragging).
  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('pointermove', onPointerMoveWin);
      window.removeEventListener('pointerup', onPointerUpWin);
      window.removeEventListener('pointercancel', onPointerUpWin);
    };
  }, [onPointerMoveWin, onPointerUpWin]);

  const style: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    width,
    height,
    zIndex: 'var(--z-pip)' as unknown as number,
    touchAction: 'none',
    // Permanently promote to its own compositor layer. Dragging and chat
    // message mutations don't trigger paints of surrounding content, and
    // the browser keeps the element GPU-accelerated between drags. Small
    // memory cost (~1 extra tile buffer); big perceived smoothness win.
    willChange: 'transform',
    // Isolate layout / style / paint within the PIP subtree so nothing
    // inside the PIP can invalidate the rest of the app (and vice versa).
    // This is what gives Discord's mini-player its "never stutters" feel.
    contain: 'layout style paint',
  };

  return { ref, style, isDragging, onPointerDown };
}
