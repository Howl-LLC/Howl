// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { Clock } from 'lucide-react';
import type { ShowcaseCard, ShowcaseData, SteamPlaytimeEntry } from '../../services/api/gameAccounts';
import type { GameActivity } from '../../types';

export type GameAccount = ShowcaseData['gameAccounts'][number];

export interface SpotifyData {
  connected: boolean;
  topArtists?: Array<{ id: string; name: string; imageUrl: string | null }>;
  topTracks?: Array<{ id: string; name: string; artists: string[]; albumArt: string | null }>;
}

export interface PlatformProfiles {
  twitch?: {
    displayName: string | null;
    avatarUrl: string | null;
    profileData: {
      displayName?: string;
      broadcasterType?: string;
      followers?: number | null;
      description?: string;
    } | null;
    profileFetchedAt: string | null;
  };
  youtube?: {
    displayName: string | null;
    avatarUrl: string | null;
    profileData: {
      title?: string;
      subscriberCount?: number | null;
      viewCount?: number;
      videoCount?: number;
    } | null;
    profileFetchedAt: string | null;
  };
  github?: {
    displayName: string | null;
    avatarUrl: string | null;
    profileData: {
      login?: string;
      name?: string;
      bio?: string;
      publicRepos?: number | null;
      followers?: number | null;
      following?: number | null;
      totalContributions?: number | null;
      contributionDays?: Array<{ date: string; count: number }> | null;
      topLanguages?: Array<{ name: string; count: number }> | null;
    } | null;
    profileFetchedAt: string | null;
  };
  reddit?: {
    displayName: string | null;
    avatarUrl: string | null;
    profileData: {
      username?: string;
      linkKarma?: number | null;
      commentKarma?: number | null;
      totalKarma?: number | null;
      createdUtc?: number | null;
      moderatedSubs?: Array<{ name: string; subscribers: number }>;
    } | null;
    profileFetchedAt: string | null;
  };
}

export const GAME_COLORS: Record<string, string> = {
  valorant: 'rgba(255,70,85,0.7)',
  cs2: 'rgba(255,165,0,0.7)',
  lol: 'rgba(0,120,215,0.7)',
  tft: 'rgba(180,100,255,0.7)',
  dota2: 'rgba(220,50,50,0.7)',
  fortnite: 'rgba(0,150,255,0.7)',
  apex: 'rgba(220,50,50,0.7)',
  marvel_rivals: 'rgba(255,180,0,0.7)',
  r6_siege: 'rgba(60,160,220,0.7)',
};

export const GAME_NAMES: Record<string, string> = {
  valorant: 'Valorant',
  cs2: 'CS2',
  lol: 'League of Legends',
  tft: 'TFT',
  dota2: 'Dota 2',
  fortnite: 'Fortnite',
  apex: 'Apex Legends',
  marvel_rivals: 'Marvel Rivals',
  r6_siege: 'Rainbow Six Siege',
};

const STAT_LABELS: Record<string, string> = {
  kd: 'K/D', winRate: 'Win Rate', headshotPct: 'HS%', hoursPlayed: 'Hours',
  kills: 'Kills', deaths: 'Deaths', wins: 'Wins', losses: 'Losses',
  matches: 'Matches', rounds: 'Rounds', mvps: 'MVPs', assists: 'Assists',
  level: 'Level', lp: 'LP', rr: 'RR', elo: 'ELO', mmr: 'MMR',
  damage: 'Damage', rankPoints: 'ELO', peakRank: 'Peak',
  peakRankPoints: 'Peak ELO', seasonId: 'Season',
};

function formatStatValue(key: string, value: number | string | null | undefined): string {
  if (value == null) return '--';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return String(value);

  // K/D ratios — always show 2 decimal places
  if (key === 'kd') return num.toFixed(2);

  // Percentages — show 1 decimal place with %
  if (key === 'winRate' || key === 'headshotPct') return `${num.toFixed(1)}%`;

  // Hours
  if (key === 'hoursPlayed') return `${num.toLocaleString()}h`;

  // Large numbers — add commas
  if (Number.isInteger(num) && num >= 1000) return num.toLocaleString();

  // Decimals that aren't K/D
  if (!Number.isInteger(num)) return num.toFixed(1);

  return String(num);
}

function getMaxGames(size: string): number {
  const [, rows] = size.split('x').map(Number);
  if (rows >= 2) return 7;
  return 3;
}

export const DATA_PROVIDERS: Record<string, { name: string; url: string }> = {
  apex: { name: 'Apex Legends Status', url: 'https://apexlegendsstatus.com' },
  dota2: { name: 'OpenDota', url: 'https://opendota.com' },
  fortnite: { name: 'Fortnite-API.com', url: 'https://fortnite-api.com' },
  marvel_rivals: { name: 'MarvelRivalsAPI', url: 'https://marvelrivalsapi.com' },
  r6_siege: { name: 'R6Data', url: 'https://r6data.eu' },
};

// Inline Spotify SVG to avoid importing from icons (keeps this module lightweight)
function SpotifySvg({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 496 512" fill="#1DB954">
      <path d="M248 8C111.1 8 0 119.1 0 256s111.1 248 248 248 248-111.1 248-248S384.9 8 248 8zm100.7 364.9c-4.2 6.6-12.9 8.6-19.5 4.4-53.5-32.7-120.8-40.1-200.1-22-7.6 1.7-15.3-3-17-10.7-1.7-7.6 3-15.3 10.7-17 86.7-19.8 161.1-11.3 221.1 25.5 6.6 4.1 8.6 12.8 4.4 19.4l.4-.6zm26.8-68.9c-5.2 8.4-16.2 11-24.6 5.8-61.2-37.6-154.5-48.5-226.9-26.5-9.2 2.8-18.9-2.4-21.7-11.6-2.8-9.2 2.4-18.9 11.6-21.7 82.6-25.2 185.3-13 254.4 30.3 8.4 5.1 11 16.2 5.8 24.6l.4-1zm2.3-71.8C310.6 196.3 180.5 192 105 213.4c-11 3.4-22.7-2.8-26.1-13.8-3.4-11 2.8-22.7 13.8-26.1 86.7-24.6 230.7-19.9 321.9 30.2 9.9 5.9 13.1 18.8 7.2 28.7-5.9 9.9-18.8 13.1-28.7 7.2l-.3-.3z"/>
    </svg>
  );
}

// Card content renderers

export function GameRankCard({ card, account, accent }: { card: ShowcaseCard; account: GameAccount | undefined; accent: string }) {
  const gameName = card.game ? GAME_NAMES[card.game] || card.game : '';
  const rank = account?.rank;
  const [cols, rows] = (card.size || '1x1').split('x').map(Number);
  const isMulti = cols > 1 || rows > 1;

  // Parse season data if available (both R6 and MR store seasons as JSON string in stats)
  let seasons: Array<{
    seasonId: number;
    seasonName?: string | null;
    seasonFullName?: string | null;
    rankName: string | null;
    rankPoints?: number;
    rankScore?: number;
    imageUrl?: string | null;
    color?: string | null;
    kills?: number;
    deaths?: number;
    wins?: number;
    losses?: number;
  }> = [];
  if (account?.stats?.seasons) {
    try {
      seasons = JSON.parse(account.stats.seasons as string);
    } catch { /* ignore parse errors */ }
  }

  // For 1x1: use season selector — works for any game with seasons data
  let displayRank = rank;
  if (!isMulti && card.config?.seasonId && seasons.length > 0) {
    const selected = seasons.find(s => s.seasonId === card.config?.seasonId);
    if (selected) {
      const isCurrent = selected.seasonId === seasons[0]?.seasonId;
      displayRank = {
        tier: selected.rankName || `Season ${selected.seasonId}`,
        division: null,
        rating: selected.rankPoints ?? selected.rankScore ?? null,
        imageUrl: isCurrent ? (rank?.imageUrl || selected.imageUrl || null) : (selected.imageUrl || rank?.imageUrl || null),
      };
    }
  }

  // How many seasons to show based on card dimensions
  const getSeasonCount = (): number => {
    if (cols >= 3 && rows >= 2) return 6;
    if (cols >= 3) return 3;
    if (cols >= 2 && rows >= 2) return 4;
    if (rows >= 3) return 5;
    if (cols >= 2) return 2;
    if (rows >= 2) return 4;
    return 1;
  };

  // Multi-size: show side-by-side seasons
  if (isMulti && seasons.length > 1) {
    const maxCount = getSeasonCount();

    // If user selected specific seasons, use those; otherwise default to most recent N
    const selectedIds = card.config?.selectedSeasons as number[] | undefined;
    let displaySeasons: typeof seasons;
    if (selectedIds && selectedIds.length > 0) {
      displaySeasons = seasons.filter(s => selectedIds.includes(s.seasonId)).slice(0, maxCount);
    } else {
      displaySeasons = seasons.slice(0, maxCount);
    }

    // Reverse to chronological order: oldest on left, current on right
    const chronological = [...displaySeasons].reverse();

    const useFlexRow = cols >= rows;

    return (
      <>
        <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: accent, opacity: 0.5 }}>
          {gameName}
        </span>
        <div
          className="flex-1 overflow-hidden"
          style={{
            display: useFlexRow ? 'flex' : 'grid',
            ...(useFlexRow
              ? { alignItems: 'center', justifyContent: 'center', gap: '8px' }
              : { gridTemplateColumns: `repeat(${Math.min(chronological.length, 2)}, 1fr)`, gap: '6px', alignContent: 'center' }),
          }}
        >
          {chronological.map((s) => {
            const isCurrent = s.seasonId === seasons[0]?.seasonId;
            const name = s.rankName || `S${s.seasonId}`;
            const pts = s.rankPoints ?? s.rankScore ?? null;
            const seasonImg = isCurrent ? (rank?.imageUrl || s.imageUrl) : s.imageUrl;

            return (
              <div
                key={s.seasonId}
                className="flex flex-col items-center gap-1"
                style={{ padding: '6px', borderRadius: '12px', flex: useFlexRow ? '1' : undefined }}
              >
                <span className="text-[7px] font-semibold" style={{ color: isCurrent ? 'rgba(102,192,244,0.5)' : 'var(--t-secondary)' }}>
                  {s.seasonName || `S${s.seasonId}`}{isCurrent ? ' · NOW' : ''}
                </span>
                {seasonImg ? (
                  <img src={seasonImg} alt="" className="object-contain" loading="lazy" decoding="async" style={{ width: '28px', height: '28px' }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <div
                    className="rounded-lg flex items-center justify-center font-bold"
                    style={{ width: '28px', height: '28px', backgroundColor: `color-mix(in srgb, ${accent} 12%, transparent)`, color: accent, fontSize: '10px' }}
                  >
                    {name.slice(0, 3)}
                  </div>
                )}
                <span className="text-center font-semibold truncate w-full" style={{ fontSize: '10px', color: 'var(--t-primary)' }}>
                  {name}
                </span>
                {pts != null && (
                  <span className="text-[8px]" style={{ color: 'var(--t-secondary)' }}>{pts.toLocaleString()} pts</span>
                )}
              </div>
            );
          })}
        </div>
      </>
    );
  }

  // Single rank display (1×1 or no season data)
  return (
    <>
      <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: accent, opacity: 0.5 }}>
        {gameName}
      </span>
      <div className="flex-1 flex flex-col items-center justify-center gap-1.5">
        {displayRank ? (
          <>
            {displayRank.imageUrl ? (
              <img src={displayRank.imageUrl} alt="" className="w-10 h-10 object-contain" loading="lazy" decoding="async" width={40} height={40} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            ) : (
              <div className="w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold" style={{ backgroundColor: `color-mix(in srgb, ${accent} 12%, transparent)`, color: accent }}>
                {displayRank.tier.slice(0, 2)}
              </div>
            )}
            <div className="text-center">
              <p className="text-xs font-bold" style={{ color: 'var(--t-primary)' }}>
                {displayRank.tier}{displayRank.division ? ` ${displayRank.division}` : ''}
              </p>
              {displayRank.rating != null && (
                <p className="text-[9px]" style={{ color: 'var(--t-secondary)' }}>{displayRank.rating.toLocaleString()} pts</p>
              )}
            </div>
          </>
        ) : (
          <div className="text-center" style={{ opacity: 0.3 }}>
            <p className="text-[10px]">{account?.stats ? 'Unranked' : 'No data yet'}</p>
            {!account?.stats && <p className="text-[8px] mt-1">Stats appear after refresh</p>}
          </div>
        )}
      </div>
    </>
  );
}

export function GameStatsCard({ card, account, accent }: { card: ShowcaseCard; account: GameAccount | undefined; accent: string }) {
  const gameName = card.game ? GAME_NAMES[card.game] || card.game : '';
  const stats = account?.stats;
  const rawKeys = (card.config?.stats as string[] | undefined) || Object.keys(stats || {}).slice(0, 4);
  const statKeys = rawKeys.filter(k => stats && k in stats && stats[k] != null);

  const isLifetime = card.game === 'cs2' || card.game === 'fortnite';

  return (
    <>
      <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: accent, opacity: 0.5 }}>
        {gameName} Stats{isLifetime ? ' · Lifetime' : ''}
      </span>
      <div className="flex-1 flex items-center justify-center gap-0">
        {statKeys.map((key, i) => {
          const val = stats?.[key];
          const display = formatStatValue(key, val);
          return (
            <React.Fragment key={key}>
              {i > 0 && <div className="w-px h-8 mx-3" style={{ backgroundColor: 'var(--border-subtle)' }} />}
              <div className="text-center">
                <p className="text-lg font-bold leading-tight" style={{ color: `color-mix(in srgb, ${accent} 80%, white)` }}>{display}</p>
                <p className="text-[9px] mt-0.5" style={{ color: 'var(--t-secondary)' }}>{STAT_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')}</p>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </>
  );
}

export function SpotifyArtistsCard({ spotifyData }: { spotifyData?: SpotifyData | null }) {
  const artists = spotifyData?.topArtists?.slice(0, 5) || [];
  return (
    <>
      <div className="flex items-center gap-1.5 mb-2">
        <SpotifySvg size={10} />
        <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: '#1DB954', opacity: 0.6 }}>Top Artists</span>
      </div>
      <div className="flex-1 flex items-center gap-3 overflow-hidden">
        {artists.length > 0 ? artists.map(a => (
          <div key={a.id} className="flex flex-col items-center gap-1 shrink-0">
            {a.imageUrl ? (
              <img src={a.imageUrl} alt="" className="w-11 h-11 rounded-full object-cover" loading="lazy" decoding="async" width={44} height={44} />
            ) : (
              <div className="w-11 h-11 rounded-full flex items-center justify-center text-xs font-bold" style={{ backgroundColor: 'rgba(29,185,52,0.15)', color: '#1DB954' }}>
                {a.name[0]}
              </div>
            )}
            <span className="text-[9px] text-center max-w-[52px] truncate" style={{ color: 'var(--t-secondary)' }}>{a.name}</span>
          </div>
        )) : (
          <p className="text-[11px]" style={{ color: 'var(--t-tertiary)' }}>No data</p>
        )}
      </div>
    </>
  );
}

export function SpotifyTracksCard({ spotifyData }: { spotifyData?: SpotifyData | null }) {
  const tracks = spotifyData?.topTracks?.slice(0, 6) || [];
  return (
    <>
      <div className="flex items-center gap-1.5 mb-2">
        <SpotifySvg size={10} />
        <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: '#1DB954', opacity: 0.6 }}>Top Tracks</span>
      </div>
      <div className="flex-1 flex flex-col gap-1 overflow-hidden">
        {tracks.length > 0 ? tracks.map((t, i) => (
          <div key={t.id} className="flex items-center gap-2 min-w-0">
            <span className="text-[9px] w-3 text-right shrink-0" style={{ color: 'var(--t-tertiary)' }}>{i + 1}</span>
            {t.albumArt ? (
              <img src={t.albumArt} alt="" className="w-5 h-5 rounded-lg shrink-0" loading="lazy" decoding="async" width={20} height={20} />
            ) : (
              <div className="w-5 h-5 rounded-lg shrink-0" style={{ backgroundColor: 'rgba(29,185,52,0.1)' }} />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[10px] truncate" style={{ color: 'var(--t-primary)' }}>{t.name}</p>
              <p className="text-[8px] truncate" style={{ color: 'var(--t-secondary)' }}>{t.artists.join(', ')}</p>
            </div>
          </div>
        )) : (
          <p className="text-[11px]" style={{ color: 'var(--t-tertiary)' }}>No data</p>
        )}
      </div>
    </>
  );
}

export function SpotifyNowPlayingCard({ activity }: { activity?: GameActivity | null }) {
  if (!activity || activity.type !== 'spotify') {
    return (
      <>
        <div className="flex items-center gap-1.5 mb-2">
          <SpotifySvg size={10} />
          <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: '#1DB954', opacity: 0.6 }}>Now Playing</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[10px] text-center" style={{ color: 'var(--t-tertiary)' }}>Shows your current track when Spotify is playing</p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="flex items-center gap-1.5 mb-2">
        <SpotifySvg size={10} />
        <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: '#1DB954', opacity: 0.6 }}>Now Playing</span>
      </div>
      <div className="flex-1 flex items-center gap-3">
        {activity.largeImage && (
          <img src={activity.largeImage} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" loading="lazy" decoding="async" width={48} height={48} />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold truncate" style={{ color: 'var(--t-primary)' }}>{activity.name}</p>
          {activity.state && (
            <p className="text-[10px] truncate" style={{ color: 'var(--t-secondary)' }}>{activity.state}</p>
          )}
          {activity.details && (
            <p className="text-[9px] truncate" style={{ color: 'var(--t-secondary)' }}>{activity.details}</p>
          )}
        </div>
      </div>
    </>
  );
}

export function SteamPlaytimeCard({ card, playtime }: { card: ShowcaseCard; playtime?: SteamPlaytimeEntry[] }) {
  const games = playtime ?? [];
  const selectedAppId = card.config?.selectedAppId as number | undefined;
  const selectedGame = selectedAppId ? games.find(g => g.appId === selectedAppId) : null;

  if (selectedGame) {
    return (
      <>
        <div className="flex items-center gap-1.5 mb-2">
          <Clock size={10} style={{ color: 'var(--t-secondary)' }} />
          <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--t-secondary)' }}>Steam Playtime · Lifetime</span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-2">
          {selectedGame.iconUrl && (
            <img src={selectedGame.iconUrl} alt="" className="w-8 h-8 rounded-lg" loading="lazy" decoding="async" width={32} height={32} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          )}
          <div className="text-center">
            <p className="text-[11px] font-medium" style={{ color: 'var(--t-primary)' }}>{selectedGame.name}</p>
            <p className="text-2xl font-bold mt-1" style={{ color: 'rgba(102,192,244,0.9)' }}>{selectedGame.hours.toLocaleString()}h</p>
          </div>
        </div>
      </>
    );
  }

  const topGames = games.slice(0, getMaxGames(card.size));
  const maxHours = Math.max(...topGames.map(g => g.hours), 1);
  return (
    <>
      <div className="flex items-center gap-1.5 mb-2">
        <Clock size={10} style={{ color: 'var(--t-secondary)' }} />
        <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--t-secondary)' }}>Steam Playtime · Lifetime</span>
      </div>
      <div className="flex-1 flex flex-col justify-center gap-1.5 overflow-hidden">
        {topGames.length > 0 ? topGames.map(g => (
          <div key={g.appId} className="flex items-center gap-2">
            {g.iconUrl && <img src={g.iconUrl} alt="" className="w-4 h-4 rounded-lg shrink-0" loading="lazy" decoding="async" width={16} height={16} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[9px] truncate" style={{ color: 'var(--t-secondary)' }}>{g.name}</span>
                <span className="text-[8px] shrink-0 ml-1" style={{ color: 'var(--t-secondary)' }}>{g.hours.toLocaleString()}h</span>
              </div>
              <div className="h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--fill-hover)' }}>
                <div className="h-full rounded-full" style={{ width: `${(g.hours / maxHours) * 100}%`, backgroundColor: 'rgba(102,192,244,0.5)' }} />
              </div>
            </div>
          </div>
        )) : (
          <p className="text-[10px] text-center flex-1 flex items-center justify-center" style={{ color: 'var(--t-tertiary)' }}>No playtime data</p>
        )}
      </div>
    </>
  );
}

export function SteamRecentCard({ card, playtime }: { card: ShowcaseCard; playtime?: SteamPlaytimeEntry[] }) {
  const maxGames = getMaxGames(card.size);
  const games = (playtime ?? []).slice(0, maxGames);
  const maxHours = Math.max(...games.map(g => g.hours), 1);

  return (
    <>
      <div className="flex items-center gap-1.5 mb-2">
        <Clock size={10} style={{ color: 'var(--t-secondary)' }} />
        <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--t-secondary)' }}>Steam · Recent Activity</span>
      </div>
      <div className="flex-1 flex flex-col justify-center gap-1.5 overflow-hidden">
        {games.length > 0 ? games.map(g => (
          <div key={g.appId} className="flex items-center gap-2">
            {g.iconUrl && <img src={g.iconUrl} alt="" className="w-4 h-4 rounded-lg shrink-0" loading="lazy" decoding="async" width={16} height={16} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[9px] truncate" style={{ color: 'var(--t-secondary)' }}>{g.name}</span>
                <span className="text-[8px] shrink-0 ml-1" style={{ color: 'var(--t-secondary)' }}>{g.hours}h</span>
              </div>
              <div className="h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--fill-hover)' }}>
                <div className="h-full rounded-full" style={{ width: `${(g.hours / maxHours) * 100}%`, backgroundColor: 'rgba(102,192,244,0.5)' }} />
              </div>
            </div>
          </div>
        )) : (
          <p className="text-[10px] text-center flex-1 flex items-center justify-center" style={{ color: 'var(--t-tertiary)' }}>No recent activity</p>
        )}
      </div>
    </>
  );
}

export function RankTimelineCard({ card, account, accent }: { card: ShowcaseCard; account: GameAccount | undefined; accent: string }) {
  const gameName = card.game ? GAME_NAMES[card.game] || card.game : '';
  const [cols, rows] = (card.size || '2x1').split('x').map(Number);
  const isVertical = rows > cols;

  let seasons: Array<{
    seasonId: number;
    seasonName?: string | null;
    seasonFullName?: string | null;
    rankName: string | null;
    rankPoints?: number;
    rankScore?: number;
    imageUrl?: string | null;
    color?: string | null;
    kills?: number;
    deaths?: number;
    wins?: number;
    losses?: number;
  }> = [];
  if (account?.stats?.seasons) {
    try {
      seasons = JSON.parse(account.stats.seasons as string);
    } catch { /* ignore */ }
  }

  // Scale season count to card size
  const getTimelineCount = (): number => {
    if (isVertical) {
      if (rows >= 3) return 6;
      return 4;
    }
    if (cols >= 3) return 5;
    return 3;
  };

  const count = getTimelineCount();
  const displaySeasons = seasons.slice(0, count);

  // Empty state
  if (displaySeasons.length === 0) {
    return (
      <>
        <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: accent, opacity: 0.5 }}>
          {gameName} · Rank Timeline
        </span>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[10px]" style={{ color: 'var(--t-tertiary)' }}>No season data. Refresh stats</p>
        </div>
      </>
    );
  }

  // Vertical timeline (tall cards: 1×2, 1×3, 2×2, 2×3)
  if (isVertical) {
    return (
      <>
        <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: accent, opacity: 0.5 }}>
          {gameName} · Rank Timeline
        </span>
        <div className="flex-1 flex flex-col justify-center overflow-hidden" style={{ padding: '4px 8px', gap: '0' }}>
          {displaySeasons.map((s, i) => {
            const isCurrent = i === 0;
            const name = s.rankName || `S${s.seasonId}`;
            const pts = s.rankPoints ?? s.rankScore ?? null;
            const seasonImg = isCurrent ? (account?.rank?.imageUrl || s.imageUrl) : s.imageUrl;

            return (
              <React.Fragment key={s.seasonId}>
                {i > 0 && (
                  <div style={{ width: '2px', height: '5px', background: 'var(--border-subtle)', marginLeft: '18px' }} />
                )}
                <div
                  className="flex items-center gap-3"
                  style={{ padding: '4px 8px', borderRadius: '12px' }}
                >
                  {seasonImg ? (
                    <img src={seasonImg} alt="" className="object-contain shrink-0" loading="lazy" decoding="async" style={{ width: '28px', height: '28px' }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  ) : (
                    <div
                      className="rounded-full flex items-center justify-center font-bold shrink-0"
                      style={{
                        width: '28px',
                        height: '28px',
                        backgroundColor: `color-mix(in srgb, ${accent} 15%, transparent)`,
                        border: `2px solid color-mix(in srgb, ${accent} 30%, transparent)`,
                        color: accent,
                        fontSize: '9px',
                      }}
                    >
                      {name.slice(0, 2)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <span className="font-semibold block truncate" style={{ fontSize: '11px', color: 'var(--t-primary)' }}>
                      {name}
                    </span>
                    <span className="text-[8px]" style={{ color: 'var(--t-secondary)' }}>
                      {s.seasonName || `S${s.seasonId}`}{pts != null ? ` · ${pts.toLocaleString()} pts` : ''}
                    </span>
                  </div>
                  {isCurrent && (
                    <span className="text-[7px] font-semibold shrink-0" style={{ color: 'rgba(102,192,244,0.4)' }}>NOW</span>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </>
    );
  }

  // Horizontal timeline (wide cards: 2×1, 3×1, 3×2)
  // Seasons are stored newest-first, but timeline reads left-to-right (oldest → newest)
  const reversed = displaySeasons.slice().reverse();

  return (
    <>
      <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: accent, opacity: 0.5 }}>
        {gameName} · Rank Timeline
      </span>
      <div className="flex-1 flex flex-col justify-center overflow-hidden" style={{ padding: '0 8px' }}>
        {/* Timeline dots row */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
          {/* Connecting line */}
          <div style={{ position: 'absolute', top: '50%', left: '12px', right: '12px', height: '2px', background: 'var(--border-subtle)', transform: 'translateY(-50%)', zIndex: 0 }} />
          {reversed.map((s, reverseIdx) => {
            const originalIdx = displaySeasons.length - 1 - reverseIdx;
            const isCurrent = originalIdx === 0;
            const seasonImg = isCurrent ? (account?.rank?.imageUrl || s.imageUrl) : s.imageUrl;
            const name = s.rankName || `S${s.seasonId}`;
            return (
              <div key={s.seasonId} style={{ zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                {seasonImg ? (
                  <img src={seasonImg} alt="" className="object-contain" loading="lazy" decoding="async" style={{ width: '28px', height: '28px' }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <div
                    className="rounded-full flex items-center justify-center font-bold"
                    style={{
                      width: '28px',
                      height: '28px',
                      backgroundColor: `color-mix(in srgb, ${accent} 15%, transparent)`,
                      border: `2px solid color-mix(in srgb, ${accent} 30%, transparent)`,
                      color: accent,
                      fontSize: '8px',
                    }}
                  >
                    {name.slice(0, 2)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {/* Labels row */}
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          {reversed.map((s, reverseIdx) => {
            const originalIdx = displaySeasons.length - 1 - reverseIdx;
            const isCurrent = originalIdx === 0;
            const name = s.rankName || `S${s.seasonId}`;
            const pts = s.rankPoints ?? s.rankScore ?? null;
            return (
              <div key={s.seasonId} style={{ textAlign: 'center', minWidth: 0, flex: '1' }}>
                <span className="block" style={{ fontSize: '7px', color: isCurrent ? 'rgba(102,192,244,0.4)' : 'var(--t-secondary)' }}>
                  {s.seasonName || `S${s.seasonId}`}
                </span>
                <span className="block font-semibold truncate" style={{ fontSize: '9px', color: 'var(--t-primary)' }}>
                  {name}
                </span>
                {pts != null && (
                  <span className="block" style={{ fontSize: '7px', color: 'var(--t-secondary)' }}>{pts.toLocaleString()} pts</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

export function CustomTextCard({ card }: { card: ShowcaseCard }) {
  const text = (card.config?.text as string) || '';
  return (
    <p className="text-xs leading-relaxed" style={{ color: 'var(--t-secondary)' }}>
      {text || 'Empty card'}
    </p>
  );
}

// Platform Profile Cards

function formatCount(n: number | null | undefined) {
  if (n == null) return '–';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function TwitchStatsCard({ profiles }: { profiles?: PlatformProfiles | null }) {
  const data = profiles?.twitch?.profileData;
  if (!data) return <p className="text-[10px]" style={{ color: 'var(--t-tertiary)' }}>Connect Twitch in Settings → Linked Apps</p>;

  return (
    <>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: 'rgba(145,70,255,0.5)' }}>Twitch</span>
        {data.broadcasterType === 'partner' && (
          <span className="text-[7px] font-bold uppercase px-1 py-0.5 rounded-lg" style={{ backgroundColor: 'rgba(145,70,255,0.15)', color: '#9146FF' }}>Partner</span>
        )}
        {data.broadcasterType === 'affiliate' && (
          <span className="text-[7px] font-bold uppercase px-1 py-0.5 rounded-lg" style={{ backgroundColor: 'rgba(145,70,255,0.1)', color: 'rgba(145,70,255,0.7)' }}>Affiliate</span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <div className="text-center">
          <span className="text-base font-bold block" style={{ color: 'var(--t-primary)' }}>{formatCount(data.followers)}</span>
          <span className="text-[8px]" style={{ color: 'var(--t-secondary)' }}>Followers</span>
        </div>
      </div>
      {data.displayName && <p className="text-[9px] mt-2 truncate" style={{ color: 'var(--t-secondary)' }}>{data.displayName}</p>}
    </>
  );
}

export function YouTubeStatsCard({ profiles }: { profiles?: PlatformProfiles | null }) {
  const data = profiles?.youtube?.profileData;
  if (!data) return <p className="text-[10px]" style={{ color: 'var(--t-tertiary)' }}>Connect YouTube in Settings → Linked Apps</p>;

  return (
    <>
      <span className="text-[8px] font-bold uppercase tracking-widest mb-2 block" style={{ color: 'rgba(255,0,0,0.4)' }}>YouTube</span>
      <div className="flex items-center gap-4">
        <div className="text-center">
          <span className="text-base font-bold block" style={{ color: 'var(--t-primary)' }}>{formatCount(data.subscriberCount)}</span>
          <span className="text-[8px]" style={{ color: 'var(--t-secondary)' }}>Subscribers</span>
        </div>
        <div style={{ width: 1, height: 24, background: 'var(--border-subtle)' }} />
        <div className="text-center">
          <span className="text-sm font-bold block" style={{ color: 'var(--t-primary)' }}>{formatCount(data.viewCount)}</span>
          <span className="text-[8px]" style={{ color: 'var(--t-secondary)' }}>Views</span>
        </div>
        <div style={{ width: 1, height: 24, background: 'var(--border-subtle)' }} />
        <div className="text-center">
          <span className="text-sm font-bold block" style={{ color: 'var(--t-primary)' }}>{formatCount(data.videoCount)}</span>
          <span className="text-[8px]" style={{ color: 'var(--t-secondary)' }}>Videos</span>
        </div>
      </div>
    </>
  );
}

export function GitHubStatsCard({ profiles }: { profiles?: PlatformProfiles | null }) {
  const data = profiles?.github?.profileData;
  if (!data) return <p className="text-[10px]" style={{ color: 'var(--t-tertiary)' }}>Connect GitHub in Settings → Linked Apps</p>;

  const recentDays = (data.contributionDays || []).slice(-112);
  const maxCount = Math.max(1, ...recentDays.map(d => d.count));

  return (
    <>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: 'rgba(230,237,243,0.4)' }}>GitHub</span>
        {data.login && <span className="text-[8px]" style={{ color: 'var(--t-tertiary)' }}>@{data.login}</span>}
      </div>
      <div className="flex items-center gap-3 mb-2">
        <div className="text-center">
          <span className="text-sm font-bold block" style={{ color: 'var(--t-primary)' }}>{formatCount(data.totalContributions)}</span>
          <span className="text-[7px]" style={{ color: 'var(--t-secondary)' }}>Contributions</span>
        </div>
        <div style={{ width: 1, height: 20, background: 'var(--border-subtle)' }} />
        <div className="text-center">
          <span className="text-sm font-bold block" style={{ color: 'var(--t-primary)' }}>{formatCount(data.publicRepos)}</span>
          <span className="text-[7px]" style={{ color: 'var(--t-secondary)' }}>Repos</span>
        </div>
        <div style={{ width: 1, height: 20, background: 'var(--border-subtle)' }} />
        <div className="text-center">
          <span className="text-sm font-bold block" style={{ color: 'var(--t-primary)' }}>{formatCount(data.followers)}</span>
          <span className="text-[7px]" style={{ color: 'var(--t-secondary)' }}>Followers</span>
        </div>
      </div>
      {recentDays.length > 0 && (
        <div className="flex gap-px flex-wrap" style={{ maxHeight: 36, overflow: 'hidden' }}>
          {recentDays.map((day, i) => {
            const intensity = day.count === 0 ? 0 : Math.min(4, Math.ceil((day.count / maxCount) * 4));
            const colors = ['var(--fill-hover)', 'rgba(57,211,83,0.2)', 'rgba(57,211,83,0.4)', 'rgba(57,211,83,0.6)', 'rgba(57,211,83,0.8)'];
            return <div key={i} style={{ width: 4, height: 4, borderRadius: 1, backgroundColor: colors[intensity] }} title={`${day.date}: ${day.count} contributions`} />;
          })}
        </div>
      )}
      {data.topLanguages && data.topLanguages.length > 0 && (
        <div className="flex gap-1.5 mt-2 flex-wrap">
          {data.topLanguages.slice(0, 5).map(lang => (
            <span key={lang.name} className="text-[7px] px-1.5 py-0.5 rounded-lg" style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--t-secondary)' }}>{lang.name}</span>
          ))}
        </div>
      )}
    </>
  );
}

export function RedditStatsCard({ profiles }: { profiles?: PlatformProfiles | null }) {
  const data = profiles?.reddit?.profileData;
  if (!data) return <p className="text-[10px]" style={{ color: 'var(--t-tertiary)' }}>Connect Reddit in Settings → Linked Apps</p>;

  const cakeDay = data.createdUtc ? new Date(data.createdUtc * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : null;

  return (
    <>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[8px] font-bold uppercase tracking-widest" style={{ color: 'rgba(255,87,0,0.4)' }}>Reddit</span>
        {data.username && <span className="text-[8px]" style={{ color: 'var(--t-tertiary)' }}>u/{data.username}</span>}
      </div>
      <div className="flex items-center gap-3">
        <div className="text-center">
          <span className="text-base font-bold block" style={{ color: 'var(--t-primary)' }}>{formatCount(data.totalKarma)}</span>
          <span className="text-[8px]" style={{ color: 'var(--t-secondary)' }}>Karma</span>
        </div>
        {cakeDay && (
          <>
            <div style={{ width: 1, height: 24, background: 'var(--border-subtle)' }} />
            <div className="text-center">
              <span className="text-xs font-semibold block" style={{ color: 'var(--t-primary)' }}>{cakeDay}</span>
              <span className="text-[8px]" style={{ color: 'var(--t-secondary)' }}>Cake Day</span>
            </div>
          </>
        )}
      </div>
      {data.moderatedSubs && data.moderatedSubs.length > 0 && (
        <div className="flex gap-1.5 mt-2 flex-wrap">
          {data.moderatedSubs.slice(0, 4).map(sub => (
            <span key={sub.name} className="text-[7px] px-1.5 py-0.5 rounded-lg" style={{ backgroundColor: 'rgba(255,87,0,0.08)', color: 'rgba(255,87,0,0.5)' }}>r/{sub.name}</span>
          ))}
        </div>
      )}
    </>
  );
}

// Main render dispatcher

export function renderCardContent(
  card: ShowcaseCard,
  gameAccounts: GameAccount[],
  spotifyData?: SpotifyData | null,
  spotifyActivity?: GameActivity | null,
  steamPlaytime?: SteamPlaytimeEntry[],
  steamRecentActivity?: SteamPlaytimeEntry[],
  platformProfiles?: PlatformProfiles | null,
) {
  const account = card.game ? gameAccounts.find(a => a.game === card.game) : undefined;
  const accent = card.color || (card.game ? GAME_COLORS[card.game] || 'var(--t-secondary)' : 'var(--t-secondary)');

  switch (card.type) {
    case 'game_rank':
      return <GameRankCard card={card} account={account} accent={accent} />;
    case 'game_stats':
      return <GameStatsCard card={card} account={account} accent={accent} />;
    case 'spotify_artists':
      return <SpotifyArtistsCard spotifyData={spotifyData} />;
    case 'spotify_tracks':
      return <SpotifyTracksCard spotifyData={spotifyData} />;
    case 'spotify_now_playing':
      return <SpotifyNowPlayingCard activity={spotifyActivity} />;
    case 'steam_playtime':
      return <SteamPlaytimeCard card={card} playtime={steamPlaytime} />;
    case 'steam_recent_activity':
      return <SteamRecentCard card={card} playtime={steamRecentActivity} />;
    case 'rank_timeline':
      return <RankTimelineCard card={card} account={account} accent={accent} />;
    case 'custom_text':
      return <CustomTextCard card={card} />;
    case 'twitch_stats':
      return <TwitchStatsCard profiles={platformProfiles} />;
    case 'youtube_stats':
      return <YouTubeStatsCard profiles={platformProfiles} />;
    case 'github_stats':
      return <GitHubStatsCard profiles={platformProfiles} />;
    case 'reddit_stats':
      return <RedditStatsCard profiles={platformProfiles} />;
    default:
      return <p className="text-[11px]" style={{ color: 'var(--t-tertiary)' }}>Unknown card</p>;
  }
}
