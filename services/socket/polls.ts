// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';
import type { Poll, PollOption } from '../../types';

interface PollVoteUpdate {
  pollId: string;
  options: PollOption[];
  totalVotes: number;
}

declare module './core' {
  interface SocketService {
    onPollCreated(callback: (poll: Poll) => void): void;
    offPollCreated(): void;
    onPollVoteUpdated(callback: (data: PollVoteUpdate) => void): void;
    offPollVoteUpdated(): void;
    onPollUpdated(callback: (poll: Poll) => void): void;
    offPollUpdated(): void;
    onPollClosed(callback: (data: { pollId: string }) => void): void;
    offPollClosed(): void;
    onPollDeleted(callback: (data: { pollId: string }) => void): void;
    offPollDeleted(): void;
  }
}

SocketService.prototype.onPollCreated = function(this: SocketService, callback: (poll: Poll) => void) {
  this.socket?.off('poll-created');
  this.socket?.on('poll-created', callback);
};

SocketService.prototype.offPollCreated = function(this: SocketService) {
  this.socket?.off('poll-created');
};

SocketService.prototype.onPollVoteUpdated = function(this: SocketService, callback: (data: PollVoteUpdate) => void) {
  this.socket?.off('poll-vote-updated');
  this.socket?.on('poll-vote-updated', callback);
};

SocketService.prototype.offPollVoteUpdated = function(this: SocketService) {
  this.socket?.off('poll-vote-updated');
};

SocketService.prototype.onPollUpdated = function(this: SocketService, callback: (poll: Poll) => void) {
  this.socket?.off('poll-updated');
  this.socket?.on('poll-updated', callback);
};

SocketService.prototype.offPollUpdated = function(this: SocketService) {
  this.socket?.off('poll-updated');
};

SocketService.prototype.onPollClosed = function(this: SocketService, callback: (data: { pollId: string }) => void) {
  this.socket?.off('poll-closed');
  this.socket?.on('poll-closed', callback);
};

SocketService.prototype.offPollClosed = function(this: SocketService) {
  this.socket?.off('poll-closed');
};

SocketService.prototype.onPollDeleted = function(this: SocketService, callback: (data: { pollId: string }) => void) {
  this.socket?.off('poll-deleted');
  this.socket?.on('poll-deleted', callback);
};

SocketService.prototype.offPollDeleted = function(this: SocketService) {
  this.socket?.off('poll-deleted');
};
