// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';
import type { Message } from '../../types';
import { normalizeMessage as normalizeMessageRaw } from '../messageNormalizer';
import type { SocketDMMessagePayload, SocketDMSystemPayload, SocketNewDmChannelPayload, SocketOtrMessagePayload, SocketOtrEndedPayload } from '../socketTypes';

declare module './core' {
  interface SocketService {
    onNewDMMessage(callback: (dmChannelId: string, message: Message, encrypted: boolean) => void): void;
    offNewDMMessage(): void;
    onDMMessageDeleted(callback: (dmChannelId: string, messageId: string) => void): void;
    offDMMessageDeleted(): void;
    onDMMessageUpdated(callback: (dmChannelId: string, messageId: string, content: string, editedAt: string, encrypted: boolean, authorId?: string) => void): void;
    offDMMessageUpdated(): void;
    onDmSystemMessage(callback: (dmChannelId: string, message: Message) => void): void;
    offDmSystemMessage(): void;
    onDmSystemMessageUpdated(callback: (data: { id: string; dmChannelId: string; systemPayload: Record<string, unknown> }) => void): void;
    offDmSystemMessageUpdated(): void;
    onDmMessagePinned(callback: (dmChannelId: string, messageId: string) => void): void;
    offDmMessagePinned(): void;
    onDmMessageUnpinned(callback: (dmChannelId: string, messageId: string) => void): void;
    offDmMessageUnpinned(): void;
    onDmMessageReactionUpdate(callback: (dmChannelId: string, messageId: string, reactions: Array<{ emoji: string; userIds: string[] }>) => void): void;
    offDmMessageReactionUpdate(): void;
    onDmBlocked(callback: (payload: { dmChannelIds: string[]; blockerId: string }) => void): void;
    offDmBlocked(): void;
    onDmUnblocked(callback: (payload: { dmChannelIds: string[] }) => void): void;
    offDmUnblocked(): void;
    onNewDmChannel(callback: (data: SocketNewDmChannelPayload) => void): void;
    offNewDmChannel(): void;
    onDmParticipantLeft(callback: (data: { dmChannelId: string; userId: string }) => void): void;
    offDmParticipantLeft(): void;
    onDmRemovedFromGroup(cb: (data: { dmChannelId: string }) => void): void;
    offDmRemovedFromGroup(): void;
    onDmParticipantRemoved(cb: (data: { dmChannelId: string; userId: string }) => void): void;
    offDmParticipantRemoved(): void;
    onDmGroupOwnerChanged(cb: (data: { dmChannelId: string; ownerId: string }) => void): void;
    offDmGroupOwnerChanged(): void;
    onDmParticipantsAdded(callback: (data: { dmChannelId: string; newMembers: Array<{ id: string; username: string; discriminator?: string; avatar?: string | null; status?: string }> }) => void): void;
    offDmParticipantsAdded(): void;
    onDmEncryptionUpgraded(callback: (data: { dmChannelId: string }) => void): void;
    offDmEncryptionUpgraded(): void;
    onDmGroupUpdated(callback: (data: { dmChannelId: string; name?: string; icon?: string }) => void): void;
    offDmGroupUpdated(): void;
    onOtrMessage(callback: (payload: SocketOtrMessagePayload) => void): void;
    offOtrMessage(): void;
    onOtrEnded(callback: (payload: SocketOtrEndedPayload) => void): void;
    offOtrEnded(): void;
  }
}

SocketService.prototype.onNewDMMessage = function(this: SocketService, callback: (dmChannelId: string, message: Message, encrypted: boolean) => void) {
  if (!this.socket) return;
  this.socket.off('new-dm-message');
  this.socket.on('new-dm-message', (payload: SocketDMMessagePayload) => {
    callback(payload.dmChannelId, normalizeMessageRaw(payload), payload.encrypted ?? false);
  });
};

SocketService.prototype.offNewDMMessage = function(this: SocketService) {
  this.socket?.off('new-dm-message');
};

SocketService.prototype.onDMMessageDeleted = function(this: SocketService, callback: (dmChannelId: string, messageId: string) => void) {
  if (!this.socket) return;
  this.socket.off('dm-message-deleted');
  this.socket.on('dm-message-deleted', (payload: { dmChannelId: string; messageId: string }) => {
    callback(payload.dmChannelId, payload.messageId);
  });
};

SocketService.prototype.offDMMessageDeleted = function(this: SocketService) {
  this.socket?.off('dm-message-deleted');
};

SocketService.prototype.onDMMessageUpdated = function(this: SocketService, callback: (dmChannelId: string, messageId: string, content: string, editedAt: string, encrypted: boolean, authorId?: string) => void) {
  if (!this.socket) return;
  this.socket.off('dm-message-updated');
  this.socket.on('dm-message-updated', (payload: { dmChannelId: string; messageId: string; content: string; editedAt: string; encrypted?: boolean; authorId?: string }) => {
    callback(payload.dmChannelId, payload.messageId, payload.content, payload.editedAt, payload.encrypted ?? false, payload.authorId);
  });
};

SocketService.prototype.offDMMessageUpdated = function(this: SocketService) {
  this.socket?.off('dm-message-updated');
};

SocketService.prototype.onDmSystemMessage = function(this: SocketService, callback: (dmChannelId: string, message: Message) => void) {
  if (!this.socket) return;
  this.socket.off('dm-system-message');
  this.socket.on('dm-system-message', (payload: SocketDMSystemPayload) => {
    callback(payload.dmChannelId, normalizeMessageRaw(payload));
  });
};

SocketService.prototype.offDmSystemMessage = function(this: SocketService) {
  this.socket?.off('dm-system-message');
};

SocketService.prototype.onDmSystemMessageUpdated = function(this: SocketService, callback: (data: { id: string; dmChannelId: string; systemPayload: Record<string, unknown> }) => void) {
  if (!this.socket) return;
  this.socket.off('dm-system-message-updated');
  this.socket.on('dm-system-message-updated', (payload: { id: string; dmChannelId: string; systemPayload: Record<string, unknown> }) => {
    callback(payload);
  });
};

SocketService.prototype.offDmSystemMessageUpdated = function(this: SocketService) {
  this.socket?.off('dm-system-message-updated');
};

SocketService.prototype.onDmMessagePinned = function(this: SocketService, callback: (dmChannelId: string, messageId: string) => void) {
  if (!this.socket) return;
  this.socket.off('dm-message-pinned');
  this.socket.on('dm-message-pinned', (payload: { dmChannelId: string; messageId: string }) => {
    callback(payload.dmChannelId, payload.messageId);
  });
};

SocketService.prototype.offDmMessagePinned = function(this: SocketService) {
  this.socket?.off('dm-message-pinned');
};

SocketService.prototype.onDmMessageUnpinned = function(this: SocketService, callback: (dmChannelId: string, messageId: string) => void) {
  if (!this.socket) return;
  this.socket.off('dm-message-unpinned');
  this.socket.on('dm-message-unpinned', (payload: { dmChannelId: string; messageId: string }) => {
    callback(payload.dmChannelId, payload.messageId);
  });
};

SocketService.prototype.offDmMessageUnpinned = function(this: SocketService) {
  this.socket?.off('dm-message-unpinned');
};

SocketService.prototype.onDmMessageReactionUpdate = function(this: SocketService, callback: (dmChannelId: string, messageId: string, reactions: Array<{ emoji: string; userIds: string[] }>) => void) {
  if (!this.socket) return;
  this.socket.off('dm-message-reaction-update');
  this.socket.on('dm-message-reaction-update', (payload: { dmChannelId: string; messageId: string; reactions: Array<{ emoji: string; userIds: string[] }> }) => {
    callback(payload.dmChannelId, payload.messageId, payload.reactions);
  });
};

SocketService.prototype.offDmMessageReactionUpdate = function(this: SocketService) {
  this.socket?.off('dm-message-reaction-update');
};

SocketService.prototype.onDmBlocked = function(this: SocketService, callback: (payload: { dmChannelIds: string[]; blockerId: string }) => void) {
  this.socket?.off('dm-blocked');
  this.socket?.on('dm-blocked', callback);
};

SocketService.prototype.offDmBlocked = function(this: SocketService) {
  this.socket?.off('dm-blocked');
};

SocketService.prototype.onDmUnblocked = function(this: SocketService, callback: (payload: { dmChannelIds: string[] }) => void) {
  this.socket?.off('dm-unblocked');
  this.socket?.on('dm-unblocked', callback);
};

SocketService.prototype.offDmUnblocked = function(this: SocketService) {
  this.socket?.off('dm-unblocked');
};

SocketService.prototype.onNewDmChannel = function(this: SocketService, callback: (data: SocketNewDmChannelPayload) => void) {
  this.socket?.off('new-dm-channel');
  this.socket?.on('new-dm-channel', callback);
};

SocketService.prototype.offNewDmChannel = function(this: SocketService) {
  this.socket?.off('new-dm-channel');
};

SocketService.prototype.onDmParticipantLeft = function(this: SocketService, callback: (data: { dmChannelId: string; userId: string }) => void) {
  this.socket?.off('dm-participant-left');
  this.socket?.on('dm-participant-left', callback);
};

SocketService.prototype.offDmParticipantLeft = function(this: SocketService) {
  this.socket?.off('dm-participant-left');
};

SocketService.prototype.onDmRemovedFromGroup = function(this: SocketService, cb: (data: { dmChannelId: string }) => void) {
  this.socket?.off('dm-removed-from-group');
  this.socket?.on('dm-removed-from-group', cb);
};

SocketService.prototype.offDmRemovedFromGroup = function(this: SocketService) {
  this.socket?.off('dm-removed-from-group');
};

SocketService.prototype.onDmParticipantRemoved = function(this: SocketService, cb: (data: { dmChannelId: string; userId: string }) => void) {
  this.socket?.off('dm-participant-removed');
  this.socket?.on('dm-participant-removed', cb);
};

SocketService.prototype.offDmParticipantRemoved = function(this: SocketService) {
  this.socket?.off('dm-participant-removed');
};

SocketService.prototype.onDmGroupOwnerChanged = function(this: SocketService, cb: (data: { dmChannelId: string; ownerId: string }) => void) {
  this.socket?.off('dm-group-owner-changed');
  this.socket?.on('dm-group-owner-changed', cb);
};

SocketService.prototype.offDmGroupOwnerChanged = function(this: SocketService) {
  this.socket?.off('dm-group-owner-changed');
};

SocketService.prototype.onDmParticipantsAdded = function(this: SocketService, callback: (data: { dmChannelId: string; newMembers: Array<{ id: string; username: string; discriminator?: string; avatar?: string | null; status?: string }> }) => void) {
  this.socket?.off('dm-participants-added');
  this.socket?.on('dm-participants-added', callback);
};

SocketService.prototype.offDmParticipantsAdded = function(this: SocketService) {
  this.socket?.off('dm-participants-added');
};

SocketService.prototype.onDmEncryptionUpgraded = function(this: SocketService, callback: (data: { dmChannelId: string }) => void) {
  this.socket?.off('dm-encryption-upgraded');
  this.socket?.on('dm-encryption-upgraded', callback);
};

SocketService.prototype.offDmEncryptionUpgraded = function(this: SocketService) {
  this.socket?.off('dm-encryption-upgraded');
};

SocketService.prototype.onDmGroupUpdated = function(this: SocketService, callback: (data: { dmChannelId: string; name?: string; icon?: string }) => void) {
  this.socket?.off('dm-group-updated');
  this.socket?.on('dm-group-updated', callback);
};

SocketService.prototype.offDmGroupUpdated = function(this: SocketService) {
  this.socket?.off('dm-group-updated');
};

SocketService.prototype.onOtrMessage = function(this: SocketService, callback: (payload: SocketOtrMessagePayload) => void) {
  if (!this.socket) return;
  this.socket.off('otr-message');
  this.socket.on('otr-message', (payload: SocketOtrMessagePayload) => callback(payload));
};

SocketService.prototype.offOtrMessage = function(this: SocketService) {
  this.socket?.off('otr-message');
};

SocketService.prototype.onOtrEnded = function(this: SocketService, callback: (payload: SocketOtrEndedPayload) => void) {
  if (!this.socket) return;
  this.socket.off('otr-ended');
  this.socket.on('otr-ended', (payload: SocketOtrEndedPayload) => callback(payload));
};

SocketService.prototype.offOtrEnded = function(this: SocketService) {
  this.socket?.off('otr-ended');
};
