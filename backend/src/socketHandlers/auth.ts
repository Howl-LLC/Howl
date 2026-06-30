// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { Server as SocketServer, Socket } from 'socket.io';
import './types.js'; // Socket module augmentation
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { getIO } from '../socketIO.js';
import { hashToken } from '../utils/sessionUtils.js';
import { JWT_SECRET } from '../middleware/auth.js';
import { onSessionInvalidation } from '../redis.js';
import { CACHE_MAX_SIZE } from './infrastructure.js';
import { parseProtocolContext, isEnforceVersionGate, isHandshakeInsideWindow, isHandshakeSoftWarning } from '../protocol.js';

const socketSessionCache = new Map<string, { valid: boolean; expiresAt: number; sessionId?: string }>();
const tokenHashToSockets = new Map<string, Set<string>>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of socketSessionCache) {
    if (now > entry.expiresAt) {
      socketSessionCache.delete(key);
      tokenHashToSockets.delete(key);
    }
  }
}, 60_000).unref();

onSessionInvalidation((tokenHash: string) => {
  socketSessionCache.delete(tokenHash);
  const socketIds = tokenHashToSockets.get(tokenHash);
  if (socketIds) {
    const io = getIO();
    for (const sid of socketIds) {
      const s = io.sockets.sockets.get(sid);
      if (s) {
        s.emit('session-expired', { reason: 'Session revoked' });
        s.disconnect(true);
      }
    }
    tokenHashToSockets.delete(tokenHash);
  }
});

export function getTokenHashToSockets(): Map<string, Set<string>> {
  return tokenHashToSockets;
}

function attachProtocolContext(socket: Socket): void {
  socket.protocolContext = parseProtocolContext({
    buildDate: socket.handshake.auth.buildDate,
    protocolVersion: socket.handshake.auth.protocolVersion,
    capabilities: socket.handshake.auth.capabilities,
  });
  // Mirror onto socket.data so remote sockets (fetchSockets via Redis adapter)
  // can see it. socket.protocolContext is a local-instance reference;
  // socket.data is serialized by the adapter.
  socket.data.protocolContext = socket.protocolContext;
}

export function setupSocketAuth(io: SocketServer): void {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token as string | undefined;
    if (!token) return next(new Error('Missing token'));
    try {
      const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: string };
      const tHash = hashToken(token);

      const now = Date.now();
      const cached = socketSessionCache.get(tHash);
      if (cached && now < cached.expiresAt) {
        // Move to end (LRU touch)
        socketSessionCache.delete(tHash);
        socketSessionCache.set(tHash, cached);
        if (!cached.valid) return next(new Error('Session revoked'));
        socket.userId = decoded.userId;
        socket.sessionId = cached.sessionId;
        attachProtocolContext(socket);

        // Permissive by default. Flip ENFORCE_VERSION_GATE=true via env once
        // >=95% of active clients send handshake fields.
        if (isEnforceVersionGate()) {
          const check = isHandshakeInsideWindow(
            socket.protocolContext!.buildDate,
            socket.protocolContext!.protocolVersion,
          );
          if (!check.ok) {
            // Let the socket connect so the client can receive the must-update
            // event; the connection handler will emit + disconnect immediately.
            socket.data.mustUpdateReason = check.reason;
            return next();
          }
        }
        socket.data.softUpdateWarning = isHandshakeSoftWarning(socket.protocolContext!.buildDate);

        return next();
      }

      const session = await prisma.session.findUnique({ where: { tokenHash: tHash }, select: { id: true } });
      if (socketSessionCache.size >= CACHE_MAX_SIZE) {
        // Evict least-recently-used (first entry in Map iteration order)
        const lruKey = socketSessionCache.keys().next().value;
        if (lruKey !== undefined) {
          socketSessionCache.delete(lruKey);
          tokenHashToSockets.delete(lruKey);
        }
      }
      socketSessionCache.set(tHash, { valid: !!session, expiresAt: now + 30_000 /* 30s cache TTL */, sessionId: session?.id });
      if (!session) return next(new Error('Session revoked'));
      socket.userId = decoded.userId;
      socket.sessionId = session.id;
      attachProtocolContext(socket);

      if (isEnforceVersionGate()) {
        const check = isHandshakeInsideWindow(
          socket.protocolContext!.buildDate,
          socket.protocolContext!.protocolVersion,
        );
        if (!check.ok) {
          socket.data.mustUpdateReason = check.reason;
          return next();
        }
      }
      socket.data.softUpdateWarning = isHandshakeSoftWarning(socket.protocolContext!.buildDate);

      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });
}
