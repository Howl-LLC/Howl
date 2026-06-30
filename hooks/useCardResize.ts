// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useRef, useEffect, useCallback } from 'react';

const CARD_MIN_W = 180;
const CARD_MIN_H = 120;
const CARD_MAX_W = 600;
const CARD_MAX_H = 400;

interface UseCardResizeOptions {
  participantCount: number;
  isMobile?: boolean;
  /** When true, use tablet-sized stretched-width cards (grid-cols-2 layout). */
  isTablet?: boolean;
  onSizeChange?: (sizes: Record<string, { w: number; h: number }>) => void;
  initialSizes?: Record<string, { w: number; h: number }>;
}

interface UseCardResizeReturn {
  cardSizes: Record<string, { w: number; h: number }>;
  getCardSize: (key: string) => { w: number; h: number };
  startResize: (key: string, e: React.MouseEvent) => void;
  draggingCardRef: React.MutableRefObject<{ key: string; w: number; h: number } | null>;
  CARD_MIN_W: number;
  CARD_MIN_H: number;
  CARD_MAX_W: number;
  CARD_MAX_H: number;
}

/**
 * Manages resizable participant cards for voice/DM call views.
 * Handles mouse drag to resize cards within min/max bounds.
 */
export function useCardResize({ participantCount, isMobile = false, isTablet = false, onSizeChange, initialSizes }: UseCardResizeOptions): UseCardResizeReturn {
  const [cardSizes, setCardSizes] = useState<Record<string, { w: number; h: number }>>(initialSizes ?? {});
  const draggingCardRef = useRef<{ key: string; w: number; h: number } | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  // Tablet gets stretched-width cards too (grid-cols-2 layout) but taller than mobile.
  const stretchWidth = isMobile || isTablet;

  const getDefaultCardSize = useCallback(() => {
    if (isMobile) {
      // Single-column grid on mobile — each card takes ~full viewport width,
      // so give them generous height to keep banner + footer legible.
      if (participantCount <= 2) return { w: 9999, h: 240 };
      if (participantCount <= 4) return { w: 9999, h: 200 };
      return { w: 9999, h: 170 };
    }
    if (isTablet) {
      // Two-column grid on tablet.
      if (participantCount <= 2) return { w: 9999, h: 280 };
      if (participantCount <= 4) return { w: 9999, h: 220 };
      return { w: 9999, h: 180 };
    }
    if (participantCount <= 2) return { w: 440, h: 300 };
    if (participantCount <= 4) return { w: 340, h: 240 };
    if (participantCount <= 6) return { w: 260, h: 190 };
    return { w: Math.max(CARD_MIN_W, 220), h: Math.max(CARD_MIN_H, 160) };
  }, [participantCount, isMobile, isTablet]);

  const getCardSize = useCallback((key: string) => {
    const defaultSize = getDefaultCardSize();
    if (stretchWidth) return { w: defaultSize.w, h: defaultSize.h };
    const drag = draggingCardRef.current;
    if (drag && drag.key === key) return { w: drag.w, h: drag.h };
    const s = cardSizes[key];
    return { w: s?.w ?? defaultSize.w, h: s?.h ?? defaultSize.h };
  }, [cardSizes, getDefaultCardSize, stretchWidth]);

  const startResize = useCallback((key: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (draggingCardRef.current) return;
    const size = getCardSize(key);
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = size.w;
    const startH = size.h;
    draggingCardRef.current = { key, w: startW, h: startH };

    // Disable transition during drag for smoother resizing
    const cardEl = (e.currentTarget as HTMLElement).closest('[data-card-resize-wrapper]') as HTMLElement | null;
    if (cardEl) cardEl.style.transition = 'none';

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const newW = Math.max(CARD_MIN_W, Math.min(CARD_MAX_W, startW + dx));
      const newH = Math.max(CARD_MIN_H, Math.min(CARD_MAX_H, startH + dy));
      draggingCardRef.current = { key, w: newW, h: newH };
      if (cardEl) {
        cardEl.style.width = `${newW}px`;
        cardEl.style.height = `${newH}px`;
      }
      setCardSizes((prev) => ({ ...prev, [key]: { w: newW, h: newH } }));
    };

    const cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', cleanup);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      if (cardEl) cardEl.style.transition = '';
      const final = draggingCardRef.current;
      draggingCardRef.current = null;
      if (final) {
        setCardSizes((prev) => {
          const next = { ...prev, [final.key]: { w: final.w, h: final.h } };
          onSizeChange?.(next);
          return next;
        });
      }
      resizeCleanupRef.current = null;
    };

    resizeCleanupRef.current = cleanup;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'se-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', cleanup);
  }, [getCardSize]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { resizeCleanupRef.current?.(); };
  }, []);

  return {
    cardSizes,
    getCardSize,
    startResize,
    draggingCardRef,
    CARD_MIN_W,
    CARD_MIN_H,
    CARD_MAX_W,
    CARD_MAX_H,
  };
}
