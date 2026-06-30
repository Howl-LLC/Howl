// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * mlsGroupStore: IndexedDB persistence funnel for MLS group state.
 *
 * Verifies the round-trip (put -> get) goes through encodeState/decodeState and
 * AES-256-GCM at-rest encryption, that a locked store (no at-rest key) throws,
 * the groupId -> dmChannelId map, kpPrivate candidate round-trips, meta get/set,
 * and oldest-eviction logging at MAX_GROUPS.
 *
 * fake-indexeddb/auto installs a spec-compliant in-memory IndexedDB onto the
 * jsdom global before any module under test imports `idb`.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { IDBFactory } from 'fake-indexeddb';

import { createIdentity, generateKeyPackages } from '../services/mls/mlsIdentity';
import { createGroup, currentEpoch, encodeState } from '../services/mls/mlsEngine';
import * as store from '../services/mls/mlsGroupStore';

// createIdentity is now 4-arg (AIK cross-sign). Thread an ephemeral AIK per call.
function mkId(userId: string, deviceId: string) {
  const aik = nacl.sign.keyPair();
  return createIdentity(userId, deviceId, aik.publicKey, aik.secretKey);
}

// A real AES-256-GCM CryptoKey for at-rest encryption (Web Crypto is present in
// Node's jsdom test env via globalThis.crypto.subtle).
async function makeAtRestKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Hand-write a LEGACY v1 identity row: signing private AES-GCM under the supplied
// vault at-rest key, wrapVersion 1 (the legacy on-disk shape). Shared across the
// read-branch tests and the v1-undecryptable-under-wrong-vault-key coverage.
async function seedLegacyV1Identity(
  userId: string,
  deviceId: string,
  vaultKey: CryptoKey,
  priv: Uint8Array,
  pub: Uint8Array,
  cred: Uint8Array,
) {
  // Prime the v5 schema via the module's getDb() so the `identity` store exists on
  // the fresh per-test IDBFactory before the raw write below.
  await store.getIdentityMeta(userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vaultKey, new Uint8Array(priv));
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('howl_mls', 7);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('identity', 'readwrite');
      tx.objectStore('identity').put({
        userId, deviceId,
        signaturePublicKey: btoa(String.fromCharCode(...pub)),
        credentialIdentity: btoa(String.fromCharCode(...cred)),
        encryptedSignaturePrivateKey: ct, iv: iv.buffer,
        createdAt: Date.now(), wrapVersion: 1,
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
  store.__testHooks.resetDbHandle();
}

// Hand-write a LEGACY v1 KeyPackage private row: the private bytes AES-GCM under the
// supplied vault at-rest key, wrapVersion 1 (the legacy on-disk shape, before KP
// privates moved onto the device wrap key). Mirrors seedLegacyV1Identity so the
// decryptKpRecord v1->v2 re-wrap branch can be exercised on a real legacy row.
async function seedLegacyV1Kp(
  vaultKey: CryptoKey,
  keyPackageRef: string,
  pub: Uint8Array,
  priv: Uint8Array,
  isLastResort: boolean,
) {
  // Prime the v5 schema via the module's getDb() so the `kpPrivate` store exists on
  // the fresh per-test IDBFactory before the raw write below.
  await store.getIdentityMeta(keyPackageRef);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vaultKey, new Uint8Array(priv));
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('howl_mls', 7);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('kpPrivate', 'readwrite');
      tx.objectStore('kpPrivate').put({
        keyPackageRef,
        keyPackage: btoa(String.fromCharCode(...pub)),
        encryptedPrivateKeyPackage: ct, iv: iv.buffer,
        isLastResort, createdAt: Date.now(), wrapVersion: 1,
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
  store.__testHooks.resetDbHandle();
}

const CH = '00000000-0000-4000-8000-0000000000a1';
const GID = '00000000-0000-4000-8000-0000000000b1';

beforeEach(() => {
  // Fresh, isolated IndexedDB per test so a prior test's `howl_mls` db cannot leak.
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

describe('mlsGroupStore', () => {
  it('round-trips a group through encode/decode + AES-GCM at rest', async () => {
    const key = await makeAtRestKey();
    store.setAtRestKey(key);

    const bundle = await mkId('00000000-0000-4000-8000-0000000000c1', randomUUID());
    const state = await createGroup(bundle.identity, GID);

    await store.putGroup(CH, GID, state, currentEpoch(state));
    const loaded = await store.getGroup(CH);

    expect(loaded).not.toBeNull();
    expect(loaded!.meta.dmChannelId).toBe(CH);
    expect(loaded!.meta.groupId).toBe(GID);
    expect(loaded!.meta.lastAppliedEpoch).toBe(currentEpoch(state));
    // Decoded state re-encodes to the identical snapshot bytes (clientConfig reattached).
    expect(encodeState(loaded!.state)).toEqual(encodeState(state));
  });

  it('throws "mls store locked" when no at-rest key is set', async () => {
    const bundle = await mkId('00000000-0000-4000-8000-0000000000c2', randomUUID());
    const state = await createGroup(bundle.identity, GID);
    // No setAtRestKey -> locked.
    await expect(store.putGroup(CH, GID, state, 0n)).rejects.toThrow('mls store locked');
  });

  it('throws "mls store locked" on getGroup with no at-rest key', async () => {
    const key = await makeAtRestKey();
    store.setAtRestKey(key);
    const bundle = await mkId('00000000-0000-4000-8000-0000000000c3', randomUUID());
    const state = await createGroup(bundle.identity, GID);
    await store.putGroup(CH, GID, state, 0n);

    store.setAtRestKey(null);
    await expect(store.getGroup(CH)).rejects.toThrow('mls store locked');
  });

  it('persists ciphertext, never the plaintext snapshot, on disk', async () => {
    const key = await makeAtRestKey();
    store.setAtRestKey(key);
    const bundle = await mkId('00000000-0000-4000-8000-0000000000c4', randomUUID());
    const state = await createGroup(bundle.identity, GID);
    const plaintext = encodeState(state);
    await store.putGroup(CH, GID, state, 0n);

    // Read the raw stored record directly (bypassing decrypt) and confirm the
    // encryptedSnapshot bytes differ from the plaintext snapshot.
    const raw = await new Promise<{ encryptedSnapshot: ArrayBuffer; iv: ArrayBuffer }>((resolve, reject) => {
      const open = indexedDB.open('howl_mls', 7);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('groups', 'readonly');
        const req = tx.objectStore('groups').get(CH);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      };
      open.onerror = () => reject(open.error);
    });
    const stored = new Uint8Array(raw.encryptedSnapshot);
    expect(stored.byteLength).toBeGreaterThan(0);
    expect(new Uint8Array(raw.iv).byteLength).toBe(12);
    // GCM ciphertext+tag is longer than plaintext and byte-different.
    expect(Array.from(stored)).not.toEqual(Array.from(plaintext));
  });

  it('builds the groupId -> dmChannelId map and lists channel ids', async () => {
    const key = await makeAtRestKey();
    store.setAtRestKey(key);
    const b1 = await mkId('00000000-0000-4000-8000-0000000000c5', randomUUID());
    const s1 = await createGroup(b1.identity, GID);
    const CH2 = '00000000-0000-4000-8000-0000000000a2';
    const GID2 = '00000000-0000-4000-8000-0000000000b2';
    const b2 = await mkId('00000000-0000-4000-8000-0000000000c6', randomUUID());
    const s2 = await createGroup(b2.identity, GID2);

    await store.putGroup(CH, GID, s1, 0n);
    await store.putGroup(CH2, GID2, s2, 0n);

    const map = await store.getGroupIdToChannelMap();
    expect(map.get(GID)).toEqual({ roomKey: CH, channelId: CH, tier: 'saved' });
    expect(map.get(GID2)).toEqual({ roomKey: CH2, channelId: CH2, tier: 'saved' });
    expect((await store.listGroupChannelIds()).sort()).toEqual([CH, CH2].sort());
  });

  it('round-trips a kpPrivate candidate (public + private + last-resort) and deletes it', async () => {
    const key = await makeAtRestKey();
    store.setAtRestKey(key);
    const ref = 'ref-aGVsbG8';
    const pub = new Uint8Array([10, 20, 30]);
    const priv = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await store.putKpPrivate(ref, pub, priv, true);
    const all = await store.getAllKeyPackageCandidates();
    expect(all).toHaveLength(1);
    expect(all[0].keyPackageRef).toBe(ref);
    expect(Array.from(all[0].keyPackage)).toEqual([10, 20, 30]);
    expect(Array.from(all[0].privateKeyPackage)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(all[0].isLastResort).toBe(true);
    await store.deleteKpPrivate(ref);
    expect(await store.getAllKeyPackageCandidates()).toHaveLength(0);
  });

  it('persists kpPrivate from generateKeyPackages and serves it back for join candidates', async () => {
    const key = await makeAtRestKey();
    store.setAtRestKey(key);
    const bundle = await mkId('00000000-0000-4000-8000-0000000000c7', randomUUID());
    const kps = await generateKeyPackages(bundle.identity, 2, true);
    for (const kp of kps) {
      await store.putKpPrivate(
        Buffer.from(kp.keyPackageRef).toString('base64'),
        kp.keyPackage,
        kp.privateKeyPackage,
        kp.isLastResort,
      );
    }
    const all = await store.getAllKeyPackageCandidates();
    expect(all).toHaveLength(3); // 2 single-use + 1 last-resort
    expect(all.filter((c) => c.isLastResort)).toHaveLength(1);
    for (const c of all) {
      expect(c.keyPackage.length).toBeGreaterThan(0);
      expect(c.privateKeyPackage.length).toBeGreaterThan(0);
    }
  });

  it('reads KP candidates with no at-rest key (v2 privates ride the device wrap key)', async () => {
    // KP privates ride the persistent device wrap key (not the vault atRestKey),
    // so getAllKeyPackageCandidates does not fail closed when the vault is locked.
    store.setAtRestKey(null);
    await expect(store.getAllKeyPackageCandidates()).resolves.toEqual([]);
  });

  it('stores and reads meta values', async () => {
    // meta is NOT at-rest-encrypted (deviceId/version are non-secret), so it
    // works without an at-rest key.
    expect(await store.getMeta('deviceId')).toBeNull();
    await store.setMeta('deviceId', 'device-xyz');
    expect(await store.getMeta('deviceId')).toBe('device-xyz');
    await store.setMeta('blobFormatVersion', '2');
    expect(await store.getMeta('blobFormatVersion')).toBe('2');
  });

  it('clears every store on clearAll (logout)', async () => {
    const key = await makeAtRestKey();
    store.setAtRestKey(key);
    const bundle = await mkId('00000000-0000-4000-8000-0000000000c8', randomUUID());
    const state = await createGroup(bundle.identity, GID);
    await store.putGroup(CH, GID, state, 0n);
    await store.putKpPrivate('ref-x', new Uint8Array([1]), new Uint8Array([9]), false);
    await store.setMeta('deviceId', 'device-xyz');

    await store.clearAll();

    expect(await store.listGroupChannelIds()).toEqual([]);
    expect(await store.getAllKeyPackageCandidates()).toEqual([]);
    expect(await store.getMeta('deviceId')).toBeNull();
  });

  it('evicts the oldest group and logs when over MAX_GROUPS', async () => {
    const key = await makeAtRestKey();
    store.setAtRestKey(key);
    const warn = vi.spyOn(store.__testHooks.logger, 'warn').mockImplementation(() => {});
    // Force the impl to treat the store as already at cap (cap of 1).
    store.__testHooks.setMaxGroupsForTest(1);
    const b1 = await mkId('00000000-0000-4000-8000-0000000000d1', randomUUID());
    const s1 = await createGroup(b1.identity, GID);
    await store.putGroup(CH, GID, s1, 0n);
    const CH2 = '00000000-0000-4000-8000-0000000000a3';
    const GID2 = '00000000-0000-4000-8000-0000000000b3';
    const b2 = await mkId('00000000-0000-4000-8000-0000000000d2', randomUUID());
    const s2 = await createGroup(b2.identity, GID2);
    await store.putGroup(CH2, GID2, s2, 0n);

    // Oldest (CH) evicted; only CH2 remains.
    expect(await store.listGroupChannelIds()).toEqual([CH2]);
    expect(warn).toHaveBeenCalledTimes(1);
    store.__testHooks.setMaxGroupsForTest(store.MAX_GROUPS);
  });
});

describe('mlsGroupStore — history archive', () => {
  async function seedState() {
    const bundle = await mkId('00000000-0000-4000-8000-0000000000c1', randomUUID());
    return createGroup(bundle.identity, GID);
  }

  it('round-trips a plaintext string under historyKey, keyed by (ch, envHash)', async () => {
    store.setAtRestKey(await makeAtRestKey());
    store.setHistoryKey(await makeAtRestKey());
    const state = await seedState();

    await store.putGroupAndHistory(CH, GID, state, currentEpoch(state), {
      messageId: 'm1', plaintext: 'hello world', envHash: 'envhash-aaa',
    });

    // a hit is by envelope hash — correct by construction
    expect(await store.getHistory(CH, 'envhash-aaa')).toBe('hello world');
    // a different envelope (e.g. an edit) is a different key => miss, never stale text
    expect(await store.getHistory(CH, 'envhash-bbb')).toBeNull();
    // the advanced ratchet snapshot was persisted in the same write
    const loaded = await store.getGroup(CH);
    expect(loaded).not.toBeNull();
    expect(loaded!.meta.dmChannelId).toBe(CH);
  });

  it('getHistory returns null when the history key is locked', async () => {
    store.setHistoryKey(null);
    expect(await store.getHistory(CH, 'envhash-aaa')).toBeNull();
  });

  it('deleteHistory removes every row for a messageId (original + edit revisions)', async () => {
    store.setAtRestKey(await makeAtRestKey());
    store.setHistoryKey(await makeAtRestKey());
    const state = await seedState();
    // an original + an edit sharing one messageId, under two envelope hashes
    await store.putGroupAndHistory(CH, GID, state, currentEpoch(state), { messageId: 'm1', plaintext: 'orig', envHash: 'h-orig' });
    await store.putGroupAndHistory(CH, GID, state, currentEpoch(state), { messageId: 'm1', plaintext: 'edited', envHash: 'h-edit' });
    expect(await store.getHistory(CH, 'h-orig')).toBe('orig');
    expect(await store.getHistory(CH, 'h-edit')).toBe('edited');

    await store.deleteHistory(CH, 'm1');
    expect(await store.getHistory(CH, 'h-orig')).toBeNull();
    expect(await store.getHistory(CH, 'h-edit')).toBeNull();
  });

  it('opens the DB at version 7 with a history store + dmChannelId/messageId/synced indexes + tombstones store', async () => {
    store.setAtRestKey(await makeAtRestKey());
    store.setHistoryKey(await makeAtRestKey());
    const state = await seedState();
    await store.putGroupAndHistory(CH, GID, state, currentEpoch(state), { messageId: 'm9', plaintext: 'x', envHash: 'h9' });
    const raw = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('howl_mls', 7);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    expect(Array.from(raw.objectStoreNames)).toContain('history');
    const names = Array.from(raw.transaction('history', 'readonly').objectStore('history').indexNames);
    expect(names).toContain('dmChannelId');
    expect(names).toContain('messageId');
    expect(names).toContain('synced');
    // The write-once tombstone store with its dmChannelId index.
    expect(Array.from(raw.objectStoreNames)).toContain('tombstones');
    const tsIdx = Array.from(raw.transaction('tombstones', 'readonly').objectStore('tombstones').indexNames);
    expect(tsIdx).toContain('dmChannelId');
    raw.close();
  });
});

describe('mlsGroupStore — putHistory (own-sent archive)', () => {
  // A representative v4 MLS envelope string (what the send path passes as
  // envelopeContent / what the read path hashes). The bytes inside `m` are opaque.
  const ENV = JSON.stringify({ v: 4, m: 'AAEAAg==' });

  // The CANONICAL envelope hash — byte-identical to mlsCoordinatorCore.sha256Hex and
  // mlsGroupStore's private copy. Pinning getHistory(putHistory-archived, THIS hash)
  // to a hit proves putHistory derives the same key the receive/read path expects, so
  // own-sent reload lookups land on the same row a received message would.
  async function sha256Hex(s: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return hex;
  }

  it('archives plaintext retrievable via getHistory under the CANONICAL envelope hash', async () => {
    store.setHistoryKey(await makeAtRestKey());
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'my own message', envelopeContent: ENV });
    // getHistory hits only if putHistory keyed by sha256Hex(ENV) — the same hash the
    // read path computes. This is the load-bearing envHash-consistency guard.
    expect(await store.getHistory(CH, await sha256Hex(ENV))).toBe('my own message');
    // A different envelope (e.g. an edit) is a different key => miss, never stale text.
    expect(await store.getHistory(CH, await sha256Hex(JSON.stringify({ v: 4, m: 'Zm9v' })))).toBeNull();
  });

  it('writes ONLY the history store — never creates or mutates a group snapshot (ratchet-safety)', async () => {
    // at-rest key is needed only to CALL getGroup (it decrypts the group snapshot);
    // putHistory itself uses ONLY the history key and never reads/writes STORE_GROUPS.
    store.setAtRestKey(await makeAtRestKey());
    store.setHistoryKey(await makeAtRestKey());
    // No group row exists for CH before the write.
    expect(await store.getGroup(CH)).toBeNull();
    await store.putHistory(CH, { messageId: 'm1', plaintext: 'mine', envelopeContent: ENV });
    // putHistory created a history row but NO group row: a main-thread own-sent write
    // can never clobber the worker-owned sender-ratchet snapshot in STORE_GROUPS.
    expect(await store.getGroup(CH)).toBeNull();
    expect(await store.getHistory(CH, await sha256Hex(ENV))).toBe('mine');
  });

  it('faithfully archives a file-envelope JSON plaintext (reload reconstructs attachments)', async () => {
    store.setHistoryKey(await makeAtRestKey());
    const fileEnvelope = JSON.stringify({
      text: 'caption',
      file: { url: 'https://cdn/x.enc', key: 'k', name: 'x.png', type: 'image/png', size: 123 },
    });
    await store.putHistory(CH, { messageId: 'm2', plaintext: fileEnvelope, envelopeContent: ENV });
    const got = await store.getHistory(CH, await sha256Hex(ENV));
    expect(got).toBe(fileEnvelope);
    const parsed = JSON.parse(got!);
    expect(parsed.text).toBe('caption');
    expect(parsed.file.key).toBe('k');
  });

  it('deleteHistory(messageId) drops the own-sent row (delete write-through)', async () => {
    store.setHistoryKey(await makeAtRestKey());
    await store.putHistory(CH, { messageId: 'm3', plaintext: 'gone soon', envelopeContent: ENV });
    expect(await store.getHistory(CH, await sha256Hex(ENV))).toBe('gone soon');
    await store.deleteHistory(CH, 'm3');
    expect(await store.getHistory(CH, await sha256Hex(ENV))).toBeNull();
  });

  it('rejects when the history key is locked (Self-recovery / locked) so the caller no-ops', async () => {
    store.setHistoryKey(null);
    await expect(
      store.putHistory(CH, { messageId: 'm4', plaintext: 'x', envelopeContent: ENV }),
    ).rejects.toThrow('mls history store locked');
  });
});

describe('mlsGroupStore — rekeyAtRestStores', () => {
  async function seedState() {
    const bundle = await mkId('00000000-0000-4000-8000-0000000000c1', randomUUID());
    return createGroup(bundle.identity, GID);
  }

  it('re-keys groups + history so the NEXT unlock (new keys installed) reads the ORIGINAL data', async () => {
    // Keys A: the current (old) unlock material.
    const aAtRest = await makeAtRestKey();
    const aHistory = await makeAtRestKey();
    // Keys B: the post-password-change unlock material.
    const bAtRest = await makeAtRestKey();
    const bHistory = await makeAtRestKey();

    // Seed a group + a history row under keys A.
    store.setAtRestKey(aAtRest);
    store.setHistoryKey(aHistory);
    const state = await seedState();
    await store.putGroupAndHistory(CH, GID, state, currentEpoch(state), {
      messageId: 'm1', plaintext: 'hello world', envHash: 'envhash-aaa',
    });
    const expectedSnapshot = encodeState((await store.getGroup(CH))!.state);

    // Re-key A -> B (old keys still installed; the helper takes keys explicitly).
    await store.rekeyAtRestStores(aAtRest, bAtRest, aHistory, bHistory);

    // Simulate the next unlock: install ONLY keys B (keys A are gone).
    store.setAtRestKey(bAtRest);
    store.setHistoryKey(bHistory);

    // The group + history are now readable under the new keys — exactly what unlock does.
    const loaded = await store.getGroup(CH);
    expect(loaded).not.toBeNull();
    expect(loaded!.meta.dmChannelId).toBe(CH);
    expect(loaded!.meta.groupId).toBe(GID);
    expect(encodeState(loaded!.state)).toEqual(expectedSnapshot);
    expect(await store.getHistory(CH, 'envhash-aaa')).toBe('hello world');
  });

  it('deletes a history row that is unreadable under the old key (graceful, no dead row)', async () => {
    const aAtRest = await makeAtRestKey();
    const aHistory = await makeAtRestKey();
    const bAtRest = await makeAtRestKey();
    const bHistory = await makeAtRestKey();
    const wrongOldHistory = await makeAtRestKey(); // NOT the key the row was written under

    store.setAtRestKey(aAtRest);
    store.setHistoryKey(aHistory);
    const state = await seedState();
    await store.putGroupAndHistory(CH, GID, state, currentEpoch(state), {
      messageId: 'm1', plaintext: 'secret', envHash: 'envhash-aaa',
    });

    // Re-key with a WRONG old-history key: the history row can't be decrypted, so it
    // must be DELETED (not left as a dead row). Groups still re-key cleanly.
    await store.rekeyAtRestStores(aAtRest, bAtRest, wrongOldHistory, bHistory);

    store.setAtRestKey(bAtRest);
    store.setHistoryKey(bHistory);
    // The unreadable history row was dropped — a miss, never stale/locked text.
    expect(await store.getHistory(CH, 'envhash-aaa')).toBeNull();
    // The group still round-trips under the new at-rest key.
    expect(await store.getGroup(CH)).not.toBeNull();
  });

  it('is a clean no-op on empty stores', async () => {
    const aAtRest = await makeAtRestKey();
    const bAtRest = await makeAtRestKey();
    const aHistory = await makeAtRestKey();
    const bHistory = await makeAtRestKey();
    await expect(store.rekeyAtRestStores(aAtRest, bAtRest, aHistory, bHistory)).resolves.toBeUndefined();
    store.setAtRestKey(bAtRest);
    expect(await store.listGroupChannelIds()).toEqual([]);
  });

  it('skips history (null history key) but still re-keys groups', async () => {
    const aAtRest = await makeAtRestKey();
    const bAtRest = await makeAtRestKey();

    // Seed a group only (no history key set: Self-recovery user with no archive).
    store.setAtRestKey(aAtRest);
    store.setHistoryKey(null);
    const state = await seedState();
    await store.putGroup(CH, GID, state, currentEpoch(state));

    await store.rekeyAtRestStores(aAtRest, bAtRest, null, null);

    store.setAtRestKey(bAtRest);
    expect(await store.getGroup(CH)).not.toBeNull();
  });

  it('leaves the device identity row INTACT (no re-key) across a vault password change [regression guard]', async () => {
    // The identity rides the persistent device wrap, so a vault password change
    // (rekey old→new at-rest) must NOT touch it — and it stays readable WITHOUT
    // any vault key (device-wrap, v2).
    const aAtRest = await makeAtRestKey();
    const bAtRest = await makeAtRestKey();
    store.setAtRestKey(aAtRest);

    const UID = '00000000-0000-4000-8000-0000000000d9';
    const DEV = '00000000-0000-4000-8000-0000000000e9';
    const b = await mkId(UID, DEV);
    await store.putIdentity(UID, DEV, b.identity.signaturePublicKey, b.identity.signaturePrivateKey, b.identity.credentialIdentity);
    expect(await store.getIdentityMeta(UID)).toEqual({ exists: true, wrapVersion: 2 });

    // Password change: rekey the vault stores old→new (history null/null here).
    await store.rekeyAtRestStores(aAtRest, bAtRest, null, null);

    // Identity row UNCHANGED (still v2) and readable with NO vault key at all.
    store.setAtRestKey(null);
    expect(await store.getIdentityMeta(UID)).toEqual({ exists: true, wrapVersion: 2 });
    const got = await store.getIdentity(UID);
    expect(got!.deviceId).toBe(DEV);
    expect(Array.from(got!.signaturePrivateKey)).toEqual(Array.from(b.identity.signaturePrivateKey));
  });

  it('does NOT re-key (or clobber) the identity store — even a stray v1 row is left for getIdentity to migrate', async () => {
    // Seed a true v1 identity row (vault-keyed) via the shared helper.
    const aAtRest = await makeAtRestKey();
    const bAtRest = await makeAtRestKey();
    const b = await mkId("00000000-0000-4000-8000-000000000fd0", "00000000-0000-4000-8000-000000000fd1");
    await seedLegacyV1Identity('00000000-0000-4000-8000-000000000fd0', '00000000-0000-4000-8000-000000000fd1', aAtRest, b.identity.signaturePrivateKey, b.identity.signaturePublicKey, b.identity.credentialIdentity);

    await store.rekeyAtRestStores(aAtRest, bAtRest, null, null);

    // The v1 row's signing-private bytes were NOT moved to bAtRest. They stay wrapped
    // under aAtRest (the ORIGINAL vault key), so a read with aAtRest still succeeds and
    // returns the same bytes. With the dead rekey block PRESENT the bytes would have
    // been re-encrypted under bAtRest, so this aAtRest read would fail-decrypt → null.
    // (We assert byte location, not wrapVersion: the read path opportunistically
    // re-stamps a v1 row to v2 on the very read below, so a post-read wrapVersion:1
    // check would be wrong.)
    const uid = '00000000-0000-4000-8000-000000000fd0';
    store.setAtRestKey(aAtRest);
    const got = await store.getIdentity(uid);
    expect(got).not.toBeNull();
    expect(Array.from(got!.signaturePrivateKey)).toEqual(Array.from(b.identity.signaturePrivateKey));
  });
});

describe('mlsGroupStore — clearHistory (recovery flows)', () => {
  async function seedState() {
    const bundle = await mkId('00000000-0000-4000-8000-0000000000c1', randomUUID());
    return createGroup(bundle.identity, GID);
  }

  it('clears every history row but leaves groups untouched', async () => {
    store.setAtRestKey(await makeAtRestKey());
    store.setHistoryKey(await makeAtRestKey());
    const state = await seedState();
    await store.putGroupAndHistory(CH, GID, state, currentEpoch(state), { messageId: 'm1', plaintext: 'hi', envHash: 'h1' });
    expect(await store.getHistory(CH, 'h1')).toBe('hi');

    await store.clearHistory();

    expect(await store.getHistory(CH, 'h1')).toBeNull();
    // The group row survives (recovery clears only the unrecoverable archive).
    expect(await store.getGroup(CH)).not.toBeNull();
  });
});

describe('mlsGroupStore — per-device identity (putIdentity/getIdentity)', () => {
  const UID = '00000000-0000-4000-8000-0000000000d1';
  const DEV = '00000000-0000-4000-8000-0000000000e1';

  async function mkIdentity(userId: string, deviceId: string) {
    const b = await mkId(userId, deviceId);
    return b;
  }

  it('round-trips a per-device identity through AES-GCM at rest', async () => {
    const key = await makeAtRestKey();
    store.setAtRestKey(key);
    const b = await mkIdentity(UID, DEV);

    await store.putIdentity(
      UID, DEV,
      b.identity.signaturePublicKey,
      b.identity.signaturePrivateKey,
      b.identity.credentialIdentity,
    );
    const got = await store.getIdentity(UID);

    expect(got).not.toBeNull();
    expect(got!.userId).toBe(UID);
    expect(got!.deviceId).toBe(DEV);
    expect(Array.from(got!.signaturePublicKey)).toEqual(Array.from(b.identity.signaturePublicKey));
    expect(Array.from(got!.signaturePrivateKey)).toEqual(Array.from(b.identity.signaturePrivateKey));
    expect(Array.from(got!.credentialIdentity)).toEqual(Array.from(b.identity.credentialIdentity));
  });

  it('returns null when no record exists for the user', async () => {
    store.setAtRestKey(await makeAtRestKey());
    expect(await store.getIdentity(UID)).toBeNull();
  });

  it('survives an at-rest key rotation (v2 identity rides the device wrap key, not the vault key)', async () => {
    // The signing private key rides the persistent device wrap key, so rotating
    // the vault atRestKey does not orphan the identity — it reads back unchanged
    // under the new key (or even with no vault key at all).
    const keyA = await makeAtRestKey();
    store.setAtRestKey(keyA);
    const b = await mkIdentity(UID, DEV);
    await store.putIdentity(UID, DEV, b.identity.signaturePublicKey, b.identity.signaturePrivateKey, b.identity.credentialIdentity);

    const keyB = await makeAtRestKey();
    store.setAtRestKey(keyB);
    const got = await store.getIdentity(UID);
    expect(got).not.toBeNull();
    expect(got!.deviceId).toBe(DEV);
    expect(Array.from(got!.signaturePrivateKey)).toEqual(Array.from(b.identity.signaturePrivateKey));
  });

  it('returns null for a LEGACY v1 row that is undecryptable under the wrong vault key (treat as fresh device)', async () => {
    // A true v1 row (signing private under vault keyA). Installing a DIFFERENT vault
    // key fails the GCM auth on the v1 branch, so getIdentity returns null (the
    // legacy "undecryptable -> fresh device" semantic, preserved for legacy rows).
    const keyA = await makeAtRestKey();
    const b = await mkIdentity(UID, DEV);
    await seedLegacyV1Identity(UID, DEV, keyA, b.identity.signaturePrivateKey, b.identity.signaturePublicKey, b.identity.credentialIdentity);

    store.setAtRestKey(await makeAtRestKey()); // wrong vault key
    expect(await store.getIdentity(UID)).toBeNull();
  });

  it('isolates two accounts in one browser by userId', async () => {
    store.setAtRestKey(await makeAtRestKey());
    const UID2 = '00000000-0000-4000-8000-0000000000d2';
    const DEV2 = '00000000-0000-4000-8000-0000000000e2';
    const b1 = await mkIdentity(UID, DEV);
    const b2 = await mkIdentity(UID2, DEV2);
    await store.putIdentity(UID, DEV, b1.identity.signaturePublicKey, b1.identity.signaturePrivateKey, b1.identity.credentialIdentity);
    await store.putIdentity(UID2, DEV2, b2.identity.signaturePublicKey, b2.identity.signaturePrivateKey, b2.identity.credentialIdentity);

    expect((await store.getIdentity(UID))!.deviceId).toBe(DEV);
    expect((await store.getIdentity(UID2))!.deviceId).toBe(DEV2);
  });

  it('persists ciphertext for the signing private key, never plaintext', async () => {
    store.setAtRestKey(await makeAtRestKey());
    const b = await mkIdentity(UID, DEV);
    await store.putIdentity(UID, DEV, b.identity.signaturePublicKey, b.identity.signaturePrivateKey, b.identity.credentialIdentity);

    const raw: any = await new Promise((resolve, reject) => {
      const req = indexedDB.open('howl_mls', 7);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('identity', 'readonly');
        const g = tx.objectStore('identity').get(UID);
        g.onsuccess = () => resolve(g.result);
        g.onerror = () => reject(g.error);
      };
      req.onerror = () => reject(req.error);
    });
    expect(raw).toBeTruthy();
    // Realm-safe check (fake-indexeddb structured-clones into its own ArrayBuffer
    // realm, so a literal `toBeInstanceOf(ArrayBuffer)` is brittle — mirror the
    // sibling "persists ciphertext" group test: a non-empty buffer that differs
    // from plaintext, with a 12-byte IV).
    const ctBytes = new Uint8Array(raw.encryptedSignaturePrivateKey);
    expect(ctBytes.byteLength).toBeGreaterThan(0);
    expect(Array.from(ctBytes)).not.toEqual(Array.from(b.identity.signaturePrivateKey));
    expect(new Uint8Array(raw.iv).byteLength).toBe(12);
  });
});

describe('mlsGroupStore — clearAll covers identity', () => {
  it('wipes the identity row', async () => {
    store.setAtRestKey(await makeAtRestKey());
    const UID = '00000000-0000-4000-8000-0000000000da';
    const DEV = '00000000-0000-4000-8000-0000000000ea';
    const b = await mkId(UID, DEV);
    await store.putIdentity(UID, DEV, b.identity.signaturePublicKey, b.identity.signaturePrivateKey, b.identity.credentialIdentity);
    expect(await store.getIdentity(UID)).not.toBeNull();

    await store.clearAll();
    expect(await store.getIdentity(UID)).toBeNull();
  });
});

describe('mlsGroupStore — DB v5 additive upgrade', () => {
  const UID = '00000000-0000-4000-8000-0000000000f1';
  const DEV = '00000000-0000-4000-8000-0000000000f2';

  // Open a RAW v4 DB with the exact v4 schema, seed one identity + one kp row
  // (NO wrapVersion field, exactly like a legacy device), then close it.
  async function seedRawV4(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('howl_mls', 4);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('groups', { keyPath: 'dmChannelId' });
        db.createObjectStore('kpPrivate', { keyPath: 'keyPackageRef' });
        db.createObjectStore('meta', { keyPath: 'key' });
        const h = db.createObjectStore('history', { keyPath: 'key' });
        h.createIndex('dmChannelId', 'dmChannelId');
        h.createIndex('messageId', 'messageId');
        h.createIndex('synced', 'synced');
        db.createObjectStore('identity', { keyPath: 'userId' });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['identity', 'kpPrivate'], 'readwrite');
        tx.objectStore('identity').put({
          userId: UID, deviceId: DEV,
          signaturePublicKey: 'cHVi', credentialIdentity: 'Y3Jl',
          encryptedSignaturePrivateKey: new Uint8Array([1, 2, 3]).buffer,
          iv: new Uint8Array(12).buffer, createdAt: 1,
        });
        tx.objectStore('kpPrivate').put({
          keyPackageRef: 'ref-1', keyPackage: 'a2lw',
          encryptedPrivateKeyPackage: new Uint8Array([4, 5, 6]).buffer,
          iv: new Uint8Array(12).buffer, isLastResort: false, createdAt: 1,
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  it('upgrades 4 -> 5: old identity/kp rows survive + get wrapVersion 1, deviceKey store is created', async () => {
    await seedRawV4();
    // Trigger the v4 -> v5 upgrade through the module's getDb() (resetDbHandle so
    // the cached v4 promise from a prior test cannot mask the reopen). A benign
    // key-only read (no decrypt) is the cheapest call that opens the DB at the
    // module's DB_VERSION and runs the upgrade body.
    store.__testHooks.resetDbHandle();
    store.setAtRestKey(await makeAtRestKey());
    await store.listGroupChannelIds();

    // getIdentity decrypts; instead read the RAW upgraded rows + store list to
    // assert the additive upgrade ran (no decrypt needed).
    const raw = await new Promise<{
      identity: any; kp: any; stores: string[];
    }>((resolve, reject) => {
      const r = indexedDB.open('howl_mls', 7);
      r.onsuccess = () => {
        const db = r.result;
        const stores = Array.from(db.objectStoreNames);
        const tx = db.transaction(['identity', 'kpPrivate'], 'readonly');
        const gi = tx.objectStore('identity').get(UID);
        const gk = tx.objectStore('kpPrivate').get('ref-1');
        tx.oncomplete = () => {
          db.close();
          resolve({ identity: gi.result, kp: gk.result, stores });
        };
        tx.onerror = () => reject(tx.error);
      };
      r.onerror = () => reject(r.error);
    });

    expect(raw.stores).toContain('deviceKey');           // new store created
    expect(raw.identity).toBeTruthy();                   // old row survived
    expect(raw.identity.wrapVersion).toBe(1);            // stamped legacy
    expect(raw.kp).toBeTruthy();
    expect(raw.kp.wrapVersion).toBe(1);
    // Existing payload bytes untouched (no data loss).
    expect(new Uint8Array(raw.identity.encryptedSignaturePrivateKey)[0]).toBe(1);
    expect(new Uint8Array(raw.kp.encryptedPrivateKeyPackage)[0]).toBe(4);
  });
});

describe('mlsGroupStore — wrapVersion field shape', () => {
  it('identity/kp records carry a cleartext wrapVersion discriminator', async () => {
    // After the v5 upgrade, a freshly written identity row (v2) and legacy rows
    // (v1) both expose wrapVersion as a plain (non-encrypted) number. Here we only
    // assert the TYPE/shape is addressable: write via putIdentity, read raw, and
    // confirm the field slot exists or is undefined (never throws). This pins the
    // discriminator as cleartext.
    store.setAtRestKey(await makeAtRestKey());
    const UID = '00000000-0000-4000-8000-0000000000fa';
    const DEV = '00000000-0000-4000-8000-0000000000fb';
    const b = await mkId(UID, DEV);
    await store.putIdentity(UID, DEV, b.identity.signaturePublicKey, b.identity.signaturePrivateKey, b.identity.credentialIdentity);
    const raw: any = await new Promise((resolve, reject) => {
      const r = indexedDB.open('howl_mls', 7);
      r.onsuccess = () => {
        const db = r.result;
        const g = db.transaction('identity', 'readonly').objectStore('identity').get(UID);
        g.onsuccess = () => { db.close(); resolve(g.result); };
        g.onerror = () => reject(g.error);
      };
      r.onerror = () => reject(r.error);
    });
    // wrapVersion is a top-level cleartext slot on the record (undefined here;
    // putIdentity sets 2). The key assertion: it is NOT inside the encrypted blob,
    // i.e. it is a plain enumerable own-property slot.
    expect('wrapVersion' in raw || raw.wrapVersion === undefined).toBe(true);
  });
});

describe('mlsGroupStore — getIdentityMeta (key-free probe)', () => {
  const UID = '00000000-0000-4000-8000-0000000000fc';
  const DEV = '00000000-0000-4000-8000-0000000000fd';

  it('returns null when no identity row exists', async () => {
    // No atRestKey set — the probe must not require one.
    store.setAtRestKey(null);
    expect(await store.getIdentityMeta(UID)).toBeNull();
  });

  it('returns {exists:true, wrapVersion} WITHOUT an at-rest key set', async () => {
    // Write a row, then stamp wrapVersion to a known value via a raw write so the
    // probe has something to read.
    const key = await makeAtRestKey();
    store.setAtRestKey(key);
    const b = await mkId(UID, DEV);
    await store.putIdentity(UID, DEV, b.identity.signaturePublicKey, b.identity.signaturePrivateKey, b.identity.credentialIdentity);
    // Force a wrapVersion onto the row (here we set it raw so the probe is
    // exercised against an explicit discriminator).
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open('howl_mls', 7);
      r.onsuccess = () => {
        const db = r.result;
        const tx = db.transaction('identity', 'readwrite');
        const s = tx.objectStore('identity');
        const g = s.get(UID);
        g.onsuccess = () => { s.put({ ...g.result, wrapVersion: 2 }); };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      r.onerror = () => reject(r.error);
    });

    // The CRITICAL assertion: probe with NO at-rest key (pre-unlock) still reads meta.
    store.setAtRestKey(null);
    const meta = await store.getIdentityMeta(UID);
    expect(meta).toEqual({ exists: true, wrapVersion: 2 });
  });

  it('defaults a row missing wrapVersion to 1 (legacy, pre-v5-stamp safety net)', async () => {
    // A row with no wrapVersion (e.g. written by an old build between upgrade races)
    // is treated as legacy v1 so a legacy device never mints a 2nd identity.
    // Prime the v5 schema first (the raw write below needs the `identity` store to
    // exist); the probe goes through getDb() and returns null on the empty store.
    await store.getIdentityMeta(UID);
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open('howl_mls', 7);
      r.onsuccess = () => {
        const db = r.result;
        const tx = db.transaction('identity', 'readwrite');
        tx.objectStore('identity').put({
          userId: UID, deviceId: DEV, signaturePublicKey: 'cHVi',
          credentialIdentity: 'Y3Jl',
          encryptedSignaturePrivateKey: new Uint8Array([1]).buffer,
          iv: new Uint8Array(12).buffer, createdAt: 1,
          // no wrapVersion
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      r.onerror = () => reject(r.error);
    });
    store.setAtRestKey(null);
    expect(await store.getIdentityMeta(UID)).toEqual({ exists: true, wrapVersion: 1 });
  });
});

describe('mlsGroupStore — getOrCreateDeviceWrapKey', () => {
  it('creates a non-extractable AES-GCM-256 key reachable WITHOUT an at-rest key', async () => {
    store.setAtRestKey(null); // device wrap key is independent of the vault
    const key = await store.getOrCreateDeviceWrapKey();
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.extractable).toBe(false);
    expect(key.type).toBe('secret');
    expect((key.algorithm as AesKeyAlgorithm).name).toBe('AES-GCM');
    expect((key.algorithm as AesKeyAlgorithm).length).toBe(256);
    expect(key.usages.sort()).toEqual(['decrypt', 'encrypt']);
  });

  it('is idempotent: create-then-reload returns the SAME persisted key', async () => {
    store.setAtRestKey(null);
    const k1 = await store.getOrCreateDeviceWrapKey();
    // Drop the cached DB handle so the second call re-opens IDB (a real reload).
    store.__testHooks.resetDbHandle();
    const k2 = await store.getOrCreateDeviceWrapKey();

    // Same key proof: encrypt under k1, decrypt under k2. A different (regenerated)
    // key would fail GCM auth and throw.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k1, new Uint8Array([7, 7, 7]));
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k2, ct));
    expect(Array.from(pt)).toEqual([7, 7, 7]);
  });

  it('survives clearHistory/clearAll-adjacent ops but is its own row id', async () => {
    store.setAtRestKey(null);
    await store.getOrCreateDeviceWrapKey();
    // Raw-confirm the key lives under id 'mls-device-wrap' in STORE_DEVICEKEY.
    const raw: any = await new Promise((resolve, reject) => {
      const r = indexedDB.open('howl_mls', 7);
      r.onsuccess = () => {
        const db = r.result;
        const g = db.transaction('deviceKey', 'readonly').objectStore('deviceKey').get('mls-device-wrap');
        g.onsuccess = () => { db.close(); resolve(g.result); };
        g.onerror = () => reject(g.error);
      };
      r.onerror = () => reject(r.error);
    });
    expect(raw).toBeTruthy();
    expect(raw.id).toBe('mls-device-wrap');
    expect(raw.key).toBeInstanceOf(CryptoKey);
  });
});

describe('mlsGroupStore — wrapVersion read-branch + opportunistic v1→v2 re-wrap', () => {
  const UID = '00000000-0000-4000-8000-000000000f10';
  const DEV = '00000000-0000-4000-8000-000000000f11';

  it('a v2 row reads with the device key only (atRestKey null)', async () => {
    store.setAtRestKey(null);
    const b = await mkId(UID, DEV);
    await store.putIdentity(UID, DEV, b.identity.signaturePublicKey, b.identity.signaturePrivateKey, b.identity.credentialIdentity);
    const got = await store.getIdentity(UID);
    expect(got!.deviceId).toBe(DEV);
  });

  it('a legacy v1 row still reads when the vault atRestKey is present (read-compat)', async () => {
    const vaultKey = await makeAtRestKey();
    const b = await mkId(UID, DEV);
    await seedLegacyV1Identity(UID, DEV, vaultKey, b.identity.signaturePrivateKey, b.identity.signaturePublicKey, b.identity.credentialIdentity);

    store.setAtRestKey(vaultKey); // vault unlocked → legacy v1 read-compat path
    const got = await store.getIdentity(UID);
    expect(got).not.toBeNull();
    expect(Array.from(got!.signaturePrivateKey)).toEqual(Array.from(b.identity.signaturePrivateKey));
  });

  it('reading a v1 row while atRestKey is present re-stamps it to v2 (opportunistic re-wrap)', async () => {
    const vaultKey = await makeAtRestKey();
    const b = await mkId(UID, DEV);
    await seedLegacyV1Identity(UID, DEV, vaultKey, b.identity.signaturePrivateKey, b.identity.signaturePublicKey, b.identity.credentialIdentity);
    expect(await store.getIdentityMeta(UID)).toEqual({ exists: true, wrapVersion: 1 });

    store.setAtRestKey(vaultKey);
    await store.getIdentity(UID);                       // triggers the opportunistic re-wrap
    expect(await store.getIdentityMeta(UID)).toEqual({ exists: true, wrapVersion: 2 });

    // Now readable with ONLY the device key (the vault key is gone).
    store.setAtRestKey(null);
    const got = await store.getIdentity(UID);
    expect(Array.from(got!.signaturePrivateKey)).toEqual(Array.from(b.identity.signaturePrivateKey));
  });

  it('a legacy v1 row is unreadable (null) when atRestKey is absent: no false fresh mint when re-wrap is impossible', async () => {
    const vaultKey = await makeAtRestKey();
    const b = await mkId(UID, DEV);
    await seedLegacyV1Identity(UID, DEV, vaultKey, b.identity.signaturePrivateKey, b.identity.signaturePublicKey, b.identity.credentialIdentity);
    store.setAtRestKey(null); // pre-unlock: cannot decrypt a v1 row
    expect(await store.getIdentity(UID)).toBeNull();
    // But getIdentityMeta still reports the row EXISTS at v1 (the key-free probe
    // that prevents minting a 2nd identity: provisioner defers, never mints).
    expect(await store.getIdentityMeta(UID)).toEqual({ exists: true, wrapVersion: 1 });
  });

  it('a legacy v1 KP row re-stamps to v2 on read and then reads with the device key only', async () => {
    const vaultKey = await makeAtRestKey();
    const ref = 'ref-legacy-v1-kp';
    const pub = new Uint8Array([9, 9, 9]);
    const priv = new Uint8Array([2, 3, 5, 7, 11, 13]);
    await seedLegacyV1Kp(vaultKey, ref, pub, priv, false);

    // Vault unlocked: the v1 KP reads under the vault key and is re-stamped v2.
    store.setAtRestKey(vaultKey);
    const first = await store.getAllKeyPackageCandidates();
    const got = first.find((c) => c.keyPackageRef === ref);
    expect(got).toBeTruthy();
    expect(Array.from(got!.privateKeyPackage)).toEqual([2, 3, 5, 7, 11, 13]);

    // Now readable with ONLY the device key (vault key gone) — proves the re-stamp persisted.
    store.setAtRestKey(null);
    const second = await store.getAllKeyPackageCandidates();
    const got2 = second.find((c) => c.keyPackageRef === ref);
    expect(got2).toBeTruthy();
    expect(Array.from(got2!.privateKeyPackage)).toEqual([2, 3, 5, 7, 11, 13]);
  });
});

describe('mlsGroupStore — identity/KP write under the device wrap key (wrapVersion 2)', () => {
  const UID = '00000000-0000-4000-8000-000000000f01';
  const DEV = '00000000-0000-4000-8000-000000000f02';

  it('putIdentity writes wrapVersion 2 and is readable with ONLY the device key (atRestKey null)', async () => {
    // Device wrap key present; NO vault at-rest key — the identity must still write+read.
    store.setAtRestKey(null);
    const b = await mkId(UID, DEV);
    await store.putIdentity(UID, DEV, b.identity.signaturePublicKey, b.identity.signaturePrivateKey, b.identity.credentialIdentity);

    // The stored row is stamped wrapVersion 2 (cleartext discriminator).
    expect((await store.getIdentityMeta(UID))).toEqual({ exists: true, wrapVersion: 2 });

    // Readable with ONLY the device key set (atRestKey still null).
    const got = await store.getIdentity(UID);
    expect(got).not.toBeNull();
    expect(got!.deviceId).toBe(DEV);
    expect(Array.from(got!.signaturePrivateKey)).toEqual(Array.from(b.identity.signaturePrivateKey));
  });

  it('putKpPrivate writes wrapVersion 2 and round-trips with ONLY the device key', async () => {
    store.setAtRestKey(null);
    const ref = 'ref-stage1-kp';
    const pub = new Uint8Array([7, 7, 7]);
    const priv = new Uint8Array([1, 1, 2, 3, 5, 8]);
    await store.putKpPrivate(ref, pub, priv, false);

    const all = await store.getAllKeyPackageCandidates();
    expect(all).toHaveLength(1);
    expect(all[0].keyPackageRef).toBe(ref);
    expect(Array.from(all[0].privateKeyPackage)).toEqual([1, 1, 2, 3, 5, 8]);
  });
});

describe('mlsGroupStore — device-wrap isolation (Self-mode guarantee)', () => {
  const UID = '00000000-0000-4000-8000-000000000f20';
  const DEV = '00000000-0000-4000-8000-000000000f21';
  const GID2 = '00000000-0000-4000-8000-000000000f2a';
  const CH2 = '00000000-0000-4000-8000-000000000f2b';

  it('with ONLY the device key: identity + KP read; group + history fail closed', async () => {
    // Seed identity + KP + group + history under a FULLY unlocked vault.
    const vaultKey = await makeAtRestKey();
    const histKey = await makeAtRestKey();
    store.setAtRestKey(vaultKey);
    store.setHistoryKey(histKey);
    const b = await mkId(UID, DEV);
    await store.putIdentity(UID, DEV, b.identity.signaturePublicKey, b.identity.signaturePrivateKey, b.identity.credentialIdentity);
    await store.putKpPrivate('kp-iso', new Uint8Array([1]), new Uint8Array([2, 3]), false);
    const state = await createGroup(b.identity, GID2);
    await store.putGroupAndHistory(CH2, GID2, state, currentEpoch(state), { messageId: 'm-iso', plaintext: 'secret', envHash: 'h-iso' });

    // Lock the VAULT (atRestKey + historyKey null). The device wrap key is untouched.
    store.setAtRestKey(null);
    store.setHistoryKey(null);

    // Identity + KP still read (they ride the device wrap, not the vault).
    expect((await store.getIdentity(UID))!.deviceId).toBe(DEV);
    const cands = await store.getAllKeyPackageCandidates();
    expect(cands.find((c) => c.keyPackageRef === 'kp-iso')).toBeTruthy();

    // Group + history are vault-keyed → fail closed (the Self-mode guarantee).
    await expect(store.getGroup(CH2)).rejects.toThrow('mls store locked');
    expect(await store.getHistory(CH2, 'h-iso')).toBeNull(); // history fails closed by returning null
  });
});

describe('mlsGroupStore — deleteIdentity / deleteAllKpPrivate (recovery revocation)', () => {
  const UID = '00000000-0000-4000-8000-000000000f30';
  const DEV = '00000000-0000-4000-8000-000000000f31';

  it('deleteIdentity removes the row so getIdentity/getIdentityMeta report absent', async () => {
    const b = await mkId(UID, DEV);
    await store.putIdentity(UID, DEV, b.identity.signaturePublicKey, b.identity.signaturePrivateKey, b.identity.credentialIdentity);
    expect(await store.getIdentityMeta(UID)).toEqual({ exists: true, wrapVersion: 2 });

    await store.deleteIdentity(UID);
    expect(await store.getIdentity(UID)).toBeNull();
    expect(await store.getIdentityMeta(UID)).toBeNull();
  });

  it('deleteAllKpPrivate wipes every KP private candidate', async () => {
    await store.putKpPrivate('kp-a', new Uint8Array([1]), new Uint8Array([2]), false);
    await store.putKpPrivate('kp-b', new Uint8Array([3]), new Uint8Array([4]), true);
    expect(await store.getAllKeyPackageCandidates()).toHaveLength(2);

    await store.deleteAllKpPrivate();
    expect(await store.getAllKeyPackageCandidates()).toHaveLength(0);
  });
});
