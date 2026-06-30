// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { Thread, ThreadMessage } from '../../types';

interface CreateThreadData {
  name: string;
  parentMessageId: string;
  autoArchive?: boolean;
  autoArchiveDuration?: string;
}

interface EditThreadData {
  name?: string;
  archived?: boolean;
  autoArchive?: boolean;
  autoArchiveDuration?: string;
}

declare module './core' {
  interface APIClient {
    createThread(channelId: string, serverId: string, data: CreateThreadData): Promise<Thread>;
    getServerThreads(serverId: string): Promise<Thread[]>;
    getThreads(channelId: string, serverId: string, archived?: boolean): Promise<Thread[]>;
    getThread(channelId: string, serverId: string, threadId: string): Promise<Thread>;
    editThread(channelId: string, serverId: string, threadId: string, data: EditThreadData): Promise<Thread>;
    deleteThread(channelId: string, serverId: string, threadId: string): Promise<void>;
    getThreadMessages(serverId: string, threadId: string, opts?: { limit?: number; before?: string; after?: string }): Promise<ThreadMessage[]>;
    sendThreadMessage(serverId: string, threadId: string, content: string, replyToMessageId?: string, attachment?: { url: string; name: string; contentType?: string; width?: number | null; height?: number | null }): Promise<ThreadMessage>;
    editThreadMessage(serverId: string, threadId: string, messageId: string, content: string): Promise<ThreadMessage>;
    deleteThreadMessage(serverId: string, threadId: string, messageId: string): Promise<void>;
    reactThreadMessage(serverId: string, threadId: string, messageId: string, emoji: string): Promise<void>;
    removeThreadReaction(serverId: string, threadId: string, messageId: string, emoji: string): Promise<void>;
  }
}

APIClient.prototype.createThread = async function(this: APIClient, channelId: string, serverId: string, data: CreateThreadData): Promise<Thread> {
  return this.request<Thread>(`/servers/${serverId}/channels/${channelId}/threads`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.getServerThreads = async function(this: APIClient, serverId: string): Promise<Thread[]> {
  return this.request<Thread[]>(`/servers/${serverId}/threads`);
};

APIClient.prototype.getThreads = async function(this: APIClient, channelId: string, serverId: string, archived = false): Promise<Thread[]> {
  return this.request<Thread[]>(`/servers/${serverId}/channels/${channelId}/threads?archived=${archived}`);
};

APIClient.prototype.getThread = async function(this: APIClient, channelId: string, serverId: string, threadId: string): Promise<Thread> {
  return this.request<Thread>(`/servers/${serverId}/channels/${channelId}/threads/${threadId}`);
};

APIClient.prototype.editThread = async function(this: APIClient, channelId: string, serverId: string, threadId: string, data: EditThreadData): Promise<Thread> {
  return this.request<Thread>(`/servers/${serverId}/channels/${channelId}/threads/${threadId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.deleteThread = async function(this: APIClient, channelId: string, serverId: string, threadId: string): Promise<void> {
  await this.request<void>(`/servers/${serverId}/channels/${channelId}/threads/${threadId}`, {
    method: 'DELETE',
  });
};

APIClient.prototype.getThreadMessages = async function(this: APIClient, serverId: string, threadId: string, opts?: { limit?: number; before?: string; after?: string }): Promise<ThreadMessage[]> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.before) params.set('before', opts.before);
  if (opts?.after) params.set('after', opts.after);
  const qs = params.toString();
  return this.request<ThreadMessage[]>(`/servers/${serverId}/threads/${threadId}/messages${qs ? `?${qs}` : ''}`);
};

APIClient.prototype.sendThreadMessage = async function(this: APIClient, serverId: string, threadId: string, content: string, replyToMessageId?: string, attachment?: { url: string; name: string; contentType?: string; width?: number | null; height?: number | null }): Promise<ThreadMessage> {
  return this.request<ThreadMessage>(`/servers/${serverId}/threads/${threadId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, replyToMessageId, attachment }),
  });
};

APIClient.prototype.editThreadMessage = async function(this: APIClient, serverId: string, threadId: string, messageId: string, content: string): Promise<ThreadMessage> {
  return this.request<ThreadMessage>(`/servers/${serverId}/threads/${threadId}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  });
};

APIClient.prototype.deleteThreadMessage = async function(this: APIClient, serverId: string, threadId: string, messageId: string): Promise<void> {
  await this.request<void>(`/servers/${serverId}/threads/${threadId}/messages/${messageId}`, {
    method: 'DELETE',
  });
};

APIClient.prototype.reactThreadMessage = async function(this: APIClient, serverId: string, threadId: string, messageId: string, emoji: string): Promise<void> {
  await this.request<void>(`/servers/${serverId}/threads/${threadId}/messages/${messageId}/reactions`, {
    method: 'POST',
    body: JSON.stringify({ emoji }),
  });
};

APIClient.prototype.removeThreadReaction = async function(this: APIClient, serverId: string, threadId: string, messageId: string, emoji: string): Promise<void> {
  await this.request<void>(`/servers/${serverId}/threads/${threadId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
    method: 'DELETE',
  });
};
