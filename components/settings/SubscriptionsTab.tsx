// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Crown, HelpCircle, CheckCircle, XCircle } from 'lucide-react';
import { apiClient } from '../../services/api';
import { SettingsSection } from './SettingsWidgets';
import { isValidRedirectUrl } from '../../utils/securityUtils';
import { RefundConfirmModal } from './RefundConfirmModal';
import { useAppVisible } from '../../hooks/useAppVisible';
import { refundReasonToTooltip } from '../../utils/refundReasons';
import { useAuthStore } from '../../stores/authStore';

export interface SubscriptionsTabProps {
  onNavigate: (page: string) => void;
}

export const SubscriptionsTab: React.FC<SubscriptionsTabProps> = ({ onNavigate }) => {
  const { t } = useTranslation();
  const isElectron = !!(window as any).__ELECTRON_WINDOW__;
  const visible = useAppVisible();
  const [subscription, setSubscription] = useState<{ plan: string | null; status: string | null; currentPeriodEnd: string | null; hasUsedTrial?: boolean; trialStartedAt?: string | null } | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [refundEligibility, setRefundEligibility] = useState<{ eligible: boolean; chargeId?: string; amount?: number; currency?: string; chargeDate?: string; reason?: string } | null>(null);
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [refundLoading, setRefundLoading] = useState(false);
  const [refundResult, setRefundResult] = useState<{ success: boolean; message: string } | null>(null);

  // Authstore-driven re-fetch: when the global subscription-updated socket event
  // (handled by useBillingSocketEvents) updates these fields, this tab refreshes
  // its locally cached subscription + refund eligibility. Same path Stripe checkout
  // already uses for self-purchase, so gift redemption and self-buy stay symmetrical.
  const stripePlan = useAuthStore(s => s.currentUser?.stripePlan);
  const stripeStatus = useAuthStore(s => s.currentUser?.stripeStatus);
  const stripePeriodEnd = useAuthStore(s => s.currentUser?.stripePeriodEnd);

  const fetchSubscription = useCallback(async () => {
    try {
      setSubLoading(true);
      const data = await apiClient.getSubscription();
      setSubscription(data);
    } catch {
      setSubscription(null);
    } finally {
      setSubLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSubscription();
    apiClient.getRefundEligibility().then(data => setRefundEligibility(data.subscription)).catch(() => {});
  }, [fetchSubscription, stripePlan, stripeStatus, stripePeriodEnd]);

  useEffect(() => {
    if (visible && isElectron) {
      // Re-fetch subscription data when returning from external billing portal
      fetchSubscription();
    }
  }, [visible]);

  const handleOpenPortal = async () => {
    try {
      const { url } = await apiClient.createBillingPortal();
      if (url && isValidRedirectUrl(url)) {
        if (isElectron && window.electron?.openExternal) {
          window.electron.openExternal(url);
        } else {
          window.location.href = url;
        }
      }
    } catch (err) {
      console.error('Portal error:', err);
    }
  };

  const handleRefund = async (reason: string) => {
    setRefundLoading(true);
    try {
      const result = await apiClient.requestRefund('subscription', reason || undefined);
      setRefundResult({ success: true, message: t('billing.refund.success', { amount: (result.amount / 100).toFixed(2), currency: result.currency.toUpperCase() }) });
      setRefundModalOpen(false);
      fetchSubscription();
      apiClient.getRefundEligibility().then(data => setRefundEligibility(data.subscription)).catch(() => {});
    } catch (err: any) {
      setRefundResult({ success: false, message: err?.message || t('billing.refund.failed') });
      setRefundModalOpen(false);
    } finally {
      setRefundLoading(false);
    }
  };

  const isActive = subscription?.plan && (subscription.status === 'active' || subscription.status === 'trialing');
  const isTrialing = subscription?.status === 'trialing';
  const planLabel = subscription?.plan === 'essential' ? 'Howl Pro Essential' : subscription?.plan === 'pro' ? 'Howl Pro' : null;
  const statusLabel = isTrialing ? t('billing.subscriptions.statusTrial') : subscription?.status === 'active' ? t('billing.subscriptions.statusActive') : subscription?.status === 'past_due' ? t('billing.subscriptions.statusPastDue') : subscription?.status === 'canceled' ? t('billing.subscriptions.statusCanceled') : subscription?.status ?? t('billing.subscriptions.statusNone');
  const statusColor = isTrialing ? 'text-amber-400 bg-amber-500/20' : subscription?.status === 'active' ? 'text-emerald-400 bg-emerald-500/20' : subscription?.status === 'past_due' ? 'text-amber-400 bg-amber-500/20' : 'text-slate-400 bg-fill-active';
  const trialDaysRemaining = isTrialing && subscription?.currentPeriodEnd
    ? Math.max(0, Math.ceil((new Date(subscription.currentPeriodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : 0;

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>{t('settings.subscriptions')}</h2>
      <p className="text-xs mb-8" style={{ color: 'var(--text-secondary)' }}>{t('billing.subscriptions.subtitle')}</p>

      {refundResult && (
        <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border text-xs mb-4 ${refundResult.success ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
          <div className="flex items-center gap-2">
            {refundResult.success ? <CheckCircle size={14} className="shrink-0" /> : <XCircle size={14} className="shrink-0" />}
            <p>{refundResult.message}</p>
          </div>
          <button type="button" onClick={() => setRefundResult(null)} className="text-[10px] font-semibold opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      <SettingsSection title={t('billing.subscriptions.activePlans')} className="mb-6">
        <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>{t('billing.subscriptions.activePlansDesc')}</p>
        {subLoading ? (
          <div className="flex items-center gap-3 py-4 px-4 rounded-xl border border-default" style={{ backgroundColor: 'var(--bg-input)' }}>
            <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</p>
          </div>
        ) : isActive && planLabel ? (
          <div className="rounded-xl border border-[var(--glass-border)] overflow-hidden" style={{ backgroundColor: 'var(--bg-input)' }}>
            <div className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl border border-[var(--cyan-accent)]/30 flex items-center justify-center bg-[var(--cyan-accent)]/10"><Crown size={20} className="text-[var(--cyan-accent)]" /></div>
                <div>
                  <p className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{planLabel}</p>
                  <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {isTrialing
                      ? t('billing.subscriptions.trialEndsIn', { days: trialDaysRemaining })
                      : subscription.currentPeriodEnd ? t('billing.subscriptions.renewsOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) }) : t('billing.subscriptions.monthly')}
                  </p>
                </div>
              </div>
              <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-lg ${statusColor}`}>{statusLabel}</span>
            </div>
            <div className="flex gap-2 px-4 pb-4">
              <button id="setting-change-plan" type="button" onClick={handleOpenPortal} className="btn-secondary text-[10px] px-4 py-2">{t('billing.subscriptions.changePlan')}</button>
              <button id="setting-cancel-subscription" type="button" onClick={handleOpenPortal} className="btn-danger-soft text-[10px] px-4 py-2">{t('common.cancel')}</button>
              {refundEligibility !== null && (
                <button
                  id="setting-subscription-refund"
                  type="button"
                  disabled={!refundEligibility.eligible}
                  onClick={refundEligibility.eligible ? () => { setRefundModalOpen(true); setRefundResult(null); } : undefined}
                  title={refundEligibility.eligible ? undefined : refundReasonToTooltip(refundEligibility.reason, t)}
                  className={`text-[10px] font-semibold px-4 py-2 rounded-xl transition-all ${
                    refundEligibility.eligible
                      ? 'btn-cta-danger'
                      : 'bg-fill-active border border-[var(--border-strong)] text-[var(--text-secondary)] opacity-60 cursor-not-allowed'
                  }`}
                >
                  {t('billing.refund.requestButton')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 py-4 px-4 rounded-xl border border-default" style={{ backgroundColor: 'var(--bg-input)' }}>
            <div className="w-10 h-10 rounded-xl border border-[var(--glass-border)] flex items-center justify-center"><HelpCircle size={20} className="text-slate-500" /></div>
            <div>
              <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{t('billing.subscriptions.noActive')}</p>
              <button type="button" onClick={() => onNavigate('howl-pro')} className="text-[11px] text-[var(--cyan-accent)] hover:underline mt-1">{t('billing.subscriptions.exploreHowlPro')}</button>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t('billing.subscriptions.credits')}>
        <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>{t('billing.subscriptions.creditsDesc')}</p>
        <div className="flex items-center gap-3 py-4 px-4 rounded-xl border border-default" style={{ backgroundColor: 'var(--bg-input)' }}>
          <div className="w-10 h-10 rounded-xl border border-[var(--glass-border)] flex items-center justify-center"><HelpCircle size={20} className="text-slate-500" /></div>
          <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{t('billing.subscriptions.noCredits')}</p>
        </div>
      </SettingsSection>
      {refundModalOpen && refundEligibility?.eligible && (
        <RefundConfirmModal
          type="subscription"
          amount={refundEligibility.amount!}
          currency={refundEligibility.currency || 'usd'}
          loading={refundLoading}
          onConfirm={handleRefund}
          onCancel={() => setRefundModalOpen(false)}
        />
      )}
    </div>
  );
};

export default SubscriptionsTab;
