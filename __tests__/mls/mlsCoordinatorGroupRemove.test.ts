// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression (security): commitRemoveMembersWithRebase must not corrupt
 * the base group state across a CAS rebase, and must fail closed when a removal target
 * is absent from the ratchet tree.
 *
 * ts-mls createCommit returns the INPUT state's own keySchedule.initSecret in `consumed`,
 * and mlsEngine.removeMembers zeroizes every consumed buffer in place. If the rebase loop
 * reused that same state for processHandshake (the winner replay), it would derive the
 * rebased epoch from a zeroed initSecret and the commit verification would fail
 * defeating the MLS establishment (move-not-borrow violation). The fix clones the base
 * state per attempt and replays the winner onto the INTACT base.
 *
 * This drives the REAL engine (the mocked mlsCoordinator.test.ts cannot catch the
 * reuse after zeroize hazard because it stubs the engine). Mirrors the Add analogue
 * mlsCoordinatorRebaseState.test.ts: a real 3 member epoch 1 group, a real "Bob" authored
 * winner commit, then a Remove rebased onto the intact base. Plus an absent-target throw.
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
}));
vi.mock('../../services/mls/mlsGroupStore', () => store);

import * as coordinator from '../../services/mls/mlsCoordinatorCore';
import { installSeams } from '../../services/mls/mlsCoordinatorCore';
import { createIdentity, generateKeyPackages } from '../../services/mls/mlsIdentity';
import { createGroup, addMembers, joinFromWelcome, selfUpdate, currentEpoch } from '../../services/mls/mlsEngine';
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
      idempotencyKeyFor: client.idempotencyKeyFor,
    },
    source: { onCommit: () => () => {}, onWelcome: () => () => {} },
    classification: { markMls: () => {} },
    leadership: { isLeader: () => true, acquire: async () => true, release: () => {} },
  });
  client.idempotencyKeyFor.mockResolvedValue('idem-k');
});

describe('mlsCoordinator.commitRemoveMembersWithRebase — real-engine Remove rebase preserves the base state', () => {
  it('replays the winner onto an intact base state, re-resolves the target leaf, removes, and resubmits (no reuse-after-zeroize)', async () => {
    const channelId = randomUUID();
    const groupId = randomUUID();
    const aliceId = await mkId(randomUUID(), randomUUID());
    const bobId = await mkId(randomUUID(), randomUUID());
    const carolId = await mkId(randomUUID(), randomUUID());

    // Alice creates the group and batch-adds Bob + Carol -> a real 3-member epoch-1 state.
    const aliceState0 = await createGroup(aliceId.identity, channelId);
    const bobKps = await generateKeyPackages(bobId.identity, 1, false);
    const carolKps = await generateKeyPackages(carolId.identity, 1, false);
    const addBoth = await addMembers(aliceState0, [bobKps[0].keyPackage, carolKps[0].keyPackage]);
    const aliceState1 = addBoth.newState; // epoch 1 (Alice + Bob + Carol)
    expect(currentEpoch(aliceState1)).toBe(1n);

    // Bob joins the same group so he can author a real winning commit. The Welcome from
    // the batched Add carries the ratchet tree (ratchetTreeExtension); each joiner uses
    // their own candidate.
    const bobCand: KeyPackageCandidate[] = bobKps.map((k) => ({
      keyPackageRef: b64(k.keyPackageRef),
      keyPackage: k.keyPackage,
      privateKeyPackage: k.privateKeyPackage,
      isLastResort: k.isLastResort,
    }));
    const bobState1 = (await joinFromWelcome(addBoth.welcome, bobCand)).state;
    expect(currentEpoch(bobState1)).toBe(1n);

    // Bob's self-update is a real epoch-1 -> 2 commit that Alice can process.
    const winner = await selfUpdate(bobState1);

    // First submit hits a CAS conflict (rebase); catch-up returns Bob's winner; after
    // replaying it Alice is at epoch 2, so the Carol-removal lands at epoch 3.
    client.submitCommit
      .mockResolvedValueOnce({ ok: false, conflict: 'rebase', currentEpoch: '2' })
      .mockResolvedValueOnce({ ok: true, epoch: '3', commitId: 'cid' });
    client.catchUp.mockResolvedValue([
      { baseEpoch: '1', resultingEpoch: '2', commit: toBase64(winner.commit), idempotencyKey: 'idem-k' },
    ]);

    // With the bug, removeMembers zeroizes aliceState1.keySchedule.initSecret and the
    // rebase reuses that same state in processHandshake -> wrong key schedule -> ts-mls
    // verification throws. With the fix (clone the base state for the consuming
    // removeMembers call) the rebase replays onto an intact initSecret, and the target
    // leaf is re-resolved against the rebased clone.
    await expect(
      coordinator.commitRemoveMembersWithRebase(channelId, groupId, aliceState1, [carolId.userId]),
    ).resolves.toBeUndefined();

    // Resubmitted once after the rebase, and persisted the final epoch-3 state.
    expect(client.submitCommit).toHaveBeenCalledTimes(2);
    expect(store.putGroup).toHaveBeenCalledTimes(1);
    const [ch, gid, , epoch] = store.putGroup.mock.calls[0];
    expect(ch).toBe(channelId);
    expect(gid).toBe(groupId);
    expect(epoch).toBe(3n);

    // Every submit carries the removed userId and NEVER a Welcome (a Remove seals nothing).
    for (const call of client.submitCommit.mock.calls) {
      expect(call[0].welcomes).toBeUndefined();
      expect(call[0].removedUserIds).toEqual([carolId.userId]);
    }
  }, 30000);

  it('throws (fails closed) before any submitCommit when a removal target is absent from the ratchet tree', async () => {
    const channelId = randomUUID();
    const groupId = randomUUID();
    const aliceId = await mkId(randomUUID(), randomUUID());
    const bobId = await mkId(randomUUID(), randomUUID());

    // Alice + Bob only (epoch 1); a third user never joined.
    const aliceState0 = await createGroup(aliceId.identity, channelId);
    const bobKps = await generateKeyPackages(bobId.identity, 1, false);
    const addBob = await addMembers(aliceState0, [bobKps[0].keyPackage]);
    const aliceState1 = addBob.newState;
    expect(currentEpoch(aliceState1)).toBe(1n);

    await expect(
      coordinator.commitRemoveMembersWithRebase(channelId, groupId, aliceState1, ['ghost-user-not-in-tree']),
    ).rejects.toThrow(/member not in ratchet tree/);

    // Failed closed before reaching the transport — no commit submitted, nothing persisted.
    expect(client.submitCommit).not.toHaveBeenCalled();
    expect(store.putGroup).not.toHaveBeenCalled();
  }, 30000);
});
