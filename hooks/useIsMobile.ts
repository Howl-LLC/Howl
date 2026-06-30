// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect } from 'react';

/* ── Breakpoint tiers ──────────────────────────────────── */
const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1024;

export type BreakpointTier = 'mobile' | 'tablet' | 'desktop';

/**
 * Returns the current layout tier: mobile (<768), tablet (768–1023), desktop (≥1024).
 * Uses window.matchMedia — no resize polling — with proper listener cleanup.
 */
export function useBreakpoint(): BreakpointTier {
  const [tier, setTier] = useState<BreakpointTier>(() => {
    if (typeof window === 'undefined') return 'desktop';
    const w = window.innerWidth;
    if (w < MOBILE_BREAKPOINT) return 'mobile';
    if (w < TABLET_BREAKPOINT) return 'tablet';
    return 'desktop';
  });

  useEffect(() => {
    const mqlMobile = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const mqlTablet = window.matchMedia(`(min-width: ${MOBILE_BREAKPOINT}px) and (max-width: ${TABLET_BREAKPOINT - 1}px)`);

    const update = () => {
      if (mqlMobile.matches) setTier('mobile');
      else if (mqlTablet.matches) setTier('tablet');
      else setTier('desktop');
    };

    // Sync on mount (SSR → client hydration)
    update();

    const onMobileChange = () => update();
    const onTabletChange = () => update();

    mqlMobile.addEventListener('change', onMobileChange);
    mqlTablet.addEventListener('change', onTabletChange);
    return () => {
      mqlMobile.removeEventListener('change', onMobileChange);
      mqlTablet.removeEventListener('change', onTabletChange);
    };
  }, []);

  return tier;
}

/**
 * Drop-in backward-compatible hook — returns true when viewport < 768px.
 * Existing consumers don't need any changes.
 */
export function useIsMobile(): boolean {
  const tier = useBreakpoint();
  return tier === 'mobile';
}
