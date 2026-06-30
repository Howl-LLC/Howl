// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Client-anchored write-once deleted-message tombstones.
 *
 * A delete-for-everyone records a tombstone keyed by messageId; the archive
 * write/restore paths consult it so a deleted message can never be resurrected
 * (re-archived locally, or restored from a surviving server copy).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { IDBFactory } from 'fake-indexeddb';

import { createIdentity } from '../services/mls/mlsIdentity';
import { createGroup, currentEpoch } from '../services/mls/mlsEngine';
import * as store from '../services/mls/mlsGroupStore';

const CH = 'chan-1';
const MSG = 'msg-1';
const GID = 'group-1';

async function key(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function seedState() {
  const aik = nacl.sign.keyPair();
  const bundle = await createIdentity('00000000-0000-4000-8000-0000000000c1', randomUUID(), aik.publicKey, aik.secretKey);
  return createGroup(bundle.identity, GID);
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  store.__testHooks.resetDbHandle();
  store.setAtRestKey(await key());
  store.setHistoryKey(await key());
});
afterEach(() => {
  store.setHistoryKey(null);
  store.setAtRestKey(null);
});

describe('client tombstones', () => {
  it('deleteHistory writes a write-once tombstone even with no local rows', async () => {
    expect(await store.hasTombstone(CH, MSG)).toBe(false);
    await store.deleteHistory(CH, MSG); // no local rows for MSG on this device
    expect(await store.hasTombstone(CH, MSG)).toBe(true);
  });

  it('is idempotent: re-deleting keeps the tombstone', async () => {
    await store.deleteHistory(CH, MSG);
    await store.deleteHistory(CH, MSG);
    expect(await store.hasTombstone(CH, MSG)).toBe(true);
  });

  it('putHistory does NOT re-archive a tombstoned messageId (send/edit re-archive race)', async () => {
    await store.deleteHistory(CH, MSG);
    await store.putHistory(CH, { messageId: MSG, plaintext: 'late edit', envelopeContent: 'env-late' });
    expect(await store.getHistory(CH, await sha256Hex('env-late'))).toBeNull();
  });

  it('putHistory still archives a NON-tombstoned message (positive control)', async () => {
    await store.putHistory(CH, { messageId: 'live', plaintext: 'kept', envelopeContent: 'env-live' });
    expect(await store.getHistory(CH, await sha256Hex('env-live'))).toBe('kept');
  });

  it('putHistoryRestored is a no-op for a tombstoned messageId (no resurrection)', async () => {
    await store.deleteHistory(CH, MSG);
    await store.putHistoryRestored(CH, { messageId: MSG, plaintext: 'resurrected?', envHash: 'aa' });
    expect(await store.getHistory(CH, 'aa')).toBeNull();
  });

  it('putHistoryRestored writes a NON-tombstoned row (positive control)', async () => {
    await store.putHistoryRestored(CH, { messageId: 'm2', plaintext: 'restored', envHash: 'bb' });
    expect(await store.getHistory(CH, 'bb')).toBe('restored');
  });

  it('putGroupAndHistory persists the ratchet but DROPS plaintext for a tombstoned messageId', async () => {
    const state = await seedState();
    await store.deleteHistory(CH, MSG);
    await store.putGroupAndHistory(CH, GID, state, currentEpoch(state), {
      messageId: MSG, plaintext: 'should not survive', envHash: 'cc',
    });
    expect(await store.getHistory(CH, 'cc')).toBeNull(); // plaintext dropped
    expect(await store.getGroup(CH)).not.toBeNull();      // ratchet snapshot kept
  });

  it('clearAll wipes tombstones (full account reset)', async () => {
    await store.deleteHistory(CH, MSG);
    expect(await store.hasTombstone(CH, MSG)).toBe(true);
    await store.clearAll();
    expect(await store.hasTombstone(CH, MSG)).toBe(false);
  });
});
