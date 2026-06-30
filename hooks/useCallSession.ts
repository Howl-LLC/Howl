// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect, useRef, useCallback } from 'react';
import type { User } from '../types';
import { createCallEngine, type CallParticipant, type ParticipantInfo, type CallEngine } from '../services/call';
import type { AudioProcessingConfig } from '../services/call/types';
import { apiClient } from '../services/api';
import { socketService } from '../services/socket';
import { getPlanPerks, type PlanTier } from '../shared/planPerks';
import { cacheLiveKitUrl } from '../services/livekitPreconnect';
import { probeStream, type BtQualityStatus } from '../services/audio/btQualityDetector';
import { resolvePreEmptiveMicOverride } from '../services/call/CallEngine';
import type { BtDevicePreference, BluetoothAudioSettings } from '../utils/settingsStorage';

export type { CallParticipant };

export interface CallAudioConstraints {
  noiseSuppression?: boolean;
  echoCancellation?: boolean;
  autoGainControl?: boolean;
  opusBitrate?: number;
  opusFec?: boolean;
  opusDtx?: boolean;
  opusPacketLoss?: number;
  opusSignal?: 'auto' | 'voice' | 'music';
  opusStereo?: boolean;
}

export interface CallTransport {
  /**
   * Join the room on the server side. Resolves after the backend has
   * committed its Redis membership write and optionally returns an inline
   * LiveKit access token + url from the socket ACK (Tier 1 latency
   * optimization — saves one HTTP round trip to /livekit/token). When
   * `token`/`url` are missing (older server, ACK timeout, or mint failure),
   * `useCallSession` transparently falls back to `POST /livekit/token`.
   */
  join: (channelId: string, username: string, avatar?: string, banner?: string) => Promise<{ token?: string; url?: string }>;
  leave: (channelId: string) => void;
  onParticipants: (cb: (chId: string, list: ParticipantInfo[], powerUpTier?: number) => void) => void;
  onUserJoined: (cb: (data: ParticipantInfo) => void) => void;
  onUserLeft: (cb: (data: { userId: string }) => void) => void;
  onJoinError: (cb: (payload: { channelId?: string; dmChannelId?: string; message: string }) => void) => void;
  onStateUpdate: (cb: (data: { userId: string; isMuted: boolean; isDeafened: boolean; serverMuted?: boolean; serverDeafened?: boolean }) => void) => void;
  onInactivityDisconnect?: (cb: (data: { channelId?: string; dmChannelId?: string }) => void) => void;
  off: () => void;
  offStateUpdate: () => void;
  /** For feature A/B: report that the local user has subscribed/unsubscribed
   *  to the screen track of `streamOwnerId` within this transport's context. */
  emitViewerSubscribe: (streamOwnerId: string) => void;
  emitViewerUnsubscribe: (streamOwnerId: string) => void;
}

async function fetchLivekitToken(roomName: string, participantName: string): Promise<{ token: string; url: string }> {
  // Route through apiClient.request so the X-Client-Build-Date /
  // X-Protocol-Version / X-Client-Capabilities headers are attached.
  // Required for /livekit/token (an enforcing route) once
  // ENFORCE_VERSION_GATE flips on — a raw fetch would be 426'd.
  // Also inherits apiClient's 401 auto-refresh and rate-limit tracking.
  const data = await apiClient.request<{ token: string; url: string }>('/livekit/token', {
    method: 'POST',
    body: JSON.stringify({ roomName, participantName }),
  });
  const fallbackUrl = (typeof import.meta !== 'undefined' && import.meta.env?.DEV) ? 'ws://localhost:7880' : '';
  const resolvedUrl = data.url || fallbackUrl;
  cacheLiveKitUrl(resolvedUrl);
  return { token: data.token, url: resolvedUrl };
}

export function useCallSession(
  channelId: string | null,
  currentUser: User | null,
  transport: CallTransport | null,
  isMuted?: boolean,
  cameraStream?: MediaStream | null,
  screenStream?: MediaStream | null,
  _micDeviceId?: string,
  _audioConstraints?: CallAudioConstraints,
  debugPrefix = '[Call]',
  _serverPowerUpTier?: number,
  userPlan?: string | null,
  roomPrefix = 'call',
  screenShareCodec: 'auto' | 'h264' | 'vp9' | 'av1' = 'auto',
  e2eeKeyBytes?: Uint8Array | null,
  screenShareFps?: number,
  screenShareBitrate?: number,
  _speakerDeviceId?: string,
  _speakerVolume?: number,
  _micVolume?: number,
  e2eeEnabled?: boolean,
  screenShareResolution?: '720p' | '1080p' | '1440p',
  _audioProcessing?: AudioProcessingConfig,
  _btDevicePreferences?: BtDevicePreference[],
  _bluetoothAudioSettings?: BluetoothAudioSettings,
  _onBluetoothQualityChange?: (status: BtQualityStatus) => void,
  onMicTrackEnded?: () => void,
  onSpeakingWhileMuted?: () => void,
  onMicSilenceUpdate?: (silenceMs: number) => void,
  /** Keyring index for the initial e2eeKeyBytes (MLS DM calls). */
  e2eeKeyIndex?: number,
): {
  localStream: MediaStream | null;
  remoteParticipants: CallParticipant[];
  leave: () => void;
  error: string | null;
  disconnectedByInactivity: boolean;
  enableRemoteScreen: (userId: string) => void;
  disableRemoteScreen: (userId: string) => void;
  setE2eeKey: (key: Uint8Array) => Promise<void>;
  setE2eeKeyAtEpoch: (key: Uint8Array, epoch: bigint) => Promise<void>;
  switchMicDevice: (deviceId: string) => Promise<void>;
  serverRegion: string | null;
  /** Epoch ms when the local user's media stream first became live, or null
   *  before connect / after leave. Used to drive the in-call duration timer. */
  startedAt: number | null;
  /** Returns current consecutive mic-silence duration in ms. 0 when audio is present. */
  getMicSilenceMs: () => number;
  /** Count of RoomEvent.EncryptionError events on this session. Only DM
   *  calls (roomPrefix 'dm-call') wire the engine's onE2eeError sink, so this
   *  stays 0 for voice/stages. Transient SFrame decrypt skew during a
   *  mid-call MLS Commit lands here instead of the fatal error path; the
   *  degraded-shield consumption is wired in a follow-up pass. */
  e2eeErrorCount: number;
} {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteParticipants, setRemoteParticipants] = useState<CallParticipant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [disconnectedByInactivity, setDisconnectedByInactivity] = useState(false);
  const [e2eeErrorCount, setE2eeErrorCount] = useState(0);
  const [serverRegion, setServerRegion] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const engineRef = useRef<CallEngine | null>(null);
  const userPlanRef = useRef(userPlan);
  userPlanRef.current = userPlan;
  // Ref-wrapped so callback identity churn in the parent doesn't force the
  // main effect to re-run and tear down the engine.
  const onMicTrackEndedRef = useRef(onMicTrackEnded);
  onMicTrackEndedRef.current = onMicTrackEnded;
  const onSpeakingWhileMutedRef = useRef(onSpeakingWhileMuted);
  onSpeakingWhileMutedRef.current = onSpeakingWhileMuted;
  const onMicSilenceUpdateRef = useRef(onMicSilenceUpdate);
  onMicSilenceUpdateRef.current = onMicSilenceUpdate;

  const leave = useCallback(() => {
    engineRef.current?.leave();
    engineRef.current = null;
    if (channelId && transport) transport.leave(channelId);
    setLocalStream(null);
    setRemoteParticipants([]);
    setStartedAt(null);
    transport?.off();
    transport?.offStateUpdate();
  }, [channelId, transport]);

  useEffect(() => {
    if (!channelId || !currentUser || !transport) {
      if (channelId && transport) transport.leave(channelId);
      setLocalStream(null);
      setRemoteParticipants([]);
      setStartedAt(null);
      transport?.off();
      return;
    }

    let cancelled = false;
    setError(null);
    setDisconnectedByInactivity(false);
    const chId = channelId;
    const roomName = `${roomPrefix}:${chId}`;

    // Re-register transport listeners on socket reconnect so events
    // are not lost during the brief reconnection window.
    // Hoisted outside the async IIFE so cleanup can access them synchronously.
    let reconnectHandler: (() => void) | null = null;
    const sock = socketService.getSocket();

    // Use a snapshot of the plan so engine isn't recreated when userPlan
    // changes (separate effects below update encoding settings live).
    const perks = getPlanPerks((userPlanRef.current as PlanTier) ?? null);

    // LiveKit token provided inline by the socket join ACK (Tier 1
    // latency optimization). Set after `transport.join()` resolves and
    // consumed once by the engine's initial `getToken` call. When absent
    // (older server, ACK timeout, mint failure) we transparently fall
    // back to POST /livekit/token — same behavior as before.
    let inlineToken: { token: string; url: string } | null = null;

    // Tier 3 latency optimization: kick off the microphone capture NOW,
    // in parallel with createCallEngine's lazy LiveKit import + the
    // socket.join ACK + room.connect. By the time the engine is ready to
    // publish, the mic track is already live, so we skip the 50–300ms
    // getUserMedia that setMicrophoneEnabled would otherwise run
    // serially after room.connect. If permission is denied / device is
    // missing, the promise rejects and CallEngine falls back to its
    // internal setMicrophoneEnabled path.
    const preCapturedMicTrackPromise: Promise<MediaStreamTrack | null> = (async () => {
      try {
        // Path A: pre-emptive label override. If the selected mic is BT-labeled
        // and a remembered 'split' preference exists, swap to a non-BT candidate
        // before getUserMedia so the BT device stays in A2DP (high-quality) mode.
        let effectiveMicDeviceId = _micDeviceId;
        if (_bluetoothAudioSettings?.autoOptimizeBluetoothAudio !== false) {
          try {
            const enumerated = await navigator.mediaDevices.enumerateDevices();
            const override = resolvePreEmptiveMicOverride({
              selectedDeviceId: _micDeviceId,
              devices: enumerated,
              btDevicePreferences: _btDevicePreferences ?? [],
              lastNonBtMicLabel: _bluetoothAudioSettings?.lastNonBtMicLabel ?? null,
            });
            if (override) effectiveMicDeviceId = override;
          } catch { /* best-effort */ }
        }

        // Default to mono capture — matches Discord's default and halves the
        // Opus bandwidth vs stereo. A single PC/headset mic is mono anyway;
        // capturing as stereo just duplicates the one channel into two and
        // wastes bitrate downstream. Opt into stereo only when the Studio
        // profile is active (vs.opusStereo=true), which is the case where
        // the user actually has a stereo source (interface + two mics, music
        // streaming, etc.).
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(effectiveMicDeviceId ? { deviceId: { exact: effectiveMicDeviceId } } : {}),
            echoCancellation: _audioConstraints?.echoCancellation ?? true,
            noiseSuppression: _audioConstraints?.noiseSuppression ?? true,
            autoGainControl: _audioConstraints?.autoGainControl ?? true,
            channelCount: _audioConstraints?.opusStereo ? 2 : 1,
          },
        });

        // Path B: fire-and-forget post-hoc probe. Gated on callback presence AND
        // the kill switch so engines with BT optimization disabled pay zero cost.
        if (_onBluetoothQualityChange && _bluetoothAudioSettings?.autoOptimizeBluetoothAudio !== false) {
          const capturedStream = stream;
          const capturedDeviceId = effectiveMicDeviceId;
          navigator.mediaDevices.enumerateDevices().then(devs => {
            const info = devs.find(d => d.kind === 'audioinput' && d.deviceId === capturedDeviceId) || null;
            const status = probeStream(capturedStream, info);
            if (status) _onBluetoothQualityChange(status);
          }).catch(() => { /* best-effort */ });
        }

        return stream.getAudioTracks()[0] ?? null;
      } catch {
        return null;
      }
    })();

    // Safety net: if the effect is cancelled before the engine consumes
    // the track, stop it so we don't leak a live mic handle.
    preCapturedMicTrackPromise.then((track) => {
      if (cancelled && track) {
        try { track.stop(); } catch { /* already stopped */ }
      }
    });

    (async () => {
    const engine = await createCallEngine({
      currentUserId: currentUser.id,
      preCapturedMicTrackPromise,
      getToken: async () => {
        if (inlineToken) {
          const cached = inlineToken;
          // Keep cached until the engine finishes its initial connect; if
          // LiveKit reconnects later it will refetch, which hits HTTP.
          inlineToken = null;
          return cached;
        }
        return fetchLivekitToken(roomName, currentUser.username);
      },
      onRemoteParticipants: (list) => { if (!cancelled) setRemoteParticipants(list); },
      onError: (msg) => { if (!cancelled) setError(msg); },
      debugPrefix,
      maxVideoBitrate: perks.maxCameraBitrate,
      maxCameraRes: perks.maxCameraRes,
      maxCameraFps: perks.maxCameraFps,
      maxScreenShareBitrate: perks.maxScreenShareBitrate,
      screenShareFps,
      screenShareBitrate: screenShareBitrate ? Math.min(screenShareBitrate, perks.maxScreenShareBitrate) : undefined,
      screenShareResolution,
      screenShareCodec,
      ...(e2eeKeyBytes ? { e2eeKeyBytes } : {}),
      e2eeEnabled,
      ...(e2eeKeyIndex !== undefined ? { e2eeKeyIndex } : {}),
      // Only DM calls get a dedicated E2EE-error sink (transient decrypt
      // skew on every mid-call MLS Commit must not end the call). Gated
      // exactly on the dm-call context so voice/stage engine configs stay
      // byte-identical and keep EncryptionError's fatal onError routing.
      ...(roomPrefix === 'dm-call' ? { onE2eeError: () => { if (!cancelled) setE2eeErrorCount((c) => c + 1); } } : {}),
      echoCancellation: _audioConstraints?.echoCancellation,
      noiseSuppression: _audioConstraints?.noiseSuppression,
      autoGainControl: _audioConstraints?.autoGainControl,
      initialAudioCodec: _audioConstraints ? {
        opusBitrate: _audioConstraints.opusBitrate !== undefined ? Math.min(_audioConstraints.opusBitrate, perks.maxVoiceBitrate) : undefined,
        opusFec: _audioConstraints.opusFec,
        opusDtx: _audioConstraints.opusDtx,
        opusPacketLoss: _audioConstraints.opusPacketLoss,
        opusSignal: _audioConstraints.opusSignal,
        opusStereo: _audioConstraints.opusStereo,
      } : undefined,
      initialAudioProcessing: _audioProcessing,
      initialMicVolume: _micVolume,
      btDevicePreferences: _btDevicePreferences,
      lastNonBtMicLabel: _bluetoothAudioSettings?.lastNonBtMicLabel ?? null,
      autoOptimizeBluetoothAudio: _bluetoothAudioSettings?.autoOptimizeBluetoothAudio ?? true,
      onBluetoothQualityChange: _onBluetoothQualityChange,
      onMicTrackEnded: () => { onMicTrackEndedRef.current?.(); },
      onSpeakingWhileMuted: () => { onSpeakingWhileMutedRef.current?.(); },
      onMicSilenceUpdate: (ms) => { onMicSilenceUpdateRef.current?.(ms); },
    });
    if (cancelled) { engine.leave(); return; }
    engineRef.current = engine;

    const resolve = (url?: string) => apiClient.resolveAssetUrl(url) ?? url;
    const onParticipants = (
      _chId: string,
      participants: ParticipantInfo[],
      powerUpTier?: number,
    ) => {
      if (_chId !== chId) return;
      if (powerUpTier !== undefined) engine.setPowerUpTier(powerUpTier);
      engine.handleParticipants(participants.map((p) => ({ ...p, avatar: resolve(p.avatar), banner: resolve(p.banner) })));
    };
    const onUserJoined = (data: ParticipantInfo) => {
      engine.handleUserJoined({ ...data, avatar: resolve(data.avatar), banner: resolve(data.banner) });
    };
    const onUserLeft = (data: { userId: string }) => engine.handleUserLeft(data);
    const onJoinError = (payload: { channelId?: string; dmChannelId?: string; message: string }) => {
      if (cancelled) return;
      const errorChId = payload.channelId ?? payload.dmChannelId;
      if (errorChId === chId) setError(payload.message);
    };
    const onVoiceStateUpdate = (data: { userId: string; isMuted: boolean; isDeafened: boolean; serverMuted?: boolean; serverDeafened?: boolean }) => {
      engine.updateParticipantVoiceState(data.userId, { isMuted: data.isMuted, isDeafened: data.isDeafened, serverMuted: data.serverMuted, serverDeafened: data.serverDeafened });
    };

    const registerTransportListeners = () => {
      transport.onJoinError(onJoinError);
      transport.onParticipants(onParticipants);
      transport.onUserJoined(onUserJoined);
      transport.onUserLeft(onUserLeft);
      transport.onStateUpdate(onVoiceStateUpdate);
      transport.onInactivityDisconnect?.(onInactivityDisconnect);
    };

    const onInactivityDisconnect = () => {
      if (cancelled) return;
      console.warn(`${debugPrefix} Disconnected due to inactivity (alone for too long)`);
      engine.leave();
      engineRef.current = null;
      setLocalStream(null);
      setRemoteParticipants([]);
      setStartedAt(null);
      setDisconnectedByInactivity(true);
      transport.off();
      transport.offStateUpdate();
    };

    registerTransportListeners();

    // Wire socket reconnect handler (assigned to outer variable for cleanup).
    // On reconnect we MUST also re-emit the join — the backend's disconnect
    // handler immediately removed us from the voice/call/stage Redis set +
    // socket.io room, so the new socket is not receiving any broadcasts
    // until we re-announce. Without this, a brief WiFi blip silently
    // degrades the call: LiveKit media may keep flowing on its own channel,
    // but voice-user-joined / voice-state-update / stage-speaker-added
    // etc. events will bypass us and the UI desynchronises.
    reconnectHandler = () => {
      if (cancelled) return;
      registerTransportListeners();
      try {
        const rejoinResult = transport.join(
          chId,
          currentUser.username,
          currentUser.avatar ?? undefined,
          (currentUser as { banner?: string }).banner ?? undefined,
        );
        Promise.resolve(rejoinResult).catch(() => {
          // Rejoin failures are non-fatal — next LiveKit event or token
          // refresh may still recover. Don't spam the user with errors.
        });
      } catch { /* best-effort rejoin */ }
    };
    sock?.on('connect', reconnectHandler);

    // Join the voice channel BEFORE starting the engine so that the backend
    // sends voice-participants (with full Pro/avatar/banner data) while
    // LiveKit is still connecting. By the time the room connects,
    // participantInfo is already populated.
    // Await the join so the LiveKit token request (inside engine.start) doesn't
    // race ahead of the backend committing participant membership — the token
    // endpoint rejects with "must join first" otherwise.
    const joinResult = transport.join(chId, currentUser.username, currentUser.avatar ?? undefined, (currentUser as { banner?: string }).banner ?? undefined);

    Promise.resolve(joinResult)
      .then((ackResult) => {
        if (cancelled) return null;
        // If the backend returned an inline token (Tier 1 path), stash it
        // so the engine's getToken call below consumes it instead of
        // hitting POST /livekit/token. Saves ~80-200ms of HTTP round trip.
        if (ackResult && ackResult.token && ackResult.url) {
          inlineToken = { token: ackResult.token, url: ackResult.url };
          // Seed the preconnect cache so future hovers on voice channels
          // in this server's region warm the TCP+TLS before click.
          cacheLiveKitUrl(ackResult.url);
        }
        return engine.start();
      })
      .then((stream) => {
        if (cancelled) {
          engine.leave();
          return;
        }
        setLocalStream(stream);
        // Mark the local join time for the in-call duration timer. Using the
        // moment our own stream goes live (rather than the remote user's
        // start time) means the timer reflects THIS participant's call
        // length, which is the intuitive meaning for late joiners.
        setStartedAt(Date.now());
        if (!cancelled) {
          // serverInfo may arrive slightly after connect — retry once after 2s if null
          const region = engine.getServerRegion();
          setServerRegion(region);
          if (!region) {
            setTimeout(() => { if (!cancelled) setServerRegion(engine.getServerRegion()); }, 2000);
          }
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err?.message ?? '';
        if (msg === 'Connection cancelled') return;
        setError(msg || 'Could not connect to voice server.');
      });
    })().catch((err) => {
      if (!cancelled) setError('Failed to initialize voice engine: ' + (err?.message ?? String(err)));
    });

    return () => {
      cancelled = true;
      engineRef.current?.leave();
      engineRef.current = null;
      transport.leave(chId);
      transport.off();
      transport.offStateUpdate();
      if (reconnectHandler) sock?.off('connect', reconnectHandler);
    };
  // userPlan intentionally excluded — separate effects update encoding live.
  // Recreating the engine on plan change destroys participantInfo and drops
  // socket listeners, causing avatar/banner/Pro data to disappear.
  }, [channelId, currentUser?.id, transport, screenShareCodec]);

  // Keep encoding values in sync BEFORE stream publish effects run.
  // Effects fire in definition order — encoding must be updated first so
  // updateCameraAndScreen publishes with the correct bitrate/fps.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || screenShareFps === undefined || screenShareBitrate === undefined) return;
    const perks = getPlanPerks((userPlan as PlanTier) ?? null);
    engine.updateScreenShareEncoding(screenShareFps, Math.min(screenShareBitrate, perks.maxScreenShareBitrate), screenShareResolution);
  }, [screenShareFps, screenShareBitrate, userPlan, screenShareResolution]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setCameraStream(cameraStream ?? null);
    engine.setScreenStream(screenStream ?? null);
    engine.updateCameraAndScreen(cameraStream ?? null, screenStream ?? null);
  }, [cameraStream, screenStream]);

  useEffect(() => {
    const engine = engineRef.current;
    if (isMuted !== undefined) {
      // Use LiveKit's API for reliable mute — track.enabled can be unreliable
      if (engine) {
        engine.setMuted(isMuted);
      }
      // Also set track.enabled as a fallback for the local audio level meter
      if (localStream) {
        localStream.getAudioTracks().forEach((t) => {
          t.enabled = !isMuted;
        });
      }
    }
  }, [localStream, isMuted]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !_audioConstraints) return;
    const perks = getPlanPerks((userPlan as PlanTier) ?? null);
    const timer = setTimeout(() => {
      engine.updateAudioCodec({
        opusBitrate: _audioConstraints.opusBitrate !== undefined ? Math.min(_audioConstraints.opusBitrate, perks.maxVoiceBitrate) : undefined,
        opusFec: _audioConstraints.opusFec,
        opusDtx: _audioConstraints.opusDtx,
        opusPacketLoss: _audioConstraints.opusPacketLoss,
        opusSignal: _audioConstraints.opusSignal,
        opusStereo: _audioConstraints.opusStereo,
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [_audioConstraints?.opusBitrate, _audioConstraints?.opusFec, _audioConstraints?.opusDtx, _audioConstraints?.opusPacketLoss, _audioConstraints?.opusSignal, _audioConstraints?.opusStereo, userPlan]);

  // Switch mic device when setting changes
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !_micDeviceId) return;
    engine.switchMicDevice(_micDeviceId);
  }, [_micDeviceId]);

  // Switch speaker device when setting changes
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !_speakerDeviceId) return;
    engine.switchSpeakerDevice(_speakerDeviceId);
  }, [_speakerDeviceId]);

  // Adjust remote audio volume
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || _speakerVolume === undefined) return;
    engine.setRemoteAudioVolume(_speakerVolume / 100);
  }, [_speakerVolume]);

  // Adjust mic volume (GainNode on published track)
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || _micVolume === undefined) return;
    engine.setMicVolume(_micVolume);
  }, [_micVolume]);

  // Update media constraints (echo cancellation, noise suppression, AGC) live
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.updateMediaConstraints({
      echoCancellation: _audioConstraints?.echoCancellation ?? true,
      noiseSuppression: _audioConstraints?.noiseSuppression ?? true,
      autoGainControl: _audioConstraints?.autoGainControl ?? true,
    });
  }, [_audioConstraints?.echoCancellation, _audioConstraints?.noiseSuppression, _audioConstraints?.autoGainControl]);

  // Update engine-owned mic processing chain (NS level / gate / sensitivity)
  // live. These are pure node-parameter mutations — no track churn.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !_audioProcessing) return;
    engine.updateAudioProcessing(_audioProcessing);
  }, [_audioProcessing?.noiseSuppressionLevel, _audioProcessing?.autoInputSensitivity, _audioProcessing?.inputSensitivity, _audioProcessing?.noiseEngine]);

  const enableRemoteScreen = useCallback((streamOwnerId: string) => {
    engineRef.current?.enableRemoteScreen(streamOwnerId);
    transport?.emitViewerSubscribe(streamOwnerId);
  }, [transport]);
  const disableRemoteScreen = useCallback((streamOwnerId: string) => {
    engineRef.current?.disableRemoteScreen(streamOwnerId);
    transport?.emitViewerUnsubscribe(streamOwnerId);
  }, [transport]);
  const setE2eeKey = useCallback(async (key: Uint8Array) => {
    await engineRef.current?.setE2eeKey(key);
  }, []);
  const setE2eeKeyAtEpoch = useCallback(async (key: Uint8Array, epoch: bigint) => {
    await engineRef.current?.setE2eeKeyAtEpoch(key, epoch);
  }, []);
  const switchMicDevice = useCallback(async (deviceId: string) => {
    await engineRef.current?.switchMicDevice(deviceId);
  }, []);

  const getMicSilenceMs = useCallback(() => engineRef.current?.getMicSilenceMs() ?? 0, []);

  return { localStream, remoteParticipants, leave, error, disconnectedByInactivity, enableRemoteScreen, disableRemoteScreen, setE2eeKey, setE2eeKeyAtEpoch, switchMicDevice, serverRegion, startedAt, getMicSilenceMs, e2eeErrorCount };
}
