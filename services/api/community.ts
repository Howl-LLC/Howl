// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';

// Types

export interface CommunityEligibilityCheck {
  /** Stable key identifying the requirement (e.g. 'emailVerified'). */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Whether this requirement is satisfied. */
  met: boolean;
  /** Optional explanatory text. */
  explanation?: string | null;
  /** Legacy alias of `explanation` when not met — preserved by the backend for older clients. */
  blocker?: string | null;
  /** Optional CTA hint: 'mfa' | 'rulesChannel' | 'rules' | 'verification' | 'autoMod'. */
  fix?: string | null;
}

export interface CommunityEligibility {
  eligible: boolean;
  checks: CommunityEligibilityCheck[];
}

export interface DiscoveryEligibilityCheck extends CommunityEligibilityCheck {
  /** Numeric deltas the UI uses to render "needs N more X" hints. */
  remaining?: {
    daysShort?: number;
    membersShort?: number;
    /** Number of weeks (out of `thresholds.engagementWeeks`) that fall
     *  short of the distinct-messager bar. */
    weeksShort?: number;
    /** Current aggregate retention rate as a 0-100 integer percentage. */
    retentionRatePct?: number;
  };
}

export interface DiscoveryEligibility {
  eligible: boolean;
  /** True iff an admin has granted Server.discoveryListingOverride for
   *  this server — the panel renders an "(admin override)" tag in the
   *  eligible banner so owners see why their server qualifies despite
   *  failing per-row checks. Optional for older backends that predate
   *  the override mechanism. */
  overrideActive?: boolean;
  checks: DiscoveryEligibilityCheck[];
  thresholds: {
    minMembers: number;
    minAgeDays: number;
    minDistinctMessagersPerWeek: number;
    engagementWeeks: number;
    minRetentionRatePct: number;
  };
}

export interface CommunityConfig {
  communityEnabled: boolean;
  discoveryEnabled: boolean;
  category: string | null;
  subcategory: string | null;
  tags: string[];
  language: string;
  longDescription: string | null;
  bannerSplash: string | null;
  vanityUrl: string | null;
  /**
   * ISO timestamp of when the vanity-URL cooldown expires, or null if no
   * cooldown is active (no prior claim, or 30-day window already elapsed).
   * Used by settings UI to display "next change in N days" without provoking
   * a 429 from the claim endpoint. Optional because older backends predate
   * the cooldown feature and won't include the field in their response.
   */
  vanityChangeEligibleAt?: string | null;
  discoverableSince: string | null;
}

export interface VanityCheckResult {
  slug: string;
  available: boolean;
  reason?: 'taken' | 'reserved' | 'invalid' | 'denylisted';
}

export interface WelcomeChannelEntry {
  id: string;
  channelId: string;
  channelName?: string;
  description: string;
  emoji: string | null;
  position: number;
}

export interface WelcomeScreen {
  welcomeScreenEnabled: boolean;
  welcomeScreenDescription: string | null;
  welcomeChannels: WelcomeChannelEntry[];
}

export type ApplicationQuestionType = 'short_text' | 'long_text' | 'multiple_choice';

export interface ApplicationQuestion {
  id: string;
  prompt: string;
  type: ApplicationQuestionType;
  required: boolean;
  maxLength?: number | null;
  choices?: string[] | null;
}

export interface ApplicationAnswer {
  questionId: string;
  value: string;
}

export type ApplicationStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn';

export interface ServerApplicationSummary {
  id: string;
  serverId: string;
  status: ApplicationStatus;
  createdAt: string;
  decidedAt: string | null;
  /** Applicant-facing message included in the decision email (both accept
   *  and reject). Reviewer-supplied. */
  decisionNote: string | null;
  /** Moderator-only note saved to the row for the rest of the team. NEVER
   *  sent to the applicant. */
  internalNote: string | null;
  applicant: {
    id: string;
    username: string;
    discriminator?: string;
    avatar: string | null;
  };
  answers: ApplicationAnswer[];
}

export interface ServerApplicationsPage {
  applications: ServerApplicationSummary[];
  nextCursor: string | null;
}

export interface InsightsTimeSeriesPoint {
  date: string;
  members: number;
  joins: number;
  leaves: number;
  messages: number;
  retainedAfter7d: number;
  voiceMinutes?: number;
}

export interface ServerInsights {
  range: '7d' | '30d' | '90d';
  points: InsightsTimeSeriesPoint[];
}

// Module augmentation

declare module './core' {
  interface APIClient {
    serverCommunityEligibility(serverId: string): Promise<CommunityEligibility>;
    /**
     * Discovery-listing eligibility (separate from community-mode eligibility).
     * Adds size/age/activity bars on top of community quality checks; returns
     * the same shape so the UI can reuse the checklist component.
     */
    serverDiscoveryEligibility(serverId: string): Promise<DiscoveryEligibility>;
    // GET /community returns the canonical projection (vanityUrl,
    // discoverableSince + all metadata) — used by settings pages so reload
    // doesn't fall back to ServerSettings (which lacks those Server-row fields).
    serverCommunityGet(serverId: string): Promise<CommunityConfig>;
    // Backend returns the full canonical CommunityConfig;
    // callers still merge defensively in case fields are added later.
    serverCommunityEnable(serverId: string, body?: { discoveryEnabled?: boolean }): Promise<CommunityConfig>;
    serverCommunityDisable(serverId: string): Promise<CommunityConfig>;
    serverCommunityUpdate(serverId: string, body: Partial<Pick<CommunityConfig, 'category' | 'subcategory' | 'tags' | 'language' | 'longDescription' | 'bannerSplash' | 'discoveryEnabled'>>): Promise<CommunityConfig>;

    serverVanityClaim(serverId: string, slug: string): Promise<{ vanityUrl: string }>;
    serverVanityRelease(serverId: string): Promise<void>;
    vanityCheck(slug: string): Promise<VanityCheckResult>;

    serverWelcomeGet(serverId: string): Promise<WelcomeScreen>;
    serverWelcomePatch(serverId: string, body: Partial<Pick<WelcomeScreen, 'welcomeScreenEnabled' | 'welcomeScreenDescription'>>): Promise<WelcomeScreen>;
    serverWelcomeChannelAdd(serverId: string, body: { channelId: string; description: string; emoji?: string | null; position?: number }): Promise<WelcomeChannelEntry>;
    serverWelcomeChannelUpdate(serverId: string, channelEntryId: string, body: Partial<{ description: string; emoji: string | null; position: number }>): Promise<WelcomeChannelEntry>;
    serverWelcomeChannelDelete(serverId: string, channelEntryId: string): Promise<void>;

    serverApplicationsQuestionsGet(serverId: string): Promise<{ questions: ApplicationQuestion[] }>;
    serverApplicationsQuestionsPatch(serverId: string, questions: ApplicationQuestion[]): Promise<{ questions: ApplicationQuestion[] }>;
    serverApplicationsList(serverId: string, opts?: { status?: ApplicationStatus; cursor?: string | null; take?: number }): Promise<ServerApplicationsPage>;
    serverApplicationDecide(serverId: string, appId: string, decision: 'accept' | 'reject', opts?: { note?: string; internalNote?: string }): Promise<ServerApplicationSummary>;

    serverInsights(serverId: string, range: '7d' | '30d' | '90d'): Promise<ServerInsights>;
  }
}

// Helpers

/**
 * Endpoints in this module ship across multiple backend units (2, 3, 6, 7, 8).
 * If an endpoint is not yet deployed, the backend returns 404. Treat that as
 * "feature not available yet" so the UI can render a graceful empty/loading
 * state rather than blowing up.
 *
 * Other errors (4xx / 5xx) propagate to the caller as before.
 */
async function requestOrEmpty<T>(client: APIClient, endpoint: string, options: RequestInit, fallback: T): Promise<T> {
  try {
    return await client.request<T>(endpoint, options);
  } catch (e) {
    const status = (e as { status?: number } | undefined)?.status;
    if (status === 404 || status === 501) return fallback;
    throw e;
  }
}

// Community lifecycle

APIClient.prototype.serverCommunityGet = async function(this: APIClient, serverId: string): Promise<CommunityConfig> {
  return this.request<CommunityConfig>(`/servers/${encodeURIComponent(serverId)}/community`, { method: 'GET' });
};

APIClient.prototype.serverCommunityEligibility = async function(this: APIClient, serverId: string): Promise<CommunityEligibility> {
  return requestOrEmpty<CommunityEligibility>(
    this,
    `/servers/${encodeURIComponent(serverId)}/community/eligibility`,
    { method: 'GET' },
    { eligible: false, checks: [] },
  );
};

APIClient.prototype.serverDiscoveryEligibility = async function(this: APIClient, serverId: string): Promise<DiscoveryEligibility> {
  return requestOrEmpty<DiscoveryEligibility>(
    this,
    `/servers/${encodeURIComponent(serverId)}/community/discovery-eligibility`,
    { method: 'GET' },
    {
      eligible: false,
      overrideActive: false,
      checks: [],
      thresholds: {
        minMembers: 1000,
        minAgeDays: 60,
        minDistinctMessagersPerWeek: 30,
        engagementWeeks: 4,
        minRetentionRatePct: 50,
      },
    },
  );
};

APIClient.prototype.serverCommunityEnable = async function(this: APIClient, serverId: string, body?: { discoveryEnabled?: boolean }): Promise<CommunityConfig> {
  return this.request<CommunityConfig>(`/servers/${encodeURIComponent(serverId)}/community/enable`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  });
};

APIClient.prototype.serverCommunityDisable = async function(this: APIClient, serverId: string): Promise<CommunityConfig> {
  return this.request<CommunityConfig>(`/servers/${encodeURIComponent(serverId)}/community/disable`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
};

APIClient.prototype.serverCommunityUpdate = async function(this: APIClient, serverId: string, body): Promise<CommunityConfig> {
  return this.request<CommunityConfig>(`/servers/${encodeURIComponent(serverId)}/community`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
};

// Vanity URLs

APIClient.prototype.serverVanityClaim = async function(this: APIClient, serverId: string, slug: string): Promise<{ vanityUrl: string }> {
  return this.request<{ vanityUrl: string }>(`/servers/${encodeURIComponent(serverId)}/vanity`, {
    method: 'POST',
    body: JSON.stringify({ slug }),
  });
};

APIClient.prototype.serverVanityRelease = async function(this: APIClient, serverId: string): Promise<void> {
  await this.request<void>(`/servers/${encodeURIComponent(serverId)}/vanity`, { method: 'DELETE' });
};

APIClient.prototype.vanityCheck = async function(this: APIClient, slug: string): Promise<VanityCheckResult> {
  // Public endpoint — IP rate-limited. Fall back to "available" when backend
  // hasn't shipped yet so the UI doesn't lock the submit button.
  const safe = encodeURIComponent(slug);
  return requestOrEmpty<VanityCheckResult>(
    this,
    `/vanity/check?slug=${safe}`,
    { method: 'GET' },
    { slug, available: true },
  );
};

// Welcome screen

APIClient.prototype.serverWelcomeGet = async function(this: APIClient, serverId: string): Promise<WelcomeScreen> {
  return requestOrEmpty<WelcomeScreen>(
    this,
    `/servers/${encodeURIComponent(serverId)}/welcome`,
    { method: 'GET' },
    { welcomeScreenEnabled: false, welcomeScreenDescription: null, welcomeChannels: [] },
  );
};

APIClient.prototype.serverWelcomePatch = async function(this: APIClient, serverId: string, body): Promise<WelcomeScreen> {
  return this.request<WelcomeScreen>(`/servers/${encodeURIComponent(serverId)}/welcome`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
};

APIClient.prototype.serverWelcomeChannelAdd = async function(this: APIClient, serverId: string, body): Promise<WelcomeChannelEntry> {
  return this.request<WelcomeChannelEntry>(`/servers/${encodeURIComponent(serverId)}/welcome/channels`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
};

APIClient.prototype.serverWelcomeChannelUpdate = async function(this: APIClient, serverId: string, channelEntryId: string, body): Promise<WelcomeChannelEntry> {
  return this.request<WelcomeChannelEntry>(`/servers/${encodeURIComponent(serverId)}/welcome/channels/${encodeURIComponent(channelEntryId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
};

APIClient.prototype.serverWelcomeChannelDelete = async function(this: APIClient, serverId: string, channelEntryId: string): Promise<void> {
  await this.request<void>(`/servers/${encodeURIComponent(serverId)}/welcome/channels/${encodeURIComponent(channelEntryId)}`, {
    method: 'DELETE',
  });
};

// Applications

APIClient.prototype.serverApplicationsQuestionsGet = async function(this: APIClient, serverId: string): Promise<{ questions: ApplicationQuestion[] }> {
  return requestOrEmpty<{ questions: ApplicationQuestion[] }>(
    this,
    `/servers/${encodeURIComponent(serverId)}/applications/questions`,
    { method: 'GET' },
    { questions: [] },
  );
};

APIClient.prototype.serverApplicationsQuestionsPatch = async function(this: APIClient, serverId: string, questions: ApplicationQuestion[]): Promise<{ questions: ApplicationQuestion[] }> {
  return this.request<{ questions: ApplicationQuestion[] }>(`/servers/${encodeURIComponent(serverId)}/applications/questions`, {
    method: 'PATCH',
    body: JSON.stringify({ questions }),
  });
};

APIClient.prototype.serverApplicationsList = async function(this: APIClient, serverId: string, opts?: { status?: ApplicationStatus; cursor?: string | null; take?: number }): Promise<ServerApplicationsPage> {
  const qs = new URLSearchParams();
  if (opts?.status) qs.set('status', opts.status);
  if (opts?.cursor) qs.set('cursor', opts.cursor);
  if (opts?.take) qs.set('take', String(Math.min(50, Math.max(1, opts.take))));
  const tail = qs.toString();
  return requestOrEmpty<ServerApplicationsPage>(
    this,
    `/servers/${encodeURIComponent(serverId)}/applications${tail ? `?${tail}` : ''}`,
    { method: 'GET' },
    { applications: [], nextCursor: null },
  );
};

APIClient.prototype.serverApplicationDecide = async function(this: APIClient, serverId: string, appId: string, decision: 'accept' | 'reject', opts?: { note?: string; internalNote?: string }): Promise<ServerApplicationSummary> {
  return this.request<ServerApplicationSummary>(`/servers/${encodeURIComponent(serverId)}/applications/${encodeURIComponent(appId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ decision, note: opts?.note, internalNote: opts?.internalNote }),
  });
};

// Insights

APIClient.prototype.serverInsights = async function(this: APIClient, serverId: string, range: '7d' | '30d' | '90d'): Promise<ServerInsights> {
  return requestOrEmpty<ServerInsights>(
    this,
    `/servers/${encodeURIComponent(serverId)}/insights?range=${encodeURIComponent(range)}`,
    { method: 'GET' },
    { range, points: [] },
  );
};
/**
 * Welcome Screen / Apply-to-Join API.
 *
 * Endpoints:
 *   `GET /api/v1/servers/:id/welcome-screen`
 *   `GET /api/v1/servers/:id/application-form`,
 *   `POST /api/v1/servers/:id/applications`
 */

export interface WelcomeScreenChannelResp {
  channelId: string;
  emoji: string | null;
  description: string;
}

export interface WelcomeScreenResp {
  serverId: string;
  serverName: string;
  serverIcon: string | null;
  description: string;
  channels: WelcomeScreenChannelResp[];
  enabled: boolean;
}

export interface ApplicationSubmitResp {
  id: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
}

declare module './core' {
  interface APIClient {
    /** Fetch the welcome screen payload for a community-enabled server. */
    welcomeScreenGet(serverId: string): Promise<WelcomeScreenResp>;
    /** Submit an apply-to-join application with question answers + captcha.
     *  Questions themselves are delivered alongside the 202 response from
     *  `/invites/join` (see `joinServerByInvite`), so there is no separate
     *  GET form endpoint on the applicant side. */
    applicationSubmit(
      serverId: string,
      answers: ApplicationAnswer[],
      captchaToken: string,
    ): Promise<ApplicationSubmitResp>;
  }
}

APIClient.prototype.welcomeScreenGet = async function(this: APIClient, serverId: string): Promise<WelcomeScreenResp> {
  // Backend mounts the welcome routes under `/servers/:id/welcome` and returns
  // the admin-style shape (welcomeScreenEnabled / welcomeScreenDescription /
  // welcomeChannels). Adapt it here so the joiner-facing modal can stay on
  // the cleaner `WelcomeScreenResp` contract.
  const raw = await this.request<WelcomeScreen>(
    `/servers/${encodeURIComponent(serverId)}/welcome`,
  );
  return {
    serverId,
    serverName: '',
    serverIcon: null,
    description: raw.welcomeScreenDescription ?? '',
    channels: raw.welcomeChannels.map((c) => ({
      channelId: c.channelId,
      emoji: c.emoji ?? null,
      description: c.description,
    })),
    enabled: raw.welcomeScreenEnabled,
  };
};

APIClient.prototype.applicationSubmit = async function(
  this: APIClient,
  serverId: string,
  answers: ApplicationAnswer[],
  captchaToken: string,
): Promise<ApplicationSubmitResp> {
  return this.request<ApplicationSubmitResp>(
    `/servers/${encodeURIComponent(serverId)}/applications`,
    { method: 'POST', body: JSON.stringify({ answers, captchaToken }) },
  );
};
