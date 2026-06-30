// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Rekey-vs-commit race. core.rekey() re-encrypts every durable
 * at-rest row under the NEW key while the OLD key is still installed, swapping the
 * module-held key only AFTER the rewrite loop resolves. An inbound commit landing in
 * that window reads a NEW-key row under the OLD key, AES-GCM throws 'OperationError',
 * and the orphaned-row heal used to PERMANENTLY DROP the live group — a self-healing
 * but real churn event triggered by an ordinary (rare, modal) password change.
 *
 * The fix is a worker-local re-key barrier: while a re-key is latched the heal must
 * treat an at-rest decrypt error as a transient stale-key artifact and NEVER drop the
 * row; and outside a re-key it must re-read once under the now-current key (the barrier
 * may have cleared between the failing read and the heal) before concluding the row is
 * a genuine orphan. A genuinely undecryptable row (cross-device password change) must
 * still drop so the channel re-establishes via External-Commit.
 *
 * Uses the REAL mlsGroupStore over fake-indexeddb and the REAL engine; only the
 * network/leadership/source/classification seams are injected (mirrors
 * mlsCoordinatorCore.rekey.test.ts / .heal.test.ts).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import * as core from '../services/mls/mlsCoordinatorCore';
import { installSeams } from '../services/mls/mlsCoordinatorCore';
import * as store from '../services/mls/mlsGroupStore';
import { createIdentity } from '../services/mls/mlsIdentity';
import nacl from 'tweetnacl';
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

const CH = '00000000-0000-4000-8000-0000000000a1';
const GID = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-0000000000e1';
const DEVICE = '00000000-0000-4000-8000-0000000000d1';

const tablock = { acquireLeadership: vi.fn(), isLeader: vi.fn(), releaseLeadership: vi.fn() };
const client = {
  publishKeyPackages: vi.fn(), keyPackageCount: vi.fn(), consumeKeyPackages: vi.fn(),
  createGroup: vi.fn(), getGroupInfo: vi.fn(), submitCommit: vi.fn(), catchUp: vi.fn(),
  getWelcomes: vi.fn(), getDMs: vi.fn(), idempotencyKeyFor: vi.fn(),
  getAikChain: vi.fn(async () => ({ chain: [], head: null })),
  onMlsCommit: vi.fn(() => () => undefined), onMlsWelcome: vi.fn(() => () => undefined),
};

type CommitHandler = (e: { groupId: string; epoch: string; commit: string }) => Promise<void>;

beforeEach(() => {
  vi.clearAllMocks();
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

function bundle(identity: Awaited<ReturnType<typeof createIdentity>>['identity']) {
  return { identity, userId: USER, deviceId: DEVICE };
}

/**
 * Seed a real group row under `atRestKey`, then activate under that SAME key so the
 * activate prefix loads CH into the routing maps and catch-up decodes it cleanly (no
 * drop). Returns the captured live commit handler the activate tail registers.
 */
async function seedAndActivate(atRestKey: CryptoKey, historyKey: CryptoKey | null): Promise<CommitHandler> {
  store.setAtRestKey(atRestKey);
  const aik = nacl.sign.keyPair();
  const id = await createIdentity(USER, DEVICE, aik.publicKey, aik.secretKey);
  const state = await createGroup(id.identity, GID);
  await store.putGroup(CH, GID, state, currentEpoch(state));
  store.setAtRestKey(null);

  let commitHandler: CommitHandler | undefined;
  client.onMlsCommit.mockImplementation(((h: CommitHandler) => { commitHandler = h; return () => undefined; }) as () => () => undefined);

  const ready = new Promise<void>((resolve) => {
    const off = core.mlsEvents.on((e) => { if (e === 'mls-ready') { off(); resolve(); } });
  });
  await core.activate(bundle(id.identity), atRestKey, historyKey);
  await ready; // tail done: CH is in _loadedGroups / _groupToChannel and decoded cleanly
  expect(core.isReadyForChannel(CH)).toBe(true);
  if (!commitHandler) throw new Error('commit handler was not registered by activate');
  return commitHandler;
}

describe('mlsCoordinatorCore — rekey-vs-commit race', () => {
  it('does NOT drop a live group row when an inbound commit lands mid-rekey', async () => {
    const aAtRest = await makeKey();
    const aHistory = await makeKey();
    const bAtRest = await makeKey();
    const bHistory = await makeKey();

    const commitHandler = await seedAndActivate(aAtRest, aHistory);

    // Pause the re-key AFTER the real re-encrypt (CH row now under keyB) but BEFORE the
    // core swaps the installed key — exactly the window where getGroup reads a keyB row
    // under keyA and AES-GCM throws OperationError.
    const realRekeyStores = store.rekeyAtRestStores;
    let reachedWindow!: () => void;
    const inWindow = new Promise<void>((r) => { reachedWindow = r; });
    let resumeRekey!: () => void;
    const resume = new Promise<void>((r) => { resumeRekey = r; });
    const spy = vi.spyOn(store, 'rekeyAtRestStores').mockImplementation(
      async (...args: Parameters<typeof store.rekeyAtRestStores>) => {
        await realRekeyStores(...args); // rows now keyB; installed key still keyA
        reachedWindow();
        await resume; // hold the vulnerable window open
      },
    );
    // Precise drop signal: dropGroupAndForget is the ONLY at-rest-error row deleter.
    const delSpy = vi.spyOn(store, 'deleteGroup');

    const rekeyP = core.rekey(bAtRest, bHistory);
    await inWindow; // CH row is keyB, installed key keyA, re-key barrier latched

    // An inbound commit lands now and runs to its heal decision while the re-key is
    // STILL paused: getGroup reads the keyB row under keyA -> OperationError. Without
    // the barrier the heal drops the live group here; with it the heal must hold.
    const commitP = commitHandler({ groupId: GID, epoch: '99', commit: 'AAAA' });
    await new Promise((r) => setTimeout(r, 30)); // flush the async getGroup -> heal path

    expect(delSpy).not.toHaveBeenCalled(); // the live row was NOT dropped mid-rekey
    expect(core.isReadyForChannel(CH)).toBe(true);

    resumeRekey();
    await rekeyP;
    await commitP;
    spy.mockRestore();
    delSpy.mockRestore();

    expect(store.getAtRestKey()).toBe(bAtRest);
    expect(await store.getGroup(CH)).not.toBeNull(); // survived the race, readable under keyB
    expect(core.isReadyForChannel(CH)).toBe(true);
  });

  it('re-reads under the current key before dropping: a transient at-rest decrypt failure does NOT drop the group', async () => {
    const keyA = await makeKey();
    const commitHandler = await seedAndActivate(keyA, null);

    // Simulate a just-completed key swap: the first read throws OperationError, a
    // re-read succeeds. With no re-key latched the heal must re-read and KEEP the row.
    const realGetGroup = store.getGroup;
    let n = 0;
    const gspy = vi.spyOn(store, 'getGroup').mockImplementation(
      async (...args: Parameters<typeof store.getGroup>) => {
        n += 1;
        if (n === 1) {
          const e = new Error('transient stale-key read');
          e.name = 'OperationError';
          throw e;
        }
        return realGetGroup(...args);
      },
    );

    await commitHandler({ groupId: GID, epoch: '99', commit: 'AAAA' });
    gspy.mockRestore();

    expect(n).toBeGreaterThanOrEqual(2); // proves the heal re-read rather than dropping on the first failure
    expect(await store.getGroup(CH)).not.toBeNull();
    expect(core.isReadyForChannel(CH)).toBe(true);
  });

  it('still drops a genuinely orphaned row on the live commit path (re-read also fails, no re-key in flight)', async () => {
    const keyA = await makeKey();
    const commitHandler = await seedAndActivate(keyA, null);

    // Both the initial read and the re-read fail (row truly under a stale key) with no
    // re-key latched -> the heal MUST drop + evict, preserving the orphan-heal contract.
    const gspy = vi.spyOn(store, 'getGroup').mockImplementation(async () => {
      const e = new Error('genuine orphan');
      e.name = 'OperationError';
      throw e;
    });

    await commitHandler({ groupId: GID, epoch: '99', commit: 'AAAA' });
    gspy.mockRestore();

    expect(core.isReadyForChannel(CH)).toBe(false); // evicted from routing
    expect(await store.getGroup(CH)).toBeNull(); // row dropped (db miss, not an error)
  });

  it('keeps the row when the re-read fails for a NON-at-rest reason (e.g. vault locked mid-heal)', async () => {
    const keyA = await makeKey();
    const commitHandler = await seedAndActivate(keyA, null);

    // First read throws an at-rest OperationError; before the re-read runs the vault is
    // locked (a concurrent deactivate nulls the key), so the re-read throws a NON-at-rest
    // 'mls store locked' Error. That is NOT a proven orphan -> the heal must KEEP the row,
    // not destroy a live group on a transient lock/IO failure.
    let n = 0;
    const gspy = vi.spyOn(store, 'getGroup').mockImplementation(async () => {
      n += 1;
      if (n === 1) {
        const e = new Error('stale at-rest key');
        e.name = 'OperationError';
        throw e;
      }
      throw new Error('mls store locked'); // re-read: non-at-rest failure
    });
    const delSpy = vi.spyOn(store, 'deleteGroup');

    await commitHandler({ groupId: GID, epoch: '99', commit: 'AAAA' });

    expect(n).toBeGreaterThanOrEqual(2); // it DID re-read
    expect(delSpy).not.toHaveBeenCalled(); // but did NOT drop on the non-at-rest failure
    expect(core.isReadyForChannel(CH)).toBe(true);

    gspy.mockRestore();
    delSpy.mockRestore();
    expect(await store.getGroup(CH)).not.toBeNull();
  });
});
