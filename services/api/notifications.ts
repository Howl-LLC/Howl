// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';

declare module './core' {
  interface APIClient {
    getNotificationCounts(): Promise<{ total: number; byServer: Record<string, { mentionCount: number; unreadCount: number }> }>;
    getNotifications(params?: { serverId?: string; unreadOnly?: boolean; limit?: number; before?: string }): Promise<{ notifications: unknown[]; hasMore: boolean }>;
    markNotificationRead(notificationId: string): Promise<void>;
    markAllNotificationsRead(serverId?: string): Promise<void>;
    deleteNotification(notificationId: string): Promise<void>;
    markChannelRead(channelId: string, before?: string): Promise<void>;
    markThreadRead(serverId: string, threadId: string): Promise<void>;
    deleteAllNotifications(serverId?: string): Promise<{ deleted: number }>;
  }
}

APIClient.prototype.getNotificationCounts = async function(this: APIClient) {
  return this.request('/notifications/counts');
};

APIClient.prototype.getNotifications = async function(this: APIClient, params) {
  const query = new URLSearchParams();
  if (params?.serverId) query.set('serverId', params.serverId);
  if (params?.unreadOnly !== undefined) query.set('unreadOnly', String(params.unreadOnly));
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.before) query.set('before', params.before);
  const qs = query.toString();
  return this.request(`/notifications${qs ? `?${qs}` : ''}`);
};

APIClient.prototype.markNotificationRead = async function(this: APIClient, notificationId) {
  await this.request(`/notifications/${notificationId}/read`, { method: 'POST' });
};

APIClient.prototype.markAllNotificationsRead = async function(this: APIClient, serverId) {
  await this.request('/notifications/read-all', {
    method: 'POST',
    body: JSON.stringify(serverId ? { serverId } : {}),
  });
};

APIClient.prototype.deleteNotification = async function(this: APIClient, notificationId) {
  await this.request(`/notifications/${notificationId}`, { method: 'DELETE' });
};

APIClient.prototype.markChannelRead = async function(this: APIClient, channelId, before?) {
  await this.request(`/messages/channels/${channelId}/read`, {
    method: 'POST',
    ...(before ? { body: JSON.stringify({ before }) } : {}),
  });
};

APIClient.prototype.markThreadRead = async function(this: APIClient, serverId, threadId) {
  await this.request(`/servers/${serverId}/threads/${threadId}/read`, { method: 'POST' });
};

APIClient.prototype.deleteAllNotifications = async function(this: APIClient, serverId) {
  return this.request('/notifications/delete-all', {
    method: 'DELETE',
    body: JSON.stringify(serverId ? { serverId } : {}),
  });
};
