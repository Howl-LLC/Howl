// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Discovery API client.
 *
 * NOTE: When the backend endpoints `/discover/*` and `/public/*` are
 * unavailable, every method here either returns empty data (so the UI renders
 * gracefully) or throws a 404-shaped error (so the profile page shows its
 * not-found state).
 */
import { APIClient } from './core';

export type ServerCardSummary = {
  /** Server id (UUID). */
  id: string;
  /** Slug or vanity URL fragment. Falls back to id when no vanity is set. */
  slug?: string | null;
  vanityUrl?: string | null;
  /** Display name. */
  name: string;
  /** Resolved icon URL (server-relative paths get resolved through resolveAssetUrl). */
  icon?: string | null;
  /** Resolved banner URL. */
  banner?: string | null;
  /** Optional dedicated discovery splash banner (preferred over banner when present). */
  bannerSplash?: string | null;
  /** Marketing description (short, single-paragraph). */
  description?: string | null;
  /** Total members. */
  memberCount: number;
  /** Online members. */
  onlineCount: number;
  /** ISO 639-1 language tag. */
  language?: string | null;
  /** Discovery category key (e.g. `gaming`). */
  category?: string | null;
  /** Up to ~6 free-form tags. UI clamps to top 3. */
  tags?: string[];
  /** Verified badge (Discord parity). */
  verified?: boolean;
  /** Featured badge (Discord parity). */
  featured?: boolean;
  /** Mature/NSFW flag (server marked itself as mature). */
  mature?: boolean;
  /** Backend-controlled blur — true when server is mature AND the caller has not opted into NSFW. */
  blurred?: boolean;
};

export type DiscoverFilters = {
  q?: string;
  category?: string;
  language?: string;
  tag?: string;
  cursor?: string | null;
  limit?: number;
};

export type DiscoverListResponse = {
  items: ServerCardSummary[];
  nextCursor: string | null;
};

export type DiscoverCategory = {
  key: string;
  label: string;
  count?: number;
};

export type PublicServerProfile = {
  id: string;
  slug?: string | null;
  vanityUrl?: string | null;
  name: string;
  icon?: string | null;
  banner?: string | null;
  bannerSplash?: string | null;
  bannerPositionY?: number;
  /** Long marketing description (markdown allowed). */
  description?: string | null;
  /** Short tagline shown beside the icon. */
  shortDescription?: string | null;
  memberCount: number;
  onlineCount: number;
  language?: string | null;
  category?: string | null;
  tags?: string[];
  verified?: boolean;
  featured?: boolean;
  mature?: boolean;
  /** Server rules (string array, ordered). */
  rules?: string[];
  /** invite_only | apply_to_join | discoverable. */
  joinMethod?: 'invite_only' | 'apply_to_join' | 'discoverable';
  /** When the caller is logged in and already a member — UI uses this to show "Open" instead of "Join". */
  isMember?: boolean;
  /** Direct invite code the caller can use to join (when discoverable + not already a member). */
  inviteCode?: string | null;
};

declare module './core' {
  interface APIClient {
    /** Authenticated discover list (filtered by the user's age + content prefs). */
    discoverList(filters?: DiscoverFilters): Promise<DiscoverListResponse>;
    /** Anonymous discover list (always SFW; NSFW servers blurred or hidden). */
    publicDiscoverList(filters?: DiscoverFilters): Promise<DiscoverListResponse>;
    /** Featured carousel — small fixed-size list. */
    discoverFeatured(): Promise<ServerCardSummary[]>;
    /** Category index (key + label + optional count). */
    discoverCategories(): Promise<DiscoverCategory[]>;
    /** Public server profile by vanity URL or id. Throws status=404 when not found. */
    publicServerProfile(vanityOrId: string): Promise<PublicServerProfile>;
    /** Direct join from the public profile (joinMethod=discoverable only). */
    publicServerJoin(vanityOrId: string): Promise<import('../../types').Server>;
  }
}

const buildQuery = (filters: DiscoverFilters | undefined): string => {
  if (!filters) return '';
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.category) params.set('category', filters.category);
  if (filters.language) params.set('language', filters.language);
  if (filters.tag) params.set('tag', filters.tag);
  if (filters.cursor) params.set('cursor', filters.cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
};

const isMissingEndpoint = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  const status = (err as Error & { status?: number }).status;
  // Treat any server-side failure on the list endpoints as "endpoint not yet
  // available". The hub falls back to its empty state instead
  // of an error banner, which is the right UX for a directory that hasn't
  // been populated yet. Profile lookups handle errors separately so a real
  // outage there can still distinguish 404 from 5xx for the user.
  return typeof status === 'number' && (status === 404 || status >= 500);
};

const normalizeCard = (api: APIClient, c: ServerCardSummary): ServerCardSummary => ({
  ...c,
  icon: c.icon ? api.resolveAssetUrl(c.icon) ?? c.icon : null,
  banner: c.banner ? (c.banner.startsWith('#') ? c.banner : (api.resolveAssetUrl(c.banner) ?? c.banner)) : null,
  bannerSplash: c.bannerSplash ? api.resolveAssetUrl(c.bannerSplash) ?? c.bannerSplash : null,
  tags: Array.isArray(c.tags) ? c.tags : [],
});

const normalizeProfile = (api: APIClient, p: PublicServerProfile): PublicServerProfile => ({
  ...p,
  icon: p.icon ? api.resolveAssetUrl(p.icon) ?? p.icon : null,
  banner: p.banner ? (p.banner.startsWith('#') ? p.banner : (api.resolveAssetUrl(p.banner) ?? p.banner)) : null,
  bannerSplash: p.bannerSplash ? api.resolveAssetUrl(p.bannerSplash) ?? p.bannerSplash : null,
  tags: Array.isArray(p.tags) ? p.tags : [],
  rules: Array.isArray(p.rules) ? p.rules : [],
});

APIClient.prototype.discoverList = async function (this: APIClient, filters?: DiscoverFilters): Promise<DiscoverListResponse> {
  try {
    const data = await this.request<DiscoverListResponse>(`/discover${buildQuery(filters)}`);
    return {
      items: (data.items ?? []).map((c) => normalizeCard(this, c)),
      nextCursor: data.nextCursor ?? null,
    };
  } catch (err) {
    if (isMissingEndpoint(err)) return { items: [], nextCursor: null };
    throw err;
  }
};

APIClient.prototype.publicDiscoverList = async function (this: APIClient, filters?: DiscoverFilters): Promise<DiscoverListResponse> {
  try {
    const data = await this.request<DiscoverListResponse>(`/public/discover${buildQuery(filters)}`);
    return {
      items: (data.items ?? []).map((c) => normalizeCard(this, c)),
      nextCursor: data.nextCursor ?? null,
    };
  } catch (err) {
    if (isMissingEndpoint(err)) return { items: [], nextCursor: null };
    throw err;
  }
};

APIClient.prototype.discoverFeatured = async function (this: APIClient): Promise<ServerCardSummary[]> {
  try {
    const data = await this.request<{ items?: ServerCardSummary[] } | ServerCardSummary[]>(`/discover/featured`);
    const items = Array.isArray(data) ? data : data.items ?? [];
    return items.map((c) => normalizeCard(this, c));
  } catch (err) {
    if (isMissingEndpoint(err)) return [];
    throw err;
  }
};

APIClient.prototype.discoverCategories = async function (this: APIClient): Promise<DiscoverCategory[]> {
  try {
    const data = await this.request<{ items?: DiscoverCategory[] } | DiscoverCategory[]>(`/discover/categories`);
    return Array.isArray(data) ? data : data.items ?? [];
  } catch (err) {
    if (isMissingEndpoint(err)) return [];
    throw err;
  }
};

APIClient.prototype.publicServerProfile = async function (this: APIClient, vanityOrId: string): Promise<PublicServerProfile> {
  // No try/catch — the profile page needs to know when the server doesn't
  // exist so it can render the not-found state. Caller handles status=404.
  const data = await this.request<PublicServerProfile>(`/public/server/${encodeURIComponent(vanityOrId)}`);
  return normalizeProfile(this, data);
};

APIClient.prototype.publicServerJoin = async function (this: APIClient, vanityOrId: string) {
  this.invalidateCache('servers');
  const data = await this.request<{
    id: string;
    name: string;
    icon?: string;
    banner?: string;
    myRole?: string;
    myPermissions?: Record<string, boolean>;
    channels: Array<{ id: string; name: string; type: string; description?: string | null; categoryId?: string | null; position?: number }>;
  }>(`/public/server/${encodeURIComponent(vanityOrId)}/join`, { method: 'POST', body: JSON.stringify({}) });
  return {
    id: data.id,
    name: data.name,
    icon: this.resolveAssetUrl(data.icon) ?? null,
    banner: data.banner?.startsWith('#') ? data.banner : (this.resolveAssetUrl(data.banner) ?? undefined),
    myRole: data.myRole ?? 'member',
    myPermissions: data.myPermissions,
    channels: data.channels.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description ?? undefined,
      type: c.type as import('../../types').Channel['type'],
      categoryId: c.categoryId ?? null,
      position: c.position ?? 0,
    })),
    categories: [],
  } satisfies import('../../types').Server;
};
