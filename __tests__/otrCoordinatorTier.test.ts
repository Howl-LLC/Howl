// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * OTR tier wiring tests. This file is the shared home for the OTR-tier coordinator
 * + engine behaviours; the coordinator and dispatcher behaviours append their own
 * `describe(...)` blocks below the engine block.
 *
 * Engine block: the MLS engine selects a tighter key-retention profile for the OTR
 * tier. OTR has no durable plaintext archive, so its group retains fewer past-epoch
 * receiver secrets than Saved — `retainKeysForEpochs` tightens from 4 (Saved) to 2
 * (OTR); `retainKeysForGenerations` stays at 10 so a briefly offline peer can still
 * catch up on queued envelopes within an epoch.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { getImpl } from '../services/mls/ciphersuite';
import {
  generateKeyPackage,
  defaultCapabilities,
  type Credential,
  type Lifetime,
} from 'ts-mls';
import {
  createGroup,
  encodeState,
  decodeState,
  type MlsIdentity,
} from '../services/mls/mlsEngine';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const realLifetime = (): Lifetime => ({
  notBefore: 0n,
  notAfter: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30),
});

async function makeIdentity(userId: string, deviceId: string): Promise<MlsIdentity> {
  const impl = await getImpl();
  const credential: Credential = {
    credentialType: 'basic',
    identity: new TextEncoder().encode(`${userId}:${deviceId}`),
  };
  const { publicPackage, privatePackage } = await generateKeyPackage(
    credential, defaultCapabilities(), realLifetime(), [], impl,
  );
  return {
    signaturePublicKey: publicPackage.leafNode.signaturePublicKey,
    signaturePrivateKey: privatePackage.signaturePrivateKey,
    credentialIdentity: credential.identity,
  };
}

describe('engine tier config', () => {
  it("decodeState(bytes, 'otr') reattaches the tighter OTR retention (retainKeysForEpochs === 2)", async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    const state = await createGroup(alice, randomUUID());
    const restored = decodeState(encodeState(state), 'otr');
    const krc = restored.clientConfig.keyRetentionConfig;
    expect(krc.retainKeysForEpochs).toBe(2);
    // Generations stays 10 so brief-offline within-epoch catch-up still decrypts.
    expect(krc.retainKeysForGenerations).toBe(10);
    expect(krc.maximumForwardRatchetSteps).toBe(200);
  });

  it("decodeState(bytes, 'saved') reattaches the Saved retention (retainKeysForEpochs === 4)", async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    const state = await createGroup(alice, randomUUID());
    const restored = decodeState(encodeState(state), 'saved');
    expect(restored.clientConfig.keyRetentionConfig.retainKeysForEpochs).toBe(4);
  });

  it('decodeState with no tier defaults to Saved retention (retainKeysForEpochs === 4)', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    const state = await createGroup(alice, randomUUID());
    const restored = decodeState(encodeState(state));
    expect(restored.clientConfig.keyRetentionConfig.retainKeysForEpochs).toBe(4);
  });
});

/**
 * Coordinator tier wiring: tier threads through the create path and the in-memory
 * routing maps are keyed by roomKey, while the durable classification is keyed by
 * the BARE dmChannelId. Drives the REAL engine (no engine mock — the engine block
 * above needs it) and mocks ONLY the IO store, mirroring the real-engine
 * scaffolding in __tests__/mls/mlsCoordinatorRebaseState.test.ts. Network / leadership
 * / classification are injected via installSeams.
 */
const { store, client, apiClient } = vi.hoisted(() => ({
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
    putGroup: vi.fn(),
    putGroupAndHistory: vi.fn(),
    getGroup: vi.fn(),
    getHistory: vi.fn(),
    listGroupChannelIds: vi.fn(),
    getGroupIdToChannelMap: vi.fn(),
    deleteGroup: vi.fn(),
    putKpPrivate: vi.fn(),
    getAllKeyPackageCandidates: vi.fn(),
    deleteKpPrivate: vi.fn(),
    getMeta: vi.fn(),
    setMeta: vi.fn(),
    clearAll: vi.fn(),
    // Read by consumeOneKeyPackage as the AIK TOFU-pin/verify seam passed to
    // assertConsumedKeyPackageTrusted (mlsCoordinatorCore.ts:71). Returns true =
    // first-sight pin of the peer's AIK; present so the mock-module proxy can read
    // the export. Mirrors __tests__/mlsCoordinator.test.ts.
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
  apiClient: { getDMs: vi.fn() },
  getAikChain: vi.fn(async () => ({ chain: [], head: null })),
  getPeerAik: vi.fn(async () => ({ signingPublicKey: null })),
  resetGroup: vi.fn(async () => ({ success: true })),
}));
vi.mock('../services/mls/mlsGroupStore', () => store);

import * as core from '../services/mls/mlsCoordinatorCore';
import { installSeams } from '../services/mls/mlsCoordinatorCore';
import { createIdentity, generateKeyPackages } from '../services/mls/mlsIdentity';
import { toBase64 } from '../services/cryptoHelpers';
import * as engine from '../services/mls/mlsEngine';
import { encodeMlsEnvelope } from '../services/mls/types';

const markMls = vi.fn();

describe('coordinator tier wiring', () => {
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
      source: { onCommit: () => () => undefined, onWelcome: () => () => undefined },
      classification: { markMls: (id: string) => markMls(id) },
      leadership: { isLeader: () => true, acquire: async () => true, release: () => undefined },
    });
    // Benign network defaults: empty routing map, KP pool full (tail no-ops), no welcomes.
    store.getGroupIdToChannelMap.mockResolvedValue(new Map());
    store.getAllKeyPackageCandidates.mockResolvedValue([]);
    client.keyPackageCount.mockResolvedValue({ remaining: 9, hasLastResort: true });
    client.publishKeyPackages.mockResolvedValue(undefined);
    client.getWelcomes.mockResolvedValue([]);
    client.catchUp.mockResolvedValue([]);
    client.idempotencyKeyFor.mockResolvedValue('idem-k');
    apiClient.getDMs.mockResolvedValue([]);
  });

  afterEach(() => {
    core.deactivate();
  });

  it("createDmGroup(id, peer, 'otr') threads tier to net.createGroup and persists under the OTR room key (markMls stays bare)", async () => {
    const id = randomUUID();
    const peerUserId = randomUUID();
    const aliceAik = nacl.sign.keyPair();
    const alice = await createIdentity(randomUUID(), randomUUID(), aliceAik.publicKey, aliceAik.secretKey);
    const bobAik = nacl.sign.keyPair();
    const bob = await createIdentity(peerUserId, randomUUID(), bobAik.publicKey, bobAik.secretKey);
    // A REAL peer KeyPackage so the real engine.addMembers commit succeeds.
    const bobKps = await generateKeyPackages(bob.identity, 1, false);
    client.consumeKeyPackages.mockResolvedValue([
      { deviceId: bob.deviceId, keyPackage: toBase64(bobKps[0].keyPackage), keyPackageRef: 'ref', isLastResort: false },
    ]);
    client.createGroup.mockResolvedValue({ groupId: 'grp-otr', currentEpoch: '0' });
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '1', commitId: 'cid' });

    await core.activate(alice, {} as CryptoKey, null);
    await new Promise((r) => setTimeout(r, 0)); // let the backgrounded tail settle

    await core.createDmGroup(id, peerUserId, 'otr');

    // net.createGroup receives the bare id + the GroupInfo + tier 'otr' (3rd arg).
    expect(client.createGroup).toHaveBeenCalledTimes(1);
    expect(client.createGroup.mock.calls[0][0]).toBe(id);
    expect(client.createGroup.mock.calls[0][2]).toBe('otr');

    // store.putGroup is keyed by the OTR room key, carrying { channelId: id, tier: 'otr' }.
    expect(store.putGroup).toHaveBeenCalledTimes(1);
    const [rk, , , , opts] = store.putGroup.mock.calls[0];
    expect(rk).toBe(`${id}#otr`);
    expect(opts).toMatchObject({ channelId: id, tier: 'otr' });

    // Durable classification is the BARE id, never the room key.
    expect(markMls).toHaveBeenCalledWith(id);
    expect(markMls).not.toHaveBeenCalledWith(`${id}#otr`);
  });

  it("establishChannel(id, peer, null, 'otr') resolves to the created OTR groupId so the toggle can refresh dmStore", async () => {
    // Fresh toggle on an existing DM: there is no server OTR group yet, so establish
    // falls through to createDmGroup. The caller (DMView toggle) needs the new server
    // groupId to write into the dmStore entry's otrMlsGroupId — establishChannel must
    // surface it (it is held in _loadedGroups under the OTR room key) instead of void.
    const id = randomUUID();
    const peerUserId = randomUUID();
    const aliceAik = nacl.sign.keyPair();
    const alice = await createIdentity(randomUUID(), randomUUID(), aliceAik.publicKey, aliceAik.secretKey);
    const bobAik = nacl.sign.keyPair();
    const bob = await createIdentity(peerUserId, randomUUID(), bobAik.publicKey, bobAik.secretKey);
    const bobKps = await generateKeyPackages(bob.identity, 1, false);
    client.consumeKeyPackages.mockResolvedValue([
      { deviceId: bob.deviceId, keyPackage: toBase64(bobKps[0].keyPackage), keyPackageRef: 'ref', isLastResort: false },
    ]);
    client.createGroup.mockResolvedValue({ groupId: 'grp-otr', currentEpoch: '0' });
    client.submitCommit.mockResolvedValue({ ok: true, epoch: '1', commitId: 'cid' });

    await core.activate(alice, {} as CryptoKey, null);
    await new Promise((r) => setTimeout(r, 0));

    const groupId = await core.establishChannel(id, peerUserId, null, 'otr');
    expect(groupId).toBe('grp-otr');
  });

  it('listOtrChannels() returns the bare channelIds of the OTR groups in the routing map', async () => {
    const otrId = randomUUID();
    const savedId = randomUUID();
    store.getGroupIdToChannelMap.mockResolvedValue(
      new Map([
        ['grp-otr', { roomKey: `${otrId}#otr`, channelId: otrId, tier: 'otr' }],
        ['grp-saved', { roomKey: savedId, channelId: savedId, tier: 'saved' }],
      ]),
    );
    const out = await core.listOtrChannels();
    expect(out).toEqual([otrId]);
  });

  it('endOtrGroup(id) deletes the OTR room-key group and leaves the Saved group', async () => {
    const id = randomUUID();
    const aliceAik = nacl.sign.keyPair();
    const alice = await createIdentity(randomUUID(), randomUUID(), aliceAik.publicKey, aliceAik.secretKey);
    // Seed both tiers into the routing map so activate loads them by room key.
    store.getGroupIdToChannelMap.mockResolvedValue(
      new Map([
        ['grp-otr', { roomKey: `${id}#otr`, channelId: id, tier: 'otr' }],
        ['grp-saved', { roomKey: id, channelId: id, tier: 'saved' }],
      ]),
    );
    await core.activate(alice, {} as CryptoKey, null);
    await new Promise((r) => setTimeout(r, 0));

    await core.endOtrGroup(id);

    expect(store.deleteGroup).toHaveBeenCalledTimes(1);
    expect(store.deleteGroup).toHaveBeenCalledWith(`${id}#otr`);
    // The Saved group (bare key) is untouched.
    expect(store.deleteGroup).not.toHaveBeenCalledWith(id);
  });

  it('joinPendingWelcomes does NOT re-join an already-loaded OTR group, and never writes its stray Welcome into the Saved bucket', async () => {
    const id = randomUUID();
    const aliceAik = nacl.sign.keyPair();
    const alice = await createIdentity(randomUUID(), randomUUID(), aliceAik.publicKey, aliceAik.secretKey);
    // The OTR group is already joined (loaded under its OTR room key), but a stray
    // batched-Add Welcome for it is still pending on the server. The OTR group is
    // keyed by the OTR room key, so the already-joined guard (_loadedGroups.has(rk))
    // short-circuits BEFORE joinFromWelcome — the OTR state can never be written into
    // the Saved (bare-id) bucket. (Corruption guard, preserved by room-key
    // isolation now that the recipient first-join via Welcome is supported.)
    store.getGroupIdToChannelMap.mockResolvedValue(
      new Map([['grp-otr', { roomKey: `${id}#otr`, channelId: id, tier: 'otr' }]]),
    );
    // A pending Welcome for the OTR groupId.
    client.getWelcomes.mockResolvedValue([{ groupId: 'grp-otr', welcomeData: 'd2VsY29tZQ==' }]);
    const joinSpy = vi.spyOn(engine, 'joinFromWelcome');

    await core.activate(alice, {} as CryptoKey, null);
    // joinPendingWelcomes runs in the backgrounded activate tail; let it settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // The OTR Welcome must NOT be joined…
    expect(joinSpy).not.toHaveBeenCalled();
    // …and nothing may be written into the Saved (bare-id) bucket for it.
    expect(store.putGroup).not.toHaveBeenCalledWith(id, expect.anything(), expect.anything(), expect.anything(), expect.anything());
    expect(store.putGroupAndHistory).not.toHaveBeenCalled();

    joinSpy.mockRestore();
  });

  it('joinPendingWelcomes JOINS a not-yet-joined OTR welcome under the OTR room key (recipient auto-join); markMls stays bare, Saved bucket untouched', async () => {
    // The counterparty (alice) enabled OTR and Added this device, producing a
    // pending OTR Welcome. This device has NOT joined the OTR group yet, so it
    // must process the Welcome and join — keyed by the OTR ROOM key so the join
    // never touches the Saved (bare-id) bucket. getDMs surfaces the
    // channel's otrMlsGroupId, which is how a brand-new OTR group gets mapped.
    const id = randomUUID();
    const aliceAik = nacl.sign.keyPair();
    const alice = await createIdentity(randomUUID(), randomUUID(), aliceAik.publicKey, aliceAik.secretKey);
    store.getGroupIdToChannelMap.mockResolvedValue(new Map()); // nothing joined yet
    apiClient.getDMs.mockResolvedValue([{ id, mlsGroupId: null, otrMlsGroupId: 'grp-otr' }]);
    client.getWelcomes.mockResolvedValue([{ groupId: 'grp-otr', welcomeData: 'd2VsY29tZQ==' }]);
    const fakeState = { tag: 'otr-joined' };
    const joinSpy = vi.spyOn(engine, 'joinFromWelcome').mockResolvedValue(
      { state: fakeState, consumedKpRef: 'kpref', isLastResort: false } as never,
    );
    vi.spyOn(engine, 'currentEpoch').mockReturnValue(1n);

    await core.activate(alice, {} as CryptoKey, null);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // The OTR Welcome WAS joined…
    expect(joinSpy).toHaveBeenCalled();
    // …persisted under the OTR room key with { channelId, tier:'otr' }, never the bare/Saved key.
    expect(store.putGroup).toHaveBeenCalledWith(`${id}#otr`, 'grp-otr', fakeState, 1n, { channelId: id, tier: 'otr' });
    expect(store.putGroup).not.toHaveBeenCalledWith(id, expect.anything(), expect.anything(), expect.anything(), expect.anything());
    // The OTR room is ready; the Saved tier is independent and not ready.
    expect(core.isReadyForChannel(id, 'otr')).toBe(true);
    expect(core.isReadyForChannel(id, 'saved')).toBe(false);
    // Durable classification is the BARE id, never the room key.
    expect(markMls).toHaveBeenCalledWith(id);

    joinSpy.mockRestore();
  });
});

/**
 * Coordinator encrypt/decrypt tier routing + OTR no-archive gate.
 * encrypt/decrypt/isReadyForChannel key on the roomKey and thread the tier; the
 * durable readable-history archive (getHistory read + putGroupAndHistory write)
 * is Saved-only — an OTR decrypt NEVER touches it, only snapshot-only putGroup.
 * Mirrors the coordinator-tier scaffolding (real engine, store mock, leader via
 * seams) and spies engine.encryptApp/decryptApp so the live ratchet is deterministic.
 */
describe('coordinator encrypt/decrypt tier routing', () => {
  const GROUP_ID = 'grp-otr-rt';

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
      source: { onCommit: () => () => undefined, onWelcome: () => () => undefined },
      classification: { markMls: (id: string) => markMls(id) },
      leadership: { isLeader: () => true, acquire: async () => true, release: () => undefined },
    });
    store.getAllKeyPackageCandidates.mockResolvedValue([]);
    client.keyPackageCount.mockResolvedValue({ remaining: 9, hasLastResort: true });
    client.publishKeyPackages.mockResolvedValue(undefined);
    client.getWelcomes.mockResolvedValue([]);
    client.catchUp.mockResolvedValue([]);
    client.idempotencyKeyFor.mockResolvedValue('idem-k');
    apiClient.getDMs.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    core.deactivate();
  });

  // Load ONLY an OTR group under roomKey(id,'otr') into _loadedGroups.
  async function activateWithOtrGroup(id: string): Promise<void> {
    const aliceAik = nacl.sign.keyPair();
    const alice = await createIdentity(randomUUID(), randomUUID(), aliceAik.publicKey, aliceAik.secretKey);
    store.getGroupIdToChannelMap.mockResolvedValue(
      new Map([[GROUP_ID, { roomKey: `${id}#otr`, channelId: id, tier: 'otr' }]]),
    );
    await core.activate(alice, {} as CryptoKey, null);
    await new Promise((r) => setTimeout(r, 0));
  }

  it("encrypt(id, 'hi', 'otr') keys on the OTR room key and persists snapshot-only with { channelId, tier }", async () => {
    const id = randomUUID();
    await activateWithOtrGroup(id);

    const fakeState = { tag: 'otr-state' };
    const fakeNew = { tag: 'otr-new' };
    store.getGroup.mockResolvedValue({ state: fakeState, meta: {} });
    vi.spyOn(engine, 'encryptApp').mockResolvedValue({
      newState: fakeNew as never,
      privateMessage: new Uint8Array([9, 9, 9, 9]),
    } as never);
    vi.spyOn(engine, 'currentEpoch').mockReturnValue(1n);

    const env = await core.encrypt(id, 'hi', 'otr');
    expect(typeof env).toBe('string');

    // Read + write key on the OTR room key.
    expect(store.getGroup).toHaveBeenCalledWith(`${id}#otr`);
    expect(store.putGroup).toHaveBeenCalledTimes(1);
    const [rk, gid, , , opts] = store.putGroup.mock.calls[0];
    expect(rk).toBe(`${id}#otr`);
    expect(gid).toBe(GROUP_ID);
    expect(opts).toMatchObject({ channelId: id, tier: 'otr' });
    // OTR encrypt never archives.
    expect(store.putGroupAndHistory).not.toHaveBeenCalled();
  });

  it("decrypt(id, env, 'm1', 'otr') NEVER reads or writes the durable archive — only snapshot-only putGroup on the OTR room key", async () => {
    const id = randomUUID();
    await activateWithOtrGroup(id);

    const env = encodeMlsEnvelope(new Uint8Array([1, 2, 3, 4]));
    store.getHistoryKey.mockReturnValue({} as CryptoKey); // would archive if tier were Saved
    store.getGroup.mockResolvedValue({ state: { tag: 's' }, meta: {} });
    vi.spyOn(engine, 'decryptApp').mockResolvedValue({
      newState: { tag: 'n' } as never,
      plaintext: new TextEncoder().encode('hello-otr'),
    } as never);
    vi.spyOn(engine, 'currentEpoch').mockReturnValue(2n);

    const out = await core.decrypt(id, env, 'm1', 'otr');
    expect(out).toBe('hello-otr');

    // Archive READ gated off for OTR.
    expect(store.getHistory).not.toHaveBeenCalled();
    // Archive WRITE gated off for OTR.
    expect(store.putGroupAndHistory).not.toHaveBeenCalled();
    // Snapshot-only persist on the OTR room key.
    expect(store.putGroup).toHaveBeenCalledTimes(1);
    const [rk, gid, , , opts] = store.putGroup.mock.calls[0];
    expect(rk).toBe(`${id}#otr`);
    expect(gid).toBe(GROUP_ID);
    expect(opts).toMatchObject({ channelId: id, tier: 'otr' });
  });

  it("isReadyForChannel reflects the OTR group independently of the Saved tier", async () => {
    const id = randomUUID();
    await activateWithOtrGroup(id); // only the OTR room key is loaded

    expect(core.isReadyForChannel(id, 'otr')).toBe(true);
    expect(core.isReadyForChannel(id, 'saved')).toBe(false);
    expect(core.isReadyForChannel(id)).toBe(false); // defaults to Saved
  });
});

/**
 * Dispatcher tier threading. The PUBLIC mlsCoordinator surface, exercised in WORKER
 * mode (useWorker=true + a mock SharedWorker) so the proxied methods post an RPC
 * rather than calling the in-process core. Tier is appended to the proxy `args[]`,
 * and the readiness mirror is keyed by roomKey (the worker's readyChannelIds are
 * room keys). This is a DIFFERENT setup from the core-path blocks above (which run
 * installSeams + activate in-process); it lives in its own describe with its own
 * mock-worker beforeEach, mirroring __tests__/mlsCoordinatorDispatcher.test.ts.
 */
describe('dispatcher tier threading (worker mode)', () => {
  const bundleStub = { identity: { signaturePublicKey: new Uint8Array(), signaturePrivateKey: new Uint8Array(), credentialIdentity: new Uint8Array() }, userId: 'u', deviceId: 'd' };

  afterEach(() => {
    delete (globalThis as any).SharedWorker;
    try { localStorage.clear(); } catch { /* ignore */ }
    vi.resetModules();
  });

  // Spawn a mock SharedWorker, import a fresh dispatcher, and drive its init ack so the
  // worker path is fully wired. Returns the dispatcher plus the posted-message log and
  // the captured port.onmessage so the test can push readiness/rpc-result frames.
  async function bootWorkerDispatcher() {
    const posted: any[] = [];
    let portOnMessage: any = null;
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (m: any) => posted.push(m), set onmessage(fn: any) { portOnMessage = fn; }, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const disp = await import('../services/mls/mlsCoordinator');
    const actP = disp.activate(bundleStub as any, {} as CryptoKey, null);
    const init = posted.find((m) => m.kind === 'init');
    portOnMessage?.({ data: { kind: 'rpc-result', correlationId: init.correlationId, ok: true, value: undefined } });
    await actP;
    return { disp, posted, pushFrame: (data: any) => portOnMessage?.({ data }) };
  }

  it("encrypt(id, 'x', 'otr') posts an RPC whose args is [id, 'x', 'otr']", async () => {
    const { disp, posted } = await bootWorkerDispatcher();
    void disp.encrypt('ch1', 'x', 'otr').catch(() => {});
    const req = posted.find((m) => m.kind === 'rpc' && m.method === 'encrypt');
    expect(req).toBeTruthy();
    expect(req.args).toEqual(['ch1', 'x', 'otr']);
  });

  it("isReadyForChannel(id, 'otr') consults the OTR roomKey in the readiness mirror, independent of Saved", async () => {
    const { disp, pushFrame } = await bootWorkerDispatcher();
    // Worker readyChannelIds are room keys; seed only the OTR room key.
    pushFrame({ kind: 'readiness', active: true, readyChannelIds: ['ch1#otr'] });
    expect(disp.isReadyForChannel('ch1', 'otr')).toBe(true);
    expect(disp.isReadyForChannel('ch1', 'saved')).toBe(false);
    expect(disp.isReadyForChannel('ch1')).toBe(false); // defaults to Saved
  });

  it('endOtrGroup(id) round-trips through the proxy (posts an rpc named endOtrGroup with [id])', async () => {
    const { disp, posted } = await bootWorkerDispatcher();
    void disp.endOtrGroup('ch1').catch(() => {});
    const req = posted.find((m) => m.kind === 'rpc' && m.method === 'endOtrGroup');
    expect(req).toBeTruthy();
    expect(req.args).toEqual(['ch1']);
  });

  it('listOtrChannels() round-trips through the proxy (posts an rpc named listOtrChannels with [])', async () => {
    const { disp, posted } = await bootWorkerDispatcher();
    void disp.listOtrChannels().catch(() => {});
    const req = posted.find((m) => m.kind === 'rpc' && m.method === 'listOtrChannels');
    expect(req).toBeTruthy();
    expect(req.args).toEqual([]);
  });
});
