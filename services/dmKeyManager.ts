// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Stateful singleton for DM key management.
 * Holds decrypted keys in memory after unlock. Provides methods for
 * setup, unlock, lock, and starting new DMs.
 */
import nacl from 'tweetnacl';
import { apiClient } from './api';
import { toBase64, fromBase64, toArrayBuffer, zeroFill } from './cryptoHelpers';
import {
  deriveUnlockMaterial,
  generateSalt,
  generateKeyPair,
  generateSigningKeyPair,
  encryptChannelKeyForRecipient,
  decryptChannelKeyFromDelivery,
  generateRecoveryKey,
  formatRecoveryKey,
  parseRecoveryKey,
  encryptRecoveryBlob,
  decryptRecoveryBlob,
  type BlobContents,
} from './dmCrypto';
// Additive coexistence layer. dmKeyManager keeps the legacy X25519/Ed25519
// secrecy core (group DMs + voice/stage depend on it) AND also carries an MLS
// identity, driving the coordinator on unlock/lock.
import { mintLeafKeypair, buildCrossSignedCredentialIdentity, decodeMlsCredentialIdentity, generateKeyPackages, KEYPACKAGE_BATCH_SIZE, KEYPACKAGE_LOW_WATER, type MlsIdentityBundle } from './mls/mlsIdentity';
import * as mlsGroupStore from './mls/mlsGroupStore';
import * as mlsClient from './mls/mlsClient';
import * as mlsCoordinator from './mls/mlsCoordinator';
import { withProvisionLock } from './mls/mlsTabLock';
import { hasHistorySyncLease } from './mls/mlsHistoryLocks';
import { signRotationLink, signRotationHead } from './mls/aikRotation';
import { logger } from './logger';

/**
 * Load the stable archive key from a decrypted blob (null if the blob predates
 * the archive; callers generate one lazily). Called from all three vault-entry
 * paths (unlock/recover/serverRecover). The archiveKey MUST load from the blob,
 * never mint fresh when one exists, or every vault entry would orphan the entire
 * cross-device history archive.
 */
function loadArchiveKeyFromBlob(contents: BlobContents): void {
  _archiveKey = contents.archiveKey ? fromBase64(contents.archiveKey) : null;
  _archiveKeyVersion = contents.archiveKeyVersion ?? 1;
}

// Event emitter
// Centralizes lock/unlock/setup notifications so UI consumers (notably the
// shared `useUiStore.e2eLocked` flag and the DMView "Messages are locked"
// banner) stay in sync regardless of which call site triggered the change
// (login, login-modal, EncryptionChoiceModal, EncryptionPassphraseModal,
// inline DM-column unlock, IncomingDMCallModal accept-flow unlock, etc.).
// Without a central emitter, every call site would have to remember to clear
// the locked flag after a successful unlock, which is error-prone.

export type LockEvent = 'locked' | 'unlocked' | 'setup-changed';

const _listeners = new Set<(e: LockEvent) => void>();

export function on(fn: (e: LockEvent) => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function off(fn: (e: LockEvent) => void): void {
  _listeners.delete(fn);
}

function emit(e: LockEvent): void {
  for (const fn of _listeners) {
    try { fn(e); }
    catch (err) { console.error('[diag][e2e-emit] listener threw', err); }
  }
}

// State

let _isUnlocked = false;
let _privateKey: Uint8Array | null = null;
/** Ed25519 secret key (64 bytes, nacl.sign format). */
let _privateSigningKey: Uint8Array | null = null;
/** Ed25519 public key (base64). Cached for the voice/stage join-blob signing path (signVoiceJoinBlob sigPub). */
let _signingPublicKeyBase64: string | null = null;
let _derivedKey: CryptoKey | null = null;
// Live content keys retained while unlocked so the device-remember path can
// persist them WITHOUT re-deriving (Argon2id). _liveBlobKey mirrors _derivedKey;
// atRest/history are not otherwise held by dmKeyManager.
let _liveBlobKey: CryptoKey | null = null;
let _liveAtRestKey: CryptoKey | null = null;
let _liveHistoryKey: CryptoKey | null = null;
let _blobVersion = 0;
let _blobSalt: string | null = null; // base64, needed for password change
let _publicKeyBase64: string | null = null;
let _isSetupChecked = false;
let _hasBundle = false;
let _passwordDerived = false;

// Operation serialization
// All state-mutating exports run through this single non-reentrant mutex so the
// background-triggered mutators (socket key deliveries, reconnect, the 30s
// idle-lock, call-accept) cannot interleave through their await points over the
// shared module state. Internal cross-calls MUST use the unwrapped *_Impl
// functions to avoid deadlocking on the mutex.
let _opChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  // Run after the previous op regardless of whether it resolved or rejected, so
  // one failed op never wedges the chain.
  const run = _opChain.then(fn, fn);
  // Advance the chain pointer to a swallowed copy: the next op waits for this
  // op to settle but never sees its value/rejection. Callers await `run`, which
  // still surfaces the real resolution/rejection.
  _opChain = run.then(() => undefined, () => undefined);
  return run as Promise<T>;
}

// Forced teardown (reset()/lock()) bypasses the mutex so logout is never blocked
// by a slow network op. It bumps this epoch; every in-flight op captures the
// epoch at start and bails (without persisting) the moment it observes a change
// after an await. `ensureLive(epoch)` is the bail check.
let _abortEpoch = 0;

class OperationAbortedError extends Error {
  constructor() { super('dmKeyManager operation aborted by teardown'); this.name = 'OperationAbortedError'; }
}

/**
 * Thrown when a decrypted vault blob's own X25519 identity does not match the
 * public key the server advertised for this account — i.e. a substituted blob
 * (server-driven MITM). A DISTINCT error type (not the generic decrypt/wrong-
 * password failure) so a caller CAN surface a tampering warning rather than
 * "incorrect passphrase". It always fails closed (no plaintext leak).
 */
export class VaultIntegrityError extends Error {
  constructor(message = 'vault blob/public-key mismatch') { super(message); this.name = 'VaultIntegrityError'; }
}

function ensureLive(epoch: number): void {
  if (_abortEpoch !== epoch) throw new OperationAbortedError();
}

// MLS state — alongside the legacy core, removes nothing
// The MLS identity (separate from the legacy X25519/Ed25519 identity) is held in
// memory while unlocked and persisted in the password/recovery-encrypted blob.
let _mlsSignaturePublicKey: Uint8Array | null = null;
let _mlsSignaturePrivateKey: Uint8Array | null = null;
let _mlsCredentialIdentity: Uint8Array | null = null;
/** Stable per-install device id; half of the `${userId}:${deviceId}` credential. */
let _deviceId: string | null = null;
/** One-shot breadcrumb guard: currentMlsBundle()'s v2 decode is on a hot path
 *  (called from every activation gate + auto-recovery), so warn AT MOST once per
 *  unlocked session when it fails — reset in clearMlsState(). The legacy-credential
 *  wedge was invisible precisely because this decode failure was swallowed silently. */
let _mlsBundleDecodeWarned = false;

/** Stable per-account archive key (raw 32 bytes). Loaded from the blob (NOT
 *  derived), generated lazily for blobs that predate the archive. Zeroized in lock(). */
let _archiveKey: Uint8Array | null = null;
/** archiveKey generation. Persisted in the blob; bumped to 2 when the archiveKey
 *  is rotated. Sourced by the history syncer's keyVersion. */
let _archiveKeyVersion = 1;
// Is _archiveKey durably reflected in the SERVER blob? The history syncer must
// not seal rows under a freshly-minted key whose best-effort re-persist failed; the
// next unlock would mint a DIFFERENT key, orphaning those rows. This is DISTINCT from
// _archiveKeyVersion above (which gates rotation staleness): this gates mint-persist
// durability. Default true (loaded keys are durable); set false ONLY where we unlock
// over an unpersisted mint (_installVaultTail), and true again after any confirmed
// blob persist that carries the archiveKey.
let _archiveKeyPersisted = true;
/** Set around either mlsCoordinator.rekey caller so the history upload syncer
 *  pauses while at-rest/history keys are mid-swap. */
let _rekeyInProgress = false;

/**
 * Build AAD string for blob encryption, binding ciphertext to the user's identity.
 * Uses the public key (unique per user, always in module state when encryption is active).
 * Returns undefined if no public key is available (pre-setup), in which case
 * encryption proceeds without AAD for backward compatibility.
 */
function getBlobAAD(): string | undefined {
  return _publicKeyBase64 ? 'howl:blob:' + _publicKeyBase64 : undefined;
}

/**
 * AAD binding the recovery blob to the user's identity. The caller supplies the
 * base64 X25519 public key (from setup's fresh keypair, the server bundle, or
 * module state), so it is reconstructable on the recover read path before module
 * state is populated.
 */
function recoveryAAD(publicKey: string): string {
  return 'howl:recovery:v1:' + publicKey;
}

/**
 * Build BlobContents at the serialization boundary.
 * Converts Uint8Array private key to base64 only here,
 * minimizing the lifetime of immutable string copies in the JS heap.
 */
function buildBlobContents(): BlobContents {
  if (!_privateKey) throw new Error('No private key available');
  const contents: BlobContents = {
    privateKey: toBase64(_privateKey),
  };
  // Persist signing key in blob so it roams with password change + recovery.
  if (_privateSigningKey) contents.privateSigningKey = toBase64(_privateSigningKey);
  // The stable archive key rides every blob (encrypted/recovery/escrow).
  if (_archiveKey) {
    contents.archiveKey = toBase64(_archiveKey);
    contents.archiveKeyVersion = _archiveKeyVersion;
  }
  return contents;
}

/**
 * Derive the Ed25519 AIK public key (base64) from the privateSigningKey carried in
 * a blob's contents, or undefined when the blob has no signing key (legacy bundle).
 * Sent alongside every blob-rewriting /password + /recover write so the server's
 * signingPublicKey column moves atomically with the blob's AIK — closing the
 * column != blob divergence class a roaming-identity rotation could otherwise leave
 * (the poisoned-column root cause of the MLS "encryption still loading" wedge).
 */
function signingPubFromContents(contents: BlobContents): string | undefined {
  if (!contents.privateSigningKey) return undefined;
  // Split derive + return (no `return ...SecretKey...` on one line) so the
  // private-key-export secret-scan rule does not false-positive on this public-key derive.
  const { publicKey } = nacl.sign.keyPair.fromSecretKey(fromBase64(contents.privateSigningKey));
  return toBase64(publicKey);
}

// MLS helpers

/**
 * Resolve the current user id for the MLS credential `${userId}:${deviceId}`.
 * Priority: an explicit argument (the round-trip test passes it; callers that
 * already know it may pass it) → the session id held by dmEncryption
 * (`getCurrentUserId`, set at login via `initializeEncryption`). Returns null if
 * neither is available, in which case the MLS identity step is skipped (legacy
 * setup/unlock still succeeds; MLS activates on a later unlock once known).
 */
async function resolveUserId(explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  try {
    const { getCurrentUserId } = await import('./dmEncryption');
    return getCurrentUserId();
  } catch {
    return null;
  }
}

/** Build the in-memory MlsIdentityBundle from the loaded MLS state, or null. */
function currentMlsBundle(): MlsIdentityBundle | null {
  if (!_mlsSignaturePublicKey || !_mlsSignaturePrivateKey || !_mlsCredentialIdentity || !_deviceId) {
    return null;
  }
  let userId: string;
  try {
    userId = decodeMlsCredentialIdentity(_mlsCredentialIdentity).userId;
  } catch {
    // Should be unreachable post-heal: loadOrMintLocalIdentity nulls an undecodable
    // (legacy/pre-v2) credential so it never reaches here. Bounded breadcrumb in case
    // an unanticipated credential shape still surfaces — MLS stays inactive (fail-closed).
    if (!_mlsBundleDecodeWarned) {
      _mlsBundleDecodeWarned = true;
      logger.warn('[mls][dmKeyManager] in-memory MLS credential failed v2 decode; MLS inactive this session', {
        credentialLength: _mlsCredentialIdentity.length,
      });
    }
    return null;
  }
  return {
    identity: {
      signaturePublicKey: _mlsSignaturePublicKey,
      signaturePrivateKey: _mlsSignaturePrivateKey,
      credentialIdentity: _mlsCredentialIdentity,
    },
    userId,
    deviceId: _deviceId,
  };
}

/**
 * Boot — mint a LEAF-ONLY MLS identity (deviceId + signing keypair) into module
 * state and persist it device-local with an EMPTY credential identity. The device
 * leaf is NOT cross-signed yet: the AIK-bound credential is built and published
 * only on the first unlock/setup (crossSignAndPublishLocalIdentity), so a leaf-only
 * identity never publishes KeyPackages. currentMlsBundle() returns null while the
 * credential is empty, so MLS does not activate with an uncross-signed leaf. The
 * at-rest key MUST already be set by the caller (setup/unlock/recover reorder).
 */
async function mintLeafIdentity(userId: string): Promise<void> {
  const deviceId = crypto.randomUUID();
  const { signKey, publicKey } = await mintLeafKeypair();
  _mlsSignaturePublicKey = publicKey;
  _mlsSignaturePrivateKey = signKey;
  _mlsCredentialIdentity = null;     // not cross-signed until first unlock
  _deviceId = deviceId;
  // empty credentialIdentity = uncross-signed (leaf-only). Persist device-local
  // (at-rest), NOT into the roaming blob.
  await mlsGroupStore.putIdentity(userId, deviceId, publicKey, signKey, new Uint8Array(0));
}

/**
 * First unlock/setup — cross-sign this device's leaf signing key with the AIK
 * (Ed25519, _privateSigningKey / _signingPublicKeyBase64), persist the now-full
 * v2 credential identity device-local, and publish the initial KeyPackage batch so
 * peers can Add this device. Idempotent + re-entrant safe: a no-op when the AIK or
 * leaf material is missing, and a re-probe of _mlsCredentialIdentity before publish
 * means a second unlock under withProvisionLock does NOT double-publish.
 */
async function crossSignAndPublishLocalIdentity(userId: string): Promise<void> {
  if (!_mlsSignaturePublicKey || !_mlsSignaturePrivateKey || !_deviceId) return;
  if (!_privateSigningKey || !_signingPublicKeyBase64) return; // AIK not loaded yet
  // Re-probe: a concurrent/earlier pass may have already cross-signed + published.
  if (_mlsCredentialIdentity) return;
  const aikPub = fromBase64(_signingPublicKeyBase64);
  _mlsCredentialIdentity = buildCrossSignedCredentialIdentity(
    userId, _deviceId, _mlsSignaturePublicKey, aikPub, _privateSigningKey,
  );
  await mlsGroupStore.putIdentity(
    userId, _deviceId, _mlsSignaturePublicKey, _mlsSignaturePrivateKey, _mlsCredentialIdentity,
  );
  const bundle = currentMlsBundle();
  if (bundle) await publishInitialKeyPackages(bundle);
}

/**
 * Whether a stored MLS credential decodes as the current v2 AIK-cross-signed
 * struct. An empty buffer (leaf-only, never cross-signed) is NOT v2. A NON-empty
 * buffer that fails to decode is a PRE-v2 legacy credential (the old
 * `utf8(`${userId}:${deviceId}`)` form): not v2 either. Used to route both to the
 * leaf-only cross-sign path so a returning legacy device self-heals on unlock.
 */
function isDecodableV2Credential(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  try {
    decodeMlsCredentialIdentity(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Length-checked byte equality. Operates on public key material (the embedded vs
 *  blob AIK), so timing-safety is not required — only correctness. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Load this device's MLS identity from the device-local store, or mint a fresh
 * LEAF-ONLY one when absent/undecryptable (a new device, or a post-reset device
 * whose old record can't be read). Sets _mlsCredentialIdentity to null when the
 * stored credential is empty (leaf-only, not yet cross-signed) so callers can tell
 * cross-signed from leaf-only. Returns whether it minted. The at-rest key MUST
 * already be set on mlsGroupStore.
 */
async function loadOrMintLocalIdentity(userId: string): Promise<{ bundle: MlsIdentityBundle | null; minted: boolean }> {
  const rec = await mlsGroupStore.getIdentity(userId);
  if (rec) {
    _mlsSignaturePublicKey = rec.signaturePublicKey;
    _mlsSignaturePrivateKey = rec.signaturePrivateKey;
    // Empty stored credential = leaf-only (uncross-signed). A NON-empty credential
    // that does not decode as v2 is a PRE-v2 legacy credential (e.g. a device whose
    // identity predates the v2 cross-signed format): treat it as leaf-only too so
    // the unlock cross-sign path below HEALS it — rebuilding a v2 credential under
    // the SAME deviceId + signing key and republishing this device's KeyPackages —
    // instead of adopting it, which left currentMlsBundle()'s strict v2 decode
    // throwing into a bare catch and MLS never activating ("Secure messaging is
    // locked"). null keeps currentMlsBundle() null until the cross-sign runs.
    const credDecodable = isDecodableV2Credential(rec.credentialIdentity);
    if (!credDecodable && rec.credentialIdentity.length > 0) {
      logger.warn('[mls][dmKeyManager] stored MLS credential not decodable as v2; treating as leaf-only to re-cross-sign + republish', {
        credentialLength: rec.credentialIdentity.length,
      });
    }
    // AIK-divergence heal: a valid v2 credential whose embedded AIK no longer matches
    // the account AIK loaded from the blob is STALE. A roaming-identity rotation can
    // swap the Ed25519 AIK (and the DmKeyBundle.signingPublicKey column) WITHOUT
    // re-cross-signing this device's credential — so its published KeyPackages still
    // embed the OLD AIK and the publish gate, which pins each KeyPackage's AIK to the
    // column, rejects them, draining the pool 404 account-wide. Treat such a credential
    // as leaf-only so the unlock cross-sign path rebuilds it under the CURRENT AIK and
    // republishes — every other device self-converges on its next login. Only checkable
    // once the blob AIK is in memory (post-unlock); the pre-unlock provisioner has no
    // AIK yet (_signingPublicKeyBase64 null), so it defers the check to the unlock pass.
    let aikDiverged = false;
    if (credDecodable && _signingPublicKeyBase64) {
      try {
        const embeddedAik = decodeMlsCredentialIdentity(rec.credentialIdentity).aikPub;
        aikDiverged = !bytesEqual(embeddedAik, fromBase64(_signingPublicKeyBase64));
      } catch {
        aikDiverged = true; // undecodable despite the v2 probe -> rebuild defensively
      }
      if (aikDiverged) {
        logger.warn('[mls][dmKeyManager] stored MLS credential AIK diverges from the account AIK; treating as leaf-only to re-cross-sign + republish under the current AIK');
      }
    }
    _mlsCredentialIdentity = (credDecodable && !aikDiverged) ? rec.credentialIdentity : null;
    _deviceId = rec.deviceId;
    return { bundle: currentMlsBundle(), minted: false };
  }
  await mintLeafIdentity(userId);
  return { bundle: currentMlsBundle(), minted: true };
}

/**
 * Provision this device's MLS identity on AUTHENTICATED session start, BEFORE and
 * independent of vault unlock. Idempotent + cross-tab single-flighted via
 * withProvisionLock. Branches on the pre-unlock identity probe:
 *   - no row (meta null)     -> mint a fresh device-wrapped identity + publish the
 *                               initial KeyPackage batch.
 *   - wrapVersion 1 (legacy) -> DEFER: do NOT mint. The row exists but is encrypted
 *                               under the vault at-rest key (unreadable pre-unlock);
 *                               minting a 2nd identity here would cause a multi-device
 *                               leaf collision. The next unlock re-wraps it to v2.
 *   - wrapVersion 2          -> load the device-wrapped identity; top-up single-use
 *                               KeyPackages + rotate the last-resort.
 *
 * Identity/KP ops succeed with ONLY the device wrap key, so this runs without the
 * vault at-rest key. Warming getOrCreateDeviceWrapKey() up front guarantees the
 * store's identity/KP at-rest path has its key before the mint/publish writes.
 * Best-effort: failures are logged and leave MLS unprovisioned this boot (legacy
 * unaffected); the caller fires this fire-and-forget.
 */
export async function provisionMlsDevice(): Promise<void> {
  const userId = await resolveUserId(undefined);
  if (!userId) return;
  await withProvisionLock(async () => {
    await mlsGroupStore.getOrCreateDeviceWrapKey();
    const meta = await mlsGroupStore.getIdentityMeta(userId);
    if (meta === null) {
      // Two-phase: boot mints a LEAF-ONLY identity and WITHHOLDS publishing.
      // The AIK is not available pre-unlock, so the device cannot be cross-signed
      // yet; the first unlock/setup cross-signs and publishes.
      await mintLeafIdentity(userId);
      return;
    }
    if (meta.wrapVersion === 1) {
      logger.warn('[mls][provision] legacy (v1) identity present; deferring to unlock', { userId });
      return;
    }
    // wrapVersion 2: device-wrapped identity. Load it into module state, then
    // (a) top up single-use KeyPackages when below low-water, and
    // (b) UNCONDITIONALLY rotate the last-resort every run - decoupled from the
    //     single-use top-up; the coordinator's replenishKeyPackagesIfLow gates
    //     last-resort minting on !hasLastResort, so with a finite-but-far
    //     last-resort it would mint once then NEVER rotate.
    const loaded = await loadOrMintLocalIdentity(userId);
    // Two-phase: a leaf-only (uncross-signed) identity has no published KeyPackages
    // yet; the KP top-up / last-resort rotation here MUST NOT publish until the leaf
    // is cross-signed at unlock. loaded.bundle is null when leaf-only (the
    // currentMlsBundle credential guard), so skip and defer to unlock.
    if (!loaded.bundle) return;
    await topUpSingleUseKeyPackages(loaded.bundle);
    await rotateLastResortKeyPackage(loaded.bundle);
  });
}

/**
 * Top up single-use KeyPackages for an already-provisioned device when the
 * server-side remaining count is below the low-water mark. Distinct from the
 * last-resort rotation: mints KEYPACKAGE_BATCH_SIZE single-use packages (NO
 * last-resort) so it never disturbs the last-resort lifecycle.
 */
async function topUpSingleUseKeyPackages(bundle: MlsIdentityBundle): Promise<void> {
  const { remaining } = await mlsClient.keyPackageCount(bundle.deviceId);
  if (remaining >= KEYPACKAGE_LOW_WATER) return;
  const generated = await generateKeyPackages(bundle.identity, KEYPACKAGE_BATCH_SIZE, false);
  for (const g of generated) {
    await mlsGroupStore.putKpPrivate(toBase64(g.keyPackageRef), g.keyPackage, g.privateKeyPackage, g.isLastResort);
  }
  await mlsClient.publishKeyPackages(
    bundle.deviceId,
    generated.map((g) => ({ keyPackage: toBase64(g.keyPackage), isLastResort: g.isLastResort })),
  );
}

/**
 * Mint and publish a FRESH last-resort KeyPackage every provisioning run, then
 * delete the prior LOCAL last-resort kpPrivate. The server-side supersede (delete
 * prior last-resort in the publish tx) handles the remote row; this clears the
 * now-orphaned local private so the device store keeps exactly one live last-resort
 * private. generateKeyPackages(identity, 0, true) yields a single last-resort
 * package (count 0 + includeLastResort).
 */
async function rotateLastResortKeyPackage(bundle: MlsIdentityBundle): Promise<void> {
  // Capture the prior local last-resort ref(s) BEFORE publishing the new one so a
  // crash mid-rotation never deletes the fresh package.
  const priorLastResortRefs = (await mlsGroupStore.getAllKeyPackageCandidates())
    .filter((c) => c.isLastResort)
    .map((c) => c.keyPackageRef);
  const [fresh] = await generateKeyPackages(bundle.identity, 0, true);
  if (!fresh) return;
  await mlsGroupStore.putKpPrivate(toBase64(fresh.keyPackageRef), fresh.keyPackage, fresh.privateKeyPackage, fresh.isLastResort);
  await mlsClient.publishKeyPackages(bundle.deviceId, [{ keyPackage: toBase64(fresh.keyPackage), isLastResort: true }]);
  const freshRef = toBase64(fresh.keyPackageRef);
  for (const ref of priorLastResortRefs) {
    if (ref === freshRef) continue; // never delete the package we just minted
    await mlsGroupStore.deleteKpPrivate(ref);
  }
}

/**
 * Publish the initial KeyPackage batch for a freshly-minted MLS identity so
 * peers can add this device to a group before the coordinator's leader-only
 * replenish runs. Persists each private package locally (at-rest, via the MLS
 * group store, which must already have its at-rest key set) and publishes the
 * public packages to the KeyPackage directory.
 */
async function publishInitialKeyPackages(bundle: MlsIdentityBundle): Promise<void> {
  const generated = await generateKeyPackages(bundle.identity, KEYPACKAGE_BATCH_SIZE, true);
  for (const g of generated) {
    await mlsGroupStore.putKpPrivate(toBase64(g.keyPackageRef), g.keyPackage, g.privateKeyPackage, g.isLastResort);
  }
  await mlsClient.publishKeyPackages(
    bundle.deviceId,
    generated.map((g) => ({ keyPackage: toBase64(g.keyPackage), isLastResort: g.isLastResort })),
  );
}

/**
 * Drive the MLS coordinator after the legacy unlock/recover state is loaded.
 *
 * CRITICAL ORDERING (memory trap): the legacy `_isUnlocked` + key state is set
 * by the caller BEFORE this runs, so a failure here never surfaces as "wrong
 * password" — the password was already proven correct by the blob decrypt. This
 * routine therefore swallows MLS-activation failures (logs them) and leaves MLS
 * inactive (fail-closed for MLS) while legacy DMs keep working.
 *
 * Non-blocking unlock: this is SYNCHRONOUS void and does NOT block unlock/recover.
 * The dispatcher's activate() returns immediately on the worker path (init RPC; if
 * the worker fails to init within a short timeout it transparently tears the worker
 * down and falls back to the in-process core path) or runs activation in the
 * background on the fallback path; MLS readiness arrives LATER via the mls-ready
 * event + readiness mirror. setAtRestKey runs synchronously up front because the
 * fallback path reads it; activate() is fired-and-forgotten with a .catch that
 * logs and leaves MLS inactive while legacy DMs work.
 * A backgrounded activate() rejection (only if BOTH the worker init AND the in-process
 * fallback fail) is only logged, not retried: the coordinator's init latch is left
 * as-is, so a fresh activation requires a lock/unlock cycle. This matches the recover path.
 */
function activateMls(bundle: MlsIdentityBundle, atRestKey: CryptoKey, historyKey: CryptoKey | null): void {
  mlsGroupStore.setAtRestKey(atRestKey); // fallback path reads this; worker re-installs via init
  mlsGroupStore.setHistoryKey(historyKey); // Saved-history archive writes under this (worker re-installs via init)
  void mlsCoordinator.activate(bundle, atRestKey, historyKey).catch((err) => {
    logger.error('[mls][dmKeyManager] coordinator activation failed; MLS inactive', {
      error: (err as Error)?.message,
    });
  });
}

/**
 * Shared MLS-identity install used by unlock(), recover(), and serverRecover().
 * Sets the per-tab at-rest/history keys, then loads this device's MLS identity
 * from the device-local store or mints a fresh one (new device / post-reset /
 * post-rotation), publishing its initial KeyPackages on a fresh mint. Fail-closed:
 * any error clears the in-memory identity and nulls the store keys, leaving MLS
 * inactive (legacy DMs unaffected). Behaviour is identical across the three flows;
 * `flow` only labels the error log. The at-rest key is set BEFORE the load so
 * getIdentity/putIdentity can decrypt/encrypt the device-local identity at rest.
 */
async function bootstrapMlsIdentity(
  atRestKey: CryptoKey,
  historyKey: CryptoKey | null,
  flow: 'unlock' | 'recover' | 'serverRecover',
): Promise<void> {
  mlsGroupStore.setAtRestKey(atRestKey);
  mlsGroupStore.setHistoryKey(historyKey);
  const resolvedUserId = await resolveUserId(undefined);
  if (!resolvedUserId) return;
  try {
    // Serialize the load-or-mint + cross-sign + publish under the SAME
    // 'howl-mls-provision' lock as the boot provisioner (provisionMlsDevice),
    // so an unlock/recover racing the provisioner mints exactly one identity.
    // loadOrMintLocalIdentity re-probes (getIdentity) inside the lock, so the
    // racer that runs second observes the row and loads instead of minting.
    //
    // Two-phase: boot mints a LEAF-ONLY identity (no publish). The AIK is loaded
    // into _privateSigningKey BEFORE this runs in all three flows
    // (unlock/recover/serverRecover), so here — under the lock — we cross-sign the
    // leaf with the AIK and publish the initial KeyPackages on the FIRST unlock
    // (when the loaded identity is not yet cross-signed). crossSignAndPublishLocal-
    // Identity re-probes _mlsCredentialIdentity before publishing, so a re-entrant
    // unlock (second lock holder) does NOT double-publish.
    await withProvisionLock(async () => {
      await loadOrMintLocalIdentity(resolvedUserId);
      if (_mlsCredentialIdentity == null) {
        await crossSignAndPublishLocalIdentity(resolvedUserId);
      }
    });
  } catch (err) {
    logger.error(`[mls][dmKeyManager] ${flow}: identity load/mint failed; legacy unaffected`, { error: (err as Error)?.message });
    // Fail-closed: clear the in-memory identity AND null the at-rest/history keys so
    // MLS is fully inactive this session (legacy unaffected); the next unlock retries
    // the mint. mintLeafIdentity populates the in-memory _mls* fields before awaiting
    // putIdentity, so on a failed persist those fields would otherwise survive and
    // currentMlsBundle() would return non-null — re-activating MLS with an identity
    // that did not persist. clearMlsState() makes currentMlsBundle() null so the
    // caller's activateMls gate is skipped; nulling the at-rest/history keys avoids
    // leaving a decryption-capable key on the store with the coordinator inactive.
    clearMlsState();
    mlsGroupStore.setAtRestKey(null);
    mlsGroupStore.setHistoryKey(null);
  }
}

// Auto-recover MLS after a SIBLING tab tore down the shared worker
// The MLS writer is one per-origin SharedWorker, but lock triggers are per-tab.
// When ANY tab calls lock()/requestIdleLock(), the worker host unconditionally
// deactivates the shared core and broadcasts 'mls-locked' to ALL tabs. An idle
// BACKGROUND tab's per-tab idle-timer therefore tears down MLS for an actively
// used SIBLING tab, which then silently fails sends ("Encryption unavailable").
//
// As a minimal, safe stopgap (short of full unlocked-port refcounting in the
// worker host): a still-unlocked tab that receives an UNEXPECTED 'mls-locked'
// re-drives activateMls() to bring the shared worker back up under its own
// identity. "Unexpected" = we did NOT initiate the lock, distinguished race-free
// by _isUnlocked: our own lock()/requestIdleLock() sets _isUnlocked=false
// SYNCHRONOUSLY before the async 'mls-locked' broadcast returns, so a true here
// means a sibling (or a worker crash) tore us down while we are still unlocked.
//
// Feasibility: re-activation needs the identity bundle (currentMlsBundle(), held
// in module state while unlocked) AND the MLS at-rest key. The at-rest key is NOT
// retained as a dmKeyManager field; it lives in mlsGroupStore (per-tab); a
// sibling's lock() nulls only ITS copy, so OURS survives and is read back via
// getAtRestKey(). After our own lock() that key is null, and _isUnlocked is false
// anyway, so this never fires post-lock.
//
// Anti-flap: a single in-flight recovery at a time (_autoRecovering latch), and
// the coordinator's own _initStarted latch de-dups concurrent re-inits. A failed
// recovery is logged and leaves MLS inactive; the manual Restore affordance
// remains the fallback. We do NOT retry on a loop.
let _autoRecovering = false;

if (typeof window !== 'undefined') {
  mlsCoordinator.mlsEvents?.on((e) => {
    if (e !== 'mls-locked') return;
    if (!_isUnlocked) return;          // WE initiated the lock; do not resurrect it.
    if (_autoRecovering) return;       // already bringing the worker back up.
    const bundle = currentMlsBundle();
    const atRestKey = mlsGroupStore.getAtRestKey();
    // Prefer the RETAINED history key (held for the whole unlocked session, cleared only
    // on lock) over the STORE mirror, which an identity-reload teardown can null while the
    // tab stays unlocked (see the mintMlsIdentity catch above). Re-activating history-blind
    // would let messages received in the recovered window decrypt + display but never
    // archive, so they relock to the placeholder after a reload.
    const historyKey = _liveHistoryKey ?? mlsGroupStore.getHistoryKey();
    if (!bundle || !atRestKey) return; // missing material; cannot recover; Part-1 UI handles it.
    // historyKey may STILL be null (a Self-recovery user legitimately has no history key);
    // it is NOT recovery-critical, so it does not gate the return above.
    _autoRecovering = true;
    logger.warn('[mls][dmKeyManager] unexpected mls-locked while unlocked; auto-recovering MLS');
    void mlsCoordinator.activate(bundle, atRestKey, historyKey)
      .catch((err) => logger.error('[mls][dmKeyManager] auto-recovery activation failed; MLS inactive', {
        error: (err as Error)?.message,
      }))
      .finally(() => { _autoRecovering = false; });
  });
}

/** Zero + clear the in-memory MLS identity bytes (called from lock). */
function clearMlsState(): void {
  zeroFill(_mlsSignaturePublicKey);
  _mlsSignaturePublicKey = null;
  zeroFill(_mlsSignaturePrivateKey);
  _mlsSignaturePrivateKey = null;
  zeroFill(_mlsCredentialIdentity);
  _mlsCredentialIdentity = null;
  _deviceId = null;
  _mlsBundleDecodeWarned = false; // re-arm the one-shot decode breadcrumb for the next session
}

/**
 * Strip the MLS identity material before serializing a blob for SERVER escrow.
 * The MLS signing private key must NEVER reach the server, or the server could
 * forge the user's MLS identity. Server escrow carries the legacy core only.
 *
 * The MLS identity is no longer carried in ANY blob — buildBlobContents() omits it
 * entirely; it lives device-local in mlsGroupStore (putIdentity, encrypted under
 * the per-device at-rest key). This strip therefore remains as a DEFENSIVE drop of
 * mlsIdentity/deviceId/blobFormatVersion for OLD v2 blobs a returning user may
 * still present (those fields are inert on read but must never be re-escrowed to
 * the server).
 */
function stripMlsForEscrow(contents: BlobContents): BlobContents {
  const rest = { ...contents } as BlobContents & {
    mlsIdentity?: unknown; deviceId?: unknown; blobFormatVersion?: unknown;
    channelKeys?: unknown; channelKeyHistory?: unknown;
  };
  delete rest.mlsIdentity;
  delete rest.deviceId;
  delete rest.blobFormatVersion;
  // Old fat blobs re-escrowed on recover/serverRecover must not keep shipping
  // dead legacy channel keys to the server.
  delete rest.channelKeys;
  delete rest.channelKeyHistory;
  return rest;
}

/**
 * Build and base64-encode the raw blob contents for server escrow.
 * Only called when passwordDerived mode is active.
 */
function getRawBlobForEscrow(): string {
  const contents = stripMlsForEscrow(buildBlobContents());
  const json = JSON.stringify(contents);
  return btoa(json);
}

// Password-derived escrow gate, with cross-tab convergence
// Server escrow is refreshed on a blob write ONLY when the user is in
// password-derived (Server-recovery) mode. The escrow blob carries the RAW
// (un-password-wrapped) key material, so we must NOT send it for users who opted
// OUT of server escrow — doing so would hand the server plaintext keys, breaking
// the E2EE contract. The decision therefore stays client-gated, but the gating
// flag (`_passwordDerived`) is a PER-TAB value that previously drifted: tab A
// enabling/disabling the mode left tab B's flag stale, so tab B's writes either
// omitted escrow (mode just enabled → escrow drifts behind the live blob) or
// kept sending it (mode just disabled → already handled server-side by the
// row gate, harmless). The server gates every escrow-bearing write on its OWN
// row-level `passwordDerived`, so it is the source of truth; we converge the
// per-tab flag to it by broadcasting a mode-change to sibling tabs via a
// localStorage `storage` event (same mechanism as encryptionFlags.ts and the
// cross-tab logout in App.tsx). `unlock()`/`checkSetup()` already refresh
// `_passwordDerived` from the bundle for fresh/reloaded tabs.
const PASSWORD_DERIVED_KEY = 'howl_e2e_password_derived';

/** Build the escrow field for a blob write — present iff this user is in
 *  password-derived mode. Centralizes the gate so all six writers stay in sync
 *  and so the convergence rules live in one place. */
function escrowField(): { rawBlobForEscrow?: string } {
  return _passwordDerived ? { rawBlobForEscrow: getRawBlobForEscrow() } : {};
}

/** Set `_passwordDerived` and broadcast the change to sibling tabs so their
 *  per-tab flag converges (the localStorage write fans out as a `storage`
 *  event in OTHER tabs; see the module-load listener below). */
function setPasswordDerived(value: boolean): void {
  _passwordDerived = value;
  try { localStorage.setItem(PASSWORD_DERIVED_KEY, value ? '1' : '0'); }
  catch { /* localStorage unavailable */ }
}

// Cross-tab convergence: a sibling tab toggled password-derived mode. Mirror the
// new value so this tab's escrow gate stops drifting. Fires only in OTHER tabs.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key !== PASSWORD_DERIVED_KEY || e.newValue == null) return;
    _passwordDerived = e.newValue === '1';
  });
}

// Pending flags (crash-resume). Set while the archive-rotation teardown is
// mid-flight so a crash/close self-heals on the next boot. Same cross-tab
// convergence as _passwordDerived: a localStorage write fans out as a 'storage'
// event in OTHER tabs.
// The flag VALUE is the owning userId (null = not pending), so a crash-orphaned
// rotation from one account can never drive resume on a DIFFERENT account that
// later logs into the same origin: resumePendingRotation only acts on a match.
const PENDING_ARCHIVE_RESYNC_KEY = 'howl_e2e_pending_archive_resync';
let _pendingArchiveResync: string | null = (() => {
  try { return localStorage.getItem(PENDING_ARCHIVE_RESYNC_KEY) || null; } catch { return null; }
})();

function setPendingArchiveResync(value: string | null): void {
  _pendingArchiveResync = value;
  try {
    if (value) localStorage.setItem(PENDING_ARCHIVE_RESYNC_KEY, value);
    else localStorage.removeItem(PENDING_ARCHIVE_RESYNC_KEY);
  } catch { /* localStorage unavailable */ }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key !== PENDING_ARCHIVE_RESYNC_KEY) return;
    _pendingArchiveResync = e.newValue;
  });
}

// Cross-tab archiveKey generation broadcast. After a tab rotates the archiveKey,
// sibling tabs still hold a stale per-tab _archiveKey/_archiveKeyVersion
// (no cross-tab key sync). Broadcasting the new generation lets the upload syncer on a
// behind tab FAIL-CLOSED (eligible() refuses to drain) so it never re-seals DM history
// under the old, escrow-exposed key. Account-scoped value: `<userId>:<version>`.
const ARCHIVE_MIN_VERSION_KEY = 'howl_e2e_archive_min_version';
let _broadcastArchiveMin: { userId: string; version: number } | null = (() => {
  try {
    const raw = localStorage.getItem(ARCHIVE_MIN_VERSION_KEY);
    if (!raw) return null;
    const i = raw.lastIndexOf(':');
    if (i < 0) return null;
    const userId = raw.slice(0, i); const version = parseInt(raw.slice(i + 1), 10);
    return userId && Number.isFinite(version) ? { userId, version } : null;
  } catch { return null; }
})();

function broadcastArchiveKeyVersion(userId: string, version: number): void {
  _broadcastArchiveMin = { userId, version };
  try { localStorage.setItem(ARCHIVE_MIN_VERSION_KEY, `${userId}:${version}`); } catch { /* unavailable */ }
}

/** The minimum archiveKey generation any tab should seal/upload history under for
 *  this account (broadcast by the rotating tab). 1 if unknown. The syncer
 *  fail-closes when getArchiveKeyVersion() is below this. */
export function getMinAcceptableArchiveKeyVersion(userId: string): number {
  return _broadcastArchiveMin && _broadcastArchiveMin.userId === userId ? _broadcastArchiveMin.version : 1;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key !== ARCHIVE_MIN_VERSION_KEY) return;
    if (!e.newValue) { _broadcastArchiveMin = null; return; }
    const i = e.newValue.lastIndexOf(':');
    if (i < 0) { _broadcastArchiveMin = null; return; }
    const userId = e.newValue.slice(0, i); const version = parseInt(e.newValue.slice(i + 1), 10);
    _broadcastArchiveMin = userId && Number.isFinite(version) ? { userId, version } : null;
    // A sibling just rotated the archiveKey to a newer generation. Poke the syncer:
    // if THIS tab holds the history-sync lease but is now
    // behind that generation (a stale-passphrase tab can never reach it, since it cannot
    // even decrypt the rotated blob), drain() fail-closes and RELEASES the lease, letting
    // the v2-capable disabling tab acquire it and finish the resync. A poke on a tab that
    // is current / not the holder is a harmless no-op.
    if (userId && Number.isFinite(version)) {
      void import('./mls/mlsHistoryArchiveSync').then((m) => m.drainHistoryNow()).catch(() => undefined);
    }
  });
}

// Pending identity rotation (crash-resume + voice-deferral). Set when the roaming
// X25519/Ed25519 identity rotation is owed but deferred (e.g. the user is in an
// active voice channel or stage), so it completes on call-end or the next safe
// boot. Same cross-tab convergence as _pendingArchiveResync. Same account-scoping
// as _pendingArchiveResync: the value is the owning userId.
const PENDING_IDENTITY_ROTATION_KEY = 'howl_e2e_pending_identity_rotation';
let _pendingIdentityRotation: string | null = (() => {
  try { return localStorage.getItem(PENDING_IDENTITY_ROTATION_KEY) || null; } catch { return null; }
})();

function setPendingIdentityRotation(value: string | null): void {
  _pendingIdentityRotation = value;
  try {
    if (value) localStorage.setItem(PENDING_IDENTITY_ROTATION_KEY, value);
    else localStorage.removeItem(PENDING_IDENTITY_ROTATION_KEY);
  } catch { /* localStorage unavailable */ }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key !== PENDING_IDENTITY_ROTATION_KEY) return;
    _pendingIdentityRotation = e.newValue;
  });
}

function readPendingIdentityRotation(): string | null {
  try { return localStorage.getItem(PENDING_IDENTITY_ROTATION_KEY) || null; } catch { return _pendingIdentityRotation; }
}

// A dedicated cross-tab lock (distinct from the lifetime-held history-sync lease,
// which a non-holder could never acquire) that single-flights the
// roaming-identity mint+publish across tabs, closing the divergence where two tabs each
// mint+publish a different identity and the loser's in-memory key no longer matches the
// server. ifAvailable so a tab that loses the race skips immediately (the pending flag
// stays set for the winner / a later resume) rather than blocking the in-process opChain.
// Single-tab fallback runs fn directly when navigator.locks is unavailable.
const IDENTITY_ROTATION_LOCK = 'howl-mls-identity-rotation';
async function withIdentityRotationLock(fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { locks?: LockManager }).locks
    : undefined;
  if (!locks) { await fn(); return; }
  await locks.request(IDENTITY_ROTATION_LOCK, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) return; // another tab holds it -> skip; the pending flag stays set for retry
    await fn();
  });
}

// The UI layer registers a probe reporting whether the user is in an active voice
// channel or stage. Used to defer identity rotation (no media rekey, ever). DM
// calls are intentionally EXCLUDED (they key off the MLS exporter, not this
// identity), so the probe reads only voice/stage state.
let _voiceSessionActiveProbe: (() => boolean) | null = null;
export function setVoiceSessionActiveProbe(fn: (() => boolean) | null): void {
  _voiceSessionActiveProbe = fn;
}

// Cross-tab voice/stage activity. The local probe only sees THIS tab; a sibling
// tab of the SAME account could be in a voice/stage call while this
// (lease/disabling) tab is not, so a local-only check would rotate the roaming identity
// mid-call from the sibling's perspective (the gamer-safe deferral must hold across
// tabs). An in-session tab stamps an account-scoped `<userId>:<epochMs>` flag; any tab
// treats the account as in-session while a fresh stamp exists. A generous TTL backstops
// a tab that crashed mid-call without clearing (identity rotation, which only ever fires
// on call-end / boot, resumes after it). Account-scoped so it never gates a different
// account on a shared origin.
const VOICE_ACTIVE_KEY = 'howl_e2e_voice_active';
const VOICE_ACTIVE_TTL_MS = 4 * 60 * 60 * 1000;
function parseVoiceActive(raw: string | null): { userId: string; ts: number } | null {
  if (!raw) return null;
  const i = raw.lastIndexOf(':');
  if (i < 0) return null;
  const userId = raw.slice(0, i); const ts = parseInt(raw.slice(i + 1), 10);
  return userId && Number.isFinite(ts) ? { userId, ts } : null;
}
let _voiceActive: { userId: string; ts: number } | null = (() => {
  try { return parseVoiceActive(localStorage.getItem(VOICE_ACTIVE_KEY)); } catch { return null; }
})();
/** The UI marks this account in/out of a voice or stage session so sibling tabs
 *  defer the roaming-identity rotation. Pass the userId to stamp, null to
 *  clear. The UI re-stamps on every voice/stage state change while in-session (App.tsx);
 *  the TTL backstops a tab that left without clearing. Accepted narrow residuals: a call
 *  with NO state change for the full TTL, and two tabs of one account both in-call where
 *  the first to leave clears the flag - both benign because identity rotation only ever
 *  fires on call-end / boot, never mid-steady-call. */
export function setVoiceSessionActiveFlag(userId: string | null): void {
  if (userId) {
    _voiceActive = { userId, ts: Date.now() };
    try { localStorage.setItem(VOICE_ACTIVE_KEY, `${userId}:${_voiceActive.ts}`); } catch { /* unavailable */ }
  } else {
    _voiceActive = null;
    try { localStorage.removeItem(VOICE_ACTIVE_KEY); } catch { /* unavailable */ }
  }
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key !== VOICE_ACTIVE_KEY) return;
    _voiceActive = parseVoiceActive(e.newValue);
  });
}

function isVoiceSessionActive(userId?: string): boolean {
  try { if (_voiceSessionActiveProbe && _voiceSessionActiveProbe()) return true; }
  catch { /* fail-safe: a throwing probe reads as not-active */ }
  if (userId && _voiceActive && _voiceActive.userId === userId && (Date.now() - _voiceActive.ts) < VOICE_ACTIVE_TTL_MS) return true;
  return false;
}

// Blob persistence with 409 conflict resolution
type BlobWriteArgs = { encryptedBlob: string; blobVersion: number; rawBlobForEscrow?: string };
type BlobWrite = (args: BlobWriteArgs) => Promise<{ blobVersion: number; escrowStale?: boolean }>;

/**
 * Re-encrypt the current in-memory blob and persist it, resolving server
 * version conflicts by reconciling with the server's blob, bumping to the
 * server's version, and retrying. NEVER swallows the error.
 * `epoch` is the caller's abort epoch — checked after each await so a forced
 * teardown mid-persist aborts cleanly without writing.
 *
 * Dormant: the persistBlob → refreshEscrowIfStale → reconcileWithServerBlob
 * cluster currently has no live caller (the rotation/claim write sites that used
 * it are gone). Retained as the generic 409-resilient, escrow-bearing blob writer
 * for future write sites; do not wire it up casually or delete it without
 * revisiting that decision.
 */
async function persistBlob(write: BlobWrite, epoch: number, maxRetries = 3): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    ensureLive(epoch);
    const encryptedBlob = await encryptBlobPacked(buildBlobContents(), _derivedKey!, getBlobAAD());
    ensureLive(epoch);
    try {
      const res = await write({
        encryptedBlob,
        blobVersion: _blobVersion,
        ...escrowField(),
      });
      ensureLive(epoch);
      _blobVersion = res.blobVersion;
      await refreshEscrowIfStale(res.escrowStale, epoch);
      return;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 409 || attempt >= maxRetries) throw err;
      ensureLive(epoch);
      await reconcileWithServerBlob(epoch);
    }
  }
}

/**
 * No-409 escrow refresh path. A backgrounded tab can hold a stale
 * `_passwordDerived=false` while the server row is already password-derived — it
 * missed a sibling's mode-enable and there was no 409 to trigger reconcile. Such
 * a write commits with NO rawBlobForEscrow, so escrow silently lags the live
 * blob. The server flags exactly that case as `escrowStale`. Adopt the
 * authoritative mode (broadcasting to sibling tabs via setPasswordDerived) and
 * re-send escrow ONCE through a plain blob write. We must NOT re-run the original
 * writer: re-running an arbitrary caller-supplied writer is unsafe, so the refresh
 * writes the escrow alone via a plain updateDmKeysBlob. The re-send carries escrow
 * (the gate is now on), so the server clears escrowStale and this does not recurse
 * beyond one extra write.
 */
async function refreshEscrowIfStale(escrowStale: boolean | undefined, epoch: number): Promise<void> {
  if (!escrowStale) return;
  setPasswordDerived(true);
  ensureLive(epoch);
  await persistBlob((args) => apiClient.updateDmKeysBlob(args), epoch);
}

/**
 * Pull the server's current blob, converge the password-derived escrow gate to
 * the server-authoritative flag, decrypt with our still-held derived key, and
 * advance _blobVersion to the server's so the 409 retry writes on top of current
 * state.
 */
async function reconcileWithServerBlob(epoch: number): Promise<void> {
  if (!_derivedKey) throw new Error('Cannot reconcile: locked');
  const bundle = await apiClient.getDmKeyBundle();
  ensureLive(epoch);
  // The bundle is the server-authoritative source of truth for password-derived
  // mode — same as _unlockImpl/checkSetup/_recoverImpl. Converge
  // the per-tab escrow gate to it (and broadcast to sibling tabs) so the 409 retry
  // write below re-evaluates escrowField() with the correct flag. Without this a
  // frozen tab that missed a sibling's mode-enable would retry with stale
  // _passwordDerived=false, omit rawBlobForEscrow, and let escrow lag the live blob.
  setPasswordDerived(bundle.passwordDerived ?? _passwordDerived);
  const blobAAD = 'howl:blob:' + bundle.publicKey;
  await decryptBlobPacked(bundle.encryptedBlob, _derivedKey, blobAAD);
  ensureLive(epoch);
  _blobVersion = bundle.blobVersion;
}

// Public API

export function isUnlocked(): boolean {
  return _isUnlocked;
}

export function isSetup(): boolean {
  return _hasBundle;
}

export function isSetupChecked(): boolean {
  return _isSetupChecked;
}

export function isPasswordDerived(): boolean {
  return _passwordDerived;
}

/**
 * Probe the server for the user's encryption bundle.
 *
 * Returns true (bundle exists) or false (server returned 404 — bundle does
 * not exist) only on an authoritative answer. On any other error — 5xx, network,
 * timeout, 401-after-refresh-failure — THROWS, leaving _hasBundle / _isSetupChecked
 * untouched so callers can preserve their last-known state and avoid prompting
 * "set up encryption" to a user who already has keys.
 *
 * Background: a bare `catch { _hasBundle = false }` here used to mis-classify
 * transient backend hiccups as "user has no bundle", which then propagated to
 * App.tsx and showed the setup choice modal on accounts that already have
 * encryption established.
 */
export async function checkSetup(): Promise<boolean> {
  try {
    const bundle = await apiClient.getDmKeyBundle();
    const wasSetup = _hasBundle;
    _hasBundle = true;
    _passwordDerived = bundle.passwordDerived ?? false;
    _isSetupChecked = true;
    if (!wasSetup) emit('setup-changed');
    return true;
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 404) {
      const wasSetup = _hasBundle;
      _hasBundle = false;
      _passwordDerived = false;
      _isSetupChecked = true;
      if (wasSetup) emit('setup-changed');
      return false;
    }
    // Transient (5xx, network/timeout rewrapped without status, 401 after
    // refresh exhaustion). Do not mutate state — callers should not interpret
    // a transient failure as "this user has no encryption set up".
    throw err;
  }
}

export function getBlobVersion(): number {
  return _blobVersion;
}

/**
 * First-time setup: generate keys, encrypt blob, upload bundle.
 * Returns the formatted recovery key for the user to save.
 */
export function setup(password: string, userId?: string): Promise<{ recoveryKey: string }> {
  return withLock(() => _setupImpl(password, userId));
}

async function _setupImpl(password: string, userId?: string): Promise<{ recoveryKey: string }> {
  const epoch = _abortEpoch;
  const salt = generateSalt();
  // Derive the blob key AND the MLS at-rest key from a single Argon2id pass (all
  // three keys HKDF-derived under distinct labels).
  const { blobKey: derivedKey, atRestKey, historyKey } = await deriveUnlockMaterial(password, salt);
  const keyPair = generateKeyPair();
  // Sibling Ed25519 keypair for voice join-blob signing and the safety number.
  const signingKeyPair = generateSigningKeyPair();

  // Populate the legacy in-memory state first (buildBlobContents reads it).
  _privateKey = keyPair.secretKey;
  _privateSigningKey = signingKeyPair.secretKey;
  _publicKeyBase64 = toBase64(keyPair.publicKey);
  _signingPublicKeyBase64 = toBase64(signingKeyPair.publicKey);
  // Clear any stale MLS identity from a prior session so a v1 setup (no resolvable
  // userId) genuinely produces no MLS identity.
  clearMlsState();

  // Mint the MLS identity BEFORE building the blob so the uploaded bundle is
  // already v2. If no userId is resolvable, the legacy bundle still ships (v1); MLS
  // is added on the next unlock once the userId is known.
  const resolvedUserId = await resolveUserId(userId);
  let mlsBundle: MlsIdentityBundle | null = null;
  // Two-phase: the boot mint is leaf-only (currentMlsBundle() returns null until
  // cross-sign), so r.bundle cannot gate the post-unlock activation. Track whether
  // a leaf identity is in memory and cross-sign+publish below (the AIK is already
  // in _privateSigningKey, generated at setup above).
  let mlsLeafReady = false;
  if (resolvedUserId) {
    try {
      // Per-device identity: the at-rest key must be set before the mint
      // (loadOrMintLocalIdentity persists the identity device-local via putIdentity).
      mlsGroupStore.setAtRestKey(atRestKey);
      mlsGroupStore.setHistoryKey(historyKey);
      // Serialize the mint under the SAME 'howl-mls-provision' lock as the boot
      // provisioner (provisionMlsDevice), so a setup() racing the provisioner mints
      // exactly one device identity. Re-probe via loadOrMintLocalIdentity (NOT an
      // unconditional mint): if a provisioner won the lock first and already minted
      // the device-wrapped identity, REUSE it (the device identity is device-local
      // and meant to be reused, not vault-bound), rather than minting a second
      // identity that overwrites the row and republishes. With no prior identity it
      // mints fresh, identical to before (including the reset->setup flow where
      // clearAll wiped everything).
      await withProvisionLock(() => loadOrMintLocalIdentity(resolvedUserId));
      // A leaf (or already-cross-signed) identity is now in memory; the cross-sign +
      // publish + activate happens below, AFTER _isUnlocked = true (non-fatal).
      mlsLeafReady = !!(_mlsSignaturePublicKey && _mlsSignaturePrivateKey && _deviceId);
    } catch (err) {
      logger.error('[mls][dmKeyManager] setup: identity mint failed; legacy unaffected', { error: (err as Error)?.message });
      mlsLeafReady = false;
      // Fail-closed: clear the in-memory identity AND null the at-rest/history keys
      // so MLS is fully inactive this session (legacy unaffected); the next unlock
      // retries the mint. mintLeafIdentity populates the in-memory _mls* fields
      // before awaiting putIdentity, so a failed persist would otherwise leave a
      // non-persisted identity behind — clearMlsState() makes currentMlsBundle()
      // null. The at-rest/history keys were set above so putIdentity could encrypt;
      // nulling them avoids leaving a decryption-capable at-rest key on the store
      // with the coordinator inactive (violates the locked invariant the bootstrap
      // teardown protects).
      clearMlsState();
      mlsGroupStore.setAtRestKey(null);
      mlsGroupStore.setHistoryKey(null);
    }
  }

  // Mint the stable archive key once at setup; it rides both blobs below.
  _archiveKey = crypto.getRandomValues(new Uint8Array(32));
  _archiveKeyVersion = 1;

  const blobContents = buildBlobContents();

  const setupAAD = 'howl:blob:' + toBase64(keyPair.publicKey);
  const encryptedBlob = await encryptBlobPacked(blobContents, derivedKey, setupAAD);

  // Recovery key — independent decryption path. The recovery blob carries the
  // legacy core only; the MLS identity is device-local (not in the blob), so a
  // recovery re-mints/loads it device-local under the new at-rest key.
  const recoveryKeyBytes = generateRecoveryKey();
  const { ciphertext: recoveryBlob, nonce: recoveryNonce } = await encryptRecoveryBlob(blobContents, recoveryKeyBytes, recoveryAAD(toBase64(keyPair.publicKey)));

  const result = await apiClient.setupDmKeys({
    publicKey: toBase64(keyPair.publicKey),
    signingPublicKey: toBase64(signingKeyPair.publicKey),
    encryptedBlob,
    blobSalt: toBase64(salt),
    recoveryBlob,
    recoveryNonce,
  });
  ensureLive(epoch);
  // The freshly-minted archiveKey is now durably in the server blob (setup awaits
  // the upload and throws on failure, so the vault never unlocks over an unpersisted key).
  _archiveKeyPersisted = true;

  // Identity material was installed above (before buildBlobContents read it).
  // _isUnlocked flips below once the remaining state is set, preserving the
  // install-all-before-flip invariant (a synchronous getter never observes
  // _isUnlocked === true over half-installed state).
  _derivedKey = derivedKey;
  _liveBlobKey = derivedKey;
  _liveAtRestKey = atRestKey;
  _liveHistoryKey = historyKey;
  _blobVersion = result.blobVersion;
  _blobSalt = toBase64(salt);
  _hasBundle = true;
  _isSetupChecked = true;
  _isUnlocked = true;

  // Set the at-rest key, cross-sign the leaf with the AIK + publish the initial
  // KeyPackage batch (so peers can add this brand-new device), then activate the
  // coordinator for the live slice. Best-effort: a failure here must NOT fail
  // setup — the legacy bundle is already uploaded and the user is unlocked. The
  // cross-sign inherits these non-fatal semantics; it runs AFTER _isUnlocked = true
  // and re-derives the bundle for activation. setAtRestKey +
  // publishInitialKeyPackages run on the main thread and write the store before
  // the worker owns it; the worker re-reads the store on init.
  if (mlsLeafReady) {
    let bootstrapOk = false;
    try {
      mlsGroupStore.setAtRestKey(atRestKey); // already set before mint; idempotent
      mlsGroupStore.setHistoryKey(historyKey); // already set before mint; idempotent (Saved-history archive writes under this)
      await crossSignAndPublishLocalIdentity(resolvedUserId!);
      mlsBundle = currentMlsBundle();
      bootstrapOk = !!mlsBundle;
    } catch (err) {
      logger.error('[mls][dmKeyManager] setup: MLS bootstrap failed; MLS inactive', {
        error: (err as Error)?.message,
      });
      // Restore the locked invariant: a partial bootstrap must not leave the
      // group store holding an at-rest key with the coordinator inactive.
      // deactivate() is idempotent and clears the at-rest key + any partial
      // activation (leadership, subscriptions).
      mlsCoordinator.deactivate();
      // Clear the main-thread at-rest key on teardown so decryption capability
      // does not survive a failed setup on the worker path (the worker scrubs
      // its own clone via core.deactivate; deactivate() above does NOT touch the
      // main-thread store when the worker owns crypto).
      mlsGroupStore.setAtRestKey(null);
      mlsGroupStore.setHistoryKey(null);
    }
    // Activate the coordinator fire-and-forget so a slow worker init / fallback
    // activation never blocks setup. Readiness arrives later via the mls-ready
    // event. A failure leaves MLS inactive; legacy works. Only fire when the
    // bootstrap above succeeded; otherwise we just deactivated.
    if (bootstrapOk && mlsBundle) {
      void mlsCoordinator.activate(mlsBundle, atRestKey, historyKey).catch((err) =>
        logger.error('[mls][dmKeyManager] setup activate failed', { error: (err as Error)?.message }),
      );
    }
  }

  emit('setup-changed');
  emit('unlocked');

  return { recoveryKey: formatRecoveryKey(recoveryKeyBytes) };
}

/**
 * Unlock: fetch bundle, derive key, decrypt blob.
 */
export function unlock(password: string): Promise<void> {
  return withLock(() => _unlockImpl(password));
}

async function _unlockImpl(password: string): Promise<void> {
  // Single-flight idempotency: a second unlock that queued behind the first
  // finds us already unlocked and no-ops, instead of redoing the whole derive.
  if (_isUnlocked) return;
  const epoch = _abortEpoch;

  const bundle = await apiClient.getDmKeyBundle();
  ensureLive(epoch);
  _passwordDerived = bundle.passwordDerived ?? false;
  const salt = fromBase64(bundle.blobSalt);
  // Single Argon2id pass yields the blob key and the MLS at-rest/history keys (all
  // three HKDF-derived under distinct labels).
  const { blobKey: derivedKey, atRestKey, historyKey } = await deriveUnlockMaterial(password, salt);
  ensureLive(epoch);

  // Blob format: base64(12-byte IV || AES-GCM ciphertext) — see encryptBlobPacked/decryptBlobPacked.
  // The ONLY operation that may legitimately report "wrong password" is this
  // decrypt. Everything after it (legacy key load, signing-key upgrade, MLS
  // activation) must not surface as a bad-password error.
  const blobAAD = 'howl:blob:' + bundle.publicKey;
  const blobContents = await decryptBlobPacked(bundle.encryptedBlob, derivedKey, blobAAD);
  ensureLive(epoch);

  // Reconcile channel protocol classifications from the durable IndexedDB group
  // map BEFORE marking the vault unlocked. This is key-free (getGroupIdToChannelMap
  // reads only plaintext ids) and closes the manual-unlock
  // window: once _isUnlocked is true the archive key loaded below becomes usable,
  // so isChannelMls() must already be authoritative or a send
  // on an established MLS channel whose localStorage classification was lost would
  // silently route to legacy. Never throws out of unlock (must not surface as a
  // wrong-password error per the contract above); activate() below reconciles
  // again as a steady-state backstop.
  try {
    await mlsCoordinator.reconcileChannelClassifications();
  } catch (err) {
    logger.warn('[mls][dmKeyManager] unlock: classification reconcile failed; activate() will retry', {
      error: (err as Error)?.message,
    });
  }
  ensureLive(epoch);

  await _installVaultTail({ blobContents, derivedKey, atRestKey, historyKey, bundle, blobAAD, epoch });

  emit('unlocked');
}

/**
 * Shared post-decrypt install tail for the vault-entry paths. Extracted
 * VERBATIM from _unlockImpl (behavior-preserving) so the passwordless
 * device-key install (_installFromDeviceWrappedContentKeys) produces byte-for-byte
 * the SAME installed state as a password unlock. Callers own everything BEFORE
 * this (deriveUnlockMaterial / device-key load, getDmKeyBundle, _passwordDerived,
 * reconcileChannelClassifications, the blob decrypt) and the `emit('unlocked')`
 * AFTER. This runs UNDER withLock via its callers.
 */
async function _installVaultTail(args: {
  blobContents: BlobContents;
  derivedKey: CryptoKey;
  atRestKey: CryptoKey;
  historyKey: CryptoKey;
  bundle: { publicKey: string; blobVersion: number; blobSalt: string };
  blobAAD: string;
  epoch: number;
}): Promise<void> {
  const { blobContents, derivedKey, atRestKey, historyKey, bundle, blobAAD, epoch } = args;

  // Install ALL identity material BEFORE flipping _isUnlocked, so a synchronous
  // getter reader never observes _isUnlocked === true over half-installed state.
  const privateKey = fromBase64(blobContents.privateKey);
  const publicKeyBase64 = toBase64(nacl.box.keyPair.fromSecretKey(privateKey).publicKey);
  // The decrypted blob's own X25519 identity MUST match the public key the server
  // advertised. A mismatch means a substituted blob (server-driven MITM); fail
  // closed with a DISTINCT error (not a wrong-password error).
  if (bundle.publicKey && publicKeyBase64 !== bundle.publicKey) {
    throw new VaultIntegrityError();
  }
  _privateKey = privateKey;
  _publicKeyBase64 = publicKeyBase64;
  loadArchiveKeyFromBlob(blobContents);
  // A blob with no archiveKey predates the archive: mint one and re-persist (folds
  // into the signing-key re-upload branch below so it rides encryptedBlob + escrow).
  let archiveKeyGenerated = false;
  if (!_archiveKey) {
    _archiveKey = crypto.getRandomValues(new Uint8Array(32));
    archiveKeyGenerated = true;
  }
  // A loaded archiveKey is already in the server blob (durable); a freshly minted
  // one is NOT until the best-effort re-upload below succeeds. Until then the syncer
  // must not seal rows under it (a failed persist would orphan them on the next unlock).
  _archiveKeyPersisted = !archiveKeyGenerated;
  _derivedKey = derivedKey;
  _liveBlobKey = derivedKey;
  _liveAtRestKey = atRestKey;
  _liveHistoryKey = historyKey;
  _blobVersion = bundle.blobVersion;
  _blobSalt = bundle.blobSalt;

  // Load or lazily generate the Ed25519 signing key. Bundles that predate the
  // signing-key rollout have neither blobContents.privateSigningKey
  // nor bundle.signingPublicKey; we generate one now and upload so future
  // deliveries are signed. The blob update is best-effort — a transient
  // failure is fine because we'll retry on next unlock.
  let signingKeyGenerated = false;
  if (blobContents.privateSigningKey) {
    _privateSigningKey = fromBase64(blobContents.privateSigningKey);
    _signingPublicKeyBase64 = toBase64(nacl.sign.keyPair.fromSecretKey(_privateSigningKey).publicKey);
  } else {
    const newSigning = generateSigningKeyPair();
    _privateSigningKey = newSigning.secretKey;
    _signingPublicKeyBase64 = toBase64(newSigning.publicKey);
    signingKeyGenerated = true;
  }

  // Per-device identity: load this device's identity from the device-local store,
  // or mint a fresh one (new device / post-reset). Shared with recover/serverRecover.
  await bootstrapMlsIdentity(atRestKey, historyKey, 'unlock');

  // Re-persist the blob ONCE if the LEGACY signing key was just added (mirrors the
  // original signing-key lazy-upload at this point). Transient failure is fine — we
  // retry on next unlock; local state stays functional.
  // NOTE: the MLS identity is device-local (not in the blob), so only a freshly
  // generated LEGACY signing key triggers a blob re-persist here.
  if (signingKeyGenerated || archiveKeyGenerated) {
    try {
      const newBlob = await encryptBlobPacked(buildBlobContents(), derivedKey, blobAAD);
      ensureLive(epoch);
      const uploadResult = await apiClient.updateDmKeysSigningKey({
        signingPublicKey: _signingPublicKeyBase64!,
        encryptedBlob: newBlob,
        blobVersion: _blobVersion,
        ...escrowField(),
      });
      ensureLive(epoch);
      _blobVersion = uploadResult.blobVersion;
      // The (possibly freshly-minted) archiveKey is now durably in the server blob.
      _archiveKeyPersisted = true;
    } catch (err) {
      if (err instanceof OperationAbortedError) throw err;
      // Transient upload failure is fine — retry on next unlock; local state works.
      // If the archiveKey was freshly minted here, _archiveKeyPersisted stays false,
      // so the syncer will not seal rows under it until a later unlock persists.
    }
  }

  // One-time legacy remember migration (no-op without a stash).
  await _migrateLegacyRememberIfPresent();

  // The migrate above is a real IndexedDB-bound await. A forced lock()/reset()
  // (which bypass the op-mutex, bump _abortEpoch, and null all key holders) landing
  // during it must not let the resumed tail flip _isUnlocked over now-null holders.
  // Abort here so isUnlocked() never transiently lies.
  ensureLive(epoch);

  // All identity material is installed — NOW mark unlocked.
  _isUnlocked = true;

  // Drive the coordinator. activateMls is fire-and-forget (synchronous void), so a
  // slow/never-completing MLS activation never keeps the vault locked. Fail-closed:
  // a failure is logged inside activateMls and leaves MLS inactive; it never throws
  // out of unlock (which would mislead the UI into reporting a wrong password).
  // Legacy DMs already work above. The load-bearing reconcileChannelClassifications
  // above stays AWAITED before _isUnlocked flips, so an established MLS channel is
  // classified before the now-usable legacy keys could route a send to legacy.
  const mlsBundle = currentMlsBundle();
  if (mlsBundle) {
    activateMls(mlsBundle, atRestKey, historyKey);
  }
}

/**
 * Passwordless unlock used by Server-recovery silent boot AND Self
 * remember-on-device. Loads the three content keys persisted by
 * deviceContentKeyStore (no Argon2id, no password), fetches the bundle,
 * decrypts the blob with the persisted blobKey, then runs the SHARED install
 * tail so the installed state is identical to a password unlock.
 *
 * Fail-closed (security invariant — NEVER silent plaintext): returns false (the
 * vault stays locked, caller shows the password prompt) when there are no fresh
 * device keys, the bundle fetch fails, or the persisted blobKey can no longer
 * decrypt the current blob (stale after a cross-device password change — clear
 * the device keys so the next boot prompts cleanly).
 */
export function installFromDeviceContentKeys(): Promise<boolean> {
  return withLock(() => _installFromDeviceWrappedContentKeys());
}

async function _installFromDeviceWrappedContentKeys(): Promise<boolean> {
  // Single-flight idempotency: mirror _unlockImpl — a second install that queued
  // behind a successful unlock/install finds us already unlocked and no-ops.
  if (_isUnlocked) return true;
  const epoch = _abortEpoch;

  const { loadContentKeys } = await import('./deviceContentKeyStore');
  const keys = await loadContentKeys();
  if (!keys) return false;
  ensureLive(epoch);

  let bundle;
  try {
    bundle = await apiClient.getDmKeyBundle();
  } catch {
    return false;
  }
  ensureLive(epoch);
  _passwordDerived = bundle.passwordDerived ?? false;

  // Mirror _unlockImpl: reconcile channel classifications BEFORE the vault unlocks
  // (key-free; closes the manual-unlock downgrade window). Never throws out of the
  // install; activate() retries as a steady-state backstop.
  try {
    await mlsCoordinator.reconcileChannelClassifications();
  } catch (err) {
    logger.warn('[mls][dmKeyManager] device-install: classification reconcile failed; activate() will retry', {
      error: (err as Error)?.message,
    });
  }
  ensureLive(epoch);

  // Decrypt the blob with the PERSISTED blobKey (no Argon2id). A failure here means
  // the persisted key no longer matches the server blob — a cross-device password
  // change rotated it. Fail closed: drop the stale device keys and return false so
  // the next boot prompts for the new password instead of silently doing nothing.
  const blobAAD = 'howl:blob:' + bundle.publicKey;
  let blobContents: BlobContents;
  try {
    blobContents = await decryptBlobPacked(bundle.encryptedBlob, keys.blobKey, blobAAD);
  } catch {
    const { clearContentKeys } = await import('./deviceContentKeyStore');
    await clearContentKeys().catch(() => {});
    return false;
  }
  ensureLive(epoch);

  await _installVaultTail({
    blobContents,
    derivedKey: keys.blobKey,
    atRestKey: keys.atRestKey,
    historyKey: keys.historyKey,
    bundle,
    blobAAD,
    epoch,
  });

  // Converge the persisted content-key mode to the authoritative account mode.
  // enablePasswordDerived (Self->Server) does not rotate the blob, so a sibling
  // device remembered in Self still decrypts here; re-stamp it to Server (no-TTL)
  // so it does not expire under the 30-day Self TTL. Best-effort: a persistence
  // hiccup must not fail an otherwise-good unlock.
  const desiredMode = _passwordDerived ? 'server' : 'self';
  if (keys.mode !== desiredMode) {
    await rememberOnDevice().catch(() => {});
  }

  emit('unlocked');
  return true;
}

/**
 * Lock: zero all secrets immediately (FORCED teardown). Bumps the abort epoch
 * so any in-flight mutator bails at its next await without persisting torn
 * state. Bypasses the mutex on purpose — logout/idle-expiry must never be
 * blocked by a slow network op.
 */
export function lock(): void {
  _abortEpoch++;
  zeroFill(_privateKey);
  _privateKey = null;
  zeroFill(_privateSigningKey);
  _privateSigningKey = null;
  _publicKeyBase64 = null;
  _signingPublicKeyBase64 = null;
  _derivedKey = null;
  _liveBlobKey = null;
  _liveAtRestKey = null;
  _liveHistoryKey = null;
  _blobVersion = 0;
  _blobSalt = null;
  _isUnlocked = false;
  zeroFill(_archiveKey);
  _archiveKey = null;
  _archiveKeyVersion = 1;
  _rekeyInProgress = false;

  // Tear down the coordinator (drops the at-rest key + group state) and zero the
  // in-memory MLS identity bytes.
  try {
    mlsCoordinator.deactivate();
  } catch (err) {
    logger.error('[mls][dmKeyManager] lock: coordinator deactivate threw', {
      error: (err as Error)?.message,
    });
  }
  // Clear the main-thread at-rest key on teardown so decryption capability does
  // not survive lock/logout on the worker path (the worker scrubs its own clone
  // via core.deactivate; deactivate() above does NOT touch the main-thread store
  // when the worker owns crypto).
  mlsGroupStore.setAtRestKey(null);
  mlsGroupStore.setHistoryKey(null);
  clearMlsState();

  // The DM search index (AES-GCM ciphertext at rest) is deleted with the keys as
  // defense-in-depth (a key-scrub should not leave a history a same-user re-login
  // could resurrect). lock() is the single chokepoint every scrub-for-good path
  // funnels through: session-end (lockEncryptionForSessionEnd), idle auto-lock
  // (requestIdleLock), and full sign-out / in-app encryption-reset (reset()) — the
  // latter two do NOT route through cleanupSession, so deleting the index here is
  // what closes those paths. The index is rebuildable from messages on the next
  // unlock. Dynamic import avoids a core->feature static cycle (matches the
  // history-sync teardowns in requestIdleLock/reset).
  void import('./dmSearchIndex').then((m) => m.teardownSearchIndexForSessionEnd()).catch(() => undefined);

  emit('locked');
}

/**
 * Cooperative lock for the idle-timer: unlike lock(), this DRAINS the mutex first,
 * so it can never zeroize a buffer that an in-flight operation (e.g. group create)
 * still reads after an await. Used only by the idle auto-lock timer, where the user
 * merely stepped away — there is no need to win a race, only to avoid corrupting an
 * operation in progress.
 */
export function requestIdleLock(): Promise<void> {
  return withLock(async () => {
    if (!_isUnlocked) return;
    lock();
    // Idle-lock is a RE-UNLOCKABLE teardown (unlike logout, which routes through
    // cleanupSession→stopHistorySync). Stop the history syncer here too, so the
    // sync lease is released (another tab can take over) AND _active is reset —
    // otherwise startHistorySync on the next unlock early-returns and never
    // re-acquires the lease, leaving this tab permanently lease-less. Reset the
    // restore dedupe so a re-unlock re-runs eager/lazy restore. Dynamic-imported to
    // avoid a static cycle (the syncer imports this module).
    void import('./mls/mlsHistoryArchiveSync').then((m) => m.stopHistorySync()).catch(() => undefined);
    void import('./mls/mlsHistoryRestore').then((m) => m.resetHistoryRestore()).catch(() => undefined);
    // (The DM search index is torn down inside lock() above — the single
    // chokepoint every scrub-for-good path funnels through.)
  });
}

/** The stable archive key bytes, or null when locked. Returns the LIVE module
 *  reference (not a copy) by design: the upload syncer compares the returned
 *  value by identity to detect an in-session key change (abort-not-skip), so a
 *  per-call copy would break that interlock. Callers MUST treat it as borrowed —
 *  never mutate/zeroize it, and never retain it past a lock() (which zeroizes it
 *  in place). Use it immediately (e.g. importKey) and re-fetch each cycle. */
export function getArchiveKey(): Uint8Array | null {
  return _archiveKey;
}

/** Current archiveKey generation (1 = original). The history syncer stamps this
 *  onto each uploaded row's keyVersion. */
export function getArchiveKeyVersion(): number {
  return _archiveKeyVersion;
}

/** True when the live archiveKey is durably persisted in the server blob. The
 *  history-archive upload syncer gates on this so it never seals rows under a
 *  freshly-minted key whose re-persist failed (which the next unlock would orphan). */
export function isArchiveKeyPersisted(): boolean {
  return _archiveKey !== null && _archiveKeyPersisted;
}


/** True while an in-session at-rest/history rekey is mid-flight. */
export function isRekeyInProgress(): boolean {
  return _rekeyInProgress;
}

interface VoiceJoinBlob {
  v: 1;
  channelId: string;
  joinTimestamp: number;
  pub: string;
  sigPub: string;
}

export function signVoiceJoinBlob(channelId: string, joinTimestamp: number): {
  blob: VoiceJoinBlob;
  signature: string;
} | null {
  if (!_privateSigningKey || !_publicKeyBase64 || !_signingPublicKeyBase64) return null;
  const blob: VoiceJoinBlob = {
    v: 1,
    channelId,
    joinTimestamp,
    pub: _publicKeyBase64,
    sigPub: _signingPublicKeyBase64,
  };
  const enc = new TextEncoder().encode(JSON.stringify(blob));
  const bytes = new Uint8Array(enc.buffer, enc.byteOffset, enc.byteLength);
  const sig = nacl.sign.detached(bytes, _privateSigningKey);
  return { blob, signature: toBase64(sig) };
}

export function verifyVoiceJoinBlob(
  blob: VoiceJoinBlob,
  signatureB64: string,
  trustedSigPubB64: string,
): boolean {
  try {
    // Verify only against the caller-supplied trusted key (the peer's pinned
    // AIK). No fallback to the self-declared `blob.sigPub` or a server-supplied
    // key — either would let a key the server controls hijack election. The
    // trusted key must also equal `blob.sigPub`, rejecting a substituted key.
    if (!trustedSigPubB64 || blob.sigPub !== trustedSigPubB64) return false;
    const enc = new TextEncoder().encode(JSON.stringify(blob));
    const bytes = new Uint8Array(enc.buffer, enc.byteOffset, enc.byteLength);
    return nacl.sign.detached.verify(bytes, fromBase64(signatureB64), fromBase64(trustedSigPubB64));
  } catch {
    return false;
  }
}

/** Stage host attestation: binds the host's X25519 wrap key (`pub`) and AIK
 *  (`sigPub`) to a channel, signed by the AIK, so the audience verifies the key
 *  distributor against a pinned AIK rather than the server-attested host. */
interface StageHostBlob {
  v: 1;
  channelId: string;
  pub: string;
  sigPub: string;
}

export function signStageHostBlob(channelId: string): {
  blob: StageHostBlob;
  signature: string;
} | null {
  if (!_privateSigningKey || !_publicKeyBase64 || !_signingPublicKeyBase64) return null;
  const blob: StageHostBlob = {
    v: 1,
    channelId,
    pub: _publicKeyBase64,
    sigPub: _signingPublicKeyBase64,
  };
  const enc = new TextEncoder().encode(JSON.stringify(blob));
  const bytes = new Uint8Array(enc.buffer, enc.byteOffset, enc.byteLength);
  const sig = nacl.sign.detached(bytes, _privateSigningKey);
  return { blob, signature: toBase64(sig) };
}

export function verifyStageHostBlob(
  blob: StageHostBlob,
  signatureB64: string,
  trustedSigPubB64: string,
): boolean {
  try {
    // Verify only against the caller-supplied trusted key (the host's pinned
    // AIK); the trusted key must equal `blob.sigPub`, so a server-substituted
    // host key is rejected. Same discipline as voice join-blobs.
    if (!trustedSigPubB64 || blob.sigPub !== trustedSigPubB64) return false;
    const enc = new TextEncoder().encode(JSON.stringify(blob));
    const bytes = new Uint8Array(enc.buffer, enc.byteOffset, enc.byteLength);
    return nacl.sign.detached.verify(bytes, fromBase64(signatureB64), fromBase64(trustedSigPubB64));
  } catch {
    return false;
  }
}

/**
 * Change DM password: decrypt blob with old, re-encrypt with new.
 * Returns the new recovery key so the caller can display it to the user.
 */
export function changePassword(oldPassword: string, newPassword: string): Promise<{ recoveryKey: string }> {
  return withLock(() => _changePasswordImpl(oldPassword, newPassword));
}

async function _changePasswordImpl(oldPassword: string, newPassword: string): Promise<{ recoveryKey: string }> {
  if (!_blobSalt) throw new Error('Not unlocked');
  const epoch = _abortEpoch;

  // Verify old password by decrypting
  const bundle = await apiClient.getDmKeyBundle();
  ensureLive(epoch);
  const blobAAD = 'howl:blob:' + bundle.publicKey;
  const oldSalt = fromBase64(bundle.blobSalt);
  const { blobKey: oldKey } = await deriveUnlockMaterial(oldPassword, oldSalt);
  const contents = await decryptBlobPacked(bundle.encryptedBlob, oldKey, blobAAD);
  ensureLive(epoch);
  // The blob's own identity must match the server-advertised publicKey.
  if (toBase64(nacl.box.keyPair.fromSecretKey(fromBase64(contents.privateKey)).publicKey) !== bundle.publicKey) {
    throw new VaultIntegrityError();
  }

  // Derive new key material. A single Argon2id pass yields the new blob key AND the
  // new MLS at-rest/history keys (all three HKDF-derived under distinct labels). The
  // at-rest/history keys are exactly what the NEXT unlock will derive, so re-keying
  // the durable stores under them keeps Saved history readable.
  const newSalt = generateSalt();
  const { blobKey: newKey, atRestKey: newAtRest, historyKey: newHistory } = await deriveUnlockMaterial(newPassword, newSalt);
  const newBlob = await encryptBlobPacked(contents, newKey, blobAAD);

  // Generate new recovery key
  const newRecoveryKeyBytes = generateRecoveryKey();
  const { ciphertext: recoveryBlob, nonce: recoveryNonce } = await encryptRecoveryBlob(contents, newRecoveryKeyBytes, recoveryAAD(bundle.publicKey));

  // Re-encrypt the durable MLS at-rest + Saved-history stores from the OLD keys
  // (still installed in the worker/store) to the NEW keys, then adopt the new keys
  // atomically. Without this the salt rotation below would orphan the history
  // archive (the next unlock's new historyKey can't decrypt the old rows). Runs
  // BEFORE the salt/blob persist while the old keys are still in memory. A re-key
  // failure must NOT abort the password change (the blob/recovery rotation is the
  // safety-critical part): log counts/error-name only — never plaintext or keys.
  _rekeyInProgress = true;
  try {
    await mlsCoordinator.rekey(newAtRest, newHistory);
    // Mirror activateMls: keep the main-thread store holders in sync for the
    // fallback path and the sibling auto-recovery read-back.
    mlsGroupStore.setAtRestKey(newAtRest);
    mlsGroupStore.setHistoryKey(newHistory);
  } catch (err) {
    logger.warn('[mls][dmKeyManager] changePassword: MLS re-key failed; Saved history may be orphaned', {
      error: (err as Error)?.name,
    });
  } finally {
    _rekeyInProgress = false;
  }

  // Bespoke persist: this re-encrypts the blob with a NEW key/salt and bundles
  // fresh recovery material, so it cannot route through persistBlob (which
  // always re-encrypts with the current _derivedKey). It serializes under the
  // mutex like every other mutator and bails on a forced teardown via the
  // epoch check above.
  const signingPub = signingPubFromContents(contents);
  const result = await apiClient.changeDmKeysPassword({
    encryptedBlob: newBlob,
    blobSalt: toBase64(newSalt),
    blobVersion: bundle.blobVersion,
    recoveryBlob,
    recoveryNonce,
    recoveryMode: 'key',
    ...(signingPub && { signingPublicKey: signingPub }),
    ...escrowField(),
  });
  ensureLive(epoch);

  _derivedKey = newKey;
  _liveBlobKey = newKey;
  _liveAtRestKey = newAtRest;
  _liveHistoryKey = newHistory;
  _blobSalt = toBase64(newSalt);
  _blobVersion = result.blobVersion;

  // Re-persist the device content keys under the NEW keys after the rekey RPC +
  // blob rotation, so a remembered device isn't orphaned (its old blobKey can no
  // longer decrypt the rotated server blob). No-op if this device was not
  // remembered. Mode is unchanged by a password change (rememberOnDevice reads the
  // live _passwordDerived).
  if (await isRememberedOnDevice()) await rememberOnDevice();

  const formatted = formatRecoveryKey(newRecoveryKeyBytes);
  zeroFill(newRecoveryKeyBytes);
  return { recoveryKey: formatted };
}

/**
 * Recover using recovery key or passphrase. Returns new recovery key after re-setup.
 */
export function recover(recoveryKeyFormatted: string, newPassword: string): Promise<{ recoveryKey: string }> {
  return withLock(() => _recoverImpl(recoveryKeyFormatted, newPassword));
}

async function _recoverImpl(recoveryKeyFormatted: string, newPassword: string): Promise<{ recoveryKey: string }> {
  const epoch = _abortEpoch;
  const bundle = await apiClient.getDmKeyBundle();
  ensureLive(epoch);

  // Derive recovery key bytes depending on mode
  let recoveryKeyBytes: Uint8Array;
  if (bundle.recoveryMode === 'passphrase' && bundle.recoveryPassphraseSalt) {
    // Custom passphrase: derive key via argon2id
    const { argon2id } = await import('hash-wasm');
    recoveryKeyBytes = await argon2id({
      password: recoveryKeyFormatted,
      salt: fromBase64(bundle.recoveryPassphraseSalt),
      parallelism: 1,
      iterations: 3,
      memorySize: 65536,
      hashLength: 32,
      outputType: 'binary',
    });
  } else {
    // Default: parse base32-formatted recovery key
    recoveryKeyBytes = parseRecoveryKey(recoveryKeyFormatted);
  }

  // Decrypt recovery blob. AAD binds it to the server-advertised identity.
  // bundle.publicKey is the source (module _publicKeyBase64 is not yet populated —
  // it is set from contents.privateKey below). An AES-GCM
  // failure here covers BOTH a wrong recovery key AND a tampered/substituted blob;
  // it surfaces as a recovery failure rather than being silently swallowed.
  let contents: BlobContents;
  try {
    contents = await decryptRecoveryBlob(bundle.recoveryBlob, bundle.recoveryNonce, recoveryKeyBytes, recoveryAAD(bundle.publicKey));
  } finally {
    zeroFill(recoveryKeyBytes);
  }

  // Populate legacy state first so buildBlobContents() reflects the recovered
  // legacy identity.
  _privateKey = fromBase64(contents.privateKey);
  _publicKeyBase64 = toBase64(nacl.box.keyPair.fromSecretKey(_privateKey).publicKey);
  if (contents.privateSigningKey) {
    _privateSigningKey = fromBase64(contents.privateSigningKey);
    _signingPublicKeyBase64 = toBase64(nacl.sign.keyPair.fromSecretKey(_privateSigningKey).publicKey);
  }
  loadArchiveKeyFromBlob(contents);
  // Generate if the recovery blob predates the archive. Stamp it into `contents`
  // too, so the escrow re-write (stripMlsForEscrow(contents)) carries it for
  // Server-recovery users — otherwise a later serverRecover() would mint a
  // DIFFERENT key and diverge from encryptedBlob/recoveryBlob. Mirrors _serverRecoverImpl.
  if (!_archiveKey) {
    _archiveKey = crypto.getRandomValues(new Uint8Array(32));
    contents.archiveKey = toBase64(_archiveKey);
  }

  // Per-device identity is handled below: recovery explicitly deletes the old
  // device-local identity so the recovered device re-joins groups as a NEW leaf via
  // External-Commit. Under the persistent device wrap the identity survives the
  // at-rest key rotation, so the delete is required (it is no longer orphaned
  // implicitly).

  // Re-encrypt with new password. The MLS identity is device-local (not in the
  // blob), so the uploaded + recovery blobs carry the legacy core only. Single
  // Argon2id pass yields the new blob key + at-rest key.
  const newSalt = generateSalt();
  const { blobKey: newKey, atRestKey, historyKey } = await deriveUnlockMaterial(newPassword, newSalt);
  const blobAAD = 'howl:blob:' + bundle.publicKey;

  // Revocation: force a fresh device identity on recovery. Under the persistent
  // device wrap the old at-rest-key rotation no longer orphans the prior identity,
  // so delete it (and its KP privates) BEFORE bootstrap load-or-mint - the recovered
  // device re-joins groups as a NEW leaf via External-Commit. Defensive: this MLS
  // section must never throw out of recovery. A failed delete is logged and tolerated.
  try {
    const recoverUserId = await resolveUserId(undefined);
    if (recoverUserId) {
      await mlsGroupStore.deleteIdentity(recoverUserId);
      await mlsGroupStore.deleteAllKpPrivate();
    }
  } catch (err) {
    logger.warn('dmKeyManager: recover() identity revocation delete failed; continuing', {
      error: (err as Error)?.name,
    });
  }

  // Set the NEW at-rest/history keys, then load-or-mint the device identity under
  // them and publish KeyPackages on a fresh mint. Shared with unlock/serverRecover.
  await bootstrapMlsIdentity(atRestKey, historyKey, 'recover');

  const persistedContents = buildBlobContents();
  const newBlob = await encryptBlobPacked(persistedContents, newKey, blobAAD);

  // New recovery key. Always reset recoveryMode to 'key': the new recoveryBlob
  // is encrypted with random 32-byte AES key bytes, not an argon2id-derived
  // passphrase. If we left recoveryMode='passphrase' (from a prior passphrase
  // setup), the next recovery would argon2id the formatted base32 string and
  // produce the wrong key, locking the user out.
  const newRecoveryKeyBytes = generateRecoveryKey();
  const { ciphertext: recoveryBlob, nonce: recoveryNonce } = await encryptRecoveryBlob(persistedContents, newRecoveryKeyBytes, recoveryAAD(bundle.publicKey));

  // Reconcile escrow + passwordDerived through the recovery. A recovery-key recover
  // re-encrypts the blob under a NEW password; for a
  // Server-recovery (password-derived) user the escrow must move with that blob,
  // or it lags the just-recovered contents (dropping any channels added since
  // the last escrow write) and a later account-password server-recover yields a
  // stale blob. The bundle's server-authoritative `passwordDerived` is the
  // source of truth — adopt it, and when set, send the raw blob so the route
  // refreshes escrow in lockstep. Build rawBlobForEscrow from the decrypted
  // `contents` (local state isn't installed yet), MLS-stripped, mirroring
  // serverRecover() — `contents` is the v2 recovery blob carrying the MLS
  // signing private key, which must NEVER reach the server (stripMlsForEscrow).
  const recovered = bundle.passwordDerived ?? false;
  const signingPub = signingPubFromContents(persistedContents);
  const result = await apiClient.recoverDmKeys({
    encryptedBlob: newBlob,
    blobSalt: toBase64(newSalt),
    recoveryBlob,
    recoveryNonce,
    recoveryMode: 'key',
    ...(signingPub && { signingPublicKey: signingPub }),
    ...(recovered && { rawBlobForEscrow: btoa(JSON.stringify(stripMlsForEscrow(contents))) }),
  });
  ensureLive(epoch);
  // The recovered/minted archiveKey is now durably in the re-encrypted server blob.
  _archiveKeyPersisted = true;

  // Identity material was installed above (before buildBlobContents). _isUnlocked
  // flips below after the signing-key restore, preserving install-all-before-flip.
  _derivedKey = newKey;
  _liveBlobKey = newKey;
  _liveAtRestKey = atRestKey;
  _liveHistoryKey = historyKey;
  _blobVersion = result.blobVersion;
  _blobSalt = toBase64(newSalt);
  // Converge the per-tab escrow gate to the bundle's authoritative mode (and
  // broadcast so sibling tabs converge too) before flipping _isUnlocked. Set it
  // before the signing-key restore below so a lazy-generate escrow write reads
  // the recovered mode, not the stale one.
  setPasswordDerived(recovered);
  // Restore (or lazily generate) the Ed25519 signing key, mirroring unlock().
  // Without this the recovered session has _privateSigningKey=null, so
  // signVoiceJoinBlob() returns null, and the FIRST blob write via
  // buildBlobContents() would drop the signing key server-side. The recoveryBlob
  // (decrypted into `contents`) carries privateSigningKey, so the load branch is the
  // live path; the else branch matches unlock() for legacy bundles.
  if (contents.privateSigningKey) {
    _privateSigningKey = fromBase64(contents.privateSigningKey);
    _signingPublicKeyBase64 = toBase64(nacl.sign.keyPair.fromSecretKey(_privateSigningKey).publicKey);
  } else {
    const newSigning = generateSigningKeyPair();
    _privateSigningKey = newSigning.secretKey;
    _signingPublicKeyBase64 = toBase64(newSigning.publicKey);
    try {
      const signingBlob = await encryptBlobPacked(buildBlobContents(), newKey, blobAAD);
      ensureLive(epoch);
      const uploadResult = await apiClient.updateDmKeysSigningKey({
        signingPublicKey: _signingPublicKeyBase64,
        encryptedBlob: signingBlob,
        blobVersion: _blobVersion,
        ...escrowField(),
      });
      ensureLive(epoch);
      _blobVersion = uploadResult.blobVersion;
    } catch (err) {
      if (err instanceof OperationAbortedError) throw err;
      // Transient upload failure is fine — retry on next unlock; local state works.
    }
  }

  // Reconcile channel protocol classifications from the durable IndexedDB group map
  // BEFORE marking the vault unlocked (mirrors _unlockImpl). recover loads the SAME
  // coexistence legacy keys; once _isUnlocked is true they become usable, so
  // isChannelMls() must already be authoritative or a send on an established MLS
  // channel whose localStorage classification was lost would silently route to
  // legacy (forward-secrecy downgrade). Key-free (getGroupIdToChannelMap reads only
  // plaintext ids); never throws out of recover.
  try {
    await mlsCoordinator.reconcileChannelClassifications();
  } catch (err) {
    logger.warn('[mls][dmKeyManager] recover: classification reconcile failed; activate() will retry', {
      error: (err as Error)?.message,
    });
  }
  ensureLive(epoch);

  _isUnlocked = true;

  // Drive the coordinator fail-closed (mirrors unlock). activateMls is
  // fire-and-forget, so a slow MLS activation never blocks recover from resolving.
  const mlsBundle = currentMlsBundle();
  if (mlsBundle) {
    activateMls(mlsBundle, atRestKey, historyKey);
  }

  // A recover runs from a LOCKED vault, so the OLD history key is not in memory and
  // the durable Saved-history rows (encrypted under it) can NEVER be re-keyed to the
  // new historyKey — they are permanently unreadable (a credential-loss event).
  // Purge them so they do not linger as dead rows that masquerade as cache misses;
  // the messages re-decrypt live and re-archive under the new key. The SERVER archive
  // (stable archiveKey) is NOT purged. AWAIT this immediately before emit('unlocked')
  // so any restore triggered off 'unlocked' runs AFTER the local purge committed
  // (otherwise restore races the purge). Swallow errors so it can never disrupt the
  // recovery.
  await mlsGroupStore.clearHistory().catch(() => undefined);

  emit('unlocked');

  // A Self-recovery restored the roaming identity from the recovery blob, which may
  // predate the disable-time identity rotation (deferred during a call). Re-rotate
  // the identity (no history dependency) via the resume machinery so future
  // voice/stage media is not wrapped to an escrow-exposed key. Account-scoped;
  // resumePendingRotation runs it on the next lease-gated mls-ready. Server-recovery
  // users (recovered=true) are intentionally excluded - they remain escrow-readable.
  if (!recovered) {
    try {
      const idUser = await resolveUserId(undefined);
      if (idUser) setPendingIdentityRotation(idUser);
    } catch { /* non-fatal: identity stays as restored until a later move-to-Private */ }
  }

  const formatted = formatRecoveryKey(newRecoveryKeyBytes);
  zeroFill(newRecoveryKeyBytes);
  return { recoveryKey: formatted };
}

/**
 * Regenerate recovery key (or set a custom passphrase).
 * Requires current encryption password for verification.
 */
export function regenerateRecoveryKey(
  password: string,
  customPassphrase?: string,
): Promise<{ recoveryKey: string; mode: 'key' | 'passphrase' }> {
  return withLock(() => _regenerateRecoveryKeyImpl(password, customPassphrase));
}

async function _regenerateRecoveryKeyImpl(
  password: string,
  customPassphrase?: string,
): Promise<{ recoveryKey: string; mode: 'key' | 'passphrase' }> {
  if (!_blobSalt) throw new Error('Not unlocked');
  const epoch = _abortEpoch;

  // Verify password by decrypting current blob
  const bundle = await apiClient.getDmKeyBundle();
  ensureLive(epoch);
  const blobAAD = 'howl:blob:' + bundle.publicKey;
  const salt = fromBase64(bundle.blobSalt);
  const { blobKey: key } = await deriveUnlockMaterial(password, salt);
  const contents = await decryptBlobPacked(bundle.encryptedBlob, key, blobAAD);
  ensureLive(epoch);
  // The blob's own identity must match the server-advertised publicKey.
  if (toBase64(nacl.box.keyPair.fromSecretKey(fromBase64(contents.privateKey)).publicKey) !== bundle.publicKey) {
    throw new VaultIntegrityError();
  }

  let recoveryBlob: string;
  let recoveryNonce: string;
  let mode: 'key' | 'passphrase';
  let recoveryPassphraseSalt: string | undefined;
  let formattedKey = '';

  if (customPassphrase) {
    // Derive raw bytes directly via argon2id (the recovery key needs extractable raw bytes, not a non-extractable CryptoKey)
    const { argon2id } = await import('hash-wasm');
    const passphraseSalt = generateSalt();
    const rawKey = await argon2id({
      password: customPassphrase,
      salt: passphraseSalt,
      parallelism: 1,
      iterations: 3,
      memorySize: 65536,
      hashLength: 32,
      outputType: 'binary',
    });
    const result = await encryptRecoveryBlob(contents, rawKey, recoveryAAD(bundle.publicKey));
    zeroFill(rawKey);
    recoveryBlob = result.ciphertext;
    recoveryNonce = result.nonce;
    mode = 'passphrase';
    recoveryPassphraseSalt = toBase64(passphraseSalt);
  } else {
    // Generate random recovery key
    const newRecoveryKeyBytes = generateRecoveryKey();
    const result = await encryptRecoveryBlob(contents, newRecoveryKeyBytes, recoveryAAD(bundle.publicKey));
    recoveryBlob = result.ciphertext;
    recoveryNonce = result.nonce;
    formattedKey = formatRecoveryKey(newRecoveryKeyBytes);
    zeroFill(newRecoveryKeyBytes);
    mode = 'key';
  }

  const signingPub = signingPubFromContents(contents);
  const apiResult = await apiClient.changeDmKeysPassword({
    encryptedBlob: bundle.encryptedBlob, // blob unchanged — only recovery blob changes
    blobSalt: bundle.blobSalt,
    blobVersion: bundle.blobVersion,
    recoveryBlob,
    recoveryNonce,
    recoveryMode: mode,
    recoveryPassphraseSalt,
    ...(signingPub && { signingPublicKey: signingPub }),
    ...escrowField(),
  });
  ensureLive(epoch);

  _blobVersion = apiResult.blobVersion;
  return { recoveryKey: formattedKey, mode };
}

/**
 * Auto-setup: wraps setup() for seamless first-login key generation.
 * Called automatically after login when no bundle exists.
 */
export async function autoSetup(password: string, userId?: string): Promise<{ recoveryKey: string }> {
  if (_hasBundle) {
    // Already set up — just unlock instead (unlock resolves userId itself).
    await unlock(password);
    return { recoveryKey: '' };
  }
  return setup(password, userId);
}

/**
 * Get the user's public key (derived from private key).
 * Returns null if not unlocked.
 */
export function getPublicKey(): string | null {
  return _publicKeyBase64;
}

/**
 * Create a group DM channel row on the server. New group DMs are MLS-only: no
 * legacy X25519 channel key is generated or delivered here — the MLS Welcome
 * (driven by mlsCoordinator.createGroupDmGroup) is the sole key distribution. We
 * POST WITHOUT encryptedKeys/senderPublicKey, so the server writes no
 * PendingKeyDelivery dead-drops. Returns the same shape as before so
 * dmActions.createGroupDM (which gates MLS creation on `created`) is unchanged.
 *
 * Sending legacy keys here would be unsafe: a recipient who read a legacy
 * dead-drop BEFORE their MLS Welcome drained could send a legacy message the
 * already-MLS creator can't decrypt.
 */
export function createGroupDm(memberIds: string[]): Promise<{
  id: string;
  encrypted: boolean;
  isGroup: true;
  created: boolean;
  ownerId?: string | null;
  otherUsers: Array<{ id: string; username: string; discriminator?: string; avatar?: string; status?: string }>;
}> {
  return withLock(() => _createGroupDmImpl(memberIds));
}

async function _createGroupDmImpl(memberIds: string[]): Promise<{
  id: string;
  encrypted: boolean;
  isGroup: true;
  created: boolean;
  ownerId?: string | null;
  otherUsers: Array<{ id: string; username: string; discriminator?: string; avatar?: string; status?: string }>;
}> {
  if (!_isUnlocked || !_privateKey || !_derivedKey) {
    throw new Error('E2E keys must be unlocked');
  }
  const epoch = _abortEpoch;

  // MLS-only create: no legacy key exchange. The server dedups on the exact
  // member set and returns `created` to distinguish a genuine create (true)
  // from a dedup-to-existing (false); dmActions.createGroupDM gates MLS group
  // creation on that flag. No per-channel key is generated here — MLS group
  // state lives in IndexedDB.
  const resp = await apiClient.createGroupDM(memberIds);
  ensureLive(epoch);

  return {
    id: resp.id,
    encrypted: resp.encrypted,
    isGroup: true,
    created: resp.created === true,
    ownerId: resp.ownerId,
    otherUsers: resp.otherUsers,
  };
}

/**
 * Encrypt a key for a recipient using our private key (nacl.box).
 * Used by voice/stage E2EE for key distribution.
 */
export function encryptKeyForRecipient(
  key: Uint8Array,
  recipientPublicKey: Uint8Array,
): { encrypted: string; nonce: string } | null {
  if (!_privateKey) return null;
  return encryptChannelKeyForRecipient(key, recipientPublicKey, _privateKey);
}

/**
 * Decrypt a key from a sender using our private key (nacl.box).
 * Used by voice/stage E2EE for key receipt.
 */
export function decryptKeyFromSender(
  encrypted: string,
  nonce: string,
  senderPublicKey: string,
): Uint8Array | null {
  if (!_privateKey) return null;
  try {
    return decryptChannelKeyFromDelivery(encrypted, nonce, senderPublicKey, _privateKey);
  } catch {
    return null;
  }
}

// Unlock-on-login Preference
// Per-device preference: should the app prompt for the encryption passphrase
// at login time, or wait until the user actually opens DMs / answers a call?
// Default: true (prompt on login — matches the prior behavior).

const UNLOCK_ON_LOGIN_KEY = 'howl_e2e_unlock_on_login';

/**
 * Read the user's preference for whether to prompt for the encryption
 * passphrase at login time. Defaults to true (prompt on login) when no
 * preference has been set or when localStorage is unavailable.
 */
export function getUnlockOnLogin(): boolean {
  try {
    const v = localStorage.getItem(UNLOCK_ON_LOGIN_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

/**
 * Set the user's preference for whether to prompt for the encryption
 * passphrase at login time. No-ops if localStorage is unavailable.
 *
 * This controls UI only (modal vs. inline locked banner). The decision
 * to actually use a stored device credential at login lives on the
 * separate getAutoUnlockEnabled() flag.
 */
export function setUnlockOnLogin(value: boolean): void {
  try {
    localStorage.setItem(UNLOCK_ON_LOGIN_KEY, value ? '1' : '0');
  } catch {
    /* localStorage unavailable */
  }
}

// Auto-Unlock with Stored Device Credential
// Independent of the modal-vs-inline UI flag (getUnlockOnLogin). When
// false, tryAutoUnlock() short-circuits to false even if a remembered
// credential exists. Useful for users who don't want any silent unlock at
// login regardless of how the prompt is presented.
//
// Default true. Earlier code fell back to getUnlockOnLogin() when this pref
// was unset, on the theory that users who'd opted out of "unlock on login"
// in the pre-split single-toggle world wanted no silent unlock either. That
// migration silently trapped users who'd toggled the old pref off for the
// other reason it controlled (modal vs. inline banner): every reload would
// short-circuit tryAutoUnlock and forgetDevice() the credential they had
// just saved with "Remember on device", so the prompt returned forever.
// Defaulting to true makes "Remember on device" actually stick; users who
// genuinely want no auto-unlock can flip the dedicated toggle in
// Settings → Encryption.

const AUTO_UNLOCK_KEY = 'howl_e2e_auto_unlock';

export function getAutoUnlockEnabled(): boolean {
  try {
    const v = localStorage.getItem(AUTO_UNLOCK_KEY);
    if (v !== null) return v === '1';
    return true;
  } catch {
    return true;
  }
}

export function setAutoUnlockEnabled(value: boolean): void {
  try {
    localStorage.setItem(AUTO_UNLOCK_KEY, value ? '1' : '0');
  } catch {
    /* localStorage unavailable */
  }
  // Disabling auto-unlock implies the stored credential is no longer
  // wanted; clear it so other paths that silently re-save (login with
  // password, encryption setup, etc.) cannot leave a stale wrap that the
  // user thinks is gone.
  if (!value) void forgetDevice();
}

// Remember on Device
// Three at-rest wrapping formats, picked in this priority order:
//
//   e1:  Electron safeStorage (OS keychain). Bound to the OS user account.
//   c1:  Web Crypto AES-GCM with a non-extractable CryptoKey held in IndexedDB.
//        JS code in this origin can *use* the key to decrypt but cannot export
//        the raw bytes, so a localStorage theft alone is inert.
//   w1:  Legacy base64 (btoa). Read path only.
//
// Note: this localStorage stash is no longer WRITTEN by any path (rememberOnDevice
// now persists content keys to deviceContentKeyStore). It is READ once, to migrate
// a pre-deploy "remember" into the content-key store: on the next successful unlock
// the install tail runs _migrateLegacyRememberIfPresent, which persists the live
// content keys and then deletes this stash. There is no in-place re-wrap to
// c1:/e1: anymore.

const REMEMBER_KEY = 'howl_e2e_remember';
const REMEMBER_LAST_USED_KEY = 'howl_e2e_remember_last_used';
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30-day sliding window
const ELECTRON_PREFIX = 'e1:';   // safeStorage-wrapped
const CRYPTOKEY_PREFIX = 'c1:';  // non-extractable CryptoKey (web)
const WEB_PREFIX = 'w1:';        // legacy btoa - read path only

// IndexedDB storage for the non-extractable wrap key
const WRAP_DB_NAME = 'howl_e2e_wrap';
const WRAP_STORE_NAME = 'keys';
const WRAP_KEY_ID = 'wrap_key';

function openWrapDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(WRAP_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(WRAP_STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetKey(): Promise<CryptoKey | null> {
  const db = await openWrapDb();
  try {
    return await new Promise<CryptoKey | null>((resolve, reject) => {
      const tx = db.transaction(WRAP_STORE_NAME, 'readonly');
      const req = tx.objectStore(WRAP_STORE_NAME).get(WRAP_KEY_ID);
      req.onsuccess = () => {
        const v = req.result;
        resolve(v instanceof CryptoKey ? v : null);
      };
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function idbPutKey(key: CryptoKey): Promise<void> {
  const db = await openWrapDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(WRAP_STORE_NAME, 'readwrite');
      tx.objectStore(WRAP_STORE_NAME).put(key, WRAP_KEY_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbDeleteKey(): Promise<void> {
  const db = await openWrapDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(WRAP_STORE_NAME, 'readwrite');
      tx.objectStore(WRAP_STORE_NAME).delete(WRAP_KEY_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function getOrCreateWrapKey(): Promise<CryptoKey> {
  const existing = await idbGetKey().catch(() => null);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable — bytes unreachable from JS
    ['encrypt', 'decrypt'],
  );
  await idbPutKey(key);
  return key;
}

async function cryptoKeyWrap(plain: string): Promise<string> {
  const key = await getOrCreateWrapKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(new TextEncoder().encode(plain)),
  );
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ct), 12);
  return CRYPTOKEY_PREFIX + toBase64(combined);
}

async function cryptoKeyUnwrap(stored: string): Promise<string | null> {
  const key = await idbGetKey().catch(() => null);
  if (!key) return null;
  const combined = fromBase64(stored.slice(CRYPTOKEY_PREFIX.length));
  if (combined.length < 13) return null;
  const iv = combined.subarray(0, 12);
  const ct = combined.subarray(12);
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ct),
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

// The password-stash WRITE path is no longer called now that rememberOnDevice
// persists content keys. Retained as a migration-read-only internal (with its wrap
// helpers) until the legacy stash is deleted wholesale.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function wrapPassword(plain: string): Promise<string> {
  const ss = typeof window !== 'undefined' ? window.electron?.safeStorage : undefined;
  if (ss) {
    try {
      if (await ss.isAvailable()) {
        const ct = await ss.encryptString(plain);
        return ELECTRON_PREFIX + ct;
      }
    } catch { /* fall through */ }
  }
  try {
    return await cryptoKeyWrap(plain);
  } catch {
    // IndexedDB / Web Crypto unavailable (private browsing in some browsers,
    // locked-down environments). Last-resort fallback keeps the feature
    // working but adds no confidentiality vs. the localStorage read itself.
    return WEB_PREFIX + btoa(plain);
  }
}

async function unwrapPassword(stored: string): Promise<string | null> {
  try {
    if (stored.startsWith(ELECTRON_PREFIX)) {
      const ss = typeof window !== 'undefined' ? window.electron?.safeStorage : undefined;
      if (!ss) return null;
      return await ss.decryptString(stored.slice(ELECTRON_PREFIX.length));
    }
    if (stored.startsWith(CRYPTOKEY_PREFIX)) {
      return await cryptoKeyUnwrap(stored);
    }
    if (stored.startsWith(WEB_PREFIX)) {
      return atob(stored.slice(WEB_PREFIX.length));
    }
    // Legacy (pre-prefix) — plain btoa.
    return atob(stored);
  } catch {
    return null;
  }
}

/**
 * Reads the wrapped remembered passphrase iff it is still within the
 * 30-day sliding window. Handles migration from the pre-TTL format by
 * stamping "now" when a passphrase exists with no timestamp — pre-upgrade
 * users keep their remembered credential and get a fresh window.
 */
function readRememberedIfFresh(): string | null {
  try {
    const saved = localStorage.getItem(REMEMBER_KEY);
    if (!saved) return null;
    const lastUsedRaw = localStorage.getItem(REMEMBER_LAST_USED_KEY);
    if (!lastUsedRaw) {
      // Migration from pre-sliding-window format — stamp now so the
      // 30-day window starts from this first post-upgrade check.
      try { localStorage.setItem(REMEMBER_LAST_USED_KEY, String(Date.now())); }
      catch { /* storage unavailable */ }
      return saved;
    }
    const lastUsed = Number(lastUsedRaw);
    if (!Number.isFinite(lastUsed) || lastUsed <= 0) return null;
    if (Date.now() - lastUsed > REMEMBER_TTL_MS) return null;
    return saved;
  } catch {
    return null;
  }
}

/**
 * Persist the CURRENT live content keys on this device so a future boot can
 * install the vault passwordless. The `_password` parameter is retained
 * for call-site compatibility (callers still pass it) but is no longer used: we
 * persist the non-extractable content keys directly, never the password. Self
 * mode (opt-in) gets the 30-day sliding TTL; Server mode (passwordDerived) is
 * always-on with no TTL.
 */
export async function rememberOnDevice(_password?: string): Promise<void> {
  if (!_liveBlobKey || !_liveAtRestKey || !_liveHistoryKey) return; // not unlocked
  const { putContentKeys } = await import('./deviceContentKeyStore');
  await putContentKeys({
    blobKey: _liveBlobKey,
    atRestKey: _liveAtRestKey,
    historyKey: _liveHistoryKey,
    mode: _passwordDerived ? 'server' : 'self',
  });
}

/**
 * One-time legacy localStorage->device migration. If a legacy wrapped-password
 * stash exists (the user opted into "remember" before this deploy), persist the
 * LIVE content keys to the new device store (write-new), VERIFY by readback, and
 * only THEN delete the localStorage entries (+ the wrap CryptoKey, regardless of
 * c1:/e1:/w1: prefix). A crash between write and delete preserves the credential
 * (the content keys are already persisted; a future forgetDevice() still clears
 * both). Runs inside the caller's op/lock. Best-effort: never throws out of the
 * install tail.
 */
async function _migrateLegacyRememberIfPresent(): Promise<void> {
  let legacy: string | null;
  try { legacy = localStorage.getItem(REMEMBER_KEY); } catch { return; }
  if (!legacy) return;
  if (!_liveBlobKey || !_liveAtRestKey || !_liveHistoryKey) return;
  try {
    const { putContentKeys, hasFreshContentKeys } = await import('./deviceContentKeyStore');
    // Write-new: persist under the live mode (server iff passwordDerived).
    await putContentKeys({
      blobKey: _liveBlobKey,
      atRestKey: _liveAtRestKey,
      historyKey: _liveHistoryKey,
      mode: _passwordDerived ? 'server' : 'self',
    });
    // Verify-readback BEFORE deleting the old stash (avoids a delete/write race).
    if (!(await hasFreshContentKeys())) return; // write didn't land - keep the legacy stash.
    // Delete-old: localStorage entries + the legacy wrap CryptoKey.
    try {
      localStorage.removeItem(REMEMBER_KEY);
      localStorage.removeItem(REMEMBER_LAST_USED_KEY);
    } catch { /* crash between write+delete is safe: content keys already persisted */ }
    idbDeleteKey().catch(() => {});
  } catch (err) {
    logger.warn('[e2e][content-keys] legacy remember migration failed; legacy stash retained', {
      error: (err as Error)?.message,
    });
  }
}

export async function forgetDevice(): Promise<void> {
  // Clear the device content-key store (the new mechanism)...
  const { clearContentKeys } = await import('./deviceContentKeyStore');
  await clearContentKeys().catch(() => {});
  // ...and tear down the LEGACY localStorage password stash + its wrap key, so a
  // forget after a partial migration leaves nothing behind. Branches the
  // c1:/e1:/w1: prefix implicitly via idbDeleteKey (the wrap CryptoKey) +
  // removeItem (the ciphertext, regardless of prefix).
  try {
    localStorage.removeItem(REMEMBER_KEY);
    localStorage.removeItem(REMEMBER_LAST_USED_KEY);
  } catch { /* localStorage unavailable */ }
  idbDeleteKey().catch(() => {});
}

export async function isRememberedOnDevice(): Promise<boolean> {
  const { hasFreshContentKeys } = await import('./deviceContentKeyStore');
  if (await hasFreshContentKeys()) return true;
  // Migration window: a legacy localStorage stash still counts as "remembered"
  // until the first-unlock migration converts it.
  return readRememberedIfFresh() !== null;
}

export async function tryAutoUnlock(): Promise<boolean> {
  try {
    if (!getAutoUnlockEnabled()) {
      // Opted out - clear BOTH the new device content keys and any legacy stash
      // so a future re-enable starts fresh.
      void forgetDevice();
      return false;
    }

    // Primary path - install from the device content-key store (no password
    // needed). Serves Self auto-unlock AND Server silent boot. Fail-closed: a false
    // here degrades to the prompt (never silent plaintext).
    const installed = await installFromDeviceContentKeys();
    if (installed) return true;

    // Legacy fallback: a device that stored the wrapped PASSWORD before this
    // deploy and has not yet migrated. Unwrap + unlock; the unlock's install
    // tail runs _migrateLegacyRememberIfPresent, converting the stash.
    const saved = readRememberedIfFresh();
    if (!saved) {
      if (localStorage.getItem(REMEMBER_KEY)) void forgetDevice();
      return false;
    }
    const password = await unwrapPassword(saved);
    if (!password) { void forgetDevice(); return false; }
    try {
      await unlock(password);
    } catch (err) {
      // Only wipe the stored credential on a genuine decrypt failure (wrong or
      // changed password). A transient error (network / 5xx at getDmKeyBundle)
      // must NOT force the user to re-type, so those leave the legacy stash intact.
      const errName = (err as { name?: string })?.name ?? '';
      const errMsg = (err as { message?: string })?.message ?? '';
      const isDecryptFailure =
        errName === 'OperationError' ||
        /decrypt|invalid key|bad key|authentication/i.test(errMsg);
      if (isDecryptFailure) void forgetDevice();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Enable password-derived mode. Sends current raw blob contents
 * to the server for escrow encryption. Requires the key manager to be unlocked.
 */
export function enablePasswordDerived(): Promise<void> {
  return withLock(() => _enablePasswordDerivedImpl());
}

async function _enablePasswordDerivedImpl(): Promise<void> {
  if (!_isUnlocked || !_privateKey) {
    throw new Error('E2E keys must be unlocked to enable password-derived mode');
  }
  const epoch = _abortEpoch;
  const rawBlobForEscrow = getRawBlobForEscrow();
  await apiClient.enablePasswordDerived({ rawBlobForEscrow });
  ensureLive(epoch);
  // Converge sibling tabs' escrow gate to the new mode.
  setPasswordDerived(true);
  // Clear any owed identity rotation. Re-enabling Server recovery makes it moot
  // (and _rotateRoamingIdentityImpl refuses to run while passwordDerived), so a
  // leftover flag (e.g. set by a prior Self recover()) would make every resume throw.
  setPendingIdentityRotation(null);
  // Self->Server - if this device is remembered, re-persist the content keys in
  // SERVER (always-on, no-TTL) mode. _passwordDerived is now true, so
  // rememberOnDevice picks 'server'. No-op if not remembered.
  if (await isRememberedOnDevice()) await rememberOnDevice();
}

/**
 * Disable password-derived mode. Re-encrypts the blob with the given
 * passphrase so the user's E2E key becomes independent of their account
 * password, then tells the server to delete the escrow blob.
 */
export function disablePasswordDerived(newPassphrase: string, userId: string): Promise<{ recoveryKey: string }> {
  return withLock(() => _disablePasswordDerivedImpl(newPassphrase, userId));
}

/**
 * The destructive server-archive resync. Clears the server archive (rows sealed
 * under the leaked old key) and re-arms the local rows so the syncer
 * re-seals/re-uploads them under the rotated key at keyVersion=2. MUST run only when
 * (a) the rotated archiveKey is already durable at v2 in BOTH the main and recovery
 * blobs (the disable-time atomic recovery-blob rebuild guarantees this) and (b) this
 * tab holds the single-holder history-sync lease (only it can drain the re-upload).
 * Idempotent: a re-run just re-deletes (now empty) and re-arms. Quiesces the upload
 * syncer across the window. Passes the rotated generation to the DELETE so the server
 * raises its per-user minimum-acceptable keyVersion floor (rejects stale re-uploads).
 */
async function _resyncServerArchive(epoch: number): Promise<void> {
  // Enumerate the SERVER-AUTHORITATIVE active-channel set BEFORE the wipe. previews is
  // uncapped (cursor-paginated) + excludes channels the user has left, and is read from
  // the server - unlike the client DM store, which is capped at 50 and can be empty before
  // it loads. Scoping the re-arm to this set re-uploads exactly the channels the user is
  // still in: a left channel is never re-sent (the server 403s a non-participant write,
  // all-or-nothing, wedging the batch) and NO active channel is missed (which would lose
  // its server history to the bulk delete with no re-upload). A network failure THROWS so
  // the caller leaves the resync owed rather than wiping with an empty/partial set.
  const activeIds = await (await import('./mls/mlsHistoryRestore')).getActiveArchiveChannelIds();
  ensureLive(epoch);
  // Quiesce the syncer across the re-arm->delete window: eligible() pauses on
  // isRekeyInProgress(), so no concurrent drain re-uploads mid-rotation. Cleared in
  // finally BEFORE the re-seal drain so the drain (which re-seals under v2) can run.
  _rekeyInProgress = true;
  try {
    // Re-arm BEFORE the delete: a crash after this leaves the active rows synced=0, so the
    // normal upload syncer re-seals + re-uploads them under the new key (superseding the
    // old-key rows server-side) even if the bulk delete never runs - no history-loss
    // window. The disabling device restored the full active archive under the OLD key
    // before minting, so every active row is present locally to re-seal.
    await mlsGroupStore.markAllHistoryUnsynced(activeIds);
    ensureLive(epoch);
    // Clear the old-key rows + raise the per-user floor. (Active rows are additionally
    // superseded by the re-upload above; the delete also removes left-channel old-key
    // rows, which the re-upload deliberately does not re-send.)
    await apiClient.deleteDmHistoryArchive(_archiveKeyVersion);
    ensureLive(epoch);
  } finally {
    _rekeyInProgress = false;
  }
  void import('./mls/mlsHistoryArchiveSync').then((m) => m.drainHistoryNow());
}

/**
 * Roaming-identity rotation. MUST run only after setPasswordDerived(false). Mints
 * fresh X25519 box + Ed25519 sign keypairs,
 * updates the in-memory PUBLIC halves FIRST (so getBlobAAD() binds the new pub),
 * re-seals the blob under the new AAD, and publishes the new public keys + blob
 * atomically. No media impact: the X25519 key is used only at key-wrap time and
 * live SFrame session keys are already held. Clears the pending flag on success.
 * Single-flighted across tabs by a dedicated cross-tab lock, and re-reads the durable
 * pending flag inside it so a sibling that already rotated is not followed by a second
 * divergent publish. `userId` is the owning account (callers gate on its flag first).
 */
async function _rotateRoamingIdentityImpl(epoch: number, userId: string): Promise<void> {
  if (!_isUnlocked || !_derivedKey || !_privateKey) throw new Error('Cannot rotate identity while locked');
  if (_passwordDerived) throw new Error('Refusing identity rotation while passwordDerived=true (would re-escrow)');

  await withIdentityRotationLock(async () => {
    // Re-read the DURABLE pending flag inside the cross-tab lock: a sibling tab may have
    // completed the rotation (and cleared the flag) while we raced for the lock. Bail if
    // so, so we never publish a SECOND fresh identity that diverges from the server's.
    if (readPendingIdentityRotation() !== userId) return;

    const box = generateKeyPair();
    const sign = generateSigningKeyPair();

    // Stash the OLD identity; do NOT zeroize yet. Swap in the NEW identity so the blob
    // is sealed + published under the new pubkey AAD. The PUT /roaming-identity below is
    // the ONLY write that updates the durable server publicKey column, so until it
    // succeeds the durable identity is still OLD: keep the OLD private keys live for the
    // rollback path.
    const oldPriv = _privateKey!;
    const oldSign = _privateSigningKey;
    const oldPub = _publicKeyBase64;
    const oldSigPub = _signingPublicKeyBase64;
    _privateKey = box.secretKey;
    _publicKeyBase64 = toBase64(box.publicKey);
    _privateSigningKey = sign.secretKey;
    _signingPublicKeyBase64 = toBase64(sign.publicKey);

    try {
      // Build the rotation attestation so peers can FOLLOW this AIK rotation forward
      // instead of stranding (the incident). The link is signed under the OLD AIK
      // (oldSign), the head under the NEW AIK (sign.secretKey); seq extends the server's
      // current head by one. A genesis install (no prior AIK) emits no link — peers
      // simply TOFU-pin the new key. If the chain fetch fails we abort (the outer catch
      // rolls back); never rotate the column without its reaching link.
      let attestation: { aikRotation: ReturnType<typeof signRotationLink>; aikHead: ReturnType<typeof signRotationHead> } | undefined;
      if (oldSigPub && oldSign) {
        const { head: chainHead } = await apiClient.getAikChain(userId);
        ensureLive(epoch);
        const seq = (chainHead?.seq ?? 0) + 1;
        const newAikPub = sign.publicKey;
        attestation = {
          aikRotation: signRotationLink({ userId, seq, oldAikPub: fromBase64(oldSigPub), newAikPub, oldAikPriv: oldSign }),
          aikHead: signRotationHead({ userId, seq, aikPub: newAikPub, aikPriv: sign.secretKey }),
        };
      }

      // Re-seal under the NEW AAD and publish, with a bounded 409 retry that refetches
      // the version and retries with the SAME new identity (NOT reconcile, which would
      // reload the OLD identity from the server blob).
      for (let attempt = 0; ; attempt++) {
        ensureLive(epoch);
        const encryptedBlob = await encryptBlobPacked(buildBlobContents(), _derivedKey!, getBlobAAD());
        ensureLive(epoch);
        try {
          const res = await apiClient.updateDmKeysRoamingIdentity({
            publicKey: _publicKeyBase64!,
            signingPublicKey: _signingPublicKeyBase64!,
            encryptedBlob,
            blobVersion: _blobVersion,
            ...escrowField(),
            ...attestation,
          });
          ensureLive(epoch);
          _blobVersion = res.blobVersion;
          break;
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status !== 409 || attempt >= 3) throw err;
          const bundle = await apiClient.getDmKeyBundle();
          ensureLive(epoch);
          // Abandon if another device already rotated the AIK: our predecessor
          // (oldSigPub) no longer matches the column, so the CAS can never win.
          // Re-throw (the outer catch rolls back to OLD); the next unlock adopts the
          // winner's identity from the blob and re-fires the rotation from the new
          // predecessor — no link-less column write, no wasted retries.
          if (attestation && oldSigPub && bundle.signingPublicKey && bundle.signingPublicKey !== oldSigPub) {
            throw err;
          }
          _blobVersion = bundle.blobVersion;
        }
      }
    } catch (err) {
      // Failed publish: the durable identity (publicKey column + blob) is unchanged, so
      // roll the in-memory identity back to OLD (getBlobAAD() then matches the column and
      // the disable tail's _rebuildRecoveryBlob re-seals under OLD-pub). Zeroize the
      // never-published fresh private keys (they protected nothing) before restoring, so
      // a failed rotation does not leave unreferenced key bytes in the heap - matching
      // the success-path zeroize discipline below.
      zeroFill(box.secretKey);
      zeroFill(sign.secretKey);
      _privateKey = oldPriv;
      _publicKeyBase64 = oldPub;
      _privateSigningKey = oldSign;
      _signingPublicKeyBase64 = oldSigPub;
      throw err;
    }

    // Publish succeeded: NOW it is safe to retire the old private keys.
    zeroFill(oldPriv);
    zeroFill(oldSign);
    setPendingIdentityRotation(null);

    // Converge this device's MLS credential onto the rotated AIK. The PUT above swapped
    // the Ed25519 AIK (and the DmKeyBundle.signingPublicKey column), but this device's
    // MLS credential + already-published KeyPackages are still cross-signed under the
    // OLD AIK. The publish gate pins each KeyPackage's embedded AIK to the column, so
    // without this step every package mismatches the new column, the pool drains, and
    // GET /mls/keypackages 404s account-wide ("Encryption is still loading"). Null the
    // stale credential and re-cross-sign + republish this device's KeyPackages under the
    // new AIK (crossSignAndPublishLocalIdentity), under the provision lock so it
    // serializes with the boot provisioner. Skipped when MLS is not loaded this session
    // (no leaf in memory) — a later unlock heals it via loadOrMintLocalIdentity's
    // AIK-divergence check.
    //
    // Failure handling: crossSignAndPublishLocalIdentity PERSISTS the re-cross-signed
    // credential BEFORE the network republish, so a publish failure would otherwise leave
    // a VALID new-AIK credential on disk whose embedded AIK already MATCHES the blob — the
    // next unlock's AIK-divergence heal would NOT fire (no divergence) and the republish
    // would never retry until the next app boot's provisioner. To keep the next-unlock
    // self-heal honest, reset the device-local record to leaf-only on failure: the next
    // unlock's loadOrMintLocalIdentity null-credential path then re-cross-signs +
    // republishes the FULL KeyPackage batch under the new AIK. In-memory
    // _mlsCredentialIdentity is intentionally left as the valid credential so MLS stays
    // active this session (only the published pool is short until the next unlock). All
    // best-effort — even if the reset itself fails, the boot provisioner's unconditional
    // last-resort rotation republishes under the new AIK on the next launch.
    try {
      await withProvisionLock(async () => {
        if (!_mlsSignaturePublicKey || !_mlsSignaturePrivateKey || !_deviceId) return;
        _mlsCredentialIdentity = null;
        await crossSignAndPublishLocalIdentity(userId);
      });
    } catch (err) {
      logger.warn('[mls][dmKeyManager] identity rotation: MLS credential re-cross-sign/republish failed; resetting device-local identity to leaf-only so the next unlock republishes', {
        error: (err as Error)?.name,
      });
      try {
        if (_mlsSignaturePublicKey && _mlsSignaturePrivateKey && _deviceId) {
          await mlsGroupStore.putIdentity(
            userId, _deviceId, _mlsSignaturePublicKey, _mlsSignaturePrivateKey, new Uint8Array(0),
          );
        }
      } catch { /* best-effort: the boot provisioner's last-resort rotation still heals */ }
    }
  });
}

/**
 * The recovery blob built earlier still carries the PRE-rotation archiveKey +
 * identity. Rebuild it from the now-rotated in-memory contents and
 * re-upload (reusing the changeDmKeysPassword CAS) so a future Self-mode recover()
 * restores the v2 archiveKey - matching the re-sealed server archive, else recovery
 * loses history - and the rotated identity. Bounded 409 refetch-retry. Caller wraps
 * best-effort so a failure never swallows the recovery key.
 */
async function _rebuildRecoveryBlob(epoch: number, recoveryKeyBytes: Uint8Array): Promise<void> {
  if (!_derivedKey || !_blobSalt) throw new Error('Cannot rebuild recovery blob while locked');
  for (let attempt = 0; ; attempt++) {
    ensureLive(epoch);
    const contents = buildBlobContents();
    const encryptedBlob = await encryptBlobPacked(contents, _derivedKey, getBlobAAD());
    const { ciphertext: recoveryBlob, nonce: recoveryNonce } = await encryptRecoveryBlob(contents, recoveryKeyBytes, recoveryAAD(_publicKeyBase64!));
    ensureLive(epoch);
    const signingPub = signingPubFromContents(contents);
    try {
      const res = await apiClient.changeDmKeysPassword({
        encryptedBlob,
        blobSalt: _blobSalt,
        blobVersion: _blobVersion,
        recoveryBlob,
        recoveryNonce,
        recoveryMode: 'key',
        ...(signingPub && { signingPublicKey: signingPub }),
        ...escrowField(),
      });
      ensureLive(epoch);
      _blobVersion = res.blobVersion;
      return;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 409 || attempt >= 3) throw err;
      const bundle = await apiClient.getDmKeyBundle();
      ensureLive(epoch);
      _blobVersion = bundle.blobVersion;
    }
  }
}

/**
 * Crash-resume for a deferred or interrupted identity/archive rotation. Called on
 * the lease-holding tab once MLS is ready (and on voice/stage call-end). Completes
 * any rotation phase that did not finish. Idempotent and safe to call when nothing
 * is pending.
 */
export function resumePendingRotation(userId: string): Promise<void> {
  return withLock(() => _resumePendingRotationImpl(userId));
}

async function _resumePendingRotationImpl(userId: string): Promise<void> {
  if (!_isUnlocked || !_derivedKey) return;
  const epoch = _abortEpoch;

  // Archive resync: complete the destructive server-archive resync owed by a prior
  // disable. Gated on a userId MATCH so a crash-orphaned flag from a DIFFERENT account
  // on this origin is left intact for IT to resume. The resync re-uploads history under
  // the rotated key, so it runs ONLY on a tab that BOTH holds the single-holder lease
  // AND already has the rotated key in memory at v2 (the disabling tab that minted it,
  // or the same tab re-unlocked with the new passphrase). Resume NEVER mints v2 (that
  // needs the ephemeral recovery key, to bring the recovery blob to v2 atomically). A
  // stale sibling tab (older passphrase -> cannot even decrypt the new blob, so it can
  // never reach v2) must NOT seal under its old key: it releases the lease instead (the
  // syncer's drain fail-closes on the broadcast generation and releases), letting the
  // v2-capable disabling tab acquire the lease and finish the resync here.
  if (_pendingArchiveResync === userId) {
    // Best-effort: a transient failure (5xx/offline/abort) must not become an unhandled
    // rejection at the bare void resumePendingRotation() call sites, nor block the
    // identity rotation below. The flag is left set on failure, so a later safe boot
    // (or the lease holder) retries.
    try {
      if (hasHistorySyncLease() && _archiveKeyVersion >= 2) {
        await _resyncServerArchive(epoch);
        ensureLive(epoch);
        setPendingArchiveResync(null);
      }
    } catch (err) {
      logger.warn('[mls][dmKeyManager] resume: archive resync failed; will retry on next safe boot', { error: (err as Error)?.name });
    }
  }

  // Identity rotation: run when pending for THIS account and the user is NOT in a
  // voice/stage session. Stays deferred (flag set) until a safe moment otherwise.
  if (_pendingIdentityRotation === userId && !isVoiceSessionActive(userId)) {
    // Best-effort: same rationale as the archive phase. The rotation impl leaves the
    // pending flag set on failure, so do not clear it here.
    try {
      await _rotateRoamingIdentityImpl(epoch, userId);
      ensureLive(epoch);
    } catch (err) {
      logger.warn('[mls][dmKeyManager] resume: identity rotation failed; will retry on next safe boot', { error: (err as Error)?.name });
    }
  }
}

async function _disablePasswordDerivedImpl(newPassphrase: string, userId: string): Promise<{ recoveryKey: string }> {
  if (!_isUnlocked || !_privateKey || !_derivedKey) {
    throw new Error('E2E keys must be unlocked to disable password-derived mode');
  }
  const epoch = _abortEpoch;

  // Build fresh blob contents from current in-memory state
  const contents = buildBlobContents();

  // Re-encrypt with the new passphrase (clean break from account password). Single
  // Argon2id pass yields the new blob key + MLS at-rest/history keys (all three
  // HKDF-derived under distinct labels).
  const newSalt = generateSalt();
  const { blobKey: newKey, atRestKey: newAtRest, historyKey: newHistory } = await deriveUnlockMaterial(newPassphrase, newSalt);
  const newBlob = await encryptBlobPacked(contents, newKey, getBlobAAD());

  // Generate fresh recovery key
  const newRecoveryKeyBytes = generateRecoveryKey();
  const { ciphertext: recoveryBlob, nonce: recoveryNonce } = await encryptRecoveryBlob(contents, newRecoveryKeyBytes, recoveryAAD(_publicKeyBase64!));

  // Re-key the durable MLS at-rest + Saved-history stores OLD -> NEW (the old keys
  // are still installed) so the salt rotation below does not orphan the history
  // archive. Failure is non-fatal to the passphrase change (log name only).
  _rekeyInProgress = true;
  try {
    await mlsCoordinator.rekey(newAtRest, newHistory);
    mlsGroupStore.setAtRestKey(newAtRest);
    mlsGroupStore.setHistoryKey(newHistory);
  } catch (err) {
    logger.warn('[mls][dmKeyManager] disablePasswordDerived: MLS re-key failed; Saved history may be orphaned', {
      error: (err as Error)?.name,
    });
  } finally {
    _rekeyInProgress = false;
  }

  // Fetch current bundle for blobVersion
  const bundle = await apiClient.getDmKeyBundle();
  ensureLive(epoch);

  // Step 1: upload the re-encrypted blob + recovery key BEFORE disabling escrow,
  // so there is no gap where the user has neither escrow nor a valid blob. The
  // escrow refresh still fires here (escrowField() sees _passwordDerived === true)
  // so escrow stays in lockstep with the new-passphrase blob.
  const signingPub = signingPubFromContents(contents);
  const result = await apiClient.changeDmKeysPassword({
    encryptedBlob: newBlob,
    blobSalt: toBase64(newSalt),
    blobVersion: bundle.blobVersion,
    recoveryBlob,
    recoveryNonce,
    recoveryMode: 'key',
    ...(signingPub && { signingPublicKey: signingPub }),
    ...escrowField(),
  });
  ensureLive(epoch);

  // Commit the local key state the MOMENT step 1 persists. The server blob is now
  // encrypted under newKey/newSalt, so leaving _derivedKey on
  // the OLD key (as the prior mutate-server-then-commit-all-local ordering did)
  // is itself the torn state: if step 2 below fails, the function would throw
  // with the server on the new passphrase but local state still on the old one —
  // "your passphrase didn't take". Committing here keeps local in sync with the
  // server regardless of step 2's outcome. _passwordDerived is intentionally NOT
  // flipped yet: until escrow is actually deleted (step 2) the user is still in
  // Server-recovery mode, and escrow (refreshed in step 1) is current under the
  // new passphrase — a consistent, recoverable state the user can retry-disable.
  _blobVersion = result.blobVersion;
  _derivedKey = newKey;
  _liveBlobKey = newKey;
  _liveAtRestKey = newAtRest;
  _liveHistoryKey = newHistory;
  _blobSalt = toBase64(newSalt);

  // Step 2: disable the mode — server deletes escrow. Only now is the user no
  // longer password-derived. A failure here throws with local + server + escrow
  // all coherently on the new passphrase (mode still enabled), not torn. Commit
  // the flag the instant the server confirms (no ensureLive gate after it: there
  // is nothing left to persist, and skipping the flip on a teardown race would
  // leave a stale-true mode flag the server has already cleared).
  await apiClient.disablePasswordDerived();
  setPasswordDerived(false);

  // Server->Self - re-persist the content keys under the NEW passphrase's keys
  // (committed to _liveBlobKey/_liveAtRestKey/_liveHistoryKey above) in SELF (30d)
  // mode. _passwordDerived was flipped false by setPasswordDerived(false) above, so
  // rememberOnDevice picks 'self'. Escrow removal is handled server-side by
  // disablePasswordDerived(). No-op if not remembered.
  if (await isRememberedOnDevice()) await rememberOnDevice();

  // Rotation (Self mode now; escrowField() is {} so nothing the rotation persists
  //    is ever re-escrowed). Best-effort + crash-resumable; a rotation error must
  //    NEVER swallow the user's recovery key returned below.

  // Identity FIRST: rotate the roaming X25519/Ed25519 identity (the archiveKey is
  // still v1 here) so a successful inline rotation is captured by the atomic
  // recovery-blob rebuild below. Mark pending FIRST (crash-safe + account-scoped),
  // then run NOW unless the user is in a voice channel or stage -> defer to call-end
  // / next boot (never touch a live SFrame session). DM calls do not block (the
  // probe excludes them). A failure leaves the flag set for resumePendingRotation.
  setPendingIdentityRotation(userId);
  if (!isVoiceSessionActive(userId)) {
    try {
      await _rotateRoamingIdentityImpl(epoch, userId);
    } catch (err) {
      logger.warn('[mls][dmKeyManager] move-to-Private identity rotation deferred to resume', { error: (err as Error)?.name });
    }
  }

  // Then rotate the archiveKey. CRITICAL ORDERING (no data-loss window): the
  // archiveKey reaches DURABLE v2 ONLY via the recovery-blob rebuild below, which
  // (changeDmKeysPassword) writes the main blob AND the recovery blob ATOMICALLY in one
  // request. So a Self recover() can never restore a v1 recovery blob that cannot read a
  // v2 server archive. The mint here is in-memory only.
  //
  // ALWAYS (regardless of alreadyV2) restore the FULL active archive under the CURRENT
  // archiveKey into the local store BEFORE the destructive resync, so THIS device holds a
  // complete plaintext copy to re-seal - even a cold device re-clicking disable on an
  // already-v2 blob, whose local store may be sparse. Under the current key: the old key on
  // a first rotation (before the mint below), or the rotated key on a resumed/second
  // attempt. Without it the resync would re-upload only the lazily-cached local subset
  // (often just previews), silently destroying server history. Fail-closed: an incomplete
  // restore SKIPS the destructive resync (archiveRotated stays false; a first rotation also
  // skips the mint, leaving v1) - the identity rotation above stands on its own and the
  // user can retry. A successful restore guarantees local completeness, so the lease-handoff
  // resume can re-upload without restoring again.
  let archiveRotated = false;
  const alreadyV2 = _archiveKeyVersion >= 2;
  let restoredOk = false;
  try {
    const restoreMod = await import('./mls/mlsHistoryRestore');
    const res = await restoreMod.restoreActiveArchiveForRotation(userId);
    restoredOk = res.ok;
  } catch (err) {
    logger.warn('[mls][dmKeyManager] move-to-Private pre-rotation restore threw; leaving archive unrotated', { error: (err as Error)?.name });
  }
  ensureLive(epoch);
  if (!restoredOk) {
    logger.warn('[mls][dmKeyManager] move-to-Private archive rotation skipped (incomplete restore under the current key); retry later');
  }
  const oldArchiveKey = _archiveKey;
  const oldArchiveVersion = _archiveKeyVersion;
  const mintedNow = !alreadyV2 && restoredOk;
  const preRebuildBlobVersion = _blobVersion;
  if (mintedNow) {
    _archiveKey = crypto.getRandomValues(new Uint8Array(32));
    _archiveKeyVersion = 2;
  }
  try {
    await _rebuildRecoveryBlob(epoch, newRecoveryKeyBytes);
    // Only run the destructive resync when the local store is provably complete (restore
    // succeeded) AND the archive is at v2 (freshly minted, or already there on a resume).
    archiveRotated = restoredOk && _archiveKeyVersion >= 2;
    if (mintedNow && oldArchiveKey) zeroFill(oldArchiveKey);
  } catch (err) {
    // The atomic v2 commit threw, but it may still have LANDED (a lost ack: the response
    // dropped, the tab closed, or an abort fired AFTER the server committed). Blindly
    // rolling back to v1 would strand the server archive at v1 beneath durably-v2 blobs ->
    // silent history loss on a later recover(). Re-read the durable blobVersion to
    // disambiguate: a value past the pre-rebuild version proves the commit landed, so KEEP
    // v2 and finish the rotation (the resync is recovery-key-free + idempotent, and runs
    // only against the now-durable v2). Only a confirmed (or, if the re-read itself fails,
    // assumed) non-commit rolls the in-memory key back to v1, which is fully consistent
    // with the still-v1 recovery blob (no loss; the user can retry move-to-Private).
    let committed = false;
    try {
      const b = await apiClient.getDmKeyBundle();
      committed = b.blobVersion > preRebuildBlobVersion;
      if (committed) _blobVersion = b.blobVersion;
    } catch { /* cannot confirm: a sustained outage most likely never reached the server -> treat as non-commit */ }
    if (committed) {
      archiveRotated = restoredOk && _archiveKeyVersion >= 2; // finish exactly as the success path (broadcast + resync/owe)
      if (mintedNow && oldArchiveKey) zeroFill(oldArchiveKey);
    } else if (mintedNow) {
      zeroFill(_archiveKey);
      _archiveKey = oldArchiveKey;
      _archiveKeyVersion = oldArchiveVersion;
    }
    logger.warn('[mls][dmKeyManager] move-to-Private recovery-blob rebuild threw', { error: (err as Error)?.name, committed });
  }

  if (archiveRotated) {
    // Broadcast the rotated generation so sibling tabs fail-close (a stale lease-holding
    // sibling then RELEASES the lease so this v2-capable tab can finish the resync). Owe
    // the destructive resync via the flag until it completes here or on the lease holder.
    broadcastArchiveKeyVersion(userId, _archiveKeyVersion);
    setPendingArchiveResync(userId);
    // The resync re-uploads history, so it runs only on the single-holder lease tab. If
    // this tab is not the holder, leave the flag set; the lease tab finishes it.
    try {
      if (hasHistorySyncLease()) {
        await _resyncServerArchive(epoch);
        setPendingArchiveResync(null);
      }
    } catch (err) {
      logger.warn('[mls][dmKeyManager] move-to-Private server-archive resync deferred to resume', { error: (err as Error)?.name });
    }
  }

  const formatted = formatRecoveryKey(newRecoveryKeyBytes);
  zeroFill(newRecoveryKeyBytes);
  return { recoveryKey: formatted };
}

/**
 * Recover E2E keys from server escrow after a password reset.
 * Decodes the raw blob from the server, populates local state,
 * then re-encrypts with the new password and uploads.
 */
export function serverRecover(newPassword: string): Promise<void> {
  return withLock(() => _serverRecoverImpl(newPassword));
}

async function _serverRecoverImpl(newPassword: string): Promise<void> {
  const epoch = _abortEpoch;
  const { rawBlob } = await apiClient.serverRecover({ password: newPassword });
  ensureLive(epoch);

  // Decode the raw blob contents from server escrow
  const json = atob(rawBlob);
  const contents: BlobContents = JSON.parse(json);

  // The server-escrow blob is the only source post-server-recover; load or mint the
  // archive key into BOTH module state and `contents` so the re-encrypt (newBlob)
  // and re-escrow (stripMlsForEscrow(contents)) below both carry it.
  if (contents.archiveKey) {
    _archiveKey = fromBase64(contents.archiveKey);
  } else {
    _archiveKey = crypto.getRandomValues(new Uint8Array(32));
    contents.archiveKey = toBase64(_archiveKey);
  }

  // Re-encrypt blob with the new password. deriveUnlockMaterial yields the blob key
  // (HKDF-derived under 'howl-blob-key') PLUS the MLS at-rest/history keys the
  // bootstrap below needs.
  const newSalt = generateSalt();
  const { blobKey: newKey, atRestKey, historyKey } = await deriveUnlockMaterial(newPassword, newSalt);
  // Derive public key from contents for AAD binding
  const recoverPubKey = toBase64(nacl.box.keyPair.fromSecretKey(fromBase64(contents.privateKey)).publicKey);
  const newBlob = await encryptBlobPacked(contents, newKey, 'howl:blob:' + recoverPubKey);

  // Build escrow data directly from decoded contents (not from state, which isn't populated yet).
  // Strip MLS before re-escrowing — a blob escrowed before this fix could carry MLS.
  const rawBlobForEscrow = btoa(JSON.stringify(stripMlsForEscrow(contents)));

  // Upload re-encrypted blob via the recover endpoint (skips optimistic locking).
  const signingPub = signingPubFromContents(contents);
  const result = await apiClient.recoverDmKeys({
    encryptedBlob: newBlob,
    blobSalt: toBase64(newSalt),
    recoveryMode: 'server-escrowed',
    ...(signingPub && { signingPublicKey: signingPub }),
    rawBlobForEscrow,
  });
  ensureLive(epoch);
  // The recovered/minted archiveKey is now durably in the re-encrypted server blob.
  _archiveKeyPersisted = true;

  // Populate local state ONLY after successful upload — prevents half-initialized
  // state on failure. Install ALL identity material BEFORE flipping _isUnlocked,
  // matching unlock(), so a synchronous getter reader never observes
  // _isUnlocked === true over half-installed state.
  _privateKey = fromBase64(contents.privateKey);
  _publicKeyBase64 = toBase64(nacl.box.keyPair.fromSecretKey(_privateKey).publicKey);
  loadArchiveKeyFromBlob(contents);
  _derivedKey = newKey;
  _liveBlobKey = newKey;
  _liveAtRestKey = atRestKey;
  _liveHistoryKey = historyKey;
  _blobVersion = result.blobVersion;
  _blobSalt = toBase64(newSalt);
  // Server-recover always lands the user in password-derived mode; converge
  // sibling tabs' escrow gate to it. Set it before the signing-key restore below
  // so a lazy-generate escrow write reads the recovered mode.
  setPasswordDerived(true);
  // Restore (or lazily generate) the Ed25519 signing key, mirroring unlock().
  // Without this the recovered session has _privateSigningKey=null, so
  // signVoiceJoinBlob() returns null, and the blob persist below would drop the
  // signing key server-side via buildBlobContents(). The escrow blob carries
  // privateSigningKey opaquely, so the load branch is the live path; the else branch
  // matches unlock() for legacy bundles.
  if (contents.privateSigningKey) {
    _privateSigningKey = fromBase64(contents.privateSigningKey);
    _signingPublicKeyBase64 = toBase64(nacl.sign.keyPair.fromSecretKey(_privateSigningKey).publicKey);
  } else {
    const newSigning = generateSigningKeyPair();
    _privateSigningKey = newSigning.secretKey;
    _signingPublicKeyBase64 = toBase64(newSigning.publicKey);
    try {
      const signingBlob = await encryptBlobPacked(buildBlobContents(), newKey, 'howl:blob:' + recoverPubKey);
      ensureLive(epoch);
      const uploadResult = await apiClient.updateDmKeysSigningKey({
        signingPublicKey: _signingPublicKeyBase64,
        encryptedBlob: signingBlob,
        blobVersion: _blobVersion,
        ...escrowField(),
      });
      ensureLive(epoch);
      _blobVersion = uploadResult.blobVersion;
    } catch (err) {
      if (err instanceof OperationAbortedError) throw err;
      // Transient upload failure is fine — retry on next unlock; local state works.
    }
  }

  // Revocation: force a fresh device identity on recovery. Under the persistent
  // device wrap the old at-rest-key rotation no longer orphans the prior identity,
  // so delete it (and its KP privates) BEFORE bootstrap load-or-mint - the recovered
  // device re-joins groups as a NEW leaf via External-Commit. Defensive: this MLS
  // section must never throw out of recovery. A failed delete is logged and tolerated.
  try {
    const srUserId = await resolveUserId(undefined);
    if (srUserId) {
      await mlsGroupStore.deleteIdentity(srUserId);
      await mlsGroupStore.deleteAllKpPrivate();
    }
  } catch (err) {
    logger.warn('dmKeyManager: serverRecover() identity revocation delete failed; continuing', {
      error: (err as Error)?.name,
    });
  }

  // Install the MLS device identity (fresh mint under the new at-rest key), then
  // reconcile channel classifications BEFORE the flip so a send on an established
  // MLS channel cannot route to the now-usable legacy key (forward-secrecy
  // downgrade), mirroring unlock()/recover(). Never throws out of recovery.
  await bootstrapMlsIdentity(atRestKey, historyKey, 'serverRecover');
  try {
    await mlsCoordinator.reconcileChannelClassifications();
  } catch (err) {
    logger.warn('[mls][dmKeyManager] serverRecover: classification reconcile failed; activate() will retry', { error: (err as Error)?.message });
  }
  // Abort the flip if a forced lock()/logout bumped the abort epoch during the
  // awaited bootstrap (mirrors recover()), so we never resurrect an unlocked vault.
  ensureLive(epoch);

  // All identity material is installed — NOW mark unlocked.
  _isUnlocked = true;

  // Drive the coordinator fail-closed (mirrors unlock/recover). Fire-and-forget
  // (synchronous void), so a slow MLS activation never blocks serverRecover.
  const mlsBundle = currentMlsBundle();
  if (mlsBundle) {
    activateMls(mlsBundle, atRestKey, historyKey);
  }

  // Server-recover runs from a LOCKED vault, so the OLD history key is gone and the
  // durable Saved-history rows (encrypted under it) cannot be re-keyed — purge the
  // now-unreadable archive rather than leave dead rows. The NEW historyKey installed
  // above governs go-forward archive writes only; this is the same credential-loss
  // cleanup as recover(). The SERVER archive (stable archiveKey) is NOT purged.
  // AWAIT this immediately before emit('unlocked') so any restore triggered off
  // 'unlocked' runs AFTER the local purge committed (otherwise restore races the
  // purge). Swallow errors.
  await mlsGroupStore.clearHistory().catch(() => undefined);

  // Server-recover always lands in Server mode; if this device is remembered,
  // re-persist the content keys (server, no-TTL) under the freshly recovered keys.
  // No-op if not remembered.
  if (await isRememberedOnDevice()) await rememberOnDevice();

  emit('unlocked');
}

/**
 * Full reset on logout.
 */
export async function reset(): Promise<void> {
  lock();
  // Full sign-out / encryption-reset path ONLY (never idle-lock): wipe the durable
  // device-local MLS store (identity, group state, KeyPackages, AND the local
  // history archive) so no prior-account material survives on a shared device. Runs
  // AFTER lock() has zeroized in-memory keys + torn down the coordinator. Best-effort:
  // an IndexedDB failure must not wedge logout.
  await mlsGroupStore.clearAll().catch(() => undefined);
  // The device content-key store is a SEPARATE IndexedDB (not part of howl_mls), so
  // clearAll() doesn't reach it. Wipe it on this full sign-out / encryption-reset
  // chokepoint so no per-account content keys survive on a shared device.
  // Idle/cross-tab/session-expiry route through lock(), never reset(), so content
  // keys correctly survive idle to allow a seamless next unlock.
  await import('./deviceContentKeyStore').then((m) => m.clearContentKeys()).catch(() => undefined);
  // Tear down the history syncer on EVERY full-clear path, here in reset() so BOTH
  // callers are covered: clearAllDmEncryptionData (logout, already preceded by
  // cleanupSession's stopHistorySync — idempotent) AND EncryptionTab.handleReset (the
  // in-app encryption reset, which does NOT route through cleanupSession). Otherwise
  // the 60s backstop interval + the sync lease leak, and the restore dedupe (_eagerDone
  // / _restoredChannels) stays stale so a same-session re-setup can't re-pull the
  // archive. Dynamic-imported to avoid a static cycle (the syncer imports this module).
  void import('./mls/mlsHistoryArchiveSync').then((m) => m.stopHistorySync()).catch(() => undefined);
  void import('./mls/mlsHistoryRestore').then((m) => m.resetHistoryRestore()).catch(() => undefined);
  _isSetupChecked = false;
  _hasBundle = false;
  _passwordDerived = false;
  _pendingArchiveResync = null;
  _archiveKeyVersion = 1;
  _pendingIdentityRotation = null;
  // Clear the cross-tab password-derived flag on full reset (logout / encryption
  // reset) so a stale value can never disagree with the server-authoritative
  // mode across accounts on a shared device. removeItem fires a `storage` event
  // with newValue=null in sibling tabs, which the listener above ignores — safe.
  try { localStorage.removeItem(PASSWORD_DERIVED_KEY); }
  catch { /* localStorage unavailable */ }
  try { localStorage.removeItem(PENDING_ARCHIVE_RESYNC_KEY); }
  catch { /* ignore */ }
  try { localStorage.removeItem(PENDING_IDENTITY_ROTATION_KEY); }
  catch { /* ignore */ }
  try { localStorage.removeItem(ARCHIVE_MIN_VERSION_KEY); _broadcastArchiveMin = null; } catch { /* ignore */ }
  try { localStorage.removeItem(VOICE_ACTIVE_KEY); _voiceActive = null; } catch { /* ignore */ }
  emit('setup-changed');
}

// Internal: Packed blob format
// Convention: encryptedBlob = base64(12-byte IV || AES-GCM ciphertext)
// This packs the IV into the blob so only one string is stored on the server.
// AAD (when provided) binds the ciphertext to the user's public key identity.

async function encryptBlobPacked(data: BlobContents, key: CryptoKey, aad?: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const encryptParams: AesGcmParams = { name: 'AES-GCM', iv: toArrayBuffer(iv) };
  if (aad) {
    (encryptParams as AesGcmParams & { additionalData: ArrayBuffer }).additionalData = new TextEncoder().encode(aad).buffer as ArrayBuffer;
  }
  const encrypted = await crypto.subtle.encrypt(encryptParams, key, plaintext);
  const combined = new Uint8Array(12 + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), 12);
  return toBase64(combined);
}

async function decryptBlobPacked(encryptedBlob: string, key: CryptoKey, aad?: string): Promise<BlobContents> {
  const combined = fromBase64(encryptedBlob);
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const decryptParams: AesGcmParams = { name: 'AES-GCM', iv: toArrayBuffer(iv) };
  if (aad) {
    (decryptParams as AesGcmParams & { additionalData: ArrayBuffer }).additionalData = new TextEncoder().encode(aad).buffer as ArrayBuffer;
  }
  // No silent no-AAD fallback. A decrypt failure (wrong key OR an
  // AAD-stripped/substituted blob) propagates — the integrity binding is never
  // bypassed.
  const decrypted = await crypto.subtle.decrypt(decryptParams, key, toArrayBuffer(ciphertext));
  return JSON.parse(new TextDecoder().decode(decrypted));
}

// Test-only helpers (throw outside the test runner)
// Let serialization/conflict/unlock tests mint a server blob that the singleton
// can decrypt with its current derived key, plus seed/read raw key buffers,
// without re-running Argon2id. Guarded so they cannot leak material in prod.
const __IS_TEST__ =
  (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') ||
  typeof (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__ !== 'undefined';

export function __test_blobSalt(): string {
  if (!__IS_TEST__) throw new Error('test-only');
  return _blobSalt ?? '';
}

export function __test_setPasswordDerived(value: boolean): void {
  if (!__IS_TEST__) throw new Error('test-only');
  setPasswordDerived(value);
}

/** Test-only: read the pending-archive-resync flag (owning userId, or null). */
export function __test_pendingArchiveResync(): string | null {
  if (!__IS_TEST__) throw new Error('test-only');
  return _pendingArchiveResync;
}
/** Test-only: seed the pending-archive-resync flag (mirrors __test_setPasswordDerived). */
export function __test_setPendingArchiveResync(value: string | null): void {
  if (!__IS_TEST__) throw new Error('test-only');
  setPendingArchiveResync(value);
}

/** Test-only: read the pending-identity-rotation flag (owning userId, or null). */
export function __test_pendingIdentityRotation(): string | null {
  if (!__IS_TEST__) throw new Error('test-only');
  return _pendingIdentityRotation;
}
/** Test-only: seed the pending-identity-rotation flag (mirrors __test_setPendingArchiveResync). */
export function __test_setPendingIdentityRotation(value: string | null): void {
  if (!__IS_TEST__) throw new Error('test-only');
  setPendingIdentityRotation(value);
}
/** Test-only: evaluate the voice-session-active gate (local probe OR the account-scoped
 *  cross-tab flag). Pass a userId to also consult the cross-tab voice-active flag. */
export function __test_isVoiceSessionActive(userId?: string): boolean {
  if (!__IS_TEST__) throw new Error('test-only');
  return isVoiceSessionActive(userId);
}

/**
 * Encrypt the current in-memory contents into a server-blob string using the
 * live derived key + AAD, so a mocked getDmKeyBundle can hand it back and the
 * manager will decrypt it. `stripSigning` omits the signing key (to force
 * unlock's generate+upload path). Restores module state before returning.
 */
export async function __test_exportServerBlob(
  opts: { stripSigning?: boolean } = {},
): Promise<string> {
  if (!__IS_TEST__) throw new Error('test-only');
  const { stripSigning } = opts;
  const savedSigning = _privateSigningKey;
  if (stripSigning) _privateSigningKey = null;
  try {
    return await encryptBlobPacked(buildBlobContents(), _derivedKey!, getBlobAAD());
  } finally {
    _privateSigningKey = savedSigning;
  }
}

export const __testHooks = {
  loadOrMintLocalIdentity,
};

