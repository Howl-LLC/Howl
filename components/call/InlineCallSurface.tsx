// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CallResizeHandle, readStoredCallHeight } from './CallResizeHandle';

export type InlineCallSurfaceMode = 'inline' | 'panel-fullscreen';

/** Default inline height if the user has never resized. Roughly matches old 58dvh feel. */
const DEFAULT_INLINE_HEIGHT = 460;

export interface InlineCallSurfaceProps {
  /** The card grid (participants or preview ghost cards). */
  children: React.ReactNode;
  /** The bottom-center controls cluster — CallControlBar, or Join buttons in preview. */
  controls: React.ReactNode;
  /** Current expand state. 'inline' = shares space with chat; 'panel-fullscreen' = fills DM panel, chat should be hidden by caller. */
  mode: InlineCallSurfaceMode;
  /** Fires when user clicks the chevron. Caller owns the state transition. If undefined, chevron is hidden. */
  onChevronToggle?: () => void;
  /** Optional extra class appended to the outer wrapper. */
  className?: string;
  /** Mobile flag — when true, disables the chevron and uses tighter padding. Default false. */
  isMobile?: boolean;
}

export const InlineCallSurface = React.memo(function InlineCallSurface({
  children,
  controls,
  mode,
  onChevronToggle,
  className,
  isMobile = false,
}: InlineCallSurfaceProps) {
  const { t } = useTranslation();

  const showChevron = onChevronToggle != null && !isMobile;
  const isExpanded = mode === 'panel-fullscreen';
  const chevronLabel = isExpanded
    ? t('voiceCall.collapse', 'Collapse')
    : t('voiceCall.expand', 'Expand');

  // Restore the persisted height on mount (desktop only — mobile uses CSS sizing).
  const [inlineHeight, setInlineHeight] = useState<number>(DEFAULT_INLINE_HEIGHT);
  useEffect(() => {
    const stored = readStoredCallHeight();
    if (stored != null) setInlineHeight(stored);
  }, []);

  const showResizeHandle = !isExpanded && !isMobile;
  const sizingClass = isExpanded
    ? 'flex-1 h-full'
    : isMobile
      ? 'shrink-0 min-h-[260px] max-h-[50dvh] h-[46dvh]'
      : 'shrink-0';
  const sizingStyle: React.CSSProperties | undefined =
    !isExpanded && !isMobile ? { height: `${inlineHeight}px` } : undefined;

  return (
    <section
      role="region"
      style={sizingStyle}
      className={`glass-call-area relative flex flex-col min-h-0 ${sizingClass} ${className ?? ''}`}
    >
      {/* Grid area */}
      <div className={`flex-1 min-h-0 overflow-hidden flex items-center justify-center ${isMobile ? 'px-2 py-2' : 'px-4 py-3'}`}>
        {children}
      </div>

      {/* Bottom row: chevron (bottom-left) + controls (center) */}
      <div className={`relative flex items-center justify-center ${isMobile ? 'px-2 pb-2' : 'px-3 pb-3'}`}>
        {showChevron && (
          <button
            type="button"
            onClick={onChevronToggle}
            title={chevronLabel}
            aria-label={chevronLabel}
            className="absolute left-3 bottom-3 w-7 h-7 flex items-center justify-center rounded-xl bg-[var(--glass-bg)] backdrop-blur-sm border border-[var(--border-subtle)] hover:bg-[var(--fill-hover)] text-[var(--text-secondary)] hover:text-[var(--cyan-accent)] transition-colors"
          >
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        )}
        {controls}
      </div>

      {showResizeHandle && (
        <CallResizeHandle currentHeight={inlineHeight} onResize={setInlineHeight} />
      )}
    </section>
  );
});
