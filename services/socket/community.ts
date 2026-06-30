// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';

/**
 * Payload shape for `server-community-updated`. The backend currently emits
 * either `{ serverId, communityEnabled, discoveryEnabled }` (enable/disable
 * lifecycle) or `{ serverId, server, settings }` (PATCH metadata) — discovery
 * consumers only care that the event fired, so the body is opaque.
 */
export interface ServerCommunityUpdatedPayload {
  serverId: string;
  communityEnabled?: boolean;
  discoveryEnabled?: boolean;
}

declare module './core' {
  interface SocketService {
    onServerCommunityUpdated(callback: (data: ServerCommunityUpdatedPayload) => void): void;
    offServerCommunityUpdated(): void;
  }
}

SocketService.prototype.onServerCommunityUpdated = function(this: SocketService, callback) {
  this.socket?.off('server-community-updated');
  this.socket?.on('server-community-updated', callback);
};

SocketService.prototype.offServerCommunityUpdated = function(this: SocketService) {
  this.socket?.off('server-community-updated');
};
