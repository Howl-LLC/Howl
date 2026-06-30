// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
export interface CallParticipant {
  userId: string;
  username: string;
  avatar?: string;
  banner?: string;
  bannerPositionY?: number;
  bannerZoom?: number;
  nickname?: string;
  nameColor?: string;
  nameFont?: string;
  nameEffect?: string;
  avatarEffect?: string;
  effectivePlan?: string;
  /** Advertised MLS-call readiness, threaded from ParticipantInfo so
   *  useDMCall can compute the symmetric useMls AND over the live roster. */
  mlsCallReady?: boolean;
  roleColor?: string;
  roleStyle?: string;
  stream: MediaStream | null;
  cameraStream?: MediaStream | null;
  screenStream?: MediaStream | null;
  screenShareAudioStream?: MediaStream | null;
  screenShareAvailable?: boolean;
  connectionState?: string;
  isMuted?: boolean;
  isDeafened?: boolean;
  serverMuted?: boolean;
  serverDeafened?: boolean;
}

export interface AudioCodecConfig {
  opusBitrate?: number;
  opusFec?: boolean;
  opusDtx?: boolean;
  opusPacketLoss?: number;
  opusSignal?: 'auto' | 'voice' | 'music';
  opusStereo?: boolean;
}

/**
 * Settings for the engine-owned mic processing chain (HPF + compressor + noise
 * gate + gain). Browser-level NS/AGC/EC are configured via the separate media
 * constraints — these settings layer the custom DSP on top of whatever the
 * browser already does.
 */
export interface AudioProcessingConfig {
  /** 'none' | 'low' | 'medium' | 'high' — strength of the custom HPF + compressor. */
  noiseSuppressionLevel?: string;
  /** When true, a smart adaptive VAD tracks the room's noise floor and opens
   *  the gate at +9 dB SNR (closes at +6 dB). When false, a static RMS gate
   *  using inputSensitivity as the threshold. */
  autoInputSensitivity?: boolean;
  /** 0..100 RMS threshold (as a percentage of full scale) for the noise gate. */
  inputSensitivity?: number;
  /** Active ML denoiser engine — at most one runs at a time. 'off' disables
   *  ML denoising entirely (pure DSP chain). Live-swapped via parallel-feed
   *  when changed mid-call. */
  noiseEngine?: import('../../utils/settingsStorage').NoiseEngine;
}

export interface CallEngineConfig {
  currentUserId: string;
  livekitUrl?: string;
  getToken: () => Promise<string | { token: string; url: string }>;
  onRemoteParticipants: (participants: CallParticipant[]) => void;
  onError?: (message: string) => void;
  /** Dedicated sink for RoomEvent.EncryptionError. Transient SFrame
   *  decrypt skew is expected on every mid-call MLS Commit, so DM calls
   *  route it here (feeding the degraded-shield machinery) instead of the
   *  fatal onError path, which DMCallView treats as call-ending. When
   *  absent (voice/stages), EncryptionError keeps the onError routing. */
  onE2eeError?: (message: string) => void;
  debugPrefix?: string;
  maxVideoBitrate?: number;
  maxCameraRes?: '720p' | '1080p' | '1440p';
  maxCameraFps?: 30 | 60;
  maxScreenShareBitrate?: number;
  /** Initial screen share encoding FPS (from user quality selection). */
  screenShareFps?: number;
  /** Initial screen share encoding bitrate (computed from resolution+fps, capped by plan). */
  screenShareBitrate?: number;
  /** Target screen-share resolution tier — used as the reference for ultrawide bitrate compensation. */
  screenShareResolution?: '720p' | '1080p' | '1440p';
  screenShareCodec?: 'auto' | 'h264' | 'vp9' | 'av1';
  /** Raw 32-byte key for LiveKit SFrame E2EE. When set, Room is created with E2EE enabled. */
  e2eeKeyBytes?: Uint8Array;
  e2eeEnabled?: boolean;
  /** Keyring index for the initial e2eeKeyBytes (epochKeyIndex(epoch) on
   *  the MLS DM-call path). Absent/undefined = the legacy index-0 setKey path
   *  (voice, stages, legacy DM calls). */
  e2eeKeyIndex?: number;
  initialAudioCodec?: AudioCodecConfig;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  /** Initial settings for the engine-owned mic processing chain. */
  initialAudioProcessing?: AudioProcessingConfig;
  /** Initial mic output gain (0..200, percentage). Defaults to 100. */
  initialMicVolume?: number;
  /** Callback fired after each getUserMedia + on devicechange to surface the
   *  mic's Bluetooth quality tier. Consumers (App.tsx) feed this into the
   *  useBluetoothQuality hook via a pub/sub bridge. Optional — engine works
   *  fine without it. */
  onBluetoothQualityChange?: (status: import('../audio/btQualityDetector').BtQualityStatus) => void;
  /**
   * Tier 3 latency optimization: a promise that resolves to a
   * pre-captured microphone MediaStreamTrack. The caller fires
   * navigator.mediaDevices.getUserMedia() in parallel with the socket
   * join ACK and LiveKit room connect, then passes the promise here so
   * the engine publishes that track directly after room.connect instead
   * of running its own getUserMedia serially. When the promise resolves
   * null or rejects, the engine falls back to
   * localParticipant.setMicrophoneEnabled(true, ...) — same behavior as
   * before.
   */
  preCapturedMicTrackPromise?: Promise<MediaStreamTrack | null>;
  /** Per-device BT preferences — used for Path A pre-emptive label override before getUserMedia. */
  btDevicePreferences?: import('../../utils/settingsStorage').BtDevicePreference[];
  /** Label of the last non-BT mic the user actively used — ranks split-devices candidates. */
  lastNonBtMicLabel?: string | null;
  /** Global kill switch. When false, Path A is skipped entirely. */
  autoOptimizeBluetoothAudio?: boolean;
  /** Fired when the raw mic MediaStreamTrack ends unexpectedly (USB unplug,
   *  OS permission revoked, device removed). NOT fired when the engine
   *  intentionally stops the track (device switch, leave, teardown) — the
   *  listener is detached before any engine-initiated stop. */
  onMicTrackEnded?: () => void;
  /** Fired when the engine detects sustained voice activity (gate-open) while
   *  the user is self-muted. Throttled to at most once per 30s; resets after
   *  the gate closes so a single speech burst counts as one trigger. */
  onSpeakingWhileMuted?: () => void;
  /** Periodic callback reporting consecutive silence duration on the local
   *  mic. Fires at ~1 Hz when the mic chain is active. Purely informational —
   *  consumers drive UI indicators, never disconnect/error paths. */
  onMicSilenceUpdate?: (silenceMs: number) => void;
}

export interface ParticipantInfo {
  userId: string;
  username: string;
  avatar?: string;
  banner?: string;
  bannerPositionY?: number;
  bannerZoom?: number;
  nickname?: string;
  nameColor?: string;
  nameFont?: string;
  nameEffect?: string;
  avatarEffect?: string;
  effectivePlan?: string;
  /** This participant's advertised MLS-call readiness (from join-dm-call,
   *  relayed by the server). Undefined for voice/stage participants, for
   *  servers without MLS-call support, and transiently for DM participants in
   *  the window between LiveKit ParticipantConnected and the socket roster
   *  landing; consumers must treat undefined as not-ready without latching it. */
  mlsCallReady?: boolean;
  roleColor?: string;
  roleStyle?: string;
}

export type CallEngine = {
  start: () => Promise<MediaStream>;
  leave: () => void;
  getLocalStream: () => MediaStream | null;
  handleParticipants: (participants: ParticipantInfo[]) => void;
  handleUserJoined: (data: ParticipantInfo) => Promise<void>;
  handleUserLeft: (data: { userId: string }) => void;
  setCameraStream: (stream: MediaStream | null) => void;
  setScreenStream: (stream: MediaStream | null) => void;
  updateCameraAndScreen: (cam: MediaStream | null, scr: MediaStream | null) => void;
  updateParticipantVoiceState: (userId: string, state: { isMuted?: boolean; isDeafened?: boolean; serverMuted?: boolean; serverDeafened?: boolean }) => void;
  enableRemoteScreen: (userId: string) => void;
  disableRemoteScreen: (userId: string) => void;
  setMuted: (muted: boolean) => void;
  updateAudioCodec: (newCodec: AudioCodecConfig) => void;
  updateScreenShareEncoding: (fps: number, bitrate: number, resolution?: '720p' | '1080p' | '1440p') => void;
  setPowerUpTier: (tier: number) => void;
  switchMicDevice: (deviceId: string) => Promise<void>;
  switchSpeakerDevice: (deviceId: string) => Promise<void>;
  setMicVolume: (volume: number) => Promise<void>;
  setRemoteAudioVolume: (volume: number) => void;
  updateMediaConstraints: (constraints: { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean }) => Promise<void>;
  /** Update the custom HPF + compressor + gate parameters in place — no track churn. */
  updateAudioProcessing: (settings: AudioProcessingConfig) => void;
  /** Returns the AnalyserNode at the end of the mic chain so UIs can drive a level meter. */
  getMicAnalyser: () => AnalyserNode | null;
  /** Returns current consecutive mic-silence duration in ms. 0 when audio is present. */
  getMicSilenceMs: () => number;
  setE2eeKey: (key: Uint8Array) => Promise<void>;
  /** Install an MLS-exporter-derived key at epochKeyIndex(epoch). Prior
   *  epoch keys stay in the LiveKit keyring (size 16) for in-flight frames. */
  setE2eeKeyAtEpoch: (key: Uint8Array, epoch: bigint) => Promise<void>;
  getServerRegion: () => string | null;
};
