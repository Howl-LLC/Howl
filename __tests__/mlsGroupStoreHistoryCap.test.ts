// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Synced-aware oldest-eviction MAX_HISTORY cap on the local readable-history
 * store. Eviction prefers already-uploaded rows (synced===1) and never silently
 * drops a synced===0 row that still owes an upload.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import * as store from '../services/mls/mlsGroupStore';

const CH = 'chan-1';

async function key(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let now = 1000;
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  store.__testHooks.resetDbHandle();
  store.setHistoryKey(await key());
  now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
  store.setHistoryKey(null);
  store.__testHooks.setMaxHistoryForTest(50_000); // restore production cap
});

describe('history cap', () => {
  it('evicts the oldest row (by updatedAt) when a new row crosses the cap', async () => {
    store.__testHooks.setMaxHistoryForTest(2);
    now = 1000; await store.putHistoryRestored(CH, { messageId: 'a', plaintext: 'A', envHash: 'a' });
    now = 2000; await store.putHistoryRestored(CH, { messageId: 'b', plaintext: 'B', envHash: 'b' });
    now = 3000; await store.putHistoryRestored(CH, { messageId: 'c', plaintext: 'C', envHash: 'c' }); // over cap → evict oldest

    expect(await store.getHistory(CH, 'a')).toBeNull(); // oldest evicted
    expect(await store.getHistory(CH, 'b')).toBe('B');
    expect(await store.getHistory(CH, 'c')).toBe('C');
  });

  it('prefers evicting synced rows over an older not-yet-uploaded (synced:0) row', async () => {
    store.__testHooks.setMaxHistoryForTest(2);
    // Oldest row is UNSYNCED (owes an upload); a newer row is synced.
    now = 1000; await store.putHistory(CH, { messageId: 'u', plaintext: 'unsynced', envelopeContent: 'envU' });
    now = 2000; await store.putHistoryRestored(CH, { messageId: 's1', plaintext: 'S1', envHash: 's1' });
    now = 3000; await store.putHistoryRestored(CH, { messageId: 's2', plaintext: 'S2', envHash: 's2' }); // over cap

    // The synced row (s1) is evicted even though the unsynced row is OLDER.
    expect(await store.getHistory(CH, 's1')).toBeNull();
    expect(await store.getHistory(CH, await sha256Hex('envU'))).toBe('unsynced'); // synced:0 survives
    expect(await store.getHistory(CH, 's2')).toBe('S2');
    // and the unsynced row is still pending upload
    const pending = await store.listUnsyncedHistory(10);
    expect(pending.map((r) => r.messageId)).toContain('u');
  });

  it('does not evict on an overwrite of an existing row (count unchanged)', async () => {
    store.__testHooks.setMaxHistoryForTest(2);
    now = 1000; await store.putHistory(CH, { messageId: 'x', plaintext: 'X', envelopeContent: 'envX' });
    now = 2000; await store.putHistory(CH, { messageId: 'y', plaintext: 'Y', envelopeContent: 'envY' });
    now = 3000; await store.putHistory(CH, { messageId: 'y', plaintext: 'Y2', envelopeContent: 'envY' }); // same envHash → overwrite

    expect(await store.getHistory(CH, await sha256Hex('envX'))).toBe('X'); // not evicted
    expect(await store.getHistory(CH, await sha256Hex('envY'))).toBe('Y2');
  });
});
