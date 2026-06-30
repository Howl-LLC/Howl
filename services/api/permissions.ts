// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { PermissionOverride } from '../../types';

declare module './core' {
  interface APIClient {
    getChannelPermissions(serverId: string, channelId: string): Promise<PermissionOverride[]>;
    setChannelPermissionOverride(serverId: string, channelId: string, targetType: 'role' | 'member', targetId: string, permissions: Record<string, boolean | null>): Promise<PermissionOverride>;
    deleteChannelPermissionOverride(serverId: string, channelId: string, overrideId: string): Promise<void>;
    getCategoryPermissions(serverId: string, categoryId: string): Promise<PermissionOverride[]>;
    setCategoryPermissionOverride(serverId: string, categoryId: string, targetType: 'role' | 'member', targetId: string, permissions: Record<string, boolean | null>): Promise<PermissionOverride>;
    deleteCategoryPermissionOverride(serverId: string, categoryId: string, overrideId: string): Promise<void>;
  }
}

// Channel permissions

APIClient.prototype.getChannelPermissions = async function(this: APIClient, serverId: string, channelId: string): Promise<PermissionOverride[]> {
  const res = await this.request<{ overrides: PermissionOverride[]; categoryOverrides?: PermissionOverride[] }>(`/servers/${serverId}/channels/${channelId}/permissions`);
  return [...(res.overrides ?? []), ...(res.categoryOverrides ?? [])];
};

APIClient.prototype.setChannelPermissionOverride = async function(this: APIClient, serverId: string, channelId: string, targetType: 'role' | 'member', targetId: string, permissions: Record<string, boolean | null>): Promise<PermissionOverride> {
  return this.request<PermissionOverride>(`/servers/${serverId}/channels/${channelId}/permissions`, {
    method: 'PUT',
    body: JSON.stringify({ targetType, targetId, permissions }),
  });
};

APIClient.prototype.deleteChannelPermissionOverride = async function(this: APIClient, serverId: string, channelId: string, overrideId: string): Promise<void> {
  await this.request<undefined>(`/servers/${serverId}/channels/${channelId}/permissions/${overrideId}`, { method: 'DELETE' });
};

// Category permissions

APIClient.prototype.getCategoryPermissions = async function(this: APIClient, serverId: string, categoryId: string): Promise<PermissionOverride[]> {
  const res = await this.request<{ overrides: PermissionOverride[] }>(`/servers/${serverId}/categories/${categoryId}/permissions`);
  return res.overrides ?? [];
};

APIClient.prototype.setCategoryPermissionOverride = async function(this: APIClient, serverId: string, categoryId: string, targetType: 'role' | 'member', targetId: string, permissions: Record<string, boolean | null>): Promise<PermissionOverride> {
  return this.request<PermissionOverride>(`/servers/${serverId}/categories/${categoryId}/permissions`, {
    method: 'PUT',
    body: JSON.stringify({ targetType, targetId, permissions }),
  });
};

APIClient.prototype.deleteCategoryPermissionOverride = async function(this: APIClient, serverId: string, categoryId: string, overrideId: string): Promise<void> {
  await this.request<undefined>(`/servers/${serverId}/categories/${categoryId}/permissions/${overrideId}`, { method: 'DELETE' });
};
