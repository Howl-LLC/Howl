// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * provisionMlsDevice() runs on authenticated session start, BEFORE and
 * independent of vault unlock, under withProvisionLock. It branches on
 * mlsGroupStore.getIdentityMeta(userId):
 *   - null            -> mint a fresh device-wrapped identity + publish initial batch
 *   - wrapVersion 1   -> DEFER (no mint; the per-device collision guard)
 *   - wrapVersion 2   -> load + top-up + rotate last-resort
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const { identity, mlsClient, mlsGroupStore, coordinator, apiClient, tabLock } = vi.hoisted(() => {
  const listeners = new Set<(e: 'mls-ready' | 'mls-locked') => void>();
  const mlsEvents = { on(cb: (e: 'mls-ready' | 'mls-locked') => void) { listeners.add(cb); return () => listeners.delete(cb); } };
  return {
    identity: {
      mintLeafKeypair: vi.fn(),
      buildCrossSignedCredentialIdentity: vi.fn(),
      decodeMlsCredentialIdentity: vi.fn(),
      generateKeyPackages: vi.fn(),
      KEYPACKAGE_BATCH_SIZE: 20,
      KEYPACKAGE_LOW_WATER: 5,
    },
    mlsClient: {
      publishKeyPackages: vi.fn(),
      keyPackageCount: vi.fn(),
    },
    mlsGroupStore: {
      setAtRestKey: vi.fn(),
      getAtRestKey: vi.fn((): CryptoKey | null => null),
      setHistoryKey: vi.fn(),
      getHistoryKey: vi.fn((): CryptoKey | null => null),
      putKpPrivate: vi.fn(() => Promise.resolve()),
      putIdentity: vi.fn(() => Promise.resolve()),
      getIdentity: vi.fn((): Promise<Record<string, unknown> | null> => Promise.resolve(null)),
      getIdentityMeta: vi.fn((): Promise<{ exists: boolean; wrapVersion: 1 | 2 } | null> => Promise.resolve(null)),
      getOrCreateDeviceWrapKey: vi.fn(() => Promise.resolve({} as CryptoKey)),
      deleteKpPrivate: vi.fn(() => Promise.resolve()),
      deleteAllKpPrivate: vi.fn(() => Promise.resolve()),
      getAllKeyPackageCandidates: vi.fn((): Promise<{ keyPackageRef: string; keyPackage: Uint8Array; privateKeyPackage: Uint8Array; isLastResort: boolean }[]> => Promise.resolve([])),
    },
    coordinator: { activate: vi.fn(() => Promise.resolve()), rekey: vi.fn(() => Promise.resolve()), deactivate: vi.fn(), reconcileChannelClassifications: vi.fn(), mlsEvents },
    apiClient: { setupDmKeys: vi.fn(), getDmKeyBundle: vi.fn(), getPendingKeyDeliveries: vi.fn(() => Promise.resolve([])) },
    tabLock: { withProvisionLock: vi.fn(<T,>(fn: () => Promise<T>) => fn()) },
  };
});

vi.mock('../services/mls/mlsIdentity', () => identity);
vi.mock('../services/mls/mlsClient', () => mlsClient);
vi.mock('../services/mls/mlsGroupStore', () => mlsGroupStore);
vi.mock('../services/mls/mlsCoordinator', () => coordinator);
vi.mock('../services/mls/mlsTabLock', () => tabLock);
vi.mock('../services/api', () => ({ apiClient }));
vi.mock('../services/dmEncryption', () => ({ getCurrentUserId: vi.fn(() => 'user-alice') }));

import { provisionMlsDevice, setup } from '../services/dmKeyManager';

const USER_ID = 'user-alice';
const NEW_PASSWORD = 'correct horse battery staple';
const MLS_SIG_PUB = new Uint8Array([10, 11, 12, 13]);
const MLS_SIG_PRIV = new Uint8Array([20, 21, 22, 23, 24, 25]);

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.indexedDB = new IDBFactory();
  // Two-phase: boot mints a leaf-only keypair (no credential, no publish); the
  // cross-sign + publish happens at unlock/setup via buildCrossSignedCredentialIdentity.
  identity.mintLeafKeypair.mockResolvedValue({
    signKey: new Uint8Array(MLS_SIG_PRIV),
    publicKey: new Uint8Array(MLS_SIG_PUB),
  });
  // The v2 cross-signed credential carries the userId; decode extracts it for the
  // currentMlsBundle userId derivation. Test fixtures use `userId:deviceId` bytes.
  identity.buildCrossSignedCredentialIdentity.mockImplementation(
    (userId: string, deviceId: string) => new TextEncoder().encode(`${userId}:${deviceId}`),
  );
  identity.decodeMlsCredentialIdentity.mockImplementation((bytes: Uint8Array) => {
    const [userId, deviceId] = new TextDecoder().decode(bytes).split(':');
    return { version: 2, userId, deviceId, aikPub: new Uint8Array(32), crossSig: new Uint8Array(64) };
  });
  identity.generateKeyPackages.mockResolvedValue([
    { keyPackage: new Uint8Array([1, 2, 3]), keyPackageRef: new Uint8Array([9, 9]), privateKeyPackage: new Uint8Array([4, 5, 6]), isLastResort: false },
    { keyPackage: new Uint8Array([7, 8]), keyPackageRef: new Uint8Array([1, 1]), privateKeyPackage: new Uint8Array([2, 2]), isLastResort: true },
  ]);
  mlsClient.publishKeyPackages.mockResolvedValue({ published: 2, remaining: 21 });
  mlsClient.keyPackageCount.mockResolvedValue({ remaining: 20, hasLastResort: true });
  mlsGroupStore.getOrCreateDeviceWrapKey.mockResolvedValue({} as CryptoKey);
});

describe('provisionMlsDevice — branch on getIdentityMeta', () => {
  it('null meta -> mints a LEAF-ONLY identity and WITHHOLDS publishing (two-phase)', async () => {
    mlsGroupStore.getIdentityMeta.mockResolvedValue(null);
    await provisionMlsDevice();
    // Boot phase 1: leaf-only mint, NO cross-sign, NO publish (the AIK is not
    // available pre-unlock; the cross-sign + publish defers to the first unlock).
    expect(identity.mintLeafKeypair).toHaveBeenCalledTimes(1);
    expect(identity.buildCrossSignedCredentialIdentity).not.toHaveBeenCalled();
    expect(mlsClient.publishKeyPackages).not.toHaveBeenCalled();
    expect(tabLock.withProvisionLock).toHaveBeenCalledTimes(1);
  });

  it('wrapVersion 1 (legacy row, atRestKey null) -> DEFERS: NO mint (per-device collision guard)', async () => {
    mlsGroupStore.getIdentityMeta.mockResolvedValue({ exists: true, wrapVersion: 1 });
    mlsGroupStore.getAtRestKey.mockReturnValue(null);
    await provisionMlsDevice();
    expect(identity.mintLeafKeypair).not.toHaveBeenCalled();
    expect(mlsClient.publishKeyPackages).not.toHaveBeenCalled();
  });

  it('wrapVersion 2 -> loads identity, does NOT mint a fresh one', async () => {
    mlsGroupStore.getIdentityMeta.mockResolvedValue({ exists: true, wrapVersion: 2 });
    mlsGroupStore.getIdentity.mockResolvedValue({
      userId: USER_ID, deviceId: 'dev-1',
      signaturePublicKey: new Uint8Array(MLS_SIG_PUB),
      signaturePrivateKey: new Uint8Array(MLS_SIG_PRIV),
      credentialIdentity: new TextEncoder().encode(`${USER_ID}:dev-1`),
    });
    await provisionMlsDevice();
    expect(identity.mintLeafKeypair).not.toHaveBeenCalled();
  });

  it('no resolvable userId -> no-op (does not throw, does not mint)', async () => {
    const enc = await import('../services/dmEncryption');
    (enc.getCurrentUserId as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    mlsGroupStore.getIdentityMeta.mockResolvedValue(null);
    await provisionMlsDevice();
    expect(mlsGroupStore.getIdentityMeta).not.toHaveBeenCalled();
    expect(identity.mintLeafKeypair).not.toHaveBeenCalled();
  });
});

describe('provisionMlsDevice — wrapVersion 2 top-up + last-resort rotation', () => {
  beforeEach(() => {
    mlsGroupStore.getIdentityMeta.mockResolvedValue({ exists: true, wrapVersion: 2 });
    mlsGroupStore.getIdentity.mockResolvedValue({
      userId: USER_ID, deviceId: 'dev-1',
      signaturePublicKey: new Uint8Array(MLS_SIG_PUB),
      signaturePrivateKey: new Uint8Array(MLS_SIG_PRIV),
      credentialIdentity: new TextEncoder().encode(`${USER_ID}:dev-1`),
    });
  });

  it('rotates the last-resort EVERY run: deletes the prior local last-resort and publishes a fresh one', async () => {
    mlsGroupStore.getAllKeyPackageCandidates.mockResolvedValue([
      { keyPackageRef: 'OLD-LR-REF', keyPackage: new Uint8Array([1]), privateKeyPackage: new Uint8Array([2]), isLastResort: true },
      { keyPackageRef: 'su-1', keyPackage: new Uint8Array([3]), privateKeyPackage: new Uint8Array([4]), isLastResort: false },
    ]);
    mlsClient.keyPackageCount.mockResolvedValue({ remaining: 20, hasLastResort: true });
    identity.generateKeyPackages.mockResolvedValue([
      { keyPackage: new Uint8Array([7]), keyPackageRef: new Uint8Array([42]), privateKeyPackage: new Uint8Array([8]), isLastResort: true },
    ]);

    await provisionMlsDevice();

    expect(identity.generateKeyPackages).toHaveBeenCalledWith(expect.anything(), 0, true);
    expect(mlsClient.publishKeyPackages).toHaveBeenCalledTimes(1);
    const publishedRefIsLastResort = mlsClient.publishKeyPackages.mock.calls[0][1].every((k: { isLastResort: boolean }) => k.isLastResort);
    expect(publishedRefIsLastResort).toBe(true);
    expect(mlsGroupStore.deleteKpPrivate).toHaveBeenCalledWith('OLD-LR-REF');
    expect(mlsGroupStore.deleteKpPrivate).not.toHaveBeenCalledWith('su-1');
  });

  it('two runs produce two DIFFERENT last-resort refs', async () => {
    mlsGroupStore.getAllKeyPackageCandidates.mockResolvedValue([]);
    mlsClient.keyPackageCount.mockResolvedValue({ remaining: 20, hasLastResort: true });
    const refs: string[] = [];
    identity.generateKeyPackages.mockImplementation(async () => {
      const ref = `lr-${refs.length}`;
      refs.push(ref);
      return [{ keyPackage: new Uint8Array([0]), keyPackageRef: new TextEncoder().encode(ref), privateKeyPackage: new Uint8Array([0]), isLastResort: true }];
    });
    await provisionMlsDevice();
    await provisionMlsDevice();
    const published = mlsClient.publishKeyPackages.mock.calls.map((c) => c[1][0].keyPackage);
    expect(published.length).toBe(2);
    expect(refs[0]).not.toBe(refs[1]);
  });

  it('tops up single-use packages when below low-water (in ADDITION to rotating last-resort)', async () => {
    mlsGroupStore.getAllKeyPackageCandidates.mockResolvedValue([]);
    mlsClient.keyPackageCount.mockResolvedValue({ remaining: 2, hasLastResort: true }); // below LOW_WATER=5
    identity.generateKeyPackages
      .mockResolvedValueOnce([{ keyPackage: new Uint8Array([5]), keyPackageRef: new Uint8Array([5]), privateKeyPackage: new Uint8Array([5]), isLastResort: false }])
      .mockResolvedValueOnce([{ keyPackage: new Uint8Array([6]), keyPackageRef: new Uint8Array([6]), privateKeyPackage: new Uint8Array([6]), isLastResort: true }]);
    await provisionMlsDevice();
    expect(identity.generateKeyPackages).toHaveBeenNthCalledWith(1, expect.anything(), 20, false);
    expect(identity.generateKeyPackages).toHaveBeenNthCalledWith(2, expect.anything(), 0, true);
    expect(mlsClient.publishKeyPackages).toHaveBeenCalledTimes(2);
  });

  it('does NOT top up single-use when at/above low-water, but STILL rotates last-resort', async () => {
    mlsGroupStore.getAllKeyPackageCandidates.mockResolvedValue([]);
    mlsClient.keyPackageCount.mockResolvedValue({ remaining: 20, hasLastResort: true });
    identity.generateKeyPackages.mockResolvedValue([
      { keyPackage: new Uint8Array([9]), keyPackageRef: new Uint8Array([9]), privateKeyPackage: new Uint8Array([9]), isLastResort: true },
    ]);
    await provisionMlsDevice();
    expect(identity.generateKeyPackages).toHaveBeenCalledTimes(1);
    expect(identity.generateKeyPackages).toHaveBeenCalledWith(expect.anything(), 0, true);
  });
});

// setup() + provisionMlsDevice() under the SHARED withProvisionLock
// provisionMlsDevice already runs under withProvisionLock. setup()'s inline
// mint (and bootstrapMlsIdentity's unlock/recover load-or-mint) must run under the
// SAME 'howl-mls-provision' lock so a setup() racing the boot provisioner mints
// EXACTLY ONE device identity. _setupImpl re-probes via loadOrMintLocalIdentity
// (not an unconditional mint), so a provisioner-minted device identity is REUSED
// rather than duplicated. The race assertion (createIdentity called once) must hold
// REGARDLESS of which racer wins the lock first - in particular the provisioner-first
// ordering.
describe('setup() + provisionMlsDevice serialization under the SHARED withProvisionLock', () => {
  // A real serializer that runs locked bodies in withProvisionLock-call order so
  // the two racers cannot interleave (mirrors navigator.locks exclusivity). Shared
  // `minted` state makes the second body observe the first body's identity row.
  function installSerializer(): void {
    let chain: Promise<unknown> = Promise.resolve();
    tabLock.withProvisionLock.mockImplementation(<T,>(fn: () => Promise<T>) => {
      const run = chain.then(fn, fn);
      chain = run.then(() => undefined, () => undefined);
      return run as Promise<T>;
    });
  }

  function installSharedIdentity(): void {
    // Two-phase: the boot provisioner mints a LEAF-ONLY identity (empty credential,
    // no publish); a racing setup that observes the row loads it (no second mint) and
    // cross-signs + publishes. The shared `minted` flag is keyed on mintLeafKeypair so
    // the second racer reads the leaf-only row instead of re-minting.
    let minted = false;
    mlsGroupStore.getIdentityMeta.mockImplementation(async () =>
      minted ? { exists: true, wrapVersion: 2 as const } : null,
    );
    mlsGroupStore.getIdentity.mockImplementation(async () =>
      minted
        ? {
            userId: USER_ID,
            deviceId: 'dev-1',
            signaturePublicKey: new Uint8Array(MLS_SIG_PUB),
            signaturePrivateKey: new Uint8Array(MLS_SIG_PRIV),
            // Leaf-only: empty credential until the first unlock/setup cross-signs.
            credentialIdentity: new Uint8Array(0),
          }
        : null,
    );
    identity.mintLeafKeypair.mockImplementation(async () => {
      minted = true;
      return { signKey: new Uint8Array(MLS_SIG_PRIV), publicKey: new Uint8Array(MLS_SIG_PUB) };
    });
    mlsGroupStore.getAllKeyPackageCandidates.mockResolvedValue([]);
    mlsClient.keyPackageCount.mockResolvedValue({ remaining: 20, hasLastResort: true });
  }

  beforeEach(() => {
    apiClient.setupDmKeys.mockResolvedValue({ blobVersion: 1 });
  });

  it('serializes a concurrent setup() vs provisionMlsDevice() so the device mints exactly ONE leaf identity', async () => {
    installSerializer();
    installSharedIdentity();

    await Promise.all([setup(NEW_PASSWORD), provisionMlsDevice()]);

    expect(identity.mintLeafKeypair).toHaveBeenCalledTimes(1);
  });

  it('is order-robust: provisioner-first still mints exactly ONE leaf identity (setup REUSES it)', async () => {
    installSerializer();
    installSharedIdentity();

    // Force the provisioner to acquire the lock FIRST, then race setup() against it.
    // This is the setup-after-provisioner direction: an unconditional setup mint would
    // double-mint here; the loadOrMint re-probe makes setup reuse the provisioner's
    // leaf-only device identity instead.
    await Promise.all([provisionMlsDevice(), setup(NEW_PASSWORD)]);

    expect(identity.mintLeafKeypair).toHaveBeenCalledTimes(1);
  });

  it('setup() REUSES a pre-existing device identity instead of minting a second one', async () => {
    // No serializer needed: the identity row already exists, so the re-probe must
    // load it and skip the mint entirely (proves loadOrMintLocalIdentity reuse).
    mlsGroupStore.getIdentity.mockResolvedValue({
      userId: USER_ID,
      deviceId: 'dev-existing',
      signaturePublicKey: new Uint8Array(MLS_SIG_PUB),
      signaturePrivateKey: new Uint8Array(MLS_SIG_PRIV),
      credentialIdentity: new Uint8Array(0), // leaf-only existing row
    });

    await setup(NEW_PASSWORD);

    expect(identity.mintLeafKeypair).not.toHaveBeenCalled();
  });
});
