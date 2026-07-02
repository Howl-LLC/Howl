// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Testable SharedWorker host logic over FAKE ports (jsdom has no
 * SharedWorker). Exercises the three host responsibilities that don't need a real
 * worker scope:
 *  - inbound rpc dispatch to the core + rpc-result reply,
 *  - the worker-context MlsNetwork RPC proxy (net-request out -> net-result in),
 *  - lock teardown + the core-emitted 'mls-locked' re-broadcast to all ports.
 *
 * The core is a stub: it satisfies CoreApi but does no real crypto. Where the
 * REAL core would emit an mlsEvents callback (e.g. deactivate -> 'mls-locked'),
 * the stub mimics that emit so the test models the real core+host interaction
 * (deactivate -> mlsEvents emit -> host broadcast), NOT a host that double-broadcasts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorkerHost, type HostPort } from '../services/mls/mlsWorkerHost';

// Mirrors the host's internal NET_TIMEOUT_MS (not exported; keep in sync).
const NET_TIMEOUT_MS = 20000;

// A fake port: records messages posted to it; lets the test push inbound messages.
function fakePort() {
  const sent: any[] = [];
  let onmessage: ((e: { data: any }) => void) | null = null;
  return {
    sent,
    port: { postMessage: (m: any) => sent.push(m), set onmessage(fn: any) { onmessage = fn; }, get onmessage() { return onmessage; }, start: () => {} } as unknown as HostPort,
    deliver: (data: any) => onmessage?.({ data }),
  };
}

describe('createWorkerHost', () => {
  let core: any;
  const bundleStub = { identity: { signaturePublicKey: new Uint8Array(), signaturePrivateKey: new Uint8Array(), credentialIdentity: new Uint8Array() }, userId: 'u', deviceId: 'd' };
  beforeEach(() => {
    core = {
      installSeams: vi.fn(),
      activate: vi.fn().mockResolvedValue(undefined),
      rekey: vi.fn().mockResolvedValue(undefined),
      deactivate: vi.fn(),
      isActive: vi.fn().mockReturnValue(true),
      readyChannelIds: vi.fn().mockReturnValue(['ch1']),
      encrypt: vi.fn().mockResolvedValue('envelope'),
      deriveSframeBaseKey: vi.fn(),
      mlsEvents: { on: vi.fn().mockReturnValue(() => {}) },
      onEpochChange: vi.fn().mockReturnValue(() => {}),
      onApplyFailed: vi.fn().mockReturnValue(() => {}),
      onKeyChange: vi.fn().mockReturnValue(() => {}),
      onKeyChangeResolved: vi.fn().mockReturnValue(() => {}),
    };
  });

  it('dispatches an rpc message to the core method and replies with rpc-result', async () => {
    const host = createWorkerHost(core);
    const f = fakePort();
    host.handleConnect(f.port);
    f.deliver({ kind: 'rpc', correlationId: 'c1', method: 'encrypt', args: ['ch1', 'hi'] });
    await vi.waitFor(() => expect(f.sent.some((m) => m.kind === 'rpc-result' && m.correlationId === 'c1' && m.ok && m.value === 'envelope')).toBe(true));
    expect(core.encrypt).toHaveBeenCalledWith('ch1', 'hi');
  });

  it('dispatches deriveSframeBaseKey and round-trips the {keyB64, epoch} result', async () => {
    core.deriveSframeBaseKey.mockResolvedValue({ keyB64: 'a2V5', epoch: '7' });
    const host = createWorkerHost(core);
    const f = fakePort();
    host.handleConnect(f.port);
    f.deliver({ kind: 'rpc', correlationId: 'c9', method: 'deriveSframeBaseKey', args: ['ch1'] });
    await vi.waitFor(() => expect(f.sent.some((m) =>
      m.kind === 'rpc-result' && m.correlationId === 'c9' && m.ok &&
      m.value?.keyB64 === 'a2V5' && m.value?.epoch === '7',
    )).toBe(true));
    expect(core.deriveSframeBaseKey).toHaveBeenCalledWith('ch1');
  });

  it('round-trips a null deriveSframeBaseKey result as ok:true value:null (not-ready, distinct from rejection)', async () => {
    core.deriveSframeBaseKey.mockResolvedValue(null);
    const host = createWorkerHost(core);
    const f = fakePort();
    host.handleConnect(f.port);
    f.deliver({ kind: 'rpc', correlationId: 'c10', method: 'deriveSframeBaseKey', args: ['ch1'] });
    await vi.waitFor(() => expect(f.sent.some((m) =>
      m.kind === 'rpc-result' && m.correlationId === 'c10' && m.ok === true && m.value === null,
    )).toBe(true));
  });

  it('routes an outbound network request to a live port and resolves on net-result', async () => {
    const host = createWorkerHost(core);
    const f = fakePort();
    host.handleConnect(f.port);
    f.deliver({ kind: 'init', correlationId: 'i1', identity: bundleStub, atRestKey: {} as CryptoKey, historyKey: null });
    await vi.waitFor(() => expect(core.installSeams).toHaveBeenCalled());
    const seams = core.installSeams.mock.calls[0][0]; // the injected CoreSeams
    const p = seams.network.submitCommit({ groupId: 'g', baseEpoch: '0', mode: 'member', commitB64: '', groupInfoB64: '', idempotencyKey: 'k' });
    await vi.waitFor(() => expect(f.sent.some((m: any) => m.kind === 'net-request' && m.method === 'submitCommit')).toBe(true));
    const req = f.sent.find((m: any) => m.kind === 'net-request');
    f.deliver({ kind: 'net-result', correlationId: req.correlationId, ok: true, value: { ok: true, epoch: '1', commitId: 'c' } });
    await expect(p).resolves.toMatchObject({ ok: true, epoch: '1' });
  });

  it('a net-result error carrying status round-trips to an Error with .status', async () => {
    // The worker host reconstructs a net-result {ok:false} into an Error and
    // re-attaches the numeric HTTP status so the core's create-once 409 branch
    // sees it on the worker path.
    const host = createWorkerHost(core);
    const f = fakePort();
    host.handleConnect(f.port);
    f.deliver({ kind: 'init', correlationId: 'i1', identity: bundleStub, atRestKey: {} as CryptoKey, historyKey: null });
    await vi.waitFor(() => expect(core.installSeams).toHaveBeenCalled());
    const seams = core.installSeams.mock.calls[0][0];
    const p = seams.network.createGroup('chan', 'gi');
    p.catch(() => {});
    await vi.waitFor(() => expect(f.sent.some((m: any) => m.kind === 'net-request' && m.method === 'createGroup')).toBe(true));
    const req = f.sent.find((m: any) => m.kind === 'net-request' && m.method === 'createGroup');
    f.deliver({ kind: 'net-result', correlationId: req.correlationId, ok: false, error: { name: 'HttpError', message: 'conflict', status: 409 } });
    await expect(p).rejects.toMatchObject({ message: 'conflict', name: 'HttpError', status: 409 });
  });

  it('forwards the tier arg on a createGroup net-request (OTR tier-drop regression)', async () => {
    // The worker-context MlsNetwork.createGroup must thread its 3rd `tier` arg into
    // the net-request args[] (mlsWorkerProtocol declares createGroup(dmChannelId,
    // groupInfoB64, tier)). Dropping it makes an OTR establish POST tier='saved',
    // colliding with the existing Saved group (@@unique([dmChannelId,tier])) -> 409.
    const host = createWorkerHost(core);
    const f = fakePort();
    host.handleConnect(f.port);
    f.deliver({ kind: 'init', correlationId: 'i1', identity: bundleStub, atRestKey: {} as CryptoKey, historyKey: null });
    await vi.waitFor(() => expect(core.installSeams).toHaveBeenCalled());
    const seams = core.installSeams.mock.calls[0][0];
    const p = seams.network.createGroup('chan', 'gi', 'otr');
    p.catch(() => {});
    await vi.waitFor(() => expect(f.sent.some((m: any) => m.kind === 'net-request' && m.method === 'createGroup')).toBe(true));
    const req = f.sent.find((m: any) => m.kind === 'net-request' && m.method === 'createGroup');
    expect(req.args).toEqual(['chan', 'gi', 'otr']);
  });

  it('a net-result error WITHOUT status does not force-set status on the Error', async () => {
    const host = createWorkerHost(core);
    const f = fakePort();
    host.handleConnect(f.port);
    f.deliver({ kind: 'init', correlationId: 'i1', identity: bundleStub, atRestKey: {} as CryptoKey, historyKey: null });
    await vi.waitFor(() => expect(core.installSeams).toHaveBeenCalled());
    const seams = core.installSeams.mock.calls[0][0];
    const p = seams.network.getDMs();
    p.catch(() => {});
    await vi.waitFor(() => expect(f.sent.some((m: any) => m.kind === 'net-request' && m.method === 'getDMs')).toBe(true));
    const req = f.sent.find((m: any) => m.kind === 'net-request' && m.method === 'getDMs');
    f.deliver({ kind: 'net-result', correlationId: req.correlationId, ok: false, error: { name: 'Error', message: 'boom' } });
    const rejected = await p.then(() => null, (e: unknown) => e);
    expect(rejected).toBeInstanceOf(Error);
    expect('status' in (rejected as object)).toBe(false);
  });

  it('an rpc rejection carrying the typed peer-unprovisioned fields serializes them into the rpc-result error', async () => {
    // The typed establish failure (reason + unprovisionedUserId, plus the
    // numeric status) must survive the host's rpc catch serializer so the main
    // thread can route it to the UI (routeEstablishOutcome).
    core.establishChannel = vi.fn().mockRejectedValue(Object.assign(
      new Error('member ghost has no available KeyPackages'),
      { reason: 'peer-unprovisioned', unprovisionedUserId: 'ghost', status: 404 },
    ));
    const host = createWorkerHost(core);
    const f = fakePort();
    host.handleConnect(f.port);
    f.deliver({ kind: 'rpc', correlationId: 'c11', method: 'establishChannel', args: ['ch1', 'ghost'] });
    await vi.waitFor(() => expect(f.sent.some((m) => m.kind === 'rpc-result' && m.correlationId === 'c11')).toBe(true));
    const res = f.sent.find((m) => m.kind === 'rpc-result' && m.correlationId === 'c11');
    expect(res.ok).toBe(false);
    expect(res.error.name).toBe('Error');
    expect(res.error.message).toBe('member ghost has no available KeyPackages');
    expect(res.error.status).toBe(404);
    expect(res.error.reason).toBe('peer-unprovisioned');
    expect(res.error.unprovisionedUserId).toBe('ghost');
  });

  it('an rpc rejection with a PLAIN Error serializes undefined reason/unprovisionedUserId (not fabricated)', async () => {
    core.establishChannel = vi.fn().mockRejectedValue(new Error('boom'));
    const host = createWorkerHost(core);
    const f = fakePort();
    host.handleConnect(f.port);
    f.deliver({ kind: 'rpc', correlationId: 'c12', method: 'establishChannel', args: ['ch1', 'peer'] });
    await vi.waitFor(() => expect(f.sent.some((m) => m.kind === 'rpc-result' && m.correlationId === 'c12')).toBe(true));
    const res = f.sent.find((m) => m.kind === 'rpc-result' && m.correlationId === 'c12');
    expect(res.ok).toBe(false);
    expect(res.error.message).toBe('boom');
    expect(res.error.reason).toBeUndefined();
    expect(res.error.unprovisionedUserId).toBeUndefined();
  });

  it('rekey dispatches to core.rekey and replies with rpc-result', async () => {
    const host = createWorkerHost(core);
    const f = fakePort();
    host.handleConnect(f.port);
    const newAtRest = {} as CryptoKey;
    const newHistory = {} as CryptoKey;
    f.deliver({ kind: 'rekey', correlationId: 'rk1', atRestKey: newAtRest, historyKey: newHistory });
    await vi.waitFor(() => expect(f.sent.some((m) => m.kind === 'rpc-result' && m.correlationId === 'rk1' && m.ok)).toBe(true));
    expect(core.rekey).toHaveBeenCalledWith(newAtRest, newHistory);
  });

  it('rekey replies ok:false when core.rekey rejects', async () => {
    core.rekey = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { name: 'RekeyError' }));
    const host = createWorkerHost(core);
    const f = fakePort();
    host.handleConnect(f.port);
    f.deliver({ kind: 'rekey', correlationId: 'rk2', atRestKey: {} as CryptoKey, historyKey: null });
    await vi.waitFor(() => expect(f.sent.some((m) => m.kind === 'rpc-result' && m.correlationId === 'rk2' && !m.ok && m.error?.name === 'RekeyError')).toBe(true));
  });

  it('lock zeroizes + broadcasts mls-locked to all ports', async () => {
    // In the REAL core, deactivate() emits 'mls-locked' via core.mlsEvents, which
    // the host (in ensureSeams) re-broadcasts to all ports. The host's lock handler
    // intentionally does NOT broadcast 'mls-locked' itself (that would double-fire
    // with the real core's latched emit). So the stub core.deactivate mimics the
    // real core's emit: it invokes the mlsEvents callback the host registered.
    let evCb: ((e: 'mls-ready' | 'mls-locked') => void) | undefined;
    core.mlsEvents = { on: vi.fn((cb: (e: 'mls-ready' | 'mls-locked') => void) => { evCb = cb; return () => {}; }) };
    core.deactivate = vi.fn(() => evCb && evCb('mls-locked'));
    const host = createWorkerHost(core);
    const a = fakePort(); const b = fakePort();
    host.handleConnect(a.port); host.handleConnect(b.port);
    // The host only registers its mlsEvents listener once seams are installed (on
    // the first init/rpc/lock). Drive an init first so ensureSeams runs and the
    // host's callback is wired before the lock fires the stub's emit.
    a.deliver({ kind: 'init', correlationId: 'i1', identity: bundleStub, atRestKey: {} as CryptoKey, historyKey: null });
    await vi.waitFor(() => expect(core.installSeams).toHaveBeenCalled());
    a.deliver({ kind: 'lock', correlationId: 'L1' });
    await vi.waitFor(() => {
      expect(core.deactivate).toHaveBeenCalled();
      expect(a.sent.some((m) => m.kind === 'event' && m.event === 'mls-locked')).toBe(true);
      expect(b.sent.some((m) => m.kind === 'event' && m.event === 'mls-locked')).toBe(true);
    });
  });

  it('broadcasts event-apply-failed from core.onApplyFailed to all ports', async () => {
    const CH = 'chFail';
    const host = createWorkerHost(core);
    const a = fakePort(); const b = fakePort();
    host.handleConnect(a.port); host.handleConnect(b.port);
    // Drive an init so ensureSeams runs and registers the host's onApplyFailed callback.
    a.deliver({ kind: 'init', correlationId: 'i1', identity: bundleStub, atRestKey: {} as CryptoKey, historyKey: null });
    await vi.waitFor(() => expect(core.onApplyFailed).toHaveBeenCalled());
    const cb = core.onApplyFailed.mock.calls[0][0];
    cb({ dmChannelId: CH, epoch: '2' });
    expect(a.sent).toContainEqual({ kind: 'event-apply-failed', payload: { dmChannelId: CH, epoch: '2' } });
    expect(b.sent).toContainEqual({ kind: 'event-apply-failed', payload: { dmChannelId: CH, epoch: '2' } });
  });

  it('refreshes the readiness mirror after a live socket-event commit (post-await)', async () => {
    // A live socket-event commit's heal-drop can shrink the core's _loadedGroups
    // WITHOUT emitting mls-ready, so the host must push a fresh readiness AFTER the
    // (async) commit callback settles. Capture the core's source callback via the
    // injected seams so the commit handler actually runs, then assert the host
    // broadcasts a 'readiness' once it resolves.
    let resolveCommit: (() => void) | undefined;
    core.installSeams = vi.fn((seams: any) => {
      // Register an async commit callback (mirrors the real core's async
      // handleIncomingCommit) whose settlement the test controls.
      seams.source.onCommit(() => new Promise<void>((res) => { resolveCommit = res; }));
    });
    const host = createWorkerHost(core);
    const f = fakePort();
    host.handleConnect(f.port);
    // init installs the seams (capturing the source.onCommit callback above).
    f.deliver({ kind: 'init', correlationId: 'i1', identity: bundleStub, atRestKey: {} as CryptoKey, historyKey: null });
    await vi.waitFor(() => expect(core.installSeams).toHaveBeenCalled());
    const readinessBefore = f.sent.filter((m: any) => m.kind === 'readiness').length;

    // Deliver a live socket-event commit. The host awaits the (pending) commit
    // callback; readiness must NOT be pushed until it settles.
    f.deliver({ kind: 'socket-event', event: 'commit', payload: { groupId: 'g', epoch: '2', commit: 'AAAA' } });
    await Promise.resolve();
    expect(f.sent.filter((m: any) => m.kind === 'readiness').length).toBe(readinessBefore);

    // Resolve the commit handler: the host's .finally(pushReadiness) now fires.
    resolveCommit!();
    await vi.waitFor(() => expect(f.sent.filter((m: any) => m.kind === 'readiness').length).toBe(readinessBefore + 1));
  });

  it('refreshes the readiness mirror after a live socket-event welcome', async () => {
    // A live Welcome-join grows _loadedGroups without emitting mls-ready, so the same
    // post-settle pushReadiness applies. With the stubbed core (no seam wiring), the
    // welcome callback is null, Promise.resolve(undefined) settles, readiness pushes.
    const host = createWorkerHost(core);
    const f = fakePort();
    host.handleConnect(f.port);
    f.deliver({ kind: 'init', correlationId: 'i1', identity: bundleStub, atRestKey: {} as CryptoKey, historyKey: null });
    await vi.waitFor(() => expect(core.installSeams).toHaveBeenCalled());
    const readinessBefore = f.sent.filter((m: any) => m.kind === 'readiness').length;
    f.deliver({ kind: 'socket-event', event: 'welcome', payload: { groupId: 'g', epoch: '2' } });
    await vi.waitFor(() => expect(f.sent.filter((m: any) => m.kind === 'readiness').length).toBe(readinessBefore + 1));
  });

  // The following tests drive the 20s net-request timeout deterministically with
  // fake timers. They are scoped here (not in the suite-wide beforeEach) so the
  // three tests above keep using real timers + vi.waitFor microtask flushing.
  describe('net-request timeout pruning (fake timers)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    // Drive an init on a port so ensureSeams runs, then return the injected seams.
    async function initAndGetSeams(host: ReturnType<typeof createWorkerHost>, f: ReturnType<typeof fakePort>) {
      f.deliver({ kind: 'init', correlationId: 'i1', identity: bundleStub, atRestKey: {} as CryptoKey, historyKey: null });
      await vi.advanceTimersByTimeAsync(0); // flush the async init microtasks
      expect(core.installSeams).toHaveBeenCalled();
      return core.installSeams.mock.calls[0][0];
    }

    it('net-request timeout with a single port prunes it and rejects with no-live-port', async () => {
      const host = createWorkerHost(core);
      const f = fakePort();
      host.handleConnect(f.port);
      const seams = await initAndGetSeams(host, f);
      const p = seams.network.getDMs();
      p.catch(() => {}); // avoid unhandled-rejection noise before the assertion
      // Net-request dispatched but no net-result delivered: the 20s timeout prunes
      // the only port, re-dispatch finds no live port, and the promise rejects.
      await vi.advanceTimersByTimeAsync(NET_TIMEOUT_MS);
      await expect(p).rejects.toThrow(/no live port/);
      expect(host._ports.has(f.port)).toBe(false);
      expect(host._ports.size).toBe(0);
      expect(host._pendingNet.size).toBe(0); // no orphan entry/timer left behind
    });

    it('net-request timeout re-dispatches to a second live port and resolves', async () => {
      const host = createWorkerHost(core);
      const a = fakePort(); const b = fakePort();
      host.handleConnect(a.port); host.handleConnect(b.port);
      // init delivered on `a` -> lastActivePort === a.port, so the first net-request
      // goes to `a`. After the timeout prunes `a`, re-dispatch goes to `b`.
      const seams = await initAndGetSeams(host, a);
      const p = seams.network.getDMs();
      p.catch(() => {});
      // First dispatch targeted the last-active port (a). Time out -> prune it ->
      // re-dispatch to the surviving port.
      await vi.advanceTimersByTimeAsync(NET_TIMEOUT_MS);
      // Collect net-requests across both ports; reply on whichever surviving port
      // got the re-dispatched request (match by the latest correlationId).
      const allReqs = [...a.sent, ...b.sent].filter((m: any) => m.kind === 'net-request' && m.method === 'getDMs');
      const latest = allReqs[allReqs.length - 1];
      // Deliver the net-result via a still-live port (b survived the prune).
      b.deliver({ kind: 'net-result', correlationId: latest.correlationId, ok: true, value: [{ dmChannelId: 'd' }] });
      await expect(p).resolves.toEqual([{ dmChannelId: 'd' }]);
    });

    it('createGroup net-request timeout REJECTS and does NOT prune/re-dispatch to another port', async () => {
      const host = createWorkerHost(core);
      const a = fakePort(); const b = fakePort();
      host.handleConnect(a.port); host.handleConnect(b.port);
      const seams = await initAndGetSeams(host, a); // init on `a` -> first dispatch targets `a`
      const p = seams.network.createGroup('chan', 'gi');
      p.catch(() => {});
      // The first (and only) dispatch went to `a`. createGroup is non-idempotent, so
      // on timeout it must reject WITHOUT pruning the tried port or re-dispatching.
      const reqsBefore = [...a.sent, ...b.sent].filter((m: any) => m.kind === 'net-request' && m.method === 'createGroup').length;
      expect(reqsBefore).toBe(1);
      await vi.advanceTimersByTimeAsync(NET_TIMEOUT_MS);
      await expect(p).rejects.toThrow(/createGroup timed out/);
      // No re-dispatch: still exactly one createGroup net-request total.
      const reqsAfter = [...a.sent, ...b.sent].filter((m: any) => m.kind === 'net-request' && m.method === 'createGroup').length;
      expect(reqsAfter).toBe(1);
      // The tried port was NOT pruned (reject != prune); both ports remain.
      expect(host._ports.has(a.port)).toBe(true);
      expect(host._ports.has(b.port)).toBe(true);
      expect(host._pendingNet.size).toBe(0); // entry cleaned up, no orphan timer
    });

    it('an idempotent method (getDMs) still prunes + re-dispatches on timeout', async () => {
      const host = createWorkerHost(core);
      const a = fakePort(); const b = fakePort();
      host.handleConnect(a.port); host.handleConnect(b.port);
      const seams = await initAndGetSeams(host, a);
      const p = seams.network.getDMs();
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(NET_TIMEOUT_MS);
      // Pruned the tried port (a) and re-dispatched to the survivor (b).
      expect(host._ports.has(a.port)).toBe(false);
      const reqs = [...a.sent, ...b.sent].filter((m: any) => m.kind === 'net-request' && m.method === 'getDMs').length;
      expect(reqs).toBe(2); // original + re-dispatch
    });

    it('a pruned-but-alive port is re-added on its next inbound message and receives subsequent broadcasts', async () => {
      const host = createWorkerHost(core);
      const a = fakePort(); const b = fakePort();
      host.handleConnect(a.port); host.handleConnect(b.port);
      // init on `a` -> lastActivePort === a.port -> first net-request targets `a`.
      const seams = await initAndGetSeams(host, a);
      const p = seams.network.getDMs();
      p.catch(() => {}); // re-dispatch to `b` will hang (no net-result); we don't care
      // Time out the request: prunes the last-active port (a) and re-dispatches to b.
      await vi.advanceTimersByTimeAsync(NET_TIMEOUT_MS);
      expect(host._ports.has(a.port)).toBe(false); // a was pruned while still alive
      // a is still alive: any inbound message must re-add it to the registry.
      const beforeRx = a.sent.length;
      a.deliver({ kind: 'rpc', correlationId: 'rx', method: 'encrypt', args: ['c', 'h'] });
      await vi.advanceTimersByTimeAsync(0); // flush the async rpc handler
      expect(host._ports.has(a.port)).toBe(true); // re-added on inbound message
      // The rpc handler calls pushReadiness() which broadcasts 'readiness' to all
      // ports. The re-added port must receive a 'readiness' AFTER its re-add.
      const readinessAfterReadd = a.sent.slice(beforeRx).some((m: any) => m.kind === 'readiness');
      expect(readinessAfterReadd).toBe(true);
    });
  });
});
