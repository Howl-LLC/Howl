// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';
import type { StageSession, StageAudienceMember } from '../../types';
import type { SignedStageHostBlob } from '../stageE2ee';

declare module './core' {
  interface SocketService {
    joinStageAudience(channelId: string): Promise<{ token?: string; url?: string }>;
    leaveStage(channelId: string): void;
    onStageStarted(callback: (session: StageSession) => void): void;
    offStageStarted(): void;
    onStageEnded(callback: (data: { sessionId: string; channelId: string }) => void): void;
    offStageEnded(): void;
    onStageUpdated(callback: (session: StageSession) => void): void;
    offStageUpdated(): void;
    onStageSpeakerAdded(callback: (data: {
      channelId: string; userId: string; username: string; discriminator?: string;
      avatar: string | null; banner?: string | null; bannerPositionY?: number; bannerZoom?: number;
      nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null;
      avatarEffect?: string | null; effectivePlan?: string;
      isMuted: boolean; isHost: boolean;
    }) => void): void;
    offStageSpeakerAdded(): void;
    onStageSpeakerRemoved(callback: (data: { channelId: string; userId: string }) => void): void;
    offStageSpeakerRemoved(): void;
    onStageHandRaised(callback: (data: { channelId: string; userId: string; username: string; avatar?: string | null }) => void): void;
    offStageHandRaised(): void;
    onStageHandLowered(callback: (data: { channelId: string; userId: string }) => void): void;
    offStageHandLowered(): void;
    onStageInviteSent(callback: (data: { userId: string; channelId: string }) => void): void;
    offStageInviteSent(): void;
    onStageAudienceJoined(callback: (data: StageAudienceMember & { channelId: string }) => void): void;
    offStageAudienceJoined(): void;
    onStageAudienceLeft(callback: (data: { userId: string; channelId: string }) => void): void;
    offStageAudienceLeft(): void;

    onStageE2eeKey(callback: (data: { channelId: string; encryptedKey: string; nonce: string; hostPublicKey: string; hostUserId: string; keyFormat?: string; hostBlob?: SignedStageHostBlob; hostSignature?: string }) => void): void;
    offStageE2eeKey(): void;
    onStageE2eeRotate(callback: (data: { channelId: string; newHostUserId: string }) => void): void;
    offStageE2eeRotate(): void;
    emitStageE2eeDistribute(data: { channelId: string; targetUserId: string; encryptedKey: string; nonce: string; keyFormat?: string; hostBlob?: SignedStageHostBlob; hostSignature?: string }): void;
    // audience/speaker key request (server forwards to current leader).
    onStageE2eeRequestKey(callback: (data: { channelId: string; userId: string; publicKey: string; capabilities?: string[] }) => void): void;
    offStageE2eeRequestKey(): void;
    emitStageE2eeRequestKey(data: { channelId: string; publicKey: string; capabilities?: string[] }): void;

    _stageGlobalHandler: ((payload: { serverId?: string; channelId: string; participants: Array<{ userId: string; username: string; avatar?: string }> }) => void) | null;
    _stageGlobalInitHandler: ((payload: { serverId?: string; participantsByChannel: Record<string, Array<{ userId: string; username: string; avatar?: string }>> }) => void) | null;

    onGlobalStageParticipants(callback: (serverId: string, channelId: string, participants: Array<{ userId: string; username: string; avatar?: string }>) => void, channelToServer?: () => Record<string, string>): void;
    onGlobalStageParticipantsInitial(callback: (serverId: string, participantsByChannel: Record<string, Array<{ userId: string; username: string; avatar?: string }>>) => void, channelToServer?: () => Record<string, string>): void;
    offGlobalStageParticipants(): void;
  }
}

SocketService.prototype.joinStageAudience = function(this: SocketService, channelId: string): Promise<{ token?: string; url?: string }> {
  const sock = this.socket;
  if (!sock) return Promise.reject(new Error('Socket not connected'));
  return new Promise<{ token?: string; url?: string }>((resolve, reject) => {
    let settled = false;
    // Matches joinDmCall / joinVoiceChannel: backend ACKs after committing
    // the audience/speaker Redis write, which gates the /livekit/token
    // endpoint for stages. Without the ACK the token fetch races the socket
    // handler and gets 403 — stage engine fails to start. The ACK also
    // carries an inline LiveKit token+url so the client avoids a separate
    // HTTP round trip (Tier 1 latency optimization).
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Reject on timeout (matches joinDmCall / joinVoiceChannel). Silently
      // resolving with `{}` caused premature disconnects when the ACK was
      // late: the HTTP /livekit/token fallback gets 403 because the speaker
      // row hasn't committed, and the stage engine fails immediately.
      reject(new Error('Stage join timed out — please try again.'));
    }, 15000);
    sock.emit('stage-join-audience', channelId, (response?: { ok: boolean; error?: string; token?: string; url?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (response && response.ok === false) {
        reject(new Error(response.error ?? 'Failed to join stage'));
      } else {
        resolve({ token: response?.token, url: response?.url });
      }
    });
  });
};

SocketService.prototype.leaveStage = function(this: SocketService, channelId: string) {
  this.socket?.emit('stage-leave', channelId);
};

SocketService.prototype.onStageStarted = function(this: SocketService, callback) {
  this.socket?.off('stage-started');
  this.socket?.on('stage-started', callback);
};

SocketService.prototype.offStageStarted = function(this: SocketService) {
  this.socket?.off('stage-started');
};

SocketService.prototype.onStageEnded = function(this: SocketService, callback) {
  this.socket?.off('stage-ended');
  this.socket?.on('stage-ended', callback);
};

SocketService.prototype.offStageEnded = function(this: SocketService) {
  this.socket?.off('stage-ended');
};

SocketService.prototype.onStageUpdated = function(this: SocketService, callback) {
  this.socket?.off('stage-updated');
  this.socket?.on('stage-updated', callback);
};

SocketService.prototype.offStageUpdated = function(this: SocketService) {
  this.socket?.off('stage-updated');
};

SocketService.prototype.onStageSpeakerAdded = function(this: SocketService, callback) {
  this.socket?.off('stage-speaker-added');
  this.socket?.on('stage-speaker-added', callback);
};

SocketService.prototype.offStageSpeakerAdded = function(this: SocketService) {
  this.socket?.off('stage-speaker-added');
};

SocketService.prototype.onStageSpeakerRemoved = function(this: SocketService, callback) {
  this.socket?.off('stage-speaker-removed');
  this.socket?.on('stage-speaker-removed', callback);
};

SocketService.prototype.offStageSpeakerRemoved = function(this: SocketService) {
  this.socket?.off('stage-speaker-removed');
};

SocketService.prototype.onStageHandRaised = function(this: SocketService, callback) {
  this.socket?.off('stage-hand-raised');
  this.socket?.on('stage-hand-raised', callback);
};

SocketService.prototype.offStageHandRaised = function(this: SocketService) {
  this.socket?.off('stage-hand-raised');
};

SocketService.prototype.onStageHandLowered = function(this: SocketService, callback) {
  this.socket?.off('stage-hand-lowered');
  this.socket?.on('stage-hand-lowered', callback);
};

SocketService.prototype.offStageHandLowered = function(this: SocketService) {
  this.socket?.off('stage-hand-lowered');
};

SocketService.prototype.onStageInviteSent = function(this: SocketService, callback) {
  this.socket?.off('stage-invite-sent');
  this.socket?.on('stage-invite-sent', callback);
};

SocketService.prototype.offStageInviteSent = function(this: SocketService) {
  this.socket?.off('stage-invite-sent');
};

SocketService.prototype.onStageAudienceJoined = function(this: SocketService, callback) {
  this.socket?.off('stage-audience-joined');
  this.socket?.on('stage-audience-joined', callback);
};

SocketService.prototype.offStageAudienceJoined = function(this: SocketService) {
  this.socket?.off('stage-audience-joined');
};

SocketService.prototype.onStageAudienceLeft = function(this: SocketService, callback) {
  this.socket?.off('stage-audience-left');
  this.socket?.on('stage-audience-left', callback);
};

SocketService.prototype.offStageAudienceLeft = function(this: SocketService) {
  this.socket?.off('stage-audience-left');
};

SocketService.prototype.onStageE2eeKey = function(this: SocketService, callback: (data: { channelId: string; encryptedKey: string; nonce: string; hostPublicKey: string; hostUserId: string; keyFormat?: string; hostBlob?: SignedStageHostBlob; hostSignature?: string }) => void) {
  this.socket?.off('stage-e2ee-key');
  this.socket?.on('stage-e2ee-key', callback);
};

SocketService.prototype.offStageE2eeKey = function(this: SocketService) {
  this.socket?.off('stage-e2ee-key');
};

SocketService.prototype.onStageE2eeRotate = function(this: SocketService, callback: (data: { channelId: string; newHostUserId: string }) => void) {
  this.socket?.off('stage-e2ee-rotate');
  this.socket?.on('stage-e2ee-rotate', callback);
};

SocketService.prototype.offStageE2eeRotate = function(this: SocketService) {
  this.socket?.off('stage-e2ee-rotate');
};

SocketService.prototype.emitStageE2eeDistribute = function(this: SocketService, data: { channelId: string; targetUserId: string; encryptedKey: string; nonce: string; keyFormat?: string; hostBlob?: SignedStageHostBlob; hostSignature?: string }) {
  this.socket?.emit('stage-e2ee-distribute', data);
};

SocketService.prototype.onStageE2eeRequestKey = function(this: SocketService, callback: (data: { channelId: string; userId: string; publicKey: string; capabilities?: string[] }) => void) {
  this.socket?.off('stage-e2ee-request-key');
  this.socket?.on('stage-e2ee-request-key', callback);
};

SocketService.prototype.offStageE2eeRequestKey = function(this: SocketService) {
  this.socket?.off('stage-e2ee-request-key');
};

SocketService.prototype.emitStageE2eeRequestKey = function(this: SocketService, data: { channelId: string; publicKey: string; capabilities?: string[] }) {
  this.socket?.emit('stage-e2ee-request-key', data);
};

SocketService.prototype.onGlobalStageParticipants = function(
  this: SocketService,
  callback: (serverId: string, channelId: string, participants: Array<{ userId: string; username: string; avatar?: string }>) => void,
  channelToServer?: () => Record<string, string>,
) {
  if (!this.socket) return;
  if (this._stageGlobalHandler) this.socket.off('server-stage-participants', this._stageGlobalHandler);
  this._stageGlobalHandler = (payload: { serverId?: string; channelId: string; participants: Array<{ userId: string; username: string; avatar?: string }> }) => {
    const sid = payload.serverId || channelToServer?.()[payload.channelId];
    if (sid) callback(sid, payload.channelId, payload.participants);
  };
  this.socket.on('server-stage-participants', this._stageGlobalHandler);
};

SocketService.prototype.onGlobalStageParticipantsInitial = function(
  this: SocketService,
  callback: (serverId: string, participantsByChannel: Record<string, Array<{ userId: string; username: string; avatar?: string }>>) => void,
  channelToServer?: () => Record<string, string>,
) {
  if (!this.socket) return;
  if (this._stageGlobalInitHandler) this.socket.off('server-stage-participants-initial', this._stageGlobalInitHandler);
  this._stageGlobalInitHandler = (payload: { serverId?: string; participantsByChannel: Record<string, Array<{ userId: string; username: string; avatar?: string }>> }) => {
    const channels = payload.participantsByChannel ?? {};
    let sid = payload.serverId;
    if (!sid && channelToServer) {
      const map = channelToServer();
      const firstCh = Object.keys(channels)[0];
      if (firstCh) sid = map[firstCh];
    }
    if (sid) callback(sid, channels);
  };
  this.socket.on('server-stage-participants-initial', this._stageGlobalInitHandler);
};

SocketService.prototype.offGlobalStageParticipants = function(this: SocketService) {
  if (this._stageGlobalHandler) { this.socket?.off('server-stage-participants', this._stageGlobalHandler); this._stageGlobalHandler = null; }
  if (this._stageGlobalInitHandler) { this.socket?.off('server-stage-participants-initial', this._stageGlobalInitHandler); this._stageGlobalInitHandler = null; }
};
