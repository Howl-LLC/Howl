// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useMemo } from 'react';
import type { User } from '../types';
import { socketService } from '../services/socket';
import { useVoiceStore } from '../stores/voiceStore';
import { useCallSession, type CallParticipant, type CallAudioConstraints, type CallTransport } from './useCallSession';
import type { AudioProcessingConfig } from '../services/call/types';
import type { BtDevicePreference, BluetoothAudioSettings } from '../utils/settingsStorage';
import type { BtQualityStatus } from '../services/audio/btQualityDetector';
import * as stageE2ee from '../services/stageE2ee';

export type StageParticipant = CallParticipant;
export type StageAudioConstraints = CallAudioConstraints;
export type StageAudioProcessing = AudioProcessingConfig;

export function useStageRoom(
  channelId: string | null,
  currentUser: User | null,
  isSpeaker: boolean,
  isMuted?: boolean,
  cameraStream?: MediaStream | null,
  screenStream?: MediaStream | null,
  micDeviceId?: string,
  audioConstraints?: StageAudioConstraints,
  serverPowerUpTier?: number,
  userPlan?: string | null,
  screenShareCodec: 'auto' | 'h264' | 'vp9' | 'av1' = 'auto',
  screenShareFps?: number,
  screenShareBitrate?: number,
  speakerDeviceId?: string,
  speakerVolume?: number,
  micVolume?: number,
  screenShareResolution?: '720p' | '1080p' | '1440p',
  audioProcessing?: StageAudioProcessing,
  btDevicePreferences?: BtDevicePreference[],
  bluetoothAudioSettings?: BluetoothAudioSettings,
  onBluetoothQualityChange?: (status: BtQualityStatus) => void,
): {
  localStream: MediaStream | null;
  remoteParticipants: StageParticipant[];
  leave: () => void;
  error: string | null;
  disconnectedByInactivity: boolean;
  enableRemoteScreen: (userId: string) => void;
  disableRemoteScreen: (userId: string) => void;
  setE2eeKey: (key: Uint8Array) => Promise<void>;
  switchMicDevice: (deviceId: string) => Promise<void>;
  serverRegion: string | null;
  isE2ee: boolean;
  isE2eeFailed: boolean;
} {
  const transport = useMemo<CallTransport | null>(() => {
    if (!channelId) return null;
    return {
      // Await the server ACK before resolving so engine.start() can fetch
      // the LiveKit token only after the audience/speaker Redis write is
      // committed. Without this the token endpoint gate returns 403 and
      // the stage engine never actually connects. Match joinDmCall pattern.
      // The ACK also carries an inline LiveKit token+url which
      // useCallSession consumes directly to skip a POST /livekit/token
      // round trip.
      join: (chId) => new Promise<{ token?: string; url?: string }>((resolve, reject) => {
        socketService.whenConnected(() => {
          socketService.joinStageAudience(chId).then(resolve).catch(reject);
        });
      }),
      leave: (chId) => socketService.leaveStage(chId),
      // Stages get participant data from REST API + socket updates (activeStageSessions state),
      // not from voice-participants-style socket events. These callbacks are no-ops.
      onParticipants: () => {},
      onUserJoined: () => {},
      onUserLeft: () => {},
      onJoinError: (cb) => {
        socketService.socket?.off('stage-error');
        socketService.socket?.on('stage-error', (data: { error: string }) => {
          cb({ channelId: channelId, message: data.error });
        });
      },
      onStateUpdate: () => {},
      off: () => { socketService.socket?.off('stage-error'); },
      offStateUpdate: () => {},
      emitViewerSubscribe: (ownerId) => {
        if (!channelId) return;
        void socketService.emitViewerSubscribe({
          context: { kind: 'stage', scopeId: channelId },
          streamOwnerId: ownerId,
          streamType: 'screen',
        });
      },
      emitViewerUnsubscribe: (ownerId) => {
        if (!channelId) return;
        void socketService.emitViewerUnsubscribe({
          context: { kind: 'stage', scopeId: channelId },
          streamOwnerId: ownerId,
          streamType: 'screen',
        });
      },
    };
  }, [channelId]);

  // Eagerly seed a stage session SFrame key during render, mirroring the
  // fix in useVoiceChannel. Without this the CallEngine's `start()` method
  // connects to the LiveKit room with `e2eeEnabled=true` but no key set on
  // the keyProvider; the SFrame worker then has nothing to encrypt/decrypt
  // with for the first few hundred ms — the host publishes frames no peer
  // can decode, and audience can't decode what speakers publish. This
  // optimistic key is replaced by the host's real key via `useStageE2ee`
  // (either it IS the host's key, or the host's key arrives via
  // stage-e2ee-key and `setE2eeKey()` updates the engine).
  const stageKey = useMemo<Uint8Array | null>(() => {
    if (!channelId) return null;
    const existing = stageE2ee.getStageKey();
    if (existing && stageE2ee.getStageChannelId() === channelId) return existing;
    const fresh = stageE2ee.generateStageSessionKey();
    stageE2ee.setStageKey(channelId, fresh);
    return fresh;
  }, [channelId]);

  // has the local user adopted the verified host SFrame key? Host is
  // always keyed; audience/speakers flip true when stage-e2ee-key arrives.
  // Subscribed reactively so the amber→green transition re-renders the shield.
  const hasVerifiedKey = useVoiceStore(
    (s) => (channelId ? s.stageE2eeKeyed[channelId] === true : false),
  );

  // Green shield: we hold the verified host key (SFrame decodes the room).
  // Amber shield: joined a stage but the host's key hasn't arrived yet — for
  // BOTH speakers and audience. Previously audience were hardcoded to never
  // show amber, so they silently decoded nothing with no signal. The
  // optimistic self-key (`stageKey`) keeps the engine running but is not the
  // room's key until the host distributes, so it must NOT count as green.
  const isE2ee = hasVerifiedKey;
  const isE2eeFailed = !!channelId && !!stageKey && !hasVerifiedKey;

  const session = useCallSession(
    channelId,
    currentUser,
    transport,
    // Audience members are always muted (can't publish); speakers use passed isMuted
    isSpeaker ? isMuted : true,
    isSpeaker ? cameraStream : null,
    isSpeaker ? screenStream : null,
    micDeviceId,
    audioConstraints,
    '[Stage]',
    serverPowerUpTier,
    userPlan,
    'stage',
    screenShareCodec,
    stageKey ?? undefined, // e2eeKeyBytes
    screenShareFps,
    screenShareBitrate,
    speakerDeviceId,
    speakerVolume,
    micVolume,
    // Stages require E2EE across all participants — see the matching comment
    // in useVoiceChannel. Join sites gate on ensureE2eUnlockedForCall().
    true, // e2eeEnabled
    screenShareResolution,
    audioProcessing,
    btDevicePreferences,
    bluetoothAudioSettings,
    onBluetoothQualityChange,
  );

  return { ...session, isE2ee, isE2eeFailed };
}
