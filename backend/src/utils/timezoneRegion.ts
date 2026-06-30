// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Timezone-to-region mapping utility.
 *
 * Maps IANA timezone strings (e.g. "America/New_York") to broad geographic
 * regions for lightweight, privacy-preserving region bucketing.
 *
 * Security: all inputs are client-supplied strings. Functions never throw,
 * never eval, never touch SQL — pure string matching only.
 */

export const VALID_REGIONS = ['NA', 'EU', 'ASIA', 'SA', 'OCE', 'AF'] as const;
export type Region = typeof VALID_REGIONS[number];

/** IANA timezone format: Area/Location or Area/Sub/Location */
const TZ_PATTERN = /^[A-Za-z_]+\/[A-Za-z_/\-+]+$/;

/** South American cities/zones that fall under the America/ IANA prefix */
const SA_IDENTIFIERS = new Set([
  'Argentina',
  'Bogota',
  'Lima',
  'Santiago',
  'Sao_Paulo',
  'Caracas',
  'La_Paz',
  'Montevideo',
  'Asuncion',
  'Guyana',
  'Paramaribo',
  'Cayenne',
  'Manaus',
  'Belem',
  'Fortaleza',
  'Recife',
  'Bahia',
  'Campo_Grande',
  'Cuiaba',
  'Porto_Velho',
  'Rio_Branco',
  'Boa_Vista',
  'Santarem',
]);

/**
 * Validate that a string looks like a plausible IANA timezone identifier.
 * Does NOT check against the full IANA database — just format validation.
 */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string') return false;
  if (tz.length === 0 || tz.length > 100) return false;
  return TZ_PATTERN.test(tz);
}

/**
 * Map an IANA timezone string to a broad geographic region.
 * Returns null for invalid or unrecognised timezones.
 */
export function timezoneToRegion(tz: string): Region | null {
  if (!isValidTimezone(tz)) return null;

  if (tz.startsWith('America/')) {
    // Check whether this is a South American timezone
    for (const id of SA_IDENTIFIERS) {
      if (tz.includes(id)) return 'SA';
    }
    return 'NA';
  }

  if (tz.startsWith('Europe/')) return 'EU';
  if (tz.startsWith('Asia/')) return 'ASIA';
  if (tz.startsWith('Australia/') || tz.startsWith('Pacific/')) return 'OCE';
  if (tz.startsWith('Africa/')) return 'AF';
  if (tz.startsWith('Atlantic/') || tz.startsWith('Indian/')) return 'AF';

  return null;
}
