// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * core.decrypt is ARCHIVE-FIRST and gains an optional
 * messageId that gates a durable archive WRITE.
 *  - Read order: in-session plaintext cache -> durable archive (store.getHistory,
 *    keyed by the envelope's hex SHA-256) -> live decrypt.
 *  - On a fresh live decrypt, when messageId is present AND the channel is Saved AND
 *    the history key is unlocked, persist the advanced ratchet + plaintext together
 *    via putGroupAndHistory (single tx). Otherwise fall back to snapshot-only putGroup.
 *  - Quota / write failure is graceful: returns plaintext, never throws.
 *  - the archive is keyed by the ENVELOPE HASH, so a hit is the plaintext of
 *    exactly that ciphertext; messageId gates the WRITE, not the READ.
 *
 * Mirrors the engine/store/identity hoisted-mocks + installSeams scaffolding from
 * __tests__/mlsCoordinatorCore.activate.test.ts. The store mock additionally
 * implements getHistory + putGroupAndHistory (the archive seams).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';

// jsdom ships no WebCrypto; sha256Hex inside the core uses crypto.subtle.digest, so
// install Node's webcrypto polyfill (same pattern as __tests__/mls/ciphersuite.test.ts).
beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

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
    getHistoryKey: vi.fn((): CryptoKey | null => null),
    getHistory: vi.fn(),
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

import * as core from '../services/mls/mlsCoordinatorCore';
import { installSeams } from '../services/mls/mlsCoordinatorCore';
import { encodeMlsEnvelope } from '../services/mls/types';
import { setChannelProtocol } from '../services/encryptionFlags';

// A real v:4 envelope so tryParseMlsEnvelope returns truthy and the live-decrypt
// path is reached (types.ts is the unmocked real module).
const CH = 'ch-archive';
const GROUP_ID = 'grp-archive';
const ENVELOPE = encodeMlsEnvelope(new Uint8Array([1, 2, 3, 4]));

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

beforeEach(async () => {
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
  // Reset in-memory state (incl. the _plaintextCache and first-init latch) so a
  // prior test's cached envelope never short-circuits the archive read.
  core.deactivate();

  client.keyPackageCount.mockResolvedValue({ remaining: 9, hasLastResort: true });
  client.publishKeyPackages.mockResolvedValue(undefined);
  client.consumeKeyPackages.mockResolvedValue([]);
  client.getWelcomes.mockResolvedValue([]);
  client.catchUp.mockResolvedValue([]);
  client.idempotencyKeyFor.mockResolvedValue('idem-key-deadbeef');
  apiClient.getDMs.mockResolvedValue([]);
  // Routing map seeds _loadedGroups with CH -> isReadyForChannel(CH) is true after
  // activate (leader + active + loaded).
  store.getGroupIdToChannelMap.mockResolvedValue(new Map([[GROUP_ID, { roomKey: CH, channelId: CH, tier: 'saved' }]]));
  store.getAllKeyPackageCandidates.mockResolvedValue([]);
  identity.generateKeyPackages.mockResolvedValue([]);
  engine.currentEpoch.mockReturnValue(1n);
  store.getHistoryKey.mockReturnValue({} as CryptoKey);
  tablock.isLeader.mockReturnValue(true);
  tablock.acquireLeadership.mockResolvedValue(true);

  // Activate so the channel is MLS-ready (active + leader + loaded).
  await core.activate(bundle('u1'), {} as CryptoKey, {} as CryptoKey);
  await new Promise((r) => setTimeout(r, 0)); // let the backgrounded tail settle
});

afterEach(() => {
  // Clear the module-level _plaintextCache (and all in-memory state) between tests.
  core.deactivate();
});

describe('core.decrypt archive-first', () => {
  it('returns archived plaintext without calling engine.decryptApp on an archive hit', async () => {
    store.getHistory.mockResolvedValueOnce('archived text');
    const out = await core.decrypt(CH, ENVELOPE, 'm1');
    expect(out).toBe('archived text');
    expect(engine.decryptApp).not.toHaveBeenCalled();
  });

  it('archives a fresh decrypt via putGroupAndHistory with messageId + envHash', async () => {
    store.getHistory.mockResolvedValueOnce(null);
    store.getGroup.mockResolvedValueOnce({ state: {}, meta: {} });
    engine.decryptApp.mockResolvedValueOnce({ newState: {}, plaintext: new TextEncoder().encode('fresh') });
    const out = await core.decrypt(CH, ENVELOPE, 'm2');
    expect(out).toBe('fresh');
    expect(store.putGroupAndHistory).toHaveBeenCalledTimes(1);
    const arg = store.putGroupAndHistory.mock.calls[0][4];
    expect(arg).toMatchObject({ messageId: 'm2', plaintext: 'fresh' });
    expect(typeof arg.envHash).toBe('string');
    expect(arg.envHash.length).toBeGreaterThan(0);
  });

  it('serves the archived plaintext when the live ratchet would throw (reload)', async () => {
    store.getHistory.mockResolvedValueOnce('saved'); // archive has it
    engine.decryptApp.mockRejectedValue(new Error('Desired gen in the past'));
    const out = await core.decrypt(CH, ENVELOPE, 'm3');
    expect(out).toBe('saved');
  });

  it('returns the plaintext and does not throw when the archive write hits quota', async () => {
    store.getHistory.mockResolvedValueOnce(null);
    store.getGroup.mockResolvedValueOnce({ state: {}, meta: {} });
    engine.decryptApp.mockResolvedValueOnce({ newState: {}, plaintext: new TextEncoder().encode('q') });
    const quota = new Error('quota');
    (quota as { name?: string }).name = 'QuotaExceededError';
    store.putGroupAndHistory.mockRejectedValueOnce(quota);
    await expect(core.decrypt(CH, ENVELOPE, 'm4')).resolves.toBe('q');
  });

  it('serves an archive HIT with no messageId (preview of an already-archived message)', async () => {
    // A no-messageId preview whose plaintext is already archived returns its text
    // via the archive read, which precedes the read-only deferral. No ratchet run.
    store.getHistory.mockResolvedValueOnce('archived preview');
    const out = await core.decrypt(CH, ENVELOPE);
    expect(out).toBe('archived preview');
    expect(engine.decryptApp).not.toHaveBeenCalled();
    expect(store.putGroup).not.toHaveBeenCalled();
    expect(store.putGroupAndHistory).not.toHaveBeenCalled();
  });

  it('a no-messageId decrypt that MISSES cache+archive is read-only (preserves the ratchet)', async () => {
    // The sidebar preview path reaches core.decrypt WITHOUT a messageId. Running the
    // single-use ratchet here would advance + zeroize the message key without a
    // delete-targetable archive write, permanently losing the newest message after a
    // reload. The deferral must NOT run engine.decryptApp and must NOT persist any
    // state; it surfaces as the lock placeholder (a throw decryptMlsContent catches).
    store.getHistory.mockResolvedValueOnce(null); // archive miss
    store.getGroup.mockResolvedValue({ state: {}, meta: {} });
    engine.decryptApp.mockResolvedValue({ newState: {}, plaintext: new TextEncoder().encode('p') });
    await expect(core.decrypt(CH, ENVELOPE)).rejects.toThrow(/preview decrypt deferred/);
    expect(engine.decryptApp).not.toHaveBeenCalled(); // ratchet never advanced
    expect(store.putGroup).not.toHaveBeenCalled();    // no snapshot persisted
    expect(store.putGroupAndHistory).not.toHaveBeenCalled(); // no archive write
    expect(store.getHistory).toHaveBeenCalled(); // archive read precedes the deferral
  });

  it('serves archived plaintext on a reload BEFORE leadership is re-acquired (not-ready window)', async () => {
    // Root cause of "received message decrypts live, then 🔒 after a plain refresh":
    // activate()'s AWAITED prefix installs the historyKey + routing map, but
    // leadership.acquire() runs in the BACKGROUNDED activateTail — so there is a window
    // where isReadyForChannel() is FALSE (this tab/worker is not yet leader) even though
    // the durable archive is fully readable (it needs only the historyKey, not the
    // writer lease). The archive (and in-session cache) read MUST precede the readiness
    // gate, so a refreshed/non-leader tab can re-display a message whose single-use
    // ratchet was already consumed. Before the fix the gate throws first and the
    // readable plaintext is never served -> permanent lock placeholder.
    tablock.isLeader.mockReturnValue(false); // not (yet) leader: isReadyForChannel === false
    store.getHistory.mockResolvedValueOnce('decrypted-live-then-archived');
    const out = await core.decrypt(CH, ENVELOPE, 'm-reload');
    expect(out).toBe('decrypted-live-then-archived');
    expect(engine.decryptApp).not.toHaveBeenCalled(); // never ran the live ratchet
  });

  it('still throws (fail-closed) when NOT leader AND the archive misses (heal path intact)', async () => {
    // The complement: a genuine not-ready first-time failure (no archived plaintext)
    // must still throw so decryptMlsContent surfaces the placeholder and useMlsRedecrypt
    // heals it once ready. Moving the archive read above the gate must NOT let a non-ready
    // tab run the live ratchet.
    tablock.isLeader.mockReturnValue(false);
    store.getHistory.mockResolvedValueOnce(null); // archive miss
    await expect(core.decrypt(CH, ENVELOPE, 'm-miss')).rejects.toThrow(/mls channel not ready/);
    expect(engine.decryptApp).not.toHaveBeenCalled(); // ratchet never advanced when not leader
  });

});
