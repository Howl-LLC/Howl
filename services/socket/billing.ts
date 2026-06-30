// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { SocketService } from './core';

/**
 * Subscription-updated event payload.
 * Emitted to `user:<userId>` when any billing state changes:
 * Stripe webhook, gift redeem, refund, admin plan grant, or power-up change.
 */
export interface SubscriptionUpdatedPayload {
  stripePlan: string | null;
  stripeStatus: string | null;
  stripePeriodEnd: string | null;
  powerUpPaidSlots?: number;
}

declare module './core' {
  interface SocketService {
    onSubscriptionUpdated(callback: (data: SubscriptionUpdatedPayload) => void): void;
    offSubscriptionUpdated(): void;
  }
}

SocketService.prototype.onSubscriptionUpdated = function(this: SocketService, callback: (data: SubscriptionUpdatedPayload) => void) {
  this.socket?.off('subscription-updated');
  this.socket?.on('subscription-updated', callback);
};

SocketService.prototype.offSubscriptionUpdated = function(this: SocketService) {
  this.socket?.off('subscription-updated');
};
