// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { Server as SocketServer } from 'socket.io';
import './types.js'; // Socket module augmentation
import { setupSocketAuth } from './auth.js';
import { registerConnectionHandlers } from './connection.js';
import { registerChannelHandlers } from './channels.js';
import { registerVoiceHandlers } from './voice.js';
import { registerDmCallHandlers } from './dmCalls.js';
import { registerThreadHandlers } from './threads.js';
import { registerStageHandlers } from './stages.js';
import { registerForumHandlers } from './forum.js';
import { registerViewerHandlers } from './viewers.js';
import { registerOtrHandlers } from './otr.js';
import { hashToken } from '../utils/sessionUtils.js';
import { isValidTimezone, timezoneToRegion } from '../utils/timezoneRegion.js';
import type { SocketContext } from './types.js';

export function registerSocketHandlers(io: SocketServer): void {
  setupSocketAuth(io);

  io.on('connection', (socket) => {
    const userId = socket.userId;
    const socketToken = socket.handshake.auth.token as string | undefined;
    const socketTokenHash = socketToken ? hashToken(socketToken) : undefined;
    const socketSessionId = socket.sessionId;
    if (!userId || !socketTokenHash || !socketSessionId) { socket.disconnect(true); return; }

    // Collect client timezone for lightweight region bucketing (in-memory only)
    const tz = socket.handshake.auth.timezone ?? socket.handshake.query.timezone;
    socket.data.region = isValidTimezone(tz) ? timezoneToRegion(tz) : null;

    const ctx: SocketContext = { io, socket, userId, socketTokenHash, socketSessionId };
    registerConnectionHandlers(ctx);
    registerChannelHandlers(ctx);
    registerVoiceHandlers(ctx);
    registerDmCallHandlers(ctx);
    registerThreadHandlers(ctx);
    registerStageHandlers(ctx);
    registerForumHandlers(ctx);
    registerViewerHandlers(ctx);
    registerOtrHandlers(ctx);
  });
}
