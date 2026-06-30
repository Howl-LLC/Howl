// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { SocketContext } from './types.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { hasPermission, loadPermissionContext, getEffectivePlan, AUTHOR_USER_SELECT, isMemberTimedOut } from '../utils.js';
import { hasChannelPermission } from '../utils/channelPermissions.js';
import { isValidUUID, parseSocketPayload, stageE2eeDistributePayload, stageE2eeRequestKeyPayload } from '../socketSchemas.js';
import { checkSocketRateLimit, checkVoiceInactivity, checkDmCallInactivity, stopDmCallRing, createDmCallSystemMessage } from './infrastructure.js';
import { getTotalParticipants, addToSet, removeFromSet, getSetMembers, getSetSize, getStageSessionId, isInSet, getActiveStageSpeakers, getStageLeader, setStageLeader } from '../routes/stages.js';
import { rotateStageLeaderAndKey, scheduleVoiceE2eeRotate } from '../services/voiceE2eeRotation.js';
import { mintLiveKitAccessToken, resolveLiveKitRegionForServer } from '../services/livekitTokens.js';
import { scheduleGraceEnd, cancelGraceEnd } from '../stageGraceTimers.js';
import { getIsShuttingDown } from '../shutdown.js';
import { findUserVoiceChannel, removeVoiceParticipant, getVoiceParticipants, setVoiceReverseLookup, deleteVoiceOverride, findUserDmCall, removeDmCallParticipant, setDmCallReverseLookup, addDmCallDeclined, dmCallSize, getDmCallStartTime, deleteDmCallStartTime, removeUserFromAllStreams, clearOwnedStreams } from '../redis.js';

const MAX_TOTAL_PARTICIPANTS = 10_000;

export function registerStageHandlers(ctx: SocketContext): void {
  const { io, socket, userId } = ctx;

  socket.on('stage-join-audience', async (channelId: string, ack?: (response: { ok: boolean; error?: string; token?: string; url?: string }) => void) => {
    // Matches join-voice-channel / join-dm-call: client awaits this before
    // requesting a LiveKit token so the Redis membership write (audience or
    // speaker set) is committed by the time /livekit/token runs its gate.
    // We also inline-mint the LiveKit token so the client skips a separate
    // HTTP round trip (Tier 1 latency optimization).
    const callAck = (response: { ok: boolean; error?: string; token?: string; url?: string }) => { try { ack?.(response); } catch { /* client went away */ } };
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); callAck({ ok: false, error: 'Rate limited' }); return; }
      if (!isValidUUID(channelId)) { callAck({ ok: false, error: 'Invalid channel' }); return; }

      const channel = await prisma.channel.findUnique({
        where: { id: channelId },
        select: { serverId: true, type: true, isPrivate: true, categoryId: true },
      });
      if (!channel || channel.type !== 'stage') { callAck({ ok: false, error: 'Not a stage channel' }); return; }

      const [member, permCtx] = await Promise.all([
        prisma.serverMember.findUnique({
          where: { userId_serverId: { userId, serverId: channel.serverId } },
          include: { user: { select: { username: true, avatar: true, discriminator: true, nameColor: true, nameFont: true, nameEffect: true, avatarEffect: true, stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true } } },
        }),
        loadPermissionContext(userId, channel.serverId),
      ]);
      if (!member || !permCtx) { callAck({ ok: false, error: 'Not a server member' }); return; }
      if (channel.isPrivate) {
        const [chOverrides, catOverrides] = await Promise.all([
          prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 100 }),
          channel.categoryId
            ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 100 })
            : Promise.resolve([]),
        ]);
        if (!hasChannelPermission(permCtx, 'viewChannels', chOverrides, catOverrides, undefined, { requireOverride: true })) {
          callAck({ ok: false, error: 'No permission to view this channel' }); return;
        }
      } else if (!hasPermission(permCtx, 'viewChannels')) {
        callAck({ ok: false, error: 'No viewChannels permission' }); return;
      }
      // A timed-out member must not (re-)join a stage — mirrors the
      // join-voice-channel timeout gate (voice.ts), so the SFU eviction applied
      // on timeout cannot be trivially undone by re-joining + re-minting a token.
      if (isMemberTimedOut(member)) { callAck({ ok: false, error: 'You are timed out and cannot join stages' }); return; }

      // Helper: mint the inline LiveKit token for the stage room. `isSpeakerNow`
      // reflects the post-Redis-write speaker status (hosts with manageStages
      // perm can publish even as audience). Failure is non-fatal — client
      // falls back to the HTTP endpoint. Defined here so it closes over
      // channel/member/permCtx.
      const mintStageToken = async (isSpeakerNow: boolean): Promise<{ token: string; url: string } | null> => {
        try {
          const region = await resolveLiveKitRegionForServer(channel.serverId);
          const canPublish = isSpeakerNow || hasPermission(permCtx, 'manageStages');
          return await mintLiveKitAccessToken({
            userId,
            participantName: member.user.username,
            roomName: `stage:${channelId}`,
            region,
            canPublish,
            plan: getEffectivePlan(member.user) as 'free' | 'essential' | 'pro',
          });
        } catch (err) {
          logger.warn({ err, userId, channelId, event: 'stage-inline-token' }, 'inline token mint failed — client will fall back to HTTP endpoint');
          return null;
        }
      };

      // Auto-leave active voice channel
      const existingVoiceChannel = await findUserVoiceChannel(userId);
      if (existingVoiceChannel) {
        io.in(`user:${userId}`).socketsLeave(`voice:${existingVoiceChannel}`);
        await Promise.all([
          removeVoiceParticipant(existingVoiceChannel, userId),
          setVoiceReverseLookup(userId, null),
          deleteVoiceOverride(existingVoiceChannel, userId),
        ]);
        if (!getIsShuttingDown()) {
          io.to(`voice:${existingVoiceChannel}`).emit('voice-user-left', { userId });
          const oldCh = await prisma.channel.findUnique({ where: { id: existingVoiceChannel }, select: { serverId: true } }).catch(() => null);
          if (oldCh?.serverId) {
            const vParts = await getVoiceParticipants(existingVoiceChannel);
            io.to(`server:${oldCh.serverId}`).emit('server-voice-participants', { serverId: oldCh.serverId, channelId: existingVoiceChannel, participants: vParts });
            // Forward secrecy when leaving a voice channel to join a stage:
            // the user keeps the old channel's SFrame key, so rotate for the
            // members who remain (parity with the graceful leave-voice rotate).
            scheduleVoiceE2eeRotate(io, existingVoiceChannel, vParts.length > 0);
          }
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

        io.to(`user:${userId}`).emit('voice-auto-disconnected', { channelId: existingVoiceChannel });
        checkVoiceInactivity(existingVoiceChannel);
      }

      // Auto-leave active DM call
      const existingDmCall = await findUserDmCall(userId);
      if (existingDmCall) {
        io.in(`user:${userId}`).socketsLeave(`dm-call:${existingDmCall}`);
        await removeDmCallParticipant(existingDmCall, userId);
        await setDmCallReverseLookup(userId, null);
        await addDmCallDeclined(existingDmCall, userId);
        if (!getIsShuttingDown()) {
          io.to(`dm-call:${existingDmCall}`).emit('dm-call-declined', { userId, dmChannelId: existingDmCall });
          io.to(`dm-call:${existingDmCall}`).emit('dm-call-user-left', { userId });
        }
        // Stream viewer cleanup for the auto-left DM call
        const oldDmCtx = { kind: 'dm' as const, scopeId: existingDmCall };
        const removedDmViewers = await removeUserFromAllStreams(userId, oldDmCtx).catch(() => []);
        for (const r of removedDmViewers) {
          io.to(`dm-call:${existingDmCall}`).emit('viewer:changed', {
            context: oldDmCtx, streamOwnerId: r.streamOwnerId, streamType: r.streamType, remove: [userId],
          });
        }
        const clearedDmOwn = await clearOwnedStreams(userId, oldDmCtx).catch(() => []);
        for (const r of clearedDmOwn) {
          io.to(`dm-call:${existingDmCall}`).emit('viewer:cleared', {
            context: oldDmCtx, streamOwnerId: userId, streamType: r.streamType,
          });
        }

        io.to(`user:${userId}`).emit('dm-call-auto-disconnected', { dmChannelId: existingDmCall });
        const rmSize = await dmCallSize(existingDmCall);
        if (rmSize === 0) {
          stopDmCallRing(existingDmCall);
          const dmSt = await getDmCallStartTime(existingDmCall);
          await deleteDmCallStartTime(existingDmCall);
          const dur = dmSt ? Date.now() - dmSt : 0;
          createDmCallSystemMessage(existingDmCall, userId, 'Call ended', 'call_ended', { durationSeconds: Math.round(dur / 1000) });
          if (!getIsShuttingDown()) io.to(`dm:${existingDmCall}`).emit('dm-call-ended', { dmChannelId: existingDmCall });
        }
        checkDmCallInactivity(existingDmCall);
      }

      const sessionId = await getStageSessionId(channelId);
      if (!sessionId) { callAck({ ok: false, error: 'No active stage' }); return; }

      // Someone is rejoining — abort any pending grace-period auto-end.
      cancelGraceEnd(channelId);

      const total = await getTotalParticipants(channelId);
      if (total >= MAX_TOTAL_PARTICIPANTS) {
        socket.emit('stage-error', { error: 'Stage is full (10,000 participant limit)' });
        callAck({ ok: false, error: 'Stage full' });
        return;
      }

      const speakers = await getSetMembers(channelId, 'speakers');
      if (speakers.includes(userId)) {
        socket.join(`channel:${channelId}`);
        const inlineToken = await mintStageToken(true);
        callAck({ ok: true, ...(inlineToken ?? {}) });
        return;
      }

      // Check if user is pre-invited to speak
      const isInvited = await isInSet(channelId, 'invites', userId);
      if (isInvited) {
        const session = await prisma.stageSession.findUnique({ where: { id: sessionId }, select: { maxSpeakers: true } });
        const currentSpeakerCount = await getSetSize(channelId, 'speakers');
        if (currentSpeakerCount < (session?.maxSpeakers ?? 25)) {
          // Auto-promote to speaker
          await removeFromSet(channelId, 'invites', userId);
          await addToSet(channelId, 'speakers', userId);
          socket.join(`channel:${channelId}`);

          const user = await prisma.user.findUnique({ where: { id: userId }, select: AUTHOR_USER_SELECT });
          const isHostUser = hasPermission(permCtx, 'manageStages');

          io.to(`channel:${channelId}`).emit('stage-speaker-added', {
            channelId,
            userId,
            username: user?.username ?? member.user.username,
            discriminator: user?.discriminator ?? '0000',
            avatar: user?.avatar ?? null,
            banner: user?.banner ?? null,
            bannerPositionY: user?.bannerPositionY ?? 50,
            bannerZoom: user?.bannerZoom ?? 100,
            nameColor: user?.nameColor ?? null,
            nameFont: user?.nameFont ?? null,
            nameEffect: user?.nameEffect ?? null,
            avatarEffect: user?.avatarEffect ?? null,
            effectivePlan: user ? getEffectivePlan(user) : undefined,
            isMuted: true,
            isHost: isHostUser,
          });

          const updatedSpeakers = await getActiveStageSpeakers(channelId);
          io.to(`server:${channel.serverId}`).emit('server-stage-participants', {
            serverId: channel.serverId, channelId, participants: updatedSpeakers,
          });

          logger.info({ userId, channelId, event: 'stage-auto-promote-invited' }, 'invited user auto-promoted to speaker');
          const inlineToken = await mintStageToken(true);
          callAck({ ok: true, ...(inlineToken ?? {}) });
          return;
        }
        // If speaker slots full, fall through to audience join
      }

      await addToSet(channelId, 'audience', userId);
      socket.join(`channel:${channelId}`);
      const inlineToken = await mintStageToken(false);
      callAck({ ok: true, ...(inlineToken ?? {}) });

      const effectivePlan = getEffectivePlan(member.user);
      const audienceMember = {
        userId,
        username: member.user.username,
        discriminator: member.user.discriminator ?? '0000',
        avatar: member.user.avatar ?? null,
        nameColor: member.user.nameColor ?? null,
        nameFont: member.user.nameFont ?? null,
        nameEffect: member.user.nameEffect ?? null,
        avatarEffect: member.user.avatarEffect ?? null,
        effectivePlan,
        channelId,
      };

      io.to(`channel:${channelId}`).emit('stage-audience-joined', audienceMember);
      logger.info({ userId, channelId, event: 'stage-join-audience' }, 'user joined stage audience');
    } catch (err) {
      logger.error({ err, userId, event: 'stage-join-audience' }, 'socket handler error');
      callAck({ ok: false, error: 'Server error' });
    }
  });

  socket.on('stage-leave', async (channelId: string) => {
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
      if (!isValidUUID(channelId)) return;

      // Also remove from speakers (if they were a speaker)
      const wasSpeaker = await isInSet(channelId, 'speakers', userId);
      if (wasSpeaker) {
        await removeFromSet(channelId, 'speakers', userId);
        io.to(`channel:${channelId}`).emit('stage-speaker-removed', { channelId, userId });

        // Update activity panel
        const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true } });
        if (channel?.serverId) {
          const updatedSpeakers = await getActiveStageSpeakers(channelId);
          io.to(`server:${channel.serverId}`).emit('server-stage-participants', {
            serverId: channel.serverId, channelId, participants: updatedSpeakers,
          });
        }

        // Trigger E2EE key rotation when a speaker leaves (forward secrecy).
        // Shared with the moderator-remove REST path and the abrupt-disconnect
        // cleanup in connection.ts so all three advance the leader
        // pointer + emit stage-e2ee-rotate identically and cannot drift.
        await rotateStageLeaderAndKey(io, channelId);
      }

      await removeFromSet(channelId, 'audience', userId);
      await removeFromSet(channelId, 'hands', userId);

      // Stream viewer cleanup
      const stageCtx = { kind: 'stage' as const, scopeId: channelId };
      const viewerRemoved = await removeUserFromAllStreams(userId, stageCtx);
      for (const r of viewerRemoved) {
        io.to(`channel:${channelId}`).emit('viewer:changed', {
          context: stageCtx, streamOwnerId: r.streamOwnerId, streamType: r.streamType, remove: [userId],
        });
      }
      const ownedCleared = await clearOwnedStreams(userId, stageCtx);
      for (const r of ownedCleared) {
        io.to(`channel:${channelId}`).emit('viewer:cleared', {
          context: stageCtx, streamOwnerId: userId, streamType: r.streamType,
        });
      }

      socket.leave(`channel:${channelId}`);

      if (!wasSpeaker) {
        io.to(`channel:${channelId}`).emit('stage-audience-left', { userId, channelId });
      }

      // Auto-end with grace: if no speakers AND no audience remain, start a
      // 60s grace timer rather than ending immediately. Lets a reconnecting
      // host / brief tab switch / network blip keep the session alive.
      const remainingSpeakerCount = await getSetSize(channelId, 'speakers');
      const remainingAudienceCount = await getSetSize(channelId, 'audience');
      if (remainingSpeakerCount === 0 && remainingAudienceCount === 0) {
        scheduleGraceEnd(channelId, io);
      }

      logger.info({ userId, channelId, event: 'stage-leave' }, 'user left stage');
    } catch (err) {
      logger.error({ err, userId, event: 'stage-leave' }, 'socket handler error');
    }
  });

  socket.on('stage-e2ee-distribute', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
      const payload = parseSocketPayload(stageE2eeDistributePayload, raw);
      if (!payload) return;
      const { channelId, targetUserId, encryptedKey, nonce, keyFormat, hostBlob, hostSignature } = payload;

      // Verify sender is a speaker or host in this stage
      const speakers = await getSetMembers(channelId, 'speakers');
      if (!speakers.includes(userId)) return;

      // Speaker is necessary but not sufficient: only the current
      // stage E2EE leader may distribute the SFrame session key. Without
      // this gate, any promoted speaker (including a low-trust audience
      // member who raised their hand) could push their chosen key to any
      // audience member via `stage-e2ee-key`, silently DoSing them or
      // mounting a selective MITM that relays only the attacker's audio.
      //
      // Leader pointer is seeded on session start to `startedById` and
      // advanced on every `stage-e2ee-rotate`. If it's missing (e.g. Redis
      // was flushed mid-session), fall back to the DB-authoritative
      // `StageSession.startedById` so legitimate hosts aren't locked out.
      let expectedLeader = await getStageLeader(channelId);
      if (!expectedLeader) {
        const sessionId = await getStageSessionId(channelId);
        if (sessionId) {
          const session = await prisma.stageSession.findUnique({
            where: { id: sessionId },
            select: { startedById: true },
          });
          expectedLeader = session?.startedById ?? null;
          if (expectedLeader) await setStageLeader(channelId, expectedLeader);
        }
      }
      if (!expectedLeader || expectedLeader !== userId) {
        logger.warn({ userId, channelId, expectedLeader, event: 'stage-e2ee-distribute-non-leader' }, 'rejected non-leader distribute');
        return;
      }

      // Verify target is a participant (speaker or audience)
      const audience = await getSetMembers(channelId, 'audience');
      if (!speakers.includes(targetUserId) && !audience.includes(targetUserId)) return;

      // Get sender's public key from DB
      const senderBundle = await prisma.dmKeyBundle.findUnique({
        where: { userId },
        select: { publicKey: true },
      });
      if (!senderBundle) return;

      // Forward the key (preserve keyFormat for dialect negotiation). Relay the
      // host's signed attestation verbatim so the recipient can verify the
      // distributor against a pinned AIK; the server does not interpret it.
      io.to(`user:${targetUserId}`).emit('stage-e2ee-key', {
        channelId,
        encryptedKey,
        nonce,
        hostPublicKey: senderBundle.publicKey,
        hostUserId: userId,
        ...(keyFormat ? { keyFormat } : {}),
        ...(hostBlob && hostSignature ? { hostBlob, hostSignature } : {}),
      });
    } catch (err) {
      logger.error({ error: (err as Error).message, userId, event: 'stage-e2ee-distribute' }, 'socket handler error');
    }
  });

  // Audience/speaker requests the SFrame session key from the current
  // stage leader. Stages were previously push-only from the host, so a lost
  // push (Socket.IO drop, host mid-reconnect, host abrupt-leave before the
  // leader advance) left the requester silently stuck on its optimistic
  // self-key with no way to ask again. The server routes the request to the
  // authoritative leader (Redis pointer, DB `startedById` fallback) so a
  // non-leader can't be tricked into distributing.
  socket.on('stage-e2ee-request-key', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
      const payload = parseSocketPayload(stageE2eeRequestKeyPayload, raw);
      if (!payload) return;
      const { channelId, capabilities } = payload;

      // Requester must be a current participant (speaker or audience).
      const [speakers, audience] = await Promise.all([
        getSetMembers(channelId, 'speakers'),
        getSetMembers(channelId, 'audience'),
      ]);
      if (!speakers.includes(userId) && !audience.includes(userId)) return;

      // Resolve the authoritative leader: Redis pointer, else DB startedById.
      let leaderUserId = await getStageLeader(channelId);
      if (!leaderUserId) {
        const sessionId = await getStageSessionId(channelId);
        if (sessionId) {
          const session = await prisma.stageSession.findUnique({
            where: { id: sessionId },
            select: { startedById: true },
          });
          leaderUserId = session?.startedById ?? null;
          if (leaderUserId) await setStageLeader(channelId, leaderUserId);
        }
      }
      // No leader resolvable, or the leader is no longer a speaker → nobody can
      // distribute. Bail rather than route to a stale identity.
      if (!leaderUserId || leaderUserId === userId || !speakers.includes(leaderUserId)) return;

      // Look up requester's public key from DB (don't trust client-supplied key).
      const requesterBundle = await prisma.dmKeyBundle.findUnique({
        where: { userId },
        select: { publicKey: true },
      });
      if (!requesterBundle) return;

      io.to(`user:${leaderUserId}`).emit('stage-e2ee-request-key', {
        channelId,
        userId,
        publicKey: requesterBundle.publicKey,
        ...(capabilities ? { capabilities } : {}),
      });
    } catch (err) {
      logger.error({ error: (err as Error).message, userId, event: 'stage-e2ee-request-key' }, 'socket handler error');
    }
  });
}
