// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';

export interface GameAccountData {
  id: string;
  game: string;
  provider: string;
  platformId: string;
  platform: string | null;
  displayName: string | null;
  verified: boolean;
  createdAt: string;
  rank: { tier: string; division: string | null; rating: number | null; imageUrl: string | null } | null;
  stats: Record<string, number | string | null> | null;
  lastFetched: string | null;
  nextRefreshAt: string | null;
  fetchError: string | null;
  errorRetryCount: number;
  errorTransient?: boolean;
  hasDisplayedCards?: boolean | null;
}

export interface SteamPlaytimeEntry {
  appId: number;
  name: string;
  hours: number;
  iconUrl: string | null;
}

export interface ShowcaseData {
  layout: ShowcaseCard[];
  mobileLayout: ShowcaseCard[] | null;
  gameAccounts: Array<{
    id: string;
    game: string;
    provider: string;
    displayName: string | null;
    verified: boolean;
    rank: GameAccountData['rank'];
    stats: GameAccountData['stats'];
    lastFetched: string | null;
    fetchError: string | null;
    errorRetryCount: number | null;
    errorTransient?: boolean | null;
    hasDisplayedCards?: boolean | null;
  }>;
  steamPlaytime: SteamPlaytimeEntry[];
  steamRecentActivity: SteamPlaytimeEntry[];
  hasSteamPlaytimeCard?: boolean | null;
  platformProfiles?: Record<string, {
    displayName: string | null;
    avatarUrl: string | null;
    profileData: Record<string, unknown> | null;
    profileFetchedAt: string | null;
  }>;
}

export interface ShowcaseCard {
  id: string;
  type: string;
  game?: string | null;
  size: string;
  position: number;
  color?: string | null;
  config?: Record<string, unknown>;
}

declare module './core' {
  interface APIClient {
    // Game accounts
    getGameAccounts(): Promise<GameAccountData[]>;
    linkGameAccount(data: { game: string; platformId: string; platform?: string | null; displayName?: string }): Promise<GameAccountData>;
    unlinkGameAccount(id: string): Promise<{ success: boolean }>;
    refreshGameAccount(id: string): Promise<{ success: boolean; rank: GameAccountData['rank']; stats: GameAccountData['stats']; lastFetched: string | null; nextRefreshAt: string | null; fetchError: string | null; errorRetryCount: number; errorTransient?: boolean }>;
    linkSteamGames(): Promise<{ success: boolean; games: string[]; created: string[] }>;

    // Showcase
    getShowcase(userId: string): Promise<ShowcaseData>;
    updateShowcaseLayout(layout: ShowcaseCard[]): Promise<{ layout: ShowcaseCard[] }>;
    updateMobileShowcaseLayout(layout: ShowcaseCard[]): Promise<{ mobileLayout: ShowcaseCard[] }>;
    deleteMobileShowcaseLayout(): Promise<{ mobileLayout: null }>;
    refreshSteamShowcase(): Promise<{ steamPlaytime: SteamPlaytimeEntry[]; steamRecentActivity: SteamPlaytimeEntry[]; fetchedAt: string }>;

    // OAuth connect tokens
    getRiotConnectToken(): Promise<{ connectToken: string }>;
    getEpicConnectToken(): Promise<{ connectToken: string }>;
    getTwitchConnectToken(): Promise<{ connectToken: string }>;
    getYouTubeConnectToken(): Promise<{ connectToken: string }>;
    getGitHubConnectToken(): Promise<{ connectToken: string }>;
    getRedditConnectToken(): Promise<{ connectToken: string }>;
    refreshConnectedAppProfile(accountId: string): Promise<{ success: boolean; profileData: unknown; profileFetchedAt: string | null; nextProfileRefreshAt: string | null }>;
  }
}

APIClient.prototype.getGameAccounts = async function(this: APIClient) {
  return this.request<GameAccountData[]>('/game-accounts');
};

APIClient.prototype.linkGameAccount = async function(this: APIClient, data) {
  return this.request<GameAccountData>('/game-accounts', { method: 'POST', body: JSON.stringify(data) });
};

APIClient.prototype.unlinkGameAccount = async function(this: APIClient, id) {
  return this.request<{ success: boolean }>(`/game-accounts/${id}`, { method: 'DELETE' });
};

APIClient.prototype.refreshGameAccount = async function(this: APIClient, id) {
  return this.request(`/game-accounts/${id}/refresh`, { method: 'POST' });
};

APIClient.prototype.linkSteamGames = async function(this: APIClient) {
  return this.request('/connected-apps/steam/link-games', { method: 'POST' });
};

APIClient.prototype.getShowcase = async function(this: APIClient, userId) {
  return this.request<ShowcaseData>(`/showcase/${userId}`);
};

APIClient.prototype.updateShowcaseLayout = async function(this: APIClient, layout) {
  return this.request<{ layout: ShowcaseCard[] }>('/showcase/layout', { method: 'PUT', body: JSON.stringify({ layout }) });
};

APIClient.prototype.updateMobileShowcaseLayout = async function(this: APIClient, layout) {
  return this.request<{ mobileLayout: ShowcaseCard[] }>('/showcase/mobile-layout', { method: 'PUT', body: JSON.stringify({ layout }) });
};

APIClient.prototype.deleteMobileShowcaseLayout = async function(this: APIClient) {
  return this.request<{ mobileLayout: null }>('/showcase/mobile-layout', { method: 'DELETE' });
};

APIClient.prototype.refreshSteamShowcase = async function(this: APIClient) {
  return this.request<{ steamPlaytime: SteamPlaytimeEntry[]; steamRecentActivity: SteamPlaytimeEntry[]; fetchedAt: string }>('/showcase/refresh-steam', { method: 'POST' });
};

APIClient.prototype.getRiotConnectToken = async function(this: APIClient) {
  return this.request<{ connectToken: string }>('/connected-apps/riot/connect-token', { method: 'POST' });
};

APIClient.prototype.getEpicConnectToken = async function(this: APIClient) {
  return this.request<{ connectToken: string }>('/connected-apps/epic/connect-token', { method: 'POST' });
};

APIClient.prototype.getTwitchConnectToken = async function(this: APIClient) {
  return this.request<{ connectToken: string }>('/connected-apps/twitch/connect-token', { method: 'POST' });
};

APIClient.prototype.getYouTubeConnectToken = async function(this: APIClient) {
  return this.request<{ connectToken: string }>('/connected-apps/youtube/connect-token', { method: 'POST' });
};

APIClient.prototype.getGitHubConnectToken = async function(this: APIClient) {
  return this.request<{ connectToken: string }>('/connected-apps/github/connect-token', { method: 'POST' });
};

APIClient.prototype.getRedditConnectToken = async function(this: APIClient) {
  return this.request<{ connectToken: string }>('/connected-apps/reddit/connect-token', { method: 'POST' });
};

APIClient.prototype.refreshConnectedAppProfile = async function(this: APIClient, accountId: string) {
  return this.request<{ success: boolean; profileData: unknown; profileFetchedAt: string | null; nextProfileRefreshAt: string | null }>(`/connected-apps/accounts/${accountId}/refresh-profile`, { method: 'POST' });
};
