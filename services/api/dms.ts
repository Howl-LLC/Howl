// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { User, Message } from '../../types';
import type { BackendUser, BackendDMMessage } from '../apiTypes';

declare module './core' {
  interface APIClient {
    getUsers(): Promise<Array<{ id: string; username: string; discriminator?: string; avatar?: string }>>;
    getDMs(): Promise<Array<{
      id: string;
      otherUser?: { id: string; username: string; discriminator?: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; activityBio?: string | null; status?: string; activity?: { type: string; name: string; details?: string; state?: string; largeImage?: string; smallImage?: string; startedAt: string; platformId?: string; platform?: string } } | null;
      isGroup?: boolean;
      name?: string;
      icon?: string;
      ownerId?: string | null;
      encrypted?: boolean;
      serverReadable?: boolean;
      otherUsers?: Array<{ id: string; username: string; discriminator?: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; activityBio?: string | null; status?: string; activity?: { type: string; name: string; details?: string; state?: string; largeImage?: string; smallImage?: string; startedAt: string; platformId?: string; platform?: string } }>;
      lastMessage?: { content: string; createdAt: string; authorId?: string };
      hasUnread?: boolean;
      pinned?: boolean;
      pinnedAt?: string;
      blockedByMe?: boolean;
      blockedByThem?: boolean;
      blockedParticipantIds?: string[];
      mlsGroupId?: string | null;
      otrMlsGroupId?: string | null;
    }>>;
    markDmAsRead(dmChannelId: string, before?: string): Promise<void>;
    getOrCreateDM(otherUserId: string): Promise<{ id: string; encrypted: true; serverReadable?: boolean; otherUser: { id: string; username: string; discriminator?: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; activityBio?: string | null; status?: string; activity?: { type: string; name: string; details?: string; state?: string; largeImage?: string; smallImage?: string; startedAt: string; platformId?: string; platform?: string } } | null }>;
    createGroupDM(memberIds: string[]): Promise<{ id: string; encrypted: true; isGroup: true; created?: boolean; name?: string; icon?: string; ownerId?: string | null; otherUsers: Array<{ id: string; username: string; discriminator?: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; activityBio?: string | null; status?: string; activity?: { type: string; name: string; details?: string; state?: string; largeImage?: string; smallImage?: string; startedAt: string; platformId?: string; platform?: string } }> }>;
    updateGroupDM(dmChannelId: string, data: { name?: string; icon?: string }): Promise<{ id: string; name?: string; icon?: string }>;
    leaveGroupDM(dmChannelId: string): Promise<void>;
    getDMMessages(dmChannelId: string, options?: { before?: string; limit?: number; around?: string }): Promise<{ messages: Message[]; hasMore: boolean; hasMoreNewer?: boolean; blockStatus?: { blockedByMe?: boolean; blockedByThem?: boolean; blockedParticipantIds?: string[] }; pinnedMessageIds?: string[]; encrypted?: boolean }>;
    getDMPins(dmChannelId: string): Promise<Array<Message & { pinnedAt: string; pinnedById: string }>>;
    pinDMMessage(dmChannelId: string, messageId: string): Promise<Message>;
    unpinDMMessage(dmChannelId: string, messageId: string): Promise<void>;
    pinDMConversation(dmChannelId: string): Promise<void>;
    unpinDMConversation(dmChannelId: string): Promise<void>;
    deleteDMMessage(dmChannelId: string, messageId: string): Promise<void>;
    editDMMessage(dmChannelId: string, messageId: string, content: string, encrypted?: boolean): Promise<{ id: string; content: string; editedAt: string | null }>;
    sendDMMessage(dmChannelId: string, content: string, replyToMessageId?: string, attachment?: { url: string; name: string; contentType?: string; width?: number | null; height?: number | null; isSpoiler?: boolean; alt?: string | null }, forwarded?: boolean, encrypted?: boolean): Promise<Message>;
    blockUser(userId: string): Promise<void>;
    unblockUser(userId: string): Promise<void>;
    getBlocked(): Promise<User[]>;
    reactDMMessage(dmChannelId: string, messageId: string, emoji: string): Promise<{ reactions: Array<{ emoji: string; userIds: string[] }> }>;
    addGroupDmMembers(dmChannelId: string, memberIds: string[]): Promise<{ id: string; members: Array<{ id: string; username: string; discriminator?: string; avatar?: string | null; status?: string }> }>;
    kickGroupDmMember(dmChannelId: string, userId: string): Promise<{ id: string; members: Array<{ id: string; username: string; discriminator?: string; avatar?: string | null; status?: string }> }>;
    getDmCallStatus(dmChannelId: string): Promise<{ active: boolean; participants: Array<{ userId: string; username: string; avatar: string | null; banner?: string | null; bannerPositionY?: number; bannerZoom?: number; nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null; avatarEffect?: string | null; effectivePlan?: string | null }> }>;
    searchDmMessages(params: {
      q: string;
      dmChannelId?: string;
      authorId?: string;
      has?: 'file' | 'image' | 'attachment';
      before?: string;
      after?: string;
      mentions?: string;
      pinned?: boolean;
      offset?: number;
      limit?: number;
    }): Promise<{ results: Array<{ id: string; dmChannelId: string; authorId: string; authorUsername: string | null; authorAvatar: string | null; content: string; createdAt: string; attachmentUrl: string | null; attachmentName: string | null }>; total: number; hasMore: boolean; encrypted?: boolean }>;
  }
}

APIClient.prototype.getUsers = async function(this: APIClient): Promise<Array<{ id: string; username: string; discriminator?: string; avatar?: string }>> {
  return this.request<Array<{ id: string; username: string; discriminator?: string; avatar?: string }>>('/users');
};

APIClient.prototype.getDMs = async function(this: APIClient) {
  const data = await this.request<any[]>('/dms');
  return data.map((dm: any) => ({
    ...dm,
    otherUser: dm.otherUser ? {
      ...dm.otherUser,
      avatar: this.resolveAssetUrl(dm.otherUser.avatar) ?? dm.otherUser.avatar,
      banner: this.resolveAssetUrl(dm.otherUser.banner) ?? dm.otherUser.banner,
      bannerPositionY: dm.otherUser.bannerPositionY ?? 50,
      bannerZoom: dm.otherUser.bannerZoom ?? 100,
    } : dm.otherUser,
    otherUsers: dm.otherUsers?.map((u: any) => ({
      ...u,
      avatar: this.resolveAssetUrl(u.avatar) ?? u.avatar,
      banner: this.resolveAssetUrl(u.banner) ?? u.banner,
      bannerPositionY: u.bannerPositionY ?? 50,
      bannerZoom: u.bannerZoom ?? 100,
    })),
  }));
};

APIClient.prototype.markDmAsRead = async function(this: APIClient, dmChannelId: string, before?: string): Promise<void> {
  await this.request<undefined>(`/dms/${dmChannelId}/read`, {
    method: 'POST',
    ...(before ? { body: JSON.stringify({ before }) } : {}),
  });
};

APIClient.prototype.getOrCreateDM = async function(this: APIClient, otherUserId: string) {
  const data = await this.request<any>('/dms', {
    method: 'POST',
    body: JSON.stringify({ otherUserId }),
  });
  if (data.otherUser?.avatar) data.otherUser.avatar = this.resolveAssetUrl(data.otherUser.avatar) ?? data.otherUser.avatar;
  if (data.otherUser?.banner) data.otherUser.banner = this.resolveAssetUrl(data.otherUser.banner) ?? data.otherUser.banner;
  if (data.otherUser) {
    data.otherUser.bannerPositionY = data.otherUser.bannerPositionY ?? 50;
    data.otherUser.bannerZoom = data.otherUser.bannerZoom ?? 100;
  }
  return data;
};

APIClient.prototype.createGroupDM = async function(this: APIClient, memberIds: string[]) {
  const data = await this.request<any>('/dms/group', {
    method: 'POST',
    body: JSON.stringify({ memberIds }),
  });
  if (data.otherUsers) data.otherUsers = data.otherUsers.map((u: any) => ({ ...u, avatar: this.resolveAssetUrl(u.avatar) ?? u.avatar, banner: this.resolveAssetUrl(u.banner) ?? u.banner, bannerPositionY: u.bannerPositionY ?? 50, bannerZoom: u.bannerZoom ?? 100 }));
  return data;
};

APIClient.prototype.updateGroupDM = async function(this: APIClient, dmChannelId: string, data: { name?: string; icon?: string }) {
  return this.request<{ id: string; name?: string; icon?: string }>(`/dms/${dmChannelId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.leaveGroupDM = async function(this: APIClient, dmChannelId: string): Promise<void> {
  await this.request<undefined>(`/dms/${dmChannelId}/leave`, { method: 'POST' });
};

APIClient.prototype.kickGroupDmMember = async function(this: APIClient, dmChannelId: string, userId: string) {
  return this.request<{ id: string; members: Array<{ id: string; username: string; discriminator?: string; avatar?: string | null; status?: string }> }>(`/dms/${dmChannelId}/members/${userId}`, { method: 'DELETE' });
};

APIClient.prototype.getDMMessages = async function(this: APIClient, dmChannelId: string, options?: { before?: string; limit?: number; around?: string }): Promise<{ messages: Message[]; hasMore: boolean; hasMoreNewer?: boolean; blockStatus?: { blockedByMe?: boolean; blockedByThem?: boolean; blockedParticipantIds?: string[] }; pinnedMessageIds?: string[]; encrypted?: boolean }> {
  const params = new URLSearchParams();
  if (options?.before) params.set('before', options.before);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.around) params.set('around', options.around);
  const qs = params.toString();
  const url = `/dms/${dmChannelId}/messages${qs ? `?${qs}` : ''}`;
  const data = await this.request<{ messages: BackendDMMessage[]; hasMore?: boolean; hasMoreNewer?: boolean; blockStatus?: { blockedByMe?: boolean; blockedByThem?: boolean; blockedParticipantIds?: string[] }; pinnedMessageIds?: string[]; encrypted?: boolean }>(url);
  const messages = (data.messages ?? []).map((m) => this.normalizeDmMessage(m));
  return { messages, hasMore: data.hasMore ?? false, hasMoreNewer: data.hasMoreNewer, blockStatus: data.blockStatus, pinnedMessageIds: data.pinnedMessageIds ?? [], encrypted: data.encrypted };
};

APIClient.prototype.getDMPins = async function(this: APIClient, dmChannelId: string): Promise<Array<Message & { pinnedAt: string; pinnedById: string }>> {
  const data = await this.request<{ pins: Array<BackendDMMessage & { pinnedAt: string; pinnedById: string }> }>(`/dms/${dmChannelId}/pins`);
  return (data.pins ?? []).map((m) => ({
    ...this.normalizeDmMessage(m),
    pinnedAt: m.pinnedAt,
    pinnedById: m.pinnedById,
  }));
};

APIClient.prototype.pinDMMessage = async function(this: APIClient, dmChannelId: string, messageId: string): Promise<Message> {
  const data = await this.request<BackendDMMessage>(`/dms/${dmChannelId}/messages/${messageId}/pin`, { method: 'POST' });
  return this.normalizeDmMessage(data);
};

APIClient.prototype.unpinDMMessage = async function(this: APIClient, dmChannelId: string, messageId: string): Promise<void> {
  await this.request<undefined>(`/dms/${dmChannelId}/messages/${messageId}/pin`, { method: 'DELETE' });
};

APIClient.prototype.pinDMConversation = async function(this: APIClient, dmChannelId: string): Promise<void> {
  await this.request<{ pinned: boolean }>(`/dms/${dmChannelId}/pin`, { method: 'POST' });
};

APIClient.prototype.unpinDMConversation = async function(this: APIClient, dmChannelId: string): Promise<void> {
  await this.request<{ pinned: boolean }>(`/dms/${dmChannelId}/pin`, { method: 'DELETE' });
};

APIClient.prototype.deleteDMMessage = async function(this: APIClient, dmChannelId: string, messageId: string): Promise<void> {
  await this.request<undefined>(`/dms/${dmChannelId}/messages/${messageId}`, { method: 'DELETE' });
};

APIClient.prototype.editDMMessage = async function(this: APIClient, dmChannelId: string, messageId: string, content: string, encrypted?: boolean): Promise<{ id: string; content: string; editedAt: string | null }> {
  const body: { content: string; encrypted?: boolean } = { content };
  if (encrypted !== undefined) body.encrypted = encrypted;
  return this.request(`/dms/${dmChannelId}/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify(body) });
};

APIClient.prototype.sendDMMessage = async function(this: APIClient, dmChannelId: string, content: string, replyToMessageId?: string, attachment?: { url: string; name: string; contentType?: string; width?: number | null; height?: number | null; isSpoiler?: boolean; alt?: string | null }, forwarded?: boolean, encrypted?: boolean): Promise<Message> {
  const body: { content: string; replyToMessageId?: string; attachmentUrl?: string; attachmentName?: string; attachmentContentType?: string; attachmentWidth?: number; attachmentHeight?: number; attachmentIsSpoiler?: boolean; attachmentAlt?: string; forwarded?: boolean; encrypted?: boolean } = {
    content,
    replyToMessageId: replyToMessageId || undefined,
  };
  if (attachment) {
    body.attachmentUrl = attachment.url;
    body.attachmentName = attachment.name;
    body.attachmentContentType = attachment.contentType;
    if (attachment.width) body.attachmentWidth = attachment.width;
    if (attachment.height) body.attachmentHeight = attachment.height;
    if (attachment.isSpoiler) {
      body.attachmentIsSpoiler = true;
    }
    if (attachment.alt && attachment.alt.trim().length > 0) {
      body.attachmentAlt = attachment.alt.trim();
    }
  }
  if (forwarded) body.forwarded = true;
  if (encrypted) body.encrypted = true;
  const data = await this.request<BackendDMMessage>(`/dms/${dmChannelId}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return this.normalizeDmMessage(data);
};

APIClient.prototype.blockUser = async function(this: APIClient, userId: string): Promise<void> {
  await this.request('/friends/block', { method: 'POST', body: JSON.stringify({ userId }) });
};

APIClient.prototype.unblockUser = async function(this: APIClient, userId: string): Promise<void> {
  await this.request(`/friends/block/${userId}`, { method: 'DELETE' });
};

APIClient.prototype.getBlocked = async function(this: APIClient): Promise<User[]> {
  const data = await this.request<BackendUser[]>('/friends/blocked');
  return data.map((u) => this.normalizeUser(u));
};

APIClient.prototype.reactDMMessage = async function(this: APIClient, dmChannelId: string, messageId: string, emoji: string): Promise<{ reactions: Array<{ emoji: string; userIds: string[] }> }> {
  return this.request(`/dms/${dmChannelId}/messages/${messageId}/reactions`, { method: 'PUT', body: JSON.stringify({ emoji }) });
};

APIClient.prototype.addGroupDmMembers = async function(this: APIClient, dmChannelId: string, memberIds: string[]): Promise<{ id: string; members: Array<{ id: string; username: string; discriminator?: string; avatar?: string | null; status?: string }> }> {
  return this.request(`/dms/${dmChannelId}/members`, { method: 'POST', body: JSON.stringify({ memberIds }) });
};

APIClient.prototype.getDmCallStatus = async function(this: APIClient, dmChannelId: string): Promise<{ active: boolean; participants: Array<{ userId: string; username: string; avatar: string | null; banner?: string | null; bannerPositionY?: number; bannerZoom?: number; nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null; avatarEffect?: string | null; effectivePlan?: string | null }> }> {
  return this.request(`/dms/${dmChannelId}/call-status`);
};

APIClient.prototype.searchDmMessages = async function(this: APIClient, params: {
  q: string;
  dmChannelId?: string;
  authorId?: string;
  has?: 'file' | 'image' | 'attachment';
  before?: string;
  after?: string;
  mentions?: string;
  pinned?: boolean;
  offset?: number;
  limit?: number;
}): Promise<{ results: Array<{ id: string; dmChannelId: string; authorId: string; authorUsername: string | null; authorAvatar: string | null; content: string; createdAt: string; attachmentUrl: string | null; attachmentName: string | null }>; total: number; hasMore: boolean; encrypted?: boolean }> {
  const qs = new URLSearchParams();
  qs.set('q', params.q);
  if (params.dmChannelId) qs.set('dmChannelId', params.dmChannelId);
  if (params.authorId) qs.set('authorId', params.authorId);
  if (params.has) qs.set('has', params.has);
  if (params.before) qs.set('before', params.before);
  if (params.after) qs.set('after', params.after);
  if (params.mentions) qs.set('mentions', params.mentions);
  if (params.pinned !== undefined) qs.set('pinned', String(params.pinned));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  return this.request(`/search/dm-messages?${qs}`);
};
