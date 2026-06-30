// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

/**
 * Spoiler reveal context — tracks which spoiler IDs the user has revealed.
 *
 * Performance: uses a ref-backed Set with a subscription model so that
 * `reveal()` only triggers re-renders for components that consume the
 * reactive `revealedIds` / `isRevealed`, not the entire subtree.
 * The `reveal` and `isRevealed` callbacks are referentially stable.
 */

type SpoilerRevealContextValue = {
  /** Check if a spoiler ID has been revealed. Stable reference. */
  isRevealed: (id: string) => boolean;
  /** Reveal a spoiler by ID. Stable reference. */
  reveal: (id: string) => void;
  /** Clear all revealed spoiler IDs. Stable reference. */
  clearRevealed: () => void;
  /** Subscribe to changes (for components that need reactive updates). */
  subscribe: (cb: () => void) => () => void;
  /** Get a snapshot version (increments on each reveal). */
  getSnapshot: () => number;
  /** Whether auto-reveal mode is active (always-reveal or moderator). */
  autoReveal: boolean;
};

const SpoilerRevealContext = createContext<SpoilerRevealContextValue | null>(null);

/** Hook for components that only need the stable `reveal` function (no re-render on reveal). */
export function useSpoilerRevealActions() {
  const ctx = useContext(SpoilerRevealContext);
  if (!ctx) return { reveal: () => {}, clearRevealed: () => {}, isRevealed: () => false, autoReveal: false };
  return { reveal: ctx.reveal, clearRevealed: ctx.clearRevealed, isRevealed: ctx.isRevealed, autoReveal: ctx.autoReveal };
}

/** Hook for components that need reactive re-renders when spoilers are revealed. */
export function useSpoilerReveal() {
  const ctx = useContext(SpoilerRevealContext);
  if (!ctx) {
    return {
      revealedIds: new Set<string>() as ReadonlySet<string>,
      reveal: () => {},
      clearRevealed: () => {},
      isRevealed: (_id: string) => false,
      autoReveal: false,
    };
  }

  // Subscribe to version changes so this component re-renders when spoilers are revealed
  useSyncExternalStore(ctx.subscribe, ctx.getSnapshot);

  return {
    revealedIds: new Set<string>() as ReadonlySet<string>, // kept for API compat but consumers should use isRevealed()
    reveal: ctx.reveal,
    clearRevealed: ctx.clearRevealed,
    isRevealed: ctx.isRevealed,
    autoReveal: ctx.autoReveal,
  };
}

export function SpoilerRevealProvider({
  children,
  channelId,
  serverId,
  spoilerMode = 'on-click',
  isServerModerator = false,
}: {
  children: React.ReactNode;
  channelId?: string;
  serverId?: string;
  spoilerMode?: 'on-click' | 'on-servers-i-moderate' | 'always';
  isServerModerator?: boolean;
}) {
  const revealedRef = useRef(new Set<string>());
  const versionRef = useRef(0);
  const listenersRef = useRef(new Set<() => void>());

  const notify = useCallback(() => {
    for (const cb of listenersRef.current) cb();
  }, []);

  const autoReveal = spoilerMode === 'always' || (spoilerMode === 'on-servers-i-moderate' && isServerModerator);

  const reveal = useCallback((id: string) => {
    if (revealedRef.current.has(id)) return; // no-op if already revealed
    revealedRef.current.add(id);
    versionRef.current++;
    notify();
  }, [notify]);

  const clearRevealed = useCallback(() => {
    if (revealedRef.current.size === 0) return;
    revealedRef.current = new Set();
    versionRef.current++;
    notify();
  }, [notify]);

  const isRevealed = useCallback((id: string) => {
    return autoReveal || revealedRef.current.has(id);
  }, [autoReveal]);

  const subscribe = useCallback((cb: () => void) => {
    listenersRef.current.add(cb);
    return () => { listenersRef.current.delete(cb); };
  }, []);

  const getSnapshot = useCallback(() => versionRef.current, []);

  // Clear when user navigates to a different channel or server
  useEffect(() => {
    clearRevealed();
  }, [channelId, serverId, clearRevealed]);

  // Clear when the window loses focus (user switches to another app/window)
  useEffect(() => {
    const onBlur = () => clearRevealed();
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [clearRevealed]);

  const value = useMemo(
    () => ({ isRevealed, reveal, clearRevealed, subscribe, getSnapshot, autoReveal }),
    [isRevealed, reveal, clearRevealed, subscribe, getSnapshot, autoReveal],
  );

  return (
    <SpoilerRevealContext.Provider value={value}>
      {children}
    </SpoilerRevealContext.Provider>
  );
}
