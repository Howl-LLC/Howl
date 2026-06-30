// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * mlsHistoryArchiveSync: the lease-gated, debounced, byte-batched
 * upload syncer that drains unsynced local history rows to the server archive.
 *
 * Strategy: mock the gate dependencies (apiClient, dmKeyManager, mlsHistoryLocks,
 * logger) but exercise the REAL mlsGroupStore against fake-indexeddb with a real
 * AES-256-GCM historyKey, and REAL crypto.subtle for the seal. This proves the
 * end-to-end shape: real rows in → sealed items POSTed → markHistorySynced flips
 * them, and the sealed ciphertext round-trips back to plaintext under the captured
 * archiveKey + recomputed AAD.
 *
 * Mirrors __tests__/mlsGroupStoreSync.test.ts: fake-indexeddb/auto, a fresh
 * IDBFactory + resetDbHandle() per test, a real historyKey.
 *
 * IMPORTANT: we do NOT use vi.resetModules(). The syncer dynamically imports the
 * REAL mlsGroupStore; resetting modules would hand it a DIFFERENT store instance
 * than this file's top-level `store`, so the historyKey set here would be invisible
 * to the syncer (no POST). Instead the syncer is imported once and its module state
 * is reset between tests via stopHistorySync().
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import * as store from '../services/mls/mlsGroupStore';
import * as sync from '../services/mls/mlsHistoryArchiveSync';
import { openArchiveRow } from '../services/dmCrypto';

// Hoisted mock state (gate dependencies)
const mocks = vi.hoisted(() => ({
  postDmHistoryArchive: vi.fn(),
  getArchiveKey: vi.fn(),
  getArchiveKeyVersion: vi.fn(),
  getMinAcceptableArchiveKeyVersion: vi.fn(() => 1),
  isArchiveKeyPersisted: vi.fn(),
  isRekeyInProgress: vi.fn(),
  isUnlocked: vi.fn(),
  hasHistorySyncLease: vi.fn(),
  acquireHistorySyncLease: vi.fn(),
  releaseHistorySyncLease: vi.fn(),
}));

vi.mock('../services/api', () => ({
  apiClient: { postDmHistoryArchive: mocks.postDmHistoryArchive },
}));
vi.mock('../services/dmKeyManager', () => ({
  getArchiveKey: mocks.getArchiveKey,
  getArchiveKeyVersion: mocks.getArchiveKeyVersion,
  getMinAcceptableArchiveKeyVersion: mocks.getMinAcceptableArchiveKeyVersion,
  isArchiveKeyPersisted: mocks.isArchiveKeyPersisted,
  isRekeyInProgress: mocks.isRekeyInProgress,
  isUnlocked: mocks.isUnlocked,
}));
vi.mock('../services/mls/mlsHistoryLocks', () => ({
  acquireHistorySyncLease: mocks.acquireHistorySyncLease,
  hasHistorySyncLease: mocks.hasHistorySyncLease,
  releaseHistorySyncLease: mocks.releaseHistorySyncLease,
}));
vi.mock('../services/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const USER = '00000000-0000-4000-8000-0000000000f0';
const CH = '00000000-0000-4000-8000-0000000000a1';
const ENV = JSON.stringify({ v: 4, m: 'AAEAAg==' });
const ENV2 = JSON.stringify({ v: 4, m: 'Zm9v' });

async function makeHistoryKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// The fire-and-forget drain chains many awaits (importKey, listUnsyncedHistory,
// per-row sealArchiveRow, post, markHistorySynced) and loops over batches, so a
// single macrotask is not enough to settle it. Pump the macrotask queue until a
// predicate holds (or a bounded number of turns elapse). For the no-op cases the
// predicate never fires, so we drain the full turn budget — still ~instant.
async function settle(predicate: () => boolean | Promise<boolean>, turns = 200): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

// Drain a fixed number of macrotask turns — for the no-op cases where there is no
// positive signal to await; we pump enough turns that any drain would have run.
async function pump(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
}

// Default gates: unlocked, lease held, no rekey, stable archive key.
let archiveKeyBytes: Uint8Array;

beforeEach(() => {
  sync.stopHistorySync(); // reset syncer module state (active/userId/timers) between tests
  globalThis.indexedDB = new IDBFactory();
  store.__testHooks.resetDbHandle();
  store.setAtRestKey(null);
  store.setHistoryKey(null);

  archiveKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  mocks.postDmHistoryArchive.mockReset().mockResolvedValue({ stored: 0 });
  mocks.getArchiveKey.mockReset().mockReturnValue(archiveKeyBytes);
  mocks.getArchiveKeyVersion.mockReset().mockReturnValue(1);
  mocks.getMinAcceptableArchiveKeyVersion.mockReset().mockReturnValue(1);
  mocks.isArchiveKeyPersisted.mockReset().mockReturnValue(true);
  mocks.isRekeyInProgress.mockReset().mockReturnValue(false);
  mocks.isUnlocked.mockReset().mockReturnValue(true);
  mocks.hasHistorySyncLease.mockReset().mockReturnValue(true);
  // acquire resolves true (holder); onLost captured but never fired in unit env.
  mocks.acquireHistorySyncLease.mockReset().mockResolvedValue(true);
  mocks.releaseHistorySyncLease.mockReset();
});

afterEach(() => {
  sync.stopHistorySync();
  store.setAtRestKey(null);
  store.setHistoryKey(null);
});

describe('mlsHistoryArchiveSync — upload drain', () => {
  it('drains two unsynced rows: POSTs sealed items, flips them synced', async () => {
    store.setHistoryKey(await makeHistoryKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    await store.putHistory(CH, { messageId: 'm2', plaintext: 'world', envelopeContent: ENV2 });

    sync.startHistorySync(USER);
    sync.drainHistoryNow();
    await settle(() => mocks.postDmHistoryArchive.mock.calls.length >= 1);

    expect(mocks.postDmHistoryArchive).toHaveBeenCalledTimes(1);
    const items = mocks.postDmHistoryArchive.mock.calls[0][0];
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(it.dmChannelId).toBe(CH);
      expect(typeof it.ciphertext).toBe('string');
      expect(it.keyVersion).toBe(1);
      expect(typeof it.msgCreatedAt).toBe('string');
      // ISO timestamp
      expect(new Date(it.msgCreatedAt).toISOString()).toBe(it.msgCreatedAt);
    }

    // Rows are now synced — a later list is empty (poll: the flip lands after POST).
    await settle(async () => (await store.listUnsyncedHistory(100)).length === 0);
    expect(await store.listUnsyncedHistory(100)).toHaveLength(0);

    sync.stopHistorySync();
  });

  it('the POSTed ciphertext round-trips to the original plaintext under the captured key + AAD', async () => {
    store.setHistoryKey(await makeHistoryKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'top secret', envelopeContent: ENV });

    sync.startHistorySync(USER);
    sync.drainHistoryNow();
    await settle(() => mocks.postDmHistoryArchive.mock.calls.length >= 1);

    const items = mocks.postDmHistoryArchive.mock.calls[0][0];
    expect(items).toHaveLength(1);
    const item = items[0];

    // Decrypt with the captured RAW archive key bytes and the recomputed AAD (incl. epoch).
    const plaintext = await openArchiveRow(archiveKeyBytes, item.ciphertext, {
      userId: USER,
      dmChannelId: item.dmChannelId,
      messageId: item.messageId,
      envelopeHash: item.envelopeHash,
      archiveEpoch: item.keyVersion,
    });
    expect(plaintext).toBe('top secret');
    expect(item.envelopeHash).toBe(await sha256Hex(ENV));

    sync.stopHistorySync();
  });

  it('no-op when getArchiveKey() is null (locked) — no POST', async () => {
    store.setHistoryKey(await makeHistoryKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    mocks.getArchiveKey.mockReturnValue(null);

    sync.startHistorySync(USER);
    sync.drainHistoryNow();
    await pump();

    expect(mocks.postDmHistoryArchive).not.toHaveBeenCalled();
    sync.stopHistorySync();
  });

  it('no-op when the archiveKey is not yet durably persisted — no POST (would orphan rows)', async () => {
    store.setHistoryKey(await makeHistoryKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    // Freshly-minted archiveKey whose re-persist failed: present in memory but not in
    // the server blob. Sealing now would orphan the rows (next unlock mints a new key).
    mocks.isArchiveKeyPersisted.mockReturnValue(false);

    sync.startHistorySync(USER);
    sync.drainHistoryNow();
    await pump();

    expect(mocks.postDmHistoryArchive).not.toHaveBeenCalled();
    sync.stopHistorySync();
  });

  it('no-op when the history key is locked (getHistoryKey null) — no POST', async () => {
    // Put a row under a key, then clear the history key (locked). Row is undrainable.
    store.setHistoryKey(await makeHistoryKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    store.setHistoryKey(null);

    sync.startHistorySync(USER);
    sync.drainHistoryNow();
    await pump();

    expect(mocks.postDmHistoryArchive).not.toHaveBeenCalled();
    sync.stopHistorySync();
  });

  it('no-op when hasHistorySyncLease() is false — no POST', async () => {
    store.setHistoryKey(await makeHistoryKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    mocks.hasHistorySyncLease.mockReturnValue(false);

    sync.startHistorySync(USER);
    sync.drainHistoryNow();
    await pump();

    expect(mocks.postDmHistoryArchive).not.toHaveBeenCalled();
    sync.stopHistorySync();
  });

  // Move-to-Private fail-close: a sibling tab whose local archiveKey generation is
  // BEHIND the broadcast minimum (another tab rotated to v2) must NOT drain, or it
  // would re-seal DM history under its stale, escrow-exposed key at keyVersion=1.
  it('fail-closes (no POST) when local archiveKeyVersion is behind the broadcast minimum', async () => {
    store.setHistoryKey(await makeHistoryKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    // This tab is still on v1; a sibling broadcast the rotated v2 minimum.
    mocks.getArchiveKeyVersion.mockReturnValue(1);
    mocks.getMinAcceptableArchiveKeyVersion.mockReturnValue(2);

    sync.startHistorySync(USER);
    sync.drainHistoryNow();
    await pump();

    expect(mocks.postDmHistoryArchive).not.toHaveBeenCalled();

    // Once this tab catches up to v2, the drain proceeds.
    mocks.getArchiveKeyVersion.mockReturnValue(2);
    sync.drainHistoryNow();
    await settle(() => mocks.postDmHistoryArchive.mock.calls.length >= 1);
    expect(mocks.postDmHistoryArchive).toHaveBeenCalledTimes(1);

    sync.stopHistorySync();
  });

  it('pauses while isRekeyInProgress() is true; resumes after it clears', async () => {
    store.setHistoryKey(await makeHistoryKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    mocks.isRekeyInProgress.mockReturnValue(true);

    sync.startHistorySync(USER);
    sync.drainHistoryNow();
    await pump();
    expect(mocks.postDmHistoryArchive).not.toHaveBeenCalled();

    // Rekey done — a new drain posts.
    mocks.isRekeyInProgress.mockReturnValue(false);
    sync.drainHistoryNow();
    await settle(() => mocks.postDmHistoryArchive.mock.calls.length >= 1);
    expect(mocks.postDmHistoryArchive).toHaveBeenCalledTimes(1);

    sync.stopHistorySync();
  });

  it('byte/item-batches: 60 rows produce >=2 POSTs, each <=50 items', async () => {
    store.setHistoryKey(await makeHistoryKey());
    for (let i = 0; i < 60; i++) {
      const env = JSON.stringify({ v: 4, m: `row-${i}` });
      await store.putHistory(CH, { messageId: `m${i}`, plaintext: `payload ${i}`, envelopeContent: env });
    }

    sync.startHistorySync(USER);
    sync.drainHistoryNow();
    await settle(async () => (await store.listUnsyncedHistory(1000)).length === 0);

    expect(mocks.postDmHistoryArchive.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of mocks.postDmHistoryArchive.mock.calls) {
      expect(call[0].length).toBeLessThanOrEqual(50);
    }
    // All 60 ultimately synced.
    expect(await store.listUnsyncedHistory(1000)).toHaveLength(0);

    sync.stopHistorySync();
  });

  it('on a POST rejection rows stay unsynced; a later drain retries', async () => {
    store.setHistoryKey(await makeHistoryKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    mocks.postDmHistoryArchive.mockRejectedValueOnce(
      Object.assign(new Error('offline'), { status: 503 }),
    );

    sync.startHistorySync(USER);
    sync.drainHistoryNow();
    await settle(() => mocks.postDmHistoryArchive.mock.calls.length >= 1);
    await pump(); // let the catch/backoff settle

    // POST attempted, but rejected — row NOT flipped.
    expect(mocks.postDmHistoryArchive).toHaveBeenCalledTimes(1);
    expect(await store.listUnsyncedHistory(100)).toHaveLength(1);

    sync.stopHistorySync();
  });

  // Regression guard: the eager DOWN-restore is lease-gated, and navigator.locks
  // grants the lease ASYNCHRONOUSLY even when it is free. Calling
  // runEagerPreviewRestore() synchronously right after startHistorySync() would no-op
  // (the lease is not yet held) and never retry, leaving a fresh device with blank
  // previews. startHistorySync invokes onLeaseAcquired from the lease-granted
  // continuation instead.
  it('invokes onLeaseAcquired AFTER the lease is granted, never synchronously', async () => {
    let grant!: (held: boolean) => void;
    mocks.acquireHistorySyncLease.mockReset().mockImplementation(
      () => new Promise<boolean>((resolve) => { grant = resolve; }),
    );
    const onLeaseAcquired = vi.fn();

    sync.startHistorySync(USER, onLeaseAcquired);
    await pump(3); // lease still pending → callback must NOT have fired
    expect(onLeaseAcquired).not.toHaveBeenCalled();

    grant(true); // lease granted → callback fires on the continuation
    await settle(() => onLeaseAcquired.mock.calls.length >= 1);
    expect(onLeaseAcquired).toHaveBeenCalledTimes(1);

    sync.stopHistorySync();
  });

  it('does not invoke onLeaseAcquired when the lease is denied (held=false)', async () => {
    mocks.acquireHistorySyncLease.mockReset().mockResolvedValue(false);
    const onLeaseAcquired = vi.fn();

    sync.startHistorySync(USER, onLeaseAcquired);
    await pump(5);

    expect(onLeaseAcquired).not.toHaveBeenCalled();
    sync.stopHistorySync();
  });
});

describe('mlsHistoryArchiveSync - move-to-Private stale-generation lease handoff', () => {
  it('releases the lease (and never uploads) when this holder is behind the broadcast archiveKey generation', async () => {
    store.setHistoryKey(await makeHistoryKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    // A sibling rotated the archiveKey to v2; this lease holder is still at v1 and can
    // never reach v2 (stale passphrase -> cannot decrypt the rotated blob). It must
    // fail-close AND release so the v2-capable disabling tab can take over the re-seal.
    mocks.getArchiveKeyVersion.mockReturnValue(1);
    mocks.getMinAcceptableArchiveKeyVersion.mockReturnValue(2);
    mocks.hasHistorySyncLease.mockReturnValue(true);

    sync.startHistorySync(USER);
    mocks.releaseHistorySyncLease.mockClear(); // ignore the release from startHistorySync's internal stop
    sync.drainHistoryNow();
    await settle(() => mocks.releaseHistorySyncLease.mock.calls.length >= 1);

    expect(mocks.releaseHistorySyncLease).toHaveBeenCalled();
    expect(mocks.postDmHistoryArchive).not.toHaveBeenCalled(); // never sealed under the stale key
    sync.stopHistorySync();
  });

  it('does NOT release the lease when the generation is current (>= the broadcast floor)', async () => {
    store.setHistoryKey(await makeHistoryKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    // This holder IS at the rotated generation -> drains normally, keeps the lease.
    mocks.getArchiveKeyVersion.mockReturnValue(2);
    mocks.getMinAcceptableArchiveKeyVersion.mockReturnValue(2);
    mocks.hasHistorySyncLease.mockReturnValue(true);

    sync.startHistorySync(USER);
    mocks.releaseHistorySyncLease.mockClear();
    sync.drainHistoryNow();
    await settle(() => mocks.postDmHistoryArchive.mock.calls.length >= 1);

    expect(mocks.postDmHistoryArchive).toHaveBeenCalled();
    expect(mocks.releaseHistorySyncLease).not.toHaveBeenCalled();
    sync.stopHistorySync();
  });
});

describe('mlsHistoryArchiveSync - move-to-Private: re-arm the lease after a stale handoff', () => {
  it('re-acquires the lease on a later drain when a current tab finds itself leaseless (the prior v2 holder closed)', async () => {
    store.setHistoryKey(await makeHistoryKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    // Current generation, unlocked, keys present - but this tab does NOT hold the lease
    // (a stale sibling released it; the v2-capable tab took over and then closed). Without
    // a re-arm the lease is orphaned and history sync silently stalls until a full reload.
    mocks.getArchiveKeyVersion.mockReturnValue(2);
    mocks.getMinAcceptableArchiveKeyVersion.mockReturnValue(2);
    mocks.hasHistorySyncLease.mockReturnValue(false);

    sync.startHistorySync(USER);
    mocks.acquireHistorySyncLease.mockClear(); // ignore the initial acquire from startHistorySync
    sync.drainHistoryNow();
    await settle(() => mocks.acquireHistorySyncLease.mock.calls.length >= 1);

    expect(mocks.acquireHistorySyncLease).toHaveBeenCalled();
    sync.stopHistorySync();
  });

  it('does NOT re-acquire while behind the broadcast floor (a stale tab must stay out so a v2-capable tab holds it)', async () => {
    store.setHistoryKey(await makeHistoryKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    mocks.getArchiveKeyVersion.mockReturnValue(1); // stale
    mocks.getMinAcceptableArchiveKeyVersion.mockReturnValue(2);
    mocks.hasHistorySyncLease.mockReturnValue(false);

    sync.startHistorySync(USER);
    mocks.acquireHistorySyncLease.mockClear();
    sync.drainHistoryNow();
    await pump();

    expect(mocks.acquireHistorySyncLease).not.toHaveBeenCalled();
    sync.stopHistorySync();
  });
});
