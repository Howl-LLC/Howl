// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { STATUS_COLORS } from '../shared/statusColors';

interface TypingStatusDotProps {
  status: string;
  isTyping: boolean;
  /** Dot diameter in pixels when NOT typing (default: 12). With no border, this is the full filled circle. */
  size?: number;
  /** Border color — only applied when borderWidth > 0. */
  borderColor?: string;
  /** Border width in pixels (default: 0 — no outline). */
  borderWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}

export const TypingStatusDot: React.FC<TypingStatusDotProps> = React.memo(({
  status,
  isTyping,
  size = 12,
  borderColor,
  borderWidth = 0,
  className,
  style,
}) => {
  // Never show typing animation for offline/invisible users
  const showTyping = isTyping && status !== 'offline' && status !== 'invisible';
  const bgColor = STATUS_COLORS[status] ?? STATUS_COLORS.offline;
  // Typing-pill dot diameter is keyed off the outer size so it stays compact whether or not a border is drawn.
  const dotSize = Math.max(2, Math.round(size * 0.22));
  const pillWidth = showTyping ? size * 2 : size;

  return (
    <div
      className={className}
      style={{
        width: pillWidth,
        height: size,
        borderRadius: size / 2,
        backgroundColor: bgColor,
        ...(borderWidth > 0 ? { border: `${borderWidth}px solid ${borderColor ?? 'transparent'}` } : {}),
        transition: 'width 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: Math.max(1, dotSize * 0.35),
        overflow: 'hidden',
        ...style,
      }}
    >
      {showTyping && (
        <>
          <span className="typing-pill-dot" style={{ width: dotSize, height: dotSize, animationDelay: '0s' }} />
          <span className="typing-pill-dot" style={{ width: dotSize, height: dotSize, animationDelay: '0.16s' }} />
          <span className="typing-pill-dot" style={{ width: dotSize, height: dotSize, animationDelay: '0.32s' }} />
        </>
      )}
    </div>
  );
});

TypingStatusDot.displayName = 'TypingStatusDot';
