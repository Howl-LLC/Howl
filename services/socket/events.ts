// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';
import type { ServerEvent } from '../../types';

declare module './core' {
  interface SocketService {
    onServerEventCreated(callback: (data: ServerEvent) => void): void;
    offServerEventCreated(): void;
    onServerEventUpdated(callback: (data: ServerEvent) => void): void;
    offServerEventUpdated(): void;
    onServerEventDeleted(callback: (data: { serverId: string; eventId: string }) => void): void;
    offServerEventDeleted(): void;
    onServerEventRsvp(callback: (data: { serverId: string; eventId: string; userId: string; status: string | null }) => void): void;
    offServerEventRsvp(): void;
  }
}

SocketService.prototype.onServerEventCreated = function(this: SocketService, callback: (data: ServerEvent) => void) {
  this.socket?.off('server-event-created');
  this.socket?.on('server-event-created', callback);
};

SocketService.prototype.offServerEventCreated = function(this: SocketService) {
  this.socket?.off('server-event-created');
};

SocketService.prototype.onServerEventUpdated = function(this: SocketService, callback: (data: ServerEvent) => void) {
  this.socket?.off('server-event-updated');
  this.socket?.on('server-event-updated', callback);
};

SocketService.prototype.offServerEventUpdated = function(this: SocketService) {
  this.socket?.off('server-event-updated');
};

SocketService.prototype.onServerEventDeleted = function(this: SocketService, callback: (data: { serverId: string; eventId: string }) => void) {
  this.socket?.off('server-event-deleted');
  this.socket?.on('server-event-deleted', callback);
};

SocketService.prototype.offServerEventDeleted = function(this: SocketService) {
  this.socket?.off('server-event-deleted');
};

SocketService.prototype.onServerEventRsvp = function(this: SocketService, callback: (data: { serverId: string; eventId: string; userId: string; status: string | null }) => void) {
  this.socket?.off('server-event-rsvp');
  this.socket?.on('server-event-rsvp', callback);
};

SocketService.prototype.offServerEventRsvp = function(this: SocketService) {
  this.socket?.off('server-event-rsvp');
};
