// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * mlsGroupStoreSync — cross-device history sync-state machinery.
 *
 * Verifies the local sync-state layer added on top of the history archive:
 *  - the numeric `synced` flag (0 = not uploaded, 1 = uploaded) and its index,
 *  - preserve-on-overwrite of `synced` in both history writers,
 *  - listUnsyncedHistory / markHistorySynced / putHistoryRestored,
 *  - the v3 -> v4 upgrade that stamps pre-existing unflagged rows synced=0,
 *  - the blocking()/terminated() reopen handlers (no InvalidStateError after a
 *    sibling tab's upgrade closes our connection).
 *
 * Mirrors __tests__/mlsGroupStore.test.ts: fake-indexeddb/auto, a fresh
 * IDBFactory + resetDbHandle() per test, a real AES-256-GCM historyKey.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { IDBFactory } from 'fake-indexeddb';

import { createIdentity } from '../services/mls/mlsIdentity';
import { createGroup, currentEpoch } from '../services/mls/mlsEngine';
import * as store from '../services/mls/mlsGroupStore';

async function makeKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const CH = '00000000-0000-4000-8000-0000000000a1';
const GID = '00000000-0000-4000-8000-0000000000b1';

// A representative v4 MLS envelope string (what the send path passes as
// envelopeContent / what the read path hashes). The bytes inside `m` are opaque.
const ENV = JSON.stringify({ v: 4, m: 'AAEAAg==' });
const ENV2 = JSON.stringify({ v: 4, m: 'Zm9v' });

// Canonical envelope hash — byte-identical to mlsGroupStore's private sha256Hex.
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// Raw getAll on the history store, bypassing the module (to inspect synced flags).
function rawHistory(): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('howl_mls');
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('history', 'readonly');
      const req = tx.objectStore('history').getAll();
      req.onsuccess = () => {
        resolve(req.result);
        db.close();
      };
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  });
}

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

describe('mlsGroupStore — history sync state', () => {
  it('putHistory writes a row synced=0; listUnsyncedHistory returns it', async () => {
    store.setHistoryKey(await makeKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });

    const unsynced = await store.listUnsyncedHistory(100);
    expect(unsynced).toHaveLength(1);
    expect(unsynced[0].dmChannelId).toBe(CH);
    expect(unsynced[0].messageId).toBe('m1');
    expect(unsynced[0].plaintext).toBe('hello');
    expect(unsynced[0].envHash).toBe(await sha256Hex(ENV));
    expect(unsynced[0].key).toBe(`${CH}:${await sha256Hex(ENV)}`);
    expect(typeof unsynced[0].msgCreatedAt).toBe('number');

    // Raw row carries the numeric flag (NOT a boolean).
    const raw = await rawHistory();
    expect(raw).toHaveLength(1);
    expect(raw[0].synced).toBe(0);
  });

  it('a same-envelope re-put after markHistorySynced PRESERVES synced=1', async () => {
    store.setHistoryKey(await makeKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    const key = `${CH}:${await sha256Hex(ENV)}`;
    await store.markHistorySynced([key]);

    // Sanity: now synced, so not enumerated.
    expect(await store.listUnsyncedHistory(100)).toHaveLength(0);

    // Re-put the SAME (channel, envelope) — must NOT reset synced back to 0.
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });

    const raw = await rawHistory();
    expect(raw).toHaveLength(1);
    expect(raw[0].synced).toBe(1);
    expect(await store.listUnsyncedHistory(100)).toHaveLength(0);
  });

  it('putGroupAndHistory preserves synced=1 on a same-envelope overwrite', async () => {
    store.setAtRestKey(await makeKey());
    store.setHistoryKey(await makeKey());
    const aik = nacl.sign.keyPair();
    const bundle = await createIdentity('00000000-0000-4000-8000-0000000000c1', randomUUID(), aik.publicKey, aik.secretKey);
    const state = await createGroup(bundle.identity, GID);
    await store.putGroupAndHistory(CH, GID, state, currentEpoch(state), {
      messageId: 'm1', plaintext: 'hi', envHash: 'h-orig',
    });
    await store.markHistorySynced([`${CH}:h-orig`]);

    // Same envHash overwrite (e.g. a re-decrypt of the same envelope).
    await store.putGroupAndHistory(CH, GID, state, currentEpoch(state), {
      messageId: 'm1', plaintext: 'hi', envHash: 'h-orig',
    });

    const raw = await rawHistory();
    const row = raw.find((r) => r.envHash === 'h-orig');
    expect(row.synced).toBe(1);
  });

  it('markHistorySynced is a no-op for a key deleted mid-flight (no resurrection)', async () => {
    store.setHistoryKey(await makeKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'hello', envelopeContent: ENV });
    const key = `${CH}:${await sha256Hex(ENV)}`;

    // Concurrent "delete for everyone" drops the row before the upload completes.
    await store.deleteHistory(CH, 'm1');

    await store.markHistorySynced([key]);

    // The row must NOT be resurrected.
    expect(await store.listUnsyncedHistory(100)).toHaveLength(0);
    expect(await rawHistory()).toHaveLength(0);
  });

  it('putHistoryRestored writes a synced=1 row keyed by a supplied envHash', async () => {
    store.setHistoryKey(await makeKey());
    const envHash = 'restored-hash-aaa';
    await store.putHistoryRestored(CH, { messageId: 'm-restored', plaintext: 'from server', envHash });

    expect(await store.getHistory(CH, envHash)).toBe('from server');
    const raw = await rawHistory();
    expect(raw).toHaveLength(1);
    expect(raw[0].synced).toBe(1);
    expect(raw[0].envHash).toBe(envHash);
    // A restored row is already uploaded — never re-enumerated for upload.
    expect(await store.listUnsyncedHistory(100)).toHaveLength(0);
  });

  it('putHistoryRestored is only-if-absent (never clobbers a local row)', async () => {
    store.setHistoryKey(await makeKey());
    // A local own-sent row exists first, unsynced.
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'local original', envelopeContent: ENV });
    const envHash = await sha256Hex(ENV);

    // A restore for the SAME (channel, envHash) must NOT overwrite it.
    await store.putHistoryRestored(CH, { messageId: 'm1', plaintext: 'server override', envHash });

    expect(await store.getHistory(CH, envHash)).toBe('local original');
    const raw = await rawHistory();
    expect(raw).toHaveLength(1);
    // Local row stays unsynced (still pending upload) — restore did not touch it.
    expect(raw[0].synced).toBe(0);
  });

  it('listUnsyncedHistory returns [] when the history key is locked', async () => {
    store.setHistoryKey(null);
    expect(await store.listUnsyncedHistory(100)).toEqual([]);
  });

  it('listUnsyncedHistory honors the bounded limit', async () => {
    store.setHistoryKey(await makeKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'a', envelopeContent: ENV });
    await store.putHistory(CH, { messageId: 'm2', plaintext: 'b', envelopeContent: ENV2 });
    expect(await store.listUnsyncedHistory(1)).toHaveLength(1);
    expect(await store.listUnsyncedHistory(100)).toHaveLength(2);
  });

  it('v3->v4 upgrade stamps pre-existing unflagged history rows synced=0', async () => {
    // Open a v3 DB directly and write a raw history row WITHOUT a `synced` flag,
    // exactly as the v3 writers produced it. Then reopen via getDb() (which
    // requests v4) and confirm the upgrade stamped the row and it enumerates.
    const historyKey = await makeKey();

    // Build a real encrypted-at-rest history row at v3 shape so listUnsyncedHistory
    // can decrypt it. Encrypt the plaintext with the same key we install below.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      historyKey,
      new TextEncoder().encode('legacy plaintext'),
    );
    const envHash = 'legacy-env-hash';
    const v3Row = {
      key: `${CH}:${envHash}`,
      dmChannelId: CH,
      messageId: 'legacy-m1',
      envHash,
      iv: iv.buffer,
      encryptedPlaintext: ct,
      updatedAt: 1700000000000,
      // NOTE: no `synced` field — this is exactly the v3 row shape.
    };

    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('howl_mls', 3);
      open.onupgradeneeded = () => {
        const db = open.result;
        const h = db.createObjectStore('history', { keyPath: 'key' });
        h.createIndex('dmChannelId', 'dmChannelId');
        h.createIndex('messageId', 'messageId');
      };
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('history', 'readwrite');
        tx.objectStore('history').put(v3Row);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });

    // Now reopen via the module — DB_VERSION is 4, so the upgrade fires and stamps.
    // listUnsyncedHistory drives getDb() (the upgrade runs) and reads via the index.
    store.__testHooks.resetDbHandle();
    store.setHistoryKey(historyKey);

    const unsynced = await store.listUnsyncedHistory(100);
    expect(unsynced).toHaveLength(1);
    expect(unsynced[0].messageId).toBe('legacy-m1');
    expect(unsynced[0].plaintext).toBe('legacy plaintext');

    // The pre-existing row was stamped synced=0 by the v4 upgrade.
    const raw = await rawHistory();
    expect(raw).toHaveLength(1);
    expect(raw[0].synced).toBe(0);
  });

  it('reopens transparently after the blocking handler closes our connection', async () => {
    store.setAtRestKey(await makeKey());
    store.setHistoryKey(await makeKey());

    // Open + write so we hold a live connection.
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'first', envelopeContent: ENV });

    // Simulate a reloaded tab forcing an upgrade: close our connection out from
    // under the module the same way the blocking() handler does, and null the
    // cached promise. (We use the exposed close path so the test doesn't reach
    // into module internals beyond the documented test hook.)
    await store.__testHooks.simulateBlockingForTest();

    // A subsequent read/write must succeed via transparent reopen — never throw
    // InvalidStateError off a dead cached handle.
    await expect(
      store.putHistory(CH, { messageId: 'm2', plaintext: 'second', envelopeContent: ENV2 }),
    ).resolves.toBeUndefined();
    expect(await store.getHistory(CH, await sha256Hex(ENV))).toBe('first');
    expect(await store.getHistory(CH, await sha256Hex(ENV2))).toBe('second');
  });
});
