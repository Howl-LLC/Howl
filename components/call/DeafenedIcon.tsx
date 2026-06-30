// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Headphones } from 'lucide-react';

/** Headphones icon with a bottom-right→top-left slash, matching the MicOff style */
export function DeafenedIcon({ size = 18 }: { size?: number }) {
  return (
    <span className="relative inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <Headphones size={size} />
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="absolute inset-0 pointer-events-none" style={{ width: size, height: size }}>
        <line x1="22" y1="22" x2="2" y2="2" />
      </svg>
    </span>
  );
}
