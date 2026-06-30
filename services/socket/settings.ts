// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';

declare module './core' {
  interface SocketService {
    onSettingsUpdated(callback: (data: { data: Record<string, unknown>; updatedAt: string }) => void): void;
    offSettingsUpdated(): void;
  }
}

SocketService.prototype.onSettingsUpdated = function(this: SocketService, callback) {
  this.socket?.off('settings-updated');
  this.socket?.on('settings-updated', callback);
};

SocketService.prototype.offSettingsUpdated = function(this: SocketService) {
  this.socket?.off('settings-updated');
};
