// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { PowerUpStatus, PowerUpableServer } from '../apiTypes';

declare module './core' {
  interface APIClient {
    createCheckoutSession(plan: 'essential' | 'pro'): Promise<{ url: string }>;
    startTrial(plan: 'essential' | 'pro'): Promise<{ url: string; setupId: string }>;
    getTrialStatus(setupId: string): Promise<{ status: string; trialResult: string | null; message: string | null; plan: string }>;
    createBillingPortal(): Promise<{ url: string }>;
    getSubscription(): Promise<{ plan: string | null; status: string | null; currentPeriodEnd: string | null; hasUsedTrial: boolean; trialStartedAt: string | null; cancelAtPeriodEnd?: boolean }>;
    getPrices(): Promise<{ essential: { amount: number; currency: string; interval: string } | null; pro: { amount: number; currency: string; interval: string } | null; powerUp: { amount: number; currency: string; interval: string } | null }>;
    getTrialEligibility(): Promise<{ eligible: boolean; reason: string | null }>;
    sendGift(plan: 'essential' | 'pro', durationMonths: number, recipientUsername?: string): Promise<{ url: string; code: string }>;
    redeemGiftCode(code: string): Promise<{ success: boolean; plan: string; durationMonths: number; periodEnd: string }>;
    getGifts(): Promise<{
      sent: Array<{ id: string; code: string; plan: string; durationMonths: number; recipientUsername: string | null; status: string; createdAt: string; expiresAt: string | null; recipient: { username: string; discriminator: string; avatar: string | null } | null }>;
      received: Array<{ id: string; plan: string; durationMonths: number; status: string; createdAt: string; redeemedAt: string | null; sender: { username: string; discriminator: string; avatar: string | null } }>;
    }>;
    assignGift(giftId: string, recipientUsername: string): Promise<{ success: boolean; gift: { id: string; code: string; plan: string; durationMonths: number; recipientUsername: string } }>;
    claimGift(giftId: string): Promise<{ success: boolean; plan: string; durationMonths: number; periodEnd: string }>;
    getPaymentMethods(): Promise<{ methods: Array<{ id: string; brand: string; last4: string; expMonth: number; expYear: number; isDefault: boolean }> }>;
    getTransactions(): Promise<{ transactions: Array<{ id: string; amount: number; currency: string; status: string; description: string; created: string; invoiceUrl: string | null; invoicePdf: string | null }> }>;
    getMyPowerUps(): Promise<PowerUpStatus>;
    getPowerUpableServers(): Promise<PowerUpableServer[]>;
    powerUpServer(serverId: string): Promise<{ success: boolean; powerUpCount: number; powerUpTier: number }>;
    removePowerUp(serverId: string): Promise<{ success: boolean; powerUpCount: number; powerUpTier: number }>;
    createPowerUpCheckout(quantity: number): Promise<{ url?: string; portalUrl?: string }>;
    managePowerUpSubscription(): Promise<{ url: string }>;
    getRefundEligibility(): Promise<{
      subscription: { eligible: boolean; chargeId?: string; amount?: number; currency?: string; chargeDate?: string; reason?: string };
      gift: { eligible: boolean; chargeId?: string; amount?: number; currency?: string; chargeDate?: string; reason?: string };
      power_up: { eligible: boolean; chargeId?: string; amount?: number; currency?: string; chargeDate?: string; reason?: string };
      hasUsed: { subscription: boolean; gift: boolean; power_up: boolean };
      policy: { windowDays: number; maxAmountUsd: number; perCategoryLimit: number };
    }>;
    requestRefund(type: 'subscription' | 'gift' | 'power_up', reason?: string): Promise<{ success: boolean; refundId: string; amount: number; currency: string; type: string }>;
  }
}

APIClient.prototype.createCheckoutSession = async function(this: APIClient, plan: 'essential' | 'pro'): Promise<{ url: string }> {
  return this.request('/billing/create-checkout', { method: 'POST', body: JSON.stringify({ plan }) });
};

APIClient.prototype.startTrial = async function(this: APIClient, plan: 'essential' | 'pro'): Promise<{ url: string; setupId: string }> {
  return this.request('/billing/start-trial', { method: 'POST', body: JSON.stringify({ plan }) });
};

APIClient.prototype.getTrialStatus = async function(this: APIClient, setupId: string): Promise<{ status: string; trialResult: string | null; message: string | null; plan: string }> {
  return this.request(`/billing/trial-status/${encodeURIComponent(setupId)}`);
};

APIClient.prototype.createBillingPortal = async function(this: APIClient): Promise<{ url: string }> {
  return this.request('/billing/create-portal', { method: 'POST' });
};

APIClient.prototype.getSubscription = async function(this: APIClient): Promise<{ plan: string | null; status: string | null; currentPeriodEnd: string | null; hasUsedTrial: boolean; trialStartedAt: string | null; cancelAtPeriodEnd?: boolean }> {
  return this.request('/billing/subscription');
};

APIClient.prototype.getPrices = async function(this: APIClient) {
  return this.request('/billing/prices');
};

APIClient.prototype.getTrialEligibility = async function(this: APIClient): Promise<{ eligible: boolean; reason: string | null }> {
  return this.request('/billing/trial-eligibility');
};

APIClient.prototype.sendGift = async function(this: APIClient, plan: 'essential' | 'pro', durationMonths: number, recipientUsername?: string) {
  return this.request('/billing/gift', { method: 'POST', body: JSON.stringify({ plan, durationMonths, recipientUsername }) });
};

APIClient.prototype.redeemGiftCode = async function(this: APIClient, code: string): Promise<{ success: boolean; plan: string; durationMonths: number; periodEnd: string }> {
  return this.request('/billing/redeem', { method: 'POST', body: JSON.stringify({ code }) });
};

APIClient.prototype.getGifts = async function(this: APIClient) {
  return this.request('/billing/gifts');
};

APIClient.prototype.assignGift = async function(this: APIClient, giftId: string, recipientUsername: string) {
  return this.request(`/billing/gifts/${encodeURIComponent(giftId)}/assign`, { method: 'POST', body: JSON.stringify({ recipientUsername }) });
};

APIClient.prototype.claimGift = async function(this: APIClient, giftId: string): Promise<{ success: boolean; plan: string; durationMonths: number; periodEnd: string }> {
  return this.request(`/billing/gifts/${encodeURIComponent(giftId)}/claim`, { method: 'POST' });
};

APIClient.prototype.getPaymentMethods = async function(this: APIClient) {
  return this.request('/billing/payment-methods');
};

APIClient.prototype.getTransactions = async function(this: APIClient) {
  return this.request('/billing/transactions');
};

APIClient.prototype.getMyPowerUps = async function(this: APIClient): Promise<PowerUpStatus> {
  return this.request('/power-ups/me');
};

APIClient.prototype.getPowerUpableServers = async function(this: APIClient): Promise<PowerUpableServer[]> {
  // Resolve server.icon from the backend's relative `/api/uploads/...` form
  // into the absolute CDN URL so the power-up settings list can actually load
  // custom server avatars (LazyGif/sanitizeImgSrc would otherwise resolve the
  // relative path against the frontend origin and 404).
  const servers = await this.request<PowerUpableServer[]>('/power-ups/servers');
  return servers.map((s) => ({
    ...s,
    icon: (this.resolveAssetUrl(s.icon) ?? s.icon) as string | null,
  }));
};

APIClient.prototype.powerUpServer = async function(this: APIClient, serverId: string): Promise<{ success: boolean; powerUpCount: number; powerUpTier: number }> {
  return this.request(`/power-ups/${serverId}`, { method: 'POST' });
};

APIClient.prototype.removePowerUp = async function(this: APIClient, serverId: string): Promise<{ success: boolean; powerUpCount: number; powerUpTier: number }> {
  return this.request(`/power-ups/${serverId}`, { method: 'DELETE' });
};

APIClient.prototype.createPowerUpCheckout = async function(this: APIClient, quantity: number) {
  return this.request('/billing/power-up-checkout', { method: 'POST', body: JSON.stringify({ quantity }) });
};

APIClient.prototype.managePowerUpSubscription = async function(this: APIClient) {
  return this.request('/billing/power-up-manage', { method: 'POST' });
};

APIClient.prototype.getRefundEligibility = async function(this: APIClient) {
  return this.request('/billing/refund-eligibility');
};

APIClient.prototype.requestRefund = async function(this: APIClient, type: 'subscription' | 'gift' | 'power_up', reason?: string) {
  return this.request('/billing/refund', { method: 'POST', body: JSON.stringify({ type, ...(reason ? { reason } : {}) }) });
};
