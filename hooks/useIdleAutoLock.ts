// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef } from 'react';
import * as dmKeyManager from '../services/dmKeyManager';

const SETTING_KEY = 'howl_e2e_idle_lock_min';

/** Minutes before auto-lock triggers. 0 = disabled. Read-only wrapper. */
export function getIdleLockMinutes(): number {
  try {
    const raw = localStorage.getItem(SETTING_KEY);
    if (!raw) return 0;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, 1440);
  } catch { return 0; }
}

export function setIdleLockMinutes(minutes: number): void {
  try {
    const clamped = Math.max(0, Math.min(Math.floor(minutes), 1440));
    if (clamped === 0) localStorage.removeItem(SETTING_KEY);
    else localStorage.setItem(SETTING_KEY, String(clamped));
  } catch { /* storage unavailable */ }
}

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'wheel'] as const;

/**
 * Locks Secure DM keys (calls dmKeyManager.lock() + forgetDevice) after
 * N minutes of inactivity, where N is pulled from localStorage on each tick.
 * 0 disables the behavior. Activity is any input event or tab visibility
 * change to visible.
 *
 * `isInCall` suppresses the lock entirely while a voice/stage/DM call is
 * active — call audio or video with no mouse/keyboard input must not trip
 * the timer. Entering or leaving a call also marks activity so the user
 * gets a fresh N-minute grace window post-call.
 */
export function useIdleAutoLock(isInCall: boolean): void {
  const lastActivityRef = useRef<number>(Date.now());
  const isInCallRef = useRef(isInCall);

  useEffect(() => {
    isInCallRef.current = isInCall;
    lastActivityRef.current = Date.now();
  }, [isInCall]);

  useEffect(() => {
    const markActive = () => { lastActivityRef.current = Date.now(); };
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, markActive, { passive: true });
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') markActive();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const interval = setInterval(() => {
      const minutes = getIdleLockMinutes();
      if (minutes <= 0) return;
      if (isInCallRef.current) return;
      if (!dmKeyManager.isUnlocked()) return;
      const idleMs = Date.now() - lastActivityRef.current;
      if (idleMs < minutes * 60_000) return;
      // isRememberedOnDevice() is async (content-key store probe). Resolve it
      // before deciding: a remembered device would silently auto-unlock on
      // restart, making idle-lock trivially bypassed, so skip the lock then.
      void dmKeyManager.isRememberedOnDevice().then((remembered) => {
        if (remembered) return;
        void dmKeyManager.requestIdleLock();
        void dmKeyManager.forgetDevice();
      });
    }, 30_000);

    return () => {
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, markActive);
      }
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(interval);
    };
  }, []);
}
