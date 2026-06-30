// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef } from 'react';
import type { User } from '../types';
import { setSelfStatus } from '../utils/selfStatus';
import { onHiddenChange, isAppHidden } from './useAppVisible';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Auto-idle: sets the user's status to 'idle' after 5 min of no activity, or
 * when the window is TRULY hidden/minimized (tab switch, minimize, Electron
 * hide) — NOT on a bare focus loss (clicking another app, DevTools, the
 * address bar). This matches Discord: clicking off the app keeps you Online;
 * only minimizing/hiding or going inactive marks you Away. Reverts to 'online'
 * on activity or when the window is shown again, but only if *we* auto-set idle
 * — manual 'dnd'/'invisible'/'idle' choices are preserved. Suppressed in a call.
 *
 * Status changes go through `setSelfStatus`, which (a) updates EVERY presence
 * surface (status bar + member/friends/DM lists) instantly so they never
 * disagree, and (b) debounces + dedupes the server write so a quick hide/show
 * collapses to ~zero network calls instead of tripping the status rate limiter.
 *
 * Uses localStorage to distinguish auto-idle from a user-chosen "away" across
 * refreshes. Returns `autoIdleRef` so `handleStatusChange` in App can reset it.
 */
export function useAutoIdle(
  currentUserStatus: User['status'],
  isInCall: boolean,
) {
  const autoIdleRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentUserStatusRef = useRef(currentUserStatus);
  currentUserStatusRef.current = currentUserStatus;
  const isInCallRef = useRef(isInCall);
  isInCallRef.current = isInCall;

  useEffect(() => {
    const goIdle = () => {
      if (currentUserStatusRef.current !== 'online') return;
      if (isInCallRef.current) return;
      autoIdleRef.current = true;
      localStorage.setItem('howl_auto_idle', '1');
      setSelfStatus('idle');
    };

    const goOnlineIfAutoIdle = () => {
      if (!autoIdleRef.current) return;
      if (currentUserStatusRef.current !== 'idle') return;
      autoIdleRef.current = false;
      localStorage.removeItem('howl_auto_idle');
      setSelfStatus('online');
    };

    const onActivity = () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(goIdle, IDLE_TIMEOUT_MS);
      goOnlineIfAutoIdle();
    };

    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    idleTimerRef.current = setTimeout(goIdle, IDLE_TIMEOUT_MS);

    // Drive auto-idle off the "hidden" channel (true tab-hide / minimize), NOT
    // the blur-inclusive visibility flag — so clicking another app keeps you
    // Online. Revert to online when the window is shown again.
    const unsubHidden = onHiddenChange((hidden) => {
      if (hidden) {
        goIdle();
      } else {
        goOnlineIfAutoIdle();
      }
    });

    // If we mounted while already hidden (e.g. reloaded in a background tab),
    // go idle right away so the status reflects reality.
    if (isAppHidden()) goIdle();

    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      unsubHidden();
    };
  }, []);

  return { autoIdleRef };
}
