// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Shared Prisma where-clause + ranking helpers for the discovery directory.
 *
 * Both the authenticated (`/api/v1/discover`) and anonymous
 * (`/api/v1/public/discover`) endpoints filter the same `Server` rows by the
 * same eligibility criteria; centralising the predicates here prevents the
 * two routes from drifting apart and makes the public-cannot-see-mature
 * invariant a single line of code instead of a per-route guard.
 *
 * Cursor format: base64(`<sortValue>|<id>`). The opaque encoding avoids
 * exposing internal sort orderings and keeps the cursor stable when the
 * sort field changes types (ints, dates, strings, doubles) by encoding
 * everything as text.
 */

// Categories

/**
 * Closed enum of discovery categories shared with the category schema.
 * Adding a new category requires updates here, in routes/serverCommunity.ts'
 * Zod enum, and in the directory front-end. Order is the display order on
 * the directory landing page.
 */
export const DISCOVERY_CATEGORIES = [
  'gaming',
  'music',
  'education',
  'science',
  'technology',
  'art',
  'entertainment',
  'lifestyle',
  'sports',
  'anime',
  'finance',
  'business',
  'community',
  'support',
  'other',
] as const;

export type DiscoveryCategory = typeof DISCOVERY_CATEGORIES[number];

export const DISCOVERY_CATEGORY_SET: ReadonlySet<string> = new Set(DISCOVERY_CATEGORIES);

// Tunables

/** Hard page-size cap for directory pages — enforces a `take ≤ 24` limit. */
export const DISCOVERY_PAGE_SIZE = 24;

/** Cap on FTS search query length to avoid pathological tsquery inputs. */
export const DISCOVERY_QUERY_MAX_LENGTH = 200;

/** Featured row size (admin-curated). */
export const DISCOVERY_FEATURED_LIMIT = 12;

// Sort type

export type DiscoverySort = 'relevance' | 'new' | 'members' | 'active';

// Cursor encode / decode

/**
 * Encode a cursor pair `(sortValue, id)` to base64. `sortValue` is rendered
 * as text — for dates pass `Date.toISOString()`, for numbers pass `String(n)`.
 */
export function encodeCursor(sortValue: string, id: string): string {
  const raw = `${sortValue}|${id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Returns null on malformed input; callers should treat null as "first page". */
export function decodeCursor(cursor: string | undefined | null): { sortValue: string; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const idx = decoded.lastIndexOf('|');
    if (idx <= 0 || idx === decoded.length - 1) return null;
    const sortValue = decoded.slice(0, idx);
    const id = decoded.slice(idx + 1);
    if (!id || id.length > 64) return null;
    if (sortValue.length > 64) return null;
    return { sortValue, id };
  } catch {
    return null;
  }
}

// ILIKE escaping (FTS fallback)

/**
 * Escape `%`, `_`, and backslashes for a Postgres `ILIKE` pattern. Used only
 * as a fallback when the FTS columns aren't present on Server/Settings — the
 * primary path is `plainto_tsquery`, which handles arbitrary input safely.
 */
export function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// Age helper

/**
 * Returns true when the user is under 18 today. A null DOB is treated as
 * under-18 so missing data falls into the strictest filter, matching the
 * NSFW spec's fail-closed behaviour.
 */
export function isUnderEighteen(dateOfBirth: Date | null | undefined): boolean {
  if (!dateOfBirth) return true;
  const today = new Date();
  let age = today.getFullYear() - dateOfBirth.getFullYear();
  const monthDiff = today.getMonth() - dateOfBirth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dateOfBirth.getDate())) age--;
  return age < 18;
}

// Category labels

/**
 * Display labels for `DISCOVERY_CATEGORIES`. Localisation lives on the
 * frontend; this is the canonical English fallback shipped with the API.
 */
export const DISCOVERY_CATEGORY_LABELS: Record<DiscoveryCategory, string> = {
  gaming: 'Gaming',
  music: 'Music',
  education: 'Education',
  science: 'Science & Tech',
  technology: 'Technology',
  art: 'Art',
  entertainment: 'Entertainment',
  lifestyle: 'Lifestyle',
  sports: 'Sports',
  anime: 'Anime & Manga',
  finance: 'Finance',
  business: 'Business',
  community: 'Community',
  support: 'Support',
  other: 'Other',
};

// Tag normalisation

/** Lowercased, trimmed, max-length-capped, deduped, capped at 5 tags. */
export function normaliseTags(input: string[] | undefined): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().toLowerCase().slice(0, 32);
    if (!t || seen.has(t)) continue;
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}
