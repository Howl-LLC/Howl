// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { User, GameActivity, ActivityHistoryEntry, MutualsResponse, UserProfileData } from '../../types';
import { API_BASE_URL } from '../../config';
import type { BackendUser, UserPreferences } from '../apiTypes';
import { getProtocolHeaders } from './protocolHeaders';

declare module './core' {
  interface APIClient {
    updateMyStatus(status: 'online' | 'idle' | 'dnd' | 'invisible' | 'offline'): Promise<void>;
    setDateOfBirth(dateOfBirth: string): Promise<void>;
    updateMeProfile(data: { username?: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null; avatarEffect?: string | null; backgroundImage?: string | null; backgroundOpacity?: number; backgroundBlur?: number; bgGifAlwaysPlay?: boolean; activityBio?: string | null }): Promise<User>;
    getPreferences(): Promise<UserPreferences>;
    updatePreferences(prefs: Partial<UserPreferences>): Promise<UserPreferences>;
    getMyActivity(): Promise<GameActivity | null>;
    setActivity(activity: { type: string; name: string; details?: string; state?: string }): Promise<GameActivity>;
    clearActivity(): Promise<void>;
    getFriendActivities(): Promise<Array<{ userId: string; activity: GameActivity }>>;
    getUserActivity(userId: string): Promise<GameActivity | null>;
    getActivityServers(): Promise<Array<{ serverId: string; serverName: string; serverIcon: string | null; memberCount: number; shareActivity: boolean | null }>>;
    setServerActivitySharing(serverId: string, shareActivity: boolean | null): Promise<{ serverId: string; shareActivity: boolean | null }>;
    getCustomGames(): Promise<{ customGames: Array<{ exeName: string; displayName: string }> }>;
    setCustomGames(customGames: Array<{ exeName: string; displayName: string }>): Promise<{ customGames: Array<{ exeName: string; displayName: string }> }>;
    activityHistory(): Promise<ActivityHistoryEntry[]>;
    getUserProfile(userId: string, serverId?: string): Promise<UserProfileData>;
    getUserMutuals(userId: string): Promise<MutualsResponse>;
    getUserActivityHistory(userId: string): Promise<ActivityHistoryEntry[]>;
    getConnectedApps(): Promise<Array<{ id: string; provider: string; displayName: string | null; avatarUrl: string | null; scopes: string | null; createdAt: string }>>;
    disconnectApp(accountId: string): Promise<void>;
    getSpotifyNowPlaying(): Promise<{ playing: boolean; track?: { id: string; name: string; artists: string[]; album: string; albumArt: string; durationMs: number; progressMs: number; uri: string; externalUrl: string } }>;
    getSpotifyTopArtists(timeRange?: string, limit?: number): Promise<{ artists: Array<{ id: string; name: string; genres: string[]; imageUrl: string | null; externalUrl: string; popularity: number }> }>;
    getSpotifyTopTracks(timeRange?: string, limit?: number): Promise<{ tracks: Array<{ id: string; name: string; artists: string[]; album: string; albumArt: string | null; durationMs: number; externalUrl: string; previewUrl: string | null }> }>;
    getSpotifyRecentlyPlayed(limit?: number): Promise<{ tracks: Array<{ id: string; name: string; artists: string[]; album: string; albumArt: string | null; playedAt: string; durationMs: number; externalUrl: string }> }>;
    getSpotifyProfile(userId: string): Promise<{ connected: boolean; displayName?: string; topArtists?: Array<{ id: string; name: string; genres: string[]; imageUrl: string | null; externalUrl: string; popularity: number }>; topTracks?: Array<{ id: string; name: string; artists: string[]; album: string; albumArt: string | null; durationMs: number; externalUrl: string; previewUrl: string | null }> }>;
    getSpotifySharedTastes(userId: string): Promise<{ compatibilityScore: number; sharedArtists: Array<{ id: string; name: string; imageUrl: string | null }>; sharedTracks: Array<{ id: string; name: string; artists: string[]; albumArt: string | null }> }>;
    listenAlong(targetUserId: string): Promise<{ ok: boolean; track?: string; artist?: string; error?: string; code?: string }>;
    getSpotifyScopeCheck(): Promise<{ connected: boolean; scopes?: string[]; missingScopes?: string[] }>;
    getSpotifyConnectToken(): Promise<{ connectToken: string }>;
    getSpotifyPlaybackState(): Promise<{
      active: boolean;
      playing?: boolean;
      track?: {
        id: string;
        name: string;
        artists: string[];
        album: string;
        albumArt: string | null;
        durationMs: number;
        progressMs: number;
        uri: string;
        externalUrl: string | null;
      } | null;
      shuffle?: boolean;
      repeat?: 'off' | 'track' | 'context';
      device?: { name: string; type: string } | null;
      isPremium?: boolean;
    }>;
    spotifyPlayPause(action: 'play' | 'pause'): Promise<{ ok?: boolean; error?: string; code?: string }>;
    spotifyNext(): Promise<{ ok?: boolean; error?: string; code?: string }>;
    spotifyPrevious(): Promise<{ ok?: boolean; error?: string; code?: string }>;
    spotifyShuffle(state: boolean): Promise<{ ok?: boolean; error?: string; code?: string }>;
    spotifyRepeat(state: 'off' | 'track' | 'context'): Promise<{ ok?: boolean; error?: string; code?: string }>;
  }
}

APIClient.prototype.updateMyStatus = async function(this: APIClient, status: 'online' | 'idle' | 'dnd' | 'invisible' | 'offline'): Promise<void> {
  await this.request<{ status: string }>('/auth/me/status', {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
};

APIClient.prototype.setDateOfBirth = async function(this: APIClient, dateOfBirth: string): Promise<void> {
  const token = this.getToken();
  const res = await fetch(`${API_BASE_URL}/auth/me/date-of-birth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...await getProtocolHeaders(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: 'include',
    body: JSON.stringify({ dateOfBirth }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const details = data.details as Record<string, string[]> | undefined;
    const detailMsg = details && Object.values(details).flat()[0];
    throw new Error(detailMsg || data.error || 'Failed to save date of birth');
  }
};

APIClient.prototype.updateMeProfile = async function(this: APIClient, data: { username?: string; avatar?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null; avatarEffect?: string | null; backgroundImage?: string | null; backgroundOpacity?: number; backgroundBlur?: number; bgGifAlwaysPlay?: boolean; activityBio?: string | null }): Promise<User> {
  const res = await this.request<BackendUser>('/auth/me', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  return this.normalizeUser(res);
};

APIClient.prototype.getPreferences = async function(this: APIClient): Promise<UserPreferences> {
  return this.request('/auth/me/preferences');
};

APIClient.prototype.updatePreferences = async function(this: APIClient, prefs: Partial<UserPreferences>): Promise<UserPreferences> {
  return this.request('/auth/me/preferences', { method: 'PATCH', body: JSON.stringify(prefs) });
};

APIClient.prototype.getMyActivity = async function(this: APIClient): Promise<GameActivity | null> {
  const res = await this.request<{ userId: string; activity: GameActivity | null }>('/activity/me');
  return res.activity ?? null;
};

APIClient.prototype.setActivity = async function(this: APIClient, activity: { type: string; name: string; details?: string; state?: string }): Promise<GameActivity> {
  return this.request<GameActivity>('/activity', { method: 'PUT', body: JSON.stringify(activity) });
};

APIClient.prototype.clearActivity = async function(this: APIClient): Promise<void> {
  await this.request('/activity', { method: 'DELETE' });
};

APIClient.prototype.getFriendActivities = async function(this: APIClient): Promise<Array<{ userId: string; activity: GameActivity }>> {
  return this.request('/activity/friends');
};

APIClient.prototype.getUserActivity = async function(this: APIClient, userId: string): Promise<GameActivity | null> {
  const res = await this.request<{ userId: string; activity: GameActivity | null }>(`/activity/${encodeURIComponent(userId)}`);
  return res.activity ?? null;
};

APIClient.prototype.getActivityServers = async function(this: APIClient) {
  return this.request('/activity/servers');
};

APIClient.prototype.setServerActivitySharing = async function(this: APIClient, serverId: string, shareActivity: boolean | null) {
  return this.request(`/activity/servers/${encodeURIComponent(serverId)}`, { method: 'PATCH', body: JSON.stringify({ shareActivity }) });
};

APIClient.prototype.getCustomGames = async function(this: APIClient) {
  return this.request('/activity/custom-games');
};

APIClient.prototype.setCustomGames = async function(this: APIClient, customGames: Array<{ exeName: string; displayName: string }>) {
  return this.request('/activity/custom-games', { method: 'PUT', body: JSON.stringify({ customGames }) });
};

APIClient.prototype.activityHistory = async function(this: APIClient): Promise<ActivityHistoryEntry[]> {
  return this.request('/activity/history');
};

APIClient.prototype.getUserProfile = async function(this: APIClient, userId: string, serverId?: string): Promise<UserProfileData> {
  const params = serverId ? `?serverId=${encodeURIComponent(serverId)}` : '';
  const data = await this.request<UserProfileData>(`/users/${encodeURIComponent(userId)}/profile${params}`);
  if (data.banner) data.banner = this.resolveAssetUrl(data.banner) ?? data.banner;
  if (data.avatar) data.avatar = this.resolveAssetUrl(data.avatar) ?? data.avatar;
  return data;
};

APIClient.prototype.getUserMutuals = async function(this: APIClient, userId: string): Promise<MutualsResponse> {
  const data = await this.request<MutualsResponse>(`/users/${encodeURIComponent(userId)}/mutuals`);
  return {
    ...data,
    mutualFriends: data.mutualFriends.map(f => ({ ...f, avatar: this.resolveAssetUrl(f.avatar) ?? null })),
    mutualServers: data.mutualServers.map(s => ({ ...s, icon: this.resolveAssetUrl(s.icon) ?? null })),
  };
};

APIClient.prototype.getUserActivityHistory = async function(this: APIClient, userId: string): Promise<ActivityHistoryEntry[]> {
  return this.request(`/activity/${encodeURIComponent(userId)}/history`);
};

APIClient.prototype.getConnectedApps = async function(this: APIClient) {
  return this.request('/connected-apps/accounts');
};

APIClient.prototype.disconnectApp = async function(this: APIClient, accountId: string): Promise<void> {
  await this.request(`/connected-apps/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
};

APIClient.prototype.getSpotifyNowPlaying = async function(this: APIClient) {
  return this.request('/connected-apps/spotify/now-playing');
};

APIClient.prototype.getSpotifyTopArtists = async function(this: APIClient, timeRange?: string, limit?: number) {
  const params = new URLSearchParams();
  if (timeRange) params.set('time_range', timeRange);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return this.request(`/connected-apps/spotify/top-artists${qs ? `?${qs}` : ''}`);
};

APIClient.prototype.getSpotifyTopTracks = async function(this: APIClient, timeRange?: string, limit?: number) {
  const params = new URLSearchParams();
  if (timeRange) params.set('time_range', timeRange);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return this.request(`/connected-apps/spotify/top-tracks${qs ? `?${qs}` : ''}`);
};

APIClient.prototype.getSpotifyRecentlyPlayed = async function(this: APIClient, limit?: number) {
  const qs = limit ? `?limit=${limit}` : '';
  return this.request(`/connected-apps/spotify/recently-played${qs}`);
};

APIClient.prototype.getSpotifyProfile = async function(this: APIClient, userId: string) {
  return this.request(`/connected-apps/spotify/profile/${encodeURIComponent(userId)}`);
};

APIClient.prototype.getSpotifySharedTastes = async function(this: APIClient, userId: string) {
  return this.request(`/connected-apps/spotify/shared-tastes/${encodeURIComponent(userId)}`);
};

APIClient.prototype.listenAlong = async function(this: APIClient, targetUserId: string) {
  return this.request('/connected-apps/spotify/listen-along', {
    method: 'PUT',
    body: JSON.stringify({ targetUserId }),
  });
};

APIClient.prototype.getSpotifyScopeCheck = async function(this: APIClient) {
  return this.request('/connected-apps/spotify/scope-check');
};

APIClient.prototype.getSpotifyConnectToken = async function(this: APIClient) {
  return this.request('/connected-apps/spotify/connect-token', { method: 'POST' });
};

APIClient.prototype.getSpotifyPlaybackState = async function(this: APIClient) {
  return this.request('/connected-apps/spotify/playback-state');
};

APIClient.prototype.spotifyPlayPause = async function(this: APIClient, action: 'play' | 'pause') {
  return this.request('/connected-apps/spotify/playback/play-pause', {
    method: 'PUT',
    body: JSON.stringify({ action }),
  });
};

APIClient.prototype.spotifyNext = async function(this: APIClient) {
  return this.request('/connected-apps/spotify/playback/next', { method: 'POST' });
};

APIClient.prototype.spotifyPrevious = async function(this: APIClient) {
  return this.request('/connected-apps/spotify/playback/previous', { method: 'POST' });
};

APIClient.prototype.spotifyShuffle = async function(this: APIClient, state: boolean) {
  return this.request('/connected-apps/spotify/playback/shuffle', {
    method: 'PUT',
    body: JSON.stringify({ state }),
  });
};

APIClient.prototype.spotifyRepeat = async function(this: APIClient, state: 'off' | 'track' | 'context') {
  return this.request('/connected-apps/spotify/playback/repeat', {
    method: 'PUT',
    body: JSON.stringify({ state }),
  });
};
