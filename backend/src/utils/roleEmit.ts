// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { Server as IOServer } from 'socket.io';
import { prisma } from '../db.js';
import { hasPermission, type PermissionContext, type RoleLike } from './permissions.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'roleEmit' });

/**
 * Emit a role event ONLY to currently-connected members who can see hidden
 * roles (manageRoles | owner | administrator). Used for `server-role-*` events
 * that carry a hidden role's payload, which must never broadcast to the whole
 * `server:${serverId}` room (that would leak the hidden role to non-mods in
 * realtime).
 *
 * Cross-replica safe via `fetchSockets()` (returns RemoteSockets across all
 * instances through the Redis adapter). The userId is read from each socket's
 * `user:${id}` room (joined immediately after auth in
 * `socketHandlers/connection.ts`). Per-user permission contexts are
 * batch-loaded (ServerMember + roles + @everyone in two Prisma queries),
 * mirroring `channelVisibility.ts`.
 */
export async function emitRoleEventToMods(io: IOServer, serverId: string, event: string, payload: unknown): Promise<void> {
  let sockets;
  try {
    sockets = await io.in(`server:${serverId}`).fetchSockets();
  } catch (err) {
    log.warn({ err, serverId }, 'fetchSockets failed for scoped role emit');
    return;
  }
  const userIds = new Set<string>();
  for (const s of sockets) {
    let userId: string | undefined;
    for (const room of s.rooms) {
      if (room.startsWith('user:')) { userId = room.slice('user:'.length); break; }
    }
    if (userId) userIds.add(userId);
  }
  if (userIds.size === 0) return;

  const [members, everyone] = await Promise.all([
    prisma.serverMember.findMany({
      where: { serverId, userId: { in: [...userIds] } },
      include: { memberRoles: { include: { role: true } } },
      take: 1000,
    }),
    prisma.serverRole.findFirst({
      where: { serverId, isEveryone: true },
      select: { id: true, position: true, permissions: true, isEveryone: true },
    }),
  ]);

  for (const m of members) {
    const roles: RoleLike[] = m.memberRoles
      .map((mr) => ({ id: mr.role.id, position: mr.role.position, permissions: mr.role.permissions, isEveryone: mr.role.isEveryone }))
      .filter((r) => !r.isEveryone);
    const ctx: PermissionContext = { member: { userId: m.userId, role: m.role }, roles, everyoneRole: everyone };
    if (hasPermission(ctx, 'manageRoles')) io.to(`user:${m.userId}`).emit(event, payload);
  }
}

/**
 * Emit a member-role event to the whole server, but give mods (canSeeHiddenRoles
 * = manageRoles | owner | administrator) the FULL payload and non-mods a
 * SANITIZED one. Used by the `server-member-role-added/-updated/-removed` emit
 * sites when a hidden role is involved, so a hidden role's name/color/ids never
 * broadcast to the whole `server:${serverId}` room (which would leak the hidden
 * role's display metadata to non-mods in realtime).
 *
 * Each connected user receives EXACTLY ONE emit (no double-processing on the
 * client). Mirrors `emitRoleEventToMods`'s socket-iteration + ctx batch-load and
 * is cross-replica safe via `fetchSockets()`.
 */
export async function emitMemberRoleEventScoped(
  io: IOServer,
  serverId: string,
  event: string,
  opts: { full: unknown; sanitized: unknown },
): Promise<void> {
  let sockets;
  try {
    sockets = await io.in(`server:${serverId}`).fetchSockets();
  } catch (err) {
    log.warn({ err, serverId }, 'fetchSockets failed for scoped member-role emit');
    return;
  }
  const userIds = new Set<string>();
  for (const s of sockets) {
    let userId: string | undefined;
    for (const room of s.rooms) {
      if (room.startsWith('user:')) { userId = room.slice('user:'.length); break; }
    }
    if (userId) userIds.add(userId);
  }
  if (userIds.size === 0) return;

  const [members, everyone] = await Promise.all([
    prisma.serverMember.findMany({
      where: { serverId, userId: { in: [...userIds] } },
      include: { memberRoles: { include: { role: true } } },
      take: 1000,
    }),
    prisma.serverRole.findFirst({
      where: { serverId, isEveryone: true },
      select: { id: true, position: true, permissions: true, isEveryone: true },
    }),
  ]);

  for (const m of members) {
    const roles: RoleLike[] = m.memberRoles
      .map((mr) => ({ id: mr.role.id, position: mr.role.position, permissions: mr.role.permissions, isEveryone: mr.role.isEveryone }))
      .filter((r) => !r.isEveryone);
    const ctx: PermissionContext = { member: { userId: m.userId, role: m.role }, roles, everyoneRole: everyone };
    const payload = hasPermission(ctx, 'manageRoles') ? opts.full : opts.sanitized;
    io.to(`user:${m.userId}`).emit(event, payload);
  }
}
