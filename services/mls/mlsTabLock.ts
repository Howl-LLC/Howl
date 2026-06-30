// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * MLS multi-tab leader election. Pairs with the SharedWorker single-writer.
 *
 * A tab acquires a navigator.locks lease named 'howl-mls-writer' and holds it
 * for its entire lifetime — the lock callback returns a promise that resolves
 * only when leadership is intentionally released (page unload / lock loss),
 * so exactly one live tab is ever the MLS writer. Non-leader tabs disable MLS
 * DM send/receive (mlsCoordinator gates on isLeader()).
 *
 * When navigator.locks is unavailable (older WebView, some test envs), we fall
 * back to single-tab leadership and warn. No key material is ever logged.
 */
import { logger } from '../logger';

const LOCK_NAME = 'howl-mls-writer';
const PROVISION_LOCK_NAME = 'howl-mls-provision';

let _isLeader = false;
let _releaseLock: (() => void) | null = null;
let _acquiring: Promise<boolean> | null = null;

function locksApi(): LockManager | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  return locks ?? null;
}

/**
 * Acquire MLS leadership. Resolves true if this tab becomes (or already is)
 * the leader. `onLost` fires if the held lock is ever released by the browser
 * (only possible on real lock loss, e.g. tab discard). Idempotent: a second
 * call while leader (or while an acquire is in flight) resolves to the same
 * outcome without requesting a second lock.
 */
export function acquireLeadership(onLost: () => void): Promise<boolean> {
  if (_isLeader) return Promise.resolve(true);
  if (_acquiring) return _acquiring;

  const locks = locksApi();
  if (!locks) {
    // Single-tab fallback: no cross-tab coordination available.
    _isLeader = true;
    logger.warn('[mls][tab-lock] navigator.locks unavailable; using single-tab leader fallback');
    return Promise.resolve(true);
  }

  _acquiring = new Promise<boolean>((resolveAcquire) => {
    // request() resolves only after the held callback's promise settles, so
    // we resolve acquireLeadership() from inside the callback (lock granted)
    // and keep the callback pending until release() is called.
    void locks
      .request(LOCK_NAME, { mode: 'exclusive' }, () =>
        new Promise<void>((releaseHeld) => {
          _isLeader = true;
          _releaseLock = () => {
            _releaseLock = null;
            releaseHeld();
          };
          resolveAcquire(true);
        }),
      )
      .then(() => {
        // The held promise settled -> leadership released or lost.
        const wasLeader = _isLeader;
        _isLeader = false;
        _releaseLock = null;
        _acquiring = null;
        if (wasLeader) onLost();
      })
      .catch((err: unknown) => {
        _isLeader = false;
        _releaseLock = null;
        _acquiring = null;
        logger.warn('[mls][tab-lock] lock request failed', { error: (err as Error)?.message });
        resolveAcquire(false);
      });
  });

  return _acquiring;
}

/** True iff this tab currently holds MLS leadership. */
export function isLeader(): boolean {
  return _isLeader;
}

/**
 * Voluntarily release leadership (e.g. on lock()/logout). Settles the held
 * lock so another tab can take over. No-op if not leader.
 */
export function releaseLeadership(): void {
  if (_releaseLock) {
    _releaseLock();
  } else {
    _isLeader = false;
  }
}

/**
 * Run `fn` under an EXCLUSIVE navigator.locks lock named
 * 'howl-mls-provision', held ONLY for fn's duration (released when fn settles).
 * This single-flights identity mint + KeyPackage publish across tabs so a fresh
 * load and an in-flight unlock never mint two identities or double-publish.
 *
 * It is DISTINCT from the lifetime-held 'howl-mls-writer' lease (acquireLeadership):
 * the writer lease is held for the whole tab lifetime to elect one MLS writer; this
 * provision lock is short-lived per-operation. They never nest in a deadlocking way
 * because provisioning runs BEFORE/independent of the writer lease (boot provisioner
 * + bootstrapMlsIdentity), not inside the held callback.
 *
 * When navigator.locks is unavailable (older WebView, some test envs), run fn
 * directly (single-tab fallback) - never throw.
 */
export async function withProvisionLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = locksApi();
  if (!locks) {
    logger.warn('[mls][tab-lock] navigator.locks unavailable; running provision unsynced');
    return fn();
  }
  return locks.request(PROVISION_LOCK_NAME, { mode: 'exclusive' }, () => fn()) as Promise<T>;
}
