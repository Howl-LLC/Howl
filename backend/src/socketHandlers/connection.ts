// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { SocketContext } from './types.js';
import './types.js'; // Socket module augmentation
import { prisma } from '../db.js';
import { logger as _logger } from '../logger.js';
import { getIsShuttingDown } from '../shutdown.js';
import {
  addUserSocket, removeUserSocket, isUserConnected as redisIsUserConnected,
  getUserSocketCount,
  removeVoiceParticipant, setVoiceReverseLookup, deleteVoiceOverride, getVoiceParticipants,
  removeDmCallParticipant, setDmCallReverseLookup, dmCallSize, addDmCallDeclined,
  isInDmCall, isDmCallDeclined,
  markRecentDmCallPresence,
  getDmCallStartTime, deleteDmCallStartTime,
  getDmCallParticipants,
  clearSocketRateLimit,
  clearOfflineGrace,
  publicVoiceParticipant,
  removeUserFromAllStreams, clearOwnedStreams,
  acquireDisconnectCleanupLock, releaseDisconnectCleanupLock,
  tryAcquireStatusReconcileLock,
} from '../redis.js';
import { removeFromSet, isInSet, getSetMembers, getActiveStageSpeakers } from '../routes/stages.js';
import { scheduleGraceEnd } from '../stageGraceTimers.js';
import { hashToken as _hashToken } from '../utils/sessionUtils.js';
import {
  userSocketCount, MAX_SOCKETS_PER_USER, offlineGraceTimers, MAX_OFFLINE_GRACE_SIZE,
  broadcastPresenceChange, checkVoiceInactivity, checkDmCallInactivity,
  createDmCallSystemMessage, stopDmCallRing, cappedMapSet, cappedTimerMapSet,
  checkSocketRateLimit as _checkSocketRateLimit,
  terminateLoneCallerDmCall, dmCallRingTimers,
} from './infrastructure.js';
import { getTokenHashToSockets } from './auth.js';
import { scheduleVoiceE2eeRotate, rotateStageLeaderAndKey } from '../services/voiceE2eeRotation.js';
import { hasPermission, hasChannelPermission } from '../utils/permissions.js';
import type { PermissionContext, PermissionOverride } from '../utils/permissions.js';
import { emitServersInitialState } from './channels.js';
import { isUnderEighteen } from '../utils/discoveryFilters.js';

export const SOCKET_REVALIDATION_MS = 5 * 60 * 1000; // 5 minutes
const OFFLINE_GRACE_MS = 7_000;

// Instance-local map: userId → pre-disconnect desired status (`idle` / `dnd` /
// `online`). Populated when the offline grace timer fires, just before flipping
// the DB to `offline`. Consumed on next reconnect so we can restore the user's
// prior status instead of blindly resetting to `online`. `invisible` is NOT
// stashed here — the grace path already leaves `invisible` rows untouched, so
// the DB itself carries that state across reconnects.
//
// Scope: instance-local. If the firing replica dies before reconnect, the entry
// is lost and the user falls back to `online` — acceptable degradation; we
// never lose `invisible` (DB-preserved) and the worst case for `dnd`/`idle` is
// a single reconnect that silently upgrades to `online`.
const MAX_PRE_DISCONNECT_STATUS_SIZE = 100_000;
const preDisconnectStatus = new Map<string, string>();

/**
 * Pure revalidation logic — extracted for testability. The periodic tick runs
 * this and then dispatches the returned verdict to the socket. Three outcomes:
 *  - `ok`            → session row present, user not suspended; keep connection
 *  - `session-revoked` → session row missing; tear down with "Session revoked"
 *  - `suspended`     → user row has `suspended: true`; tear down with "Account suspended"
 *  - `transient`     → DB error; caller should NOT disconnect (retry next interval)
 *
 * Separating the decision from the socket effect lets unit tests assert the
 * decision matrix without booting a Socket.IO server or waiting 5 minutes.
 */
export type RevalidationVerdict =
  | { kind: 'ok' }
  | { kind: 'session-revoked' }
  | { kind: 'suspended' }
  | { kind: 'transient'; err: unknown };

export async function revalidateSocketSession(
  sessionId: string,
): Promise<RevalidationVerdict> {
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, user: { select: { suspended: true } } },
    });
    if (!session) return { kind: 'session-revoked' };
    if (session.user.suspended) return { kind: 'suspended' };
    return { kind: 'ok' };
  } catch (err) {
    return { kind: 'transient', err };
  }
}

export function registerConnectionHandlers(ctx: SocketContext): void {
  const { io, socket, userId, socketTokenHash, socketSessionId } = ctx;
  const tokenHashToSockets = getTokenHashToSockets();

  // Track socket in tokenHash → socketId map for session invalidation
  if (!tokenHashToSockets.has(socketTokenHash)) tokenHashToSockets.set(socketTokenHash, new Set());
  tokenHashToSockets.get(socketTokenHash)!.add(socket.id);

  // Periodic session revalidation — look up by session.id, NOT tokenHash.
  // session.tokenHash rotates on every access-token refresh (auth.ts /refresh
  // endpoint), while session.id is the primary key and never changes. Before
  // this fix, the first token refresh (≤15 min after login) made the tokenHash
  // query return null and the user was kicked at the next revalidation tick.
  const log = _logger.child({ userId, socketId: socket.id, sessionId: socketSessionId });
  // Per-socket ±30s jitter on the 5-min revalidation cadence. Without this,
  // 10K sockets created within the same connect-storm window would all hit
  // `session.findUnique` in the same second every 5 min — a thundering herd
  // against Postgres. Recursive setTimeout (vs setInterval) so each tick
  // re-rolls jitter independently.
  let revalidationTimer: NodeJS.Timeout | null = null;
  const scheduleRevalidation = () => {
    const jitterMs = Math.floor(Math.random() * 60_000) - 30_000;
    revalidationTimer = setTimeout(async () => {
      const verdict = await revalidateSocketSession(socketSessionId);
      if (verdict.kind === 'session-revoked') {
        socket.emit('session-expired', { reason: 'Session revoked' });
        socket.disconnect(true);
        return;
      }
      if (verdict.kind === 'suspended') {
        // Account suspended since connect — REST rejects these within the
        // ≤60s suspended-cache TTL, but without this check the socket would
        // keep flowing presence/voice/stage events until the next tick.
        socket.emit('session-expired', { reason: 'Account suspended' });
        socket.disconnect(true);
        return;
      }
      if (verdict.kind === 'transient') {
        log.warn({ err: verdict.err, userId }, 'Session revalidation error -- will retry next interval');
      }
      scheduleRevalidation();
    }, SOCKET_REVALIDATION_MS + jitterMs);
  };
  scheduleRevalidation();

  socket.on('disconnect', () => {
    if (revalidationTimer) clearTimeout(revalidationTimer);
    const sids = tokenHashToSockets.get(socketTokenHash);
    if (sids) {
      sids.delete(socket.id);
      if (sids.size === 0) tokenHashToSockets.delete(socketTokenHash);
    }
  });

  // If the auth middleware flagged this socket for hard rejection, emit the
  // must-update event now (client is connected and can receive it), then
  // disconnect. Skip all other connection setup.
  if (socket.data.mustUpdateReason) {
    socket.emit('must-update', { reason: socket.data.mustUpdateReason, autoUpdateHint: true });
    setTimeout(() => socket.disconnect(true), 250);
    return;
  }

  // If the auth middleware flagged a soft warning (45-60 days old), emit it
  // on connect. The client banner is dismissable and won't re-raise once the
  // user clicks X this session.
  if (socket.data.softUpdateWarning) {
    socket.emit('update-recommended', { reason: 'buildDate', softWarningOnly: true });
  }

  void (async () => {
    // Per-user connection count enforcement (Redis-backed for multi-instance)
    const currentCount = await getUserSocketCount(userId);
    if (currentCount >= MAX_SOCKETS_PER_USER) {
      socket.emit('error', { message: 'Too many connections' });
      socket.disconnect(true);
      return;
    }
    userSocketCount.set(userId, (userSocketCount.get(userId) || 0) + 1);

    // Cancel any pending offline grace timer on reconnect
    const pendingOffline = offlineGraceTimers.get(userId);
    const hadGraceTimer = !!pendingOffline;
    if (pendingOffline) {
      clearTimeout(pendingOffline);
      offlineGraceTimers.delete(userId);
    }
    if (hadGraceTimer) {
      clearOfflineGrace(userId).catch(() => {});
    }

    const wasFirstConnection = await addUserSocket(userId, socket.id);
    socket.join(`user:${userId}`);

    // Reset the per-user socket-event rate-limit counter when this socket is
    // the user's only active one. The counter has a 10s window and is meant
    // to guard against in-session event spam; carrying stale state across a
    // hard refresh is not what it's for. On hard refresh the disconnect
    // handler's `clearSocketRateLimit` (in the disconnect callback below)
    // often can't run before the new socket arrives — Socket.IO's disconnect
    // is fired lazily and the new TCP connection races ahead of the old
    // socket's teardown, so `stillConnected` evaluates true and the reset is
    // skipped. That strands the user with a counter from the prior session
    // which then throttles their first post-refresh `join-dm-call` (and any
    // other rate-limited socket action) with a confusing "Rate limited"
    // error. wasFirstConnection guards against clearing another tab's
    // counter when the user has concurrent sockets (multi-tab / multi-
    // device).
    if (wasFirstConnection) {
      clearSocketRateLimit(userId);
    }

    // Defer the DB status reconcile + inactivity-refresh side effects 5–10s
    // off the connect hot path. At launch a connect-storm of ~10K sockets
    // arrives in seconds; running `user.findUnique` + conditional `user.update`
    // + `session.findFirst` + `gameStatsCache.updateMany` synchronously on
    // every handshake hammers Postgres at the worst possible moment.
    //
    // Safe to defer: nothing in the connect-time response depends on these
    // writes — presence is already correct in Redis (addUserSocket above),
    // status changes propagate via socket events, and the inactivity refresh
    // is best-effort. A user's `status` row may be stale by 5–10s post-connect;
    // observers see the corrective presence-update (broadcastPresenceChange)
    // when the deferred work completes.
    //
    // .unref() so a hot-shutdown doesn't block on pending status reconciles.
    const reconcileDelay = 5_000 + Math.floor(Math.random() * 5_000);
    setTimeout(() => {
      // If the socket disconnected during the 5–10s defer window, bail out.
      // Otherwise the offline-grace timer (7s) may have already
      // fired, stashed the prior status in `preDisconnectStatus`, and
      // flipped the DB to `offline` — and this deferred reconcile would
      // then read the stash and resurrect the user back to whatever was
      // stashed, causing visible status flapping during reconnect storms.
      // The grace timer + reconnect path on the next socket handles the
      // restoration correctly without our interference.
      if (socket.disconnected) return;
      void (async () => {
        // SETNX gate: skip the DB write if another socket for this user
        // already reconciled within the last 60s. Crucial during connect-
        // storms — without this, a user with N reconnecting tabs runs N
        // identical user.update writes seconds apart. Skipped reconciles
        // still get correct presence via Redis (already updated above).
        const shouldReconcileStatus = await tryAcquireStatusReconcileLock(userId).catch(() => true);

        // Clear the preDisconnectStatus entry unconditionally once a
        // post-connect reconcile fires for this user. If we won the SETNX
        // we'll consume the stash below; if we lost it, the holder either
        // already consumed-and-cleared it or will, and either way leaving
        // a stale entry behind risks an LRU-bound leak (entries persist
        // until the 100K cap evicts them). One read+delete is cheap.
        const stashed = preDisconnectStatus.get(userId);
        preDisconnectStatus.delete(userId);

        if (shouldReconcileStatus) {
          // When the DB shows `offline`, restore the user's pre-disconnect
          // status (e.g. `dnd`, `idle`) captured by the grace timer before
          // it flipped them offline. Falls back to `online` if no prior
          // status was stashed (fresh login, cross-replica failover, or the
          // user really was `online`).
          const u = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } }).catch(() => null);
          if (u) {
            const newStatus = u.status === 'offline' ? (stashed ?? 'online') : u.status;
            if (newStatus !== u.status) {
              await prisma.user.update({ where: { id: userId }, data: { status: newStatus } }).catch(() => {});
            }
            // If a grace timer was pending, the user was never visibly
            // offline to others (grace hadn't fired), so no corrective
            // broadcast is needed.
            if (!hadGraceTimer && newStatus !== u.status) {
              broadcastPresenceChange(userId, newStatus);
            }
          }
        }

        if (wasFirstConnection) {
          // Queue showcase refresh for users returning after 5+ days of inactivity
          const INACTIVITY_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000;
          const inactivityCutoff = new Date(Date.now() - INACTIVITY_THRESHOLD_MS);

          const latestSession = await prisma.session.findFirst({
            where: { userId },
            orderBy: { lastActiveAt: 'desc' },
            select: { lastActiveAt: true },
          }).catch(() => null);

          if (latestSession && latestSession.lastActiveAt < inactivityCutoff) {
            await prisma.gameStatsCache.updateMany({
              where: {
                gameAccount: { userId },
                nextRefreshAt: { gt: new Date() },
              },
              data: { nextRefreshAt: new Date() },
            }).catch(() => {});
          }
        }
      })().catch(() => {});
    }, reconcileDelay).unref();

  })().catch(() => {});

  // Auto-subscribe to all rooms the user can currently see
  //
  // On connect, batch-load the user's server/DM/channel memberships from
  // Postgres and put the socket into the matching Socket.IO rooms
  // (`server:*`, `channel:*`, `dm:*`). This replaces the old pattern where
  // the client fired one `join-*` emission per room on bootstrap — which,
  // for any user in a handful of moderately-populated servers, exhausted the
  // per-user 30-events/10s `checkSocketRateLimit` counter and silently
  // throttled their first in-session action (e.g. `join-dm-call` → "Rate
  // limited"). Client-side bootstrap emissions are now redundant; the
  // `join-server` / `join-channel` / `join-dm` handlers remain registered
  // as a fallback for older clients during the deploy skew window.
  //
  // Independent IIFE from the presence/status block above: a failure here
  // (Prisma, permission lookup, etc.) must not block status reconciliation
  // or voice/call cleanup. Client falls back to explicit joins if this fails.
  void (async () => {
    const connectStart = Date.now();
    try {
      const [memberRows, dmParticipants, bans, userRow] = await Promise.all([
        prisma.serverMember.findMany({
          where: { userId },
          include: { memberRoles: { include: { role: true } } },
          take: 1000,
        }),
        prisma.dMParticipant.findMany({
          where: { userId },
          select: { dmChannelId: true },
          take: 1000,
        }),
        prisma.serverBan.findMany({
          where: { userId },
          select: { serverId: true },
          take: 1000,
        }),
        prisma.user.findUnique({
          where: { id: userId },
          select: { dateOfBirth: true },
        }),
      ]);

      // Fail-closed when DOB is missing — matches the discovery filter
      // convention used by `isUnderEighteen`. Drives the per-channel
      // age-gate filter below.
      const isMinor = isUnderEighteen(userRow?.dateOfBirth ?? null);

      if (memberRows.length === 0 && dmParticipants.length === 0) return;

      const bannedServerIds = new Set(bans.map(b => b.serverId));
      const activeMemberRows = memberRows.filter(m => !bannedServerIds.has(m.serverId));
      const activeServerIds = activeMemberRows.map(m => m.serverId);

      const [everyoneRoles, subscribableChannels] = await Promise.all([
        activeServerIds.length > 0
          ? prisma.serverRole.findMany({
              where: { serverId: { in: activeServerIds }, isEveryone: true },
              select: { id: true, serverId: true, position: true, permissions: true, isEveryone: true },
              take: 1000,
            })
          : Promise.resolve([]),
        // Include text, stage, and forum. Voice channels use a separate
        // `voice:${id}` room so the `channel:${id}` subscription is a no-op
        // for them — keeping them out of this set saves per-user memory
        // without losing any events. The pre-change client joined all
        // channel types unfiltered (see App.tsx's now-removed bootstrap
        // loop); stage events (stage-started/ended/speaker-*, etc.) and
        // forum events (forum-tag-*, new-message for forum posts) broadcast
        // to `channel:${id}`, so they MUST be included here to avoid a
        // behavior regression.
        activeServerIds.length > 0
          ? prisma.channel.findMany({
              where: { serverId: { in: activeServerIds }, type: { in: ['text', 'stage', 'forum'] } },
              select: { id: true, serverId: true, isPrivate: true, categoryId: true, ageRestricted: true },
              take: 5001,
            })
          : Promise.resolve([]),
      ]);

      if (subscribableChannels.length > 5000) {
        _logger.warn(
          { userId, channelCount: subscribableChannels.length, cap: 5000, event: 'auto-subscribe-cap-hit' },
          'auto-subscribe channel cap hit; some channels may not be joined until the client emits explicit join-channel',
        );
      }

      // Build per-server PermissionContext from the batched rows. Mirrors
      // `loadPermissionContext` but fed from pre-fetched data so we pay one
      // round trip instead of 2 × serverCount.
      const everyoneRoleByServer = new Map<string, { id: string; position: number; permissions: unknown; isEveryone: boolean }>();
      for (const r of everyoneRoles) {
        everyoneRoleByServer.set(r.serverId, { id: r.id, position: r.position, permissions: r.permissions, isEveryone: r.isEveryone });
      }
      const ctxByServer = new Map<string, PermissionContext>();
      for (const m of activeMemberRows) {
        const roles = m.memberRoles.map((mr) => ({
          id: mr.role.id,
          position: mr.role.position,
          permissions: mr.role.permissions,
          isEveryone: mr.role.isEveryone,
        }));
        ctxByServer.set(m.serverId, {
          member: { userId: m.userId, role: m.role },
          roles,
          everyoneRole: everyoneRoleByServer.get(m.serverId) ?? null,
        });
      }

      // Server-level filter: viewChannels + readMessageHistory. Matches the
      // gate in the `join-channel` handler.
      const candidateChannels = subscribableChannels.filter((ch) => {
        const ctx = ctxByServer.get(ch.serverId);
        if (!ctx) return false;
        return hasPermission(ctx, 'viewChannels') && hasPermission(ctx, 'readMessageHistory');
      });

      const candidateChannelIds = candidateChannels.map((c) => c.id);
      const categoryIds = [...new Set(candidateChannels.map((c) => c.categoryId).filter((id): id is string => !!id))];
      const [channelOverrides, categoryOverrides] = await Promise.all([
        candidateChannelIds.length > 0
          ? prisma.channelPermissionOverride.findMany({
              where: { channelId: { in: candidateChannelIds } },
              take: 10000,
            })
          : Promise.resolve([]),
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

      // Per-channel gate with overrides. Mirrors the second half of the
      // `join-channel` handler: private channels require viewChannels at the
      // channel tier, all channels require readMessageHistory at the channel
      // tier. Age-gated channels are dropped for minors so the socket never
      // joins the broadcast room — closes the live fan-out path that the
      // REST `denyIfAgeGated` gate alone does not cover.
      const visibleChannelIds: string[] = [];
      for (const ch of candidateChannels) {
        if (isMinor && (ch as { ageRestricted?: boolean }).ageRestricted) continue;
        const ctx = ctxByServer.get(ch.serverId);
        if (!ctx) continue;
        const chOvrs = channelOvrByCh.get(ch.id) ?? [];
        const catOvrs = ch.categoryId ? (catOvrByCat.get(ch.categoryId) ?? []) : [];
        if (ch.isPrivate && !hasChannelPermission(ctx, 'viewChannels', chOvrs, catOvrs, undefined, { requireOverride: true })) continue;
        if (!hasChannelPermission(ctx, 'readMessageHistory', chOvrs, catOvrs)) continue;
        visibleChannelIds.push(ch.id);
      }

      // Join rooms in-memory. socket.join is idempotent — a later client-side
      // explicit join (older client) is a no-op.
      for (const serverId of activeServerIds) socket.join(`server:${serverId}`);
      for (const channelId of visibleChannelIds) socket.join(`channel:${channelId}`);
      for (const dmp of dmParticipants) socket.join(`dm:${dmp.dmChannelId}`);

      // Initial voice/stage state per server. Batched: 2 Prisma queries +
      // N parallel Redis reads instead of 2N Prisma queries.
      await emitServersInitialState(socket, activeServerIds);

      _logger.info(
        {
          userId,
          serverCount: activeServerIds.length,
          channelCount: visibleChannelIds.length,
          dmCount: dmParticipants.length,
          ms: Date.now() - connectStart,
          event: 'auto-subscribe',
        },
        'socket auto-subscribe complete',
      );
    } catch (err) {
      _logger.error(
        { err, userId, event: 'auto-subscribe-failed' },
        'socket auto-subscribe failed — client will fall back to explicit join-* events',
      );
    }
  })();

  // Capture channel / call rooms before disconnect clears them. We do this in
  // 'disconnecting' (not 'disconnect') because Socket.IO clears socket.rooms
  // before the 'disconnect' event fires.
  let stageChannelIds: string[] = [];
  let disconnectingVoiceChannelIds: string[] = [];
  let disconnectingDmCallIds: string[] = [];
  socket.on('disconnecting', () => {
    const rooms = [...socket.rooms];
    stageChannelIds = rooms.filter(r => r.startsWith('channel:')).map(r => r.slice('channel:'.length));
    disconnectingVoiceChannelIds = rooms.filter(r => r.startsWith('voice:')).map(r => r.slice('voice:'.length));
    disconnectingDmCallIds = rooms.filter(r => r.startsWith('dm-call:')).map(r => r.slice('dm-call:'.length));
  });

  // Main disconnect handler: presence, voice, DM call cleanup
  socket.on('disconnect', async () => {
    const count = userSocketCount.get(userId) || 1;
    if (count <= 1) userSocketCount.delete(userId);
    else userSocketCount.set(userId, count - 1);

    await removeUserSocket(userId, socket.id);

    const stillConnected = await redisIsUserConnected(userId);
    if (!stillConnected) {
      const uid = userId;
      const timer = setTimeout(async () => {
        offlineGraceTimers.delete(uid);
        // Re-check at fire time: another socket for this user may have
        // connected during the grace window (multi-device: Electron + web).
        // `removeUserSocket` ran before `redisIsUserConnected` above when we
        // scheduled this timer, and reconnects during the window clear the
        // timer outright (see lines above), so a `true` result here reflects
        // a genuine concurrent socket we must not stomp with `offline`.
        const reconnected = await redisIsUserConnected(uid).catch(() => false);
        if (reconnected) return;

        const u = await prisma.user.findUnique({ where: { id: uid }, select: { status: true } }).catch(() => null);
        if (u && u.status !== 'invisible' && u.status !== 'offline') {
          // Stash the pre-disconnect status so the next reconnect can restore
          // it (dnd/idle should not silently become online). `invisible` is
          // left alone by design — the DB keeps that value across the grace
          // fire. `online` is still stashed so reconnect explicitly restores
          // to `online` rather than relying on the fallback default.
          cappedMapSet(preDisconnectStatus, uid, u.status, MAX_PRE_DISCONNECT_STATUS_SIZE);
          await prisma.user.update({ where: { id: uid }, data: { status: 'offline' } }).catch(() => {});
          broadcastPresenceChange(uid, 'offline');
        }

        // Clear detected_game activities on disconnect (Steam activities are server-managed)
        const detectedActivity = await prisma.userActivity.findUnique({
          where: { userId: uid },
          select: { id: true, type: true },
        }).catch(() => null);
        if (detectedActivity && detectedActivity.type === 'detected_game') {
          await prisma.userActivity.delete({ where: { id: detectedActivity.id } }).catch(() => {});
          // Promote secondary if it exists
          const { promoteSecondaryToPrimary } = await import('../services/secondaryActivity.js');
          await promoteSecondaryToPrimary(uid);
          const { fetchAndBroadcastActivities } = await import('./infrastructure.js');
          fetchAndBroadcastActivities(uid).catch(() => {});
        } else {
          // Also check if detected_game was in secondary
          const { clearSecondaryByType } = await import('../services/secondaryActivity.js');
          await clearSecondaryByType(uid, 'detected_game');
        }

        // Temporary-membership eviction moved to the cleanup worker
        // (purgeExpiredTemporaryMembers, runs every 5 minutes). The legacy
        // disconnect-grace kick was surprising for fresh joiners who closed
        // a tab before assigning a role; the new behavior keys removal to
        // the originating invite's expiresAt instead.
      }, OFFLINE_GRACE_MS);
      cappedTimerMapSet(offlineGraceTimers, uid, timer, MAX_OFFLINE_GRACE_SIZE, clearTimeout);
    }

    // Voice/DM-call cleanup uses a Redis SETNX lock per (userId, room) so
    // exactly ONE socket per disconnect group runs cleanup, even when N
    // sockets of the same user disconnect in the same event-loop tick.
    // Previously a `fetchSockets()` snapshot + per-socket `stillHeld` check
    // was racy: if all N disconnects fired in one tick, each handler saw
    // the others as "still in the room" and skipped cleanup, orphaning the
    // participant row in Redis until a heartbeat reaper noticed. The lock
    // has a 5-second TTL so it auto-releases if the holder crashes mid-
    // cleanup. We release explicitly at the end of each loop iteration so a
    // quick reconnect-then-disconnect doesn't have to wait the full TTL.

    // Voice cleanup
    for (const voiceChannelId of disconnectingVoiceChannelIds) {
      const acquired = await acquireDisconnectCleanupLock(`voice:${voiceChannelId}`, userId);
      if (!acquired) continue;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await Promise.all([
            removeVoiceParticipant(voiceChannelId, userId),
            setVoiceReverseLookup(userId, null),
            deleteVoiceOverride(voiceChannelId, userId),
          ]);
          break;
        } catch (err) {
          if (attempt === 2) _logger.error({ err, userId, voiceChannelId, event: 'disconnect-voice-cleanup-failed' }, 'Failed to clean up voice participant after 3 attempts');
          else await new Promise(r => setTimeout(r, 500));
        }
      }
      // Stream viewer cleanup for voice disconnect
      if (!getIsShuttingDown()) {
        const voiceCtx = { kind: 'voice' as const, scopeId: voiceChannelId };
        const viewerRemoved = await removeUserFromAllStreams(userId, voiceCtx).catch(() => []);
        for (const r of viewerRemoved) {
          io.to(`voice:${voiceChannelId}`).emit('viewer:changed', {
            context: voiceCtx, streamOwnerId: r.streamOwnerId, streamType: r.streamType, remove: [userId],
          });
        }
        const ownedCleared = await clearOwnedStreams(userId, voiceCtx).catch(() => []);
        for (const r of ownedCleared) {
          io.to(`voice:${voiceChannelId}`).emit('viewer:cleared', {
            context: voiceCtx, streamOwnerId: userId, streamType: r.streamType,
          });
        }
      }

      if (!getIsShuttingDown()) socket.to(`voice:${voiceChannelId}`).emit('voice-user-left', { userId });
      const channel = await prisma.channel.findUnique({ where: { id: voiceChannelId }, select: { serverId: true } }).catch(() => null);
      const remainingVoiceParticipants = await getVoiceParticipants(voiceChannelId).catch(() => []);
      if (channel?.serverId && !getIsShuttingDown()) {
        io.to(`server:${channel.serverId}`).emit('server-voice-participants', { serverId: channel.serverId, channelId: voiceChannelId, participants: remainingVoiceParticipants.map(publicVoiceParticipant) });
      }
      // forward secrecy on abrupt departure. The graceful
      // leave-voice-channel handler rotates the SFrame key; the common
      // crash/close/sleep/drop path did not, leaving the departed member's
      // key live for the rest of the session. Mirror the graceful debounced
      // rotate via the shared helper so the two paths cannot drift.
      if (!getIsShuttingDown()) scheduleVoiceE2eeRotate(io, voiceChannelId, remainingVoiceParticipants.length > 0);
      checkVoiceInactivity(voiceChannelId);
      await releaseDisconnectCleanupLock(`voice:${voiceChannelId}`, userId).catch(() => {});
    }

    for (const dmCallId of disconnectingDmCallIds) {
      const acquired = await acquireDisconnectCleanupLock(`dm-call:${dmCallId}`, userId);
      if (!acquired) continue;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await Promise.all([
            removeDmCallParticipant(dmCallId, userId),
            setDmCallReverseLookup(userId, null),
            addDmCallDeclined(dmCallId, userId),
            markRecentDmCallPresence(dmCallId, userId),
          ]);
          break;
        } catch (err) {
          if (attempt === 2) _logger.error({ err, userId, dmCallId, event: 'disconnect-dm-cleanup-failed' }, 'Failed to clean up DM call participant after 3 attempts');
          else await new Promise(r => setTimeout(r, 500));
        }
      }
      // Stream viewer cleanup for DM disconnect
      if (!getIsShuttingDown()) {
        const dmCtx = { kind: 'dm' as const, scopeId: dmCallId };
        const viewerRemoved = await removeUserFromAllStreams(userId, dmCtx).catch(() => []);
        for (const r of viewerRemoved) {
          io.to(`dm-call:${dmCallId}`).emit('viewer:changed', {
            context: dmCtx, streamOwnerId: r.streamOwnerId, streamType: r.streamType, remove: [userId],
          });
        }
        const ownedCleared = await clearOwnedStreams(userId, dmCtx).catch(() => []);
        for (const r of ownedCleared) {
          io.to(`dm-call:${dmCallId}`).emit('viewer:cleared', {
            context: dmCtx, streamOwnerId: userId, streamType: r.streamType,
          });
        }
      }

      if (!getIsShuttingDown()) io.to(`dm-call:${dmCallId}`).emit('dm-call-declined', { userId, dmChannelId: dmCallId });
      const remainingSize = await dmCallSize(dmCallId);
      if (remainingSize === 0) {
        stopDmCallRing(dmCallId);
        const startTime = await getDmCallStartTime(dmCallId);
        await deleteDmCallStartTime(dmCallId);
        const durationMs = startTime ? Date.now() - startTime : 0;
        const durationSec = Math.round(durationMs / 1000);
        createDmCallSystemMessage(dmCallId, userId, 'Call ended', 'call_ended', { durationSeconds: durationSec });
        if (!getIsShuttingDown()) io.to(`dm:${dmCallId}`).emit('dm-call-ended', { dmChannelId: dmCallId });
      } else if (remainingSize === 1 && !getIsShuttingDown() && dmCallRingTimers.has(dmCallId)) {
        // Disconnected callee was a ringing recipient (call still in ring
        // phase). If every other DM participant has now declined or is in
        // the call, the lone remaining person is the caller with nobody
        // left to answer — end the call so their ringback stops.
        try {
          const dmParticipants = await prisma.dMParticipant.findMany({
            where: { dmChannelId: dmCallId },
            select: { userId: true },
            take: 100,
          });
          const allHandled = (await Promise.all(
            dmParticipants.map(async (p) =>
              (await isInDmCall(dmCallId, p.userId)) || (await isDmCallDeclined(dmCallId, p.userId))
            ),
          )).every(Boolean);
          if (allHandled) {
            await terminateLoneCallerDmCall(dmCallId, 'all_declined');
          }
        } catch { /* best-effort */ }
      }
      if (!getIsShuttingDown()) io.to(`dm-call:${dmCallId}`).emit('dm-call-user-left', { userId });
      checkDmCallInactivity(dmCallId);

      if (!getIsShuttingDown()) {
        try {
          const callParticipants = await getDmCallParticipants(dmCallId);
          // Emit the full cosmetic payload (banner, name styling, avatar
          // effect, plan) so the DM call-preview banner renders correctly
          // after an abrupt disconnect. Previously the disconnect path
          // emitted only { userId, username, avatar }, which overwrote the
          // richer data set by broadcastCallStatus with bare records.
          io.to(`dm:${dmCallId}`).emit('dm-call-status-changed', {
            dmChannelId: dmCallId,
            active: callParticipants.length > 0,
            participants: callParticipants.map(p => ({
              userId: p.userId,
              username: p.username,
              avatar: p.avatar ?? null,
              banner: p.banner ?? null,
              bannerPositionY: p.bannerPositionY ?? 50,
              bannerZoom: p.bannerZoom ?? 100,
              nameColor: p.nameColor ?? null,
              nameFont: p.nameFont ?? null,
              nameEffect: p.nameEffect ?? null,
              avatarEffect: p.avatarEffect ?? null,
              effectivePlan: p.effectivePlan ?? null,
            })),
          });
        } catch { /* best-effort */ }
      }
      await releaseDisconnectCleanupLock(`dm-call:${dmCallId}`, userId).catch(() => {});
    }

    // Clean up stage membership (audience, hands, AND speakers)
    for (const channelId of stageChannelIds) {
      // Mirror the voice/DM-call loops above: a per-(user, channel) Redis lock
      // so exactly ONE socket of a multi-socket user runs stage cleanup. The
      // rotateStageLeaderAndKey below is NOT debounced (unlike voice's
      // scheduleVoiceE2eeRotate), so without this lock N sockets of one
      // speaker disconnecting in the same tick each fire a rotate — N
      // stage-e2ee-rotate broadcasts, N fresh host session keys, and audience
      // members landing on mismatched keys with no automatic repair.
      const acquired = await acquireDisconnectCleanupLock(`stage:${channelId}`, userId);
      if (!acquired) continue;
      // Stream viewer cleanup for stage disconnect
      if (!getIsShuttingDown()) {
        const stageCtx = { kind: 'stage' as const, scopeId: channelId };
        const viewerRemoved = await removeUserFromAllStreams(userId, stageCtx).catch(() => []);
        for (const r of viewerRemoved) {
          io.to(`channel:${channelId}`).emit('viewer:changed', {
            context: stageCtx, streamOwnerId: r.streamOwnerId, streamType: r.streamType, remove: [userId],
          });
        }
        const ownedCleared = await clearOwnedStreams(userId, stageCtx).catch(() => []);
        for (const r of ownedCleared) {
          io.to(`channel:${channelId}`).emit('viewer:cleared', {
            context: stageCtx, streamOwnerId: userId, streamType: r.streamType,
          });
        }
      }

      const wasSpeaker = await isInSet(channelId, 'speakers', userId).catch(() => false);
      await removeFromSet(channelId, 'audience', userId).catch(() => {});
      await removeFromSet(channelId, 'hands', userId).catch(() => {});

      if (wasSpeaker) {
        await removeFromSet(channelId, 'speakers', userId).catch(() => {});
        if (!getIsShuttingDown()) io.to(`channel:${channelId}`).emit('stage-speaker-removed', { channelId, userId });
        // Update activity panel
        const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true } }).catch(() => null);
        if (channel?.serverId) {
          const updatedSpeakers = await getActiveStageSpeakers(channelId).catch(() => []);
          if (!getIsShuttingDown()) io.to(`server:${channel.serverId}`).emit('server-stage-participants', {
            serverId: channel.serverId, channelId, participants: updatedSpeakers,
          });
        }
        // when a STAGE SPEAKER (incl. the host) abruptly disconnects,
        // the graceful stage-leave + moderator-remove paths advance the
        // setStageLeader pointer and emit stage-e2ee-rotate; this path did
        // neither, so the leader pointer stayed on the departed host and the
        // leader-gated stage-e2ee-distribute rejected every remaining speaker
        // — no joiner could get a key for the rest of the session. Mirror
        // them via the shared helper so the three paths cannot drift.
        if (!getIsShuttingDown()) await rotateStageLeaderAndKey(io, channelId).catch(() => null);
      } else {
        if (!getIsShuttingDown()) io.to(`channel:${channelId}`).emit('stage-audience-left', { userId, channelId });
      }

      // Auto-end with grace: if no speakers AND no audience remain, start a
      // 60s timer instead of ending immediately. A user whose socket drops
      // briefly (network blip, laptop sleep) gets a chance to reconnect.
      const remainingSpeakers = await getSetMembers(channelId, 'speakers').catch(() => []);
      const remainingAudience = await getSetMembers(channelId, 'audience').catch(() => []);
      if (remainingSpeakers.length === 0 && remainingAudience.length === 0 && !getIsShuttingDown()) {
        scheduleGraceEnd(channelId, io);
      }
      await releaseDisconnectCleanupLock(`stage:${channelId}`, userId).catch(() => {});
    }

    // Only clear rate limit state when the user has no remaining sockets
    if (!stillConnected) {
      clearSocketRateLimit(userId);
    }
  });
}
