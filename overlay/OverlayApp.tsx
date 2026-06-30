// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect, useCallback, useRef } from 'react';
import { VoiceWidget } from './VoiceWidget';
import { OverlayToastManager } from './OverlayToastManager';
import { LockedOverlay } from './LockedOverlay';
import type {
  OverlaySettings, OverlayVoiceState, OverlayNotification,
  OverlayServer, OverlayChannel, OverlayMessage, OverlayUnreads,
} from './types';

declare global {
  interface Window {
    overlayBridge?: {
      toggleLock: (locked: boolean) => void;
      show: () => void;
      hide: () => void;
      sendToMain: (channel: string, ...args: unknown[]) => void;
      onVoiceUpdate: (cb: (data: unknown) => void) => () => void;
      onNotification: (cb: (data: unknown) => void) => () => void;
      onSettingsChanged: (cb: (settings: unknown) => void) => () => void;
      onServersUpdate: (cb: (data: unknown) => void) => () => void;
      onMessagesUpdate: (cb: (data: unknown) => void) => () => void;
      onUnreadsUpdate: (cb: (data: unknown) => void) => () => void;
      onGameDetected: (cb: (game: unknown) => void) => () => void;
      onGameCleared: (cb: () => void) => () => void;
    };
  }
}

const DEFAULT_SETTINGS: OverlaySettings = {
  enabled: true, clickableRegions: true, lockKeybind: 'SHIFT+BACKQUOTE',
  widgetMode: 'detailed', widgetCorner: 'top-left',
  avatarSize: 'medium', displayNames: 'always', showUsers: 'always',
  maxUsersDisplayed: 8, toastCorner: 'bottom-right',
  toastMessages: true, toastWelcome: true, toastGoLive: true,
  toastGameActivity: true, toastNowPlaying: true,
};

export function OverlayApp() {
  const [isLocked, setIsLocked] = useState(false);
  const [gameDetected, setGameDetected] = useState(false);
  const [settings, setSettings] = useState<OverlaySettings>(DEFAULT_SETTINGS);
  const [voiceState, setVoiceState] = useState<OverlayVoiceState | null>(null);
  const [notifications, setNotifications] = useState<OverlayNotification[]>([]);
  const [servers, setServers] = useState<OverlayServer[]>([]);
  const [channels, setChannels] = useState<OverlayChannel[]>([]);
  const [messages, setMessages] = useState<OverlayMessage[]>([]);
  const [unreads, setUnreads] = useState<OverlayUnreads | null>(null);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);

  // Refs for accessing current values in event handlers without re-subscribing
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const isLockedRef = useRef(isLocked);
  isLockedRef.current = isLocked;

  // IPC Listeners
  useEffect(() => {
    const bridge = window.overlayBridge;
    if (!bridge) return;
    const cleanups: Array<() => void> = [];

    cleanups.push(bridge.onGameDetected(() => setGameDetected(true)));
    cleanups.push(bridge.onGameCleared(() => {
      setGameDetected(false);
      if (isLockedRef.current) {
        setIsLocked(false);
        bridge.toggleLock(false);
      }
    }));
    cleanups.push(bridge.onSettingsChanged((s) => setSettings(s as OverlaySettings)));
    cleanups.push(bridge.onVoiceUpdate((d) => setVoiceState(d as OverlayVoiceState | null)));
    cleanups.push(bridge.onNotification((d) => {
      const notif = d as OverlayNotification;
      const s = settingsRef.current;
      if (notif.type === 'message' && !s.toastMessages) return;
      if (notif.type === 'welcome' && !s.toastWelcome) return;
      if (notif.type === 'go-live' && !s.toastGoLive) return;
      if (notif.type === 'game-activity' && !s.toastGameActivity) return;
      if (notif.type === 'now-playing' && !s.toastNowPlaying) return;
      setNotifications(prev => [...prev.slice(-4), notif]); // max 5
    }));
    cleanups.push(bridge.onServersUpdate((d) => {
      const data = d as { servers: OverlayServer[]; activeServerId?: string };
      setServers(data.servers);
      if (data.activeServerId) setActiveServerId(data.activeServerId);
    }));
    cleanups.push(bridge.onMessagesUpdate((d) => {
      const data = d as { channelId: string; messages: OverlayMessage[]; channels?: OverlayChannel[] };
      setMessages(data.messages);
      setActiveChannelId(data.channelId);
      if (data.channels) setChannels(data.channels);
    }));
    cleanups.push(bridge.onUnreadsUpdate((d) => setUnreads(d as OverlayUnreads)));

    return () => cleanups.forEach(fn => fn());
  }, []);

  // Keybind Listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const keybind = settingsRef.current.lockKeybind;
      if (!keybind) return;

      const parts = keybind.toUpperCase().split('+');
      const key = parts[parts.length - 1];
      const needShift = parts.includes('SHIFT');
      const needCtrl = parts.includes('CTRL') || parts.includes('CONTROL');
      const needAlt = parts.includes('ALT');

      const keyMap: Record<string, string> = {
        'BACKQUOTE': '`', 'TILDE': '`', 'ESCAPE': 'ESCAPE',
        'TAB': 'TAB', 'SPACE': ' ',
      };
      const expectedKey = keyMap[key] || key;
      const actualKey = e.key.toUpperCase();
      const actualCode = e.code.toUpperCase();

      const keyMatch = actualKey === expectedKey ||
        actualCode === key ||
        actualCode === `KEY${key}` ||
        actualCode === `DIGIT${key}`;

      if (keyMatch &&
        e.shiftKey === needShift &&
        e.ctrlKey === needCtrl &&
        e.altKey === needAlt
      ) {
        e.preventDefault();
        e.stopPropagation();
        const newLocked = !isLockedRef.current;
        setIsLocked(newLocked);
        window.overlayBridge?.toggleLock(newLocked);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  // Toast Dismissal
  const dismissToast = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  // Auto-dismiss toasts after 5s
  useEffect(() => {
    if (notifications.length === 0) return;
    const oldest = notifications[0];
    const age = Date.now() - oldest.timestamp;
    const remaining = Math.min(5000, Math.max(0, 5000 - age));
    const timer = setTimeout(() => {
      setNotifications(prev => prev.slice(1));
    }, remaining);
    return () => clearTimeout(timer);
  }, [notifications]);

  // IPC actions from child components
  const handleSendMessage = useCallback((channelId: string, content: string) => {
    window.overlayBridge?.sendToMain('send-message', { channelId, content });
  }, []);

  const handleSwitchChannel = useCallback((channelId: string) => {
    setActiveChannelId(channelId);
    window.overlayBridge?.sendToMain('switch-channel', { channelId });
  }, []);

  const handleSwitchServer = useCallback((serverId: string) => {
    setActiveServerId(serverId);
    window.overlayBridge?.sendToMain('switch-server', { serverId });
  }, []);

  const handleToastReply = useCallback((channelId: string, content: string) => {
    window.overlayBridge?.sendToMain('send-message', { channelId, content });
  }, []);

  if (!gameDetected) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0,
      pointerEvents: isLocked ? 'auto' : 'none',
    }}>
      {/* Voice Widget — always visible when in voice */}
      {voiceState?.channelId && (
        <VoiceWidget voiceState={voiceState} settings={settings} />
      )}

      {/* Notification Toasts — visible when unlocked */}
      {!isLocked && notifications.length > 0 && (
        <OverlayToastManager
          notifications={notifications}
          corner={settings.toastCorner}
          clickableRegions={settings.clickableRegions}
          onDismiss={dismissToast}
          onReply={handleToastReply}
        />
      )}

      {/* Locked Overlay — full chat panel */}
      {isLocked && (
        <LockedOverlay
          servers={servers}
          channels={channels}
          messages={messages}
          unreads={unreads}
          voiceState={voiceState}
          activeServerId={activeServerId}
          activeChannelId={activeChannelId}
          lockKeybind={settings.lockKeybind}
          onSwitchServer={handleSwitchServer}
          onSwitchChannel={handleSwitchChannel}
          onSendMessage={handleSendMessage}
        />
      )}
    </div>
  );
}
