// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';

declare module './core' {
  interface SocketService {
    onDmKeyRotationNeeded(callback: (data: { dmChannelId: string; oldestMemberId: string; memberIds: string[]; leaverId?: string }) => void): void;
    offDmKeyRotationNeeded(): void;
    onDmEncryptionReset(callback: (data: { userId: string }) => void): void;
    offDmEncryptionReset(): void;
  }
}

SocketService.prototype.onDmKeyRotationNeeded = function(this: SocketService, callback) {
  this.socket?.off('dm-key-rotation-needed');
  this.socket?.on('dm-key-rotation-needed', callback);
};

SocketService.prototype.offDmKeyRotationNeeded = function(this: SocketService) {
  this.socket?.off('dm-key-rotation-needed');
};

// A user (a DM partner, or this account on another device) performed a full
// encryption reset (DELETE /dms/keys/bundle).
SocketService.prototype.onDmEncryptionReset = function(this: SocketService, callback) {
  this.socket?.off('dm-encryption-reset');
  this.socket?.on('dm-encryption-reset', callback);
};

SocketService.prototype.offDmEncryptionReset = function(this: SocketService) {
  this.socket?.off('dm-encryption-reset');
};
