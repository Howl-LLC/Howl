// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect } from 'react';

// Module-level visibility tracking
// Accessible both from React components (via hook) and plain functions (via isAppVisible())

let _visible = typeof document !== 'undefined' ? !document.hidden : true;
const _listeners = new Set<(visible: boolean) => void>();

function _setVisible(v: boolean) {
  if (_visible === v) return;
  _visible = v;
  _listeners.forEach(fn => fn(v));
}

// Separate "hidden" channel
// `_visible` flips on a mere window blur (clicking another app, DevTools, the
// address bar) so CSS animations can pause "like Discord". That is TOO twitchy
// to drive presence/auto-idle — Discord does not mark you Away just because the
// window lost focus, only when the tab is truly hidden or the window is
// minimized. `_hidden` tracks ONLY a real hide/minimize (document.hidden +
// Electron minimize/hide IPC), never a transient blur, so auto-idle can use it
// without regressing the animation-pausing consumers of `_visible`.
let _hidden = typeof document !== 'undefined' ? document.hidden : false;
const _hiddenListeners = new Set<(hidden: boolean) => void>();

function _setHidden(v: boolean) {
  if (_hidden === v) return;
  _hidden = v;
  _hiddenListeners.forEach(fn => fn(v));
}

// Deferred initialization
// Listeners are installed once via initAppVisible() (called from App.tsx's
// mount effect) instead of at module evaluation time. This lets App.tsx clean
// up on unmount and avoids registering listeners when the module is merely
// imported by non-browser code (SSR, tests, etc.).

let _initialized = false;
let _cleanupFns: Array<() => void> = [];

/**
 * Install document/window/Electron visibility listeners.
 * Idempotent -- safe to call more than once; only the first call takes effect.
 * Returns a cleanup function that removes all installed listeners.
 */
export function initAppVisible(): () => void {
  if (_initialized) return () => {};
  _initialized = true;

  // Web: visibilitychange + window blur/focus
  // blur fires when DevTools, address bar, or extensions steal focus -- this is
  // intentional so CSS animations (avatar glows, name shimmer, etc.) pause like Discord.
  // focus re-enables only when the document is also not hidden (avoids race with
  // the visibility API where focus can fire before visibilitychange on tab switch).
  if (typeof document !== 'undefined') {
    const onVisibilityChange = () => { _setVisible(!document.hidden); _setHidden(document.hidden); };
    const onBlur = () => _setVisible(false); // blur does NOT count as hidden
    const onFocus = () => { if (!document.hidden) _setVisible(true); };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);

    _cleanupFns.push(
      () => document.removeEventListener('visibilitychange', onVisibilityChange),
      () => window.removeEventListener('blur', onBlur),
      () => window.removeEventListener('focus', onFocus),
    );
  }

  // Electron: IPC visibility signal (more reliable for minimize/restore).
  // main.js sends this ONLY on hide/minimize/restore/show — never on a bare
  // window blur — so it is a true hidden signal and drives both channels.
  if (typeof window !== 'undefined' && window.electron?.onWindowVisibility) {
    const unsub = window.electron.onWindowVisibility((visible: boolean) => {
      _setVisible(visible);
      _setHidden(!visible);
    });
    if (typeof unsub === 'function') _cleanupFns.push(unsub);
  }

  return () => {
    for (const fn of _cleanupFns) fn();
    _cleanupFns = [];
    _initialized = false;
  };
}

/** Module-level getter -- safe to call from any context (hooks, callbacks, socket handlers) */
export function isAppVisible(): boolean {
  return _visible;
}

/** Subscribe to visibility changes. Returns unsubscribe function. */
export function onVisibilityChange(fn: (visible: boolean) => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

/**
 * Module-level getter for the "hidden" channel (true tab-hide / window
 * minimize only — NOT a transient blur). Use this for presence/auto-idle.
 */
export function isAppHidden(): boolean {
  return _hidden;
}

/** Subscribe to hide/show changes (minimize/tab-hide only). Returns unsubscribe. */
export function onHiddenChange(fn: (hidden: boolean) => void): () => void {
  _hiddenListeners.add(fn);
  return () => { _hiddenListeners.delete(fn); };
}

/** React hook -- returns current visibility state */
export function useAppVisible(): boolean {
  const [visible, setVisible] = useState(_visible);
  useEffect(() => onVisibilityChange(setVisible), []);
  return visible;
}
