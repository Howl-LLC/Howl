// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { RemoteParticipant, RemoteTrackPublication, RemoteTrack, TrackPublication, Participant } from 'livekit-client';
import { makeHowlSframeKeyProvider, makeInstallQueue, epochKeyIndex, type HowlSframeKeyProvider } from './HowlSframeKeyProvider';
import type { CallParticipant, ParticipantInfo, AudioCodecConfig, AudioProcessingConfig, CallEngineConfig, CallEngine } from './types';
import type { NoiseEngine } from '../../utils/settingsStorage';
import {
  GATE_ATTACK, GATE_RELEASE,
  NS_FLOOR_UPDATE, NS_FLOOR_DECAY, NS_MIN_FLOOR, NS_OPEN_RATIO, NS_CLOSE_RATIO,
  INITIAL_NOISE_FLOOR,
  sensitivityPctToThreshold,
  buildMicProcessingChain,
  createDenoiserNode,
  destroyDenoiserNode,
} from '../audio/micProcessingChain';
import { probeStream, matchesBluetoothLabel } from '../audio/btQualityDetector';
import { findPreferenceByLabel } from '../audio/btQualityPreferences';
import type { BtDevicePreference } from '../../utils/settingsStorage';
import { getVideoQuality, compensateForAspectRatio, resolveScreenShareCodec, getCachedBestCodec } from '../../utils/videoConstraints';

// Lazy-load livekit-client to keep it out of the initial bundle
type LivekitModule = typeof import('livekit-client');
let _livekitPromise: Promise<LivekitModule> | null = null;
function getLivekit(): Promise<LivekitModule> {
  if (!_livekitPromise) _livekitPromise = import('livekit-client');
  return _livekitPromise;
}

/**
 * Given the currently-selected deviceId and the full enumeration, if the
 * selected device is BT-labeled AND a remembered 'split' preference exists
 * for it, return the deviceId of the best non-BT candidate. Otherwise return
 * null (meaning: proceed with the original selection).
 */
export function resolvePreEmptiveMicOverride(args: {
  selectedDeviceId: string | undefined;
  devices: MediaDeviceInfo[];
  btDevicePreferences: BtDevicePreference[];
  lastNonBtMicLabel: string | null;
}): string | null {
  const { selectedDeviceId, devices, btDevicePreferences, lastNonBtMicLabel } = args;
  if (!selectedDeviceId) return null;
  const selected = devices.find(d => d.kind === 'audioinput' && d.deviceId === selectedDeviceId);
  if (!selected) return null;
  if (!matchesBluetoothLabel(selected.label)) return null;
  const pref = findPreferenceByLabel(btDevicePreferences, selected.label);
  if (!pref || pref.choice !== 'split') return null;
  const nonBt = devices.filter(d => d.kind === 'audioinput' && !matchesBluetoothLabel(d.label));
  if (nonBt.length === 0) return null;
  const byLastUsed = lastNonBtMicLabel ? nonBt.find(d => d.label === lastNonBtMicLabel) : undefined;
  if (byLastUsed) return byLastUsed.deviceId;
  const byDefault = nonBt.find(d => d.deviceId === 'default');
  if (byDefault) return byDefault.deviceId;
  return nonBt[0].deviceId;
}

export async function createCallEngine(config: CallEngineConfig): Promise<CallEngine> {
  const lk = await getLivekit();
  const { Room, RoomEvent, Track, DisconnectReason } = lk;
  const {
    currentUserId,
    livekitUrl,
    getToken,
    onRemoteParticipants,
    onError: _onError,
    onE2eeError,
    debugPrefix = '[Call]',
    maxVideoBitrate = 2_500_000,
    maxCameraRes = '720p' as const,
    maxCameraFps = 30 as 30 | 60,
    maxScreenShareBitrate = 2_000_000,
    screenShareFps: initialScreenShareFps,
    screenShareBitrate: initialScreenShareBitrate,
    screenShareResolution: initialScreenShareResolution,
    screenShareCodec = 'auto',
    e2eeKeyBytes,
    e2eeEnabled,
    e2eeKeyIndex,
    initialAudioCodec,
    onBluetoothQualityChange,
    preCapturedMicTrackPromise,
    btDevicePreferences,
    lastNonBtMicLabel,
    autoOptimizeBluetoothAudio,
    onMicTrackEnded: _onMicTrackEnded,
    onSpeakingWhileMuted: _onSpeakingWhileMuted,
    onMicSilenceUpdate: _onMicSilenceUpdate,
  } = config;

  // Mutable screen share encoding — updated by updateScreenShareEncoding()
  let currentScreenShareFps = initialScreenShareFps ?? 30;
  let currentScreenShareBitrate = initialScreenShareBitrate ?? maxScreenShareBitrate;
  let currentScreenShareResolution: '720p' | '1080p' | '1440p' = initialScreenShareResolution ?? '1080p';

  // Apply ultrawide / multi-monitor compensation: read the screen track's actual
  // dimensions and scale bitrate up (capped to 1.6×) when the source has many more
  // pixels than the chosen resolution tier expects (e.g. 21:9 or 32:9 displays).
  function effectiveScreenBitrate(track: MediaStreamTrack | null | undefined): number {
    if (!track) return currentScreenShareBitrate;
    const s = track.getSettings();
    return compensateForAspectRatio(
      currentScreenShareBitrate,
      s.width ?? 1920,
      s.height ?? 1080,
      currentScreenShareResolution,
    );
  }

  // Track which peer-count tier the camera was last published at.
  // When the tier changes (e.g., 2→4 peers, 4→8 peers), we republish camera
  // with adjusted bitrate to reduce publisher upload bandwidth.
  let lastCameraPeerTier = -1;

  function getPeerTier(peerCount: number): number {
    if (peerCount <= 2) return 0;
    if (peerCount <= 4) return 1;
    if (peerCount <= 8) return 2;
    return 3;
  }

  const isProd = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const log = isProd
    ? (_msg: string, _data?: object) => {}
    : (msg: string, data?: object) => {
        console.log(`%c${debugPrefix}%c ${msg}`, 'color:#0ea5e9;font-weight:bold', 'color:inherit', data ?? '');
      };

  let room: InstanceType<typeof Room> | null = null;
  // Latched true the moment `r.connect()` resolves successfully. Used by the
  // RoomEvent.Disconnected handler below to distinguish "we never connected
  // → let the .connect() rejection path own the error" from "we were live
  // and then dropped → user needs to know".
  let hasFullyConnected = false;
  let localStream: MediaStream | null = null;
  let keyProvider: HowlSframeKeyProvider | null = null;
  let currentE2eeKey: Uint8Array | null = e2eeKeyBytes ?? null;
  let currentE2eeKeyIndex: number | null = e2eeKeyIndex ?? null;
  let e2eeWorker: Worker | undefined;
  // Serialize key installs. Two in-flight installs (legacy downgrade vs
  // MLS rekey, or either racing the reconnect re-inject) could otherwise
  // resolve their HKDF imports out of call order, leaving the worker's
  // active encrypt slot behind the recorded (key, index) pair. The queue
  // guarantees the last caller also installs last (contract pinned by the
  // makeInstallQueue tests in howlSframeKeyProvider.test.ts).
  const installQueue = makeInstallQueue();
  // Sticky marker that this engine has done
  // an epoch-indexed install (constructed with e2eeKeyIndex, or rekeyed via
  // setE2eeKeyAtEpoch). LiveKit's base setKey path emits its SetKey event
  // without an explicit index, so the e2ee worker writes ring slot 0 but
  // never moves its currentKeyIndex; an indexed install DOES move it. A
  // downgrade routed through the base path after an epoch-indexed install
  // would therefore keep encrypting at the stale MLS slot with the old key.
  // setE2eeKey consults this flag to claim slot 0 explicitly instead.
  let hadIndexedInstall = currentE2eeKeyIndex !== null;
  // livekit-client never turns SFrame on by itself —
  // Room.setupE2EE() only constructs the E2EEManager, and every FrameCryptor
  // short-circuits to plaintext passthrough until room.setE2EEEnabled(true)
  // flips the local encryptionType to GCM and posts enable{true}. Enabling
  // with an empty keyring makes the encoder drop frames (silent call), so
  // the first successful key install is the earliest safe moment; each
  // install site calls this helper. Once per room — setE2EEEnabled
  // republishes local tracks as GCM, so a late first key (voice late-joiner,
  // MLS async resolution) still converts an already-published mic.
  let e2eeEnabledOnRoom = false;
  async function ensureRoomE2eeEnabled(): Promise<void> {
    if (room && keyProvider && currentE2eeKey && !e2eeEnabledOnRoom) {
      await room.setE2EEEnabled(true);
      e2eeEnabledOnRoom = true;
      log('SFrame E2EE enabled on LiveKit room');
    }
  }

  // Engine-owned mic processing chain. The published LocalAudioTrack is the
  // *destination* of this graph, so swapping the raw input source (device or
  // browser-constraint changes) and tweaking node parameters (NS level, gate,
  // gain) never disturb the LiveKit sender — no unpublish/republish, no SFrame
  // re-key, no remote-side track flicker, no getUserMedia re-prompt.
  type MicProcessing = {
    ctx: AudioContext;
    rawStream: MediaStream;            // owned; tracks are stopped on swap/teardown
    sourceNode: MediaStreamAudioSourceNode;
    hpf: BiquadFilterNode;
    compressor: DynamicsCompressorNode;
    analyser: AnalyserNode;
    gainNode: GainNode;
    limiter: DynamicsCompressorNode;
    denoiser?: AudioWorkletNode | null;
    denoiserEngine?: NoiseEngine;
    destination: MediaStreamAudioDestinationNode;
    applyNodeParams: (noiseSuppressionLevel: string) => void;
    rafId: number;
    /** Bound `visibilitychange` handler — kept on the struct so the matching
     *  removeEventListener in teardown gets the same reference. */
    onVisibilityChange: () => void;
  };
  let micProcessing: MicProcessing | null = null;
  let currentMicDeviceId: string | undefined = undefined;
  // Mutable mic-chain settings; the RAF gate loop reads this object every
  // frame so updates are picked up without rebuilding the graph.
  const processingSettings: {
    noiseSuppressionLevel: string;
    autoInputSensitivity: boolean;
    inputSensitivity: number;
    noiseEngine: NoiseEngine;
    micVolume: number;
  } = {
    noiseSuppressionLevel: config.initialAudioProcessing?.noiseSuppressionLevel ?? 'medium',
    autoInputSensitivity: config.initialAudioProcessing?.autoInputSensitivity ?? true,
    inputSensitivity: config.initialAudioProcessing?.inputSensitivity ?? 50,
    noiseEngine: config.initialAudioProcessing?.noiseEngine ?? 'off',
    micVolume: config.initialMicVolume ?? 100,
  };
  // Serializes concurrent denoiser swaps so rapid dropdown toggling doesn't race.
  let swapDenoiserChain: Promise<void> = Promise.resolve();

  // Speaking-while-muted detection state. The poll() RAF loop watches the
  // gate's `target` (1.0 when speaking, 0.0 when not) and fires the callback
  // after sustained activity (~500ms) — but only if the user is self-muted
  // and the throttle window has elapsed. Reset on gate-close so one speech
  // burst counts as one trigger, not many.
  let isUserMuted = false;
  let speakingMutedTicks = 0;
  let lastSpeakMutedFireMs = 0;
  const SPEAK_MUTED_TICK_THRESHOLD = 30; // ~500ms at 60fps
  const SPEAK_MUTED_THROTTLE_MS = 30_000;

  // Silence tracking: measures consecutive ms of mic silence for the UI
  // indicator. Purely informational — never triggers disconnect or error.
  const SILENCE_THRESHOLD_LINEAR = 0.000316; // -70 dBFS: Math.pow(10, -70/20)
  let silenceStartedAt: number | null = null;
  let lastSilenceUpdateMs = 0;
  let lastSilenceCallbackAt = 0;

  let mediaConstraints = {
    echoCancellation: config.echoCancellation ?? true,
    noiseSuppression: config.noiseSuppression ?? true,
    autoGainControl: config.autoGainControl ?? true,
  };

  // Re-probe BT quality on device change events so UI can react to BT reconnects.
  const onDeviceChangeHandler = async () => {
    if (!onBluetoothQualityChange) return;
    if (autoOptimizeBluetoothAudio === false) return;
    const micPub = room?.localParticipant?.getTrackPublication(Track.Source.Microphone);
    const mediaStreamTrack = micPub?.track?.mediaStreamTrack ?? null;
    if (!mediaStreamTrack) return;
    try {
      const stream = new MediaStream([mediaStreamTrack]);
      const devs = await navigator.mediaDevices.enumerateDevices();
      const info = devs.find(d => d.kind === 'audioinput' && d.deviceId === currentMicDeviceId) || null;
      const status = probeStream(stream, info);
      if (status) onBluetoothQualityChange(status);
    } catch { /* ignore */ }
  };

  // Current audio codec configuration — mutated by updateAudioCodec()
  let codecConfig: AudioCodecConfig = { ...initialAudioCodec };

  function applyProcessingNodeParams(): void {
    micProcessing?.applyNodeParams?.(processingSettings.noiseSuppressionLevel);
  }

  function buildMicProcessing(rawStream: MediaStream): MediaStream | null {
    if (rawStream.getAudioTracks().length === 0) return null;
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      // Pin to 48 kHz so DSP graph matches Opus + RNNoise native rate
      let ctx: AudioContext;
      try { ctx = new AudioCtx({ sampleRate: 48000 }); }
      catch { ctx = new AudioCtx(); }

      const nodes = buildMicProcessingChain(ctx, rawStream, processingSettings.noiseSuppressionLevel);
      if (!nodes) { ctx.close().catch(() => {}); return null; }

      const { sourceNode, hpf, compressor, analyser, gainNode, limiter, destination, applyNodeParams } = nodes;

      const dataArray = new Float32Array(analyser.fftSize);
      let gateLevel = 1.0;
      let noiseFloor = INITIAL_NOISE_FLOOR;
      let autoGateOpen = false;
      const poll = (): void => {
        if (!micProcessing) return;
        const targetVolume = processingSettings.micVolume / 100;
        // Background-tab fix:
        // (1) requestAnimationFrame is throttled to ~1 fps (or stops entirely)
        //     when the tab is hidden, so the VAD gate stops updating. If the
        //     gate had just closed when the user tabbed away, gainNode.gain
        //     was set to 0 and stays there — other participants hear silence
        //     even when the user is talking.
        // (2) Force the gate fully open while the tab is hidden so audio
        //     transmits unconditionally. Discord behaves the same way: tab
        //     away during a call → others continue to hear you.
        // The next visibility-change → visible call resumes the AudioContext
        // (via onVisibilityChange below); the next rAF after that re-runs the
        // VAD and the gate state recovers naturally.
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          gateLevel = 1.0;
          gainNode.gain.value = targetVolume;
          micProcessing.rafId = requestAnimationFrame(poll);
          return;
        }
        analyser.getFloatTimeDomainData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) sumSquares += dataArray[i] * dataArray[i];
        const rms = Math.sqrt(sumSquares / dataArray.length);

        // Silence tracker: accumulate consecutive silence duration using
        // wall-clock time so it survives tab-backgrounding rAF throttling.
        const nowPerf = performance.now();
        if (rms < SILENCE_THRESHOLD_LINEAR) {
          if (silenceStartedAt === null) silenceStartedAt = nowPerf;
          lastSilenceUpdateMs = nowPerf - silenceStartedAt;
        } else {
          silenceStartedAt = null;
          lastSilenceUpdateMs = 0;
        }
        // Fire the callback at ~1 Hz to avoid render thrash
        if (_onMicSilenceUpdate && nowPerf - lastSilenceCallbackAt >= 1000) {
          lastSilenceCallbackAt = nowPerf;
          _onMicSilenceUpdate(lastSilenceUpdateMs);
        }

        let target: number;
        if (processingSettings.autoInputSensitivity) {
          if (rms < noiseFloor * 1.5) {
            noiseFloor = noiseFloor * NS_FLOOR_UPDATE + rms * (1 - NS_FLOOR_UPDATE);
          } else {
            noiseFloor *= NS_FLOOR_DECAY;
          }
          if (noiseFloor < NS_MIN_FLOOR) noiseFloor = NS_MIN_FLOOR;
          const openT = noiseFloor * NS_OPEN_RATIO;
          const closeT = noiseFloor * NS_CLOSE_RATIO;
          if (autoGateOpen) { if (rms < closeT) autoGateOpen = false; }
          else { if (rms > openT) autoGateOpen = true; }
          target = autoGateOpen ? 1.0 : 0.0;
        } else {
          const threshold = sensitivityPctToThreshold(processingSettings.inputSensitivity);
          target = rms >= threshold ? 1.0 : 0.0;
        }
        // Speaking-while-muted detection. Piggybacks on the gate's existing
        // VAD (target=1 means the gate decided the user is speaking). Counts
        // sustained ticks while self-muted; fires once per throttle window
        // and resets at gate-close so a single burst is a single trigger.
        if (_onSpeakingWhileMuted && isUserMuted && target > 0) {
          speakingMutedTicks++;
          if (speakingMutedTicks >= SPEAK_MUTED_TICK_THRESHOLD) {
            const now = Date.now();
            if (now - lastSpeakMutedFireMs > SPEAK_MUTED_THROTTLE_MS) {
              lastSpeakMutedFireMs = now;
              try { _onSpeakingWhileMuted(); } catch { /* */ }
            }
            speakingMutedTicks = 0;
          }
        } else if (target === 0) {
          speakingMutedTicks = 0;
        }
        gateLevel += (target - gateLevel) * (target > gateLevel ? GATE_ATTACK : GATE_RELEASE);
        gainNode.gain.value = targetVolume * gateLevel;
        micProcessing.rafId = requestAnimationFrame(poll);
      };

      // Visibility handler: when tab returns, force-open the gate immediately
      // (so the user isn't held silent while the gate re-attacks from 0) and
      // resume the AudioContext in case the browser auto-suspended it. The
      // listener is removed in teardownMicProcessing.
      const onVisibilityChange = (): void => {
        if (!micProcessing) return;
        if (document.visibilityState === 'visible') {
          micProcessing.ctx.resume().catch(() => { /* already running */ });
          gateLevel = 1.0;
          gainNode.gain.value = processingSettings.micVolume / 100;
        } else {
          // Force-open the gate the moment we lose visibility, so we don't
          // strand at a half-closed gateLevel that the throttled rAF can't
          // recover from.
          gateLevel = 1.0;
          gainNode.gain.value = processingSettings.micVolume / 100;
        }
      };
      document.addEventListener('visibilitychange', onVisibilityChange);

      micProcessing = {
        ctx, rawStream, sourceNode, hpf, compressor, analyser, gainNode, limiter, destination,
        applyNodeParams,
        denoiser: null,
        denoiserEngine: processingSettings.noiseEngine,
        rafId: 0,
        onVisibilityChange,
      };
      micProcessing.rafId = requestAnimationFrame(poll);

      // Async-insert ML denoiser between compressor and analyser
      const engine = processingSettings.noiseEngine;
      if (engine !== 'off') {
        const mp = micProcessing;
        createDenoiserNode(ctx, engine).then((node) => {
          if (!node) return;
          if (!micProcessing || micProcessing !== mp) {
            try { destroyDenoiserNode(node, engine); } catch { /* */ }
            return;
          }
          try {
            mp.compressor.disconnect(mp.analyser);
            mp.compressor.connect(node);
            node.connect(mp.analyser);
            mp.denoiser = node;
            mp.denoiserEngine = engine;
            log('denoiser worklet attached', { engine });
          } catch (err) {
            log('denoiser insert failed', { engine, error: (err as Error)?.message });
            try { destroyDenoiserNode(node, engine); } catch { /* */ }
            try { mp.compressor.connect(mp.analyser); } catch { /* */ }
          }
        }).catch((err) => {
          log('denoiser load failed', { engine, error: (err as Error)?.message });
        });
      }

      return destination.stream;
    } catch (err) {
      log('failed to build mic processing chain', { error: (err as Error)?.message });
      return null;
    }
  }

  function teardownMicProcessing(): void {
    if (!micProcessing) return;
    cancelAnimationFrame(micProcessing.rafId);
    try { document.removeEventListener('visibilitychange', micProcessing.onVisibilityChange); } catch { /* */ }
    if (micProcessing.denoiser) {
      try { destroyDenoiserNode(micProcessing.denoiser, micProcessing.denoiserEngine ?? 'off'); } catch { /* */ }
    }
    try { micProcessing.sourceNode.disconnect(); } catch { /* already disconnected */ }
    try { micProcessing.hpf.disconnect(); } catch { /* */ }
    try { micProcessing.compressor.disconnect(); } catch { /* */ }
    try { micProcessing.analyser.disconnect(); } catch { /* */ }
    try { micProcessing.gainNode.disconnect(); } catch { /* */ }
    try { micProcessing.limiter?.disconnect(); } catch { /* */ }
    try { micProcessing.destination.disconnect(); } catch { /* */ }
    detachRawMicEndedListener();
    micProcessing.rawStream.getTracks().forEach((t) => { try { t.stop(); } catch { /* already stopped */ } });
    micProcessing.ctx.close().catch(() => {});
    micProcessing = null;
  }

  // Parallel-feed swap: connect new denoiser before disconnecting old so
  // the analyser never sees a silent frame.
  async function swapDenoiser(nextEngine: NoiseEngine): Promise<void> {
    if (!micProcessing) {
      processingSettings.noiseEngine = nextEngine;
      return;
    }
    const mp = micProcessing;
    const currentEngine: NoiseEngine = mp.denoiserEngine ?? 'off';
    if (currentEngine === nextEngine) return;

    // Load the new node first. Graph is untouched during this await.
    let nextNode: AudioWorkletNode | null = null;
    if (nextEngine !== 'off') {
      try {
        nextNode = await createDenoiserNode(mp.ctx, nextEngine);
      } catch {
        nextNode = null;
      }
      if (!nextNode) {
        log('denoiser load failed during live swap, staying on current engine', { nextEngine });
        return;
      }
    }

    // Stale-instance guard — user may have swapped devices / left mid-load.
    if (!micProcessing || micProcessing !== mp) {
      if (nextNode) {
        try { destroyDenoiserNode(nextNode, nextEngine); } catch { /* */ }
      }
      return;
    }

    const oldNode = mp.denoiser;

    // Connect the new path BEFORE disconnecting the old.
    try {
      if (nextNode) {
        mp.compressor.connect(nextNode);
        nextNode.connect(mp.analyser);
      } else {
        // Going to 'off' — route compressor straight to analyser alongside old.
        mp.compressor.connect(mp.analyser);
      }
    } catch (err) {
      log('denoiser live-swap: connect new path failed', { error: (err as Error)?.message });
      if (nextNode) {
        try { destroyDenoiserNode(nextNode, nextEngine); } catch { /* */ }
      }
      return;
    }

    // Detach the old path.
    if (oldNode) {
      try { mp.compressor.disconnect(oldNode); } catch { /* */ }
      try { oldNode.disconnect(mp.analyser); } catch { /* */ }
      try { destroyDenoiserNode(oldNode, currentEngine); } catch { /* */ }
    } else if (nextNode) {
      // Previously 'off' (compressor→analyser direct). Remove the direct edge
      // now that the new denoiser is in place.
      try { mp.compressor.disconnect(mp.analyser); } catch { /* */ }
    }

    mp.denoiser = nextNode;
    mp.denoiserEngine = nextEngine;
    processingSettings.noiseEngine = nextEngine;
    log('denoiser live-swapped', { from: currentEngine, to: nextEngine });
  }

  // Listener attached to the raw mic track so we can surface a UI toast when
  // the device disappears (USB unplug, OS revoked permission, BT range loss).
  // Kept as a single-slot cleanup so engine-initiated stops (device switch,
  // teardown, leave) detach BEFORE calling track.stop() — that way the same
  // 'ended' event the browser fires never reaches the user-facing callback.
  let rawMicListenerCleanup: (() => void) | null = null;

  function attachRawMicEndedListener(stream: MediaStream): void {
    if (!_onMicTrackEnded) return;
    const t = stream.getAudioTracks()[0];
    if (!t) return;
    const handler = (): void => {
      log('raw mic track ended unexpectedly');
      _onMicTrackEnded?.();
    };
    t.addEventListener('ended', handler);
    rawMicListenerCleanup = () => {
      try { t.removeEventListener('ended', handler); } catch { /* */ }
    };
  }

  function detachRawMicEndedListener(): void {
    if (rawMicListenerCleanup) {
      rawMicListenerCleanup();
      rawMicListenerCleanup = null;
    }
  }

  // Replace the upstream mic source feeding the chain. Used when the user
  // changes the mic device or toggles browser-level NS/AGC/EC. The sender's
  // RTCRtpSender keeps the same destination track, so peers see no churn.
  function swapRawSource(newRaw: MediaStream): void {
    if (!micProcessing) return;
    const oldRaw = micProcessing.rawStream;
    try { micProcessing.sourceNode.disconnect(); } catch { /* */ }
    const newSource = micProcessing.ctx.createMediaStreamSource(newRaw);
    newSource.connect(micProcessing.hpf);
    micProcessing.sourceNode = newSource;
    micProcessing.rawStream = newRaw;
    detachRawMicEndedListener();
    oldRaw.getTracks().forEach((t) => { try { t.stop(); } catch { /* */ } });
    attachRawMicEndedListener(newRaw);
  }

  function buildAudioPublishOptions(): { audioPreset?: { maxBitrate: number }; dtx?: boolean; red?: boolean; forceStereo?: boolean } {
    const opts: { audioPreset?: { maxBitrate: number }; dtx?: boolean; red?: boolean; forceStereo?: boolean } = {};
    if (codecConfig.opusBitrate !== undefined) {
      opts.audioPreset = { maxBitrate: codecConfig.opusBitrate * 1000 };
    }
    // DTX (Discontinuous Transmission) saves bandwidth during silence.
    // Default to true unless user explicitly configured it off.
    opts.dtx = codecConfig.opusDtx ?? true;
    // RED (Redundant Audio Data) provides packet loss resilience similar to Opus FEC.
    // Default to true for better audio quality on lossy connections.
    opts.red = codecConfig.opusFec ?? true;
    if (codecConfig.opusStereo !== undefined) opts.forceStereo = codecConfig.opusStereo;
    return opts;
  }

  const participantInfo = new Map<string, { username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nickname?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string; mlsCallReady?: boolean }>();
  const voiceState = new Map<string, { isMuted?: boolean; isDeafened?: boolean; serverMuted?: boolean; serverDeafened?: boolean }>();
  const enabledScreenUsers = new Set<string>();

  let pushTimer: ReturnType<typeof setTimeout> | null = null;

  // Stable stream references to avoid re-creating MediaStream objects on every push
  const audioStreams = new Map<string, MediaStream>();
  const cameraStreams = new Map<string, MediaStream>();
  const screenStreams = new Map<string, MediaStream>();
  const screenAudioStreams = new Map<string, MediaStream>();

  // Internal participant map — O(1) updates per event instead of O(N) rebuild
  const participantMap = new Map<string, CallParticipant>();

  // Max concurrent screen share subscriptions. Matches Discord's publisher
  // cap (50 per voice channel) — LiveKit's adaptiveStream + dynacast + per-
  // publisher simulcast already scale quality down per tile size, so the
  // engine cap is only a safety net, not the primary bandwidth gate.
  const MAX_SCREEN_SUBSCRIPTIONS = 50;
  // Track screen subscription order for LRU eviction
  const screenSubscriptionOrder: string[] = [];

  /** Build/update a single participant entry in the internal map. Returns the entry or null if no room participant. */
  function updateSingleParticipant(userId: string): CallParticipant | null {
    if (!room) return null;
    const participant = room.remoteParticipants.get(userId);
    if (!participant) {
      participantMap.delete(userId);
      audioStreams.delete(userId);
      cameraStreams.delete(userId);
      screenStreams.delete(userId);
      screenAudioStreams.delete(userId);
      return null;
    }

    const info = participantInfo.get(userId);
    const vs = voiceState.get(userId);

    let audioStream = audioStreams.get(userId) ?? null;
    const audioPublication = participant.getTrackPublication(Track.Source.Microphone);
    const audioTrack = audioPublication?.track?.mediaStreamTrack ?? null;
    if (audioTrack && audioTrack.readyState === 'live') {
      if (!audioStream || audioStream.getAudioTracks()[0] !== audioTrack) {
        audioStream = new MediaStream([audioTrack]);
        audioStreams.set(userId, audioStream);
      }
    } else {
      // Preserve existing audio stream during brief track renegotiation.
      // This prevents phantom one-way audio loss: when another participant
      // leaves, LiveKit renegotiates and the audio track may be briefly
      // null. If we delete the stream here, the UI removes the audio
      // element and when the track comes back, the remote user can hear
      // us but we cannot hear them (asymmetric disconnect).
      const existing = audioStreams.get(userId);
      if (existing) {
        const existingTrack = existing.getAudioTracks()[0];
        if (!audioPublication || (existingTrack && existingTrack.readyState === 'ended')) {
          audioStream = null;
          audioStreams.delete(userId);
        } else {
          // Keep the existing stream — track is mid-renegotiation
          audioStream = existing;
        }
      } else {
        audioStream = null;
      }
    }

    let camStream: MediaStream | null = null;
    const camPublication = participant.getTrackPublication(Track.Source.Camera);
    const camTrack = camPublication?.track?.mediaStreamTrack ?? null;
    if (camTrack && camTrack.readyState === 'live') {
      const existing = cameraStreams.get(userId);
      if (existing && existing.getVideoTracks()[0] === camTrack) {
        camStream = existing;
      } else {
        camStream = new MediaStream([camTrack]);
        cameraStreams.set(userId, camStream);
      }
    } else {
      // Preserve existing camera stream during brief track renegotiation
      // (e.g. when another participant leaves and LiveKit renegotiates).
      // The track may be temporarily null/ended but will come back via
      // TrackSubscribed. Only delete if the publication itself is gone
      // (camera was intentionally turned off) or the track is explicitly ended.
      const existing = cameraStreams.get(userId);
      if (existing) {
        const existingTrack = existing.getVideoTracks()[0];
        if (!camPublication || (existingTrack && existingTrack.readyState === 'ended')) {
          cameraStreams.delete(userId);
        } else {
          // Keep the existing stream — track is likely mid-renegotiation
          camStream = existing;
        }
      }
    }

    let scrStream: MediaStream | null = null;
    const scrPublication = participant.getTrackPublication(Track.Source.ScreenShare);
    const scrTrack = scrPublication?.track?.mediaStreamTrack ?? null;
    const hasScreenShare = !!scrPublication && !scrPublication.isMuted;
    const screenWatching = enabledScreenUsers.has(userId);
    if (scrTrack && scrTrack.readyState === 'live' && screenWatching) {
      const existing = screenStreams.get(userId);
      if (existing && existing.getVideoTracks()[0] === scrTrack) {
        scrStream = existing;
      } else {
        scrStream = new MediaStream([scrTrack]);
        screenStreams.set(userId, scrStream);
      }
    } else {
      // Preserve existing screen stream during brief track renegotiation
      const existing = screenStreams.get(userId);
      if (existing && screenWatching) {
        const existingTrack = existing.getVideoTracks()[0];
        if (!scrPublication || (existingTrack && existingTrack.readyState === 'ended')) {
          screenStreams.delete(userId);
        } else {
          scrStream = existing;
        }
      } else {
        screenStreams.delete(userId);
      }
    }

    // Screen share audio — separate LiveKit track, only expose when screen is being watched
    let scrAudioStream: MediaStream | null = null;
    const scrAudioPublication = participant.getTrackPublication(Track.Source.ScreenShareAudio);
    const scrAudioTrack = scrAudioPublication?.track?.mediaStreamTrack ?? null;
    if (scrAudioTrack && scrAudioTrack.readyState === 'live' && screenWatching) {
      const existing = screenAudioStreams.get(userId);
      if (existing && existing.getAudioTracks()[0] === scrAudioTrack) {
        scrAudioStream = existing;
      } else {
        scrAudioStream = new MediaStream([scrAudioTrack]);
        screenAudioStreams.set(userId, scrAudioStream);
      }
    } else {
      screenAudioStreams.delete(userId);
    }

    const entry: CallParticipant = {
      userId,
      username: info?.username ?? participant.name ?? 'Unknown',
      avatar: info?.avatar,
      banner: info?.banner,
      bannerPositionY: info?.bannerPositionY,
      bannerZoom: info?.bannerZoom,
      nickname: info?.nickname,
      nameColor: info?.nameColor,
      nameFont: info?.nameFont,
      nameEffect: info?.nameEffect,
      avatarEffect: info?.avatarEffect,
      effectivePlan: info?.effectivePlan,
      mlsCallReady: info?.mlsCallReady,
      roleColor: info?.roleColor,
      roleStyle: info?.roleStyle,
      stream: audioStream,
      cameraStream: camStream ?? undefined,
      screenStream: scrStream ?? undefined,
      screenShareAudioStream: scrAudioStream ?? undefined,
      screenShareAvailable: hasScreenShare,
      connectionState: participant.connectionQuality as unknown as string,
      isMuted: vs?.isMuted ?? participant.isMicrophoneEnabled === false,
      isDeafened: vs?.isDeafened,
      serverMuted: vs?.serverMuted,
      serverDeafened: vs?.serverDeafened,
    };
    participantMap.set(userId, entry);
    return entry;
  }

  /** Full rebuild of all participants — used only for initial connect and reconnect. */
  function rebuildAllParticipants(): void {
    if (!room) { participantMap.clear(); return; }
    const seenIds = new Set<string>();
    for (const [, participant] of room.remoteParticipants) {
      seenIds.add(participant.identity);
      updateSingleParticipant(participant.identity);
    }
    // Clean up stale entries
    for (const uid of participantMap.keys()) {
      if (!seenIds.has(uid)) {
        participantMap.delete(uid);
        audioStreams.delete(uid);
        cameraStreams.delete(uid);
        screenStreams.delete(uid);
      }
    }
  }

  /** Derive flat array from the participant map for consumers. */
  function getParticipantArray(): CallParticipant[] {
    return Array.from(participantMap.values());
  }

  /**
   * Schedule a debounced push to consumers.
   * @param delay — ms to wait (default 50 for track events, 16 for critical events)
   */
  function pushParticipants(delay = 50): void {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      onRemoteParticipants(getParticipantArray());
    }, delay);
  }

  /**
   * Push with minimal debounce (one frame) for critical events.
   * Never skips debounce entirely — prevents 10 simultaneous joins from
   * causing 10 immediate O(N) array builds.
   */
  function pushSoon(): void {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    pushTimer = setTimeout(() => {
      pushTimer = null;
      onRemoteParticipants(getParticipantArray());
    }, 16);
  }

  /**
   * Push synchronously — used for user-leave events so the UI drops the
   * departed participant immediately. Eliminates the brief "Connecting…"
   * flash that appears when stale entries are still in the consumer array
   * for the duration of a debounce window.
   */
  function pushImmediate(): void {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    onRemoteParticipants(getParticipantArray());
  }

  function wireRoomEvents(r: InstanceType<typeof Room>): void {
    r.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      log('participant connected', { identity: p.identity });
      updateSingleParticipant(p.identity);
      pushParticipants();
    });
    r.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      log('participant disconnected', { identity: p.identity });
      enabledScreenUsers.delete(p.identity);
      const idx = screenSubscriptionOrder.indexOf(p.identity);
      if (idx !== -1) screenSubscriptionOrder.splice(idx, 1);
      participantMap.delete(p.identity);
      audioStreams.delete(p.identity);
      cameraStreams.delete(p.identity);
      screenStreams.delete(p.identity);
      screenAudioStreams.delete(p.identity);
      // E2EE key rotation is handled by the explicit voice-e2ee-rotate protocol.
      // No ratchetKey() here — the new leader generates a fresh key and distributes it.
      pushImmediate();
    });
    r.on(RoomEvent.TrackSubscribed, (_track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      log('track subscribed', { identity: participant.identity, source: _pub.source });
      updateSingleParticipant(participant.identity);
      pushParticipants();
    });
    r.on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      log('track unsubscribed', { identity: participant.identity, source: _pub.source });
      updateSingleParticipant(participant.identity);
      pushParticipants();
    });
    r.on(RoomEvent.TrackMuted, (_pub: TrackPublication, participant: Participant) => {
      log('track muted', { identity: participant.identity, source: _pub.source });
      updateSingleParticipant(participant.identity);
      pushParticipants();
    });
    r.on(RoomEvent.TrackUnmuted, (_pub: TrackPublication, participant: Participant) => {
      log('track unmuted', { identity: participant.identity, source: _pub.source });
      updateSingleParticipant(participant.identity);
      pushParticipants();
    });
    r.on(RoomEvent.TrackPublished, (_pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      log('track published', { identity: participant.identity, source: _pub.source });
      updateSingleParticipant(participant.identity);
      pushParticipants();
    });
    r.on(RoomEvent.TrackUnpublished, (_pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      log('track unpublished', { identity: participant.identity, source: _pub.source });
      updateSingleParticipant(participant.identity);
      pushParticipants();
    });
    r.on(RoomEvent.Disconnected, (reason) => {
      // Always log (not isProd-gated) so disconnect symptoms are debuggable
      // from production console reports without rebuilds. Cheap — fires once
      // per session at most.
      console.warn(`${debugPrefix} room disconnected`, { reason, hasFullyConnected });

      // Root-cause fix for the "Voice disconnected. You may need to
      // rejoin." banner that appeared on every join/initiate
      //
      // The previous handler fired _onError unconditionally for every
      // DisconnectReason. That meant:
      //
      //   • JOIN_FAILURE — LiveKit fires Disconnected synchronously
      //     during a failed connect() before rejecting the promise. We
      //     showed the banner from this handler, then the .catch() at
      //     useCallSession.ts:397 set a more accurate message — but the
      //     first setError already triggered DMCallView's auto-cleanup
      //     (leave + 3s onEndCall timer). Symptom: every failed join
      //     looked like a disconnect even before the real error landed.
      //
      //   • CLIENT_INITIATED — user pressed "leave" intentionally. No
      //     banner needed; the call view tears down on its own.
      //
      //   • Disconnect during the initial connect handshake (before
      //     hasFullyConnected latched true) — same as JOIN_FAILURE; let
      //     the connect() rejection path own the error message.
      //
      // We only show the banner for an UNEXPECTED disconnect AFTER a
      // successful connection. Reasons like DUPLICATE_IDENTITY,
      // PARTICIPANT_REMOVED, ROOM_DELETED, SERVER_SHUTDOWN, SIGNAL_CLOSE,
      // and STATE_MISMATCH all qualify. UNKNOWN_REASON is included
      // because LiveKit reports it for genuine network drops.
      if (reason === DisconnectReason.CLIENT_INITIATED) return;
      if (reason === DisconnectReason.JOIN_FAILURE) return;
      if (!hasFullyConnected) return;

      // Reason-aware messages so users get something more actionable
      // than the generic "rejoin" text. All still surface through
      // _onError and end up in the same banner.
      let message = 'Voice disconnected. You may need to rejoin.';
      if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
        message = 'You joined this call from another window. Voice ended here.';
      } else if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
        message = 'You were removed from the call.';
      } else if (reason === DisconnectReason.ROOM_DELETED) {
        message = 'The call ended.';
      } else if (reason === DisconnectReason.SERVER_SHUTDOWN) {
        message = 'Voice server restarted. You may need to rejoin.';
      }
      _onError?.(message);
    });
    r.on(RoomEvent.Reconnecting, () => {
      log('reconnecting...');
      // Mark that we are mid-reconnect — streams may briefly go null.
      // Do NOT clear participants here; they will be rebuilt on Reconnected.
    });
    r.on(RoomEvent.Reconnected, () => {
      log('reconnected — resubscribing all tracks');
      // After reconnect, LiveKit may have swapped underlying tracks.
      // Clear stale stream references so they get recreated from fresh tracks.
      audioStreams.clear();
      cameraStreams.clear();
      screenStreams.clear();
      screenAudioStreams.clear();
      rebuildAllParticipants();
      pushSoon();
      // Re-inject E2EE key after reconnect — SFrame context may be lost
      if (keyProvider && currentE2eeKey) {
        // Defensive re-ensure after the re-inject lands: covers a first key
        // that arrived mid-disconnect. Already-enabled rooms are a no-op
        // (the flag holds), so no republish churn on ordinary reconnects.
        installQueue.enqueue(keyProvider, currentE2eeKey, currentE2eeKeyIndex)
          .then(() => ensureRoomE2eeEnabled())
          .catch(() => {});
        log('E2EE key re-injected after reconnect');
      }
    });
    // Track subscription failure — retry with exponential backoff.
    // This addresses phantom one-way disconnects where the audio track
    // fails to subscribe but the participant is still in the room.
    r.on(RoomEvent.TrackSubscriptionFailed, (trackSid: string, participant: RemoteParticipant, reason?: unknown) => {
      log('track subscription failed — will retry', { identity: participant.identity, trackSid, reason: String(reason ?? 'unknown') });
      let attempts = 0;
      const maxAttempts = 3;
      const retry = () => {
        if (attempts >= maxAttempts || !room) return;
        attempts++;
        const delay = Math.min(1000 * Math.pow(2, attempts - 1), 4000);
        setTimeout(() => {
          if (!room) return;
          // Find the publication by SID and resubscribe
          for (const pub of participant.trackPublications.values()) {
            if (pub.trackSid === trackSid && !pub.isSubscribed) {
              pub.setSubscribed(true);
              log('retrying track subscription', { identity: participant.identity, trackSid, attempt: attempts });
              break;
            }
          }
          // Rebuild participant entry to pick up any newly available tracks
          updateSingleParticipant(participant.identity);
          pushParticipants();
          // Schedule next retry if needed
          if (attempts < maxAttempts) retry();
        }, delay);
      };
      retry();
    });
    // Connection quality monitoring — when a participant's quality drops to
    // lost/poor and then recovers, rebuild their entry to reattach tracks.
    r.on(RoomEvent.ConnectionQualityChanged, (_quality: unknown, participant: Participant) => {
      if ('identity' in participant && participant.identity !== currentUserId) {
        updateSingleParticipant(participant.identity);
        pushParticipants();
      }
    });
    r.on(RoomEvent.EncryptionError, (error: Error) => {
      log('E2EE encryption error', { message: error?.message });
      // Transient SFrame decrypt skew is
      // expected on every mid-call MLS Commit while peers converge on the
      // new epoch key. Consumers that provide a dedicated sink (DM calls)
      // get the error routed there, NOT into the fatal _onError path that
      // call UIs treat as call-ending. Voice/stages pass no sink and keep
      // the existing fatal routing byte-identical.
      if (onE2eeError) {
        onE2eeError('E2EE encryption error: ' + (error?.message ?? 'unknown'));
        return;
      }
      _onError?.('E2EE encryption error: ' + (error?.message ?? 'unknown'));
    });
  }

  async function start(): Promise<MediaStream> {
    const roomOpts: ConstructorParameters<typeof Room>[0] = {
      adaptiveStream: true,
      dynacast: true,
    };

    if (e2eeKeyBytes || e2eeEnabled) {
      const { ExternalE2EEKeyProvider } = lk;
      const HowlProvider = makeHowlSframeKeyProvider(ExternalE2EEKeyProvider);
      keyProvider = new HowlProvider();
      e2eeWorker = new Worker(
        new URL('livekit-client/e2ee-worker', import.meta.url),
        { type: 'module' },
      );
      roomOpts.e2ee = {
        keyProvider,
        worker: e2eeWorker,
      };
    }

    const r = new Room(roomOpts);
    room = r;

    wireRoomEvents(r);

    // Subscribe to device changes for BT quality re-probing after room is set.
    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', onDeviceChangeHandler);
    }

    const tokenResult = await getToken();

    if (room !== r) {
      r.disconnect();
      throw new Error('Connection cancelled');
    }

    let jwt: string;
    let wsUrl: string;
    if (typeof tokenResult === 'string') {
      jwt = tokenResult;
      wsUrl = livekitUrl || 'ws://localhost:7880';
    } else {
      jwt = tokenResult.token;
      wsUrl = tokenResult.url;
    }
    await r.connect(wsUrl, jwt);

    if (room !== r) {
      r.disconnect();
      throw new Error('Connection cancelled');
    }
    // Latch — anything past this point is a "real" disconnect (server,
    // network, or kick), and the Disconnected handler should surface it.
    hasFullyConnected = true;

    // Flush any participantInfo stored while room was null.
    // handleParticipants may have been called (from the voice-participants
    // socket event) before room.connect() completed — its pushSoon() returned
    // [] because room was null. Now that remoteParticipants is populated,
    // rebuild so profile data (avatar, banner, Pro fields) appears immediately.
    rebuildAllParticipants();
    pushSoon();

    // Use currentE2eeKey (not the constructor param e2eeKeyBytes) so a key
    // delivered via setE2eeKey() while we were awaiting connect — e.g. a
    // voice late-joiner receiving the leader's key via the exchange, or a
    // stage host's post-mount generated key — isn't overwritten by the
    // stale initial-render seed. Without this, the room is silent for the
    // late joiner: peers encrypt with the shared key and this client
    // encrypts/decrypts with its own pre-exchange seed.
    if (keyProvider && currentE2eeKey) {
      await installQueue.enqueue(keyProvider, currentE2eeKey, currentE2eeKeyIndex);
      // Before the mic publish below, so the track publishes as GCM from the
      // first frame (no republish).
      await ensureRoomE2eeEnabled();
      log('E2EE key set on LiveKit room');
    }

    log('connected to LiveKit room', { roomName: r.name });

    // Acquire a raw mic stream first (Tier 3 pre-capture if available, else
    // getUserMedia here), then route it through the engine-owned processing
    // chain. The destination of that chain is what gets published — so any
    // future setting changes (NS level, gate, volume, mic device, browser
    // constraints) only mutate node parameters or swap the source feeding the
    // chain. The published track stays the same MediaStreamTrack throughout
    // the call: no unpublish/republish, no SFrame re-key, no remote flicker.
    let rawStream: MediaStream | null = null;
    if (preCapturedMicTrackPromise) {
      try {
        const preTrack = await preCapturedMicTrackPromise;
        if (preTrack && preTrack.readyState === 'live' && room === r) {
          rawStream = new MediaStream([preTrack]);
          const settings = preTrack.getSettings();
          if (settings.deviceId) currentMicDeviceId = settings.deviceId;
        }
      } catch (preErr) {
        log('pre-captured mic acquire failed — falling back to getUserMedia', { error: (preErr as Error)?.message });
      }
    }
    if (!rawStream) {
      // Path A: pre-emptive label override. If the selected mic is BT-labeled and
      // a 'split' preference exists, swap to a non-BT candidate so the BT device
      // stays in A2DP mode and the user sees no banner / no extra getUserMedia.
      if (autoOptimizeBluetoothAudio !== false) {
        try {
          const enumerated = await navigator.mediaDevices.enumerateDevices();
          const override = resolvePreEmptiveMicOverride({
            selectedDeviceId: currentMicDeviceId,
            devices: enumerated,
            btDevicePreferences: btDevicePreferences ?? [],
            lastNonBtMicLabel: lastNonBtMicLabel ?? null,
          });
          if (override) currentMicDeviceId = override;
        } catch { /* Path A is best-effort; fall through to normal getUserMedia */ }
      }

      try {
        rawStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(currentMicDeviceId ? { deviceId: { exact: currentMicDeviceId } } : {}),
            echoCancellation: mediaConstraints.echoCancellation,
            noiseSuppression: mediaConstraints.noiseSuppression,
            autoGainControl: mediaConstraints.autoGainControl,
            // Mono by default (Discord parity, halves Opus bandwidth). Stereo
            // only when the user's codec profile asks for it — capturing two
            // channels from a single mic just duplicates the mono signal.
            channelCount: codecConfig.opusStereo ? 2 : 1,
          },
        });
        const settings = rawStream.getAudioTracks()[0]?.getSettings();
        if (settings?.deviceId) currentMicDeviceId = settings.deviceId;
      } catch (micErr) {
        log('microphone failed — continuing without mic', { error: (micErr as Error)?.message });
      }
    }

    // Listen for the raw mic track to end unexpectedly (USB unplug, OS
    // permission revoke, BT out of range). Engine-initiated stops detach this
    // listener first, so only deterministic device-loss events surface.
    if (rawStream) attachRawMicEndedListener(rawStream);

    // Path B: post-hoc BT quality probe. Fire-and-forget to avoid adding
    // enumerateDevices() latency (10-50ms on Windows) to the mic publish
    // critical path. Gated on the callback being provided — engines without
    // a consumer pay zero cost.
    if (rawStream && onBluetoothQualityChange && autoOptimizeBluetoothAudio !== false) {
      const streamForProbe = rawStream;
      const deviceIdAtProbe = currentMicDeviceId;
      navigator.mediaDevices.enumerateDevices().then(devs => {
        const info = devs.find(d => d.kind === 'audioinput' && d.deviceId === deviceIdAtProbe) || null;
        const status = probeStream(streamForProbe, info);
        if (status) onBluetoothQualityChange(status);
      }).catch(() => { /* detection is best-effort */ });
    }

    if (rawStream && room === r) {
      const processedStream = buildMicProcessing(rawStream);
      if (processedStream) {
        const processedTrack = processedStream.getAudioTracks()[0];
        // userProvidedTrack=true: the engine owns the track lifecycle. Device
        // switches go through swapRawSource (which keeps the same destination
        // track), and leave/teardown stops everything explicitly. Without this
        // flag, LiveKit will run its own restartTrack() on track-ended events
        // (e.g., when the user unplugs their mic mid-call) — getUserMedia
        // fails, the publication errors out, and the resulting cascade tears
        // the room down. Letting the engine own the lifecycle keeps the room
        // up; the user just goes silent until they fix their mic.
        const localAudio = new lk.LocalAudioTrack(processedTrack, {
          echoCancellation: mediaConstraints.echoCancellation,
          noiseSuppression: mediaConstraints.noiseSuppression,
          autoGainControl: mediaConstraints.autoGainControl,
        }, true);
        try {
          await r.localParticipant.publishTrack(localAudio, { source: Track.Source.Microphone, ...buildAudioPublishOptions() });
        } catch (publishErr) {
          log('mic publish failed', { error: (publishErr as Error)?.message });
        }
        localStream = new MediaStream([processedTrack]);
      } else {
        // AudioContext unavailable — degrade gracefully by publishing the raw
        // track directly. Loses the custom NS/gate but at least the user can
        // still talk.
        const rawTrack = rawStream.getAudioTracks()[0];
        if (rawTrack) {
          // userProvidedTrack=true — same reasoning as the AudioContext path
          // above. The fallback raw track is also engine-owned; LK should not
          // try to auto-restart it on unexpected end.
          const localAudio = new lk.LocalAudioTrack(rawTrack, {
            echoCancellation: mediaConstraints.echoCancellation,
            noiseSuppression: mediaConstraints.noiseSuppression,
            autoGainControl: mediaConstraints.autoGainControl,
          }, true);
          try {
            await r.localParticipant.publishTrack(localAudio, { source: Track.Source.Microphone, ...buildAudioPublishOptions() });
          } catch (publishErr) {
            log('mic publish failed (raw fallback)', { error: (publishErr as Error)?.message });
          }
          localStream = new MediaStream([rawTrack]);
        } else {
          localStream = new MediaStream();
        }
      }
    } else {
      localStream = new MediaStream();
    }

    log('engine started', {
      maxVideoBitrate,
      maxCameraRes,
      maxScreenShareBitrate,
      screenShareFps: currentScreenShareFps,
      screenShareBitrate: currentScreenShareBitrate,
      e2ee: !!currentE2eeKey || !!e2eeEnabled,
    });

    return localStream;
  }

  function handleParticipants(
    participants: Array<ParticipantInfo>,
  ): void {
    for (const p of participants) {
      if (p.userId === currentUserId) continue;
      participantInfo.set(p.userId, { username: p.username, avatar: p.avatar, banner: p.banner, bannerPositionY: p.bannerPositionY, bannerZoom: p.bannerZoom, nickname: p.nickname, nameColor: p.nameColor, nameFont: p.nameFont, nameEffect: p.nameEffect, avatarEffect: p.avatarEffect, effectivePlan: p.effectivePlan, roleColor: p.roleColor, roleStyle: p.roleStyle, mlsCallReady: p.mlsCallReady });
      updateSingleParticipant(p.userId);
    }
    pushSoon();
  }

  async function handleUserJoined(
    data: ParticipantInfo,
  ): Promise<void> {
    if (data.userId === currentUserId) return;
    participantInfo.set(data.userId, { username: data.username, avatar: data.avatar, banner: data.banner, bannerPositionY: data.bannerPositionY, bannerZoom: data.bannerZoom, nickname: data.nickname, nameColor: data.nameColor, nameFont: data.nameFont, nameEffect: data.nameEffect, avatarEffect: data.avatarEffect, effectivePlan: data.effectivePlan, roleColor: data.roleColor, roleStyle: data.roleStyle, mlsCallReady: data.mlsCallReady });
    updateSingleParticipant(data.userId);
    pushParticipants();
    recalcCameraEncoding().catch(() => {}); // fire-and-forget
  }

  function handleUserLeft(data: { userId: string }): void {
    participantInfo.delete(data.userId);
    voiceState.delete(data.userId);
    enabledScreenUsers.delete(data.userId);
    const idx = screenSubscriptionOrder.indexOf(data.userId);
    if (idx !== -1) screenSubscriptionOrder.splice(idx, 1);
    participantMap.delete(data.userId);
    audioStreams.delete(data.userId);
    cameraStreams.delete(data.userId);
    screenStreams.delete(data.userId);
    // Push synchronously so the UI drops the departed participant this tick —
    // any lingering entry would otherwise render as "Connecting…" for the
    // duration of a debounce window.
    pushImmediate();
    recalcCameraEncoding().catch(() => {}); // fire-and-forget
  }

  function setCameraStream(_stream: MediaStream | null): void {
  }

  function setScreenStream(_stream: MediaStream | null): void {
  }

  function updateCameraAndScreen(cam: MediaStream | null, scr: MediaStream | null): void {
    if (!room) return;

    const lp = room.localParticipant;

    (async () => {
      if (cam) {
        const videoTrack = cam.getVideoTracks()[0];
        if (videoTrack) {
          const camPub = lp.getTrackPublication(Track.Source.Camera);
          if (camPub?.track && camPub.track.mediaStreamTrack.readyState === 'live' && !camPub.isMuted) {
            // Effects (autoframe, color grade, background blur/virtual bg)
            // are now applied pre-publish by buildProcessedCameraStream, so
            // the videoTrack we receive is already the processed output.
            await camPub.track.replaceTrack(videoTrack).catch((err: unknown) => { _onError?.(err instanceof Error ? err.message : 'Track operation failed'); });
          } else {
            if (camPub) {
              await lp.unpublishTrack(camPub.track!.mediaStreamTrack, true).catch((err: unknown) => { _onError?.(err instanceof Error ? err.message : 'Track operation failed'); });
            }
            // Tell the encoder this is motion content so it prioritises temporal smoothness.
            try { (videoTrack as MediaStreamTrack).contentHint = 'motion'; } catch { /* read-only on some browsers */ }
            const peerCount = participantInfo.size + 1;
            const quality = getVideoQuality(peerCount, maxVideoBitrate, maxCameraRes, maxCameraFps);
            const cameraCodec = getCachedBestCodec();
            await lp.publishTrack(videoTrack, {
              source: Track.Source.Camera,
              videoCodec: cameraCodec,
              videoEncoding: {
                maxBitrate: quality.bitrate,
                maxFramerate: quality.fps,
              },
              simulcast: true,
              degradationPreference: 'maintain-framerate',
            }).catch((err: unknown) => { _onError?.(err instanceof Error ? err.message : 'Track operation failed'); });
            lastCameraPeerTier = getPeerTier(peerCount);
          }
        }
      } else {
        const camPub = lp.getTrackPublication(Track.Source.Camera);
        if (camPub) {
          await lp.unpublishTrack(camPub.track!.mediaStreamTrack, true).catch((err: unknown) => { _onError?.(err instanceof Error ? err.message : 'Track operation failed'); });
        }
      }

      if (scr) {
        const screenTrack = scr.getVideoTracks()[0];
        if (screenTrack) {
          // Only unpublish + republish when the track actually changed (new
          // screen source). unpublishTrack(..., stopOnUnpublish=true) stops
          // the underlying MediaStreamTrack, so blindly re-doing this when
          // the track is unchanged (e.g. user toggled camera while sharing)
          // kills the local preview and republishes a dead track — black card.
          // Encoding-param changes (bitrate/fps/resolution) flow through
          // updateScreenShareEncoding() which handles its own republish.
          const scrPub = lp.getTrackPublication(Track.Source.ScreenShare);
          const screenTrackAlreadyPublished =
            scrPub?.track?.mediaStreamTrack === screenTrack &&
            screenTrack.readyState === 'live';
          if (!screenTrackAlreadyPublished) {
            if (scrPub) {
              await lp.unpublishTrack(scrPub.track!.mediaStreamTrack, true).catch((err: unknown) => { _onError?.(err instanceof Error ? err.message : 'Track operation failed'); });
            }
            // Tell the encoder this is static UI / text content — prioritise spatial detail
            // over motion smoothness. Massive perceived sharpness gain for screens.
            try { (screenTrack as MediaStreamTrack).contentHint = 'detail'; } catch { /* read-only on some browsers */ }
            const resolvedCodec = resolveScreenShareCodec(screenShareCodec);
            const adjustedBitrate = effectiveScreenBitrate(screenTrack);
            await lp.publishTrack(screenTrack, {
              source: Track.Source.ScreenShare,
              ...(resolvedCodec ? { videoCodec: resolvedCodec } : {}),
              simulcast: true,
              videoEncoding: {
                maxBitrate: adjustedBitrate,
                maxFramerate: currentScreenShareFps,
              },
              // Under bandwidth pressure, drop FPS first so text stays sharp.
              degradationPreference: 'maintain-resolution',
            }).catch((err: unknown) => { _onError?.(err instanceof Error ? err.message : 'Track operation failed'); });
            const settings = screenTrack.getSettings();
            log('screen share published', {
              bitrate: adjustedBitrate,
              baselineBitrate: currentScreenShareBitrate,
              codec: resolvedCodec ?? 'browser-default',
              fps: currentScreenShareFps,
              actualFps: settings.frameRate,
              actualRes: `${settings.width}x${settings.height}`,
              targetRes: currentScreenShareResolution,
            });
          }

          // Publish screen share audio if available (user toggled "Share Audio").
          // Same same-track guard as video above.
          const screenAudioTrack = scr.getAudioTracks()[0];
          if (screenAudioTrack && screenAudioTrack.readyState === 'live') {
            const existingAudioPub = lp.getTrackPublication(Track.Source.ScreenShareAudio);
            const audioAlreadyPublished =
              existingAudioPub?.track?.mediaStreamTrack === screenAudioTrack;
            if (!audioAlreadyPublished) {
              if (existingAudioPub?.track) {
                await lp.unpublishTrack(existingAudioPub.track.mediaStreamTrack, true).catch((err: unknown) => { _onError?.(err instanceof Error ? err.message : 'Track operation failed'); });
              }
              await lp.publishTrack(screenAudioTrack, {
                source: Track.Source.ScreenShareAudio,
              }).catch((err: unknown) => { _onError?.(err instanceof Error ? err.message : 'Screen share audio publish failed'); });
              log('screen share audio published');
            }
          }
        }
      } else {
        const scrPub = lp.getTrackPublication(Track.Source.ScreenShare);
        if (scrPub) {
          await lp.unpublishTrack(scrPub.track!.mediaStreamTrack, true).catch((err: unknown) => { _onError?.(err instanceof Error ? err.message : 'Track operation failed'); });
        }
        // Also unpublish screen share audio
        const scrAudioPub = lp.getTrackPublication(Track.Source.ScreenShareAudio);
        if (scrAudioPub?.track) {
          await lp.unpublishTrack(scrAudioPub.track.mediaStreamTrack, true).catch((err: unknown) => { _onError?.(err instanceof Error ? err.message : 'Track operation failed'); });
        }
      }
      pushParticipants();
    })();
  }

  function updateParticipantVoiceState(
    userId: string,
    state: { isMuted?: boolean; isDeafened?: boolean; serverMuted?: boolean; serverDeafened?: boolean },
  ): void {
    voiceState.set(userId, { ...voiceState.get(userId), ...state });
    updateSingleParticipant(userId);
    pushParticipants();
  }

  function enableRemoteScreen(userId: string): void {
    // Cap concurrent screen share subscriptions to avoid bandwidth/memory explosion
    if (enabledScreenUsers.size >= MAX_SCREEN_SUBSCRIPTIONS && !enabledScreenUsers.has(userId)) {
      // Evict the oldest subscription
      const oldest = screenSubscriptionOrder.shift();
      if (oldest) {
        enabledScreenUsers.delete(oldest);
        screenStreams.delete(oldest);
        updateSingleParticipant(oldest);
        log('screen evicted (cap reached)', { evictedUserId: oldest });
      }
    }
    enabledScreenUsers.add(userId);
    // Track subscription order for LRU eviction
    const idx = screenSubscriptionOrder.indexOf(userId);
    if (idx !== -1) screenSubscriptionOrder.splice(idx, 1);
    screenSubscriptionOrder.push(userId);
    updateSingleParticipant(userId);
    log('screen enabled for viewer', { userId });
    pushParticipants();
  }

  function disableRemoteScreen(userId: string): void {
    enabledScreenUsers.delete(userId);
    screenStreams.delete(userId);
    const idx = screenSubscriptionOrder.indexOf(userId);
    if (idx !== -1) screenSubscriptionOrder.splice(idx, 1);
    updateSingleParticipant(userId);
    log('screen disabled for viewer', { userId });
    pushParticipants();
  }

  function setMuted(muted: boolean): void {
    isUserMuted = muted;
    if (!muted) speakingMutedTicks = 0;
    if (!room) return;
    // Use the published track's soft mute() / unmute() — those flip
    // `track.enabled` on the underlying MediaStreamTrack so the sender stops
    // emitting voice frames, but the publication, sender, and SFrame
    // transformer all stay alive. Previously this called
    // setMicrophoneEnabled(!muted), which unpublishes the track on mute and
    // re-runs getUserMedia on unmute — way too expensive for PTT (every
    // press/release dropped and re-acquired the mic) and the source of the
    // "voice settings break my call" feedback when toggling rapidly.
    const lp = room.localParticipant;
    const micPub = lp.getTrackPublication(Track.Source.Microphone);
    const track = micPub?.track;
    if (track) {
      const op = muted ? track.mute() : track.unmute();
      Promise.resolve(op).catch((err: unknown) => {
        _onError?.(err instanceof Error ? err.message : 'Failed to toggle mute');
      });
      return;
    }
    // No published track — fall back to LiveKit's setMicrophoneEnabled so
    // unmuting from a "no mic" state still attempts to capture.
    lp.setMicrophoneEnabled(!muted).catch((err: unknown) => {
      _onError?.(err instanceof Error ? err.message : 'Failed to toggle mute');
    });
  }

  async function republishMicWithCurrentCodec(): Promise<void> {
    if (!room) return;
    const lp = room.localParticipant;
    const micPub = lp.getTrackPublication(Track.Source.Microphone);
    if (!micPub?.track) return;
    const msTrack = micPub.track.mediaStreamTrack;
    // stopOnUnpublish = false: keep the MediaStreamTrack alive so we can
    // republish it with new codec/bitrate/stereo/FEC/DTX options.
    await lp.unpublishTrack(msTrack, false).catch((err: unknown) => {
      _onError?.(err instanceof Error ? err.message : 'Track operation failed');
    });
    await lp.publishTrack(msTrack, {
      source: Track.Source.Microphone,
      ...buildAudioPublishOptions(),
    }).catch((err: unknown) => {
      _onError?.(err instanceof Error ? err.message : 'Track operation failed');
    });
    log('audio codec republished', codecConfig);
  }

  async function applyOpusBitrateLive(bitrateKbps: number): Promise<void> {
    if (!room) return;
    const lp = room.localParticipant;
    const micPub = lp.getTrackPublication(Track.Source.Microphone);
    // LocalTrack exposes a public `sender` getter (RTCRtpSender | undefined).
    const sender = (micPub?.track as unknown as { sender?: RTCRtpSender } | undefined)?.sender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      const encodings = params.encodings?.length ? params.encodings : [{}];
      encodings[0] = { ...encodings[0], maxBitrate: bitrateKbps * 1000 };
      await sender.setParameters({ ...params, encodings });
      log('opus bitrate live-updated', { kbps: bitrateKbps });
    } catch (err) {
      log('opus bitrate live-update failed, republishing', { error: (err as Error)?.message });
      await republishMicWithCurrentCodec();
    }
  }

  function updateAudioCodec(newCodec: AudioCodecConfig): void {
    // Detect what changed BEFORE merging.
    const sdpChanged = (
      (newCodec.opusFec !== undefined && newCodec.opusFec !== codecConfig.opusFec) ||
      (newCodec.opusDtx !== undefined && newCodec.opusDtx !== codecConfig.opusDtx) ||
      (newCodec.opusStereo !== undefined && newCodec.opusStereo !== codecConfig.opusStereo) ||
      (newCodec.opusSignal !== undefined && newCodec.opusSignal !== codecConfig.opusSignal) ||
      (newCodec.opusPacketLoss !== undefined && newCodec.opusPacketLoss !== codecConfig.opusPacketLoss)
    );
    const bitrateChanged = newCodec.opusBitrate !== undefined && newCodec.opusBitrate !== codecConfig.opusBitrate;

    codecConfig = { ...codecConfig, ...newCodec };
    if (!room) return;
    const lp = room.localParticipant;
    const micPub = lp.getTrackPublication(Track.Source.Microphone);
    if (!micPub?.track) return;

    if (sdpChanged) {
      republishMicWithCurrentCodec();
    } else if (bitrateChanged) {
      applyOpusBitrateLive(codecConfig.opusBitrate!);
    }
  }

  function updateScreenShareEncoding(fps: number, bitrate: number, resolution?: '720p' | '1080p' | '1440p'): void {
    currentScreenShareFps = fps;
    currentScreenShareBitrate = Math.min(bitrate, maxScreenShareBitrate);
    if (resolution) currentScreenShareResolution = resolution;
    log('screen share encoding updated', { fps: currentScreenShareFps, bitrate: currentScreenShareBitrate, resolution: currentScreenShareResolution });

    // Re-publish active screen share with new encoding
    if (!room) return;
    const lp = room.localParticipant;
    const scrPub = lp.getTrackPublication(Track.Source.ScreenShare);
    if (!scrPub?.track || scrPub.track.mediaStreamTrack.readyState !== 'live') return;

    // Apply FPS constraint to the live track so the browser/system adjusts capture rate
    scrPub.track.mediaStreamTrack.applyConstraints({
      frameRate: { ideal: fps, min: fps > 30 ? 30 : undefined },
    }).catch(() => {});

    const msTrack = scrPub.track.mediaStreamTrack;
    (async () => {
      // Same fix as updateAudioCodec — keep the MediaStreamTrack alive
      // across the unpublish so the subsequent publishTrack has a live
      // source to re-encode. Previously `true` stopped the capture and
      // the republish would operate on a dead track.
      await lp.unpublishTrack(msTrack, false).catch((err: unknown) => { _onError?.(err instanceof Error ? err.message : 'Track operation failed'); });
      try { msTrack.contentHint = 'detail'; } catch { /* read-only on some browsers */ }
      const resolvedCodec = resolveScreenShareCodec(screenShareCodec);
      const adjustedBitrate = effectiveScreenBitrate(msTrack);
      await lp.publishTrack(msTrack, {
        source: Track.Source.ScreenShare,
        ...(resolvedCodec ? { videoCodec: resolvedCodec } : {}),
        simulcast: true,
        videoEncoding: {
          maxBitrate: adjustedBitrate,
          maxFramerate: currentScreenShareFps,
        },
        degradationPreference: 'maintain-resolution',
      }).catch((err: unknown) => { _onError?.(err instanceof Error ? err.message : 'Track operation failed'); });
      log('screen share re-published with new encoding', { fps: currentScreenShareFps, bitrate: adjustedBitrate, codec: resolvedCodec ?? 'browser-default' });

      // Also re-publish screen share audio if it's active
      const scrAudioPub = lp.getTrackPublication(Track.Source.ScreenShareAudio);
      if (scrAudioPub?.track && scrAudioPub.track.mediaStreamTrack.readyState === 'live') {
        // Audio doesn't need encoding changes, but if we just re-published video
        // we should ensure audio is still published
        log('screen share audio still active after encoding update');
      }
    })();
  }

  /**
   * Recalculate and republish camera encoding when the peer-count tier changes.
   * Uses unpublish+republish (brief ~50ms video glitch) rather than RTCRtpSender
   * parameter manipulation, which is unreliable with simulcast layers.
   * Only fires when crossing tier boundaries (2→4, 4→8, 8+), not on every join/leave.
   */
  async function recalcCameraEncoding(): Promise<void> {
    if (!room) return;
    const lp = room.localParticipant;
    const camPub = lp.getTrackPublication(Track.Source.Camera);
    if (!camPub?.track || camPub.isMuted) return;

    const peerCount = participantInfo.size + 1;
    const tier = getPeerTier(peerCount);
    if (tier === lastCameraPeerTier) return; // same tier, no change needed
    lastCameraPeerTier = tier;

    const videoTrack = camPub.track.mediaStreamTrack;
    if (!videoTrack || videoTrack.readyState !== 'live') return;

    const quality = getVideoQuality(peerCount, maxVideoBitrate, maxCameraRes, maxCameraFps);

    await lp.unpublishTrack(videoTrack, true).catch((err: unknown) => {
      _onError?.(err instanceof Error ? err.message : 'Track operation failed');
    });
    try { videoTrack.contentHint = 'motion'; } catch { /* read-only on some browsers */ }
    const cameraCodec = getCachedBestCodec();
    await lp.publishTrack(videoTrack, {
      source: Track.Source.Camera,
      videoCodec: cameraCodec,
      videoEncoding: {
        maxBitrate: quality.bitrate,
        maxFramerate: quality.fps,
      },
      simulcast: true,
      degradationPreference: 'maintain-framerate',
    }).catch((err: unknown) => {
      _onError?.(err instanceof Error ? err.message : 'Track operation failed');
    });
    log('camera encoding adjusted for peer count', { peerCount, tier, bitrate: quality.bitrate, fps: quality.fps, codec: cameraCodec });
  }

  function setPowerUpTier(_tier: number): void {
    // Bitrate caps are handled by LiveKit server configuration
  }

  async function switchMicDevice(deviceId: string): Promise<void> {
    if (!room) return;
    currentMicDeviceId = deviceId || undefined;
    // We own the published track via the processing chain, so we can't let
    // LiveKit's switchActiveDevice swap our destination track for a
    // freshly-captured one — that would unpublish/republish behind our back.
    // Re-capture the raw mic with the new device, swap the source feeding
    // our chain, and the published destination track stays untouched.
    if (micProcessing) {
      try {
        const newRaw = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            echoCancellation: mediaConstraints.echoCancellation,
            noiseSuppression: mediaConstraints.noiseSuppression,
            autoGainControl: mediaConstraints.autoGainControl,
            channelCount: codecConfig.opusStereo ? 2 : 1,
          },
        });
        swapRawSource(newRaw);
        // Path B: post-hoc BT quality probe after device switch.
        if (onBluetoothQualityChange && autoOptimizeBluetoothAudio !== false) {
          const streamForProbe = newRaw;
          const deviceIdAtProbe = deviceId || currentMicDeviceId;
          navigator.mediaDevices.enumerateDevices().then(devs => {
            const info = devs.find(d => d.kind === 'audioinput' && d.deviceId === deviceIdAtProbe) || null;
            const status = probeStream(streamForProbe, info);
            if (status) onBluetoothQualityChange(status);
          }).catch(() => { /* ignore */ });
        }
      } catch (err) {
        console.warn(`${debugPrefix} Failed to switch mic device:`, err);
      }
      return;
    }
    // No chain (degraded path) — fall back to LiveKit's device switch.
    try {
      await room.switchActiveDevice('audioinput', deviceId || 'default');
    } catch (err) {
      console.warn(`${debugPrefix} Failed to switch mic device:`, err);
    }
  }

  async function switchSpeakerDevice(deviceId: string): Promise<void> {
    if (!room) return;
    try {
      await room.switchActiveDevice('audiooutput', deviceId || 'default');
    } catch (err) {
      console.warn(`${debugPrefix} Failed to switch speaker device:`, err);
    }
  }

  async function updateMediaConstraints(constraints: { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean }): Promise<void> {
    mediaConstraints = { ...mediaConstraints, ...constraints };
    if (!room) return;
    // Browser-level NS / EC / AGC are baked in at getUserMedia time, so we
    // need a fresh raw track. But we feed it into the same processing chain,
    // so the published destination track is unchanged from LiveKit's view —
    // no unpublish/republish, no SFrame re-key. Previously this called
    // setMicrophoneEnabled(false) → setMicrophoneEnabled(true, ...), which
    // produced the "settings changes cut me out of the call" symptom.
    if (!micProcessing) return;
    try {
      const newRaw = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(currentMicDeviceId ? { deviceId: { exact: currentMicDeviceId } } : {}),
          echoCancellation: mediaConstraints.echoCancellation,
          noiseSuppression: mediaConstraints.noiseSuppression,
          autoGainControl: mediaConstraints.autoGainControl,
          channelCount: codecConfig.opusStereo ? 2 : 1,
        },
      });
      swapRawSource(newRaw);
    } catch (err) {
      console.warn(`${debugPrefix} Failed to update media constraints:`, err);
    }
  }

  async function setMicVolume(volume: number): Promise<void> {
    // Pure parameter mutation — the RAF poll inside the chain reads
    // processingSettings.micVolume every frame and applies it via the gain
    // node. No track work, no getUserMedia, no republish. Async signature
    // preserved for API compatibility.
    processingSettings.micVolume = volume;
  }

  function updateAudioProcessing(settings: AudioProcessingConfig): void {
    if (settings.noiseSuppressionLevel !== undefined) {
      processingSettings.noiseSuppressionLevel = settings.noiseSuppressionLevel;
    }
    if (settings.autoInputSensitivity !== undefined) {
      processingSettings.autoInputSensitivity = settings.autoInputSensitivity;
    }
    if (settings.inputSensitivity !== undefined) {
      processingSettings.inputSensitivity = settings.inputSensitivity;
    }
    if (settings.noiseEngine !== undefined && settings.noiseEngine !== processingSettings.noiseEngine) {
      const nextEngine = settings.noiseEngine;
      swapDenoiserChain = swapDenoiserChain
        .then(() => swapDenoiser(nextEngine))
        .catch((err) => log('swapDenoiser errored', { error: (err as Error)?.message }));
    }
    // HPF + compressor are mutated in place; gate threshold and gain are read
    // from processingSettings inside the RAF poll loop.
    applyProcessingNodeParams();
  }

  function getMicAnalyser(): AnalyserNode | null {
    return micProcessing?.analyser ?? null;
  }

  function getMicSilenceMs(): number {
    return lastSilenceUpdateMs;
  }

  function setRemoteAudioVolume(volume: number): void {
    if (!room) return;
    const v = Math.max(0, Math.min(2, volume));
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.audioTrackPublications.values()) {
        const els = pub.track?.attachedElements;
        if (els) for (const el of els) (el as HTMLAudioElement).volume = v;
      }
    }
  }

  /** Installs on a room that was built WITHOUT
   *  E2EE (provider never created) can never take effect. Reject so callers'
   *  .catch paths surface degraded instead of a silent no-op success feeding
   *  false green shields. Before start() (room null) record-only behavior is
   *  kept: the post-connect install replays currentE2eeKey, which voice and
   *  stage rely on. */
  function assertInstallable(): void {
    if (!keyProvider && room) {
      throw new Error('E2EE not configured on this room');
    }
  }

  async function setE2eeKey(key: Uint8Array): Promise<void> {
    assertInstallable();
    currentE2eeKey = key;
    if (hadIndexedInstall) {
      // The base setKey path never moves the
      // worker's currentKeyIndex (its SetKey event carries
      // updateCurrentKeyIndex=false), so after an epoch-indexed install a
      // base-path downgrade would keep ENCRYPTING at the stale MLS slot with
      // the old key (legacy peers get permanent one-way media under green
      // shields). Only an indexed install moves the encrypt slot, so the
      // downgrade claims slot 0 explicitly. The slot-reclaim semantics are
      // pinned by the real-provider canary in howlSframeKeyProvider.test.ts.
      currentE2eeKeyIndex = 0;
      if (keyProvider) {
        await installQueue.enqueue(keyProvider, key, 0);
        await ensureRoomE2eeEnabled();
        log('E2EE key updated (rotation, reclaimed encrypt slot 0 after indexed install)');
      }
    } else {
      currentE2eeKeyIndex = null; // legacy/voice/stage semantics: index-0 setKey path
      if (keyProvider) {
        await installQueue.enqueue(keyProvider, key, null);
        await ensureRoomE2eeEnabled();
        log('E2EE key updated (rotation)');
      }
    }
  }

  /** MLS DM-call path; installs at epochKeyIndex(epoch), retaining prior
   *  epoch keys in the keyring for in-flight frames across a Commit. */
  async function setE2eeKeyAtEpoch(key: Uint8Array, epoch: bigint): Promise<void> {
    assertInstallable();
    const idx = epochKeyIndex(epoch);
    currentE2eeKey = key;
    currentE2eeKeyIndex = idx;
    hadIndexedInstall = true;
    if (keyProvider) {
      await installQueue.enqueue(keyProvider, key, idx);
      await ensureRoomE2eeEnabled();
      log('E2EE key updated (MLS epoch rekey)', { keyIndex: idx });
    }
  }
  function leave(): void {
    if (navigator.mediaDevices?.removeEventListener) {
      try { navigator.mediaDevices.removeEventListener('devicechange', onDeviceChangeHandler); } catch { /* */ }
    }
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    if (room) {
      room.disconnect(true);
      room = null;
    }
    // Defensively terminate the E2EE worker (no-op if LiveKit already did)
    if (e2eeWorker) {
      e2eeWorker.terminate();
      e2eeWorker = undefined;
    }
    keyProvider = null;
    currentE2eeKey = null;
    currentE2eeKeyIndex = null;
    e2eeEnabledOnRoom = false;
    detachRawMicEndedListener();
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    teardownMicProcessing();
    currentMicDeviceId = undefined;
    participantInfo.clear();
    voiceState.clear();
    enabledScreenUsers.clear();
    screenSubscriptionOrder.length = 0;
    audioStreams.clear();
    // Stop all camera tracks
    for (const [, stream] of cameraStreams) {
      stream.getTracks().forEach(t => t.stop());
    }
    // Stop all screen share tracks
    for (const [, stream] of screenStreams) {
      stream.getTracks().forEach(t => t.stop());
    }
    cameraStreams.clear();
    screenStreams.clear();
    screenAudioStreams.clear();
    participantMap.clear();
    onRemoteParticipants([]);
  }

  return {
    start,
    leave,
    getLocalStream: () => localStream,
    handleParticipants,
    handleUserJoined,
    handleUserLeft,
    setCameraStream,
    setScreenStream,
    updateCameraAndScreen,
    updateParticipantVoiceState,
    enableRemoteScreen,
    disableRemoteScreen,
    setMuted,
    updateAudioCodec,
    updateScreenShareEncoding,
    setPowerUpTier,
    switchMicDevice,
    switchSpeakerDevice,
    setMicVolume,
    setRemoteAudioVolume,
    updateMediaConstraints,
    updateAudioProcessing,
    getMicAnalyser,
    getMicSilenceMs,
    setE2eeKey,
    setE2eeKeyAtEpoch,
    getServerRegion: () => {
      const info = room?.serverInfo;
      if (!info) return null;
      // Prefer explicit region field (populated by LiveKit Cloud)
      if (info.region) return info.region;
      // Fallback: parse region prefix from nodeId (e.g., "US-EAST-1-xyzabc" → "US-EAST-1")
      if (info.nodeId) {
        const m = info.nodeId.match(/^([a-zA-Z]+-[a-zA-Z]+-\d+)/);
        if (m) return m[1].toLowerCase();
      }
      return null;
    },
  };
}
