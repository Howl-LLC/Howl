// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Vanity URL slug validation + normalization.
 *
 * Format: lowercase `[a-z0-9-]+`, 3–32 chars, no leading/trailing dash,
 * no consecutive dashes (`--`), not on the reserved list.
 *
 * Used by:
 *   - `routes/serverVanity.ts` — owner claim/clear endpoints + public check
 *   - any future Unit (frontend invite preview, etc.) that needs to validate
 *     a slug before sending it to the API
 */

import { isReservedSlug } from '../data/reservedSlugs.js';

export type VanitySlugError = 'invalid_format' | 'reserved';

export interface ValidationFailure {
  ok: false;
  reason: VanitySlugError;
}

export interface ValidationSuccess {
  ok: true;
  slug: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

const SLUG_FORMAT_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,30}[a-z0-9]$/;

/**
 * Normalize a candidate slug (trim + lowercase). Does NOT validate format.
 * Pair with `validateSlug` for the format/reserved checks.
 */
export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Validate a candidate vanity slug.
 *
 * Returns `{ ok: true, slug }` on success (slug is the normalized form to
 * persist) or `{ ok: false, reason }` on failure.
 *
 * Format rules enforced:
 *   - 3–32 characters total
 *   - characters from `[a-z0-9-]` only
 *   - first and last character must be alphanumeric (no leading/trailing dash)
 *   - no consecutive dashes (`--`)
 *
 * The single regex above expresses all four format rules:
 *   - leading char `[a-z0-9]`
 *   - trailing char `[a-z0-9]`
 *   - middle chars `[a-z0-9]` OR a dash that is followed by an alphanumeric
 *     (`-(?=[a-z0-9])`), which forbids both `--` and trailing `-`
 *   - the `{1,30}` middle quantifier + 2 boundary chars yields 3–32 length
 */
export function validateSlug(input: unknown): ValidationResult {
  if (typeof input !== 'string') return { ok: false, reason: 'invalid_format' };
  const slug = normalizeSlug(input);
  if (slug.length < 3 || slug.length > 32) return { ok: false, reason: 'invalid_format' };
  if (!SLUG_FORMAT_RE.test(slug)) return { ok: false, reason: 'invalid_format' };
  if (isReservedSlug(slug)) return { ok: false, reason: 'reserved' };
  return { ok: true, slug };
}
