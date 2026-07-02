// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Testable SharedWorker host logic. Owns the connected-port registry,
 * dispatches inbound RPC to the core, builds the worker-context MlsNetwork (an
 * RPC proxy that calls a live port and retries on timeout / port death), relays
 * inbound socket events to the core's CommitWelcomeSource, and broadcasts the
 * core's events to all ports. Kept free of `self`/SharedWorkerGlobalScope so it
 * can be unit-tested over fake ports (jsdom has no SharedWorker).
 */
import { logger } from '../logger';
import { acquireLeadership, isLeader, releaseLeadership } from './mlsTabLock';
import {
  newCorrelationId,
  type CoreSeams, type MlsNetwork, type CommitWelcomeSource, type ClassificationSink, type LeadershipGate,
  type MainToWorker, type WorkerToMain,
} from './mlsWorkerProtocol';

export interface HostPort {
  postMessage(message: WorkerToMain): void;
  onmessage: ((e: { data: MainToWorker }) => void) | null;
  start(): void;
}

/** The subset of the core the host drives. mlsCoordinatorCore satisfies this. */
export interface CoreApi {
  installSeams(seams: CoreSeams): void;
  activate(identity: unknown, atRestKey: CryptoKey, historyKey: CryptoKey | null): Promise<void>;
  rekey(atRestKey: CryptoKey, historyKey: CryptoKey | null): Promise<void>;
  deactivate(): void;
  isActive(): boolean;
  readyChannelIds(): string[];
  mlsEvents: { on(cb: (e: 'mls-ready' | 'mls-locked') => void): () => void };
  onEpochChange(cb: (e: { dmChannelId: string; groupId: string; epoch: string }) => void): () => void;
  onApplyFailed(cb: (p: { dmChannelId: string; epoch: string }) => void): () => void;
  onKeyChange(cb: (p: { userId: string; candidateAik: string; pinnedAik: string; self: boolean }) => void): () => void;
  onKeyChangeResolved(cb: (p: { userId: string }) => void): () => void;
  // proxied async methods (indexable):
  [method: string]: unknown;
}

const NET_TIMEOUT_MS = 20000;

// Net methods that must NOT be re-dispatched to another port on timeout: they are
// NON-IDEMPOTENT create-once endpoints, so a re-dispatch (after the original slow
// request already succeeded server-side) produces a self-409 that strands the DM
// forever. createGroup is the create-once group registration. For these we
// reject the request on timeout instead of pruning + re-dispatching.
const NON_REDISPATCHABLE_METHODS: ReadonlySet<keyof MlsNetwork> = new Set(['createGroup']);

export function createWorkerHost(core: CoreApi) {
  const ports = new Set<HostPort>();
  let lastActivePort: HostPort | null = null;
  // Pending outbound network requests: correlationId -> { resolve, reject, method, args, triedPorts }
  const pendingNet = new Map<string, {
    resolve: (v: unknown) => void; reject: (e: Error) => void;
    method: keyof MlsNetwork; args: unknown[]; triedPorts: Set<HostPort>; timer: ReturnType<typeof setTimeout>;
  }>();
  // The commit/welcome callbacks the core registered via the source seam. The core's
  // handlers are async (return Promise<void>), so the stored type allows a promise the
  // 'socket-event' case awaits before refreshing the readiness mirror.
  let commitCb: ((e: { groupId: string; epoch: string; commit: string }) => void | Promise<void>) | null = null;
  let welcomeCb: ((e: { groupId: string; epoch: string }) => void | Promise<void>) | null = null;
  let groupResetCb: ((e: { dmChannelId: string; mlsGroupId: string }) => void | Promise<void>) | null = null;
  let seamsInstalled = false;

  function broadcast(msg: WorkerToMain): void {
    for (const p of ports) { try { p.postMessage(msg); } catch { /* dead port */ } }
  }

  // Route network to the most-recently-active port (the tab whose last inbound
  // message is newest is demonstrably alive). The initiating port is preferred;
  // most-recently-active IS the initiating tab in the common case and
  // avoids the shared-mutable-ref clobber that concurrent rpc handlers would
  // cause. exclude = ports already tried for this request.
  function pickPort(exclude: Set<HostPort>): HostPort | null {
    if (lastActivePort && ports.has(lastActivePort) && !exclude.has(lastActivePort)) return lastActivePort;
    for (const p of ports) if (!exclude.has(p)) return p;
    return null;
  }

  // Build the worker-context MlsNetwork. Each call posts a net-request to a live
  // port and awaits the matching net-result; on timeout, prune the dead port and
  // re-dispatch. idempotencyKeyFor is pure -> computed locally, no RPC.
  function makeNetwork(): MlsNetwork {
    function rpc<T>(method: keyof MlsNetwork, args: unknown[]): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const correlationId = newCorrelationId();
        const triedPorts = new Set<HostPort>();
        const dispatch = () => {
          const target = pickPort(triedPorts);
          if (!target) { cleanup(); reject(new Error(`mls net ${method}: no live port`)); return; }
          triedPorts.add(target);
          target.postMessage({ kind: 'net-request', correlationId, method, args });
        };
        const cleanup = () => { clearTimeout(entry.timer); pendingNet.delete(correlationId); };
        const entry = {
          resolve: (v: unknown) => { cleanup(); resolve(v as T); },
          reject: (e: Error) => { cleanup(); reject(e); },
          method, args, triedPorts,
          timer: setTimeout(function onTimeout() {
            // createGroup (and any other non-idempotent create-once method) must NOT
            // be re-dispatched on timeout: the original slow request may already have
            // succeeded server-side, so a retry on another port produces a self-409
            // that strands the DM forever. Reject instead of re-dispatching.
            if (NON_REDISPATCHABLE_METHODS.has(method)) {
              logger.warn('[mls][worker] net rpc timeout; non-idempotent method, rejecting (no re-dispatch)', { method });
              entry.reject(new Error(`mls net ${method} timed out`));
              return;
            }
            // No answer in time: PRUNE the unresponsive port (the one we just
            // tried) so it is not re-selected, then re-dispatch to another.
            // submitCommit is idempotency-keyed and reads are safe to retry;
            // consumeKeyPackages is destructive, so a retry can burn one extra
            // single-use KeyPackage (bounded waste; replenish heals). Acceptable.
            const lastTried = [...entry.triedPorts].pop();
            if (lastTried) ports.delete(lastTried);
            logger.warn('[mls][worker] net rpc timeout; pruned port + re-dispatching', { method });
            dispatch();
            // Re-arm ONLY if dispatch did not terminate the request (a no-live-port
            // dispatch calls cleanup() which deletes the entry). Prevents an orphan
            // timer that fires forever after the promise already rejected.
            if (pendingNet.has(correlationId)) entry.timer = setTimeout(onTimeout, NET_TIMEOUT_MS);
          }, NET_TIMEOUT_MS),
        };
        pendingNet.set(correlationId, entry);
        dispatch();
      });
    }
    const idemLocal = async (groupId: string, baseEpoch: string, kind: string, recipientId?: string): Promise<string> => {
      const input = `${groupId}:${baseEpoch}:${kind}:${recipientId ?? ''}`;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
      let bin = ''; const a = new Uint8Array(digest); for (let i = 0; i < a.length; i++) bin += String.fromCharCode(a[i]);
      return btoa(bin);
    };
    return {
      publishKeyPackages: (d, k) => rpc('publishKeyPackages', [d, k]),
      keyPackageCount: (d) => rpc('keyPackageCount', [d]),
      consumeKeyPackages: (u) => rpc('consumeKeyPackages', [u]),
      createGroup: (c, g, t) => rpc('createGroup', [c, g, t]),
      getGroupInfo: (g) => rpc('getGroupInfo', [g]),
      submitCommit: (a) => rpc('submitCommit', [a]),
      catchUp: (g, s, l) => rpc('catchUp', [g, s, l]),
      getWelcomes: (l) => rpc('getWelcomes', [l]),
      getDMs: () => rpc('getDMs', []),
      getAikChain: (u) => rpc('getAikChain', [u]),
      getPeerAik: (u) => rpc('getPeerAik', [u]),
      resetGroup: (g, e) => rpc('resetGroup', [g, e]),
      idempotencyKeyFor: idemLocal,
    };
  }

  function ensureSeams(): void {
    if (seamsInstalled) return;
    const network = makeNetwork();
    const source: CommitWelcomeSource = {
      onCommit: (cb) => { commitCb = cb; return () => { if (commitCb === cb) commitCb = null; }; },
      onWelcome: (cb) => { welcomeCb = cb; return () => { if (welcomeCb === cb) welcomeCb = null; }; },
      onGroupReset: (cb) => { groupResetCb = cb; return () => { if (groupResetCb === cb) groupResetCb = null; }; },
    };
    const classification: ClassificationSink = { markMls: (channelId) => broadcast({ kind: 'set-classification', channelId }) };
    const leadership: LeadershipGate = { isLeader, acquire: acquireLeadership, release: releaseLeadership };
    core.installSeams({ network, source, classification, leadership });
    // Re-broadcast the core's events; refresh readiness on each (the tail finishing
    // and emitting mls-ready is when loaded channels change).
    core.mlsEvents.on((e) => { broadcast({ kind: 'event', event: e }); pushReadiness(); });
    core.onEpochChange((p) => broadcast({ kind: 'event-epoch', payload: p }));
    core.onApplyFailed((p) => broadcast({ kind: 'event-apply-failed', payload: p }));
    core.onKeyChange((p) => broadcast({ kind: 'event-key-change', payload: p }));
    core.onKeyChangeResolved((p) => broadcast({ kind: 'event-key-change-resolved', payload: p }));
    seamsInstalled = true;
  }

  function pushReadiness(): void {
    broadcast({ kind: 'readiness', active: core.isActive(), readyChannelIds: core.readyChannelIds() });
  }

  async function handleMessage(port: HostPort, data: MainToWorker): Promise<void> {
    ports.add(port);        // any inbound message proves the port is alive; re-include a
                            // port that an earlier net-request timeout wrongly pruned, so
                            // it resumes receiving broadcasts (prune-on-timeout self-heals).
    lastActivePort = port;
    switch (data.kind) {
      case 'init': {
        ensureSeams();
        try {
          await core.activate(data.identity, data.atRestKey, data.historyKey);
          pushReadiness();
          port.postMessage({ kind: 'rpc-result', correlationId: data.correlationId, ok: true, value: undefined });
        } catch (err) {
          const e = err as Error & { status?: number };
          port.postMessage({ kind: 'rpc-result', correlationId: data.correlationId, ok: false, error: { name: e.name, message: e.message, status: e.status } });
        }
        return;
      }
      case 'rekey': {
        // Re-encrypt the durable stores old->new and adopt the new keys
        // inside the worker (which owns the only installed keys). ensureSeams in case
        // a rekey somehow precedes init (defensive; core.rekey no-ops if not active).
        ensureSeams();
        try {
          await core.rekey(data.atRestKey, data.historyKey);
          port.postMessage({ kind: 'rpc-result', correlationId: data.correlationId, ok: true, value: undefined });
        } catch (err) {
          const e = err as Error & { status?: number };
          port.postMessage({ kind: 'rpc-result', correlationId: data.correlationId, ok: false, error: { name: e.name, message: e.message, status: e.status } });
        }
        return;
      }
      case 'lock': {
        // core.deactivate() emits 'mls-locked' via core.mlsEvents, which ensureSeams
        // re-broadcasts to all ports. Do NOT broadcast mls-locked again here (the
        // core's emit is latched; a second explicit broadcast would double-fire).
        core.deactivate();
        pushReadiness();
        port.postMessage({ kind: 'rpc-result', correlationId: data.correlationId, ok: true, value: undefined });
        return;
      }
      case 'rpc': {
        try {
          const fn = core[data.method] as (...a: unknown[]) => Promise<unknown> | unknown;
          const value = await fn(...data.args);
          port.postMessage({ kind: 'rpc-result', correlationId: data.correlationId, ok: true, value });
          pushReadiness();
        } catch (err) {
          const e = err as Error & { status?: number; reason?: string; unprovisionedUserId?: string; blockedUserId?: string };
          // Thread the numeric HTTP status AND the typed establish-failure reason across
          // the rpc-result boundary so status-dependent (create-once 409) and
          // reason-dependent (peer-unprovisioned / key-change-blocked) handling survives.
          port.postMessage({ kind: 'rpc-result', correlationId: data.correlationId, ok: false, error: { name: e.name, message: e.message, status: e.status, reason: e.reason, unprovisionedUserId: e.unprovisionedUserId, blockedUserId: e.blockedUserId } });
          // A proxied method can mutate _loadedGroups BEFORE throwing (heal-drops,
          // recoverChannelAfterKeyChange's teardown paths) — refresh the mirror on the
          // failure path too, or the main thread stays stale-ready.
          pushReadiness();
        }
        return;
      }
      case 'socket-event': {
        // Both commit and welcome can mutate _loadedGroups WITHOUT emitting mls-ready:
        // a live heal-drop (stale-key OperationError) shrinks it; a live Welcome-join
        // grows it. The handlers are async, so await the settled handler BEFORE pushing
        // readiness — a synchronous pushReadiness() would broadcast the stale set (before
        // the heal's _loadedGroups.delete), leaving the main thread's readiness mirror
        // wrong (encrypt would throw "mls channel not ready" and refuse to re-establish).
        const handled = data.event === 'commit'
          ? commitCb?.(data.payload)
          : data.event === 'welcome'
            ? welcomeCb?.(data.payload)
            : groupResetCb?.(data.payload);
        // pushReadiness MUST run whether the handler fulfilled or rejected (a live
        // heal-drop / Welcome-join mutates _loadedGroups either way). The welcome
        // branch's joinPendingWelcomes() can REJECT with no internal catch, and a
        // bare .finally() re-propagates that rejection into this void-discarded
        // promise → an unhandled rejection inside the SharedWorker. Settle on BOTH
        // paths and CONSUME the rejection (do not re-propagate).
        void Promise.resolve(handled).then(() => pushReadiness(), () => pushReadiness());
        return;
      }
      case 'net-result': {
        const entry = pendingNet.get(data.correlationId);
        if (!entry) return;
        if (data.ok) entry.resolve(data.value);
        else {
          // Re-attach the numeric HTTP status so the core's .status-based branches
          // see it on the worker path too: create-once 409 detection AND
          // consumeOneKeyPackage's 404 -> peer-unprovisioned normalization.
          // nonApiResponse rides along for the stale-group 404 teardown gate.
          const { name, message, status, nonApiResponse } = data.error;
          entry.reject(Object.assign(new Error(message), { name, ...(status !== undefined ? { status } : {}), ...(nonApiResponse !== undefined ? { nonApiResponse } : {}) }));
        }
        return;
      }
    }
  }

  function handleConnect(port: HostPort): void {
    ports.add(port);
    port.onmessage = (e) => { void handleMessage(port, e.data); };
    port.start();
  }

  return { handleConnect, _ports: ports, _pendingNet: pendingNet };
}
