// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect, type CSSProperties } from 'react';

const MIN_VW = 768;
const MAX_VW = 1920;

function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

function getScale(): number {
  if (typeof window === 'undefined') return 1;
  const t = clamp01((window.innerWidth - MIN_VW) / (MAX_VW - MIN_VW));
  return (85 + 25 * t) / 100;
}

export function usePickerSize(baseWidth: number, baseHeight: number): { width: number; height: number } {
  const [scale, setScale] = useState(getScale);

  useEffect(() => {
    const onResize = () => setScale(getScale());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const maxWidth = typeof window !== 'undefined' ? window.innerWidth - 16 : Infinity;
  return {
    width: Math.min(Math.round(baseWidth * scale), maxWidth),
    height: Math.round(baseHeight * scale),
  };
}

export const PICKER_GLASS_STYLE: CSSProperties = {
  backgroundColor: 'rgba(15, 23, 42, 0.45)',
  borderColor: 'rgba(255,255,255,0.12)',
  backdropFilter: 'blur(24px) saturate(1.4)',
  WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
  boxShadow:
    '0 0 0 1px rgba(255,255,255,0.06) inset, 0 25px 50px -12px rgba(0,0,0,0.45), 0 0 80px -20px rgba(0,0,0,0.3)',
};

export const PICKER_GLASS_CLASS =
  'rounded-2xl border shadow-2xl animate-in fade-in zoom-in-95 duration-150 backdrop-blur-xl';

export const PICKER_HEADER_STYLE: CSSProperties = {
  backgroundColor: 'rgba(255,255,255,0.04)',
  borderColor: 'rgba(255,255,255,0.08)',
};

export const PICKER_FOOTER_STYLE: CSSProperties = {
  backgroundColor: 'rgba(255,255,255,0.03)',
  borderColor: 'rgba(255,255,255,0.08)',
};

export const PICKER_INPUT_STYLE: CSSProperties = {
  backgroundColor: 'rgba(255,255,255,0.06)',
  borderColor: 'rgba(255,255,255,0.1)',
  color: 'var(--text-primary)',
};

export const PICKER_STICKY_BG = 'rgba(15, 23, 42, 0.55)';
