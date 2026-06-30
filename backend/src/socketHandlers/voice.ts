// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { SocketContext } from './types.js';
import nacl from 'tweetnacl';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { hasPermission, loadPermissionContext, effectivePosition, getEffectivePlan, isMemberTimedOut } from '../utils.js';
import { hasChannelPermission } from '../utils/channelPermissions.js';
import { muteParticipantAudio } from '../services/livekitAdmin.js';
import { mintLiveKitAccessToken, resolveLiveKitRegionForServer } from '../services/livekitTokens.js';
import {
  addVoiceParticipant, removeVoiceParticipant, getVoiceParticipants, getVoiceParticipantData,
  isInVoiceChannel, setVoiceReverseLookup, refreshVoiceTTL, findUserVoiceChannel,
  getVoiceOverride, setVoiceOverride, deleteVoiceOverride,
  voiceChannelSize,
  findUserDmCall, removeDmCallParticipant, setDmCallReverseLookup,
  dmCallSize, addDmCallDeclined, getDmCallStartTime, deleteDmCallStartTime,
  publicVoiceParticipant,
  removeUserFromAllStreams, clearOwnedStreams,
  setVoiceParticipantScreenSharing,
} from '../redis.js';
import {
  isValidUUID, parseSocketPayload,
  joinVoicePayload, leaveVoicePayload, voiceStatePayload, soundboardPayload, serverMutePayload, serverDeafenPayload, moveVoicePayload,
  voiceE2eeDistributePayload, voiceE2eeRequestKeyPayload,
  voiceScreenSharePayload,
} from '../socketSchemas.js';
import {
  checkSocketRateLimit,
  isSoundboardThrottled, checkVoiceInactivity,
  stopDmCallRing, checkDmCallInactivity, createDmCallSystemMessage,
} from './infrastructure.js';
import { scheduleVoiceE2eeRotate } from '../services/voiceE2eeRotation.js';
import { electVoiceLeader } from '../services/voiceLeaderElection.js';

/** Shared logic for server-mute-user and server-deafen-user */
async function handleServerVoiceOverride(
  ctx: SocketContext,
  payload: { channelId: string; targetUserId: string },
  field: 'serverMuted' | 'serverDeafened',
  value: boolean,
): Promise<void> {
  const { io, userId } = ctx;
  const channel = await prisma.channel.findUnique({ where: { id: payload.channelId }, select: { serverId: true } }).catch(() => null);
  if (!channel?.serverId) return;
  const [actor, actorCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId, serverId: channel.serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(userId, channel.serverId),
  ]);
  if (!actor || !actorCtx) return;
  const isOwner = actor.role?.toLowerCase() === 'owner';
  const canMute = isOwner || hasPermission(actorCtx, 'muteMembers');
  if (!canMute) return;

  // Role hierarchy: LOWER position = HIGHER authority. Load target's full
  // permission context for multi-role effectivePosition.
  const [target, targetCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: payload.targetUserId, serverId: channel.serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(payload.targetUserId, channel.serverId),
  ]);
  if (!target) return;
  const targetIsOwner = target.role?.toLowerCase() === 'owner';
  if (targetIsOwner) return; // Can never mute the owner
  if (!isOwner) {
    const actorPos = effectivePosition(actorCtx);
    const targetPos = targetCtx ? effectivePosition(targetCtx) : Infinity;
    if (targetPos <= actorPos) return; // target equal-or-higher authority → block
  }

  if (!(await isInVoiceChannel(payload.channelId, payload.targetUserId))) return;

  const existing = (await getVoiceOverride(payload.channelId, payload.targetUserId)) ?? { serverMuted: false, serverDeafened: false, byUserId: userId };
  existing[field] = value;
  existing.byUserId = userId;
  if (!existing.serverMuted && !existing.serverDeafened) {
    await deleteVoiceOverride(payload.channelId, payload.targetUserId);
  } else {
    await setVoiceOverride(payload.channelId, payload.targetUserId, existing);
  }

  const dbField = field === 'serverMuted' ? 'serverMuted' : 'serverDeafened';
  await prisma.serverMember.update({
    where: { userId_serverId: { userId: payload.targetUserId, serverId: channel.serverId } },
    data: { [dbField]: value },
  }).catch(() => {});

  io.to(`user:${payload.targetUserId}`).emit('voice-server-mute', {
    channelId: payload.channelId,
    serverMuted: existing.serverMuted,
    serverDeafened: existing.serverDeafened,
    byUserId: userId,
  });

  // When deafening, isMuted is always true (deafen implies mute in broadcast)
  const broadcastMuted = existing.serverDeafened ? true : existing.serverMuted;
  io.to(`voice:${payload.channelId}`).emit('voice-state-update', {
    userId: payload.targetUserId,
    isMuted: broadcastMuted,
    isDeafened: existing.serverDeafened,
    serverMuted: existing.serverMuted,
    serverDeafened: existing.serverDeafened,
  });

  // SFU-level enforcement — mute the audio track at the LiveKit server
  // This prevents malicious clients from ignoring the client-side mute event
  if (field === 'serverMuted') {
    muteParticipantAudio(`voice:${payload.channelId}`, payload.targetUserId, value).catch(() => {});
  } else if (field === 'serverDeafened' && value) {
    // Deafen implies mute at SFU level
    muteParticipantAudio(`voice:${payload.channelId}`, payload.targetUserId, true).catch(() => {});
  } else if (field === 'serverDeafened' && !value) {
    // Un-deafen: also reverse SFU mute if user is not separately server-muted
    const override = await getVoiceOverride(payload.channelId, payload.targetUserId);
    if (!override?.serverMuted) {
      muteParticipantAudio(`voice:${payload.channelId}`, payload.targetUserId, false).catch(() => {});
    }
  }
}

export function registerVoiceHandlers(ctx: SocketContext): void {
  const { io, socket, userId } = ctx;

  socket.on('join-voice-channel', async (raw: unknown, ack?: (response: { ok: boolean; error?: string; token?: string; url?: string }) => void) => {
    // Matches join-dm-call: the client awaits this ACK before requesting a
    // LiveKit token, so /livekit/token's `isInVoiceChannel` gate sees the
    // committed Redis write instead of racing it. We also inline the minted
    // LiveKit access token in the ACK so the client doesn't need a separate
    // HTTP round trip (Tier 1 latency optimization — matches Discord's
    // VOICE_SERVER_UPDATE where the voice server URL+token arrives inline).
    const callAck = (response: { ok: boolean; error?: string; token?: string; url?: string }) => { try { ack?.(response); } catch { /* client went away */ } };
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); callAck({ ok: false, error: 'Rate limited' }); return; }
      const payload = parseSocketPayload(joinVoicePayload, raw);
      if (!payload) { callAck({ ok: false, error: 'Invalid payload' }); return; }
      const { channelId } = payload || {};
      if (!isValidUUID(channelId)) {
        socket.emit('voice-join-error', { channelId, message: 'Missing channel' });
        callAck({ ok: false, error: 'Missing channel' });
        return;
      }

      // Auto-leave previous voice channel to prevent ghost participants
      const existingChannel = await findUserVoiceChannel(userId);
      if (existingChannel && existingChannel !== channelId) {
        io.in(`user:${userId}`).socketsLeave(`voice:${existingChannel}`);
        await Promise.all([
          removeVoiceParticipant(existingChannel, userId),
          deleteVoiceOverride(existingChannel, userId),
        ]);
        socket.to(`voice:${existingChannel}`).emit('voice-user-left', { userId });
        const oldChannel = await prisma.channel.findUnique({ where: { id: existingChannel }, select: { serverId: true } }).catch(() => null);
        if (oldChannel?.serverId) {
          const oldParticipants = await getVoiceParticipants(existingChannel);
          io.to(`server:${oldChannel.serverId}`).emit('server-voice-participants', { serverId: oldChannel.serverId, channelId: existingChannel, participants: oldParticipants.map(publicVoiceParticipant) });
          // Forward secrecy on a channel switch: the user retains the old
          // channel's SFrame key after leaving it, so rotate for the members who
          // remain (parity with the graceful leave-voice-channel rotate below).
          scheduleVoiceE2eeRotate(io, existingChannel, oldParticipants.length > 0);
        }
        // Stream viewer cleanup for the auto-left voice channel
        const oldVoiceCtx = { kind: 'voice' as const, scopeId: existingChannel };
        const removedViewers = await removeUserFromAllStreams(userId, oldVoiceCtx).catch(() => []);
        for (const r of removedViewers) {
          io.to(`voice:${existingChannel}`).emit('viewer:changed', {
            context: oldVoiceCtx, streamOwnerId: r.streamOwnerId, streamType: r.streamType, remove: [userId],
          });
        }
        const clearedOwn = await clearOwnedStreams(userId, oldVoiceCtx).catch(() => []);
        for (const r of clearedOwn) {
          io.to(`voice:${existingChannel}`).emit('viewer:cleared', {
            context: oldVoiceCtx, streamOwnerId: userId, streamType: r.streamType,
          });
        }

        checkVoiceInactivity(existingChannel);
        io.to(`user:${userId}`).emit('voice-auto-disconnected', { channelId: existingChannel });
      } else if (existingChannel && existingChannel === channelId) {
        // Same channel from another device — transfer
        io.in(`user:${userId}`).socketsLeave(`voice:${channelId}`);
        socket.to(`user:${userId}`).emit('call-transferred', { type: 'voice', channelId });
      }

      // Auto-leave active DM call to prevent dual connections
      const existingDmCall = await findUserDmCall(userId);
      if (existingDmCall) {
        io.in(`user:${userId}`).socketsLeave(`dm-call:${existingDmCall}`);
        await removeDmCallParticipant(existingDmCall, userId);
        await setDmCallReverseLookup(userId, null);
        await addDmCallDeclined(existingDmCall, userId);
        io.to(`dm-call:${existingDmCall}`).emit('dm-call-declined', { userId, dmChannelId: existingDmCall });
        socket.to(`dm-call:${existingDmCall}`).emit('dm-call-user-left', { userId });

        const remainingSize = await dmCallSize(existingDmCall);
        if (remainingSize === 0) {
          stopDmCallRing(existingDmCall);
          const startTime = await getDmCallStartTime(existingDmCall);
          await deleteDmCallStartTime(existingDmCall);
          const durationMs = startTime ? Date.now() - startTime : 0;
          const durationSec = Math.round(durationMs / 1000);
          createDmCallSystemMessage(existingDmCall, userId, 'Call ended', 'call_ended', { durationSeconds: durationSec });
          io.to(`dm:${existingDmCall}`).emit('dm-call-ended', { dmChannelId: existingDmCall });
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

        checkDmCallInactivity(existingDmCall);

        io.to(`user:${userId}`).emit('dm-call-auto-disconnected', { dmChannelId: existingDmCall });
        logger.info({ userId, dmChannelId: existingDmCall, reason: 'joined-voice' }, 'auto-left DM call');
      }

      const channel = await prisma.channel.findUnique({ where: { id: channelId }, include: { server: true } });
      if (!channel) {
        socket.emit('voice-join-error', { channelId, message: 'Channel not found' });
        callAck({ ok: false, error: 'Channel not found' });
        return;
      }
      if (channel.type !== 'voice') {
        socket.emit('voice-join-error', { channelId, message: 'Not a voice channel' });
        callAck({ ok: false, error: 'Not a voice channel' });
        return;
      }
      const [member, permCtx] = await Promise.all([
        prisma.serverMember.findUnique({
          where: { userId_serverId: { userId, serverId: channel.serverId } },
          include: { serverRole: true, user: { select: { username: true, avatar: true, banner: true, bannerPositionY: true, bannerZoom: true, nameColor: true, nameFont: true, nameEffect: true, avatarEffect: true, stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true } } },
        }),
        loadPermissionContext(userId, channel.serverId),
      ]);
      if (!member || !permCtx) {
        socket.emit('voice-join-error', { channelId, message: 'You are not a member of this server' });
        callAck({ ok: false, error: 'Not a member' });
        return;
      }
      if (!hasPermission(permCtx, 'connect')) {
        socket.emit('voice-join-error', { channelId, message: 'You do not have permission to join voice channels' });
        callAck({ ok: false, error: 'No connect permission' });
        return;
      }
      if (channel.isPrivate) {
        const [chOverrides, catOverrides] = await Promise.all([
          prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 100 }),
          channel.categoryId
            ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 100 })
            : Promise.resolve([]),
        ]);
        if (!hasChannelPermission(permCtx, 'viewChannels', chOverrides, catOverrides, undefined, { requireOverride: true })) {
          socket.emit('voice-join-error', { channelId, message: 'No permission to view this channel' });
          callAck({ ok: false, error: 'No permission to view this channel' });
          return;
        }
      }
      if (isMemberTimedOut(member)) {
        socket.emit('voice-join-error', { channelId, message: 'You are timed out and cannot join voice channels' });
        callAck({ ok: false, error: 'Timed out' });
        return;
      }
      const MAX_VOICE_PARTICIPANTS = 99;
      const currentSize = await voiceChannelSize(channelId);
      if (currentSize >= MAX_VOICE_PARTICIPANTS) {
        socket.emit('voice-join-error', { channelId, message: 'Voice channel is full (max 99 participants)' });
        callAck({ ok: false, error: 'Channel full' });
        return;
      }
      // Voice channels require SFrame E2EE across all participants. A user
      // without a published key bundle can't take part in leader election or
      // receive the session key; if we let them join anyway their Room would
      // publish plaintext while peers publish ciphertext, silencing the
      // whole channel. Reject with a clear message so the client gate can
      // prompt the user to set up encryption.
      const joinerKeyBundle = await prisma.dmKeyBundle.findUnique({
        where: { userId },
        select: { publicKey: true, signingPublicKey: true },
      });
      if (!joinerKeyBundle) {
        socket.emit('voice-join-error', { channelId, message: 'Set up end-to-end encryption before joining voice channels.' });
        callAck({ ok: false, error: 'No key bundle' });
        return;
      }
      const username = member.user.username;
      const nickname = member.nickname ?? undefined;
      const avatar = member.serverAvatar ?? member.user.avatar ?? undefined;
      const banner = member.serverBanner ?? member.user.banner ?? undefined;
      const bannerPositionY = member.user.bannerPositionY ?? undefined;
      const bannerZoom = member.user.bannerZoom ?? undefined;
      const effectivePlan = getEffectivePlan(member.user);
      const isPro = effectivePlan === 'pro' || effectivePlan === 'essential';
      const nameColor = isPro ? (member.user.nameColor ?? undefined) : undefined;
      const nameFont = isPro ? (member.user.nameFont ?? undefined) : undefined;
      const nameEffect = isPro ? (member.user.nameEffect ?? undefined) : undefined;
      const avatarEffect = isPro ? (member.user.avatarEffect ?? undefined) : undefined;
      const roleColor = member.serverRole?.color ?? undefined;
      const roleStyle = member.serverRole?.style ?? undefined;
      logger.debug({ userId, username, banner: !!banner, avatar: !!avatar, effectivePlan, nameColor, nameFont, nameEffect, roleColor, event: 'voice-join-data' }, 'voice participant data extracted');
      // Cross-validate the signed join-blob against the joiner's
      // DB-authoritative DmKeyBundle. Without this, any authenticated
      // channel member could produce a valid signature over `joinTimestamp:0`
      // using a throwaway Ed25519 keypair and become the "oldest" leader,
      // permanently DoSing E2EE key exchange for the channel.
      //
      // Gates (any failure → discard the blob, join proceeds without it):
      //   1. channelId in the blob must match this channel.
      //   2. blob.pub must equal the joiner's DB-published X25519 publicKey.
      //   3. blob.sigPub must equal the joiner's DB-published Ed25519 signingPublicKey.
      //   4. blob.joinTimestamp must be within ±30s of server time (clamp —
      //      prevents `joinTimestamp: 0` leader hijack even though signature
      //      verifies under the joiner's real signing key).
      //   5. Ed25519 signature must verify server-side against the DB sigPub
      //      (defense-in-depth — client also re-verifies).
      const now = Date.now();
      const CLOCK_SKEW_TOLERANCE_MS = 30_000;
      let signedJoinBlob: typeof payload.joinBlob | undefined;
      let signedJoinSignature: typeof payload.signature | undefined;
      if (payload.joinBlob && payload.signature) {
        const blob = payload.joinBlob;
        const sig = payload.signature;
        const reason = (() => {
          if (blob.channelId !== channelId) return 'channel-mismatch';
          if (blob.pub !== joinerKeyBundle.publicKey) return 'pub-mismatch';
          if (blob.sigPub !== joinerKeyBundle.signingPublicKey) return 'sigpub-mismatch';
          if (Math.abs(blob.joinTimestamp - now) > CLOCK_SKEW_TOLERANCE_MS) return 'timestamp-out-of-range';
          try {
            const canonBytes = new TextEncoder().encode(JSON.stringify(blob));
            const sigBytes = Buffer.from(sig, 'base64');
            const pubBytes = Buffer.from(joinerKeyBundle.signingPublicKey ?? '', 'base64');
            if (!nacl.sign.detached.verify(canonBytes, sigBytes, pubBytes)) return 'signature-invalid';
          } catch {
            return 'signature-parse-error';
          }
          return null;
        })();
        if (reason) {
          logger.warn({ userId, channelId, reason, event: 'voice-join-blob-rejected' }, 'rejecting voice join-blob');
        } else {
          signedJoinBlob = blob;
          signedJoinSignature = sig;
        }
      }

      socket.join(`voice:${channelId}`);
      await addVoiceParticipant(channelId, userId, { username, nickname, avatar, banner, bannerPositionY, bannerZoom, nameColor, nameFont, nameEffect, avatarEffect, effectivePlan, roleColor, roleStyle, joinBlob: signedJoinBlob, signature: signedJoinSignature, signingPublicKey: joinerKeyBundle.signingPublicKey ?? undefined, joinedAt: now, capabilities: socket.protocolContext?.capabilities ?? [] });
      await setVoiceReverseLookup(userId, channelId);

      // Mint the LiveKit access token inline so the client can connect
      // straight to the SFU without a separate POST /livekit/token round
      // trip. Failure to mint is non-fatal — client will fall back to the
      // HTTP endpoint and still succeed (slower path, but functional).
      const canPublish = hasPermission(permCtx, 'speak');
      let inlineToken: { token: string; url: string } | null = null;
      try {
        const region = await resolveLiveKitRegionForServer(channel.serverId);
        inlineToken = await mintLiveKitAccessToken({
          userId,
          participantName: username,
          roomName: `voice:${channelId}`,
          region,
          canPublish,
          plan: effectivePlan as 'free' | 'essential' | 'pro',
        });
      } catch (err) {
        logger.warn({ err, userId, channelId, event: 'voice-inline-token' }, 'inline token mint failed — client will fall back to HTTP endpoint');
      }

      // ACK the client NOW: the Redis membership write is committed, so the
      // subsequent LiveKit token request gate (isInVoiceChannel) will pass.
      // Further broadcast work below is non-critical to the client's join
      // sequence and can happen after the ack returns.
      callAck({ ok: true, ...(inlineToken ?? {}) });

      if (member.serverMuted || member.serverDeafened) {
        await setVoiceOverride(channelId, userId, { serverMuted: member.serverMuted, serverDeafened: member.serverDeafened, byUserId: 'system' });
        socket.emit('voice-server-mute', { channelId, serverMuted: member.serverMuted, serverDeafened: member.serverDeafened, byUserId: 'system' });
      }
      const participants = await getVoiceParticipants(channelId);
      const pc = (channel.server as { powerUpCount?: number }).powerUpCount ?? 0;
      const powerUpTier = pc >= 14 ? 3 : pc >= 7 ? 2 : pc >= 2 ? 1 : 0;
      socket.emit('voice-participants', { channelId, participants: participants.map(publicVoiceParticipant), powerUpTier });
      socket.to(`voice:${channelId}`).emit('voice-user-joined', { userId, username, nickname, avatar, banner, bannerPositionY, bannerZoom, nameColor, nameFont, nameEffect, avatarEffect, effectivePlan, roleColor, roleStyle, joinBlob: signedJoinBlob, signature: signedJoinSignature, signingPublicKey: joinerKeyBundle.signingPublicKey ?? undefined, capabilities: socket.protocolContext?.capabilities ?? [] });
      io.to(`server:${channel.serverId}`).emit('server-voice-participants', { serverId: channel.serverId, channelId, participants: participants.map(publicVoiceParticipant) });

      // E2EE: joiner is guaranteed to have a key bundle (checked above). If
      // other participants are already in the channel, ask the oldest one
      // to encrypt the session key for this joiner.
      if (participants.length > 1) {
        const oldestParticipant = participants.find(p => p.userId !== userId);
        if (oldestParticipant) {
          io.to(`user:${oldestParticipant.userId}`).emit('voice-e2ee-request-key', {
            channelId,
            userId,
            publicKey: joinerKeyBundle.publicKey,
            capabilities: socket.protocolContext?.capabilities ?? [],
          });
        }
      }

      checkVoiceInactivity(channelId);
    } catch (err) {
      logger.error({ err, userId, event: 'join-voice-channel' }, 'socket handler error');
      callAck({ ok: false, error: 'Server error' });
    }
  });

  socket.on('leave-voice-channel', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
      const payload = parseSocketPayload(leaveVoicePayload, raw);
      if (!payload) return;
      const channelId = payload.channelId;
      // If this socket was removed from the room (call transferred to another device),
      // skip to prevent kicking the new device's connection from Redis.
      if (!socket.rooms.has(`voice:${channelId}`)) return;
      if (!(await isInVoiceChannel(channelId, userId))) return;
      const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true } }).catch(() => null);
      socket.leave(`voice:${channelId}`);
      await Promise.all([
        removeVoiceParticipant(channelId, userId),
        setVoiceReverseLookup(userId, null),
        deleteVoiceOverride(channelId, userId),
      ]);
      // Stream viewer cleanup: remove this user as viewer + clear their owned streams
      const voiceCtx = { kind: 'voice' as const, scopeId: channelId };
      const viewerRemoved = await removeUserFromAllStreams(userId, voiceCtx);
      for (const r of viewerRemoved) {
        io.to(`voice:${channelId}`).emit('viewer:changed', {
          context: voiceCtx, streamOwnerId: r.streamOwnerId, streamType: r.streamType, remove: [userId],
        });
      }
      const ownedCleared = await clearOwnedStreams(userId, voiceCtx);
      for (const r of ownedCleared) {
        io.to(`voice:${channelId}`).emit('viewer:cleared', {
          context: voiceCtx, streamOwnerId: userId, streamType: r.streamType,
        });
      }

      const participants = await getVoiceParticipants(channelId);
      socket.to(`voice:${channelId}`).emit('voice-user-left', { userId });
      if (channel?.serverId) io.to(`server:${channel.serverId}`).emit('server-voice-participants', { serverId: channel.serverId, channelId, participants: participants.map(publicVoiceParticipant) });

      // E2EE: If participants remain, debounce key rotation (forward secrecy).
      // Shared with the abrupt-disconnect path in connection.ts so the
      // two cannot drift. Empty room cancels any pending rotate.
      scheduleVoiceE2eeRotate(io, channelId, participants.length > 0);

      checkVoiceInactivity(channelId);
    } catch (err) {
      logger.error({ err, userId, event: 'leave-voice-channel' }, 'socket handler error');
    }
  });

  socket.on('voice-state-update', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) {
        socket.emit('rate-limited');
        return;
      }
      const payload = parseSocketPayload(voiceStatePayload, raw);
      if (!payload) return;
      const inChannel = await isInVoiceChannel(payload.channelId, userId);
      if (!inChannel) return;
      refreshVoiceTTL(payload.channelId).catch(() => {});
      const override = await getVoiceOverride(payload.channelId, userId);
      socket.to(`voice:${payload.channelId}`).emit('voice-state-update', {
        userId,
        isMuted: override?.serverMuted ? true : !!payload.isMuted,
        isDeafened: override?.serverDeafened ? true : !!payload.isDeafened,
        serverMuted: override?.serverMuted ?? false,
        serverDeafened: override?.serverDeafened ?? false,
      });
    } catch (err) {
      logger.error({ err, userId, event: 'voice-state-update' }, 'socket handler error');
    }
  });

  // Client tells us they started/stopped publishing a screen track in the
  // voice channel. Persist the flag and re-broadcast the participant list so
  // other server members can render a sidebar "watch stream" icon. We don't
  // rebroadcast into the voice room itself — callers in the same channel
  // already see the screen track via LiveKit.
  socket.on('voice-set-screenshare', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
      const payload = parseSocketPayload(voiceScreenSharePayload, raw);
      if (!payload) return;
      const inChannel = await isInVoiceChannel(payload.channelId, userId);
      if (!inChannel) return;
      const updated = await setVoiceParticipantScreenSharing(payload.channelId, userId, payload.isScreenSharing);
      if (!updated) return;
      refreshVoiceTTL(payload.channelId).catch(() => {});
      const channel = await prisma.channel.findUnique({ where: { id: payload.channelId }, select: { serverId: true } }).catch(() => null);
      if (!channel?.serverId) return;
      const participants = await getVoiceParticipants(payload.channelId);
      io.to(`server:${channel.serverId}`).emit('server-voice-participants', {
        serverId: channel.serverId, channelId: payload.channelId, participants: participants.map(publicVoiceParticipant),
      });
    } catch (err) {
      logger.error({ err, userId, event: 'voice-set-screenshare' }, 'socket handler error');
    }
  });

  socket.on('server-mute-user', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
      const payload = parseSocketPayload(serverMutePayload, raw);
      if (!payload) return;
      await handleServerVoiceOverride(ctx, payload, 'serverMuted', !!payload.muted);
    } catch (err) {
      logger.error({ err, userId, event: 'server-mute-user' }, 'socket handler error');
    }
  });

  socket.on('server-deafen-user', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
      const payload = parseSocketPayload(serverDeafenPayload, raw);
      if (!payload) return;
      await handleServerVoiceOverride(ctx, payload, 'serverDeafened', !!payload.deafened);
    } catch (err) {
      logger.error({ err, userId, event: 'server-deafen-user' }, 'socket handler error');
    }
  });

  socket.on('voice-soundboard-play', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) {
        socket.emit('rate-limited');
        return;
      }
      const payload = parseSocketPayload(soundboardPayload, raw);
      if (!payload) return;
      if (await isSoundboardThrottled(userId)) return;
      if (!(await isInVoiceChannel(payload.channelId, userId))) return;

      const channel = await prisma.channel.findUnique({ where: { id: payload.channelId }, select: { serverId: true } });
      if (!channel?.serverId) return;
      const permCtx = await loadPermissionContext(userId, channel.serverId);
      if (!permCtx || !hasPermission(permCtx, 'speak')) return;
      const sound = await prisma.soundboardSound.findFirst({
        where: { id: payload.soundId, serverId: channel.serverId },
        select: { audioUrl: true, name: true, emoji: true, volume: true },
      });
      if (!sound) return;

      if (!sound.audioUrl.startsWith('/api/uploads/')) {
        logger.warn({ soundId: payload.soundId, userId, event: 'voice-soundboard-play' }, 'soundboard audioUrl failed validation');
        return;
      }

      socket.to(`voice:${payload.channelId}`).emit('voice-soundboard-play', {
        fromUserId: userId,
        audioUrl: sound.audioUrl,
        volume: sound.volume,
        name: sound.name,
        emoji: sound.emoji ?? undefined,
      });
    } catch (err) {
      logger.error({ err, userId, event: 'voice-soundboard-play' }, 'socket handler error');
    }
  });

  socket.on('voice-e2ee-distribute', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
      const payload = parseSocketPayload(voiceE2eeDistributePayload, raw);
      if (!payload) return;
      const { targetUserId, encryptedKey, nonce, channelId, keyFormat } = payload;

      // Verify sender is in the voice channel
      if (!(await isInVoiceChannel(channelId, userId))) return;

      // Verify sender is the elected leader. Elect by the SAME signed
      // joinTimestamp the clients elect on (electVoiceLeader), NOT server
      // joinedAt order — otherwise ordinary client clock skew can flip the
      // relative order so the server-allowed leader's key is rejected by every
      // client while the client-elected leader's distribution is dropped here,
      // wedging key exchange with no recovery.
      const currentParticipants = await getVoiceParticipants(channelId);
      const distributeLeaderUserId = electVoiceLeader(channelId, currentParticipants);
      if (distributeLeaderUserId && distributeLeaderUserId !== userId) return;

      // Verify target is in the voice channel
      if (!(await isInVoiceChannel(channelId, targetUserId))) return;

      // Get sender's public key from DB
      const senderBundle = await prisma.dmKeyBundle.findUnique({
        where: { userId },
        select: { publicKey: true },
      });
      if (!senderBundle) return;

      // Forward the key to the target (preserve keyFormat for dialect negotiation)
      io.to(`user:${targetUserId}`).emit('voice-e2ee-key', {
        channelId,
        encryptedKey,
        nonce,
        leaderPublicKey: senderBundle.publicKey,
        leaderUserId: userId,
        ...(keyFormat ? { keyFormat } : {}),
      });
    } catch (err) {
      logger.error({ error: (err as Error).message, userId, event: 'voice-e2ee-distribute' }, 'socket handler error');
    }
  });

  // Client-initiated key request after E2EE rotation (non-leaders request the new key from the new leader)
  socket.on('voice-e2ee-request-key', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
      const payload = parseSocketPayload(voiceE2eeRequestKeyPayload, raw);
      if (!payload) return;
      const { channelId, targetUserId } = payload;

      // Verify sender is in the voice channel
      if (!(await isInVoiceChannel(channelId, userId))) return;

      const participants = await getVoiceParticipants(channelId);
      if (participants.length === 0) return;

      let leaderUserId: string;
      if (targetUserId && await isInVoiceChannel(channelId, targetUserId)) {
        leaderUserId = targetUserId;
      } else {
        // No (valid) target — fall back to the elected leader, matching the
        // distribute gate and the client's election, not joinedAt.
        leaderUserId = electVoiceLeader(channelId, participants) ?? participants[0].userId;
      }

      // Don't forward to self (leader shouldn't request from themselves)
      if (leaderUserId === userId) return;

      // Look up requester's public key from DB (don't trust client-supplied key)
      const requesterBundle = await prisma.dmKeyBundle.findUnique({
        where: { userId },
        select: { publicKey: true },
      });
      if (!requesterBundle) return;

      // Forward the key request to the leader with the requester's verified public key
      io.to(`user:${leaderUserId}`).emit('voice-e2ee-request-key', {
        channelId,
        userId,
        publicKey: requesterBundle.publicKey,
        capabilities: socket.protocolContext?.capabilities ?? [],
      });
    } catch (err) {
      logger.error({ error: (err as Error).message, userId, event: 'voice-e2ee-request-key' }, 'socket handler error');
    }
  });

  socket.on('move-voice-user', async (raw: unknown) => {
    try {
      if (!(await checkSocketRateLimit(userId))) { socket.emit('rate-limited'); return; }
      const payload = parseSocketPayload(moveVoicePayload, raw);
      if (!payload) return;
      if (payload.fromChannelId === payload.toChannelId) return;

      const [fromChannel, toChannel] = await Promise.all([
        prisma.channel.findUnique({ where: { id: payload.fromChannelId }, select: { serverId: true, type: true } }),
        prisma.channel.findUnique({ where: { id: payload.toChannelId }, select: { serverId: true, type: true } }),
      ]);
      if (!fromChannel?.serverId || !toChannel?.serverId) return;
      if (fromChannel.serverId !== toChannel.serverId) return;
      if (toChannel.type !== 'voice') return;

      const [actor, actorCtx] = await Promise.all([
        prisma.serverMember.findUnique({
          where: { userId_serverId: { userId, serverId: fromChannel.serverId } },
          include: { serverRole: true },
        }),
        loadPermissionContext(userId, fromChannel.serverId),
      ]);
      if (!actor || !actorCtx) return;
      const isOwner = actor.role?.toLowerCase() === 'owner';
      const canMove = isOwner || hasPermission(actorCtx, 'moveMembers');
      if (!canMove) return;

      // Fetch target member + permission context in parallel (one DB round-trip).
      // targetMember is needed for role hierarchy + server-mute re-application;
      // targetCtx gives us multi-role effectivePosition for role hierarchy.
      const [targetMember, targetCtx] = await Promise.all([
        prisma.serverMember.findUnique({
          where: { userId_serverId: { userId: payload.targetUserId, serverId: fromChannel.serverId } },
          include: { serverRole: true },
        }),
        loadPermissionContext(payload.targetUserId, fromChannel.serverId),
      ]);
      if (!targetMember) return;

      // Role hierarchy: LOWER position = HIGHER authority.
      // Block when target's effective position is <= actor's.
      if (!isOwner) {
        if (targetMember.role?.toLowerCase() === 'owner') return;
        const actorPos = effectivePosition(actorCtx);
        const targetPos = targetCtx ? effectivePosition(targetCtx) : Infinity;
        if (targetPos <= actorPos) return;
      }

      if (!(await isInVoiceChannel(payload.fromChannelId, payload.targetUserId))) return;
      const userData = await getVoiceParticipantData(payload.fromChannelId, payload.targetUserId);
      if (!userData) return;

      await Promise.all([
        removeVoiceParticipant(payload.fromChannelId, payload.targetUserId),
        deleteVoiceOverride(payload.fromChannelId, payload.targetUserId),
      ]);
      try {
        await Promise.all([
          addVoiceParticipant(payload.toChannelId, payload.targetUserId, userData),
          setVoiceReverseLookup(payload.targetUserId, payload.toChannelId),
        ]);
      } catch (moveErr) {
        // Rollback: restore to source channel
        await addVoiceParticipant(payload.fromChannelId, payload.targetUserId, userData).catch(() => {});
        await setVoiceReverseLookup(payload.targetUserId, payload.fromChannelId).catch(() => {});
        throw moveErr;
      }

      // Re-apply server-mute/deafen in the new channel if the moved user has persistent overrides
      if (targetMember.serverMuted || targetMember.serverDeafened) {
        await setVoiceOverride(payload.toChannelId, payload.targetUserId, {
          serverMuted: targetMember.serverMuted,
          serverDeafened: targetMember.serverDeafened,
          byUserId: 'system',
        });
        io.to(`user:${payload.targetUserId}`).emit('voice-server-mute', {
          channelId: payload.toChannelId,
          serverMuted: targetMember.serverMuted,
          serverDeafened: targetMember.serverDeafened,
          byUserId: 'system',
        });
      }

      // Migrate target user's socket(s) from old voice room to new one
      const targetSockets = await io.in(`user:${payload.targetUserId}`).fetchSockets();
      for (const targetSocket of targetSockets) {
        targetSocket.leave(`voice:${payload.fromChannelId}`);
        targetSocket.join(`voice:${payload.toChannelId}`);
      }

      io.to(`voice:${payload.fromChannelId}`).emit('voice-user-left', { userId: payload.targetUserId });
      const { capabilities: movedCaps, ...publicUserData } = userData;
      io.to(`voice:${payload.toChannelId}`).emit('voice-user-joined', { userId: payload.targetUserId, ...publicUserData, capabilities: movedCaps ?? [] });

      const [fromList, toList] = await Promise.all([
        getVoiceParticipants(payload.fromChannelId),
        getVoiceParticipants(payload.toChannelId),
      ]);
      io.to(`server:${fromChannel.serverId}`).emit('server-voice-participants', {
        serverId: fromChannel.serverId, channelId: payload.fromChannelId, participants: fromList.map(publicVoiceParticipant),
      });
      io.to(`server:${fromChannel.serverId}`).emit('server-voice-participants', {
        serverId: fromChannel.serverId, channelId: payload.toChannelId, participants: toList.map(publicVoiceParticipant),
      });

      // Forward secrecy at the involuntary-move boundary: the moved member
      // is removed from fromChannel without consent (moderator action, same class
      // as a kick), so rotate fromChannel's SFrame key. The toChannel keys on the
      // joined member via the normal join/request flow.
      scheduleVoiceE2eeRotate(io, payload.fromChannelId, fromList.length > 0);

      io.to(`user:${payload.targetUserId}`).emit('voice-moved', {
        fromChannelId: payload.fromChannelId,
        toChannelId: payload.toChannelId,
        byUserId: userId,
      });

      checkVoiceInactivity(payload.fromChannelId);
      checkVoiceInactivity(payload.toChannelId);
    } catch (err) {
      logger.error({ err, userId, event: 'move-voice-user' }, 'socket handler error');
    }
  });
}
