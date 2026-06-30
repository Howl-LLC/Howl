// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * mlsHistoryRestore: the RESTORE side that pulls sealed archive rows
 * DOWN from the server and writes the AAD-verified plaintext into the local
 * history store so a fresh/recovered device can read a Saved DM's full history.
 *
 * Strategy mirrors __tests__/mlsHistoryArchiveSync.test.ts: mock the gate
 * dependencies (apiClient, dmKeyManager, mlsHistoryLocks, mlsCoordinator, logger)
 * but exercise the REAL mlsGroupStore against fake-indexeddb with a real
 * AES-256-GCM historyKey, and REAL crypto.subtle for the seal/open. Rows are
 * sealed in-test via sealArchiveRow under a KNOWN archiveKey so the AAD matches
 * what writeVerifiedRow recomputes; a MUTATED-AAD row proves rejection.
 *
 * No vi.resetModules(): the restore module imports the REAL mlsGroupStore, so
 * resetting modules would hand it a DIFFERENT store instance than this file's
 * top-level `store`. Module state (the dedupe sets) is reset via
 * resetHistoryRestore() between tests.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import * as store from '../services/mls/mlsGroupStore';
import * as restore from '../services/mls/mlsHistoryRestore';
import { sealArchiveRow } from '../services/dmCrypto';
import type { ArchiveRow } from '../services/api';

// Hoisted mock state (gate dependencies)
const mocks = vi.hoisted(() => ({
  getDmHistoryPreviews: vi.fn(),
  getDmHistoryForChannel: vi.fn(),
  getArchiveKey: vi.fn(),
  isUnlocked: vi.fn(),
  hasHistorySyncLease: vi.fn(),
  runWithChannelRestoreLock: vi.fn(),
  isReadyForChannel: vi.fn(),
  emitHistoryRestored: vi.fn(),
}));

vi.mock('../services/api', () => ({
  apiClient: {
    getDmHistoryPreviews: mocks.getDmHistoryPreviews,
    getDmHistoryForChannel: mocks.getDmHistoryForChannel,
  },
}));
vi.mock('../services/dmKeyManager', () => ({
  getArchiveKey: mocks.getArchiveKey,
  isUnlocked: mocks.isUnlocked,
}));
vi.mock('../services/mls/mlsHistoryLocks', () => ({
  hasHistorySyncLease: mocks.hasHistorySyncLease,
  // Run the fn directly (single-tab fallback shape).
  runWithChannelRestoreLock: mocks.runWithChannelRestoreLock,
}));
vi.mock('../services/mls/mlsCoordinator', () => ({
  isReadyForChannel: mocks.isReadyForChannel,
  emitHistoryRestored: mocks.emitHistoryRestored,
}));
vi.mock('../services/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const USER = '00000000-0000-4000-8000-0000000000f0';
const CH = '00000000-0000-4000-8000-0000000000a1';
// Arbitrary stable hex strings — restore treats envelopeHash as an opaque key (and
// AAD component); it is never recomputed, so any consistent value is fine here.
const ENV_HASH_1 = 'a'.repeat(64);
const ENV_HASH_2 = 'b'.repeat(64);

let archiveKeyBytes: Uint8Array;

async function makeHistoryKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Seal a row under the test's known archiveKey with the CORRECT AAD. */
async function sealRow(
  plaintext: string,
  envelopeHash: string,
  messageId: string,
  opts?: { aadMessageId?: string },
): Promise<ArchiveRow> {
  const ciphertext = await sealArchiveRow(archiveKeyBytes, plaintext, {
    userId: USER,
    dmChannelId: CH,
    // aadMessageId lets us seal under a DIFFERENT messageId than the row advertises,
    // producing a tampered/spliced row that openArchiveRow must reject.
    messageId: opts?.aadMessageId ?? messageId,
    envelopeHash,
    archiveEpoch: 1,
  });
  return { dmChannelId: CH, messageId, envelopeHash, ciphertext, keyVersion: 1, msgCreatedAt: new Date().toISOString() };
}

beforeEach(() => {
  restore.resetHistoryRestore(); // reset module dedupe state between tests
  globalThis.indexedDB = new IDBFactory();
  store.__testHooks.resetDbHandle();
  store.setAtRestKey(null);
  store.setHistoryKey(null);

  archiveKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  mocks.getDmHistoryPreviews.mockReset().mockResolvedValue({ rows: [], nextCursor: null });
  mocks.getDmHistoryForChannel.mockReset().mockResolvedValue({ rows: [], nextCursor: null });
  mocks.getArchiveKey.mockReset().mockReturnValue(archiveKeyBytes);
  mocks.isUnlocked.mockReset().mockReturnValue(true);
  mocks.hasHistorySyncLease.mockReset().mockReturnValue(true);
  mocks.isReadyForChannel.mockReset().mockReturnValue(true);
  mocks.emitHistoryRestored.mockReset();
  // Run the channel restore fn directly (single-tab fallback).
  mocks.runWithChannelRestoreLock.mockReset().mockImplementation(
    async (_ch: string, fn: () => Promise<void>) => { await fn(); },
  );
});

afterEach(() => {
  store.setAtRestKey(null);
  store.setHistoryKey(null);
  restore.resetHistoryRestore();
});

describe('mlsHistoryRestore — eager preview restore', () => {
  it('writes a verified preview row to local history and fires emitHistoryRestored(null)', async () => {
    store.setHistoryKey(await makeHistoryKey());
    const row = await sealRow('hello from another device', ENV_HASH_1, 'm1');
    mocks.getDmHistoryPreviews.mockResolvedValue({ rows: [row], nextCursor: null });

    await restore.runEagerPreviewRestore(USER);

    expect(await store.getHistory(CH, ENV_HASH_1)).toBe('hello from another device');
    expect(mocks.emitHistoryRestored).toHaveBeenCalledTimes(1);
    expect(mocks.emitHistoryRestored).toHaveBeenCalledWith({ dmChannelId: null });
  });

  it('on a transient previews GET failure the eager pass is un-marked so a later trigger retries', async () => {
    store.setHistoryKey(await makeHistoryKey());
    // First pass: the previews GET throws (offline at unlock). Must not throw out.
    mocks.getDmHistoryPreviews.mockRejectedValueOnce(new Error('offline'));
    await expect(restore.runEagerPreviewRestore(USER)).resolves.toBeUndefined();
    expect(mocks.getDmHistoryPreviews).toHaveBeenCalledTimes(1);

    // A later 'mls-ready' trigger (reconnect / auto-recovery) must RETRY rather
    // than stay stuck on lock-placeholder previews: the failure reset _eagerDone,
    // so the second call re-issues the GET and fills the previously-missed row.
    // (Without the fix _eagerDone stays true and this second call early-returns,
    // leaving getDmHistoryPreviews called only once.)
    const row = await sealRow('healed after reconnect', ENV_HASH_1, 'm1');
    mocks.getDmHistoryPreviews.mockResolvedValue({ rows: [row], nextCursor: null });
    await restore.runEagerPreviewRestore(USER);

    expect(mocks.getDmHistoryPreviews).toHaveBeenCalledTimes(2);
    expect(await store.getHistory(CH, ENV_HASH_1)).toBe('healed after reconnect');
  });

  it('REJECTS a row sealed under a mutated AAD (wrong messageId) — not written, does not throw', async () => {
    store.setHistoryKey(await makeHistoryKey());
    // The ciphertext is sealed with messageId 'EVIL' but the row advertises 'm1':
    // openArchiveRow recomputes AAD from the advertised 'm1' → tag mismatch → reject.
    const tampered = await sealRow('spliced payload', ENV_HASH_1, 'm1', { aadMessageId: 'EVIL' });
    mocks.getDmHistoryPreviews.mockResolvedValue({ rows: [tampered], nextCursor: null });

    await expect(restore.runEagerPreviewRestore(USER)).resolves.toBeUndefined();

    expect(await store.getHistory(CH, ENV_HASH_1)).toBeNull(); // never persisted
    expect(mocks.emitHistoryRestored).not.toHaveBeenCalled(); // nothing written → no emit
  });

  it('no-op when this tab does not hold the sync lease', async () => {
    store.setHistoryKey(await makeHistoryKey());
    mocks.hasHistorySyncLease.mockReturnValue(false);
    const row = await sealRow('hello', ENV_HASH_1, 'm1');
    mocks.getDmHistoryPreviews.mockResolvedValue({ rows: [row], nextCursor: null });

    await restore.runEagerPreviewRestore(USER);

    expect(mocks.getDmHistoryPreviews).not.toHaveBeenCalled();
    expect(await store.getHistory(CH, ENV_HASH_1)).toBeNull();
  });

  it('a restored row is marked synced=1 (the syncer will not re-upload it)', async () => {
    store.setHistoryKey(await makeHistoryKey());
    const row = await sealRow('restored', ENV_HASH_1, 'm1');
    mocks.getDmHistoryPreviews.mockResolvedValue({ rows: [row], nextCursor: null });

    await restore.runEagerPreviewRestore(USER);

    expect(await store.getHistory(CH, ENV_HASH_1)).toBe('restored');
    // listUnsyncedHistory enumerates synced=0 rows; a restored (synced=1) row is absent.
    const unsynced = await store.listUnsyncedHistory(100);
    expect(unsynced.find((r) => r.envHash === ENV_HASH_1)).toBeUndefined();
    expect(unsynced).toHaveLength(0);
  });

  it('only-if-absent: a pre-existing local row is NOT clobbered by restore', async () => {
    store.setHistoryKey(await makeHistoryKey());
    // Local own-sent row already present under this (channel, envelope).
    await store.putHistoryRestored(CH, { messageId: 'm1', plaintext: 'LOCAL original', envHash: ENV_HASH_1 });
    // Server advertises a DIFFERENT plaintext for the same (channel, envelope).
    const row = await sealRow('SERVER overwrite', ENV_HASH_1, 'm1');
    mocks.getDmHistoryPreviews.mockResolvedValue({ rows: [row], nextCursor: null });

    await restore.runEagerPreviewRestore(USER);

    expect(await store.getHistory(CH, ENV_HASH_1)).toBe('LOCAL original'); // not clobbered
  });
});

describe('mlsHistoryRestore — lazy per-channel restore', () => {
  it('fills the channel, fires emitHistoryRestored({dmChannelId}), and dedupes a second call', async () => {
    store.setHistoryKey(await makeHistoryKey());
    const r1 = await sealRow('msg one', ENV_HASH_1, 'm1');
    const r2 = await sealRow('msg two', ENV_HASH_2, 'm2');
    mocks.getDmHistoryForChannel.mockResolvedValue({ rows: [r1, r2], nextCursor: null });

    await restore.restoreChannelHistory(USER, CH);

    expect(await store.getHistory(CH, ENV_HASH_1)).toBe('msg one');
    expect(await store.getHistory(CH, ENV_HASH_2)).toBe('msg two');
    expect(mocks.emitHistoryRestored).toHaveBeenCalledWith({ dmChannelId: CH });
    expect(mocks.getDmHistoryForChannel).toHaveBeenCalledTimes(1);

    // Second call is deduped — no second GET.
    await restore.restoreChannelHistory(USER, CH);
    expect(mocks.getDmHistoryForChannel).toHaveBeenCalledTimes(1);
  });

  it('no-ops when isReadyForChannel is false; a later ready call still restores', async () => {
    store.setHistoryKey(await makeHistoryKey());
    const row = await sealRow('late', ENV_HASH_1, 'm1');
    mocks.getDmHistoryForChannel.mockResolvedValue({ rows: [row], nextCursor: null });

    mocks.isReadyForChannel.mockReturnValue(false);
    await restore.restoreChannelHistory(USER, CH);
    expect(mocks.getDmHistoryForChannel).not.toHaveBeenCalled();
    expect(await store.getHistory(CH, ENV_HASH_1)).toBeNull();

    // Channel becomes established — the same call now restores (not marked-restored).
    mocks.isReadyForChannel.mockReturnValue(true);
    await restore.restoreChannelHistory(USER, CH);
    expect(mocks.getDmHistoryForChannel).toHaveBeenCalledTimes(1);
    expect(await store.getHistory(CH, ENV_HASH_1)).toBe('late');
  });

  it('paginates across cursors until nextCursor is null', async () => {
    store.setHistoryKey(await makeHistoryKey());
    const r1 = await sealRow('page-one', ENV_HASH_1, 'm1');
    const r2 = await sealRow('page-two', ENV_HASH_2, 'm2');
    mocks.getDmHistoryForChannel
      .mockResolvedValueOnce({ rows: [r1], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ rows: [r2], nextCursor: null });

    await restore.restoreChannelHistory(USER, CH);

    expect(mocks.getDmHistoryForChannel).toHaveBeenCalledTimes(2);
    expect(mocks.getDmHistoryForChannel).toHaveBeenNthCalledWith(1, CH, undefined);
    expect(mocks.getDmHistoryForChannel).toHaveBeenNthCalledWith(2, CH, 'cursor-1');
    expect(await store.getHistory(CH, ENV_HASH_1)).toBe('page-one');
    expect(await store.getHistory(CH, ENV_HASH_2)).toBe('page-two');
  });

  it('OTR: returns immediately without calling getDmHistoryForChannel (OTR has no durable archive)', async () => {
    store.setHistoryKey(await makeHistoryKey());
    const row = await sealRow('should-not-restore', ENV_HASH_1, 'm1');
    mocks.getDmHistoryForChannel.mockResolvedValue({ rows: [row], nextCursor: null });

    await restore.restoreChannelHistory(USER, CH, 'otr');

    expect(mocks.getDmHistoryForChannel).not.toHaveBeenCalled();
    expect(await store.getHistory(CH, ENV_HASH_1)).toBeNull();
    expect(mocks.emitHistoryRestored).not.toHaveBeenCalled();
  });

  it('on a transient GET failure the channel is un-marked so a later call retries', async () => {
    store.setHistoryKey(await makeHistoryKey());
    mocks.getDmHistoryForChannel.mockRejectedValueOnce(new Error('offline'));

    await restore.restoreChannelHistory(USER, CH); // fails, un-marks, no emit
    expect(mocks.emitHistoryRestored).not.toHaveBeenCalled();

    // Retry succeeds.
    const row = await sealRow('retried', ENV_HASH_1, 'm1');
    mocks.getDmHistoryForChannel.mockResolvedValue({ rows: [row], nextCursor: null });
    await restore.restoreChannelHistory(USER, CH);
    expect(mocks.getDmHistoryForChannel).toHaveBeenCalledTimes(2);
    expect(await store.getHistory(CH, ENV_HASH_1)).toBe('retried');
  });
});

describe('mlsHistoryRestore — restoreActiveArchiveForRotation (move-to-Private full re-seal pre-pass)', () => {
  const CH_A = CH; // active channel A
  const CH_B = '00000000-0000-4000-8000-0000000000c3'; // active channel B
  const A_OLD = 'a'.repeat(64);
  const A_NEW = 'a'.repeat(63) + '2';
  const B_HASH = 'b'.repeat(64);

  /** Seal a row for an arbitrary channel under the test's known archiveKey. */
  async function sealForChannel(dmChannelId: string, plaintext: string, envelopeHash: string, messageId: string): Promise<ArchiveRow> {
    const ciphertext = await sealArchiveRow(archiveKeyBytes, plaintext, { userId: USER, dmChannelId, messageId, envelopeHash, archiveEpoch: 1 });
    return { dmChannelId, messageId, envelopeHash, ciphertext, keyVersion: 1, msgCreatedAt: new Date().toISOString() };
  }

  it('restores the FULL history of every active channel (not just previews) and returns the active channel set', async () => {
    store.setHistoryKey(await makeHistoryKey());
    const a1 = await sealForChannel(CH_A, 'A old', A_OLD, 'a1');
    const a2 = await sealForChannel(CH_A, 'A new', A_NEW, 'a2');
    const b1 = await sealForChannel(CH_B, 'B only', B_HASH, 'b1');
    // Previews carries the LATEST row per active channel (what a fresh device cached).
    mocks.getDmHistoryPreviews.mockResolvedValue({ rows: [a2, b1], nextCursor: null });
    mocks.getDmHistoryForChannel.mockImplementation(async (ch: string) =>
      ch === CH_A ? { rows: [a1, a2], nextCursor: null } : { rows: [b1], nextCursor: null });

    // Local store starts EMPTY (the device only ever saw previews).
    const result = await restore.restoreActiveArchiveForRotation(USER);

    expect(result.ok).toBe(true);
    expect([...result.channelIds].sort()).toEqual([CH_A, CH_B].sort());
    // FULL history is now local, including the older CH_A row previews never carried.
    expect(await store.getHistory(CH_A, A_OLD)).toBe('A old');
    expect(await store.getHistory(CH_A, A_NEW)).toBe('A new');
    expect(await store.getHistory(CH_B, B_HASH)).toBe('B only');
  });

  it('fails closed (ok=false) when a per-channel restore GET fails, so the caller leaves v1 intact', async () => {
    store.setHistoryKey(await makeHistoryKey());
    const a1 = await sealForChannel(CH_A, 'A', A_OLD, 'a1');
    mocks.getDmHistoryPreviews.mockResolvedValue({ rows: [a1], nextCursor: null });
    mocks.getDmHistoryForChannel.mockRejectedValue(new Error('offline'));

    const result = await restore.restoreActiveArchiveForRotation(USER);
    expect(result.ok).toBe(false);
  });

  it('a corrupt/unverifiable row is dropped without failing the whole rotation', async () => {
    store.setHistoryKey(await makeHistoryKey());
    const good = await sealForChannel(CH_A, 'good', A_OLD, 'a1');
    // Tampered: sealed under a different messageId than advertised -> AAD mismatch.
    const badCt = await sealArchiveRow(archiveKeyBytes, 'bad', { userId: USER, dmChannelId: CH_A, messageId: 'EVIL', envelopeHash: A_NEW, archiveEpoch: 1 });
    const bad: ArchiveRow = { dmChannelId: CH_A, messageId: 'a2', envelopeHash: A_NEW, ciphertext: badCt, keyVersion: 1, msgCreatedAt: new Date().toISOString() };
    mocks.getDmHistoryPreviews.mockResolvedValue({ rows: [good], nextCursor: null });
    mocks.getDmHistoryForChannel.mockResolvedValue({ rows: [good, bad], nextCursor: null });

    const result = await restore.restoreActiveArchiveForRotation(USER);
    expect(result.ok).toBe(true); // a corrupt row must not wedge move-to-Private forever
    expect(await store.getHistory(CH_A, A_OLD)).toBe('good');
    expect(await store.getHistory(CH_A, A_NEW)).toBeNull(); // dropped
  });

  it('getActiveArchiveChannelIds returns the distinct active-channel set from previews (uncapped, server-authoritative)', async () => {
    const a = await sealForChannel(CH_A, 'a', A_OLD, 'a1');
    const b = await sealForChannel(CH_B, 'b', B_HASH, 'b1');
    mocks.getDmHistoryPreviews
      .mockResolvedValueOnce({ rows: [a], nextCursor: 'p1' })
      .mockResolvedValueOnce({ rows: [b], nextCursor: null });

    const ids = await restore.getActiveArchiveChannelIds();

    expect([...ids].sort()).toEqual([CH_A, CH_B].sort());
    expect(mocks.getDmHistoryPreviews).toHaveBeenCalledTimes(2); // paginated, not the capped /dms list
  });

  it('getActiveArchiveChannelIds returns [] when the server archive is empty', async () => {
    mocks.getDmHistoryPreviews.mockResolvedValue({ rows: [], nextCursor: null });
    expect(await restore.getActiveArchiveChannelIds()).toEqual([]);
  });
});
