// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Voice / Stage action utilities.
 * Extracted from App.tsx useCallback handlers for reuse outside React components.
 */
import { apiClient } from '../services/api';
import { socketService } from '../services/socket';
import { useVoiceStore } from '../stores/voiceStore';
import { useServerStore } from '../stores/serverStore';
import { ensureE2eUnlockedForCall } from './callE2eeGate';
import { leaveOtherActiveCalls } from './activeCallRegistry';

import { normalizeStageSession } from './stageHelpers';
export { normalizeStageSession } from './stageHelpers';

// Switch voice channel

export function switchVoiceChannel(channelId: string): void {
  const doSwitch = () => {
    leaveOtherActiveCalls('voice');
    try {
      sessionStorage.removeItem('howl_voice_channel');
    } catch (err) {
      console.error('Failed to clear voice channel session', err);
    }
    useVoiceStore.getState().setConnectedVoiceChannelId(channelId);
    try {
      const { servers } = useServerStore.getState();
      const targetServer = servers.find((s) => s.channels.some((c) => c.id === channelId));
      if (targetServer) {
        sessionStorage.setItem(
          'howl_voice_channel',
          JSON.stringify({ serverId: targetServer.id, channelId }),
        );
      }
    } catch (err) {
      console.error('Failed to store voice channel on switch', err);
    }
  };
  if (!ensureE2eUnlockedForCall(doSwitch)) return;
  doSwitch();
}

// Leave voice channel

export function leaveVoiceChannel(
  navigate: (path: string) => void,
  opts?: {
    isCameraOn?: boolean;
    isScreenSharing?: boolean;
    toggleCamera?: () => void;
    toggleScreenShare?: () => void;
  },
): void {
  // Capture voice state before clearing it (avoids stale read after setConnectedVoiceChannelId(null))
  const prevVoiceId = useVoiceStore.getState().connectedVoiceChannelId;
  const { servers } = useServerStore.getState();
  const activeServerId = prevVoiceId
    ? (servers.find((srv) => srv.channels.some((c) => c.id === prevVoiceId))?.id ?? null)
    : null;

  try {
    sessionStorage.removeItem('howl_voice_channel');
  } catch (err) {
    console.error('Failed to clear voice channel session', err);
  }
  useVoiceStore.getState().setConnectedVoiceChannelId(null);
  if (opts?.isCameraOn) opts.toggleCamera?.();
  if (opts?.isScreenSharing) opts.toggleScreenShare?.();

  // Navigate to first text channel in the active server (never voice/stage)
  const activeServer = activeServerId ? servers.find((s) => s.id === activeServerId) : null;
  const firstText = activeServer?.channels.find((c) => c.type === 'text' || c.type === 'forum');
  if (firstText && activeServer) {
    navigate(`/channels/${activeServer.id}/${firstText.id}`);
  } else if (activeServer) {
    // No text-like channel exists — navigate to the server home (no active channel)
    navigate(`/channels/${activeServer.id}`);
  }
}

// Server mute/deafen/move user

export function serverMuteUser(targetUserId: string, muted: boolean): void {
  const { connectedVoiceChannelId } = useVoiceStore.getState();
  if (!connectedVoiceChannelId) return;
  socketService.sendServerMuteUser(connectedVoiceChannelId, targetUserId, muted);
}

export function serverDeafenUser(targetUserId: string, deafened: boolean): void {
  const { connectedVoiceChannelId } = useVoiceStore.getState();
  if (!connectedVoiceChannelId) return;
  socketService.sendServerDeafenUser(connectedVoiceChannelId, targetUserId, deafened);
}

export function moveVoiceUser(targetUserId: string, toChannelId: string): void {
  const { connectedVoiceChannelId } = useVoiceStore.getState();
  if (!connectedVoiceChannelId) return;
  socketService.sendMoveVoiceUser(targetUserId, connectedVoiceChannelId, toChannelId);
}

// Stage: join / leave

export function joinStage(channelId: string): void {
  const doJoin = () => {
    leaveOtherActiveCalls('stage');
    useVoiceStore.getState().setConnectedStageChannelId(channelId);
    // useStageRoom's transport.join handles the audience socket emit with
    // ACK-gating so engine.start() doesn't race the /livekit/token endpoint.
  };
  if (!ensureE2eUnlockedForCall(doJoin)) return;
  doJoin();
}

export function leaveStage(): void {
  const { connectedStageChannelId } = useVoiceStore.getState();
  if (connectedStageChannelId) socketService.leaveStage(connectedStageChannelId);
  useVoiceStore.getState().setConnectedStageChannelId(null);
}

// Stage: raise / lower hand

export async function raiseHand(
  connectedStageChannelId: string,
  activeServerId: string,
): Promise<void> {
  await apiClient.raiseHand(connectedStageChannelId, activeServerId);
}

export async function lowerHand(
  connectedStageChannelId: string,
  activeServerId: string,
  targetUserId?: string,
): Promise<void> {
  await apiClient.lowerHand(connectedStageChannelId, activeServerId, targetUserId);
}

// Stage: join as speaker / move to audience

export async function joinStageAsSpeaker(
  activeChannelId: string,
  activeServerId: string,
): Promise<void> {
  const doJoin = async () => {
    try {
      leaveOtherActiveCalls('stage');
      await apiClient.joinStageAsSpeaker(activeChannelId, activeServerId);
      useVoiceStore.getState().setConnectedStageChannelId(activeChannelId);
      // useStageRoom's transport.join handles the audience socket emit with
      // ACK-gating so engine.start() doesn't race /livekit/token.
    } catch (err) {
      console.error('Failed to join as speaker:', err);
    }
  };
  if (!ensureE2eUnlockedForCall(() => { void doJoin(); })) return;
  await doJoin();
}

export async function moveSelfToAudience(
  connectedStageChannelId: string,
  activeServerId: string,
): Promise<void> {
  try {
    await apiClient.moveToAudience(connectedStageChannelId, activeServerId);
  } catch (err) {
    console.error('Failed to move to audience:', err);
  }
}

// Stage: start / edit

export type StageSettingsData = {
  topic?: string;
  maxSpeakers: number;
  textChatEnabled: boolean;
  allowEmojis: boolean;
  allowStickers: boolean;
  allowGifs: boolean;
  invitedSpeakerUserIds?: string[];
  invitedRoleIds?: string[];
};

export async function startStage(
  channelId: string,
  activeServerId: string,
  data: StageSettingsData,
  navigate: (path: string) => void,
): Promise<void> {
  const doStart = async () => {
    try {
      leaveOtherActiveCalls('stage');
      const session = await apiClient.startStage(channelId, activeServerId, data);
      useVoiceStore.getState().setActiveStageSessions((prev) => ({
        ...prev,
        [channelId]: normalizeStageSession(session),
      }));
      useVoiceStore.getState().setConnectedStageChannelId(channelId);
      // useStageRoom's transport.join handles the audience socket emit with
      // ACK-gating so engine.start() doesn't race /livekit/token.
      const { servers } = useServerStore.getState();
      const server = servers.find((s) => s.id === activeServerId);
      if (server) navigate(`/channels/${server.id}/${channelId}`);
    } catch (err) {
      console.error('Failed to start stage:', err);
    }
    useVoiceStore.getState().setStageSettingsModal(null);
  };
  if (!ensureE2eUnlockedForCall(() => { void doStart(); })) return;
  await doStart();
}

export async function editStage(
  channelId: string,
  activeServerId: string,
  data: StageSettingsData,
): Promise<void> {
  try {
    const session = await apiClient.editStage(channelId, activeServerId, data);
    useVoiceStore.getState().setActiveStageSessions((prev) => ({
      ...prev,
      [channelId]: normalizeStageSession(session),
    }));
  } catch (err) {
    console.error('Failed to edit stage:', err);
  }
  useVoiceStore.getState().setStageSettingsModal(null);
}
