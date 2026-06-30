// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// services/peerDialects.ts
// Picks the highest mutually-supported version within a capability family.
// Baseline: if no overlap, fall back to `<family>.v1` (guaranteed supported).

export function selectSframeDialect(selfCaps: string[], peerCaps: string[] | undefined | null): string {
  const peer = peerCaps ?? [];
  const selfSframe = selfCaps
    .filter(c => c.startsWith('sframe.v'))
    .map(c => parseInt(c.slice('sframe.v'.length), 10))
    .filter(n => Number.isInteger(n) && n >= 1);
  const peerSframe = peer
    .filter(c => c.startsWith('sframe.v'))
    .map(c => parseInt(c.slice('sframe.v'.length), 10))
    .filter(n => Number.isInteger(n) && n >= 1);
  const common = selfSframe.filter(v => peerSframe.includes(v));
  if (common.length === 0) return 'sframe.v1';
  return 'sframe.v' + Math.max(...common);
}

export function intersectSframeDialects(capLists: (string[] | undefined | null)[]): string {
  // For rotation: intersection across ALL participants.
  const sets = capLists.map(list => new Set((list ?? []).filter(c => c.startsWith('sframe.v'))));
  if (sets.length === 0) return 'sframe.v1';
  const [first, ...rest] = sets;
  const intersection = [...first].filter(x => rest.every(s => s.has(x)));
  const versions = intersection
    .map(c => parseInt(c.slice('sframe.v'.length), 10))
    .filter(n => Number.isInteger(n) && n >= 1);
  if (versions.length === 0) return 'sframe.v1';
  return 'sframe.v' + Math.max(...versions);
}

/**
 * Returns true if the keyFormat is a dialect this client understands.
 * Currently only 'sframe.v1' is supported. Callers should drop (with a
 * structured warning) any payload where this returns false.
 */
export function isSupportedKeyFormat(keyFormat: string | undefined): boolean {
  const format = keyFormat ?? 'sframe.v1';
  return format === 'sframe.v1';
}
