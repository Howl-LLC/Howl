// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * mlsCoordinator — the surface the rest of the app calls. Ties together the
 * engine (pure ts-mls), the group store (IndexedDB at-rest), the transport
 * client, the identity/KeyPackage lifecycle, and the tab-leader lock.
 *
 * Invariants:
 *  - Fail closed: encrypt/decrypt throw when the channel isn't ready, so the
 *    seam never downgrades to legacy or plaintext.
 *  - Single writer: all group-state mutations run only when this tab is the
 *    leader and funnel through mlsGroupStore. A non-leader tab never holds a
 *    decrypted ClientState: routing maps are built from decrypt-free
 *    metadata, and decrypted reads happen lazily and only when ready ⇒ leader.
 *  - 1:1 establish: either party that sends first runs
 *    createGroup+addMembers+Welcome; the create-once 409 means the peer beat us →
 *    discard locally and join via the Welcome (or External Commit at epoch >= 1).
 *  - Welcome mapping is a UNION of the store map and a fresh getDMs() pass;
 *    an unmapped Welcome is left pending, never silently dropped.
 *  - CAS: submitCommit conflicts drive a member-mode rebase loop.
 *  - Logging carries only { channelId, error } — never key bytes or envelopes.
 */
import type { MlsIdentityBundle } from './mlsIdentity';
import type { MlsClientState } from './types';
import { roomKey, type MlsTier } from './roomKey';
import { encodeMlsEnvelope, tryParseMlsEnvelope } from './types';
import * as engine from './mlsEngine';
import * as store from './mlsGroupStore';
import { MLS_CIPHERSUITE_NAME, getImpl } from './ciphersuite';
import { generateKeyPackages, decodeMlsCredentialIdentity, KEYPACKAGE_BATCH_SIZE, KEYPACKAGE_LOW_WATER } from './mlsIdentity';
import { verifyLeafCredential, assertConsumedKeyPackageTrusted } from './credentialTrust';
import type { CoreSeams, MlsNetwork, CommitWelcomeSource, ClassificationSink, LeadershipGate } from './mlsWorkerProtocol';
import { toBase64, fromBase64, zeroFill } from '../cryptoHelpers';
import { logger } from '../logger';

// Injected seams (installed by the worker or the in-process fallback)
let net: MlsNetwork;
let source: CommitWelcomeSource;
let classification: ClassificationSink;
let leadership: LeadershipGate;

/** Install the context-dependent seams. Called once before activate(). */
export function installSeams(seams: CoreSeams): void {
  net = seams.network;
  source = seams.source;
  classification = seams.classification;
  leadership = seams.leadership;
}

/** A "peer has published no MLS KeyPackages" failure, tagged so the worker seam can
 *  carry a typed `reason` to the UI (mirrors how apiClient stamps `.status`). */
function peerUnprovisionedError(userId: string): Error {
  return Object.assign(new Error(`member ${userId} has no available KeyPackages`), {
    reason: 'peer-unprovisioned' as const,
    unprovisionedUserId: userId,
  });
}

/** Consume one KeyPackage for a member, normalizing BOTH an empty pool and a 404 from
 *  the consume route into a typed peer-unprovisioned error. Returns the KeyPackage bytes. */
async function consumeOneKeyPackage(userId: string): Promise<Uint8Array> {
  let consumed: Awaited<ReturnType<typeof net.consumeKeyPackages>>;
  try {
    consumed = await net.consumeKeyPackages(userId);
  } catch (err) {
    if ((err as { status?: number }).status === 404) throw peerUnprovisionedError(userId);
    throw err;
  }
  if (consumed.length === 0) throw peerUnprovisionedError(userId);
  const bytes = fromBase64(consumed[0].keyPackage);
  const impl = await getImpl();
  await assertConsumedKeyPackageTrusted(bytes, userId, impl, store.pinOrVerifyAik, engine.copyBytes);
  return bytes;
}

// Local aliases so the body reads like before (client.X -> net.X, isLeader() ->
// leadership.isLeader(), setChannelProtocol(c,'mls') -> classification.markMls(c)).
function isLeader(): boolean { return leadership.isLeader(); }

// Lock/ready event bus

type MlsLockState = 'mls-ready' | 'mls-locked';
const _listeners = new Set<(e: MlsLockState) => void>();

export interface MlsLockEvents {
  on(cb: (e: MlsLockState) => void): () => void;
}

export const mlsEvents: MlsLockEvents = {
  on(cb) {
    _listeners.add(cb);
    return () => _listeners.delete(cb);
  },
};

// Tracks whether we are currently in the locked state, so an involuntary
// leadership loss followed by a voluntary deactivate (or vice versa) doesn't
// emit 'mls-locked' twice. Reset to false on every 'mls-ready'.
let _lockedEmitted = false;

function emit(e: MlsLockState): void {
  if (e === 'mls-locked') {
    if (_lockedEmitted) return; // already locked — don't double-emit
    _lockedEmitted = true;
  } else {
    _lockedEmitted = false; // 'mls-ready' clears the locked latch
  }
  for (const cb of _listeners) {
    try {
      cb(e);
    } catch (err) {
      logger.error('[mls][events] listener threw', { error: (err as Error)?.message });
    }
  }
}

// Epoch-change observers
// Fired whenever a putGroup ADVANCES the MLS epoch for a channel (commit / join
// / catch-up paths). NOT fired on a plain app-message encrypt (that advances the
// message ratchet, not the MLS epoch). The re-decrypt-on-key-arrival and the
// SFrame rekey-on-commit paths consume this.

interface EpochChangeEvent {
  dmChannelId: string;
  groupId: string;
  epoch: string;
}
const _epochListeners = new Set<(e: EpochChangeEvent) => void>();

export function onEpochChange(cb: (e: EpochChangeEvent) => void): () => void {
  _epochListeners.add(cb);
  return () => {
    _epochListeners.delete(cb);
  };
}

function emitEpochChange(e: EpochChangeEvent): void {
  for (const cb of _epochListeners) {
    try {
      cb(e);
    } catch (err) {
      logger.error('[mls][epoch] listener threw', { channelId: e.dmChannelId, error: (err as Error)?.message });
    }
  }
}

// Apply-failure observers
// Fired when an incoming/caught-up commit fails to apply (e.g. a leaf-identity
// collision throws in processHandshake). Distinct from the mls-locked latch: this
// is per-failure, never deduped. Consumers surface a non-destructive resync hint.
interface MlsApplyFailedEvent {
  dmChannelId: string;
  epoch: string;
}
const _applyFailedListeners = new Set<(e: MlsApplyFailedEvent) => void>();

export function onApplyFailed(cb: (e: MlsApplyFailedEvent) => void): () => void {
  _applyFailedListeners.add(cb);
  return () => {
    _applyFailedListeners.delete(cb);
  };
}

function emitApplyFailed(e: MlsApplyFailedEvent): void {
  for (const cb of _applyFailedListeners) {
    try {
      cb(e);
    } catch (err) {
      logger.error('[mls][apply-failed] listener threw', { channelId: e.dmChannelId, error: (err as Error)?.message });
    }
  }
}

export type { MlsApplyFailedEvent };

// Ready-channel observers
// Fired when a DM channel NEWLY transitions to ready (loaded + established) AFTER
// activation — i.e. the join/establish paths that do NOT emit 'mls-ready'
// (External Commit self-join, Welcome-join, 1:1 either-party create). The lazy
// history restore retries on this so a fresh device's first DM open fills its full
// history without a reload. Activation-time loads are covered by 'mls-ready', so
// they intentionally do NOT route here. Fire-and-forget; per-listener try/catch.
const _readyChannelListeners = new Set<(dmChannelId: string) => void>();

export function onReadyChannel(cb: (dmChannelId: string) => void): () => void {
  _readyChannelListeners.add(cb);
  return () => {
    _readyChannelListeners.delete(cb);
  };
}

function emitReadyChannel(dmChannelId: string): void {
  for (const cb of _readyChannelListeners) {
    try {
      cb(dmChannelId);
    } catch (err) {
      logger.error('[mls][ready-channel] listener threw', { channelId: dmChannelId, error: (err as Error)?.message });
    }
  }
}

// In-memory state (leader tab only mutates)

let _active = false;
// First-init latch: set synchronously before any await so two near-
// simultaneous init messages on the SharedWorker path (where navigator.locks no
// longer serializes activate()) run the leader-only tail exactly once.
let _initStarted = false;
let _identity: MlsIdentityBundle | null = null;
/** dmChannelId -> loaded server groupId (loaded groups are MLS-ready). */
const _loadedGroups = new Map<string, string>();
/** server groupId -> dmChannelId, for routing incoming commits/welcomes. */
const _groupToChannel = new Map<string, string>();
/** dmChannelId -> last epoch we fired an epoch-change for (advance gate). */
const _lastEpoch = new Map<string, bigint>();
/** dmChannelId -> in-flight establishChannel promise (dedupe concurrent open+send). */
const _establishing = new Map<string, Promise<void>>();
const _unsubscribers: Array<() => void> = [];

// Bounded self-Update cadence
// RFC 9750 §8.3: force idle/read-only members to contribute key updates on a
// bounded schedule so PCS (leaf-key self-heal) is guaranteed, not opportunistic.
// A group is "due" when it has never self-updated or >= CADENCE has elapsed; the
// timer ticks more often than the cadence so a deferred-on-conflict group retries
// promptly. lastSelfUpdateAt persists in the `meta` store, suppressing redundant
// rotations across reopens (each self-update forces every peer to process a commit).
const SELF_UPDATE_CADENCE_MS = 24 * 60 * 60 * 1000; // rotate each leaf >= daily
const SELF_UPDATE_TICK_MS = 60 * 60 * 1000;         // scheduler wakeup (acts only on due groups)
const SELF_UPDATE_META_PREFIX = 'selfUpdateAt:';    // meta key per dmChannelId
let _selfUpdateTimer: ReturnType<typeof setInterval> | null = null;
let _selfUpdateSweepRunning = false; // re-entrancy guard (a slow sweep can outlast a tick)
let _rekeyInProgress = false;        // pause the cadence while at-rest keys are mid-swap
// dmChannelIds whose self-Update was skipped for a pre-v2 (legacy) own leaf — log
// once per channel per session (cleared on deactivate). Bounded by the loaded-group
// count, which is itself bounded.
const _legacyLeafLogged = new Set<string>();

// Decrypted-plaintext cache (cross-tab read)
// N tabs share ONE ClientState via the worker; each tab independently RPCs
// decrypt() for the same incoming envelope. ts-mls application-message keys are
// single-use (forward secrecy): the first decrypt advances+persists the ratchet,
// so a SECOND decrypt of the SAME ciphertext throws "Desired gen in the past".
// Without memoization only the race-winner tab renders a peer message; the others
// show the locked placeholder. Memoize plaintext by (channel, envelope), checked
// and populated INSIDE withChannelLock so the race-loser sees the winner's entry.
// Bounded (FIFO eviction) + in-memory only (the in-memory layer; durable plaintext
// now lives in the history archive) + cleared on deactivate() so no decrypted
// plaintext outlives the unlocked session. The ratchet still advances exactly once per
// ciphertext, so forward secrecy is preserved. The cap is well above a realistic
// single-session message volume so a busy channel won't evict another channel's
// still-unread entry (an evicted entry just degrades that one message to the
// pre-fix placeholder — never a downgrade to legacy). Intentionally NOT cleared on
// involuntary leadership loss: the decrypt() cache read sits behind the
// isReadyForChannel() guard (which requires isLeader()), so a non-leader tab can
// never read it, and a re-acquiring leader on the same still-unlocked session
// serves the same correct plaintext. deactivate() (the key-zeroing teardown) is
// the single clear point.
const _plaintextCache = new Map<string, string>();
const PLAINTEXT_CACHE_MAX = 2000;

// Readable-history archive helpers

// Hex SHA-256 of the source envelope — the archive key suffix (history is
// keyed by `${channel}:${envHash}`, so a hit is the plaintext of this exact ciphertext).
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// One-time low-storage warning so a full disk doesn't spam logs (counts-only,
// never plaintext or key bytes — matches the store's logging discipline).
let _lowStorageWarned = false;
function handleArchiveWriteError(err: unknown): void {
  if ((err as { name?: string })?.name === 'QuotaExceededError') {
    if (!_lowStorageWarned) {
      _lowStorageWarned = true;
      logger.warn('[mls][archive] device storage full; readable history not saved for some messages', {});
    }
    return;
  }
  logger.warn('[mls][archive] history write failed; message will re-decrypt next load', {
    error: (err as Error)?.message,
  });
}

const MAX_REBASE_ATTEMPTS = 8;

// Per-channel operation serializer (within-tab single-writer guard)
// Every channel-state read-modify-write (encrypt/decrypt advance the ratchet,
// commit/join/catch-up advance the epoch) reads getGroup, mutates via the engine,
// then writes putGroup. Two concurrent ops on the SAME channel would each read the
// same base state and the second putGroup would clobber the first — the first
// message was then encrypted under a generation that is never persisted, so the
// recipient can never decrypt it. Serialize all channel-scoped ops per channelId.
// This is the WITHIN-tab guard only; full multi-tab single-writer is the
// SharedWorker's job. Wrap only at the public-entry level to avoid nested-lock deadlock.
const _opQueue = new Map<string, Promise<unknown>>();

function withChannelLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  const prev = _opQueue.get(channelId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn regardless of the prior op's outcome
  // Park a swallowed-rejection version in the queue so one failure doesn't reject
  // every subsequent op; return the real (possibly rejecting) promise to the caller.
  _opQueue.set(channelId, next.catch(() => {}));
  return next as Promise<T>;
}

// At-rest re-key barrier. A password change drives core.rekey, which
// re-encrypts every durable at-rest row under the NEW key while the OLD key is still
// installed (the swap lands only after the rewrite loop resolves). A concurrent
// commit/decrypt that reads an already-rewritten row therefore throws a stale-key
// 'OperationError' that is NOT a genuine orphan. This synchronous latch — a promise
// that resolves when the in-flight re-key finishes — lets healIfOrphanedGroup tell
// that transient artifact apart from a real orphan and refuse to drop a live group row
// mid-re-key. Null whenever no re-key is in flight.
let _rekeyBarrier: Promise<void> | null = null;

// Activation / deactivation

/**
 * Called by dmKeyManager.unlock once the identity and at-rest key are ready.
 * Order: setAtRestKey -> build DECRYPT-FREE routing maps -> _active=true ->
 * acquireLeadership -> ONLY if leader: replenish KPs if low -> join pending
 * welcomes -> catch up each group -> subscribe sockets -> emit 'mls-ready'.
 * The decrypt-only steps (getGroup, joinFromWelcome, catchUp) run leader-only,
 * so a non-leader tab never holds a decrypted ClientState.
 * Resolves once the awaited prefix sets _active; the leader-only tail (and the
 * 'mls-ready' emit) completes later in the background, so this promise resolving
 * is NOT an MLS-ready signal. Idempotent until deactivate() resets the latch.
 */
export async function activate(identity: MlsIdentityBundle, atRestKey: CryptoKey, historyKey: CryptoKey | null): Promise<void> {
  // First-init latch: the worker is single-threaded, so a synchronously-set flag
  // (set before any await) fully serializes two near-simultaneous init messages,
  // so the leader-only tail runs exactly once.
  if (_initStarted) return;
  _initStarted = true;

  // PREFIX (awaited: completes before activate() resolves, so a post-unlock
  // establishChannel/create RPC never hits the "mls not active" guard).
  _identity = identity;
  store.setAtRestKey(atRestKey);
  store.setHistoryKey(historyKey);
  // Rotation-attestation wiring: let the trust store fetch a peer's rotation chain on a
  // pin mismatch so it can advance the pin across a legitimate AIK rotation instead of
  // stranding the conversation. (The store treats our own userId like any peer — our own
  // chain governs our own leaves; no blanket self-trust.)
  store.setRotationChainFetcher((userId) => net.getAikChain(userId));

  // Install the REAL credential validator: cross-sig verify (check 2) + TOFU-pinned
  // AIK (check 3). The closure captures the live engine/store module bindings, so it
  // applies to every already-loaded state too (the existing design intent). Roster
  // check (check 1) is intentionally omitted — ts-mls passes the validator no
  // roster/group context; the add path enforces roster instead.
  engine.setCredentialValidator(async (credentialIdentity, leafSigningPublicKey) => {
    const impl = await getImpl();
    const r = await verifyLeafCredential({ credentialIdentity, leafSigningPublicKey, impl });
    if (!r.ok || !r.userId || !r.aikPub) return false;
    // Trust check 3: TOFU-pin on first sight; reject on AIK change (fail closed;
    // a later refinement softens to warn+acknowledge for Saved chats).
    let deviceId = '';
    try { deviceId = decodeMlsCredentialIdentity(credentialIdentity).deviceId; } catch { /* already rejected above */ }
    return store.pinOrVerifyAik(r.userId, r.aikPub, { deviceId, leafKey: leafSigningPublicKey });
  });

  // Routing maps from decrypt-free metadata only: never call getGroup here.
  _loadedGroups.clear();
  _groupToChannel.clear();
  _lastEpoch.clear();
  const g2c = await store.getGroupIdToChannelMap(); // groupId -> { roomKey, channelId, tier }
  for (const [groupId, { roomKey: rk, channelId }] of g2c) {
    _groupToChannel.set(groupId, rk); // groupId -> roomKey
    _loadedGroups.set(rk, groupId); // inverse, roomKey -> groupId
    // Reconcile the durable classification from the authoritative source. The
    // send/receive seams route on isChannelMls() (a single localStorage record)
    // while the proof a channel is MLS is the encrypted group in IndexedDB. If
    // that localStorage record is lost while the group survives, routing would
    // silently downgrade an established MLS channel to the coexistence legacy
    // path. Re-assert 'mls' here so a reload heals the divergence. Idempotent:
    // setChannelProtocol is a one-way ratchet (no-ops if already 'mls'). The
    // classification keys on the BARE channelId, never the room key.
    classification.markMls(channelId);
  }

  _active = true;

  // TAIL (backgrounded: leadership.acquire may block on another tab's lease and
  // the leader-only replenish/join/catch-up are slow; activate() must NOT wait on
  // them so a post-unlock establishChannel RPC sees _active synchronously).
  // Surface tail failures: leadership.acquire and replenishKeyPackagesIfLow are
  // not internally wrapped, so without this catch a rejection there would be a
  // silent unhandled rejection. MLS stays fail-closed; the next unlock retries.
  activateTail().catch((err) => logger.warn('[mls][activate] background tail failed', { error: (err as Error)?.message }));
}

async function activateTail(): Promise<void> {
  const leader = await leadership.acquire(handleLeadershipLost);
  // Teardown-safety: a forced lock()/deactivate() during the awaits above
  // nulls _active. Do not revive state or emit 'mls-ready' after a teardown.
  if (!_active) {
    if (leader) leadership.release();
    return;
  }
  if (leader) {
    await replenishKeyPackagesIfLow();
    // Drop any group persisted under a previous ciphersuite BEFORE join/catch-up, so a
    // pending Welcome or External-Commit re-establishes the channel on the current suite
    // (joinPendingWelcomes/catchUp both skip a channel that is still loaded).
    await healSuiteMismatchedGroups();
    await joinPendingWelcomes();
    await catchUpAllGroups();
    if (!_active) return; // re-check after the leader-only awaits
    _unsubscribers.push(source.onCommit(handleIncomingCommit));
    _unsubscribers.push(source.onWelcome(handleIncomingWelcome));
    startSelfUpdateScheduler(); // begin bounded PCS self-Update cadence (leader-only)
  }

  if (!_active) return; // final guard before announcing ready
  emit('mls-ready');
}

/** Called by dmKeyManager.lock. Clears in-memory state and drops the at-rest key. */
export function deactivate(): void {
  for (const unsub of _unsubscribers.splice(0)) {
    try {
      unsub();
    } catch {
      /* ignore */
    }
  }
  _loadedGroups.clear();
  _groupToChannel.clear();
  _lastEpoch.clear();
  _plaintextCache.clear(); // no decrypted plaintext survives a lock/logout
  _lowStorageWarned = false; // re-arm the one-time low-storage warning for the next session
  // Fully reset the in-memory op/drain state so nothing survives a lock /
  // logout / account-switch (teardown hygiene). Any drain IIFE
  // still settling self-terminates via joinPendingWelcomes' isLeader() guard.
  _opQueue.clear();
  _establishing.clear();
  _drainInFlight = null;
  _drainQueued = false;
  stopSelfUpdateScheduler(); // disarm the cadence timer (no commits after lock)
  _selfUpdateSweepRunning = false;
  _legacyLeafLogged.clear(); // reset the once-per-session legacy-leaf log set
  // Worker-scope teardown: the worker holds a structured-clone of the identity
  // buffers (the main-thread clearMlsState aliasing scrub does NOT reach them),
  // so scrub the raw Ed25519 signing key + public + credential bytes here. Safe
  // and idempotent on the in-process fallback path too.
  if (_identity) {
    zeroFill(_identity.identity.signaturePrivateKey);
    zeroFill(_identity.identity.signaturePublicKey);
    zeroFill(_identity.identity.credentialIdentity);
  }
  _identity = null;
  _active = false;
  _initStarted = false;
  store.setAtRestKey(null);
  store.setHistoryKey(null);
  store.setRotationChainFetcher(null);
  leadership.release();
  emit('mls-locked');
}

/**
 * Re-key the durable at-rest stores from the CURRENTLY-installed (old) keys to the
 * new unlock-derived keys, then adopt the new keys — atomically from the worker's
 * point of view. Used by the in-session password/passphrase-change
 * flows so a salt rotation does not orphan the Saved-history archive.
 *
 * Order matters: read-all/re-encrypt-all/write-all under the OLD keys (still
 * installed) BEFORE swapping the module-held keys. If no at-rest key is installed
 * (MLS not active), no-op safely.
 *
 * Concurrency: this runs in the single-threaded worker (or the in-process
 * fallback) and a password change is modal and rare, but it is NOT atomic against other
 * ops. The function awaits internally (per-row decrypt/encrypt/put) and the worker
 * dispatches inbound commits fire-and-forget, so a commit/decrypt CAN interleave at any
 * await and read a row already rewritten under the new key while the old key is still
 * installed — a stale-key OperationError. The _rekeyBarrier latch (set below, before the
 * first await) lets healIfOrphanedGroup recognise that as a transient re-key artifact and
 * refuse to drop the live row; the row stays at its prior epoch and MLS catch-up/resync
 * reconciles it under the new key. Residual (accepted): rekey takes no channel lock, so an
 * in-flight commit that READ under the old key can still WRITE its advanced state under the
 * old key after that row was rewritten, leaving one genuinely-stale row the next read drops
 * — strictly rarer than the original any-commit false-drop, and self-healing (re-establish
 * via External-Commit; STORE_HISTORY is never touched).
 */
export async function rekey(newAtRestKey: CryptoKey, newHistoryKey: CryptoKey | null): Promise<void> {
  const oldAtRest = store.getAtRestKey();
  if (!oldAtRest) return; // not active — nothing installed to re-key
  // Pause the cadence so an autonomous self-Update tick can't persist a
  // group under a stale at-rest key while the keys are mid-swap.
  _rekeyInProgress = true;
  const oldHistory = store.getHistoryKey();
  // Latch the re-key barrier SYNCHRONOUSLY (before the first await) so an interleaving
  // read of an already-rewritten row is treated as a transient stale-key artifact by the
  // heal, not dropped as an orphan. Cleared in finally; the identity check
  // keeps a (serialized, but defensive) later re-key from clearing a newer barrier.
  let release!: () => void;
  const myBarrier = new Promise<void>((resolve) => { release = resolve; });
  _rekeyBarrier = myBarrier;
  try {
    await store.rekeyAtRestStores(oldAtRest, newAtRestKey, oldHistory, newHistoryKey);
    // Swap the installed keys only AFTER every row is re-encrypted under the new ones.
    store.setAtRestKey(newAtRestKey);
    store.setHistoryKey(newHistoryKey);
  } finally {
    _rekeyInProgress = false;
    if (_rekeyBarrier === myBarrier) _rekeyBarrier = null;
    release();
  }
}

function handleLeadershipLost(): void {
  // Lost the writer lease (rare: tab discard). Drop subscriptions; this tab is
  // no longer leader, so isReadyForChannel becomes false and crypto fails closed.
  for (const unsub of _unsubscribers.splice(0)) {
    try {
      unsub();
    } catch {
      /* ignore */
    }
  }
  stopSelfUpdateScheduler(); // lost the writer lease — stop committing
  // Emit 'mls-locked' so consumers reset their UI on involuntary leadership loss.
  // emit() latches so a later deactivate won't double-emit.
  emit('mls-locked');
}

export function isActive(): boolean {
  return _active;
}

export function isReadyForChannel(dmChannelId: string, tier: MlsTier = 'saved'): boolean {
  return _active && isLeader() && _loadedGroups.has(roomKey(dmChannelId, tier));
}

/** The dmChannelIds currently MLS-ready (loaded + we are leader). Drives the
 *  dispatcher's synchronous isReadyForChannel mirror. */
export function readyChannelIds(): string[] {
  if (!_active || !isLeader()) return [];
  return [..._loadedGroups.keys()];
}

/**
 * Re-assert 'mls' classification for every channel that has a durable group row
 * in IndexedDB. getGroupIdToChannelMap reads only plaintext groupId/dmChannelId
 * (no at-rest key required), so this is safe to call EARLY in unlock() — before
 * the vault is marked unlocked and the coexistence legacy keys become usable.
 * Closes the manual-unlock window where a lost localStorage classification would
 * let a send on an established MLS channel route to legacy. Idempotent (the
 * classification is a one-way ratchet); activate() reconciles again as a backstop.
 */
export async function reconcileChannelClassifications(): Promise<void> {
  const g2c = await store.getGroupIdToChannelMap();
  for (const [, { channelId }] of g2c) classification.markMls(channelId);
}

// Persist + epoch-advance fan-out

/**
 * Persist a group state and fire onEpochChange iff this advances the channel's
 * epoch. Used by every MLS-epoch-advancing path (commit/join/catch-up). The
 * plain app-message encrypt path does NOT route through here (it advances the
 * message ratchet, not the MLS epoch).
 */
async function persistGroup(
  dmChannelId: string,
  groupId: string,
  state: MlsClientState,
  epoch: bigint,
  tier: MlsTier = 'saved',
): Promise<void> {
  const rk = roomKey(dmChannelId, tier);
  await store.putGroup(rk, groupId, state, epoch, { channelId: dmChannelId, tier });
  const prev = _lastEpoch.get(rk);
  if (prev === undefined || epoch > prev) {
    _lastEpoch.set(rk, epoch);
    emitEpochChange({ dmChannelId, groupId, epoch: epoch.toString() });
  }
}

// 1:1 establish (either-party create)

/**
 * Create the saved-tier MLS group for a 1:1 DM and add the recipient. Either
 * party that sends first creates the group and adds the counterparty via Welcome.
 * The create-once 409 resolves a both-create race: the loser discards its local
 * epoch-0 group and joins via the winner's Welcome (or External Commit once the
 * group is at epoch >= 1).
 *
 * If the backend create-once endpoint returns 409 ("group already exists"), the
 * peer beat us in a tie/race: discard the local epoch-0 group and fall through
 * to the join path. Classifies the channel 'mls' on a successful create.
 */
export function createDmGroup(dmChannelId: string, recipientUserId: string, tier: MlsTier = 'saved'): Promise<void> {
  // A 1:1 DM is the single-member case of an N-member group. Delegate so the two
  // paths share one implementation. The single-member idempotency token is the
  // bare recipientId (dedupe+sort of a 1-element set), so the create-once/rebase
  // behaviour is byte-identical to the legacy 1:1 path.
  //
  // wireAsPublicMessage=false: a 1:1 (isGroup=false) channel's member commit MUST
  // be an mls_private_message. The backend commit gate (routes/mls.ts `else if
  // (!isGroup)`) rejects a public 1:1 commit as wrong_wireformat, and keeping it
  // private leaves the server unable to read 1:1 commit content. Group
  // creates default to public (authority/accept-both); see createGroupDmGroup.
  return createGroupDmGroup(dmChannelId, [recipientUserId], false, tier);
}

/**
 * Create the saved-tier MLS group for a DM (1:1 or group) and add N members.
 * Generalizes createDmGroup from one recipient to many: one consumeKeyPackages per
 * member, ONE batched engine.addMembers (a single Commit + single Welcome), and ONE
 * submitCommit fanning the Welcome out to every member. `memberUserIds` EXCLUDES self
 * (the creator's leaf comes from createGroup).
 *
 * This is an epoch-0 create owned by the sole pre-existing member (us): there is no
 * member-mode CAS rebase winner to replay, so we submit once and fail closed on a
 * non-ok result. A create-once 409 at client.createGroup means a peer beat us in a
 * tie/race — discard the local epoch-0 group and defer to the Welcome/join path.
 * Classifies the channel 'mls' on a successful commit.
 *
 * Runs inside withChannelLock and inlines the batched commit (does NOT call
 * commitAddWithRebase — that path is the epoch >= 1 single-recipient rebase loop;
 * re-entering the lock is unnecessary here and re-checking _active/isLeader after
 * each await preserves teardown discipline).
 */
export function createGroupDmGroup(dmChannelId: string, memberUserIds: string[], wireAsPublicMessage = true, tier: MlsTier = 'saved'): Promise<void> {
  // The MLS protocol group_id and the in-memory routing keys are the per-tier room
  // key (bare id for Saved, namespaced for OTR); the server group row + classification
  // stay keyed by the bare dmChannelId.
  const rk = roomKey(dmChannelId, tier);
  // Serialize per channel (within-tab single-writer guard) so a create can't race
  // a concurrent encrypt/decrypt/commit on the same channel.
  return withChannelLock(rk, async () => {
    if (!_active || !_identity) throw new Error('mls not active');
    if (!isLeader()) throw new Error('mls not leader');
    if (_loadedGroups.has(rk)) return; // idempotent

    // Dedupe + sort the member set: the sorted-set token drives a deterministic
    // idempotency key and a single-element set reduces to the bare id (1:1
    // byte-compatible).
    const members = [...new Set(memberUserIds)].sort();

    // 1. Local epoch-0 group (self only). The MLS protocol group_id is the room key.
    const state: MlsClientState = await engine.createGroup(_identity.identity, rk);

    // 2. Consume one KeyPackage per member device (one per member) BEFORE
    //    registering the server group row. A member with no KeyPackages now fails the
    //    establish before any MlsGroup row exists, so a peer-unprovisioned create mints
    //    no orphan. Accepted tradeoff: the loser of a create race burns
    //    one KeyPackage per member; pools replenish and last-resort is reusable.
    const kps: Array<{ userId: string; keyPackage: Uint8Array }> = [];
    for (const userId of members) {
      kps.push({ userId, keyPackage: await consumeOneKeyPackage(userId) });
    }
    if (!_active || !isLeader()) throw new Error('mls torn down mid-create'); // after-await recheck

    // 3. Register the MlsGroup row on the server with the epoch-0 GroupInfo (the commit
    //    handler requires the row to exist). The server assigns groupId.
    const epoch0GroupInfo = await engine.makeGroupInfo(state);
    let groupId: string;
    try {
      const created = await net.createGroup(dmChannelId, toBase64(epoch0GroupInfo), tier);
      groupId = created.groupId;
    } catch (err) {
      // Mirror submitCommit's thrown-error status extraction to detect the create-once
      // 409 (peer beat me). Discard the local group and defer to the Welcome/join path;
      // any other error is a real failure and rethrows. (The numeric .status survives
      // the SharedWorker boundary, so this fires on the worker path too.)
      const status = (err as { status?: number }).status;
      if (status === 409) {
        logger.warn('[mls][create] group already exists; deferring to welcome join', { channelId: dmChannelId });
        return;
      }
      throw err;
    }
    if (!_active || !isLeader()) throw new Error('mls torn down mid-create'); // after-await recheck

    // 4. Build the batched Add+Commit (epoch 0 -> 1) with N KeyPackages and submit
    //    once with the Welcome fanned out to every member. Move-not-borrow: feed
    //    addMembers a CLONE of the base state (ts-mls zeroizes consumed buffers in
    //    place) and a fresh copy of each KeyPackage's bytes.
    const baseEpoch = engine.currentEpoch(state).toString();
    const addInput = engine.decodeState(engine.encodeState(state), tier);
    const { newState, commit, welcome } = await engine.addMembers(
      addInput,
      kps.map((m) => engine.copyBytes(m.keyPackage)),
      wireAsPublicMessage,
    );
    const newGroupInfo = await engine.makeGroupInfo(newState);
    const recipientSetToken = members.join(',');
    const idempotencyKey = await net.idempotencyKeyFor(groupId, baseEpoch, 'add', recipientSetToken);
    const result = await net.submitCommit({
      groupId,
      baseEpoch,
      mode: 'member',
      commitB64: toBase64(commit),
      groupInfoB64: toBase64(newGroupInfo),
      idempotencyKey,
      welcomes: kps.map((m) => ({ recipientId: m.userId, welcomeData: toBase64(welcome) })),
    });
    // Epoch-0 create: the sole pre-existing member is us, so a member-mode 409 has
    // no winning commit we could replay. Fail closed rather than loop.
    if (!result.ok) {
      throw new Error(`epoch-0 group create commit failed: ${result.conflict ?? 'unknown'}`);
    }
    if (!_active || !isLeader()) throw new Error('mls torn down mid-create'); // after-await recheck

    // 5. Persist (fires the epoch-change fan-out), mark loaded + classify the
    //    channel mls (downgrade-resistant ratchet). persistGroup writes the store
    //    row + emits onEpochChange; it does NOT touch the routing maps, so set them
    //    here.
    const epoch = BigInt(result.epoch);
    await persistGroup(dmChannelId, groupId, newState, epoch, tier);
    _loadedGroups.set(rk, groupId);
    _groupToChannel.set(groupId, rk);
    classification.markMls(dmChannelId); // BARE id — never the room key
    emitReadyChannel(rk); // channel is ready now (fires history-restore retry)
  });
}

/**
 * Resolution tree for an mls 1:1 channel. Deduped per channel so a
 * concurrent open + first-send share one resolution. NOT wrapped in withChannelLock —
 * its sub-steps each take the per-channel lock, so wrapping here would deadlock.
 */
export async function establishChannel(
  dmChannelId: string,
  recipientUserId: string,
  mlsGroupId?: string | null,
  tier: MlsTier = 'saved',
): Promise<string | undefined> {
  const rk = roomKey(dmChannelId, tier);
  // Return the resolved server groupId (held in _loadedGroups under the room key
  // once establish settles) so a caller toggling OTR on an existing DM can write it
  // into the dmStore entry's otrMlsGroupId — the first OTR send reads that field.
  const inflight = _establishing.get(rk);
  if (inflight) {
    await inflight;
    return _loadedGroups.get(rk);
  }
  const p = _establishImpl(dmChannelId, recipientUserId, mlsGroupId, tier).finally(() => {
    _establishing.delete(rk);
  });
  _establishing.set(rk, p);
  await p;
  return _loadedGroups.get(rk);
}

/**
 * Resolution tree for an mls DM channel (1:1 or group). The Welcome ->
 * External Commit steps are member-count-agnostic and shared by both paths; only the
 * last-resort `create` step differs (1:1 supplies createFn; a joining group member
 * does NOT — the owner created the group via createGroupDmGroup). NOT wrapped in
 * withChannelLock — every sub-step (joinPendingWelcomes / joinViaExternalCommit /
 * createFn) takes the per-channel lock itself, so wrapping here would deadlock.
 */
async function _establishResolve(
  dmChannelId: string,
  opts: { mlsGroupId?: string | null; createFn?: () => Promise<void>; tier?: MlsTier },
): Promise<void> {
  const tier = opts.tier ?? 'saved';
  const rk = roomKey(dmChannelId, tier);
  if (!_active || !_identity) throw new Error('mls not active');
  if (!isLeader()) throw new Error('mls not leader');
  if (_loadedGroups.has(rk)) return;

  // 1. Welcome-primary.
  await joinPendingWelcomes();
  if (_loadedGroups.has(rk)) return;

  // 2. A server group exists -> External Commit (or epoch-0 refuse inside).
  //    A 404 from the join means the id we hold is STALE: the server heal
  //    deletes + recreates an abandoned epoch-0 MlsGroup row,
  //    minting a NEW groupId, while a caller-supplied id from dmStore only
  //    updates on a full GET /dms refresh. Re-resolve fresh and retry the
  //    join ONCE (a 404 from the fresh id propagates); no usable fresh id
  //    means the group is gone -> fall through to step 3 as if none had been
  //    found. No after-await recheck needed here: joinViaExternalCommit and
  //    createFn re-check _active/isLeader at their own entry, same as after
  //    the resolveServerGroupId await below.
  const groupId = opts.mlsGroupId ?? (await resolveServerGroupId(dmChannelId, tier));
  if (groupId) {
    try {
      await joinViaExternalCommit(dmChannelId, groupId, tier);
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
      logger.warn('[mls][establish] cached groupId stale (404); re-resolving', { channelId: dmChannelId });
      const freshId = await resolveServerGroupId(dmChannelId, tier);
      if (freshId && freshId !== groupId) {
        await joinViaExternalCommit(dmChannelId, freshId, tier);
      }
    }
    if (_loadedGroups.has(rk)) return;
  }

  // 3. No group anywhere -> create (1:1 only; a joining group member never creates).
  if (opts.createFn) {
    await opts.createFn();
  }
}

function _establishImpl(
  dmChannelId: string,
  recipientUserId: string,
  mlsGroupId?: string | null,
  tier: MlsTier = 'saved',
): Promise<void> {
  // 1:1: the last-resort create is the either-party create-once flow.
  return _establishResolve(dmChannelId, {
    mlsGroupId,
    tier,
    createFn: () => createDmGroup(dmChannelId, recipientUserId, tier),
  });
}

/**
 * Resolution tree for an mls GROUP DM channel. A joining member resolves
 * the group via a pending Welcome (step 1) or an External Commit against the existing
 * server group (step 2); it NEVER creates — the owner created the group via
 * createGroupDmGroup, so there is no createFn. Deduped per channel via the same
 * _establishing map the 1:1 establishChannel uses; NOT wrapped in withChannelLock
 * (sub-steps lock, so wrapping would deadlock).
 */
export function establishGroupDmChannel(dmChannelId: string, mlsGroupId?: string | null): Promise<void> {
  const inflight = _establishing.get(dmChannelId);
  if (inflight) return inflight;
  const p = _establishResolve(dmChannelId, { mlsGroupId }).finally(() => {
    _establishing.delete(dmChannelId);
  });
  _establishing.set(dmChannelId, p);
  return p;
}

/**
 * Member-mode batched Add commit (N members) with the CAS rebase loop. One
 * engine.addMembers over N KeyPackages produces a single Commit + single Welcome; the
 * one submitCommit fans that Welcome out to every member. On a 409 'rebase' conflict we
 * replay the winning commit(s) onto our INTACT base state, rebuild the Add on the new
 * epoch, and resubmit. The idempotency key is deterministic per (groupId, baseEpoch,
 * sorted-set-of-recipients): a network-timeout resubmit onto the SAME baseEpoch with the
 * SAME member set reuses the key (server returns the original outcome); a genuine rebase
 * onto a NEW baseEpoch yields a new key. Persists the final accepted state.
 *
 * The 1:1 form (commitAddWithRebase) delegates here with a one-element member set; that
 * delegate is the entry point the real-engine rebase regression test
 * (__tests__/mls/mlsCoordinatorRebaseState.test.ts) drives — the N-ary form below owns
 * the logic. There is no production epoch-0 caller: createGroupDmGroup inlines its own
 * batched create commit, so this loop is the epoch >= 1 Add path used by addGroupMembers.
 */
export async function commitAddMembersWithRebase(
  dmChannelId: string,
  groupId: string,
  baseState: MlsClientState,
  members: { userId: string; keyPackage: Uint8Array }[],
): Promise<void> {
  let state = baseState;
  for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt++) {
    const baseEpoch = engine.currentEpoch(state).toString();
    // A racing External-Commit self-join may have already added some target on a
    // prior rebase replay; re-Adding an already-present member throws in ts-mls
    // ("Add for someone already in the group"). Filter to the still-absent members
    // (no-op in the normal no-race case: pending === members). credentialIdentityFor
    // THROWS when the user has no leaf, which is the "still absent" signal here.
    const pending = members.filter((m) => {
      try { credentialIdentityFor(state, m.userId); return false; } catch { return true; }
    });
    if (pending.length === 0) {
      // Every target already joined via its own commit; the rebase replays already
      // merged them into `state`. Persist the caught-up state and return (no Add needed).
      await persistGroup(dmChannelId, groupId, state, engine.currentEpoch(state));
      return;
    }
    // Multi-member idempotency token: dedupe + sort + join the actual per-attempt recipient
    // set so the key is stable across attempts (only baseEpoch changes on a rebase). A single
    // member reduces to the bare id, byte-compatible with the legacy 1:1 token.
    const recipientSetToken = [...new Set(pending.map((m) => m.userId))].sort().join(',');
    // Move-not-borrow, two parts:
    //  - Fresh copy of each KeyPackage's bytes each iteration: ts-mls treats inputs
    //    as move-not-borrow, so reusing a member's keyPackage across attempts could
    //    feed an already-consumed buffer.
    //  - Feed addMembers a CLONE of the base state, never `state` itself. ts-mls
    //    createCommit returns the input state's own keySchedule.initSecret in
    //    `consumed`, and addMembers zeroizes consumed buffers in place. On a 409 we
    //    replay the winner onto `state` via processHandshake below, so `state` must
    //    stay intact — let the throwaway clone absorb the zeroize.
    const addInput = engine.decodeState(engine.encodeState(state));
    const { newState, commit, welcome } = await engine.addMembers(
      addInput,
      pending.map((m) => engine.copyBytes(m.keyPackage)),
      true,
    );
    const newGroupInfo = await engine.makeGroupInfo(newState);
    const idempotencyKey = await net.idempotencyKeyFor(groupId, baseEpoch, 'add', recipientSetToken);
    const result = await net.submitCommit({
      groupId,
      baseEpoch,
      mode: 'member',
      commitB64: toBase64(commit),
      groupInfoB64: toBase64(newGroupInfo),
      idempotencyKey,
      welcomes: pending.map((m) => ({ recipientId: m.userId, welcomeData: toBase64(welcome) })),
    });

    if (result.ok) {
      const epoch = BigInt(result.epoch);
      await persistGroup(dmChannelId, groupId, newState, epoch);
      return;
    }

    if (result.conflict !== 'rebase') {
      // refetch_group_info is external mode; not reachable here.
      throw new Error(`unexpected commit conflict: ${result.conflict}`);
    }

    // Rebase: replay the winning commit(s) onto our base state, then retry.
    const since = engine.currentEpoch(state).toString();
    const winners = await net.catchUp(groupId, since);
    for (const w of winners) {
      state = await engine.processHandshake(state, fromBase64(w.commit));
    }
  }
  throw new Error('exceeded max rebase attempts');
}

/**
 * 1:1 single-recipient Add delegate. Kept as the contract-blessed single-recipient
 * form and as the entry point the real-engine rebase regression test
 * (__tests__/mls/mlsCoordinatorRebaseState.test.ts) drives directly: a real CAS rebase
 * has no valid winning commit at epoch 0 (sole member), so the move-not-borrow
 * reuse-after-zeroize hazard is only reachable at epoch >= 1 by calling this. The N-ary
 * commitAddMembersWithRebase owns the logic. Not part of the public coordinator API.
 */
export async function commitAddWithRebase(
  dmChannelId: string,
  groupId: string,
  baseState: MlsClientState,
  recipientUserId: string,
  recipientKp: Uint8Array,
): Promise<void> {
  await commitAddMembersWithRebase(dmChannelId, groupId, baseState, [
    { userId: recipientUserId, keyPackage: recipientKp },
  ]);
}

/**
 * Owner-authored Add orchestration: resolve the loaded groupId + the
 * persisted base state + one KeyPackage per new member, then commit the batched Add via
 * commitAddMembersWithRebase. Runs under the channel lock (caller-locks: the commit fn
 * does NOT self-lock, so wrapping here is required and not a nested-lock deadlock).
 * Called by utils/dmActions.addGroupDmMembers.
 */
export async function addGroupMembers(dmChannelId: string, memberUserIds: string[]): Promise<void> {
  return withChannelLock(dmChannelId, async () => {
    if (!_active || !_identity) throw new Error('mls not active');
    if (!isLeader()) throw new Error('mls not leader');
    const groupId = _loadedGroups.get(dmChannelId);
    if (!groupId) throw new Error('mls group not loaded');
    const loaded = await store.getGroup(dmChannelId);
    if (!loaded) throw new Error('mls group missing');
    // Consume one KeyPackage per new member device (one per member).
    const members: { userId: string; keyPackage: Uint8Array }[] = [];
    for (const userId of memberUserIds) {
      members.push({ userId, keyPackage: await consumeOneKeyPackage(userId) });
    }
    if (!_active || !isLeader()) throw new Error('mls torn down mid-add'); // after-await recheck
    await commitAddMembersWithRebase(dmChannelId, groupId, loaded.state, members);
  });
}

/**
 * Resolve a member's basic-credential identity bytes by DECODING each leaf's v2
 * credential and matching userId (one device per user, so it hits exactly
 * one leaf). Returns the leaf's REAL stored bytes — never re-encoded — because a
 * remover cannot recompute a target's AIK crossSig under v2; resolveLeafIndex then
 * full-byte-matches those exact bytes. THROWS if the user has no leaf — a missing
 * target must fail closed before any value reaches removeMembers (a -1 leaf index
 * hits the ts-mls level(-1) infinite loop; see mlsEngine.resolveLeafIndex).
 */
function credentialIdentityFor(state: MlsClientState, userId: string): Uint8Array {
  for (const node of state.ratchetTree) {
    if (node != null && node.nodeType === 'leaf') {
      const cred = node.leaf.credential;
      if (cred.credentialType !== 'basic') continue;
      try {
        if (decodeMlsCredentialIdentity(cred.identity).userId === userId) return cred.identity;
      } catch { /* malformed leaf credential: skip */ }
    }
  }
  throw new Error('credentialIdentityFor: member not in ratchet tree');
}

/**
 * Member-mode batched Remove commit (N members) with the CAS rebase loop. One
 * engine.removeMembers over the resolved leaf indices produces a single Commit and NO
 * Welcome (a Remove seals nothing); the one submitCommit carries removedUserIds and NO
 * welcomes. On a 409 'rebase' conflict we replay the winning commit(s) onto our INTACT
 * base state, re-resolve the leaves against the rebased clone (the tree shifts as members
 * join/leave), rebuild the Remove on the new epoch, and resubmit. The idempotency key is
 * deterministic per (groupId, baseEpoch, sorted-set-of-targets): a network-timeout resubmit
 * onto the SAME baseEpoch with the SAME target set reuses the key; a genuine rebase onto a
 * NEW baseEpoch yields a new key. Persists the final accepted state.
 *
 * Near-clone of commitAddMembersWithRebase; the loop is GUARD-FREE for the same
 * reason — teardown discipline lives in the removeGroupMembers wrapper (entry guard +
 * after-await recheck). The only differences: no KeyPackage to copy (Remove carries leaf
 * indices only), leaves are resolved on the per-attempt CLONE, and the submit sends
 * removedUserIds with no welcomes.
 */
export async function commitRemoveMembersWithRebase(
  dmChannelId: string,
  groupId: string,
  baseState: MlsClientState,
  targetUserIds: string[],
): Promise<void> {
  // Sorted-set token: dedupe + sort + join so the key is stable across attempts (only
  // baseEpoch changes on a rebase).
  const recipientSetToken = [...new Set(targetUserIds)].sort().join(',');
  let state = baseState;
  for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt++) {
    const baseEpoch = engine.currentEpoch(state).toString();
    // Move-not-borrow: feed removeMembers a CLONE of the base state, never `state`
    // itself. ts-mls createCommit returns the input state's own keySchedule.initSecret
    // in `consumed` and removeMembers zeroizes consumed buffers in place. On a 409 we
    // replay the winner onto `state` via processHandshake below, so `state` must stay
    // intact — let the throwaway clone absorb the zeroize. Resolve leaf indices on the
    // CLONE (the tree shifts across rebases), failing closed if a target is absent.
    const removeInput = engine.decodeState(engine.encodeState(state));
    const leafIndices = targetUserIds.map((uid) =>
      engine.resolveLeafIndex(removeInput, credentialIdentityFor(removeInput, uid)),
    );
    const { newState, commit } = await engine.removeMembers(removeInput, leafIndices, true);
    const newGroupInfo = await engine.makeGroupInfo(newState);
    const idempotencyKey = await net.idempotencyKeyFor(groupId, baseEpoch, 'remove', recipientSetToken);
    const result = await net.submitCommit({
      groupId,
      baseEpoch,
      mode: 'member',
      commitB64: toBase64(commit),
      groupInfoB64: toBase64(newGroupInfo),
      idempotencyKey,
      removedUserIds: targetUserIds,
    });

    if (result.ok) {
      const epoch = BigInt(result.epoch);
      await persistGroup(dmChannelId, groupId, newState, epoch);
      return;
    }

    if (result.conflict !== 'rebase') {
      // refetch_group_info is external mode; not reachable here.
      throw new Error(`unexpected commit conflict: ${result.conflict}`);
    }

    // Rebase: replay the winning commit(s) onto our intact base state, then retry.
    const since = engine.currentEpoch(state).toString();
    const winners = await net.catchUp(groupId, since);
    for (const w of winners) {
      state = await engine.processHandshake(state, fromBase64(w.commit));
    }
  }
  throw new Error('exceeded max rebase attempts');
}

/**
 * Owner-authored Remove orchestration: resolve the loaded groupId + the
 * persisted base state, then commit the batched Remove via commitRemoveMembersWithRebase.
 * Runs under the channel lock (caller-locks: the commit fn does NOT self-lock, so wrapping
 * here is required and not a nested-lock deadlock). Mirrors addGroupMembers. Called by
 * utils/dmActions.kickFromGroupDM.
 */
export async function removeGroupMembers(dmChannelId: string, targetUserIds: string[]): Promise<void> {
  return withChannelLock(dmChannelId, async () => {
    if (!_active || !_identity) throw new Error('mls not active');
    if (!isLeader()) throw new Error('mls not leader');
    const groupId = _loadedGroups.get(dmChannelId);
    if (!groupId) throw new Error('mls group not loaded');
    const loaded = await store.getGroup(dmChannelId);
    if (!loaded) throw new Error('mls group missing');
    await commitRemoveMembersWithRebase(dmChannelId, groupId, loaded.state, targetUserIds);
  });
}

/**
 * Author the Remove of an absent self-leaver, invoked by the
 * repurposed leader-election when THIS client is the elected oldest-remaining
 * member. Holds withChannelLock (caller-locks). NO-OPS (returns, never throws)
 * when this tab is not active / not leader / has no loaded MLS group for the
 * channel — it is a fire-and-forget leader-election handler, not a user action.
 * Mirrors removeGroupMembers but with the not-leader/no-group guards softened to
 * a silent return.
 */
export async function removeAbsentLeaver(dmChannelId: string, leaverUserId: string): Promise<void> {
  return withChannelLock(dmChannelId, async () => {
    if (!_active || !isLeader()) return;
    const groupId = _loadedGroups.get(dmChannelId);
    if (!groupId) return;
    const loaded = await store.getGroup(dmChannelId);
    if (!loaded) return;
    await commitRemoveMembersWithRebase(dmChannelId, groupId, loaded.state, [leaverUserId]);
  });
}

/**
 * Decide whether THIS client authors the absent-leaver Remove on a
 * repurposed `dm-key-rotation-needed` leader-election. The caller (App.tsx) has
 * already confirmed the channel is MLS. Only the elected oldest-remaining member
 * commits, targeting the EXPLICIT leaverId the server carried in the payload (the
 * server is authoritative; the local roster is mutated by dm-participant-left before
 * this fires, so reconstructing the leaver from it is unsound — that was the bug).
 * Dispatches removeAbsentLeaver fire-and-forget (the leader-election event must not
 * block). No React; reuses the EXISTING `dm-key-rotation-needed` event with one
 * additive optional `leaverId` field (no new event/schema).
 */
export function handleGroupLeaderElection(
  data: { dmChannelId: string; oldestMemberId: string; memberIds: string[]; leaverId?: string },
  currentUserId: string | undefined,
): void {
  if (!currentUserId || currentUserId !== data.oldestMemberId) return;
  const leaverId = data.leaverId;
  if (!leaverId || leaverId === currentUserId) return;
  void removeAbsentLeaver(data.dmChannelId, leaverId).catch(() => undefined);
}

// External-Commit self-join

/** Resolve a channel's server groupId via a fresh getDMs pass (mlsGroupId). null = no group yet. */
async function resolveServerGroupId(dmChannelId: string, tier: MlsTier = 'saved'): Promise<string | null> {
  try {
    const dms = await net.getDMs();
    const dm = dms.find((d) => d.id === dmChannelId);
    return (tier === 'otr' ? dm?.otrMlsGroupId : dm?.mlsGroupId) ?? null;
  } catch (err) {
    logger.warn('[mls][external] resolveServerGroupId failed', { channelId: dmChannelId, error: (err as Error)?.message });
    return null;
  }
}

/**
 * External-Commit self-join. Refuses an epoch-0 GroupInfo (creator-only;
 * the non-creator awaits the Welcome). Otherwise builds the External Commit off the
 * fetched GroupInfo and submits in 'external' mode. A 'refetch_group_info' 409 means
 * we lost the CAS as a non-member (cannot replay) -> discard, refetch a fresh-epoch
 * GroupInfo, retry (bounded). Persists + classifies + marks loaded on success.
 */
export async function joinViaExternalCommit(dmChannelId: string, groupId: string, tier: MlsTier = 'saved'): Promise<void> {
  const rk = roomKey(dmChannelId, tier);
  await withChannelLock(rk, async () => {
    if (_loadedGroups.has(rk)) return; // idempotent under the lock
    for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt++) {
      if (!_active || !isLeader() || !_identity) throw new Error('mls not active/leader');
      const { groupInfo, groupInfoEpoch } = await net.getGroupInfo(groupId);
      if (BigInt(groupInfoEpoch) === 0n) {
        // Epoch-0 group = creator-only; we have no leaf and the Welcome is en route.
        // Stay not-ready (fail closed); the onMlsWelcome drain / next open establishes it.
        logger.warn('[mls][external] epoch-0 group; awaiting welcome', { channelId: dmChannelId });
        return;
      }
      const { newState, commit } = await engine.joinExternal(
        engine.copyBytes(fromBase64(groupInfo)),
        _identity.identity,
      );
      const newGroupInfo = await engine.makeGroupInfo(newState);
      const idempotencyKey = await net.idempotencyKeyFor(groupId, groupInfoEpoch, 'external', _identity.userId);
      const result = await net.submitCommit({
        groupId,
        baseEpoch: groupInfoEpoch,
        mode: 'external',
        commitB64: toBase64(commit),
        groupInfoB64: toBase64(newGroupInfo),
        idempotencyKey,
      });
      if (result.ok) {
        if (!_active || !isLeader()) throw new Error('mls torn down mid-join'); // after-await recheck
        await persistGroup(dmChannelId, groupId, newState, BigInt(result.epoch), tier);
        _loadedGroups.set(rk, groupId);
        _groupToChannel.set(groupId, rk);
        classification.markMls(dmChannelId); // BARE id — never the room key
        emitReadyChannel(rk); // channel is ready now (fires history-restore retry)
        return;
      }
      if (result.conflict !== 'refetch_group_info') {
        throw new Error(`unexpected external commit conflict: ${result.conflict}`);
      }
      // Lost the CAS as a non-member: discard newState (GC) and refetch a fresh GroupInfo.
    }
    throw new Error('exceeded max external-commit attempts');
  });
}

// OTR tier teardown

/**
 * Drop the local OTR group state for a channel. The Saved group (the
 * bare-keyed durable archive) is left untouched. Keyed by the OTR room key so it can
 * never collide with the Saved tier's bare key.
 */
export async function endOtrGroup(dmChannelId: string): Promise<void> {
  const rk = roomKey(dmChannelId, 'otr');
  await withChannelLock(rk, async () => {
    const groupId = _loadedGroups.get(rk);
    await store.deleteGroup(rk);
    _loadedGroups.delete(rk);
    if (groupId) _groupToChannel.delete(groupId);
    _lastEpoch.delete(rk);
    emitReadyChannel(rk); // readiness recompute; UI re-reads
  });
}

/** Bare dmChannelIds that currently have a local OTR group (for the teardown warning). */
export async function listOtrChannels(): Promise<string[]> {
  const g2c = await store.getGroupIdToChannelMap();
  const out: string[] = [];
  for (const [, { channelId, tier }] of g2c) if (tier === 'otr') out.push(channelId);
  return out;
}

// Message crypto (fail closed)

export function encrypt(dmChannelId: string, plaintext: string, tier: MlsTier = 'saved'): Promise<string> {
  const rk = roomKey(dmChannelId, tier);
  // Serialize per channel: two concurrent encrypts must NOT both read the same
  // base state (the second putGroup would clobber the first's ratchet advance).
  return withChannelLock(rk, async () => {
    if (!isReadyForChannel(dmChannelId, tier)) {
      throw new Error('mls channel not ready');
    }
    const groupId = _loadedGroups.get(rk)!;
    const loaded = await store.getGroup(rk);
    if (!loaded) throw new Error('mls group missing');
    // A group persisted under a PREVIOUS ciphersuite decodes fine but every engine
    // op then runs the current getImpl() KDF/AEAD over the old suite's secrets (a
    // WebCrypto HMAC-length brick on send). healSuiteMismatchedGroups only sweeps at
    // activation, so a long-lived post-cutover session that never reloads would stay
    // bricked-on-send. Drop+forget reactively so the channel re-establishes on the
    // current suite via External-Commit: this send fails (locked shield), the next
    // succeeds — same outcome as the activation sweep, without requiring a reload.
    const encSuite = loaded.state.groupContext?.cipherSuite;
    if (encSuite !== undefined && encSuite !== MLS_CIPHERSUITE_NAME) {
      await dropGroupAndForget(dmChannelId, groupId);
      logger.warn('[mls] dropped group on stale ciphersuite mid-session (encrypt); will re-establish', { channelId: dmChannelId });
      throw new Error('mls group on stale ciphersuite; dropped, will re-establish');
    }
    const { newState, privateMessage } = await engine.encryptApp(
      loaded.state,
      new TextEncoder().encode(plaintext),
    );
    // App-message encrypt advances the message ratchet, NOT the MLS epoch — persist
    // directly (no epoch-change fan-out).
    await store.putGroup(rk, groupId, newState, engine.currentEpoch(newState), { channelId: dmChannelId, tier });
    return encodeMlsEnvelope(privateMessage);
  });
}

export function decrypt(dmChannelId: string, envelopeContent: string, messageId?: string, tier: MlsTier = 'saved'): Promise<string> {
  const rk = roomKey(dmChannelId, tier);
  return withChannelLock(rk, async () => {
    // Leadership-free re-display path (in-session cache + durable archive): reading
    // this user's OWN already-decrypted plaintext needs only the installed historyKey,
    // NOT the writer lease or a live group, so it must precede the readiness gate. On a
    // plain refresh this decrypt re-runs while activateTail is still acquiring leadership
    // in the background (isReadyForChannel false); gating these reads behind readiness
    // would strand a received message whose single-use ratchet was already consumed as a
    // permanent lock placeholder. The ratchet-advancing live path below stays gated.
    // 1. In-session cross-tab idempotency cache (keyed by envelope; cheapest, no IO).
    // Cross-tab idempotency: serve an already-decrypted envelope from cache so a
    // sibling tab never re-runs the single-use ratchet (which would throw). The
    // per-channel lock makes this check race-safe — the loser sees the winner's entry.
    const cacheKey = rk + ' ' + envelopeContent;
    const cached = _plaintextCache.get(cacheKey);
    if (cached !== undefined) return cached;
    // 2. Durable archive, keyed by the envelope hash: survives reload
    //    after the single-use ratchet has zeroized the message key. A hit is the
    //    plaintext of exactly this ciphertext, so it is correct by construction:
    //    an edited message hashes differently and simply misses. Read on EVERY
    //    path (no messageId needed); populate the in-memory cache from a hit.
    const envHash = await sha256Hex(envelopeContent);
    if (tier === 'saved') {
      const archived = await store.getHistory(rk, envHash);
      if (archived !== null) {
        _plaintextCache.set(cacheKey, archived);
        return archived;
      }
    }
    // Past the leadership-free reads: everything below advances/zeroizes the single-use
    // ratchet (live decrypt) or persists state, which needs the live group AND the
    // writer lease. Gate HERE (not at the top) so the cache/archive reads above stay
    // reachable on a non-leader / not-yet-ready tab during the reload window.
    if (!isReadyForChannel(dmChannelId, tier)) {
      throw new Error('mls channel not ready');
    }
    // Preview ratchet-burn guard: a no-messageId decrypt is a
    // DERIVATIVE preview (sidebar last-message). Running the single-use ratchet
    // here would advance + zeroize the message key WITHOUT a delete-targetable
    // archive write, so after a reload the message would be a permanent lock
    // placeholder that cannot be re-decrypted or healed. Defer: preserve the key
    // so the id-bearing path (channel open / live arrival) decrypts AND archives
    // it. Already-archived/cached previews returned above; this only defers a
    // never-yet-seen preview, which shows the placeholder until opened.
    if (!messageId && tier === 'saved') {
      throw new Error('mls preview decrypt deferred (no messageId)');
    }
    // 3. Live decrypt: advances + zeroizes the single-use ratchet.
    const groupId = _loadedGroups.get(rk)!;
    const msgBytes = tryParseMlsEnvelope(envelopeContent);
    if (!msgBytes) throw new Error('not a v4 mls envelope');
    const loaded = await store.getGroup(rk);
    if (!loaded) throw new Error('mls group missing');
    // Mid-session ciphersuite-mismatch heal (see encrypt()). Drop + re-establish
    // rather than run the current suite's AEAD over a prior suite's secrets. The
    // cache/archive read paths above are unaffected (they never touch the ratchet).
    const decSuite = loaded.state.groupContext?.cipherSuite;
    if (decSuite !== undefined && decSuite !== MLS_CIPHERSUITE_NAME) {
      await dropGroupAndForget(dmChannelId, groupId);
      logger.warn('[mls] dropped group on stale ciphersuite mid-session (decrypt); will re-establish', { channelId: dmChannelId });
      throw new Error('mls group on stale ciphersuite; dropped, will re-establish');
    }
    const { newState, plaintext } = await engine.decryptApp(loaded.state, msgBytes);
    const text = new TextDecoder().decode(plaintext);
    const epoch = engine.currentEpoch(newState);
    // Persist the advanced ratchet, plus the plaintext when this is a Saved channel
    // with an unlocked history key AND a stable messageId (so the row is delete-
    // targetable). The archive write + ratchet snapshot ride ONE IndexedDB
    // transaction. Quota / write failure: log + warn-once and persist
    // NOTHING (the ratchet stays at its pre-advance position, so the message
    // re-decrypts cleanly next load): never delete Saved content.
    if (tier === 'saved' && messageId && store.getHistoryKey() !== null) {
      try {
        await store.putGroupAndHistory(rk, groupId, newState, epoch, { messageId, plaintext: text, envHash });
      } catch (err) {
        handleArchiveWriteError(err);
      }
    } else {
      await store.putGroup(rk, groupId, newState, epoch, { channelId: dmChannelId, tier }); // OTR: no durable archive
    }
    _plaintextCache.set(cacheKey, text);
    if (_plaintextCache.size > PLAINTEXT_CACHE_MAX) {
      // FIFO eviction: drop the oldest entry (Map preserves insertion order).
      _plaintextCache.delete(_plaintextCache.keys().next().value as string);
    }
    return text;
  });
}

/**
 * Derive the SFrame base key for this channel's call from the MLS
 * exporter (RFC 9605 §5.2: label "SFrame 1.0 Base Key", empty context,
 * 32 bytes; the epoch is implicitly bound because exporterSecret rotates
 * per epoch). Read-only: exportSecret does not advance the ratchet; the
 * channel lock is held only for read consistency with concurrent commits.
 * Returns null (never throws) when the channel is not MLS-ready so the
 * caller can fall back to the legacy SFrame key (the fallback ladder).
 */
export function deriveSframeBaseKey(dmChannelId: string): Promise<{ keyB64: string; epoch: string } | null> {
  return withChannelLock(dmChannelId, async () => {
    if (!isReadyForChannel(dmChannelId)) return null;
    const loaded = await store.getGroup(dmChannelId);
    if (!loaded) return null;
    const raw = await engine.exportSecret(
      loaded.state,
      engine.SFRAME_EXPORTER_LABEL,
      new Uint8Array(0),
      engine.SFRAME_BASE_KEY_LEN,
    );
    const epoch = engine.currentEpoch(loaded.state).toString();
    const keyB64 = toBase64(raw);
    zeroFill(raw);
    return { keyB64, epoch };
  });
}

// Incoming handshake / welcome (leader only)

async function handleIncomingCommit(e: { groupId: string; epoch: string; commit: string }): Promise<void> {
  if (!isLeader()) return;
  const dmChannelId = _groupToChannel.get(e.groupId);
  if (!dmChannelId) return;
  // Serialize per channel so an incoming commit's read-modify-write can't race a
  // concurrent encrypt/decrypt/join on the same channel (within-tab guard).
  await withChannelLock(dmChannelId, async () => {
    try {
      const loaded = await store.getGroup(dmChannelId);
      if (!loaded) return;
      // Drop stale epochs (ts-mls also rejects them; this avoids the work).
      if (BigInt(e.epoch) <= loaded.meta.lastAppliedEpoch) return;
      const newState = await engine.processHandshake(loaded.state, fromBase64(e.commit));
      await persistGroup(dmChannelId, e.groupId, newState, engine.currentEpoch(newState));
    } catch (err) {
      if (await healIfOrphanedGroup(dmChannelId, e.groupId, err)) {
        // Live (post-activation) heal-drop: unlike the activate-time heal there is no
        // mls-ready to re-establish this channel, so surface the resync banner. The row
        // is gone, so the next reload/send/open re-establishes via External-Commit, and
        // the banner clears on that re-establish's epoch advance.
        emitApplyFailed({ dmChannelId, epoch: e.epoch });
        return;
      }
      logger.error('[mls][commit] apply failed; group stays at prior epoch', { channelId: dmChannelId, epoch: e.epoch, error: (err as Error)?.message });
      emitApplyFailed({ dmChannelId, epoch: e.epoch });
    }
  });
}

// Coalesce overlapping welcome drains: every 'mls-welcome' socket event would
// otherwise fire a full joinPendingWelcomes (getWelcomes + getDMs) — a storm of
// redundant fetches when many Welcomes land at once. A drain already running
// satisfies callers that join before it started; a Welcome that arrives AFTER the
// current drain began schedules exactly ONE follow-up drain so it is still picked
// up. Correctness: every event is covered by either the running drain or the
// single trailing drain.
let _drainInFlight: Promise<void> | null = null;
let _drainQueued = false;

function runWelcomeDrain(): Promise<void> {
  if (_drainInFlight) {
    // A drain is already running; ensure exactly one more runs after it so a
    // Welcome that arrived mid-drain is not missed.
    _drainQueued = true;
    return _drainInFlight;
  }
  _drainInFlight = (async () => {
    try {
      await joinPendingWelcomes();
      // Drain any follow-ups requested while this drain was running. Loops so a
      // burst collapses to back-to-back drains, never overlapping ones.
      while (_drainQueued) {
        _drainQueued = false;
        await joinPendingWelcomes();
      }
    } finally {
      _drainInFlight = null;
    }
  })();
  return _drainInFlight;
}

async function handleIncomingWelcome(_e: { groupId: string; epoch: string }): Promise<void> {
  if (!isLeader()) return;
  await runWelcomeDrain();
}

// Welcome join + catch-up + KP replenish (leader only)

/**
 * Pull pending Welcomes and join each whose group we can map to a dmChannelId.
 *
 * The groupId -> dmChannelId map is built as the UNION of the store map and
 * a fresh getDMs() pass (each channel's mlsGroupId). A
 * brand-new conversation's Welcome has no local store row yet, so the getDMs
 * pass is what maps it. An unmapped Welcome is LEFT PENDING (never consumed/
 * dropped) — it retries on the next drain once getDMs surfaces the channel.
 *
 * On a successful join: persist, delete the consumed init key (RFC 9750), and if
 * the consumed KeyPackage was last-resort, self-update to heal PCS.
 */
async function joinPendingWelcomes(): Promise<void> {
  if (!isLeader()) return;
  const welcomes = await net.getWelcomes();
  if (welcomes.length === 0) return;

  // Union mapping: store map + a fresh getDMs() pass, built BEFORE the
  // per-welcome resolve. Each entry carries the tier so the join is keyed by the
  // correct room key below.
  const mapping = new Map<string, { channelId: string; tier: MlsTier }>(); // groupId -> { channelId, tier }
  const storeMap = await store.getGroupIdToChannelMap();
  // Map every joined group, Saved AND OTR. An OTR group is keyed by its OTR room
  // key in the per-welcome loop, so it can NEVER write into the Saved (bare-id)
  // bucket — the corruption property a blanket OTR-skip would protect,
  // here preserved by room-key isolation instead.
  for (const [groupId, { channelId, tier }] of storeMap) {
    mapping.set(groupId, { channelId, tier });
  }
  try {
    const dms = await net.getDMs();
    for (const dm of dms) {
      if (dm.mlsGroupId) mapping.set(dm.mlsGroupId, { channelId: dm.id, tier: 'saved' });
      // A brand-new OTR group (the recipient's first join) is surfaced by its
      // otrMlsGroupId: the device processes the counterparty's Welcome and joins
      // the OTR tier, keyed by the OTR room key so the Saved tier is
      // untouched.
      if (dm.otrMlsGroupId) mapping.set(dm.otrMlsGroupId, { channelId: dm.id, tier: 'otr' });
    }
  } catch (err) {
    logger.warn('[mls][welcome] getDMs mapping failed', { error: (err as Error)?.message });
  }

  // The candidate set depends only on THIS device's local KeyPackages, not on
  // any welcome, so compute it ONCE per drain instead of re-reading the whole KP
  // store inside the per-welcome loop. A candidate consumed by an earlier welcome in
  // this same drain stays in the list but is harmless: each Welcome is sealed to a
  // distinct KeyPackage, so a stale candidate simply fails HPKE decap for a later
  // welcome (joinFromWelcome copies each candidate's bytes per attempt — move-safe).
  const candidates = await store.getAllKeyPackageCandidates();
  for (const w of welcomes) {
    const entry = mapping.get(w.groupId);
    if (!entry) {
      // Unmapped — leave pending; it will retry on the next drain.
      logger.warn('[mls][welcome] groupId not yet mapped; leaving pending', {});
      continue;
    }
    const { channelId, tier } = entry;
    const rk = roomKey(channelId, tier);
    if (_loadedGroups.has(rk)) continue; // already joined (per-tier, room-key isolated)
    // Serialize the join (and its last-resort heal) per room so it can't race
    // a concurrent op on the same tier. healLastResort is called INSIDE this
    // lock — it must NOT re-take the lock or it deadlocks.
    await withChannelLock(rk, async () => {
      try {
        const { state, consumedKpRef, isLastResort } = await engine.joinFromWelcome(
          engine.copyBytes(fromBase64(w.welcomeData)),
          candidates,
        );
        await persistGroup(channelId, w.groupId, state, engine.currentEpoch(state), tier);
        _loadedGroups.set(rk, w.groupId);
        _groupToChannel.set(w.groupId, rk);
        // RFC 9750: delete the consumed init key so it cannot be reused.
        await store.deleteKpPrivate(consumedKpRef);
        classification.markMls(channelId); // durable classification is ALWAYS the bare id
        emitReadyChannel(rk); // channel is ready now (fires history-restore retry)

        // A last-resort KeyPackage is reused across many joins, so its init key
        // never rotates on its own; heal PCS immediately with a self-update.
        if (isLastResort) {
          await healLastResort(channelId, w.groupId, state, tier);
        }
      } catch (err) {
        logger.warn('[mls][welcome] join failed', { channelId, tier, error: (err as Error)?.message });
      }
    });
  }
}

/**
 * After joining via a last-resort KeyPackage, emit a self-update Commit so our
 * leaf rotates (forward secrecy / PCS heal). Member-mode submit; persists the
 * post-update state. A conflict here just means a peer commit landed first — we
 * leave the heal for the next drain rather than racing.
 */
async function healLastResort(dmChannelId: string, groupId: string, joinedState: MlsClientState, tier: MlsTier = 'saved'): Promise<void> {
  const ok = await commitSelfUpdate(dmChannelId, groupId, joinedState, tier);
  if (!ok) logger.warn('[mls][welcome] last-resort heal deferred (conflict)', { channelId: dmChannelId });
}

/**
 * Emit a self-Update Commit for ONE loaded group: rotate our leaf, advance the
 * epoch, publish via the member-mode CAS submit path, persist + stamp on success.
 * LOCK-FREE — the caller MUST already hold withChannelLock(dmChannelId) and be
 * leader (mirrors how healLastResort runs inside joinPendingWelcomes' lock). On a
 * We DISCARD our locally-built newState (do NOT persist or stamp) in every case
 * except a clean, freshly-applied success, so the persisted row can never diverge
 * from the server/peers at a given epoch number:
 *  - CAS conflict (!result.ok): a peer commit landed first — the socket/catch-up
 *    path applies it; the next cadence tick re-reads the caught-up state and retries.
 *  - idempotent replay: the server already recorded a DIFFERENT self-Update at this
 *    baseEpoch (self-Update commits are randomized, so the deterministic idempotency
 *    key aliases distinct commits). Our newState is for a commit the server never
 *    applied — persisting it would silently diverge at the same epoch.
 *  - teardown / leadership loss / in-flight rekey during the round-trip: a write now
 *    could revive state after lock or land under an at-rest key that is mid-swap.
 * selfUpdate zeroizes the input state's consumed buffers in place, but on every
 * discard path we drop newState and re-getGroup next tick, so the persisted row is
 * never corrupted. Returns true iff a fresh commit was applied + stamped.
 */
async function commitSelfUpdate(dmChannelId: string, groupId: string, state: MlsClientState, tier: MlsTier = 'saved'): Promise<boolean> {
  // Legacy-leaf guard: a self-Update REUSES our existing leaf credential
  // (ts-mls createUpdatePath copies it; only the HPKE key rotates), so if our own
  // leaf in this group still carries a pre-v2 (undecodable) credential, the
  // committed leaf would fail v2 credential validation on every peer
  // (validateLeafNodeUpdateOrCommit) and desync the group. A self-Update therefore
  // CANNOT heal such a leaf — only re-keying it with a fresh v2 KeyPackage (re-join)
  // can. Skip until then; do NOT stamp, so it re-evaluates once the leaf is replaced.
  // Bounded to one log per channel per session (cleared on deactivate).
  if (engine.ownLeafCredentialIsLegacy(state)) {
    if (!_legacyLeafLogged.has(dmChannelId)) {
      _legacyLeafLogged.add(dmChannelId);
      logger.warn('[mls][pcs] skipping self-Update: own leaf carries a pre-v2 legacy credential (peers would reject); awaiting leaf replacement', {
        channelId: dmChannelId,
      });
    }
    return false;
  }
  const baseEpoch = engine.currentEpoch(state).toString();
  const { newState, commit } = await engine.selfUpdate(state);
  const newGroupInfo = await engine.makeGroupInfo(newState);
  const idempotencyKey = await net.idempotencyKeyFor(groupId, baseEpoch, 'selfupdate');
  const result = await net.submitCommit({
    groupId,
    baseEpoch,
    mode: 'member',
    commitB64: toBase64(commit),
    groupInfoB64: toBase64(newGroupInfo),
    idempotencyKey,
  });
  // Post-await recheck (the round-trip can straddle a peer commit, an idempotent
  // replay of a prior attempt, a teardown, or a rekey) — see the docstring.
  if (!result.ok || result.idempotent || !_active || !isLeader() || _rekeyInProgress) {
    return false;
  }
  await persistGroup(dmChannelId, groupId, newState, BigInt(result.epoch), tier);
  await store.setMeta(SELF_UPDATE_META_PREFIX + dmChannelId, Date.now().toString());
  return true;
}

/** Due iff never self-updated or the last self-update is older than the cadence. */
async function selfUpdateDue(dmChannelId: string): Promise<boolean> {
  const raw = await store.getMeta(SELF_UPDATE_META_PREFIX + dmChannelId);
  if (raw === null) return true;
  const last = Number(raw);
  if (!Number.isFinite(last)) return true; // garbage => treat as due
  if (last > Date.now()) return true; // future stamp (clock rewind) => treat as due
  return Date.now() - last >= SELF_UPDATE_CADENCE_MS;
}

/**
 * Walk every loaded group and self-Update the ones past the cadence, so a
 * read-only/idle member's leaf key rotates on a bounded schedule (PCS), not only
 * opportunistically. Leader-only; each channel under its own lock; tolerant of
 * heal-dropped rows; re-entrancy- and rekey-guarded; re-checks teardown after each
 * await (mirrors catchUpAllGroups).
 */
async function runSelfUpdateSweep(): Promise<void> {
  if (!_active || !isLeader() || _rekeyInProgress || _selfUpdateSweepRunning) return;
  _selfUpdateSweepRunning = true;
  try {
    for (const [dmChannelId, groupId] of [..._loadedGroups]) { // snapshot: a heal-drop can shrink the map
      if (!_active || !isLeader() || _rekeyInProgress) return;
      await withChannelLock(dmChannelId, async () => {
        try {
          if (!(await selfUpdateDue(dmChannelId))) return;
          const loaded = await store.getGroup(dmChannelId);
          if (!loaded) return;
          await commitSelfUpdate(dmChannelId, groupId, loaded.state);
        } catch (err) {
          if (await healIfOrphanedGroup(dmChannelId, groupId, err)) return;
          logger.warn('[mls][pcs] self-update skipped; will retry next cadence', {
            channelId: dmChannelId,
            error: (err as Error)?.message,
          });
        }
      });
    }
  } finally {
    _selfUpdateSweepRunning = false;
  }
}

/** Arm the bounded self-Update cadence (leader-only): an eager sweep now ("on
 *  activate") plus a periodic tick that self-updates due groups ("on a timer"). */
function startSelfUpdateScheduler(): void {
  stopSelfUpdateScheduler(); // idempotent re-arm
  void runSelfUpdateSweep(); // eager: close the PCS window at activation
  _selfUpdateTimer = setInterval(() => { void runSelfUpdateSweep(); }, SELF_UPDATE_TICK_MS);
}

function stopSelfUpdateScheduler(): void {
  if (_selfUpdateTimer) {
    clearInterval(_selfUpdateTimer);
    _selfUpdateTimer = null;
  }
}

/**
 * Is `err` a WebCrypto AES-GCM decrypt failure (a DOMException named
 * 'OperationError')? Matched by NAME, not `instanceof DOMException`: the worker
 * realm's DOMException can differ from the one the error was constructed against
 * (cross-realm / cross-environment), so an `instanceof` check is unsound. The
 * WebCrypto spec mandates the name 'OperationError' for a failed decrypt, so the
 * name is the reliable signal. A 'mls store locked' Error has name 'Error', so it
 * never matches.
 */
function isAtRestDecryptError(err: unknown): boolean {
  return typeof (err as { name?: unknown })?.name === 'string' && (err as { name: string }).name === 'OperationError';
}

/**
 * If `err` is an at-rest DECRYPT failure on a group row (a WebCrypto
 * 'OperationError' — the row is encrypted under a stale at-rest key, e.g. after a
 * cross-device password change), DROP the row and evict it from routing so the
 * channel re-establishes via External-Commit on the next establishChannel. Returns
 * true if it healed (caller must NOT also fail-loud). A 'mls store locked' Error is
 * NOT an orphan — return false and let the caller handle it.
 */
/** Drop a group's at-rest row AND evict it from every in-memory routing map so the
 *  channel re-establishes (External-Commit / create) on its next open/send. Shared by
 *  the orphaned-row heal (stale at-rest key) and the ciphersuite-change heal. */
async function dropGroupAndForget(dmChannelId: string, groupId: string): Promise<void> {
  // Evict by ROOM KEY, not the bare dmChannelId: the at-rest group row, _loadedGroups,
  // and _lastEpoch are all keyed by roomKey(dmChannelId, tier). For the saved (default)
  // tier roomKey === dmChannelId, but an OTR group's key is namespaced (#otr), so a
  // bare-id delete would leave the stale entry behind and the rejoin guard (keyed by the
  // room key) would no-op. Resolve the exact room key from the groupId -> roomKey map.
  const rk = _groupToChannel.get(groupId) ?? dmChannelId;
  await store.deleteGroup(rk).catch(() => undefined);
  _loadedGroups.delete(rk);
  _groupToChannel.delete(groupId);
  _lastEpoch.delete(rk);
}

async function healIfOrphanedGroup(dmChannelId: string, groupId: string, err: unknown): Promise<boolean> {
  if (!isAtRestDecryptError(err)) return false;
  // An at-rest OperationError seen while a password re-key is in flight is a
  // TRANSIENT stale-key artifact (rekeyAtRestStores rewrites each row under the NEW key
  // while the OLD key is still installed), NOT a genuine orphan. Never destroy a live
  // group row on it: wait the re-key out and leave the row intact — the commit that
  // tripped this stays at the prior epoch and MLS catch-up/resync recovers it.
  if (_rekeyBarrier) {
    await _rekeyBarrier;
    return false;
  }
  // No re-key was latched on entry. Re-read once under the now-current key to classify the
  // failure; drop ONLY a row that is still provably an at-rest orphan:
  //  - decodes now  -> a just-completed re-key swap, OR a non-at-rest OperationError thrown
  //    by the engine (e.g. processHandshake on a corrupt/desynced commit) on a perfectly
  //    readable row: KEEP it (the caller surfaces the resync banner; catch-up reconciles).
  //  - re-read throws a NON-at-rest error (e.g. 'mls store locked' from a concurrent
  //    deactivate, or a transient IO error): NOT a proven orphan -> KEEP, fail-loud.
  //  - a re-key latched DURING the re-read's await: KEEP and let it reconcile.
  //  - still an at-rest OperationError: a genuine orphan (e.g. a cross-device password
  //    change) -> drop so the channel re-establishes via External-Commit.
  let reErr: unknown;
  try {
    if (await store.getGroup(dmChannelId)) return false;
  } catch (e) {
    reErr = e;
  }
  if (_rekeyBarrier) {
    await _rekeyBarrier;
    return false;
  }
  if (reErr !== undefined && !isAtRestDecryptError(reErr)) return false;
  await dropGroupAndForget(dmChannelId, groupId);
  logger.warn('[mls] dropped undecryptable group row; channel will re-establish via External-Commit', { channelId: dmChannelId });
  return true;
}

/**
 * PQC cutover self-heal: drop any loaded group whose persisted ciphersuite differs
 * from the active suite (e.g. a pre-X-Wing codepoint-1 group after the default flips
 * to 83). Such a group decodes fine but every engine op runs the current getImpl()'s
 * KDF/AEAD over the old suite's secrets, so the WebCrypto HMAC import rejects the
 * mismatched-length key and the channel bricks on send. On a purged server there are
 * no catch-up commits to trip the existing apply-failed heal, so this MUST be a
 * proactive sweep, not a failure handler. Runs before joinPendingWelcomes/catchUp so
 * the dropped channel re-establishes on the current suite. Leader-only: getGroup
 * decrypts at rest (single-writer).
 */
async function healSuiteMismatchedGroups(): Promise<void> {
  if (!isLeader()) return;
  for (const [dmChannelId, groupId] of [..._loadedGroups]) {
    await withChannelLock(dmChannelId, async () => {
      let loaded: Awaited<ReturnType<typeof store.getGroup>>;
      try {
        loaded = await store.getGroup(dmChannelId);
      } catch {
        return; // an at-rest decrypt failure is the orphaned-row heal's concern, not this one
      }
      if (!loaded) return;
      if (loaded.state.groupContext.cipherSuite === MLS_CIPHERSUITE_NAME) return;
      await dropGroupAndForget(dmChannelId, groupId);
      logger.warn('[mls] dropped group persisted under a previous ciphersuite; channel will re-establish on the current suite', { channelId: dmChannelId });
    });
  }
}

async function catchUpAllGroups(): Promise<void> {
  if (!isLeader()) return;
  for (const [dmChannelId, groupId] of _loadedGroups) {
    // Serialize each channel's catch-up read-modify-write (within-tab guard).
    await withChannelLock(dmChannelId, async () => {
      try {
        const loaded = await store.getGroup(dmChannelId);
        if (!loaded) return;
        const commits = await net.catchUp(groupId, loaded.meta.lastAppliedEpoch.toString());
        let state = loaded.state;
        for (const c of commits) {
          state = await engine.processHandshake(state, fromBase64(c.commit));
        }
        if (commits.length > 0) {
          await persistGroup(dmChannelId, groupId, state, engine.currentEpoch(state));
        }
      } catch (err) {
        if (await healIfOrphanedGroup(dmChannelId, groupId, err)) return; // dropped + will re-establish
        // Best-effort epoch for the UI hint; '0' is a "stuck epoch unknown" sentinel
        // (the second getGroup itself throws under lock or on an orphaned row).
        const loaded = await store.getGroup(dmChannelId).catch(() => null);
        const stuckEpoch = loaded ? loaded.meta.lastAppliedEpoch.toString() : '0';
        logger.error('[mls][catchup] apply failed; group stays at prior epoch', { channelId: dmChannelId, epoch: stuckEpoch, error: (err as Error)?.message });
        emitApplyFailed({ dmChannelId, epoch: stuckEpoch });
      }
    });
  }
}

async function replenishKeyPackagesIfLow(): Promise<void> {
  if (!_identity || !isLeader()) return;
  const { remaining, hasLastResort } = await net.keyPackageCount(_identity.deviceId);
  if (remaining >= KEYPACKAGE_LOW_WATER && hasLastResort) return;
  const generated = await generateKeyPackages(_identity.identity, KEYPACKAGE_BATCH_SIZE, !hasLastResort);
  for (const g of generated) {
    await store.putKpPrivate(toBase64(g.keyPackageRef), g.keyPackage, g.privateKeyPackage, g.isLastResort);
  }
  await net.publishKeyPackages(
    _identity.deviceId,
    generated.map((g) => ({ keyPackage: toBase64(g.keyPackage), isLastResort: g.isLastResort })),
  );
}
