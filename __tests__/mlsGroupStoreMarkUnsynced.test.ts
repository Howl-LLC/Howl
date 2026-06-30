// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * mlsGroupStoreMarkUnsynced - move-to-Private archive re-seal trigger.
 *
 * Verifies markAllHistoryUnsynced(): after the archiveKey rotates, every history
 * row must be re-enumerated for upload so the syncer re-seals + re-uploads it
 * under the new key. The mutation flips every row's `synced` flag back to 0.
 *
 * Mirrors __tests__/mlsGroupStoreSync.test.ts: fake-indexeddb/auto, a fresh
 * IDBFactory + resetDbHandle() per test, a real AES-256-GCM historyKey.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import * as store from '../services/mls/mlsGroupStore';

async function makeKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const CH = '00000000-0000-4000-8000-0000000000a1';
const ENV = JSON.stringify({ v: 4, m: 'AAEAAg==' });
const ENV2 = JSON.stringify({ v: 4, m: 'Zm9v' });

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  store.__testHooks.resetDbHandle();
  store.setAtRestKey(null);
  store.setHistoryKey(null);
});
afterEach(() => {
  store.setAtRestKey(null);
  store.setHistoryKey(null);
  vi.restoreAllMocks();
});

describe('mlsGroupStore - markAllHistoryUnsynced (move-to-Private re-seal)', () => {
  it('flips every synced=1 row back to 0 so it re-enumerates for upload', async () => {
    store.setHistoryKey(await makeKey());

    // Put two rows, then mark them synced (= uploaded under the OLD archiveKey).
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    await store.putHistory(CH, { messageId: 'm2', plaintext: 'world', envelopeContent: ENV2 });
    const keys = (await store.listUnsyncedHistory(100)).map((r) => r.key);
    await store.markHistorySynced(keys);

    // Nothing pending: both are uploaded.
    expect(await store.listUnsyncedHistory(100)).toHaveLength(0);

    // archiveKey rotated - re-seal trigger.
    await store.markAllHistoryUnsynced();

    // Both rows must be pending upload again.
    expect(await store.listUnsyncedHistory(100)).toHaveLength(2);
  });

  it('with an active-channel allowlist, only re-arms rows for those channels (left-channel rows stay synced)', async () => {
    store.setHistoryKey(await makeKey());
    const CH_LEFT = '00000000-0000-4000-8000-0000000000b2';

    // An active-channel row and a left-(group-)DM row, both uploaded under the OLD key.
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    await store.putHistory(CH_LEFT, { messageId: 'm2', plaintext: 'left', envelopeContent: ENV2 });
    const keys = (await store.listUnsyncedHistory(100)).map((r) => r.key);
    await store.markHistorySynced(keys);
    expect(await store.listUnsyncedHistory(100)).toHaveLength(0);

    // Move-to-Private re-seal scoped to the channels the user is STILL in: the
    // left channel must NOT be re-armed (the server would 403 a non-participant
    // write and wedge the whole upload).
    await store.markAllHistoryUnsynced([CH]);

    const pending = await store.listUnsyncedHistory(100);
    expect(pending).toHaveLength(1);
    expect(pending[0].dmChannelId).toBe(CH);
  });

  it('an empty allowlist re-arms nothing (no active channels => no re-seal)', async () => {
    store.setHistoryKey(await makeKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    const keys = (await store.listUnsyncedHistory(100)).map((r) => r.key);
    await store.markHistorySynced(keys);

    await store.markAllHistoryUnsynced([]);

    expect(await store.listUnsyncedHistory(100)).toHaveLength(0);
  });
});
