// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect } from 'react';
import { socketService } from '../services/socket';
import { useAuthStore } from '../stores/authStore';

/**
 * Registers the `subscription-updated` socket event.
 *
 * Emitted to `user:<userId>` whenever billing state changes on the backend:
 * - Stripe webhook (checkout, subscription updated/deleted, dispute, invoice, refund)
 * - Gift redeem
 * - Self-serve refund
 * - Admin plan grant
 * - Power-up changes
 *
 * Updates `authStore.currentUser` so every component that reads plan/status
 * re-renders immediately — no polling required.
 */
export function useBillingSocketEvents(opts: {
  currentUserId: string | undefined;
}): void {
  const { currentUserId } = opts;

  useEffect(() => {
    if (!currentUserId) return;

    socketService.onSubscriptionUpdated((data) => {
      useAuthStore.getState().updateCurrentUser({
        stripePlan: data.stripePlan,
        stripeStatus: data.stripeStatus,
        stripePeriodEnd: data.stripePeriodEnd,
      });
    });

    return () => {
      socketService.offSubscriptionUpdated();
    };
  }, [currentUserId]);
}
