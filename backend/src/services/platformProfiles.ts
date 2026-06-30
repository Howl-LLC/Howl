// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Platform profile data fetchers.
 *
 * Fetches profile stats from Twitch, YouTube, GitHub, and Reddit.
 * Data is stored in ConnectedApp.profileData as JSON.
 */

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { getValidPlatformToken } from './platformTokens.js';
import { getEffectivePlan } from '../utils.js';
import { Prisma } from '../../generated/prisma-client-v7/client.js';

const log = logger.child({ module: 'platform-profiles' });

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';

export interface PlatformProfileResult {
  data: Record<string, unknown> | null;
  error: string | null;
}

// Twitch

async function fetchTwitchProfile(userId: string, providerId: string): Promise<PlatformProfileResult> {
  const token = await getValidPlatformToken(userId, 'twitch');
  if (!token) return { data: null, error: 'No valid Twitch token' };

  try {
    const userRes = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(providerId)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    const userData = (await userRes.json()) as { data?: Array<{ display_name: string; broadcaster_type: string; description: string; profile_image_url: string; created_at: string }> };
    const user = userData.data?.[0];
    if (!user) return { data: null, error: 'Twitch user not found' };

    const followRes = await fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${encodeURIComponent(providerId)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    const followData = (await followRes.json()) as { total?: number };

    return {
      data: {
        displayName: (user.display_name || '').slice(0, 128),
        broadcasterType: (user.broadcaster_type || '').slice(0, 32),
        description: (user.description || '').slice(0, 500),
        profileImageUrl: (user.profile_image_url || '').slice(0, 2048),
        createdAt: user.created_at || null,
        followers: typeof followData.total === 'number' ? followData.total : null,
      },
      error: null,
    };
  } catch (err) {
    log.warn({ err }, 'Twitch profile fetch failed');
    return { data: null, error: `Fetch error: ${(err as Error).message?.slice(0, 200)}` };
  }
}

// YouTube

async function fetchYouTubeProfile(userId: string): Promise<PlatformProfileResult> {
  const token = await getValidPlatformToken(userId, 'youtube');
  if (!token) return { data: null, error: 'No valid YouTube token' };

  try {
    const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    const body = (await res.json()) as {
      items?: Array<{
        id: string;
        snippet: { title: string; description: string; thumbnails: { default?: { url: string } } };
        statistics: { subscriberCount?: string; viewCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean };
      }>;
      error?: { message?: string };
    };

    const channel = body.items?.[0];
    if (!channel) return { data: null, error: body.error?.message || 'YouTube channel not found' };

    return {
      data: {
        channelId: (channel.id || '').slice(0, 128),
        title: (channel.snippet.title || '').slice(0, 128),
        description: (channel.snippet.description || '').slice(0, 500),
        thumbnailUrl: (channel.snippet.thumbnails?.default?.url || '').slice(0, 2048),
        subscriberCount: channel.statistics.hiddenSubscriberCount ? null : Number(channel.statistics.subscriberCount) || 0,
        viewCount: Number(channel.statistics.viewCount) || 0,
        videoCount: Number(channel.statistics.videoCount) || 0,
      },
      error: null,
    };
  } catch (err) {
    log.warn({ err }, 'YouTube profile fetch failed');
    return { data: null, error: `Fetch error: ${(err as Error).message?.slice(0, 200)}` };
  }
}

// GitHub

async function fetchGitHubProfile(userId: string): Promise<PlatformProfileResult> {
  const token = await getValidPlatformToken(userId, 'github');
  if (!token) return { data: null, error: 'No valid GitHub token' };

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Howl',
  };

  try {
    const userRes = await fetch('https://api.github.com/user', {
      headers,
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    const user = (await userRes.json()) as {
      login?: string; name?: string; avatar_url?: string; bio?: string;
      public_repos?: number; followers?: number; following?: number; created_at?: string;
    };
    if (!user.login) return { data: null, error: 'GitHub user not found' };

    // Fetch contribution data via GraphQL
    let totalContributions: number | null = null;
    let contributionDays: Array<{ date: string; count: number }> | null = null;
    try {
      const gqlRes = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query { viewer { contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { contributionCount date } } } } } }`,
        }),
        signal: AbortSignal.timeout(8000),
        redirect: 'manual',
      });
      const gqlData = (await gqlRes.json()) as {
        data?: { viewer?: { contributionsCollection?: { contributionCalendar?: {
          totalContributions?: number;
          weeks?: Array<{ contributionDays: Array<{ contributionCount: number; date: string }> }>;
        } } } };
      };
      const cal = gqlData.data?.viewer?.contributionsCollection?.contributionCalendar;
      if (cal) {
        totalContributions = cal.totalContributions ?? null;
        contributionDays = cal.weeks?.flatMap(w => w.contributionDays.map(d => ({ date: d.date, count: d.contributionCount }))) ?? null;
      }
    } catch (gqlErr) {
      log.warn({ err: gqlErr }, 'GitHub GraphQL contributions fetch failed (non-fatal)');
    }

    // Fetch top languages from recent repos
    let topLanguages: Array<{ name: string; count: number }> | null = null;
    try {
      const reposRes = await fetch('https://api.github.com/user/repos?sort=pushed&per_page=50&type=owner', {
        headers,
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      });
      const repos = (await reposRes.json()) as Array<{ language?: string | null; fork?: boolean }>;
      if (Array.isArray(repos)) {
        const langCounts = new Map<string, number>();
        for (const repo of repos) {
          if (repo.fork) continue;
          if (repo.language) {
            langCounts.set(repo.language, (langCounts.get(repo.language) || 0) + 1);
          }
        }
        topLanguages = [...langCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([name, count]) => ({ name, count }));
      }
    } catch (langErr) {
      log.warn({ err: langErr }, 'GitHub repos/languages fetch failed (non-fatal)');
    }

    return {
      data: {
        login: (user.login || '').slice(0, 64),
        name: (user.name || '').slice(0, 128),
        avatarUrl: (user.avatar_url || '').slice(0, 2048),
        bio: (user.bio || '').slice(0, 256),
        publicRepos: typeof user.public_repos === 'number' ? user.public_repos : null,
        followers: typeof user.followers === 'number' ? user.followers : null,
        following: typeof user.following === 'number' ? user.following : null,
        createdAt: user.created_at || null,
        totalContributions,
        contributionDays,
        topLanguages,
      },
      error: null,
    };
  } catch (err) {
    log.warn({ err }, 'GitHub profile fetch failed');
    return { data: null, error: `Fetch error: ${(err as Error).message?.slice(0, 200)}` };
  }
}

// Reddit

async function fetchRedditProfile(userId: string): Promise<PlatformProfileResult> {
  const token = await getValidPlatformToken(userId, 'reddit');
  if (!token) return { data: null, error: 'No valid Reddit token' };

  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'Howl/1.0',
  };

  try {
    const meRes = await fetch('https://oauth.reddit.com/api/v1/me', {
      headers,
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    const me = (await meRes.json()) as {
      name?: string; icon_img?: string; link_karma?: number; comment_karma?: number;
      created_utc?: number; subreddit?: { banner_img?: string; title?: string };
    };
    if (!me.name) return { data: null, error: 'Reddit user not found' };

    // Fetch trophies
    let trophies: Array<{ name: string; description: string | null }> = [];
    try {
      const trophyRes = await fetch('https://oauth.reddit.com/api/v1/me/trophies', {
        headers,
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      });
      const trophyData = (await trophyRes.json()) as {
        data?: { trophies?: Array<{ data: { name: string; description: string | null } }> };
      };
      trophies = (trophyData.data?.trophies || [])
        .slice(0, 30)
        .map(t => ({ name: (t.data.name || '').slice(0, 128), description: (t.data.description || '').slice(0, 256) }));
    } catch (trophyErr) {
      log.warn({ err: trophyErr }, 'Reddit trophies fetch failed (non-fatal)');
    }

    // Fetch moderated subreddits
    let moderatedSubs: Array<{ name: string; subscribers: number }> = [];
    try {
      const modRes = await fetch('https://oauth.reddit.com/subreddits/mine/moderator?limit=25', {
        headers,
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      });
      const modData = (await modRes.json()) as {
        data?: { children?: Array<{ data: { display_name: string; subscribers: number } }> };
      };
      moderatedSubs = (modData.data?.children || [])
        .slice(0, 25)
        .map(s => ({ name: (s.data.display_name || '').slice(0, 128), subscribers: s.data.subscribers || 0 }));
    } catch (modErr) {
      log.warn({ err: modErr }, 'Reddit moderated subs fetch failed (non-fatal)');
    }

    const iconImg = (me.icon_img || '').split('?')[0].slice(0, 2048);

    return {
      data: {
        username: (me.name || '').slice(0, 64),
        iconImg: iconImg || null,
        linkKarma: typeof me.link_karma === 'number' ? me.link_karma : null,
        commentKarma: typeof me.comment_karma === 'number' ? me.comment_karma : null,
        totalKarma: typeof me.link_karma === 'number' && typeof me.comment_karma === 'number'
          ? me.link_karma + me.comment_karma : null,
        createdUtc: typeof me.created_utc === 'number' ? me.created_utc : null,
        trophies,
        moderatedSubs,
      },
      error: null,
    };
  } catch (err) {
    log.warn({ err }, 'Reddit profile fetch failed');
    return { data: null, error: `Fetch error: ${(err as Error).message?.slice(0, 200)}` };
  }
}

// Dispatcher

export async function fetchPlatformProfile(userId: string, provider: string, providerId: string): Promise<PlatformProfileResult> {
  switch (provider) {
    case 'twitch': return fetchTwitchProfile(userId, providerId);
    case 'youtube': return fetchYouTubeProfile(userId);
    case 'github': return fetchGitHubProfile(userId);
    case 'reddit': return fetchRedditProfile(userId);
    default: return { data: null, error: `Unknown provider: ${provider}` };
  }
}

/**
 * Refresh profile data for a connected app and write to DB.
 * Returns true if data was successfully fetched.
 */
export async function refreshConnectedAppProfile(connectedAppId: string): Promise<boolean> {
  const app = await prisma.connectedApp.findUnique({
    where: { id: connectedAppId },
    select: { id: true, userId: true, provider: true, providerId: true },
  });
  if (!app) return false;

  const result = await fetchPlatformProfile(app.userId, app.provider, app.providerId);
  const now = new Date();

  // Determine next auto-refresh based on user's plan
  const user = await prisma.user.findUnique({
    where: { id: app.userId },
    select: { stripePlan: true, stripeStatus: true, stripePeriodEnd: true, stripeSubscriptionId: true },
  });

  let autoRefreshHours = 24;
  if (user) {
    const plan = getEffectivePlan(user);
    autoRefreshHours = plan === 'pro' ? 12 : plan === 'essential' ? 12 : 24;
  }

  const nextRefresh = new Date(now.getTime() + autoRefreshHours * 60 * 60 * 1000);

  await prisma.connectedApp.update({
    where: { id: app.id },
    data: {
      profileData: result.data ? (result.data as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      profileFetchedAt: now,
      nextProfileRefreshAt: nextRefresh,
    },
  });

  log.info({
    connectedAppId: app.id,
    provider: app.provider,
    hasData: !!result.data,
    error: result.error?.slice(0, 100),
  }, 'platform profile refreshed');

  return !result.error;
}
