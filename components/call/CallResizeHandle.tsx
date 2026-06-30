// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback, useEffect, useRef } from 'react';

const STORAGE_KEY = 'howl:dmCallHeight';
const MIN_HEIGHT = 200;
/** Cap so the chat area below always keeps ~200px of breathing room. */
const getMaxHeight = () => Math.max(MIN_HEIGHT, window.innerHeight - 200);

export function readStoredCallHeight(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}

interface CallResizeHandleProps {
  currentHeight: number;
  onResize: (height: number) => void;
}

/**
 * Vertical drag handle at the bottom edge of the inline DM call area.
 * Mirrors the sidebar resize pattern in NotificationCenterView (width → height,
 * col-resize → row-resize) and persists the chosen height to localStorage.
 */
export const CallResizeHandle = React.memo(function CallResizeHandle({
  currentHeight,
  onResize,
}: CallResizeHandleProps) {
  const isResizing = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);
  const latestHeight = useRef(currentHeight);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    startY.current = e.clientY;
    startHeight.current = currentHeight;
    latestHeight.current = currentHeight;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [currentHeight]);

  const stopResizing = useCallback(() => {
    if (!isResizing.current) return;
    isResizing.current = false;
    document.body.style.cursor = 'default';
    document.body.style.userSelect = 'auto';
    try {
      window.localStorage.setItem(STORAGE_KEY, String(Math.round(latestHeight.current)));
    } catch {
      /* quota / disabled storage — drop silently */
    }
  }, []);

  const resize = useCallback((e: MouseEvent) => {
    if (!isResizing.current) return;
    const delta = e.clientY - startY.current;
    const next = Math.min(Math.max(startHeight.current + delta, MIN_HEIGHT), getMaxHeight());
    latestHeight.current = next;
    onResize(next);
  }, [onResize]);

  useEffect(() => {
    window.addEventListener('mousemove', resize);
    window.addEventListener('mouseup', stopResizing);
    return () => {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stopResizing);
    };
  }, [resize, stopResizing]);

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize call area"
      onMouseDown={startResizing}
      className="absolute bottom-0 left-0 right-0 h-2.5 cursor-row-resize group z-30"
    >
      {/* Full-width baseline separator. */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-[var(--border-subtle)] group-hover:bg-[var(--fill-stronger)] transition-colors" />
      {/* Centered grab pill — visible affordance so the handle is
          discoverable. Brightens on hover / active drag. */}
      <div className="absolute left-1/2 bottom-[3px] -translate-x-1/2 h-1 w-12 rounded-full bg-[var(--fill-active)] group-hover:bg-[var(--fill-stronger)] group-active:bg-[var(--cyan-accent)] transition-colors" />
    </div>
  );
});
