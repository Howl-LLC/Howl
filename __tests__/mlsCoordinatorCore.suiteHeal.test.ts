// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * PQC cutover self-heal (ciphersuite change). After the default MLS ciphersuite is
 * flipped (e.g. codepoint 1 -> 83 X-Wing), a group persisted under the OLD suite
 * decodes fine but cannot be operated on by the current getImpl(): every ts-mls op
 * (including send) derives keys at the new suite's KDF/AEAD lengths and the WebCrypto
 * HMAC importKey rejects the mismatched secret ("HMAC key length must be shorter than
 * the key data, and by no more than 7 bits"). On a purged server there are no catch-up
 * commits to fail on, so the stale group sits "ready" and the FIRST failure is the
 * user's send; the resync banner cannot clear it because a reload just re-loads the
 * same stale row. The leader must therefore DROP a suite-mismatched group proactively
 * at activation so the channel re-establishes on the current suite.
 *
 * Load-bearing integration test: REAL mlsGroupStore over fake-indexeddb + REAL engine.
 * Only the network/leadership/source/classification seams are injected, plus a thin
 * ciphersuite mock whose ONLY job is to simulate the active-suite CHANGE over time
 * (the real production state transition): the group is seeded while suite-1 is active,
 * then activation runs with suite-83 active. All crypto/store/coordinator logic is real.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

const SUITE_1 = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
const SUITE_83 = 'MLS_256_XWING_AES256GCM_SHA512_Ed25519';

// Mutable holder for the "currently active" suite, available to the hoisted mock.
const suite = vi.hoisted(() => ({ name: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' }));

// Mock ONLY the suite-selection surface; everything ts-mls is real. getImpl/caps
// follow suite.name so engine.createGroup mints under whatever suite is active.
vi.mock('../services/mls/ciphersuite', async () => {
  const { getCiphersuiteImpl, getCiphersuiteFromName, defaultCapabilities } = await vi.importActual<typeof import('ts-mls')>('ts-mls');
  const cache = new Map<string, Promise<unknown>>();
  return {
    get MLS_CIPHERSUITE_NAME() { return suite.name; },
    MLS_CIPHERSUITE_ID: 0,
    getImpl: () => {
      if (!cache.has(suite.name)) cache.set(suite.name, getCiphersuiteImpl(getCiphersuiteFromName(suite.name as Parameters<typeof getCiphersuiteFromName>[0])));
      return cache.get(suite.name)!;
    },
    supportedCapabilities: () => ({ ...defaultCapabilities(), ciphersuites: [suite.name] }),
  };
});

import nacl from 'tweetnacl';
import * as core from '../services/mls/mlsCoordinatorCore';
import { installSeams } from '../services/mls/mlsCoordinatorCore';
import * as store from '../services/mls/mlsGroupStore';
import { createIdentity } from '../services/mls/mlsIdentity';
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

const CH = '00000000-0000-4000-8000-0000000000c2';
const GID = '00000000-0000-4000-8000-0000000000b2';
const USER = '00000000-0000-4000-8000-0000000000a2';
const DEVICE = '00000000-0000-4000-8000-0000000000d2';

const tablock = { acquireLeadership: vi.fn(), isLeader: vi.fn(), releaseLeadership: vi.fn() };
const client = {
  publishKeyPackages: vi.fn(), keyPackageCount: vi.fn(), consumeKeyPackages: vi.fn(),
  createGroup: vi.fn(), getGroupInfo: vi.fn(), submitCommit: vi.fn(), catchUp: vi.fn(),
  getWelcomes: vi.fn(), getDMs: vi.fn(), idempotencyKeyFor: vi.fn(),
  getAikChain: vi.fn(async () => ({ chain: [], head: null })),
  onMlsCommit: vi.fn(() => () => undefined), onMlsWelcome: vi.fn(() => () => undefined),
};

function grantLeaderAndCleanTail({ leader }: { leader: boolean }): void {
  tablock.acquireLeadership.mockResolvedValue(leader);
  tablock.isLeader.mockReturnValue(leader);
  client.keyPackageCount.mockResolvedValue({ remaining: 50, hasLastResort: true });
  client.getWelcomes.mockResolvedValue([]);
  client.catchUp.mockResolvedValue([]);
  client.getDMs.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  suite.name = SUITE_1; // seed phase default
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
});

function bundle(identity: Awaited<ReturnType<typeof createIdentity>>['identity']) {
  return { identity, userId: USER, deviceId: DEVICE };
}

describe('mlsCoordinatorCore — ciphersuite-mismatch heal (PQC cutover)', () => {
  it('drops a group persisted under the previous suite at activation so the channel re-establishes', async () => {
    // Seed a REAL suite-1 group (the active suite during seeding).
    const atRest = await makeKey();
    store.setAtRestKey(atRest);
    const aik = nacl.sign.keyPair();
    const bundleId = await createIdentity(USER, DEVICE, aik.publicKey, aik.secretKey);
    const state = await createGroup(bundleId.identity, GID);
    expect(state.groupContext.cipherSuite).toBe(SUITE_1); // sanity: seeded under suite-1
    await store.putGroup(CH, GID, state, currentEpoch(state));

    grantLeaderAndCleanTail({ leader: true });

    // The active suite is now 83 (post-flip). Activation must drop the stale suite-1 row.
    suite.name = SUITE_83;
    const ready = new Promise<void>((resolve) => {
      const off = core.mlsEvents.on((e) => { if (e === 'mls-ready') { off(); resolve(); } });
    });
    await core.activate(bundle(bundleId.identity), atRest, null);
    await ready;

    // The row was dropped (db MISS -> null, under the SAME at-rest key, so this proves
    // a delete, not a decrypt failure) and the channel is no longer routed/ready.
    expect(await store.getGroup(CH)).toBeNull();
    expect(core.isReadyForChannel(CH)).toBe(false);
  });

  it('keeps a group already on the current suite', async () => {
    const atRest = await makeKey();
    store.setAtRestKey(atRest);
    suite.name = SUITE_83; // seed directly on the current suite
    const aik = nacl.sign.keyPair();
    const bundleId = await createIdentity(USER, DEVICE, aik.publicKey, aik.secretKey);
    const state = await createGroup(bundleId.identity, GID);
    expect(state.groupContext.cipherSuite).toBe(SUITE_83);
    await store.putGroup(CH, GID, state, currentEpoch(state));

    grantLeaderAndCleanTail({ leader: true });

    const ready = new Promise<void>((resolve) => {
      const off = core.mlsEvents.on((e) => { if (e === 'mls-ready') { off(); resolve(); } });
    });
    await core.activate(bundle(bundleId.identity), atRest, null);
    await ready;

    // Same-suite group survives activation and stays ready.
    expect(await store.getGroup(CH)).not.toBeNull();
    expect(core.isReadyForChannel(CH)).toBe(true);
  });

  it('#6: reactively drops a group whose suite no longer matches when encrypt() runs mid-session (no reload)', async () => {
    const atRest = await makeKey();
    store.setAtRestKey(atRest);
    // Seed + activate while suite-1 is still active, so the activation sweep KEEPS
    // the group and the channel is ready/loaded.
    suite.name = SUITE_1;
    const aik = nacl.sign.keyPair();
    const bundleId = await createIdentity(USER, DEVICE, aik.publicKey, aik.secretKey);
    const state = await createGroup(bundleId.identity, GID);
    expect(state.groupContext.cipherSuite).toBe(SUITE_1);
    await store.putGroup(CH, GID, state, currentEpoch(state));

    grantLeaderAndCleanTail({ leader: true });

    const ready = new Promise<void>((resolve) => {
      const off = core.mlsEvents.on((e) => { if (e === 'mls-ready') { off(); resolve(); } });
    });
    await core.activate(bundle(bundleId.identity), atRest, null);
    await ready;
    expect(core.isReadyForChannel(CH)).toBe(true); // survived activation

    // Mid-session PQC cutover with NO reload: the active suite flips to 83. The next
    // send must NOT run the new suite's AEAD over the old suite's secrets — it drops
    // the group (re-establish) and rejects this send, rather than staying bricked
    // until a reload re-runs the activation sweep.
    suite.name = SUITE_83;
    await expect(core.encrypt(CH, 'hello')).rejects.toThrow(/stale ciphersuite/);
    expect(await store.getGroup(CH)).toBeNull();
    expect(core.isReadyForChannel(CH)).toBe(false);
  });
});
