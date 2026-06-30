// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Username content & quality filter.
 *
 * Single source of truth for what's a valid Howl account username. Plumbed into
 * `usernameSchema` (signup, self-rename, admin rename) and re-exports
 * `containsProfanity` for the per-server-nickname routes that already had a
 * weaker filter.
 *
 * Policy summary:
 *   - ASCII allowlist `[A-Za-z0-9._-]` for the unique-identifier `username`.
 *     Unicode expression lives at the per-server `nickname` layer instead, so
 *     homoglyph impersonation (Cyrillic А vs Latin A), bidi/RTL injection,
 *     zero-width duplicates, and Zalgo combining-mark spam are blocked at the
 *     account level.
 *   - No leading/trailing punctuation, no doubled separators.
 *   - Soft repetition cap (5+ same char in a row).
 *   - Case-insensitive reserved-name blocklist for system/role-impersonation.
 *   - Severe-slur blocklist run through `obscenity`'s pattern engine
 *     (leetspeak, confusables, whitelist transforms).
 *
 * The slur list is intentionally narrow — severe slurs and hate-speech terms
 * only, NOT mild language ("damn", "hell", "ass", "tit"). Keep it tight to
 * avoid false-positives on legitimate names.
 */

import {
  DataSet,
  RegExpMatcher,
  parseRawPattern,
  resolveConfusablesTransformer,
  resolveLeetSpeakTransformer,
  toAsciiLowerCaseTransformer,
} from 'obscenity';

export type UsernameRejection =
  | 'character_set'
  | 'punctuation'
  | 'repetition'
  | 'reserved'
  | 'profanity'
  | 'zero_width';

export type UsernameResult = { ok: true } | { ok: false; reason: UsernameRejection };

// Slur dataset
//
// Curated list of severe slurs and hate-speech terms. Plurals/variants are
// enumerated explicitly rather than relying on optional-character patterns,
// because the list is short and explicit is auditable.

const SLURS: readonly string[] = [
  'nigger', 'nigga', 'niggers', 'niggas',
  'faggot', 'faggots', 'fag', 'fags',
  'dyke', 'dykes',
  'tranny', 'trannies',
  'kike', 'kikes',
  'spic', 'spics', 'spick', 'spicks',
  'wetback', 'wetbacks',
  'beaner', 'beaners',
  'chink', 'chinks',
  'gook', 'gooks',
  'jap', 'japs',
  'raghead', 'ragheads',
  'towelhead', 'towelheads',
  'sandnigger', 'sandnigga',
  'coon', 'coons',
  'darkie', 'darkies',
  'jiggaboo', 'jigaboo',
  'porchmonkey',
  'zipperhead',
  'squaw',
  'redskin', 'redskins',
  'chinaman',
  'pajeet',
  'retard', 'retards', 'retarded',
  'wigger', 'wiggers',
  'cracker',
  'honky', 'honkey', 'honkies',
  'gringo', 'gringos',
  'shemale',
  'hermaphrodite',
  // Additions from obscenity's slur set:
  'abeed',
  'africoon',
  'arabush',
  'boonga',
  'chingchong',
];

const slurDataset = new DataSet<{ word: string }>();
for (const word of SLURS) {
  // `|word|` asserts word boundary on both sides, so "snigger" / "Bridgestone"
  // do not match `|nigger|`. Combined with the leetspeak/confusable transformers
  // below, this catches `n1gger`, `nιgger`, `n.i.g.g.e.r`, etc.
  slurDataset.addPhrase((p) => p.setMetadata({ word }).addPattern(parseRawPattern(`|${word}|`)));
}

// Custom transformer chain — confusables (Cyrillic А → Latin A), leetspeak
// (n1gger → nigger), and lowercase. Deliberately omits
// `collapseDuplicatesTransformer` because that would collapse "tranny" → "trany"
// at match time, breaking literal patterns. Repetition spam ("niggggger") is
// handled separately by the repetition rule in `validateUsername`.
const slurMatcher = new RegExpMatcher({
  ...slurDataset.build(),
  blacklistMatcherTransformers: [
    resolveConfusablesTransformer(),
    resolveLeetSpeakTransformer(),
    toAsciiLowerCaseTransformer(),
  ],
});

// Reserved names

export const RESERVED_NAMES: readonly string[] = [
  'admin',
  'administrator',
  'system',
  'moderator',
  'mod',
  'staff',
  'support',
  'howl',
  'bot',
  'null',
  'undefined',
  'everyone',
  'here',
  'root',
];

const RESERVED_SET = new Set(RESERVED_NAMES.map((n) => n.toLowerCase()));

// Zero-width / bidi control chars
//
// Defense-in-depth even though `stripControlChars` runs before this in the
// schema chain. Covers ZWSP (U+200B), ZWNJ (U+200C), ZWJ (U+200D),
// word-joiner (U+2060), BOM (U+FEFF), bidi overrides (U+202A–U+202E), and
// bidi isolates (U+2066–U+2069). Any of these characters is a hard reject
// regardless of the ASCII allowlist. Implemented as an explicit codepoint set
// so the source file stays free of literal invisible characters (also keeps
// the `security/detect-bidi-characters` ESLint rule happy).
const ZERO_WIDTH_CODEPOINTS: ReadonlySet<number> = new Set([
  0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF,
  0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
  0x2066, 0x2067, 0x2068, 0x2069,
]);

function hasZeroWidthChar(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && ZERO_WIDTH_CODEPOINTS.has(cp)) return true;
  }
  return false;
}

// Character allowlist
//
// Plain ASCII letters, digits, dot, underscore, hyphen. Anything else (Cyrillic,
// CJK, emoji, accented Latin, vertical-bar barcode, punctuation spam) is
// rejected as `character_set`.
const ALLOWLIST_RE = /^[A-Za-z0-9._-]+$/;

// Validator

/**
 * Run all username content rules against the input. Returns ok or the first
 * failing rule. Length is enforced earlier in the Zod chain — do not duplicate
 * it here.
 */
export function validateUsername(input: string): UsernameResult {
  if (hasZeroWidthChar(input)) return { ok: false, reason: 'zero_width' };

  if (!ALLOWLIST_RE.test(input)) return { ok: false, reason: 'character_set' };

  // Punctuation: no leading/trailing separator, no two non-alphanumerics in a row.
  if (/^[._-]/.test(input) || /[._-]$/.test(input)) return { ok: false, reason: 'punctuation' };
  if (/[._-]{2,}/.test(input)) return { ok: false, reason: 'punctuation' };

  // Repetition: reject 5+ of the same character consecutively.
  if (/(.)\1{4,}/.test(input)) return { ok: false, reason: 'repetition' };

  // Reserved names: case-insensitive exact match.
  if (RESERVED_SET.has(input.toLowerCase())) return { ok: false, reason: 'reserved' };

  // Profanity: obscenity engine with leetspeak/confusables/whitelist transforms.
  if (slurMatcher.hasMatch(input)) return { ok: false, reason: 'profanity' };

  return { ok: true };
}

/**
 * Backwards-compatible severity check used by per-server nickname routes
 * (`routes/servers.ts`). Same engine as `validateUsername` but only checks the
 * profanity rule — server nicknames legitimately contain spaces, accented
 * characters, emoji, etc., which the username allowlist would reject.
 */
export function containsProfanity(text: string): boolean {
  return slurMatcher.hasMatch(text);
}

/**
 * User-facing message for each rejection reason. Consumers can use this for
 * the `error` field in API responses; the structured `code` lets clients
 * localize independently.
 */
export function errorMessageForReason(reason: UsernameRejection): string {
  switch (reason) {
    case 'character_set':
      return 'Username may only contain letters, digits, and "._-". Use your per-server nickname for unicode.';
    case 'punctuation':
      return 'Username may not start, end with, or contain consecutive ".", "_", or "-".';
    case 'repetition':
      return 'Username may not repeat the same character 5 or more times in a row.';
    case 'reserved':
      return 'That username is reserved. Please choose another.';
    case 'profanity':
      return "That username isn't allowed. Please choose another.";
    case 'zero_width':
      return 'Username may not contain invisible or directional control characters.';
  }
}
