// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { io as ioClient, Socket } from 'socket.io-client';
import { WS_URL } from '../../config';
import { apiClient } from '../api';
import { CURRENT_PROTOCOL_VERSION, KNOWN_CAPABILITIES } from '../../shared/protocol';
import type { MustUpdatePayload, UpdateRecommendedPayload } from '../../shared/protocol';
import { useUpdateStore } from '../../stores/updateStore';
import { resolveBuildDateSync } from '../buildDate';

function currentCapabilities(): string[] {
  return [...KNOWN_CAPABILITIES];
}

export class SocketService {
  socket: Socket | null = null;
  private refreshingToken = false;
  private _onReconnectCallback: (() => void) | null = null;
  private _hasConnectedOnce = false;
  private _socketCreatedCallbacks = new Set<() => void>();
  private _connectGeneration = 0;

  getSocket(): Socket | null {
    return this.socket;
  }

  /** Register a callback that fires on every reconnect (not the initial connect). */
  onReconnect(callback: () => void) {
    this._onReconnectCallback = callback;
  }

  offReconnect() {
    this._onReconnectCallback = null;
  }

  connect(token: string, onConnect?: () => void) {
    if (this.socket?.connected) {
      onConnect?.();
      return;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }
    this._hasConnectedOnce = false;
    this._connectGeneration++;

    // Must be synchronous: React mounts sibling effects (useChannelSocketEvents,
    // useDmSocketEvents, etc.) on the same commit and they register listeners
    // via `this.socket?.on(...)` / `if (!this.socket) return;`. If we awaited
    // anything here, this.socket would be null through the entire mount pass
    // and every direct-registration hook would silently no-op for the life of
    // the connection.
    const buildDate = resolveBuildDateSync();
    const protocolVersion = CURRENT_PROTOCOL_VERSION;
    const capabilities = currentCapabilities();

    this.socket = ioClient(WS_URL, {
      auth: {
        token,
        deviceId: localStorage.getItem('howl-deviceId') ?? undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        buildDate,
        protocolVersion,
        capabilities,
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 15,
      // Spread reconnect across ~15s to prevent thundering-herd auth-refresh storm at backend deploy / network blip.
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30000,
      randomizationFactor: 0.5,
      timeout: 20000,
    });
    // Flush callbacks waiting for socket creation
    const pending = Array.from(this._socketCreatedCallbacks);
    this._socketCreatedCallbacks.clear();
    for (const cb of pending) cb();
    this.socket.on('connect', () => {
      if (this._hasConnectedOnce) {
        // This is a reconnect, not the initial connect
        this._onReconnectCallback?.();
      }
      this._hasConnectedOnce = true;
    });
    if (onConnect) this.socket.once('connect', onConnect);

    // When the server revokes a session (password change, password reset, admin
    // session revoke), it emits 'session-expired' then disconnects the socket.
    // Stop auto-reconnect so we don't spin indefinitely with a dead session,
    // then trigger the API client's session-expired flow to redirect to login.
    this.socket.on('session-expired', () => {
      if (this.socket) {
        this.socket.io.reconnection(false);
      }
      apiClient.triggerSessionExpired();
    });

    // Version-gate: server tells the client its build is too old or the
    // protocol version is unsupported. The modal blocks further interaction
    // and drives the Electron auto-updater or a web reload.
    this.socket.on('must-update', (payload: MustUpdatePayload) => {
      useUpdateStore.getState().setRequired(payload.reason);
    });

    this.socket.on('update-recommended', (_payload: UpdateRecommendedPayload) => {
      useUpdateStore.getState().setRecommended(true);
    });

    this.socket.on('connect_error', async (err) => {
      const msg = err.message?.toLowerCase() ?? '';
      const isAuthError = msg.includes('session revoked') || msg.includes('invalid token') || msg.includes('jwt expired') || msg.includes('token expired') || msg.includes('unauthorized');
      if (isAuthError) {
        if (this.refreshingToken) return;
        this.refreshingToken = true;
        // Pause auto-reconnect to avoid wasting attempts with a stale token
        if (this.socket) this.socket.io.reconnection(false);
        try {
          const newToken = await apiClient.refreshAccessToken();
          if (newToken && this.socket) {
            // Update both socket.auth (used by Socket.IO handshake on reconnect)
            // and manager opts.auth (used as fallback by some Socket.IO versions).
            // Preserve deviceId from the original auth.
            const authObj = {
              token: newToken,
              deviceId: localStorage.getItem('howl-deviceId') ?? undefined,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              buildDate: resolveBuildDateSync(),
              protocolVersion: CURRENT_PROTOCOL_VERSION,
              capabilities: currentCapabilities(),
            };
            this.socket.auth = authObj;
            if (this.socket.io?.opts) {
              (this.socket.io.opts as Record<string, unknown>).auth = authObj;
            }
            this.socket.io.reconnection(true);
            this.socket.connect();
          } else if (this.socket) {
            // Re-enable reconnection even on refresh failure so the socket
            // can recover if the user logs in again or the token is refreshed
            // elsewhere (e.g., another tab).
            this.socket.io.reconnection(true);
          }
        } finally {
          this.refreshingToken = false;
        }
      }
    });
  }

  isConnected(): boolean {
    return !!this.socket?.connected;
  }

  measureLatency(): Promise<number | null> {
    return new Promise((resolve) => {
      if (!this.socket?.connected) { resolve(null); return; }
      const start = performance.now();
      let resolved = false;
      const timeout = setTimeout(() => { if (!resolved) { resolved = true; resolve(null); } }, 5000);
      this.socket.volatile.emit('ping-latency', () => {
        if (!resolved) { resolved = true; clearTimeout(timeout); resolve(Math.round(performance.now() - start)); }
      });
    });
  }

  /** Run callback when socket is connected (immediately if already connected).
   * Queues via onSocketCreated if the socket doesn't exist yet, so callers
   * don't silently lose their callback during the connect() → listeners gap. */
  whenConnected(callback: () => void) {
    if (!this.socket) {
      this.onSocketCreated(() => { this.whenConnected(callback); });
      return;
    }
    if (this.socket.connected) callback();
    else this.socket.once('connect', callback);
  }

  /**
   * Queue a callback to run when the socket object is created.
   * If socket already exists, fires immediately.
   * Returns an unsubscribe function to remove the callback (e.g. on unmount).
   * Fixes race condition where hooks register listeners before connect() is called.
   */
  onSocketCreated(callback: () => void): () => void {
    if (this.socket) {
      callback();
    } else {
      this._socketCreatedCallbacks.add(callback);
    }
    return () => { this._socketCreatedCallbacks.delete(callback); };
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  joinChannel(channelId: string) {
    this.socket?.emit('join-channel', channelId);
  }

  leaveChannel(channelId: string) {
    this.socket?.emit('leave-channel', channelId);
  }

  joinDM(dmChannelId: string) {
    this.socket?.emit('join-dm', dmChannelId);
  }

  leaveDM(dmChannelId: string) {
    this.socket?.emit('leave-dm', dmChannelId);
  }

  joinServer(serverId: string) {
    this.socket?.emit('join-server', serverId);
  }

  leaveServer(serverId: string) {
    this.socket?.emit('leave-server', serverId);
  }

  emitTyping(target: { channelId?: string; dmChannelId?: string }) {
    this.socket?.emit('typing', target);
  }

  emitOtrMessage(payload: { dmChannelId: string; mlsGroupId: string; clientMsgId: string; ciphertext: string }) {
    this.socket?.emit('otr-message', payload);
  }

  emitOtrAck(payload: { clientMsgId: string }) {
    this.socket?.emit('otr-ack', payload);
  }

  emitOtrPull() {
    this.socket?.emit('otr-pull', {});
  }
}
