// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * mlsCoordinator dispatcher. The public MLS surface every consumer imports.
 * When SharedWorker exists, all MLS crypto runs in the single per-origin worker
 * (mlsWorker) and this module proxies calls over RPC, mirrors readiness for the
 * synchronous isActive/isReadyForChannel reads, applies set-classification,
 * relays socket events into the worker, and re-emits worker events. When
 * SharedWorker is absent, it runs mlsCoordinatorCore in-process under the
 * navigator.locks leader guard (fallback). Public signatures are identical on
 * both paths so no consumer changes.
 */
import * as core from './mlsCoordinatorCore';
import { mainNetwork, mainCommitWelcomeSource, mainClassificationSink, mainLeadershipGate } from './mlsSeams';
import { setChannelProtocol } from '../encryptionFlags';
import { logger } from '../logger';
import {
  newCorrelationId,
  type MainToWorker, type WorkerToMain, type ProxiedMethod, type MlsNetwork,
} from './mlsWorkerProtocol';
import { roomKey, type MlsTier } from './roomKey';
import type { MlsIdentityBundle } from './mlsIdentity';

// Re-exported event buses (local registries, fed by the active path)
type MlsLockState = 'mls-ready' | 'mls-locked';
const _lockListeners = new Set<(e: MlsLockState) => void>();
export interface MlsLockEvents { on(cb: (e: MlsLockState) => void): () => void; }
export const mlsEvents: MlsLockEvents = { on(cb) { _lockListeners.add(cb); return () => _lockListeners.delete(cb); } };
// Dedup latch (mirrors the core's): a worker can deliver mls-locked from more than
// one path (core.deactivate emit + a failure handler); never double-fire to listeners.
let _lockedEmitted = false;
function emitLock(e: MlsLockState): void {
  if (e === 'mls-locked') { if (_lockedEmitted) return; _lockedEmitted = true; } else { _lockedEmitted = false; }
  for (const cb of _lockListeners) { try { cb(e); } catch (err) { logger.error('[mls][dispatch] lock listener threw', { error: (err as Error)?.message }); } }
}

interface EpochChangeEvent { dmChannelId: string; groupId: string; epoch: string; }
const _epochListeners = new Set<(e: EpochChangeEvent) => void>();
export function onEpochChange(cb: (e: EpochChangeEvent) => void): () => void { _epochListeners.add(cb); return () => { _epochListeners.delete(cb); }; }
function emitEpoch(e: EpochChangeEvent): void { for (const cb of _epochListeners) { try { cb(e); } catch (err) { logger.error('[mls][dispatch] epoch listener threw', { error: (err as Error)?.message }); } } }

interface MlsApplyFailedEvent { dmChannelId: string; epoch: string; }
const _applyFailedListeners = new Set<(e: MlsApplyFailedEvent) => void>();
export function onApplyFailed(cb: (e: MlsApplyFailedEvent) => void): () => void { _applyFailedListeners.add(cb); return () => { _applyFailedListeners.delete(cb); }; }
function emitApplyFailed(e: MlsApplyFailedEvent): void { for (const cb of _applyFailedListeners) { try { cb(e); } catch (err) { logger.error('[mls][dispatch] apply-failed listener threw', { error: (err as Error)?.message }); } } }

// Emitted when the local DM history archive is restored for a channel
// (dmChannelId set) or after the eager bulk pass (dmChannelId null). The restore
// originates on the main thread, so emitHistoryRestored is exported and called
// directly — no worker round-trip.
interface HistoryRestoredEvent { dmChannelId: string | null; }
const _historyRestoredListeners = new Set<(e: HistoryRestoredEvent) => void>();
export function onHistoryRestored(cb: (e: HistoryRestoredEvent) => void): () => void { _historyRestoredListeners.add(cb); return () => { _historyRestoredListeners.delete(cb); }; }
export function emitHistoryRestored(e: HistoryRestoredEvent): void { for (const cb of _historyRestoredListeners) { try { cb(e); } catch (err) { logger.error('[mls][dispatch] history-restored listener threw', { error: (err as Error)?.message }); } } }

// Emitted when a DM channel NEWLY transitions to ready (established + loaded)
// AFTER activation. A fresh device self-joins via External Commit concurrently
// with opening the DM; the worker pushes a 'readiness' message that adds the
// channel to the mirror but emits no event, and the self-join fires neither
// 'mls-ready' nor onEpochChange(ch) on this device, so the lazy history restore
// would never retry (history would fill only after a reload). Fed by the
// worker-path readiness diff (onWorkerMessage 'readiness') and, on the fallback,
// core.onReadyChannel.
const _readyChannelListeners = new Set<(dmChannelId: string) => void>();
export function onReadyChannel(cb: (dmChannelId: string) => void): () => void { _readyChannelListeners.add(cb); return () => { _readyChannelListeners.delete(cb); }; }
function emitReadyChannel(dmChannelId: string): void { for (const cb of _readyChannelListeners) { try { cb(dmChannelId); } catch (err) { logger.error('[mls][dispatch] ready-channel listener threw', { error: (err as Error)?.message }); } } }

// Remember-the-fallback: once a device's worker is observed to hang on init, we record
// it so EVERY later page load skips the worker up front and goes straight to in-process —
// no repeated init-timeout wait, no locked flash. Feature detection can't pre-empt this
// (a trivial probe worker loads fine on mobile WebKit; only the real ts-mls module graph
// hangs), so the device's own prior behavior is the signal. localStorage may throw
// (private mode / disabled storage); never let that break path selection.
const WORKER_UNSUPPORTED_KEY = 'howl:mls:worker-unsupported';
function workerMarkedUnsupported(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(WORKER_UNSUPPORTED_KEY) === '1'; } catch { return false; }
}
function rememberWorkerUnsupported(): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(WORKER_UNSUPPORTED_KEY, '1'); } catch { /* ignore */ }
}

// Path selection. Mutable: starts as the SharedWorker capability check (minus any
// remembered hang), but flips to false PERMANENTLY for the session if the worker fails
// to initialize (mobile WebKit spawns the module SharedWorker yet its module graph never
// finishes loading, so init is never acked). One flip re-routes EVERY downstream
// read/proxy (isActive, isReadyForChannel, deactivate, rekey, proxy) onto the in-process
// core fallback — which deactivate()/rekey() require, since they early-return on a null
// workerPort.
let useWorker = typeof SharedWorker !== 'undefined' && !workerMarkedUnsupported();
let worker: SharedWorker | null = null;
let workerPort: MessagePort | null = null;
// Bumped by every deactivate(). Lets a pending activate() detect that a deliberate
// teardown (lock / logout / idle-lock) raced its worker-init and rejected the init
// promise — so the catch can stay locked instead of resurrecting MLS on the fallback.
let _teardownSeq = 0;

// Readiness mirror (worker path) so isActive/isReadyForChannel stay synchronous.
let _mirrorActive = false;
const _mirrorReady = new Set<string>();

// Pending RPC + init/lock replies keyed by correlationId.
const _pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
// The main-thread network the worker proxies into, and the socket source we relay.
const _net: MlsNetwork = mainNetwork();
const _socketUnsub: Array<() => void> = [];

function startWorker(): void {
  if (worker) return;
  worker = new SharedWorker(new URL('./mlsWorker.ts', import.meta.url), { type: 'module' });
  workerPort = worker.port;
  workerPort.onmessage = (e: MessageEvent) => { void onWorkerMessage(e.data as WorkerToMain); };
  // Recovery: a crashed/errored worker must not leave the mirror stale-true
  // (isReadyForChannel would pass and a send would post to a dead port and hang). Reset
  // to locked, reject outstanding rpc so the send seam fails closed, and allow a fresh
  // activate() to re-spawn the worker (durable state is in IndexedDB).
  const onWorkerFailure = (err: unknown): void => {
    // After a fallback flip (useWorker=false) the in-process core owns MLS; a late
    // error event from the abandoned worker must NOT reset the mirror or emit
    // 'mls-locked' (it would wrongly signal locked while the core is active).
    if (!useWorker) return;
    logger.error('[mls][dispatch] worker error; resetting MLS', { error: (err as { message?: string })?.message });
    _mirrorActive = false; _mirrorReady.clear();
    rejectAllPending(new Error('mls worker error'));
    emitLock('mls-locked');
    worker = null; workerPort = null;
    for (const u of _socketUnsub.splice(0)) { try { u(); } catch { /* ignore */ } }
  };
  worker.onerror = onWorkerFailure;
  workerPort.onmessageerror = onWorkerFailure;
  workerPort.start();
  // Relay this tab's socket mls-commit/mls-welcome into the worker (every tab relays;
  // the core dedupes). Subscribe once.
  const src = mainCommitWelcomeSource();
  _socketUnsub.push(src.onCommit((p) => post({ kind: 'socket-event', event: 'commit', payload: p })));
  _socketUnsub.push(src.onWelcome((p) => post({ kind: 'socket-event', event: 'welcome', payload: p })));
}

function rejectAllPending(err: Error): void {
  for (const [, p] of _pending) { try { p.reject(err); } catch { /* ignore */ } }
  _pending.clear();
}

// Abandon the worker when its init fails so the in-process fallback owns MLS cleanly:
// detach the worker's handlers (so a late error event can't re-enter), close our port,
// reject any in-flight rpc, drop the socket relays, and null the refs. Idempotent — the
// worker-error path's onWorkerFailure may have already nulled the refs.
function teardownWorker(): void {
  _mirrorActive = false; _mirrorReady.clear();
  rejectAllPending(new Error('mls worker torn down'));
  if (worker) { try { worker.onerror = null; } catch { /* ignore */ } }
  if (workerPort) {
    try { workerPort.onmessage = null; workerPort.onmessageerror = null; } catch { /* ignore */ }
    try { workerPort.close(); } catch { /* ignore */ }
  }
  worker = null; workerPort = null;
  for (const u of _socketUnsub.splice(0)) { try { u(); } catch { /* ignore */ } }
}

function post(msg: MainToWorker): void { workerPort?.postMessage(msg); }

async function onWorkerMessage(msg: WorkerToMain): Promise<void> {
  switch (msg.kind) {
    case 'rpc-result': {
      const p = _pending.get(msg.correlationId);
      if (!p) return;
      _pending.delete(msg.correlationId);
      if (msg.ok) p.resolve(msg.value);
      else {
        const { name, message, status, reason, unprovisionedUserId } = msg.error;
        p.reject(Object.assign(new Error(message), { name, ...(status !== undefined ? { status } : {}), ...(reason !== undefined ? { reason } : {}), ...(unprovisionedUserId !== undefined ? { unprovisionedUserId } : {}) }));
      }
      return;
    }
    case 'net-request': {
      try {
        const fn = _net[msg.method] as (...a: unknown[]) => Promise<unknown>;
        const value = await fn(...msg.args);
        post({ kind: 'net-result', correlationId: msg.correlationId, ok: true, value });
      } catch (err) {
        const e = err as Error & { status?: number };
        // Thread the numeric HTTP status (apiClient sets it on thrown errors) across
        // the worker boundary: the core's create-once 409 branch reads .status.
        post({ kind: 'net-result', correlationId: msg.correlationId, ok: false, error: { name: e.name, message: e.message, status: e.status } });
      }
      return;
    }
    case 'set-classification': { setChannelProtocol(msg.channelId, 'mls'); return; }
    case 'event': { emitLock(msg.event); return; }
    case 'event-epoch': { emitEpoch(msg.payload); return; }
    case 'event-apply-failed': { emitApplyFailed(msg.payload); return; }
    case 'readiness': {
      _mirrorActive = msg.active;
      // Re-arm the lock-dedup latch whenever MLS becomes active again. A non-leader
      // tab never receives an 'mls-ready' event (that is leader-only), so without this
      // a 'mls-locked' emitted before a non-leader re-activate would stay latched and
      // suppress the next genuine lock signal to UI consumers.
      if (msg.active) _lockedEmitted = false;
      // Announce channels that NEWLY became ready so the lazy history restore
      // retries (the readiness message is the ONLY signal that adds a
      // channel to the mirror on the worker path). Diff against the prior mirror BEFORE
      // rebuilding it, then emit AFTER the rebuild so a listener that calls
      // isReadyForChannel inside the callback sees the channel as ready.
      const newlyReady = msg.active ? msg.readyChannelIds.filter((id) => !_mirrorReady.has(id)) : [];
      _mirrorReady.clear();
      for (const id of msg.readyChannelIds) _mirrorReady.add(id);
      for (const id of newlyReady) emitReadyChannel(id);
      return;
    }
  }
}

const RPC_TIMEOUT_MS = 30000;
// Worker init must ack fast: core.activate resolves after only decrypt-free IndexedDB
// metadata reads, so a healthy worker (after its module graph loads) acks in well under
// a second — 3s is a wide margin. A longer wait means the module graph is hung (mobile
// WebKit), so cap it low and fall back rather than stranding the user. The wait is paid
// at most once per device: rememberWorkerUnsupported() makes later loads skip the worker.
const INIT_TIMEOUT_MS = 3000;
function rpc(method: ProxiedMethod, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const correlationId = newCorrelationId();
    const timer = setTimeout(() => { if (_pending.delete(correlationId)) reject(new Error(`mls rpc ${method} timed out`)); }, RPC_TIMEOUT_MS);
    _pending.set(correlationId, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    post({ kind: 'rpc', correlationId, method, args });
  });
}

// Fallback wiring (in-process core)
let _fallbackInstalled = false;
function ensureFallback(): void {
  if (_fallbackInstalled) return;
  core.installSeams({
    network: mainNetwork(),
    source: mainCommitWelcomeSource(),
    classification: mainClassificationSink(),
    leadership: mainLeadershipGate(),
  });
  core.mlsEvents.on(emitLock);
  core.onEpochChange(emitEpoch);
  core.onApplyFailed(emitApplyFailed);
  core.onReadyChannel(emitReadyChannel); // in-process path
  _fallbackInstalled = true;
}

// Clone the identity bundle on the fallback path so core.activate's scrub target is
// its OWN copy of the secret buffers. This mirrors the worker path, where postMessage
// structured-clones the bundle, so core.deactivate's zeroize never reaches the
// live buffers dmKeyManager still holds and scrubs via clearMlsState.
function cloneBundle(b: MlsIdentityBundle): MlsIdentityBundle {
  return {
    ...b,
    identity: {
      ...b.identity,
      signaturePrivateKey: new Uint8Array(b.identity.signaturePrivateKey),
      signaturePublicKey: new Uint8Array(b.identity.signaturePublicKey),
      credentialIdentity: new Uint8Array(b.identity.credentialIdentity),
    },
  };
}

// Public API (identical signatures on both paths)
export async function activate(identity: MlsIdentityBundle, atRestKey: CryptoKey, historyKey: CryptoKey | null): Promise<void> {
  const seq = _teardownSeq;
  if (useWorker) {
    try {
      startWorker();
      await new Promise<void>((resolve, reject) => {
        const correlationId = newCorrelationId();
        const timer = setTimeout(() => { if (_pending.delete(correlationId)) reject(Object.assign(new Error('mls init timed out'), { initTimedOut: true })); }, INIT_TIMEOUT_MS);
        _pending.set(correlationId, {
          resolve: () => { clearTimeout(timer); resolve(); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        post({ kind: 'init', correlationId, identity, atRestKey, historyKey });
      });
      return;
    } catch (err) {
      // A deactivate()/lock()/logout that raced this pending worker-init rejected the
      // init promise (with 'mls locked'). That is a DELIBERATE teardown, not a worker
      // failure: the user locked, so STAY LOCKED — do NOT resurrect MLS on the fallback
      // core, which would re-install the at-rest key lock() just nulled and run
      // core.activate with a clearMlsState-zeroed identity. Leave the worker as
      // deactivate() left it for the next unlock to re-attempt.
      if (seq !== _teardownSeq) return;
      // Otherwise it is a genuine worker failure. Mobile WebKit spawns the module
      // SharedWorker but its module graph (ts-mls + X-Wing PQC, all pure JS) never
      // finishes loading, so init is never acked and the wait above rejects (timeout) —
      // or the worker hard-errors. Fall back to the in-process core: the SAME crypto on
      // the main thread, which mobile WebKit runs fine (its Argon2 unlock already does).
      // Safety: BOTH paths gate writes on the navigator.locks 'howl-mls-writer' lease,
      // so even if a hung worker later revived the fallback cannot become a second
      // writer (it would block on the lease, not corrupt). Flip useWorker so every later
      // call routes to the core.
      logger.warn('[mls][dispatch] worker init failed; falling back to in-process core', { error: (err as Error)?.message });
      teardownWorker();
      useWorker = false;
      // Remember ONLY the init TIMEOUT — that is the WebKit module-graph hang, which is
      // a permanent device property. A worker hard-error (onerror/onmessageerror) or a
      // sync construction throw can be transient (deploy chunk-hash 404, network blip,
      // momentary CSP/OOM), so it stays session-only and self-heals on the next load.
      if ((err as { initTimedOut?: boolean })?.initTimedOut) {
        rememberWorkerUnsupported(); // skip the worker (and this wait) on every later load
      }
    }
  }
  ensureFallback();
  await core.activate(cloneBundle(identity), atRestKey, historyKey);
}

/**
 * Re-key the durable at-rest stores from the current (old) keys to the new
 * unlock-derived keys, then adopt the new keys. On the worker path
 * the worker holds the only installed keys, so the re-key must run there; we post
 * a 'rekey' message and await its ack. On the fallback path the in-process core
 * owns the keys directly. Mirrors how activate() dispatches.
 */
export async function rekey(newAtRestKey: CryptoKey, newHistoryKey: CryptoKey | null): Promise<void> {
  if (useWorker) {
    if (!workerPort) return; // worker not started (MLS never activated) — nothing to re-key
    await new Promise<void>((resolve, reject) => {
      const correlationId = newCorrelationId();
      const timer = setTimeout(() => { if (_pending.delete(correlationId)) reject(new Error('mls rekey timed out')); }, RPC_TIMEOUT_MS);
      _pending.set(correlationId, {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      post({ kind: 'rekey', correlationId, atRestKey: newAtRestKey, historyKey: newHistoryKey });
    });
    return;
  }
  ensureFallback();
  await core.rekey(newAtRestKey, newHistoryKey);
}

export function deactivate(): void {
  _teardownSeq++; // signal any in-flight activate() that this teardown is deliberate
  if (useWorker) {
    if (!workerPort) return;
    post({ kind: 'lock', correlationId: newCorrelationId() });
    _mirrorActive = false; _mirrorReady.clear();
    rejectAllPending(new Error('mls locked'));
    return;
  }
  core.deactivate();
}

export function isActive(): boolean { return useWorker ? _mirrorActive : core.isActive(); }
export function isReadyForChannel(dmChannelId: string, tier: MlsTier = 'saved'): boolean {
  return useWorker ? (_mirrorActive && _mirrorReady.has(roomKey(dmChannelId, tier))) : core.isReadyForChannel(dmChannelId, tier);
}

// reconcileChannelClassifications is main-thread on BOTH paths.
export { reconcileChannelClassifications } from './mlsReconcile';

function proxy<T>(method: ProxiedMethod, args: unknown[]): Promise<T> {
  return (useWorker ? rpc(method, args) : (core[method] as (...a: unknown[]) => Promise<unknown>)(...args)) as Promise<T>;
}

export function createDmGroup(dmChannelId: string, recipientUserId: string, tier: MlsTier = 'saved'): Promise<void> { return proxy('createDmGroup', [dmChannelId, recipientUserId, tier]); }
export function createGroupDmGroup(dmChannelId: string, memberUserIds: string[]): Promise<void> { return proxy('createGroupDmGroup', [dmChannelId, memberUserIds]); }
export function establishChannel(dmChannelId: string, recipientUserId: string, mlsGroupId?: string | null, tier: MlsTier = 'saved'): Promise<string | undefined> { return proxy('establishChannel', [dmChannelId, recipientUserId, mlsGroupId, tier]); }
export function establishGroupDmChannel(dmChannelId: string, mlsGroupId?: string | null): Promise<void> { return proxy('establishGroupDmChannel', [dmChannelId, mlsGroupId]); }
export function addGroupMembers(dmChannelId: string, memberUserIds: string[]): Promise<void> { return proxy('addGroupMembers', [dmChannelId, memberUserIds]); }
export function removeGroupMembers(dmChannelId: string, targetUserIds: string[]): Promise<void> { return proxy('removeGroupMembers', [dmChannelId, targetUserIds]); }
export function removeAbsentLeaver(dmChannelId: string, leaverUserId: string): Promise<void> { return proxy('removeAbsentLeaver', [dmChannelId, leaverUserId]); }
export function joinViaExternalCommit(dmChannelId: string, groupId: string, tier: MlsTier = 'saved'): Promise<void> { return proxy('joinViaExternalCommit', [dmChannelId, groupId, tier]); }
export function encrypt(dmChannelId: string, plaintext: string, tier: MlsTier = 'saved'): Promise<string> { return proxy('encrypt', [dmChannelId, plaintext, tier]); }
export function decrypt(dmChannelId: string, envelopeContent: string, messageId?: string, tier: MlsTier = 'saved'): Promise<string> { return proxy('decrypt', [dmChannelId, envelopeContent, messageId, tier]); }
export function deriveSframeBaseKey(dmChannelId: string): Promise<{ keyB64: string; epoch: string } | null> { return proxy('deriveSframeBaseKey', [dmChannelId]); }
export function endOtrGroup(dmChannelId: string): Promise<void> { return proxy('endOtrGroup', [dmChannelId]); }
export function listOtrChannels(): Promise<string[]> { return proxy('listOtrChannels', []); }

/**
 * Fire-and-forget (sync void); App.tsx does not await it. On the worker path proxy()
 * returns a real RPC Promise; on the fallback path core.handleGroupLeaderElection is a
 * SYNCHRONOUS void function, so wrap in Promise.resolve() before .catch() (calling
 * .catch on the undefined the sync core fn returns would throw).
 */
export function handleGroupLeaderElection(data: { dmChannelId: string; oldestMemberId: string; memberIds: string[]; leaverId?: string }, currentUserId: string | undefined): void {
  void Promise.resolve(proxy('handleGroupLeaderElection', [data, currentUserId])).catch(() => undefined);
}
