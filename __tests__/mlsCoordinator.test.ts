// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * mlsCoordinator orchestration.
 * Mocks engine/store/identity; injects client/tablock/api via installSeams, so we test the wiring only:
 *  - encrypt() fails closed when the channel isn't ready (no downgrade).
 *  - createDmGroup() runs create -> consume -> addMembers -> submitCommit and
 *    persists state + classifies the channel 'mls' (initiator side only).
 *  - the non-initiator side (own userId lexicographically > recipient)
 *    returns early without touching engine.createGroup / client.createGroup.
 *  - the backend create-once 409 is treated as "peer beat me" -> the local
 *    group is discarded and the join path owns it.
 *  - a Welcome whose groupId has no local store-map row still joins via the
 *    api.getDMs() union mapping (mlsGroupId -> channel.id).
 *  - the rebase loop resubmits the commit after a 409 'rebase' conflict.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
    ownLeafCredentialIsLegacy: vi.fn(() => false),
    processHandshake: vi.fn(),
    encryptApp: vi.fn(),
    decryptApp: vi.fn(),
    makeGroupInfo: vi.fn(),
    currentEpoch: vi.fn(),
    copyBytes: (b: Uint8Array) => new Uint8Array(b),
    // Identity passthrough: commitAddWithRebase clones the base state via
    // decodeState(encodeState(state)) before addMembers (move-not-borrow). With
    // the real engine that is a deep copy; here the wiring tests only need the
    // same state object to flow through so the existing assertions hold.
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
    // Read by consumeOneKeyPackage as the arg passed to the (stubbed-out) adder
    // check; never invoked here because assertConsumedKeyPackageTrusted is mocked
    // to a passthrough. Present only so the mock-module proxy can read the export.
    pinOrVerifyAik: vi.fn(async () => true),
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
    // credentialIdentityFor (real) decodes each leaf's credential to match by userId.
    // The fake ratchet-tree leaves below carry `${userId}:dev` bytes, so the mock
    // decoder extracts the userId by splitting on ':' (throws on non-decodable bytes,
    // mirroring the real fail-closed decode the resolver's try/catch relies on).
    decodeMlsCredentialIdentity: vi.fn((bytes: Uint8Array) => {
      const parts = new TextDecoder().decode(bytes).split(':');
      if (parts.length < 2 || !parts[0]) throw new Error('decode: malformed');
      return { version: 2, userId: parts[0], deviceId: parts[1], aikPub: new Uint8Array(32), crossSig: new Uint8Array(64) };
    }),
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
// These are WIRING tests: consumeKeyPackages is mocked to return FAKE KeyPackage
// bytes (e.g. btoa('kp')), and mlsGroupStore/mlsEngine are fully mocked, so the
// real adder-side check would reject every consumed package on bytes
// that were never meant to be a valid KeyPackage. Stub ONLY the choke-point check
// to a passthrough so the consume->add->submitCommit orchestration under test is
// unchanged; the real assertConsumedKeyPackageTrusted is fully exercised by
// __tests__/mls/adderCheck.test.ts (and verifyLeafCredential by validateCredential.test.ts).
vi.mock('../services/mls/credentialTrust', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mls/credentialTrust')>()),
  assertConsumedKeyPackageTrusted: vi.fn(async () => undefined),
}));

import * as coordinator from '../services/mls/mlsCoordinatorCore';
import { installSeams, joinViaExternalCommit, isReadyForChannel, activate, createDmGroup, establishChannel, establishGroupDmChannel, removeAbsentLeaver, handleGroupLeaderElection, mlsEvents, deactivate, isActive } from '../services/mls/mlsCoordinatorCore';
import { setChannelProtocol } from '../services/encryptionFlags';
import { encodeMlsEnvelope } from '../services/mls/types';

const CHANNEL = '00000000-0000-4000-8000-000000000001';
const GROUP = '00000000-0000-4000-8000-0000000000a1';
// Recipient userId for the establish flow. Lexicographically BETWEEN the small
// and large creator ids so the initiator gate flips with the creator id.
const RECIPIENT = 'bbbb-recipient';

// Creator userId for the happy-path tests; lexicographically < RECIPIENT
// ('aaaa' < 'bbbb'). Either side builds.
const CREATOR_SMALL = 'aaaa-creator';

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
const atRestKey = {} as CryptoKey;

async function activateAsLeader(userId: string = CREATOR_SMALL) {
  tablock.acquireLeadership.mockResolvedValue(true);
  tablock.isLeader.mockReturnValue(true);
  store.getGroupIdToChannelMap.mockResolvedValue(new Map());
  store.getAllKeyPackageCandidates.mockResolvedValue([]);
  client.keyPackageCount.mockResolvedValue({ remaining: 50, hasLastResort: true });
  client.getWelcomes.mockResolvedValue([]);
  apiClient.getDMs.mockResolvedValue([]);
  await coordinator.activate(bundle(userId), atRestKey, null);
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

describe('mlsCoordinator.encrypt — fail closed', () => {
  it('throws when the channel is not ready (never downgrades)', async () => {
    // Not active, no group loaded -> isReadyForChannel false.
    tablock.isLeader.mockReturnValue(false);
    await expect(coordinator.encrypt(CHANNEL, 'hi')).rejects.toThrow();
    expect(engine.encryptApp).not.toHaveBeenCalled();
  });
});

describe('mlsCoordinator.createDmGroup — happy path (initiator)', () => {
  it('creates group, consumes a KP, adds member, submits commit, persists, classifies mls', async () => {
    await activateAsLeader(CREATOR_SMALL);

    const epoch0State = { tag: 'epoch0' };
    const epoch1State = { tag: 'epoch1' };
    engine.createGroup.mockResolvedValue(epoch0State);
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    engine.currentEpoch.mockImplementation((s: unknown) => (s === epoch1State ? 1n : 0n));
    client.createGroup.mockResolvedValue({ groupId: GROUP, currentEpoch: '0' });
    client.consumeKeyPackages.mockResolvedValue([
      { deviceId: 'rdev', keyPackage: btoa('kp'), keyPackageRef: 'ref', isLastResort: false },
    ]);
    engine.addMembers.mockResolvedValue({
      newState: epoch1State,
      commit: new Uint8Array([0xc0]),
      welcome: new Uint8Array([0xa0]),
    });
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '1', commitId: 'cid' });

    await coordinator.createDmGroup(CHANNEL, RECIPIENT);

    expect(engine.createGroup).toHaveBeenCalledTimes(1);
    expect(client.createGroup).toHaveBeenCalledWith(CHANNEL, expect.any(String), 'saved');
    expect(client.consumeKeyPackages).toHaveBeenCalledWith(RECIPIENT);
    expect(engine.addMembers).toHaveBeenCalledTimes(1);
    // A 1:1 (isGroup=false) member Add MUST be wired as an mls_private_message: the
    // backend non-group commit gate rejects a public 1:1 commit as wrong_wireformat.
    // createDmGroup passes wireAsPublicMessage=false; addMembers receives it as arg 3.
    expect(engine.addMembers.mock.calls[0][2]).toBe(false);
    expect(client.submitCommit).toHaveBeenCalledTimes(1);
    const submitArgs = client.submitCommit.mock.calls[0][0];
    expect(submitArgs.groupId).toBe(GROUP);
    expect(submitArgs.baseEpoch).toBe('0');
    expect(submitArgs.mode).toBe('member');
    expect(submitArgs.welcomes).toHaveLength(1);
    expect(submitArgs.welcomes[0].recipientId).toBe(RECIPIENT);
    // Idempotency key is the deterministic one from idempotencyKeyFor.
    expect(client.idempotencyKeyFor).toHaveBeenCalledWith(GROUP, '0', 'add', RECIPIENT);
    expect(submitArgs.idempotencyKey).toBe('idem-key-deadbeef');
    // Persisted the epoch-1 state and classified the channel.
    expect(store.putGroup).toHaveBeenCalledWith(CHANNEL, GROUP, epoch1State, 1n, { channelId: CHANNEL, tier: 'saved' });
    const { isChannelMls } = await import('../services/encryptionFlags');
    expect(isChannelMls(CHANNEL)).toBe(true);
    expect(coordinator.isReadyForChannel(CHANNEL)).toBe(true);
  });
});

describe('mlsCoordinator.createDmGroup — either party creates (initiator gate dropped)', () => {
  it('creates a group even when own userId sorts AFTER the recipient', async () => {
    // Self = 'zzz' sorts after recipient 'aaa'; either side creates.
    tablock.acquireLeadership.mockResolvedValue(true);
    tablock.isLeader.mockReturnValue(true);
    store.getGroupIdToChannelMap.mockResolvedValue(new Map());
    client.keyPackageCount.mockResolvedValue({ remaining: 99, hasLastResort: true });
    client.getWelcomes.mockResolvedValue([]);
    await activate({ userId: 'zzz', deviceId: 'd1', identity: {} as never }, {} as never, null);

    engine.createGroup.mockResolvedValue({ tag: 's0' });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([1]));
    client.createGroup.mockResolvedValue({ groupId: 'g', currentEpoch: '0' });
    client.consumeKeyPackages.mockResolvedValue([{ deviceId: 'd', keyPackage: 'QQ', keyPackageRef: 'r', isLastResort: false }]);
    engine.addMembers.mockResolvedValue({ newState: { tag: 's1' }, commit: new Uint8Array([2]), welcome: new Uint8Array([3]) });
    engine.currentEpoch.mockReturnValue(0n);
    client.idempotencyKeyFor.mockResolvedValue('k');
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '1', commitId: 'c' });

    await createDmGroup('chan-x', 'aaa');

    expect(engine.createGroup).toHaveBeenCalled();   // no early return
    expect(client.createGroup).toHaveBeenCalled();
    expect(isReadyForChannel('chan-x')).toBe(true);
  });
});

describe('mlsCoordinator.establishChannel', () => {
  async function activateLeader(userId = 'u-self') {
    tablock.acquireLeadership.mockResolvedValue(true);
    tablock.isLeader.mockReturnValue(true);
    store.getGroupIdToChannelMap.mockResolvedValue(new Map());
    client.keyPackageCount.mockResolvedValue({ remaining: 99, hasLastResort: true });
    client.getWelcomes.mockResolvedValue([]);
    await activate({ userId, deviceId: 'd1', identity: {} as never }, {} as never, null);
  }

  it('throws (fail closed) when not leader', async () => {
    await activateLeader();
    tablock.isLeader.mockReturnValue(false);
    await expect(establishChannel('c', 'r')).rejects.toThrow(/leader/);
  });

  it('step 2: a server group exists -> external join path (no create)', async () => {
    await activateLeader();
    client.getWelcomes.mockResolvedValue([]); // step 1 finds nothing
    client.getGroupInfo.mockResolvedValue({ groupInfo: 'RR', groupInfoEpoch: '3' }); // 'RR' = valid base64 GroupInfo blob
    engine.joinExternal.mockResolvedValue({ newState: { tag: 'j' }, commit: new Uint8Array([1]) });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([2]));
    engine.currentEpoch.mockReturnValue(4n);
    client.idempotencyKeyFor.mockResolvedValue('k');
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '4', commitId: 'c' });

    await establishChannel('chan-e', 'recip', 'grp-e'); // mlsGroupId passed -> no getDMs needed

    expect(engine.joinExternal).toHaveBeenCalled();
    expect(engine.createGroup).not.toHaveBeenCalled();
    expect(isReadyForChannel('chan-e')).toBe(true);
  });

  it('step 3: no group anywhere -> create path', async () => {
    await activateLeader('aaa'); // small id, will build
    client.getWelcomes.mockResolvedValue([]);
    apiClient.getDMs.mockResolvedValue([{ id: 'chan-n', mlsGroupId: null }]); // resolveServerGroupId -> null
    engine.createGroup.mockResolvedValue({ tag: 's0' });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([1]));
    client.createGroup.mockResolvedValue({ groupId: 'g', currentEpoch: '0' });
    client.consumeKeyPackages.mockResolvedValue([{ deviceId: 'd', keyPackage: 'QQ', keyPackageRef: 'r', isLastResort: false }]);
    engine.addMembers.mockResolvedValue({ newState: { tag: 's1' }, commit: new Uint8Array([2]), welcome: new Uint8Array([3]) });
    engine.currentEpoch.mockReturnValue(0n);
    client.idempotencyKeyFor.mockResolvedValue('k');
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '1', commitId: 'c' });

    await establishChannel('chan-n', 'zzz'); // no mlsGroupId -> resolveServerGroupId pass

    expect(engine.createGroup).toHaveBeenCalled();
    expect(isReadyForChannel('chan-n')).toBe(true);
  });

  it('idempotent: concurrent calls for the same channel share one in-flight resolution', async () => {
    await activateLeader();
    client.getWelcomes.mockResolvedValue([]);
    client.getGroupInfo.mockResolvedValue({ groupInfo: 'RR', groupInfoEpoch: '3' }); // 'RR' = valid base64 GroupInfo blob
    engine.joinExternal.mockResolvedValue({ newState: { tag: 'j' }, commit: new Uint8Array([1]) });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([2]));
    engine.currentEpoch.mockReturnValue(4n);
    client.idempotencyKeyFor.mockResolvedValue('k');
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '4', commitId: 'c' });

    await Promise.all([
      establishChannel('chan-d', 'r', 'grp-d'),
      establishChannel('chan-d', 'r', 'grp-d'),
    ]);

    expect(engine.joinExternal).toHaveBeenCalledTimes(1); // deduped
  });
});

describe('mlsCoordinator establish: stale cached groupId 404 hardening', () => {
  // The backend may DELETE + RECREATE an abandoned epoch-0 MlsGroup row, minting
  // a NEW groupId; other participants' dmStore still holds the OLD id mid-session.
  // A 404 from a cached/caller-supplied id must re-resolve via
  // getDMs and retry the join once (or fall through to create when the group is
  // gone) instead of aborting the tree before step 3.
  async function activateLeader(userId = 'u-self') {
    tablock.acquireLeadership.mockResolvedValue(true);
    tablock.isLeader.mockReturnValue(true);
    store.getGroupIdToChannelMap.mockResolvedValue(new Map());
    client.keyPackageCount.mockResolvedValue({ remaining: 99, hasLastResort: true });
    client.getWelcomes.mockResolvedValue([]);
    await activate({ userId, deviceId: 'd1', identity: {} as never }, {} as never, null);
  }

  it('re-resolves a stale caller-supplied groupId on 404 and retries the join with the fresh id', async () => {
    await activateLeader();
    client.getWelcomes.mockResolvedValue([]); // step 1 finds nothing
    apiClient.getDMs.mockResolvedValue([{ id: 'chan-stale', mlsGroupId: 'grp-fresh' }]);
    client.getGroupInfo.mockImplementation((groupId: string) =>
      groupId === 'grp-stale'
        ? Promise.reject(Object.assign(new Error('Group not found'), { status: 404 }))
        : Promise.resolve({ groupInfo: 'RR', groupInfoEpoch: '3' }),
    );
    engine.joinExternal.mockResolvedValue({ newState: { tag: 'j' }, commit: new Uint8Array([1]) });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([2]));
    engine.currentEpoch.mockReturnValue(4n);
    client.idempotencyKeyFor.mockResolvedValue('k');
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '4', commitId: 'c' });

    await establishChannel('chan-stale', 'recip', 'grp-stale'); // cached id is stale

    expect(client.getGroupInfo).toHaveBeenCalledWith('grp-stale');
    expect(client.getGroupInfo).toHaveBeenCalledWith('grp-fresh'); // retried with the re-resolved id
    expect(engine.joinExternal).toHaveBeenCalledTimes(1); // joined via the fresh id
    expect(engine.createGroup).not.toHaveBeenCalled();
    expect(isReadyForChannel('chan-stale')).toBe(true);
  });

  it('falls through to the create path when the stale groupId 404s and no fresh id exists', async () => {
    await activateLeader('aaa');
    client.getWelcomes.mockResolvedValue([]);
    apiClient.getDMs.mockResolvedValue([{ id: 'chan-gone', mlsGroupId: null }]); // group gone, none minted
    client.getGroupInfo.mockRejectedValue(Object.assign(new Error('Group not found'), { status: 404 }));
    engine.createGroup.mockResolvedValue({ tag: 's0' });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([1]));
    client.createGroup.mockResolvedValue({ groupId: 'g', currentEpoch: '0' });
    client.consumeKeyPackages.mockResolvedValue([{ deviceId: 'd', keyPackage: 'QQ', keyPackageRef: 'r', isLastResort: false }]);
    engine.addMembers.mockResolvedValue({ newState: { tag: 's1' }, commit: new Uint8Array([2]), welcome: new Uint8Array([3]) });
    engine.currentEpoch.mockReturnValue(0n);
    client.idempotencyKeyFor.mockResolvedValue('k');
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '1', commitId: 'c' });

    await establishChannel('chan-gone', 'zzz', 'grp-stale-2');

    expect(client.createGroup).toHaveBeenCalled(); // step 3 reached, not aborted by the 404
    expect(isReadyForChannel('chan-gone')).toBe(true);
  });

  it('control: a non-404 getGroupInfo error still rejects (no swallow, no re-resolve)', async () => {
    await activateLeader();
    client.getWelcomes.mockResolvedValue([]);
    client.getGroupInfo.mockRejectedValue(Object.assign(new Error('server exploded'), { status: 500 }));

    await expect(establishChannel('chan-f', 'r', 'grp-f')).rejects.toThrow('server exploded');
    expect(client.getGroupInfo).toHaveBeenCalledTimes(1); // no retry
    expect(engine.createGroup).not.toHaveBeenCalled();
  });
});

describe('mlsCoordinator.establishGroupDmChannel', () => {
  async function activateLeader(userId = 'u-self') {
    tablock.acquireLeadership.mockResolvedValue(true);
    tablock.isLeader.mockReturnValue(true);
    store.getGroupIdToChannelMap.mockResolvedValue(new Map());
    store.getAllKeyPackageCandidates.mockResolvedValue([]);
    client.keyPackageCount.mockResolvedValue({ remaining: 99, hasLastResort: true });
    client.getWelcomes.mockResolvedValue([]);
    apiClient.getDMs.mockResolvedValue([]);
    await activate({ userId, deviceId: 'd1', identity: {} as never }, {} as never, null);
  }

  it('throws (fail closed) when not leader', async () => {
    await activateLeader();
    tablock.isLeader.mockReturnValue(false);
    await expect(establishGroupDmChannel('g-chan')).rejects.toThrow(/leader/);
  });

  it('step 2: a server group exists -> external join path (never create)', async () => {
    await activateLeader();
    client.getWelcomes.mockResolvedValue([]); // step 1 finds nothing
    client.getGroupInfo.mockResolvedValue({ groupInfo: 'RR', groupInfoEpoch: '3' });
    engine.joinExternal.mockResolvedValue({ newState: { tag: 'gj' }, commit: new Uint8Array([1]) });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([2]));
    engine.currentEpoch.mockReturnValue(4n);
    client.idempotencyKeyFor.mockResolvedValue('k');
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '4', commitId: 'c' });

    await establishGroupDmChannel('g-chan-e', 'grp-ge'); // mlsGroupId passed -> no getDMs needed

    expect(engine.joinExternal).toHaveBeenCalled();
    expect(engine.createGroup).not.toHaveBeenCalled(); // a joining member never creates
    expect(isReadyForChannel('g-chan-e')).toBe(true);
  });

  it('step 1: a pending Welcome resolves the group before any External Commit', async () => {
    await activateLeader();
    store.getAllKeyPackageCandidates.mockResolvedValue([
      { keyPackageRef: 'kpref-gw', keyPackage: new Uint8Array([9]), privateKeyPackage: new Uint8Array([8]), isLastResort: false },
    ]);
    client.getWelcomes.mockResolvedValue([{ groupId: 'grp-gw', epoch: '1', welcomeData: btoa('wd') }]);
    apiClient.getDMs.mockResolvedValue([{ id: 'g-chan-w', mlsGroupId: 'grp-gw' }]);
    engine.joinFromWelcome.mockResolvedValue({ state: { tag: 'gw' }, consumedKpRef: 'kpref-gw', isLastResort: false });
    engine.currentEpoch.mockReturnValue(1n);

    await establishGroupDmChannel('g-chan-w'); // no mlsGroupId -> getDMs union mapping resolves it

    expect(engine.joinFromWelcome).toHaveBeenCalled();
    expect(engine.joinExternal).not.toHaveBeenCalled(); // step 1 short-circuits step 2
    expect(engine.createGroup).not.toHaveBeenCalled();  // and step 3
    expect(isReadyForChannel('g-chan-w')).toBe(true);
  });

  it('idempotent: concurrent group calls for the same channel share one in-flight resolution', async () => {
    await activateLeader();
    client.getWelcomes.mockResolvedValue([]);
    client.getGroupInfo.mockResolvedValue({ groupInfo: 'RR', groupInfoEpoch: '3' });
    engine.joinExternal.mockResolvedValue({ newState: { tag: 'gj' }, commit: new Uint8Array([1]) });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([2]));
    engine.currentEpoch.mockReturnValue(4n);
    client.idempotencyKeyFor.mockResolvedValue('k');
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '4', commitId: 'c' });

    await Promise.all([
      establishGroupDmChannel('g-chan-d', 'grp-gd'),
      establishGroupDmChannel('g-chan-d', 'grp-gd'),
    ]);

    expect(engine.joinExternal).toHaveBeenCalledTimes(1); // deduped
  });
});

describe('mlsCoordinator.createDmGroup — create-once 409 means peer beat me', () => {
  it('discards the local group and defers to the Welcome path on a 409', async () => {
    await activateAsLeader(CREATOR_SMALL); // initiator side

    engine.createGroup.mockResolvedValue({ tag: 'epoch0' });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    client.consumeKeyPackages.mockResolvedValue([
      { deviceId: 'rdev', keyPackage: btoa('kp'), keyPackageRef: 'ref', isLastResort: false },
    ]);
    // client.createGroup throws a 409 (group already exists — peer beat me).
    client.createGroup.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));

    await coordinator.createDmGroup(CHANNEL, RECIPIENT);

    // Built the local group + consumed the peer's KP (consume-before-create: the race
    // loser burns one KP per member, an accepted tradeoff) + tried to register, but
    // bailed without committing.
    expect(engine.createGroup).toHaveBeenCalledTimes(1);
    expect(client.consumeKeyPackages).toHaveBeenCalledTimes(1);
    expect(client.createGroup).toHaveBeenCalledTimes(1);
    expect(engine.addMembers).not.toHaveBeenCalled();
    expect(client.submitCommit).not.toHaveBeenCalled();
    // The local epoch-0 group is discarded — not marked loaded.
    expect(coordinator.isReadyForChannel(CHANNEL)).toBe(false);
  });

  it('rethrows a non-409 createGroup error', async () => {
    await activateAsLeader(CREATOR_SMALL);
    engine.createGroup.mockResolvedValue({ tag: 'epoch0' });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    client.consumeKeyPackages.mockResolvedValue([
      { deviceId: 'rdev', keyPackage: btoa('kp'), keyPackageRef: 'ref', isLastResort: false },
    ]);
    client.createGroup.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    await expect(coordinator.createDmGroup(CHANNEL, RECIPIENT)).rejects.toThrow('boom');
  });
});

describe('mlsCoordinator.createDmGroup — fail-closed on a member-mode 409 at epoch-0 create', () => {
  // The create path does not loop on a member-mode 'rebase' 409.
  // At epoch 0 the creator is the SOLE member, so there is no valid winning commit
  // to replay (a both-create race is resolved earlier at client.createGroup's
  // create-once 409, not here). The epoch >= 1 rebase loop in commitAddWithRebase
  // is unchanged and is covered directly by mlsCoordinatorRebaseState.test.ts.
  it('throws (no rebase loop) when submitCommit returns a member-mode 409 at create', async () => {
    await activateAsLeader(CREATOR_SMALL);

    const epoch0State = { tag: 'epoch0' };
    const epoch1State = { tag: 'epoch1' };
    engine.createGroup.mockResolvedValue(epoch0State);
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    client.createGroup.mockResolvedValue({ groupId: GROUP, currentEpoch: '0' });
    client.consumeKeyPackages.mockResolvedValue([
      { deviceId: 'rdev', keyPackage: btoa('kp'), keyPackageRef: 'ref', isLastResort: false },
    ]);
    engine.addMembers.mockResolvedValue({
      newState: epoch1State,
      commit: new Uint8Array([1]),
      welcome: new Uint8Array([2]),
    });
    // A member-mode 409 at the epoch-0 create: fail closed, do NOT loop.
    client.submitCommit.mockResolvedValue({ ok: false, conflict: 'rebase', currentEpoch: '1' });
    engine.currentEpoch.mockImplementation((s: unknown) => (s === epoch1State ? 1n : 0n));

    await expect(coordinator.createDmGroup(CHANNEL, RECIPIENT)).rejects.toThrow();

    // Submitted exactly once (no rebase loop), never replayed a winner, never persisted.
    expect(client.submitCommit).toHaveBeenCalledTimes(1);
    expect(engine.processHandshake).not.toHaveBeenCalled();
    expect(store.putGroup).not.toHaveBeenCalled();
    expect(coordinator.isReadyForChannel(CHANNEL)).toBe(false); // fail closed
  });
});

describe('mlsCoordinator.createGroupDmGroup — N-member group create', () => {
  const M1 = 'aaaa-member-1';
  const M2 = 'cccc-member-2';
  const M3 = 'bbbb-member-3';

  it('consumes one KP per member, batches one addMembers, submits one commit with N welcomes, persists + classifies mls', async () => {
    await activateAsLeader(CREATOR_SMALL);

    const epoch0State = { tag: 'g0' };
    const epoch1State = { tag: 'g1' };
    engine.createGroup.mockResolvedValue(epoch0State);
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    engine.currentEpoch.mockImplementation((s: unknown) => (s === epoch1State ? 1n : 0n));
    client.createGroup.mockResolvedValue({ groupId: GROUP, currentEpoch: '0' });
    client.consumeKeyPackages.mockImplementation((uid: string) =>
      Promise.resolve([{ deviceId: `${uid}-dev`, keyPackage: btoa(`kp-${uid}`), keyPackageRef: `ref-${uid}`, isLastResort: false }]),
    );
    engine.addMembers.mockResolvedValue({
      newState: epoch1State,
      commit: new Uint8Array([0xc0]),
      welcome: new Uint8Array([0xa0]),
    });
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '1', commitId: 'cid' });

    await coordinator.createGroupDmGroup(CHANNEL, [M2, M1, M3, M2]);

    expect(client.consumeKeyPackages).toHaveBeenCalledTimes(3);
    expect(client.consumeKeyPackages).toHaveBeenCalledWith(M1);
    expect(client.consumeKeyPackages).toHaveBeenCalledWith(M2);
    expect(client.consumeKeyPackages).toHaveBeenCalledWith(M3);
    expect(engine.createGroup).toHaveBeenCalledTimes(1);
    expect(engine.addMembers).toHaveBeenCalledTimes(1);
    expect(engine.addMembers.mock.calls[0][1]).toHaveLength(3);
    // A group (isGroup=true) member Add defaults to public (wireAsPublicMessage=true,
    // authority/accept-both): createGroupDmGroup is called without the flag, so it
    // defaults true and addMembers receives true as arg 3. Distinct from the 1:1 path.
    expect(engine.addMembers.mock.calls[0][2]).toBe(true);
    expect(client.submitCommit).toHaveBeenCalledTimes(1);

    const submitArgs = client.submitCommit.mock.calls[0][0];
    expect(submitArgs.groupId).toBe(GROUP);
    expect(submitArgs.baseEpoch).toBe('0');
    expect(submitArgs.mode).toBe('member');
    expect(submitArgs.welcomes).toHaveLength(3);
    expect(submitArgs.welcomes.map((w: { recipientId: string }) => w.recipientId).sort()).toEqual([M1, M2, M3].sort());
    expect(client.idempotencyKeyFor).toHaveBeenCalledWith(GROUP, '0', 'add', [M1, M3, M2].sort().join(','));
    expect(store.putGroup).toHaveBeenCalledWith(CHANNEL, GROUP, epoch1State, 1n, { channelId: CHANNEL, tier: 'saved' });
    const { isChannelMls } = await import('../services/encryptionFlags');
    expect(isChannelMls(CHANNEL)).toBe(true);
    expect(coordinator.isReadyForChannel(CHANNEL)).toBe(true);
  });

  it('throws when a member has no available KeyPackages', async () => {
    await activateAsLeader(CREATOR_SMALL);
    engine.createGroup.mockResolvedValue({ tag: 'g0' });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    engine.currentEpoch.mockReturnValue(0n);
    client.createGroup.mockResolvedValue({ groupId: GROUP, currentEpoch: '0' });
    client.consumeKeyPackages.mockImplementation((uid: string) =>
      Promise.resolve(uid === M1 ? [{ deviceId: 'd', keyPackage: btoa('kp'), keyPackageRef: 'r', isLastResort: false }] : []),
    );
    await expect(coordinator.createGroupDmGroup(CHANNEL, [M1, M2])).rejects.toThrow(/no available KeyPackages/);
    expect(engine.addMembers).not.toHaveBeenCalled();
    expect(client.submitCommit).not.toHaveBeenCalled();
    expect(coordinator.isReadyForChannel(CHANNEL)).toBe(false);
    expect(client.createGroup).not.toHaveBeenCalled(); // consume-before-create: no server row minted
  });

  it('consumes every member KeyPackage BEFORE creating the server group row', async () => {
    await activateAsLeader(CREATOR_SMALL);
    engine.createGroup.mockResolvedValue({ tag: 'g0' });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    engine.currentEpoch.mockReturnValue(0n);
    client.createGroup.mockResolvedValue({ groupId: GROUP, currentEpoch: '0' });
    client.consumeKeyPackages.mockResolvedValue([{ deviceId: 'd', keyPackage: btoa('kp'), keyPackageRef: 'r', isLastResort: false }]);
    engine.addMembers.mockResolvedValue({ newState: { tag: 'g1' }, commit: new Uint8Array([0xc0]), welcome: new Uint8Array([0xa0]) });
    engine.currentEpoch.mockImplementation((s: unknown) => ((s as { tag?: string })?.tag === 'g1' ? 1n : 0n));
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '1', commitId: 'cid' });

    await coordinator.createGroupDmGroup(CHANNEL, ['mmmm-member']);

    expect(client.consumeKeyPackages.mock.invocationCallOrder[0]).toBeLessThan(client.createGroup.mock.invocationCallOrder[0]);
  });

  it('tags a missing-KeyPackage failure with reason peer-unprovisioned + the member id', async () => {
    await activateAsLeader(CREATOR_SMALL);
    engine.createGroup.mockResolvedValue({ tag: 'g0' });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    engine.currentEpoch.mockReturnValue(0n);
    client.consumeKeyPackages.mockResolvedValue([]); // empty pool

    await expect(coordinator.createGroupDmGroup(CHANNEL, ['ghost-user'])).rejects.toMatchObject({
      reason: 'peer-unprovisioned',
      unprovisionedUserId: 'ghost-user',
    });
    expect(client.createGroup).not.toHaveBeenCalled();
  });

  it('normalizes a 404 from the consume route into peer-unprovisioned', async () => {
    await activateAsLeader(CREATOR_SMALL);
    engine.createGroup.mockResolvedValue({ tag: 'g0' });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    engine.currentEpoch.mockReturnValue(0n);
    client.consumeKeyPackages.mockRejectedValue(Object.assign(new Error('No KeyPackages for this user'), { status: 404 }));

    await expect(coordinator.createGroupDmGroup(CHANNEL, ['ghost-user'])).rejects.toMatchObject({ reason: 'peer-unprovisioned', unprovisionedUserId: 'ghost-user' });
    expect(client.createGroup).not.toHaveBeenCalled();
  });
});

describe('mlsCoordinator.commitAddMembersWithRebase — N members', () => {
  const M1 = 'cccc-member-1';
  const M2 = 'aaaa-member-2'; // lexicographically BEFORE M1 so the sort is observable
  const KP1 = new Uint8Array([0xc1]);
  const KP2 = new Uint8Array([0xc2]);

  it('clones base once per attempt, copies each KP, adds N, submits one commit with N welcomes and the sorted-set idempotency key', async () => {
    await activateAsLeader(CREATOR_SMALL);

    const baseState = { tag: 'baseEpoch5' };
    const epoch6State = { tag: 'epoch6' };
    engine.currentEpoch.mockImplementation((s: unknown) => (s === epoch6State ? 6n : 5n));
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    engine.addMembers.mockResolvedValue({ newState: epoch6State, commit: new Uint8Array([0xc0]), welcome: new Uint8Array([0xa0]) });
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '6', commitId: 'cid6' });

    await coordinator.commitAddMembersWithRebase(CHANNEL, GROUP, baseState as never, [
      { userId: M1, keyPackage: KP1 },
      { userId: M2, keyPackage: KP2 },
    ]);

    expect(engine.addMembers).toHaveBeenCalledTimes(1);
    const addedKps = engine.addMembers.mock.calls[0][1] as Uint8Array[];
    expect(addedKps).toHaveLength(2);
    expect(client.submitCommit).toHaveBeenCalledTimes(1);
    const submitArgs = client.submitCommit.mock.calls[0][0];
    expect(submitArgs.mode).toBe('member');
    expect(submitArgs.baseEpoch).toBe('5');
    expect(submitArgs.welcomes).toHaveLength(2);
    expect(submitArgs.welcomes.map((w: { recipientId: string }) => w.recipientId).sort()).toEqual([M1, M2].sort());
    expect(client.idempotencyKeyFor).toHaveBeenCalledWith(GROUP, '5', 'add', [M2, M1].sort().join(','));
    expect(store.putGroup).toHaveBeenCalledWith(CHANNEL, GROUP, epoch6State, 6n, { channelId: CHANNEL, tier: 'saved' });
  });

  it('on a 409 rebase replays the winner onto the intact base state and resubmits with the same sorted-set token', async () => {
    await activateAsLeader(CREATOR_SMALL);
    const baseState = { tag: 'baseEpoch5' };
    const epoch6State = { tag: 'epoch6' };
    const winnerState = { tag: 'winnerEpoch6' };
    const epoch7State = { tag: 'epoch7' };
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    engine.addMembers
      .mockResolvedValueOnce({ newState: epoch6State, commit: new Uint8Array([1]), welcome: new Uint8Array([2]) })
      .mockResolvedValueOnce({ newState: epoch7State, commit: new Uint8Array([3]), welcome: new Uint8Array([4]) });
    client.submitCommit
      .mockResolvedValueOnce({ ok: false, conflict: 'rebase', currentEpoch: '6' })
      .mockResolvedValueOnce({ ok: true, epoch: '7', commitId: 'cid7' });
    client.catchUp.mockResolvedValue([{ baseEpoch: '5', resultingEpoch: '6', commit: btoa('wc'), idempotencyKey: 'k' }]);
    engine.processHandshake.mockResolvedValue(winnerState);
    engine.currentEpoch.mockImplementation((s: unknown) => s === epoch7State ? 7n : s === winnerState || s === epoch6State ? 6n : 5n);

    await coordinator.commitAddMembersWithRebase(CHANNEL, GROUP, baseState as never, [
      { userId: M1, keyPackage: KP1 },
      { userId: M2, keyPackage: KP2 },
    ]);

    expect(client.submitCommit).toHaveBeenCalledTimes(2);
    expect(engine.processHandshake).toHaveBeenCalledTimes(1);
    const token = [M2, M1].sort().join(',');
    expect(client.idempotencyKeyFor).toHaveBeenNthCalledWith(1, GROUP, '5', 'add', token);
    expect(client.idempotencyKeyFor).toHaveBeenNthCalledWith(2, GROUP, '6', 'add', token);
    expect(store.putGroup).toHaveBeenLastCalledWith(CHANNEL, GROUP, epoch7State, 7n, { channelId: CHANNEL, tier: 'saved' });
  });

  // A racing External-Commit self-join may already have added a target (replayed
  // into `state` on a rebase); re-Adding an already-present member throws in ts-mls.
  // The loop must filter to still-absent members per iteration.
  // The mock engine.decodeState/encodeState are passthroughs, so the cloned state shares
  // this ratchetTree and the REAL credentialIdentityFor scans it.
  const presentLeaf = (userId: string) => ({
    nodeType: 'leaf' as const,
    leaf: { credential: { credentialType: 'basic' as const, identity: new TextEncoder().encode(`${userId}:dev`) } },
  });

  it('filters out a member already present in the tree (racing self-join): adds ONLY the absent member, one welcome, token = absent set', async () => {
    await activateAsLeader(CREATOR_SMALL);

    // M1 already self-joined (its leaf is in the tree); M2 is still absent.
    const baseState = { tag: 'baseEpoch5', ratchetTree: [presentLeaf(CREATOR_SMALL), null, presentLeaf(M1)] };
    const epoch6State = { tag: 'epoch6' };
    engine.currentEpoch.mockImplementation((s: unknown) => (s === epoch6State ? 6n : 5n));
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    engine.addMembers.mockResolvedValue({ newState: epoch6State, commit: new Uint8Array([0xc0]), welcome: new Uint8Array([0xa0]) });
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '6', commitId: 'cid6' });

    await coordinator.commitAddMembersWithRebase(CHANNEL, GROUP, baseState as never, [
      { userId: M1, keyPackage: KP1 },
      { userId: M2, keyPackage: KP2 },
    ]);

    // addMembers gets ONLY M2's KeyPackage (length 1, not 2).
    expect(engine.addMembers).toHaveBeenCalledTimes(1);
    const addedKps = engine.addMembers.mock.calls[0][1] as Uint8Array[];
    expect(addedKps).toHaveLength(1);
    expect(addedKps[0]).toEqual(KP2);
    // submitCommit welcomes only M2; token reflects only the absent recipient (M2, not M1,M2).
    expect(client.submitCommit).toHaveBeenCalledTimes(1);
    const submitArgs = client.submitCommit.mock.calls[0][0];
    expect(submitArgs.welcomes).toHaveLength(1);
    expect(submitArgs.welcomes[0].recipientId).toBe(M2);
    expect(client.idempotencyKeyFor).toHaveBeenCalledWith(GROUP, '5', 'add', M2);
    expect(store.putGroup).toHaveBeenCalledWith(CHANNEL, GROUP, epoch6State, 6n, { channelId: CHANNEL, tier: 'saved' });
  });

  it('skips the commit entirely when every target already self-joined: no addMembers, no submitCommit, persists the caught-up state', async () => {
    await activateAsLeader(CREATOR_SMALL);

    // Both M1 and M2 already in the tree -> nothing to Add.
    const baseState = { tag: 'baseEpoch5', ratchetTree: [presentLeaf(CREATOR_SMALL), null, presentLeaf(M1), null, presentLeaf(M2)] };
    engine.currentEpoch.mockReturnValue(5n);

    await coordinator.commitAddMembersWithRebase(CHANNEL, GROUP, baseState as never, [
      { userId: M1, keyPackage: KP1 },
      { userId: M2, keyPackage: KP2 },
    ]);

    expect(engine.addMembers).not.toHaveBeenCalled();
    expect(client.submitCommit).not.toHaveBeenCalled();
    // Persists the already-caught-up base state at its current epoch.
    expect(store.putGroup).toHaveBeenCalledWith(CHANNEL, GROUP, baseState, 5n, { channelId: CHANNEL, tier: 'saved' });
  });
});

describe('mlsCoordinator.commitRemoveMembersWithRebase — mocked wiring', () => {
  // Sorted so the sorted-set token == join order; A resolves to leaf 1, B to leaf 2.
  const TARGET_A = 'aaaa-target-a';
  const TARGET_B = 'bbbb-target-b';

  // A base state carrying a ratchetTree the REAL credentialIdentityFor scans (the
  // engine clone helpers decodeState/encodeState are identity passthroughs in the
  // mock, so the clone IS this object). Leaves at node positions 0/2/4 hold self +
  // both targets' basic-credential identity bytes (`${userId}:dev`).
  const leaf = (userId: string) => ({
    nodeType: 'leaf' as const,
    leaf: { credential: { credentialType: 'basic' as const, identity: new TextEncoder().encode(`${userId}:dev`) } },
  });
  const makeBaseState = (tag: string) => ({
    tag,
    ratchetTree: [leaf(CREATOR_SMALL), null, leaf(TARGET_A), null, leaf(TARGET_B)],
  });
  const idA = new TextEncoder().encode(`${TARGET_A}:dev`);
  const idB = new TextEncoder().encode(`${TARGET_B}:dev`);
  const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

  it('removes N members: resolves leaves on the clone, submits one commit with removedUserIds, NO welcomes, member mode, remove kind + sorted-set token, persists', async () => {
    await activateAsLeader(CREATOR_SMALL);

    const baseState = makeBaseState('baseEpoch2');
    const epoch3State = { tag: 'epoch3' };
    engine.currentEpoch.mockImplementation((s: unknown) => (s === epoch3State ? 3n : 2n));
    engine.resolveLeafIndex.mockImplementation((_s: unknown, id: Uint8Array) =>
      sameBytes(id, idA) ? 1 : sameBytes(id, idB) ? 2 : -1,
    );
    engine.removeMembers.mockResolvedValue({ newState: epoch3State, commit: new Uint8Array([0xd0]) });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '3', commitId: 'cid3' });

    await coordinator.commitRemoveMembersWithRebase(CHANNEL, GROUP, baseState as never, [TARGET_A, TARGET_B]);

    // One Remove commit over the sorted leaf indices, no Welcome involved.
    expect(engine.removeMembers).toHaveBeenCalledTimes(1);
    expect(engine.removeMembers.mock.calls[0][1]).toEqual([1, 2]);
    expect(client.submitCommit).toHaveBeenCalledTimes(1);
    const submitArgs = client.submitCommit.mock.calls[0][0];
    expect(submitArgs.mode).toBe('member');
    expect(submitArgs.baseEpoch).toBe('2');
    expect(submitArgs.welcomes).toBeUndefined();
    expect(submitArgs.removedUserIds).toEqual([TARGET_A, TARGET_B]);
    // Remove kind + deterministic sorted-set idempotency token.
    expect(client.idempotencyKeyFor).toHaveBeenCalledWith(GROUP, '2', 'remove', [TARGET_A, TARGET_B].sort().join(','));
    expect(submitArgs.idempotencyKey).toBe('idem-key-deadbeef');
    expect(store.putGroup).toHaveBeenCalledWith(CHANNEL, GROUP, epoch3State, 3n, { channelId: CHANNEL, tier: 'saved' });
  });

  it('on a 409 rebase replays the winner onto the intact base state and resubmits with the same sorted-set token off the new baseEpoch', async () => {
    await activateAsLeader(CREATOR_SMALL);

    const baseState = makeBaseState('baseEpoch2');
    const winnerState = makeBaseState('winnerEpoch3'); // post-replay state still scannable for the same targets
    const epoch3State = { tag: 'removed3' };
    const epoch4State = { tag: 'removed4' };
    engine.resolveLeafIndex.mockImplementation((_s: unknown, id: Uint8Array) =>
      sameBytes(id, idA) ? 1 : sameBytes(id, idB) ? 2 : -1,
    );
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    engine.removeMembers
      .mockResolvedValueOnce({ newState: epoch3State, commit: new Uint8Array([1]) })
      .mockResolvedValueOnce({ newState: epoch4State, commit: new Uint8Array([3]) });
    client.submitCommit
      .mockResolvedValueOnce({ ok: false, conflict: 'rebase', currentEpoch: '3' })
      .mockResolvedValueOnce({ ok: true, epoch: '4', commitId: 'cid4' });
    client.catchUp.mockResolvedValue([{ baseEpoch: '2', resultingEpoch: '3', commit: btoa('wc'), idempotencyKey: 'k' }]);
    engine.processHandshake.mockResolvedValue(winnerState);
    engine.currentEpoch.mockImplementation((s: unknown) =>
      s === epoch4State ? 4n : s === winnerState || s === epoch3State ? 3n : 2n,
    );

    await coordinator.commitRemoveMembersWithRebase(CHANNEL, GROUP, baseState as never, [TARGET_A, TARGET_B]);

    expect(client.submitCommit).toHaveBeenCalledTimes(2);
    expect(engine.processHandshake).toHaveBeenCalledTimes(1);
    const token = [TARGET_A, TARGET_B].sort().join(',');
    expect(client.idempotencyKeyFor).toHaveBeenNthCalledWith(1, GROUP, '2', 'remove', token);
    expect(client.idempotencyKeyFor).toHaveBeenNthCalledWith(2, GROUP, '3', 'remove', token);
    // Every submit carries removedUserIds and never a Welcome.
    for (const call of client.submitCommit.mock.calls) {
      expect(call[0].welcomes).toBeUndefined();
      expect(call[0].removedUserIds).toEqual([TARGET_A, TARGET_B]);
    }
    expect(store.putGroup).toHaveBeenLastCalledWith(CHANNEL, GROUP, epoch4State, 4n, { channelId: CHANNEL, tier: 'saved' });
  });
});

describe('mlsCoordinator.removeAbsentLeaver — leader authors the absent self-leaver Remove', () => {
  const LEAVER = 'aaaa-leaver';
  // A loaded MLS group whose ratchet tree carries the creator + the leaver leaf so
  // the REAL credentialIdentityFor / resolveLeafIndex resolve the target.
  const leaf = (userId: string) => ({
    nodeType: 'leaf' as const,
    leaf: { credential: { credentialType: 'basic' as const, identity: new TextEncoder().encode(`${userId}:dev`) } },
  });
  const baseState = { tag: 'loadedRemoveState', ratchetTree: [leaf(CREATOR_SMALL), null, leaf(LEAVER)] };
  const idLeaver = new TextEncoder().encode(`${LEAVER}:dev`);
  const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

  // Drive the create happy path so CHANNEL is loaded (_loadedGroups.get(CHANNEL) === GROUP)
  // and this tab is leader; then point store.getGroup at a removable base state.
  async function loadGroupAndArmRemove() {
    await makeChannelReady();
    store.getGroup.mockResolvedValue({ state: baseState, meta: { lastAppliedEpoch: 1n } });
    engine.resolveLeafIndex.mockImplementation((_s: unknown, id: Uint8Array) => (sameBytes(id, idLeaver) ? 1 : -1));
    engine.removeMembers.mockResolvedValue({ newState: { tag: 'afterRemove' }, commit: new Uint8Array([0xd0]) });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    engine.currentEpoch.mockReturnValue(2n);
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '2', commitId: 'cidR' });
    // makeChannelReady() ran the create happy path (1 submitCommit, etc.). Clear the
    // call history so the assertions below measure ONLY the removeAbsentLeaver path;
    // mockClear keeps the implementations set just above.
    engine.removeMembers.mockClear();
    engine.resolveLeafIndex.mockClear();
    client.submitCommit.mockClear();
    client.idempotencyKeyFor.mockClear();
    store.putGroup.mockClear();
  }

  it('delegates to commitRemoveMembersWithRebase with the loaded groupId, base state, and the single leaver', async () => {
    await loadGroupAndArmRemove();

    await removeAbsentLeaver(CHANNEL, LEAVER);

    // Resolved the leaver's leaf and submitted exactly one member-mode Remove
    // carrying removedUserIds=[leaver] and NO welcomes (a Remove seals nothing).
    expect(engine.removeMembers).toHaveBeenCalledTimes(1);
    expect(engine.removeMembers.mock.calls[0][1]).toEqual([1]);
    expect(client.submitCommit).toHaveBeenCalledTimes(1);
    const submitArgs = client.submitCommit.mock.calls[0][0];
    expect(submitArgs.groupId).toBe(GROUP);
    expect(submitArgs.mode).toBe('member');
    expect(submitArgs.welcomes).toBeUndefined();
    expect(submitArgs.removedUserIds).toEqual([LEAVER]);
    // baseEpoch derives from engine.currentEpoch(state) (mocked to 2n), not meta.
    expect(client.idempotencyKeyFor).toHaveBeenCalledWith(GROUP, '2', 'remove', LEAVER);
    expect(store.putGroup).toHaveBeenLastCalledWith(CHANNEL, GROUP, { tag: 'afterRemove' }, 2n, { channelId: CHANNEL, tier: 'saved' });
  });

  it('no-ops (no throw) when this tab is not the leader', async () => {
    await loadGroupAndArmRemove();
    tablock.isLeader.mockReturnValue(false);

    await expect(removeAbsentLeaver(CHANNEL, LEAVER)).resolves.toBeUndefined();
    expect(engine.removeMembers).not.toHaveBeenCalled();
    expect(client.submitCommit).not.toHaveBeenCalled();
  });

  it('no-ops (no throw) when the channel has no loaded MLS group', async () => {
    await activateAsLeader(CREATOR_SMALL); // leader, but CHANNEL was never loaded
    store.getGroup.mockResolvedValue({ state: baseState, meta: { lastAppliedEpoch: 1n } });

    await expect(removeAbsentLeaver('chan-no-group', LEAVER)).resolves.toBeUndefined();
    expect(engine.removeMembers).not.toHaveBeenCalled();
    expect(client.submitCommit).not.toHaveBeenCalled();
  });
});

describe('mlsCoordinator.handleGroupLeaderElection — only the elected oldest-remaining member Removes the EXPLICIT leaverId', () => {
  const SELF = CREATOR_SMALL;
  const LEAVER = 'aaaa-leaver';
  const STAYER = 'cccc-stayer';
  const leaf = (userId: string) => ({
    nodeType: 'leaf' as const,
    leaf: { credential: { credentialType: 'basic' as const, identity: new TextEncoder().encode(`${userId}:dev`) } },
  });
  const baseState = { tag: 'leState', ratchetTree: [leaf(SELF), null, leaf(LEAVER), null, leaf(STAYER)] };
  const idLeaver = new TextEncoder().encode(`${LEAVER}:dev`);
  const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

  async function loadGroupAndArmRemove() {
    await makeChannelReady();
    store.getGroup.mockResolvedValue({ state: baseState, meta: { lastAppliedEpoch: 1n } });
    engine.resolveLeafIndex.mockImplementation((_s: unknown, id: Uint8Array) => (sameBytes(id, idLeaver) ? 1 : -1));
    engine.removeMembers.mockResolvedValue({ newState: { tag: 'afterRemove' }, commit: new Uint8Array([0xd0]) });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    engine.currentEpoch.mockReturnValue(2n);
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '2', commitId: 'cidR' });
    // makeChannelReady() ran the create happy path (1 submitCommit, etc.). Clear the
    // call history so the assertions below measure ONLY the removeAbsentLeaver path;
    // mockClear keeps the implementations set just above.
    engine.removeMembers.mockClear();
    engine.resolveLeafIndex.mockClear();
    client.submitCommit.mockClear();
    client.idempotencyKeyFor.mockClear();
    store.putGroup.mockClear();
  }

  it('this client is the oldest member -> Removes the EXPLICIT leaverId even when the local roster no longer shows the leaver (post-splice regression)', async () => {
    await loadGroupAndArmRemove();

    // REGRESSION MODEL: this is the real production state at election time.
    // dm-participant-left has ALREADY synchronously spliced the leaver out of the
    // local roster, and the server's memberIds is the post-leave real-member set
    // (also excludes the leaver). The old roster-diff code computed
    // (otherUsers ∪ self) \ memberIds === ∅ and authored NO Remove. The explicit
    // leaverId in the payload must drive the Remove regardless of roster state.
    handleGroupLeaderElection(
      { dmChannelId: CHANNEL, oldestMemberId: SELF, memberIds: [SELF, STAYER], leaverId: LEAVER },
      SELF,
    );
    // The dispatch is fire-and-forget; flush microtasks for the awaited remove.
    await new Promise((r) => setTimeout(r, 0));

    expect(engine.removeMembers).toHaveBeenCalledTimes(1);
    expect(client.submitCommit).toHaveBeenCalledTimes(1);
    expect(client.submitCommit.mock.calls[0][0].removedUserIds).toEqual([LEAVER]);
  });

  it('this client is NOT the oldest member -> no Remove (someone else authors it)', async () => {
    await loadGroupAndArmRemove();

    handleGroupLeaderElection(
      { dmChannelId: CHANNEL, oldestMemberId: STAYER, memberIds: [STAYER], leaverId: LEAVER },
      SELF, // self != oldestMemberId
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(engine.removeMembers).not.toHaveBeenCalled();
    expect(client.submitCommit).not.toHaveBeenCalled();
  });

  it('leaverId absent from the payload -> no Remove (nothing to target)', async () => {
    await loadGroupAndArmRemove();

    handleGroupLeaderElection(
      { dmChannelId: CHANNEL, oldestMemberId: SELF, memberIds: [SELF, STAYER] },
      SELF,
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(engine.removeMembers).not.toHaveBeenCalled();
    expect(client.submitCommit).not.toHaveBeenCalled();
  });

  it('leaverId === currentUserId -> no Remove (defensive: never self-evict)', async () => {
    await loadGroupAndArmRemove();

    handleGroupLeaderElection(
      { dmChannelId: CHANNEL, oldestMemberId: SELF, memberIds: [SELF, STAYER], leaverId: SELF },
      SELF,
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(engine.removeMembers).not.toHaveBeenCalled();
    expect(client.submitCommit).not.toHaveBeenCalled();
  });
});

describe('mlsCoordinator.activate — reconciles classification from durable IndexedDB (downgrade resistance)', () => {
  // Unique ids: encryptionFlags' in-memory classification map is module-level
  // and is NOT reset by localStorage.clear() in beforeEach, so other tests'
  // CHANNEL='mls' writes leak. A fresh channel/group keeps this assertion honest.
  const RECONCILE_CHANNEL = '00000000-0000-4000-8000-0000000000f1';
  const RECONCILE_GROUP = '00000000-0000-4000-8000-0000000000f2';

  it('re-asserts mls classification on boot for a group rehydrated from IndexedDB', async () => {
    // An established MLS channel whose group survives in IndexedDB, but whose
    // localStorage classification was lost (a swallowed persistProtocols write,
    // a sibling-tab key removal, storage pressure — anything that drops the
    // single 'howl_channel_protocol' record while the durable group remains).
    // On unlock, activate() rehydrates _loadedGroups from the durable group map
    // and MUST re-derive 'mls' so routing never silently downgrades the channel
    // to the coexistence legacy path.
    const flags = await import('../services/encryptionFlags');
    expect(flags.isChannelMls(RECONCILE_CHANNEL)).toBe(false);

    tablock.acquireLeadership.mockResolvedValue(true);
    tablock.isLeader.mockReturnValue(true);
    store.getGroupIdToChannelMap.mockResolvedValue(new Map([[RECONCILE_GROUP, { roomKey: RECONCILE_CHANNEL, channelId: RECONCILE_CHANNEL, tier: 'saved' }]]));
    store.getAllKeyPackageCandidates.mockResolvedValue([]);
    store.getGroup.mockResolvedValue(undefined); // catch-up is a no-op
    client.keyPackageCount.mockResolvedValue({ remaining: 50, hasLastResort: true });
    client.getWelcomes.mockResolvedValue([]);
    apiClient.getDMs.mockResolvedValue([]);

    await coordinator.activate(bundle(CREATOR_SMALL), atRestKey, null);

    expect(flags.isChannelMls(RECONCILE_CHANNEL)).toBe(true);
  });
});

describe('mlsCoordinator.rekey — re-encrypt old->new then adopt new keys', () => {
  const oldAtRest = { tag: 'oldAtRest' } as unknown as CryptoKey;
  const oldHistory = { tag: 'oldHistory' } as unknown as CryptoKey;
  const newAtRest = { tag: 'newAtRest' } as unknown as CryptoKey;
  const newHistory = { tag: 'newHistory' } as unknown as CryptoKey;

  // Restore the hoisted defaults these tests override (vi.clearAllMocks does NOT
  // reset a mockReturnValue), so later tests still see getAtRestKey/getHistoryKey -> null.
  afterEach(() => {
    store.getAtRestKey.mockReturnValue(null);
    store.getHistoryKey.mockReturnValue(null);
  });

  it('reads the installed old keys, re-keys the stores, THEN swaps in the new keys', async () => {
    store.getAtRestKey.mockReturnValue(oldAtRest);
    store.getHistoryKey.mockReturnValue(oldHistory);
    // Measure only this test's set*Key calls (beforeEach's deactivate already called them).
    store.setAtRestKey.mockClear();
    store.setHistoryKey.mockClear();

    await coordinator.rekey(newAtRest, newHistory);

    // Re-encrypted under the explicit old->new key pair before any swap.
    expect(store.rekeyAtRestStores).toHaveBeenCalledTimes(1);
    expect(store.rekeyAtRestStores).toHaveBeenCalledWith(oldAtRest, newAtRest, oldHistory, newHistory);
    // Adopted the new keys AFTER the re-key (ordering: rekeyAtRestStores before setAtRestKey).
    expect(store.setAtRestKey).toHaveBeenCalledWith(newAtRest);
    expect(store.setHistoryKey).toHaveBeenCalledWith(newHistory);
    expect(store.rekeyAtRestStores.mock.invocationCallOrder[0])
      .toBeLessThan(store.setAtRestKey.mock.invocationCallOrder.at(-1)!);
  });

  it('no-ops safely when no at-rest key is installed (MLS not active)', async () => {
    store.getAtRestKey.mockReturnValue(null);
    store.setAtRestKey.mockClear();
    await coordinator.rekey(newAtRest, newHistory);
    expect(store.rekeyAtRestStores).not.toHaveBeenCalled();
    expect(store.setAtRestKey).not.toHaveBeenCalled();
  });
});

describe('mlsCoordinator.joinPendingWelcomes — union mapping', () => {
  it('joins a Welcome with no local store-map row via the getDMs() mapping', async () => {
    // Activate as leader, but the store group->channel map is EMPTY (brand-new
    // conversation: no local row yet). getDMs supplies the mlsGroupId mapping.
    tablock.acquireLeadership.mockResolvedValue(true);
    tablock.isLeader.mockReturnValue(true);
    store.getGroupIdToChannelMap.mockResolvedValue(new Map());
    store.getAllKeyPackageCandidates.mockResolvedValue([
      { keyPackageRef: 'kpref-1', keyPackage: new Uint8Array([9]), privateKeyPackage: new Uint8Array([8]), isLastResort: false },
    ]);
    client.keyPackageCount.mockResolvedValue({ remaining: 50, hasLastResort: true });
    // getDMs returns the channel carrying the matching mlsGroupId.
    apiClient.getDMs.mockResolvedValue([{ id: CHANNEL, mlsGroupId: GROUP }]);
    // One pending Welcome for GROUP.
    client.getWelcomes.mockResolvedValue([{ groupId: GROUP, epoch: '1', welcomeData: btoa('wel') }]);

    const joinedState = { tag: 'joined' };
    engine.joinFromWelcome.mockResolvedValue({ state: joinedState, consumedKpRef: 'kpref-1', isLastResort: false });
    engine.currentEpoch.mockReturnValue(1n);

    await coordinator.activate(bundle(CREATOR_SMALL), atRestKey, null);
    await new Promise((r) => setTimeout(r, 0)); // let the backgrounded tail (joinPendingWelcomes) run

    // Joined + persisted + deleted the consumed init key + classified mls.
    expect(engine.joinFromWelcome).toHaveBeenCalledTimes(1);
    expect(store.putGroup).toHaveBeenCalledWith(CHANNEL, GROUP, joinedState, 1n, { channelId: CHANNEL, tier: 'saved' });
    expect(store.deleteKpPrivate).toHaveBeenCalledWith('kpref-1');
    const { isChannelMls } = await import('../services/encryptionFlags');
    expect(isChannelMls(CHANNEL)).toBe(true);
    expect(coordinator.isReadyForChannel(CHANNEL)).toBe(true);
  });

  it('leaves an unmapped Welcome pending (never consumes/drops it)', async () => {
    tablock.acquireLeadership.mockResolvedValue(true);
    tablock.isLeader.mockReturnValue(true);
    store.getGroupIdToChannelMap.mockResolvedValue(new Map());
    store.getAllKeyPackageCandidates.mockResolvedValue([]);
    client.keyPackageCount.mockResolvedValue({ remaining: 50, hasLastResort: true });
    apiClient.getDMs.mockResolvedValue([]); // no mapping anywhere
    client.getWelcomes.mockResolvedValue([{ groupId: GROUP, epoch: '1', welcomeData: btoa('wel') }]);

    await coordinator.activate(bundle(CREATOR_SMALL), atRestKey, null);

    // Unmapped -> not consumed, not joined.
    expect(engine.joinFromWelcome).not.toHaveBeenCalled();
    expect(store.putGroup).not.toHaveBeenCalled();
    expect(coordinator.isReadyForChannel(CHANNEL)).toBe(false);
  });

  it('heals PCS with a self-update commit when the consumed KP was last-resort', async () => {
    tablock.acquireLeadership.mockResolvedValue(true);
    tablock.isLeader.mockReturnValue(true);
    store.getGroupIdToChannelMap.mockResolvedValue(new Map());
    store.getAllKeyPackageCandidates.mockResolvedValue([
      { keyPackageRef: 'lr-ref', keyPackage: new Uint8Array([9]), privateKeyPackage: new Uint8Array([8]), isLastResort: true },
    ]);
    client.keyPackageCount.mockResolvedValue({ remaining: 50, hasLastResort: true });
    apiClient.getDMs.mockResolvedValue([{ id: CHANNEL, mlsGroupId: GROUP }]);
    client.getWelcomes.mockResolvedValue([{ groupId: GROUP, epoch: '1', welcomeData: btoa('wel') }]);

    const joinedState = { tag: 'joined' };
    const healedState = { tag: 'healed' };
    engine.joinFromWelcome.mockResolvedValue({ state: joinedState, consumedKpRef: 'lr-ref', isLastResort: true });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
    engine.selfUpdate.mockResolvedValue({ newState: healedState, commit: new Uint8Array([0xc0]) });
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '2', commitId: 'cid' });
    engine.currentEpoch.mockImplementation((s: unknown) => (s === healedState ? 2n : 1n));

    await coordinator.activate(bundle(CREATOR_SMALL), atRestKey, null);
    await new Promise((r) => setTimeout(r, 0)); // let the backgrounded tail (joinPendingWelcomes + heal) run

    // Self-update commit submitted (member mode) to heal PCS.
    expect(engine.selfUpdate).toHaveBeenCalledTimes(1);
    expect(client.submitCommit).toHaveBeenCalledTimes(1);
    expect(client.submitCommit.mock.calls[0][0].mode).toBe('member');
    // The healed state was persisted.
    expect(store.putGroup).toHaveBeenLastCalledWith(CHANNEL, GROUP, healedState, 2n, { channelId: CHANNEL, tier: 'saved' });
  });
});

// Helper: drive the initiator happy path so CHANNEL is loaded + ready (leader),
// leaving engine/store mocks set up so encrypt/decrypt can run afterwards.
async function makeChannelReady() {
  await activateAsLeader(CREATOR_SMALL);
  const epoch0State = { tag: 'epoch0' };
  const epoch1State = { tag: 'epoch1' };
  engine.createGroup.mockResolvedValue(epoch0State);
  engine.makeGroupInfo.mockResolvedValue(new Uint8Array([0xaa]));
  engine.currentEpoch.mockImplementation((s: unknown) => (s === epoch1State ? 1n : 0n));
  client.createGroup.mockResolvedValue({ groupId: GROUP, currentEpoch: '0' });
  client.consumeKeyPackages.mockResolvedValue([
    { deviceId: 'rdev', keyPackage: btoa('kp'), keyPackageRef: 'ref', isLastResort: false },
  ]);
  engine.addMembers.mockResolvedValue({
    newState: epoch1State,
    commit: new Uint8Array([0xc0]),
    welcome: new Uint8Array([0xa0]),
  });
  client.submitCommit.mockResolvedValue({ ok: true, epoch: '1', commitId: 'cid' });
  await coordinator.createDmGroup(CHANNEL, RECIPIENT);
  expect(coordinator.isReadyForChannel(CHANNEL)).toBe(true);
}

describe('mlsCoordinator.encrypt/decrypt — round trip', () => {
  it('encrypt advances + persists state and returns a v4 envelope', async () => {
    await makeChannelReady();

    const loadedState = { tag: 'loaded' };
    const advancedState = { tag: 'advanced' };
    store.getGroup.mockResolvedValue({
      state: loadedState,
      meta: { lastAppliedEpoch: 1n },
    });
    engine.currentEpoch.mockImplementation((s: unknown) => (s === advancedState ? 5n : 1n));
    engine.encryptApp.mockResolvedValue({
      newState: advancedState,
      privateMessage: new Uint8Array([0xde, 0xad]),
    });

    const result = await coordinator.encrypt(CHANNEL, 'hello world');

    expect(engine.encryptApp).toHaveBeenCalledTimes(1);
    // Persisted the advanced state under the loaded groupId.
    expect(store.putGroup).toHaveBeenLastCalledWith(CHANNEL, GROUP, advancedState, 5n, { channelId: CHANNEL, tier: 'saved' });
    // Returned a well-formed v4 envelope.
    const { isMlsEnvelopeV4 } = await import('../services/mls/types');
    expect(isMlsEnvelopeV4(result)).toBe(true);
  });

  it('decrypt parses a v4 envelope, advances + persists, returns plaintext', async () => {
    await makeChannelReady();

    const loadedState = { tag: 'loaded' };
    const advancedState = { tag: 'advanced' };
    store.getGroup.mockResolvedValue({
      state: loadedState,
      meta: { lastAppliedEpoch: 1n },
    });
    engine.currentEpoch.mockImplementation((s: unknown) => (s === advancedState ? 6n : 1n));
    engine.decryptApp.mockResolvedValue({
      newState: advancedState,
      plaintext: new TextEncoder().encode('secret payload'),
    });

    // Build a real v4 envelope to feed decrypt.
    const { encodeMlsEnvelope } = await import('../services/mls/types');
    const envelope = encodeMlsEnvelope(new Uint8Array([0xbe, 0xef]));

    const result = await coordinator.decrypt(CHANNEL, envelope, 'm-live');

    expect(engine.decryptApp).toHaveBeenCalledTimes(1);
    expect(store.putGroup).toHaveBeenLastCalledWith(CHANNEL, GROUP, advancedState, 6n, { channelId: CHANNEL, tier: 'saved' });
    expect(result).toBe('secret payload');
  });
});

describe('mlsCoordinator.encrypt — per-channel serializer (ratchet-clobber guard)', () => {
  it('serializes two concurrent encrypts: the 2nd reads the state the 1st persisted', async () => {
    await makeChannelReady();

    // Model the ratchet: each encrypt reads the CURRENT persisted state and
    // advances it. If the ops were NOT serialized, both would read state0 and the
    // engine would see state0 twice; serialized, the 2nd sees state1.
    const state0 = { gen: 0 };
    const state1 = { gen: 1 };
    const state2 = { gen: 2 };
    let persisted: { gen: number } = state0;

    // getGroup returns whatever was last persisted (the live ratchet head).
    store.getGroup.mockImplementation(async () => ({
      state: persisted,
      meta: { lastAppliedEpoch: 1n },
    }));
    // putGroup records the new head.
    store.putGroup.mockImplementation(async (_ch: string, _g: string, st: { gen: number }) => {
      persisted = st;
    });
    engine.currentEpoch.mockReturnValue(1n);
    // encryptApp advances state0->state1->state2 in call order, each producing a
    // DISTINCT ciphertext so the two envelopes differ.
    const seenBases: Array<{ gen: number }> = [];
    engine.encryptApp.mockImplementation(async (st: { gen: number }) => {
      seenBases.push(st);
      if (st === state0) return { newState: state1, privateMessage: new Uint8Array([1]) };
      if (st === state1) return { newState: state2, privateMessage: new Uint8Array([2]) };
      throw new Error(`encryptApp saw an unexpected (clobbered) base: gen=${st.gen}`);
    });

    // Fire both WITHOUT awaiting the first — they race onto the same channel.
    const [e1, e2] = await Promise.all([
      coordinator.encrypt(CHANNEL, 'first'),
      coordinator.encrypt(CHANNEL, 'second'),
    ]);

    expect(engine.encryptApp).toHaveBeenCalledTimes(2);
    // Strictly sequential: 1st saw state0, 2nd saw state1 (the state the 1st
    // persisted) — NOT state0 twice. That is the anti-clobber guarantee.
    expect(seenBases[0]).toBe(state0);
    expect(seenBases[1]).toBe(state1);
    // Distinct envelopes (distinct ciphertexts).
    expect(e1).not.toBe(e2);
    // Final persisted head is the fully-advanced state.
    expect(persisted).toBe(state2);
  });
});

describe('mlsCoordinator — onMlsWelcome live notify triggers a drain', () => {
  it('the registered onMlsWelcome callback drains + joins a pending Welcome', async () => {
    // Capture the callback the coordinator registers via client.onMlsWelcome
    // during activate, BEFORE activating as leader.
    let welcomeCb: ((e: { groupId: string; epoch: string }) => void) | null = null;
    client.onMlsWelcome.mockImplementation(((cb: (e: { groupId: string; epoch: string }) => void) => {
      welcomeCb = cb;
      return () => undefined;
    }) as () => () => undefined);

    // activate() runs a startup drain with EMPTY welcomes (the helper sets
    // client.getWelcomes -> []), so no join happens at startup.
    await activateAsLeader(CREATOR_SMALL);
    await new Promise((r) => setTimeout(r, 0)); // let the backgrounded tail subscribe onMlsWelcome

    // AFTER activation, reconfigure mocks so a fresh drain would now join a
    // brand-new Welcome via the getDMs() union mapping (GROUP -> CHANNEL).
    client.getWelcomes.mockResolvedValue([{ groupId: GROUP, epoch: '1', welcomeData: btoa('w') }]);
    apiClient.getDMs.mockResolvedValue([{ id: CHANNEL, mlsGroupId: GROUP }]);
    store.getAllKeyPackageCandidates.mockResolvedValue([
      { keyPackageRef: 'kpref', keyPackage: new Uint8Array([9]), privateKeyPackage: new Uint8Array([8]), isLastResort: false },
    ]);
    engine.joinFromWelcome.mockResolvedValue({ state: { tag: 'joined' }, consumedKpRef: 'kpref', isLastResort: false });
    engine.currentEpoch.mockReturnValue(1n);

    // Clear the call counts mutated by activate's startup drain so we measure ONLY
    // the callback-triggered drain.
    engine.joinFromWelcome.mockClear();
    store.putGroup.mockClear();
    store.deleteKpPrivate.mockClear();

    // Fire the live notify exactly as the socket layer would.
    expect(welcomeCb).toBeTypeOf('function');
    await welcomeCb!({ groupId: GROUP, epoch: '1' });
    // Flush the fire-and-forget drain's trailing microtasks/timers before asserting.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // The live notify caused a drain that joined the Welcome.
    expect(engine.joinFromWelcome).toHaveBeenCalledTimes(1);
    expect(store.putGroup).toHaveBeenCalledWith(CHANNEL, GROUP, { tag: 'joined' }, 1n, { channelId: CHANNEL, tier: 'saved' });
    expect(store.deleteKpPrivate).toHaveBeenCalledWith('kpref');
    const { isChannelMls } = await import('../services/encryptionFlags');
    expect(isChannelMls(CHANNEL)).toBe(true);
  });
});

describe('mlsCoordinator — leadership loss emits mls-locked', () => {
  it('emits mls-locked on involuntary leadership loss, without double-emit on deactivate', async () => {
    // Capture the onLost callback passed to acquireLeadership so we can invoke it.
    let onLost: (() => void) | undefined;
    tablock.acquireLeadership.mockImplementation(async (cb: () => void) => {
      onLost = cb;
      return true;
    });
    tablock.isLeader.mockReturnValue(true);
    store.getGroupIdToChannelMap.mockResolvedValue(new Map());
    store.getAllKeyPackageCandidates.mockResolvedValue([]);
    client.keyPackageCount.mockResolvedValue({ remaining: 50, hasLastResort: true });
    client.getWelcomes.mockResolvedValue([]);
    apiClient.getDMs.mockResolvedValue([]);

    const events: string[] = [];
    const unsub = coordinator.mlsEvents.on((e) => events.push(e));

    await coordinator.activate(bundle(CREATOR_SMALL), atRestKey, null);
    await new Promise((r) => setTimeout(r, 0)); // let the backgrounded tail emit 'mls-ready'
    expect(events).toEqual(['mls-ready']);
    expect(onLost).toBeDefined();

    // Involuntary leadership loss fires the captured callback.
    onLost!();
    expect(events).toEqual(['mls-ready', 'mls-locked']);

    // A subsequent voluntary deactivate must NOT double-emit mls-locked.
    coordinator.deactivate();
    expect(events).toEqual(['mls-ready', 'mls-locked']);

    unsub();
  });
});

describe('mlsCoordinator.joinViaExternalCommit', () => {
  // Helper: activate as leader with empty maps (mirrors the existing activate setup).
  async function activateLeader() {
    tablock.acquireLeadership.mockResolvedValue(true);
    tablock.isLeader.mockReturnValue(true);
    store.getGroupIdToChannelMap.mockResolvedValue(new Map());
    client.keyPackageCount.mockResolvedValue({ remaining: 99, hasLastResort: true });
    client.getWelcomes.mockResolvedValue([]);
    await activate({ userId: 'u-self', deviceId: 'd1', identity: {} as never }, {} as never, null);
  }

  it('REFUSES an epoch-0 GroupInfo (awaits the welcome; no submit, channel stays not loaded)', async () => {
    await activateLeader();
    client.getGroupInfo.mockResolvedValue({ groupInfo: 'AAA', groupInfoEpoch: '0' });

    await joinViaExternalCommit('chan-1', 'grp-1');

    expect(client.submitCommit).not.toHaveBeenCalled();
    expect(isReadyForChannel('chan-1')).toBe(false); // not loaded -> fail closed
  });

  it('happy external join: joinExternal -> submitCommit(external) ok -> persists + classifies + loads', async () => {
    await activateLeader();
    client.getGroupInfo.mockResolvedValue({ groupInfo: 'R0', groupInfoEpoch: '5' });
    engine.joinExternal.mockResolvedValue({ newState: { tag: 'joined' }, commit: new Uint8Array([9]) });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([7]));
    engine.currentEpoch.mockReturnValue(6n);
    client.idempotencyKeyFor.mockResolvedValue('idemp-x');
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '6', commitId: 'c1' });

    await joinViaExternalCommit('chan-2', 'grp-2');

    expect(engine.joinExternal).toHaveBeenCalled();
    expect(client.submitCommit).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'grp-2', mode: 'external', baseEpoch: '5' }),
    );
    expect(store.putGroup).toHaveBeenCalledWith('chan-2', 'grp-2', { tag: 'joined' }, 6n, { channelId: 'chan-2', tier: 'saved' });
    expect(isReadyForChannel('chan-2')).toBe(true);
  });

  it('refetch_group_info 409 loop: discards, refetches a fresh GroupInfo, retries, then succeeds', async () => {
    await activateLeader();
    client.getGroupInfo
      .mockResolvedValueOnce({ groupInfo: 'R5', groupInfoEpoch: '5' })
      .mockResolvedValueOnce({ groupInfo: 'R6', groupInfoEpoch: '6' });
    engine.joinExternal.mockResolvedValue({ newState: { tag: 'j' }, commit: new Uint8Array([1]) });
    engine.makeGroupInfo.mockResolvedValue(new Uint8Array([2]));
    engine.currentEpoch.mockReturnValue(7n);
    client.idempotencyKeyFor.mockResolvedValue('k');
    client.submitCommit
      .mockResolvedValueOnce({ ok: false, conflict: 'refetch_group_info', currentEpoch: '6' })
      .mockResolvedValueOnce({ ok: true, epoch: '7', commitId: 'c2' });

    await joinViaExternalCommit('chan-3', 'grp-3');

    expect(client.getGroupInfo).toHaveBeenCalledTimes(2); // refetched on the 409
    expect(client.submitCommit).toHaveBeenCalledTimes(2);
    expect(isReadyForChannel('chan-3')).toBe(true);
  });
});

describe('mlsCoordinator.activate — teardown-safe', () => {
  it('a deactivate() during activate() awaits does NOT revive state or emit mls-ready', async () => {
    const events: string[] = [];
    const off = mlsEvents.on((e) => events.push(e));
    store.getGroupIdToChannelMap.mockResolvedValue(new Map());
    client.keyPackageCount.mockResolvedValue({ remaining: 99, hasLastResort: true });
    client.getWelcomes.mockResolvedValue([]);
    // Interleave a forced teardown the moment leadership is awaited (inside activate).
    tablock.acquireLeadership.mockImplementation(async () => {
      deactivate();
      return true;
    });
    tablock.isLeader.mockReturnValue(true);

    await activate({ userId: 'u', deviceId: 'd', identity: {} as never }, {} as never, null);
    await new Promise((r) => setTimeout(r, 0)); // let the backgrounded tail run acquire->deactivate->_active re-check

    expect(isActive()).toBe(false);                  // not revived
    expect(events).not.toContain('mls-ready');       // no post-logout ready
    off();
  });
});

describe('mlsCoordinator.decrypt — cross-tab idempotency', () => {
  // Single-writer means N tabs RPC decrypt into ONE shared ClientState. ts-mls
  // application-message keys are single-use (forward secrecy): the first decrypt of
  // an envelope advances+persists the ratchet, so a SECOND decrypt of the SAME
  // ciphertext throws "Desired gen in the past". Without memoization only the
  // race-winner tab renders a peer message; the others show the locked placeholder.
  // The worker must decrypt once and serve every other tab from a plaintext cache.
  async function activateReady(userId = CREATOR_SMALL) {
    tablock.acquireLeadership.mockResolvedValue(true);
    tablock.isLeader.mockReturnValue(true);
    store.getGroupIdToChannelMap.mockResolvedValue(new Map([['grp-dc', { roomKey: 'chan-dc', channelId: 'chan-dc', tier: 'saved' }]]));
    store.getAllKeyPackageCandidates.mockResolvedValue([]);
    client.keyPackageCount.mockResolvedValue({ remaining: 50, hasLastResort: true });
    client.getWelcomes.mockResolvedValue([]);
    apiClient.getDMs.mockResolvedValue([]);
    await coordinator.activate(bundle(userId), atRestKey, null);
  }

  it('decrypting the same envelope twice returns the same plaintext and advances the ratchet once', async () => {
    await activateReady();
    expect(isReadyForChannel('chan-dc')).toBe(true);

    store.getGroup.mockResolvedValue({ state: { tag: 'base' } });
    store.putGroup.mockResolvedValue(undefined);
    engine.currentEpoch.mockReturnValue(1n);
    // First decrypt succeeds; a re-decrypt of the same ciphertext throws (single-use key).
    // (mockReset clears any leftover once-queue — clearAllMocks does not.)
    engine.decryptApp.mockReset();
    engine.decryptApp
      .mockResolvedValueOnce({ newState: { tag: 'advanced' }, plaintext: new TextEncoder().encode('hello from peer') })
      .mockRejectedValueOnce(new Error('Desired gen in the past'));

    const env = encodeMlsEnvelope(new Uint8Array([9, 8, 7]));
    const first = await coordinator.decrypt('chan-dc', env, 'm-dc-1');
    const second = await coordinator.decrypt('chan-dc', env, 'm-dc-1');

    expect(first).toBe('hello from peer');
    expect(second).toBe('hello from peer');             // the second tab reads it too
    expect(engine.decryptApp).toHaveBeenCalledTimes(1); // ratchet consumed exactly once
  });

  it('does not serve a stale plaintext after deactivate (cache cleared on lock)', async () => {
    await activateReady();
    store.getGroup.mockResolvedValue({ state: { tag: 'base' } });
    store.putGroup.mockResolvedValue(undefined);
    engine.currentEpoch.mockReturnValue(1n);
    const env = encodeMlsEnvelope(new Uint8Array([5, 5, 5]));
    engine.decryptApp.mockReset();
    engine.decryptApp.mockResolvedValueOnce({ newState: { tag: 'advanced' }, plaintext: new TextEncoder().encode('secret') });
    expect(await coordinator.decrypt('chan-dc', env, 'm-dc-2')).toBe('secret');

    coordinator.deactivate(); // lock / logout: no decrypted plaintext may survive
    await activateReady();    // re-unlock

    // Same envelope must NOT come from a stale cache — it re-runs the consumed
    // ratchet, which throws. Proves the cache was cleared on deactivate.
    engine.decryptApp.mockRejectedValueOnce(new Error('Desired gen in the past'));
    await expect(coordinator.decrypt('chan-dc', env, 'm-dc-2')).rejects.toThrow(/Desired gen in the past/);
  });
});

describe('mlsCoordinator — fail loud on commit-apply errors (per-device-identity)', () => {
  it('fail-loud: a processHandshake throw on an incoming commit emits mls-apply-failed and does not advance the epoch', async () => {
    // Capture the commit callback the coordinator registers via client.onMlsCommit
    // during the backgrounded activate tail (modeled on the onMlsWelcome capture).
    let commitCb: ((e: { groupId: string; epoch: string; commit: string }) => void) | undefined;
    client.onMlsCommit.mockImplementation(((cb: (e: { groupId: string; epoch: string; commit: string }) => void) => {
      commitCb = cb;
      return () => undefined;
    }) as () => () => undefined);

    // makeChannelReady() drives the initiator create happy path so CHANNEL is
    // loaded + leader and _groupToChannel maps GROUP -> CHANNEL (the incoming-commit
    // route key). It uses the module CHANNEL/GROUP constants.
    await makeChannelReady();
    await new Promise((r) => setTimeout(r, 0)); // let the backgrounded tail subscribe onMlsCommit
    expect(commitCb).toBeTypeOf('function');

    // The loaded group sits at epoch 1; the incoming commit is epoch 2 (NOT a stale
    // no-op), and processHandshake throws (a leaf-identity collision) so the apply fails.
    store.getGroup.mockResolvedValue({ state: {}, meta: { dmChannelId: CHANNEL, groupId: GROUP, lastAppliedEpoch: 1n } });
    engine.processHandshake.mockRejectedValueOnce(new Error('leaf collision'));

    const failures: Array<{ dmChannelId: string; epoch: string }> = [];
    const off = coordinator.onApplyFailed((e) => failures.push(e));
    store.putGroup.mockClear(); // measure only the post-makeChannelReady put attempts

    await commitCb!({ groupId: GROUP, epoch: '2', commit: 'AAAA' });
    await Promise.resolve();

    expect(failures).toEqual([{ dmChannelId: CHANNEL, epoch: '2' }]);
    expect(store.putGroup).not.toHaveBeenCalled(); // no epoch advance on a failed apply
    off();
  });

  it('live-heal: an OperationError on an incoming commit drops the row AND surfaces the resync banner', async () => {
    // A live (post-activation) incoming commit whose apply throws a WebCrypto
    // OperationError (the group row is encrypted under a stale at-rest key, e.g. a
    // cross-device password change) must heal-drop the row AND emit mls-apply-failed
    // (unlike the activate-time heal, no mls-ready re-establishes a live channel, so
    // the resync banner is the recovery contract; the row is gone, so the next
    // reload/send/open re-establishes via External-Commit).
    let commitCb: ((e: { groupId: string; epoch: string; commit: string }) => void) | undefined;
    client.onMlsCommit.mockImplementation(((cb: (e: { groupId: string; epoch: string; commit: string }) => void) => {
      commitCb = cb;
      return () => undefined;
    }) as () => () => undefined);

    await makeChannelReady();
    await new Promise((r) => setTimeout(r, 0));
    expect(commitCb).toBeTypeOf('function');

    // The group row is encrypted under a stale at-rest key (e.g. a cross-device password
    // change), so the at-rest getGroup decrypt throws a WebCrypto OperationError on every
    // read. healIfOrphanedGroup re-reads to rule out a transient re-key swap,
    // sees the row is STILL undecryptable, drops it + evicts routing, then the live catch emits.
    store.getGroup.mockRejectedValue(Object.assign(new Error('stale at-rest key'), { name: 'OperationError' }));

    const failures: Array<{ dmChannelId: string; epoch: string }> = [];
    const off = coordinator.onApplyFailed((e) => failures.push(e));
    store.deleteGroup.mockClear();
    store.deleteGroup.mockResolvedValue(undefined); // heal awaits deleteGroup(...).catch(...)

    await commitCb!({ groupId: GROUP, epoch: '2', commit: 'AAAA' });
    await Promise.resolve();

    expect(store.deleteGroup).toHaveBeenCalledWith(CHANNEL); // the row was dropped
    expect(failures).toEqual([{ dmChannelId: CHANNEL, epoch: '2' }]); // banner surfaced
    off();
  });

  it('live-heal: an OperationError from processHandshake on a DECODABLE row keeps the row (banner only, no drop)', async () => {
    // Re-read contract: an OperationError whose at-rest row still decodes (e.g.
    // a corrupt/desynced/forged commit makes processHandshake throw a WebCrypto error while
    // getGroup succeeds) is NOT an orphan. The heal must KEEP the readable, history-bearing
    // row + surface the resync banner (catch-up/rebase replays the missed commit), rather
    // than destroying a live group on any OperationError.
    let commitCb: ((e: { groupId: string; epoch: string; commit: string }) => void) | undefined;
    client.onMlsCommit.mockImplementation(((cb: (e: { groupId: string; epoch: string; commit: string }) => void) => {
      commitCb = cb;
      return () => undefined;
    }) as () => () => undefined);

    await makeChannelReady();
    await new Promise((r) => setTimeout(r, 0));
    expect(commitCb).toBeTypeOf('function');

    // getGroup decodes fine (the row is NOT a stale-key orphan); processHandshake throws a
    // WebCrypto-named OperationError applying this specific commit.
    store.getGroup.mockResolvedValue({ state: {}, meta: { dmChannelId: CHANNEL, groupId: GROUP, lastAppliedEpoch: 1n } });
    engine.processHandshake.mockRejectedValueOnce(Object.assign(new Error('bad commit'), { name: 'OperationError' }));

    const failures: Array<{ dmChannelId: string; epoch: string }> = [];
    const off = coordinator.onApplyFailed((e) => failures.push(e));
    store.deleteGroup.mockClear();
    store.deleteGroup.mockResolvedValue(undefined);

    await commitCb!({ groupId: GROUP, epoch: '2', commit: 'AAAA' });
    await Promise.resolve();

    expect(store.deleteGroup).not.toHaveBeenCalled(); // the readable row was KEPT
    expect(failures).toEqual([{ dmChannelId: CHANNEL, epoch: '2' }]); // banner still surfaced
    off();
  });

  it('does NOT emit on a stale-epoch no-op (legitimate drop, must stay silent)', async () => {
    let commitCb: ((e: { groupId: string; epoch: string; commit: string }) => void) | undefined;
    client.onMlsCommit.mockImplementation(((cb: (e: { groupId: string; epoch: string; commit: string }) => void) => {
      commitCb = cb;
      return () => undefined;
    }) as () => () => undefined);

    await makeChannelReady();
    await new Promise((r) => setTimeout(r, 0));
    expect(commitCb).toBeTypeOf('function');

    // Loaded at epoch 5; an incoming epoch-3 commit is a stale no-op (BigInt(3) <= 5),
    // which returns BEFORE processHandshake. It must NOT emit mls-apply-failed.
    store.getGroup.mockResolvedValue({ state: {}, meta: { dmChannelId: CHANNEL, groupId: GROUP, lastAppliedEpoch: 5n } });

    const failures: Array<{ dmChannelId: string; epoch: string }> = [];
    const off = coordinator.onApplyFailed((e) => failures.push(e));

    await commitCb!({ groupId: GROUP, epoch: '3', commit: 'AAAA' });
    await Promise.resolve();

    expect(engine.processHandshake).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
    off();
  });
});
