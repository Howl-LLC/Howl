// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * `serverNotSuspended` middleware.
 *
 * Rejects state-changing requests for a server that has been admin-suspended
 * (`Server.suspendedAt IS NOT NULL`). Read endpoints, audit-log reads, and
 * data-export endpoints are explicitly bypassed (GET / HEAD / OPTIONS) so a
 * suspended server's owner can still self-serve their data per ToS.
 *
 * Returns HTTP 423 Locked — distinct from 403 (permission denied) and 401
 * (auth failure) so clients can render a dedicated "this server is suspended"
 * UI. Body shape matches the rest of the route surface: `{ error, reason? }`.
 *
 * Two factories because the existing routes resolve the server differently:
 *
 *   - `serverNotSuspendedByServerId(paramName?)` — for routes mounted under
 *     `/servers/:serverId/...`.
 *
 *   - `serverNotSuspendedByChannelId(paramName?)` — for routes mounted under
 *     `/messages/channels/:channelId/...`. DM channels (`serverId` null) are
 *     never affected by server suspension and bypass cleanly. Uses a single
 *     `channel.findUnique({ include: { server } })` so we don't pay two
 *     roundtrips on the message-send hot path.
 *
 * Both factories are intentionally narrow: if the server doesn't exist, do
 * NOT shadow the 404 the handler will return — just call `next()` and let
 * the route owner handle missing rows. That keeps the middleware idempotent
 * if upstream validation has already rejected the request and avoids
 * leaking row existence via timing.
 */

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { getParam } from '../utils.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isReadOnly(req: Request): boolean {
  return READ_METHODS.has(req.method);
}

function suspended(reason: string | null) {
  return { error: 'server_suspended', reason: reason ?? null };
}

export function serverNotSuspendedByServerId(paramName: string = 'serverId') {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (isReadOnly(req)) return next();
    try {
      const serverId = getParam(req, paramName);
      if (!serverId || !UUID_REGEX.test(serverId)) return next();

      const server = await prisma.server.findUnique({
        where: { id: serverId },
        select: { suspendedAt: true, suspensionReason: true },
      });
      if (!server) return next();
      if (server.suspendedAt !== null) {
        return res.status(423).json(suspended(server.suspensionReason));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function serverNotSuspendedByChannelId(paramName: string = 'channelId') {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (isReadOnly(req)) return next();
    try {
      const channelId = getParam(req, paramName);
      if (!channelId || !UUID_REGEX.test(channelId)) return next();

      // Single roundtrip: include the parent server so we can short-circuit
      // on DM channels (serverId === null) without a second query.
      const channel = await prisma.channel.findUnique({
        where: { id: channelId },
        select: { server: { select: { suspendedAt: true, suspensionReason: true } } },
      });
      const server = channel?.server;
      if (!server) return next();
      if (server.suspendedAt !== null) {
        return res.status(423).json(suspended(server.suspensionReason));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
