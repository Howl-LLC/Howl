// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';
import type { Message } from '../../types';
import { normalizeMessage as normalizeMessageRaw } from '../messageNormalizer';
import type { SocketNewMessagePayload } from './types';

function toMessage(p: SocketNewMessagePayload): Message {
  const msg = normalizeMessageRaw(p);
  // Channel messages default authorRoleStyle to 'solid' (DM messages leave it undefined)
  msg.authorRoleStyle = (p.authorRoleStyle as Message['authorRoleStyle']) ?? 'solid';
  return msg;
}

declare module './core' {
  interface SocketService {
    onNewMessage(callback: (channelId: string, message: Message) => void): void;
    offNewMessage(): void;
    onChannelMessagePinned(callback: (channelId: string, messageId: string) => void): void;
    offChannelMessagePinned(): void;
    onChannelMessageUnpinned(callback: (channelId: string, messageId: string) => void): void;
    offChannelMessageUnpinned(): void;
    onChannelMessageDeleted(callback: (channelId: string, messageId: string) => void): void;
    offChannelMessageDeleted(): void;
    onChannelMessageUpdated(callback: (channelId: string, messageId: string, content: string, editedAt: string) => void): void;
    offChannelMessageUpdated(): void;
    onMessageReactionUpdate(callback: (channelId: string, messageId: string, reactions: Array<{ emoji: string; userIds: string[] }>) => void): void;
    offMessageReactionUpdate(): void;
    onServerMemberProfileUpdated(callback: (payload: { userId: string; serverId: string; nickname: string | null; serverAvatar: string | null; serverBanner: string | null }) => void): void;
    offServerMemberProfileUpdated(): void;
    onUserTyping(callback: (payload: { channelId?: string; dmChannelId?: string; serverId?: string; userId: string; username: string }) => void): void;
    offUserTyping(): void;
    onForumPostTyping(callback: (payload: { serverId: string; channelId: string; postId: string; userId: string }) => void): void;
    offForumPostTyping(): void;
    onCategoryCreated(callback: (payload: { serverId: string; category: { id: string; name: string; position: number } }) => void): void;
    offCategoryCreated(): void;
    onCategoryUpdated(callback: (payload: { serverId: string; category: { id: string; name: string; position: number } }) => void): void;
    offCategoryUpdated(): void;
    onCategoryDeleted(callback: (payload: { serverId: string; categoryId: string }) => void): void;
    offCategoryDeleted(): void;
    onChannelsReordered(callback: (payload: { serverId: string; channels: Array<{ id: string; position: number; categoryId: string | null }> }) => void): void;
    offChannelsReordered(): void;
    onCategoriesReordered(callback: (payload: { serverId: string; categories: Array<{ id: string; position: number }> }) => void): void;
    offCategoriesReordered(): void;
    onChannelCreated(callback: (payload: { serverId: string; channel: { id: string; name: string; description?: string; type: string; categoryId: string | null; position: number } }) => void): void;
    offChannelCreated(): void;
    onChannelUpdatedMeta(callback: (payload: { serverId: string; channel: { id: string; name: string; description?: string; type: string; categoryId: string | null; position: number } }) => void): void;
    offChannelUpdatedMeta(): void;
    onChannelDeleted(callback: (payload: { serverId: string; channelId: string }) => void): void;
    offChannelDeleted(): void;
    onChannelPermissionsUpdated(callback: (payload: { serverId: string }) => void): void;
    offChannelPermissionsUpdated(): void;
    onCategoryPermissionsUpdated(callback: (payload: { serverId: string }) => void): void;
    offCategoryPermissionsUpdated(): void;
  }
}

SocketService.prototype.onNewMessage = function(this: SocketService, callback: (channelId: string, message: Message) => void) {
  if (!this.socket) return;
  this.socket.off('new-message');
  this.socket.on('new-message', (payload: SocketNewMessagePayload) => {
    callback(payload.channelId, toMessage(payload));
  });
};

SocketService.prototype.offNewMessage = function(this: SocketService) {
  this.socket?.off('new-message');
};

SocketService.prototype.onChannelMessagePinned = function(this: SocketService, callback: (channelId: string, messageId: string) => void) {
  if (!this.socket) return;
  this.socket.off('channel-message-pinned');
  this.socket.on('channel-message-pinned', (payload: { channelId: string; messageId: string }) => {
    callback(payload.channelId, payload.messageId);
  });
};

SocketService.prototype.offChannelMessagePinned = function(this: SocketService) {
  this.socket?.off('channel-message-pinned');
};

SocketService.prototype.onChannelMessageUnpinned = function(this: SocketService, callback: (channelId: string, messageId: string) => void) {
  if (!this.socket) return;
  this.socket.off('channel-message-unpinned');
  this.socket.on('channel-message-unpinned', (payload: { channelId: string; messageId: string }) => {
    callback(payload.channelId, payload.messageId);
  });
};

SocketService.prototype.offChannelMessageUnpinned = function(this: SocketService) {
  this.socket?.off('channel-message-unpinned');
};

SocketService.prototype.onChannelMessageDeleted = function(this: SocketService, callback: (channelId: string, messageId: string) => void) {
  if (!this.socket) return;
  this.socket.off('message-deleted');
  this.socket.on('message-deleted', (payload: { channelId: string; messageId: string }) => {
    callback(payload.channelId, payload.messageId);
  });
};

SocketService.prototype.offChannelMessageDeleted = function(this: SocketService) {
  this.socket?.off('message-deleted');
};

SocketService.prototype.onChannelMessageUpdated = function(this: SocketService, callback: (channelId: string, messageId: string, content: string, editedAt: string) => void) {
  if (!this.socket) return;
  this.socket.off('message-updated');
  this.socket.on('message-updated', (payload: { channelId: string; messageId: string; content: string; editedAt: string }) => {
    callback(payload.channelId, payload.messageId, payload.content, payload.editedAt);
  });
};

SocketService.prototype.offChannelMessageUpdated = function(this: SocketService) {
  this.socket?.off('message-updated');
};

SocketService.prototype.onMessageReactionUpdate = function(this: SocketService, callback: (channelId: string, messageId: string, reactions: Array<{ emoji: string; userIds: string[] }>) => void) {
  if (!this.socket) return;
  this.socket.off('message-reaction-update');
  this.socket.on('message-reaction-update', (payload: { channelId: string; messageId: string; reactions: Array<{ emoji: string; userIds: string[] }> }) => {
    callback(payload.channelId, payload.messageId, payload.reactions);
  });
};

SocketService.prototype.offMessageReactionUpdate = function(this: SocketService) {
  this.socket?.off('message-reaction-update');
};

SocketService.prototype.onServerMemberProfileUpdated = function(this: SocketService, callback: (payload: { userId: string; serverId: string; nickname: string | null; serverAvatar: string | null; serverBanner: string | null }) => void) {
  if (!this.socket) return;
  this.socket.off('server-member-profile-updated');
  this.socket.on('server-member-profile-updated', callback);
};

SocketService.prototype.offServerMemberProfileUpdated = function(this: SocketService) {
  this.socket?.off('server-member-profile-updated');
};

SocketService.prototype.onUserTyping = function(this: SocketService, callback: (payload: { channelId?: string; dmChannelId?: string; serverId?: string; userId: string; username: string }) => void) {
  this.socket?.off('user-typing');
  this.socket?.on('user-typing', callback);
};

SocketService.prototype.offUserTyping = function(this: SocketService) {
  this.socket?.off('user-typing');
};

SocketService.prototype.onForumPostTyping = function(this: SocketService, callback: (payload: { serverId: string; channelId: string; postId: string; userId: string }) => void) {
  this.socket?.off('forum-post-typing');
  this.socket?.on('forum-post-typing', callback);
};

SocketService.prototype.offForumPostTyping = function(this: SocketService) {
  this.socket?.off('forum-post-typing');
};

SocketService.prototype.onCategoryCreated = function(this: SocketService, callback) {
  this.socket?.off('category-created');
  this.socket?.on('category-created', callback);
};
SocketService.prototype.offCategoryCreated = function(this: SocketService) {
  this.socket?.off('category-created');
};

SocketService.prototype.onCategoryUpdated = function(this: SocketService, callback) {
  this.socket?.off('category-updated');
  this.socket?.on('category-updated', callback);
};
SocketService.prototype.offCategoryUpdated = function(this: SocketService) {
  this.socket?.off('category-updated');
};

SocketService.prototype.onCategoryDeleted = function(this: SocketService, callback) {
  this.socket?.off('category-deleted');
  this.socket?.on('category-deleted', callback);
};
SocketService.prototype.offCategoryDeleted = function(this: SocketService) {
  this.socket?.off('category-deleted');
};

SocketService.prototype.onChannelsReordered = function(this: SocketService, callback) {
  this.socket?.off('channels-reordered');
  this.socket?.on('channels-reordered', callback);
};
SocketService.prototype.offChannelsReordered = function(this: SocketService) {
  this.socket?.off('channels-reordered');
};

SocketService.prototype.onCategoriesReordered = function(this: SocketService, callback) {
  this.socket?.off('categories-reordered');
  this.socket?.on('categories-reordered', callback);
};
SocketService.prototype.offCategoriesReordered = function(this: SocketService) {
  this.socket?.off('categories-reordered');
};

SocketService.prototype.onChannelCreated = function(this: SocketService, callback) {
  this.socket?.off('channel-created');
  this.socket?.on('channel-created', callback);
};
SocketService.prototype.offChannelCreated = function(this: SocketService) {
  this.socket?.off('channel-created');
};

SocketService.prototype.onChannelUpdatedMeta = function(this: SocketService, callback) {
  this.socket?.off('channel-updated-meta');
  this.socket?.on('channel-updated-meta', callback);
};
SocketService.prototype.offChannelUpdatedMeta = function(this: SocketService) {
  this.socket?.off('channel-updated-meta');
};

SocketService.prototype.onChannelDeleted = function(this: SocketService, callback) {
  this.socket?.off('channel-deleted');
  this.socket?.on('channel-deleted', callback);
};
SocketService.prototype.offChannelDeleted = function(this: SocketService) {
  this.socket?.off('channel-deleted');
};

SocketService.prototype.onChannelPermissionsUpdated = function(this: SocketService, callback) {
  this.socket?.off('channel-permissions-updated');
  this.socket?.on('channel-permissions-updated', callback);
};
SocketService.prototype.offChannelPermissionsUpdated = function(this: SocketService) {
  this.socket?.off('channel-permissions-updated');
};

SocketService.prototype.onCategoryPermissionsUpdated = function(this: SocketService, callback) {
  this.socket?.off('category-permissions-updated');
  this.socket?.on('category-permissions-updated', callback);
};
SocketService.prototype.offCategoryPermissionsUpdated = function(this: SocketService) {
  this.socket?.off('category-permissions-updated');
};
