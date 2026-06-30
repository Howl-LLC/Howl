// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * The plaintext DM search index must be DELETED on EVERY session end, not
 * merely have its handle closed.
 *
 * The bug: the idle-lock / cross-tab-logout / server-session-expiry path
 * (preserveEncryption=true) scrubbed all key material but only called
 * closeDmSearchDB() for the search index, which closes the IndexedDB handle and
 * leaves every plaintext DM row on disk. On a shared/kiosk device a local
 * attacker (DevTools/IndexedDB or filesystem) then reads the prior session's
 * decrypted history with zero key material, and a same-user re-login auto-reloads
 * the surviving rows. The durable index is rebuildable from messages, so session
 * end must DELETE it (clearSearchIndex), matching the full-sign-out path and the
 * key scrub the same path already performs.
 *
 * teardownSearchIndexForSessionEnd() is the single contract both cleanupSession
 * branches now use; this exercises it via the real module against fake-indexeddb,
 * probing the RAW on-disk store (independent of the module's in-memory index).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import * as search from '../services/dmSearchIndex';
import * as mlsStore from '../services/mls/mlsGroupStore';
import type { Message } from '../types';

// At-rest content is AES-GCM ciphertext under the vault historyKey.
// Indexing fails closed (skips writes) while no key is installed, so every test
// that persists rows must install a key first (mirrors __tests__/dmSearchIndex.test.ts).
function installHistoryKey(): Promise<CryptoKey> {
  return crypto.subtle
    .generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    .then((k) => { mlsStore.setHistoryKey(k); return k; });
}

beforeEach(() => {
  // Fresh spec-compliant IndexedDB per test so on-disk state never leaks across tests.
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  mlsStore.setHistoryKey(null); // reset the at-rest key so each test controls it explicitly
});

afterEach(async () => {
  // Reset the module's in-memory globals (searchIndex / currentUserId / dbPromise).
  await search.clearSearchIndex().catch(() => {});
});

function mkMsg(id: string, content: string): Message {
  return {
    id,
    authorId: 'author-1',
    authorUsername: 'alice',
    content,
    timestamp: new Date('2026-06-20T12:00:00Z'),
    type: 'message',
  } as Message;
}

/** Count plaintext rows persisted on disk for a user, bypassing the module's
 *  in-memory index entirely (the actual exposure a shared-device attacker sees). */
async function rawDiskRowCount(userId: string): Promise<number> {
  // Open WITHOUT a fixed version/upgrade: OURS' production owns the schema at
  // DB_VERSION=2, and opening the existing DB at a lower version throws
  // VersionError. No version opens at the current version (or creates an empty
  // DB if production never created one). The at-rest `messages` rows are AES-GCM
  // ciphertext now, but a raw row count is still the exposure we probe.
  const db = await openDB(`howl-dm-search-${userId}`);
  const n = db.objectStoreNames.contains('messages') ? await db.count('messages') : 0;
  db.close();
  return n;
}

describe('DM search index is deleted on session end (no plaintext survives a key scrub)', () => {
  it('teardownSearchIndexForSessionEnd erases on-disk plaintext rows', async () => {
    const userId = 'user-teardown';
    await installHistoryKey();
    await search.initSearchIndex(userId);
    await search.indexDMMessages('chan-1', [mkMsg('m1', 'secret plaintext payload')]);
    expect(await rawDiskRowCount(userId)).toBe(1); // sanity: on disk before teardown

    await search.teardownSearchIndexForSessionEnd();

    // GREEN: 0 — the plaintext index was deleted, nothing survives the key scrub.
    // RED (pre-fix, closeDmSearchDB only): 1 — the row survives on disk.
    expect(await rawDiskRowCount(userId)).toBe(0);
  });

  it('full sign-out (clearSearchIndex) still erases the index', async () => {
    const userId = 'user-signout';
    await installHistoryKey();
    await search.initSearchIndex(userId);
    await search.indexDMMessages('chan-1', [mkMsg('m1', 'top secret')]);
    expect(await rawDiskRowCount(userId)).toBe(1);

    await search.clearSearchIndex();

    expect(await rawDiskRowCount(userId)).toBe(0);
  });

  it('the cleared index rebuilds lazily from re-loaded messages (UX self-heals)', async () => {
    const userId = 'user-rebuild';
    await installHistoryKey();
    await search.initSearchIndex(userId);
    await search.indexDMMessages('chan-1', [mkMsg('m1', 'findable secret')]);
    await search.teardownSearchIndexForSessionEnd();

    // Re-login, then re-open the DM channel (App re-indexes the decrypted batch).
    await installHistoryKey();
    await search.initSearchIndex(userId);
    expect(await rawDiskRowCount(userId)).toBe(0);
    await search.indexDMMessages('chan-1', [mkMsg('m1', 'findable secret')]);

    expect(search.searchDMMessages('findable').results.map((r) => r.id)).toContain('m1');
    expect(await rawDiskRowCount(userId)).toBe(1);
  });

  it('cross-user safety: after teardown, a different user has none of the prior user plaintext', async () => {
    await search.initSearchIndex('user-A');
    await search.indexDMMessages('chan-1', [mkMsg('m1', 'user A private')]);
    await search.teardownSearchIndexForSessionEnd();

    await search.initSearchIndex('user-B');
    expect(await rawDiskRowCount('user-A')).toBe(0);
    expect(await rawDiskRowCount('user-B')).toBe(0);
    expect(search.searchDMMessages('private').results).toHaveLength(0);
  });
});
