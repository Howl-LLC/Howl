// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * deriveSframeBaseKey(dmChannelId) worker-core RPC.
 * Mocks engine/store/identity; injects client/tablock/api via installSeams
 * (same harness as mlsCoordinator.test.ts), so we test the wiring only:
 *  - null (never throw) on every not-ready path, so the caller can take the
 *    legacy rung of the fallback ladder.
 *  - engine.exportSecret is called with the RFC 9605 constants (read-only:
 *    the derive never persists group state).
 *  - the derived buffer is zeroized after base64 encoding (move-not-borrow).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock leaf modules via vi.hoisted so they exist both inside the (hoisted)
// vi.mock factories and in the test body. Shapes mirror mlsCoordinator.test.ts
// plus the exporter surface (exportSecret + the two constants).
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
    exportSecret: vi.fn(),
    SFRAME_EXPORTER_LABEL: 'SFrame 1.0 Base Key',
    SFRAME_BASE_KEY_LEN: 32,
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
    getHistoryKey: vi.fn((): CryptoKey | null => null),
    rekeyAtRestStores: vi.fn(),
    clearHistory: vi.fn(),
    getHistory: vi.fn((): Promise<string | null> => Promise.resolve(null)),
    putGroupAndHistory: vi.fn(),
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

import * as coordinator from '../services/mls/mlsCoordinatorCore';
import { installSeams } from '../services/mls/mlsCoordinatorCore';
import { setChannelProtocol } from '../services/encryptionFlags';
import { toBase64 } from '../services/cryptoHelpers';

const CHANNEL = '00000000-0000-4000-8000-00000000aa01';
const GROUP = 'group-aa01';
const atRestKey = {} as CryptoKey;
const bundle = (userId: string) => ({
  identity: {
    signaturePublicKey: new Uint8Array([1]),
    signaturePrivateKey: new Uint8Array([2]),
    credentialIdentity: new Uint8Array([3]),
  },
  userId,
  deviceId: 'dev',
});

async function activateAsLeaderWithGroup() {
  tablock.acquireLeadership.mockResolvedValue(true);
  tablock.isLeader.mockReturnValue(true);
  // Activation discovers the already-established group, populating _loadedGroups.
  store.getGroupIdToChannelMap.mockResolvedValue(new Map([[GROUP, { roomKey: CHANNEL, channelId: CHANNEL, tier: 'saved' }]]));
  store.getAllKeyPackageCandidates.mockResolvedValue([]);
  client.keyPackageCount.mockResolvedValue({ remaining: 50, hasLastResort: true });
  client.getWelcomes.mockResolvedValue([]);
  client.catchUp.mockResolvedValue([]); // discovery triggers catchUpAllGroups in the tail
  apiClient.getDMs.mockResolvedValue([]);
  await coordinator.activate(bundle('u1'), atRestKey, null);
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
  coordinator.deactivate();
  client.idempotencyKeyFor.mockResolvedValue('idem-key-deadbeef');
});

describe('deriveSframeBaseKey', () => {
  it('returns null when inactive / not leader / channel not loaded (fail closed, no throw)', async () => {
    tablock.isLeader.mockReturnValue(false);
    await expect(coordinator.deriveSframeBaseKey(CHANNEL)).resolves.toBeNull();
    expect(engine.exportSecret).not.toHaveBeenCalled();
  });

  it('returns null for a channel with no loaded group even when active leader', async () => {
    await activateAsLeaderWithGroup();
    await expect(coordinator.deriveSframeBaseKey('00000000-0000-4000-8000-00000000bb02')).resolves.toBeNull();
    expect(engine.exportSecret).not.toHaveBeenCalled();
  });

  it('derives via engine.exportSecret with the RFC 9605 constants and returns base64 key + decimal epoch', async () => {
    await activateAsLeaderWithGroup();
    const state = { fake: 'state' };
    // lastAppliedEpoch deliberately differs from currentEpoch: the epoch in
    // the result must come from engine.currentEpoch(state), the same state
    // the exporter ran on, never from the persisted meta row.
    store.getGroup.mockResolvedValue({ state, meta: { dmChannelId: CHANNEL, groupId: GROUP, lastAppliedEpoch: 6n } });
    const keyBytes = new Uint8Array(32).fill(0xab);
    engine.exportSecret.mockResolvedValue(new Uint8Array(keyBytes)); // copy: the impl zeroizes its buffer
    engine.currentEpoch.mockReturnValue(7n);

    const result = await coordinator.deriveSframeBaseKey(CHANNEL);
    expect(result).toEqual({ keyB64: toBase64(keyBytes), epoch: '7' });
    expect(engine.exportSecret).toHaveBeenCalledWith(state, 'SFrame 1.0 Base Key', new Uint8Array(0), 32);
  });

  it('zeroizes the derived buffer after encoding', async () => {
    await activateAsLeaderWithGroup();
    store.getGroup.mockResolvedValue({ state: {}, meta: { dmChannelId: CHANNEL, groupId: GROUP, lastAppliedEpoch: 1n } });
    const derived = new Uint8Array(32).fill(0xcd);
    engine.exportSecret.mockResolvedValue(derived);
    engine.currentEpoch.mockReturnValue(1n);
    await coordinator.deriveSframeBaseKey(CHANNEL);
    expect(Array.from(derived)).toEqual(new Array(32).fill(0)); // move-not-borrow discipline
  });

  it('returns null when the group record is missing from the store', async () => {
    await activateAsLeaderWithGroup();
    store.getGroup.mockResolvedValue(null);
    await expect(coordinator.deriveSframeBaseKey(CHANNEL)).resolves.toBeNull();
  });
});
