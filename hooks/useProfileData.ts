// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect } from 'react';
import { apiClient } from '../services/api';
import type { ShowcaseData } from '../services/api/gameAccounts';
import type { MutualFriend, MutualServer, ActivityHistoryEntry, UserProfileData } from '../types';

export interface SpotifyProfile {
  connected: boolean;
  displayName?: string;
  topArtists?: Array<{ id: string; name: string; genres: string[]; imageUrl: string | null; externalUrl: string; popularity: number }>;
  topTracks?: Array<{ id: string; name: string; artists: string[]; album: string; albumArt: string | null; durationMs: number; externalUrl: string; previewUrl: string | null }>;
}

export interface ProfileDataResult {
  showcaseData: ShowcaseData | null;
  showcaseLoading: boolean;
  mutualFriends: MutualFriend[];
  mutualServers: MutualServer[];
  activityHistory: ActivityHistoryEntry[];
  profileData: UserProfileData | null;
  loading: boolean;
  spotifyProfile: SpotifyProfile | null;
}

export function useProfileData(userId: string, opts?: { isSelf?: boolean; serverId?: string }): ProfileDataResult {
  const isSelf = opts?.isSelf ?? false;
  const serverId = opts?.serverId;

  const [showcaseData, setShowcaseData] = useState<ShowcaseData | null>(null);
  const [showcaseLoading, setShowcaseLoading] = useState(true);
  const [mutualFriends, setMutualFriends] = useState<MutualFriend[]>([]);
  const [mutualServers, setMutualServers] = useState<MutualServer[]>([]);
  const [activityHistory, setActivityHistory] = useState<ActivityHistoryEntry[]>([]);
  const [profileData, setProfileData] = useState<UserProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [spotifyProfile, setSpotifyProfile] = useState<SpotifyProfile | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Reset so a switch between users never shows the previous user's data.
    setShowcaseData(null);
    setShowcaseLoading(true);
    setProfileData(null);
    setMutualFriends([]);
    setMutualServers([]);
    setLoading(true);

    apiClient.getSpotifyProfile(userId)
      .then(d => { if (!cancelled) setSpotifyProfile(d as SpotifyProfile); })
      .catch(() => { if (!cancelled) setSpotifyProfile(null); });
    apiClient.getShowcase(userId)
      .then(d => { if (!cancelled) { setShowcaseData(d); setShowcaseLoading(false); } })
      .catch(() => { if (!cancelled) { setShowcaseData(null); setShowcaseLoading(false); } });

    if (isSelf) {
      apiClient.activityHistory().then(h => { if (!cancelled) setActivityHistory(h); }).catch(() => {});
      apiClient.getUserProfile(userId, serverId).then(p => { if (!cancelled) setProfileData(p); }).catch(() => {});
      if (!cancelled) setLoading(false);
      return () => { cancelled = true; };
    }

    Promise.all([
      apiClient.getUserMutuals(userId).catch(() => ({ mutualFriends: [] as MutualFriend[], mutualServers: [] as MutualServer[] })),
      apiClient.getUserActivityHistory(userId).catch(() => [] as ActivityHistoryEntry[]),
      apiClient.getUserProfile(userId, serverId).catch(() => null),
    ]).then(([mutuals, history, profile]) => {
      if (cancelled) return;
      setMutualFriends(mutuals.mutualFriends);
      setMutualServers(mutuals.mutualServers);
      setActivityHistory(history);
      if (profile) setProfileData(profile);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [userId, isSelf, serverId]);

  return { showcaseData, showcaseLoading, mutualFriends, mutualServers, activityHistory, profileData, loading, spotifyProfile };
}
