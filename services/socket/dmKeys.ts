// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';

declare module './core' {
  interface SocketService {
    onDmKeyRotationNeeded(callback: (data: { dmChannelId: string; oldestMemberId: string; memberIds: string[]; leaverId?: string }) => void): void;
    offDmKeyRotationNeeded(): void;
  }
}

SocketService.prototype.onDmKeyRotationNeeded = function(this: SocketService, callback) {
  this.socket?.off('dm-key-rotation-needed');
  this.socket?.on('dm-key-rotation-needed', callback);
};

SocketService.prototype.offDmKeyRotationNeeded = function(this: SocketService) {
  this.socket?.off('dm-key-rotation-needed');
};
