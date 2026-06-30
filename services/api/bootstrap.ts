// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { User, Server, Channel, CustomEmoji } from '../../types';
import type { BackendUser } from '../apiTypes';
import type { ServerFolder } from './serverFolders';

/**
 * Cold-start aggregate payload returned by `GET /api/v1/bootstrap`. Collapses
 * what used to be 7 separate REST calls (auth/me + settings + servers + folders
 * + per-server emojis × N + notification-counts + blocked) into a single round
 * trip — connect-storm prep for public-launch flash traffic.
 */
export interface BootstrapPayload {
  user: User | null;
  settings: { data: Record<string, unknown> | null; updatedAt: string | null };
  servers: Server[];
  folders: ServerFolder[];
  emojis: Record<string, CustomEmoji[]>;
  notificationCounts: { total: number; byServer: Record<string, { mentionCount: number; unreadCount: number }> };
  blocked: User[];
  /**
   * Per-slice failures from the backend's Promise.allSettled — keys map to the
   * top-level field that failed. Callers should render what they have and
   * retry the failed slice on its own (e.g. `apiClient.getServers()`).
   */
  errors?: Partial<Record<'user' | 'settings' | 'servers' | 'folders' | 'emojis' | 'notificationCounts' | 'blocked', string>>;
}

declare module './core' {
  interface APIClient {
    getBootstrap(): Promise<BootstrapPayload>;
  }
}

APIClient.prototype.getBootstrap = async function(this: APIClient): Promise<BootstrapPayload> {
  // Mirror the per-route reshaping done in users/servers/notifications/etc so
  // store hydration code can use the same field shapes whether it received the
  // single bootstrap response or one of the legacy endpoints.
  const raw = await this.request<{
    user: BackendUser | null;
    settings: { data: Record<string, unknown> | null; updatedAt: string | null };
    servers: Array<{
      id: string; name: string; icon?: string; banner?: string; bannerPositionY?: number;
      powerUpCount?: number; description?: string | null; myRole?: string;
      myPermissions?: Record<string, boolean>;
      channels: Array<Record<string, unknown>>;
      categories?: Array<Record<string, unknown>>;
    }>;
    folders: ServerFolder[];
    emojis: Record<string, CustomEmoji[]>;
    notificationCounts: { total: number; byServer: Record<string, { mentionCount: number; unreadCount: number }> };
    blocked: BackendUser[];
    errors?: BootstrapPayload['errors'];
  }>('/bootstrap');

  const servers: Server[] = raw.servers.map((s) => ({
    id: s.id,
    name: s.name,
    icon: this.resolveAssetUrl(s.icon) ?? null,
    banner: s.banner?.startsWith('#') ? s.banner : (this.resolveAssetUrl(s.banner) ?? undefined),
    bannerPositionY: s.bannerPositionY ?? 50,
    powerUpCount: s.powerUpCount ?? 0,
    description: s.description ?? null,
    myRole: s.myRole,
    myPermissions: s.myPermissions,
    // The slim /servers payload drops `channels` and
    // `categories` from the bootstrap response — they're hydrated lazily via
    // GET /servers/:serverId on first server-click. Default to empty arrays
    // so this map() doesn't throw on a payload that doesn't include them.
    channels: (s.channels ?? []).map((c: any) => ({
      id: c.id, name: c.name, description: c.description ?? undefined,
      type: (c.type ?? 'text') as Channel['type'],
      categoryId: c.categoryId ?? null, position: c.position ?? 0,
      isPrivate: c.isPrivate ?? false, ageRestricted: c.ageRestricted ?? false,
      slowMode: c.slowMode ?? 0, userLimit: c.userLimit ?? 0,
      hideAfterInactivity: c.hideAfterInactivity ?? null,
      postGuidelines: c.postGuidelines ?? null,
      defaultReaction: c.defaultReaction ?? null,
      defaultSortOrder: c.defaultSortOrder ?? 'recent_activity',
      defaultLayout: c.defaultLayout ?? 'list',
      requireTags: c.requireTags ?? false,
      postSlowMode: c.postSlowMode ?? 0, messageSlowMode: c.messageSlowMode ?? 0,
    })),
    categories: s.categories?.map((cat: any) => ({
      id: cat.id, name: cat.name, position: cat.position ?? 0, isPrivate: cat.isPrivate ?? false,
    })) ?? [],
  }));

  // Resolve emoji image URLs the same way getServerEmojis does, then prime the
  // per-server emoji cache so any later getServerEmojis() call is a cache hit.
  const emojis: Record<string, CustomEmoji[]> = {};
  for (const [serverId, list] of Object.entries(raw.emojis ?? {})) {
    const resolved = list.map((e) => ({ ...e, imageUrl: this.resolveAssetUrl(e.imageUrl) ?? e.imageUrl }));
    emojis[serverId] = resolved;
    this.setCache(`emojis:${serverId}`, resolved, 60_000);
  }

  // Prime the servers cache for the same reason — any code path that still
  // calls apiClient.getServers() (e.g. focus refetches) will hit the cache.
  this.setCache('servers', servers, 30_000);

  return {
    user: raw.user ? this.normalizeUser(raw.user) : null,
    settings: raw.settings ?? { data: null, updatedAt: null },
    servers,
    folders: raw.folders ?? [],
    emojis,
    notificationCounts: raw.notificationCounts ?? { total: 0, byServer: {} },
    blocked: (raw.blocked ?? []).map((u) => this.normalizeUser(u)),
    ...(raw.errors ? { errors: raw.errors } : {}),
  };
};
