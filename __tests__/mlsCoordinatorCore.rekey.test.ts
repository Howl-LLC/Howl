// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * core.rekey() re-encrypts the durable at-rest stores from the
 * CURRENTLY-installed (old) keys to the new unlock-derived keys, then adopts the
 * new keys. This is the load-bearing end-to-end test: it uses the REAL
 * mlsGroupStore over fake-indexeddb and the REAL engine, seeds a group + history
 * row under keysA, calls core.rekey(keysB), and proves the store now reads the
 * ORIGINAL data under keysB — exactly what the next unlock will do.
 *
 * Only the network/leadership seams are injected (installSeams). engine + store +
 * identity are the real modules, so the AES-GCM re-encryption is exercised for real.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { IDBFactory } from 'fake-indexeddb';

import * as core from '../services/mls/mlsCoordinatorCore';
import { installSeams } from '../services/mls/mlsCoordinatorCore';
import * as store from '../services/mls/mlsGroupStore';
import { createIdentity } from '../services/mls/mlsIdentity';
import { createGroup, currentEpoch, encodeState } from '../services/mls/mlsEngine';
import { setChannelProtocol } from '../services/encryptionFlags';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

async function makeKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const CH = '00000000-0000-4000-8000-0000000000a1';
const GID = '00000000-0000-4000-8000-0000000000b1';

const tablock = { acquireLeadership: vi.fn(), isLeader: vi.fn(), releaseLeadership: vi.fn() };
const client = {
  publishKeyPackages: vi.fn(), keyPackageCount: vi.fn(), consumeKeyPackages: vi.fn(),
  createGroup: vi.fn(), getGroupInfo: vi.fn(), submitCommit: vi.fn(), catchUp: vi.fn(),
  getWelcomes: vi.fn(), getDMs: vi.fn(), idempotencyKeyFor: vi.fn(),
  getAikChain: vi.fn(async () => ({ chain: [], head: null })),
  onMlsCommit: vi.fn(() => () => undefined), onMlsWelcome: vi.fn(() => () => undefined),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Fresh, isolated IndexedDB per test.
  globalThis.indexedDB = new IDBFactory();
  store.__testHooks.resetDbHandle();
  store.setAtRestKey(null);
  store.setHistoryKey(null);

  installSeams({
    network: {
      publishKeyPackages: client.publishKeyPackages,
      keyPackageCount: client.keyPackageCount,
      consumeKeyPackages: client.consumeKeyPackages,
      createGroup: client.createGroup,
      getGroupInfo: client.getGroupInfo,
      submitCommit: client.submitCommit,
      catchUp: client.catchUp,
      getWelcomes: client.getWelcomes,
      getDMs: client.getDMs,
      getAikChain: vi.fn(async () => ({ chain: [], head: null })),
      idempotencyKeyFor: client.idempotencyKeyFor,
    },
    source: { onCommit: client.onMlsCommit, onWelcome: client.onMlsWelcome },
    classification: { markMls: (id: string) => setChannelProtocol(id, 'mls') },
    leadership: { isLeader: tablock.isLeader, acquire: tablock.acquireLeadership, release: tablock.releaseLeadership },
  });
  core.deactivate();

  tablock.acquireLeadership.mockResolvedValue(true);
  tablock.isLeader.mockReturnValue(true);
  client.keyPackageCount.mockResolvedValue({ remaining: 50, hasLastResort: true });
  client.getWelcomes.mockResolvedValue([]);
  client.catchUp.mockResolvedValue([]);
  client.getDMs.mockResolvedValue([]);
});

function bundle(userId: string, identity: Awaited<ReturnType<typeof createIdentity>>['identity']) {
  return { identity, userId, deviceId: 'dev' };
}

describe('core.rekey — end-to-end re-encrypt then adopt', () => {
  it('activates with keysA, seeds rows, rekeys to keysB; store reads under keysB and getAtRestKey/getHistoryKey return the new keys', async () => {
    const aAtRest = await makeKey();
    const aHistory = await makeKey();
    const bAtRest = await makeKey();
    const bHistory = await makeKey();

    const aik = nacl.sign.keyPair();
    const id = await createIdentity('00000000-0000-4000-8000-0000000000c1', randomUUID(), aik.publicKey, aik.secretKey);

    // Activate under keys A (installs keys A in the real store via the core prefix).
    await core.activate(bundle('u1', id.identity), aAtRest, aHistory);
    expect(store.getAtRestKey()).toBe(aAtRest);
    expect(store.getHistoryKey()).toBe(aHistory);

    // Seed a real group + a history row under keys A (mirrors a live decrypt write).
    const state = await createGroup(id.identity, GID);
    await store.putGroupAndHistory(CH, GID, state, currentEpoch(state), {
      messageId: 'm1', plaintext: 'hello world', envHash: 'envhash-aaa',
    });
    const expectedSnapshot = encodeState((await store.getGroup(CH))!.state);

    // Re-key A -> B through the core (reads the installed old keys internally).
    await core.rekey(bAtRest, bHistory);

    // The core adopted the new keys atomically.
    expect(store.getAtRestKey()).toBe(bAtRest);
    expect(store.getHistoryKey()).toBe(bHistory);

    // The durable rows are now readable under the NEW keys (what the next unlock does).
    const loaded = await store.getGroup(CH);
    expect(loaded).not.toBeNull();
    expect(encodeState(loaded!.state)).toEqual(expectedSnapshot);
    expect(await store.getHistory(CH, 'envhash-aaa')).toBe('hello world');
  });

  it('no-ops when MLS is not active (no installed at-rest key)', async () => {
    const bAtRest = await makeKey();
    const bHistory = await makeKey();
    // Never activated; store has no at-rest key.
    expect(store.getAtRestKey()).toBeNull();
    await core.rekey(bAtRest, bHistory);
    // Still null — rekey did not adopt new keys on an inactive store.
    expect(store.getAtRestKey()).toBeNull();
  });
});
