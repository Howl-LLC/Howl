// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PipStreamDesc } from '../../hooks/usePipState';
import { PipStreamSwitcher } from './PipStreamSwitcher';

interface Props {
  selected: PipStreamDesc;
  streams: PipStreamDesc[];
  presenterName: string;
  /** Mobile disables the popout button. */
  isMobile: boolean;
  resolveName: (id: string) => string;

  onClose: () => void;
  onPopout: () => void;
  onSelectStream: (desc: PipStreamDesc) => void;
}

const IDLE_FADE_MS = 1500;

/** Hover-reveal chrome overlay for the PIP window.
 *  - Bottom-left: presenter name, stream switcher chevron.
 *  - Bottom-right: popout + close buttons.
 *  The viewer count pill + avatar stack live OUTSIDE this chrome (mounted in
 *  PipHost) so they stay visible without requiring hover.
 *  Fades after 1.5s of pointer inactivity. */
export const PipChrome = React.memo(({
  selected, streams, presenterName, isMobile, resolveName,
  onClose, onPopout, onSelectStream,
}: Props) => {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const poke = useCallback(() => {
    setVisible(true);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setVisible(false), IDLE_FADE_MS);
  }, []);

  // Clean up timer on unmount.
  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);

  // Drive chrome reveal from the parent PIP wrapper. The chrome overlay itself
  // is pointer-events: none so it doesn't intercept clicks meant for the
  // underlying tile (e.g. the Watch Stream button on the unsubscribed
  // placeholder). Native listeners on the parent fire even though the overlay
  // can't receive events.
  useEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    parent.addEventListener('pointermove', poke);
    parent.addEventListener('pointerdown', poke);
    return () => {
      parent.removeEventListener('pointermove', poke);
      parent.removeEventListener('pointerdown', poke);
    };
  }, [poke]);

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 pointer-events-none"
    >
      {/* Gradient scrim */}
      <div
        className={`absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/55 transition-opacity duration-200 pointer-events-none ${visible ? 'opacity-100' : 'opacity-0'}`}
      />
      {/* Bottom row */}
      <div
        className={`absolute bottom-2 left-2 right-2 flex items-center justify-between gap-2 transition-opacity duration-200 pointer-events-auto ${visible ? 'opacity-100' : 'opacity-0'}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-white text-[11px] font-semibold truncate px-2 py-1 rounded-lg bg-black/55">
            {presenterName}
          </span>
          <PipStreamSwitcher
            streams={streams}
            selected={selected}
            resolveName={resolveName}
            onSelect={onSelectStream}
          />
        </div>
        <div className="flex items-center gap-1.5">
          {!isMobile && (
            <button
              type="button"
              onClick={onPopout}
              onPointerDown={(e) => e.stopPropagation()}
              aria-label="Popout"
              className="w-7 h-7 rounded-lg bg-black/65 hover:bg-black/80 text-white flex items-center justify-center"
            >
              {/* External-link / popout icon */}
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current">
                <path d="M14 3h7v7h-2V6.4L10.4 15 9 13.6 17.6 5H14V3zM5 5h5v2H7v10h10v-3h2v5H5V5z"/>
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="Close"
            className="w-7 h-7 rounded-lg bg-black/65 hover:bg-black/80 text-white flex items-center justify-center"
          >
            {/* X / close icon */}
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current">
              <path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
});

PipChrome.displayName = 'PipChrome';
