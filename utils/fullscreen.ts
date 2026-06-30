// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Fullscreen helpers — split by platform so the call surface behaves like
 * Discord on each target:
 *   - Web: no native Fullscreen API. The call surface is an in-window overlay
 *     with `position: fixed; inset: 0; z-[var(--z-pip)]`. Calling
 *     `requestAppFullscreen(true)` in the browser is a no-op; the caller's
 *     `mode='fullscreen'` state is what drives the visual fullscreen.
 *   - Electron: asks the main process to put the native window into
 *     fullscreen via IPC. The overlay then fills the chromeless window,
 *     matching Discord Desktop.
 *
 * Legacy browser Fullscreen API helpers (`toggleElementFullscreen`,
 * `isFullscreen`, `onFullscreenChange`) are kept for the per-video-tile
 * expand button in calls, which still uses native fullscreen on that one
 * element — that's the only place native Fullscreen API is still the
 * right call.
 */

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
};

type WebkitElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void>;
};

interface ElectronBridge {
  isElectron?: boolean;
  setFullscreen?: (enabled: boolean) => void;
  onFullscreenChange?: (cb: (enabled: boolean) => void) => () => void;
}

function getElectron(): ElectronBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as typeof window & { electron?: ElectronBridge }).electron;
  return bridge && bridge.isElectron ? bridge : null;
}

export function isRunningInElectron(): boolean {
  return getElectron() !== null;
}

/**
 * Request or exit fullscreen for the whole call surface.
 * Electron: native window fullscreen. Web: no-op (overlay handles it).
 */
export function requestAppFullscreen(enabled: boolean): void {
  const electron = getElectron();
  if (electron?.setFullscreen) {
    electron.setFullscreen(enabled);
  }
  // Web: intentional no-op. Callers should update their local `isFullscreen`
  // state regardless so the overlay renders.
}

/**
 * Subscribe to app-level fullscreen changes driven by the OS / user
 * (F11, OS chrome, etc.) so the renderer can sync its local state.
 * Returns an unsubscribe. On web, fires never.
 */
export function onAppFullscreenChange(cb: (enabled: boolean) => void): () => void {
  const electron = getElectron();
  if (electron?.onFullscreenChange) {
    return electron.onFullscreenChange(cb);
  }
  return () => {};
}

// Legacy per-element fullscreen (used by individual video tile buttons)

export function isFullscreen(): boolean {
  if (typeof document === 'undefined') return false;
  const doc = document as WebkitDocument;
  return !!(document.fullscreenElement || doc.webkitFullscreenElement);
}

export function toggleElementFullscreen(el: HTMLElement | null): void {
  if (!el) return;
  const element = el as WebkitElement;
  const doc = document as WebkitDocument;

  if (!isFullscreen()) {
    if (element.requestFullscreen) {
      element.requestFullscreen().catch(() => {});
    } else if (element.webkitRequestFullscreen) {
      element.webkitRequestFullscreen().catch(() => {});
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (doc.webkitExitFullscreen) {
      doc.webkitExitFullscreen().catch(() => {});
    }
  }
}

export function onFullscreenChange(handler: () => void): () => void {
  document.addEventListener('fullscreenchange', handler);
  document.addEventListener('webkitfullscreenchange', handler);
  return () => {
    document.removeEventListener('fullscreenchange', handler);
    document.removeEventListener('webkitfullscreenchange', handler);
  };
}
