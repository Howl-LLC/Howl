// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { ForumPost, ForumMessage, ForumTag } from '../../types';

declare module './core' {
  interface APIClient {
    getForumPosts(serverId: string, channelId: string, options?: { limit?: number; before?: string; tag?: string; sort?: 'latest' | 'oldest' | 'active' }): Promise<{ posts: ForumPost[]; hasMore: boolean }>;
    getForumPost(serverId: string, channelId: string, postId: string): Promise<ForumPost>;
    createForumPost(serverId: string, channelId: string, data: { title: string; content: string; tagIds?: string[]; imageUrl?: string }): Promise<ForumPost>;
    updateForumPost(serverId: string, channelId: string, postId: string, data: { title?: string; content?: string; tagIds?: string[]; pinned?: boolean; locked?: boolean }): Promise<ForumPost>;
    deleteForumPost(serverId: string, channelId: string, postId: string): Promise<void>;
    getForumMessages(serverId: string, channelId: string, postId: string, options?: { limit?: number; before?: string }): Promise<{ messages: ForumMessage[]; hasMore: boolean }>;
    createForumMessage(serverId: string, channelId: string, postId: string, data: { content: string; attachmentUrl?: string; attachmentName?: string; attachmentContentType?: string; attachmentWidth?: number; attachmentHeight?: number }): Promise<ForumMessage>;
    editForumMessage(serverId: string, channelId: string, postId: string, messageId: string, content: string): Promise<ForumMessage>;
    deleteForumMessage(serverId: string, channelId: string, postId: string, messageId: string): Promise<void>;
    addForumReaction(serverId: string, channelId: string, postId: string, messageId: string, emoji: string): Promise<{ success: boolean; reactions: Array<{ emoji: string; userIds: string[] }> }>;
    removeForumReaction(serverId: string, channelId: string, postId: string, messageId: string, emoji: string): Promise<void>;
    getForumTags(serverId: string, channelId: string): Promise<ForumTag[]>;
    createForumTag(serverId: string, channelId: string, data: { name: string; color: string; emoji?: string }): Promise<ForumTag>;
    updateForumTag(serverId: string, channelId: string, tagId: string, data: { name?: string; color?: string; emoji?: string | null }): Promise<ForumTag>;
    deleteForumTag(serverId: string, channelId: string, tagId: string): Promise<void>;
    reorderForumTags(serverId: string, channelId: string, tags: Array<{ id: string; position: number }>): Promise<ForumTag[]>;
  }
}

// Forum posts

APIClient.prototype.getForumPosts = async function(this: APIClient, serverId: string, channelId: string, options?: { limit?: number; before?: string; tag?: string; sort?: 'latest' | 'oldest' | 'active' }): Promise<{ posts: ForumPost[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.before) params.set('before', options.before);
  if (options?.tag) params.set('tagId', options.tag);
  if (options?.sort) {
    const sortMap: Record<string, string> = { active: 'recent_activity', latest: 'creation_date', oldest: 'creation_date' };
    params.set('sortBy', sortMap[options.sort] || 'recent_activity');
  }
  const qs = params.toString();
  return this.request<{ posts: ForumPost[]; hasMore: boolean }>(`/servers/${serverId}/channels/${channelId}/posts${qs ? `?${qs}` : ''}`);
};

APIClient.prototype.getForumPost = async function(this: APIClient, serverId: string, channelId: string, postId: string): Promise<ForumPost> {
  const data = await this.request<{ post: ForumPost }>(`/servers/${serverId}/channels/${channelId}/posts/${postId}`);
  return data.post;
};

APIClient.prototype.createForumPost = async function(this: APIClient, serverId: string, channelId: string, data: { title: string; content: string; tagIds?: string[]; imageUrl?: string }): Promise<ForumPost> {
  return this.request<ForumPost>(`/servers/${serverId}/channels/${channelId}/posts`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.updateForumPost = async function(this: APIClient, serverId: string, channelId: string, postId: string, data: { title?: string; content?: string; tagIds?: string[]; pinned?: boolean; locked?: boolean }): Promise<ForumPost> {
  return this.request<ForumPost>(`/servers/${serverId}/channels/${channelId}/posts/${postId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.deleteForumPost = async function(this: APIClient, serverId: string, channelId: string, postId: string): Promise<void> {
  await this.request<undefined>(`/servers/${serverId}/channels/${channelId}/posts/${postId}`, { method: 'DELETE' });
};

// Forum messages

APIClient.prototype.getForumMessages = async function(this: APIClient, serverId: string, channelId: string, postId: string, options?: { limit?: number; before?: string }): Promise<{ messages: ForumMessage[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.before) params.set('before', options.before);
  const qs = params.toString();
  return this.request<{ messages: ForumMessage[]; hasMore: boolean }>(`/servers/${serverId}/channels/${channelId}/posts/${postId}/messages${qs ? `?${qs}` : ''}`);
};

APIClient.prototype.createForumMessage = async function(this: APIClient, serverId: string, channelId: string, postId: string, data: { content: string; attachmentUrl?: string; attachmentName?: string; attachmentContentType?: string; attachmentWidth?: number; attachmentHeight?: number }): Promise<ForumMessage> {
  return this.request<ForumMessage>(`/servers/${serverId}/channels/${channelId}/posts/${postId}/messages`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.editForumMessage = async function(this: APIClient, serverId: string, channelId: string, postId: string, messageId: string, content: string): Promise<ForumMessage> {
  return this.request<ForumMessage>(`/servers/${serverId}/channels/${channelId}/posts/${postId}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  });
};

APIClient.prototype.deleteForumMessage = async function(this: APIClient, serverId: string, channelId: string, postId: string, messageId: string): Promise<void> {
  await this.request<undefined>(`/servers/${serverId}/channels/${channelId}/posts/${postId}/messages/${messageId}`, { method: 'DELETE' });
};

// Forum reactions

APIClient.prototype.addForumReaction = async function(this: APIClient, serverId: string, channelId: string, postId: string, messageId: string, emoji: string): Promise<{ success: boolean; reactions: Array<{ emoji: string; userIds: string[] }> }> {
  return this.request(`/servers/${serverId}/channels/${channelId}/posts/${postId}/messages/${messageId}/reactions`, {
    method: 'POST',
    body: JSON.stringify({ emoji }),
  });
};

APIClient.prototype.removeForumReaction = async function(this: APIClient, serverId: string, channelId: string, postId: string, messageId: string, emoji: string): Promise<void> {
  await this.request<undefined>(`/servers/${serverId}/channels/${channelId}/posts/${postId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, { method: 'DELETE' });
};

// Forum tags

APIClient.prototype.getForumTags = async function(this: APIClient, serverId: string, channelId: string): Promise<ForumTag[]> {
  return this.request<ForumTag[]>(`/servers/${serverId}/channels/${channelId}/tags`);
};

APIClient.prototype.createForumTag = async function(this: APIClient, serverId: string, channelId: string, data: { name: string; color: string; emoji?: string }): Promise<ForumTag> {
  return this.request<ForumTag>(`/servers/${serverId}/channels/${channelId}/tags`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.updateForumTag = async function(this: APIClient, serverId: string, channelId: string, tagId: string, data: { name?: string; color?: string; emoji?: string | null }): Promise<ForumTag> {
  return this.request<ForumTag>(`/servers/${serverId}/channels/${channelId}/tags/${tagId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.deleteForumTag = async function(this: APIClient, serverId: string, channelId: string, tagId: string): Promise<void> {
  await this.request<undefined>(`/servers/${serverId}/channels/${channelId}/tags/${tagId}`, { method: 'DELETE' });
};

APIClient.prototype.reorderForumTags = async function(this: APIClient, serverId: string, channelId: string, tags: Array<{ id: string; position: number }>): Promise<ForumTag[]> {
  return this.request<ForumTag[]>(`/servers/${serverId}/channels/${channelId}/tags/reorder`, {
    method: 'PUT',
    body: JSON.stringify({ tags }),
  });
};
