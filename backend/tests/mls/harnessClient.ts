// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import {
  generateKeyPackageWithKey,
  defaultCapabilities,
  createGroup,
  createCommit,
  createApplicationMessage,
  encodeMlsMessage,
  decodeMlsMessage,
  processPrivateMessage,
  processPublicMessage,
  createGroupInfoWithExternalPubAndRatchetTree,
  joinGroup,
  joinGroupExternal,
  emptyPskIndex,
  zeroOutUint8Array,
  type CiphersuiteImpl,
  type ClientState,
  type Credential,
  type KeyPackage,
  type PrivateKeyPackage,
  type Lifetime,
  type Proposal,
} from 'ts-mls';
// encode/decodeKeyPackage are NOT barrel-exported.
import { encodeKeyPackage, decodeKeyPackage } from 'ts-mls/keyPackage.js';
import { getImpl } from '../../src/mls/ciphersuite.js';
import { encodeMlsIdentity, decodeMlsIdentity, buildDeviceXsigMessage } from '../../src/mls/credential.js';
import { b64ToBuf, bufToB64, copyBytes } from '../../src/mls/serialization.js';

function realLifetime(): Lifetime {
  return { notBefore: 0n, notAfter: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30) };
}

/**
 * A single MLS device for tests. Holds a ClientState (after group create/join)
 * and a generated key-package pool, using the production credential identity +
 * real lifetimes.
 */
export class HarnessClient {
  private state: ClientState | undefined;
  // The publish-then-join contract: a joiner must call publishKeyPackageB64()
  // and then joinFromWelcome() with NO other key-generating call in between,
  // because every freshKeyPair() call overwrites lastKeyPair (the private half
  // joinGroup needs). A stray createGroup/joinExternal/publishKeyPackageB64
  // between the two would leave joinFromWelcome holding the wrong private key.
  private lastKeyPair: { publicPackage: KeyPackage; privatePackage: PrivateKeyPackage } | undefined;

  private constructor(
    readonly userId: string,
    readonly deviceId: string,
    private readonly impl: CiphersuiteImpl,
    // Account identity key (AIK, Ed25519): cross-signs this device's leaf signing
    // key into the v2 credential. Maps to the account's DmKeyBundle.signingPublicKey.
    private readonly aik: { publicKey: Uint8Array; signKey: Uint8Array },
    // Stable per-device leaf signing keypair. Reused across every KeyPackage so the
    // v2 cross-sig (over this.leaf.publicKey) binds the actual leaf signing key, and
    // distinct init keys still yield distinct refs.
    private readonly leaf: { publicKey: Uint8Array; signKey: Uint8Array },
  ) {}

  static async create(userId: string, deviceId: string): Promise<HarnessClient> {
    const impl = await getImpl();
    const aik = await impl.signature.keygen();
    const leaf = await impl.signature.keygen();
    return new HarnessClient(userId, deviceId, impl, aik, leaf);
  }

  /** The account AIK public key (base64) — route tests set the publisher's DmKeyBundle.signingPublicKey to this. */
  aikPublicKeyB64(): string {
    return bufToB64(this.aik.publicKey);
  }

  /** Build the v2 cross-signed Basic credential (AIK signs the leaf signing key). */
  private async credential(): Promise<Credential> {
    const msg = buildDeviceXsigMessage(this.userId, this.deviceId, this.leaf.publicKey);
    const crossSig = await this.impl.signature.sign(this.aik.signKey, msg);
    return { credentialType: 'basic', identity: encodeMlsIdentity(this.userId, this.deviceId, this.aik.publicKey, crossSig) };
  }

  // Reuses this device's stable leaf signing key (this.leaf) on every call — the
  // v2 credential's AIK cross-sig is over this.leaf.publicKey, so every KeyPackage
  // MUST be signed by that same leaf key. Distinct init/HPKE keys per call still
  // yield distinct refs.
  private async freshKeyPair() {
    const pair = await generateKeyPackageWithKey(
      await this.credential(), defaultCapabilities(), realLifetime(), [], this.leaf, this.impl,
    );
    this.lastKeyPair = pair;
    return pair;
  }

  /** Produce a publishable KeyPackage (base64-encoded MLSMessage-free KeyPackage bytes). */
  async publishKeyPackageB64(): Promise<string> {
    const pair = await this.freshKeyPair();
    return bufToB64(encodeKeyPackage(pair.publicPackage));
  }

  /**
   * Produce a publishable KeyPackage that reuses this device's ONE leaf signing
   * key (this.leaf) while generating fresh init/HPKE keys each time. Repeated calls
   * therefore share a signing key but yield distinct makeKeyPackageRef values —
   * exactly the shape the server's ref-based dedup must distinguish from ts-mls's
   * signature-key-only equality. Does NOT set lastKeyPair (publish-only path).
   */
  async publishKeyPackageWithStableSigningKeyB64(): Promise<string> {
    const pair = await generateKeyPackageWithKey(
      await this.credential(),
      defaultCapabilities(),
      realLifetime(),
      [],
      this.leaf,
      this.impl,
    );
    return bufToB64(encodeKeyPackage(pair.publicPackage));
  }

  /** Found a new group at epoch 0 using the last generated key pair. Returns the 32-byte groupId hex. */
  async createGroup(): Promise<string> {
    const founder = await this.freshKeyPair();
    const groupId = crypto.getRandomValues(new Uint8Array(32));
    this.state = await createGroup(groupId, founder.publicPackage, founder.privatePackage, [], this.impl);
    return Buffer.from(groupId).toString('hex');
  }

  async currentEpoch(): Promise<bigint> {
    if (!this.state) throw new Error('HarnessClient: no group state');
    return this.state.groupContext.epoch;
  }

  /**
   * Add a member by their published KeyPackage. Returns wire bytes (base64) +
   * new epoch. The returned `groupInfoB64` is the post-commit self-contained
   * GroupInfo (ratchet tree embedded) published via publishGroupInfoB64, so a
   * later external joiner can self-join the new epoch without a fresh fetch.
   */
  async commitAdd(memberKeyPackageB64: string, opts?: { wireAsPublicMessage?: boolean }): Promise<{ commitB64: string; welcomeB64: string; groupInfoB64: string; newEpoch: bigint }> {
    if (!this.state) throw new Error('HarnessClient: no group state');
    const decoded = decodeKeyPackageFromB64(memberKeyPackageB64);
    const addProposal: Proposal = { proposalType: 'add', add: { keyPackage: decoded } };
    // ratchetTreeExtension embeds the ratchet tree in the Welcome's GroupInfo so the
    // joiner's joinGroup (called with no explicit ratchetTree) finds it. Without this,
    // ts-mls throws "No RatchetTree passed and no ratchet_tree extension". Mirrors the
    // self-contained-blob model used by createGroupInfoWithExternalPubAndRatchetTree.
    const result = await createCommit({ state: this.state, cipherSuite: this.impl }, { extraProposals: [addProposal], ratchetTreeExtension: true, wireAsPublicMessage: opts?.wireAsPublicMessage ?? false });
    if (!result.welcome) throw new Error('commitAdd: expected a Welcome for an Add commit');
    const commitB64 = bufToB64(encodeMlsMessage(result.commit));
    const welcomeB64 = bufToB64(encodeMlsMessage({ version: 'mls10', wireformat: 'mls_welcome', welcome: result.welcome }));
    this.state = result.newState;
    for (const buf of result.consumed) zeroOutUint8Array(buf);
    const groupInfoB64 = await this.publishGroupInfoB64();
    return { commitB64, welcomeB64, groupInfoB64, newEpoch: this.state.groupContext.epoch };
  }

  /**
   * Add N members in ONE batched commit: decode each published KeyPackage into an
   * Add proposal, feed all N as extraProposals to a single createCommit, and
   * return the ONE resulting Commit + ONE Welcome (ratchetTreeExtension embeds the
   * tree so each joiner's joinGroup finds it). This is the N-ary twin of commitAdd;
   * the conformance test asserts ts-mls accepts N inline Add proposals at once.
   */
  async commitAddMany(memberKeyPackageB64List: string[], opts?: { wireAsPublicMessage?: boolean }): Promise<{ commitB64: string; welcomeB64: string; groupInfoB64: string; newEpoch: bigint }> {
    if (!this.state) throw new Error('HarnessClient: no group state');
    if (memberKeyPackageB64List.length === 0) throw new Error('commitAddMany: no KeyPackages provided');
    const proposals: Proposal[] = memberKeyPackageB64List.map((b64) => {
      const decoded = decodeKeyPackageFromB64(b64);
      return { proposalType: 'add', add: { keyPackage: decoded } };
    });
    const result = await createCommit({ state: this.state, cipherSuite: this.impl }, { extraProposals: proposals, ratchetTreeExtension: true, wireAsPublicMessage: opts?.wireAsPublicMessage ?? false });
    if (!result.welcome) throw new Error('commitAddMany: expected a Welcome for an Add commit');
    const commitB64 = bufToB64(encodeMlsMessage(result.commit));
    const welcomeB64 = bufToB64(encodeMlsMessage({ version: 'mls10', wireformat: 'mls_welcome', welcome: result.welcome }));
    this.state = result.newState;
    for (const buf of result.consumed) zeroOutUint8Array(buf);
    const groupInfoB64 = await this.publishGroupInfoB64();
    return { commitB64, welcomeB64, groupInfoB64, newEpoch: this.state.groupContext.epoch };
  }

  /**
   * Resolve the LEAF index (not the node-array position) of a member by their
   * credential identity bytes in this client's LIVE ratchet tree (full-byte match).
   * A leaf at logical index i sits at node-array position 2*i. THROWS on not-found —
   * never returns -1 (a -1 fed to a Remove proposal hits the documented ts-mls
   * non-terminating level(-1) hazard).
   */
  resolveLeafIndex(credentialIdentity: Uint8Array): number {
    if (!this.state) throw new Error('HarnessClient: no group state');
    const tree = this.state.ratchetTree;
    const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
    for (let nodePos = 0, leaf = 0; nodePos < tree.length; nodePos += 2, leaf += 1) {
      const node = tree[nodePos];
      if (node != null && node.nodeType === 'leaf' && sameBytes(node.leaf.credential.identity, credentialIdentity)) {
        return leaf;
      }
    }
    throw new Error('resolveLeafIndex: member not in ratchet tree');
  }

  /**
   * Resolve a member's LEAF index by DECODING each leaf's v2 credential and matching
   * userId + deviceId. A remover cannot recompute a target's AIK crossSig under v2,
   * so the v1 re-encode-then-byte-match approach is impossible; decode-and-compare
   * the stored bytes instead. THROWS on not-found (the -1 level() hazard guard).
   */
  leafIndexForUser(userId: string, deviceId: string): number {
    if (!this.state) throw new Error('HarnessClient: no group state');
    const tree = this.state.ratchetTree;
    for (let nodePos = 0, leafIndex = 0; nodePos < tree.length; nodePos += 2, leafIndex += 1) {
      const node = tree[nodePos];
      if (node?.nodeType !== 'leaf') continue;
      const cred = node.leaf.credential;
      if (cred.credentialType !== 'basic') continue;
      try {
        const id = decodeMlsIdentity(cred.identity);
        if (id.userId === userId && id.deviceId === deviceId) return leafIndex;
      } catch { /* skip */ }
    }
    throw new Error('leafIndexForUser: member not in ratchet tree');
  }

  /**
   * Remove N members (matched by the decoded v2 userId/deviceId from the v2 169-byte
   * credential struct `{version, userId, deviceId, AIK_pub, crossSig}`) in ONE commit. A
   * Remove commit carries NO Welcome (mirrors the production removeMembers /
   * selfUpdate no-Welcome path). Leaves are resolved on the LIVE tree (the
   * correctness guard against a stale -1 leaf index).
   */
  async commitRemove(targetIdentities: { userId: string; deviceId: string }[], opts?: { wireAsPublicMessage?: boolean }): Promise<{ commitB64: string; groupInfoB64: string; newEpoch: bigint }> {
    if (!this.state) throw new Error('HarnessClient: no group state');
    if (targetIdentities.length === 0) throw new Error('commitRemove: no targets');
    const leafIndices = targetIdentities.map((t) => this.leafIndexForUser(t.userId, t.deviceId));
    const proposals: Proposal[] = leafIndices.map((i) => ({ proposalType: 'remove', remove: { removed: i } }));
    const result = await createCommit({ state: this.state, cipherSuite: this.impl }, { extraProposals: proposals, wireAsPublicMessage: opts?.wireAsPublicMessage ?? false });
    const commitB64 = bufToB64(encodeMlsMessage(result.commit));
    this.state = result.newState;
    for (const buf of result.consumed) zeroOutUint8Array(buf);
    const groupInfoB64 = await this.publishGroupInfoB64();
    return { commitB64, groupInfoB64, newEpoch: this.state.groupContext.epoch };
  }

  /**
   * Empty-proposal self-update commit (path refresh, no membership change, no
   * Welcome). Used as the post-eviction "next commit" a removed member must fail
   * to follow — the genuine forward-secrecy boundary (its leaf no longer overlaps
   * the update path).
   */
  async selfUpdate(): Promise<{ commitB64: string; groupInfoB64: string; newEpoch: bigint }> {
    if (!this.state) throw new Error('HarnessClient: no group state');
    const result = await createCommit({ state: this.state, cipherSuite: this.impl }, {});
    const commitB64 = bufToB64(encodeMlsMessage(result.commit));
    this.state = result.newState;
    for (const buf of result.consumed) zeroOutUint8Array(buf);
    const groupInfoB64 = await this.publishGroupInfoB64();
    return { commitB64, groupInfoB64, newEpoch: this.state.groupContext.epoch };
  }

  /** Join a group from a sealed Welcome (the new-member path). Uses the last key pair. */
  async joinFromWelcome(welcomeB64: string): Promise<void> {
    if (!this.lastKeyPair) throw new Error('joinFromWelcome: call publishKeyPackageB64 first');
    const decoded = decodeMlsMessage(copyBytes(b64ToBuf(welcomeB64)), 0);
    if (!decoded) throw new Error('joinFromWelcome: malformed welcome');
    const [msg] = decoded;
    if (msg.wireformat !== 'mls_welcome') throw new Error(`joinFromWelcome: expected mls_welcome, got ${msg.wireformat}`);
    this.state = await joinGroup(
      msg.welcome,
      this.lastKeyPair.publicPackage,
      this.lastKeyPair.privatePackage,
      emptyPskIndex,
      this.impl,
    );
  }

  /** Publish self-contained GroupInfo (ratchet tree embedded) as base64 wire bytes. */
  async publishGroupInfoB64(): Promise<string> {
    if (!this.state) throw new Error('HarnessClient: no group state');
    const gi = await createGroupInfoWithExternalPubAndRatchetTree(this.state, [], this.impl);
    return bufToB64(encodeMlsMessage({ version: 'mls10', wireformat: 'mls_group_info', groupInfo: gi }));
  }

  /** External-commit self-join off a published GroupInfo. Returns the public-message commit + new epoch. */
  async joinExternal(groupInfoB64: string): Promise<{ externalCommitB64: string; newEpoch: bigint }> {
    const decoded = decodeMlsMessage(copyBytes(b64ToBuf(groupInfoB64)), 0);
    if (!decoded) throw new Error('joinExternal: malformed group info');
    const [msg] = decoded;
    if (msg.wireformat !== 'mls_group_info') throw new Error(`joinExternal: expected mls_group_info, got ${msg.wireformat}`);
    const joiner = await this.freshKeyPair();
    const { publicMessage, newState } = await joinGroupExternal(
      msg.groupInfo,
      joiner.publicPackage,
      joiner.privatePackage,
      false,
      this.impl,
    );
    this.state = newState;
    const externalCommitB64 = bufToB64(encodeMlsMessage({ version: 'mls10', wireformat: 'mls_public_message', publicMessage }));
    return { externalCommitB64, newEpoch: newState.groupContext.epoch };
  }

  /**
   * Craft a MALICIOUS external commit: a real external_init self-join with an
   * inline Remove of an ARBITRARY pre-commit leaf index spliced in. Models a
   * tweaked client — the server does NO crypto validation of external commits
   * (admission.ts: "full crypto membership validation is member-side"), so the
   * re-encoded commit's now-invalid signature/membership tag are irrelevant to
   * the server-side Remove-authz gate, which only decodes + reads the inline
   * proposals. Used to prove the gate rejects an unauthorized external eviction
   * (`removed` = a victim's leaf) while allowing the self-resync carve-out
   * (`removed` = the committer's own leaf). The leaf index is interpreted against
   * the PRE-commit tree, mirroring how routes/mls.ts resolves it against the
   * stored epoch-N GroupInfo.
   */
  async craftExternalCommitRemovingLeaf(groupInfoB64: string, removedLeafIndex: number): Promise<{ externalCommitB64: string; newEpoch: bigint }> {
    const { externalCommitB64, newEpoch } = await this.joinExternal(groupInfoB64);
    const decoded = decodeMlsMessage(copyBytes(b64ToBuf(externalCommitB64)), 0);
    if (!decoded) throw new Error('craftExternalCommitRemovingLeaf: malformed external commit');
    const [msg] = decoded;
    if (msg.wireformat !== 'mls_public_message') throw new Error('craftExternalCommitRemovingLeaf: expected public message');
    const content = msg.publicMessage.content;
    if (content.contentType !== 'commit') throw new Error('craftExternalCommitRemovingLeaf: expected commit');
    content.commit.proposals.push({ proposalOrRefType: 'proposal', proposal: { proposalType: 'remove', remove: { removed: removedLeafIndex } } });
    return { externalCommitB64: bufToB64(encodeMlsMessage(msg)), newEpoch };
  }

  /** Apply an incoming commit (member or external) and advance state. */
  async processCommit(commitB64: string): Promise<void> {
    if (!this.state) throw new Error('HarnessClient: no group state');
    const decoded = decodeMlsMessage(copyBytes(b64ToBuf(commitB64)), 0);
    if (!decoded) throw new Error('processCommit: malformed commit');
    const [msg] = decoded;
    if (msg.wireformat === 'mls_private_message') {
      const r = await processPrivateMessage(this.state, msg.privateMessage, emptyPskIndex, this.impl);
      if (r.kind !== 'newState') throw new Error(`processCommit: expected newState, got ${r.kind}`);
      this.state = r.newState;
      for (const buf of r.consumed) zeroOutUint8Array(buf);
      return;
    }
    if (msg.wireformat === 'mls_public_message') {
      const r = await processPublicMessage(this.state, msg.publicMessage, emptyPskIndex, this.impl);
      this.state = r.newState;
      for (const buf of r.consumed) zeroOutUint8Array(buf);
      return;
    }
    throw new Error(`processCommit: unexpected wireformat ${msg.wireformat}`);
  }

  async encrypt(text: string): Promise<string> {
    if (!this.state) throw new Error('HarnessClient: no group state');
    const enc = await createApplicationMessage(this.state, new TextEncoder().encode(text), this.impl);
    this.state = enc.newState;
    const wire = bufToB64(encodeMlsMessage({ version: 'mls10', wireformat: 'mls_private_message', privateMessage: enc.privateMessage }));
    for (const buf of enc.consumed) zeroOutUint8Array(buf);
    return wire;
  }

  async decrypt(ciphertextB64: string): Promise<string> {
    if (!this.state) throw new Error('HarnessClient: no group state');
    const decoded = decodeMlsMessage(copyBytes(b64ToBuf(ciphertextB64)), 0);
    if (!decoded) throw new Error('decrypt: malformed ciphertext');
    const [msg] = decoded;
    if (msg.wireformat !== 'mls_private_message') throw new Error(`decrypt: expected private message, got ${msg.wireformat}`);
    const r = await processPrivateMessage(this.state, msg.privateMessage, emptyPskIndex, this.impl);
    if (r.kind !== 'applicationMessage') throw new Error(`decrypt: expected applicationMessage, got ${r.kind}`);
    this.state = r.newState;
    const text = new TextDecoder().decode(r.message);
    for (const buf of r.consumed) zeroOutUint8Array(buf);
    return text;
  }
}

// Local helper: decode a base64 raw KeyPackage (not wrapped in an MLSMessage).
// decodeKeyPackage is imported from the 'ts-mls/keyPackage.js' subpath.
function decodeKeyPackageFromB64(b64: string): KeyPackage {
  const decoded = decodeKeyPackage(copyBytes(b64ToBuf(b64)), 0);
  if (!decoded) throw new Error('decodeKeyPackageFromB64: malformed key package');
  return decoded[0];
}
