// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';

interface Props {
  presenterAvatar?: string;
  presenterName: string;
  onWatch: () => void;
}

/** Placeholder shown for unsubscribed screenshares: presenter avatar + "Watch Stream" CTA. */
export const PipWatchPlaceholder = React.memo(({ presenterAvatar, presenterName, onWatch }: Props) => {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-slate-800 to-slate-900">
      {presenterAvatar ? (
        <img src={presenterAvatar} alt="" className="w-12 h-12 rounded-[var(--radius-lg)]" />
      ) : (
        <div className="w-12 h-12 rounded-[var(--radius-lg)] bg-white/10" />
      )}
      <div className="text-white text-xs font-medium truncate max-w-[90%]">{presenterName}</div>
      <button
        type="button"
        onClick={onWatch}
        onPointerDown={(e) => e.stopPropagation()}
        className="btn-cta mt-1 px-3 py-1 text-[11px] font-semibold rounded-xl"
      >
        Watch Stream
      </button>
    </div>
  );
});

PipWatchPlaceholder.displayName = 'PipWatchPlaceholder';
