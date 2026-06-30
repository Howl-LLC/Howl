// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, type MutableRefObject } from 'react';
import type { Server } from '../types';
import { socketService } from '../services/socket';
import { useVoiceStore } from '../stores/voiceStore';
import { useNavigate } from 'react-router-dom';
import { deferStoreUpdate } from '../utils/storeHelpers';

/**
 * Registers socket events for voice control actions applied TO the current user:
 * - voice-server-mute: server mute/deafen applied by a moderator
 * - voice-moved: admin moved user to a different voice channel
 * - voice-inactivity-disconnect: alone in voice for too long
 * - dm-call-inactivity-disconnect: alone in DM call for too long
 * - voice-auto-disconnected: joining DM call while in voice (or vice versa)
 * - dm-call-auto-disconnected: joining voice while in DM call (or vice versa)
 * - call-transferred: call/voice transferred to another device
 */
export function useVoiceControlSocketEvents(opts: {
  connectedVoiceChannelId: string | null;
  activeDmCallChannelId: string | null;
  voiceChannelIdRef: MutableRefObject<string | null>;
  servers: Server[];
  setActiveDmCallChannelId: (id: string | null) => void;
  setDmCallWithVideo: (v: boolean) => void;
  setDmCallDeclinedUserIds: (ids: string[]) => void;
  showGlobalToast: (msg: string, type: string) => void;
}): void {
  const {
    connectedVoiceChannelId,
    activeDmCallChannelId,
    voiceChannelIdRef,
    servers,
    setActiveDmCallChannelId,
    setDmCallWithVideo,
    setDmCallDeclinedUserIds,
    showGlobalToast,
  } = opts;

  const navigate = useNavigate();

  // Listen for server mute/deafen applied to the current user
  useEffect(() => {
    if (!connectedVoiceChannelId) return;
    const handler = (data: { channelId: string; serverMuted: boolean; serverDeafened: boolean }) => {
      if (data.channelId !== connectedVoiceChannelId) return;
      deferStoreUpdate(() => {
        useVoiceStore.getState().setServerMuted(data.serverMuted);
        useVoiceStore.getState().setServerDeafened(data.serverDeafened);
        if (data.serverMuted) useVoiceStore.getState().setIsMuted(true);
        if (data.serverDeafened) { useVoiceStore.getState().setIsDeafened(true); useVoiceStore.getState().setIsMuted(true); }
      });
    };
    socketService.onVoiceServerMute(handler);
    return () => { socketService.offVoiceServerMute(); };
  }, [connectedVoiceChannelId]);

  // Listen for being moved to a different voice channel by an admin
  useEffect(() => {
    if (!connectedVoiceChannelId) return;
    const handler = (data: { fromChannelId: string; toChannelId: string }) => {
      if (data.fromChannelId !== connectedVoiceChannelId) return;
      deferStoreUpdate(() => {
        useVoiceStore.getState().setServerMuted(false);
        useVoiceStore.getState().setServerDeafened(false);
        useVoiceStore.getState().setConnectedVoiceChannelId(data.toChannelId);
      });
      try {
        const targetServer = servers.find(s => s.channels.some(c => c.id === data.toChannelId));
        if (targetServer) {
          sessionStorage.setItem('howl_voice_channel', JSON.stringify({ serverId: targetServer.id, channelId: data.toChannelId }));
          navigate(`/channels/${targetServer.id}/${data.toChannelId}`);
        }
      } catch (err) { console.error('Failed to store voice channel after move', err); }
    };
    socketService.onVoiceMoved(handler);
    return () => { socketService.offVoiceMoved(); };
  }, [connectedVoiceChannelId, servers]);

  // Listen for server voice inactivity disconnect (alone in voice for too long)
  useEffect(() => {
    if (!connectedVoiceChannelId) return;
    const handler = (data: { channelId: string }) => {
      if (data.channelId !== connectedVoiceChannelId) return;
      voiceChannelIdRef.current = null;
      deferStoreUpdate(() => {
        useVoiceStore.getState().setConnectedVoiceChannelId(null);
        useVoiceStore.getState().setVoiceChannelParticipants([]);
        useVoiceStore.getState().setServerMuted(false);
        useVoiceStore.getState().setServerDeafened(false);
      });
      showGlobalToast('You were disconnected from voice due to inactivity.', 'warning');
    };
    socketService.onVoiceInactivityDisconnect(handler);
    return () => { socketService.offVoiceInactivityDisconnect(); };
  }, [connectedVoiceChannelId, showGlobalToast]);

  // Listen for DM call inactivity disconnect (alone in call for too long)
  useEffect(() => {
    if (!activeDmCallChannelId) return;
    const handler = (data: { dmChannelId: string }) => {
      if (data.dmChannelId !== activeDmCallChannelId) return;
      deferStoreUpdate(() => {
        setActiveDmCallChannelId(null);
        setDmCallWithVideo(false);
        setDmCallDeclinedUserIds([]);
        useVoiceStore.getState().setDmCallIsInitiator(null);
      });
      showGlobalToast('You were disconnected from the call due to inactivity.', 'warning');
    };
    socketService.onDmCallInactivityDisconnect(handler);
    return () => { socketService.offDmCallInactivityDisconnect(); };
  }, [activeDmCallChannelId, showGlobalToast]);

  // Auto-disconnect: joining a DM call while in voice (or vice versa) clears the other
  useEffect(() => {
    const handleVoiceAutoDisconnect = (_data: { channelId: string }) => {
      deferStoreUpdate(() => useVoiceStore.getState().setConnectedVoiceChannelId(null));
    };
    const handleDmCallAutoDisconnect = (_data: { dmChannelId: string }) => {
      deferStoreUpdate(() => {
        setActiveDmCallChannelId(null);
        setDmCallWithVideo(false);
        setDmCallDeclinedUserIds([]);
      });
    };
    socketService.onVoiceAutoDisconnected(handleVoiceAutoDisconnect);
    socketService.onDmCallAutoDisconnected(handleDmCallAutoDisconnect);
    return () => {
      socketService.offVoiceAutoDisconnected();
      socketService.offDmCallAutoDisconnected();
    };
  }, []);

  // Multi-device: call/voice was transferred to another device
  useEffect(() => {
    const handleCallTransferred = (data: { type: string; channelId?: string; dmChannelId?: string }) => {
      if (data.type === 'voice') {
        deferStoreUpdate(() => useVoiceStore.getState().setConnectedVoiceChannelId(null));
        showGlobalToast('Call transferred to another device.', 'info');
      } else if (data.type === 'dm-call') {
        deferStoreUpdate(() => {
          setActiveDmCallChannelId(null);
          setDmCallWithVideo(false);
          setDmCallDeclinedUserIds([]);
          useVoiceStore.getState().setDmCallIsInitiator(null);
        });
        showGlobalToast('Call transferred to another device.', 'info');
      }
    };
    const sock = socketService.getSocket();
    sock?.off('call-transferred');
    sock?.on('call-transferred', handleCallTransferred);
    const unsubSocketCreated = socketService.onSocketCreated(() => {
      const s = socketService.getSocket();
      s?.off('call-transferred');
      s?.on('call-transferred', handleCallTransferred);
    });
    return () => {
      unsubSocketCreated();
      socketService.getSocket()?.off('call-transferred');
    };
  }, [showGlobalToast]);
}
