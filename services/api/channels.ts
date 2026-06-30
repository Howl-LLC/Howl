// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { Message } from '../../types';
import type { BackendMessage } from '../apiTypes';

/** Per-attachment shape sent up by the composer. */
export interface ComposerAttachment {
  url: string;
  name: string;
  contentType?: string;
  width?: number | null;
  height?: number | null;
  isSpoiler?: boolean;
  alt?: string | null;
}

declare module './core' {
  interface APIClient {
    getChannelMessages(channelId: string, options?: { limit?: number; before?: string; around?: string }): Promise<{ messages: Message[]; hasMore: boolean; hasMoreNewer?: boolean; pinnedMessageIds?: string[]; lastReadAt?: string | null }>;
    sendChannelMessage(channelId: string, content: string, replyToMessageId?: string, attachment?: ComposerAttachment, forwarded?: boolean): Promise<Message>;
    getChannelPins(channelId: string): Promise<Array<Message & { pinnedAt: string; pinnedById: string }>>;
    pinChannelMessage(channelId: string, messageId: string): Promise<void>;
    reactChannelMessage(channelId: string, messageId: string, emoji: string): Promise<{ reactions: Array<{ emoji: string; userIds: string[] }> }>;
    unpinChannelMessage(channelId: string, messageId: string): Promise<void>;
    deleteChannelMessage(channelId: string, messageId: string): Promise<void>;
    editChannelMessage(channelId: string, messageId: string, content: string): Promise<{ id: string; content: string; editedAt: string | null }>;
    /** Records that the caller has accepted the 18+ gate for this channel.
     *  Server appends channelId to ServerMember.acceptedAgeRestrictedChannelIds
     *  for the caller's membership row. Returns the updated array. */
    acceptChannelAgeGate(channelId: string): Promise<{ acceptedAgeRestrictedChannelIds: string[] }>;
    searchMessages(params: {
      q: string;
      serverId?: string;
      channelId?: string;
      authorId?: string;
      has?: 'file' | 'image' | 'attachment';
      before?: string;
      after?: string;
      mentions?: string;
      pinned?: boolean;
      offset?: number;
      limit?: number;
    }): Promise<{ results: Array<{ id: string; channelId: string; channelName: string | null; serverId: string | null; authorId: string; authorUsername: string | null; authorAvatar: string | null; content: string; createdAt: string; attachmentUrl: string | null; attachmentName: string | null }>; total: number; hasMore: boolean }>;
  }
}

APIClient.prototype.getChannelMessages = async function(this: APIClient, channelId: string, options?: { limit?: number; before?: string; around?: string }): Promise<{ messages: Message[]; hasMore: boolean; hasMoreNewer?: boolean; pinnedMessageIds?: string[]; lastReadAt?: string | null }> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.before) params.set('before', options.before);
  if (options?.around) params.set('around', options.around);
  const qs = params.toString();
  const data = await this.request<{ messages: BackendMessage[]; hasMore: boolean; hasMoreNewer?: boolean; pinnedMessageIds?: string[]; lastReadAt?: string | null }>(`/messages/channels/${channelId}${qs ? `?${qs}` : ''}`);
  return { messages: data.messages.map((m) => this.normalizeMessage(m)), hasMore: data.hasMore, hasMoreNewer: data.hasMoreNewer, pinnedMessageIds: data.pinnedMessageIds, lastReadAt: data.lastReadAt };
};

APIClient.prototype.sendChannelMessage = async function(this: APIClient, channelId: string, content: string, replyToMessageId?: string, attachment?: ComposerAttachment, forwarded?: boolean): Promise<Message> {
  const body: { content: string; replyToMessageId?: string; attachmentUrl?: string; attachmentName?: string; attachmentContentType?: string; attachmentWidth?: number; attachmentHeight?: number; attachmentIsSpoiler?: boolean; attachmentAlt?: string; forwarded?: boolean } = {
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
  const data = await this.request<BackendMessage>(`/messages/channels/${channelId}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return this.normalizeMessage(data);
};

APIClient.prototype.acceptChannelAgeGate = async function(this: APIClient, channelId: string): Promise<{ acceptedAgeRestrictedChannelIds: string[] }> {
  return this.request<{ acceptedAgeRestrictedChannelIds: string[] }>(`/channels/${channelId}/age-gate/accept`, { method: 'POST' });
};

APIClient.prototype.getChannelPins = async function(this: APIClient, channelId: string): Promise<Array<Message & { pinnedAt: string; pinnedById: string }>> {
  const data = await this.request<{ pins: Array<BackendMessage & { pinnedAt: string; pinnedById: string }> }>(`/messages/channels/${channelId}/pins`);
  const list = data.pins ?? [];
  return list.map((m) => ({
    ...this.normalizeMessage(m),
    pinnedAt: m.pinnedAt,
    pinnedById: m.pinnedById,
  }));
};

APIClient.prototype.pinChannelMessage = async function(this: APIClient, channelId: string, messageId: string): Promise<void> {
  await this.request<undefined>(`/messages/channels/${channelId}/messages/${messageId}/pin`, { method: 'POST' });
};

APIClient.prototype.unpinChannelMessage = async function(this: APIClient, channelId: string, messageId: string): Promise<void> {
  await this.request<undefined>(`/messages/channels/${channelId}/messages/${messageId}/pin`, { method: 'DELETE' });
};

APIClient.prototype.deleteChannelMessage = async function(this: APIClient, channelId: string, messageId: string): Promise<void> {
  await this.request<undefined>(`/messages/channels/${channelId}/messages/${messageId}`, { method: 'DELETE' });
};

APIClient.prototype.editChannelMessage = async function(this: APIClient, channelId: string, messageId: string, content: string): Promise<{ id: string; content: string; editedAt: string | null }> {
  return this.request(`/messages/channels/${channelId}/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify({ content }) });
};

APIClient.prototype.searchMessages = async function(this: APIClient, params: {
  q: string;
  serverId?: string;
  channelId?: string;
  authorId?: string;
  has?: 'file' | 'image' | 'attachment';
  before?: string;
  after?: string;
  mentions?: string;
  pinned?: boolean;
  offset?: number;
  limit?: number;
}): Promise<{ results: Array<{ id: string; channelId: string; channelName: string | null; serverId: string | null; authorId: string; authorUsername: string | null; authorAvatar: string | null; content: string; createdAt: string; attachmentUrl: string | null; attachmentName: string | null }>; total: number; hasMore: boolean }> {
  const qs = new URLSearchParams();
  qs.set('q', params.q);
  if (params.serverId) qs.set('serverId', params.serverId);
  if (params.channelId) qs.set('channelId', params.channelId);
  if (params.authorId) qs.set('authorId', params.authorId);
  if (params.has) qs.set('has', params.has);
  if (params.before) qs.set('before', params.before);
  if (params.after) qs.set('after', params.after);
  if (params.mentions) qs.set('mentions', params.mentions);
  if (params.pinned !== undefined) qs.set('pinned', String(params.pinned));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  return this.request(`/search/messages?${qs.toString()}`);
};

APIClient.prototype.reactChannelMessage = async function(this: APIClient, channelId: string, messageId: string, emoji: string): Promise<{ reactions: Array<{ emoji: string; userIds: string[] }> }> {
  return this.request(`/messages/channels/${channelId}/messages/${messageId}/reactions`, { method: 'PUT', body: JSON.stringify({ emoji }) });
};
