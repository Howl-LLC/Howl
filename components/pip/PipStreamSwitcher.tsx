// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useRef, useState } from 'react';
import type { PipStreamDesc } from '../../hooks/usePipState';

interface Props {
  streams: PipStreamDesc[];
  selected: PipStreamDesc;
  resolveName: (id: string) => string;
  onSelect: (desc: PipStreamDesc) => void;
}

/** Dropdown stream switcher. Only renders when there are 2+ streams. */
export const PipStreamSwitcher = React.memo(({ streams, selected, resolveName, onSelect }: Props) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  /* Close on Escape key or outside click */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [open]);

  if (streams.length <= 1) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        onPointerDown={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-black/65 text-white text-[11px] font-semibold"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" className="w-2.5 h-2.5 fill-current"><path d="M7 10l5 5 5-5z"/></svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute bottom-full mb-1 left-0 min-w-[150px] rounded-lg bg-[#18181b] border border-white/10 shadow-xl overflow-hidden z-10"
        >
          {streams.map((s) => (
            <li
              key={`${s.ownerId}:${s.type}`}
              role="option"
              aria-selected={s.ownerId === selected.ownerId && s.type === selected.type}
              className={`px-3 py-1.5 text-white text-xs cursor-pointer hover:bg-white/10 ${s.ownerId === selected.ownerId && s.type === selected.type ? 'bg-white/5' : ''}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => { onSelect(s); setOpen(false); }}
            >
              {resolveName(s.ownerId)} · {s.type === 'screen' ? 'Screen' : 'Camera'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

PipStreamSwitcher.displayName = 'PipStreamSwitcher';
