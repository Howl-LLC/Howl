// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';

const DOT = 'min-w-[18px] h-[18px] rounded-full text-white text-[9px] font-black px-1 flex items-center justify-center shrink-0';
const SAVED_BG = '#ef4444';
const OTR_BG = '#076FA0';
const SAVED_GLOW = '0 0 8px rgba(239,68,68,0.3)';
const OTR_GLOW = '0 0 8px rgba(7,111,160,0.45)';
const RING = '0 0 0 2px var(--bg-app)';
const fmt = (n: number) => (n > 99 ? '99+' : (n || 1));

/**
 * Per-conversation two-color unread badge. Saved unread is red, OTR unread is
 * Howl blue. When both are present the dots semi-overlap (blue behind, red in
 * front), each ringed with the row surface so they stay legible where they
 * cross.
 */
export const TierUnreadBadge: React.FC<{
  savedUnread: boolean;
  savedCount: number;
  otrUnread: boolean;
  otrCount: number;
}> = ({ savedUnread, savedCount, otrUnread, otrCount }) => {
  if (!savedUnread && !otrUnread) return null;

  if (savedUnread && otrUnread) {
    return (
      <span className="relative flex items-center shrink-0" aria-label="Unread messages">
        <span data-tier="otr" className={DOT} style={{ backgroundColor: OTR_BG, boxShadow: `${OTR_GLOW}, ${RING}` }}>{fmt(otrCount)}</span>
        <span data-tier="saved" className={`${DOT} -ml-2`} style={{ backgroundColor: SAVED_BG, boxShadow: `${SAVED_GLOW}, ${RING}` }}>{fmt(savedCount)}</span>
      </span>
    );
  }
  if (otrUnread) {
    return <span data-tier="otr" className={DOT} style={{ backgroundColor: OTR_BG, boxShadow: OTR_GLOW }} aria-label="Unread messages">{fmt(otrCount)}</span>;
  }
  return <span data-tier="saved" className={DOT} style={{ backgroundColor: SAVED_BG, boxShadow: SAVED_GLOW }} aria-label="Unread messages">{fmt(savedCount)}</span>;
};
TierUnreadBadge.displayName = 'TierUnreadBadge';
