// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Duplicated from main app types — overlay must not import from main app
export interface OverlayVoiceParticipant {
  userId: string;
  username: string;
  avatar?: string;
  isSpeaking: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  roleColor?: string;
}

export interface OverlayVoiceState {
  channelId: string | null;
  channelName: string;
  serverName: string;
  participants: OverlayVoiceParticipant[];
  isStage: boolean;
}

export interface OverlayNotification {
  id: string;
  type: 'message' | 'welcome' | 'go-live' | 'game-activity' | 'now-playing';
  serverName?: string;
  serverIcon?: string;
  channelName?: string;
  channelId?: string;
  authorName?: string;
  authorAvatar?: string;
  content?: string;
  timestamp: number;
}

export interface OverlayServer {
  id: string;
  name: string;
  icon?: string;
  initial: string;
  color: string;
  unreadCount: number;
  mentionCount: number;
}

export interface OverlayChannel {
  id: string;
  name: string;
  type: 'text' | 'voice' | 'stage' | 'forum';
  category?: string;
  unread: boolean;
  voiceParticipantCount?: number;
}

export interface OverlayMessage {
  id: string;
  authorName: string;
  authorAvatar?: string;
  authorColor?: string;
  content: string;
  timestamp: string;
}

export interface OverlayUnreads {
  serverUnreadIds: string[];
  serverMentionCounts: Record<string, number>;
  channelUnreadIds: string[];
  dmUnreadCount: number;
}

export interface OverlaySettings {
  enabled: boolean;
  clickableRegions: boolean;
  lockKeybind: string;
  widgetMode: 'compact' | 'detailed';
  widgetCorner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  avatarSize: 'small' | 'medium' | 'large';
  displayNames: 'always' | 'speaking-only' | 'never';
  showUsers: 'always' | 'speaking-only' | 'never';
  maxUsersDisplayed: number;
  toastCorner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  toastMessages: boolean;
  toastWelcome: boolean;
  toastGoLive: boolean;
  toastGameActivity: boolean;
  toastNowPlaying: boolean;
}
