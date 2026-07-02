// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, afterEach } from 'vitest';

// The dispatcher chooses worker vs fallback by `typeof SharedWorker`. Test both.
describe('mlsCoordinator dispatcher', () => {
  afterEach(() => { delete (globalThis as any).SharedWorker; try { localStorage.clear(); } catch { /* ignore */ } vi.useRealTimers(); vi.resetModules(); vi.doUnmock('../services/mls/mlsCoordinatorCore'); });
  const WORKER_UNSUPPORTED_KEY = 'howl:mls:worker-unsupported';

  // A core stub complete enough for ensureFallback() (installSeams + all event
  // subscriptions) and the proxied/sync reads. activate resolves immediately so
  // the in-process fallback "succeeds" the way mobile WebKit's main thread does.
  function makeCoreStub() {
    return {
      installSeams: vi.fn(),
      mlsEvents: { on: vi.fn(() => () => {}) },
      onEpochChange: vi.fn(() => () => {}),
      onApplyFailed: vi.fn(() => () => {}),
      onKeyChange: vi.fn(() => () => {}),
      onKeyChangeResolved: vi.fn(() => () => {}),
      onReadyChannel: vi.fn(() => () => {}),
      activate: vi.fn().mockResolvedValue(undefined),
      deactivate: vi.fn(),
      isActive: vi.fn().mockReturnValue(true),
      isReadyForChannel: vi.fn().mockReturnValue(true),
      encrypt: vi.fn().mockResolvedValue('env'),
    };
  }
  const bundle = { identity: { signaturePublicKey: new Uint8Array(1), signaturePrivateKey: new Uint8Array(1), credentialIdentity: new Uint8Array(1) }, userId: 'u', deviceId: 'd' };

  it('fallback path (no SharedWorker): proxies to the in-process core and mirrors sync reads', async () => {
    delete (globalThis as any).SharedWorker;
    // Stub the core so we can assert the dispatcher actually proxies into it.
    // doMock (not hoisted) applies only to the dynamic import below, so it does not
    // bleed into the worker-path test (which never imports the real core anyway).
    const coreStub = {
      installSeams: vi.fn(),
      mlsEvents: { on: vi.fn(() => () => {}) },
      onEpochChange: vi.fn(() => () => {}),
      encrypt: vi.fn().mockResolvedValue('env'),
      isReadyForChannel: vi.fn().mockReturnValue(true),
      isActive: vi.fn(),
      activate: vi.fn(),
      deactivate: vi.fn(),
    };
    vi.doMock('../services/mls/mlsCoordinatorCore', () => coreStub);
    const disp = await import('../services/mls/mlsCoordinator');
    const out = await disp.encrypt('ch', 'pt');
    expect(coreStub.encrypt).toHaveBeenCalledWith('ch', 'pt', 'saved'); // tier appended (defaults to 'saved')
    expect(out).toBe('env');
    expect(disp.isReadyForChannel('x')).toBe(true);
    expect(coreStub.isReadyForChannel).toHaveBeenCalledWith('x', 'saved'); // tier appended (defaults to 'saved')
  });

  it('worker path: activate wires the port; isReadyForChannel reads the readiness mirror', async () => {
    const posted: any[] = [];
    let portOnMessage: any = null;
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (m: any) => posted.push(m), set onmessage(fn: any) { portOnMessage = fn; }, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const disp = await import('../services/mls/mlsCoordinator');
    const bundleStub = { identity: { signaturePublicKey: new Uint8Array(), signaturePrivateKey: new Uint8Array(), credentialIdentity: new Uint8Array() }, userId: 'u', deviceId: 'd' };
    const actP = disp.activate(bundleStub as any, {} as CryptoKey, null);
    const init = posted.find((m) => m.kind === 'init');
    expect(init).toBeTruthy();
    portOnMessage?.({ data: { kind: 'rpc-result', correlationId: init.correlationId, ok: true, value: undefined } });
    await actP;
    portOnMessage?.({ data: { kind: 'readiness', active: true, readyChannelIds: ['chA'] } });
    expect(disp.isReadyForChannel('chA')).toBe(true);
    expect(disp.isReadyForChannel('chZ')).toBe(false);
  });

  it('rpc-result error re-attaches status/reason/unprovisionedUserId onto the rejected Error (worker path)', async () => {
    // The dispatcher must rebuild the typed peer-unprovisioned failure from
    // the serialized rpc-result error so routeEstablishOutcome sees err.reason and
    // err.unprovisionedUserId on the worker path.
    const posted: any[] = [];
    let portOnMessage: any = null;
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (m: any) => posted.push(m), set onmessage(fn: any) { portOnMessage = fn; }, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const disp = await import('../services/mls/mlsCoordinator');
    // Start the worker so establishChannel posts an rpc (activate need not settle).
    void disp.activate({ identity: { signaturePublicKey: new Uint8Array(), signaturePrivateKey: new Uint8Array(), credentialIdentity: new Uint8Array() }, userId: 'u', deviceId: 'd' } as any, {} as CryptoKey, null);
    const p = disp.establishChannel('ch1', 'ghost');
    p.catch(() => {});
    const req = posted.find((m) => m.kind === 'rpc' && m.method === 'establishChannel');
    expect(req).toBeTruthy();
    portOnMessage?.({ data: { kind: 'rpc-result', correlationId: req.correlationId, ok: false, error: { name: 'Error', message: 'member ghost has no available KeyPackages', status: 404, reason: 'peer-unprovisioned', unprovisionedUserId: 'ghost' } } });
    const err = await p.then(() => null, (e: unknown) => e) as Error & { status?: number; reason?: string; unprovisionedUserId?: string };
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('member ghost has no available KeyPackages');
    expect(err.status).toBe(404);
    expect(err.reason).toBe('peer-unprovisioned');
    expect(err.unprovisionedUserId).toBe('ghost');
  });

  it('rpc-result error WITHOUT the typed fields rejects with an Error that has no own reason/unprovisionedUserId/status', async () => {
    const posted: any[] = [];
    let portOnMessage: any = null;
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (m: any) => posted.push(m), set onmessage(fn: any) { portOnMessage = fn; }, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const disp = await import('../services/mls/mlsCoordinator');
    void disp.activate({ identity: { signaturePublicKey: new Uint8Array(), signaturePrivateKey: new Uint8Array(), credentialIdentity: new Uint8Array() }, userId: 'u', deviceId: 'd' } as any, {} as CryptoKey, null);
    const p = disp.establishChannel('ch1', 'peer');
    p.catch(() => {});
    const req = posted.find((m) => m.kind === 'rpc' && m.method === 'establishChannel');
    expect(req).toBeTruthy();
    portOnMessage?.({ data: { kind: 'rpc-result', correlationId: req.correlationId, ok: false, error: { name: 'Error', message: 'boom' } } });
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('boom');
    // Conditional spreads: absent fields must NOT appear as own properties (a
    // routeEstablishOutcome check on `reason` must see a clean miss, and a
    // forced-undefined `status` would break `'status' in err` consumers).
    expect('reason' in (err as object)).toBe(false);
    expect('unprovisionedUserId' in (err as object)).toBe(false);
    expect('status' in (err as object)).toBe(false);
  });

  it('emits onReadyChannel for channels that NEWLY become ready (worker path readiness diff)', async () => {
    // A fresh device self-joins via External Commit concurrently
    // with opening the DM. The worker pushes a `readiness` message that adds the channel
    // to the mirror but emitted NO event, so the lazy history restore never retried. The
    // dispatcher must diff the incoming ready set against the prior mirror and announce
    // each newly-ready channel (AFTER the mirror is rebuilt, so isReadyForChannel is true).
    let portOnMessage: any = null;
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (_m: any) => {}, set onmessage(fn: any) { portOnMessage = fn; }, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const disp = await import('../services/mls/mlsCoordinator');
    void disp.activate({ identity: { signaturePublicKey: new Uint8Array(), signaturePrivateKey: new Uint8Array(), credentialIdentity: new Uint8Array() }, userId: 'u', deviceId: 'd' } as any, {} as CryptoKey, null);
    const ready: string[] = [];
    const readyAtEmit: Record<string, boolean> = {};
    const off = disp.onReadyChannel((id) => { ready.push(id); readyAtEmit[id] = disp.isReadyForChannel(id); });
    portOnMessage?.({ data: { kind: 'readiness', active: true, readyChannelIds: ['chA'] } });
    portOnMessage?.({ data: { kind: 'readiness', active: true, readyChannelIds: ['chA', 'chB'] } }); // chA already ready
    portOnMessage?.({ data: { kind: 'readiness', active: true, readyChannelIds: ['chA', 'chB'] } }); // idempotent
    expect(ready).toEqual(['chA', 'chB']);          // each channel announced exactly once
    expect(readyAtEmit['chA']).toBe(true);          // mirror already reflects readiness at emit time
    expect(readyAtEmit['chB']).toBe(true);
    off();
  });

  it('relays core.onReadyChannel to onReadyChannel listeners (fallback path)', async () => {
    delete (globalThis as any).SharedWorker;
    let coreReadyCb: ((id: string) => void) | null = null;
    const coreStub = {
      installSeams: vi.fn(),
      mlsEvents: { on: vi.fn(() => () => {}) },
      onEpochChange: vi.fn(() => () => {}),
      onApplyFailed: vi.fn(() => () => {}),
      onKeyChange: vi.fn(() => () => {}),
      onKeyChangeResolved: vi.fn(() => () => {}),
      onReadyChannel: vi.fn((cb: (id: string) => void) => { coreReadyCb = cb; return () => {}; }),
      activate: vi.fn().mockResolvedValue(undefined),
    };
    vi.doMock('../services/mls/mlsCoordinatorCore', () => coreStub);
    const disp = await import('../services/mls/mlsCoordinator');
    await disp.activate({ identity: { signaturePublicKey: new Uint8Array(), signaturePrivateKey: new Uint8Array(), credentialIdentity: new Uint8Array() } } as any, {} as CryptoKey, null);
    const seen: string[] = [];
    disp.onReadyChannel((id) => seen.push(id));
    expect(coreReadyCb).toBeTruthy();               // ensureFallback subscribed the core emitter
    coreReadyCb!('chX');
    expect(seen).toEqual(['chX']);                  // relayed to the public dispatcher event
  });

  it('re-emits event-apply-failed from the worker to onApplyFailed listeners', async () => {
    const CH = 'chFail';
    let portOnMessage: any = null;
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (_m: any) => {}, set onmessage(fn: any) { portOnMessage = fn; }, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const disp = await import('../services/mls/mlsCoordinator');
    // Start the worker so workerPort.onmessage is wired to onWorkerMessage.
    void disp.activate({ identity: { signaturePublicKey: new Uint8Array(), signaturePrivateKey: new Uint8Array(), credentialIdentity: new Uint8Array() }, userId: 'u', deviceId: 'd' } as any, {} as CryptoKey, null);
    const seen: Array<{ dmChannelId: string; epoch: string }> = [];
    const off = disp.onApplyFailed((e) => seen.push(e));
    portOnMessage?.({ data: { kind: 'event-apply-failed', payload: { dmChannelId: CH, epoch: '2' } } });
    expect(seen).toEqual([{ dmChannelId: CH, epoch: '2' }]);
    off();
  });

  // Mobile-WebKit resilience: the module SharedWorker spawns but its module
  // graph (ts-mls + X-Wing) never finishes init, so the init RPC is never acked.
  // activate() must give up after a short timeout, tear the worker down, and
  // re-activate via the in-process core path (same pure-JS crypto, main thread).

  it('worker init never acks (mobile WebKit hang): activate() times out, tears down the worker, and falls back to the in-process core', async () => {
    vi.useFakeTimers();
    const posted: any[] = [];
    // SharedWorker EXISTS (so the worker path is chosen) but NEVER replies to init.
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (m: any) => posted.push(m), set onmessage(_fn: any) {}, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const coreStub = makeCoreStub();
    vi.doMock('../services/mls/mlsCoordinatorCore', () => coreStub);
    const disp = await import('../services/mls/mlsCoordinator');

    const actP = disp.activate(bundle as any, {} as CryptoKey, null);
    expect(posted.find((m) => m.kind === 'init')).toBeTruthy();   // init was posted to the (hung) worker

    // Past the short init timeout (and past the legacy 30s, so this is a clean RED
    // against the pre-fix code, which would reject with "mls init timed out").
    await vi.advanceTimersByTimeAsync(35000);
    await actP;                                                   // must RESOLVE via fallback, not reject

    expect(coreStub.activate).toHaveBeenCalledTimes(1);           // fell back to the in-process core
    expect(disp.isActive()).toBe(true);                           // now reads the core's active state
    expect(coreStub.isActive).toHaveBeenCalled();
  });

  it('worker errors during init (hard failure): activate() falls back to the in-process core', async () => {
    const posted: any[] = [];
    let triggerError: any = null;
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (m: any) => posted.push(m), set onmessage(_fn: any) {}, set onmessageerror(_fn: any) {}, start() {} };
      set onerror(fn: any) { triggerError = fn; }
      constructor(_url: unknown, _opts: unknown) {}
    };
    const coreStub = makeCoreStub();
    vi.doMock('../services/mls/mlsCoordinatorCore', () => coreStub);
    const disp = await import('../services/mls/mlsCoordinator');

    const actP = disp.activate(bundle as any, {} as CryptoKey, null);
    expect(posted.find((m) => m.kind === 'init')).toBeTruthy();
    triggerError?.(new Event('error'));                           // worker dies mid-init
    await actP;                                                   // resolves via fallback

    expect(coreStub.activate).toHaveBeenCalledTimes(1);
    expect(disp.isActive()).toBe(true);
  });

  it('worker init succeeds: stays on the worker path and never falls back to the core', async () => {
    let portOnMessage: any = null;
    const posted: any[] = [];
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (m: any) => posted.push(m), set onmessage(fn: any) { portOnMessage = fn; }, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const coreStub = makeCoreStub();
    vi.doMock('../services/mls/mlsCoordinatorCore', () => coreStub);
    const disp = await import('../services/mls/mlsCoordinator');

    const actP = disp.activate(bundle as any, {} as CryptoKey, null);
    const init = posted.find((m) => m.kind === 'init');
    portOnMessage?.({ data: { kind: 'rpc-result', correlationId: init.correlationId, ok: true, value: undefined } });
    await actP;

    expect(coreStub.activate).not.toHaveBeenCalled();             // worker acked → no fallback
    portOnMessage?.({ data: { kind: 'readiness', active: true, readyChannelIds: ['chA'] } });
    expect(disp.isReadyForChannel('chA')).toBe(true);             // reads the worker readiness mirror
    expect(coreStub.isReadyForChannel).not.toHaveBeenCalled();
  });

  it('after the init-timeout fallback, ALL calls route to the core (deactivate reaches core.deactivate, not the worker no-op)', async () => {
    // Regression guard: deactivate()/rekey() early-return on `!workerPort`. The
    // fallback must flip the path flag itself (not merely null the port) so every
    // subsequent call — deactivate, encrypt, isActive — reaches the in-process core.
    vi.useFakeTimers();
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (_m: any) => {}, set onmessage(_fn: any) {}, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const coreStub = makeCoreStub();
    vi.doMock('../services/mls/mlsCoordinatorCore', () => coreStub);
    const disp = await import('../services/mls/mlsCoordinator');

    const actP = disp.activate(bundle as any, {} as CryptoKey, null);
    await vi.advanceTimersByTimeAsync(35000);
    await actP;

    disp.deactivate();
    expect(coreStub.deactivate).toHaveBeenCalledTimes(1);         // reached the core, not the worker no-op
    await disp.encrypt('ch', 'pt');
    expect(coreStub.encrypt).toHaveBeenCalledWith('ch', 'pt', 'saved'); // proxy routes to the core too (tier appended)
  });

  it('deactivate() racing a pending worker-init stays locked — it does NOT resurrect MLS on the fallback core', async () => {
    // Confidentiality guard: on iOS the worker hangs init for the whole window, so a
    // lock()/logout during it calls deactivate() FIRST, which rejects the in-flight
    // init. That rejection must NOT be mistaken for a worker failure: falling back here
    // would re-run core.activate, re-installing the at-rest key lock() just nulled (and
    // with a clearMlsState-zeroed identity). The user locked → stay locked.
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (_m: any) => {}, set onmessage(_fn: any) {}, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const coreStub = makeCoreStub();
    vi.doMock('../services/mls/mlsCoordinatorCore', () => coreStub);
    const disp = await import('../services/mls/mlsCoordinator');

    const actP = disp.activate(bundle as any, {} as CryptoKey, null);   // worker-init pending (never acks)
    disp.deactivate();                                                  // user locks → rejects the pending init
    await actP;                                                         // must settle WITHOUT falling back

    expect(coreStub.activate).not.toHaveBeenCalled();                  // no resurrection after a deliberate lock
    expect(disp.isActive()).toBe(false);                               // still the worker mirror (locked), not the core
  });

  it('after the fallback flip, a later activate() routes straight to the core (no worker re-spawn)', async () => {
    // Coverage for the relock/unlock and dmKeyManager auto-recovery cycle: once the
    // session has fallen back, useWorker stays false, so every subsequent activate()
    // uses the in-process core and never posts another worker init.
    vi.useFakeTimers();
    const posted: any[] = [];
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (m: any) => posted.push(m), set onmessage(_fn: any) {}, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const coreStub = makeCoreStub();
    vi.doMock('../services/mls/mlsCoordinatorCore', () => coreStub);
    const disp = await import('../services/mls/mlsCoordinator');

    const actP = disp.activate(bundle as any, {} as CryptoKey, null);
    await vi.advanceTimersByTimeAsync(35000);
    await actP;
    expect(coreStub.activate).toHaveBeenCalledTimes(1);                // first activate fell back
    const initCount = posted.filter((m) => m.kind === 'init').length;

    await disp.activate(bundle as any, {} as CryptoKey, null);         // a later unlock cycle
    expect(coreStub.activate).toHaveBeenCalledTimes(2);                // routed to the core again
    expect(posted.filter((m) => m.kind === 'init').length).toBe(initCount); // no new worker init posted
  });

  // Remember the fallback: a device whose worker hangs records it, so the NEXT
  // page load skips the worker entirely (no 5s wait, no locked flash) instead of
  // re-detecting the hang every time.

  it('a genuine worker-init failure remembers it (persists the unsupported flag)', async () => {
    vi.useFakeTimers();
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (_m: any) => {}, set onmessage(_fn: any) {}, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const coreStub = makeCoreStub();
    vi.doMock('../services/mls/mlsCoordinatorCore', () => coreStub);
    const disp = await import('../services/mls/mlsCoordinator');

    expect(localStorage.getItem(WORKER_UNSUPPORTED_KEY)).toBeNull();   // not remembered yet
    const actP = disp.activate(bundle as any, {} as CryptoKey, null);
    await vi.advanceTimersByTimeAsync(35000);
    await actP;

    expect(coreStub.activate).toHaveBeenCalledTimes(1);               // fell back this session
    expect(localStorage.getItem(WORKER_UNSUPPORTED_KEY)).toBe('1');   // and remembered for next time
  });

  it('a transient worker ERROR during init falls back this session but does NOT remember (only the WebKit hang/timeout is sticky)', async () => {
    // A one-off worker error (deploy chunk-hash 404, network blip, OOM) must not
    // permanently downgrade a healthy device — it self-heals on the next load. Only
    // the init TIMEOUT (the genuine module-graph hang) is remembered.
    let triggerError: any = null;
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (_m: any) => {}, set onmessage(_fn: any) {}, set onmessageerror(_fn: any) {}, start() {} };
      set onerror(fn: any) { triggerError = fn; }
      constructor(_url: unknown, _opts: unknown) {}
    };
    const coreStub = makeCoreStub();
    vi.doMock('../services/mls/mlsCoordinatorCore', () => coreStub);
    const disp = await import('../services/mls/mlsCoordinator');

    const actP = disp.activate(bundle as any, {} as CryptoKey, null);
    triggerError?.(new Event('error'));                              // transient error, NOT a hang
    await actP;

    expect(coreStub.activate).toHaveBeenCalledTimes(1);             // fell back this session
    expect(localStorage.getItem(WORKER_UNSUPPORTED_KEY)).toBeNull(); // but did NOT persist
  });

  it('a deactivate-race (deliberate lock) does NOT remember the worker as unsupported', async () => {
    // The lock-race rejects the init too, but it is not a worker failure — it must not
    // poison the flag and make every future load skip a perfectly good worker.
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (_m: any) => {}, set onmessage(_fn: any) {}, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const coreStub = makeCoreStub();
    vi.doMock('../services/mls/mlsCoordinatorCore', () => coreStub);
    const disp = await import('../services/mls/mlsCoordinator');

    const actP = disp.activate(bundle as any, {} as CryptoKey, null);
    disp.deactivate();                                                // deliberate teardown races the init
    await actP;

    expect(coreStub.activate).not.toHaveBeenCalled();                // stayed locked (no resurrection)
    expect(localStorage.getItem(WORKER_UNSUPPORTED_KEY)).toBeNull(); // and did NOT remember a "failure"
  });

  it("readiness push synthesizes 'mls-ready' when the mirror flips inactive->active with no event (warm-worker reload / non-leader tab)", async () => {
    // A reload against a still-warm SharedWorker (core already active: init re-emits
    // nothing) and any non-leader tab ('mls-ready' is leader-only) both flip the
    // readiness mirror WITHOUT an 'event' broadcast. Consumers key ready-time work
    // (key-change alert hydration, redecrypt sweeps) off mlsEvents — the transition
    // must fire anyway.
    let portOnMessage: any = null;
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (_m: any) => {}, set onmessage(fn: any) { portOnMessage = fn; }, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const disp = await import('../services/mls/mlsCoordinator');
    void disp.activate(bundle as any, {} as CryptoKey, null); // spawns the worker + port (init ack not needed)
    const events: string[] = [];
    disp.mlsEvents.on((e) => events.push(e));
    portOnMessage?.({ data: { kind: 'readiness', active: true, readyChannelIds: [] } });
    expect(events).toEqual(['mls-ready']);
    expect(disp.isActive()).toBe(true);
    // A later readiness push while already active (e.g. a channel diff) must NOT re-fire.
    portOnMessage?.({ data: { kind: 'readiness', active: true, readyChannelIds: ['chA'] } });
    expect(events).toEqual(['mls-ready']);
  });

  it("no double 'mls-ready' when the real event precedes the readiness push (leader activate)", async () => {
    let portOnMessage: any = null;
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (_m: any) => {}, set onmessage(fn: any) { portOnMessage = fn; }, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) {}
    };
    const disp = await import('../services/mls/mlsCoordinator');
    void disp.activate(bundle as any, {} as CryptoKey, null);
    const events: string[] = [];
    disp.mlsEvents.on((e) => events.push(e));
    // Leader ordering: core emits the real event during activate, THEN pushReadiness.
    portOnMessage?.({ data: { kind: 'event', event: 'mls-ready' } });
    portOnMessage?.({ data: { kind: 'readiness', active: true, readyChannelIds: [] } });
    expect(events).toEqual(['mls-ready']);
    // The generalized latch still re-arms across a lock: locked -> ready -> locked all emit.
    portOnMessage?.({ data: { kind: 'event', event: 'mls-locked' } });
    portOnMessage?.({ data: { kind: 'event', event: 'mls-locked' } }); // duplicate lock stays deduped
    portOnMessage?.({ data: { kind: 'readiness', active: false, readyChannelIds: [] } });
    portOnMessage?.({ data: { kind: 'readiness', active: true, readyChannelIds: [] } }); // non-leader re-activate
    expect(events).toEqual(['mls-ready', 'mls-locked', 'mls-ready']);
  });

  it('with the unsupported flag remembered, activate() skips the worker and goes straight to the core (instant, no spawn)', async () => {
    localStorage.setItem(WORKER_UNSUPPORTED_KEY, '1');                // remembered from a prior session
    let constructed = 0;
    (globalThis as any).SharedWorker = class {
      port = { postMessage: (_m: any) => {}, set onmessage(_fn: any) {}, set onmessageerror(_fn: any) {}, start() {} };
      onerror: any = null;
      constructor(_url: unknown, _opts: unknown) { constructed++; }
    };
    const coreStub = makeCoreStub();
    vi.doMock('../services/mls/mlsCoordinatorCore', () => coreStub);
    const disp = await import('../services/mls/mlsCoordinator');

    await disp.activate(bundle as any, {} as CryptoKey, null);        // resolves immediately, no timers advanced
    expect(constructed).toBe(0);                                     // worker never spawned
    expect(coreStub.activate).toHaveBeenCalledTimes(1);              // straight to in-process
    expect(disp.isActive()).toBe(true);                             // reads the core, not the worker mirror
    expect(coreStub.isActive).toHaveBeenCalled();
  });
});
