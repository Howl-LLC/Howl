// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';

declare module './core' {
  interface SocketService {
    joinDmCall(dmChannelId: string, username: string, avatar?: string, banner?: string, withVideo?: boolean, mlsCallReady?: boolean): Promise<{ token?: string; url?: string }>;
    leaveDmCall(dmChannelId: string): void;
    onDmCallJoinError(callback: (payload: { dmChannelId: string; message: string }) => void): void;
    onDmCallParticipants(callback: (dmChannelId: string, participants: Array<{ userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; mlsCallReady?: boolean }>) => void): void;
    onDmCallUserJoined(callback: (data: { userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; capabilities?: string[]; mlsCallReady?: boolean }) => void): void;
    onDmCallUserLeft(callback: (data: { userId: string }) => void): void;
    sendDmCallStateUpdate(dmChannelId: string, isMuted: boolean, isDeafened: boolean): void;
    onDmCallStateUpdate(callback: (data: { userId: string; isMuted: boolean; isDeafened: boolean }) => void): void;
    offDmCallStateUpdate(): void;
    /** Announce whether our own SFrame leg is E2EE-established. Relayed by the
     *  server to the rest of the dm-call room so peers can render a *bilateral*
     *  encryption shield instead of over-claiming on local key possession. */
    sendDmCallE2eeAck(dmChannelId: string, ok: boolean): void;
    onDmCallE2eeAck(callback: (data: { userId: string; ok: boolean }) => void): void;
    offDmCallE2eeAck(): void;
    onDmCallInactivityDisconnect(callback: (data: { dmChannelId: string }) => void): void;
    offDmCallInactivityDisconnect(): void;
    onDmCallAutoDisconnected(callback: (data: { dmChannelId: string }) => void): void;
    offDmCallAutoDisconnected(): void;
    offDmCall(): void;
    onIncomingDMCall(callback: (data: { dmChannelId: string; fromUserId: string; username: string; avatar?: string; banner?: string | null; bannerPositionY?: number; bannerZoom?: number; nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null; avatarEffect?: string | null; effectivePlan?: string | null; withVideo?: boolean; mlsCallReady?: boolean }) => void): void;
    offIncomingDMCall(): void;
    /** Subscribe to `dm-call-ended`. Returns an unsubscribe that removes ONLY
     *  this listener (additive — safe for multiple subscribers). */
    onDmCallEnded(callback: (data: { dmChannelId: string }) => void): () => void;
    /** Removes ALL `dm-call-ended` listeners. Prefer the returned unsubscribe. */
    offDmCallEnded(): void;
    declineDmCall(dmChannelId: string): void;
    onDmCallDeclined(callback: (data: { userId: string; dmChannelId: string }) => void): void;
    offDmCallDeclined(): void;
    /** Server-side authoritative end for an outgoing DM call when no callee
     *  answered (60s ring timeout, all callees declined, or all callees
     *  disconnected without accepting). The caller's UI uses this to clear
     *  active call state and stop the ringback. */
    onDmCallNoAnswer(callback: (data: { dmChannelId: string; reason: 'no_answer' | 'all_declined' }) => void): void;
    offDmCallNoAnswer(): void;
    /** Subscribe to `dm-call-status-changed`. Returns an unsubscribe that removes
     *  ONLY this listener (additive — safe for multiple subscribers). */
    onDmCallStatusChanged(callback: (data: { dmChannelId: string; active: boolean; participants: Array<{ userId: string; username: string; avatar: string | null; banner?: string | null; bannerPositionY?: number; bannerZoom?: number; nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null; avatarEffect?: string | null; effectivePlan?: string | null }> }) => void): () => void;
    /** Removes ALL `dm-call-status-changed` listeners. Prefer the returned unsubscribe. */
    offDmCallStatusChanged(): void;
  }
}

SocketService.prototype.joinDmCall = function(this: SocketService, dmChannelId: string, username: string, avatar?: string, banner?: string, withVideo?: boolean, mlsCallReady?: boolean): Promise<{ token?: string; url?: string }> {
  const sock = this.socket;
  if (!sock) return Promise.reject(new Error('Socket not connected'));
  return new Promise<{ token?: string; url?: string }>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Reject on timeout. Silently resolving with `{}` was producing
      // "voice disconnected after a few seconds" symptoms: when the ACK is
      // late the server hasn't committed the participant row yet, the
      // HTTP /livekit/token fallback gets 403, room.connect() fails, and
      // RoomEvent.Disconnected fires. A loud failure with a retry is the
      // right UX. 15s is generous for a worst-case slow ACK.
      reject(new Error('Join request timed out. Please try again.'));
    }, 15000);
    // ACK carries the inline LiveKit token+url so the client avoids a
    // separate POST /livekit/token HTTP round trip (Tier 1 latency
    // optimization — matches Discord's VOICE_SERVER_UPDATE shape).
    sock.emit('join-dm-call', { dmChannelId, username, avatar, banner, withVideo, ...(typeof mlsCallReady === 'boolean' ? { mlsCallReady } : {}) }, (response?: { ok: boolean; error?: string; token?: string; url?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (response && response.ok === false) {
        reject(new Error(response.error ?? 'Failed to join DM call'));
      } else {
        resolve({ token: response?.token, url: response?.url });
      }
    });
  });
};

SocketService.prototype.leaveDmCall = function(this: SocketService, dmChannelId: string) {
  this.socket?.emit('leave-dm-call', { dmChannelId });
};

SocketService.prototype.onDmCallJoinError = function(this: SocketService, callback: (payload: { dmChannelId: string; message: string }) => void) {
  this.socket?.off('dm-call-join-error');
  this.socket?.on('dm-call-join-error', callback);
};

SocketService.prototype.onDmCallParticipants = function(this: SocketService, callback: (dmChannelId: string, participants: Array<{ userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; mlsCallReady?: boolean }>) => void) {
  this.socket?.off('dm-call-participants');
  this.socket?.on('dm-call-participants', (payload: { dmChannelId: string; participants: Array<{ userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; mlsCallReady?: boolean }> }) => {
    callback(payload.dmChannelId, payload.participants);
  });
};

SocketService.prototype.onDmCallUserJoined = function(this: SocketService, callback: (data: { userId: string; username: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string; capabilities?: string[]; mlsCallReady?: boolean }) => void) {
  this.socket?.off('dm-call-user-joined');
  this.socket?.on('dm-call-user-joined', callback);
};

SocketService.prototype.onDmCallUserLeft = function(this: SocketService, callback: (data: { userId: string }) => void) {
  this.socket?.off('dm-call-user-left');
  this.socket?.on('dm-call-user-left', callback);
};

SocketService.prototype.sendDmCallStateUpdate = function(this: SocketService, dmChannelId: string, isMuted: boolean, isDeafened: boolean) {
  this.socket?.emit('dm-call-state-update', { dmChannelId, isMuted, isDeafened });
};

SocketService.prototype.onDmCallStateUpdate = function(this: SocketService, callback: (data: { userId: string; isMuted: boolean; isDeafened: boolean }) => void) {
  this.socket?.off('dm-call-state-update');
  this.socket?.on('dm-call-state-update', callback);
};

SocketService.prototype.offDmCallStateUpdate = function(this: SocketService) {
  this.socket?.off('dm-call-state-update');
};

SocketService.prototype.sendDmCallE2eeAck = function(this: SocketService, dmChannelId: string, ok: boolean) {
  this.socket?.emit('dm-call-e2ee-ack', { dmChannelId, ok });
};

SocketService.prototype.onDmCallE2eeAck = function(this: SocketService, callback: (data: { userId: string; ok: boolean }) => void) {
  this.socket?.off('dm-call-e2ee-ack');
  this.socket?.on('dm-call-e2ee-ack', callback);
};

SocketService.prototype.offDmCallE2eeAck = function(this: SocketService) {
  this.socket?.off('dm-call-e2ee-ack');
};

SocketService.prototype.onDmCallInactivityDisconnect = function(this: SocketService, callback: (data: { dmChannelId: string }) => void) {
  this.socket?.off('dm-call-inactivity-disconnect');
  this.socket?.on('dm-call-inactivity-disconnect', callback);
};

SocketService.prototype.offDmCallInactivityDisconnect = function(this: SocketService) {
  this.socket?.off('dm-call-inactivity-disconnect');
};

SocketService.prototype.onDmCallAutoDisconnected = function(this: SocketService, callback: (data: { dmChannelId: string }) => void) {
  this.socket?.off('dm-call-auto-disconnected');
  this.socket?.on('dm-call-auto-disconnected', callback);
};

SocketService.prototype.offDmCallAutoDisconnected = function(this: SocketService) {
  this.socket?.off('dm-call-auto-disconnected');
};

SocketService.prototype.offDmCall = function(this: SocketService) {
  // Only blast events whose subscribers live INSIDE the call session
  // (CallTransport in useCallSession). Events with App-level / DM-view-level
  // subscribers — dm-call-status-changed (DMView banner) and
  // dm-call-auto-disconnected (useVoiceControlSocketEvents) — must NOT be
  // blasted here: they outlive the call and are managed via additive
  // subscription with their own specific unsubscribers. Blasting them on
  // call leave is the bug behind "X is in a call" pinning after both
  // parties leave: DMView's status-changed listener gets nuked when you
  // hang up, so the trailing {active:false, participants:[]} event for
  // the other party's leave never reaches the banner.
  this.socket?.off('dm-call-join-error');
  this.socket?.off('dm-call-participants');
  this.socket?.off('dm-call-user-joined');
  this.socket?.off('dm-call-user-left');
  this.socket?.off('dm-call-state-update');
  this.socket?.off('dm-call-e2ee-ack');
  this.socket?.off('dm-call-inactivity-disconnect');
  this.socket?.off('call-transferred');
};

SocketService.prototype.onIncomingDMCall = function(this: SocketService, callback: (data: { dmChannelId: string; fromUserId: string; username: string; avatar?: string; banner?: string | null; bannerPositionY?: number; bannerZoom?: number; nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null; avatarEffect?: string | null; effectivePlan?: string | null; withVideo?: boolean; mlsCallReady?: boolean }) => void) {
  this.socket?.off('incoming-dm-call');
  this.socket?.on('incoming-dm-call', callback);
};

SocketService.prototype.offIncomingDMCall = function(this: SocketService) {
  this.socket?.off('incoming-dm-call');
};

SocketService.prototype.onDmCallEnded = function(this: SocketService, callback: (data: { dmChannelId: string }) => void): () => void {
  const sock = this.socket;
  if (!sock) return () => { /* no socket yet */ };
  sock.on('dm-call-ended', callback);
  return () => { sock.off('dm-call-ended', callback); };
};

SocketService.prototype.offDmCallEnded = function(this: SocketService) {
  this.socket?.off('dm-call-ended');
};

SocketService.prototype.declineDmCall = function(this: SocketService, dmChannelId: string) {
  this.socket?.emit('decline-dm-call', { dmChannelId });
};

SocketService.prototype.onDmCallDeclined = function(this: SocketService, callback: (data: { userId: string; dmChannelId: string }) => void) {
  this.socket?.off('dm-call-declined');
  this.socket?.on('dm-call-declined', callback);
};

SocketService.prototype.offDmCallDeclined = function(this: SocketService) {
  this.socket?.off('dm-call-declined');
};

SocketService.prototype.onDmCallNoAnswer = function(this: SocketService, callback: (data: { dmChannelId: string; reason: 'no_answer' | 'all_declined' }) => void) {
  this.socket?.off('dm-call-no-answer');
  this.socket?.on('dm-call-no-answer', callback);
};

SocketService.prototype.offDmCallNoAnswer = function(this: SocketService) {
  this.socket?.off('dm-call-no-answer');
};

SocketService.prototype.onDmCallStatusChanged = function(this: SocketService, callback: (data: { dmChannelId: string; active: boolean; participants: Array<{ userId: string; username: string; avatar: string | null; banner?: string | null; bannerPositionY?: number; bannerZoom?: number; nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null; avatarEffect?: string | null; effectivePlan?: string | null }> }) => void): () => void {
  const sock = this.socket;
  if (!sock) return () => { /* no socket yet */ };
  sock.on('dm-call-status-changed', callback);
  return () => { sock.off('dm-call-status-changed', callback); };
};

SocketService.prototype.offDmCallStatusChanged = function(this: SocketService) {
  this.socket?.off('dm-call-status-changed');
};
