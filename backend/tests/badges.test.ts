// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { computeBadges, applyBadgePrefs, BADGE_KEYS } from '../src/utils/badges.js';

// Deterministic earned set: 'staff' (DB) + 'pro' (plan) + 'beta'
// ('beta' is auto-earned because createdAt < BETA_CUTOFF default 2026-12-31).
const earnedUser = {
  badges: ['staff'],
  stripePlan: 'pro',
  stripeStatus: 'active',
  stripeSubscriptionId: 'sub_1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('computeBadges (regression - unchanged)', () => {
  it('merges DB badges, beta cutoff, and plan badges', () => {
    expect(computeBadges(earnedUser).sort()).toEqual(['beta', 'pro', 'staff']);
  });
});

describe('applyBadgePrefs', () => {
  it('returns [] when showBadges is false (master switch wins)', () => {
    expect(applyBadgePrefs({ ...earnedUser, showBadges: false })).toEqual([]);
  });

  it('shows all earned in canonical default order when no prefs', () => {
    expect(applyBadgePrefs(earnedUser)).toEqual(['staff', 'pro', 'beta']);
  });

  it('hides badges in the hidden deny-list', () => {
    expect(applyBadgePrefs({ ...earnedUser, badgeDisplay: { hidden: ['staff'], order: [] } }))
      .toEqual(['pro', 'beta']);
  });

  it('applies the order preference first, canonical default for the rest', () => {
    expect(applyBadgePrefs({ ...earnedUser, badgeDisplay: { hidden: [], order: ['beta', 'pro'] } }))
      .toEqual(['beta', 'pro', 'staff']);
  });

  it('ignores unearned keys in order/hidden (truth gate)', () => {
    expect(applyBadgePrefs({ ...earnedUser, badgeDisplay: { hidden: ['verified'], order: ['verified'] } }))
      .toEqual(['staff', 'pro', 'beta']);
  });

  it('shows a newly-earned badge by default (deny-list semantics)', () => {
    const r = applyBadgePrefs({
      ...earnedUser,
      badges: ['staff', 'bug_hunter'],
      badgeDisplay: { hidden: [], order: ['staff'] },
    });
    expect(r).toContain('bug_hunter');
  });

  it('degrades malformed badgeDisplay to no-prefs (never throws)', () => {
    expect(applyBadgePrefs({ ...earnedUser, badgeDisplay: 'garbage' })).toEqual(['staff', 'pro', 'beta']);
    expect(applyBadgePrefs({ ...earnedUser, badgeDisplay: { hidden: 'x', order: 7 } as unknown }))
      .toEqual(['staff', 'pro', 'beta']);
  });

  it('BADGE_KEYS is exactly the 7 canonical keys', () => {
    expect([...BADGE_KEYS].sort()).toEqual(
      ['beta', 'bug_hunter', 'early_supporter', 'pro', 'pro_essential', 'staff', 'verified'],
    );
  });
});
