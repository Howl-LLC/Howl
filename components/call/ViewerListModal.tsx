// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { socketService } from '../../services/socket';
import type { StreamContext } from '../../stores/types';
import { resolveViewers, type ResolvedViewer } from '../../utils/resolveViewer';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useIsMobile } from '../../hooks/useIsMobile';

interface Props {
  context: StreamContext;
  ownerId: string;
  onClose: () => void;
}

const DRAG_DISMISS_THRESHOLD = 80;

/** Modal that fetches the full viewer list (paginated). Used when
 *  >5 viewers exist (the popover's "+N more" CTA).
 *  On mobile (<768 px) renders as a bottom sheet with drag-to-dismiss. */
export const ViewerListModal = React.memo(({ context, ownerId, onClose }: Props) => {
  const [entries, setEntries] = useState<ResolvedViewer[]>([]);
  const [nextPage, setNextPage] = useState<number | undefined>(0);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mobile = useIsMobile();
  useFocusTrap(dialogRef);

  /* ── Drag-to-dismiss state (mobile only) ────────────────── */
  const dragStartY = useRef<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!mobile) return;
    dragStartY.current = e.clientY;
    setDragOffset(0);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [mobile]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragStartY.current === null) return;
    const delta = e.clientY - dragStartY.current;
    // Only allow dragging down (positive delta)
    setDragOffset(Math.max(0, delta));
  }, []);

  const onPointerUp = useCallback(() => {
    if (dragStartY.current === null) return;
    if (dragOffset > DRAG_DISMISS_THRESHOLD) {
      onClose();
    }
    dragStartY.current = null;
    setDragOffset(0);
  }, [dragOffset, onClose]);

  useEffect(() => () => { mounted.current = false; }, []);

  async function fetchPage(page: number) {
    setLoading(true);
    const res = await socketService.requestViewerList({
      context, streamOwnerId: ownerId, streamType: 'screen', page,
    });
    if (!mounted.current) return;
    if (res.ok && res.viewers) {
      const resolved: ResolvedViewer[] = resolveViewers(res.viewers);
      setEntries(prev => (page === 0 ? resolved : [...prev, ...resolved]));
      setNextPage(res.nextPage);
    }
    setLoading(false);
  }

  useEffect(() => { void fetchPage(0); }, [context.kind, context.scopeId, ownerId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* ── Layout classes ─────────────────────────────────────── */
  const backdropClass = mobile
    ? 'fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm'
    : 'fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm';

  const dialogClass = mobile
    ? 'fixed inset-x-0 bottom-0 z-[80] max-h-[75vh] rounded-t-2xl bg-[#18181b] border-t border-white/10 shadow-2xl overflow-hidden flex flex-col'
    : 'w-[420px] max-h-[70vh] rounded-xl bg-[#18181b] border border-white/10 shadow-2xl overflow-hidden flex flex-col';

  const dialogStyle = mobile && dragOffset > 0
    ? { transform: `translateY(${dragOffset}px)`, transition: 'none' }
    : mobile
      ? { transition: 'transform 0.2s ease-out' }
      : undefined;

  return createPortal(
    <div className={backdropClass} onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-label="All viewers"
        className={dialogClass}
        style={dialogStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mobile grabber bar + drag zone */}
        {mobile && (
          <div
            className="touch-none cursor-grab active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <div className="w-10 h-1 rounded-full bg-white/30 mx-auto my-2" />
          </div>
        )}

        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
          <h3 className="text-white font-semibold">Viewers</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-white/60 hover:text-white"
            aria-label="Close"
          >
            &times;
          </button>
        </div>
        <ul className="flex-1 overflow-y-auto p-2">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5">
              {e.avatar ? (
                <img src={e.avatar} alt="" className="w-7 h-7 rounded-[var(--radius-lg)]" />
              ) : (
                <div className="w-7 h-7 rounded-[var(--radius-lg)] bg-white/10" />
              )}
              <span className="text-white text-sm truncate">{e.username}</span>
            </li>
          ))}
          {loading && <li className="p-2 text-white/40 text-xs">Loading&hellip;</li>}
        </ul>
        {nextPage !== undefined && !loading && (
          <button
            type="button"
            className="px-4 py-2 text-blue-400 hover:text-blue-300 text-sm border-t border-white/10"
            onClick={() => void fetchPage(nextPage)}
          >
            Load more
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
});

ViewerListModal.displayName = 'ViewerListModal';
