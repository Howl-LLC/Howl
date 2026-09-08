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
import type { PermissionContext, PermissionOverride, RoleLike } from './permissions.js';
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
  opts: { isMinor?: boolean; viewOnly?: boolean } = {},
): Promise<string[]> {
  if (channels.length === 0) return [];

  // Cheap short-circuit: if the server-level gate fails, no channel can pass.
  // Owner / administrator roles short-circuit `hasPermission` to true.
  //
  // `viewOnly` makes this match the "who can SEE this channel"
  // gate used by the stage-participant broadcasts (`emitChannelEventToViewers`)
  // and the authoritative stage-join handler: `viewChannels` only, and — for a
  // PRIVATE channel — via the per-channel override chain. So it ALSO drops this
  // server-level short-circuit: a member granted a private channel ONLY via a
  // channel/category override (no server-wide `viewChannels`) must still be
  // admitted, exactly as the realtime emit admits them; the per-channel
  // `requireOverride` check below is authoritative. Callers that pick real-time
  // MESSAGE recipients must NOT pass it (they need the full read gate here).
  if (!opts.viewOnly && (!hasPermission(ctx, 'viewChannels') || !hasPermission(ctx, 'readMessageHistory'))) {
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
    if (!opts.viewOnly && !hasChannelPermission(ctx, 'readMessageHistory', chOvrs, catOvrs)) continue;
    visible.push(ch.id);
  }
  return visible;
}

/**
 * : server-channel mention / @everyone notification fanout.
 *
 * The notification pipeline (routes/messages.ts, routes/threads.ts, the
 * notification + eventReminder workers) resolves WHO to notify without
 * intersecting that set with WHO can read the channel, and the worker @everyone
 * branch broadcasts the content-bearing `notification-created` (channel name +
 * 200-char body preview) to the whole `server:` room. This leaks private-channel
 * content, in realtime and durably (Notification rows, GET /notifications, 90d).
 *
 * These two helpers give the notification paths a channel-visibility primitive
 * that is reachable from WORKER context (no socket dependency, unlike
 * `emitChannelEventToViewers`, which enumerates connected sockets and so cannot
 * pick durable-row recipients — offline viewers must still get rows).
 *
 * `loadChannelNotifyGate` loads the channel + its override chain + the @everyone
 * role once and decides `provablyOpen`: whether EVERY server member is
 * guaranteed a viewer, in which case the caller keeps the cheap server-room
 * broadcast + unfiltered rows (the dominant public-@everyone case, unchanged, so
 * no per-member cost and no Redis fan-out amplification at 10K members).
 * Otherwise the caller filters recipients through `filterUsersWhoCanViewChannel`
 * and scopes the emit.
 */
export type ChannelNotifyGate = {
  channel: { id: string; serverId: string; isPrivate: boolean; categoryId: string | null; ageRestricted: boolean };
  channelOverrides: PermissionOverride[];
  categoryOverrides: PermissionOverride[];
  everyoneRole: RoleLike | null;
  /**
   * True iff every server member is provably a viewer: a public, non-age-gated
   * channel whose @everyone baseline grants BOTH viewChannels and
   * readMessageHistory (server-level perms are grant-only unions, so an
   * @everyone grant is a sound sufficient condition that the weakest member
   * passes), and no channel/category override touches either permission. When
   * true, the server-room broadcast is audience-equivalent to the viewer set and
   * durable rows may stay unfiltered.
   */
  provablyOpen: boolean;
};

/** Does a single override touch viewChannels or readMessageHistory (allow OR
 *  deny)? Any such override can change the viewer set, so it forces the scoped
 *  path. A `{ sendMessages: false }` announcements override does NOT trip this. */
function overrideTouchesVisibility(o: PermissionOverride): boolean {
  const p = (o.permissions as Record<string, boolean | null> | null) ?? {};
  const vc = p.viewChannels;
  const rmh = p.readMessageHistory;
  return (vc === true || vc === false) || (rmh === true || rmh === false);
}

/**
 * Pure decision (exported for unit tests): given the channel flags, its override
 * rows, and the @everyone role, is every member provably a viewer?
 */
export function computeProvablyOpen(
  channel: { isPrivate: boolean; ageRestricted: boolean },
  channelOverrides: PermissionOverride[],
  categoryOverrides: PermissionOverride[],
  everyoneRole: RoleLike | null,
): boolean {
  if (channel.isPrivate || channel.ageRestricted) return false;
  const everyonePerms = (everyoneRole?.permissions as Record<string, boolean> | null) ?? {};
  const baselineOpen =
    everyonePerms.administrator === true ||
    (everyonePerms.viewChannels === true && everyonePerms.readMessageHistory === true);
  if (!baselineOpen) return false;
  if (channelOverrides.some(overrideTouchesVisibility)) return false;
  if (categoryOverrides.some(overrideTouchesVisibility)) return false;
  return true;
}

/**
 * Load the channel, its channel+category override chain, and the server's
 * @everyone role, then compute `provablyOpen`. Returns null when the channel
 * does not exist or is not a server channel (a DM channel id yields null =
 * fail-closed for the notification paths). THROWS on DB error — callers must
 * treat a throw as "do not fan out" rather than falling back to a broadcast.
 */
export async function loadChannelNotifyGate(channelId: string): Promise<ChannelNotifyGate | null> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, serverId: true, isPrivate: true, categoryId: true, ageRestricted: true },
  });
  if (!channel || !channel.serverId) return null;

  const [channelOverrides, categoryOverrides, everyoneRole] = await Promise.all([
    prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 10000 }),
    channel.categoryId
      ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 10000 })
      : Promise.resolve([] as PermissionOverride[]),
    prisma.serverRole.findFirst({
      where: { serverId: channel.serverId, isEveryone: true },
      select: { id: true, position: true, permissions: true, isEveryone: true },
    }),
  ]);

  const gateChannel = {
    id: channel.id,
    serverId: channel.serverId,
    isPrivate: channel.isPrivate,
    categoryId: channel.categoryId,
    ageRestricted: !!channel.ageRestricted,
  };
  return {
    channel: gateChannel,
    channelOverrides,
    categoryOverrides,
    everyoneRole: everyoneRole ?? null,
    provablyOpen: computeProvablyOpen(gateChannel, channelOverrides, categoryOverrides, everyoneRole ?? null),
  };
}

/**
 * Given a notify gate and a batch of candidate user IDs, return the subset that
 * can VIEW the channel per the authoritative REST read gate
 * (`routes/messages.ts:702-707`): the user is a current member, and — for a
 * private channel — holds `viewChannels` via the override chain
 * (`requireOverride`), and holds `readMessageHistory` via the override chain
 * (which falls through to the server base for public channels).
 *
 * The per-user context is built IDENTICALLY to `loadPermissionContext`
 * (memberRoles unfiltered, `everyoneRole` carried on the context) so the
 * notification audience equals the REST-read audience by construction. This is
 * deliberately NOT `filterVisibleChannelIds`' gate, which adds a server-level
 * short-circuit (`hasPermission` pair) the REST read path does not have and
 * would blank out a channel made readable purely by an override.
 *
 * `dropMinors` additionally removes under-18 users (pass the channel's
 * `ageRestricted` flag). Missing user rows fail closed (treated as minors),
 * matching the discovery-filter convention.
 *
 * THROWS on DB error — never returns a silently-partial set. Callers resolve the
 * full set BEFORE any Notification write so a retry cannot duplicate rows.
 */
export async function filterUsersWhoCanViewChannel(params: {
  gate: ChannelNotifyGate;
  candidateUserIds: string[];
  dropMinors?: boolean;
}): Promise<Set<string>> {
  const { gate, candidateUserIds, dropMinors } = params;
  const result = new Set<string>();
  const unique = [...new Set(candidateUserIds)];
  if (unique.length === 0) return result;

  const members = await prisma.serverMember.findMany({
    where: { serverId: gate.channel.serverId, userId: { in: unique } },
    include: { memberRoles: { include: { role: true } } },
    take: unique.length,
  });

  let minorByUser: Map<string, boolean> | null = null;
  if (dropMinors && members.length > 0) {
    const ages = await prisma.user.findMany({
      where: { id: { in: members.map((m) => m.userId) } },
      select: { id: true, dateOfBirth: true },
      take: members.length,
    });
    minorByUser = new Map<string, boolean>();
    for (const u of ages) minorByUser.set(u.id, isUnderEighteen(u.dateOfBirth));
  }

  for (const m of members) {
    if (dropMinors && (minorByUser?.get(m.userId) ?? true)) continue;
    // Build the context exactly as loadPermissionContext does: memberRoles are
    // NOT filtered for isEveryone (matches the REST read path), and the
    // @everyone role rides on the context, NOT as arg 5 (hasChannelPermission
    // ignores arg 5 for context callers).
    const ctx: PermissionContext = {
      member: { userId: m.userId, role: m.role },
      roles: m.memberRoles.map((mr) => ({
        id: mr.role.id,
        position: mr.role.position,
        permissions: mr.role.permissions,
        isEveryone: mr.role.isEveryone,
      })),
      everyoneRole: gate.everyoneRole,
    };
    if (
      gate.channel.isPrivate &&
      !hasChannelPermission(ctx, 'viewChannels', gate.channelOverrides, gate.categoryOverrides, undefined, { requireOverride: true })
    ) {
      continue;
    }
    if (!hasChannelPermission(ctx, 'readMessageHistory', gate.channelOverrides, gate.categoryOverrides)) {
      continue;
    }
    result.add(m.userId);
  }
  return result;
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
 *
 * `dropMinors` additionally removes under-18 members (pass the channel's
 * `ageRestricted` flag). The stage lifecycle emits (`emitStageEventScoped`) use
 * it so an age-restricted stage's existence / topic / roster is never pushed to a
 * minor who can otherwise VIEW the channel. Missing user rows fail closed
 * (treated as minors), matching the discovery-filter convention.
 */
export async function emitChannelEventToViewers(params: {
  io: SocketServer;
  serverId: string;
  channel: { id: string; isPrivate: boolean; categoryId: string | null };
  channelOverrides: PermissionOverride[];
  categoryOverrides: PermissionOverride[];
  event: string;
  payload: unknown;
  dropMinors?: boolean;
}): Promise<void> {
  const { io, serverId, channel, channelOverrides, categoryOverrides, event, payload, dropMinors } = params;
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

    // Age-gated stage emits: pull DOBs for the candidate members so under-18
    // viewers are dropped alongside the visibility gate. One extra round trip,
    // only on the (rare) age-restricted path.
    let minorByUser: Map<string, boolean> | null = null;
    if (dropMinors && members.length > 0) {
      const ages = await prisma.user.findMany({
        where: { id: { in: members.map((m) => m.userId) } },
        select: { id: true, dateOfBirth: true },
        take: members.length,
      });
      minorByUser = new Map<string, boolean>();
      for (const u of ages) minorByUser.set(u.id, isUnderEighteen(u.dateOfBirth));
    }

    let delivered = 0;
    for (const m of members) {
      if (dropMinors && (minorByUser?.get(m.userId) ?? true)) continue;
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
 * the stage lifecycle server-room broadcasts.
 *
 * Every stage action emits both a `channel:${channelId}` leg (correctly scoped —
 * a private channel's room only contains members who passed the `join-channel` /
 * auto-subscribe `viewChannels` gate) AND a `server:${serverId}` leg that fans the
 * stage's existence, topic, and speaker roster (userId / username / avatar) to the
 * WHOLE server, including non-viewers of a private / override-restricted stage
 * channel. This routes the server leg through the same visibility gate as the
 * authoritative stage-join handler (`viewChannels`; private → `requireOverride`):
 *
 *   - `provablyOpen` (public, non-age-gated, @everyone grants view+read, no
 *     visibility override) → keep the single cheap `server:` broadcast. This is
 *     the dominant case, so there is no per-member cost and no Redis fan-out
 *     amplification at 10K members.
 *   - otherwise → deliver only to connected members who can VIEW the channel, via
 *     `emitChannelEventToViewers` (one emit per viewer, matching who sees the
 * channel in their sidebar and who initial bootstrap now serves).
 *
 * Fail-closed: a deleted / non-server channel (null gate) or a DB error SKIPS the
 * emit rather than falling back to a server-wide broadcast. Stage state is
 * self-healing — the next participant change (or a REST `GET /stage`) re-derives
 * the current roster, so a dropped indicator update is invisible.
 *
 * Never throws — callers `void` it at the departure sites (`stage-leave`,
 * abrupt-disconnect, ban/kick eviction) so it cannot delay or skip the
 * forward-secrecy `rotateStageLeaderAndKey` that runs in the same block.
 */
export async function emitStageEventScoped(params: {
  io: SocketServer;
  channelId: string;
  serverId: string;
  event: string;
  payload: unknown;
}): Promise<void> {
  const { io, channelId, serverId, event, payload } = params;
  try {
    const gate = await loadChannelNotifyGate(channelId);
    if (!gate) return; // channel deleted mid-flight / not a server channel → fail closed
    if (gate.provablyOpen) {
      io.to(`server:${serverId}`).emit(event, payload);
      return;
    }
    await emitChannelEventToViewers({
      io,
      serverId,
      channel: { id: gate.channel.id, isPrivate: gate.channel.isPrivate, categoryId: gate.channel.categoryId },
      channelOverrides: gate.channelOverrides,
      categoryOverrides: gate.categoryOverrides,
      event,
      payload,
      // Age-restricted stage: drop minor viewers too. (An age-restricted channel
      // is never `provablyOpen`, so it always reaches this per-viewer path.)
      dropMinors: gate.channel.ageRestricted,
    });
  } catch (err) {
    log.error(
      { err, channelId, serverId, event, action: 'stage-scoped-emit-failed' },
      'emitStageEventScoped failed; clients heal on next stage update',
    );
  }
}

/**
 * Voice age gate: the voice-presence server-room broadcasts.
 *
 * Every voice-presence change emits both a `voice:${channelId}` leg (correctly
 * scoped — that room only holds members who passed the join-voice gate) AND a
 * `server:${serverId}` leg carrying the occupant roster (userId / username /
 * avatar / banner) to the WHOLE server. Two boundaries must scope that leg,
 * matching the authoritative voice-join handler (`socketHandlers/voice.ts`):
 *
 * - VISIBILITY: a PRIVATE voice channel's roster must not leak to
 *     members who cannot VIEW it. A PUBLIC voice channel skips the override check
 *     entirely (joinable by anyone with `connect`), so its roster is not secret.
 *   - AGE (this unit): an `ageRestricted` voice channel's roster must not reach a
 *     MINOR, because `join-voice-channel` now refuses a minor's join, so a minor
 *     can never be an occupant and the indicator would be theatre.
 *
 * Dispatch, keyed on the two flags the caller already holds (no query on the hot
 * path): a PUBLIC, non-age-restricted channel — the dominant case — keeps the
 * single cheap `server:` broadcast (no per-member cost, no Redis fan-out
 * amplification at 10K members). Anything PRIVATE or AGE-RESTRICTED is delivered
 * only to connected members who can VIEW it (`viewChannels` via the channel/
 * category override chain, `requireOverride` for private; public age-restricted
 * still fans per-viewer so `dropMinors` can apply) with under-18 members dropped
 * on the age-restricted branch. Deliberately NOT keyed on `provablyOpen`, which
 * would additionally force per-viewer fan-out on public READ-restricted voice
 * channels the join gate lets everyone into.
 *
 * `ageRestricted` is a REQUIRED param so the compiler forces every one of the
 * ~17 presence-emit sites to thread the flag — a missed site cannot silently
 * fail open and broadcast an age-restricted roster to minors.
 *
 * Fail-closed: a scoped channel with no eligible connected viewers emits nothing;
 * a DB error is caught and skips the emit (voice roster self-heals on the next
 * presence change). Never throws — the departure call sites `void` it so it
 * cannot delay or skip the forward-secrecy `scheduleVoiceE2eeRotate` that runs
 * in the same block.
 */
export async function emitVoicePresenceScoped(params: {
  io: SocketServer;
  channel: { id: string; serverId: string; isPrivate: boolean; categoryId: string | null; ageRestricted: boolean };
  event: string;
  payload: unknown;
}): Promise<void> {
  const { io, channel, event, payload } = params;
  try {
    // Dominant case: public and not age-restricted → joinable by anyone with
    // `connect`, roster is not secret → single cheap broadcast, zero extra query.
    if (!channel.isPrivate && !channel.ageRestricted) {
      io.to(`server:${channel.serverId}`).emit(event, payload);
      return;
    }
    const [channelOverrides, categoryOverrides] = await Promise.all([
      prisma.channelPermissionOverride.findMany({ where: { channelId: channel.id }, take: 10000 }),
      channel.categoryId
        ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 10000 })
        : Promise.resolve([] as PermissionOverride[]),
    ]);
    await emitChannelEventToViewers({
      io,
      serverId: channel.serverId,
      // Pass the real isPrivate so a PUBLIC age-restricted channel stays visible
      // to every (adult) member — only the age drop applies there — while a
      // PRIVATE one keeps the requireOverride view gate.
      channel: { id: channel.id, isPrivate: channel.isPrivate, categoryId: channel.categoryId },
      channelOverrides,
      categoryOverrides,
      event,
      payload,
      // A minor cannot join an age-restricted voice channel (join-voice gate), so
      // its roster must never be pushed to one.
      dropMinors: channel.ageRestricted,
    });
  } catch (err) {
    log.error(
      { err, channelId: channel.id, serverId: channel.serverId, event, action: 'voice-scoped-emit-failed' },
      'emitVoicePresenceScoped failed; clients heal on next voice update',
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
