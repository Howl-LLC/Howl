// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression tests for the refund cross-account anti-bypass.
 *
 * Pre-fix, refund eligibility was tracked solely on per-User booleans
 * (hasUsedSubscriptionRefund / Gift / PowerUp). On account delete, the User
 * row vanishes and the booleans reset — so a user could refund their plan,
 * delete the account, sign up again with the same email + card, and refund
 * again indefinitely.
 *
 * Post-fix, every refund (self-serve, admin-initiated, and Stripe Dashboard
 * via the webhook) writes a RefundUsage row keyed by emailHash, stripeCustomerId,
 * and paymentMethodFingerprint. RefundUsage has no FK to User and survives
 * GDPR delete. Eligibility checks query this table — any match for the same
 * type blocks a fresh refund.
 *
 * `isRefundUsageBlocked` is the gating function. These tests verify it
 * recognizes each identifier independently so the fix can't be bypassed by
 * rotating one of the three.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../src/db.js';
import { isRefundUsageBlocked } from '../src/routes/billing.js';

async function clearRefundUsage() {
  await prisma.refundUsage.deleteMany({});
}

afterAll(async () => {
  await clearRefundUsage();
});

describe('isRefundUsageBlocked — refund cross-account anti-bypass', () => {
  beforeEach(async () => {
    await clearRefundUsage();
  });

  it('returns false when no RefundUsage rows exist for any identifier', async () => {
    const blocked = await isRefundUsageBlocked('subscription', {
      emailHash: 'fresh-email-hash',
      stripeCustomerId: 'cus_fresh',
      paymentMethodFingerprint: 'fp_fresh',
    });
    expect(blocked).toBe(false);
  });

  it('returns true when a row matches by emailHash for the same type', async () => {
    await prisma.refundUsage.create({
      data: { type: 'subscription', emailHash: 'rotating@victim.com_hash', stripeCustomerId: null, paymentMethodFingerprint: null },
    });
    const blocked = await isRefundUsageBlocked('subscription', {
      emailHash: 'rotating@victim.com_hash',
      stripeCustomerId: 'cus_brand_new',
      paymentMethodFingerprint: 'fp_brand_new',
    });
    expect(blocked).toBe(true);
  });

  it('returns true when a row matches by stripeCustomerId for the same type', async () => {
    await prisma.refundUsage.create({
      data: { type: 'gift', emailHash: null, stripeCustomerId: 'cus_known', paymentMethodFingerprint: null },
    });
    const blocked = await isRefundUsageBlocked('gift', {
      emailHash: 'totally-different-hash',
      stripeCustomerId: 'cus_known',
      paymentMethodFingerprint: null,
    });
    expect(blocked).toBe(true);
  });

  it('returns true when a row matches by paymentMethodFingerprint for the same type', async () => {
    await prisma.refundUsage.create({
      data: { type: 'power_up', emailHash: null, stripeCustomerId: null, paymentMethodFingerprint: 'fp_card_a' },
    });
    const blocked = await isRefundUsageBlocked('power_up', {
      emailHash: 'completely-new-hash',
      stripeCustomerId: 'cus_completely_new',
      paymentMethodFingerprint: 'fp_card_a',
    });
    expect(blocked).toBe(true);
  });

  it('does NOT block when the matching row is for a different type', async () => {
    // User refunded a gift previously — they should still be eligible for a subscription refund.
    await prisma.refundUsage.create({
      data: { type: 'gift', emailHash: 'shared-hash', stripeCustomerId: 'cus_shared', paymentMethodFingerprint: 'fp_shared' },
    });
    const blocked = await isRefundUsageBlocked('subscription', {
      emailHash: 'shared-hash',
      stripeCustomerId: 'cus_shared',
      paymentMethodFingerprint: 'fp_shared',
    });
    expect(blocked).toBe(false);
  });

  it('returns false when all identifiers are null (nothing to query against)', async () => {
    // If we were to OR no filters, Prisma would treat it as "match anything",
    // which would make any RefundUsage row block everyone. The function must
    // short-circuit and return false when there's nothing to check against.
    await prisma.refundUsage.create({
      data: { type: 'subscription', emailHash: 'some-hash', stripeCustomerId: 'cus_some', paymentMethodFingerprint: 'fp_some' },
    });
    const blocked = await isRefundUsageBlocked('subscription', {
      emailHash: null,
      stripeCustomerId: null,
      paymentMethodFingerprint: null,
    });
    expect(blocked).toBe(false);
  });

  it('blocks when only one of three identifiers matches (defense in depth)', async () => {
    // Account-delete-and-rotate-email scenario: the new account has a different
    // emailHash and stripeCustomerId, but the same card → fingerprint match.
    await prisma.refundUsage.create({
      data: { type: 'subscription', emailHash: 'old-account-hash', stripeCustomerId: 'cus_old', paymentMethodFingerprint: 'fp_card_x' },
    });
    const blocked = await isRefundUsageBlocked('subscription', {
      emailHash: 'new-account-hash',
      stripeCustomerId: 'cus_new',
      paymentMethodFingerprint: 'fp_card_x',
    });
    expect(blocked).toBe(true);
  });

  it('treats different types as independent — gift refund does not block subscription', async () => {
    await prisma.refundUsage.createMany({
      data: [
        { id: 'ru_gift', type: 'gift', emailHash: 'multi-refund-hash' },
        { id: 'ru_pu', type: 'power_up', emailHash: 'multi-refund-hash' },
      ],
    });
    const blockedSub = await isRefundUsageBlocked('subscription', {
      emailHash: 'multi-refund-hash',
      stripeCustomerId: null,
      paymentMethodFingerprint: null,
    });
    expect(blockedSub).toBe(false);

    const blockedGift = await isRefundUsageBlocked('gift', {
      emailHash: 'multi-refund-hash',
      stripeCustomerId: null,
      paymentMethodFingerprint: null,
    });
    expect(blockedGift).toBe(true);
  });
});
