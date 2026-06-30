// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * The DM search index must not persist decrypted DM plaintext at rest. The
 * stored `content` is AES-GCM ciphertext under the vault historyKey;
 * reads decrypt under that key and fail closed (empty results) while locked
 * (historyKey null). On lock the in-memory MiniSearch is dropped + the DB handle
 * closed; on unlock the index is rebuilt by decrypting the store.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

import * as store from '../services/mls/mlsGroupStore';
// dmSearchIndex is dynamically imported per the app's code-splitting pattern.

async function key(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

describe('dmSearchIndex at-rest encryption', () => {
  beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });

  it('does not persist decrypted plaintext in IndexedDB', async () => {
    const hk = await key();
    store.setHistoryKey(hk);
    const idx = await import('../services/dmSearchIndex');
    await idx.initSearchIndex('user-1');
    await idx.indexDMMessages('chan-1', [{
      id: 'm1', dmChannelId: 'chan-1', authorId: 'a', authorUsername: 'alice',
      content: 'SECRETPLAINTEXTTOKEN', timestamp: new Date(),
    } as any]);

    const { openDB } = await import('idb');
    const db = await openDB('howl-dm-search-user-1');
    const raw = await db.get('messages', 'm1');
    expect(JSON.stringify(raw)).not.toContain('SECRETPLAINTEXTTOKEN');

    // searchDmMessagesHybrid is SYNCHRONOUS and returns { instant: DMSearchResponse; fetchOlder }.
    // The in-memory MiniSearch hits live at .instant.results (not the top level).
    const { instant } = idx.searchDmMessagesHybrid('SECRETPLAINTEXTTOKEN');
    expect(instant.results.some((r: any) => r.id === 'm1')).toBe(true); // searchable while unlocked
  });

  it('returns no results while locked (historyKey null) and again after unlock', async () => {
    const hk = await key();
    store.setHistoryKey(hk);
    const idx = await import('../services/dmSearchIndex');
    await idx.initSearchIndex('user-2');
    await idx.indexDMMessages('chan-1', [{
      id: 'm2', dmChannelId: 'chan-1', authorId: 'a', authorUsername: 'alice',
      content: 'FINDME', timestamp: new Date(),
    } as any]);

    store.setHistoryKey(null); // simulate idle-lock
    await idx.onLocked();      // drop in-memory MiniSearch + close handle
    const locked = idx.searchDmMessagesHybrid('FINDME');
    expect(locked.instant.results).toEqual([]);       // in-memory surface dropped
    expect(await locked.fetchOlder()).toEqual([]);    // IDB scan fails closed (historyKey null)

    store.setHistoryKey(hk);   // unlock
    await idx.onUnlocked('user-2'); // rebuild MiniSearch by decrypting the store
    const { instant } = idx.searchDmMessagesHybrid('FINDME');
    expect(instant.results.some((r: any) => r.id === 'm2')).toBe(true);
  });

  it('re-seals edited content at rest (updateMessageInIndex never persists new plaintext)', async () => {
    const hk = await key();
    store.setHistoryKey(hk);
    const idx = await import('../services/dmSearchIndex');
    await idx.initSearchIndex('user-3');
    // Seed the row the way production does (addMessageToIndex on arrival), then
    // exercise the real edit path (message-edited → updateMessageInIndex(id, newContent)).
    await idx.addMessageToIndex('chan-1', {
      id: 'm3', dmChannelId: 'chan-1', authorId: 'a', authorUsername: 'alice',
      content: 'ORIGINALTOKEN', timestamp: new Date(),
    } as any);
    await idx.updateMessageInIndex('m3', 'NEWSECRETTOKEN');

    // At rest the edited row must be ciphertext — the new plaintext must not appear.
    const { openDB } = await import('idb');
    const db = await openDB('howl-dm-search-user-3');
    const raw = await db.get('messages', 'm3');
    expect(JSON.stringify(raw)).not.toContain('NEWSECRETTOKEN');

    // The edited content is searchable while unlocked (in-memory MiniSearch updated).
    const { instant } = idx.searchDmMessagesHybrid('NEWSECRETTOKEN');
    expect(instant.results.some((r: any) => r.id === 'm3')).toBe(true);
  });
});
