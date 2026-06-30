// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Game stats fetcher service.
 *
 * Fetches stats from external game APIs, normalizes data into a common shape,
 * and upserts into GameStatsCache. Each game has its own fetcher function.
 *
 * Used by: manual refresh endpoint (gameAccounts.ts) and the BullMQ stats-refresh worker.
 */

import { prisma } from '../db.js';
import { Prisma } from '../../generated/prisma-client-v7/client.js';
import { logger } from '../logger.js';
import { decryptSecret, encryptSecret } from './mfaCrypto.js';
import { getEffectivePlan } from '../utils.js';

const log = logger.child({ module: 'game-stats' });

// Env vars

const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
const RIOT_API_KEY = process.env.RIOT_API_KEY || '';
const FORTNITE_API_KEY = process.env.FORTNITE_API_KEY || '';
const APEX_API_KEY = process.env.APEX_API_KEY || '';
const MARVEL_RIVALS_API_KEY = process.env.MARVEL_RIVALS_API_KEY || '';
const R6_API_KEY = process.env.R6_API_KEY || '';

// Common types

export interface NormalizedRank {
  tier: string;
  division: string | null;
  rating: number | null;
  imageUrl: string | null;
}

export interface NormalizedStats {
  [key: string]: number | string | null;
}

export interface FetchResult {
  rank: NormalizedRank | null;
  stats: NormalizedStats | null;
  error?: string;
  errorStatus?: number;
}

// Safe fetch helper

async function safeFetch(url: string, options?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
    });
  } catch (err) {
    log.warn({ err, url: url.split('?')[0] }, 'external API fetch failed');
    return null;
  }
}

function truncate(val: unknown, maxLen = 256): string {
  return String(val ?? '').slice(0, maxLen);
}

function safeNum(val: unknown): number | null {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read upstream response body and produce a single-line error string suitable
 * for storing in GameStatsCache.fetchError. Includes the upstream message
 * when the body is JSON (looks at common envelope fields), or the truncated
 * raw body otherwise. Falls back to status-only when the body is empty.
 *
 * Body is consumed by this call — only invoke on the error path.
 *
 * Exported for unit testing.
 */
export async function responseError(res: Response | null, provider: string): Promise<string> {
  if (!res) return `${provider} API: no response`;
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  let msg = '';
  if (body) {
    const trimmed = body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const candidate = parsed.message ?? parsed.error ?? parsed.detail ?? parsed.error_description;
        if (typeof candidate === 'string') {
          msg = candidate;
        } else if (typeof parsed.error === 'object' && parsed.error !== null) {
          const inner = (parsed.error as Record<string, unknown>).message;
          if (typeof inner === 'string') msg = inner;
        }
      } catch { /* not JSON */ }
    }
    if (!msg) msg = trimmed;
  }
  msg = msg.replace(/\s+/g, ' ').slice(0, 200);
  return msg
    ? `${provider} API ${res.status}: ${msg}`
    : `${provider} API returned ${res.status}`;
}

/**
 * Detects transient/outage-class errors that should not count against the
 * normal "fix it on your side" retry budget. Triggers a longer cooldown
 * upstream so we don't burn cycles while the provider recovers.
 *
 * Markers are deliberately specific to avoid false positives — bare
 * "connection" would match too much.
 *
 * Exported for unit testing.
 */
export function isTransientError(error: string | undefined, status?: number): boolean {
  if (status === 502 || status === 503 || status === 504 || status === 429) return true;
  if (!error) return false;
  const e = error.toLowerCase();
  return (
    e.includes('too many connections') ||
    e.includes('connection slots') ||
    e.includes('service unavailable') ||
    e.includes('temporarily unavailable') ||
    e.includes('try again later') ||
    e.includes('gateway timeout') ||
    e.includes('bad gateway') ||
    e.includes('connection refused') ||
    e.includes('econnreset') ||
    e.includes('etimedout')
  );
}

/**
 * Build a FetchResult for an error response. Reads the upstream body once
 * and captures the status for transient-error classification.
 */
async function errorResult(res: Response | null, provider: string): Promise<FetchResult> {
  const error = await responseError(res, provider);
  return { rank: null, stats: null, error, errorStatus: res?.status };
}

// STEAM: CS2 + Dota 2

async function fetchCS2Stats(steamId: string): Promise<FetchResult> {
  if (!STEAM_API_KEY) return { rank: null, stats: null, error: 'STEAM_API_KEY not configured' };

  const res = await safeFetch(
    `https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?appid=730&key=${STEAM_API_KEY}&steamid=${encodeURIComponent(steamId)}`
  );
  if (!res || !res.ok) return errorResult(res, 'Steam');

  const data = await res.json() as {
    playerstats?: { stats?: Array<{ name: string; value: number }> };
  };

  const statsMap = new Map<string, number>();
  for (const s of data.playerstats?.stats ?? []) {
    statsMap.set(s.name, s.value);
  }

  const totalKills = statsMap.get('total_kills') ?? 0;
  const totalDeaths = statsMap.get('total_deaths') ?? 1;
  const totalWins = statsMap.get('total_wins') ?? 0;
  const totalRounds = statsMap.get('total_rounds_played') ?? 0;
  const totalMvps = statsMap.get('total_mvps') ?? 0;
  const headshots = statsMap.get('total_kills_headshot') ?? 0;
  const timePlayed = statsMap.get('total_time_played') ?? 0;

  const kd = totalDeaths > 0 ? Math.round((totalKills / totalDeaths) * 100) / 100 : 0;
  const headshotPct = totalKills > 0 ? Math.round((headshots / totalKills) * 1000) / 10 : 0;
  const hours = Math.round(timePlayed / 3600);

  return {
    rank: null, // Premier rating not available from Steam API
    stats: {
      kd,
      kills: totalKills,
      deaths: totalDeaths,
      wins: totalWins,
      rounds: totalRounds,
      mvps: totalMvps,
      headshotPct,
      hoursPlayed: hours,
    },
  };
}

async function fetchDota2Stats(steamId: string): Promise<FetchResult> {
  // Use OpenDota API (free, no key required, rate limited to 60/min)
  // Convert Steam64 ID to Steam32 for OpenDota
  const steam64 = BigInt(steamId);
  const steam32 = Number(steam64 - BigInt('76561197960265728'));

  const res = await safeFetch(`https://api.opendota.com/api/players/${steam32}`);
  if (!res || !res.ok) return errorResult(res, 'OpenDota');

  const data = await res.json() as {
    rank_tier?: number | null;
    mmr_estimate?: { estimate?: number };
    profile?: { personaname?: string };
  };

  // OpenDota rank_tier: first digit = medal (1-8), second digit = stars (0-5)
  const medalNames = ['', 'Herald', 'Guardian', 'Crusader', 'Archon', 'Legend', 'Ancient', 'Divine', 'Immortal'];
  let rank: NormalizedRank | null = null;

  if (data.rank_tier) {
    const medal = Math.floor(data.rank_tier / 10);
    const stars = data.rank_tier % 10;
    rank = {
      tier: medalNames[medal] || 'Unknown',
      division: stars > 0 ? String(stars) : null,
      rating: data.mmr_estimate?.estimate ?? null,
      imageUrl: `https://www.opendota.com/assets/images/dota2/rank_icons/rank_icon_${data.rank_tier}.png`,
    };
  }

  // Fetch win/loss
  const wlRes = await safeFetch(`https://api.opendota.com/api/players/${steam32}/wl`);
  let wins = 0, losses = 0;
  if (wlRes?.ok) {
    const wl = await wlRes.json() as { win?: number; lose?: number };
    wins = wl.win ?? 0;
    losses = wl.lose ?? 0;
  }

  const totalMatches = wins + losses;
  const winRate = totalMatches > 0 ? Math.round((wins / totalMatches) * 1000) / 10 : 0;

  return {
    rank,
    stats: {
      wins,
      losses,
      matches: totalMatches,
      winRate,
      mmr: data.mmr_estimate?.estimate ?? null,
    },
  };
}

// RIOT: Valorant, League of Legends, TFT

// Used when RSO token-based Valorant access is enabled (currently uses API key)
async function _getRiotToken(userId: string): Promise<string | null> {
  const app = await prisma.connectedApp.findUnique({
    where: { userId_provider: { userId, provider: 'riot' } },
    select: { accessToken: true, refreshToken: true, tokenExpiresAt: true },
  });
  if (!app) return null;

  // Check if token is still valid (with 60s buffer)
  if (app.tokenExpiresAt && app.tokenExpiresAt.getTime() > Date.now() + 60_000) {
    return decryptSecret(app.accessToken);
  }

  // Refresh the token
  const RIOT_CLIENT_ID = process.env.RIOT_CLIENT_ID || '';
  const RIOT_CLIENT_SECRET = process.env.RIOT_CLIENT_SECRET || '';
  if (!RIOT_CLIENT_ID || !RIOT_CLIENT_SECRET) return null;

  const refreshToken = decryptSecret(app.refreshToken);
  if (!refreshToken) return null;

  const basicAuth = Buffer.from(`${RIOT_CLIENT_ID}:${RIOT_CLIENT_SECRET}`).toString('base64');
  const res = await safeFetch('https://auth.riotgames.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basicAuth}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });

  if (!res?.ok) return null;

  const tokenData = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };

  await prisma.connectedApp.update({
    where: { userId_provider: { userId, provider: 'riot' } },
    data: {
      accessToken: encryptSecret(tokenData.access_token),
      ...(tokenData.refresh_token ? { refreshToken: encryptSecret(tokenData.refresh_token) } : {}),
      tokenExpiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
    },
  });

  return tokenData.access_token;
}

async function fetchValorantStats(puuid: string, _userId: string): Promise<FetchResult> {
  if (!RIOT_API_KEY) return { rank: null, stats: null, error: 'RIOT_API_KEY not configured' };

  const res = await safeFetch(
    `https://na.api.riotgames.com/val/ranked/v1/by-puuid/${encodeURIComponent(puuid)}?api_key=${RIOT_API_KEY}`
  );

  if (!res || res.status === 403 || res.status === 404) {
    return { rank: null, stats: null, error: 'Valorant ranked data not available (may require RSO token)', errorStatus: res?.status };
  }

  if (!res.ok) return errorResult(res, 'Riot VAL');

  const data = await res.json() as {
    currenttier?: number;
    currenttierpatched?: string;
    ranking_in_tier?: number;
    mmr_change_to_last_game?: number;
    elo?: number;
  };

  const tierNames = ['Iron', 'Iron', 'Iron', 'Bronze', 'Bronze', 'Bronze', 'Silver', 'Silver', 'Silver',
    'Gold', 'Gold', 'Gold', 'Platinum', 'Platinum', 'Platinum', 'Diamond', 'Diamond', 'Diamond',
    'Ascendant', 'Ascendant', 'Ascendant', 'Immortal', 'Immortal', 'Immortal', 'Radiant'];
  const divisionMap = ['1', '2', '3'];

  const tier = data.currenttier != null ? tierNames[data.currenttier] ?? 'Unranked' : 'Unranked';
  const division = data.currenttier != null ? divisionMap[data.currenttier % 3] ?? null : null;

  return {
    rank: tier !== 'Unranked' ? {
      tier,
      division: tier === 'Radiant' ? null : division,
      rating: data.ranking_in_tier ?? data.elo ?? null,
      imageUrl: null,
    } : null,
    stats: {
      rr: data.ranking_in_tier ?? null,
      elo: data.elo ?? null,
    },
  };
}

async function fetchLoLStats(puuid: string): Promise<FetchResult> {
  if (!RIOT_API_KEY) return { rank: null, stats: null, error: 'RIOT_API_KEY not configured' };

  const sumRes = await safeFetch(
    `https://na1.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}?api_key=${RIOT_API_KEY}`
  );
  if (!sumRes?.ok) return errorResult(sumRes, 'Riot LOL summoner');

  const summoner = await sumRes.json() as { id: string; summonerLevel?: number };

  const rankRes = await safeFetch(
    `https://na1.api.riotgames.com/lol/league/v4/entries/by-summoner/${encodeURIComponent(summoner.id)}?api_key=${RIOT_API_KEY}`
  );
  if (!rankRes?.ok) {
    return {
      rank: null,
      stats: { level: summoner.summonerLevel ?? null },
      error: await responseError(rankRes, 'Riot LOL league'),
      errorStatus: rankRes?.status,
    };
  }

  const entries = await rankRes.json() as Array<{
    queueType: string; tier: string; rank: string; leaguePoints: number;
    wins: number; losses: number;
  }>;

  const soloQ = entries.find(e => e.queueType === 'RANKED_SOLO_5x5');

  const totalMatches = soloQ ? soloQ.wins + soloQ.losses : 0;
  const winRate = totalMatches > 0 ? Math.round((soloQ!.wins / totalMatches) * 1000) / 10 : 0;

  return {
    rank: soloQ ? {
      tier: truncate(soloQ.tier, 32),
      division: truncate(soloQ.rank, 8),
      rating: soloQ.leaguePoints,
      imageUrl: null,
    } : null,
    stats: {
      wins: soloQ?.wins ?? 0,
      losses: soloQ?.losses ?? 0,
      matches: totalMatches,
      winRate,
      lp: soloQ?.leaguePoints ?? null,
      level: summoner.summonerLevel ?? null,
    },
  };
}

async function fetchTFTStats(puuid: string): Promise<FetchResult> {
  if (!RIOT_API_KEY) return { rank: null, stats: null, error: 'RIOT_API_KEY not configured' };

  const res = await safeFetch(
    `https://na1.api.riotgames.com/tft/league/v1/entries/by-puuid/${encodeURIComponent(puuid)}?api_key=${RIOT_API_KEY}`
  );
  if (!res?.ok) return errorResult(res, 'Riot TFT');

  const entries = await res.json() as Array<{
    queueType: string; tier: string; rank: string; leaguePoints: number;
    wins: number; losses: number;
  }>;

  const ranked = entries.find(e => e.queueType === 'RANKED_TFT');

  const totalMatches = ranked ? ranked.wins + ranked.losses : 0;
  const winRate = totalMatches > 0 ? Math.round((ranked!.wins / totalMatches) * 1000) / 10 : 0;

  return {
    rank: ranked ? {
      tier: truncate(ranked.tier, 32),
      division: truncate(ranked.rank, 8),
      rating: ranked.leaguePoints,
      imageUrl: null,
    } : null,
    stats: {
      wins: ranked?.wins ?? 0,
      losses: ranked?.losses ?? 0,
      matches: totalMatches,
      winRate,
      lp: ranked?.leaguePoints ?? null,
    },
  };
}

// FORTNITE (fortnite-api.com)

async function fetchFortniteStats(accountId: string, displayName: string): Promise<FetchResult> {
  if (!FORTNITE_API_KEY) return { rank: null, stats: null, error: 'FORTNITE_API_KEY not configured' };

  const endpoint = accountId && accountId.length === 32
    ? `https://fortnite-api.com/v2/stats/br/v2?accountId=${encodeURIComponent(accountId)}`
    : `https://fortnite-api.com/v2/stats/br/v2?name=${encodeURIComponent(displayName)}`;

  const res = await safeFetch(endpoint, {
    headers: { Authorization: FORTNITE_API_KEY },
  });
  if (!res?.ok) return errorResult(res, 'Fortnite');

  const data = await res.json() as {
    status?: number;
    data?: {
      account?: { level?: number };
      battlePass?: { level?: number };
      stats?: {
        all?: { overall?: { wins?: number; kills?: number; deaths?: number; kd?: number; matches?: number; winRate?: number; minutesPlayed?: number } };
      };
    };
  };

  const overall = data.data?.stats?.all?.overall;
  if (!overall) return { rank: null, stats: null, error: 'No stats data in Fortnite response' };

  return {
    rank: null,
    stats: {
      wins: safeNum(overall.wins),
      kills: safeNum(overall.kills),
      deaths: safeNum(overall.deaths),
      kd: safeNum(overall.kd),
      matches: safeNum(overall.matches),
      winRate: safeNum(overall.winRate),
      hoursPlayed: overall.minutesPlayed ? Math.round(overall.minutesPlayed / 60) : null,
      level: safeNum(data.data?.account?.level),
    },
  };
}

// APEX LEGENDS (apexlegendsapi.com / mozambiquehe.re)

async function fetchApexStats(platformId: string, platform: string | null): Promise<FetchResult> {
  if (!APEX_API_KEY) return { rank: null, stats: null, error: 'APEX_API_KEY not configured' };

  const apexPlatform = platform === 'psn' ? 'PS4' : platform === 'xbox' ? 'X1' : 'PC';
  const res = await safeFetch(
    `https://api.mozambiquehe.re/bridge?auth=${APEX_API_KEY}&player=${encodeURIComponent(platformId)}&platform=${apexPlatform}`
  );
  if (!res?.ok) return errorResult(res, 'Apex');

  const data = await res.json() as {
    global?: {
      name?: string;
      level?: number;
      rank?: { rankName?: string; rankDiv?: number; rankScore?: number; rankImg?: string };
    };
    total?: {
      kills?: { value?: number };
      damage?: { value?: number };
      games_played?: { value?: number };
      wins?: { value?: number };
      kd?: { value?: number };
    };
  };

  const rankData = data.global?.rank;
  if (rankData?.rankImg) {
    log.debug({ rankImg: rankData.rankImg.slice(0, 200), game: 'apex' }, 'Apex rank image URL');
  }
  const rank: NormalizedRank | null = rankData?.rankName ? {
    tier: truncate(rankData.rankName, 32),
    division: rankData.rankDiv != null ? String(rankData.rankDiv) : null,
    rating: safeNum(rankData.rankScore),
    imageUrl: rankData.rankImg
      ? (rankData.rankImg.startsWith('http') ? rankData.rankImg : `https://api.mozambiquehe.re${rankData.rankImg}`).slice(0, 512)
      : null,
  } : null;

  return {
    rank,
    stats: {
      level: safeNum(data.global?.level),
      kills: safeNum(data.total?.kills?.value),
      damage: safeNum(data.total?.damage?.value),
      matches: safeNum(data.total?.games_played?.value),
      wins: safeNum(data.total?.wins?.value),
      kd: safeNum(data.total?.kd?.value),
    },
  };
}

// MARVEL RIVALS (marvelrivalsapi.com)

async function fetchMarvelRivalsStats(username: string): Promise<FetchResult> {
  if (!MARVEL_RIVALS_API_KEY) return { rank: null, stats: null, error: 'MARVEL_RIVALS_API_KEY not configured' };

  const res = await safeFetch(
    `https://marvelrivalsapi.com/api/v1/player/${encodeURIComponent(username)}`, {
      headers: { 'x-api-key': MARVEL_RIVALS_API_KEY },
    }
  );
  if (!res?.ok) return errorResult(res, 'Marvel Rivals');

  const data = await res.json() as {
    player?: {
      rank?: { rank?: string; image?: string; color?: string };
      info?: {
        rank_game_season?: Record<string, {
          rank_game_id: number;
          rank_score: number;
          max_rank_score: number;
        }>;
      };
    };
    overall_stats?: {
      ranked?: {
        total_matches?: number; total_wins?: number; total_losses?: number;
        total_kills?: number; total_deaths?: number; total_assists?: number;
      };
    };
  };

  const rankInfo = data.player?.rank;
  const s = data.overall_stats?.ranked;

  // Get rank score from latest season
  let currentRankScore: number | null = null;
  const seasons = data.player?.info?.rank_game_season;
  if (seasons) {
    const entries = Object.values(seasons);
    if (entries.length > 0) {
      const latest = entries.sort((a, b) => b.rank_game_id - a.rank_game_id)[0];
      currentRankScore = latest.rank_score ? Math.round(latest.rank_score) : null;
    }
  }

  const kills = safeNum(s?.total_kills) ?? 0;
  const deaths = safeNum(s?.total_deaths) ?? 1;
  const matches = safeNum(s?.total_matches) ?? 0;
  const wins = safeNum(s?.total_wins) ?? 0;

  // Build per-season data for frontend season selector / timeline
  const seasonData = seasons ? Object.entries(seasons).map(([_key, s]) => ({
    seasonId: s.rank_game_id,
    rankScore: Math.round(s.rank_score),
    maxRankScore: Math.round(s.max_rank_score),
    // MR API doesn't provide per-season rank tier name — only current via player.rank.rank
    rankName: null as string | null,
    rankPoints: Math.round(s.rank_score), // alias for consistency with R6 shape
  })).sort((a, b) => b.seasonId - a.seasonId) : [];

  // Tag the latest season with the current rank name
  if (seasonData.length > 0 && rankInfo?.rank) {
    seasonData[0].rankName = truncate(rankInfo.rank, 32);
  }

  return {
    rank: rankInfo?.rank ? {
      tier: truncate(rankInfo.rank, 32),
      division: null,
      rating: currentRankScore,
      imageUrl: rankInfo.image
        ? `https://marvelrivalsapi.com/rivals${rankInfo.image}`.slice(0, 512)
        : null,
    } : null,
    stats: {
      matches,
      wins,
      losses: safeNum(s?.total_losses),
      kills,
      deaths,
      assists: safeNum(s?.total_assists),
      kd: deaths > 0 ? Math.round((kills / deaths) * 100) / 100 : 0,
      winRate: matches > 0 ? Math.round((wins / matches) * 1000) / 10 : 0,
      seasons: JSON.stringify(seasonData),
    },
  };
}

// RAINBOW SIX SIEGE (r6data.eu)

/** R6 Siege season info: season_id → { code, name, start } */
const R6_SEASON_INFO: Record<number, { code: string; name: string; start: string }> = {
  41: { code: 'Y11S1', name: 'Silent Hunt', start: '2026-03-03' },
  40: { code: 'Y10S4', name: 'Tenfold Pursuit', start: '2025-12-02' },
  39: { code: 'Y10S3', name: 'High Stakes', start: '2025-09-02' },
  38: { code: 'Y10S2', name: 'Daybreak', start: '2025-06-18' },
  37: { code: 'Y10S1', name: 'Prep Phase', start: '2025-03-04' },
  36: { code: 'Y9S4', name: 'Collision Point', start: '2024-12-03' },
  35: { code: 'Y9S3', name: 'Twin Shells', start: '2024-09-10' },
  34: { code: 'Y9S2', name: 'New Blood', start: '2024-06-11' },
  33: { code: 'Y9S1', name: 'Deadly Omen', start: '2024-03-12' },
  32: { code: 'Y8S4', name: 'Deep Freeze', start: '2023-12-06' },
  31: { code: 'Y8S3', name: 'Heavy Mettle', start: '2023-08-29' },
  30: { code: 'Y8S2', name: 'Dread Factor', start: '2023-05-30' },
  29: { code: 'Y8S1', name: 'Commanding Force', start: '2023-03-07' },
  28: { code: 'Y7S4', name: 'Solar Raid', start: '2022-12-06' },
  27: { code: 'Y7S3', name: 'Brutal Swarm', start: '2022-09-13' },
  26: { code: 'Y7S2', name: 'Vector Glare', start: '2022-06-14' },
  25: { code: 'Y7S1', name: 'Demon Veil', start: '2022-03-15' },
  24: { code: 'Y6S4', name: 'High Calibre', start: '2021-11-30' },
  23: { code: 'Y6S3', name: 'Crystal Guard', start: '2021-09-07' },
  22: { code: 'Y6S2', name: 'North Star', start: '2021-06-14' },
  21: { code: 'Y6S1', name: 'Crimson Heist', start: '2021-03-16' },
  20: { code: 'Y5S4', name: 'Neon Dawn', start: '2020-12-01' },
  19: { code: 'Y5S3', name: 'Shadow Legacy', start: '2020-09-10' },
  18: { code: 'Y5S2', name: 'Steel Wave', start: '2020-06-16' },
  17: { code: 'Y5S1', name: 'Void Edge', start: '2020-03-10' },
  16: { code: 'Y4S4', name: 'Shifting Tides', start: '2019-12-03' },
  15: { code: 'Y4S3', name: 'Ember Rise', start: '2019-09-11' },
  14: { code: 'Y4S2', name: 'Phantom Sight', start: '2019-06-11' },
  13: { code: 'Y4S1', name: 'Burnt Horizon', start: '2019-03-06' },
  12: { code: 'Y3S4', name: 'Wind Bastion', start: '2018-12-04' },
  11: { code: 'Y3S3', name: 'Grim Sky', start: '2018-09-04' },
  10: { code: 'Y3S2', name: 'Para Bellum', start: '2018-06-07' },
  9:  { code: 'Y3S1', name: 'Chimera', start: '2018-03-06' },
  8:  { code: 'Y2S4', name: 'White Noise', start: '2017-12-05' },
  7:  { code: 'Y2S3', name: 'Blood Orchid', start: '2017-09-05' },
  6:  { code: 'Y2S2', name: 'Operation Health', start: '2017-06-07' },
  5:  { code: 'Y2S1', name: 'Velvet Shell', start: '2017-02-07' },
  4:  { code: 'Y1S4', name: 'Red Crow', start: '2016-11-17' },
  3:  { code: 'Y1S3', name: 'Skull Rain', start: '2016-08-02' },
  2:  { code: 'Y1S2', name: 'Dust Line', start: '2016-05-10' },
  1:  { code: 'Y1S1', name: 'Black Ice', start: '2016-02-02' },
};

async function fetchR6SiegeStats(username: string, platform: string | null): Promise<FetchResult> {
  if (!R6_API_KEY) return { rank: null, stats: null, error: 'R6_API_KEY not configured' };

  const r6Platform = platform === 'psn' ? 'psn' : platform === 'xbox' ? 'xbl' : 'uplay';
  const platformFamily = (platform === 'psn' || platform === 'xbox') ? 'console' : 'pc';

  // Single API call — type=stats returns rank + stats + per-season data
  const res = await safeFetch(
    `https://api.r6data.eu/api/stats?type=stats&nameOnPlatform=${encodeURIComponent(username)}&platformType=${r6Platform}&platform_families=${platformFamily}`, {
      headers: { 'api-key': R6_API_KEY },
    }
  );

  if (!res?.ok) return errorResult(res, 'R6');

  const data = await res.json() as {
    platform_families_full_profiles?: Array<{
      board_ids_full_profiles?: Array<{
        board_id?: string;
        full_profiles?: Array<{
          season_id: number;
          profile: {
            rank: number;
            rank_points: number;
            max_rank: number;
            max_rank_points: number;
            kills: number;
            deaths: number;
            wins: number;
            losses: number;
            abandon?: number;
          };
        }>;
      }>;
    }>;
  };

  // Navigate to ranked board
  const rankedBoard = data.platform_families_full_profiles?.[0]
    ?.board_ids_full_profiles?.find(b => b.board_id === 'ranked');

  if (!rankedBoard?.full_profiles?.length) {
    return { rank: null, stats: null, error: 'No ranked data found for this player' };
  }

  // Sort by season_id descending to get current season first
  const seasons = [...rankedBoard.full_profiles].sort((a, b) => b.season_id - a.season_id);
  const current = seasons[0];
  const p = current.profile;

  // Map rank number to name
  const R6_RANK_NAMES: Record<number, string> = {
    0: 'Unranked',
    1: 'Copper V', 2: 'Copper IV', 3: 'Copper III', 4: 'Copper II', 5: 'Copper I',
    6: 'Bronze V', 7: 'Bronze IV', 8: 'Bronze III', 9: 'Bronze II', 10: 'Bronze I',
    11: 'Silver V', 12: 'Silver IV', 13: 'Silver III', 14: 'Silver II', 15: 'Silver I',
    16: 'Gold V', 17: 'Gold IV', 18: 'Gold III', 19: 'Gold II', 20: 'Gold I',
    21: 'Platinum V', 22: 'Platinum IV', 23: 'Platinum III', 24: 'Platinum II', 25: 'Platinum I',
    26: 'Emerald V', 27: 'Emerald IV', 28: 'Emerald III', 29: 'Emerald II', 30: 'Emerald I',
    31: 'Diamond V', 32: 'Diamond IV', 33: 'Diamond III', 34: 'Diamond II', 35: 'Diamond I',
    36: 'Champion',
  };

  // Static rank image URLs from r6data.eu — fallback when seasonalStats doesn't return an image
  const R6_RANK_IMAGES: Record<number, string> = {
    1: 'copper-5', 2: 'copper-4', 3: 'copper-3', 4: 'copper-2', 5: 'copper-1',
    6: 'bronze-5', 7: 'bronze-4', 8: 'bronze-3', 9: 'bronze-2', 10: 'bronze-1',
    11: 'silver-5', 12: 'silver-4', 13: 'silver-3', 14: 'silver-2', 15: 'silver-1',
    16: 'gold-5', 17: 'gold-4', 18: 'gold-3', 19: 'gold-2', 20: 'gold-1',
    21: 'platinum-5', 22: 'platinum-4', 23: 'platinum-3', 24: 'platinum-2', 25: 'platinum-1',
    26: 'emerald-5', 27: 'emerald-4', 28: 'emerald-3', 29: 'emerald-2', 30: 'emerald-1',
    31: 'diamond-5', 32: 'diamond-4', 33: 'diamond-3', 34: 'diamond-2', 35: 'diamond-1',
    36: 'champion',
  };

  const rankName = R6_RANK_NAMES[p.rank] ?? `Rank ${p.rank}`;
  const peakRankName = R6_RANK_NAMES[p.max_rank] ?? `Rank ${p.max_rank}`;

  const kills = p.kills ?? 0;
  const deaths = p.deaths ?? 1;
  const wins = p.wins ?? 0;
  const losses = p.losses ?? 0;
  const matches = wins + losses;

  // Fetch rank image AND historical season data from seasonalStats endpoint
  let rankImageUrl: string | null = null;
  const seasonalHistory: Array<{
    timestamp: string;
    rankName: string | null;
    imageUrl: string | null;
    color: string | null;
    rankPoints: number | null;
  }> = [];

  if (p.rank > 0) {
    const seasonalRes = await safeFetch(
      `https://api.r6data.eu/api/stats?type=seasonalStats&nameOnPlatform=${encodeURIComponent(username)}&platformType=${r6Platform}`, {
        headers: { 'api-key': R6_API_KEY },
      }
    );
    if (seasonalRes?.ok) {
      const seasonalData = await seasonalRes.json() as {
        data?: {
          history?: {
            data?: Array<[string, {
              metadata?: { rank?: string; imageUrl?: string; color?: string };
              value?: number;
            }]>;
          };
        };
      };
      const historyEntries = seasonalData.data?.history?.data;
      if (historyEntries && Array.isArray(historyEntries)) {
        for (const [timestamp, entry] of historyEntries) {
          seasonalHistory.push({
            timestamp,
            rankName: entry.metadata?.rank ? truncate(entry.metadata.rank, 32) : null,
            imageUrl: entry.metadata?.imageUrl?.slice(0, 512) ?? null,
            color: entry.metadata?.color?.slice(0, 16) ?? null,
            rankPoints: typeof entry.value === 'number' ? Math.round(entry.value) : null,
          });
        }
        // Get rank image from the latest entry
        if (seasonalHistory.length > 0 && seasonalHistory[0].imageUrl) {
          rankImageUrl = seasonalHistory[0].imageUrl;
        }
      }
    }
  }

  // Static fallback if seasonalStats didn't return an image
  if (!rankImageUrl && p.rank > 0) {
    const slug = R6_RANK_IMAGES[p.rank];
    if (slug) {
      rankImageUrl = `https://r6data.eu/assets/img/r6_ranks_img/${slug}.webp`;
    }
  }

  // Build season data
  const seasonData: Array<{
    seasonId: number;
    seasonName: string;
    seasonFullName: string | null;
    rank: number;
    rankName: string;
    rankPoints: number;
    maxRank: number;
    maxRankName: string;
    maxRankPoints: number;
    imageUrl: string | null;
    color: string | null;
    kills: number;
    deaths: number;
    wins: number;
    losses: number;
  }> = [];

  // Current season from full_profiles (already fetched above)
  const currentInfo = R6_SEASON_INFO[current.season_id];
  seasonData.push({
    seasonId: current.season_id,
    seasonName: currentInfo?.code ?? `S${current.season_id}`,
    seasonFullName: currentInfo?.name ?? null,
    rank: p.rank,
    rankName,
    rankPoints: p.rank_points,
    maxRank: p.max_rank,
    maxRankName: R6_RANK_NAMES[p.max_rank] ?? '',
    maxRankPoints: p.max_rank_points,
    imageUrl: rankImageUrl,
    color: null,
    kills,
    deaths,
    wins,
    losses,
  });

  log.info({
    game: 'r6_siege',
    currentSeason: current.season_id,
    totalSeasons: seasonData.length,
  }, 'R6 season data built');

  const rank: NormalizedRank = {
    tier: truncate(rankName, 32),
    division: null,
    rating: p.rank_points,
    imageUrl: rankImageUrl,
  };

  return {
    rank: p.rank > 0 ? rank : null,
    stats: {
      kills,
      deaths,
      wins,
      losses,
      matches,
      kd: deaths > 0 ? Math.round((kills / deaths) * 100) / 100 : 0,
      winRate: matches > 0 ? Math.round((wins / matches) * 1000) / 10 : 0,
      headshotPct: null,
      rankPoints: p.rank_points,
      peakRank: peakRankName,
      peakRankPoints: p.max_rank_points,
      seasonId: current.season_id,
      seasons: JSON.stringify(seasonData),
    },
  };
}

// STEAM PLAYTIME

export interface SteamPlaytimeEntry {
  appId: number;
  name: string;
  hours: number;
  iconUrl: string | null;
}

export async function fetchSteamPlaytime(steamId: string): Promise<SteamPlaytimeEntry[]> {
  if (!STEAM_API_KEY) return [];

  const res = await safeFetch(
    `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${encodeURIComponent(steamId)}&include_appinfo=1&include_played_free_games=1`
  );
  if (!res?.ok) {
    log.warn({ status: res?.status, steamId: steamId.slice(0, 8) }, 'Steam playtime fetch failed');
    return [];
  }

  const data = await res.json() as {
    response?: {
      total_count?: number;
      game_count?: number;
      games?: Array<{
        appid: number;
        name: string;
        playtime_forever: number;
        playtime_2weeks?: number;
        img_icon_url?: string;
      }>;
    };
  };

  log.info({
    steamId: steamId.slice(0, 8),
    totalCount: data.response?.total_count ?? data.response?.game_count ?? 0,
    gamesReturned: data.response?.games?.length ?? 0,
  }, 'steam owned games API response');

  const games = data.response?.games ?? [];

  return games
    .map(g => ({
      appId: g.appid,
      name: truncate(g.name, 64),
      hours: Math.round((g.playtime_forever ?? 0) / 60),
      iconUrl: g.img_icon_url
        ? `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg`
        : null,
    }))
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 8);
}

export async function fetchSteamRecentActivity(steamId: string): Promise<SteamPlaytimeEntry[]> {
  if (!STEAM_API_KEY) return [];

  const res = await safeFetch(
    `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/?key=${STEAM_API_KEY}&steamid=${encodeURIComponent(steamId)}&count=10`
  );
  if (!res?.ok) {
    log.warn({ status: res?.status, steamId: steamId.slice(0, 8) }, 'Steam recent activity fetch failed');
    return [];
  }

  const data = await res.json() as {
    response?: {
      total_count?: number;
      games?: Array<{
        appid: number;
        name: string;
        playtime_forever: number;
        playtime_2weeks?: number;
        img_icon_url?: string;
      }>;
    };
  };

  const games = data.response?.games ?? [];

  return games
    .map(g => ({
      appId: g.appid,
      name: truncate(g.name, 64),
      hours: Math.round((g.playtime_2weeks ?? 0) / 60),
      iconUrl: g.img_icon_url
        ? `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg`
        : null,
    }))
    .filter(g => g.hours > 0)
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 8);
}

// DISPATCHER — fetch stats for any game

export async function fetchGameStats(gameAccount: {
  id: string; game: string; provider: string; platformId: string;
  platform: string | null; displayName: string | null; userId: string;
}): Promise<FetchResult> {
  const { game, platformId, platform, displayName, userId } = gameAccount;

  let result: FetchResult;

  try {
    switch (game) {
      case 'cs2':
        result = await fetchCS2Stats(platformId);
        break;
      case 'dota2':
        result = await fetchDota2Stats(platformId);
        break;
      case 'valorant':
        result = await fetchValorantStats(platformId, userId);
        break;
      case 'lol':
        result = await fetchLoLStats(platformId);
        break;
      case 'tft':
        result = await fetchTFTStats(platformId);
        break;
      case 'fortnite':
        result = await fetchFortniteStats(platformId, displayName || platformId);
        break;
      case 'apex':
        result = await fetchApexStats(platformId, platform);
        break;
      case 'marvel_rivals':
        result = await fetchMarvelRivalsStats(platformId);
        break;
      case 'r6_siege':
        result = await fetchR6SiegeStats(platformId, platform);
        break;
      default:
        result = { rank: null, stats: null, error: `Unknown game: ${game}` };
    }
  } catch (err) {
    log.error({ err, game, platformId: platformId.slice(0, 20) }, 'game stats fetch threw');
    result = { rank: null, stats: null, error: `Fetch error: ${(err as Error).message?.slice(0, 200)}` };
  }

  return result;
}

/**
 * Fetch stats for a game account and write to GameStatsCache.
 * Returns true if stats were successfully fetched.
 */
export async function refreshGameAccountStats(gameAccountId: string): Promise<boolean> {
  const account = await prisma.gameAccount.findUnique({
    where: { id: gameAccountId },
    select: { id: true, game: true, provider: true, platformId: true, platform: true, displayName: true, userId: true },
  });
  if (!account) return false;

  const result = await fetchGameStats(account);
  const now = new Date();

  // For R6 Siege: merge historical seasons from existing cache (they never change)
  if (account.game === 'r6_siege' && result.stats?.seasons) {
    try {
      const existingCache = await prisma.gameStatsCache.findUnique({
        where: { gameAccountId: account.id },
        select: { stats: true },
      });
      const existingStats = existingCache?.stats as Record<string, unknown> | null;
      if (existingStats?.seasons) {
        const newSeasons = JSON.parse(result.stats.seasons as string) as Array<{ seasonId: number; [k: string]: unknown }>;
        const oldSeasons = JSON.parse(existingStats.seasons as string) as Array<{ seasonId: number; [k: string]: unknown }>;

        const merged = [...newSeasons];

        // Detect garbage data: if all old seasons have identical rank+points, discard them
        const uniqueRankCombos = new Set(oldSeasons.map(s => `${s.rank ?? '?'}-${s.rankPoints ?? s.rankScore ?? '?'}`));
        if (uniqueRankCombos.size <= 1 && oldSeasons.length > 1) {
          log.info({ game: 'r6_siege', discardedCount: oldSeasons.length }, 'discarding garbage R6 historical seasons (all identical)');
        } else {
          // Normal merge: keep historical seasons from old cache that aren't in new data
          const newSeasonIds = new Set(newSeasons.map(s => s.seasonId));
          for (const old of oldSeasons) {
            if (!newSeasonIds.has(old.seasonId) && R6_SEASON_INFO[old.seasonId]) {
              merged.push(old);
            }
          }
        }
        merged.sort((a, b) => b.seasonId - a.seasonId);
        result.stats.seasons = JSON.stringify(merged);

        log.info({ game: 'r6_siege', newCount: newSeasons.length, mergedCount: merged.length }, 'R6 merged cached historical seasons');
      }
    } catch (e) {
      log.warn({ err: e }, 'Failed to merge R6 historical seasons from cache');
    }
  }

  // Determine next auto-refresh based on user's plan
  const user = await prisma.user.findUnique({
    where: { id: account.userId },
    select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true },
  });

  let autoRefreshHours = 24;
  if (user) {
    const plan = getEffectivePlan(user);
    autoRefreshHours = plan === 'pro' ? 12 : plan === 'essential' ? 12 : 24;
  }

  // Transient errors (provider 5xx, rate limits, DB outages) wake up after
  // 6h rather than the plan's normal 12/24h interval — the provider will
  // typically recover within hours, so re-checking sooner than the healthy
  // schedule is appropriate. Slower than the per-attempt 30s manual retry
  // path, so we don't hammer a recovering provider.
  const transient = isTransientError(result.error, result.errorStatus);
  const cooldownHours = result.error && transient ? 6 : autoRefreshHours;
  const nextRefresh = new Date(now.getTime() + cooldownHours * 60 * 60 * 1000);

  await prisma.gameStatsCache.upsert({
    where: { gameAccountId: account.id },
    create: {
      gameAccountId: account.id,
      rank: (result.rank ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
      stats: (result.stats ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
      lastFetched: now,
      nextRefreshAt: nextRefresh,
      fetchError: result.error?.slice(0, 500) ?? null,
      errorRetryCount: result.error ? 1 : 0,
      errorTransient: !!result.error && transient,
    },
    update: {
      rank: (result.rank ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
      stats: (result.stats ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
      lastFetched: now,
      nextRefreshAt: nextRefresh,
      fetchError: result.error?.slice(0, 500) ?? null,
      errorTransient: !!result.error && transient,
      ...(result.error
        ? { errorRetryCount: { increment: 1 } }
        : { errorRetryCount: 0 }),
    },
  });

  log.info({
    gameAccountId: account.id,
    game: account.game,
    hasRank: !!result.rank,
    hasStats: !!result.stats,
    error: result.error?.slice(0, 100),
  }, 'game stats refreshed');

  return !result.error;
}
