// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { TFunction } from 'i18next';

/**
 * Map an eligibility `reason` returned by GET /api/billing/refund-eligibility
 * to a user-facing tooltip string.
 *
 * The backend returns one of:
 *   'already_refunded' | 'no_billing_account' | 'no_active_subscription'
 *   | 'no_active_power_up' | 'no_eligible_gift' | 'no_eligible_charge'
 *   | 'check_failed' | 'unknown_type'
 *
 * 'already_refunded' is permanent (account-lifetime cap of 1 per category);
 * the others are temporary and the user might become eligible again later
 * (next charge, next gift purchase, etc.). Tooltip wording reflects this.
 */
export function refundReasonToTooltip(reason: string | undefined, t: TFunction): string {
  switch (reason) {
    case 'already_refunded':
      return t('billing.refund.tooltip.alreadyRefunded', 'Already used. Limit is 1 refund per category for the lifetime of the account.');
    case 'no_eligible_charge':
      return t('billing.refund.tooltip.noEligibleCharge', 'No eligible charge in the last 5 days.');
    case 'no_active_subscription':
      return t('billing.refund.tooltip.noActiveSubscription', "You don't have an active subscription to refund.");
    case 'no_active_power_up':
      return t('billing.refund.tooltip.noActivePowerUp', "You don't have an active power-up subscription to refund.");
    case 'no_eligible_gift':
      return t('billing.refund.tooltip.noEligibleGift', 'No pending gift purchased in the last 5 days.');
    case 'no_billing_account':
      return t('billing.refund.tooltip.noBillingAccount', 'No Stripe billing account on file.');
    case 'check_failed':
      return t('billing.refund.tooltip.checkFailed', "Couldn't check eligibility right now. Try again later.");
    default:
      return t('billing.refund.tooltip.notEligible', 'Not eligible for refund.');
  }
}
