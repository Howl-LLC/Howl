// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useUpdateStore } from '../stores/updateStore';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { resolveBuildDateSync } from '../services/buildDate';

const IS_ELECTRON = typeof window !== 'undefined' && !!(window.electron?.isElectron || (window as unknown as Record<string, unknown>).__ELECTRON_WINDOW__);
const CHECK_TIMEOUT_MS = 90_000;

export function UpdateBlockingModal() {
  const { required, reason, stage, progress, setStage, setProgress } = useUpdateStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, required);

  useEffect(() => {
    if (!required) return;

    if (IS_ELECTRON) {
      const cleanups: (() => void)[] = [];

      const unsub1 = window.electron?.onUpdateAvailable?.(() => setStage('downloading'));
      if (unsub1) cleanups.push(unsub1);

      const unsub2 = window.electron?.onUpdateDownloadProgress?.((p: number) => setProgress(p));
      if (unsub2) cleanups.push(unsub2);

      const unsub3 = window.electron?.onUpdateDownloaded?.(() => setStage('ready'));
      if (unsub3) cleanups.push(unsub3);

      const unsub4 = window.electron?.onUpdateError?.(() => setStage('failed'));
      if (unsub4) cleanups.push(unsub4);

      const unsub5 = window.electron?.onUpdateNotAvailable?.(() => setStage('failed'));
      if (unsub5) cleanups.push(unsub5);

      window.electron?.checkForUpdate?.();

      const timeout = setTimeout(() => {
        if (useUpdateStore.getState().stage === 'checking') {
          setStage('failed');
        }
      }, CHECK_TIMEOUT_MS);

      return () => {
        clearTimeout(timeout);
        for (const fn of cleanups) fn();
      };
    } else {
      // Web: reload with cache-busting escalation.
      // Attempt 0: append ?_v=<buildDate>-<random> to invalidate CDN edge cache.
      // Attempt 1: unregister service worker (if registered) then reload.
      // Attempt 2+: give up and show the manual-retry UI.
      const key = 'howl-update-reload-attempt';
      const attempt = parseInt(sessionStorage.getItem(key) ?? '0', 10);
      if (attempt >= 2) {
        setStage('failed');
        return;
      }
      sessionStorage.setItem(key, String(attempt + 1));

      const t = setTimeout(() => {
        if (attempt === 0) {
          // First attempt: cache-bust via unique query param. Cloudflare Pages
          // treats unique query strings as separate cache keys for HTML.
          const url = new URL(window.location.href);
          if (!url.searchParams.has('_v')) {
            const buildDate = resolveBuildDateSync();
            const rand = Math.random().toString(36).slice(2, 8);
            url.searchParams.set('_v', `${buildDate}-${rand}`);
            window.location.replace(url.toString());
          } else {
            window.location.reload();
          }
        } else {
          // Second attempt: force-unregister the service worker so the browser
          // bypasses SW caching, then reload.
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistration()
              .then((reg) => {
                if (reg) return reg.unregister();
              })
              .then(() => window.location.reload())
              .catch(() => window.location.reload());
          } else {
            window.location.reload();
          }
        }
      }, 3_000);
      return () => clearTimeout(t);
    }
  }, [required, setStage, setProgress]);

  if (!required) return null;

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/80">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="update-modal-title" className="max-w-md w-full bg-neutral-900 rounded-lg p-6 shadow-2xl">
        <h2 id="update-modal-title" className="text-xl font-semibold mb-2 text-white">Howl needs to update</h2>
        <p className="text-neutral-300 mb-4">
          {reason === 'buildDate'
            ? "Your version of Howl is too old to keep using. We're getting you up to date."
            : 'Howl has changed in a way that requires an update to continue.'}
        </p>

        {IS_ELECTRON ? (
          <>
            {stage === 'checking' && <p className="text-neutral-300">Checking for update...</p>}
            {stage === 'downloading' && (
              <>
                <p className="text-neutral-300">Downloading update...</p>
                <div className="h-2 bg-neutral-700 rounded-lg mt-2 overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </>
            )}
            {stage === 'ready' && (
              <>
                <p className="text-neutral-300">Update ready. Restart to apply.</p>
                <button
                  className="mt-4 w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white"
                  onClick={() => window.electron?.restartForUpdate?.()}
                >
                  Restart now
                </button>
              </>
            )}
            {stage === 'failed' && (
              <>
                <p className="text-neutral-300">
                  Update check failed. Please reinstall from the Howl website.
                </p>
                <a
                  href="https://howlpro.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 block text-center py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white"
                >
                  Open howlpro.com
                </a>
              </>
            )}
          </>
        ) : (
          <>
            {stage !== 'failed' && (
              <p className="text-neutral-300">Reloading to get the latest version...</p>
            )}
            {stage === 'failed' && (
              <>
                <p className="text-neutral-300">
                  Reload failed. Please clear your browser cache and refresh manually.
                </p>
                <button
                  className="mt-4 w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white"
                  onClick={() => {
                    sessionStorage.removeItem('howl-update-reload-attempt');
                    window.location.reload();
                  }}
                >
                  Try again
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
