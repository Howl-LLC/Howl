// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Upload syncer for the cross-device MLS history archive.
 *
 * Drains unsynced local history rows (own-sent + received plaintext, archived by
 * the local history store) up to the server archive so a fresh device can
 * restore readable history. Design properties:
 *  - LEASE-GATED: only the single tab holding the history-sync lease drains, so
 *    tabs never race or duplicate uploads. onLost is a deliberate no-op (drains
 *    simply stop until the lease is re-acquired) — we never re-acquire from onLost,
 *    and stopHistorySync sets _active=false BEFORE releasing so the self-fired
 *    onLost can't restart a drain (see mlsHistoryLocks.releaseHistorySyncLease).
 *  - DEBOUNCED: local writes poke a 1.5s debounce; a 60s backstop catches anything
 *    missed; unlock triggers an eager drain.
 *  - BYTE + ITEM BOUNDED: batches cap at BATCH_MAX_ITEMS and BATCH_MAX_BYTES (under
 *    the 2mb route limit), with at least one row per batch even if it alone is large.
 *  - REKEY-INTERLOCKED: pauses while dmKeyManager reports a rekey in progress (the
 *    at-rest/history keys are mid-swap), resuming on the next trigger.
 *  - ABORT-NOT-SKIP on key change: the archiveKey is captured once at batch start
 *    (by Uint8Array IDENTITY — getArchiveKey returns the live module reference). A
 *    lock+unlock or rekey yields a NEW array → identity !== → the drain ABORTS
 *    (returns) rather than sealing some rows under the stale key. Unflipped rows stay
 *    unsynced and re-upload under the new key later (the server dedups on envelopeHash).
 *  - BACKS OFF on ANY upload throw (5xx/offline, or the client's synchronous
 *    rate-limit gate-throw which carries no .status), retrying after BACKOFF_MS.
 */
import * as mlsGroupStore from './mlsGroupStore';
import * as dmKeyManager from '../dmKeyManager';
import { sealArchiveRow } from '../dmCrypto';
import { apiClient } from '../api';
import { acquireHistorySyncLease, hasHistorySyncLease, releaseHistorySyncLease } from './mlsHistoryLocks';
import { logger } from '../logger';

const BATCH_MAX_ITEMS = 50;
const BATCH_MAX_BYTES = 1_700_000; // headroom under the 2mb route limit
const DEBOUNCE_MS = 1500;
const BACKSTOP_MS = 60_000;
const BACKOFF_MS = 30_000;
let _userId: string | null = null;
let _active = false;
let _running = false;
let _debounce: ReturnType<typeof setTimeout> | null = null;
let _backstop: ReturnType<typeof setInterval> | null = null;
let _backoffUntil = 0;

/**
 * Start the syncer for this user: acquire the lease, eager-drain, arm the backstop.
 *
 * `onLeaseAcquired` runs ONCE the lease is actually granted to THIS tab (the eager
 * DOWN-restore is lease-gated, so it must run here — not synchronously at the call
 * site). navigator.locks grants the lease asynchronously even when it is free, so
 * `hasHistorySyncLease()` is still false the instant startHistorySync returns;
 * driving the eager restore off this continuation is what makes it actually run on
 * a fresh/recovered device (where `mls-ready` fires only once, before the grant).
 */
export function startHistorySync(userId: string, onLeaseAcquired?: () => void): void {
  if (_active && _userId === userId) return;
  stopHistorySync();
  _backoffUntil = 0; // a deliberate (re)start is fresh intent — drop any stale backoff
  _userId = userId;
  _active = true;
  void acquireHistorySyncLease(() => {
    /* lease lost: drains simply no-op until re-acquired — never re-acquire here. */
  }).then((held) => {
    if (_active && held) {
      void drain();
      onLeaseAcquired?.(); // only the lease holder runs the eager restore (cross-tab dedupe)
    }
  });
  _backstop = setInterval(() => {
    if (_active) void drain();
  }, BACKSTOP_MS);
}

/** Stop the syncer: disarm timers and release the lease. _active is cleared FIRST
 *  so the self-fired onLost (from the deliberate release) is harmless. */
export function stopHistorySync(): void {
  _active = false;
  _userId = null;
  if (_debounce) {
    clearTimeout(_debounce);
    _debounce = null;
  }
  if (_backstop) {
    clearInterval(_backstop);
    _backstop = null;
  }
  releaseHistorySyncLease();
}

/** Debounced poke from local archive writes (dmActions send/edit). */
export function pokeHistorySync(): void {
  if (!_active) return;
  if (_debounce) clearTimeout(_debounce);
  _debounce = setTimeout(() => {
    void drain();
  }, DEBOUNCE_MS);
}

/** Eager drain (called on unlock). */
export function drainHistoryNow(): void {
  if (_active) void drain();
}

/** All gates that must hold for a drain to proceed. The archiveKey/historyKey null
 *  checks are the "locked" guard; the lease + rekey + backoff gates are the rest. */
function eligible(): boolean {
  return (
    _active &&
    hasHistorySyncLease() &&
    !dmKeyManager.isRekeyInProgress() &&
    dmKeyManager.isUnlocked() &&
    // Fail-closed: a tab behind the broadcast archiveKey generation must not re-seal under the stale (escrow-exposed) key.
    dmKeyManager.getArchiveKeyVersion() >= (_userId ? dmKeyManager.getMinAcceptableArchiveKeyVersion(_userId) : 1) &&
    dmKeyManager.getArchiveKey() !== null &&
    // Do not seal rows under a freshly-minted archiveKey whose re-persist failed;
    // the next unlock would mint a different key and orphan them (no keyVersion fallback).
    dmKeyManager.isArchiveKeyPersisted() &&
    mlsGroupStore.getHistoryKey() !== null &&
    Date.now() >= _backoffUntil
  );
}

/**
 * If this tab holds the history-sync lease but its archiveKey generation is
 * behind the broadcast floor (a sibling rotated to v2 and this stale tab
 * cannot reach it - e.g. it still holds the pre-disable passphrase and cannot decrypt
 * the rotated blob), release the lease so a v2-capable tab (the disabling tab, which
 * minted v2) can take over the re-seal. No-op when not the holder or not behind. The
 * released tab does not re-acquire (onLost is a deliberate no-op), so the lease
 * converges to a v2-capable holder rather than fail-closing forever.
 */
function releaseLeaseIfStale(): void {
  if (!_active || !_userId) return;
  if (hasHistorySyncLease() && dmKeyManager.getArchiveKeyVersion() < dmKeyManager.getMinAcceptableArchiveKeyVersion(_userId)) {
    logger.warn('[mls][history-sync] stale archiveKey generation under lease; releasing so a rotated tab can take over');
    releaseHistorySyncLease();
  }
}

/**
 * Re-arm the lease when this tab is otherwise able to sync but no longer holds
 * it. After a stale handoff, the released sibling never re-acquires (onLost
 * is a no-op) and the v2-capable tab that took over may close, orphaning the lease so
 * history sync silently stalls until a reload. So a CURRENT tab (at/above the broadcast
 * floor, unlocked, keys present) that finds itself leaseless re-queues for it. A STALE
 * tab (behind the floor) deliberately stays out so a v2-capable tab holds the lease.
 * acquireHistorySyncLease is idempotent + queues behind any current holder, so this is
 * safe to call on every drain; the lease-granted continuation kicks exactly one drain.
 */
function maybeReacquireLease(): void {
  if (!_active || !_userId) return;
  if (hasHistorySyncLease()) return;
  if (dmKeyManager.getArchiveKeyVersion() < dmKeyManager.getMinAcceptableArchiveKeyVersion(_userId)) return;
  if (!dmKeyManager.isUnlocked() || dmKeyManager.getArchiveKey() === null || mlsGroupStore.getHistoryKey() === null) return;
  void acquireHistorySyncLease(() => { /* lost: drains pause until re-acquired */ })
    .then((held) => { if (_active && held && hasHistorySyncLease()) void drain(); });
}

async function drain(): Promise<void> {
  if (_running) return;
  if (!eligible()) { releaseLeaseIfStale(); maybeReacquireLease(); return; }
  _running = true;
  try {
    const userId = _userId!;
    const keyBytes = dmKeyManager.getArchiveKey(); // captured once; compared by identity
    if (!keyBytes) return;

    for (;;) {
      // Abort-not-skip: re-check eligibility AND key identity each loop. A key change
      // (lock+unlock / rekey) yields a new Uint8Array → !== → abort without flipping.
      if (!eligible() || dmKeyManager.getArchiveKey() !== keyBytes) return;
      const rows = await mlsGroupStore.listUnsyncedHistory(BATCH_MAX_ITEMS);
      if (rows.length === 0) return;

      const batch: typeof rows = [];
      const items: Array<{
        dmChannelId: string;
        envelopeHash: string;
        ciphertext: string;
        keyVersion: number;
        messageId: string;
        msgCreatedAt: string;
      }> = [];
      let bytes = 0;
      // Single epoch for the whole batch: the seal AAD epoch and the wire
      // keyVersion MUST be the same value (restore unseals with
      // archiveEpoch: r.keyVersion), and the archiveKey generation is stable
      // for this batch (guarded above via getArchiveKey() === keyBytes). With
      // move-to-Private rotation this is dynamic per generation.
      const archiveEpoch = dmKeyManager.getArchiveKeyVersion();
      for (const r of rows) {
        const ciphertext = await sealArchiveRow(keyBytes, r.plaintext, {
          userId,
          dmChannelId: r.dmChannelId,
          messageId: r.messageId,
          envelopeHash: r.envHash,
          archiveEpoch,
        });
        const item = {
          dmChannelId: r.dmChannelId,
          envelopeHash: r.envHash,
          ciphertext,
          keyVersion: archiveEpoch,
          messageId: r.messageId,
          msgCreatedAt: new Date(r.msgCreatedAt).toISOString(),
        };
        const size = JSON.stringify(item).length;
        // Always include at least one row (the `batch.length > 0` guard); otherwise
        // stop before exceeding the byte budget or the item cap.
        if (batch.length > 0 && (bytes + size > BATCH_MAX_BYTES || batch.length >= BATCH_MAX_ITEMS)) break;
        batch.push(r);
        items.push(item);
        bytes += size;
        if (batch.length >= BATCH_MAX_ITEMS) break;
      }
      if (items.length === 0) return;

      try {
        await apiClient.postDmHistoryArchive(items);
      } catch (err) {
        // Back off on ANY throw: a 5xx/offline carries .status; the client's
        // synchronous rate-limit gate-throw carries .isRateLimit but no .status.
        const status = (err as { status?: number })?.status;
        _backoffUntil = Date.now() + BACKOFF_MS;
        logger.warn('[mls][history-sync] upload failed; will retry', { status });
        return;
      }

      // Re-check after the await: if the key changed during the POST, do NOT flip
      // (rows stay unsynced, re-upload under the new key later — no data loss).
      if (!eligible() || dmKeyManager.getArchiveKey() !== keyBytes) return;
      await mlsGroupStore.markHistorySynced(batch.map((r) => r.key));
    }
  } catch (err) {
    logger.warn('[mls][history-sync] drain error', { error: (err as Error)?.message });
  } finally {
    _running = false;
  }
}
