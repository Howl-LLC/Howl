// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression (security): commitAddWithRebase must not corrupt the base
 * group state across a CAS rebase. ts-mls createCommit returns the INPUT state's
 * own keySchedule.initSecret in `consumed`, and mlsEngine.addMembers zeroizes
 * every consumed buffer in place. If the rebase loop reuses that same state for
 * processHandshake (the winner replay), it derives the rebased epoch from a
 * zeroed initSecret and the commit verification fails — defeating the MLS
 * establishment (move-not-borrow violation).
 *
 * This drives the REAL engine (the existing mlsCoordinator.test.ts mocks the
 * engine, which is exactly why it cannot catch this). commitAddWithRebase is
 * only driven by createDmGroup at epoch 0, where a real rebase has no valid
 * winning commit (sole member), so we exercise it directly at epoch 1 with a
 * real two-member group and a real Bob-authored winner commit.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';

// Mock only the IO/leaf modules; the engine + identity + crypto helpers are REAL.
const { store, client, apiClient } = vi.hoisted(() => ({
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
  apiClient: { getDMs: vi.fn() },
  getAikChain: vi.fn(async () => ({ chain: [], head: null })),
  getPeerAik: vi.fn(async () => ({ signingPublicKey: null })),
  resetGroup: vi.fn(async () => ({ success: true })),
}));
vi.mock('../../services/mls/mlsGroupStore', () => store);

import * as coordinator from '../../services/mls/mlsCoordinatorCore';
import { installSeams } from '../../services/mls/mlsCoordinatorCore';
import { createIdentity, generateKeyPackages } from '../../services/mls/mlsIdentity';
import { createGroup, addMember, joinFromWelcome, selfUpdate, currentEpoch } from '../../services/mls/mlsEngine';
import type { KeyPackageCandidate } from '../../services/mls/mlsEngine';
import { toBase64 } from '../../services/cryptoHelpers';

// createIdentity is now 4-arg (AIK cross-sign). Thread an ephemeral AIK per call.
function mkId(userId: string, deviceId: string) {
  const aik = nacl.sign.keyPair();
  return createIdentity(userId, deviceId, aik.publicKey, aik.secretKey);
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

beforeEach(() => {
  vi.clearAllMocks();
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
    source: { onCommit: () => () => {}, onWelcome: () => () => {} },
    classification: { markMls: () => {} },
    leadership: { isLeader: () => true, acquire: async () => true, release: () => {} },
  });
  client.idempotencyKeyFor.mockResolvedValue('idem-k');
});

describe('mlsCoordinator.commitAddWithRebase — real-engine rebase preserves the base state', () => {
  it('replays the winner onto an intact base state and resubmits (no reuse-after-zeroize)', async () => {
    const channelId = randomUUID();
    const groupId = randomUUID();
    const aliceId = await mkId(randomUUID(), randomUUID());
    const bobId = await mkId(randomUUID(), randomUUID());
    const carolId = await mkId(randomUUID(), randomUUID());

    // Alice creates the group and adds Bob -> a real 2-member epoch-1 state.
    const aliceState0 = await createGroup(aliceId.identity, channelId);
    const bobKps = await generateKeyPackages(bobId.identity, 1, false);
    const addBob = await addMember(aliceState0, bobKps[0].keyPackage);
    const aliceState1 = addBob.newState; // epoch 1 (Alice + Bob)
    expect(currentEpoch(aliceState1)).toBe(1n);

    // Bob joins the same group so he can author a real winning commit.
    const bobCand: KeyPackageCandidate[] = bobKps.map((k) => ({
      keyPackageRef: b64(k.keyPackageRef),
      keyPackage: k.keyPackage,
      privateKeyPackage: k.privateKeyPackage,
      isLastResort: k.isLastResort,
    }));
    const bobState1 = (await joinFromWelcome(addBob.welcome, bobCand)).state;
    expect(currentEpoch(bobState1)).toBe(1n);

    // Bob's self-update is a real epoch-1 -> 2 commit that Alice can process.
    const winner = await selfUpdate(bobState1);

    // Carol is the member commitAddWithRebase will add.
    const carolKps = await generateKeyPackages(carolId.identity, 1, false);
    const carolKp = carolKps[0].keyPackage;

    // First submit hits a CAS conflict (rebase); catch-up returns Bob's winner;
    // after replaying it Alice is at epoch 2, so the re-add lands at epoch 3.
    client.submitCommit
      .mockResolvedValueOnce({ ok: false, conflict: 'rebase', currentEpoch: '2' })
      .mockResolvedValueOnce({ ok: true, epoch: '3', commitId: 'cid' });
    client.catchUp.mockResolvedValue([
      { baseEpoch: '1', resultingEpoch: '2', commit: toBase64(winner.commit), idempotencyKey: 'idem-k' },
    ]);

    // With the bug, addMembers zeroizes aliceState1.keySchedule.initSecret and the
    // rebase reuses that same state in processHandshake -> wrong key schedule ->
    // ts-mls verification throws. With the fix (clone the base state for the
    // consuming addMembers call) the rebase replays onto an intact initSecret.
    await expect(
      coordinator.commitAddWithRebase(channelId, groupId, aliceState1, carolId.userId, carolKp),
    ).resolves.toBeUndefined();

    // Resubmitted once after the rebase, and persisted the final epoch-3 state.
    expect(client.submitCommit).toHaveBeenCalledTimes(2);
    expect(store.putGroup).toHaveBeenCalledTimes(1);
    const [ch, gid, , epoch] = store.putGroup.mock.calls[0];
    expect(ch).toBe(channelId);
    expect(gid).toBe(groupId);
    expect(epoch).toBe(3n);
  }, 30000);
});
