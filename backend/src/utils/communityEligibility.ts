// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Community eligibility evaluation.
 *
 * Returns the same checklist that `GET …/community/eligibility` reports and
 * that `POST …/community/enable` enforces. Centralising the logic guarantees
 * the gate seen by mods on the eligibility screen is identical to the gate
 * the server runs server-side at enable time — no drift between UX and
 * enforcement.
 *
 * The evaluator only reads — it never writes. Callers decide whether to
 * surface the result or block on it.
 */

import { prisma } from '../db.js';

export type EligibilityCheckKey =
  | 'owner_email_verified'
  | 'owner_mfa_enabled'
  | 'rules_channel_set'
  | 'rules_populated'
  | 'verification_level_low_or_higher'
  | 'automod_spam_filter_enabled'
  | 'not_suspended'
  | 'category_set'
  | 'tags_set'
  | 'long_description_set'
  | 'banner_splash_set';

/**
 * Minimum length for the public long description. Short enough to keep
 * onboarding friction low, long enough to ensure owners write something
 * meaningful for the directory listing rather than a placeholder.
 */
const LONG_DESCRIPTION_MIN_CHARS = 30;

export interface EligibilityCheck {
  key: EligibilityCheckKey;
  /** User-facing requirement title (always present). */
  label: string;
  met: boolean;
  /** Sub-line explanation. Reflects the blocker text when `met=false`. */
  explanation: string | null;
  /** Legacy alias of `explanation` when not met — preserved for older clients. */
  blocker: string | null;
  /** CTA hint the frontend can wire to a button (e.g. 'mfa'). */
  fix: string | null;
}

const LABELS: Record<EligibilityCheckKey, { label: string; metExplanation: string | null; fix: string | null }> = {
  owner_email_verified: { label: 'Owner email verified', metExplanation: 'Your account email is verified.', fix: null },
  owner_mfa_enabled: { label: 'Two-factor authentication on the owner account', metExplanation: 'Two-factor authentication is active (authenticator app or passkey).', fix: 'mfa' },
  rules_channel_set: { label: 'Rules channel designated', metExplanation: 'A channel is set as the server rules channel.', fix: 'rulesChannel' },
  rules_populated: { label: 'Server rules populated', metExplanation: 'At least one rule is published.', fix: 'rules' },
  verification_level_low_or_higher: { label: 'Verification level Low or higher', metExplanation: 'New accounts must verify before chatting.', fix: 'verification' },
  automod_spam_filter_enabled: { label: 'Automod spam filter enabled', metExplanation: 'Spam filtering is on for this server.', fix: 'autoMod' },
  not_suspended: { label: 'Server is not suspended', metExplanation: 'Server is in good standing.', fix: null },
  category_set: { label: 'Category selected', metExplanation: 'A directory category is chosen.', fix: 'category' },
  tags_set: { label: 'At least one tag added', metExplanation: 'Tags help people discover your server.', fix: 'tags' },
  long_description_set: { label: 'Long description written', metExplanation: 'Public profile description is filled in.', fix: 'longDescription' },
  banner_splash_set: { label: 'Public banner uploaded', metExplanation: 'A banner is set for the public profile.', fix: 'bannerSplash' },
};

export interface EligibilityResult {
  eligible: boolean;
  checks: EligibilityCheck[];
}

/**
 * Legacy owner lookup by role display string.
 *
 * Ownership is authoritative via `Server.ownerId` (20260713
 * add_server_owner_id migration); the mutable `ServerMember.role` string is
 * a display artifact that can drift. This lookup exists only as a fallback
 * for rows the migration backfill could not resolve (`ownerId` still null),
 * matching the convention in `utils/permissions.ts` and `routes/gdpr.ts`.
 */
async function findLegacyOwnerUserId(serverId: string): Promise<string | null> {
  const owner = await prisma.serverMember.findFirst({
    where: {
      serverId,
      role: { equals: 'owner', mode: 'insensitive' },
    },
    select: { userId: true },
  });
  return owner?.userId ?? null;
}

/**
 * Verification level "low" or higher means new accounts (or unverified email)
 * are kept out of the server's chat surface — a Discord prerequisite for
 * Community. We treat the canonical strings the schema documents:
 *   none < low < medium < high < highest
 * `highest` isn't on the schema today but is reserved; we accept it
 * defensively so this helper doesn't have to be touched if it ships later.
 */
function meetsVerificationLevelLowOrHigher(level: string | null | undefined): boolean {
  if (!level) return false;
  return ['low', 'medium', 'high', 'highest'].includes(level);
}

function rulesPopulated(rules: unknown): boolean {
  if (!Array.isArray(rules)) return false;
  return rules.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

/**
 * Evaluate every eligibility check. The function is pure with respect to
 * Prisma — no caching, no mutation. Callers should treat the result as a
 * point-in-time snapshot.
 */
export async function evaluateCommunityEligibility(serverId: string): Promise<EligibilityResult> {
  const [server, settings] = await Promise.all([
    prisma.server.findUnique({
      where: { id: serverId },
      select: { id: true, suspendedAt: true, ownerId: true },
    }),
    prisma.serverSettings.findUnique({
      where: { serverId },
      select: {
        verificationLevel: true,
        rules: true,
        rulesChannelId: true,
        category: true,
        tags: true,
        longDescription: true,
        bannerSplash: true,
      },
    }),
  ]);

  const ownerUserId = server?.ownerId ?? (await findLegacyOwnerUserId(serverId));

  // Owner snapshot — email-verified and an active MFA factor are both
  // required. MFA counts any enrolled factor (TOTP secret or a passkey), not
  // just the `mfaEnabled` flag: legacy enrollments can predate the flag write.
  let ownerEmailVerified = false;
  let ownerMfaEnabled = false;
  if (ownerUserId) {
    const owner = await prisma.user.findUnique({
      where: { id: ownerUserId },
      select: {
        emailVerified: true,
        mfaEnabled: true,
        mfaTotpSecret: true,
        _count: { select: { passkeyCredentials: true } },
      },
    });
    ownerEmailVerified = owner?.emailVerified === true;
    ownerMfaEnabled =
      owner?.mfaEnabled === true ||
      !!owner?.mfaTotpSecret ||
      (owner?._count.passkeyCredentials ?? 0) > 0;
  }

  const automodSpamRule = await prisma.automodRule.findFirst({
    where: { serverId, type: 'spam_filter', enabled: true },
    select: { id: true },
  });

  const notSuspended = !!server && server.suspendedAt === null;

  // Public-listing metadata checks
  // The owner can configure these at any time — the form stays unlocked even
  // before community mode is on so they can fill it out up front. Each piece
  // of metadata is required because it ships in the /discover listing or the
  // public profile.
  const categorySet = !!(settings?.category && settings.category.trim().length > 0);
  const tagsSet = Array.isArray(settings?.tags) && (settings.tags as unknown[]).length > 0;
  const longDescriptionSet =
    !!settings?.longDescription && settings.longDescription.trim().length >= LONG_DESCRIPTION_MIN_CHARS;
  const bannerSplashSet = !!(settings?.bannerSplash && settings.bannerSplash.trim().length > 0);

  const raw: Array<{ key: EligibilityCheckKey; met: boolean; blocker: string | null }> = [
    {
      key: 'owner_email_verified',
      met: ownerEmailVerified,
      blocker: ownerEmailVerified ? null : 'Server owner must verify their email address.',
    },
    {
      key: 'owner_mfa_enabled',
      met: ownerMfaEnabled,
      blocker: ownerMfaEnabled ? null : 'Server owner must enable two-factor authentication.',
    },
    {
      key: 'rules_channel_set',
      met: !!settings?.rulesChannelId,
      blocker: settings?.rulesChannelId ? null : 'Designate a rules channel.',
    },
    {
      key: 'rules_populated',
      met: rulesPopulated(settings?.rules),
      blocker: rulesPopulated(settings?.rules) ? null : 'Add at least one server rule.',
    },
    {
      key: 'verification_level_low_or_higher',
      met: meetsVerificationLevelLowOrHigher(settings?.verificationLevel),
      blocker: meetsVerificationLevelLowOrHigher(settings?.verificationLevel)
        ? null
        : 'Raise verification level to Low or higher.',
    },
    {
      key: 'automod_spam_filter_enabled',
      met: !!automodSpamRule,
      blocker: automodSpamRule ? null : 'Enable an Automod spam filter rule.',
    },
    {
      key: 'not_suspended',
      met: notSuspended,
      blocker: notSuspended ? null : 'Server is suspended; contact Trust & Safety.',
    },
    {
      key: 'category_set',
      met: categorySet,
      blocker: categorySet ? null : 'Pick a category for your community.',
    },
    {
      key: 'tags_set',
      met: tagsSet,
      blocker: tagsSet ? null : 'Add at least one tag.',
    },
    {
      key: 'long_description_set',
      met: longDescriptionSet,
      blocker: longDescriptionSet
        ? null
        : `Write a long description of at least ${LONG_DESCRIPTION_MIN_CHARS} characters.`,
    },
    {
      key: 'banner_splash_set',
      met: bannerSplashSet,
      blocker: bannerSplashSet ? null : 'Upload a public banner.',
    },
  ];

  const checks: EligibilityCheck[] = raw.map((r) => {
    const meta = LABELS[r.key];
    return {
      key: r.key,
      label: meta.label,
      met: r.met,
      explanation: r.met ? meta.metExplanation : r.blocker,
      blocker: r.blocker,
      fix: r.met ? null : meta.fix,
    };
  });

  return {
    eligible: checks.every((c) => c.met),
    checks,
  };
}

/**
 * Vanity URL claim gate.
 *
 * A vanity URL is a perk reserved for community-quality servers — owners can
 * claim one only after their server passes every other community check, OR
 * after community mode is already enabled. Releasing/clearing a vanity is
 * always permitted regardless of state.
 *
 * Returns the eligibility snapshot alongside the boolean so callers can
 * render the same checklist without re-running the evaluator.
 */
export async function canClaimVanityUrl(
  serverId: string,
): Promise<{ canClaim: boolean; eligibility: EligibilityResult; communityEnabled: boolean }> {
  const [eligibility, settings] = await Promise.all([
    evaluateCommunityEligibility(serverId),
    prisma.serverSettings.findUnique({
      where: { serverId },
      select: { communityEnabled: true },
    }),
  ]);
  const communityEnabled = settings?.communityEnabled === true;
  return {
    canClaim: eligibility.eligible || communityEnabled,
    eligibility,
    communityEnabled,
  };
}

/**
 * Public-discovery gate for anonymous read endpoints.
 *
 * Returns `true` only if every guard is satisfied:
 *   1. `settings.communityEnabled` — owner has flipped on Community mode.
 *   2. `settings.discoveryEnabled` — owner has opted into the Discover
 *      directory + public preview surface.
 *   3. `server.suspendedAt === null` — Trust & Safety has not suspended
 *      the server.
 *   4. `server.hiddenFromDiscovery !== true` — admin / owner has not
 *      tombstoned the server out of the public surface.
 * Anonymous endpoints MUST translate `false` into a 404 (never 401/403);
 * existence of a private/suspended/hidden server is itself a leak.
 *
 * Synchronous + side-effect free so callers can reuse the same Prisma
 * read they already make for other fields. The caller is responsible for
 * ensuring the listed columns are SELECTed.
 */
export function isPubliclyDiscoverable(
  server: {
    suspendedAt: Date | null;
    hiddenFromDiscovery: boolean | null;
  },
  settings: { communityEnabled: boolean; discoveryEnabled: boolean },
): boolean {
  return (
    settings.communityEnabled === true &&
    settings.discoveryEnabled === true &&
    server.suspendedAt === null &&
    server.hiddenFromDiscovery !== true
  );
}
