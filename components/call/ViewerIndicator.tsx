// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef } from 'react';
import { useViewers } from '../../hooks/useViewers';
import type { StreamContext } from '../../stores/types';
import { ViewerPopover } from './ViewerPopover';

interface Props {
  context: StreamContext;
  ownerId: string;
  selfUserId?: string;
  /** visual variant: 'overlay' (default, for cards/PIP) | 'inline' (for chrome bars) */
  variant?: 'overlay' | 'inline';
}

/** Two-person silhouette viewer count pill. Hover/click opens viewer popover. */
export const ViewerIndicator = React.memo(({ context, ownerId, selfUserId, variant = 'overlay' }: Props) => {
  const { count, viewers } = useViewers(context, ownerId, selfUserId);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  if (count <= 0) return null;

  const base =
    'inline-flex items-center gap-1.5 rounded-full text-white font-semibold leading-none';
  const sizing = variant === 'overlay'
    ? 'px-2.5 py-1.5 text-xs'
    : 'px-2 py-1 text-[11px]';
  const bg = 'bg-black/65 backdrop-blur-sm hover:bg-black/80 transition-colors';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={`Viewers (${count})`}
        className={`${base} ${sizing} ${bg}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(o => !o)}
      >
        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current" aria-hidden="true">
          <path d="M9 12a4 4 0 100-8 4 4 0 000 8zm7 0a3 3 0 100-6 3 3 0 000 6zm-7 2c-4 0-7 2-7 5v2h14v-2c0-3-3-5-7-5zm7 0c-.7 0-1.4.1-2 .3 1.2 1.1 2 2.7 2 4.7v2h6v-2c0-3-3-5-6-5z"/>
        </svg>
        <span>{count}</span>
      </button>

      {open && (
        <ViewerPopover
          anchorEl={btnRef.current}
          context={context}
          ownerId={ownerId}
          viewers={viewers}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
});

ViewerIndicator.displayName = 'ViewerIndicator';
