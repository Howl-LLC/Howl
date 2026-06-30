// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useMemo, useState, useEffect, useRef } from 'react';
import type { User } from '../types';
import { socketService } from '../services/socket';
import { useCallSession, type CallParticipant, type CallAudioConstraints, type CallTransport } from './useCallSession';
import type { AudioProcessingConfig } from '../services/call/types';
import type { BtDevicePreference, BluetoothAudioSettings } from '../utils/settingsStorage';
import type { BtQualityStatus } from '../services/audio/btQualityDetector';
import { isChannelEncrypted, setChannelEncryptionStatus, isChannelMls } from '../services/encryptionFlags';
import { isUnlocked as isDmUnlocked } from '../services/dmKeyManager';
import { isReadyForChannel as isMlsReadyForChannel, deriveSframeBaseKey, onEpochChange } from '../services/mls/mlsCoordinator';
import { fromBase64 } from '../services/cryptoHelpers';
import { epochKeyIndex } from '../services/call/HowlSframeKeyProvider';
import { logger } from '../services/logger';
import { useDmStore } from '../stores/dmStore';

export type DMCallParticipant = CallParticipant;
export type DMCallAudioConstraints = CallAudioConstraints;
export type DMCallAudioProcessing = AudioProcessingConfig;

/** Visual state of the DM-call encryption shield.
 *  - `none`      — E2EE was never expected (legacy unencrypted DM, DMs locked);
 *                  no shield is shown, matching prior behavior.
 *  - `encrypting`— E2EE is expected and our own leg is (becoming) encrypted, but
 *                  at least one current peer has not yet confirmed E2EE on their
 *                  side. We deliberately do NOT claim full E2EE here.
 *  - `secure`    — every current remote peer has confirmed E2EE is established
 *                  on their leg AND our own leg is encrypted: bilateral E2EE.
 *  - `failed`    — E2EE was expected but our own leg failed to key, or a peer
 *                  reported that E2EE failed on theirs, or a mid-call MLS
 *                  degrade left us without an honest scheme.
 *  - `blocked`   - E2EE was expected but the channel yielded no MLS key; the
 *                  session is never started. */
export type DmCallShieldStatus = 'none' | 'encrypting' | 'secure' | 'failed' | 'blocked';

/**
 * Pure derivation of the DM-call encryption shield.
 *
 * Green must not over-claim: the shield turns green only once every
 * remote peer currently in the call has confirmed (via the `dm-call-e2ee-ack`
 * round-trip) that E2EE is established on their leg.
 *
 * Kept pure (no React, no sockets) so the trust-calibration logic is unit
 * testable in isolation.
 */
export function deriveDmCallShield(input: {
  /** Local key resolution has finished (success or honest fallback). */
  e2eeReady: boolean;
  /** E2EE was expected for this DM (channel encrypted + DMs unlocked). */
  e2eeExpected: boolean;
  /** Our own leg has an SFrame key installed. */
  localKeyed: boolean;
  /** Resolution yielded no key by either scheme; the session never
   *  starts. */
  blocked: boolean;
  /** A mid-call MLS degrade (rekey failed / downgrade without
   *  fallback). */
  degraded: boolean;
  /** userIds of remote participants currently in the call. */
  remotePeerIds: string[];
  /** Peers that confirmed E2EE established on their leg. */
  ackedPeerIds: Set<string>;
  /** Peers that reported E2EE failed on their leg. */
  failedPeerIds: Set<string>;
}): DmCallShieldStatus {
  const { e2eeReady, e2eeExpected, localKeyed, blocked, degraded, remotePeerIds, ackedPeerIds, failedPeerIds } = input;

  // E2EE was never on the table → no shield at all (unchanged behavior).
  if (!e2eeExpected) return 'none';

  // Neither scheme yielded a key; the call is blocked, honestly red.
  if (blocked) return 'blocked';

  // Still resolving our own key. Honest interim signal rather than a premature
  // green or a misleading amber-failed.
  if (!e2eeReady) return 'encrypting';

  // Our own leg never keyed despite E2EE being expected — this is the
  // pre-existing `isE2eeFailed` condition.
  if (!localKeyed) return 'failed';

  // A mid-call MLS degrade (rekey failed / downgrade without fallback).
  if (degraded) return 'failed';

  // Our leg is encrypted. A peer explicitly reporting failure is the strongest
  // signal — surface it even if other peers acked.
  if (remotePeerIds.some((id) => failedPeerIds.has(id))) return 'failed';

  // No peer is present yet (ringing / alone) — we cannot honestly claim
  // bilateral E2EE, so stay "encrypting" until a peer confirms.
  if (remotePeerIds.length === 0) return 'encrypting';

  // Green only once EVERY current remote peer has confirmed E2EE on their leg.
  const allPeersAcked = remotePeerIds.every((id) => ackedPeerIds.has(id));
  return allPeersAcked ? 'secure' : 'encrypting';
}

/** Bookkeeping for our standing E2EE ack: what we last reported, and to whom. */
export type StandingAckState = { ok: boolean; informed: Set<string> } | null;

/**
 * Decide whether to (re)emit our standing `dm-call-e2ee-ack` and compute the
 * next bookkeeping ref, given the previous ref, the peers currently present,
 * and whether our own leg is keyed. Pure so the rejoin / drain-to-zero
 * semantics are unit-testable without mounting the hook (mirrors
 * `deriveDmCallShield`).
 *
 * - No peers present → reset to null and don't emit, so a later rejoin counts
 *   as new and re-emits. Socket.IO room broadcasts only reach current members,
 *   so a rejoiner missed our earlier ack and must get a fresh one — otherwise
 *   their shield stays stuck on "encrypting".
 * - Otherwise prune "informed" down to present peers; emit when our own state
 *   changed or a not-yet-informed peer is present; stay silent on an unrelated
 *   roster mutation (mute/deafen updates also rewrite the participant list).
 */
export function computeStandingAck(
  prev: StandingAckState,
  remotePeerIds: string[],
  localKeyed: boolean,
): { nextRef: StandingAckState; emit: boolean } {
  if (remotePeerIds.length === 0) return { nextRef: null, emit: false };
  const stillInformed = prev
    ? new Set([...prev.informed].filter((id) => remotePeerIds.includes(id)))
    : new Set<string>();
  const stateChanged = !prev || prev.ok !== localKeyed;
  const newPeer = remotePeerIds.some((id) => !stillInformed.has(id));
  if (!stateChanged && !newPeer) {
    return { nextRef: { ok: localKeyed, informed: stillInformed }, emit: false };
  }
  return { nextRef: { ok: localKeyed, informed: new Set(remotePeerIds) }, emit: true };
}

/** Which keying scheme a DM call runs under.
 *  - mls: base key derived from the channel's MLS exporter (FS + PCS).
 *  - blocked: E2EE expected but no MLS key yields one; the session is never
 *    started and the shield goes red. Never silent transport-only.
 *  - none: E2EE was never expected (locked vault); transport-only
 *    behavior. */
export type DmCallKeyScheme = 'mls' | 'blocked' | 'none';

/** The initial key decision. MLS exporter key available -> mls; E2EE
 *  expected but no MLS key -> blocked (red shield, no media, the honest
 *  failure); E2EE not expected -> none. The recipient additionally ANDs the
 *  ringer's advertised readiness so it never keys a call the ringer cannot
 *  decrypt. Pure (no React, no sockets, no crypto). */
export function decideInitialCallKey(input: {
  e2eeExpected: boolean;
  isInitiator: boolean;
  /** Exporter-derived base key, or null when the channel is not MLS-ready. */
  mlsKey: Uint8Array | null;
  /** Ringer's advertised readiness from incoming-dm-call (recipient only). */
  incomingMlsCallReady: boolean | undefined;
}): { scheme: DmCallKeyScheme; keyBytes: Uint8Array | null } {
  const { e2eeExpected, isInitiator, mlsKey, incomingMlsCallReady } = input;
  if (!e2eeExpected) return { scheme: 'none', keyBytes: null };
  if (mlsKey && (isInitiator || incomingMlsCallReady === true)) return { scheme: 'mls', keyBytes: mlsKey };
  return { scheme: 'blocked', keyBytes: null };
}

export function useDMCall(
  dmChannelId: string | null,
  currentUser: User | null,
  isMuted?: boolean,
  cameraStream?: MediaStream | null,
  screenStream?: MediaStream | null,
  micDeviceId?: string,
  audioConstraints?: DMCallAudioConstraints,
  userPlan?: string | null,
  withVideo?: boolean,
  screenShareCodec: 'auto' | 'h264' | 'vp9' | 'av1' = 'auto',
  /** True when local user pressed Call (initiator), false when they
   *  Accepted an incoming-dm-call (recipient). Null when no call is being
   *  established. The recipient branch, absent an MLS key, blocks honestly
   *  rather than starting a call the caller could not key. */
  isInitiator?: boolean | null,
  screenShareFps?: number,
  screenShareBitrate?: number,
  micVolume?: number,
  audioProcessing?: DMCallAudioProcessing,
  btDevicePreferences?: BtDevicePreference[],
  bluetoothAudioSettings?: BluetoothAudioSettings,
  onBluetoothQualityChange?: (status: BtQualityStatus) => void,
  onMicTrackEnded?: () => void,
  onSpeakingWhileMuted?: () => void,
  onMicSilenceUpdate?: (silenceMs: number) => void,
  /** The ringer's advertised MLS-call readiness from incoming-dm-call,
   *  store-laundered via useVoiceStore (dmCallIncomingMlsReady). */
  incomingMlsCallReady?: boolean,
): {
  localStream: MediaStream | null;
  remoteParticipants: DMCallParticipant[];
  leave: () => void;
  error: string | null;
  disconnectedByInactivity: boolean;
  enableRemoteScreen: (userId: string) => void;
  disableRemoteScreen: (userId: string) => void;
  switchMicDevice: (deviceId: string) => Promise<void>;
  /** Whether this call is fully (bilaterally) E2EE: our leg is keyed AND every
   *  current remote peer has confirmed E2EE on their leg. Drives the green shield. */
  isE2ee: boolean;
  /** Whether E2EE was expected (channel encrypted + Secure DMs unlocked) but
   *  failed — either our own key never installed or a peer reported failure. */
  isE2eeFailed: boolean;
  /** E2EE is expected and our leg is (becoming) encrypted, but at least one
   *  current peer has not yet confirmed E2EE on their side. Drives the amber
   *  "establishing encryption" shield, distinct from an outright failure. */
  isE2eeEstablishing: boolean;
  /** E2EE expected but no MLS key yielded one; session never started.
   *  Red shield. */
  isE2eeBlocked: boolean;
  /** Which scheme keys the call ('mls' = exporter-derived, forward
   *  secret). Null when none/blocked. */
  callKeyMode: 'mls' | null;
  /** Epoch ms when the local user joined the call, or null pre-connect. */
  startedAt: number | null;
  getMicSilenceMs: () => number;
} {
  const [e2eeKeyBytes, setE2eeKeyBytes] = useState<Uint8Array | null>(null);
  // Render-coherent per-channel readiness. The session gate below must be
  // CLOSED during the very render where dmChannelId flips (useCallSession's
  // construct effect captures the channelId in that same commit, and the
  // engine can never gain E2EE after construct), so readiness is keyed to
  // the channel it was resolved for instead of a boolean latch that
  // survives channel changes.
  const [e2eeResolvedFor, setE2eeResolvedFor] = useState<string | null>(null);
  const [callScheme, setCallScheme] = useState<DmCallKeyScheme>('none');
  // The rekey/EncryptionError degrade flag feeds the shield as 'failed'.
  // Driven only by the rekey-on-Commit effect and the
  // e2eeErrorCount effect. Sticky only until the next SUCCESSFUL install:
  // a healed rekey clears it, so the shield is honest again.
  const [mlsDegraded, setMlsDegraded] = useState(false);
  /** Exporter-derived key + epoch held for the active call (zeroized on end). */
  const mlsKeyRef = useRef<Uint8Array | null>(null);
  const mlsEpochRef = useRef<bigint>(0n);
  /** Advertised on join-dm-call; ref so the transport memo never re-creates. */
  const mlsAdvertiseRef = useRef(false);
  /** The scheme the hook currently WANTS the engine keyed under.
   *  Written SYNCHRONOUSLY at every decision point (resolution commit,
   *  null-channel reset, teardown); async continuations re-check it
   *  immediately before installing, so a stale continuation can never install
   *  against a newer decision. The branch disposed flags alone cannot close
   *  this: they only flip in the NEXT commit's cleanup, after the decision
   *  already changed. */
  const desiredSchemeRef = useRef<'mls' | null>(null);
  // Read inside the transport.join closure via ref so flipping withVideo
  // does not recreate the transport object — that cascades into
  // useCallSession's effect deps and tears down the LiveKit Room
  // (engine.leave() → room.disconnect() → reconnect with a new
  // participantID), which is the bug behind "user randomly dropped from
  // DM/group calls". Server voice/stage transports are stable for the
  // same reason.
  const withVideoRef = useRef(withVideo);
  withVideoRef.current = withVideo;

  // Subscribe to the dmStore's view of channel.encrypted. Historical note:
  // `dm-encryption-upgraded` has had no backend emitter since 2026-04; this
  // dep exists for the cold-store flip (bootstrap / orphan-heal populating
  // dmChannels after the hook mounted with an empty store). Post-resolution
  // flips are inert by design: the resolution effect freezes once it has
  // committed for the live channel (one-shot). Reading through a
  // primitive selector avoids the new-reference rerender that
  // `s.dmChannels.find(...)` would trigger on every dmStore mutation.
  const dmStoreSaysEncrypted = useDmStore(s =>
    dmChannelId ? (s.dmChannels.find(c => c.id === dmChannelId)?.encrypted ?? false) : false,
  );

  // Resolve the E2EE key: derive from the MLS exporter when the channel is
  // ready; otherwise the pure decider blocks the call.
  useEffect(() => {
    if (!dmChannelId) {
      setE2eeKeyBytes(null);
      setE2eeResolvedFor(null);
      setCallScheme('none');
      // Between-calls reset: the next call must never join with the previous
      // call's advertise flag or epoch slot.
      mlsAdvertiseRef.current = false;
      mlsEpochRef.current = 0n;
      desiredSchemeRef.current = null;
      return;
    }

    // Resolution is one-shot per call: once it has committed for the live
    // channel, mid-call dep flips (dmStore churn from Close DM, group
    // removal, bootstrap) must not replay the initial decision against a
    // running session. A replay on a transient derive failure would commit
    // 'blocked' and hard-drop the live call, and would falsely heal
    // mlsDegraded. Mid-call scheme changes are
    // owned exclusively by the roster AND and rekey effects, which never
    // re-mint key material. This also freezes a 'none'-admitted call as
    // honestly transport-only for its duration (main parity; the next call
    // resolves fresh because the null-channel branch resets the latch).
    if (e2eeResolvedFor === dmChannelId) return;

    // Authoritative + cache: dmStore.encrypted is server-derived (the truth);
    // isChannelEncrypted is a localStorage ratchet (downgrade-resistant offline
    // cache). Either one being true means E2EE is expected. Without combining
    // them, the cold-cache race fires: a fresh tab/device that reads the cache
    // before bootstrap populates it sees `false` and silently skips E2EE,
    // shipping a transport-only call to a recipient whose own cache (warm from
    // an earlier session) correctly expects the yellow-shield-or-better.
    const cacheSaysEncrypted = isChannelEncrypted(dmChannelId);
    const isEncrypted = cacheSaysEncrypted || dmStoreSaysEncrypted;

    // Write-through: when the dmStore is fresher than the cache, sync the
    // cache so subsequent module-level reads (e.g. from `services/socket/dms`
    // or any non-React caller) hit the fast path without round-tripping to
    // the React store. Idempotent — setChannelEncryptionStatus no-ops when
    // the desired value is already set.
    if (isEncrypted && !cacheSaysEncrypted) {
      setChannelEncryptionStatus(dmChannelId, true);
    }

    if (!isEncrypted || !isDmUnlocked()) {
      setE2eeKeyBytes(null);
      setCallScheme('none');
      setE2eeResolvedFor(dmChannelId);
      // A 'none' transport-only call must not advertise MLS or ship a stale
      // epoch slot from an earlier call on join.
      mlsAdvertiseRef.current = false;
      mlsEpochRef.current = 0n;
      return;
    }

    let cancelled = false;

    (async () => {
      // MLS is the only scheme. Derive when the channel is
      // ready; otherwise the decider blocks the call (red shield, no media).
      let mlsKey: Uint8Array | null = null;
      let derivedEpoch: bigint | null = null;
      if (isChannelMls(dmChannelId) && isMlsReadyForChannel(dmChannelId)) {
        try {
          const derived = await deriveSframeBaseKey(dmChannelId);
          if (derived) {
            mlsKey = fromBase64(derived.keyB64);
            derivedEpoch = BigInt(derived.epoch);
          }
        } catch (err) {
          // Worker raced a lock/deactivate: treat as not-ready (blocked).
          // Never crash a call on a derive failure.
          if (!cancelled) {
            logger.warn('[DM call] MLS derive failed at resolution; call will be blocked', {
              channelId: dmChannelId, error: (err as Error)?.message,
            });
          }
        }
      } else if (!cancelled) {
        logger.warn('[DM call] channel not MLS-ready at resolution; call will be blocked', {
          channelId: dmChannelId,
        });
      }

      // Cancellation discipline: NO ref or state write above this line.
      if (cancelled) return;
      const decision = decideInitialCallKey({
        e2eeExpected: true, // this branch runs only past the isEncrypted+unlocked gate
        isInitiator: isInitiator === true,
        mlsKey,
        incomingMlsCallReady,
      });
      mlsKeyRef.current = mlsKey;
      mlsEpochRef.current = derivedEpoch ?? 0n;
      mlsAdvertiseRef.current = mlsKey !== null;
      desiredSchemeRef.current = decision.scheme === 'mls' ? 'mls' : null;
      setCallScheme(decision.scheme);
      setMlsDegraded(false);
      setE2eeKeyBytes(decision.keyBytes);
      setE2eeResolvedFor(dmChannelId);
    })();

    return () => { cancelled = true; };
    // e2eeResolvedFor: read by the one-shot freeze above. No loop: the
    // commit triggers exactly one re-run, which freezes immediately.
  }, [dmChannelId, isInitiator, dmStoreSaysEncrypted, incomingMlsCallReady, e2eeResolvedFor]);

  const transport = useMemo<CallTransport | null>(() => {
    if (!dmChannelId) return null;
    return {
      join: (chId, username, avatar, banner) => new Promise<{ token?: string; url?: string }>((resolve, reject) => {
        socketService.whenConnected(() => {
          socketService.joinDmCall(chId, username, avatar, banner, withVideoRef.current, mlsAdvertiseRef.current)
            .then(resolve)
            .catch(reject);
        });
      }),
      leave: (chId) => socketService.leaveDmCall(chId),
      onParticipants: (cb) => socketService.onDmCallParticipants(cb),
      onUserJoined: (cb) => socketService.onDmCallUserJoined(cb),
      onUserLeft: (cb) => socketService.onDmCallUserLeft(cb),
      onJoinError: (cb) => socketService.onDmCallJoinError(cb as (p: { dmChannelId: string; message: string }) => void),
      onStateUpdate: (cb) => socketService.onDmCallStateUpdate(cb),
      onInactivityDisconnect: (cb) => socketService.onDmCallInactivityDisconnect((data) => cb({ dmChannelId: data.dmChannelId })),
      off: () => socketService.offDmCall(),
      offStateUpdate: () => socketService.offDmCallStateUpdate(),
      emitViewerSubscribe: (ownerId) => {
        if (!dmChannelId) return;
        void socketService.emitViewerSubscribe({
          context: { kind: 'dm', scopeId: dmChannelId },
          streamOwnerId: ownerId,
          streamType: 'screen',
        });
      },
      emitViewerUnsubscribe: (ownerId) => {
        if (!dmChannelId) return;
        void socketService.emitViewerUnsubscribe({
          context: { kind: 'dm', scopeId: dmChannelId },
          streamOwnerId: ownerId,
          streamType: 'screen',
        });
      },
    };
  }, [dmChannelId]);

  // Derive E2EE expectation after key resolution. Use the same dual-source
  // expectation that the resolution effect uses, so the shield logic stays
  // consistent with the actual E2EE attempt path. Without the dmStore
  // fallback, a fresh-tab cold-cache state would suppress the shield even
  // after the resolution effect (which DOES see the dmStore value) marked
  // E2EE as expected and failed — so the user would see nothing instead of
  // a yellow shield.
  const channelIsEncrypted = dmChannelId
    ? (isChannelEncrypted(dmChannelId) || dmStoreSaysEncrypted)
    : false;
  const dmsUnlocked = isDmUnlocked();
  // Render-coherent readiness: true only once the resolution effect finished
  // for THIS channel, so the session gate stays closed during the render
  // where dmChannelId flips. Idle (dmChannelId null) now reads as not-ready
  // instead of the old latched true; every consumer is safe with that: the
  // gate passes null anyway, e2eeExpected is false so the shield resolves to
  // 'none' before consulting readiness, and the standing-ack effect
  // early-returns on a null channel.
  const e2eeReady = dmChannelId !== null && e2eeResolvedFor === dmChannelId;
  const localKeyed = e2eeReady && !!e2eeKeyBytes;
  // A mid-call vault lock flips dmsUnlocked false at render time,
  // but the engine keeps encrypting under the installed key, so a still-keyed
  // call must keep its shield instead of vanishing to 'none'. Locked at call
  // START still yields 'none' because nothing is keyed yet.
  const e2eeExpected = channelIsEncrypted && (dmsUnlocked || localKeyed);

  const session = useCallSession(
    // Don't start the session until the E2EE key is resolved, and never
    // start it when the resolution blocked the call (no silent
    // transport-only sessions when E2EE was expected).
    e2eeReady && callScheme !== 'blocked' ? dmChannelId : null,
    currentUser,
    transport,
    isMuted,
    cameraStream,
    screenStream,
    micDeviceId,
    audioConstraints,
    '[DM call]',
    undefined,
    userPlan,
    'dm-call',
    screenShareCodec,
    e2eeKeyBytes,
    screenShareFps,
    screenShareBitrate,
    undefined, // speakerDeviceId — handled by DMCallView's applyVolume
    undefined, // speakerVolume — handled by DMCallView's applyVolume
    micVolume,
    undefined, // e2eeEnabled: DM calls key via the MLS exporter (callScheme)
    undefined, // screenShareResolution
    audioProcessing,
    btDevicePreferences,
    bluetoothAudioSettings,
    onBluetoothQualityChange,
    onMicTrackEnded,
    onSpeakingWhileMuted,
    onMicSilenceUpdate,
    // MLS calls install the exporter key at the epoch's keyring slot so
    // prior-epoch keys survive a Commit.
    callScheme === 'mls' ? epochKeyIndex(mlsEpochRef.current) : undefined,
  );

  // Bilateral E2EE confirmation
  // Each side announces (via `dm-call-e2ee-ack`) whether E2EE is established on
  // its own SFrame leg. We only show the green shield once EVERY current remote
  // peer has confirmed — so the initiator can no longer over-claim full E2EE
  // purely because its own key installed before the peer keyed.
  const remotePeerIds = useMemo(
    () => session.remoteParticipants.map((p) => p.userId),
    [session.remoteParticipants],
  );
  const [ackedPeerIds, setAckedPeerIds] = useState<Set<string>>(() => new Set());
  const [failedPeerIds, setFailedPeerIds] = useState<Set<string>>(() => new Set());

  // Reset confirmation state when the call target changes.
  useEffect(() => {
    setAckedPeerIds(new Set());
    setFailedPeerIds(new Set());
  }, [dmChannelId]);

  // Drop confirmations for peers who have left, so a peer who leaves and later
  // rejoins (a fresh socket that has NOT re-keyed yet) must send a fresh ack
  // before we show green again — a stale ack must not over-claim on rejoin.
  useEffect(() => {
    const present = new Set(remotePeerIds);
    const prune = (prev: Set<string>) => {
      if ([...prev].every((id) => present.has(id))) return prev; // no change
      return new Set([...prev].filter((id) => present.has(id)));
    };
    setAckedPeerIds(prune);
    setFailedPeerIds(prune);
  }, [remotePeerIds]);

  // Listen for peers' E2EE acks. A peer that flips ok:true→false (e.g. its key
  // resolution finished as a failure) moves from acked to failed, and vice
  // versa, so the shield always reflects the latest report.
  useEffect(() => {
    if (!dmChannelId) return;
    socketService.onDmCallE2eeAck(({ userId: peerId, ok }) => {
      setAckedPeerIds((prev) => {
        const next = new Set(prev);
        if (ok) next.add(peerId); else next.delete(peerId);
        return next;
      });
      setFailedPeerIds((prev) => {
        const next = new Set(prev);
        if (ok) next.delete(peerId); else next.add(peerId);
        return next;
      });
    });
    return () => { socketService.offDmCallE2eeAck(); };
  }, [dmChannelId]);

  // Announce our own E2EE state to the room. Socket.IO room broadcasts only
  // reach sockets currently in the room, so we (re)emit whenever our own state
  // changes OR a peer we haven't yet informed appears — this delivers our
  // standing ack to peers who join after we keyed, without persisting any
  // per-call server state and without spamming an ack on every unrelated
  // roster mutation (mute/deafen updates also rewrite the participant list).
  const lastAckRef = useRef<StandingAckState>(null);
  useEffect(() => {
    if (!dmChannelId) { lastAckRef.current = null; return; }
    if (!e2eeReady) return;
    // Ack honesty: localKeyed alone stays true through every degrade, so
    // a degraded member would keep acking ok:true and PEER shields would
    // stay green. The standing ack reports keyed AND not degraded; the next
    // successful install re-acks ok:true through the same machinery.
    const ackOk = localKeyed && !mlsDegraded;
    const { nextRef, emit } = computeStandingAck(lastAckRef.current, remotePeerIds, ackOk);
    lastAckRef.current = nextRef;
    if (emit) {
      socketService.whenConnected(() => {
        // Report ok:true when our leg is keyed (and not degraded); ok:false
        // when E2EE was expected but our key never installed (honest
        // failure). When E2EE was never expected we still report ok:false so
        // a peer who DID key doesn't sit on a permanent "encrypting": its
        // shield correctly resolves to amber.
        socketService.sendDmCallE2eeAck(dmChannelId, ackOk);
      });
    }
  }, [dmChannelId, e2eeReady, localKeyed, mlsDegraded, remotePeerIds]);

  // Rekey-on-Commit. Subscribe only while an MLS call is live; the
  // one-shot reconcile on session-up covers a Commit that landed between
  // resolution and engine start (and reconnect catch-up: epoch events fire
  // from the data socket regardless of LiveKit room state).
  useEffect(() => {
    if (!dmChannelId || callScheme !== 'mls' || session.startedAt === null) return;
    let disposed = false;
    const rekey = async (epochStr: string) => {
      try {
        const derived = await deriveSframeBaseKey(dmChannelId);
        if (disposed) return;
        // `disposed` only flips in the NEXT commit's cleanup, so
        // teardown or a null-channel reset can null desiredSchemeRef while
        // this async rekey is still pending commit here. Re-check the desired
        // scheme before any ref write or install: a stale MLS install after
        // that reset would strand the engine on a key the hook no longer claims.
        if (desiredSchemeRef.current !== 'mls') return;
        if (!derived) {
          // Channel went not-ready mid-call (lock/reset/password change):
          // keep the old key; old-epoch frames still decrypt via the
          // keyring; surface degraded.
          setMlsDegraded(true);
          return;
        }
        const key = fromBase64(derived.keyB64);
        mlsKeyRef.current = key;
        mlsEpochRef.current = BigInt(derived.epoch);
        await session.setE2eeKeyAtEpoch(key, BigInt(derived.epoch));
        // A successful rekey heals an earlier degraded flag: the shield
        // turning green again is the honest state.
        if (!disposed) setMlsDegraded(false);
      } catch (err) {
        if (!disposed) {
          logger.error('[DM call] MLS rekey failed', { channelId: dmChannelId, epoch: epochStr, error: (err as Error)?.message });
          setMlsDegraded(true);
        }
      }
    };
    // One-shot reconcile at session start (idempotent when nothing changed:
    // same epoch -> same key -> same index).
    void rekey('reconcile');
    const unsub = onEpochChange((e) => {
      if (e.dmChannelId !== dmChannelId) return;
      void rekey(e.epoch);
    });
    return () => { disposed = true; unsub(); };
  }, [dmChannelId, callScheme, session.startedAt, session.setE2eeKeyAtEpoch]);

  // SFrame decrypt skew surfaces as RoomEvent.EncryptionError, counted
  // by useCallSession (DM calls only). Every mid-call Commit rekeys members
  // at slightly different moments, so a burst of decrypt failures means a
  // peer is (transiently or permanently) on a key we cannot read: flip the
  // shield to failed honestly. The next successful rekey heals it through the
  // existing degraded machinery. The initial 0 never triggers; only an
  // observed increase does.
  const lastE2eeErrorCountRef = useRef(0);
  useEffect(() => {
    const count = session.e2eeErrorCount;
    const prev = lastE2eeErrorCountRef.current;
    lastE2eeErrorCountRef.current = count;
    if (count > prev && callScheme === 'mls') {
      setMlsDegraded(true);
    }
  }, [session.e2eeErrorCount, callScheme]);

  // Teardown. Zeroize held base-key material when the call target
  // changes or the hook unmounts (parity with the worker's zeroize
  // discipline; the engine nulls its own copy in leave()).
  useEffect(() => {
    return () => {
      mlsKeyRef.current?.fill(0);
      mlsKeyRef.current = null;
      mlsEpochRef.current = 0n;
      mlsAdvertiseRef.current = false;
      // Stale async continuations re-check this before writing;
      // nulling it here makes completions that outlive the call inert.
      desiredSchemeRef.current = null;
    };
  }, [dmChannelId]);

  const shield = deriveDmCallShield({
    e2eeReady,
    e2eeExpected,
    localKeyed,
    blocked: callScheme === 'blocked',
    degraded: mlsDegraded,
    remotePeerIds,
    ackedPeerIds,
    failedPeerIds,
  });
  const isE2ee = shield === 'secure';
  const isE2eeFailed = shield === 'failed';
  const isE2eeEstablishing = shield === 'encrypting';
  const isE2eeBlocked = shield === 'blocked';
  const callKeyMode: 'mls' | null = callScheme === 'mls' ? 'mls' : null;

  return { ...session, isE2ee, isE2eeFailed, isE2eeEstablishing, isE2eeBlocked, callKeyMode };
}
