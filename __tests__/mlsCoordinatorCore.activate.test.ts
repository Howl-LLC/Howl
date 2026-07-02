// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * activate() split into an AWAITED PREFIX + a BACKGROUNDED TAIL with a
 * synchronous first-init latch.
 *  - The first-init latch (`_initStarted`, set synchronously before any await) makes
 *    two near-simultaneous init messages run the leader-only tail EXACTLY ONCE. On the
 *    SharedWorker path the navigator.locks gate no longer serializes activate(), so the
 *    latch is what prevents a double-run of the leader-only work.
 *  - activate() resolves after the awaited PREFIX (identity install, at-rest key, routing
 *    maps + classification, `_active = true`) WITHOUT waiting for the (possibly slow /
 *    leadership-blocked) tail, so a post-unlock establishChannel RPC never hits the
 *    "mls not active" guard.
 *
 * Mocks engine/store/identity (the core imports those modules directly); injects
 * network/source/classification/leadership via installSeams, mirroring
 * __tests__/mlsCoordinator.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock leaf modules
// Build the mock objects via vi.hoisted so they exist both inside the (hoisted)
// vi.mock factories and in the test body.
const { engine, store, client, identity, tablock, apiClient } = vi.hoisted(() => ({
  engine: {
    createGroup: vi.fn(),
    addMembers: vi.fn(),
    addMember: vi.fn(),
    removeMembers: vi.fn(),
    resolveLeafIndex: vi.fn(),
    joinExternal: vi.fn(),
    joinFromWelcome: vi.fn(),
    selfUpdate: vi.fn(),
    processHandshake: vi.fn(),
    encryptApp: vi.fn(),
    decryptApp: vi.fn(),
    makeGroupInfo: vi.fn(),
    currentEpoch: vi.fn(),
    copyBytes: (b: Uint8Array) => new Uint8Array(b),
    encodeState: vi.fn((s: unknown) => s),
    decodeState: vi.fn((s: unknown) => s),
    setCredentialValidator: vi.fn(),
  },
  store: {
    setAtRestKey: vi.fn(),
    setHistoryKey: vi.fn(),
    setRotationChainFetcher: vi.fn(),
    setOwnAikHint: vi.fn(),
    setPinRejectionListener: vi.fn(),
    setPinResolutionListener: vi.fn(),
    getTrustRecord: vi.fn(async () => null),
    getAtRestKey: vi.fn((): CryptoKey | null => null),
    getHistoryKey: vi.fn(() => null),
    rekeyAtRestStores: vi.fn(),
    clearHistory: vi.fn(),
    putGroup: vi.fn(),
    getGroup: vi.fn(),
    listGroupChannelIds: vi.fn(),
    getGroupIdToChannelMap: vi.fn(),
    deleteGroup: vi.fn(),
    putKpPrivate: vi.fn(),
    getAllKeyPackageCandidates: vi.fn(),
    deleteKpPrivate: vi.fn(),
    getMeta: vi.fn(),
    setMeta: vi.fn(),
    clearAll: vi.fn(),
  },
  client: {
    publishKeyPackages: vi.fn(),
    keyPackageCount: vi.fn(),
    consumeKeyPackages: vi.fn(),
    createGroup: vi.fn(),
    getGroupInfo: vi.fn(),
    submitCommit: vi.fn(),
    catchUp: vi.fn(),
    getWelcomes: vi.fn(),
    idempotencyKeyFor: vi.fn(),
    onMlsCommit: vi.fn(() => () => undefined),
    onMlsWelcome: vi.fn(() => () => undefined),
  },
  identity: {
    generateKeyPackages: vi.fn(),
    KEYPACKAGE_BATCH_SIZE: 20,
    KEYPACKAGE_LOW_WATER: 5,
  },
  tablock: {
    acquireLeadership: vi.fn(),
    isLeader: vi.fn(),
    releaseLeadership: vi.fn(),
  },
  apiClient: {
    getDMs: vi.fn(),
    getAikChain: vi.fn(async () => ({ chain: [], head: null })),
    getPeerAik: vi.fn(async () => ({ signingPublicKey: null })),
    resetGroup: vi.fn(async () => ({ success: true })),
  },
}));
vi.mock('../services/mls/mlsEngine', () => engine);
vi.mock('../services/mls/mlsGroupStore', () => store);
vi.mock('../services/mls/mlsIdentity', () => identity);

import * as core from '../services/mls/mlsCoordinatorCore';
import { installSeams } from '../services/mls/mlsCoordinatorCore';
import { setChannelProtocol } from '../services/encryptionFlags';

// `net` and `leadership` are spy-bearing references the tests assert on (net.keyPackageCount,
// leadership.acquire). They alias the hoisted client/tablock spies installed via installSeams.
const net = client;
const leadership = tablock;

function bundle(userId: string) {
  return {
    identity: {
      signaturePublicKey: new Uint8Array([1]),
      signaturePrivateKey: new Uint8Array([2]),
      credentialIdentity: new Uint8Array([3]),
    },
    userId,
    deviceId: 'dev',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
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
      getDMs: apiClient.getDMs,
      getAikChain: vi.fn(async () => ({ chain: [], head: null })),
      getPeerAik: vi.fn(async () => ({ signingPublicKey: null })),
      resetGroup: vi.fn(async () => ({ success: true })),
      idempotencyKeyFor: client.idempotencyKeyFor,
    },
    source: {
      onCommit: client.onMlsCommit,
      onWelcome: client.onMlsWelcome,
    },
    classification: { markMls: (id: string) => setChannelProtocol(id, 'mls') },
    leadership: {
      isLeader: tablock.isLeader,
      acquire: tablock.acquireLeadership,
      release: tablock.releaseLeadership,
    },
  });
  // Reset in-memory state AND the first-init latch between tests.
  core.deactivate();

  // Network: keyPackageCount resolves LOW so the leader-only tail does real work,
  // the rest resolve benign values; routing map empty; leader acquired.
  client.keyPackageCount.mockResolvedValue({ remaining: 0, hasLastResort: false });
  client.publishKeyPackages.mockResolvedValue(undefined);
  client.consumeKeyPackages.mockResolvedValue([]);
  client.getWelcomes.mockResolvedValue([]);
  client.catchUp.mockResolvedValue([]);
  client.idempotencyKeyFor.mockResolvedValue('idem-key-deadbeef');
  apiClient.getDMs.mockResolvedValue([]);
  store.getGroupIdToChannelMap.mockResolvedValue(new Map());
  store.getAllKeyPackageCandidates.mockResolvedValue([]);
  identity.generateKeyPackages.mockResolvedValue([]);
  tablock.isLeader.mockReturnValue(true);
  tablock.acquireLeadership.mockResolvedValue(true);
});

describe('core.activate', () => {
  it('runs the leader-only tail exactly once when activate is called twice concurrently', async () => {
    // Two concurrent activate() calls (same bundle/atRestKey).
    await Promise.all([
      core.activate(bundle('u1'), {} as CryptoKey, null),
      core.activate(bundle('u1'), {} as CryptoKey, null),
    ]);
    await new Promise((r) => setTimeout(r, 0)); // let the backgrounded tail run
    // keyPackageCount is the first network call in the leader-only tail
    // (replenishKeyPackagesIfLow); the latch makes the tail run once, not twice.
    expect(net.keyPackageCount).toHaveBeenCalledTimes(1);
  });

  it('activate() resolves after the prefix (_active true) without waiting for the leader tail', async () => {
    // The tail never completes (leadership.acquire hangs); activate() must still
    // resolve after the awaited prefix with _active === true, so a post-unlock
    // establishChannel RPC does not hit the "mls not active" guard.
    leadership.acquireLeadership.mockReturnValue(new Promise(() => {}));
    await core.activate(bundle('u1'), {} as CryptoKey, null);
    expect(core.isActive()).toBe(true);
  });
});
