// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';
import type { GameActivity } from '../../types';

declare module './core' {
  interface SocketService {
    onActivityUpdate(callback: (data: { userId: string; activity: GameActivity | null; secondaryActivity?: GameActivity | null }) => void): void;
    offActivityUpdate(): void;
    emitSetActivity(activity: { type: string; name: string; details?: string; state?: string; platformId?: string }): void;
    emitClearActivity(): void;
  }
}

SocketService.prototype.onActivityUpdate = function(this: SocketService, callback: (data: { userId: string; activity: GameActivity | null; secondaryActivity?: GameActivity | null }) => void) {
  this.socket?.off('activity-update');
  this.socket?.on('activity-update', callback);
};

SocketService.prototype.offActivityUpdate = function(this: SocketService) {
  this.socket?.off('activity-update');
};

SocketService.prototype.emitSetActivity = function(this: SocketService, activity: { type: string; name: string; details?: string; state?: string; platformId?: string }) {
  this.socket?.emit('set-activity', activity);
};

SocketService.prototype.emitClearActivity = function(this: SocketService) {
  this.socket?.emit('clear-activity');
};
