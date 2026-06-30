// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useMemo } from 'react';
import { useViewers } from '../../hooks/useViewers';
import { resolveViewers } from '../../utils/resolveViewer';
import { LetterAvatar } from '../LetterAvatar';
import { ViewerPopover } from './ViewerPopover';
import type { StreamContext } from '../../stores/types';

interface Props {
  context: StreamContext;
  ownerId: string;
  selfUserId?: string;
}

const MAX_VISIBLE = 3;
const AVATAR_SIZE = 24;

/** Compact viewer-avatar cluster (up to 3 overlapping 24px circles + +N badge).
 *  Hover/click reveals the same ViewerPopover used by the count pill. */
export const ViewerAvatarStack = React.memo(({ context, ownerId, selfUserId }: Props) => {
  const { count, viewers } = useViewers(context, ownerId, selfUserId);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const resolved = useMemo(() => resolveViewers(viewers.slice(0, MAX_VISIBLE)), [viewers]);
  const overflow = Math.max(0, count - MAX_VISIBLE);

  if (count <= 0) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={`Viewers (${count})`}
        className="inline-flex items-center rounded-full bg-black/55 backdrop-blur-sm hover:bg-black/75 transition-colors py-0.5 pl-0.5 pr-1.5"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center">
          {resolved.map((v, i) => (
            <div
              key={v.id}
              className={`rounded-[var(--radius-lg)] ring-2 ring-black/70 overflow-hidden ${i > 0 ? '-ml-2' : ''}`}
              style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
            >
              <LetterAvatar avatar={v.avatar} username={v.username} size={AVATAR_SIZE} className="rounded-full" />
            </div>
          ))}
        </div>
        {overflow > 0 && (
          <span className="ml-1 text-[10px] font-bold text-white leading-none tabular-nums">
            +{overflow}
          </span>
        )}
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

ViewerAvatarStack.displayName = 'ViewerAvatarStack';
