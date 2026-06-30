// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';
import type { Thread, ThreadMessage } from '../../types';

declare module './core' {
  interface SocketService {
    joinThread(threadId: string): void;
    leaveThread(threadId: string): void;
    onThreadCreated(callback: (thread: Thread) => void): void;
    offThreadCreated(): void;
    onThreadMessage(callback: (message: ThreadMessage) => void): void;
    offThreadMessage(): void;
    onThreadMessageEdited(callback: (data: { id: string; threadId: string; content: string; editedAt: string }) => void): void;
    offThreadMessageEdited(): void;
    onThreadMessageDeleted(callback: (data: { id: string; threadId: string }) => void): void;
    offThreadMessageDeleted(): void;
    onThreadUpdated(callback: (data: Partial<Thread> & { id: string }) => void): void;
    offThreadUpdated(): void;
    onThreadArchived(callback: (data: Partial<Thread> & { id: string }) => void): void;
    offThreadArchived(): void;
    onThreadDeleted(callback: (data: { threadId: string; channelId: string }) => void): void;
    offThreadDeleted(): void;
  }
}

SocketService.prototype.joinThread = function(this: SocketService, threadId: string) {
  this.socket?.emit('join-thread', threadId);
};

SocketService.prototype.leaveThread = function(this: SocketService, threadId: string) {
  this.socket?.emit('leave-thread', threadId);
};

SocketService.prototype.onThreadCreated = function(this: SocketService, callback: (thread: Thread) => void) {
  this.socket?.off('thread-created');
  this.socket?.on('thread-created', callback);
};

SocketService.prototype.offThreadCreated = function(this: SocketService) {
  this.socket?.off('thread-created');
};

SocketService.prototype.onThreadMessage = function(this: SocketService, callback: (message: ThreadMessage) => void) {
  this.socket?.off('thread-message');
  this.socket?.on('thread-message', callback);
};

SocketService.prototype.offThreadMessage = function(this: SocketService) {
  this.socket?.off('thread-message');
};

SocketService.prototype.onThreadMessageEdited = function(this: SocketService, callback) {
  this.socket?.off('thread-message-edited');
  this.socket?.on('thread-message-edited', callback);
};

SocketService.prototype.offThreadMessageEdited = function(this: SocketService) {
  this.socket?.off('thread-message-edited');
};

SocketService.prototype.onThreadMessageDeleted = function(this: SocketService, callback) {
  this.socket?.off('thread-message-deleted');
  this.socket?.on('thread-message-deleted', callback);
};

SocketService.prototype.offThreadMessageDeleted = function(this: SocketService) {
  this.socket?.off('thread-message-deleted');
};

SocketService.prototype.onThreadUpdated = function(this: SocketService, callback) {
  this.socket?.off('thread-updated');
  this.socket?.on('thread-updated', callback);
};

SocketService.prototype.offThreadUpdated = function(this: SocketService) {
  this.socket?.off('thread-updated');
};

SocketService.prototype.onThreadArchived = function(this: SocketService, callback) {
  this.socket?.off('thread-archived');
  this.socket?.on('thread-archived', callback);
};

SocketService.prototype.offThreadArchived = function(this: SocketService) {
  this.socket?.off('thread-archived');
};

SocketService.prototype.onThreadDeleted = function(this: SocketService, callback) {
  this.socket?.off('thread-deleted');
  this.socket?.on('thread-deleted', callback);
};

SocketService.prototype.offThreadDeleted = function(this: SocketService) {
  this.socket?.off('thread-deleted');
};
