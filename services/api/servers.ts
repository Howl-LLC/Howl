// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { User, Server, Channel, ChannelCategory, ServerSettings, ServerBan } from '../../types';
import type { ApplicationQuestion } from './community';

/**
 * 202 response shape from `/invites/join` when the target server has
 * `joinMethod === 'apply_to_join'`. The applicant has not joined yet — they
 * need to submit answers to the configured questions, which a reviewer then
 * accepts or rejects. Discriminated by `applicationRequired: true`.
 */
export interface InviteApplicationRequired {
  applicationRequired: true;
  serverId: string;
  serverName: string;
  questions: ApplicationQuestion[];
  /** Set when the user already has a pending application — lets the UI skip
   *  the form and render the "already applied, awaiting review" state. */
  existingApplication?: { status: 'pending'; createdAt: string } | null;
}

export interface InvitePreview {
  serverId: string;
  serverName: string;
  serverIcon: string | null;
  serverBanner: string | null;
  serverBannerPositionY: number;
  serverBannerZoom: number;
  description: string | null;
  memberCount: number;
  onlineCount: number;
  code: string;
  expiresAt: string | null;
  /** Server's join policy. Optional for backward compat with older backends
   *  that didn't surface this field. Treat missing as 'invite_only'. */
  joinMethod?: 'invite_only' | 'apply_to_join' | 'discoverable';
}

declare module './core' {
  interface APIClient {
    /**
     * Slim list of the user's servers — no channels, categories, or
     * permission overrides. Companion `getServer(id)` hydrates a single
     * server when the user opens it. Slimming the bootstrap path is a
     * connect-storm prerequisite for launch.
     */
    getServers(): Promise<Server[]>;
    /**
     * Hydrate one server with channels, categories, and override-resolved
     * visibility. Called by AppLayout the first time the user opens a server.
     */
    getServer(serverId: string): Promise<Server>;
    resolveInvite(code: string): Promise<InvitePreview>;
    updateServer(serverId: string, data: { name?: string; icon?: string; banner?: string }): Promise<Server>;
    getServerMembers(serverId: string): Promise<Array<User & { role: string; roleColor?: string; roleStyle?: 'solid' | 'gradient' | 'holographic'; memberSince?: string; joinedPlatform?: string; joinMethod?: string; nickname?: string | null; serverAvatar?: string | null; serverBanner?: string | null }>>;
    getMyServerProfile(serverId: string): Promise<{ nickname: string | null; serverAvatar: string | null; serverBanner: string | null; onboardingCompletedAt: string | null }>;
    updateMyServerProfile(serverId: string, data: { nickname?: string | null; serverAvatar?: string | null; serverBanner?: string | null }): Promise<{ nickname: string | null; serverAvatar: string | null; serverBanner: string | null }>;
    /** Set another member's nickname. Requires `manageNicknames` permission
     *  on the server, plus role-hierarchy: cannot change nickname of a
     *  member at or above your role position, or the server owner. */
    setMemberNickname(serverId: string, userId: string, nickname: string | null): Promise<{ nickname: string | null }>;
    getSsoAccounts(): Promise<Array<{ id: string; provider: string; email: string | null; displayName: string | null; avatarUrl: string | null }>>;
    getSsoLinkToken(provider: string): Promise<{ linkToken: string }>;
    unlinkSsoAccount(accountId: string): Promise<void>;
    kickServerMember(serverId: string, userId: string): Promise<void>;
    getMemberModView(serverId: string, userId: string): Promise<{
      id: string; username: string; avatar?: string; role: string; roleColor?: string; roleStyle?: string;
      memberSince: string; joinedPlatform: string; joinMethod: string;
      messageCount: number; linksCount: number; mediaCount: number;
      roles: Array<{ name: string; color: string }>; modPermissions: string[]; passedVerification: boolean;
    }>;
    getServerRoles(serverId: string): Promise<Array<{
      id: string; name: string; color: string; style: string; icon?: string; position: number; locked: boolean; isEveryone?: boolean;
      permissions: Record<string, boolean>; displaySeparately: boolean; allowMention: boolean;
      linkedRoleRequirements?: unknown[]; memberCount: number;
    }>>;
    createServerRole(serverId: string, data: { name?: string; color?: string; style?: string; icon?: string; permissions?: Record<string, boolean>; displaySeparately?: boolean; allowMention?: boolean }): Promise<{ id: string; name: string; color: string; style: string; icon?: string; position: number; locked: boolean; isEveryone?: boolean; permissions: Record<string, boolean>; displaySeparately: boolean; allowMention: boolean; memberCount: number }>;
    updateServerRole(serverId: string, roleId: string, data: { name?: string; color?: string; style?: string; icon?: string; permissions?: Record<string, boolean>; displaySeparately?: boolean; allowMention?: boolean; position?: number }): Promise<{ id: string; name: string; color: string; style: string; icon?: string; position: number; locked: boolean; isEveryone?: boolean; permissions: Record<string, boolean>; displaySeparately: boolean; allowMention: boolean; memberCount: number }>;
    deleteServerRole(serverId: string, roleId: string): Promise<void>;
    reorderServerRoles(serverId: string, orderedRoleIds: string[]): Promise<{ ok: true; roles: Array<{ id: string; position: number }> }>;
    addMemberToRole(serverId: string, roleId: string, userId: string): Promise<void>;
    removeMemberFromRole(serverId: string, roleId: string, userId: string): Promise<void>;
    createServer(name: string, icon?: string, template?: string): Promise<Server>;
    createServerFromTemplate(code: string, name?: string, icon?: string): Promise<Server>;
    createChannel(serverId: string, name: string, type: Channel['type'], categoryId?: string | null, isPrivate?: boolean): Promise<Channel>;
    updateChannel(serverId: string, channelId: string, data: Partial<Pick<Channel, 'name' | 'description' | 'slowMode' | 'isPrivate' | 'ageRestricted' | 'userLimit' | 'hideAfterInactivity' | 'postGuidelines' | 'defaultReaction' | 'defaultSortOrder' | 'defaultLayout' | 'requireTags' | 'postSlowMode' | 'messageSlowMode'>>): Promise<Channel>;
    deleteChannel(serverId: string, channelId: string): Promise<void>;
    createCategory(serverId: string, name: string): Promise<ChannelCategory>;
    updateCategory(serverId: string, categoryId: string, data: { name?: string; position?: number; isPrivate?: boolean }): Promise<ChannelCategory>;
    deleteCategory(serverId: string, categoryId: string): Promise<void>;
    reorderChannels(serverId: string, channels: Array<{ id: string; position: number; categoryId: string | null }>): Promise<void>;
    reorderCategories(serverId: string, categories: Array<{ id: string; position: number }>): Promise<void>;
    /**
     * Persist the far-left sidebar server order for the authenticated user.
     * Replaces the localStorage-only scheme so the order follows the user
     * across devices, browser tabs, and reinstalls. Pass the full ordered
     * list of server IDs; array index becomes the stored `position`.
     */
    setServerOrder(serverIds: string[]): Promise<void>;
    getServerInvites(serverId: string): Promise<Array<{ id: string; code: string; link: string; useCount: number; maxUses?: number; expiresAt?: string; temporary?: boolean; label?: string; shareable: boolean; createdAt: string; createdBy?: { id: string; username: string; discriminator: string; avatar: string | null } }>>;
    createServerInvite(serverId: string, options?: { expireAfter?: number | null; maxUses?: number | null; temporary?: boolean; customCode?: string; label?: string; shareable?: boolean }): Promise<{ id: string; code: string; link: string; maxUses?: number; expiresAt?: string; temporary?: boolean; label?: string; shareable: boolean }>;
    deleteServerInvite(serverId: string, inviteId: string): Promise<void>;
    updateServerInvite(serverId: string, inviteId: string, data: { label?: string | null; shareable?: boolean }): Promise<{ id: string; code: string; link: string; useCount: number; maxUses?: number; expiresAt?: string; temporary?: boolean; label?: string; shareable: boolean; createdAt: string }>;
    leaveServer(serverId: string): Promise<void>;
    transferServerOwnership(serverId: string, newOwnerId: string): Promise<void>;
    deleteServer(serverId: string, password?: string): Promise<void>;
    joinServerByInvite(code: string, ageConfirmed?: boolean): Promise<Server | InviteApplicationRequired>;
    getServerSettings(serverId: string): Promise<ServerSettings>;
    updateServerSettings(serverId: string, data: Partial<Omit<ServerSettings, 'id' | 'serverId'>>): Promise<ServerSettings>;
    getServerBans(serverId: string): Promise<ServerBan[]>;
    banServerMember(serverId: string, userId: string, reason?: string): Promise<ServerBan>;
    unbanServerMember(serverId: string, userId: string): Promise<void>;
    getServerPrivacy(serverId: string): Promise<{ allowDirectMessages: boolean | null }>;
    updateServerPrivacy(serverId: string, settings: { allowDirectMessages: boolean | null }): Promise<{ allowDirectMessages: boolean | null }>;
    /** Roles granted automatically when a member joins the server (max 5). */
    autoRolesGet(serverId: string): Promise<{ roleIds: string[] }>;
    autoRolesSet(serverId: string, roleIds: string[]): Promise<{ roleIds: string[] }>;
    /** Mark the authenticated member's onboarding as complete. */
    onboardingComplete(serverId: string): Promise<{ onboardingCompletedAt: string }>;
  }
}

// Slim server payload (no channels/categories/overrides). Frontend consumers
// that read `server.channels` get an empty array until `getServer(id)`
// hydrates the active server — see AppLayout's hydration effect.
type SlimServerResponse = {
  id: string;
  name: string;
  icon?: string;
  banner?: string;
  bannerPositionY?: number;
  powerUpCount?: number;
  memberCount?: number;
  description?: string | null;
  myRole?: string;
  myPermissions?: Record<string, boolean>;
  acceptedAgeRestrictedChannelIds?: string[];
};

function deserializeChannel(c: Record<string, unknown>): Channel {
  return {
    id: c.id as string,
    name: c.name as string,
    description: (c.description as string | undefined) ?? undefined,
    type: ((c.type as Channel['type']) ?? 'text'),
    categoryId: (c.categoryId as string | null | undefined) ?? null,
    position: (c.position as number | undefined) ?? 0,
    isPrivate: (c.isPrivate as boolean | undefined) ?? false,
    ageRestricted: (c.ageRestricted as boolean | undefined) ?? false,
    slowMode: (c.slowMode as number | undefined) ?? 0,
    userLimit: (c.userLimit as number | undefined) ?? 0,
    hideAfterInactivity: (c.hideAfterInactivity as number | null | undefined) ?? null,
    postGuidelines: (c.postGuidelines as string | null | undefined) ?? null,
    defaultReaction: (c.defaultReaction as string | null | undefined) ?? null,
    defaultSortOrder: (c.defaultSortOrder as Channel['defaultSortOrder'] | undefined) ?? 'recent_activity',
    defaultLayout: (c.defaultLayout as Channel['defaultLayout'] | undefined) ?? 'list',
    requireTags: (c.requireTags as boolean | undefined) ?? false,
    postSlowMode: (c.postSlowMode as number | undefined) ?? 0,
    messageSlowMode: (c.messageSlowMode as number | undefined) ?? 0,
  } as Channel;
}

function deserializeCategory(cat: Record<string, unknown>): ChannelCategory {
  return {
    id: cat.id as string,
    name: cat.name as string,
    position: (cat.position as number | undefined) ?? 0,
    isPrivate: (cat.isPrivate as boolean | undefined) ?? false,
  } as ChannelCategory;
}

function deserializeSlimServer(this: APIClient, s: SlimServerResponse): Server {
  return {
    id: s.id,
    name: s.name,
    icon: this.resolveAssetUrl(s.icon) ?? null,
    banner: s.banner?.startsWith('#') ? s.banner : (this.resolveAssetUrl(s.banner) ?? undefined),
    bannerPositionY: s.bannerPositionY ?? 50,
    powerUpCount: s.powerUpCount ?? 0,
    memberCount: s.memberCount ?? 0,
    description: s.description ?? null,
    myRole: s.myRole,
    myPermissions: s.myPermissions,
    acceptedAgeRestrictedChannelIds: s.acceptedAgeRestrictedChannelIds ?? [],
    // Empty until `getServer(id)` hydrates this server. Consumers that read
    // `server.channels.find(...)` keep working — they just see no channels
    // for un-hydrated servers (cross-server voice indicators, jump-to-first-
    // channel, etc. degrade gracefully to "not visited yet").
    channels: [],
    categories: [],
  };
}

APIClient.prototype.getServers = async function(this: APIClient): Promise<Server[]> {
  const cacheKey = 'servers';
  const cached = this.getCached<Server[]>(cacheKey);
  if (cached) return cached;
  const data = await this.request<SlimServerResponse[]>('/servers');
  const result = data.map((s) => deserializeSlimServer.call(this, s));
  this.setCache(cacheKey, result, 30_000);
  return result;
};

APIClient.prototype.getServer = async function(this: APIClient, serverId: string): Promise<Server> {
  type FullServerResponse = SlimServerResponse & {
    channels?: Array<Record<string, unknown>>;
    categories?: Array<Record<string, unknown>>;
  };
  const data = await this.request<FullServerResponse>(`/servers/${serverId}`);
  const slim = deserializeSlimServer.call(this, data);
  return {
    ...slim,
    channels: (data.channels ?? []).map(deserializeChannel),
    categories: (data.categories ?? []).map(deserializeCategory),
  };
};

APIClient.prototype.updateServer = async function(this: APIClient, serverId: string, data: { name?: string; icon?: string; banner?: string }): Promise<Server> {
  const res = await this.request<{ id: string; name: string; icon?: string; banner?: string; bannerPositionY?: number; powerUpCount?: number; channels: Array<{ id: string; name: string; type: string; description?: string; categoryId?: string | null; position?: number }>; categories?: Array<{ id: string; name: string; position: number }> }>(`/servers/${serverId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  return {
    id: res.id,
    name: res.name,
    icon: this.resolveAssetUrl(res.icon) ?? null,
    banner: res.banner?.startsWith('#') ? res.banner : (this.resolveAssetUrl(res.banner) ?? undefined),
    bannerPositionY: res.bannerPositionY ?? 50,
    powerUpCount: res.powerUpCount ?? 0,
    channels: res.channels.map((c) => ({ id: c.id, name: c.name, description: c.description ?? undefined, type: c.type as Channel['type'], categoryId: c.categoryId ?? null, position: c.position ?? 0 })),
    categories: res.categories?.map((cat) => ({ id: cat.id, name: cat.name, position: cat.position ?? 0 })) ?? [],
  };
};

APIClient.prototype.getServerMembers = async function(this: APIClient, serverId: string): Promise<Array<User & { role: string; roleColor?: string; roleStyle?: 'solid' | 'gradient' | 'holographic'; roles?: Array<{ id: string; name: string; color?: string; style?: string; position?: number; displaySeparately?: boolean }>; memberSince?: string; joinedPlatform?: string; joinMethod?: string; nickname?: string | null; serverAvatar?: string | null; serverBanner?: string | null }>> {
  const cacheKey = `members:${serverId}`;
  const cached = this.getCached<Array<User & { role: string; roleColor?: string; roleStyle?: 'solid' | 'gradient' | 'holographic'; roles?: Array<{ id: string; name: string; color?: string; style?: string; position?: number; displaySeparately?: boolean }>; memberSince?: string; joinedPlatform?: string; joinMethod?: string; nickname?: string | null; serverAvatar?: string | null; serverBanner?: string | null }>>(cacheKey);
  if (cached) return cached;

  type MemberRow = { id: string; username: string; discriminator?: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; activityBio?: string | null; status?: string; role: string; roleColor?: string; roleStyle?: string; roles?: Array<{ id: string; name: string; color: string; style: string; position: number; displaySeparately: boolean }>; memberSince?: string; joinedPlatform?: string; joinMethod?: string; nickname?: string | null; serverAvatar?: string | null; serverBanner?: string | null; stripePlan?: string | null; effectivePlan?: string | null; nameFont?: string | null; nameEffect?: string | null; nameColor?: string | null; avatarEffect?: string | null; badges?: string[]; activity?: { type: string; name: string; details?: string; state?: string; largeImage?: string; smallImage?: string; startedAt: string; platformId?: string; platform?: string } };
  const raw = await this.request<MemberRow[] | { members: MemberRow[]; total: number; hasMore: boolean }>(`/servers/${serverId}/members?limit=500`);
  const data = Array.isArray(raw) ? raw : raw.members;
  const result = data.map((m) => ({
    id: m.id,
    username: m.username,
    discriminator: m.discriminator,
    avatar: this.resolveAssetUrl(m.avatar) || null,
    banner: this.resolveAssetUrl(m.banner),
    bannerPositionY: m.bannerPositionY ?? 50,
    bannerZoom: m.bannerZoom ?? 100,
    activityBio: m.activityBio ?? undefined,
    status: (m.status as User['status']) ?? 'offline',
    role: m.role,
    roleColor: m.roleColor,
    roleStyle: (m.roleStyle as 'solid' | 'gradient' | 'holographic' | undefined) ?? 'solid',
    roles: m.roles ?? [],
    memberSince: m.memberSince,
    joinedPlatform: m.joinedPlatform,
    joinMethod: m.joinMethod,
    nickname: m.nickname ?? null,
    serverAvatar: m.serverAvatar ? this.resolveAssetUrl(m.serverAvatar) : null,
    serverBanner: m.serverBanner ? this.resolveAssetUrl(m.serverBanner) : null,
    stripePlan: m.stripePlan ?? null,
    effectivePlan: m.effectivePlan ?? null,
    nameFont: m.nameFont ?? null,
    nameEffect: m.nameEffect ?? null,
    nameColor: m.nameColor ?? null,
    avatarEffect: m.avatarEffect ?? null,
    badges: m.badges ?? [],
    activity: m.activity ? {
      type: m.activity.type as any,
      name: m.activity.name,
      details: m.activity.details ?? undefined,
      state: m.activity.state ?? undefined,
      largeImage: m.activity.largeImage ?? undefined,
      smallImage: m.activity.smallImage ?? undefined,
      startedAt: m.activity.startedAt,
      platformId: m.activity.platformId ?? undefined,
      platform: m.activity.platform ?? undefined,
    } : undefined,
  }));
  this.setCache(cacheKey, result);
  return result;
};

APIClient.prototype.getMyServerProfile = async function(this: APIClient, serverId: string): Promise<{ nickname: string | null; serverAvatar: string | null; serverBanner: string | null; onboardingCompletedAt: string | null }> {
  const data = await this.request<{ nickname: string | null; serverAvatar: string | null; serverBanner: string | null; onboardingCompletedAt?: string | null }>(`/servers/${serverId}/members/@me/profile`);
  return {
    nickname: data.nickname,
    serverAvatar: data.serverAvatar ? this.resolveAssetUrl(data.serverAvatar) ?? null : null,
    serverBanner: data.serverBanner ? this.resolveAssetUrl(data.serverBanner) ?? null : null,
    onboardingCompletedAt: data.onboardingCompletedAt ?? null,
  };
};

APIClient.prototype.updateMyServerProfile = async function(this: APIClient, serverId: string, data: { nickname?: string | null; serverAvatar?: string | null; serverBanner?: string | null }): Promise<{ nickname: string | null; serverAvatar: string | null; serverBanner: string | null }> {
  const result = await this.request<{ nickname: string | null; serverAvatar: string | null; serverBanner: string | null }>(`/servers/${serverId}/members/@me/profile`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  return {
    nickname: result.nickname,
    serverAvatar: result.serverAvatar ? this.resolveAssetUrl(result.serverAvatar) ?? null : null,
    serverBanner: result.serverBanner ? this.resolveAssetUrl(result.serverBanner) ?? null : null,
  };
};

APIClient.prototype.setMemberNickname = async function(this: APIClient, serverId: string, userId: string, nickname: string | null): Promise<{ nickname: string | null }> {
  return this.request<{ nickname: string | null }>(`/servers/${serverId}/members/${userId}/nickname`, {
    method: 'PATCH',
    body: JSON.stringify({ nickname }),
  });
};

APIClient.prototype.getSsoAccounts = async function(this: APIClient): Promise<Array<{ id: string; provider: string; email: string | null; displayName: string | null; avatarUrl: string | null }>> {
  return this.request('/auth/sso/accounts');
};

APIClient.prototype.getSsoLinkToken = async function(this: APIClient, provider: string): Promise<{ linkToken: string }> {
  return this.request('/auth/sso/link-token', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  });
};

APIClient.prototype.unlinkSsoAccount = async function(this: APIClient, accountId: string): Promise<void> {
  await this.request(`/auth/sso/accounts/${accountId}`, { method: 'DELETE' });
};

APIClient.prototype.kickServerMember = async function(this: APIClient, serverId: string, userId: string): Promise<void> {
  await this.request(`/servers/${serverId}/members/${userId}`, { method: 'DELETE' });
};

APIClient.prototype.getMemberModView = async function(this: APIClient, serverId: string, userId: string) {
  return this.request(`/servers/${serverId}/members/${userId}/mod-view`);
};

APIClient.prototype.getServerRoles = async function(this: APIClient, serverId: string) {
  return this.request(`/servers/${serverId}/roles`);
};

APIClient.prototype.createServerRole = async function(this: APIClient, serverId: string, data: { name?: string; color?: string; style?: string; icon?: string; permissions?: Record<string, boolean>; displaySeparately?: boolean; allowMention?: boolean }) {
  return this.request(`/servers/${serverId}/roles`, { method: 'POST', body: JSON.stringify(data) });
};

APIClient.prototype.updateServerRole = async function(this: APIClient, serverId: string, roleId: string, data: { name?: string; color?: string; style?: string; icon?: string; permissions?: Record<string, boolean>; displaySeparately?: boolean; allowMention?: boolean; position?: number }) {
  return this.request(`/servers/${serverId}/roles/${roleId}`, { method: 'PUT', body: JSON.stringify(data) });
};

APIClient.prototype.deleteServerRole = async function(this: APIClient, serverId: string, roleId: string): Promise<void> {
  await this.request(`/servers/${serverId}/roles/${roleId}`, { method: 'DELETE' });
};

APIClient.prototype.reorderServerRoles = async function(this: APIClient, serverId: string, orderedRoleIds: string[]): Promise<{ ok: true; roles: Array<{ id: string; position: number }> }> {
  return this.request(`/servers/${serverId}/roles/reorder`, {
    method: 'POST',
    body: JSON.stringify({ orderedRoleIds }),
  });
};

APIClient.prototype.addMemberToRole = async function(this: APIClient, serverId: string, roleId: string, userId: string): Promise<void> {
  await this.request(`/servers/${serverId}/roles/${roleId}/members`, { method: 'POST', body: JSON.stringify({ userId }) });
};

APIClient.prototype.removeMemberFromRole = async function(this: APIClient, serverId: string, roleId: string, userId: string): Promise<void> {
  await this.request(`/servers/${serverId}/roles/${roleId}/members/${userId}`, { method: 'DELETE' });
};

APIClient.prototype.createServer = async function(this: APIClient, name: string, icon?: string, template?: string): Promise<Server> {
  this.invalidateCache('servers');
  const body: Record<string, string> = { name };
  if (icon) body.icon = icon;
  if (template) body.template = template;
  const data = await this.request<{ id: string; name: string; icon?: string; banner?: string; myRole?: string; myPermissions?: Record<string, boolean>; channels: Array<{ id: string; name: string; type: string; description?: string; categoryId?: string | null; position?: number }>; categories?: Array<{ id: string; name: string; position: number }> }>('/servers', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return {
    id: data.id,
    name: data.name,
    icon: this.resolveAssetUrl(data.icon) ?? null,
    banner: data.banner?.startsWith('#') ? data.banner : (this.resolveAssetUrl(data.banner) ?? undefined),
    myRole: data.myRole ?? 'owner',
    myPermissions: data.myPermissions,
    channels: data.channels.map((c) => ({ id: c.id, name: c.name, description: c.description ?? undefined, type: c.type as Channel['type'], categoryId: c.categoryId ?? null, position: c.position ?? 0 })),
    categories: data.categories?.map((cat) => ({ id: cat.id, name: cat.name, position: cat.position ?? 0 })) ?? [],
  };
};

APIClient.prototype.createServerFromTemplate = async function(this: APIClient, code: string, name?: string, icon?: string): Promise<Server> {
  this.invalidateCache('servers');
  const body: { code: string; name?: string; icon?: string } = { code };
  if (name) body.name = name;
  if (icon) body.icon = icon;
  const data = await this.request<{ id: string; name: string; icon?: string; banner?: string; myRole?: string; myPermissions?: Record<string, boolean>; channels: Array<{ id: string; name: string; type: string; description?: string; categoryId?: string | null; position?: number }>; categories?: Array<{ id: string; name: string; position: number }> }>('/servers/from-template', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return {
    id: data.id,
    name: data.name,
    icon: this.resolveAssetUrl(data.icon) ?? null,
    banner: data.banner?.startsWith('#') ? data.banner : (this.resolveAssetUrl(data.banner) ?? undefined),
    myRole: data.myRole ?? 'owner',
    myPermissions: data.myPermissions,
    channels: data.channels.map((c) => ({ id: c.id, name: c.name, description: c.description ?? undefined, type: c.type as Channel['type'], categoryId: c.categoryId ?? null, position: c.position ?? 0 })),
    categories: data.categories?.map((cat) => ({ id: cat.id, name: cat.name, position: cat.position ?? 0 })) ?? [],
  };
};

APIClient.prototype.createChannel = async function(this: APIClient, serverId: string, name: string, type: Channel['type'], categoryId?: string | null, isPrivate?: boolean): Promise<Channel> {
  this.invalidateCache('servers');
  const body: Record<string, unknown> = { name, type };
  if (categoryId) body.categoryId = categoryId;
  if (isPrivate) body.isPrivate = true;
  const data = await this.request<Record<string, unknown>>(`/servers/${serverId}/channels`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { id: data.id as string, name: data.name as string, description: (data.description as string) ?? undefined, type: (data.type ?? 'text') as Channel['type'], categoryId: (data.categoryId as string) ?? null, position: (data.position as number) ?? 0, isPrivate: (data.isPrivate as boolean) ?? false };
};

APIClient.prototype.updateChannel = async function(this: APIClient, serverId: string, channelId: string, data: Partial<Pick<Channel, 'name' | 'description' | 'slowMode' | 'isPrivate' | 'ageRestricted' | 'userLimit' | 'hideAfterInactivity' | 'postGuidelines' | 'defaultReaction' | 'defaultSortOrder' | 'defaultLayout' | 'requireTags' | 'postSlowMode' | 'messageSlowMode'>>): Promise<Channel> {
  const res = await this.request<Record<string, unknown>>(`/servers/${serverId}/channels/${channelId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  return { id: res.id as string, name: res.name as string, description: (res.description as string) ?? undefined, type: (res.type ?? 'text') as Channel['type'], categoryId: (res.categoryId as string) ?? null, position: (res.position as number) ?? 0, isPrivate: (res.isPrivate as boolean) ?? false, ageRestricted: (res.ageRestricted as boolean) ?? false, slowMode: (res.slowMode as number) ?? 0 };
};

APIClient.prototype.deleteChannel = async function(this: APIClient, serverId: string, channelId: string): Promise<void> {
  this.invalidateCache('servers');
  await this.request<undefined>(`/servers/${serverId}/channels/${channelId}`, { method: 'DELETE' });
};

APIClient.prototype.getServerInvites = async function(this: APIClient, serverId: string) {
  // Backend returns { invites: Invite[], pagination: {...} } (paginated). Unwrap to
  // the plain array the frontend consumers expect. Resolve createdBy.avatar from
  // relative `/api/uploads/...` to the absolute CDN URL — otherwise <LazyGif>
  // loads the relative path against the frontend origin and 404s.
  type Invite = { id: string; code: string; link: string; useCount: number; maxUses?: number; expiresAt?: string; temporary?: boolean; label?: string; shareable: boolean; createdAt: string; createdBy?: { id: string; username: string; discriminator: string; avatar: string | null } };
  const response = await this.request<{ invites: Invite[] } | Invite[]>(`/servers/${serverId}/invites`);
  const invites = Array.isArray(response) ? response : response.invites ?? [];
  return invites.map((inv) => ({
    ...inv,
    createdBy: inv.createdBy
      ? { ...inv.createdBy, avatar: this.resolveAssetUrl(inv.createdBy.avatar) ?? inv.createdBy.avatar }
      : inv.createdBy,
  }));
};

APIClient.prototype.createServerInvite = async function(this: APIClient, serverId: string, options?: { expireAfter?: number | null; maxUses?: number | null; temporary?: boolean; customCode?: string; label?: string; shareable?: boolean }) {
  return this.request(`/servers/${serverId}/invites`, {
    method: 'POST',
    body: JSON.stringify(options ?? {}),
  });
};

APIClient.prototype.deleteServerInvite = async function(this: APIClient, serverId: string, inviteId: string): Promise<void> {
  await this.request(`/servers/${serverId}/invites/${inviteId}`, { method: 'DELETE' });
};

APIClient.prototype.updateServerInvite = async function(this: APIClient, serverId: string, inviteId: string, data: { label?: string | null; shareable?: boolean }) {
  return this.request(`/servers/${serverId}/invites/${inviteId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.leaveServer = async function(this: APIClient, serverId: string): Promise<void> {
  this.invalidateCache('servers');
  await this.request<undefined>(`/servers/${serverId}/leave`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
};

APIClient.prototype.transferServerOwnership = async function(this: APIClient, serverId: string, newOwnerId: string): Promise<void> {
  await this.request<undefined>(`/servers/${serverId}/transfer-ownership`, {
    method: 'POST',
    body: JSON.stringify({ newOwnerId }),
  });
};

APIClient.prototype.deleteServer = async function(this: APIClient, serverId: string, password?: string): Promise<void> {
  this.invalidateCache('servers');
  await this.request<undefined>(`/servers/${serverId}`, {
    method: 'DELETE',
    headers: password ? { 'x-confirm-password': password } : undefined,
  });
};

APIClient.prototype.joinServerByInvite = async function(this: APIClient, code: string, ageConfirmed?: boolean): Promise<Server | InviteApplicationRequired> {
  this.invalidateCache('servers');
  const payload: { code: string; ageConfirmed?: boolean } = { code };
  if (ageConfirmed) payload.ageConfirmed = true;
  type JoinedServerResp = { id: string; name: string; icon?: string; banner?: string; myRole?: string; myPermissions?: Record<string, boolean>; channels: Array<{ id: string; name: string; type: string; description?: string; categoryId?: string | null; position?: number }>; categories?: Array<{ id: string; name: string; position: number }> };
  type ApplicationRequiredResp = {
    status: 'application_required';
    serverId: string;
    serverName: string;
    questions: ApplicationQuestion[];
    existingApplication?: { status: 'pending'; createdAt: string } | null;
  };
  const data = await this.request<JoinedServerResp | ApplicationRequiredResp>('/invites/join', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if ('status' in data && data.status === 'application_required') {
    return {
      applicationRequired: true,
      serverId: data.serverId,
      serverName: data.serverName,
      questions: Array.isArray(data.questions) ? data.questions : [],
      existingApplication: data.existingApplication ?? null,
    };
  }
  const joined = data as JoinedServerResp;
  return {
    id: joined.id,
    name: joined.name,
    icon: this.resolveAssetUrl(joined.icon) ?? null,
    banner: joined.banner?.startsWith('#') ? joined.banner : (this.resolveAssetUrl(joined.banner) ?? undefined),
    myRole: joined.myRole ?? 'member',
    myPermissions: joined.myPermissions,
    channels: joined.channels.map((c) => ({ id: c.id, name: c.name, description: c.description ?? undefined, type: c.type as Channel['type'], categoryId: c.categoryId ?? null, position: c.position ?? 0 })),
    categories: joined.categories?.map((cat) => ({ id: cat.id, name: cat.name, position: cat.position ?? 0 })) ?? [],
  };
};

APIClient.prototype.getServerSettings = async function(this: APIClient, serverId: string): Promise<ServerSettings> {
  return this.request(`/servers/${serverId}/settings`);
};

APIClient.prototype.updateServerSettings = async function(this: APIClient, serverId: string, data: Partial<Omit<ServerSettings, 'id' | 'serverId'>>): Promise<ServerSettings> {
  return this.request(`/servers/${serverId}/settings`, { method: 'PATCH', body: JSON.stringify(data) });
};

APIClient.prototype.getServerBans = async function(this: APIClient, serverId: string): Promise<ServerBan[]> {
  const data = await this.request<{ bans: ServerBan[]; total: number; page: number; pages: number }>(`/servers/${serverId}/bans`);
  return data.bans;
};

APIClient.prototype.banServerMember = async function(this: APIClient, serverId: string, userId: string, reason?: string): Promise<ServerBan> {
  return this.request(`/servers/${serverId}/bans`, { method: 'POST', body: JSON.stringify({ userId, reason }) });
};

APIClient.prototype.unbanServerMember = async function(this: APIClient, serverId: string, userId: string): Promise<void> {
  await this.request(`/servers/${serverId}/bans/${userId}`, { method: 'DELETE' });
};

APIClient.prototype.getServerPrivacy = async function(this: APIClient, serverId: string): Promise<{ allowDirectMessages: boolean | null }> {
  return this.request(`/servers/${serverId}/privacy`);
};

APIClient.prototype.updateServerPrivacy = async function(this: APIClient, serverId: string, settings: { allowDirectMessages: boolean | null }): Promise<{ allowDirectMessages: boolean | null }> {
  return this.request(`/servers/${serverId}/privacy`, { method: 'PATCH', body: JSON.stringify(settings) });
};

APIClient.prototype.autoRolesGet = async function(this: APIClient, serverId: string): Promise<{ roleIds: string[] }> {
  return this.request(`/servers/${serverId}/auto-roles`);
};

APIClient.prototype.autoRolesSet = async function(this: APIClient, serverId: string, roleIds: string[]): Promise<{ roleIds: string[] }> {
  return this.request(`/servers/${serverId}/auto-roles`, { method: 'PUT', body: JSON.stringify({ roleIds }) });
};

APIClient.prototype.onboardingComplete = async function(this: APIClient, serverId: string): Promise<{ onboardingCompletedAt: string }> {
  return this.request(`/servers/${serverId}/members/@me/onboarding`, { method: 'PATCH', body: JSON.stringify({ completed: true }) });
};

APIClient.prototype.createCategory = async function(this: APIClient, serverId: string, name: string): Promise<ChannelCategory> {
  this.invalidateCache('servers');
  return this.request<ChannelCategory>(`/servers/${serverId}/categories`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
};

APIClient.prototype.updateCategory = async function(this: APIClient, serverId: string, categoryId: string, data: { name?: string; position?: number; isPrivate?: boolean }): Promise<ChannelCategory> {
  this.invalidateCache('servers');
  return this.request<ChannelCategory>(`/servers/${serverId}/categories/${categoryId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.deleteCategory = async function(this: APIClient, serverId: string, categoryId: string): Promise<void> {
  this.invalidateCache('servers');
  await this.request(`/servers/${serverId}/categories/${categoryId}`, { method: 'DELETE' });
};

APIClient.prototype.reorderChannels = async function(this: APIClient, serverId: string, channels: Array<{ id: string; position: number; categoryId: string | null }>): Promise<void> {
  this.invalidateCache('servers');
  await this.request(`/servers/${serverId}/channels/reorder`, {
    method: 'PUT',
    body: JSON.stringify({ channels }),
  });
};

APIClient.prototype.reorderCategories = async function(this: APIClient, serverId: string, categories: Array<{ id: string; position: number }>): Promise<void> {
  this.invalidateCache('servers');
  await this.request(`/servers/${serverId}/categories/reorder`, {
    method: 'PUT',
    body: JSON.stringify({ categories }),
  });
};

APIClient.prototype.setServerOrder = async function(this: APIClient, serverIds: string[]): Promise<void> {
  this.invalidateCache('servers');
  await this.request('/servers/me/order', {
    method: 'PUT',
    body: JSON.stringify({ serverIds }),
  });
};

APIClient.prototype.resolveInvite = async function(this: APIClient, code: string): Promise<InvitePreview> {
  const data = await this.request<InvitePreview>(`/invites/${encodeURIComponent(code)}/preview`);
  return {
    ...data,
    serverIcon: this.resolveAssetUrl(data.serverIcon) ?? null,
    serverBanner: data.serverBanner?.startsWith('#') ? data.serverBanner : (this.resolveAssetUrl(data.serverBanner) ?? null),
  };
};
