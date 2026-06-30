// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Channel-visibility helpers for "auto-join a socket to every channel room the
 * user can actually see" flows. Consolidates the override-aware permission
 * gate so that `invites.ts` (new member joins server), `servers.ts` (new
 * channel created), and any future auto-join path all apply the same check
 * as the authoritative `join-channel` socket handler
 * (`backend/src/socketHandlers/channels.ts:121-148`) and the connection-time
 * auto-subscribe (`backend/src/socketHandlers/connection.ts:339-388`).
 *
 * The failure mode this file exists to prevent: gating a bulk `socketsJoin`
 * on `!isPrivate` is **insufficient** because category-level `@everyone`
 * overrides can restrict a public channel. Per-channel message broadcasts
 * (`io.to('channel:${id}').emit('new-message', ...)` in `routes/messages.ts`)
 * deliver plaintext content — server channel messages are not E2E encrypted
 * — so a misjoin is a live data leak for the socket's lifetime.
 */

import type { Server as SocketServer } from 'socket.io';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import type { PermissionContext, PermissionOverride } from './permissions.js';
import { hasPermission, hasChannelPermission } from './permissions.js';
import { isUnderEighteen } from './discoveryFilters.js';

const log = logger.child({ module: 'channelVisibility' });

type ChannelDescriptor = {
  id: string;
  isPrivate: boolean;
  categoryId: string | null;
  /** When true, the channel is age-gated. Pair with an `isMinor` flag at
   *  the call site to drop the channel from the visible set. */
  ageRestricted?: boolean;
};

/**
 * Given a user's PermissionContext and a batch of channels, return the
 * subset the user can read in real time. Applies the same gate as the
 * `join-channel` socket handler:
 *   - server-level: `viewChannels` + `readMessageHistory`
 *   - per-channel (private only): `viewChannels` via override chain
 *   - per-channel (all channels): `readMessageHistory` via override chain
 *   - per-channel (age-gated only, when `isMinor`): hide
 *
 * Overrides for each channel and for each distinct category are loaded in
 * parallel and grouped in-memory; no N+1 queries.
 */
export async function filterVisibleChannelIds(
  ctx: PermissionContext,
  channels: ChannelDescriptor[],
  opts: { isMinor?: boolean } = {},
): Promise<string[]> {
  if (channels.length === 0) return [];

  // Cheap short-circuit: if the server-level gate fails, no channel can pass.
  // Owner / administrator roles short-circuit `hasPermission` to true.
  if (!hasPermission(ctx, 'viewChannels') || !hasPermission(ctx, 'readMessageHistory')) {
    return [];
  }

  const channelIds = channels.map((c) => c.id);
  const categoryIds = [
    ...new Set(channels.map((c) => c.categoryId).filter((id): id is string => !!id)),
  ];

  const [channelOverrides, categoryOverrides] = await Promise.all([
    prisma.channelPermissionOverride.findMany({
      where: { channelId: { in: channelIds } },
      take: 10000,
    }),
    categoryIds.length > 0
      ? prisma.categoryPermissionOverride.findMany({
          where: { categoryId: { in: categoryIds } },
          take: 10000,
        })
      : Promise.resolve([]),
  ]);

  const channelOvrByCh = new Map<string, PermissionOverride[]>();
  for (const o of channelOverrides) {
    const list = channelOvrByCh.get(o.channelId);
    if (list) list.push(o); else channelOvrByCh.set(o.channelId, [o]);
  }
  const catOvrByCat = new Map<string, PermissionOverride[]>();
  for (const o of categoryOverrides) {
    const list = catOvrByCat.get(o.categoryId);
    if (list) list.push(o); else catOvrByCat.set(o.categoryId, [o]);
  }

  const visible: string[] = [];
  for (const ch of channels) {
    if (opts.isMinor && ch.ageRestricted) continue;
    const chOvrs = channelOvrByCh.get(ch.id) ?? [];
    const catOvrs = ch.categoryId ? (catOvrByCat.get(ch.categoryId) ?? []) : [];
    if (ch.isPrivate && !hasChannelPermission(ctx, 'viewChannels', chOvrs, catOvrs, undefined, { requireOverride: true })) continue;
    if (!hasChannelPermission(ctx, 'readMessageHistory', chOvrs, catOvrs)) continue;
    visible.push(ch.id);
  }
  return visible;
}

/**
 * Auto-join every currently-connected member of `server:${serverId}` to
 * `channel:${channelId}`, filtering per-member by the supplied category
 * overrides plus the server-level read gate. Intended for the
 * `channel-created` path where the new channel has no channel-level
 * override rows yet (those are created via separate API calls), so only
 * category-level overrides can restrict visibility at this moment.
 *
 * Cross-replica: `fetchSockets()` returns RemoteSockets for all instances
 * via the Redis adapter, and `RemoteSocket.join(room)` propagates the room
 * membership back to the owning instance. Per-user permission contexts are
 * batch-loaded (ServerMember + roles + @everyone in two Prisma queries).
 */
export async function autoJoinVisibleServerMembers(params: {
  io: SocketServer;
  serverId: string;
  channelId: string;
  categoryOverrides: PermissionOverride[];
  /** When true, minor sockets are excluded from the auto-join. Pass the
   *  freshly-created channel's `ageRestricted` flag so age-gated channels
   *  do not silently fan out to under-18 members. */
  channelAgeRestricted?: boolean;
}): Promise<void> {
  const { io, serverId, channelId, categoryOverrides, channelAgeRestricted } = params;
  try {
    const sockets = await io.in(`server:${serverId}`).fetchSockets();
    if (sockets.length === 0) return;

    // Extract userId from each socket by scanning its rooms for the
    // `user:${id}` entry (every authenticated socket joins this at
    // socketHandlers/connection.ts:164 immediately after auth). Falls back
    // to skipping any socket that somehow lacks the marker rather than
    // risking a mis-join.
    const socketUsers: Array<{ socket: typeof sockets[number]; userId: string }> = [];
    const userIdSet = new Set<string>();
    for (const s of sockets) {
      let userId: string | null = null;
      for (const room of s.rooms) {
        if (room.startsWith('user:')) { userId = room.slice('user:'.length); break; }
      }
      if (!userId) continue;
      socketUsers.push({ socket: s, userId });
      userIdSet.add(userId);
    }
    if (socketUsers.length === 0) return;
    const userIds = [...userIdSet];

    // Batch-load membership + @everyone. One round trip each. When the new
    // channel is age-gated we also need the user's DOB to drop minors from
    // the auto-join — pulled in the same parallel block to avoid an extra
    // round trip.
    const [members, everyoneRole, userAges] = await Promise.all([
      prisma.serverMember.findMany({
        where: { serverId, userId: { in: userIds } },
        include: { memberRoles: { include: { role: true } } },
        take: 1000,
      }),
      prisma.serverRole.findFirst({
        where: { serverId, isEveryone: true },
        select: { id: true, position: true, permissions: true, isEveryone: true },
      }),
      channelAgeRestricted
        ? prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, dateOfBirth: true },
            take: 1000,
          })
        : Promise.resolve([]),
    ]);

    const minorByUser = new Map<string, boolean>();
    if (channelAgeRestricted) {
      for (const u of userAges) minorByUser.set(u.id, isUnderEighteen(u.dateOfBirth));
      // Sockets whose userId was not returned by the DOB query are treated
      // as minors — fail-closed matches the discovery filter convention.
    }

    const ctxByUser = new Map<string, PermissionContext>();
    for (const m of members) {
      const roles = m.memberRoles.map((mr) => ({
        id: mr.role.id,
        position: mr.role.position,
        permissions: mr.role.permissions,
        isEveryone: mr.role.isEveryone,
      }));
      ctxByUser.set(m.userId, {
        member: { userId: m.userId, role: m.role },
        roles,
        everyoneRole: everyoneRole ?? null,
      });
    }

    let joined = 0;
    for (const { socket, userId } of socketUsers) {
      const ctx = ctxByUser.get(userId);
      if (!ctx) continue; // Socket holder is not actually a member (e.g. banned mid-flight).
      if (channelAgeRestricted && (minorByUser.get(userId) ?? true)) continue;
      if (!hasPermission(ctx, 'viewChannels') || !hasPermission(ctx, 'readMessageHistory')) continue;
      // `categoryOverrides` is already fetched by the caller (it's a property
      // of the new channel's parent category). No channel overrides exist yet
      // on a freshly-created channel — pass [] so the override walk skips the
      // channel tier and goes straight to category.
      if (!hasChannelPermission(ctx, 'readMessageHistory', [], categoryOverrides)) continue;
      socket.join(`channel:${channelId}`);
      joined++;
    }

    log.debug(
      { serverId, channelId, candidates: socketUsers.length, joined, channelAgeRestricted: !!channelAgeRestricted },
      'auto-joined server members to new channel',
    );
  } catch (err) {
    log.error(
      { err, serverId, channelId, event: 'auto-join-visible-failed' },
      'autoJoinVisibleServerMembers failed; affected sockets will pick up on next reconnect',
    );
  }
}

/**
 * Emit a channel metadata event (`channel-created` / `channel-updated-meta`)
 * ONLY to currently-connected server members who can VIEW the channel. Used for
 * PRIVATE channels, whose existence/name must NOT broadcast to the whole
 * `server:${serverId}` room — that would leak the private channel's metadata to
 * non-authorized members in realtime, even though the REST read path
 * (`routes/servers.ts` GET, `visibleChannels`) already filters them out.
 *
 * Public channels must NOT use this — they keep broadcasting to the whole server
 * room, so every member (and older clients) still receive them.
 *
 * The view gate matches the REST `visibleChannels` filter exactly: owner /
 * administrator bypass, else a `viewChannels` grant via the channel/category
 * override chain (`requireOverride`). `readMessageHistory` is intentionally NOT
 * required here — this governs who SEES the channel in their sidebar, not who
 * joins its message room (that stays governed by `autoJoinVisibleServerMembers`
 * / `join-channel`).
 *
 * Mirrors `autoJoinVisibleServerMembers`: cross-replica `fetchSockets()`, userId
 * read from the `user:${id}` room, per-user contexts batch-loaded (ServerMember
 * + roles + @everyone). Each viewer receives exactly one emit (deduped by user).
 */
export async function emitChannelEventToViewers(params: {
  io: SocketServer;
  serverId: string;
  channel: { id: string; isPrivate: boolean; categoryId: string | null };
  channelOverrides: PermissionOverride[];
  categoryOverrides: PermissionOverride[];
  event: string;
  payload: unknown;
}): Promise<void> {
  const { io, serverId, channel, channelOverrides, categoryOverrides, event, payload } = params;
  try {
    const sockets = await io.in(`server:${serverId}`).fetchSockets();
    if (sockets.length === 0) return;

    const userIdSet = new Set<string>();
    for (const s of sockets) {
      for (const room of s.rooms) {
        if (room.startsWith('user:')) { userIdSet.add(room.slice('user:'.length)); break; }
      }
    }
    if (userIdSet.size === 0) return;
    const userIds = [...userIdSet];

    const [members, everyoneRole] = await Promise.all([
      prisma.serverMember.findMany({
        where: { serverId, userId: { in: userIds } },
        include: { memberRoles: { include: { role: true } } },
        take: 1000,
      }),
      prisma.serverRole.findFirst({
        where: { serverId, isEveryone: true },
        select: { id: true, position: true, permissions: true, isEveryone: true },
      }),
    ]);

    let delivered = 0;
    for (const m of members) {
      const roles = m.memberRoles.map((mr) => ({
        id: mr.role.id, position: mr.role.position, permissions: mr.role.permissions, isEveryone: mr.role.isEveryone,
      }));
      const ctx: PermissionContext = { member: { userId: m.userId, role: m.role }, roles, everyoneRole: everyoneRole ?? null };
      // Match the REST `visibleChannels` gate: public is always visible (caller
      // should not use this for public channels, but stay correct if they do);
      // private requires a `viewChannels` override (owner/admin bypass inside
      // hasChannelPermission).
      const canView = !channel.isPrivate
        || hasChannelPermission(ctx, 'viewChannels', channelOverrides, categoryOverrides, everyoneRole ?? null, { requireOverride: true });
      if (canView) { io.to(`user:${m.userId}`).emit(event, payload); delivered++; }
    }

    log.debug({ serverId, channelId: channel.id, event, candidates: userIds.length, delivered }, 'scoped channel event to viewers');
  } catch (err) {
    log.error(
      { err, serverId, channelId: channel.id, event, action: 'scoped-channel-emit-failed' },
      'emitChannelEventToViewers failed; affected clients pick up on next load',
    );
  }
}

/**
 * Server-side eviction: when a channel is flipped to `ageRestricted = true`,
 * remove every currently-connected minor socket from `channel:${id}` so they
 * stop receiving real-time `new-message` events without waiting for a
 * reconnect. Auto-subscribe and `join-channel` already gate at re-entry;
 * this closes the toggle-mid-session leak.
 *
 * Cross-replica via `fetchSockets()` + `RemoteSocket.leave()`.
 */
export async function evictMinorSocketsFromAgeGatedChannel(params: {
  io: SocketServer;
  channelId: string;
}): Promise<void> {
  const { io, channelId } = params;
  try {
    const sockets = await io.in(`channel:${channelId}`).fetchSockets();
    if (sockets.length === 0) return;

    const userBySocket: Array<{ socket: typeof sockets[number]; userId: string }> = [];
    const userIdSet = new Set<string>();
    for (const s of sockets) {
      let userId: string | null = null;
      for (const room of s.rooms) {
        if (room.startsWith('user:')) { userId = room.slice('user:'.length); break; }
      }
      if (!userId) continue;
      userBySocket.push({ socket: s, userId });
      userIdSet.add(userId);
    }
    if (userBySocket.length === 0) return;

    const users = await prisma.user.findMany({
      where: { id: { in: [...userIdSet] } },
      select: { id: true, dateOfBirth: true },
      take: 1000,
    });
    const minorByUser = new Map<string, boolean>();
    for (const u of users) minorByUser.set(u.id, isUnderEighteen(u.dateOfBirth));

    let evicted = 0;
    for (const { socket, userId } of userBySocket) {
      // Sockets whose user record is missing are treated as minors —
      // fail-closed matches the discovery filter convention.
      if (!(minorByUser.get(userId) ?? true)) continue;
      socket.leave(`channel:${channelId}`);
      evicted++;
    }

    log.info(
      { channelId, candidates: userBySocket.length, evicted, event: 'age-gate-evict' },
      'evicted minor sockets from age-gated channel',
    );
  } catch (err) {
    log.error(
      { err, channelId, event: 'age-gate-evict-failed' },
      'evictMinorSocketsFromAgeGatedChannel failed; affected sockets will pick up on next reconnect',
    );
  }
}
