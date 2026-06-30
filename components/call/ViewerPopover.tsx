// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { StreamContext } from '../../stores/types';
import { resolveViewer } from '../../utils/resolveViewer';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ViewerListModal } from './ViewerListModal';

interface Props {
  anchorEl: HTMLElement | null;
  context: StreamContext;
  ownerId: string;
  viewers: string[];
  onClose: () => void;
}

const MAX_INLINE = 5;

export const ViewerPopover = React.memo(({ anchorEl, context, ownerId, viewers, onClose }: Props) => {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [showFull, setShowFull] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const mobile = useIsMobile();

  useEffect(() => {
    if (!anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    setPos({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(window.innerWidth - 260, rect.left)),
    });
  }, [anchorEl]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Mobile: tap-outside-to-dismiss (replaces hover-leave on desktop)
  useEffect(() => {
    if (!mobile) return;
    const onDocClick = (e: MouseEvent) => {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [mobile, onClose]);

  if (!pos) return null;

  const visible = viewers.slice(0, MAX_INLINE);
  const overflow = Math.max(0, viewers.length - MAX_INLINE);

  return createPortal(
    <div
      ref={popRef}
      role="dialog"
      aria-label="Viewers"
      className="fixed z-[70] w-[240px] rounded-lg bg-[#18181b] border border-white/10 shadow-xl p-3 text-sm text-white"
      style={{ top: pos.top, left: pos.left }}
      onMouseEnter={(e) => e.stopPropagation()}
      onMouseLeave={mobile ? undefined : onClose}
    >
      <div className="text-xs uppercase tracking-wide text-white/50 mb-2">
        Watching ({viewers.length})
      </div>
      <ul className="space-y-2">
        {visible.map((id) => {
          const v = resolveViewer(id);
          return (
            <li key={id} className="flex items-center gap-2">
              {v.avatar
                ? <img src={v.avatar} alt="" className="w-6 h-6 rounded-[var(--radius-lg)]" />
                : <div className="w-6 h-6 rounded-[var(--radius-lg)] bg-white/10" />}
              <span className="truncate">{v.username}</span>
            </li>
          );
        })}
      </ul>
      {overflow > 0 && (
        <button
          type="button"
          className="mt-2 w-full text-xs text-blue-400 hover:text-blue-300"
          onClick={() => setShowFull(true)}
        >
          +{overflow} more
        </button>
      )}
      {showFull && (
        <ViewerListModal
          context={context}
          ownerId={ownerId}
          onClose={() => setShowFull(false)}
        />
      )}
    </div>,
    // Render into the anchor's own document so the popover lands in the
    // popped-out window (PipPopoutView) instead of escaping to the main app.
    anchorEl?.ownerDocument?.body ?? document.body,
  );
});

ViewerPopover.displayName = 'ViewerPopover';
