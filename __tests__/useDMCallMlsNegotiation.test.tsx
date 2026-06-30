// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * useDMCall key resolution (MLS-only).
 *
 * MLS is the sole scheme. When the channel is MLS-ready the hook derives the
 * SFrame base key from the exporter and keys the session; otherwise the call
 * is BLOCKED (the session never starts, channelId gated to null). There is no
 * legacy wrapped-key rung and no roster downgrade/upgrade ladder.
 *
 * Mock seams mirror useMlsRedecrypt.test.tsx (coordinator capture) and
 * useVoiceChannelE2eeShield.test.tsx (useCallSession spy).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

let mlsReady = false;
let deriveResult: { keyB64: string; epoch: string } | null = null;
const deriveSpy = vi.fn(async (_ch: string) => deriveResult);
/** Captured rekey subscription; null when the hook is unsubscribed. */
let epochCb: ((e: { dmChannelId: string; groupId: string; epoch: string }) => void) | null = null;
vi.mock('../services/mls/mlsCoordinator', () => ({
  isReadyForChannel: () => mlsReady,
  deriveSframeBaseKey: (ch: string) => deriveSpy(ch),
  onEpochChange: (cb: (e: { dmChannelId: string; groupId: string; epoch: string }) => void) => {
    epochCb = cb;
    return () => { epochCb = null; };
  },
}));

let channelMls = false;
vi.mock('../services/encryptionFlags', () => ({
  isChannelMls: () => channelMls,
  isChannelEncrypted: () => true,
  setChannelEncryptionStatus: vi.fn(),
}));

/** Captured so the unmount tests can assert no post-unmount error log fires. */
const loggerError = vi.fn();
vi.mock('../services/logger', () => ({
  logger: {
    error: (...a: unknown[]) => loggerError(...a),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

/** Mutable so the degraded-latch and locked-start tests can flip the vault
 *  state mid-test (the previous hardwired `() => true` made the 'none'
 *  branch structurally unreachable). */
let unlocked = true;
vi.mock('../services/dmKeyManager', () => ({
  isUnlocked: () => unlocked,
}));

const joinDmCall = vi.fn(async (..._a: unknown[]) => ({}));
const sendDmCallE2eeAck = vi.fn();
vi.mock('../services/socket', () => ({
  socketService: {
    joinDmCall: (...a: unknown[]) => joinDmCall(...a),
    leaveDmCall: vi.fn(),
    whenConnected: (cb: () => void) => cb(),
    onDmCallParticipants: vi.fn(), onDmCallUserJoined: vi.fn(), onDmCallUserLeft: vi.fn(),
    onDmCallJoinError: vi.fn(), onDmCallStateUpdate: vi.fn(),
    onDmCallInactivityDisconnect: vi.fn(), offDmCall: vi.fn(), offDmCallStateUpdate: vi.fn(),
    onDmCallE2eeAck: vi.fn(), offDmCallE2eeAck: vi.fn(),
    sendDmCallE2eeAck: (ch: string, ok: boolean) => sendDmCallE2eeAck(ch, ok),
    emitViewerSubscribe: vi.fn(async () => {}), emitViewerUnsubscribe: vi.fn(async () => {}),
  },
}));

const callSessionSpy = vi.fn();
const setE2eeKey = vi.fn(async (_key: Uint8Array) => {});
const setE2eeKeyAtEpoch = vi.fn(async (_key: Uint8Array, _epoch: bigint) => {});
let sessionRemoteParticipants: Array<{ userId: string; mlsCallReady?: boolean }> = [];
let sessionStartedAt: number | null = null;
/** Mutable like sessionStartedAt: the SFrame-error test bumps it to simulate
 *  RoomEvent.EncryptionError counted by useCallSession. */
let sessionE2eeErrorCount = 0;
vi.mock('../hooks/useCallSession', () => ({
  useCallSession: (...args: unknown[]) => {
    callSessionSpy(...args);
    return {
      localStream: null, remoteParticipants: sessionRemoteParticipants, leave: vi.fn(), error: null,
      disconnectedByInactivity: false, enableRemoteScreen: vi.fn(), disableRemoteScreen: vi.fn(),
      setE2eeKey, setE2eeKeyAtEpoch, switchMicDevice: vi.fn(), serverRegion: null,
      startedAt: sessionStartedAt, getMicSilenceMs: () => 0,
      e2eeErrorCount: sessionE2eeErrorCount,
    };
  },
}));

/** Mutable so the resolution-freeze tests can flip the store's encrypted view
 *  mid-call (production triggers: Close DM, dm-removed-from-group,
 *  bootstrap absent -> present). */
let storeEncrypted = true;
vi.mock('../stores/dmStore', () => ({
  useDmStore: (sel: (s: { dmChannels: Array<{ id: string; encrypted: boolean }> }) => unknown) =>
    sel({ dmChannels: [{ id: 'ch-1', encrypted: storeEncrypted }] }),
}));

import { useDMCall } from '../hooks/useDMCall';

const CH = 'ch-1';
const user = { id: 'u-self', username: 'self' } as never;
const flush = () => new Promise((r) => setTimeout(r, 0));
/** Flush async continuations INSIDE act so any state commits they trigger
 *  land before the assertions sample result.current. */
const settle = () => act(async () => { await flush(); await flush(); });
const b64 = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Args mirror the App.tsx call: positions 1-21 then incomingMlsCallReady (22). */
function render(opts: { isInitiator: boolean; incomingMlsCallReady?: boolean }) {
  return renderHook(() => useDMCall(
    CH, user, false, null, null, undefined, undefined, null,
    false, 'auto', opts.isInitiator,
    undefined, undefined, 100, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined,
    opts.incomingMlsCallReady,
  ));
}

/** Resolution finished AND its re-render landed, with the session blocked.
 *  isE2eeBlocked flips true once resolution completes without an MLS key,
 *  so waiting on it pins the terminal state; the LAST useCallSession call
 *  from that same committed render must then carry channelId null. Sampling
 *  call-count alone is racy: the mount-time ack-Set resets produce an early
 *  pre-resolution re-render whose channelId is also null. */
async function expectBlocked(result: { current: { isE2eeBlocked: boolean } }) {
  await waitFor(() => expect(result.current.isE2eeBlocked).toBe(true));
  expect(callSessionSpy.mock.calls.at(-1)![0]).toBeNull();
}

beforeEach(() => {
  vi.clearAllMocks();
  mlsReady = false;
  channelMls = false;
  deriveResult = null;
  epochCb = null;
  sessionRemoteParticipants = [];
  sessionStartedAt = null;
  sessionE2eeErrorCount = 0;
  unlocked = true;
  storeEncrypted = true;
});

describe('useDMCall MLS negotiation: resolution', () => {
  it('initiator on an MLS-ready channel derives the exporter key and keys the session, advertises mlsCallReady', async () => {
    channelMls = true; mlsReady = true;
    deriveResult = { keyB64: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))), epoch: '3' };
    render({ isInitiator: true });
    await waitFor(() => expect(deriveSpy).toHaveBeenCalledWith(CH));
    // Session started with the MLS key at position 14 and e2eeKeyIndex (29) = 3 % 16.
    await waitFor(() => {
      const args = callSessionSpy.mock.calls.at(-1)!;
      expect(args[0]).toBe(CH);                                  // session gated on (not blocked)
      expect(Array.from(args[13] as Uint8Array)).toEqual(new Array(32).fill(1));
      expect(args[28]).toBe(3);
    });
  });

  it('initiator on a non-MLS channel BLOCKS: session never starts', async () => {
    const { result } = render({ isInitiator: true });
    await expectBlocked(result);
    expect(deriveSpy).not.toHaveBeenCalled();
  });

  it('recipient with both-ready keys the MLS exporter key', async () => {
    channelMls = true; mlsReady = true;
    deriveResult = { keyB64: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))), epoch: '4' };
    render({ isInitiator: false, incomingMlsCallReady: true });
    await waitFor(() => {
      const args = callSessionSpy.mock.calls.at(-1)!;
      expect(Array.from(args[13] as Uint8Array)).toEqual(new Array(32).fill(1));
    });
  });

  it('recipient MLS-ready but ringer NOT ready BLOCKS (no legacy rung below MLS)', async () => {
    channelMls = true; mlsReady = true;
    deriveResult = { keyB64: b64(1), epoch: '3' };
    const { result } = render({ isInitiator: false, incomingMlsCallReady: false });
    await expectBlocked(result);
  });

  it('recipient with no MLS key BLOCKS (session never starts)', async () => {
    const { result } = render({ isInitiator: false, incomingMlsCallReady: true });
    await expectBlocked(result);
  });

  it('join advertises the local derive outcome', async () => {
    channelMls = true; mlsReady = true;
    deriveResult = { keyB64: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))), epoch: '0' };
    render({ isInitiator: true });
    await waitFor(() => expect(deriveSpy).toHaveBeenCalled());
    // Wait for the post-resolution render (channelId = CH) so the refs the
    // transport reads (mlsAdvertiseRef) are committed.
    await waitFor(() => expect(callSessionSpy.mock.calls.at(-1)![0]).toBe(CH));
    // Drive the transport join exactly as useCallSession would
    // (the hook exposes the transport via useCallSession's 3rd positional arg).
    const transport = callSessionSpy.mock.calls.at(-1)![2] as { join: (c: string, u: string) => Promise<unknown> };
    await transport.join(CH, 'self');
    expect(joinDmCall).toHaveBeenCalledWith(CH, 'self', undefined, undefined, false, true);
  });

  it('locked at call start opens the gate transport-only and ships no key material', async () => {
    unlocked = false;
    const { result } = render({ isInitiator: true });
    await waitFor(() => {
      const args = callSessionSpy.mock.calls.at(-1)!;
      expect(args[0]).toBe(CH);    // transport-only session starts (main parity)
      expect(args[13]).toBeNull(); // with no key bytes
    });
    // Shield 'none': E2EE was never expected for this call (nothing keyed).
    expect(result.current.isE2eeBlocked).toBe(false);
    expect(result.current.isE2eeFailed).toBe(false);
    expect(result.current.isE2eeEstablishing).toBe(false);
    expect(result.current.isE2ee).toBe(false);
    expect(deriveSpy).not.toHaveBeenCalled();
    const transport = callSessionSpy.mock.calls.at(-1)![2] as { join: (c: string, u: string) => Promise<unknown> };
    await transport.join(CH, 'self');
    // No MLS advertise: a locked-start call must not claim readiness it does
    // not have.
    expect(joinDmCall).toHaveBeenCalledWith(CH, 'self', undefined, undefined, false, false);
  });
});

/** Sibling of render() for the PRODUCTION timeline: App.tsx mounts this hook
 *  permanently with dmChannelId = null (activeDmCallChannelId) and flips it
 *  to the channel id when a call starts, back to null when it ends. The
 *  channel (and the per-call negotiation inputs) must flow through renderHook
 *  props so the null -> CH -> null -> CH lifecycle is reproducible. Same 22
 *  positional args as render() with ch swapped in. */
type TimelineProps = {
  ch: string | null;
  isInitiator: boolean;
  incomingMlsCallReady?: boolean;
};
function renderTimeline(initialProps: TimelineProps) {
  return renderHook(
    (p: TimelineProps) => useDMCall(
      p.ch, user, false, null, null, undefined, undefined, null,
      false, 'auto', p.isInitiator,
      undefined, undefined, 100, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      p.incomingMlsCallReady,
    ),
    { initialProps },
  );
}

describe('useDMCall MLS negotiation: production timeline (null -> channel)', () => {
  it('call start from idle: the session never constructs before resolution settles (engine would be permanently unkeyed)', async () => {
    channelMls = true; mlsReady = true;
    deriveResult = { keyB64: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))), epoch: '3' };
    const { rerender } = renderTimeline({ ch: null, isInitiator: true });
    rerender({ ch: CH, isInitiator: true });
    await waitFor(() => expect(callSessionSpy.mock.calls.some((c) => c[0] === CH)).toBe(true));
    // The FIRST session construction for this channel must already carry the
    // resolved key and epoch slot: CallEngine only sets up E2EE at construct
    // time (no late-enable path), so an earlier gated-open render with stale
    // readiness would build a permanently unencrypted room.
    const first = callSessionSpy.mock.calls.find((c) => c[0] === CH)!;
    expect(Array.from((first[13] ?? []) as Uint8Array)).toEqual(new Array(32).fill(1));
    expect(first[28]).toBe(3);
  });

  it("second call does not inherit the previous call's epoch slot or advertise flag", async () => {
    // Call 1: MLS at epoch 3.
    channelMls = true; mlsReady = true;
    deriveResult = { keyB64: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))), epoch: '3' };
    const { rerender } = renderTimeline({ ch: null, isInitiator: true });
    rerender({ ch: CH, isInitiator: true });
    await waitFor(() => {
      const args = callSessionSpy.mock.calls.at(-1)!;
      expect(args[0]).toBe(CH);
      expect(args[28]).toBe(3); // call 1 keyed via MLS at epoch slot 3
    });

    // End the call, then make the channel not-MLS so call 2 BLOCKS.
    rerender({ ch: null, isInitiator: true });
    channelMls = false; mlsReady = false; deriveResult = null;
    rerender({ ch: CH, isInitiator: true });

    // Call 2 blocks: the session never reopens for it, and no stale epoch
    // slot or MLS advertise can leak from call 1.
    await waitFor(() => expect(callSessionSpy.mock.calls.at(-1)![0]).toBeNull());
  });

  it('idle reset: returning to null clears scheme so a "blocked" outcome does not leak into the next call\'s gate', async () => {
    // Call 1: recipient with no MLS resolves to 'blocked'. The session must
    // never construct for it, not even during the null -> CH transition
    // render: with stale idle readiness the gate would open before
    // resolution and build an unkeyed transport-only room.
    const blockedProps = { isInitiator: false, incomingMlsCallReady: true } as const;
    const { result, rerender } = renderTimeline({ ch: null, ...blockedProps });
    rerender({ ch: CH, ...blockedProps });
    await waitFor(() => expect(result.current.isE2eeBlocked).toBe(true));
    expect(callSessionSpy.mock.calls.some((c) => c[0] === CH)).toBe(false);

    // End the blocked call, then start a legitimate initiator MLS call on the
    // same channel: the gate must open for it (the 'blocked' scheme must not
    // leak forward and keep the next call gated).
    rerender({ ch: null, ...blockedProps });
    channelMls = true; mlsReady = true; deriveResult = { keyB64: b64(1), epoch: '3' };
    const marker = callSessionSpy.mock.calls.length;
    rerender({ ch: CH, isInitiator: true });
    await waitFor(() =>
      expect(callSessionSpy.mock.calls.slice(marker).some((c) => c[0] === CH)).toBe(true));
  });
});

describe('useDMCall MLS negotiation: runtime', () => {
  function startMlsCall() {
    channelMls = true; mlsReady = true;
    deriveResult = { keyB64: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))), epoch: '3' };
    sessionStartedAt = 1000; // session up: rekey/reconcile effects active
    return render({ isInitiator: true });
  }

  it('rekeys on an epoch change for the call channel via setE2eeKeyAtEpoch', async () => {
    deriveSpy.mockClear();
    const view = startMlsCall();
    await waitFor(() => expect(epochCb).toBeTruthy());
    // Drain the mount-time reconcile install before clearing: its async
    // completion otherwise races the epoch-fired rekey, and .at(-1) could
    // still read the reconcile's (fill(1), 3n) pair.
    await waitFor(() => expect(setE2eeKeyAtEpoch).toHaveBeenCalled());
    setE2eeKeyAtEpoch.mockClear();
    deriveResult = { keyB64: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))), epoch: '4' };
    epochCb!({ dmChannelId: CH, groupId: 'g', epoch: '4' });
    await waitFor(() => expect(setE2eeKeyAtEpoch).toHaveBeenCalled());
    const [key, epoch] = setE2eeKeyAtEpoch.mock.calls.at(-1)! as [Uint8Array, bigint];
    expect(Array.from(key)).toEqual(new Array(32).fill(9));
    expect(epoch).toBe(4n);
    view.unmount();
  });

  it('ignores epoch changes for other channels', async () => {
    const view = startMlsCall();
    await waitFor(() => expect(epochCb).toBeTruthy());
    // Drain the mount-time reconcile install before clearing, else its async
    // completion lands after mockClear and flakes the not-called assertion.
    await waitFor(() => expect(setE2eeKeyAtEpoch).toHaveBeenCalled());
    setE2eeKeyAtEpoch.mockClear();
    epochCb!({ dmChannelId: 'other-channel', groupId: 'g', epoch: '9' });
    await flush();
    expect(setE2eeKeyAtEpoch).not.toHaveBeenCalled();
    view.unmount();
  });

  it('rekey derive failure flips degraded, keeps the old key installed', async () => {
    const view = startMlsCall();
    await waitFor(() => expect(epochCb).toBeTruthy());
    await waitFor(() => expect(setE2eeKeyAtEpoch).toHaveBeenCalled()); // drain mount reconcile
    setE2eeKeyAtEpoch.mockClear();
    deriveResult = null; // vault locked mid-call: derive now returns null
    epochCb!({ dmChannelId: CH, groupId: 'g', epoch: '5' });
    await flush(); await flush();
    expect(setE2eeKeyAtEpoch).not.toHaveBeenCalled();
    view.unmount();
  });

  it('degraded heals: a failed rekey flips the shield to failed, the next successful rekey clears it', async () => {
    const view = startMlsCall();
    await waitFor(() => expect(epochCb).toBeTruthy());
    await waitFor(() => expect(setE2eeKeyAtEpoch).toHaveBeenCalled()); // drain mount reconcile
    // Zero peers and locally keyed: the honest idle state is 'encrypting',
    // so no ack interference can mask the degraded flag in this test.
    expect(view.result.current.isE2eeFailed).toBe(false);

    deriveResult = null; // vault locked mid-call: derive now returns null
    epochCb!({ dmChannelId: CH, groupId: 'g', epoch: '5' });
    await waitFor(() => expect(view.result.current.isE2eeFailed).toBe(true)); // degraded -> failed

    // Vault unlocked again: the next Commit's rekey succeeds and must HEAL
    // the sticky degraded flag (the honest state is no longer failed).
    deriveResult = { keyB64: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))), epoch: '6' };
    epochCb!({ dmChannelId: CH, groupId: 'g', epoch: '6' });
    await waitFor(() => expect(view.result.current.isE2eeFailed).toBe(false));
    // With zero peers the healed shield reads 'encrypting', not 'secure'
    // (green still requires every present peer to ack).
    expect(view.result.current.isE2eeEstablishing).toBe(true);
    expect(view.result.current.isE2ee).toBe(false);
    view.unmount();
  });

  it('unmount unsubscribes and zeroizes held key material', async () => {
    const view = startMlsCall();
    await waitFor(() => expect(epochCb).toBeTruthy());
    // The mount-time reconcile re-derives and swaps mlsKeyRef to a FRESH
    // array, superseding the construct-time alias (callSessionSpy args[13]),
    // so capture the material the hook actually holds at unmount: the last
    // installed MLS key.
    await waitFor(() => expect(setE2eeKeyAtEpoch).toHaveBeenCalled());
    const heldMls = setE2eeKeyAtEpoch.mock.calls.at(-1)![0] as Uint8Array;
    expect(Array.from(heldMls)).toEqual(new Array(32).fill(1)); // pre-unmount sanity
    view.unmount();
    expect(epochCb).toBeNull(); // unsubscribed
    expect(Array.from(heldMls)).toEqual(new Array(32).fill(0)); // zeroized
  });

  it('resolution is one-shot; a mid-call dmStore flip never replays it', async () => {
    channelMls = true; mlsReady = true;
    deriveResult = { keyB64: b64(1), epoch: '3' };
    const view = render({ isInitiator: true });
    await waitFor(() => expect(callSessionSpy.mock.calls.at(-1)![0]).toBe(CH));
    const deriveCalls = deriveSpy.mock.calls.length;

    // Production triggers: Close DM on the in-call channel, group removal,
    // bootstrap absent -> present. All surface as a dmStore encrypted flip.
    storeEncrypted = false;
    view.rerender();
    await settle();

    expect(deriveSpy.mock.calls.length).toBe(deriveCalls);    // no replayed derive
    expect(callSessionSpy.mock.calls.at(-1)![0]).toBe(CH);    // session gate still open
    view.unmount();
  });

  it('a mid-call dmStore flip does not silently heal a degraded call', async () => {
    const view = startMlsCall();
    await waitFor(() => expect(epochCb).toBeTruthy());
    await waitFor(() => expect(setE2eeKeyAtEpoch).toHaveBeenCalled()); // drain mount reconcile
    deriveResult = null; // vault trouble mid-call: the rekey derive fails
    epochCb!({ dmChannelId: CH, groupId: 'g', epoch: '5' });
    await waitFor(() => expect(view.result.current.isE2eeFailed).toBe(true));

    storeEncrypted = false;
    view.rerender();
    await settle();

    expect(view.result.current.isE2eeFailed).toBe(true);   // no false heal
    expect(callSessionSpy.mock.calls.at(-1)![0]).toBe(CH); // gate never nulled mid-call
    view.unmount();
  });

  it('a degraded member re-acks ok:false; a successful rekey re-acks ok:true', async () => {
    sessionRemoteParticipants = [{ userId: 'peer-mls', mlsCallReady: true }];
    const view = startMlsCall();
    await waitFor(() => expect(sendDmCallE2eeAck).toHaveBeenLastCalledWith(CH, true));
    await waitFor(() => expect(setE2eeKeyAtEpoch).toHaveBeenCalled()); // reconcile drained

    deriveResult = null; // a Commit lands but the derive fails: degraded
    epochCb!({ dmChannelId: CH, groupId: 'g', epoch: '5' });
    // The peer's shield must not stay green off our stale ok:true ack.
    await waitFor(() => expect(sendDmCallE2eeAck).toHaveBeenLastCalledWith(CH, false));

    deriveResult = { keyB64: b64(9), epoch: '6' }; // the next Commit heals
    epochCb!({ dmChannelId: CH, groupId: 'g', epoch: '6' });
    await waitFor(() => expect(sendDmCallE2eeAck).toHaveBeenLastCalledWith(CH, true));
    view.unmount();
  });

  it('a mid-call vault lock does not vanish the shield on a keyed call', async () => {
    const view = startMlsCall();
    await waitFor(() => expect(callSessionSpy.mock.calls.at(-1)![0]).toBe(CH));
    // Keyed, zero peers: the honest shield is 'encrypting' (amber).
    expect(view.result.current.isE2eeEstablishing).toBe(true);

    unlocked = false; // idle-lock or explicit vault lock mid-call
    view.rerender();

    // The shield must NOT collapse to 'none' (all flags false): our leg is
    // still keyed and the engine keeps encrypting, so with zero peers the
    // honest observable stays isE2eeEstablishing. Locked at call START still
    // yields 'none' because nothing was ever keyed (see the locked-at-start test).
    expect(view.result.current.isE2eeEstablishing).toBe(true);
    expect(view.result.current.isE2ee).toBe(false);
    expect(view.result.current.isE2eeFailed).toBe(false);
    view.unmount();
  });

  it('an SFrame EncryptionError flips the shield to failed; the next successful rekey heals it', async () => {
    const view = startMlsCall();
    await waitFor(() => expect(epochCb).toBeTruthy());
    await waitFor(() => expect(setE2eeKeyAtEpoch).toHaveBeenCalled()); // reconcile drained
    expect(view.result.current.isE2eeFailed).toBe(false);

    sessionE2eeErrorCount = 1; // transient forward-edge decrypt skew (mid-call Commit)
    view.rerender();
    await waitFor(() => expect(view.result.current.isE2eeFailed).toBe(true));

    deriveResult = { keyB64: b64(9), epoch: '6' };
    epochCb!({ dmChannelId: CH, groupId: 'g', epoch: '6' });
    await waitFor(() => expect(view.result.current.isE2eeFailed).toBe(false));
    view.unmount();
  });
});

/** The resolution effect's `if (cancelled) return;` guard. These pin it
 *  through both supersession shapes: a dep-flip rerun and an unmount. */
describe('useDMCall MLS negotiation: resolution cancellation', () => {
  it('a cancelled resolution run commits nothing; the superseding run wins', async () => {
    channelMls = true; mlsReady = true;
    const d1 = deferred<{ keyB64: string; epoch: string } | null>();
    deriveSpy.mockImplementationOnce(() => d1.promise);
    const view = renderTimeline({ ch: CH, isInitiator: false, incomingMlsCallReady: false });
    await waitFor(() => expect(deriveSpy).toHaveBeenCalledTimes(1)); // run 1 parked on derive

    // The ringer's advertised readiness flips (store re-launder): run 1 is
    // cancelled by the dep change, run 2 starts and completes as MLS.
    deriveResult = { keyB64: b64(1), epoch: '3' };
    view.rerender({ ch: CH, isInitiator: false, incomingMlsCallReady: true });
    await waitFor(() => {
      const args = callSessionSpy.mock.calls.at(-1)!;
      expect(args[0]).toBe(CH);
      expect(Array.from(args[13] as Uint8Array)).toEqual(new Array(32).fill(1)); // run 2's MLS key
    });

    // Release run 1 late: its cancelled guard must keep run 1's blocked
    // decision from clobbering run 2's MLS decision.
    d1.resolve({ keyB64: b64(2), epoch: '9' });
    await settle();
    expect(view.result.current.callKeyMode).toBe('mls');
    const last = callSessionSpy.mock.calls.at(-1)!;
    expect(last[0]).toBe(CH);
    expect(Array.from(last[13] as Uint8Array)).toEqual(new Array(32).fill(1));
    const transport = last[2] as { join: (c: string, u: string) => Promise<unknown> };
    await transport.join(CH, 'self');
    // advertise true: run 2's committed refs, not run 1's.
    expect(joinDmCall).toHaveBeenCalledWith(CH, 'self', undefined, undefined, false, true);
    view.unmount();
  });

  it('a run parked at unmount releases without residue or crash', async () => {
    channelMls = true; mlsReady = true;
    const d = deferred<{ keyB64: string; epoch: string } | null>();
    deriveSpy.mockImplementationOnce(() => d.promise);
    const view = renderTimeline({ ch: CH, isInitiator: false, incomingMlsCallReady: true });
    await waitFor(() => expect(deriveSpy).toHaveBeenCalledTimes(1));
    const before = callSessionSpy.mock.calls.length;
    view.unmount();
    d.resolve({ keyB64: b64(1), epoch: '3' });
    await flush(); await flush();
    // No post-unmount render constructed a session for the channel, no crash.
    expect(callSessionSpy.mock.calls.slice(before).some((c) => c[0] === CH)).toBe(false);
  });
});
