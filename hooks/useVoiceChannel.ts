// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useMemo } from 'react';
import type { User } from '../types';
import { socketService } from '../services/socket';
import { useCallSession, type CallParticipant, type CallAudioConstraints, type CallTransport } from './useCallSession';
import type { AudioProcessingConfig } from '../services/call/types';
import type { BtDevicePreference, BluetoothAudioSettings } from '../utils/settingsStorage';
import type { BtQualityStatus } from '../services/audio/btQualityDetector';
import * as voiceE2ee from '../services/voiceE2ee';
import { buildOwnSignedJoinBlob } from '../services/voiceE2ee';

export type VoiceParticipant = CallParticipant;
export type VoiceAudioConstraints = CallAudioConstraints;
export type VoiceAudioProcessing = AudioProcessingConfig;

export function useVoiceChannel(
  channelId: string | null,
  currentUser: User | null,
  isMuted?: boolean,
  cameraStream?: MediaStream | null,
  screenStream?: MediaStream | null,
  micDeviceId?: string,
  audioConstraints?: VoiceAudioConstraints,
  serverPowerUpTier?: number,
  userPlan?: string | null,
  screenShareCodec: 'auto' | 'h264' | 'vp9' | 'av1' = 'auto',
  screenShareFps?: number,
  screenShareBitrate?: number,
  speakerDeviceId?: string,
  speakerVolume?: number,
  micVolume?: number,
  screenShareResolution?: '720p' | '1080p' | '1440p',
  audioProcessing?: VoiceAudioProcessing,
  btDevicePreferences?: BtDevicePreference[],
  bluetoothAudioSettings?: BluetoothAudioSettings,
  onBluetoothQualityChange?: (status: BtQualityStatus) => void,
  onMicTrackEnded?: () => void,
  onSpeakingWhileMuted?: () => void,
  onMicSilenceUpdate?: (silenceMs: number) => void,
): {
  localStream: MediaStream | null;
  remoteParticipants: VoiceParticipant[];
  leave: () => void;
  error: string | null;
  disconnectedByInactivity: boolean;
  enableRemoteScreen: (userId: string) => void;
  disableRemoteScreen: (userId: string) => void;
  setE2eeKey: (key: Uint8Array) => Promise<void>;
  switchMicDevice: (deviceId: string) => Promise<void>;
  serverRegion: string | null;
  getMicSilenceMs: () => number;
  isE2ee: boolean;
  isE2eeFailed: boolean;
} {
  const transport = useMemo<CallTransport | null>(() => {
    if (!channelId) return null;
    return {
      // Await the server ACK before resolving so useCallSession can start
      // engine.start() / fetch LiveKit token only after the Redis voice-
      // participant write is committed. Without this, the /livekit/token
      // gate (isInVoiceChannel) sees no membership row and returns 403 —
      // the engine fails to connect, localStream is empty, no remote
      // tracks subscribe. Match joinDmCall's pattern exactly. The ACK also
      // carries an inline LiveKit token+url which useCallSession consumes
      // directly to skip a POST /livekit/token round trip.
      join: (chId, username, avatar, banner) => new Promise<{ token?: string; url?: string }>((resolve, reject) => {
        socketService.whenConnected(() => {
          const signed = buildOwnSignedJoinBlob(chId, Date.now());
          socketService.joinVoiceChannel(chId, username, avatar, banner, signed ?? undefined)
            .then(resolve)
            .catch(reject);
        });
      }),
      leave: (chId) => socketService.leaveVoiceChannel(chId),
      onParticipants: (cb) => socketService.onVoiceParticipants((chId, list, powerUpTier) => cb(chId, list, powerUpTier)),
      onUserJoined: (cb) => socketService.onVoiceUserJoined(cb),
      onUserLeft: (cb) => socketService.onVoiceUserLeft(cb),
      onJoinError: (cb) => socketService.onVoiceJoinError(cb as (p: { channelId: string; message: string }) => void),
      onStateUpdate: (cb) => socketService.onVoiceStateUpdate(cb),
      onInactivityDisconnect: (cb) => socketService.onVoiceInactivityDisconnect((data) => cb({ channelId: data.channelId })),
      off: () => socketService.offVoice(),
      offStateUpdate: () => socketService.offVoiceStateUpdate(),
      emitViewerSubscribe: (ownerId) => {
        if (!channelId) return;
        void socketService.emitViewerSubscribe({
          context: { kind: 'voice', scopeId: channelId },
          streamOwnerId: ownerId,
          streamType: 'screen',
        });
      },
      emitViewerUnsubscribe: (ownerId) => {
        if (!channelId) return;
        void socketService.emitViewerUnsubscribe({
          context: { kind: 'voice', scopeId: channelId },
          streamOwnerId: ownerId,
          streamType: 'screen',
        });
      },
    };
  }, [channelId]);

  // Eagerly generate & store the voice session SFrame key *during render*,
  // before `useCallSession` creates the engine. If we waited for the effect
  // in `useVoiceE2ee` to run, the engine would start with a null key, publish
  // encrypted frames no peer can decode, and we'd have a silent room. The
  // key is reused on remount for the same channel so we don't rotate mid-
  // session. `useVoiceE2ee` still handles leader election and key rotation
  // once participants arrive (it may replace this optimistic key with the
  // real leader's key).
  const e2eeKeyBytes = useMemo<Uint8Array | undefined>(() => {
    if (!channelId) return undefined;
    const existing = voiceE2ee.getVoiceKey();
    if (existing && voiceE2ee.getVoiceChannelId() === channelId) return existing;
    const fresh = voiceE2ee.generateVoiceSessionKey();
    voiceE2ee.setVoiceKey(channelId, fresh);
    return fresh;
  }, [channelId]);

  // Green shield: SFrame key present (server voice runs E2EE unconditionally —
  // e2eeEnabled:true below). Amber shield: in a voice channel but no key was
  // seeded, i.e. the optimistic render-time key generation failed and key
  // exchange never produced one. Mirrors useStageRoom's speaker semantics;
  // every voice participant publishes, so there is no audience exemption.
  const isE2ee = !!e2eeKeyBytes;
  const isE2eeFailed = !e2eeKeyBytes && !!channelId;

  const session = useCallSession(
    channelId,
    currentUser,
    transport,
    isMuted,
    cameraStream,
    screenStream,
    micDeviceId,
    audioConstraints,
    '[Voice]',
    serverPowerUpTier,
    userPlan,
    'voice',
    screenShareCodec,
    e2eeKeyBytes,
    screenShareFps,
    screenShareBitrate,
    speakerDeviceId,
    speakerVolume,
    micVolume,
    // E2EE is mandatory for voice channels — the join flow is gated on
    // ensureE2eUnlockedForCall() at every entry point, so by the time we
    // reach here the vault is guaranteed unlocked. Setting this true
    // unconditionally is what keeps Room options symmetric across
    // participants (asymmetric e2ee flags made the SFU relay frames that
    // one side encrypted with SFrame and the other couldn't decode).
    true, // e2eeEnabled
    screenShareResolution,
    audioProcessing,
    btDevicePreferences,
    bluetoothAudioSettings,
    onBluetoothQualityChange,
    onMicTrackEnded,
    onSpeakingWhileMuted,
    onMicSilenceUpdate,
  );

  return { ...session, isE2ee, isE2eeFailed };
}
