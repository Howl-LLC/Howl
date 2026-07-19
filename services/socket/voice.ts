// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';
import type { SignedVoiceJoinBlob } from '../voiceE2ee';

declare module './core' {
  interface SocketService {
    _svpHandler: ((payload: { channelId: string; participants: Array<{ userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }> }) => void) | null;
    _svpInitHandler: ((payload: { participantsByChannel: Record<string, Array<{ userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }>> }) => void) | null;
    _svpGlobalHandler: ((payload: { serverId?: string; channelId: string; participants: Array<{ userId: string; username: string; avatar?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }> }) => void) | null;
    _svpGlobalInitHandler: ((payload: { serverId?: string; participantsByChannel: Record<string, Array<{ userId: string; username: string; avatar?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }>> }) => void) | null;

    onServerVoiceParticipants(callback: (channelId: string, participants: Array<{ userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }>) => void): void;
    onServerVoiceParticipantsInitial(callback: (participantsByChannel: Record<string, Array<{ userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }>>) => void): void;
    offServerVoiceParticipants(): void;
    onGlobalVoiceParticipants(callback: (serverId: string, channelId: string, participants: Array<{ userId: string; username: string; avatar?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }>) => void, channelToServer?: () => Record<string, string>): void;
    onGlobalVoiceParticipantsInitial(callback: (serverId: string, participantsByChannel: Record<string, Array<{ userId: string; username: string; avatar?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }>>) => void, channelToServer?: () => Record<string, string>): void;
    offGlobalVoiceParticipants(): void;
    onServerChannelActivity(callback: (payload: { serverId: string; channelId: string; messageId: string; mentionUserIds: string[] }) => void): void;
    offServerChannelActivity(): void;
    joinVoiceChannel(channelId: string, username: string, avatar?: string, banner?: string, signed?: { blob: SignedVoiceJoinBlob; signature: string }): Promise<{ token?: string; url?: string }>;
    leaveVoiceChannel(channelId: string): void;
    onVoiceJoinError(callback: (payload: { channelId: string; message: string }) => void): void;
    onVoiceParticipants(callback: (channelId: string, participants: Array<{ userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nickname?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string; joinBlob?: SignedVoiceJoinBlob; signature?: string }>, powerUpTier?: number) => void): void;
    onVoiceUserJoined(callback: (data: { userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nickname?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string; joinBlob?: SignedVoiceJoinBlob; signature?: string; capabilities?: string[] }) => void): void;
    onVoiceUserLeft(callback: (data: { userId: string }) => void): void;
    sendVoiceSoundboardPlay(channelId: string, sound: { audioUrl: string; volume: number; name: string; emoji?: string }): void;
    onVoiceSoundboardPlay(callback: (data: { fromUserId: string; audioUrl: string; volume: number; name: string; emoji?: string }) => void): void;
    offVoiceSoundboardPlay(): void;
    sendVoiceStateUpdate(channelId: string, isMuted: boolean, isDeafened: boolean): void;
    onVoiceStateUpdate(callback: (data: { userId: string; isMuted: boolean; isDeafened: boolean; serverMuted?: boolean; serverDeafened?: boolean }) => void): void;
    offVoiceStateUpdate(): void;
    sendServerMuteUser(channelId: string, targetUserId: string, muted: boolean): void;
    sendServerDeafenUser(channelId: string, targetUserId: string, deafened: boolean): void;
    onVoiceServerMute(callback: (data: { channelId: string; serverMuted: boolean; serverDeafened: boolean; byUserId: string }) => void): void;
    offVoiceServerMute(): void;
    sendMoveVoiceUser(targetUserId: string, fromChannelId: string, toChannelId: string): void;
    onVoiceMoved(callback: (data: { fromChannelId: string; toChannelId: string; byUserId: string }) => void): void;
    offVoiceMoved(): void;
    onVoiceInactivityDisconnect(callback: (data: { channelId: string }) => void): void;
    offVoiceInactivityDisconnect(): void;
    onVoiceAutoDisconnected(callback: (data: { channelId: string }) => void): void;
    offVoiceAutoDisconnected(): void;
    onVoiceE2eeKey(callback: (data: { channelId: string; encryptedKey: string; nonce: string; leaderPublicKey: string; leaderUserId: string; keyFormat?: string }) => void): void;
    offVoiceE2eeKey(): void;
    onVoiceE2eeRotate(callback: (data: { channelId: string; newLeaderUserId: string }) => void): void;
    offVoiceE2eeRotate(): void;
    onVoiceE2eeRequestKey(callback: (data: { channelId: string; userId: string; publicKey: string; capabilities?: string[] }) => void): void;
    offVoiceE2eeRequestKey(): void;
    emitVoiceE2eeDistribute(data: { channelId: string; targetUserId: string; encryptedKey: string; nonce: string; keyFormat?: string }): void;
    emitVoiceE2eeRequestKey(data: { channelId: string; publicKey: string; targetUserId?: string }): void;
    /** Additive voice-participants listener used by useVoiceE2ee to
     *  run its local leader election. Does NOT clobber other listeners on the
     *  same event. Returns an unsubscribe function. `signingPublicKey` is
     *  the DB-authoritative Ed25519 pub; clients must verify
     *  `blob.signature` against this value rather than the self-declared
     *  `blob.sigPub`. */
    addVoiceParticipantsListener(callback: (channelId: string, participants: Array<{ userId: string; username: string; joinBlob?: SignedVoiceJoinBlob; signature?: string; signingPublicKey?: string }>) => void): () => void;
    offVoice(): void;
    /** Tell the server the local user started/stopped publishing a screen
     *  track in this voice channel. Drives the sidebar "watch stream" icon
     *  for other server members. No-op if not currently in the channel. */
    sendVoiceSetScreenShare(channelId: string, isScreenSharing: boolean): void;
  }
}

SocketService.prototype.onServerVoiceParticipants = function(this: SocketService, callback: (channelId: string, participants: Array<{ userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }>) => void) {
  if (!this.socket) return;
  if (this._svpHandler) this.socket.off('server-voice-participants', this._svpHandler);
  this._svpHandler = (payload: { channelId: string; participants: Array<{ userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }> }) => {
    callback(payload.channelId, payload.participants);
  };
  this.socket.on('server-voice-participants', this._svpHandler);
};

SocketService.prototype.onServerVoiceParticipantsInitial = function(this: SocketService, callback: (participantsByChannel: Record<string, Array<{ userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }>>) => void) {
  if (!this.socket) return;
  if (this._svpInitHandler) this.socket.off('server-voice-participants-initial', this._svpInitHandler);
  this._svpInitHandler = (payload: { participantsByChannel: Record<string, Array<{ userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }>> }) => {
    callback(payload.participantsByChannel ?? {});
  };
  this.socket.on('server-voice-participants-initial', this._svpInitHandler);
};

SocketService.prototype.offServerVoiceParticipants = function(this: SocketService) {
  if (this._svpHandler) { this.socket?.off('server-voice-participants', this._svpHandler); this._svpHandler = null; }
  if (this._svpInitHandler) { this.socket?.off('server-voice-participants-initial', this._svpInitHandler); this._svpInitHandler = null; }
};

SocketService.prototype.onGlobalVoiceParticipants = function(
  this: SocketService,
  callback: (serverId: string, channelId: string, participants: Array<{ userId: string; username: string; avatar?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }>) => void,
  channelToServer?: () => Record<string, string>,
) {
  if (!this.socket) return;
  if (this._svpGlobalHandler) this.socket.off('server-voice-participants', this._svpGlobalHandler);
  this._svpGlobalHandler = (payload: { serverId?: string; channelId: string; participants: Array<{ userId: string; username: string; avatar?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }> }) => {
    const sid = payload.serverId || channelToServer?.()[payload.channelId];
    if (sid) callback(sid, payload.channelId, payload.participants);
  };
  this.socket.on('server-voice-participants', this._svpGlobalHandler);
};

SocketService.prototype.onGlobalVoiceParticipantsInitial = function(
  this: SocketService,
  callback: (serverId: string, participantsByChannel: Record<string, Array<{ userId: string; username: string; avatar?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }>>) => void,
  channelToServer?: () => Record<string, string>,
) {
  if (!this.socket) return;
  if (this._svpGlobalInitHandler) this.socket.off('server-voice-participants-initial', this._svpGlobalInitHandler);
  this._svpGlobalInitHandler = (payload: { serverId?: string; participantsByChannel: Record<string, Array<{ userId: string; username: string; avatar?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }>> }) => {
    const channels = payload.participantsByChannel ?? {};
    let sid = payload.serverId;
    if (!sid && channelToServer) {
      const map = channelToServer();
      const firstCh = Object.keys(channels)[0];
      if (firstCh) sid = map[firstCh];
    }
    if (sid) callback(sid, channels);
  };
  this.socket.on('server-voice-participants-initial', this._svpGlobalInitHandler);
};

SocketService.prototype.offGlobalVoiceParticipants = function(this: SocketService) {
  if (this._svpGlobalHandler) { this.socket?.off('server-voice-participants', this._svpGlobalHandler); this._svpGlobalHandler = null; }
  if (this._svpGlobalInitHandler) { this.socket?.off('server-voice-participants-initial', this._svpGlobalInitHandler); this._svpGlobalInitHandler = null; }
};

SocketService.prototype.onServerChannelActivity = function(this: SocketService, callback: (payload: { serverId: string; channelId: string; messageId: string; mentionUserIds: string[] }) => void) {
  if (!this.socket) return;
  this.socket.off('server-channel-activity');
  this.socket.on('server-channel-activity', callback);
};

SocketService.prototype.offServerChannelActivity = function(this: SocketService) {
  this.socket?.off('server-channel-activity');
};

SocketService.prototype.joinVoiceChannel = function(this: SocketService, channelId: string, username: string, avatar?: string, banner?: string, signed?: { blob: SignedVoiceJoinBlob; signature: string }): Promise<{ token?: string; url?: string }> {
  const sock = this.socket;
  if (!sock) return Promise.reject(new Error('Socket not connected'));
  return new Promise<{ token?: string; url?: string }>((resolve, reject) => {
    let settled = false;
    // Matches joinDmCall: backend ACKs after committing the Redis membership
    // write, which gates the /livekit/token endpoint. Without this, the token
    // fetch races ahead and gets 403 "must join channel first" — engine.start()
    // then throws, localStream is empty (no voice-level meter), and no
    // remote-participant tracks ever subscribe (room connection failed).
    // The ACK also carries the inline LiveKit token + url so the client
    // avoids a separate HTTP round trip (Tier 1 latency optimization).
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Reject on timeout. Silently resolving with `{}` produced "voice
      // disconnected after a few seconds": when the ACK is late the
      // backend hasn't committed the membership row yet, the HTTP
      // /livekit/token fallback gets 403, room.connect() fails, and
      // RoomEvent.Disconnected fires. Loud, retriable failure is correct.
      reject(new Error('Join request timed out. Please try again.'));
    }, 15000);
    sock.emit('join-voice-channel', { channelId, username, avatar, banner, joinBlob: signed?.blob, signature: signed?.signature }, (response?: { ok: boolean; error?: string; token?: string; url?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (response && response.ok === false) {
        reject(new Error(response.error ?? 'Failed to join voice channel'));
      } else {
        resolve({ token: response?.token, url: response?.url });
      }
    });
  });
};

SocketService.prototype.leaveVoiceChannel = function(this: SocketService, channelId: string) {
  this.socket?.emit('leave-voice-channel', { channelId });
};

SocketService.prototype.onVoiceJoinError = function(this: SocketService, callback: (payload: { channelId: string; message: string }) => void) {
  this.socket?.off('voice-join-error');
  this.socket?.on('voice-join-error', callback);
};

SocketService.prototype.onVoiceParticipants = function(this: SocketService, callback: (channelId: string, participants: Array<{ userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nickname?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }>, powerUpTier?: number) => void) {
  this.socket?.off('voice-participants');
  this.socket?.on('voice-participants', (payload: { channelId: string; participants: Array<{ userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nickname?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }>; powerUpTier?: number }) => {
    callback(payload.channelId, payload.participants, payload.powerUpTier);
  });
};

SocketService.prototype.onVoiceUserJoined = function(this: SocketService, callback: (data: { userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nickname?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; roleColor?: string; roleStyle?: string }) => void) {
  this.socket?.off('voice-user-joined');
  this.socket?.on('voice-user-joined', callback);
};

SocketService.prototype.onVoiceUserLeft = function(this: SocketService, callback: (data: { userId: string }) => void) {
  this.socket?.off('voice-user-left');
  this.socket?.on('voice-user-left', callback);
};

SocketService.prototype.sendVoiceSoundboardPlay = function(this: SocketService, channelId: string, sound: { audioUrl: string; volume: number; name: string; emoji?: string }) {
  this.socket?.emit('voice-soundboard-play', { channelId, ...sound });
};

SocketService.prototype.onVoiceSoundboardPlay = function(this: SocketService, callback: (data: { fromUserId: string; audioUrl: string; volume: number; name: string; emoji?: string }) => void) {
  this.socket?.off('voice-soundboard-play');
  this.socket?.on('voice-soundboard-play', callback);
};

SocketService.prototype.offVoiceSoundboardPlay = function(this: SocketService) {
  this.socket?.off('voice-soundboard-play');
};

SocketService.prototype.sendVoiceStateUpdate = function(this: SocketService, channelId: string, isMuted: boolean, isDeafened: boolean) {
  this.socket?.emit('voice-state-update', { channelId, isMuted, isDeafened });
};

SocketService.prototype.onVoiceStateUpdate = function(this: SocketService, callback: (data: { userId: string; isMuted: boolean; isDeafened: boolean; serverMuted?: boolean; serverDeafened?: boolean }) => void) {
  this.socket?.off('voice-state-update');
  this.socket?.on('voice-state-update', callback);
};

SocketService.prototype.offVoiceStateUpdate = function(this: SocketService) {
  this.socket?.off('voice-state-update');
};

SocketService.prototype.sendServerMuteUser = function(this: SocketService, channelId: string, targetUserId: string, muted: boolean) {
  this.socket?.emit('server-mute-user', { channelId, targetUserId, muted });
};

SocketService.prototype.sendServerDeafenUser = function(this: SocketService, channelId: string, targetUserId: string, deafened: boolean) {
  this.socket?.emit('server-deafen-user', { channelId, targetUserId, deafened });
};

SocketService.prototype.onVoiceServerMute = function(this: SocketService, callback: (data: { channelId: string; serverMuted: boolean; serverDeafened: boolean; byUserId: string }) => void) {
  this.socket?.off('voice-server-mute');
  this.socket?.on('voice-server-mute', callback);
};

SocketService.prototype.offVoiceServerMute = function(this: SocketService) {
  this.socket?.off('voice-server-mute');
};

SocketService.prototype.sendMoveVoiceUser = function(this: SocketService, targetUserId: string, fromChannelId: string, toChannelId: string) {
  this.socket?.emit('move-voice-user', { targetUserId, fromChannelId, toChannelId });
};

SocketService.prototype.onVoiceMoved = function(this: SocketService, callback: (data: { fromChannelId: string; toChannelId: string; byUserId: string }) => void) {
  this.socket?.off('voice-moved');
  this.socket?.on('voice-moved', callback);
};

SocketService.prototype.offVoiceMoved = function(this: SocketService) {
  this.socket?.off('voice-moved');
};

SocketService.prototype.onVoiceInactivityDisconnect = function(this: SocketService, callback: (data: { channelId: string }) => void) {
  this.socket?.off('voice-inactivity-disconnect');
  this.socket?.on('voice-inactivity-disconnect', callback);
};

SocketService.prototype.offVoiceInactivityDisconnect = function(this: SocketService) {
  this.socket?.off('voice-inactivity-disconnect');
};

SocketService.prototype.onVoiceAutoDisconnected = function(this: SocketService, callback: (data: { channelId: string }) => void) {
  this.socket?.off('voice-auto-disconnected');
  this.socket?.on('voice-auto-disconnected', callback);
};

SocketService.prototype.offVoiceAutoDisconnected = function(this: SocketService) {
  this.socket?.off('voice-auto-disconnected');
};

SocketService.prototype.onVoiceE2eeKey = function(this: SocketService, callback: (data: { channelId: string; encryptedKey: string; nonce: string; leaderPublicKey: string; leaderUserId: string; keyFormat?: string }) => void) {
  this.socket?.off('voice-e2ee-key');
  this.socket?.on('voice-e2ee-key', callback);
};

SocketService.prototype.offVoiceE2eeKey = function(this: SocketService) {
  this.socket?.off('voice-e2ee-key');
};

SocketService.prototype.onVoiceE2eeRotate = function(this: SocketService, callback: (data: { channelId: string; newLeaderUserId: string }) => void) {
  this.socket?.off('voice-e2ee-rotate');
  this.socket?.on('voice-e2ee-rotate', callback);
};

SocketService.prototype.offVoiceE2eeRotate = function(this: SocketService) {
  this.socket?.off('voice-e2ee-rotate');
};

SocketService.prototype.onVoiceE2eeRequestKey = function(this: SocketService, callback: (data: { channelId: string; userId: string; publicKey: string; capabilities?: string[] }) => void) {
  this.socket?.off('voice-e2ee-request-key');
  this.socket?.on('voice-e2ee-request-key', callback);
};

SocketService.prototype.offVoiceE2eeRequestKey = function(this: SocketService) {
  this.socket?.off('voice-e2ee-request-key');
};

SocketService.prototype.emitVoiceE2eeDistribute = function(this: SocketService, data: { channelId: string; targetUserId: string; encryptedKey: string; nonce: string; keyFormat?: string }) {
  this.socket?.emit('voice-e2ee-distribute', data);
};

SocketService.prototype.emitVoiceE2eeRequestKey = function(this: SocketService, data: { channelId: string; publicKey: string; targetUserId?: string }) {
  this.socket?.emit('voice-e2ee-request-key', data);
};

SocketService.prototype.addVoiceParticipantsListener = function(
  this: SocketService,
  callback: (channelId: string, participants: Array<{ userId: string; username: string; joinBlob?: SignedVoiceJoinBlob; signature?: string; signingPublicKey?: string }>) => void,
): () => void {
  const socket = this.socket;
  if (!socket) return () => {};
  const handler = (payload: { channelId: string; participants: Array<{ userId: string; username: string; joinBlob?: SignedVoiceJoinBlob; signature?: string; signingPublicKey?: string }> }) => {
    callback(payload.channelId, payload.participants);
  };
  socket.on('voice-participants', handler);
  return () => { socket.off('voice-participants', handler); };
};

SocketService.prototype.sendVoiceSetScreenShare = function(this: SocketService, channelId: string, isScreenSharing: boolean) {
  this.socket?.emit('voice-set-screenshare', { channelId, isScreenSharing });
};

SocketService.prototype.offVoice = function(this: SocketService) {
  this.socket?.off('voice-join-error');
  this.socket?.off('voice-participants');
  this.socket?.off('voice-user-joined');
  this.socket?.off('voice-user-left');
  this.socket?.off('voice-soundboard-play');
  this.socket?.off('voice-state-update');
  this.socket?.off('voice-inactivity-disconnect');
  this.socket?.off('voice-auto-disconnected');
  this.socket?.off('voice-server-mute');
  this.socket?.off('voice-moved');
  this.socket?.off('voice-e2ee-key');
  this.socket?.off('voice-e2ee-rotate');
  this.socket?.off('voice-e2ee-request-key');
};
