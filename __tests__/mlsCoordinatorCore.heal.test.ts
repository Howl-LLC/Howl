// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * MLS per-device identity: heal orphaned group rows. When a group row in
 * IndexedDB is encrypted under a STALE at-rest key (e.g. after a cross-device
 * password change), getGroup's AES-GCM decrypt throws a DOMException 'OperationError'.
 * Instead of sticking at the old epoch (or fail-loud emitting mls-apply-failed), the
 * coordinator DROPS the undecryptable row + evicts it from routing so the channel
 * re-establishes via External-Commit on the next establishChannel.
 *
 * This is a load-bearing end-to-end test: it uses the REAL mlsGroupStore over
 * fake-indexeddb and the REAL engine. It seeds a group under keyA, then activates
 * under keyB (the post-password-change key), and proves the activate-time catch-up
 * dropped the row + evicted the channel. Only the network/leadership/source/
 * classification seams are injected (installSeams), so the AES-GCM decrypt failure
 * is exercised for real.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import * as core from '../services/mls/mlsCoordinatorCore';
import { installSeams } from '../services/mls/mlsCoordinatorCore';
import * as store from '../services/mls/mlsGroupStore';
import nacl from 'tweetnacl';
import { createIdentity } from '../services/mls/mlsIdentity';
import { createGroup, currentEpoch } from '../services/mls/mlsEngine';
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

const CH = '00000000-0000-4000-8000-0000000000c1';
const GID = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-0000000000a1';
const DEVICE = '00000000-0000-4000-8000-0000000000d1';

// Network + leadership seam stubs (mirrors mlsCoordinatorCore.rekey.test.ts).
const tablock = { acquireLeadership: vi.fn(), isLeader: vi.fn(), releaseLeadership: vi.fn() };
const client = {
  publishKeyPackages: vi.fn(), keyPackageCount: vi.fn(), consumeKeyPackages: vi.fn(),
  createGroup: vi.fn(), getGroupInfo: vi.fn(), submitCommit: vi.fn(), catchUp: vi.fn(),
  getWelcomes: vi.fn(), getDMs: vi.fn(), idempotencyKeyFor: vi.fn(),
  getAikChain: vi.fn(async () => ({ chain: [], head: null })),
  onMlsCommit: vi.fn(() => () => undefined), onMlsWelcome: vi.fn(() => () => undefined),
};

// Configure the leader flag + the network mocks that let the activate tail reach
// catch-up cleanly (matches rekey.test.ts's beforeEach grants). The seams themselves
// are installed in beforeEach (BEFORE core.deactivate(), which calls leadership.release()).
function installRealStoreSeams({ leader }: { leader: boolean }): void {
  tablock.acquireLeadership.mockResolvedValue(leader);
  tablock.isLeader.mockReturnValue(leader);
  // Skip KP replenish (remaining above the low-water + has last resort) and find no
  // pending welcomes / no catch-up commits, so the only catch-up work is getGroup.
  client.keyPackageCount.mockResolvedValue({ remaining: 50, hasLastResort: true });
  client.getWelcomes.mockResolvedValue([]);
  client.catchUp.mockResolvedValue([]);
  client.getDMs.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Fresh, isolated IndexedDB per test (mirrors rekey.test.ts).
  globalThis.indexedDB = new IDBFactory();
  store.__testHooks.resetDbHandle();
  store.setAtRestKey(null);
  store.setHistoryKey(null);
  // Install seams BEFORE core.deactivate() so leadership.release() is defined
  // (REAL store/engine/identity; only network/leadership/source/classification injected).
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
  core.deactivate(); // reset coordinator state (resets _initStarted; matches rekey.test.ts's reset)
});

function bundle(identity: Awaited<ReturnType<typeof createIdentity>>['identity']) {
  return { identity, userId: USER, deviceId: DEVICE };
}

describe('mlsCoordinatorCore — orphaned-row heal', () => {
  it('drops an undecryptable group row during activate-catchup so the channel is no longer loaded', async () => {
    // Seed a REAL group row under keyA (the pre-password-change at-rest key).
    const keyA = await makeKey();
    store.setAtRestKey(keyA);
    const aik = nacl.sign.keyPair();
    const bundleId = await createIdentity(USER, DEVICE, aik.publicKey, aik.secretKey);
    const state = await createGroup(bundleId.identity, GID);
    await store.putGroup(CH, GID, state, currentEpoch(state));
    store.setAtRestKey(null);

    installRealStoreSeams({ leader: true });

    // Activate under keyB (the post-cross-device-password-change key). The activate
    // prefix builds _loadedGroups from the PLAINTEXT groupId/channelId map (no key
    // needed), so CH is loaded; the backgrounded catch-up then getGroup(CH) decrypts
    // under keyB -> OperationError -> healIfOrphanedGroup drops the row + evicts it.
    const keyB = await makeKey();
    const ready = new Promise<void>((resolve) => {
      const off = core.mlsEvents.on((e) => { if (e === 'mls-ready') { off(); resolve(); } });
    });
    await core.activate(bundle(bundleId.identity), keyB, null);
    await ready; // mls-ready fires AFTER catchUpAllGroups, so the heal has run

    // The row was deleted: install keyB and read it back — a db MISS returns null
    // (not an OperationError), proving the orphan was dropped, not just skipped.
    store.setAtRestKey(keyB);
    expect(await store.getGroup(CH)).toBeNull();
    // And the channel was evicted from the routing maps (no longer ready).
    expect(core.isReadyForChannel(CH)).toBe(false);
  });
});
