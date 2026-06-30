// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Shared "liquid glass" styling and position helper for all right-click / context menus
 * so they match the server name dropdown and stay on screen.
 */

import React, { type CSSProperties, useRef, useState, useLayoutEffect } from 'react';

const PADDING = 8;

/** Inline style for the glass menu container (add left, top yourself). */
export const GLASS_MENU_STYLE: CSSProperties = {
  backgroundColor: 'var(--glass-bg, rgba(10, 15, 30, 0.72))',
  borderColor: 'var(--glass-border)',
  boxShadow: 'var(--glass-shadow)',
  backdropFilter: 'blur(20px) saturate(1.3)',
  WebkitBackdropFilter: 'blur(20px) saturate(1.3)',
};

/**
 * Inline style for dropdowns — same as glass menu for a consistent look.
 */
export const GLASS_DROPDOWN_STYLE: CSSProperties = {
  ...GLASS_MENU_STYLE,
};

/** Tailwind class for glass menu (rounded-2xl, border, etc.). */
export const GLASS_MENU_CLASS =
  'rounded-2xl border shadow-2xl animate-in fade-in zoom-in-[0.97] duration-150 backdrop-blur-xl';

/** Glass utility class — use instead of GLASS_MENU_STYLE inline object.
 *  Combines with GLASS_MENU_CLASS for a complete glass menu: `glass ${GLASS_MENU_CLASS}` */
export const GLASS_UTILITY_CLASS = 'glass';

/** @deprecated Use GLASS_MENU_STYLE */
export const LIQUID_GLASS_MENU_STYLE = GLASS_MENU_STYLE;
/** @deprecated Use GLASS_MENU_CLASS */
export const LIQUID_GLASS_MENU_CLASS = GLASS_MENU_CLASS;

/**
 * Clamp a context menu within the viewport given known dimensions.
 */
function clampToViewport(
  x: number,
  y: number,
  width: number,
  height: number
): { left: number; top: number } {
  let left = x;
  let top = y;
  const maxH = window.innerHeight - PADDING;
  const maxW = window.innerWidth - PADDING;

  if (left + width > maxW) left = maxW - width;
  if (left < PADDING) left = PADDING;
  if (top + height > maxH) top = maxH - height;
  if (top < PADDING) top = PADDING;
  return { left, top };
}

/**
 * Compute left/top so the context menu stays within the viewport.
 * Use when menu is fixed and you have estimated width/height.
 */
export function getContextMenuPosition(
  x: number,
  y: number,
  estWidth: number,
  estHeight: number
): { left: number; top: number } {
  return clampToViewport(x, y, estWidth, estHeight);
}

/** Default estimated size for user/DM/group context menus. */
export const CONTEXT_MENU_EST_WIDTH = 240;
export const CONTEXT_MENU_EST_HEIGHT = 600;

/**
 * Hook that measures the actual menu DOM after mount and repositions to stay in viewport.
 * Uses scrollWidth/scrollHeight which are immune to CSS transform animations.
 * Also caps maxHeight and makes the menu scrollable if it's taller than the viewport.
 */
export function useContextMenuPosition(x: number, y: number, estWidth = CONTEXT_MENU_EST_WIDTH, estHeight = CONTEXT_MENU_EST_HEIGHT, bottomSafeArea = 0) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => clampToViewport(x, y, estWidth, estHeight));
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);

  // Synchronous layout pass — measure with scrollWidth/scrollHeight (immune to CSS transforms)
  useLayoutEffect(() => {
    const reposition = () => {
      const el = menuRef.current;
      const w = el ? Math.max(el.scrollWidth, el.offsetWidth) || estWidth : estWidth;
      const h = el ? Math.max(el.scrollHeight, el.offsetHeight) || estHeight : estHeight;
      const availableHeight = window.innerHeight - PADDING * 2 - bottomSafeArea;
      const clamped = clampToViewport(x, y, w, Math.min(h, availableHeight));
      if (h > availableHeight) {
        setMaxHeight(availableHeight);
        clamped.top = PADDING;
      } else {
        setMaxHeight(undefined);
      }
      // Enforce tighter bottom bound from safe area
      const maxTop = window.innerHeight - Math.min(h, availableHeight) - PADDING - bottomSafeArea;
      if (clamped.top > maxTop) clamped.top = Math.max(PADDING, maxTop);
      setPos(clamped);
    };

    reposition();

    // Re-measure after an animation frame in case the initial measurement
    // happened before the browser finished computing layout sizes.
    const id = requestAnimationFrame(reposition);
    return () => cancelAnimationFrame(id);
  }, [x, y, estWidth, estHeight, bottomSafeArea]);

  const maxWidth = typeof window !== 'undefined' ? window.innerWidth - PADDING * 2 : undefined;
  const style: CSSProperties = {
    left: pos.left,
    top: pos.top,
    ...(maxHeight ? { maxHeight, overflowY: 'auto' as const } : {}),
    ...(maxWidth ? { maxWidth } : {}),
  };

  return { menuRef, style };
}

/**
 * Wrapper component for context menus rendered inside createPortal / conditional blocks
 * where hooks can't be used directly. Measures actual DOM and repositions.
 * Supports ref forwarding so callers can use the DOM node for outside-click detection.
 */
export const ContextMenuContainer = React.forwardRef<
  HTMLDivElement,
  {
    x: number;
    y: number;
    estWidth?: number;
    estHeight?: number;
    className?: string;
    style?: CSSProperties;
    children: React.ReactNode;
  } & Omit<React.HTMLAttributes<HTMLDivElement>, 'style'>
>(({ x, y, estWidth = CONTEXT_MENU_EST_WIDTH, estHeight = CONTEXT_MENU_EST_HEIGHT, className, style: extraStyle, children, ...rest }, forwardedRef) => {
  const { menuRef, style: posStyle } = useContextMenuPosition(x, y, estWidth, estHeight);

  const combinedRef = (el: HTMLDivElement | null) => {
    (menuRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    if (typeof forwardedRef === 'function') forwardedRef(el);
    else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
  };

  return (
    <div ref={combinedRef} className={className} style={{ ...extraStyle, ...posStyle }} {...rest}>
      {children}
    </div>
  );
});

const GAP = 4;

/**
 * Position a submenu to the right of a trigger rect, clamped to viewport.
 * Use for Mute Server / Notification Settings dropdowns so they match the main menu.
 */
export function getSubmenuPosition(
  triggerRect: DOMRect,
  submenuWidth: number,
  submenuHeight: number
): { left: number; top: number } {
  return getContextMenuPosition(triggerRect.right + GAP, triggerRect.top, submenuWidth, submenuHeight);
}
