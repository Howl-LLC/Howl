// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * core.deactivate() must zeroize the identity key buffers.
 * On the SharedWorker path the worker holds a structured-clone of the identity
 * buffers, so the main-thread clearMlsState aliasing scrub does NOT reach them.
 * deactivate() therefore scrubs the raw Ed25519 signing key + public + credential
 * bytes itself (safe + idempotent on the in-process fallback path too).
 *
 * Reuses the engine/store/identity hoisted-mocks + installSeams scaffolding from
 * __tests__/mlsCoordinatorCore.activate.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock leaf modules
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
    getHistoryKey: vi.fn(() => null),
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

describe('core.deactivate zeroizes identity', () => {
  it('fills the signing/public/credential buffers with zeros on deactivate', async () => {
    const priv = new Uint8Array([9, 9, 9]);
    const pub = new Uint8Array([8, 8]);
    const cred = new Uint8Array([7]);
    await core.activate(
      {
        identity: {
          signaturePrivateKey: priv,
          signaturePublicKey: pub,
          credentialIdentity: cred,
        },
        userId: 'u1',
        deviceId: 'd',
      },
      {} as CryptoKey,
      null,
    );
    core.deactivate();
    expect(Array.from(priv)).toEqual([0, 0, 0]);
    expect(Array.from(pub)).toEqual([0, 0]);
    expect(Array.from(cred)).toEqual([0]);
  });
});
