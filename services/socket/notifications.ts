// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';

declare module './core' {
  interface SocketService {
    onNotificationCreated(callback: (notification: {
      id?: string; serverId?: string; channelId?: string; threadId?: string;
      type: string; title: string; body?: string;
      metadata?: Record<string, unknown>; createdAt: string;
    }) => void): void;
    offNotificationCreated(): void;

    onCalendarActivity(callback: (data: {
      serverId: string;
      type: 'change' | 'soon' | 'live' | 'ended';
      eventId: string;
      eventTitle?: string;
      startTime?: string;
    }) => void): void;
    offCalendarActivity(): void;

    onDmMention(callback: (data: {
      dmChannelId: string;
      mentionUserIds: string[];
    }) => void): void;
    offDmMention(): void;

    onNotificationReadSync(callback: (data: {
      notificationId?: string;
      serverId?: string | null;
      all?: boolean;
    }) => void): void;
    offNotificationReadSync(): void;

    onNotificationDeleteSync(callback: (data: {
      serverId?: string | null;
      all?: boolean;
      deletedCount: number;
    }) => void): void;
    offNotificationDeleteSync(): void;

    onChannelReadState(callback: (data: {
      channelId: string;
      lastReadAt: string;
      markedUnread?: boolean;
      mentionCount?: number;
    }) => void): void;
    offChannelReadState(): void;

    onDmReadState(callback: (data: {
      dmChannelId: string;
      lastReadAt: string;
      markedUnread?: boolean;
      mentionCount?: number;
    }) => void): void;
    offDmReadState(): void;
  }
}

SocketService.prototype.onNotificationCreated = function(this: SocketService, callback) {
  this.socket?.off('notification-created');
  this.socket?.on('notification-created', callback);
};
SocketService.prototype.offNotificationCreated = function(this: SocketService) {
  this.socket?.off('notification-created');
};

SocketService.prototype.onCalendarActivity = function(this: SocketService, callback) {
  this.socket?.off('calendar-activity');
  this.socket?.on('calendar-activity', callback);
};
SocketService.prototype.offCalendarActivity = function(this: SocketService) {
  this.socket?.off('calendar-activity');
};

SocketService.prototype.onDmMention = function(this: SocketService, callback) {
  this.socket?.off('dm-mention');
  this.socket?.on('dm-mention', callback);
};
SocketService.prototype.offDmMention = function(this: SocketService) {
  this.socket?.off('dm-mention');
};

SocketService.prototype.onNotificationReadSync = function(this: SocketService, callback) {
  this.socket?.off('notification-read-sync');
  this.socket?.on('notification-read-sync', callback);
};
SocketService.prototype.offNotificationReadSync = function(this: SocketService) {
  this.socket?.off('notification-read-sync');
};

SocketService.prototype.onNotificationDeleteSync = function(this: SocketService, callback) {
  this.socket?.off('notification-delete-sync');
  this.socket?.on('notification-delete-sync', callback);
};
SocketService.prototype.offNotificationDeleteSync = function(this: SocketService) {
  this.socket?.off('notification-delete-sync');
};

SocketService.prototype.onChannelReadState = function(this: SocketService, callback) {
  this.socket?.off('channel-read-state');
  this.socket?.on('channel-read-state', callback);
};
SocketService.prototype.offChannelReadState = function(this: SocketService) {
  this.socket?.off('channel-read-state');
};

SocketService.prototype.onDmReadState = function(this: SocketService, callback) {
  this.socket?.off('dm-read-state');
  this.socket?.on('dm-read-state', callback);
};
SocketService.prototype.offDmReadState = function(this: SocketService) {
  this.socket?.off('dm-read-state');
};
