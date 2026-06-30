// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Rocket, Crown, Users, Shield, Sparkles, Check, X, Plus, Minus, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { apiClient, type PowerUpStatus, type PowerUpableServer } from '../../services/api';
import { SettingsSection } from './SettingsWidgets';
import { isValidRedirectUrl } from '../../utils/securityUtils';
import { RefundConfirmModal } from './RefundConfirmModal';
import { ServerIcon } from '../ServerIcon';
import { useAppVisible } from '../../hooks/useAppVisible';
import { refundReasonToTooltip } from '../../utils/refundReasons';

export interface ServerUpgradesTabProps {
  onNavigate: (page: string) => void;
}

export const ServerUpgradesTab: React.FC<ServerUpgradesTabProps> = ({ onNavigate }) => {
  const { t } = useTranslation();
  const isElectron = !!(window as any).__ELECTRON_WINDOW__;
  const visible = useAppVisible();
  const [powerUpStatus, setPowerUpStatus] = useState<PowerUpStatus | null>(null);
  const [powerUpServers, setPowerUpServers] = useState<PowerUpableServer[]>([]);
  const [powerUpLoading, setPowerUpLoading] = useState(false);
  const [powerUpLoadError, setPowerUpLoadError] = useState<string | null>(null);
  const [powerUpActionLoading, setPowerUpActionLoading] = useState<string | null>(null);
  const [purchaseQuantity, setPurchaseQuantity] = useState(1);
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [manageLoading, setManageLoading] = useState(false);
  const [powerUpPrice, setPowerUpPrice] = useState(3.99);
  const [serverUpgradesFaqOpen, setServerUpgradesFaqOpen] = useState<number | null>(null);
  const [subscription, setSubscription] = useState<{ plan: string | null; status: string | null; currentPeriodEnd: string | null } | null>(null);
  const [powerUpRefundEligibility, setPowerUpRefundEligibility] = useState<{ eligible: boolean; chargeId?: string; amount?: number; currency?: string; chargeDate?: string; reason?: string } | null>(null);
  const [powerUpRefundModalOpen, setPowerUpRefundModalOpen] = useState(false);
  const [powerUpRefundLoading, setPowerUpRefundLoading] = useState(false);
  const [powerUpRefundResult, setPowerUpRefundResult] = useState<{ success: boolean; message: string } | null>(null);

  const fetchSubscription = useCallback(async () => {
    try {
      const data = await apiClient.getSubscription();
      setSubscription(data);
    } catch {
      setSubscription(null);
    }
  }, []);

  useEffect(() => { fetchSubscription(); }, [fetchSubscription]);

  useEffect(() => {
    apiClient.getPrices().then(data => {
      if (data.powerUp?.amount) setPowerUpPrice(data.powerUp.amount);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    setPowerUpLoading(true);
    setPowerUpLoadError(null);
    Promise.all([apiClient.getMyPowerUps(), apiClient.getPowerUpableServers()])
      .then(([status, servers]) => { setPowerUpStatus(status); setPowerUpServers(servers); })
      .catch(() => setPowerUpLoadError(t('settings.serverUpgrades.failedToLoad')))
      .finally(() => setPowerUpLoading(false));
  }, []);

  useEffect(() => {
    apiClient.getRefundEligibility().then(data => setPowerUpRefundEligibility(data.power_up)).catch(() => {});
  }, []);

  useEffect(() => {
    if (visible && isElectron) {
      // Re-fetch power-up data when returning from external billing portal
      Promise.all([apiClient.getMyPowerUps(), apiClient.getPowerUpableServers()])
        .then(([status, servers]) => { setPowerUpStatus(status); setPowerUpServers(servers); })
        .catch(() => {});
      fetchSubscription();
    }
  }, [visible]);

  const isPro = subscription?.plan === 'pro';
  const formatCurrency = (amount: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
  const perksTable = [
    { perk: t('settings.serverUpgrades.emojiSlots'), l1: '100', l2: '150', l3: '250' },
    { perk: t('settings.serverUpgrades.stickerSlots'), l1: '15', l2: '30', l3: '60' },
    { perk: t('settings.serverUpgrades.soundboardSlots'), l1: '24', l2: '36', l3: '48' },
    { perk: t('settings.serverUpgrades.streamQuality'), l1: '1080p 60fps', l2: '1440p 30fps', l3: '1440p 60fps' },
    { perk: t('settings.serverUpgrades.audioQuality'), l1: '128kbps', l2: '256kbps', l3: '384kbps' },
    { perk: t('settings.serverUpgrades.uploadSizeLimit'), l1: '75MB', l2: '100MB', l3: '125MB' },
    { perk: t('settings.serverUpgrades.animatedServerIcon'), l1: true, l2: true, l3: true },
    { perk: t('settings.serverUpgrades.serverBanner'), l1: false, l2: t('settings.serverUpgrades.static'), l3: t('settings.serverUpgrades.animated') },
    { perk: t('settings.serverUpgrades.customRoleIcons'), l1: false, l2: true, l3: true },
    { perk: t('settings.serverUpgrades.customInviteLink'), l1: false, l2: false, l3: true },
  ];
  const faqItems: Array<{ q: string; a: string; settingId: string }> = [
    { q: t('settings.serverUpgrades.faqWhatDoes'), a: t('settings.serverUpgrades.faqWhatDoesA'), settingId: 'faq-what-does-power-up' },
    { q: t('settings.serverUpgrades.faqHowPowerUp'), a: t('settings.serverUpgrades.faqHowPowerUpA'), settingId: 'faq-how-to-power-up' },
    { q: t('settings.serverUpgrades.faqStack'), a: t('settings.serverUpgrades.faqStackA'), settingId: 'faq-can-power-ups-stack' },
    { q: t('settings.serverUpgrades.faqTiers'), a: t('settings.serverUpgrades.faqTiersA'), settingId: 'faq-tier-unlocks' },
    { q: t('settings.serverUpgrades.faqGetSlots'), a: t('settings.serverUpgrades.faqGetSlotsA'), settingId: 'faq-get-slots' },
  ];

  const handlePowerUp = async (serverId: string) => {
    setPowerUpActionLoading(serverId);
    try {
      const result = await apiClient.powerUpServer(serverId);
      setPowerUpServers((prev) => prev.map((s) => s.id === serverId ? { ...s, myPowerUpCount: s.myPowerUpCount + 1, powerUpCount: result.powerUpCount, powerUpTier: result.powerUpTier } : s));
      setPowerUpStatus((prev) => prev ? { ...prev, used: prev.used + 1, available: prev.available - 1 } : prev);
    } catch { /* ignore */ }
    setPowerUpActionLoading(null);
  };

  const handleRemovePowerUp = async (serverId: string) => {
    setPowerUpActionLoading(serverId);
    try {
      const result = await apiClient.removePowerUp(serverId);
      setPowerUpServers((prev) => prev.map((s) => s.id === serverId ? { ...s, myPowerUpCount: s.myPowerUpCount - 1, powerUpCount: result.powerUpCount, powerUpTier: result.powerUpTier } : s));
      setPowerUpStatus((prev) => prev ? { ...prev, used: prev.used - 1, available: prev.available + 1 } : prev);
    } catch { /* ignore */ }
    setPowerUpActionLoading(null);
  };

  const handlePurchasePowerUps = async () => {
    setPurchaseLoading(true);
    setPurchaseError(null);
    try {
      const data = await apiClient.createPowerUpCheckout(purchaseQuantity);
      const url = data.url || data.portalUrl;
      if (url && isValidRedirectUrl(url)) {
        if (isElectron && window.electron?.openExternal) {
          window.electron.openExternal(url);
        } else {
          window.location.href = url;
        }
      } else setPurchaseError(t('billing.checkoutFailed'));
    } catch (err) {
      setPurchaseError(err instanceof Error ? err.message : t('billing.checkoutFailed'));
    } finally {
      setPurchaseLoading(false);
    }
  };

  const handleManagePowerUpSub = async () => {
    setManageLoading(true);
    try {
      const data = await apiClient.managePowerUpSubscription();
      if (data.url && isValidRedirectUrl(data.url)) {
        if (isElectron && window.electron?.openExternal) {
          window.electron.openExternal(data.url);
        } else {
          window.location.href = data.url;
        }
      }
    } catch { /* ignore */ }
    setManageLoading(false);
  };

  const handlePowerUpRefund = async (reason: string) => {
    setPowerUpRefundLoading(true);
    try {
      const result = await apiClient.requestRefund('power_up', reason || undefined);
      setPowerUpRefundResult({ success: true, message: t('billing.refund.success', { amount: (result.amount / 100).toFixed(2), currency: result.currency.toUpperCase() }) });
      setPowerUpRefundModalOpen(false);
      Promise.all([apiClient.getMyPowerUps(), apiClient.getPowerUpableServers()])
        .then(([status, servers]) => { setPowerUpStatus(status); setPowerUpServers(servers); })
        .catch(() => {});
      apiClient.getRefundEligibility().then(data => setPowerUpRefundEligibility(data.power_up)).catch(() => {});
    } catch (err: any) {
      setPowerUpRefundResult({ success: false, message: err?.message || t('billing.refund.failed') });
      setPowerUpRefundModalOpen(false);
    } finally {
      setPowerUpRefundLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>{t('settings.serverBoost')}</h2>
      <p className="text-xs mb-6" style={{ color: 'var(--text-secondary)' }}>{t('settings.serverUpgrades.subtitle')}</p>

      {/* Power-up slots summary + purchase */}
      <div className="border border-[var(--glass-border)] rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
        {/* Slot Overview */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <p className="text-sm font-black" style={{ color: 'var(--text-primary)' }}>{t('settings.serverUpgrades.yourSlots')}</p>
            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              {powerUpStatus?.freeSlots ? t('settings.serverUpgrades.freeFromPro', { count: powerUpStatus.freeSlots }) : ''}
              {powerUpStatus?.freeSlots && powerUpStatus?.paidSlots ? ' + ' : ''}
              {powerUpStatus?.paidSlots ? t('settings.serverUpgrades.paidSlots', { count: powerUpStatus.paidSlots }) : ''}
              {!powerUpStatus?.freeSlots && !powerUpStatus?.paidSlots ? t('settings.serverUpgrades.noSlotsYet') : ''}
            </p>
          </div>
          <div className="flex gap-1.5 flex-wrap justify-end max-w-[200px]">
            {Array.from({ length: powerUpStatus?.totalSlots ?? 0 }).map((_, i) => (
              <div key={i} className={`w-7 h-7 rounded-lg border flex items-center justify-center ${i < (powerUpStatus?.used ?? 0) ? 'border-[var(--cyan-accent)]/50 bg-[var(--cyan-accent)]/20' : 'border-[var(--glass-border)] bg-fill-hover'}`}>
                <Rocket size={12} className={i < (powerUpStatus?.used ?? 0) ? 'text-[var(--cyan-accent)]' : 'text-slate-600'} />
              </div>
            ))}
          </div>
        </div>

        {powerUpStatus && powerUpStatus.totalSlots > 0 && (
          <p className="text-[11px] mb-5" style={{ color: 'var(--text-secondary)' }}>
            {powerUpStatus.available === 0
              ? t('settings.serverUpgrades.allSlotsInUse')
              : t('settings.serverUpgrades.slotsAvailable', { count: powerUpStatus.available })}
          </p>
        )}

        <div className="border-t border-[var(--glass-border)] my-5" />

        {/* Purchase Power-Ups */}
        <p id="setting-purchase-power-ups" className="text-sm font-black mb-1" style={{ color: 'var(--text-primary)' }}>{t('settings.serverUpgrades.purchaseTitle')}</p>
        <p className="text-[11px] mb-4" style={{ color: 'var(--text-secondary)' }}>{t('settings.serverUpgrades.purchaseDesc', { price: formatCurrency(powerUpPrice) })}</p>

        <div id="setting-power-up-quantity" className="flex items-center gap-4 mb-4">
          <div className="flex items-center gap-0 border border-[var(--glass-border)] rounded-xl overflow-hidden" style={{ backgroundColor: 'var(--bg-input)' }}>
            <button type="button" onClick={() => setPurchaseQuantity(q => Math.max(1, q - 1))} disabled={purchaseQuantity <= 1}
              className="px-3 py-2 text-sm font-bold hover:bg-fill-active transition-colors disabled:opacity-30" style={{ color: 'var(--text-primary)' }}>&#x2212;</button>
            <span className="px-4 py-2 text-sm font-black min-w-[48px] text-center border-x border-[var(--glass-border)]" style={{ color: 'var(--text-primary)' }}>{purchaseQuantity}</span>
            <button type="button" onClick={() => setPurchaseQuantity(q => Math.min(50, q + 1))} disabled={purchaseQuantity >= 50}
              className="px-3 py-2 text-sm font-bold hover:bg-fill-active transition-colors disabled:opacity-30" style={{ color: 'var(--text-primary)' }}>+</button>
          </div>

          <div className="flex-1">
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('settings.serverUpgrades.priceEach', { price: formatCurrency(powerUpPrice) })}</p>
          </div>

          <div className="text-right">
            <p className="text-lg font-black" style={{ color: 'var(--text-primary)' }}>
              {formatCurrency(purchaseQuantity * powerUpPrice)}
            </p>
            <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>{t('settings.serverUpgrades.perMonth')}</p>
          </div>
        </div>

        {powerUpRefundResult && (
          <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border text-xs mb-4 ${powerUpRefundResult.success ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
            <div className="flex items-center gap-2">
              {powerUpRefundResult.success ? <CheckCircle size={14} className="shrink-0" /> : <XCircle size={14} className="shrink-0" />}
              <p>{powerUpRefundResult.message}</p>
            </div>
            <button type="button" onClick={() => setPowerUpRefundResult(null)} className="text-[10px] font-semibold opacity-60 hover:opacity-100">&#x2715;</button>
          </div>
        )}

        {purchaseError && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-xl border text-xs bg-red-500/10 border-red-500/20 text-red-400 mb-4">
            <AlertTriangle size={14} className="shrink-0" />
            <p>{purchaseError}</p>
          </div>
        )}

        <div className="flex gap-3">
          <button type="button" onClick={handlePurchasePowerUps} disabled={purchaseLoading}
            className="btn-cta text-xs px-5 py-2.5 rounded-xl transition-all disabled:opacity-50">
            {purchaseLoading ? t('settings.serverUpgrades.purchasing') : t('settings.serverUpgrades.purchaseButton')}
          </button>

          {(powerUpStatus?.paidSlots ?? 0) > 0 && (
            <button id="setting-manage-power-up-subscription" type="button" onClick={handleManagePowerUpSub} disabled={manageLoading}
              className="btn-secondary text-xs px-5 py-2.5">
              {manageLoading ? '…' : t('settings.serverUpgrades.manageSub')}
            </button>
          )}
          {powerUpRefundEligibility !== null && (
            <button
              id="setting-power-up-refund"
              type="button"
              disabled={!powerUpRefundEligibility.eligible}
              onClick={powerUpRefundEligibility.eligible ? () => { setPowerUpRefundModalOpen(true); setPowerUpRefundResult(null); } : undefined}
              title={powerUpRefundEligibility.eligible ? undefined : refundReasonToTooltip(powerUpRefundEligibility.reason, t)}
              className={`btn-cta-danger text-xs px-5 py-2.5 rounded-xl transition-all ${
                powerUpRefundEligibility.eligible
                  ? ''
                  : 'cursor-not-allowed opacity-50'
              }`}
            >
              {t('billing.refund.requestButton')}
            </button>
          )}
        </div>

        {!isPro && (
          <>
            <div className="border-t border-[var(--glass-border)] my-5" />
            <div id="setting-view-howl-pro" className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{t('settings.serverUpgrades.proBonus')}</p>
                <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('settings.serverUpgrades.proBonusDesc')}</p>
              </div>
              <button type="button" onClick={() => onNavigate('howl-pro')}
                className="btn-secondary text-[10px] px-4 py-2">
                {t('settings.serverUpgrades.viewHowlPro')}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Server list */}
      <div id="setting-power-up-server" className="border border-[var(--glass-border)] rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
        <p className="text-sm font-black mb-1" style={{ color: 'var(--text-primary)' }}>{t('settings.serverUpgrades.yourServers')}</p>
        <p className="text-[11px] mb-4" style={{ color: 'var(--text-secondary)' }}>{t('settings.serverUpgrades.yourServersDesc')}</p>
        {powerUpLoadError ? (
          <div className="text-sm text-red-400 py-4 text-center">{powerUpLoadError}</div>
        ) : powerUpLoading ? (
          <p className="text-xs py-6 text-center" style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</p>
        ) : powerUpServers.length === 0 ? (
          <p className="text-xs py-6 text-center" style={{ color: 'var(--text-secondary)' }}>{t('settings.serverUpgrades.noServersYet')}</p>
        ) : (
          <ul className="space-y-3">
            {powerUpServers.map((s) => (
              <li key={s.id} id={`setting-remove-power-up-${s.id}`} className="flex items-center justify-between py-3 px-4 rounded-xl border border-default" style={{ backgroundColor: 'var(--bg-input)' }}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full overflow-hidden shrink-0">
                    <ServerIcon icon={s.icon} name={s.name} size={40} />
                  </div>
                  <div>
                    <p className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{s.name}</p>
                    <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                      {s.powerUpCount === 0 ? t('settings.serverUpgrades.noPowerUps') : t('settings.serverUpgrades.powerUpCount', { count: s.powerUpCount })} · {s.powerUpTier === 0 ? t('settings.serverUpgrades.baseTier') : t('settings.serverUpgrades.tierN', { tier: s.powerUpTier })}
                      {s.myPowerUpCount > 0 && <span className="text-[var(--cyan-accent)]"> · {t('settings.serverUpgrades.fromYou', { count: s.myPowerUpCount })}</span>}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {s.myPowerUpCount > 0 && (
                    <button type="button" disabled={powerUpActionLoading === s.id}
                      onClick={() => handleRemovePowerUp(s.id)}
                      className="btn-danger-soft text-[10px] px-3 py-2">
                      {powerUpActionLoading === s.id ? '…' : '−'}
                    </button>
                  )}
                  {s.myPowerUpCount > 0 && (
                    <span className="text-[11px] font-bold min-w-[20px] text-center" style={{ color: 'var(--text-primary)' }}>{s.myPowerUpCount}</span>
                  )}
                  <button type="button" disabled={(powerUpStatus?.available ?? 0) < 1 || powerUpActionLoading === s.id}
                    onClick={() => handlePowerUp(s.id)}
                    className="btn-cta text-[10px] px-4 py-2 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                    {powerUpActionLoading === s.id ? '…' : t('settings.serverUpgrades.powerUp')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Perks for supporters */}
      <div className="border border-default rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--bg-panel)' }}>
        <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>{t('settings.serverUpgrades.perksForSupporters')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          {[
            { icon: <Users size={18} className="text-[var(--cyan-accent)]" />, text: t('settings.serverUpgrades.perkSupporterIcon') },
            { icon: <Crown size={18} className="text-[var(--cyan-accent)]" />, text: t('settings.serverUpgrades.perkEvolvingBadge') },
            { icon: <Shield size={18} className="text-[var(--cyan-accent)]" />, text: t('settings.serverUpgrades.perkSupporterRole') },
            { icon: <Sparkles size={18} className="text-[var(--cyan-accent)]" />, text: t('settings.serverUpgrades.perkUnlockTiers') },
          ].map((b) => (
            <div key={b.text} className="flex gap-3 p-4 rounded-xl border border-default" style={{ backgroundColor: 'var(--bg-input)' }}>
              <div className="w-10 h-10 rounded-xl border border-[var(--glass-border)] flex items-center justify-center shrink-0">{b.icon}</div>
              <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{b.text}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Features by tier */}
      <SettingsSection title={t('settings.serverUpgrades.featuresByTier')} className="mb-6">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead>
              <tr className="border-b border-[var(--glass-border)]">
                <th className="py-2 pr-4 font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{t('settings.serverUpgrades.feature')}</th>
                <th className="py-2 px-2 font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{t('settings.serverUpgrades.tier1')}</th>
                <th className="py-2 px-2 font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{t('settings.serverUpgrades.tier2')}</th>
                <th className="py-2 px-2 font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{t('settings.serverUpgrades.tier3')}</th>
              </tr>
            </thead>
            <tbody>
              {perksTable.map((row) => (
                <tr key={row.perk} className="border-b border-default">
                  <td className="py-2 pr-4" style={{ color: 'var(--text-primary)' }}>{row.perk}</td>
                  <td className="py-2 px-2" style={{ color: 'var(--text-secondary)' }}>{typeof row.l1 === 'boolean' ? (row.l1 ? <Check size={14} className="text-emerald-400" /> : <X size={14} className="text-slate-500" />) : row.l1}</td>
                  <td className="py-2 px-2" style={{ color: 'var(--text-secondary)' }}>{typeof row.l2 === 'boolean' ? (row.l2 ? <Check size={14} className="text-emerald-400" /> : <X size={14} className="text-slate-500" />) : row.l2}</td>
                  <td className="py-2 px-2" style={{ color: 'var(--text-secondary)' }}>{typeof row.l3 === 'boolean' ? (row.l3 ? <Check size={14} className="text-emerald-400" /> : <X size={14} className="text-slate-500" />) : row.l3}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsSection>

      {/* FAQ */}
      <SettingsSection title={t('settings.serverUpgrades.faq')}>
        <ul className="space-y-2">
          {faqItems.map((item, i) => (
            <li key={item.q} id={`setting-${item.settingId}`}>
              <button type="button" onClick={() => setServerUpgradesFaqOpen(serverUpgradesFaqOpen === i ? null : i)} className="w-full flex items-center justify-between py-3 px-4 rounded-xl border border-default text-left transition-colors hover:bg-fill-hover" style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)' }}>
                <span className="text-xs font-medium">{item.q}</span>
                {serverUpgradesFaqOpen === i ? <Minus size={14} className="text-slate-500 shrink-0" /> : <Plus size={14} className="text-slate-500 shrink-0" />}
              </button>
              {serverUpgradesFaqOpen === i && (
                <div className="mt-1 py-3 px-4 rounded-xl border border-default text-[11px]" style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-secondary)' }}>
                  {item.a}
                </div>
              )}
            </li>
          ))}
        </ul>
      </SettingsSection>
      {powerUpRefundModalOpen && powerUpRefundEligibility?.eligible && (
        <RefundConfirmModal
          type="power_up"
          amount={powerUpRefundEligibility.amount!}
          currency={powerUpRefundEligibility.currency || 'usd'}
          loading={powerUpRefundLoading}
          onConfirm={handlePowerUpRefund}
          onCancel={() => setPowerUpRefundModalOpen(false)}
        />
      )}
    </div>
  );
};

export default ServerUpgradesTab;
