// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Detects when a new service worker is waiting and exposes a function
 * to activate it (which reloads the page). Uses a dynamic import so the
 * hook is a no-op in Electron builds where VitePWA is not bundled.
 */
export function useServiceWorkerUpdate() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  // Ref, not state: keeps `applyUpdate` stable and always current, avoiding
  // stale closures in toast onAction handlers.
  const updateSWRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    if (window.electron?.isElectron || !('serviceWorker' in navigator)) return;

    import('virtual:pwa-register').then(({ registerSW }) => {
      const update = registerSW({
        onNeedRefresh() {
          setUpdateAvailable(true);
        },
      });
      updateSWRef.current = update;
    }).catch(() => {
      // VitePWA virtual module unavailable (Electron / test env)
    });
  }, []);

  const applyUpdate = useCallback(() => {
    const updateSW = updateSWRef.current;
    // `updateSW(true)` posts SKIP_WAITING to the waiting worker and relies on
    // Workbox's `controllerchange` listener to trigger the reload. That listener
    // is intermittently missed across browsers — so we always schedule our own
    // safety reload. If Workbox reloads first, this timeout never runs (page
    // unloads). If not, we reload ourselves after the new SW has had time to
    // activate, and the new version is served on the next load.
    if (updateSW) {
      updateSW(true).catch(() => { /* fall through to timeout reload */ });
    }
    setTimeout(() => { window.location.reload(); }, 1500);
  }, []);

  return { updateAvailable, applyUpdate };
}
