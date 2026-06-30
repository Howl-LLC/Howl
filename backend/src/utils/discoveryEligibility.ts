// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Discovery-listing eligibility evaluation.
 *
 * Sister to `communityEligibility.ts`. Community-mode eligibility gates
 * whether a server can flip `communityEnabled=true` at all. THIS file
 * gates whether a community-mode server can additionally flip
 * `discoveryEnabled=true` and appear on the public community page.
 *
 * Anti-gaming design: each common discovery-spam pattern is defeated by
 * at least one independent check, so satisfying any one signal in
 * isolation is not enough.
 *
 *   - Botted membership      → fails `sustained_engagement_met`
 *                              (need real distinct talkers, not just bodies)
 *   - One chatty user        → fails `sustained_engagement_met`
 *                              (need ≥30 distinct people, not raw messages)
 *   - Pre-application spam   → fails `sustained_engagement_met`
 *                              (each of 4 weeks must clear the bar; one
 *                               big week + 3 dead weeks is filtered out)
 *   - Botted-then-pruned     → fails `member_retention_met`
 *                              (low 7-day cohort retention)
 *   - No real stickiness     → fails `member_retention_met`
 *
 * Special-case bypass: `Server.discoveryListingOverride` (admin-only)
 * waives the four quantitative gates plus the icon/description asset
 * gates, marking the server eligible regardless of size/age/activity.
 * The community-mode safety floor (rules, MFA, automod, banner, etc.)
 * is NOT bypassed — admin override is for "list this server early," not
 * "skip safety review." Per-check `met` flags stay HONEST when override
 * is active so the panel can show the real state alongside the override
 * banner. There is intentionally NO grandfather rule for verified
 * servers — verified is a pure trust badge, not a discovery shortcut.
 *
 * Pure function. No writes, no caching here — caller decides whether to
 * persist `ServerSettings.eligibleForDiscoverySince` from the result.
 */

import { prisma } from '../db.js';
import { evaluateCommunityEligibility } from './communityEligibility.js';

// Threshold constants
//
// Initial threshold values — surfaced to owners with a "may evolve as Howl grows"
// notice. Bump in lock-step with the eligibility-panel copy when changed.
export const DISCOVERY_MIN_MEMBERS = 100;
export const DISCOVERY_MIN_AGE_DAYS = 30;
/** Distinct human users that must send ≥1 message in EACH of the last
 *  ENGAGEMENT_WEEKS weeks. "In each week" (not "across the window") is
 *  what defeats one-week pre-application spam bursts. */
export const DISCOVERY_MIN_DISTINCT_MESSAGERS_PER_WEEK = 30;
export const DISCOVERY_ENGAGEMENT_WEEKS = 4;
/** Aggregate 7-day cohort retention required across the last 30 days:
 *  of all members who joined in the [d-37, d-7) window, what fraction
 *  was still present 7 days after their join. Aggregate (sum/sum) rather
 *  than per-day-mean so low-traffic days don't dominate the signal. */
export const DISCOVERY_MIN_RETENTION_RATE = 0.5;

const RETENTION_NUMERATOR_DAYS = 30;
const RETENTION_DENOMINATOR_OFFSET_DAYS = 7;
const RETENTION_LOOKBACK_DAYS =
  RETENTION_NUMERATOR_DAYS + RETENTION_DENOMINATOR_OFFSET_DAYS;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

export type DiscoveryEligibilityKey =
  | 'community_eligible'
  | 'minimum_age_met'
  | 'minimum_members_met'
  | 'sustained_engagement_met'
  | 'member_retention_met'
  | 'has_icon'
  | 'has_description';

/**
 * Mirrors `EligibilityCheck` from communityEligibility.ts (same field names
 * so frontend can render community + discovery checks with one component)
 * with a wider `key` type that includes both check sets, plus a `remaining`
 * field for numeric deltas ("needs N more X").
 */
export interface DiscoveryEligibilityCheck {
  /** Either a community check key (delegated) or a discovery-specific key. */
  key: DiscoveryEligibilityKey | string;
  label: string;
  met: boolean;
  explanation: string | null;
  blocker: string | null;
  fix: string | null;
  remaining?: {
    daysShort?: number;
    membersShort?: number;
    /** Number of weeks (out of ENGAGEMENT_WEEKS) that fall short of the
     *  distinct-messager bar — used for the "X of Y weeks fall short" hint. */
    weeksShort?: number;
    /** Current aggregate retention rate as a 0-100 integer percentage —
     *  rendered alongside the threshold in the eligibility panel. */
    retentionRatePct?: number;
  };
}

export interface DiscoveryEligibilityResult {
  eligible: boolean;
  /** True iff the admin discovery-listing override is active. The panel
   *  uses this to render an "(admin override)" tag in the eligible banner
   *  so owners can see why their server qualifies despite missing bars. */
  overrideActive: boolean;
  /** Frozen point-in-time snapshot of community + discovery checks. */
  checks: DiscoveryEligibilityCheck[];
  /** Echoed thresholds so the UI can show absolute targets next to deltas. */
  thresholds: {
    minMembers: number;
    minAgeDays: number;
    minDistinctMessagersPerWeek: number;
    engagementWeeks: number;
    minRetentionRatePct: number;
  };
}

const LABELS: Record<
  DiscoveryEligibilityKey,
  { label: string; metExplanation: string; fix: string | null }
> = {
  community_eligible: {
    label: 'Community mode prerequisites met',
    metExplanation: 'All Community-mode quality checks pass.',
    fix: 'community',
  },
  minimum_age_met: {
    label: `Server is at least ${DISCOVERY_MIN_AGE_DAYS} days old`,
    metExplanation: 'Server has been active long enough to be listed.',
    fix: null, // age is automatic — owner just waits
  },
  minimum_members_met: {
    label: `At least ${DISCOVERY_MIN_MEMBERS} members`,
    metExplanation: 'Server has reached the minimum member count.',
    fix: 'invites',
  },
  sustained_engagement_met: {
    label: `At least ${DISCOVERY_MIN_DISTINCT_MESSAGERS_PER_WEEK} different people chatting in each of the last ${DISCOVERY_ENGAGEMENT_WEEKS} weeks`,
    metExplanation: 'Server has sustained, healthy weekly conversation.',
    fix: null,
  },
  member_retention_met: {
    label: `At least ${Math.round(DISCOVERY_MIN_RETENTION_RATE * 100)}% of new members stay past 7 days`,
    metExplanation: 'New members are sticking around — healthy retention.',
    fix: null,
  },
  has_icon: {
    label: 'Server icon set',
    metExplanation: 'Server has a custom icon.',
    fix: 'icon',
  },
  has_description: {
    label: 'Server description set',
    metExplanation: 'Server has a public description.',
    fix: 'description',
  },
};

/**
 * Evaluate every discovery-listing check. Pure read; no caching, no writes.
 *
 * Caller (route handler / nightly worker) is responsible for persisting the
 * result into `ServerSettings.eligibleForDiscoverySince` and invalidating
 * the Redis cache.
 */
export async function evaluateDiscoveryEligibility(
  serverId: string,
): Promise<DiscoveryEligibilityResult> {
  const retentionWindowStart = new Date(Date.now() - RETENTION_LOOKBACK_DAYS * DAY_MS);

  const [server, settings, memberCount, dailyStats, weeklyMessagers, communityResult] = await Promise.all([
    prisma.server.findUnique({
      where: { id: serverId },
      select: { id: true, icon: true, createdAt: true, discoveryListingOverride: true },
    }),
    prisma.serverSettings.findUnique({
      where: { serverId },
      select: { description: true, longDescription: true },
    }),
    prisma.serverMember.count({ where: { serverId } }),
    // Retention math needs the wider 37-day window so the 30-day numerator
    // (retainedAfter7d for [today-30, today)) and the 30-day denominator
    // (joins for [today-37, today-7) — paired 7 days earlier) can be summed
    // from the same fetch. Each cohort's `retainedAfter7d` row is paired
    // implicitly with the `joins` row 7 days earlier.
    prisma.dailyServerStats.findMany({
      where: { serverId, date: { gte: retentionWindowStart } },
      select: { date: true, joins: true, retainedAfter7d: true },
      orderBy: { date: 'asc' },
    }),
    // Distinct-author counts per 7-day bucket across the last 28 days. We
    // use raw SQL because Prisma's groupBy doesn't support COUNT(DISTINCT).
    // Bucket 0 = last 7 days, 1 = 7-14d ago, 2 = 14-21d, 3 = 21-28d.
    // System messages (type='system') are excluded — they're auto-generated
    // and don't represent real conversation. Index used:
    // Message(channelId, createdAt) (schema.prisma).
    prisma.$queryRaw<Array<{ week_bucket: number; distinct_users: bigint }>>`
      SELECT
        FLOOR(EXTRACT(EPOCH FROM (NOW() - m."createdAt")) / ${WEEK_SECONDS})::int AS week_bucket,
        COUNT(DISTINCT m."authorId") AS distinct_users
      FROM "Message" m
      INNER JOIN "Channel" c ON m."channelId" = c.id
      WHERE c."serverId" = ${serverId}
        AND m."createdAt" >= NOW() - INTERVAL '28 days'
        AND m."type" = 'message'
      GROUP BY week_bucket
      ORDER BY week_bucket
    `,
    evaluateCommunityEligibility(serverId),
  ]);

  // Age / members deltas
  const ageMs = server ? Date.now() - server.createdAt.getTime() : 0;
  const ageDays = Math.floor(ageMs / DAY_MS);
  const daysShort = Math.max(0, DISCOVERY_MIN_AGE_DAYS - ageDays);

  const membersShort = Math.max(0, DISCOVERY_MIN_MEMBERS - memberCount);

  // Sustained engagement
  // Each of the 4 weekly buckets must independently clear the bar. Missing
  // bucket = 0 distinct users (week with no messages).
  const weekCounts = new Array<number>(DISCOVERY_ENGAGEMENT_WEEKS).fill(0);
  for (const row of weeklyMessagers) {
    if (row.week_bucket >= 0 && row.week_bucket < DISCOVERY_ENGAGEMENT_WEEKS) {
      weekCounts[row.week_bucket] = Number(row.distinct_users);
    }
  }
  const weeksMeetingBar = weekCounts.filter(
    (c) => c >= DISCOVERY_MIN_DISTINCT_MESSAGERS_PER_WEEK,
  ).length;
  const weeksShort = DISCOVERY_ENGAGEMENT_WEEKS - weeksMeetingBar;
  const sustainedEngagementMet = weeksShort === 0;

  // Member retention
  // Aggregate (sum/sum) cohort retention over the last 30 days. Numerator:
  // sum of `retainedAfter7d` for [today-30, today). Denominator: sum of
  // `joins` for [today-37, today-7) — i.e. the join days that the
  // numerator's retentions are derived from. Empty denominator (no joins
  // in window) → undefined rate → treat as MET so closed/stable communities
  // aren't penalised for lack of growth.
  const now = Date.now();
  const numStart = now - RETENTION_NUMERATOR_DAYS * DAY_MS;
  const denomStart = now - RETENTION_LOOKBACK_DAYS * DAY_MS;
  const denomEnd = now - RETENTION_DENOMINATOR_OFFSET_DAYS * DAY_MS;

  let retainedSum = 0;
  let joinsSum = 0;
  for (const row of dailyStats) {
    const d = row.date.getTime();
    if (d >= numStart && d < now) retainedSum += row.retainedAfter7d;
    if (d >= denomStart && d < denomEnd) joinsSum += row.joins;
  }
  // Clamp to [0, 1] — `retainedAfter7d` per row can't exceed `joins` from
  // 7 days earlier per row, but window-aggregated sums could in principle
  // diverge if the worker misses a day; clamp defensively.
  const retentionRate =
    joinsSum > 0 ? Math.min(1, retainedSum / joinsSum) : null;
  const retentionRatePct =
    retentionRate !== null ? Math.round(retentionRate * 100) : null;
  const memberRetentionMet =
    retentionRate === null || retentionRate >= DISCOVERY_MIN_RETENTION_RATE;

  // Description: either short description OR longDescription is OK
  // longDescription is the public-preview marketing copy; short description
  // is the in-app description. Either satisfies the gate.
  const hasDescription =
    !!(settings?.description && settings.description.trim().length > 0) ||
    !!(settings?.longDescription && settings.longDescription.trim().length > 0);

  // Build checks
  const raw: Array<{
    key: DiscoveryEligibilityKey;
    met: boolean;
    blocker: string | null;
    remaining?: DiscoveryEligibilityCheck['remaining'];
  }> = [
    {
      key: 'community_eligible',
      met: communityResult.eligible,
      blocker: communityResult.eligible
        ? null
        : 'Complete all Community-mode requirements first.',
    },
    {
      key: 'minimum_age_met',
      met: ageDays >= DISCOVERY_MIN_AGE_DAYS,
      blocker:
        ageDays >= DISCOVERY_MIN_AGE_DAYS
          ? null
          : `Server must be at least ${DISCOVERY_MIN_AGE_DAYS} days old (${daysShort} more day${daysShort === 1 ? '' : 's'} to go).`,
      remaining: { daysShort: ageDays >= DISCOVERY_MIN_AGE_DAYS ? 0 : daysShort },
    },
    {
      key: 'minimum_members_met',
      met: memberCount >= DISCOVERY_MIN_MEMBERS,
      blocker:
        memberCount >= DISCOVERY_MIN_MEMBERS
          ? null
          : `Server needs ${DISCOVERY_MIN_MEMBERS} members (${membersShort} more to go).`,
      remaining: { membersShort },
    },
    {
      key: 'sustained_engagement_met',
      met: sustainedEngagementMet,
      blocker: sustainedEngagementMet
        ? null
        : `Server needs at least ${DISCOVERY_MIN_DISTINCT_MESSAGERS_PER_WEEK} different active members in each of the last ${DISCOVERY_ENGAGEMENT_WEEKS} weeks (${weeksShort} week${weeksShort === 1 ? '' : 's'} fall short).`,
      remaining: { weeksShort },
    },
    {
      key: 'member_retention_met',
      met: memberRetentionMet,
      blocker: memberRetentionMet
        ? null
        : `Only ${retentionRatePct ?? 0}% of new members stay past 7 days; ${Math.round(DISCOVERY_MIN_RETENTION_RATE * 100)}% required.`,
      remaining: retentionRatePct !== null ? { retentionRatePct } : undefined,
    },
    {
      key: 'has_icon',
      met: !!server?.icon,
      blocker: server?.icon ? null : 'Upload a server icon.',
    },
    {
      key: 'has_description',
      met: hasDescription,
      blocker: hasDescription ? null : 'Add a server description.',
    },
  ];

  const checks: DiscoveryEligibilityCheck[] = raw.map((r) => {
    const meta = LABELS[r.key];
    return {
      key: r.key,
      label: meta.label,
      met: r.met,
      explanation: r.met ? meta.metExplanation : r.blocker,
      blocker: r.blocker,
      fix: r.met ? null : meta.fix,
      ...(r.remaining ? { remaining: r.remaining } : {}),
    };
  });

  // Eligibility resolution
  // Community-mode prereqs are a hard safety floor — never bypassed by the
  // admin override (rules / MFA / automod / banner / category / tags must
  // all be in place even for the official Howl server). Everything else
  // falls under the override umbrella.
  const overrideActive = server?.discoveryListingOverride === true;
  const nonCommunityChecksMet = checks
    .filter((c) => c.key !== 'community_eligible')
    .every((c) => c.met);
  const eligible =
    communityResult.eligible && (overrideActive || nonCommunityChecksMet);

  return {
    eligible,
    overrideActive,
    checks,
    thresholds: {
      minMembers: DISCOVERY_MIN_MEMBERS,
      minAgeDays: DISCOVERY_MIN_AGE_DAYS,
      minDistinctMessagersPerWeek: DISCOVERY_MIN_DISTINCT_MESSAGERS_PER_WEEK,
      engagementWeeks: DISCOVERY_ENGAGEMENT_WEEKS,
      minRetentionRatePct: Math.round(DISCOVERY_MIN_RETENTION_RATE * 100),
    },
  };
}
