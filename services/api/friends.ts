// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { User } from '../../types';
import type { BackendUser } from '../apiTypes';

declare module './core' {
  interface APIClient {
    sendFriendRequest(usernameDiscriminator: string): Promise<{ success: boolean; user: User }>;
    getFriends(): Promise<User[]>;
    getFriendRequests(): Promise<{
      incoming: Array<{ id: string; createdAt: string; user: User }>;
      outgoing: Array<{ id: string; createdAt: string; user: User }>;
    }>;
    acceptFriendRequest(requestId: string): Promise<{ success: boolean; user: User }>;
    declineFriendRequest(requestId: string): Promise<void>;
    cancelFriendRequest(requestId: string): Promise<void>;
    removeFriend(userId: string): Promise<void>;
  }
}

APIClient.prototype.sendFriendRequest = async function(this: APIClient, usernameDiscriminator: string): Promise<{ success: boolean; user: User }> {
  this.invalidateCache('friendRequests');
  const data = await this.request<{ success: boolean; user: BackendUser }>('/friends/request', {
    method: 'POST',
    body: JSON.stringify({ usernameDiscriminator: usernameDiscriminator.trim() }),
  });
  return { success: data.success, user: this.normalizeUser(data.user) };
};

APIClient.prototype.getFriends = async function(this: APIClient): Promise<User[]> {
  const cacheKey = 'friends';
  const cached = this.getCached<User[]>(cacheKey);
  if (cached) return cached;
  const data = await this.request<BackendUser[]>('/friends');
  const result = data.map((u) => this.normalizeUser(u));
  this.setCache(cacheKey, result, 60_000);
  return result;
};

APIClient.prototype.getFriendRequests = async function(this: APIClient): Promise<{
  incoming: Array<{ id: string; createdAt: string; user: User }>;
  outgoing: Array<{ id: string; createdAt: string; user: User }>;
}> {
  const cacheKey = 'friendRequests';
  const cached = this.getCached<{ incoming: Array<{ id: string; createdAt: string; user: User }>; outgoing: Array<{ id: string; createdAt: string; user: User }> }>(cacheKey);
  if (cached) return cached;
  const data = await this.request<{
    incoming: Array<{ id: string; createdAt: string; user: BackendUser }>;
    outgoing: Array<{ id: string; createdAt: string; user: BackendUser }>;
  }>('/friends/requests');
  const result = {
    incoming: data.incoming.map((r) => ({ id: r.id, createdAt: r.createdAt, user: this.normalizeUser(r.user) })),
    outgoing: data.outgoing.map((r) => ({ id: r.id, createdAt: r.createdAt, user: this.normalizeUser(r.user) })),
  };
  this.setCache(cacheKey, result, 10_000);
  return result;
};

APIClient.prototype.acceptFriendRequest = async function(this: APIClient, requestId: string): Promise<{ success: boolean; user: User }> {
  this.invalidateCache('friendRequests');
  this.invalidateCache('friends');
  const data = await this.request<{ success: boolean; user: BackendUser }>(`/friends/requests/${requestId}/accept`, { method: 'POST' });
  return { success: data.success, user: this.normalizeUser(data.user) };
};

APIClient.prototype.declineFriendRequest = async function(this: APIClient, requestId: string): Promise<void> {
  this.invalidateCache('friendRequests');
  await this.request(`/friends/requests/${requestId}/decline`, { method: 'POST' });
};

APIClient.prototype.cancelFriendRequest = async function(this: APIClient, requestId: string): Promise<void> {
  this.invalidateCache('friendRequests');
  await this.request(`/friends/requests/${requestId}`, { method: 'DELETE' });
};

APIClient.prototype.removeFriend = async function(this: APIClient, userId: string): Promise<void> {
  await this.request(`/friends/${userId}`, { method: 'DELETE' });
};
