// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef } from 'react';
import { useSettings } from '../contexts/SettingsContext';
import { useVoiceStore } from '../stores/voiceStore';
import { useServerStore } from '../stores/serverStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useMessageStore } from '../stores/messageStore';
import { useNotificationStore } from '../stores/notificationStore';
import { subscribeStreamAudioLevel } from './useAudioLevel';
import { apiClient } from '../services/api';
import type { GameOverlaySettings } from '../utils/settingsStorage';
import type { Server, Message } from '../types';

// Electron bridge type guard

const electron = (typeof window !== 'undefined' && (window as any).electron) as {
  isElectron?: true;
  setOverlayEnabled?: (enabled: boolean) => void;
  updateOverlayVoice?: (data: unknown) => void;
  updateOverlayNotifications?: (data: unknown) => void;
  updateOverlaySettings?: (settings: unknown) => void;
  updateOverlayServers?: (data: unknown) => void;
  updateOverlayMessages?: (data: unknown) => void;
  updateOverlayUnreads?: (data: unknown) => void;
  onOverlayToMain?: (callback: (channel: string, ...args: unknown[]) => void) => () => void;
} | null;

// Helpers

/** 8 deterministic gradients for server icons, hashed from ID. */
const SERVER_GRADIENTS = [
  'linear-gradient(135deg, #667eea, #764ba2)',
  'linear-gradient(135deg, #f093fb, #f5576c)',
  'linear-gradient(135deg, #4facfe, #00f2fe)',
  'linear-gradient(135deg, #43e97b, #38f9d7)',
  'linear-gradient(135deg, #fa709a, #fee140)',
  'linear-gradient(135deg, #a18cd1, #fbc2eb)',
  'linear-gradient(135deg, #fccb90, #d57eeb)',
  'linear-gradient(135deg, #e0c3fc, #8ec5fc)',
];

function serverColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return SERVER_GRADIENTS[Math.abs(hash) % SERVER_GRADIENTS.length];
}

function formatTime(timestamp: Date | string): string {
  const d = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatMessage(msg: Message) {
  return {
    id: msg.id,
    authorName: msg.authorUsername ?? 'Unknown',
    authorAvatar: msg.authorAvatar ?? undefined,
    authorColor: msg.authorNameColor ?? msg.authorRoleColor ?? undefined,
    content: msg.content,
    timestamp: formatTime(msg.timestamp),
  };
}

function formatServers(
  servers: Server[],
  activeServerId: string | null,
) {
  const notifState = useNotificationStore.getState();
  return {
    activeServerId,
    servers: servers.map(s => ({
      id: s.id,
      name: s.name,
      icon: s.icon ?? undefined,
      initial: s.name.charAt(0).toUpperCase(),
      color: serverColor(s.id),
      unreadCount: notifState.serverUnreadIds.has(s.id) ? 1 : 0,
      mentionCount: notifState.serverMentionCounts[s.id] ?? 0,
    })),
  };
}

function formatChannels(server: Server) {
  const notifState = useNotificationStore.getState();
  return server.channels.map(ch => ({
    id: ch.id,
    name: ch.name,
    type: ch.type as 'text' | 'voice' | 'stage' | 'forum',
    category: ch.categoryId ?? undefined,
    unread: notifState.channelUnreadIds.has(ch.id),
  }));
}

// Hook

/**
 * Bridge that forwards main-window Zustand state to the Electron overlay
 * window via IPC. Fire-and-forget — returns void and causes no re-renders.
 * All store subscriptions use `.subscribe()` (not selectors).
 *
 * Call once in AppLayout.
 */
export function useOverlayBridge(): void {
  const isElectron = !!electron?.isElectron;

  const { gameOverlaySettings } = useSettings();
  const settingsRef = useRef<GameOverlaySettings>(gameOverlaySettings);

  // Keep settingsRef in sync without re-subscribing effects
  useEffect(() => {
    settingsRef.current = gameOverlaySettings;
  }, [gameOverlaySettings]);

  // 1. Settings forwarding

  useEffect(() => {
    if (!isElectron) return;
    electron!.setOverlayEnabled?.(gameOverlaySettings.enabled);
  }, [isElectron, gameOverlaySettings.enabled]);

  useEffect(() => {
    if (!isElectron) return;
    electron!.updateOverlaySettings?.(gameOverlaySettings);
  }, [isElectron, gameOverlaySettings]);

  // 2. Voice state forwarding (Zustand .subscribe) + speaking detection

  useEffect(() => {
    if (!isElectron) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    // Speaking detection: subscribe to each participant's audio stream.
    // speakingSet tracks which userIds are currently speaking.
    const speakingSet = new Set<string>();
    const streamCleanups = new Map<string, () => void>();

    /** Push current voice state to the overlay. */
    function pushVoiceState() {
      const voiceState = useVoiceStore.getState();
      const channelId = voiceState.connectedVoiceChannelId ?? voiceState.connectedStageChannelId;
      const isStage = !!voiceState.connectedStageChannelId && !voiceState.connectedVoiceChannelId;

      let channelName = '';
      let serverName = '';
      if (channelId) {
        const servers = useServerStore.getState().servers;
        for (const s of servers) {
          const ch = s.channels.find(c => c.id === channelId);
          if (ch) { channelName = ch.name; serverName = s.name; break; }
        }
      }

      electron!.updateOverlayVoice?.({
        channelId,
        channelName,
        serverName,
        isStage,
        participants: voiceState.voiceChannelParticipants.map(p => ({
          userId: p.userId,
          username: p.username,
          avatar: p.avatar ?? undefined,
          isSpeaking: speakingSet.has(p.userId),
          isMuted: !!(p.isMuted || p.serverMuted),
          isDeafened: !!(p.isDeafened || p.serverDeafened),
          roleColor: p.roleColor ?? undefined,
        })),
      });
    }

    /** Sync audio level subscriptions for the current participant list. */
    function syncSpeakingSubscriptions() {
      const participants = useVoiceStore.getState().voiceChannelParticipants;
      const currentIds = new Set(participants.map(p => p.userId));

      // Remove subscriptions for departed participants
      for (const [userId, cleanup] of streamCleanups) {
        if (!currentIds.has(userId)) {
          cleanup();
          streamCleanups.delete(userId);
          speakingSet.delete(userId);
        }
      }

      // Add subscriptions for new participants
      const SPEAKING_THRESHOLD = 0.06;
      for (const p of participants) {
        if (streamCleanups.has(p.userId)) continue;
        if (!p.stream) continue;

        const uid = p.userId;
        const cleanup = subscribeStreamAudioLevel(p.stream, (level) => {
          const wasSpeaking = speakingSet.has(uid);
          const nowSpeaking = level > SPEAKING_THRESHOLD;
          if (wasSpeaking !== nowSpeaking) {
            if (nowSpeaking) speakingSet.add(uid); else speakingSet.delete(uid);
            // Debounce the push — speaking flickers fast, 100ms smooths it
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { timer = null; pushVoiceState(); }, 100);
          }
        });
        streamCleanups.set(uid, cleanup);
      }
    }

    const unsub = useVoiceStore.subscribe((state, prev) => {
      const changed =
        state.connectedVoiceChannelId !== prev.connectedVoiceChannelId ||
        state.connectedStageChannelId !== prev.connectedStageChannelId ||
        state.voiceChannelParticipants !== prev.voiceChannelParticipants ||
        state.isMuted !== prev.isMuted ||
        state.isDeafened !== prev.isDeafened;
      if (!changed) return;

      // Re-sync speaking subscriptions when participant list changes
      if (state.voiceChannelParticipants !== prev.voiceChannelParticipants) {
        syncSpeakingSubscriptions();
      }

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; pushVoiceState(); }, 100);
    });

    return () => {
      unsub();
      if (timer) clearTimeout(timer);
      // Clean up all audio level subscriptions
      for (const cleanup of streamCleanups.values()) cleanup();
      streamCleanups.clear();
      speakingSet.clear();
    };
  }, [isElectron]);

  // 3. Server + channel forwarding (Zustand .subscribe)

  useEffect(() => {
    if (!isElectron) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsub = useServerStore.subscribe((state, prev) => {
      if (state.servers === prev.servers) return;

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const { activeServerId } = useNavigationStore.getState();
        const sid = typeof activeServerId === 'string' && activeServerId !== 'home'
          && activeServerId !== 'account' && activeServerId !== 'friends'
          && activeServerId !== 'dm'
          ? activeServerId : null;
        electron!.updateOverlayServers?.(formatServers(useServerStore.getState().servers, sid));
      }, 200);
    });

    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [isElectron]);

  // 4. Navigation changes

  useEffect(() => {
    if (!isElectron) return;

    const unsub = useNavigationStore.subscribe((state, prev) => {
      if (state.activeServerId === prev.activeServerId && state.activeChannelId === prev.activeChannelId) return;

      const sid = typeof state.activeServerId === 'string' && state.activeServerId !== 'home'
        && state.activeServerId !== 'account' && state.activeServerId !== 'friends'
        && state.activeServerId !== 'dm'
        ? state.activeServerId : null;
      electron!.updateOverlayServers?.(formatServers(useServerStore.getState().servers, sid));

      // Push messages + channels for the newly active channel
      if (state.activeChannelId && state.activeChannelId !== prev.activeChannelId) {
        const msgs = useMessageStore.getState().messages[state.activeChannelId] ?? [];
        const activeServer = useServerStore.getState().servers.find(s => s.id === sid);
        electron!.updateOverlayMessages?.({
          channelId: state.activeChannelId,
          messages: msgs.slice(-50).map(formatMessage),
          channels: activeServer ? formatChannels(activeServer) : undefined,
        });
      }
    });

    return () => { unsub(); };
  }, [isElectron]);

  // 5. Message forwarding (Zustand .subscribe)

  useEffect(() => {
    if (!isElectron) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsub = useMessageStore.subscribe((state, prev) => {
      const activeChannelId = useNavigationStore.getState().activeChannelId;
      if (!activeChannelId) return;
      // Only forward if the active channel's messages changed, not any channel
      if (state.messages[activeChannelId] === prev.messages[activeChannelId]) return;

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const chId = useNavigationStore.getState().activeChannelId;
        if (!chId) return;
        const msgs = useMessageStore.getState().messages[chId] ?? [];
        electron!.updateOverlayMessages?.({
          channelId: chId,
          messages: msgs.slice(-50).map(formatMessage),
        });
      }, 100);
    });

    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [isElectron]);

  // 6. Unread/mention forwarding (Zustand .subscribe)

  useEffect(() => {
    if (!isElectron) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsub = useNotificationStore.subscribe((state, prev) => {
      if (
        state.serverUnreadIds === prev.serverUnreadIds &&
        state.serverMentionCounts === prev.serverMentionCounts &&
        state.channelUnreadIds === prev.channelUnreadIds &&
        state.dmUnreadCounts === prev.dmUnreadCounts
      ) return;

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const ns = useNotificationStore.getState();
        electron!.updateOverlayUnreads?.({
          serverUnreadIds: Array.from(ns.serverUnreadIds),
          serverMentionCounts: { ...ns.serverMentionCounts },
          channelUnreadIds: Array.from(ns.channelUnreadIds),
          dmUnreadCount: Object.values(ns.dmUnreadCounts).reduce((a, b) => a + b, 0),
        });
      }, 200);
    });

    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [isElectron]);

  // 7. Handle overlay-to-main messages

  useEffect(() => {
    if (!isElectron) return;

    const cleanup = electron!.onOverlayToMain?.((channel: string, ...args: unknown[]) => {
      switch (channel) {
        case 'send-message': {
          const data = args[0] as { channelId?: string; content?: string } | undefined;
          if (data?.channelId && data?.content?.trim()) {
            apiClient.sendChannelMessage(data.channelId, data.content.trim()).catch(() => {
              // Silently swallow — overlay doesn't have error UI yet
            });
          }
          break;
        }

        case 'switch-channel': {
          const data = args[0] as { channelId?: string } | undefined;
          if (data?.channelId) {
            useNavigationStore.getState().setActiveChannelId(data.channelId);
          }
          break;
        }

        case 'switch-server': {
          const data = args[0] as { serverId?: string } | undefined;
          if (data?.serverId) {
            const nav = useNavigationStore.getState();
            nav.setActiveServerId(data.serverId);
            // Set first text channel as active channel
            const server = useServerStore.getState().servers.find(s => s.id === data.serverId);
            if (server) {
              const firstText = server.channels.find(ch => ch.type === 'text');
              if (firstText) {
                nav.setActiveChannelId(firstText.id);
              }
            }
          }
          break;
        }
      }
    });

    return () => { cleanup?.(); };
  }, [isElectron]);

  // 8. Initial data push on mount

  useEffect(() => {
    if (!isElectron) return;

    const timer = setTimeout(() => {
      // Settings
      electron!.updateOverlaySettings?.(settingsRef.current);
      electron!.setOverlayEnabled?.(settingsRef.current.enabled);

      // Servers
      const { activeServerId, activeChannelId } = useNavigationStore.getState();
      const sid = typeof activeServerId === 'string' && activeServerId !== 'home'
        && activeServerId !== 'account' && activeServerId !== 'friends'
        && activeServerId !== 'dm'
        ? activeServerId : null;
      electron!.updateOverlayServers?.(formatServers(useServerStore.getState().servers, sid));

      // Messages + channels for current channel
      if (activeChannelId) {
        const msgs = useMessageStore.getState().messages[activeChannelId] ?? [];
        const servers = useServerStore.getState().servers;
        const activeServer = servers.find(s => s.id === sid);
        electron!.updateOverlayMessages?.({
          channelId: activeChannelId,
          messages: msgs.slice(-50).map(formatMessage),
          channels: activeServer ? formatChannels(activeServer) : undefined,
        });
      }

      // Unreads
      const ns = useNotificationStore.getState();
      electron!.updateOverlayUnreads?.({
        serverUnreadIds: Array.from(ns.serverUnreadIds),
        serverMentionCounts: { ...ns.serverMentionCounts },
        channelUnreadIds: Array.from(ns.channelUnreadIds),
        dmUnreadCount: Object.values(ns.dmUnreadCounts).reduce((a, b) => a + b, 0),
      });
    }, 1000);

    return () => { clearTimeout(timer); };
  }, [isElectron]);
}
