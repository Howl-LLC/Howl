// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Bounded self-Update cadence. The leader self-Updates each loaded group
 * on activate (eager sweep) and on a periodic timer, but only when the group is
 * "due" (>= SELF_UPDATE_CADENCE_MS since its last self-update). Non-leaders never
 * self-update; teardown and leadership-loss clear the timer; a CAS conflict defers
 * (does not stamp lastSelfUpdateAt) so the next tick retries.
 *
 * Harness mirrors __tests__/mlsCoordinatorCore.activate.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { engine, store, client, identity, tablock, apiClient } = vi.hoisted(() => ({
  engine: {
    createGroup: vi.fn(), addMembers: vi.fn(), addMember: vi.fn(), removeMembers: vi.fn(),
    resolveLeafIndex: vi.fn(), joinExternal: vi.fn(), joinFromWelcome: vi.fn(),
    selfUpdate: vi.fn(), processHandshake: vi.fn(), encryptApp: vi.fn(), decryptApp: vi.fn(),
    makeGroupInfo: vi.fn(), currentEpoch: vi.fn(), ownLeafCredentialIsLegacy: vi.fn(() => false),
    copyBytes: (b: Uint8Array) => new Uint8Array(b),
    encodeState: vi.fn((s: unknown) => s), decodeState: vi.fn((s: unknown) => s),
    setCredentialValidator: vi.fn(),
  },
  store: {
    setAtRestKey: vi.fn(), setHistoryKey: vi.fn(),
    setRotationChainFetcher: vi.fn(),
    setOwnAikHint: vi.fn(),
    setPinRejectionListener: vi.fn(),
    setPinResolutionListener: vi.fn(),
    getTrustRecord: vi.fn(async () => null),
    getAtRestKey: vi.fn((): CryptoKey | null => null), getHistoryKey: vi.fn(() => null),
    rekeyAtRestStores: vi.fn(), clearHistory: vi.fn(),
    putGroup: vi.fn(), getGroup: vi.fn(), listGroupChannelIds: vi.fn(),
    getGroupIdToChannelMap: vi.fn(), deleteGroup: vi.fn(),
    putKpPrivate: vi.fn(), getAllKeyPackageCandidates: vi.fn(), deleteKpPrivate: vi.fn(),
    getMeta: vi.fn(), setMeta: vi.fn(), clearAll: vi.fn(),
  },
  client: {
    publishKeyPackages: vi.fn(), keyPackageCount: vi.fn(), consumeKeyPackages: vi.fn(),
    createGroup: vi.fn(), getGroupInfo: vi.fn(), submitCommit: vi.fn(), catchUp: vi.fn(),
    getWelcomes: vi.fn(), idempotencyKeyFor: vi.fn(),
    onMlsCommit: vi.fn(() => () => undefined), onMlsWelcome: vi.fn(() => () => undefined),
  },
  identity: { generateKeyPackages: vi.fn(), KEYPACKAGE_BATCH_SIZE: 20, KEYPACKAGE_LOW_WATER: 5 },
  tablock: { acquireLeadership: vi.fn(), isLeader: vi.fn(), releaseLeadership: vi.fn() },
  apiClient: { getDMs: vi.fn() },
  getAikChain: vi.fn(async () => ({ chain: [], head: null })),
  getPeerAik: vi.fn(async () => ({ signingPublicKey: null })),
  resetGroup: vi.fn(async () => ({ success: true })),
}));
vi.mock('../services/mls/mlsEngine', () => engine);
vi.mock('../services/mls/mlsGroupStore', () => store);
vi.mock('../services/mls/mlsIdentity', () => identity);

import * as core from '../services/mls/mlsCoordinatorCore';
import { installSeams } from '../services/mls/mlsCoordinatorCore';
import { setChannelProtocol } from '../services/encryptionFlags';

const net = client;
const CH = '11111111-1111-1111-1111-111111111111';
const GID = 'group-1';

function bundle(userId: string) {
  return {
    identity: {
      signaturePublicKey: new Uint8Array([1]),
      signaturePrivateKey: new Uint8Array([2]),
      credentialIdentity: new Uint8Array([3]),
    },
    userId, deviceId: 'dev',
  };
}

/** Flush the backgrounded activateTail + eager sweep (deep promise chain) until
 *  `pred` holds or we exhaust `turns` macrotasks. */
async function settle(pred: () => boolean, turns = 60): Promise<void> {
  for (let i = 0; i < turns && !pred(); i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  installSeams({
    network: {
      publishKeyPackages: client.publishKeyPackages, keyPackageCount: client.keyPackageCount,
      consumeKeyPackages: client.consumeKeyPackages, createGroup: client.createGroup,
      getGroupInfo: client.getGroupInfo, submitCommit: client.submitCommit, catchUp: client.catchUp,
      getWelcomes: client.getWelcomes, getDMs: apiClient.getDMs, idempotencyKeyFor: client.idempotencyKeyFor,
      getAikChain: vi.fn(async () => ({ chain: [], head: null })),
      getPeerAik: vi.fn(async () => ({ signingPublicKey: null })),
      resetGroup: vi.fn(async () => ({ success: true })),
    },
    source: { onCommit: client.onMlsCommit, onWelcome: client.onMlsWelcome },
    classification: { markMls: (id: string) => setChannelProtocol(id, 'mls') },
    leadership: { isLeader: tablock.isLeader, acquire: tablock.acquireLeadership, release: tablock.releaseLeadership },
  });
  core.deactivate(); // reset _initStarted + in-memory state

  client.keyPackageCount.mockResolvedValue({ remaining: 99, hasLastResort: true }); // no KP work
  client.publishKeyPackages.mockResolvedValue(undefined);
  client.consumeKeyPackages.mockResolvedValue([]);
  client.getWelcomes.mockResolvedValue([]);
  client.catchUp.mockResolvedValue([]);
  client.idempotencyKeyFor.mockResolvedValue('idem-selfupdate');
  client.submitCommit.mockResolvedValue({ ok: true, epoch: '2' });
  apiClient.getDMs.mockResolvedValue([]);
  // One loaded group so _loadedGroups is non-empty after activate().
  store.getGroupIdToChannelMap.mockResolvedValue(new Map([[GID, { roomKey: CH, channelId: CH, tier: 'saved' }]]));
  store.getAllKeyPackageCandidates.mockResolvedValue([]);
  // state must carry the current ciphersuite so the activate tail's
  // healSuiteMismatchedGroups() doesn't drop the seeded group before our sweep.
  store.getGroup.mockResolvedValue({
    state: { tag: 'state', groupContext: { cipherSuite: 'MLS_256_XWING_AES256GCM_SHA512_Ed25519' } },
    meta: { dmChannelId: CH, groupId: GID, lastAppliedEpoch: 1n },
  });
  store.getMeta.mockResolvedValue(null); // never self-updated => due
  store.setMeta.mockResolvedValue(undefined);
  store.putGroup.mockResolvedValue(undefined);
  identity.generateKeyPackages.mockResolvedValue([]);
  engine.currentEpoch.mockReturnValue(1n);
  engine.ownLeafCredentialIsLegacy.mockReturnValue(false); // default: own leaf is v2
  engine.selfUpdate.mockResolvedValue({ newState: { tag: 'newState' }, commit: new Uint8Array([9]) });
  engine.makeGroupInfo.mockResolvedValue(new Uint8Array([8]));
  tablock.isLeader.mockReturnValue(true);
  tablock.acquireLeadership.mockResolvedValue(true);
});

afterEach(() => {
  core.deactivate();
  vi.useRealTimers();
});

describe('self-Update cadence', () => {
  it('self-Updates each due loaded group on activate (member-mode commit + stamp)', async () => {
    await core.activate(bundle('u1'), {} as CryptoKey, null);
    await settle(() => net.submitCommit.mock.calls.length > 0);
    expect(engine.selfUpdate).toHaveBeenCalledTimes(1);
    expect(net.submitCommit).toHaveBeenCalledWith(expect.objectContaining({ groupId: GID, mode: 'member', idempotencyKey: 'idem-selfupdate' }));
    expect(store.setMeta).toHaveBeenCalledWith('selfUpdateAt:' + CH, expect.any(String));
  });

  it('does NOT self-Update when this tab is not the leader', async () => {
    tablock.isLeader.mockReturnValue(false);
    await core.activate(bundle('u1'), {} as CryptoKey, null);
    await settle(() => false, 30);
    expect(engine.selfUpdate).not.toHaveBeenCalled();
  });

  it('does NOT self-Update a group still within the cadence window', async () => {
    store.getMeta.mockResolvedValue(String(Date.now() - 60_000)); // 1 min ago => not due
    await core.activate(bundle('u1'), {} as CryptoKey, null);
    await settle(() => false, 30);
    expect(engine.selfUpdate).not.toHaveBeenCalled();
  });

  it('defers on a CAS conflict and does NOT stamp lastSelfUpdateAt (so it retries)', async () => {
    client.submitCommit.mockResolvedValue({ ok: false, conflict: 'rebase', currentEpoch: '2' });
    await core.activate(bundle('u1'), {} as CryptoKey, null);
    await settle(() => engine.selfUpdate.mock.calls.length > 0);
    expect(engine.selfUpdate).toHaveBeenCalledTimes(1);
    expect(store.setMeta).not.toHaveBeenCalled();
  });

  it('fires again on the periodic tick while a group stays due', async () => {
    vi.useFakeTimers();
    await core.activate(bundle('u1'), {} as CryptoKey, null);
    await vi.advanceTimersByTimeAsync(0); // flush activation + eager sweep
    const afterActivate = engine.selfUpdate.mock.calls.length;
    expect(afterActivate).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // one tick (SELF_UPDATE_TICK_MS)
    expect(engine.selfUpdate.mock.calls.length).toBeGreaterThan(afterActivate);
  });

  it('stops the timer on deactivate (no self-Update after teardown)', async () => {
    vi.useFakeTimers();
    await core.activate(bundle('u1'), {} as CryptoKey, null);
    await vi.advanceTimersByTimeAsync(0);
    const before = engine.selfUpdate.mock.calls.length;
    core.deactivate();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(engine.selfUpdate.mock.calls.length).toBe(before);
  });

  it('discards an idempotent replay without persisting or stamping (a different commit already landed)', async () => {
    // The server fast-path returns idempotent:true for a re-used (groupId,baseEpoch,
    // 'selfupdate') key WITHOUT applying our (randomized, different) commit. Persisting
    // our local newState here would diverge from the server/peers at the same epoch.
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '2', idempotent: true });
    await core.activate(bundle('u1'), {} as CryptoKey, null);
    await settle(() => engine.selfUpdate.mock.calls.length > 0);
    expect(engine.selfUpdate).toHaveBeenCalledTimes(1);
    expect(store.putGroup).not.toHaveBeenCalled();
    expect(store.setMeta).not.toHaveBeenCalled();
  });

  it('aborts the persist when a rekey starts during submit (no write under a mid-swap key)', async () => {
    let releaseRekey!: () => void;
    store.getAtRestKey.mockReturnValue({} as CryptoKey); // rekey precondition: a key is installed
    store.rekeyAtRestStores.mockReturnValue(new Promise<void>((r) => { releaseRekey = () => r(); }));
    client.submitCommit.mockImplementation(async () => {
      void core.rekey({} as CryptoKey, null); // sets _rekeyInProgress=true, then awaits the hung rekeyAtRestStores
      await Promise.resolve(); // let rekey set the flag before submit resolves
      return { ok: true, epoch: '2' };
    });
    await core.activate(bundle('u1'), {} as CryptoKey, null);
    await settle(() => engine.selfUpdate.mock.calls.length > 0);
    expect(engine.selfUpdate).toHaveBeenCalledTimes(1);
    expect(store.putGroup).not.toHaveBeenCalled(); // persist aborted while keys mid-swap
    expect(store.setMeta).not.toHaveBeenCalled();
    releaseRekey(); // cleanup so the hung rekey settles
  });

  it('treats a future lastSelfUpdateAt as due (clock rewind cannot suppress PCS)', async () => {
    store.getMeta.mockResolvedValue(String(Date.now() + 60 * 60 * 1000)); // 1h in the future
    await core.activate(bundle('u1'), {} as CryptoKey, null);
    await settle(() => engine.selfUpdate.mock.calls.length > 0);
    expect(engine.selfUpdate).toHaveBeenCalledTimes(1);
  });

  // Legacy-leaf safety guard: a pre-v2 own-leaf credential cannot be rotated by a
  // self-Update (createUpdatePath REUSES the credential), so the committed leaf
  // would fail v2 validation on peers and desync the group. Skip such groups.
  it('does NOT self-Update a group whose own leaf carries a pre-v2 legacy credential', async () => {
    engine.ownLeafCredentialIsLegacy.mockReturnValue(true);
    await core.activate(bundle('u1'), {} as CryptoKey, null);
    await settle(() => false, 30);
    expect(engine.selfUpdate).not.toHaveBeenCalled();
    expect(net.submitCommit).not.toHaveBeenCalled();
    expect(store.setMeta).not.toHaveBeenCalled(); // not stamped => re-evaluated once the leaf is replaced
  });
});
