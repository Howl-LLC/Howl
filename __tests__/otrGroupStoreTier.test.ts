// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * mlsGroupStore — tier-aware coexistence (OTR).
 *
 * A DM channel can hold TWO MLS groups: tier='saved' (bare dmChannelId key) and
 * tier='otr' (`${id}#otr` key). This pins:
 *  - put under both room keys → getGroup returns DISTINCT states (no clobber);
 *  - getGroupIdToChannelMap returns the richer { roomKey, channelId, tier } entry;
 *  - a pre-OTR Saved row (no channelId/tier fields) reads back as tier 'saved'
 *    with channelId defaulting to the key;
 *  - deleteGroup(otrRoomKey) removes ONLY the OTR row.
 *
 * Reuses the mlsGroupStore harness (fake-indexeddb + at-rest key setup).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import nacl from 'tweetnacl';

import { createIdentity } from '../services/mls/mlsIdentity';
import { createGroup, currentEpoch, encodeState } from '../services/mls/mlsEngine';
import { roomKey } from '../services/mls/roomKey';
import * as store from '../services/mls/mlsGroupStore';

async function makeAtRestKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const CH = '00000000-0000-4000-8000-0000000000a1';
const GID_SAVED = '00000000-0000-4000-8000-0000000000b1';
const GID_OTR = '00000000-0000-4000-8000-0000000000b2';

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

describe('mlsGroupStore — tier-aware Saved + OTR coexistence', () => {
  it('a Saved group and an OTR group coexist per channel (no clobber)', async () => {
    store.setAtRestKey(await makeAtRestKey());

    const bSavedAik = nacl.sign.keyPair();
    const bSaved = await createIdentity('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1', bSavedAik.publicKey, bSavedAik.secretKey);
    const sSaved = await createGroup(bSaved.identity, GID_SAVED);
    const bOtrAik = nacl.sign.keyPair();
    const bOtr = await createIdentity('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000d2', bOtrAik.publicKey, bOtrAik.secretKey);
    const sOtr = await createGroup(bOtr.identity, GID_OTR, 'otr');

    // Saved under the bare id (default opts), OTR under `${id}#otr` with tier/channelId.
    await store.putGroup(roomKey(CH, 'saved'), GID_SAVED, sSaved, currentEpoch(sSaved));
    await store.putGroup(roomKey(CH, 'otr'), GID_OTR, sOtr, currentEpoch(sOtr), { channelId: CH, tier: 'otr' });

    const savedLoaded = await store.getGroup(CH);
    const otrLoaded = await store.getGroup(`${CH}#otr`);

    expect(savedLoaded).not.toBeNull();
    expect(otrLoaded).not.toBeNull();
    // Distinct rows, distinct groupIds — neither write clobbered the other.
    expect(savedLoaded!.meta.dmChannelId).toBe(CH);
    expect(savedLoaded!.meta.groupId).toBe(GID_SAVED);
    expect(otrLoaded!.meta.dmChannelId).toBe(`${CH}#otr`);
    expect(otrLoaded!.meta.groupId).toBe(GID_OTR);
    // States re-encode to their OWN distinct snapshots.
    expect(encodeState(savedLoaded!.state)).toEqual(encodeState(sSaved));
    expect(encodeState(otrLoaded!.state)).toEqual(encodeState(sOtr));
  });

  it('getGroupIdToChannelMap returns rich { roomKey, channelId, tier } entries for both tiers', async () => {
    store.setAtRestKey(await makeAtRestKey());

    const bSavedAik = nacl.sign.keyPair();
    const bSaved = await createIdentity('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-0000000000d3', bSavedAik.publicKey, bSavedAik.secretKey);
    const sSaved = await createGroup(bSaved.identity, GID_SAVED);
    const bOtrAik = nacl.sign.keyPair();
    const bOtr = await createIdentity('00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000d4', bOtrAik.publicKey, bOtrAik.secretKey);
    const sOtr = await createGroup(bOtr.identity, GID_OTR, 'otr');

    await store.putGroup(roomKey(CH, 'saved'), GID_SAVED, sSaved, currentEpoch(sSaved));
    await store.putGroup(roomKey(CH, 'otr'), GID_OTR, sOtr, currentEpoch(sOtr), { channelId: CH, tier: 'otr' });

    const map = await store.getGroupIdToChannelMap();
    expect(map.size).toBe(2);
    expect(map.get(GID_SAVED)).toEqual({ roomKey: CH, channelId: CH, tier: 'saved' });
    expect(map.get(GID_OTR)).toEqual({ roomKey: `${CH}#otr`, channelId: CH, tier: 'otr' });
  });

  it('a pre-OTR Saved row (no channelId/tier fields) reads back as tier "saved", channelId=key', async () => {
    const key = await makeAtRestKey();
    store.setAtRestKey(key);

    const bAik = nacl.sign.keyPair();
    const b = await createIdentity('00000000-0000-4000-8000-0000000000c5', '00000000-0000-4000-8000-0000000000d5', bAik.publicKey, bAik.secretKey);
    const state = await createGroup(b.identity, GID_SAVED);
    const snapshot = encodeState(state);
    // Hand-write a legacy Saved row WITHOUT channelId/tier (pre-OTR on-disk shape).
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(snapshot));
    // Prime the v7 schema so the `groups` store exists before the raw write.
    await store.listGroupChannelIds();
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('howl_mls', 7);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('groups', 'readwrite');
        tx.objectStore('groups').put({
          dmChannelId: CH,
          groupId: GID_SAVED,
          encryptedSnapshot: ct,
          iv: iv.buffer,
          lastAppliedEpoch: currentEpoch(state).toString(),
          updatedAt: Date.now(),
          // no channelId, no tier
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    store.__testHooks.resetDbHandle();
    store.setAtRestKey(key);

    // getGroup decodes under the defaulted tier 'saved' and round-trips.
    const loaded = await store.getGroup(CH);
    expect(loaded).not.toBeNull();
    expect(encodeState(loaded!.state)).toEqual(snapshot);

    // The map defaults the absent fields: channelId → key, tier → 'saved'.
    const map = await store.getGroupIdToChannelMap();
    expect(map.get(GID_SAVED)).toEqual({ roomKey: CH, channelId: CH, tier: 'saved' });
  });

  it('deleteGroup(otrRoomKey) removes ONLY the OTR row; the Saved row survives', async () => {
    store.setAtRestKey(await makeAtRestKey());

    const bSavedAik = nacl.sign.keyPair();
    const bSaved = await createIdentity('00000000-0000-4000-8000-0000000000c6', '00000000-0000-4000-8000-0000000000d6', bSavedAik.publicKey, bSavedAik.secretKey);
    const sSaved = await createGroup(bSaved.identity, GID_SAVED);
    const bOtrAik = nacl.sign.keyPair();
    const bOtr = await createIdentity('00000000-0000-4000-8000-0000000000c7', '00000000-0000-4000-8000-0000000000d7', bOtrAik.publicKey, bOtrAik.secretKey);
    const sOtr = await createGroup(bOtr.identity, GID_OTR, 'otr');

    await store.putGroup(roomKey(CH, 'saved'), GID_SAVED, sSaved, currentEpoch(sSaved));
    await store.putGroup(roomKey(CH, 'otr'), GID_OTR, sOtr, currentEpoch(sOtr), { channelId: CH, tier: 'otr' });

    await store.deleteGroup(roomKey(CH, 'otr'));

    expect(await store.getGroup(`${CH}#otr`)).toBeNull();
    const savedLoaded = await store.getGroup(CH);
    expect(savedLoaded).not.toBeNull();
    expect(savedLoaded!.meta.groupId).toBe(GID_SAVED);
  });
});
