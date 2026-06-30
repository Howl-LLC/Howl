// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Profanity filter for per-server profile nicknames.
 * Targets severe slurs and hate speech only — NOT mild language like "damn" or "hell".
 */

const SLURS: string[] = [
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
  'camel jockey',
  'sandnigger', 'sandnigga',
  'coon', 'coons',
  'darkie', 'darkies',
  'jiggaboo', 'jigaboo',
  'porchmonkey', 'porch monkey',
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
  'shemale', 'she-male',
  'hermaphrodite',
];

const LEET_MAP: Record<string, string> = {
  '@': 'a',
  '4': 'a',
  '8': 'b',
  '(': 'c',
  '3': 'e',
  '6': 'g',
  '1': 'i',
  '!': 'i',
  '|': 'i',
  '0': 'o',
  '5': 's',
  '$': 's',
  '7': 't',
  '+': 't',
  '%': 'x',
};

function decodeLeetspeak(text: string): string {
  let result = '';
  for (const ch of text) {
    result += LEET_MAP[ch] ?? ch;
  }
  return result;
}

function normalize(text: string): string {
  return decodeLeetspeak(text.toLowerCase())
    .replace(/[\s_\-.'*]+/g, '')
    .replace(/(.)\1{2,}/g, '$1$1');
}

/** Pre-computed normalized slurs — avoids re-normalizing the static list on every call */
const NORMALIZED_SLURS: { original: string; normalized: string }[] = SLURS.map(slur => ({
  original: slur,
  normalized: normalize(slur),
}));

export function containsProfanity(text: string): boolean {
  const normalized = normalize(text);
  for (const entry of NORMALIZED_SLURS) {
    if (normalized.includes(entry.normalized)) return true;
  }
  return false;
}

export function getProfanityMatches(text: string): string[] {
  const normalized = normalize(text);
  const matches: string[] = [];
  for (const entry of NORMALIZED_SLURS) {
    if (normalized.includes(entry.normalized)) {
      matches.push(entry.original);
    }
  }
  return [...new Set(matches)];
}
