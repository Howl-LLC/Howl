// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { Server as SocketServer } from 'socket.io';

let _io: SocketServer | null = null;

export function setIO(io: SocketServer): void {
  _io = io;
}

export function getIO(): SocketServer {
  if (!_io) throw new Error('Socket.IO not initialized');
  return _io;
}
