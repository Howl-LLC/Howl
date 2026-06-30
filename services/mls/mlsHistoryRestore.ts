// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * RESTORE side of the cross-device MLS history archive.
 *
 * Pulls sealed archive rows DOWN from the server and writes them into the local
 * history store so a fresh/recovered device can read a Saved DM's full history.
 * Two passes:
 *  - EAGER (unlock-time, lease holder only): the latest row per channel via
 *    GET /previews → local store, then a bulk emitHistoryRestored so sidebar
 *    previews + open chats heal. Lease-gated so tabs never duplicate the pass.
 *  - LAZY (on channel open, after the channel is established): the full
 *    per-channel restore via GET /:dmChannelId, under a per-channel restore lock
 *    (cross-tab dedupe) plus an in-session _restoredChannels set.
 *
 * Every row is AAD-verified via openArchiveRow before it is persisted; an
 * UNVERIFIED row is NEVER written (it falls back to live decrypt). The archiveKey
 * is the stable, recovery-surviving key (distinct from the historyKey that the
 * local at-rest archive uses), so restore works across a recover()/serverRecover().
 */
import * as mlsGroupStore from './mlsGroupStore';
import * as mlsCoordinator from './mlsCoordinator';
import * as dmKeyManager from '../dmKeyManager';
import { openArchiveRow } from '../dmCrypto';
import { apiClient, type ArchiveRow } from '../api';
import { runWithChannelRestoreLock, hasHistorySyncLease } from './mlsHistoryLocks';
import type { MlsTier } from './roomKey';
import { logger } from '../logger';

const _restoredChannels = new Set<string>(); // per-session lazy-restore dedupe
let _eagerDone = false;

/** Defense-in-depth: bound the cursor-driven restore loops so a buggy or
 *  malicious server that returns a never-null (or non-advancing) cursor cannot
 *  spin them forever. Far above any realistic history (previews page = 500
 *  channels, channel page = 200 rows → 5M channels / 2M messages), so a
 *  legitimate restore never hits it; if it ever does we log and stop (no silent
 *  truncation), and the next trigger resumes from the local store's gaps. */
const MAX_RESTORE_PAGES = 10_000;

/** Reset per-session restore dedupe (call on lock/logout). */
export function resetHistoryRestore(): void {
  _restoredChannels.clear();
  _eagerDone = false;
}

/** The stable archiveKey RAW bytes (HKDF over them derives the deterministic per-row
 *  IV; openArchiveRow imports the AES-GCM key internally). */
function archiveKeyBytes(): Uint8Array | null {
  return dmKeyManager.getArchiveKey();
}

async function writeVerifiedRow(userId: string, archiveKey: Uint8Array, r: ArchiveRow): Promise<boolean> {
  // A message deleted-for-everyone on this device is never restored. Cheap
  // pre-check to skip the decrypt; putHistoryRestored re-checks in-tx (authoritative).
  if (await mlsGroupStore.hasTombstone(r.dmChannelId, r.messageId)) return false;
  let plaintext: string;
  try {
    plaintext = await openArchiveRow(archiveKey, r.ciphertext, {
      userId, dmChannelId: r.dmChannelId, messageId: r.messageId, envelopeHash: r.envelopeHash,
      archiveEpoch: r.keyVersion,
    });
  } catch {
    return false; // AAD/tag failure — never persist an unverified row (falls back to live decrypt)
  }
  try {
    await mlsGroupStore.putHistoryRestored(r.dmChannelId, { messageId: r.messageId, plaintext, envHash: r.envelopeHash });
    return true;
  } catch {
    return false; // locked / quota — best-effort
  }
}

/** Eager unlock-time pass (lease holder only): latest row per channel → local store,
 *  then signal a bulk restore so the sidebar previews + open chats heal.
 *  OTR rooms are never restored here: the server excludes OTR rows from GET /previews
 *  (no durable archive), so the response keyed into the store never contains them. */
export async function runEagerPreviewRestore(userId: string): Promise<void> {
  if (_eagerDone || !hasHistorySyncLease()) return;
  if (!dmKeyManager.isUnlocked() || dmKeyManager.getArchiveKey() === null || mlsGroupStore.getHistoryKey() === null) return;
  _eagerDone = true;
  const archiveKey = archiveKeyBytes();
  if (!archiveKey) return;
  let cursor: string | undefined;
  let wrote = false;
  let pages = 0;
  try {
    do {
      if (!dmKeyManager.isUnlocked()) return;
      if (++pages > MAX_RESTORE_PAGES) { logger.warn('[mls][history-restore] eager previews hit page cap; stopping', { pages }); break; }
      const page = await apiClient.getDmHistoryPreviews(cursor);
      for (const row of page.rows) { if (await writeVerifiedRow(userId, archiveKey, row)) wrote = true; }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  } catch (err) {
    // Transient failure (offline at unlock, 5xx, rate-limit): allow the next
    // 'mls-ready' trigger (reconnect / auto-recovery) to retry the eager pass
    // instead of leaving previews stuck as lock placeholders until a reload.
    // Mirrors the lazy path's _restoredChannels.delete-on-failure. A page-cap
    // break (not an error) intentionally leaves _eagerDone=true (no retry).
    _eagerDone = false;
    logger.warn('[mls][history-restore] eager previews failed', { error: (err as Error)?.message });
  }
  if (wrote) mlsCoordinator.emitHistoryRestored({ dmChannelId: null }); // bulk → refreshDmPreviews + sweepAll
}

/** Lazy full restore for one channel (opening tab). Ordering: channel must be
 *  established (isReadyForChannel) FIRST, then fill, then fire the re-render. */
export async function restoreChannelHistory(userId: string, dmChannelId: string, tier: MlsTier = 'saved'): Promise<void> {
  if (tier === 'otr') return; // OTR has no durable archive
  if (_restoredChannels.has(dmChannelId)) return;
  if (!mlsCoordinator.isReadyForChannel(dmChannelId)) return; // not established yet — caller retries on ready
  if (!dmKeyManager.isUnlocked() || dmKeyManager.getArchiveKey() === null || mlsGroupStore.getHistoryKey() === null) return;
  _restoredChannels.add(dmChannelId);
  await runWithChannelRestoreLock(dmChannelId, async () => {
    const archiveKey = archiveKeyBytes();
    if (!archiveKey) { _restoredChannels.delete(dmChannelId); return; }
    let cursor: string | undefined;
    let wrote = false;
    let pages = 0;
    try {
      do {
        if (!dmKeyManager.isUnlocked()) return;
        if (++pages > MAX_RESTORE_PAGES) { logger.warn('[mls][history-restore] channel restore hit page cap; stopping', { dmChannelId, pages }); break; }
        const page = await apiClient.getDmHistoryForChannel(dmChannelId, cursor);
        for (const row of page.rows) { if (await writeVerifiedRow(userId, archiveKey, row)) wrote = true; }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    } catch (err) {
      _restoredChannels.delete(dmChannelId); // allow a retry on transient failure
      logger.warn('[mls][history-restore] channel restore failed', { error: (err as Error)?.message });
      return;
    }
    if (wrote) mlsCoordinator.emitHistoryRestored({ dmChannelId }); // per-channel → sweepChannel + previews
  });
}

/**
 * Move-to-Private - restore the caller's ENTIRE active archive into the local store
 * under the CURRENT archiveKey, so the disabling device holds a complete plaintext copy
 * BEFORE the archiveKey is rotated and the server archive is wiped + re-sealed. Without
 * this pre-pass the destructive re-seal would re-upload only whatever the lazy
 * per-channel restore happened to have cached (often just previews), silently destroying
 * server-side history for channels the device never opened.
 *
 * Active channels are enumerated via GET /previews, which already EXCLUDES channels the
 * caller has left (pendingRemoval). Left-group rows are therefore neither restored nor
 * re-sealed (they cannot be: the server 403s a non-participant archive write); the
 * caller drops them with the bulk wipe. Returns the active channel id set (used to scope
 * the re-arm) and `ok` = whether EVERY readable row was restored, so the caller fails
 * closed (skips the destructive rotation, leaves v1 intact) on any transient failure.
 *
 * NOT lease-gated (unlike the eager pass): IndexedDB is shared across tabs, so filling it
 * here serves whichever tab later holds the sync lease and runs the re-upload. A row that
 * fails AAD verification is corrupt/unreadable (never readable history) so it is dropped
 * and logged, NOT treated as a failure - else one bad row would wedge move-to-Private
 * forever. A persist failure (locked/quota) IS a failure (a readable row would be lost).
 */
/**
 * Move-to-Private - the server-authoritative set of ACTIVE channels that have archive
 * rows, from GET /previews (which excludes channels the caller has left / pendingRemoval).
 * Uncapped (cursor-paginated) and read from the SERVER, NOT the client DM store - so it is
 * neither truncated (the /dms list caps at 50) nor empty-because-not-loaded. Used to scope
 * the re-seal re-arm to exactly the channels whose history is re-uploaded, so a left
 * channel is never re-sent (the server 403s a non-participant write and would wedge the
 * whole batch) and NO active channel is ever missed (which would lose its server history
 * to the bulk DELETE with no re-upload). Throws on a network failure so the caller can
 * fail-closed rather than scope to an empty/partial set.
 */
export async function getActiveArchiveChannelIds(): Promise<string[]> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    // Fail-closed on the cap (like the network-error path): returning a PARTIAL set would
    // let the caller re-arm fewer channels than the bulk delete wipes. Unreachable for any
    // real user (cap = 10000 pages); a hit means an adversarial/buggy non-advancing cursor.
    if (++pages > MAX_RESTORE_PAGES) { logger.warn('[mls][history-restore] active-channel scan hit page cap', { pages }); throw new Error('active-channel scan exceeded page cap'); }
    const page = await apiClient.getDmHistoryPreviews(cursor);
    for (const row of page.rows) ids.add(row.dmChannelId);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return [...ids];
}

export async function restoreActiveArchiveForRotation(userId: string): Promise<{ ok: boolean; channelIds: string[] }> {
  if (!dmKeyManager.isUnlocked() || dmKeyManager.getArchiveKey() === null) return { ok: false, channelIds: [] };
  const archiveKey = archiveKeyBytes();
  if (!archiveKey) return { ok: false, channelIds: [] };

  // 1) Enumerate active channels (previews excludes left/pendingRemoval channels).
  let channelIds: string[];
  try {
    channelIds = await getActiveArchiveChannelIds();
  } catch (err) {
    logger.warn('[mls][history-restore] rotation previews failed', { error: (err as Error)?.message });
    return { ok: false, channelIds: [] };
  }

  // 2) Full-restore every active channel under the CURRENT archiveKey.
  let ok = true;
  let unverifiable = 0;
  for (const dmChannelId of channelIds) {
    let chCursor: string | undefined;
    let chPages = 0;
    try {
      do {
        if (!dmKeyManager.isUnlocked()) return { ok: false, channelIds: [...channelIds] };
        if (++chPages > MAX_RESTORE_PAGES) { logger.warn('[mls][history-restore] rotation channel hit page cap; stopping', { dmChannelId, chPages }); ok = false; break; }
        const page = await apiClient.getDmHistoryForChannel(dmChannelId, chCursor);
        for (const r of page.rows) {
          let plaintext: string;
          try {
            plaintext = await openArchiveRow(archiveKey, r.ciphertext, {
              userId, dmChannelId: r.dmChannelId, messageId: r.messageId, envelopeHash: r.envelopeHash, archiveEpoch: r.keyVersion,
            });
          } catch { unverifiable++; continue; } // corrupt/tampered — never readable history, safe to drop
          try {
            await mlsGroupStore.putHistoryRestored(r.dmChannelId, { messageId: r.messageId, plaintext, envHash: r.envelopeHash });
          } catch { ok = false; } // locked/quota — a readable row could not be persisted; fail closed
        }
        chCursor = page.nextCursor ?? undefined;
      } while (chCursor);
    } catch (err) {
      logger.warn('[mls][history-restore] rotation channel restore failed', { dmChannelId, error: (err as Error)?.message });
      ok = false;
    }
  }
  if (unverifiable > 0) logger.warn('[mls][history-restore] rotation skipped unverifiable rows', { unverifiable });
  return { ok, channelIds: [...channelIds] };
}
