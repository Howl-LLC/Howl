// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import {
  createGroup as tsCreateGroup,
  createCommit,
  createApplicationMessage,
  encodeMlsMessage,
  decodeMlsMessage,
  processPrivateMessage,
  processPublicMessage,
  joinGroup,
  joinGroupExternal,
  emptyPskIndex,
  zeroOutUint8Array,
  generateKeyPackageWithKey,
  defaultLifetimeConfig,
  defaultKeyPackageEqualityConfig,
  defaultPaddingConfig,
  encodeGroupState,
  decodeGroupState,
  createGroupInfoWithExternalPubAndRatchetTree,
  mlsExporter,
  type ClientConfig,
  type KeyRetentionConfig,
  type Credential,
  type PrivateKeyPackage,
  type Lifetime,
  type Proposal,
} from 'ts-mls';
import { decodeKeyPackage } from 'ts-mls/keyPackage.js';
import { ratchetTreeFromExtension } from 'ts-mls/groupInfo.js';
import { getImpl, supportedCapabilities } from './ciphersuite';
import { decodeMlsCredentialIdentity } from './mlsIdentity';
import type { MlsClientState, MlsGroupId } from './types';
import type { MlsTier } from './roomKey';

/** A stable MLS identity: a signing keypair plus the basic-credential identity bytes. */
export interface MlsIdentity {
  signaturePublicKey: Uint8Array;
  signaturePrivateKey: Uint8Array;
  /** The v2 169-byte credential struct `{version=0x02, userId(36), deviceId(36), AIK_pub(32), crossSig(64)}` (matches backend/src/mls/credential.ts). */
  credentialIdentity: Uint8Array;
}

export interface GeneratedKeyPackage {
  keyPackage: Uint8Array;
  keyPackageRef: Uint8Array;
  privateKeyPackage: Uint8Array;
  isLastResort: boolean;
}

export interface AddMemberResult {
  newState: MlsClientState;
  commit: Uint8Array;
  welcome: Uint8Array;
}
export interface CommitResult {
  newState: MlsClientState;
  commit: Uint8Array;
}
export interface EncryptResult {
  newState: MlsClientState;
  privateMessage: Uint8Array;
}
export interface DecryptResult {
  newState: MlsClientState;
  plaintext: Uint8Array;
}

/** A stored KeyPackage the joiner can try against an incoming Welcome. */
export interface KeyPackageCandidate {
  keyPackageRef: string;
  /** Public KeyPackage wire bytes (non-secret). */
  keyPackage: Uint8Array;
  /** Serialized private material (JSON triple, see mlsIdentity). */
  privateKeyPackage: Uint8Array;
  isLastResort: boolean;
}

/** joinFromWelcome reports WHICH candidate matched, so the caller deletes that init key + heals last-resort. */
export interface JoinResult {
  state: MlsClientState;
  consumedKpRef: string;
  isLastResort: boolean;
}

/**
 * Fresh copy of `src`. ts-mls decoders alias views into their input and the
 * consumed-buffer zeroization can write back into it; feed a copy to every
 * decode whose source bytes are read again (move-not-borrow).
 */
export function copyBytes(src: Uint8Array): Uint8Array {
  return new Uint8Array(src);
}

/** True iff a leaf carrying `sigPub` is present in the ratchet tree (matches ts-mls's own signature-key leaf identity). */
function leafSignatureMatches(
  tree: ReturnType<typeof ratchetTreeFromExtension>,
  sigPub: Uint8Array,
): boolean {
  if (!tree) return false;
  return tree.some(
    (n) =>
      n != null &&
      n.nodeType === 'leaf' &&
      n.leaf.signaturePublicKey.length === sigPub.length &&
      n.leaf.signaturePublicKey.every((b, i) => b === sigPub[i]),
  );
}

/**
 * Resolve the LEAF index of a member by their credential identity (the v2 169-byte
 * credential struct `{version, userId, deviceId, AIK_pub, crossSig}`)
 * in the LIVE ClientState ratchet tree. A leaf at logical index `i` sits at node-array
 * position `2*i`; iterate node positions stepping by 2 and track the leaf ordinal.
 * Matches on the basic-credential identity bytes.
 *
 * THROWS if not found: a -1 index passed to removeMembers hits the documented ts-mls
 * infinite-loop hazard (findIndex -> -1 -> level(-1) never terminates), so a missing
 * target must fail closed BEFORE any value reaches removeMembers.
 */
export function resolveLeafIndex(state: MlsClientState, credentialIdentity: Uint8Array): number {
  const tree = state.ratchetTree;
  const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  for (let nodePos = 0, leafIndex = 0; nodePos < tree.length; nodePos += 2, leafIndex += 1) {
    const node = tree[nodePos];
    if (node == null || node.nodeType !== 'leaf') continue;
    const cred = node.leaf.credential;
    if (cred.credentialType === 'basic' && sameBytes(cred.identity, credentialIdentity)) {
      return leafIndex;
    }
  }
  throw new Error('resolveLeafIndex: member not in ratchet tree');
}

/**
 * True iff THIS device's own leaf credential in `state` is present and does NOT
 * decode as a v2 credential (a pre-v2 legacy leaf). A self-Update REUSES the
 * existing leaf credential (ts-mls createUpdatePath copies it; only the HPKE key
 * rotates), so a self-Update can never rotate a legacy leaf to v2 — and a commit
 * carrying it would fail v2 credential validation on every peer
 * (validateLeafNodeUpdateOrCommit), desyncing the group. The coordinator uses this
 * to SKIP self-Updating such a group until the leaf is replaced via a fresh v2
 * KeyPackage (re-join). Indeterminate (no own leaf in the tree / non-basic
 * credential) returns false — fail-open, so a normal v2 self-Update still proceeds.
 *
 * A leaf at logical index `i` sits at ratchet-tree node position `2*i` (see
 * resolveLeafIndex); the device's own logical leaf index is state.privatePath.leafIndex.
 */
export function ownLeafCredentialIsLegacy(state: MlsClientState): boolean {
  const leafIndex = state.privatePath?.leafIndex;
  if (leafIndex == null) return false;
  const node = state.ratchetTree[leafIndex * 2];
  if (node == null || node.nodeType !== 'leaf') return false;
  const cred = node.leaf.credential;
  if (cred.credentialType !== 'basic') return false;
  try {
    decodeMlsCredentialIdentity(cred.identity);
    return false;
  } catch {
    return true;
  }
}

function realLifetime(): Lifetime {
  return { notBefore: 0n, notAfter: BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30) };
}

// Credential validation seam
// The default is a STRUCTURAL check that the basic-credential identity parses as
// the versioned v2 struct (version 0x02 | userId | deviceId | AIK_pub | crossSig).
// The cryptographic cross-sig ENFORCEMENT is the backend AS's job; the real
// per-device authorization is installed here via setCredentialValidator.
// Wired into ts-mls at every boundary through the clientConfig.authService passed
// to createGroup/joinGroup and reattached by decodeState, so processHandshake
// (which reads state.clientConfig.authService) uses it too.

function defaultStructuralValidator(credentialIdentity: Uint8Array): boolean {
  try {
    decodeMlsCredentialIdentity(credentialIdentity); // throws on bad version/length/UUID
    return true;
  } catch {
    return false;
  }
}

/**
 * Validator seam: receives BOTH the basic-credential identity and
 * the leaf's signing public key (forwarded from ts-mls's authService), so the real
 * validator can verify the AIK cross-sig over that leaf key. May be sync or async.
 * `defaultStructuralValidator` keeps its single-arg shape but stays assignable
 * (the extra param is ignored).
 */
export type CredentialValidatorFn = (
  credentialIdentity: Uint8Array,
  leafSigningPublicKey: Uint8Array,
) => boolean | Promise<boolean>;

let credentialValidator: CredentialValidatorFn = defaultStructuralValidator;

/**
 * Override the credential validator used inside joinFromWelcome / processHandshake.
 * The default is structural; the coordinator's activate() installs the real
 * per-device authorization (cross-sig verify + TOFU-pinned-AIK).
 */
export function setCredentialValidator(fn: CredentialValidatorFn): void {
  credentialValidator = fn;
}

/**
 * Explicit, audited key-retention bound for Saved DMs.
 *
 * Same numeric values ts-mls ships as `defaultKeyRetentionConfig`, pinned here so
 * the bound is a reviewed decision rather than a silently-inherited default:
 *  - retainKeysForGenerations: 10 — out-of-order delivery window WITHIN an epoch.
 *    Tightening risks permanently dropping out-of-order messages that re-decrypt
 *    cannot recover (the keys would already be gone). KEEP.
 *  - retainKeysForEpochs: 4 — past epochs whose receiver secrets are retained for
 *    live catch-up after a membership change. The durable plaintext archive owns
 *    long-term history, so this only covers live catch-up; 4 is firmly bounded and
 *    a strictly smaller exposure than the archive itself for Saved.
 *  - maximumForwardRatchetSteps: 200 — cap on a single forward ratchet jump. KEEP.
 *
 * This is the single per-chat-type seam: when OTR ships it passes a tighter config
 * here (no archive => minimise retained secrets). Reattached on every decodeState()
 * via buildClientConfig(), so already-persisted states adopt it on next load with
 * no migration.
 */
const HOWL_KEY_RETENTION_CONFIG: KeyRetentionConfig = {
  retainKeysForGenerations: 10,
  retainKeysForEpochs: 4,
  maximumForwardRatchetSteps: 200,
};

// OTR has no durable archive, so retain fewer past-epoch secrets than Saved.
// retainKeysForGenerations stays at 10 so brief-offline catch-up within an epoch
// still decrypts queued envelopes; only retainKeysForEpochs tightens (1:1
// forward-only => little membership churn).
const HOWL_OTR_KEY_RETENTION_CONFIG: KeyRetentionConfig = {
  retainKeysForGenerations: 10,
  retainKeysForEpochs: 2,
  maximumForwardRatchetSteps: 200,
};

/**
 * Build the ClientConfig from the five exported defaults plus our authService
 * seam. The authService closes over the live `credentialValidator` module
 * binding, so a later setCredentialValidator takes effect on existing states.
 * `tier` selects the key-retention profile: OTR keeps fewer past-epoch secrets
 * (no durable archive); Saved (the default) keeps the wider bound.
 */
function buildClientConfig(tier: MlsTier = 'saved'): ClientConfig {
  return {
    keyRetentionConfig: tier === 'otr' ? HOWL_OTR_KEY_RETENTION_CONFIG : HOWL_KEY_RETENTION_CONFIG,
    lifetimeConfig: defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    authService: {
      validateCredential: async (credential: Credential, signaturePublicKey: Uint8Array): Promise<boolean> =>
        credential.credentialType === 'basic'
          ? await credentialValidator(credential.identity, signaturePublicKey)
          : false,
    },
  };
}

/** The on-disk private-key-package shape produced by mlsIdentity. */
interface SerializedPrivateKeyPackage {
  initPrivateKey: string;
  hpkePrivateKey: string;
  signaturePrivateKey: string;
  keyPackage: string;
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Deserialize the three private keys from the JSON-triple shape mlsIdentity produces. */
function deserializePrivateKeys(serialized: Uint8Array): PrivateKeyPackage | null {
  let parsed: SerializedPrivateKeyPackage;
  try {
    parsed = JSON.parse(new TextDecoder().decode(serialized));
  } catch {
    return null;
  }
  if (
    typeof parsed.initPrivateKey !== 'string' ||
    typeof parsed.hpkePrivateKey !== 'string' ||
    typeof parsed.signaturePrivateKey !== 'string'
  ) {
    return null;
  }
  return {
    initPrivateKey: b64ToBytes(parsed.initPrivateKey),
    hpkePrivateKey: b64ToBytes(parsed.hpkePrivateKey),
    signaturePrivateKey: b64ToBytes(parsed.signaturePrivateKey),
  };
}

/** Found a new 1:1 group at epoch 0, self only. */
export async function createGroup(identity: MlsIdentity, groupId: MlsGroupId, tier: MlsTier = 'saved'): Promise<MlsClientState> {
  const impl = await getImpl();
  const credential: Credential = { credentialType: 'basic', identity: identity.credentialIdentity };
  // Mint the founder's own leaf KeyPackage from the stable signing key.
  const { publicPackage, privatePackage } = await generateKeyPackageWithKey(
    credential,
    supportedCapabilities(),
    realLifetime(),
    [],
    { signKey: identity.signaturePrivateKey, publicKey: identity.signaturePublicKey },
    impl,
  );
  const groupIdBytes = new TextEncoder().encode(groupId);
  return tsCreateGroup(groupIdBytes, publicPackage, privatePackage, [], impl, buildClientConfig(tier));
}

/**
 * Canonical membership primitive: batch N Add proposals into ONE Commit + ONE
 * Welcome, with `ratchetTreeExtension: true` so each joiner's Welcome carries the
 * tree. Callable with a single-element array or N members.
 */
export async function addMembers(
  state: MlsClientState,
  recipientKeyPackageBytesList: Uint8Array[],
  wireAsPublicMessage = false,
): Promise<AddMemberResult> {
  if (recipientKeyPackageBytesList.length === 0) {
    throw new Error('addMembers: no recipient KeyPackages provided');
  }
  const impl = await getImpl();
  const proposals: Proposal[] = recipientKeyPackageBytesList.map((bytes) => {
    const decoded = decodeKeyPackage(copyBytes(bytes), 0);
    if (!decoded) throw new Error('addMembers: malformed recipient KeyPackage');
    return { proposalType: 'add', add: { keyPackage: decoded[0] } };
  });
  const result = await createCommit(
    { state, cipherSuite: impl },
    { extraProposals: proposals, ratchetTreeExtension: true, wireAsPublicMessage },
  );
  if (!result.welcome) throw new Error('addMembers: expected a Welcome for an Add commit');
  const commit = encodeMlsMessage(result.commit);
  const welcome = encodeMlsMessage({ version: 'mls10', wireformat: 'mls_welcome', welcome: result.welcome });
  const newState = result.newState;
  for (const buf of result.consumed) zeroOutUint8Array(buf);
  return { newState, commit, welcome };
}

/** Add one member by their published KeyPackage bytes (single-element addMembers). */
export function addMember(state: MlsClientState, recipientKeyPackageBytes: Uint8Array, wireAsPublicMessage = false): Promise<AddMemberResult> {
  return addMembers(state, [recipientKeyPackageBytes], wireAsPublicMessage);
}

/**
 * Remove members by leaf index: one Remove proposal per leaf, batched into ONE Commit
 * (no Welcome — a Remove seals nothing). Returns CommitResult { newState, commit } (the
 * same shape selfUpdate/joinExternal return). The caller resolves leaf indices via
 * resolveLeafIndex on the SAME state (never pass -1; see that helper's infinite-loop note).
 */
export async function removeMembers(state: MlsClientState, leafIndices: number[], wireAsPublicMessage = false): Promise<CommitResult> {
  const impl = await getImpl();
  const proposals: Proposal[] = leafIndices.map((i) => ({ proposalType: 'remove', remove: { removed: i } }));
  const result = await createCommit({ state, cipherSuite: impl }, { extraProposals: proposals, wireAsPublicMessage });
  const commit = encodeMlsMessage(result.commit);
  const newState = result.newState;
  for (const buf of result.consumed) zeroOutUint8Array(buf);
  return { newState, commit };
}

/**
 * Join a group from a sealed Welcome, trying each candidate's (public KeyPackage,
 * private material) until one decrypts. Reports the matched candidate's ref +
 * last-resort flag so the caller can delete the init key and heal PCS. The
 * Welcome carries the ratchet tree (ratchetTreeExtension). A fresh copy of the
 * Welcome bytes is decoded per attempt (move-not-borrow).
 */
export async function joinFromWelcome(
  welcomeBytes: Uint8Array,
  candidates: KeyPackageCandidate[],
  tier: MlsTier = 'saved',
): Promise<JoinResult> {
  const impl = await getImpl();
  let lastErr: unknown;
  for (const candidate of candidates) {
    const pubDecoded = decodeKeyPackage(copyBytes(candidate.keyPackage), 0);
    if (!pubDecoded) continue;
    const priv = deserializePrivateKeys(candidate.privateKeyPackage);
    if (!priv) continue;
    const decoded = decodeMlsMessage(copyBytes(welcomeBytes), 0);
    if (!decoded) throw new Error('joinFromWelcome: malformed welcome');
    const [msg] = decoded;
    if (msg.wireformat !== 'mls_welcome') {
      throw new Error(`joinFromWelcome: expected mls_welcome, got ${msg.wireformat}`);
    }
    try {
      const state = await joinGroup(
        msg.welcome,
        pubDecoded[0],
        priv,
        emptyPskIndex,
        impl,
        undefined,
        undefined,
        buildClientConfig(tier),
      );
      return { state, consumedKpRef: candidate.keyPackageRef, isLastResort: candidate.isLastResort };
    } catch (err) {
      // A Welcome is sealed to exactly one KeyPackage; the wrong candidate fails
      // HPKE decap. Keep trying; surface the last error if none match.
      lastErr = err;
    }
  }
  throw new Error(
    `joinFromWelcome: no candidate KeyPackage matched the Welcome${
      lastErr instanceof Error ? ` (last error: ${lastErr.message})` : ''
    }`,
  );
}

/**
 * External-Commit self-join. Mints a fresh leaf from the STABLE signing
 * identity, decodes the published GroupInfo (which embeds the ratchet tree), and
 * commits via joinGroupExternal. `resync` is DATA-DRIVEN: ts-mls passes it straight
 * into ratchetTree.findIndex with no guard, so resync=true with no matching leaf
 * yields findIndex=-1 -> toLeafIndex(-0.5) -> level(-1) INFINITE LOOP. We scan for a
 * leaf carrying our signing key: present (same-device recovery / a Welcome-added
 * leaf) -> resync (remove+external_init); absent (genuinely new) -> plain add. No
 * `consumed` array is returned (ts-mls 1.6.2), so nothing to zeroize.
 */
export async function joinExternal(
  groupInfoBytes: Uint8Array,
  identity: MlsIdentity,
  tier: MlsTier = 'saved',
): Promise<CommitResult> {
  const impl = await getImpl();
  const decoded = decodeMlsMessage(copyBytes(groupInfoBytes), 0);
  if (!decoded) throw new Error('joinExternal: malformed group-info');
  const [msg] = decoded;
  if (msg.wireformat !== 'mls_group_info') {
    throw new Error(`joinExternal: expected mls_group_info, got ${msg.wireformat}`);
  }
  const credential: Credential = { credentialType: 'basic', identity: identity.credentialIdentity };
  const { publicPackage, privatePackage } = await generateKeyPackageWithKey(
    credential,
    supportedCapabilities(),
    realLifetime(),
    [],
    { signKey: identity.signaturePrivateKey, publicKey: identity.signaturePublicKey },
    impl,
  );
  const tree = ratchetTreeFromExtension(msg.groupInfo);
  const resync = leafSignatureMatches(tree, identity.signaturePublicKey);
  const { publicMessage, newState } = await joinGroupExternal(
    msg.groupInfo,
    publicPackage,
    privatePackage,
    resync,
    impl,
    undefined,
    buildClientConfig(tier),
  );
  const commit = encodeMlsMessage({ version: 'mls10', wireformat: 'mls_public_message', publicMessage });
  return { newState, commit };
}

/** Update our own leaf (PCS heal). Emits a member Commit; advances one epoch. */
export async function selfUpdate(state: MlsClientState): Promise<CommitResult> {
  const impl = await getImpl();
  const result = await createCommit({ state, cipherSuite: impl }, { extraProposals: [] });
  const commit = encodeMlsMessage(result.commit);
  const newState = result.newState;
  for (const buf of result.consumed) zeroOutUint8Array(buf);
  return { newState, commit };
}

/**
 * Apply an incoming handshake message (a Commit) and return the new state.
 * Member commits are mls_private_message; external commits are mls_public_message.
 * Application messages are handled by decryptApp, not here.
 */
export async function processHandshake(
  state: MlsClientState,
  mlsMessageBytes: Uint8Array,
): Promise<MlsClientState> {
  const impl = await getImpl();
  const decoded = decodeMlsMessage(copyBytes(mlsMessageBytes), 0);
  if (!decoded) throw new Error('processHandshake: malformed message');
  const [msg] = decoded;
  if (msg.wireformat === 'mls_private_message') {
    const r = await processPrivateMessage(state, msg.privateMessage, emptyPskIndex, impl);
    if (r.kind !== 'newState') {
      throw new Error(`processHandshake: expected a handshake commit, got ${r.kind}`);
    }
    const newState = r.newState;
    for (const buf of r.consumed) zeroOutUint8Array(buf);
    return newState;
  }
  if (msg.wireformat === 'mls_public_message') {
    const r = await processPublicMessage(state, msg.publicMessage, emptyPskIndex, impl);
    const newState = r.newState;
    for (const buf of r.consumed) zeroOutUint8Array(buf);
    return newState;
  }
  throw new Error(`processHandshake: unexpected wireformat ${msg.wireformat}`);
}

// Application-layer PADME length bucketing
// ts-mls's PaddingConfig (padUntilLength | alwaysPad) can't express PADME, so we
// bucket the *plaintext* at the application-message chokepoint: every encryptApp
// frames VERSION || u32LE(realLen) || plaintext and zero-pads to a Padmé bucket,
// so a message >256 B no longer leaks its exact length over the wire or at rest.
// decryptApp reads realLen and slices back, failing closed on a malformed frame.
// The ts-mls 256-floor (defaultPaddingConfig, kept) still hides small messages.
const APP_PAD_VERSION = 0x01;
const APP_PAD_HEADER_LEN = 5; // version(1) || uint32LE realLength(4)

/**
 * Padmé padding (Nikitin et al., PETS 2019): round n UP so the lowest bits are
 * zero, bounding the size leak with ≤ ~12% overhead. Identical to fileCrypto.ts
 * `padmeSize`; duplicated to avoid coupling MLS to the attachment codec
 * (pure math, and decrypt reads the stored length rather than recomputing this,
 * so the two copies can never drift into a decrypt failure).
 */
function padmeSize(n: number): number {
  if (n <= 2) return n;
  const e = Math.floor(Math.log2(n));
  const s = Math.floor(Math.log2(e)) + 1;
  const bucket = Math.pow(2, e - s);
  return Math.ceil(n / bucket) * bucket;
}

/** Frame + Padmé-pad an application plaintext. Length-hides >256 B text. */
export function padApplicationPlaintext(plaintext: Uint8Array): Uint8Array {
  const framedLen = APP_PAD_HEADER_LEN + plaintext.length;
  const padded = new Uint8Array(padmeSize(framedLen)); // zero-filled tail = the pad
  padded[0] = APP_PAD_VERSION;
  new DataView(padded.buffer, padded.byteOffset, padded.byteLength).setUint32(1, plaintext.length, true);
  padded.set(plaintext, APP_PAD_HEADER_LEN);
  return padded;
}

/** Strip the padding frame, recovering the exact plaintext. Fail-closed on garbage. */
export function unpadApplicationPlaintext(padded: Uint8Array): Uint8Array {
  if (padded.length < APP_PAD_HEADER_LEN) throw new Error('decryptApp: truncated padding frame');
  if (padded[0] !== APP_PAD_VERSION) throw new Error(`decryptApp: unknown padding version ${padded[0]}`);
  const realLen = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(1, true);
  if (realLen > padded.length - APP_PAD_HEADER_LEN) throw new Error('decryptApp: padding length out of range');
  return padded.slice(APP_PAD_HEADER_LEN, APP_PAD_HEADER_LEN + realLen);
}

/** Encrypt an application message. Advances the sender ratchet. */
export async function encryptApp(state: MlsClientState, plaintext: Uint8Array): Promise<EncryptResult> {
  const impl = await getImpl();
  const padded = padApplicationPlaintext(plaintext); // PADME-bucket before encrypt
  const enc = await createApplicationMessage(state, padded, impl);
  zeroOutUint8Array(padded); // temp frame held the plaintext
  const privateMessage = encodeMlsMessage({
    version: 'mls10',
    wireformat: 'mls_private_message',
    privateMessage: enc.privateMessage,
  });
  const newState = enc.newState;
  for (const buf of enc.consumed) zeroOutUint8Array(buf);
  return { newState, privateMessage };
}

/** Decrypt an application message. Advances the receiver ratchet. */
export async function decryptApp(state: MlsClientState, mlsMessageBytes: Uint8Array): Promise<DecryptResult> {
  const impl = await getImpl();
  const decoded = decodeMlsMessage(copyBytes(mlsMessageBytes), 0);
  if (!decoded) throw new Error('decryptApp: malformed message');
  const [msg] = decoded;
  if (msg.wireformat !== 'mls_private_message') {
    throw new Error(`decryptApp: expected mls_private_message, got ${msg.wireformat}`);
  }
  const r = await processPrivateMessage(state, msg.privateMessage, emptyPskIndex, impl);
  if (r.kind !== 'applicationMessage') {
    throw new Error(`decryptApp: expected applicationMessage, got ${r.kind}`);
  }
  const padded = r.message;
  const plaintext = unpadApplicationPlaintext(padded); // strip the PADME frame
  zeroOutUint8Array(padded); // decoded frame held the plaintext (slice copied it out)
  const newState = r.newState;
  for (const buf of r.consumed) zeroOutUint8Array(buf);
  return { newState, plaintext };
}

/** Current group epoch (uint64). */
export function currentEpoch(state: MlsClientState): bigint {
  return state.groupContext.epoch;
}

/**
 * Build a fresh self-contained GroupInfo (external_pub + ratchet_tree embedded)
 * for the current epoch, wrapped as a wire-format mls_group_info MLSMessage.
 * Published to the server on create and on each commit (the server is a dumb relay).
 */
export async function makeGroupInfo(state: MlsClientState): Promise<Uint8Array> {
  const impl = await getImpl();
  const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(state, [], impl);
  return encodeMlsMessage({ version: 'mls10', wireformat: 'mls_group_info', groupInfo });
}

/**
 * Serialize group state for at-rest local persistence. encodeGroupState is sync
 * and strips clientConfig; decodeState reattaches it. Never sent to the server.
 */
export function encodeState(state: MlsClientState): Uint8Array {
  return encodeGroupState(state);
}

/**
 * Restore group state from bytes and reattach the clientConfig. ts-mls's
 * decodeGroupState returns [GroupState, bytesRead] | undefined and drops the
 * clientConfig (defaultClientConfig is not barrel-exported), so we rebuild it
 * via buildClientConfig() — which carries our credential-validation seam, so a
 * reloaded state keeps the same authService as a freshly created/joined one.
 */
export function decodeState(bytes: Uint8Array, tier: MlsTier = 'saved'): MlsClientState {
  const decoded = decodeGroupState(copyBytes(bytes), 0);
  if (!decoded) throw new Error('decodeState: decodeGroupState returned undefined');
  const [groupState] = decoded;
  return { ...groupState, clientConfig: buildClientConfig(tier) };
}

/** RFC 9605 §5.2 literal exporter label for the SFrame base key. */
export const SFRAME_EXPORTER_LABEL = 'SFrame 1.0 Base Key';
/** SFrame base key length in bytes; matches the 32-byte key LiveKit setKey receives today. */
export const SFRAME_BASE_KEY_LEN = 32;

/**
 * RFC 9420 exporter (§8.5). Derives `length` bytes from the current epoch's
 * exporter secret under `label` + `context`. Consumed by the SFrame call path.
 */
export async function exportSecret(
  state: MlsClientState,
  label: string,
  context: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const impl = await getImpl();
  // Copy the exporter secret before handing it to ts-mls (move-not-borrow):
  // ts-mls 1.6.2 aliases Uint8Array views into its input buffers, so passing
  // the live view risks corrupting group state if a future ts-mls version
  // mutates or retains its input.
  return mlsExporter(copyBytes(state.keySchedule.exporterSecret), label, context, length, impl);
}
