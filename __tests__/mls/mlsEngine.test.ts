// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// ts-mls's default crypto provider needs WebCrypto; jsdom lacks it, so install
// Node's webcrypto polyfill (mirrors __tests__/dmCrypto.test.ts).
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import {
  generateKeyPackage,
  defaultCapabilities,
  decodeMlsMessage,
  type Credential,
  type Lifetime,
} from 'ts-mls';
import { encodeKeyPackage, makeKeyPackageRef } from 'ts-mls/keyPackage.js';
import { getImpl } from '../../services/mls/ciphersuite';
import { buildCrossSignedCredentialIdentity, decodeMlsCredentialIdentity } from '../../services/mls/mlsIdentity';
import {
  createGroup,
  addMember,
  addMembers,
  removeMembers,
  resolveLeafIndex,
  joinFromWelcome,
  joinExternal,
  selfUpdate,
  processHandshake,
  encryptApp,
  decryptApp,
  setCredentialValidator,
  copyBytes,
  currentEpoch,
  makeGroupInfo,
  ownLeafCredentialIsLegacy,
  type MlsIdentity,
  type KeyPackageCandidate,
} from '../../services/mls/mlsEngine';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

// Restore the default structural validator after any test that overrides it,
// since the engine holds it as module-level state. v2-aware: the basic-credential
// identity must parse as the versioned struct (matches the engine default).
const defaultValidator = (id: Uint8Array): boolean => {
  try {
    decodeMlsCredentialIdentity(id);
    return true;
  } catch {
    return false;
  }
};
afterEach(() => setCredentialValidator(defaultValidator));

const realLifetime = (): Lifetime => ({
  notBefore: 0n,
  notAfter: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30),
});

// Ephemeral test AIK (Ed25519). The cross-sig content is irrelevant to structural
// validation (the default validator only decodes the v2 struct). We cross-sign
// over a stand-in leaf key so the 169-byte struct is well-formed.
const testAik = nacl.sign.keyPair();
function v2Identity(userId: string, deviceId: string): Uint8Array {
  return buildCrossSignedCredentialIdentity(
    userId, deviceId, testAik.publicKey, testAik.publicKey, testAik.secretKey,
  );
}

/** Test-local identity factory (production version is services/mls/mlsIdentity.ts). */
async function makeIdentity(userId: string, deviceId: string): Promise<MlsIdentity> {
  const impl = await getImpl();
  const credential: Credential = {
    credentialType: 'basic',
    identity: v2Identity(userId, deviceId),
  };
  const { publicPackage, privatePackage } = await generateKeyPackage(
    credential,
    defaultCapabilities(),
    realLifetime(),
    [],
    impl,
  );
  return {
    signaturePublicKey: publicPackage.leafNode.signaturePublicKey,
    signaturePrivateKey: privatePackage.signaturePrivateKey,
    credentialIdentity: credential.identity,
  };
}

/** A full join candidate: public KeyPackage bytes, ref, and serialized private triple. */
async function makeCandidate(
  userId: string,
  deviceId: string,
  isLastResort = false,
): Promise<KeyPackageCandidate & { credentialIdentity: Uint8Array }> {
  const impl = await getImpl();
  const credential: Credential = {
    credentialType: 'basic',
    identity: v2Identity(userId, deviceId),
  };
  // Stable copy of the credential identity for leaf resolution: ts-mls may alias
  // credential.identity into the generated KeyPackage and a later addMember can
  // zeroize/mutate the underlying buffer (move-not-borrow), so capture it now.
  const credentialIdentity = new Uint8Array(credential.identity);
  const { publicPackage, privatePackage } = await generateKeyPackage(
    credential,
    defaultCapabilities(),
    realLifetime(),
    [],
    impl,
  );
  const keyPackageBytes = encodeKeyPackage(publicPackage);
  const ref = await makeKeyPackageRef(publicPackage, impl.hash);
  const privateKeyPackage = new TextEncoder().encode(
    JSON.stringify({
      initPrivateKey: Buffer.from(privatePackage.initPrivateKey).toString('base64'),
      hpkePrivateKey: Buffer.from(privatePackage.hpkePrivateKey).toString('base64'),
      signaturePrivateKey: Buffer.from(privatePackage.signaturePrivateKey).toString('base64'),
      keyPackage: Buffer.from(keyPackageBytes).toString('base64'),
    }),
  );
  return {
    keyPackageRef: Buffer.from(ref).toString('base64'),
    keyPackage: new Uint8Array(keyPackageBytes),
    privateKeyPackage,
    isLastResort,
    credentialIdentity,
  };
}

describe('ownLeafCredentialIsLegacy', () => {
  it('returns false for a genuine v2 own leaf, true once the own-leaf credential is a pre-v2 buffer', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    const state = await createGroup(alice, randomUUID());

    // Founder sits at logical leaf 0 (node position 0) with a real v2 credential.
    expect(state.privatePath.leafIndex).toBe(0);
    expect(ownLeafCredentialIsLegacy(state)).toBe(false);

    // Replace ONLY the own-leaf credential identity with a pre-v2 (undecodable)
    // buffer — exercises the real leafIndex*2 mapping + the real strict decode.
    const ownPos = state.privatePath.leafIndex * 2;
    const own = state.ratchetTree[ownPos];
    expect(own?.nodeType).toBe('leaf');
    const legacyState = {
      ...state,
      ratchetTree: state.ratchetTree.map((n, i) =>
        i === ownPos && n != null && n.nodeType === 'leaf'
          ? { ...n, leaf: { ...n.leaf, credential: { credentialType: 'basic' as const, identity: new TextEncoder().encode('legacy-pre-v2-credential') } } }
          : n,
      ),
    };
    expect(ownLeafCredentialIsLegacy(legacyState)).toBe(true);
  });

  it('resolves the correct own leaf at a NON-zero leaf index (a joined device, not the founder)', async () => {
    // The realistic incident shape: a device that JOINED an existing DM sits at a
    // non-zero leaf, so the leafIndex*2 mapping must pick ITS leaf, not the founder's.
    const alice = await makeIdentity(randomUUID(), randomUUID());
    const aliceState = await createGroup(alice, randomUUID());
    const bob = await makeCandidate(randomUUID(), randomUUID());
    const added = await addMember(aliceState, bob.keyPackage);
    const bobState = (await joinFromWelcome(added.welcome, [bob])).state;

    // Bob is the second member -> logical leaf 1 (node position 2).
    expect(bobState.privatePath.leafIndex).toBe(1);
    expect(ownLeafCredentialIsLegacy(bobState)).toBe(false); // Bob's own v2 leaf

    // Mutating ALICE's leaf (node 0) must NOT flip Bob's result — the guard reads
    // Bob's own leaf (node 2), not just any non-v2 leaf in the tree.
    const aliceLeafLegacy = {
      ...bobState,
      ratchetTree: bobState.ratchetTree.map((n, i) =>
        i === 0 && n != null && n.nodeType === 'leaf'
          ? { ...n, leaf: { ...n.leaf, credential: { credentialType: 'basic' as const, identity: new TextEncoder().encode('legacy-pre-v2-credential') } } }
          : n,
      ),
    };
    expect(ownLeafCredentialIsLegacy(aliceLeafLegacy)).toBe(false); // Bob's own leaf is still v2

    // Mutating BOB's own leaf (node 2) flips it.
    const bobLeafLegacy = {
      ...bobState,
      ratchetTree: bobState.ratchetTree.map((n, i) =>
        i === bobState.privatePath.leafIndex * 2 && n != null && n.nodeType === 'leaf'
          ? { ...n, leaf: { ...n.leaf, credential: { credentialType: 'basic' as const, identity: new TextEncoder().encode('legacy-pre-v2-credential') } } }
          : n,
      ),
    };
    expect(ownLeafCredentialIsLegacy(bobLeafLegacy)).toBe(true);
  });

  it('fail-open: returns false when the own leaf is absent from the tree', () => {
    expect(ownLeafCredentialIsLegacy({ privatePath: { leafIndex: 5 }, ratchetTree: [] } as never)).toBe(false);
  });
});

describe('mlsEngine core ops', () => {
  it('two-party create -> add -> join -> encrypt -> decrypt round-trip', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    const groupId = randomUUID();

    // Alice founds the group at epoch 0.
    let aliceState = await createGroup(alice, groupId);
    expect(currentEpoch(aliceState)).toBe(0n);

    // Bob publishes a KeyPackage; Alice adds him.
    const bob = await makeCandidate(randomUUID(), randomUUID());
    const added = await addMember(aliceState, bob.keyPackage);
    aliceState = added.newState;
    expect(currentEpoch(aliceState)).toBe(1n);

    // Bob joins from the Welcome using his stored candidate.
    const join = await joinFromWelcome(added.welcome, [bob]);
    expect(join.consumedKpRef).toBe(bob.keyPackageRef);
    expect(join.isLastResort).toBe(false);
    let bobState = join.state;
    expect(currentEpoch(bobState)).toBe(1n);

    // Alice encrypts; Bob decrypts.
    const enc = await encryptApp(aliceState, new TextEncoder().encode('hello bob'));
    aliceState = enc.newState;
    const dec = await decryptApp(bobState, enc.privateMessage);
    bobState = dec.newState;
    expect(new TextDecoder().decode(dec.plaintext)).toBe('hello bob');

    // And the reverse direction.
    const enc2 = await encryptApp(bobState, new TextEncoder().encode('hi alice'));
    const dec2 = await decryptApp(aliceState, enc2.privateMessage);
    expect(new TextDecoder().decode(dec2.plaintext)).toBe('hi alice');
  });

  it('addMembers (batched) is the primitive addMember wraps; one commit + one welcome', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    const aliceState = await createGroup(alice, randomUUID());
    const bob = await makeCandidate(randomUUID(), randomUUID());
    const added = await addMembers(aliceState, [bob.keyPackage]);
    expect(added.commit.length).toBeGreaterThan(0);
    expect(added.welcome.length).toBeGreaterThan(0);
    expect(currentEpoch(added.newState)).toBe(1n);
    // The single-member Welcome admits Bob.
    const join = await joinFromWelcome(added.welcome, [bob]);
    expect(currentEpoch(join.state)).toBe(1n);
  });

  it('joinFromWelcome reports the matched candidate among several', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    const aliceState = await createGroup(alice, randomUUID());
    const bob = await makeCandidate(randomUUID(), randomUUID());
    const added = await addMember(aliceState, bob.keyPackage);
    // A decoy candidate that does not match the Welcome (Alice should skip it).
    const decoy = await makeCandidate(randomUUID(), randomUUID());
    const join = await joinFromWelcome(added.welcome, [decoy, bob]);
    expect(join.consumedKpRef).toBe(bob.keyPackageRef);
    expect(currentEpoch(join.state)).toBe(1n);
  });

  it('processHandshake applies a selfUpdate commit', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    let aliceState = await createGroup(alice, randomUUID());

    const bob = await makeCandidate(randomUUID(), randomUUID());
    const added = await addMember(aliceState, bob.keyPackage);
    aliceState = added.newState;
    let bobState = (await joinFromWelcome(added.welcome, [bob])).state;
    expect(currentEpoch(aliceState)).toBe(1n);
    expect(currentEpoch(bobState)).toBe(1n);

    // Bob heals via selfUpdate (epoch 1 -> 2); Alice processes the commit.
    const upd = await selfUpdate(bobState);
    bobState = upd.newState;
    expect(currentEpoch(bobState)).toBe(2n);

    aliceState = await processHandshake(aliceState, upd.commit);
    expect(currentEpoch(aliceState)).toBe(2n);

    // Messages still flow after the heal.
    const enc = await encryptApp(aliceState, new TextEncoder().encode('post-heal'));
    const dec = await decryptApp(bobState, enc.privateMessage);
    expect(new TextDecoder().decode(dec.plaintext)).toBe('post-heal');
  });

  it('removeMembers evicts a member: 3-party group, Charlie removed, others converge', async () => {
    // Alice founds at epoch 0, adds Bob (epoch 1), adds Charlie (epoch 2).
    const alice = await makeIdentity(randomUUID(), randomUUID());
    let aliceState = await createGroup(alice, randomUUID());
    const bob = await makeCandidate(randomUUID(), randomUUID());
    const addedBob = await addMember(aliceState, bob.keyPackage);
    aliceState = addedBob.newState;
    let bobState = (await joinFromWelcome(addedBob.welcome, [bob])).state;
    const charlie = await makeCandidate(randomUUID(), randomUUID());
    const addedCharlie = await addMember(aliceState, charlie.keyPackage);
    aliceState = addedCharlie.newState;
    const charlieState = (await joinFromWelcome(addedCharlie.welcome, [charlie])).state;
    bobState = await processHandshake(bobState, addedCharlie.commit);
    expect(currentEpoch(aliceState)).toBe(2n);
    expect(currentEpoch(bobState)).toBe(2n);
    expect(currentEpoch(charlieState)).toBe(2n);

    // Alice removes Charlie's leaf (resolved by his credential identity).
    const charlieLeaf = resolveLeafIndex(aliceState, charlie.credentialIdentity);
    const removeResult = await removeMembers(aliceState, [charlieLeaf]);
    aliceState = removeResult.newState;
    // A Remove seals nothing: no Welcome on the result.
    expect('welcome' in removeResult).toBe(false);
    expect(currentEpoch(aliceState)).toBe(3n);

    // Bob converges on the Remove commit; Charlie is gone.
    bobState = await processHandshake(bobState, removeResult.commit);
    expect(currentEpoch(bobState)).toBe(3n);

    // Alice <-> Bob still message on the new epoch.
    const enc = await encryptApp(aliceState, new TextEncoder().encode('post-evict'));
    const dec = await decryptApp(bobState, enc.privateMessage);
    expect(new TextDecoder().decode(dec.plaintext)).toBe('post-evict');

    // Evicted Charlie (stuck at epoch 2) cannot decrypt the epoch-3 message.
    await expect(decryptApp(charlieState, enc.privateMessage)).rejects.toThrow();
  }, 20000);

  it('removeMembers emits a PublicMessage commit when wireAsPublicMessage=true', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    let aliceState = await createGroup(alice, randomUUID());
    const bob = await makeCandidate(randomUUID(), randomUUID());
    const added = await addMember(aliceState, bob.keyPackage);
    aliceState = added.newState;
    const bobLeaf = resolveLeafIndex(aliceState, bob.credentialIdentity);

    const { commit } = await removeMembers(aliceState, [bobLeaf], true);
    const decoded = decodeMlsMessage(commit, 0);
    expect(decoded![0].wireformat).toBe('mls_public_message');
  });

  it('resolveLeafIndex returns the correct LEAF index for a present member', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    let aliceState = await createGroup(alice, randomUUID());
    expect(resolveLeafIndex(aliceState, alice.credentialIdentity)).toBe(0);
    const bob = await makeCandidate(randomUUID(), randomUUID());
    aliceState = (await addMember(aliceState, bob.keyPackage)).newState;
    expect(resolveLeafIndex(aliceState, bob.credentialIdentity)).toBe(1);
    const charlie = await makeCandidate(randomUUID(), randomUUID());
    aliceState = (await addMember(aliceState, charlie.keyPackage)).newState;
    expect(resolveLeafIndex(aliceState, charlie.credentialIdentity)).toBe(2);
  });

  it('resolveLeafIndex THROWS (no infinite-loop) for an absent member', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    const aliceState = await createGroup(alice, randomUUID());
    const stranger = new TextEncoder().encode(`${randomUUID()}:${randomUUID()}`);
    expect(() => resolveLeafIndex(aliceState, stranger)).toThrow('resolveLeafIndex: member not in ratchet tree');
    await expect(
      (async () => {
        const leaf = resolveLeafIndex(aliceState, stranger); // throws here
        return removeMembers(aliceState, [leaf]);
      })(),
    ).rejects.toThrow('resolveLeafIndex: member not in ratchet tree');
  }, 20000);

  it('setCredentialValidator gates membership changes (rejecting validator blocks add)', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    const aliceState = await createGroup(alice, randomUUID());
    const bob = await makeCandidate(randomUUID(), randomUUID());
    setCredentialValidator(() => false);
    // ts-mls validates the added leaf's credential via clientConfig.authService.
    await expect(addMember(aliceState, bob.keyPackage)).rejects.toThrow();
  });

  it('aliasing discipline: the same ciphertext bytes decode twice without corruption', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    let aliceState = await createGroup(alice, randomUUID());
    const bob = await makeCandidate(randomUUID(), randomUUID());
    const added = await addMember(aliceState, bob.keyPackage);
    aliceState = added.newState;
    const bobState = (await joinFromWelcome(added.welcome, [bob])).state;

    const enc = await encryptApp(aliceState, new TextEncoder().encode('aliasing-check'));
    // Snapshot the wire bytes a caller would hold; assert they survive decrypt unchanged.
    const wire = enc.privateMessage;
    const before = Array.from(wire);
    const dec = await decryptApp(bobState, wire);
    expect(new TextDecoder().decode(dec.plaintext)).toBe('aliasing-check');
    expect(Array.from(wire)).toEqual(before);
  });

  it('copyBytes returns an independent copy', () => {
    const src = new Uint8Array([1, 2, 3]);
    const dup = copyBytes(src);
    expect(Array.from(dup)).toEqual([1, 2, 3]);
    dup[0] = 99;
    expect(src[0]).toBe(1);
  });
});

describe('mlsEngine.joinExternal', () => {
  // Build a real epoch-1 two-member group; return Alice's identity + state + Bob's state.
  async function epoch1Group() {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    let aliceState = await createGroup(alice, randomUUID());
    const bob = await makeCandidate(randomUUID(), randomUUID());
    const added = await addMember(aliceState, bob.keyPackage);
    aliceState = added.newState;
    const bobState = (await joinFromWelcome(added.welcome, [bob])).state;
    expect(currentEpoch(aliceState)).toBe(1n);
    return { alice, aliceState, bobState };
  }

  it('present leaf: an existing member re-joins via External Commit (resync), members converge', async () => {
    const { alice, aliceState, bobState } = await epoch1Group();
    const gi = await makeGroupInfo(aliceState);

    // Alice's leaf IS in the tree (same signing key) -> data-driven resync = true.
    const ext = await joinExternal(gi, alice);
    expect(currentEpoch(ext.newState)).toBe(2n); // groupInfoEpoch(1) + 1

    // The other member applies the public External Commit and converges.
    const bobAfter = await processHandshake(bobState, ext.commit);
    expect(currentEpoch(bobAfter)).toBe(2n);

    // Messaging works on the new epoch (re-joined Alice <-> Bob).
    const enc = await encryptApp(ext.newState, new TextEncoder().encode('rejoined'));
    const dec = await decryptApp(bobAfter, enc.privateMessage);
    expect(new TextDecoder().decode(dec.plaintext)).toBe('rejoined');
  }, 20000);

  it('absent leaf: a non-member External-Commits (clean add) WITHOUT hanging', async () => {
    const { aliceState, bobState } = await epoch1Group();
    const gi = await makeGroupInfo(aliceState);
    const charlie = await makeIdentity(randomUUID(), randomUUID());

    // Charlie has NO leaf -> data-driven resync = false -> a clean add, no -0.5 hang.
    // (If resync were hardcoded true, ts-mls would loop forever and this test would
    // time out = RED. The 20s timeout is the regression guard.)
    const ext = await joinExternal(gi, charlie);
    expect(currentEpoch(ext.newState)).toBe(2n);

    // Existing members apply the commit and reach the same epoch.
    const aliceAfter = await processHandshake(aliceState, ext.commit);
    const bobAfter = await processHandshake(bobState, ext.commit);
    expect(currentEpoch(aliceAfter)).toBe(2n);
    expect(currentEpoch(bobAfter)).toBe(2n);

    // Charlie can now message a member.
    const enc = await encryptApp(ext.newState, new TextEncoder().encode('hi from charlie'));
    const dec = await decryptApp(aliceAfter, enc.privateMessage);
    expect(new TextDecoder().decode(dec.plaintext)).toBe('hi from charlie');
  }, 20000);

  it('rejects a non-group_info wire message', async () => {
    const id = await makeIdentity(randomUUID(), randomUUID());
    const state = await createGroup(id, randomUUID());
    // An application message is mls_private_message, not mls_group_info.
    const enc = await encryptApp(state, new TextEncoder().encode('x'));
    await expect(joinExternal(enc.privateMessage, id)).rejects.toThrow(/expected mls_group_info/);
  });
});

describe('application-layer PADME length bucketing (real two-party round-trip)', () => {
  it('hides length within a Padmé bucket and round-trips >256 B exactly', async () => {
    const alice = await makeIdentity(randomUUID(), randomUUID());
    let aliceState = await createGroup(alice, randomUUID());
    const bob = await makeCandidate(randomUUID(), randomUUID());
    const added = await addMember(aliceState, bob.keyPackage);
    aliceState = added.newState;
    const join = await joinFromWelcome(added.welcome, [bob]);
    let bobState = join.state;

    // Two plaintexts of DIFFERENT length, both >256 B, in the SAME Padmé bucket
    // (framed 305 and 320 both round up to a 320-byte bucket).
    const m1 = new TextEncoder().encode('a'.repeat(300));
    const m2 = new TextEncoder().encode('b'.repeat(315));

    const e1 = await encryptApp(aliceState, m1);
    aliceState = e1.newState;
    const e2 = await encryptApp(aliceState, m2);

    // Leak reduction: equal ciphertext length despite different plaintext length.
    expect(e2.privateMessage.length).toBe(e1.privateMessage.length);

    // Both decrypt to the exact original, in order.
    const d1 = await decryptApp(bobState, e1.privateMessage);
    bobState = d1.newState;
    const d2 = await decryptApp(bobState, e2.privateMessage);
    expect(new TextDecoder().decode(d1.plaintext)).toBe('a'.repeat(300));
    expect(new TextDecoder().decode(d2.plaintext)).toBe('b'.repeat(315));
  });
});
