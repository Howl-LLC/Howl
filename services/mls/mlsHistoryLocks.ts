// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * MLS history-archive locks (navigator.locks coordination across tabs).
 *
 * Two distinct locks, both modeled on mlsTabLock:
 *  - The SYNC LEASE is a single-holder, lifetime-held exclusive lock. Only the
 *    holder runs the upload syncer + the eager bulk restore, so they never race
 *    or duplicate across tabs. onLost fires if the held lease is later released
 *    or stolen by the browser.
 *  - The per-channel RESTORE lock is an `ifAvailable` exclusive lock: if another
 *    tab already holds it, this tab skips silently (that tab is restoring the
 *    same channel), giving cross-tab dedupe for lazy per-channel restore.
 *
 * When navigator.locks is unavailable (older WebView, some test envs), the lease
 * falls back to single-tab ownership and the restore lock runs fn directly. No
 * key material is ever logged.
 */
import { logger } from '../logger';

const SYNC_LEASE = 'howl-mls-history-sync';

let _hasLease = false;
let _releaseLease: (() => void) | null = null;
let _acquiring: Promise<boolean> | null = null;
// Abort handle for a STILL-QUEUED lease request (not yet granted), so a
// release-while-acquiring can cancel it instead of leaving a zombie request that
// later wins the lease in a stopped/logged-out tab and holds it forever.
let _acquireAbort: AbortController | null = null;

function locksApi(): LockManager | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  return locks ?? null;
}

/**
 * Acquire the single-holder history-sync lease. Resolves true if this tab
 * becomes (or already is) the holder. The upload syncer + eager restore run only
 * in the holder. `onLost` fires if the held lease is ever released/stolen by the
 * browser. Idempotent: a second call while holding (or while an acquire is in
 * flight) resolves to the same outcome without requesting a second lock.
 * Single-tab fallback when navigator.locks is unavailable.
 */
export function acquireHistorySyncLease(onLost: () => void): Promise<boolean> {
  if (_hasLease) return Promise.resolve(true);
  if (_acquiring) return _acquiring;

  const locks = locksApi();
  if (!locks) {
    // Single-tab fallback: no cross-tab coordination available.
    _hasLease = true;
    logger.warn('[mls][history-sync] navigator.locks unavailable; single-tab fallback');
    return Promise.resolve(true);
  }

  const abort = new AbortController();
  _acquireAbort = abort;
  _acquiring = new Promise<boolean>((resolveAcquire) => {
    // request() resolves only after the held callback's promise settles, so we
    // resolve acquireHistorySyncLease() from inside the callback (lock granted)
    // and keep the callback pending until releaseHeld() is called. The signal lets
    // releaseHistorySyncLease() cancel the request while it is still QUEUED.
    void locks
      .request(SYNC_LEASE, { mode: 'exclusive', signal: abort.signal }, () =>
        new Promise<void>((releaseHeld) => {
          _hasLease = true;
          if (_acquireAbort === abort) _acquireAbort = null; // granted: no longer abortable
          _releaseLease = () => {
            _releaseLease = null;
            releaseHeld();
          };
          resolveAcquire(true);
        }),
      )
      .then(() => {
        // The held promise settled -> lease released or lost.
        const wasHeld = _hasLease;
        _hasLease = false;
        _releaseLease = null;
        if (_acquireAbort === abort) _acquireAbort = null;
        _acquiring = null;
        if (wasHeld) onLost();
      })
      .catch((err: unknown) => {
        _hasLease = false;
        _releaseLease = null;
        if (_acquireAbort === abort) _acquireAbort = null;
        _acquiring = null;
        // AbortError is the EXPECTED result of releaseHistorySyncLease() cancelling a
        // still-queued request (release-while-acquiring) — not a failure, don't warn.
        if ((err as Error)?.name !== 'AbortError') {
          logger.warn('[mls][history-sync] lease request failed', { error: (err as Error)?.message });
        }
        resolveAcquire(false);
      });
  });

  return _acquiring;
}

/** True iff this tab currently holds the history-sync lease. */
export function hasHistorySyncLease(): boolean {
  return _hasLease;
}

/**
 * Voluntarily release the history-sync lease (e.g. on lock()/logout). Settles
 * the held lock so another tab can take over. No-op if not holding.
 */
export function releaseHistorySyncLease(): void {
  if (_releaseLease) {
    _releaseLease();
  } else {
    // Not yet granted: cancel the still-queued navigator.locks request so a stopped/
    // logged-out tab can't later win the lease and hold it forever (zombie holder
    // starving other tabs). The aborted request rejects with AbortError, handled in
    // the .catch above (clears _acquiring, resolves false). _hasLease is already false.
    _hasLease = false;
    if (_acquireAbort) {
      _acquireAbort.abort();
      _acquireAbort = null;
    }
  }
}

/**
 * Run fn under a per-channel restore lock. If another tab already holds it
 * (ifAvailable not granted), skip silently — that tab is restoring the same
 * channel. Single-tab fallback runs fn directly when navigator.locks is absent.
 */
export async function runWithChannelRestoreLock(
  dmChannelId: string,
  fn: () => Promise<void>,
): Promise<void> {
  const locks = locksApi();
  if (!locks) {
    await fn();
    return;
  }
  await locks.request(
    `howl-mls-history-restore:${dmChannelId}`,
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      // lock === null ⇒ not granted ⇒ another tab holds it ⇒ skip.
      if (lock) await fn();
    },
  );
}
