// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';
import type { SocketServerRole } from './types';

declare module './core' {
  interface SocketService {
    onPresenceUpdate(callback: (data: { userId: string; status: string }) => void): void;
    offPresenceUpdate(): void;
    onReportReviewed(callback: (data: { reportId: string; status: string; reason: string }) => void): void;
    offReportReviewed(): void;
    onFriendRequestReceived(callback: (data: { id: string; user: { id: string; username: string; discriminator: string; avatar?: string; status?: string } }) => void): void;
    offFriendRequestReceived(): void;
    onFriendRequestAccepted(callback: (data: { user: { id: string; username: string; discriminator: string; avatar?: string; status?: string } }) => void): void;
    offFriendRequestAccepted(): void;
    onFriendRequestDeclined(callback: (data: { requestId: string }) => void): void;
    offFriendRequestDeclined(): void;
    onFriendRequestCancelled(callback: (data: { requestId: string }) => void): void;
    offFriendRequestCancelled(): void;
    onFriendRemoved(callback: (data: { userId: string }) => void): void;
    offFriendRemoved(): void;
    onFriendListUpdate(callback: (data: { type: string }) => void): void;
    offFriendListUpdate(): void;
    offAllFriendEvents(): void;
    onServerRoleCreated(callback: (data: { serverId: string; role: SocketServerRole }) => void): void;
    offServerRoleCreated(): void;
    onServerRoleUpdated(callback: (data: { serverId: string; role: SocketServerRole }) => void): void;
    offServerRoleUpdated(): void;
    onServerRoleDeleted(callback: (data: { serverId: string; roleId: string }) => void): void;
    offServerRoleDeleted(): void;
    onServerMemberJoined(callback: (data: { serverId: string; user: { id: string; username: string; discriminator?: string; avatar?: string; status?: string }; role?: string; roleColor?: string }) => void): void;
    offServerMemberJoined(): void;
    onServerMemberLeft(callback: (data: { serverId: string; userId: string; kicked?: boolean }) => void): void;
    offServerMemberLeft(): void;
    onServerKicked(callback: (data: { serverId: string }) => void): void;
    offServerKicked(): void;
    onServerBanned(callback: (data: { serverId: string }) => void): void;
    offServerBanned(): void;
    onServerDeleted(callback: (data: { serverId: string }) => void): void;
    offServerDeleted(): void;
    onServerMemberRoleUpdated(callback: (data: { serverId: string; userId: string; roleId: string; roleName: string; roleColor: string; roleStyle: string }) => void): void;
    offServerMemberRoleUpdated(): void;
    onServerMemberRoleAdded(callback: (data: { serverId: string; userId: string; roleId: string; role: { id: string; name: string; color: string; style: string; position: number; displaySeparately: boolean }; roles: string[] }) => void): void;
    offServerMemberRoleAdded(): void;
    onServerMemberRoleRemoved(callback: (data: { serverId: string; userId: string; roleId: string; roles: string[] }) => void): void;
    offServerMemberRoleRemoved(): void;
    onMemberTimeoutApplied(callback: (data: { serverId: string; userId: string; timeoutUntil: string; reason: string | null; byUserId: string }) => void): void;
    offMemberTimeoutApplied(): void;
    onMemberTimeoutCleared(callback: (data: { serverId: string; userId: string; byUserId: string }) => void): void;
    offMemberTimeoutCleared(): void;
    onMemberNicknameChanged(callback: (data: { serverId: string; userId: string; nickname: string | null }) => void): void;
    offMemberNicknameChanged(): void;
    onServerUpdated(callback: (data: { serverId: string; name: string; icon: string | null; banner: string | null }) => void): void;
    offServerUpdated(): void;
    onServerSettingsUpdated(callback: (data: { serverId: string; settings: Record<string, unknown> }) => void): void;
    offServerSettingsUpdated(): void;
    onServerOwnershipTransferred(callback: (data: { serverId: string; previousOwnerId: string; newOwnerId: string }) => void): void;
    offServerOwnershipTransferred(): void;
    onServerEmojiCreated(callback: (data: { serverId: string; emoji: { id: string; name: string; imageUrl: string } }) => void): void;
    offServerEmojiCreated(): void;
    onServerEmojiDeleted(callback: (data: { serverId: string; emojiId: string }) => void): void;
    offServerEmojiDeleted(): void;
    onServerStickerCreated(callback: (data: { serverId: string; sticker: { id: string; name: string; imageUrl: string; description?: string | null } }) => void): void;
    offServerStickerCreated(): void;
    onServerStickerDeleted(callback: (data: { serverId: string; stickerId: string }) => void): void;
    offServerStickerDeleted(): void;
    onServerSoundboardCreated(callback: (data: { serverId: string; sound: { id: string; name: string; audioUrl: string; emoji?: string | null; volume?: number } }) => void): void;
    offServerSoundboardCreated(): void;
    onServerSoundboardDeleted(callback: (data: { serverId: string; soundId: string }) => void): void;
    offServerSoundboardDeleted(): void;
    onServerInviteCreated(callback: (data: { serverId: string; invite: Record<string, unknown> }) => void): void;
    offServerInviteCreated(): void;
    onServerInviteDeleted(callback: (data: { serverId: string; inviteId: string }) => void): void;
    offServerInviteDeleted(): void;
    offAllServerEvents(): void;
  }
}

SocketService.prototype.onPresenceUpdate = function(this: SocketService, callback: (data: { userId: string; status: string }) => void) {
  this.socket?.off('presence-update');
  this.socket?.on('presence-update', callback);
};

SocketService.prototype.offPresenceUpdate = function(this: SocketService) {
  this.socket?.off('presence-update');
};

SocketService.prototype.onReportReviewed = function(this: SocketService, callback: (data: { reportId: string; status: string; reason: string }) => void) {
  this.socket?.off('report-reviewed');
  this.socket?.on('report-reviewed', callback);
};

SocketService.prototype.offReportReviewed = function(this: SocketService) {
  this.socket?.off('report-reviewed');
};

SocketService.prototype.onFriendRequestReceived = function(this: SocketService, callback: (data: { id: string; user: { id: string; username: string; discriminator: string; avatar?: string; status?: string } }) => void) {
  this.socket?.off('friend-request-received');
  this.socket?.on('friend-request-received', callback);
};

SocketService.prototype.offFriendRequestReceived = function(this: SocketService) {
  this.socket?.off('friend-request-received');
};

SocketService.prototype.onFriendRequestAccepted = function(this: SocketService, callback: (data: { user: { id: string; username: string; discriminator: string; avatar?: string; status?: string } }) => void) {
  this.socket?.off('friend-request-accepted');
  this.socket?.on('friend-request-accepted', callback);
};

SocketService.prototype.offFriendRequestAccepted = function(this: SocketService) {
  this.socket?.off('friend-request-accepted');
};

SocketService.prototype.onFriendRequestDeclined = function(this: SocketService, callback: (data: { requestId: string }) => void) {
  this.socket?.off('friend-request-declined');
  this.socket?.on('friend-request-declined', callback);
};

SocketService.prototype.offFriendRequestDeclined = function(this: SocketService) {
  this.socket?.off('friend-request-declined');
};

SocketService.prototype.onFriendRequestCancelled = function(this: SocketService, callback: (data: { requestId: string }) => void) {
  this.socket?.off('friend-request-cancelled');
  this.socket?.on('friend-request-cancelled', callback);
};

SocketService.prototype.offFriendRequestCancelled = function(this: SocketService) {
  this.socket?.off('friend-request-cancelled');
};

SocketService.prototype.onFriendRemoved = function(this: SocketService, callback: (data: { userId: string }) => void) {
  this.socket?.off('friend-removed');
  this.socket?.on('friend-removed', callback);
};

SocketService.prototype.offFriendRemoved = function(this: SocketService) {
  this.socket?.off('friend-removed');
};

SocketService.prototype.onFriendListUpdate = function(this: SocketService, callback: (data: { type: string }) => void) {
  this.socket?.off('friend-list-update');
  this.socket?.on('friend-list-update', callback);
};

SocketService.prototype.offFriendListUpdate = function(this: SocketService) {
  this.socket?.off('friend-list-update');
};

SocketService.prototype.offAllFriendEvents = function(this: SocketService) {
  this.socket?.off('friend-request-received');
  this.socket?.off('friend-request-accepted');
  this.socket?.off('friend-request-declined');
  this.socket?.off('friend-request-cancelled');
  this.socket?.off('friend-removed');
  this.socket?.off('friend-list-update');
};

SocketService.prototype.onServerRoleCreated = function(this: SocketService, callback: (data: { serverId: string; role: SocketServerRole }) => void) {
  this.socket?.off('server-role-created');
  this.socket?.on('server-role-created', callback);
};

SocketService.prototype.offServerRoleCreated = function(this: SocketService) {
  this.socket?.off('server-role-created');
};

SocketService.prototype.onServerRoleUpdated = function(this: SocketService, callback: (data: { serverId: string; role: SocketServerRole }) => void) {
  this.socket?.off('server-role-updated');
  this.socket?.on('server-role-updated', callback);
};

SocketService.prototype.offServerRoleUpdated = function(this: SocketService) {
  this.socket?.off('server-role-updated');
};

SocketService.prototype.onServerRoleDeleted = function(this: SocketService, callback: (data: { serverId: string; roleId: string }) => void) {
  this.socket?.off('server-role-deleted');
  this.socket?.on('server-role-deleted', callback);
};

SocketService.prototype.offServerRoleDeleted = function(this: SocketService) {
  this.socket?.off('server-role-deleted');
};

SocketService.prototype.onServerMemberJoined = function(this: SocketService, callback: (data: { serverId: string; user: { id: string; username: string; discriminator?: string; avatar?: string; status?: string }; role?: string; roleColor?: string }) => void) {
  this.socket?.off('server-member-joined');
  this.socket?.on('server-member-joined', callback);
};

SocketService.prototype.offServerMemberJoined = function(this: SocketService) {
  this.socket?.off('server-member-joined');
};

SocketService.prototype.onServerMemberLeft = function(this: SocketService, callback: (data: { serverId: string; userId: string; kicked?: boolean }) => void) {
  this.socket?.off('server-member-left');
  this.socket?.on('server-member-left', callback);
};

SocketService.prototype.offServerMemberLeft = function(this: SocketService) {
  this.socket?.off('server-member-left');
};

SocketService.prototype.onServerKicked = function(this: SocketService, callback: (data: { serverId: string }) => void) {
  this.socket?.off('server-kicked');
  this.socket?.on('server-kicked', callback);
};

SocketService.prototype.offServerKicked = function(this: SocketService) {
  this.socket?.off('server-kicked');
};

SocketService.prototype.onServerBanned = function(this: SocketService, callback: (data: { serverId: string }) => void) {
  this.socket?.off('server-banned');
  this.socket?.on('server-banned', callback);
};

SocketService.prototype.offServerBanned = function(this: SocketService) {
  this.socket?.off('server-banned');
};

SocketService.prototype.onServerDeleted = function(this: SocketService, callback: (data: { serverId: string }) => void) {
  this.socket?.off('server-deleted');
  this.socket?.on('server-deleted', callback);
};

SocketService.prototype.offServerDeleted = function(this: SocketService) {
  this.socket?.off('server-deleted');
};

SocketService.prototype.onServerMemberRoleUpdated = function(this: SocketService, callback: (data: { serverId: string; userId: string; roleId: string; roleName: string; roleColor: string; roleStyle: string }) => void) {
  this.socket?.off('server-member-role-updated');
  this.socket?.on('server-member-role-updated', callback);
};

SocketService.prototype.offServerMemberRoleUpdated = function(this: SocketService) {
  this.socket?.off('server-member-role-updated');
};

SocketService.prototype.onServerMemberRoleAdded = function(this: SocketService, callback: (data: { serverId: string; userId: string; roleId: string; role: { id: string; name: string; color: string; style: string; position: number; displaySeparately: boolean }; roles: string[] }) => void) {
  this.socket?.off('server-member-role-added');
  this.socket?.on('server-member-role-added', callback);
};

SocketService.prototype.offServerMemberRoleAdded = function(this: SocketService) {
  this.socket?.off('server-member-role-added');
};

SocketService.prototype.onServerMemberRoleRemoved = function(this: SocketService, callback: (data: { serverId: string; userId: string; roleId: string; roles: string[] }) => void) {
  this.socket?.off('server-member-role-removed');
  this.socket?.on('server-member-role-removed', callback);
};

SocketService.prototype.offServerMemberRoleRemoved = function(this: SocketService) {
  this.socket?.off('server-member-role-removed');
};

SocketService.prototype.onMemberTimeoutApplied = function(this: SocketService, callback: (data: { serverId: string; userId: string; timeoutUntil: string; reason: string | null; byUserId: string }) => void) {
  this.socket?.off('member-timeout-applied');
  this.socket?.on('member-timeout-applied', callback);
};

SocketService.prototype.offMemberTimeoutApplied = function(this: SocketService) {
  this.socket?.off('member-timeout-applied');
};

SocketService.prototype.onMemberTimeoutCleared = function(this: SocketService, callback: (data: { serverId: string; userId: string; byUserId: string }) => void) {
  this.socket?.off('member-timeout-cleared');
  this.socket?.on('member-timeout-cleared', callback);
};

SocketService.prototype.offMemberTimeoutCleared = function(this: SocketService) {
  this.socket?.off('member-timeout-cleared');
};

SocketService.prototype.onMemberNicknameChanged = function(this: SocketService, callback: (data: { serverId: string; userId: string; nickname: string | null }) => void) {
  this.socket?.off('member-nickname-changed');
  this.socket?.on('member-nickname-changed', callback);
};

SocketService.prototype.offMemberNicknameChanged = function(this: SocketService) {
  this.socket?.off('member-nickname-changed');
};

SocketService.prototype.onServerUpdated = function(this: SocketService, callback: (data: { serverId: string; name: string; icon: string | null; banner: string | null }) => void) {
  this.socket?.off('server-updated');
  this.socket?.on('server-updated', callback);
};

SocketService.prototype.offServerUpdated = function(this: SocketService) {
  this.socket?.off('server-updated');
};

SocketService.prototype.onServerSettingsUpdated = function(this: SocketService, callback: (data: { serverId: string; settings: Record<string, unknown> }) => void) {
  this.socket?.off('server-settings-updated');
  this.socket?.on('server-settings-updated', callback);
};

SocketService.prototype.offServerSettingsUpdated = function(this: SocketService) {
  this.socket?.off('server-settings-updated');
};

SocketService.prototype.onServerOwnershipTransferred = function(this: SocketService, callback: (data: { serverId: string; previousOwnerId: string; newOwnerId: string }) => void) {
  this.socket?.off('server-ownership-transferred');
  this.socket?.on('server-ownership-transferred', callback);
};

SocketService.prototype.offServerOwnershipTransferred = function(this: SocketService) {
  this.socket?.off('server-ownership-transferred');
};

SocketService.prototype.onServerEmojiCreated = function(this: SocketService, callback: (data: { serverId: string; emoji: { id: string; name: string; imageUrl: string } }) => void) {
  this.socket?.off('server-emoji-created');
  this.socket?.on('server-emoji-created', callback);
};

SocketService.prototype.offServerEmojiCreated = function(this: SocketService) {
  this.socket?.off('server-emoji-created');
};

SocketService.prototype.onServerEmojiDeleted = function(this: SocketService, callback: (data: { serverId: string; emojiId: string }) => void) {
  this.socket?.off('server-emoji-deleted');
  this.socket?.on('server-emoji-deleted', callback);
};

SocketService.prototype.offServerEmojiDeleted = function(this: SocketService) {
  this.socket?.off('server-emoji-deleted');
};

SocketService.prototype.onServerStickerCreated = function(this: SocketService, callback: (data: { serverId: string; sticker: { id: string; name: string; imageUrl: string; description?: string | null } }) => void) {
  this.socket?.off('server-sticker-created');
  this.socket?.on('server-sticker-created', callback);
};

SocketService.prototype.offServerStickerCreated = function(this: SocketService) {
  this.socket?.off('server-sticker-created');
};

SocketService.prototype.onServerStickerDeleted = function(this: SocketService, callback: (data: { serverId: string; stickerId: string }) => void) {
  this.socket?.off('server-sticker-deleted');
  this.socket?.on('server-sticker-deleted', callback);
};

SocketService.prototype.offServerStickerDeleted = function(this: SocketService) {
  this.socket?.off('server-sticker-deleted');
};

SocketService.prototype.onServerSoundboardCreated = function(this: SocketService, callback: (data: { serverId: string; sound: { id: string; name: string; audioUrl: string; emoji?: string | null; volume?: number } }) => void) {
  this.socket?.off('server-soundboard-created');
  this.socket?.on('server-soundboard-created', callback);
};

SocketService.prototype.offServerSoundboardCreated = function(this: SocketService) {
  this.socket?.off('server-soundboard-created');
};

SocketService.prototype.onServerSoundboardDeleted = function(this: SocketService, callback: (data: { serverId: string; soundId: string }) => void) {
  this.socket?.off('server-soundboard-deleted');
  this.socket?.on('server-soundboard-deleted', callback);
};

SocketService.prototype.offServerSoundboardDeleted = function(this: SocketService) {
  this.socket?.off('server-soundboard-deleted');
};

SocketService.prototype.onServerInviteCreated = function(this: SocketService, callback: (data: { serverId: string; invite: Record<string, unknown> }) => void) {
  this.socket?.off('server-invite-created');
  this.socket?.on('server-invite-created', callback);
};

SocketService.prototype.offServerInviteCreated = function(this: SocketService) {
  this.socket?.off('server-invite-created');
};

SocketService.prototype.onServerInviteDeleted = function(this: SocketService, callback: (data: { serverId: string; inviteId: string }) => void) {
  this.socket?.off('server-invite-deleted');
  this.socket?.on('server-invite-deleted', callback);
};

SocketService.prototype.offServerInviteDeleted = function(this: SocketService) {
  this.socket?.off('server-invite-deleted');
};

SocketService.prototype.offAllServerEvents = function(this: SocketService) {
  this.socket?.off('server-role-created');
  this.socket?.off('server-role-updated');
  this.socket?.off('server-role-deleted');
  this.socket?.off('server-member-joined');
  this.socket?.off('server-member-left');
  this.socket?.off('server-kicked');
  this.socket?.off('server-banned');
  this.socket?.off('server-deleted');
  this.socket?.off('server-member-role-updated');
  this.socket?.off('server-member-role-added');
  this.socket?.off('server-member-role-removed');
  this.socket?.off('server-member-profile-updated');
  this.socket?.off('member-timeout-applied');
  this.socket?.off('member-timeout-cleared');
  this.socket?.off('member-nickname-changed');
  this.socket?.off('server-updated');
  this.socket?.off('server-settings-updated');
  this.socket?.off('server-ownership-transferred');
  this.socket?.off('server-emoji-created');
  this.socket?.off('server-emoji-deleted');
  this.socket?.off('server-sticker-created');
  this.socket?.off('server-sticker-deleted');
  this.socket?.off('server-soundboard-created');
  this.socket?.off('server-soundboard-deleted');
  this.socket?.off('server-invite-created');
  this.socket?.off('server-invite-deleted');
};
