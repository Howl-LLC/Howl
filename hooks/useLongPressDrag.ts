// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useRef, useCallback, useState } from 'react';

interface LongPressDragOptions {
  delay?: number;
  onDragStart?: (index: number) => void;
  onDragOver?: (fromIndex: number, toIndex: number) => void;
  onDragEnd?: () => void;
}

interface LongPressDragResult {
  activeIndex: number | null;
  dragOverIndex: number | null;
  getItemProps: (index: number) => {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
    style: React.CSSProperties;
  };
}

export function useLongPressDrag(options: LongPressDragOptions = {}): LongPressDragResult {
  const { delay = 300, onDragStart, onDragOver, onDragEnd } = options;
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDragging = useRef(false);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const itemRects = useRef<Map<number, DOMRect>>(new Map());
  const activeIndexRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const getItemProps = useCallback((index: number) => {
    const handleTouchStart = (e: React.TouchEvent) => {
      const touch = e.touches[0];
      startPos.current = { x: touch.clientX, y: touch.clientY };

      // Collect all card rects for hit testing during drag
      const container = (e.currentTarget as HTMLElement).parentElement;
      if (container) {
        itemRects.current.clear();
        const cards = container.querySelectorAll('[data-drag-index]');
        cards.forEach(card => {
          const idx = Number(card.getAttribute('data-drag-index'));
          itemRects.current.set(idx, card.getBoundingClientRect());
        });
      }

      timerRef.current = setTimeout(() => {
        isDragging.current = true;
        activeIndexRef.current = index;
        setActiveIndex(index);
        onDragStart?.(index);
        // Prevent scrolling while dragging
        document.body.style.overflow = 'hidden';
      }, delay);
    };

    const handleTouchMove = (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (!startPos.current) return;

      // If user moves more than 10px before long-press fires, cancel it
      if (!isDragging.current) {
        const dx = Math.abs(touch.clientX - startPos.current.x);
        const dy = Math.abs(touch.clientY - startPos.current.y);
        if (dx > 10 || dy > 10) {
          clearTimer();
        }
        return;
      }

      // Hit test: which card is the finger over?
      for (const [idx, rect] of itemRects.current) {
        if (
          touch.clientX >= rect.left && touch.clientX <= rect.right &&
          touch.clientY >= rect.top && touch.clientY <= rect.bottom
        ) {
          if (idx !== activeIndexRef.current && idx !== dragOverIndex) {
            setDragOverIndex(idx);
            onDragOver?.(activeIndexRef.current!, idx);
          }
          break;
        }
      }
    };

    const handleTouchEnd = () => {
      clearTimer();
      if (isDragging.current) {
        isDragging.current = false;
        setActiveIndex(null);
        setDragOverIndex(null);
        activeIndexRef.current = null;
        onDragEnd?.();
        document.body.style.overflow = '';
      }
      startPos.current = null;
    };

    const isActive = activeIndex === index;
    const isDragTarget = dragOverIndex === index;

    return {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
      style: {
        transition: isActive ? 'none' : 'transform 0.15s ease, box-shadow 0.15s ease',
        transform: isActive ? 'scale(1.05)' : isDragTarget ? 'scale(0.95)' : 'scale(1)',
        zIndex: isActive ? 100 : 1,
        boxShadow: isActive ? '0 0 0 2px var(--cyan-accent), 0 8px 24px rgba(0,0,0,0.3)' : 'none',
        opacity: isActive ? 0.9 : 1,
        position: 'relative' as const,
      },
    };
  }, [activeIndex, dragOverIndex, delay, onDragStart, onDragOver, onDragEnd, clearTimer]);

  return { activeIndex, dragOverIndex, getItemProps };
}
