// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mlsSeams.mainNetwork delegates to mlsClient + apiClient. Mock both so the
// seam tests assert the exact delegation (createGroup threads tier; getDMs maps
// otrMlsGroupId) without a live network. markMls still uses the real
// encryptionFlags/mlsTabLock (not mocked here).
const createGroupMock = vi.fn();
vi.mock('../services/mls/mlsClient', () => ({
  publishKeyPackages: vi.fn(),
  keyPackageCount: vi.fn(),
  consumeKeyPackages: vi.fn(),
  createGroup: (...args: unknown[]) => createGroupMock(...args),
  getGroupInfo: vi.fn(),
  submitCommit: vi.fn(),
  catchUp: vi.fn(),
  getWelcomes: vi.fn(),
  getAikChain: vi.fn(),
  idempotencyKeyFor: vi.fn(),
  onMlsCommit: vi.fn(),
  onMlsWelcome: vi.fn(),
}));

const getDMsMock = vi.fn();
vi.mock('../services/api', () => ({
  apiClient: {
    getDMs: (...args: unknown[]) => getDMsMock(...args),
  },
}));

import { mainNetwork, mainClassificationSink, mainLeadershipGate } from '../services/mls/mlsSeams';

beforeEach(() => {
  createGroupMock.mockReset();
  getDMsMock.mockReset();
});

describe('mlsSeams (main-thread adapters)', () => {
  it('mainNetwork exposes all MlsNetwork methods', () => {
    const n = mainNetwork();
    for (const m of ['publishKeyPackages','keyPackageCount','consumeKeyPackages','createGroup','getGroupInfo','submitCommit','catchUp','getWelcomes','getDMs','getAikChain','idempotencyKeyFor'] as const) {
      expect(typeof n[m]).toBe('function');
    }
  });
  it('mainClassificationSink.markMls delegates to setChannelProtocol', async () => {
    mainClassificationSink().markMls('chan-x');
    const { isChannelMls } = await import('../services/encryptionFlags');
    expect(isChannelMls('chan-x')).toBe(true);
  });
  it('mainLeadershipGate exposes isLeader/acquire/release', () => {
    const g = mainLeadershipGate();
    expect(typeof g.isLeader).toBe('function');
    expect(typeof g.acquire).toBe('function');
    expect(typeof g.release).toBe('function');
  });

  it('createGroup threads tier to mlsClient.createGroup', async () => {
    createGroupMock.mockResolvedValue({ groupId: 'g1', currentEpoch: '0' });
    await mainNetwork().createGroup('11111111-1111-4111-8111-111111111111', 'gi', 'otr');
    expect(createGroupMock).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'gi', 'otr');
  });

  it('getDMs maps otrMlsGroupId from the API list item', async () => {
    getDMsMock.mockResolvedValue([
      { id: '22222222-2222-4222-8222-222222222222', mlsGroupId: 'saved-g', otrMlsGroupId: 'otr-g' },
    ]);
    const dms = await mainNetwork().getDMs();
    expect(dms).toEqual([
      { id: '22222222-2222-4222-8222-222222222222', mlsGroupId: 'saved-g', otrMlsGroupId: 'otr-g' },
    ]);
  });

  it('getDMs defaults otrMlsGroupId to null when absent', async () => {
    getDMsMock.mockResolvedValue([{ id: '33333333-3333-4333-8333-333333333333', mlsGroupId: 'saved-g' }]);
    const dms = await mainNetwork().getDMs();
    expect(dms[0].otrMlsGroupId).toBeNull();
  });
});
