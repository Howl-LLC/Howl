// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { CustomEmoji, ServerSticker, SoundboardSound, AutomodRule, ServerTemplate, AuditLogEntry } from '../../types';

declare module './core' {
  interface APIClient {
    getServerEmojis(serverId: string): Promise<CustomEmoji[]>;
    uploadServerEmoji(serverId: string, name: string, imageUrl: string): Promise<CustomEmoji>;
    deleteServerEmoji(serverId: string, emojiId: string): Promise<void>;
    getServerStickers(serverId: string): Promise<ServerSticker[]>;
    uploadServerSticker(serverId: string, name: string, imageUrl: string, description?: string): Promise<ServerSticker>;
    deleteServerSticker(serverId: string, stickerId: string): Promise<void>;
    getServerSounds(serverId: string): Promise<SoundboardSound[]>;
    uploadServerSound(serverId: string, name: string, audioUrl: string, emoji?: string, volume?: number): Promise<SoundboardSound>;
    deleteServerSound(serverId: string, soundId: string): Promise<void>;
    getAutomodRules(serverId: string): Promise<AutomodRule[]>;
    createAutomodRule(serverId: string, data: { name: string; type: string; enabled?: boolean; config?: Record<string, unknown> }): Promise<AutomodRule>;
    updateAutomodRule(serverId: string, ruleId: string, data: { name?: string; enabled?: boolean; config?: Record<string, unknown> }): Promise<AutomodRule>;
    deleteAutomodRule(serverId: string, ruleId: string): Promise<void>;
    getServerTemplates(serverId: string): Promise<ServerTemplate[]>;
    createServerTemplate(serverId: string, name: string, description?: string): Promise<ServerTemplate>;
    syncServerTemplate(serverId: string, templateId: string, data?: { name?: string; description?: string }): Promise<ServerTemplate>;
    deleteServerTemplate(serverId: string, templateId: string): Promise<void>;
    resolveTemplate(code: string): Promise<{
      name: string;
      description?: string | null;
      code: string;
      channelSnapshot?: unknown;
      roleSnapshot?: unknown;
      categorySnapshot?: unknown;
      settingsSnapshot?: unknown;
      usageCount: number;
      serverName: string;
      createdAt: string;
    }>;
    getAuditLog(serverId: string, page?: number, action?: string): Promise<{ entries: AuditLogEntry[]; total: number; page: number; pages: number }>;
  }
}

APIClient.prototype.getServerEmojis = async function(this: APIClient, serverId: string): Promise<CustomEmoji[]> {
  const cacheKey = `emojis:${serverId}`;
  const cached = this.getCached<CustomEmoji[]>(cacheKey);
  if (cached) return cached;
  const result = await this.request<CustomEmoji[]>(`/servers/${serverId}/emoji`);
  const resolved = result.map((e) => ({ ...e, imageUrl: this.resolveAssetUrl(e.imageUrl) ?? e.imageUrl }));
  this.setCache(cacheKey, resolved, 60_000);
  return resolved;
};

APIClient.prototype.uploadServerEmoji = async function(this: APIClient, serverId: string, name: string, imageUrl: string): Promise<CustomEmoji> {
  const result = await this.request<CustomEmoji>(`/servers/${serverId}/emoji`, { method: 'POST', body: JSON.stringify({ name, imageUrl }) });
  this.invalidateCache(`emojis:${serverId}`);
  return result;
};

APIClient.prototype.deleteServerEmoji = async function(this: APIClient, serverId: string, emojiId: string): Promise<void> {
  await this.request(`/servers/${serverId}/emoji/${emojiId}`, { method: 'DELETE' });
  this.invalidateCache(`emojis:${serverId}`);
};

APIClient.prototype.getServerStickers = async function(this: APIClient, serverId: string): Promise<ServerSticker[]> {
  const cacheKey = `stickers:${serverId}`;
  const cached = this.getCached<ServerSticker[]>(cacheKey);
  if (cached) return cached;
  const result = await this.request<ServerSticker[]>(`/servers/${serverId}/stickers`);
  const resolved = result.map((s) => ({ ...s, imageUrl: this.resolveAssetUrl(s.imageUrl) ?? s.imageUrl }));
  this.setCache(cacheKey, resolved, 60_000);
  return resolved;
};

APIClient.prototype.uploadServerSticker = async function(this: APIClient, serverId: string, name: string, imageUrl: string, description?: string): Promise<ServerSticker> {
  const result = await this.request<ServerSticker>(`/servers/${serverId}/stickers`, { method: 'POST', body: JSON.stringify({ name, imageUrl, description }) });
  this.invalidateCache(`stickers:${serverId}`);
  return result;
};

APIClient.prototype.deleteServerSticker = async function(this: APIClient, serverId: string, stickerId: string): Promise<void> {
  await this.request(`/servers/${serverId}/stickers/${stickerId}`, { method: 'DELETE' });
  this.invalidateCache(`stickers:${serverId}`);
};

APIClient.prototype.getServerSounds = async function(this: APIClient, serverId: string): Promise<SoundboardSound[]> {
  const result = await this.request<SoundboardSound[]>(`/servers/${serverId}/soundboard`);
  return result.map((s) => ({ ...s, audioUrl: this.resolveAssetUrl(s.audioUrl) ?? s.audioUrl }));
};

APIClient.prototype.uploadServerSound = async function(this: APIClient, serverId: string, name: string, audioUrl: string, emoji?: string, volume?: number): Promise<SoundboardSound> {
  return this.request(`/servers/${serverId}/soundboard`, { method: 'POST', body: JSON.stringify({ name, audioUrl, emoji, volume }) });
};

APIClient.prototype.deleteServerSound = async function(this: APIClient, serverId: string, soundId: string): Promise<void> {
  await this.request(`/servers/${serverId}/soundboard/${soundId}`, { method: 'DELETE' });
};

APIClient.prototype.getAutomodRules = async function(this: APIClient, serverId: string): Promise<AutomodRule[]> {
  return this.request(`/servers/${serverId}/automod`);
};

APIClient.prototype.createAutomodRule = async function(this: APIClient, serverId: string, data: { name: string; type: string; enabled?: boolean; config?: Record<string, unknown> }): Promise<AutomodRule> {
  return this.request(`/servers/${serverId}/automod`, { method: 'POST', body: JSON.stringify(data) });
};

APIClient.prototype.updateAutomodRule = async function(this: APIClient, serverId: string, ruleId: string, data: { name?: string; enabled?: boolean; config?: Record<string, unknown> }): Promise<AutomodRule> {
  return this.request(`/servers/${serverId}/automod/${ruleId}`, { method: 'PATCH', body: JSON.stringify(data) });
};

APIClient.prototype.deleteAutomodRule = async function(this: APIClient, serverId: string, ruleId: string): Promise<void> {
  await this.request(`/servers/${serverId}/automod/${ruleId}`, { method: 'DELETE' });
};

APIClient.prototype.getServerTemplates = async function(this: APIClient, serverId: string): Promise<ServerTemplate[]> {
  return this.request(`/servers/${serverId}/templates`);
};

APIClient.prototype.createServerTemplate = async function(this: APIClient, serverId: string, name: string, description?: string): Promise<ServerTemplate> {
  return this.request(`/servers/${serverId}/templates`, { method: 'POST', body: JSON.stringify({ name, description }) });
};

APIClient.prototype.syncServerTemplate = async function(this: APIClient, serverId: string, templateId: string, data?: { name?: string; description?: string }): Promise<ServerTemplate> {
  return this.request(`/servers/${serverId}/templates/${templateId}`, {
    method: 'PUT',
    body: JSON.stringify(data ?? {}),
  });
};

APIClient.prototype.deleteServerTemplate = async function(this: APIClient, serverId: string, templateId: string): Promise<void> {
  await this.request(`/servers/${serverId}/templates/${templateId}`, { method: 'DELETE' });
};

APIClient.prototype.resolveTemplate = async function(this: APIClient, code: string) {
  return this.request(`/servers/template-preview/${code}`);
};

APIClient.prototype.getAuditLog = async function(this: APIClient, serverId: string, page?: number, action?: string): Promise<{ entries: AuditLogEntry[]; total: number; page: number; pages: number }> {
  const params = new URLSearchParams();
  if (page) params.set('page', String(page));
  if (action) params.set('action', action);
  const qs = params.toString();
  return this.request(`/servers/${serverId}/audit-log${qs ? `?${qs}` : ''}`);
};
