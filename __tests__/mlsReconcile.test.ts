// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { IDBFactory } from 'fake-indexeddb';
import { reconcileChannelClassifications } from '../services/mls/mlsReconcile';

beforeEach(() => { (globalThis as any).indexedDB = new IDBFactory(); localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('reconcileChannelClassifications (main thread)', () => {
  it('marks every channel with a durable group row as mls (key-free read)', async () => {
    const store = await import('../services/mls/mlsGroupStore');
    const { createIdentity } = await import('../services/mls/mlsIdentity');
    const { createGroup, currentEpoch } = await import('../services/mls/mlsEngine');
    // Seed ONE real group row. putGroup runs the REAL encodeState (ts-mls
    // encodeGroupState walks the live ClientState), so the state must be real, not a
    // stub. Mirror __tests__/mlsGroupStore.test.ts: real identity -> real group.
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    store.setAtRestKey(key);
    const aik = nacl.sign.keyPair();
    const bundle = await createIdentity(randomUUID(), randomUUID(), aik.publicKey, aik.secretKey);
    const state = await createGroup(bundle.identity, 'chan-1');
    await store.putGroup('chan-1', 'group-1', state, currentEpoch(state));
    store.setAtRestKey(null); // drop the key: reconcile must NOT need it (key-free index read)

    const { isChannelMls } = await import('../services/encryptionFlags');
    expect(isChannelMls('chan-1')).toBe(false);
    await reconcileChannelClassifications();
    expect(isChannelMls('chan-1')).toBe(true);
  });

  it('classifies an OTR group by its bare channelId, never the room key', async () => {
    const id = 'a3f1c2d4-5b6e-4f80-9a1b-2c3d4e5f6071'; // v4 UUID (reconcile does not validate)
    const groupStore = await import('../services/mls/mlsGroupStore');
    const flags = await import('../services/encryptionFlags');
    const setSpy = vi.spyOn(flags, 'setChannelProtocol');
    // Map<groupId, { roomKey, channelId, tier }>; OTR room key is `${id}#otr`.
    vi.spyOn(groupStore, 'getGroupIdToChannelMap').mockResolvedValue(
      new Map([['group-otr', { roomKey: `${id}#otr`, channelId: id, tier: 'otr' as const }]]),
    );

    await reconcileChannelClassifications();

    expect(setSpy).toHaveBeenCalledWith(id, 'mls');
    expect(setSpy).not.toHaveBeenCalledWith(`${id}#otr`, expect.anything());
    expect(flags.isChannelMls(id)).toBe(true);
    expect(flags.isChannelMls(`${id}#otr`)).toBe(false);
  });
});
