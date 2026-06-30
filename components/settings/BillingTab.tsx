// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Crown, Check, X, Upload, Camera, Monitor, Hash,
  MessageSquare, Volume2, Palette, Type, Sparkles, Image, Clock,
  Loader2, AlertTriangle, CheckCircle, XCircle
} from 'lucide-react';
import { User } from '../../types';
import { apiClient } from '../../services/api';
import { isValidRedirectUrl } from '../../utils/securityUtils';
import { useAppVisible } from '../../hooks/useAppVisible';

export interface BillingTabProps {
  user: User;
  onNavigate: (page: string) => void;
}

const PerkRow = ({ label, included }: { label: string; included?: boolean }) => (
  <li className="flex items-center gap-2">
    {included ? <Check size={12} className="text-emerald-400 shrink-0" /> : <X size={12} className="text-t-secondary shrink-0" />}
    <span style={{ color: included ? 'var(--text-primary)' : 'var(--text-secondary)', opacity: included ? 1 : 0.5 }}>{label}</span>
  </li>
);

export const BillingTab: React.FC<BillingTabProps> = ({ user: _user, onNavigate }) => {
  const { t } = useTranslation();
  const isElectron = !!(window as unknown as { __ELECTRON_WINDOW__?: boolean }).__ELECTRON_WINDOW__;
  const visible = useAppVisible();

  const [subscription, setSubscription] = useState<{ plan: string | null; status: string | null; currentPeriodEnd: string | null; hasUsedTrial?: boolean; trialStartedAt?: string | null; cancelAtPeriodEnd?: boolean } | null>(null);
  const [prices, setPrices] = useState<{ essential: { amount: number; currency: string; interval: string } | null; pro: { amount: number; currency: string; interval: string } | null } | null>(null);
  const [_subLoading, setSubLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [trialEligible, setTrialEligible] = useState(false);

  // Two-step trial state
  const [trialSetupId, setTrialSetupId] = useState<string | null>(null);
  const [trialStatus, setTrialStatus] = useState<{ status: string; trialResult: string | null; message: string | null; plan: string } | null>(null);
  const [trialPolling, setTrialPolling] = useState(false);
  const pollingRef = useRef(false);

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

  const fetchTrialEligibility = useCallback(async () => {
    try {
      const { eligible } = await apiClient.getTrialEligibility();
      setTrialEligible(eligible);
    } catch {
      setTrialEligible(false);
    }
  }, []);

  useEffect(() => {
    fetchSubscription();
    fetchTrialEligibility();
    apiClient.getPrices().then(setPrices).catch(() => {
      setPrices({ essential: { amount: 2.99, currency: 'usd', interval: 'month' }, pro: { amount: 8.99, currency: 'usd', interval: 'month' } });
    });
  }, [fetchSubscription, fetchTrialEligibility]);

  // Electron: Stripe checkout/trial/portal opens in the system browser via
  // openExternal, so the user leaves and comes back. When the window becomes
  // visible again, refetch subscription + trial eligibility so the UI reflects
  // the webhook-driven state change. Matches ServerUpgradesTab's pattern.
  useEffect(() => {
    if (visible && isElectron) {
      fetchSubscription();
      fetchTrialEligibility();
    }
  }, [visible, isElectron, fetchSubscription, fetchTrialEligibility]);

  // Detect return from Stripe checkout and refresh subscription state
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    if (sessionId) {
      const url = new URL(window.location.href);
      url.searchParams.delete('session_id');
      window.history.replaceState({}, '', url.toString());
      fetchSubscription();
    }
  }, []);

  // Check URL for trial-setup redirect on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const setupParam = params.get('trial-setup');
    const setupIdParam = params.get('setupId');
    if (setupParam === 'pending' && setupIdParam) {
      setTrialSetupId(setupIdParam);
      setTrialPolling(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Poll for trial status
  useEffect(() => {
    if (!trialPolling || !trialSetupId) return;
    pollingRef.current = true;
    const poll = async () => {
      try {
        const result = await apiClient.getTrialStatus(trialSetupId);
        if (!pollingRef.current) return;
        if (result.status !== 'pending') {
          setTrialStatus(result);
          setTrialPolling(false);
          fetchSubscription();
          fetchTrialEligibility();
        }
      } catch {
        if (pollingRef.current) setTrialPolling(false);
      }
    };
    poll();
    const interval = setInterval(poll, 2000);
    const timeout = setTimeout(() => { if (pollingRef.current) setTrialPolling(false); }, 60000);
    return () => { pollingRef.current = false; clearInterval(interval); clearTimeout(timeout); };
  }, [trialPolling, trialSetupId, fetchSubscription, fetchTrialEligibility]);

  // In Electron, route Stripe redirects through the openExternal IPC so they
  // open in the system browser without navigating the app away. Web stays on
  // window.location.href so the checkout happens in the current tab and
  // Stripe's success redirect comes back into Howl.
  const openStripeUrl = (url: string) => {
    const w = window as unknown as { electron?: { openExternal?: (u: string) => Promise<{ success: boolean }> } };
    if (w.electron?.openExternal) {
      w.electron.openExternal(url).catch(() => { window.location.href = url; });
    } else {
      window.location.href = url;
    }
  };

  const handleSubscribe = async (plan: 'essential' | 'pro') => {
    try {
      setCheckoutLoading(plan);
      setCheckoutError(null);
      const { url } = await apiClient.createCheckoutSession(plan);
      if (url && isValidRedirectUrl(url)) openStripeUrl(url);
    } catch (err) {
      console.error('Checkout error:', err);
      setCheckoutError(t('billing.checkoutFailed'));
    } finally {
      setCheckoutLoading(null);
    }
  };

  const handleStartTrial = async (plan: 'essential' | 'pro') => {
    try {
      setCheckoutLoading(plan);
      setCheckoutError(null);
      const { url } = await apiClient.startTrial(plan);
      if (url && isValidRedirectUrl(url)) openStripeUrl(url);
    } catch (err) {
      console.error('Trial setup error:', err);
      setCheckoutError(t('billing.checkoutFailed'));
    } finally {
      setCheckoutLoading(null);
    }
  };

  const handleOpenPortal = async () => {
    try {
      const { url } = await apiClient.createBillingPortal();
      if (url && isValidRedirectUrl(url)) openStripeUrl(url);
    } catch (err) {
      console.error('Portal error:', err);
    }
  };


  const isActive = subscription?.plan && (subscription.status === 'active' || subscription.status === 'trialing') && !subscription.cancelAtPeriodEnd;
  const isCanceling = subscription?.cancelAtPeriodEnd && subscription.plan && subscription.status === 'active';
  const isTrialing = subscription?.status === 'trialing';
  const currentPlanLabel = subscription?.plan === 'essential' ? t('billing.howlProEssential') : subscription?.plan === 'pro' ? t('settings.howlPro') : null;

  const formatPrice = (p: { amount: number; currency: string; interval: string } | null | undefined) => {
    if (!p) return '$?.??/mo';
    const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: p.currency }).format(p.amount);
    return `${formatted}/${p.interval === 'year' ? 'yr' : 'mo'}`;
  };
  const essentialLabel = formatPrice(prices?.essential);
  const proLabel = formatPrice(prices?.pro);

  // Calculate trial days remaining
  const trialDaysRemaining = isTrialing && subscription?.currentPeriodEnd
    ? Math.max(0, Math.ceil((new Date(subscription.currentPeriodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : 0;

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>{t('settings.howlPro')}</h2>
      <p className="text-xs mb-6" style={{ color: 'var(--text-secondary)' }}>{t('billing.subtitle')}</p>

      {/* Trial result banners */}
      {trialPolling && (
        <div className="border border-[var(--cyan-accent)]/30 rounded-2xl p-6 mb-8 flex items-center gap-4" style={{ backgroundColor: 'var(--bg-panel)', backgroundImage: 'linear-gradient(135deg, color-mix(in srgb, var(--cyan-accent) 6%, transparent) 0%, transparent 100%)' }}>
          <Loader2 size={20} className="text-[var(--cyan-accent)] animate-spin shrink-0" />
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('billing.settingUpTrial')}</p>
            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('billing.verifyingPayment')}</p>
          </div>
        </div>
      )}

      {trialStatus?.trialResult === 'started' && (
        <div className="border border-emerald-500/30 rounded-2xl p-6 mb-8 flex flex-wrap items-center justify-between gap-4" style={{ backgroundColor: 'var(--bg-panel)', backgroundImage: 'linear-gradient(135deg, rgba(16,185,129,0.08) 0%, color-mix(in srgb, var(--cyan-accent) 6%, transparent) 100%)' }}>
          <div className="flex items-center gap-3">
            <CheckCircle size={20} className="text-emerald-400 shrink-0" />
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('billing.trialStarted')}</p>
              <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('billing.trialStartedDesc', { plan: trialStatus.plan === 'essential' ? 'Essential' : '' })}</p>
            </div>
          </div>
          <button type="button" onClick={() => { setTrialStatus(null); fetchSubscription(); }} className="text-[10px] font-semibold px-5 py-2.5 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 transition-all">
            {t('billing.gotIt')}
          </button>
        </div>
      )}

      {trialStatus?.trialResult === 'card_ineligible' && (
        <div className="border border-amber-500/30 rounded-2xl p-6 mb-8" style={{ backgroundColor: 'var(--bg-panel)', backgroundImage: 'linear-gradient(135deg, rgba(245,158,11,0.08) 0%, transparent 100%)' }}>
          <div className="flex items-center gap-3 mb-3">
            <AlertTriangle size={20} className="text-amber-400 shrink-0" />
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('billing.cardIneligible')}</p>
              <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('billing.cardIneligibleDesc')}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 ml-8">
            <button type="button" onClick={() => handleSubscribe('essential')} disabled={!!checkoutLoading} className="btn-cta text-[10px] font-semibold px-4 py-2 rounded-xl transition-all disabled:opacity-50">
              {checkoutLoading === 'essential' ? t('billing.redirecting') : t('billing.subscribeToPlan', { plan: 'Essential', price: essentialLabel, interpolation: { escapeValue: false } })}
            </button>
            <button type="button" onClick={() => handleSubscribe('pro')} disabled={!!checkoutLoading} className="btn-cta text-[10px] font-semibold px-4 py-2 rounded-xl transition-all disabled:opacity-50">
              {checkoutLoading === 'pro' ? t('billing.redirecting') : t('billing.subscribeToPlan', { plan: 'Pro', price: proLabel, interpolation: { escapeValue: false } })}
            </button>
          </div>
        </div>
      )}

      {trialStatus?.trialResult === 'failed' && (
        <div className="border border-red-500/30 rounded-2xl p-6 mb-8 flex flex-wrap items-center justify-between gap-4" style={{ backgroundColor: 'var(--bg-panel)', backgroundImage: 'linear-gradient(135deg, var(--danger-subtle) 0%, transparent 100%)' }}>
          <div className="flex items-center gap-3">
            <XCircle size={20} className="text-red-400 shrink-0" />
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('billing.somethingWentWrong')}</p>
              <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{trialStatus.message || t('billing.pleaseTryAgain')}</p>
            </div>
          </div>
          <button type="button" onClick={() => { setTrialStatus(null); setTrialSetupId(null); }} className="btn-secondary text-[10px] px-5 py-2.5">
            {t('billing.tryAgain')}
          </button>
        </div>
      )}

      {/* Active subscription banner */}
      {isActive && (
        <div id="setting-manage-subscription" className={`border rounded-2xl p-6 mb-8 flex flex-wrap items-center justify-between gap-4 ${isTrialing ? 'border-amber-500/30' : 'border-emerald-500/30'}`} style={{ backgroundColor: 'var(--bg-panel)', backgroundImage: isTrialing ? 'linear-gradient(135deg, rgba(245,158,11,0.08) 0%, color-mix(in srgb, var(--cyan-accent) 6%, transparent) 100%)' : 'linear-gradient(135deg, rgba(16,185,129,0.08) 0%, color-mix(in srgb, var(--cyan-accent) 6%, transparent) 100%)' }}>
          <div>
            <div className="flex items-center gap-2 mb-1">
              {isTrialing ? <Clock size={16} className="text-amber-400" /> : <Crown size={16} className="text-[var(--cyan-accent)]" />}
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{currentPlanLabel}</span>
              {isTrialing ? (
                <span className="text-[9px] font-semibold px-2 py-0.5 rounded-lg bg-amber-500/20 text-amber-400">{t('billing.trial')}</span>
              ) : (
                <span className="text-[9px] font-semibold px-2 py-0.5 rounded-lg bg-emerald-500/20 text-emerald-400">{t('billing.active')}</span>
              )}
            </div>
            {isTrialing ? (
              <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {t('billing.trialEndsIn', { days: trialDaysRemaining, date: subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : t('billing.trialEnd') })}
              </p>
            ) : subscription.currentPeriodEnd ? (
              <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {t('billing.renewsOn', { date: new Date(subscription.currentPeriodEnd).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) })}
              </p>
            ) : null}
          </div>
          <button type="button" onClick={() => onNavigate('subscriptions')} className="btn-secondary text-[10px] px-5 py-2.5">
            {t('billing.manageSubscription')}
          </button>
        </div>
      )}

      {/* Canceling subscription banner */}
      {isCanceling && (
        <div id="setting-resubscribe" className="border border-amber-500/30 rounded-2xl p-6 mb-8 flex flex-wrap items-center justify-between gap-4" style={{ backgroundColor: 'var(--bg-panel)', backgroundImage: 'linear-gradient(135deg, rgba(245,158,11,0.08) 0%, transparent 100%)' }}>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle size={16} className="text-amber-400" />
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{currentPlanLabel}</span>
              <span className="text-[9px] font-semibold px-2 py-0.5 rounded-lg bg-amber-500/20 text-amber-400">{t('billing.canceling')}</span>
            </div>
            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              {t('billing.subscriptionEndsOn', { date: subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : t('billing.yourBillingDate') })}
            </p>
          </div>
          <button type="button" onClick={handleOpenPortal} className="text-[10px] font-semibold px-5 py-2.5 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 transition-all">
            {t('billing.resubscribe')}
          </button>
        </div>
      )}

      {/* Promo section */}
      {!isActive && !isCanceling && (
        <div id="setting-start-free-trial" className="flex items-center gap-6 border border-[var(--glass-border)] rounded-2xl p-6 mb-8" style={{ backgroundColor: 'var(--bg-panel)', backgroundImage: trialEligible ? 'linear-gradient(135deg, rgba(245,158,11,0.08) 0%, color-mix(in srgb, var(--cyan-accent) 6%, transparent) 100%)' : 'linear-gradient(135deg, color-mix(in srgb, var(--cyan-accent) 6%, transparent) 0%, transparent 100%)' }}>
          <div className="w-16 h-16 shrink-0 rounded-2xl bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/20 flex items-center justify-center">
            <Crown size={24} className="text-[var(--cyan-accent)]" />
          </div>
          <div className="flex-1 min-w-0">
            {trialEligible ? (
              <>
                <h3 className="text-base font-black tracking-tight mb-0.5" style={{ color: 'var(--text-primary)' }}>{t('billing.tryFreeTitle')}</h3>
                <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>{t('billing.tryFreeDesc')}</p>
              </>
            ) : (
              <>
                <h3 className="text-base font-black tracking-tight mb-0.5" style={{ color: 'var(--text-primary)' }}>{t('billing.unlockTitle')}</h3>
                <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>{t('billing.unlockDesc', { price: essentialLabel, interpolation: { escapeValue: false } })}</p>
              </>
            )}
            <div className="flex flex-wrap gap-2">
              {trialEligible ? (
                <button type="button" onClick={() => handleStartTrial('pro')} disabled={!!checkoutLoading} className="flex items-center gap-2 text-[10px] font-semibold px-4 py-2 rounded-lg bg-amber-500 text-black hover:bg-amber-400 transition-all disabled:opacity-50">
                  {checkoutLoading ? t('billing.redirecting') : t('billing.startFreeTrial')}
                </button>
              ) : (
                <button type="button" onClick={() => handleSubscribe('essential')} disabled={!!checkoutLoading} className="btn-cta flex items-center gap-2 text-[10px] font-semibold px-4 py-2 rounded-xl transition-all disabled:opacity-50">
                  {checkoutLoading ? t('billing.redirecting') : t('billing.getStarted')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {checkoutError && (
        <div className="mt-2 mb-4 px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: 'var(--danger-subtle)', color: 'var(--danger)' }}>
          {checkoutError}
        </div>
      )}

      {/* Plan comparison */}
      <p className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>{t('billing.comparePlans')}</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10">
        {/* Free tier */}
        <div id="setting-plan-comparison-free" className="border border-[var(--glass-border)] rounded-2xl p-5 flex flex-col" style={{ backgroundColor: 'var(--bg-panel)' }}>
          <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>{t('billing.free')}</p>
          <p className="text-lg font-black mb-4" style={{ color: 'var(--text-primary)' }}>$0</p>
          <ul className="space-y-1.5 mb-6 flex-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            <PerkRow label={t('billing.perk50mbUploads')} included />
            <PerkRow label={t('billing.perk720pWebcam')} included />
            <PerkRow label={t('billing.perk1080p30ScreenShare')} included />
            <PerkRow label={t('billing.perkBitrate96')} included />
            <PerkRow label={t('billing.perkShowcase2')} included />
            <PerkRow label={t('billing.perkBannerColorOnly')} included />
            <PerkRow label={t('billing.perkShowcaseHero')} />
            <PerkRow label={t('billing.perkShowcaseMobile')} />
            <PerkRow label={t('billing.perkVideoCallBackground')} />
            <PerkRow label={t('billing.perkPowerUpSlots')} />
            <PerkRow label={t('billing.perkCustomBackground')} />
            <PerkRow label={t('billing.perkChangeDiscriminator')} />
            <PerkRow label={t('billing.perkUniversalEmoji')} />
            <PerkRow label={t('billing.perkStaticBackground')} />
            <PerkRow label={t('billing.perkAnimatedGifBg')} />
            <PerkRow label={t('billing.perkCustomNameColor')} />
            <PerkRow label={t('billing.perkColoredChatText')} />
            <PerkRow label={t('billing.perkProfileEffects')} />
          </ul>
          {!subscription?.plan && <span className="w-full text-center text-[10px] font-semibold py-2.5 rounded-xl bg-fill-hover text-t-secondary">{t('billing.current')}</span>}
        </div>
        {/* Essential */}
        <div id="setting-plan-comparison-essential" className={`border rounded-2xl p-5 flex flex-col ${subscription?.plan === 'essential' ? 'border-emerald-500/40' : 'border-[var(--glass-border)]'}`} style={{ backgroundColor: 'var(--bg-panel)' }}>
          {subscription?.plan === 'essential' && <span className="text-[9px] font-semibold px-2 py-0.5 rounded-lg bg-emerald-500/20 text-emerald-400 self-start mb-2">{t('billing.currentPlan')}</span>}
          <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>{t('billing.howlProEssential')}</p>
          <p className="text-lg font-black mb-4" style={{ color: 'var(--text-primary)' }}>{essentialLabel}</p>
          <ul className="space-y-1.5 mb-6 flex-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            <PerkRow label={t('billing.perk100mbUploads')} included />
            <PerkRow label={t('billing.perk1080p30Webcam')} included />
            <PerkRow label={t('billing.perk1080p60ScreenShare')} included />
            <PerkRow label={t('billing.perkBitrate128')} included />
            <PerkRow label={t('billing.perkShowcase4')} included />
            <PerkRow label={t('billing.perkBannerImageUpload')} included />
            <PerkRow label={t('billing.perkShowcaseMobile')} included />
            <PerkRow label={t('billing.perkVideoCallBackground')} included />
            <PerkRow label={t('billing.perkShowcaseHero')} />
            <PerkRow label={t('billing.perkPowerUpSlots')} />
            <PerkRow label={t('billing.perkChangeDiscriminator')} included />
            <PerkRow label={t('billing.perkUniversalEmoji')} included />
            <PerkRow label={t('billing.perkStaticBackground')} included />
            <PerkRow label={t('billing.perkAnimatedGifBg')} />
            <PerkRow label={t('billing.perkCustomNameColor')} />
            <PerkRow label={t('billing.perkColoredChatText')} />
            <PerkRow label={t('billing.perkProfileEffects')} />
          </ul>
          <div id="setting-subscribe-essential">
          {subscription?.plan === 'essential' ? (
            <button type="button" onClick={() => onNavigate('subscriptions')} className="btn-secondary w-full text-[10px] py-2.5">{t('billing.manage')}</button>
          ) : trialEligible ? (
            <button type="button" onClick={() => handleStartTrial('essential')} disabled={!!checkoutLoading} className="w-full text-[10px] font-semibold py-2.5 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30 transition-all disabled:opacity-50">
              {checkoutLoading === 'essential' ? t('billing.redirecting') : t('billing.startFreeTrial')}
            </button>
          ) : (
            <button type="button" onClick={() => handleSubscribe('essential')} disabled={!!checkoutLoading} className="btn-cta w-full text-[10px] font-semibold py-2.5 rounded-xl transition-all disabled:opacity-50">
              {checkoutLoading === 'essential' ? t('billing.redirecting') : t('billing.subscribe')}
            </button>
          )}
          </div>
        </div>
        {/* Pro */}
        <div id="setting-plan-comparison-pro" className={`border rounded-2xl p-5 flex flex-col relative ${subscription?.plan === 'pro' ? 'border-emerald-500/40' : 'border-[var(--cyan-accent)]/30'}`} style={{ backgroundColor: 'var(--bg-panel)', boxShadow: subscription?.plan !== 'pro' ? '0 0 0 1px color-mix(in srgb, var(--cyan-accent) 20%, transparent)' : undefined }}>
          {subscription?.plan === 'pro' ? (
            <span className="absolute top-3 right-3 text-[9px] font-semibold px-2 py-0.5 rounded-lg bg-emerald-500/20 text-emerald-400">{t('billing.currentPlan')}</span>
          ) : (
            <span className="absolute top-3 right-3 text-[9px] font-semibold px-2 py-0.5 rounded-lg bg-[var(--cyan-accent)]/20 text-[var(--cyan-accent)]">{t('billing.bestValue')}</span>
          )}
          <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.howlPro')}</p>
          <p className="text-lg font-black mb-4" style={{ color: 'var(--text-primary)' }}>{proLabel}</p>
          <ul className="space-y-1.5 mb-6 flex-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            <PerkRow label={t('billing.perk500mbUploads')} included />
            <PerkRow label={t('billing.perk1440p30Webcam')} included />
            <PerkRow label={t('billing.perk1440p60ScreenShare')} included />
            <PerkRow label={t('billing.perkBitrate384')} included />
            <PerkRow label={t('billing.perkShowcase12')} included />
            <PerkRow label={t('billing.perkBannerImageUpload')} included />
            <PerkRow label={t('billing.perkShowcaseHero')} included />
            <PerkRow label={t('billing.perkShowcaseMobile')} included />
            <PerkRow label={t('billing.perkVideoCallBackground')} included />
            <PerkRow label={t('billing.perkPowerUpSlots')} included />
            <PerkRow label={t('billing.perkChangeDiscriminator')} included />
            <PerkRow label={t('billing.perkUniversalEmoji')} included />
            <PerkRow label={t('billing.perkStaticAndGifBg')} included />
            <PerkRow label={t('billing.perkAnimatedGifBg')} included />
            <PerkRow label={t('billing.perkCustomNameColor')} included />
            <PerkRow label={t('billing.perkColoredChatText')} included />
            <PerkRow label={t('billing.perkProfileEffects')} included />
          </ul>
          <div id="setting-subscribe-pro">
          {subscription?.plan === 'pro' ? (
            <button type="button" onClick={() => onNavigate('subscriptions')} className="btn-secondary w-full text-[10px] py-2.5">{t('billing.manage')}</button>
          ) : trialEligible ? (
            <button type="button" onClick={() => handleStartTrial('pro')} disabled={!!checkoutLoading} className="w-full text-[10px] font-semibold py-2.5 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30 transition-all disabled:opacity-50">
              {checkoutLoading === 'pro' ? t('billing.redirecting') : t('billing.startFreeTrial')}
            </button>
          ) : (
            <button type="button" onClick={() => handleSubscribe('pro')} disabled={!!checkoutLoading} className="btn-cta w-full text-[10px] font-semibold py-2.5 rounded-xl transition-all disabled:opacity-50">
              {checkoutLoading === 'pro' ? t('billing.redirecting') : t('billing.subscribe')}
            </button>
          )}
          </div>
        </div>
      </div>

      {/* Premium perks list */}
      <p className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>{t('billing.includedWithPro')}</p>
      <div className="border border-default rounded-2xl overflow-hidden divide-y divide-[var(--border-subtle)]" style={{ backgroundColor: 'var(--bg-panel)' }}>
        {[
          { icon: <Upload size={16} className="text-[var(--cyan-accent)]" />, title: t('billing.featLargerUploads'), desc: t('billing.featLargerUploadsDesc') },
          { icon: <Camera size={16} className="text-[var(--cyan-accent)]" />, title: t('billing.featHdVideo'), desc: t('billing.featHdVideoDesc') },
          { icon: <Monitor size={16} className="text-[var(--cyan-accent)]" />, title: t('billing.featHdScreenShare'), desc: t('billing.featHdScreenShareDesc') },
          { icon: <Image size={16} className="text-[var(--cyan-accent)]" />, title: t('billing.featBannerUpload'), desc: t('billing.featBannerUploadDesc') },
          { icon: <Monitor size={16} className="text-[var(--cyan-accent)]" />, title: t('billing.featCustomBackground'), desc: t('billing.featCustomBackgroundDesc') },
          { icon: <Hash size={16} className="text-[var(--cyan-accent)]" />, title: t('billing.featCustomDiscriminator'), desc: t('billing.featCustomDiscriminatorDesc') },
          { icon: <MessageSquare size={16} className="text-[var(--cyan-accent)]" />, title: t('billing.featUniversalEmoji'), desc: t('billing.featUniversalEmojiDesc') },
          { icon: <Volume2 size={16} className="text-[var(--cyan-accent)]" />, title: t('billing.featHighBitrate'), desc: t('billing.featHighBitrateDesc') },
          { icon: <Palette size={16} className="text-[var(--cyan-accent)]" />, title: t('billing.featCustomNameColor'), desc: t('billing.featCustomNameColorDesc') },
          { icon: <Type size={16} className="text-[var(--cyan-accent)]" />, title: t('billing.featColoredChatText'), desc: t('billing.featColoredChatTextDesc') },
          { icon: <Sparkles size={16} className="text-[var(--cyan-accent)]" />, title: t('billing.featProfileEffects'), desc: t('billing.featProfileEffectsDesc') },
        ].map((item) => (
          <div key={item.title} className="flex items-center gap-4 px-5 py-3.5">
            <div className="w-8 h-8 rounded-lg bg-[var(--cyan-accent)]/10 flex items-center justify-center shrink-0">{item.icon}</div>
            <div className="flex-1 min-w-0">
              <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{item.title}</span>
              <span className="text-[11px] ml-2" style={{ color: 'var(--text-secondary)' }}>{item.desc}</span>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
};

export default BillingTab;
