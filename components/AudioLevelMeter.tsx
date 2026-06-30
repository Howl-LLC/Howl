// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { useSharedIsSpeaking } from '../hooks/useAudioLevel';

interface AudioLevelMeterProps {
  stream: MediaStream | null;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  /** Legacy prop — idle now renders as three equal dots (ellipsis), so
   * there's no visual clutter to hide. Kept for backward compat; ignored. */
  hideInactive?: boolean;
}

const SIZES = {
  sm: { bar: 2,   gap: 1.5, h: 12 },
  md: { bar: 2.5, gap: 2,   h: 16 },
  lg: { bar: 3,   gap: 2.5, h: 22 },
};

const SPEAKING_THRESHOLD = 0.06;

// Idle rendering: via .howl-wf-bar--idle, each span becomes a circle with
// width = height = s.bar. Active bounce still uses --howl-wf-low via scaleY.
const IDLE_SCALE = '0.2';

export const AudioLevelMeter: React.FC<AudioLevelMeterProps> = React.memo(({
  stream,
  className = '',
  size = 'md',
}) => {
  // Boolean-based: only re-renders on the speaking/not-speaking flip,
  // not on every quantized level step. ~5-7× fewer React commits.
  const active = useSharedIsSpeaking(stream, SPEAKING_THRESHOLD);

  const s = SIZES[size];
  const width = s.bar * 3 + s.gap * 2;

  return (
    <div
      className={`inline-flex items-center shrink-0 ${className}`}
      style={{ width, height: s.h, gap: s.gap }}
      aria-hidden
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={active ? 'howl-wf-bar howl-wf-bar--active' : 'howl-wf-bar howl-wf-bar--idle'}
          style={{
            width: s.bar,
            height: s.h,
            ['--howl-wf-dot' as string]: `${s.bar}px`,
            ['--howl-wf-delay' as string]: `${i * 0.14}s`,
            ['--howl-wf-low' as string]: IDLE_SCALE,
            ['--howl-wf-high' as string]: i === 1 ? '1' : (i === 0 ? '0.6' : '0.75'),
          }}
        />
      ))}
    </div>
  );
});
