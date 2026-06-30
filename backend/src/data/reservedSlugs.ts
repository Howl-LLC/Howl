// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Reserved vanity-URL slugs.
 *
 * A claim of any slug in this set is rejected with `reason: 'reserved'`.
 *
 * Three buckets:
 *   1. Platform paths — slugs that collide with existing or planned routes
 *      on the SPA / API surface. Letting an owner claim `/admin` would mean
 *      the SPA's admin UI gets shadowed by a community-server landing page.
 *   2. Marketing — terms used (or likely to be used) in marketing pages and
 *      the public site. Reserving them prevents squatting.
 *   3. Abuse / slurs — a moderate denylist. Full slur detection is handled
 *      elsewhere; this is just a server-side block to keep the lowest-effort
 *      attempts from succeeding. Keep it small and focused on overt slurs;
 *      do not list false positives that legitimate communities might use.
 *
 * All entries MUST be lowercase. Membership is checked after slug
 * normalization (`normalizeSlug` in `utils/vanitySlug.ts`).
 */

const PLATFORM_PATHS = [
  'admin', 'api', 'app', 'assets', 'auth', 'backend', 'discover', 'download',
  'help', 'home', 'invite', 'join', 'legal', 'login', 'logout', 'me', 'mod',
  'new', 'oauth', 'panel', 'pricing', 'privacy', 'pro', 'register', 'reset',
  's', 'server', 'servers', 'settings', 'signin', 'signup', 'sitemap',
  'staff', 'static', 'status', 'support', 'terms', 'verify', 'webhook',
  'welcome', 'ws',
  // Adjacent platform / infra paths frequently used by SPA/CDN integrations.
  'cdn', 'console', 'dashboard', 'dev', 'docs', 'health', 'logs',
  'manifest', 'metrics', 'public', 'robots', 'root', 'sentry', 'service-worker',
  'sw', 'system', 'test', 'uploads', 'user', 'users', 'v1', 'v2',
];

const MARKETING = [
  'about', 'blog', 'careers', 'contact', 'docs', 'enterprise', 'features',
  'partners', 'press', 'team',
  // First-party brand terms — keep these reserved so they never resolve to a
  // community server.
  'howl', 'howlpro', 'howlapp', 'howlchat', 'howlbeta', 'official',
];

// Moderate slur / abuse denylist. Keep entries narrow and undeniably abusive
// — broader content moderation is layered elsewhere. Listed lowercase only.
const ABUSE = [
  'fag', 'faggot', 'nigger', 'nigga', 'kike', 'spic', 'chink', 'tranny',
  'retard', 'retarded', 'cunt', 'whore',
];

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  ...PLATFORM_PATHS,
  ...MARKETING,
  ...ABUSE,
].map((s) => s.toLowerCase()));

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}
