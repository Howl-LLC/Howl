// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { Server as SocketServer, Socket } from 'socket.io';
import type { Region } from '../utils/timezoneRegion.js';

declare module 'socket.io' {
  interface Socket {
    userId?: string;
    /** Stable session row id captured at connect time. Use this for
     *  revalidation instead of the token hash — session.tokenHash rotates
     *  on every access-token refresh while session.id stays constant, so a
     *  tokenHash-based lookup incorrectly returns null after the first
     *  refresh and kicks the user. */
    sessionId?: string;
    /** Protocol version context parsed from the handshake auth fields.
     *  Always present after auth middleware; individual fields may be null
     *  when the client doesn't send them (permissive mode). */
    protocolContext?: {
      buildDate: string | null;
      protocolVersion: number | null;
      capabilities: string[];
    };
  }

  interface SocketData {
    region?: Region | null;
    softUpdateWarning?: boolean;
    /** Set by auth middleware when enforcement is active and handshake is
     *  outside the compat window. The connection handler emits must-update
     *  then disconnects. We let the socket connect so the client receives
     *  the event before being kicked. */
    mustUpdateReason?: 'buildDate' | 'protocolVersion';
    /** Mirrored from socket.protocolContext so that RemoteSocket objects
     *  returned by fetchSockets() (via Redis adapter) carry the context.
     *  socket.data is serialized by the adapter; direct socket properties
     *  are not. */
    protocolContext?: {
      buildDate: string | null;
      protocolVersion: number | null;
      capabilities: string[];
    };
  }
}

export interface SocketContext {
  io: SocketServer;
  socket: Socket;
  userId: string;
  socketTokenHash: string;
  socketSessionId: string;
}
