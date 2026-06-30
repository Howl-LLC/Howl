// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useRef, useCallback } from 'react';

const LONG_PRESS_MS = 500;
const MOVE_THRESHOLD = 10;

/**
 * Returns touch event handlers that fire `callback` after a long press (~500ms).
 * The synthetic React.MouseEvent passed to the callback uses the touch coordinates,
 * so existing onContextMenu handlers work without changes.
 *
 * Also calls `preventDefault()` on the native `contextmenu` event while a
 * long-press is active to suppress the browser's default context menu.
 */
export function useLongPress(
  callback: ((e: React.MouseEvent) => void) | undefined,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchOriginRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);
  const targetRef = useRef<EventTarget | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    touchOriginRef.current = null;
    firedRef.current = false;
    targetRef.current = null;
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!callback) return;
      const touch = e.touches[0];
      touchOriginRef.current = { x: touch.clientX, y: touch.clientY };
      firedRef.current = false;
      targetRef.current = e.target;

      timerRef.current = setTimeout(() => {
        firedRef.current = true;
        const syntheticEvent = {
          clientX: touch.clientX,
          clientY: touch.clientY,
          pageX: touch.pageX,
          pageY: touch.pageY,
          target: targetRef.current,
          currentTarget: e.currentTarget,
          preventDefault: () => {},
          stopPropagation: () => {},
          nativeEvent: e.nativeEvent,
        } as unknown as React.MouseEvent;
        callback(syntheticEvent);
      }, LONG_PRESS_MS);
    },
    [callback],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!touchOriginRef.current) return;
      const touch = e.touches[0];
      const dx = touch.clientX - touchOriginRef.current.x;
      const dy = touch.clientY - touchOriginRef.current.y;
      if (dx * dx + dy * dy > MOVE_THRESHOLD * MOVE_THRESHOLD) {
        clear();
      }
    },
    [clear],
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (firedRef.current) {
        e.preventDefault();
      }
      clear();
    },
    [clear],
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (firedRef.current) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Stop propagation on the desktop/mouse path too (the touch path above
      // already does): this element owns the context menu, so a nested
      // context-menu element must not also trigger an ancestor's onContextMenu
      // (e.g. right-clicking an author name inside a message row was opening
      // both the user menu and the message menu).
      if (callback) { e.stopPropagation(); callback(e); }
    },
    [callback],
  );

  return { onTouchStart, onTouchMove, onTouchEnd, onContextMenu };
}

/**
 * Non-hook utility for inline context menus (safe inside loops/conditionals).
 * Returns props to spread onto any element:
 *   <button {...longPressBindings((e) => openMenu(e))} />
 *
 * Uses a data-attribute on the element + a module-level Map so it doesn't
 * violate the rules of hooks while still supporting cancel-on-move.
 */
let _lpIdCounter = 0;
const _lpTimers = new Map<number, { timer: ReturnType<typeof setTimeout>; origin: { x: number; y: number }; fired: boolean }>();

export function longPressBindings(
  callback: (e: React.MouseEvent) => void,
): {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
} {
  const id = ++_lpIdCounter;
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const touch = e.touches[0];
      const entry = {
        timer: setTimeout(() => {
          const ent = _lpTimers.get(id);
          if (ent) ent.fired = true;
          callback({
            clientX: touch.clientX,
            clientY: touch.clientY,
            pageX: touch.pageX,
            pageY: touch.pageY,
            target: e.target,
            currentTarget: e.currentTarget,
            preventDefault: () => {},
            stopPropagation: () => {},
            nativeEvent: e.nativeEvent,
          } as unknown as React.MouseEvent);
        }, LONG_PRESS_MS),
        origin: { x: touch.clientX, y: touch.clientY },
        fired: false,
      };
      _lpTimers.set(id, entry);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const entry = _lpTimers.get(id);
      if (!entry) return;
      const touch = e.touches[0];
      const dx = touch.clientX - entry.origin.x;
      const dy = touch.clientY - entry.origin.y;
      if (dx * dx + dy * dy > MOVE_THRESHOLD * MOVE_THRESHOLD) {
        clearTimeout(entry.timer);
        _lpTimers.delete(id);
      }
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const entry = _lpTimers.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        if (entry.fired) e.preventDefault();
        _lpTimers.delete(id);
      }
    },
    onContextMenu: (e: React.MouseEvent) => {
      const entry = _lpTimers.get(id);
      if (entry?.fired) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Stop propagation on the desktop/mouse path too (the touch path above
      // already does): this element owns the context menu, so a nested
      // context-menu element must not also trigger an ancestor's onContextMenu
      // (e.g. right-clicking an author name inside a message row was opening
      // both the user menu and the message menu).
      e.stopPropagation();
      callback(e);
    },
  };
}
