// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { StageSession } from '../../types';

interface StartStageData {
  topic?: string;
  maxSpeakers?: number;
  textChatEnabled?: boolean;
  allowEmojis?: boolean;
  allowStickers?: boolean;
  allowGifs?: boolean;
  invitedSpeakerUserIds?: string[];
  invitedRoleIds?: string[];
}

interface EditStageData {
  topic?: string;
  maxSpeakers?: number;
  textChatEnabled?: boolean;
  allowEmojis?: boolean;
  allowStickers?: boolean;
  allowGifs?: boolean;
}

declare module './core' {
  interface APIClient {
    startStage(channelId: string, serverId: string, data: StartStageData): Promise<StageSession>;
    endStage(channelId: string, serverId: string): Promise<void>;
    editStage(channelId: string, serverId: string, data: EditStageData): Promise<StageSession>;
    getStage(channelId: string, serverId: string): Promise<StageSession | null>;
    getStageHistory(channelId: string, serverId: string): Promise<StageSession[]>;
    inviteToSpeak(channelId: string, serverId: string, userId: string): Promise<void>;
    removeSpeaker(channelId: string, serverId: string, userId: string): Promise<void>;
    raiseHand(channelId: string, serverId: string): Promise<void>;
    lowerHand(channelId: string, serverId: string, userId?: string): Promise<void>;
    acceptHandRaise(channelId: string, serverId: string, userId: string): Promise<void>;
    joinStageAsSpeaker(channelId: string, serverId: string): Promise<void>;
    moveToAudience(channelId: string, serverId: string): Promise<void>;
  }
}

APIClient.prototype.startStage = async function(this: APIClient, channelId: string, serverId: string, data: StartStageData): Promise<StageSession> {
  return this.request<StageSession>(`/servers/${serverId}/channels/${channelId}/stage/start`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.endStage = async function(this: APIClient, channelId: string, serverId: string): Promise<void> {
  await this.request<void>(`/servers/${serverId}/channels/${channelId}/stage/end`, { method: 'POST' });
};

APIClient.prototype.editStage = async function(this: APIClient, channelId: string, serverId: string, data: EditStageData): Promise<StageSession> {
  return this.request<StageSession>(`/servers/${serverId}/channels/${channelId}/stage`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.getStage = async function(this: APIClient, channelId: string, serverId: string): Promise<StageSession | null> {
  return this.request<StageSession | null>(`/servers/${serverId}/channels/${channelId}/stage`);
};

APIClient.prototype.getStageHistory = async function(this: APIClient, channelId: string, serverId: string): Promise<StageSession[]> {
  return this.request<StageSession[]>(`/servers/${serverId}/channels/${channelId}/stage/history`);
};

APIClient.prototype.inviteToSpeak = async function(this: APIClient, channelId: string, serverId: string, userId: string): Promise<void> {
  await this.request<void>(`/servers/${serverId}/channels/${channelId}/stage/speakers/invite`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
};

APIClient.prototype.removeSpeaker = async function(this: APIClient, channelId: string, serverId: string, userId: string): Promise<void> {
  await this.request<void>(`/servers/${serverId}/channels/${channelId}/stage/speakers/remove`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
};

APIClient.prototype.raiseHand = async function(this: APIClient, channelId: string, serverId: string): Promise<void> {
  await this.request<void>(`/servers/${serverId}/channels/${channelId}/stage/hand/raise`, { method: 'POST' });
};

APIClient.prototype.lowerHand = async function(this: APIClient, channelId: string, serverId: string, userId?: string): Promise<void> {
  await this.request<void>(`/servers/${serverId}/channels/${channelId}/stage/hand/lower`, {
    method: 'POST',
    body: JSON.stringify(userId ? { userId } : {}),
  });
};

APIClient.prototype.acceptHandRaise = async function(this: APIClient, channelId: string, serverId: string, userId: string): Promise<void> {
  await this.request<void>(`/servers/${serverId}/channels/${channelId}/stage/hand/accept`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
};

APIClient.prototype.joinStageAsSpeaker = async function(this: APIClient, channelId: string, serverId: string): Promise<void> {
  await this.request<void>(`/servers/${serverId}/channels/${channelId}/stage/join-as-speaker`, { method: 'POST' });
};

APIClient.prototype.moveToAudience = async function(this: APIClient, channelId: string, serverId: string): Promise<void> {
  await this.request<void>(`/servers/${serverId}/channels/${channelId}/stage/move-to-audience`, { method: 'POST' });
};
