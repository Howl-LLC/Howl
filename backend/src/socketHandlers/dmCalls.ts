// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { SocketContext } from './types.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { getEffectivePlan } from '../utils.js';
import { getIsShuttingDown } from '../shutdown.js';
import {
  addDmCallParticipant, removeDmCallParticipant, getDmCallParticipants, dmCallSize,
  isInDmCall, isDmCallDeclined, addDmCallDeclined,
  setDmCallReverseLookup, setDmCallStartTime, getDmCallStartTime, deleteDmCallStartTime,
  isDmCallRateLimited, findUserDmCall,
  markRecentDmCallPresence, wasRecentlyInDmCall,
  findUserVoiceChannel, removeVoiceParticipant, deleteVoiceOverride, getVoiceParticipants,
  setVoiceReverseLookup,
  removeUserFromAllStreams, clearOwnedStreams,
} from '../redis.js';
import { parseSocketPayload, joinDmCallPayload, leaveDmCallPayload, declineDmCallPayload, dmCallStatePayload, dmCallE2eeAckPayload } from '../socketSchemas.js';
import { mintLiveKitAccessToken } from '../services/livekitTokens.js';
import { getDefaultRegion } from '../services/livekitRegions.js';
import {
  checkSocketRateLimit,
  createDmCallSystemMessage,
  startDmCallRing, stopDmCallRing, dmCallRingTimers,
  checkDmCallInactivity,
  checkVoiceInactivity,
  terminateLoneCallerDmCall,
} from './infrastructure.js';
import { scheduleVoiceE2eeRotate } from '../services/voiceE2eeRotation.js';

async function broadcastCallStatus(io: SocketContext['io'], dmChannelId: string): Promise<void> {
  try {
    const participants = await getDmCallParticipants(dmChannelId);
    io.to(`dm:${dmChannelId}`).emit('dm-call-status-changed', {
      dmChannelId,
      active: participants.length > 0,
      participants: participants.map(p => ({
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
  } catch { /* best-effort broadcast */ }
}

export function registerDmCallHandlers(ctx: SocketContext): void {
  const { io, socket, userId } = ctx;

  socket.on('join-dm-call', async (raw: unknown, ack?: (response: { ok: boolean; error?: string; token?: string; url?: string }) => void) => {
    // Inline-mint the LiveKit access token in the ACK so the client doesn't
    // need a separate POST /livekit/token round trip (Tier 1 latency
    // optimization — matches Discord's VOICE_SERVER_UPDATE payload shape).
    const callAck = (response: { ok: boolean; error?: string; token?: string; url?: string }) => { try { ack?.(response); } catch { /* client went away */ } };
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); callAck({ ok: false, error: 'Rate limited' }); return; }
      const payload = parseSocketPayload(joinDmCallPayload, raw);
      if (!payload) {
        socket.emit('dm-call-join-error', { dmChannelId: null, message: 'Invalid payload' });
        callAck({ ok: false, error: 'Invalid payload' });
        return;
      }
      const { dmChannelId, mlsCallReady } = payload;

      // Auto-leave active voice channel to prevent dual connections
      const existingVoiceChannel = await findUserVoiceChannel(userId);
      if (existingVoiceChannel) {
        io.in(`user:${userId}`).socketsLeave(`voice:${existingVoiceChannel}`);
        await Promise.all([
          removeVoiceParticipant(existingVoiceChannel, userId),
          deleteVoiceOverride(existingVoiceChannel, userId),
          setVoiceReverseLookup(userId, null),
        ]);
        socket.to(`voice:${existingVoiceChannel}`).emit('voice-user-left', { userId });
        const oldChannel = await prisma.channel.findUnique({ where: { id: existingVoiceChannel }, select: { serverId: true } }).catch(() => null);
        if (oldChannel?.serverId) {
          const oldParticipants = await getVoiceParticipants(existingVoiceChannel);
          io.to(`server:${oldChannel.serverId}`).emit('server-voice-participants', {
            serverId: oldChannel.serverId,
            channelId: existingVoiceChannel,
            participants: oldParticipants,
          });
          // Forward secrecy when leaving a voice channel to join a DM call:
          // the user keeps the old channel's SFrame key, so rotate for the members
          // who remain (parity with the graceful leave-voice-channel rotate).
          scheduleVoiceE2eeRotate(io, existingVoiceChannel, oldParticipants.length > 0);
        }
        // Stream viewer cleanup for the auto-left voice channel
        const oldVoiceCtx = { kind: 'voice' as const, scopeId: existingVoiceChannel };
        const removedVoiceViewers = await removeUserFromAllStreams(userId, oldVoiceCtx).catch(() => []);
        for (const r of removedVoiceViewers) {
          io.to(`voice:${existingVoiceChannel}`).emit('viewer:changed', {
            context: oldVoiceCtx, streamOwnerId: r.streamOwnerId, streamType: r.streamType, remove: [userId],
          });
        }
        const clearedVoiceOwn = await clearOwnedStreams(userId, oldVoiceCtx).catch(() => []);
        for (const r of clearedVoiceOwn) {
          io.to(`voice:${existingVoiceChannel}`).emit('viewer:cleared', {
            context: oldVoiceCtx, streamOwnerId: userId, streamType: r.streamType,
          });
        }

        checkVoiceInactivity(existingVoiceChannel);

        io.to(`user:${userId}`).emit('voice-auto-disconnected', { channelId: existingVoiceChannel });
        logger.info({ userId, channelId: existingVoiceChannel, reason: 'joined-dm-call' }, 'auto-left voice channel');
      }

      const participant = await prisma.dMParticipant.findUnique({
        where: { userId_dmChannelId: { userId, dmChannelId } },
        include: { user: { select: { username: true, avatar: true, banner: true, bannerPositionY: true, bannerZoom: true, nameColor: true, nameFont: true, nameEffect: true, avatarEffect: true, stripePlan: true, stripeStatus: true, stripePeriodEnd: true } } },
      });
      if (!participant) {
        socket.emit('dm-call-join-error', { dmChannelId, message: 'You are not in this DM' });
        callAck({ ok: false, error: 'You are not in this DM' });
        return;
      }

      const otherParticipants = await prisma.dMParticipant.findMany({
        where: { dmChannelId, userId: { not: userId } },
        select: { userId: true },
        take: 100,
      });
      const otherIds = otherParticipants.map(p => p.userId);
      if (otherIds.length > 0) {
        const block = await prisma.block.findFirst({
          where: {
            OR: [
              { blockerId: userId, blockedUserId: { in: otherIds } },
              { blockerId: { in: otherIds }, blockedUserId: userId },
            ],
          },
        });
        if (block) {
          socket.emit('dm-call-join-error', { dmChannelId, message: 'Cannot call this user' });
          callAck({ ok: false, error: 'Cannot call this user' });
          return;
        }
      }

      const username = participant.user.username;
      const avatar = participant.user.avatar ?? undefined;
      const effectivePlan = getEffectivePlan(participant.user);
      const isPro = effectivePlan === 'pro' || effectivePlan === 'essential';
      const nameColor = isPro ? (participant.user.nameColor ?? undefined) : undefined;
      const nameFont = isPro ? (participant.user.nameFont ?? undefined) : undefined;
      const nameEffect = isPro ? (participant.user.nameEffect ?? undefined) : undefined;
      const avatarEffect = isPro ? (participant.user.avatarEffect ?? undefined) : undefined;
      const banner = participant.user.banner ?? undefined;
      const bannerPositionY = participant.user.bannerPositionY ?? 50;
      const bannerZoom = participant.user.bannerZoom ?? 100;
      const alreadyInCall = await isInDmCall(dmChannelId, userId);
      const currentSize = await dmCallSize(dmChannelId);
      const isNewCall = currentSize === 0;

      const MAX_DM_CALL_PARTICIPANTS = 25;
      if (!alreadyInCall && currentSize >= MAX_DM_CALL_PARTICIPANTS) {
        const msg = `This call has reached the maximum of ${MAX_DM_CALL_PARTICIPANTS} participants.`;
        socket.emit('dm-call-join-error', { dmChannelId, message: msg });
        callAck({ ok: false, error: msg });
        return;
      }

      // Only rate-limit brand-new call starts — that's the spam vector
      // (repeatedly ringing a target). Rejoining an ongoing call (others
      // still present, so no ring fires) is expected behavior — network
      // blips, device switches, refresh, mic fiddling — and shouldn't
      // count against the 3-per-30s cap. Also bypass when the user was
      // in THIS DM's call within the last minute: that covers the
      // hard-refresh case where the backend cleaned them up and the call
      // is now empty (`isNewCall=true`), which otherwise counts as a
      // fresh outbound call and throttles the user after just a few
      // refresh cycles.
      const recentlyInThisCall = await wasRecentlyInDmCall(dmChannelId, userId);
      if (!alreadyInCall && isNewCall && !recentlyInThisCall && await isDmCallRateLimited(userId)) {
        const msg = `You're calling too fast. Please wait a moment before trying again.`;
        socket.emit('dm-call-join-error', { dmChannelId, message: msg });
        callAck({ ok: false, error: msg });
        return;
      }

      // Multi-device: transfer call to this socket
      // Skip when the same socket is already in this dm-call room. A
      // same-socket rejoin (frontend reconnect handler firing on socket
      // reconnect, or any spurious useEffect re-run) shouldn't trigger
      // transfer — it churns the room membership, kicks listeners, and
      // creates a fresh LiveKit token that races against the existing
      // Room. socketsLeave() applied to our own socket is what makes the
      // server-broadcast `dm-call-user-left` fire, which the LiveKit room
      // peer handles by ending its participant entry → DUPLICATE_IDENTITY
      // on the next client reconnect. Idempotent rejoin = mint fresh
      // token + ack, nothing else.
      const sameSocketAlreadyInRoom = socket.rooms.has(`dm-call:${dmChannelId}`);
      if (alreadyInCall && !sameSocketAlreadyInRoom) {
        io.in(`user:${userId}`).socketsLeave(`dm-call:${dmChannelId}`);
        socket.to(`user:${userId}`).emit('call-transferred', { type: 'dm-call', dmChannelId });
      }

      // If user is in a DIFFERENT DM call, leave it on ALL devices
      const existingOtherDmCall = !alreadyInCall ? await findUserDmCall(userId) : null;
      if (existingOtherDmCall && existingOtherDmCall !== dmChannelId) {
        io.in(`user:${userId}`).socketsLeave(`dm-call:${existingOtherDmCall}`);
        await removeDmCallParticipant(existingOtherDmCall, userId);
        await setDmCallReverseLookup(userId, null);
        await addDmCallDeclined(existingOtherDmCall, userId);
        if (!getIsShuttingDown()) {
          io.to(`dm-call:${existingOtherDmCall}`).emit('dm-call-declined', { userId, dmChannelId: existingOtherDmCall });
          io.to(`dm-call:${existingOtherDmCall}`).emit('dm-call-user-left', { userId });
        }
        // Stream viewer cleanup for the auto-left DM call
        const oldDmCtx = { kind: 'dm' as const, scopeId: existingOtherDmCall };
        const removedDmViewers = await removeUserFromAllStreams(userId, oldDmCtx).catch(() => []);
        for (const r of removedDmViewers) {
          io.to(`dm-call:${existingOtherDmCall}`).emit('viewer:changed', {
            context: oldDmCtx, streamOwnerId: r.streamOwnerId, streamType: r.streamType, remove: [userId],
          });
        }
        const clearedDmOwn = await clearOwnedStreams(userId, oldDmCtx).catch(() => []);
        for (const r of clearedDmOwn) {
          io.to(`dm-call:${existingOtherDmCall}`).emit('viewer:cleared', {
            context: oldDmCtx, streamOwnerId: userId, streamType: r.streamType,
          });
        }

        io.to(`user:${userId}`).emit('dm-call-auto-disconnected', { dmChannelId: existingOtherDmCall });
        const oldSize = await dmCallSize(existingOtherDmCall);
        if (oldSize === 0) {
          stopDmCallRing(existingOtherDmCall);
          const st = await getDmCallStartTime(existingOtherDmCall);
          await deleteDmCallStartTime(existingOtherDmCall);
          const dur = st ? Date.now() - st : 0;
          createDmCallSystemMessage(existingOtherDmCall, userId, 'Call ended', 'call_ended', { durationSeconds: Math.round(dur / 1000) });
          if (!getIsShuttingDown()) io.to(`dm:${existingOtherDmCall}`).emit('dm-call-ended', { dmChannelId: existingOtherDmCall });
        }
        checkDmCallInactivity(existingOtherDmCall);
        await broadcastCallStatus(io, existingOtherDmCall);
      }

      socket.join(`dm-call:${dmChannelId}`);
      await addDmCallParticipant(dmChannelId, userId, { username, avatar, banner, bannerPositionY, bannerZoom, withVideo: !!payload.withVideo, nameColor, nameFont, nameEffect, avatarEffect, effectivePlan, capabilities: socket.protocolContext?.capabilities ?? [], mlsCallReady: mlsCallReady === true });
      await setDmCallReverseLookup(userId, dmChannelId);

      // Mint the LiveKit access token inline. DM calls always get canPublish
      // and always use the default region (DM participants span servers so
      // there's no single server region to consult).
      let inlineToken: { token: string; url: string } | null = null;
      try {
        const region = getDefaultRegion();
        inlineToken = await mintLiveKitAccessToken({
          userId,
          participantName: username,
          roomName: `dm-call:${dmChannelId}`,
          region,
          canPublish: true,
          plan: effectivePlan as 'free' | 'essential' | 'pro',
        });
      } catch (err) {
        logger.warn({ err, userId, dmChannelId, event: 'dm-call-inline-token' }, 'inline token mint failed — client will fall back to HTTP endpoint');
      }

      // Ack before any further non-essential work so the client can safely request a LiveKit token
      // (the token endpoint gates on dmCallParticipants membership, which is now committed).
      callAck({ ok: true, ...(inlineToken ?? {}) });
      const participants = await getDmCallParticipants(dmChannelId);
      // Roster goes to the WHOLE call room (the joiner is in the room since
      // the join above), not just the joiner: an in-call member that missed
      // this join's dm-call-user-joined (socket blip) would otherwise hold
      // stale peer-readiness until its own reconnect, forcing a unilateral
      // legacy downgrade with one-way media. Key-blind: payload unchanged,
      // and the client's handleParticipants is idempotent + channel-filtered.
      io.to(`dm-call:${dmChannelId}`).emit('dm-call-participants', { dmChannelId, participants });
      socket.to(`dm-call:${dmChannelId}`).emit('dm-call-user-joined', { userId, username, avatar, banner, bannerPositionY, bannerZoom, nameColor, nameFont, nameEffect, avatarEffect, effectivePlan, capabilities: socket.protocolContext?.capabilities ?? [], mlsCallReady: mlsCallReady === true });

      if (isNewCall) {
        await setDmCallStartTime(dmChannelId, Date.now());
        createDmCallSystemMessage(dmChannelId, userId, 'started a call', 'call_started');
      }

      // Reuse otherParticipants from the block check above instead of a duplicate findMany
      let someoneNotInCall = false;
      const otherCallChecks = await Promise.all(
        otherIds.map(async (pid) => ({
          userId: pid,
          inCall: await isInDmCall(dmChannelId, pid),
        }))
      );
      for (const { userId: pid, inCall } of otherCallChecks) {
        if (inCall) continue;
        someoneNotInCall = true;
        io.to(`user:${pid}`).emit('incoming-dm-call', {
          dmChannelId,
          fromUserId: userId,
          username,
          avatar,
          banner,
          bannerPositionY,
          bannerZoom,
          nameColor,
          nameFont,
          nameEffect,
          avatarEffect,
          effectivePlan,
          withVideo: !!payload.withVideo,
          mlsCallReady: mlsCallReady === true,
        });
      }
      if (someoneNotInCall) {
        startDmCallRing(dmChannelId);
      } else {
        stopDmCallRing(dmChannelId);
      }
      checkDmCallInactivity(dmChannelId);
      await broadcastCallStatus(io, dmChannelId);
      logger.info({
        userId, dmChannelId, isNewCall,
        participantCount: (await dmCallSize(dmChannelId)),
        event: 'join-dm-call',
      }, 'user joined DM call');
    } catch (err) {
      logger.error({ err, userId, event: 'join-dm-call' }, 'socket handler error');
      callAck({ ok: false, error: 'Server error' });
    }
  });

  socket.on('leave-dm-call', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
      const payload = parseSocketPayload(leaveDmCallPayload, raw);
      if (!payload) return;
      const dmChannelId = payload.dmChannelId;
      if (!socket.rooms.has(`dm-call:${dmChannelId}`)) return;
      if (!(await isInDmCall(dmChannelId, userId))) return;
      socket.leave(`dm-call:${dmChannelId}`);
      await removeDmCallParticipant(dmChannelId, userId);
      await setDmCallReverseLookup(userId, null);
      await markRecentDmCallPresence(dmChannelId, userId);

      // Stream viewer cleanup
      const dmCtx = { kind: 'dm' as const, scopeId: dmChannelId };
      const viewerRemoved = await removeUserFromAllStreams(userId, dmCtx);
      for (const r of viewerRemoved) {
        io.to(`dm-call:${dmChannelId}`).emit('viewer:changed', {
          context: dmCtx, streamOwnerId: r.streamOwnerId, streamType: r.streamType, remove: [userId],
        });
      }
      const ownedCleared = await clearOwnedStreams(userId, dmCtx);
      for (const r of ownedCleared) {
        io.to(`dm-call:${dmChannelId}`).emit('viewer:cleared', {
          context: dmCtx, streamOwnerId: userId, streamType: r.streamType,
        });
      }

      // Mark as declined so the ring timer won't re-ring this user,
      // and notify the caller so their UI removes the "ringing" card
      await addDmCallDeclined(dmChannelId, userId);
      io.to(`dm-call:${dmChannelId}`).emit('dm-call-declined', { userId, dmChannelId });
      const remainingSize = await dmCallSize(dmChannelId);
      let callEnded = false;
      if (remainingSize === 0) {
        stopDmCallRing(dmChannelId);
        callEnded = true;
      }
      // Use io.to(room) rather than socket.to(room): the socket has already
      // left the room (line 304) so the set of recipients is identical, but
      // io.to() is resilient to reorderings and matches the sibling broadcast
      // at line 326. The departing socket itself is not a recipient either
      // way (already out of the room).
      io.to(`dm-call:${dmChannelId}`).emit('dm-call-user-left', { userId });
      checkDmCallInactivity(dmChannelId);
      await broadcastCallStatus(io, dmChannelId);
      logger.info({
        userId, dmChannelId, remainingSize, callEnded,
        event: 'leave-dm-call',
      }, 'user left DM call');

      if (callEnded) {
        const startTime = await getDmCallStartTime(dmChannelId);
        await deleteDmCallStartTime(dmChannelId);
        const durationMs = startTime ? Date.now() - startTime : 0;
        const durationSec = Math.round(durationMs / 1000);
        createDmCallSystemMessage(dmChannelId, userId, 'Call ended', 'call_ended', { durationSeconds: durationSec });
      }

      if (callEnded) {
        // All DM participants are already in the dm:{dmChannelId} room for message delivery
        io.to(`dm:${dmChannelId}`).emit('dm-call-ended', { dmChannelId });
      }
    } catch (err) {
      logger.error({ err, userId, event: 'leave-dm-call' }, 'socket handler error');
    }
  });

  socket.on('decline-dm-call', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
      const payload = parseSocketPayload(declineDmCallPayload, raw);
      if (!payload) return;
      const dmChannelId = payload.dmChannelId;
      const dmPart = await prisma.dMParticipant.findUnique({
        where: { userId_dmChannelId: { userId, dmChannelId } },
        select: { userId: true },
      });
      if (!dmPart) return;
      await addDmCallDeclined(dmChannelId, userId);
      io.to(`dm-call:${dmChannelId}`).emit('dm-call-declined', { userId, dmChannelId });

      if (dmCallRingTimers.has(dmChannelId)) {
        try {
          const dmParticipants = await prisma.dMParticipant.findMany({
            where: { dmChannelId },
            select: { userId: true },
            take: 100,
          });
          const allHandled = (await Promise.all(
            dmParticipants.map(async (p) =>
              (await isInDmCall(dmChannelId, p.userId)) || (await isDmCallDeclined(dmChannelId, p.userId))
            ),
          )).every(Boolean);
          if (allHandled) {
            // If only the caller is left and every other DM participant has
            // declined, end the call so the caller's ringback stops instead
            // of looping until their client-side 60s safety net fires.
            // terminateLoneCallerDmCall guards on dmCallSize === 1 and is
            // idempotent with stopDmCallRing.
            if ((await dmCallSize(dmChannelId)) === 1) {
              await terminateLoneCallerDmCall(dmChannelId, 'all_declined');
            } else {
              stopDmCallRing(dmChannelId);
            }
          }
        } catch { /* best-effort ring stop */ }
      }
      logger.info({ userId, dmChannelId, event: 'decline-dm-call' }, 'user declined DM call');
    } catch (err) {
      logger.error({ err, userId, event: 'decline-dm-call' }, 'socket handler error');
    }
  });

  socket.on('dm-call-state-update', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) {
        socket.emit('rate-limited');
        return;
      }
      const payload = parseSocketPayload(dmCallStatePayload, raw);
      if (!payload) return;
      if (!(await isInDmCall(payload.dmChannelId, userId))) return;
      socket.to(`dm-call:${payload.dmChannelId}`).emit('dm-call-state-update', {
        userId,
        isMuted: payload.isMuted,
        isDeafened: payload.isDeafened,
      });
    } catch (err) {
      logger.error({ err, userId, event: 'dm-call-state-update' }, 'socket handler error');
    }
  });

  // E2EE established/failed report. Relayed to the rest of the dm-call room so
  // each peer can render a *bilateral* encryption shield (green only once every
  // current peer confirms E2EE on their leg). Server never sees keys — `ok` is a
  // plain boolean about the sender's own SFrame state.
  socket.on('dm-call-e2ee-ack', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) {
        socket.emit('rate-limited');
        return;
      }
      const payload = parseSocketPayload(dmCallE2eeAckPayload, raw);
      if (!payload) return;
      if (!(await isInDmCall(payload.dmChannelId, userId))) return;
      socket.to(`dm-call:${payload.dmChannelId}`).emit('dm-call-e2ee-ack', {
        userId,
        ok: payload.ok,
      });
    } catch (err) {
      logger.error({ err, userId, event: 'dm-call-e2ee-ack' }, 'socket handler error');
    }
  });
}
