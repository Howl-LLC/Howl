// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Gift, Copy, AlertCircle, AlertTriangle, CheckCircle2, X, Check, Users, Sparkles, RotateCcw, ArrowLeft } from 'lucide-react';
import { apiClient } from '../../services/api';
import { isValidRedirectUrl } from '../../utils/securityUtils';
import { SettingsSection } from './SettingsWidgets';
import { Dropdown } from '../ui/dropdown';
import type { User } from '../../types';
import { RefundConfirmModal } from './RefundConfirmModal';
import { useAppVisible } from '../../hooks/useAppVisible';
import { refundReasonToTooltip } from '../../utils/refundReasons';

function maskCode(code: string): string {
  const parts = code.split('-');
  if (parts.length !== 4) return code;
  return `${parts[0]}-${'•'.repeat(5)}-${'•'.repeat(5)}-${parts[3]}`;
}

export const GiftInventoryTab: React.FC = () => {
  const { t } = useTranslation();
  const isElectron = !!(window as any).__ELECTRON_WINDOW__;
  const visible = useAppVisible();
  const [giftRedeemCode, setGiftRedeemCode] = useState('');
  const [giftRedeemLoading, setGiftRedeemLoading] = useState(false);
  const [giftRedeemResult, setGiftRedeemResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [giftsSent, setGiftsSent] = useState<Array<any>>([]);
  const [giftsReceived, setGiftsReceived] = useState<Array<any>>([]);
  const [giftsLoading, setGiftsLoading] = useState(false);
  const [giftsError, setGiftsError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Friend picker modal state — 3-step flow: pick → confirm → sent
  const [friendPickerGiftId, setFriendPickerGiftId] = useState<string | null>(null);
  const [pickerStep, setPickerStep] = useState<'pick' | 'confirm' | 'sent'>('pick');
  const [selectedFriend, setSelectedFriend] = useState<User | null>(null);
  const [friends, setFriends] = useState<User[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  // Recipient claim state
  const [claimLoadingId, setClaimLoadingId] = useState<string | null>(null);
  const [claimResult, setClaimResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Gift purchase modal state
  const [giftModalOpen, setGiftModalOpen] = useState(false);
  const [giftPlan, setGiftPlan] = useState<'essential' | 'pro'>('pro');
  const [giftDuration, setGiftDuration] = useState(1);
  const [giftLoading, setGiftLoading] = useState(false);
  const [giftError, setGiftError] = useState<string | null>(null);

  const [giftRefundEligibility, setGiftRefundEligibility] = useState<{ eligible: boolean; chargeId?: string; amount?: number; currency?: string; chargeDate?: string; reason?: string } | null>(null);
  const [giftRefundModalOpen, setGiftRefundModalOpen] = useState(false);
  const [giftRefundLoading, setGiftRefundLoading] = useState(false);
  const [giftRefundResult, setGiftRefundResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const handlePurchaseGift = async () => {
    try {
      setGiftLoading(true);
      setGiftError(null);
      const data = await apiClient.sendGift(giftPlan, giftDuration);
      if (data.url && isValidRedirectUrl(data.url)) {
        if (isElectron && window.electron?.openExternal) {
          window.electron.openExternal(data.url);
        } else {
          window.location.href = data.url;
        }
      }
    } catch (err) {
      setGiftError(err instanceof Error ? err.message : t('billing.checkoutFailed'));
    } finally {
      setGiftLoading(false);
    }
  };

  const fetchGifts = useCallback(() => {
    setGiftsLoading(true);
    setGiftsError(null);
    apiClient.getGifts()
      .then(data => { setGiftsSent(data.sent); setGiftsReceived(data.received); })
      .catch(() => setGiftsError(t('billing.gifts.loadError')))
      .finally(() => setGiftsLoading(false));
  }, [t]);

  const handleGiftRefund = async (reason: string) => {
    setGiftRefundLoading(true);
    try {
      const result = await apiClient.requestRefund('gift', reason || undefined);
      setGiftRefundResult({ type: 'success', message: t('billing.refund.success', { amount: (result.amount / 100).toFixed(2), currency: result.currency.toUpperCase() }) });
      setGiftRefundModalOpen(false);
      fetchGifts();
      apiClient.getRefundEligibility().then(data => setGiftRefundEligibility(data.gift)).catch(() => {});
    } catch (err: any) {
      setGiftRefundResult({ type: 'error', message: err?.message || t('billing.refund.failed') });
      setGiftRefundModalOpen(false);
    } finally {
      setGiftRefundLoading(false);
    }
  };

  // Handle ?gift=cancel redirect from Stripe
  const [cancelNotice, setCancelNotice] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('gift') === 'cancel') {
      setCancelNotice(true);
      params.delete('gift');
      const clean = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (clean ? `?${clean}` : ''));
    }
  }, []);

  useEffect(() => { fetchGifts(); }, [fetchGifts]);

  useEffect(() => {
    if (visible && isElectron) {
      // Re-fetch gift data when returning from external billing portal
      fetchGifts();
    }
  }, [visible]);

  useEffect(() => {
    apiClient.getRefundEligibility().then(data => setGiftRefundEligibility(data.gift)).catch(() => {});
  }, []);

  const handleRedeemCode = async () => {
    if (!giftRedeemCode.trim()) return;
    setGiftRedeemLoading(true);
    setGiftRedeemResult(null);
    try {
      const data = await apiClient.redeemGiftCode(giftRedeemCode.trim());
      const planLabel = data.plan === 'pro' ? t('billing.gifts.planPro') : t('billing.gifts.planEssential');
      setGiftRedeemResult({ type: 'success', message: t('billing.gifts.redeemSuccess', { plan: planLabel, count: data.durationMonths }) });
      setGiftRedeemCode('');
      fetchGifts();
    } catch (err: unknown) {
      setGiftRedeemResult({ type: 'error', message: err instanceof Error ? err.message : t('billing.gifts.redeemError') });
    } finally {
      setGiftRedeemLoading(false);
    }
  };

  const copyToClipboard = (id: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const openFriendPicker = async (giftId: string) => {
    setFriendPickerGiftId(giftId);
    setPickerStep('pick');
    setSelectedFriend(null);
    setAssignError(null);
    setFriendsLoading(true);
    try {
      const data = await apiClient.getFriends();
      setFriends(data);
    } catch {
      setFriends([]);
    } finally {
      setFriendsLoading(false);
    }
  };

  const closeFriendPicker = () => {
    setFriendPickerGiftId(null);
    setPickerStep('pick');
    setSelectedFriend(null);
    setAssignError(null);
  };

  // Step 1 → Step 2: user picked a friend, advance to confirm.
  const pickFriend = (friend: User) => {
    setSelectedFriend(friend);
    setAssignError(null);
    setPickerStep('confirm');
  };

  // Step 2 → Step 3: confirm and send.
  const handleConfirmSend = async () => {
    if (!friendPickerGiftId || !selectedFriend) return;
    setAssignLoading(true);
    setAssignError(null);
    try {
      const tag = `${selectedFriend.username}#${selectedFriend.discriminator}`;
      await apiClient.assignGift(friendPickerGiftId, tag);
      fetchGifts();
      setPickerStep('sent');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('billing.gifts.assignError');
      setAssignError(message);
    } finally {
      setAssignLoading(false);
    }
  };

  const handleClaimGift = async (giftId: string) => {
    setClaimLoadingId(giftId);
    setClaimResult(null);
    try {
      const data = await apiClient.claimGift(giftId);
      const planLabel = data.plan === 'pro' ? t('billing.gifts.planPro') : t('billing.gifts.planEssential');
      setClaimResult({ type: 'success', message: t('billing.gifts.claimSuccess', { plan: planLabel, count: data.durationMonths }) });
      fetchGifts();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('billing.gifts.claimError');
      setClaimResult({ type: 'error', message });
    } finally {
      setClaimLoadingId(null);
    }
  };

  const giftStatusStyle = (status: string) => {
    switch (status) {
      case 'redeemed': return 'bg-emerald-500/20 text-emerald-400';
      case 'pending': return 'bg-cyan-500/20 text-cyan-400';
      case 'payment_pending': return 'bg-amber-500/20 text-amber-400';
      case 'cancelled': return 'bg-slate-500/20 text-slate-400';
      case 'expired': return 'bg-red-500/20 text-red-400';
      default: return 'bg-fill-active text-white/50';
    }
  };

  const pendingGifts = giftsSent.filter(g => g.status === 'pending' && !g.recipientId);

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>{t('billing.gifts.title')}</h2>
      <p className="text-xs mb-8" style={{ color: 'var(--text-secondary)' }}>{t('billing.gifts.description')}</p>

      {cancelNotice && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl border text-xs bg-amber-500/10 border-amber-500/20 text-amber-400 mb-6">
          <AlertCircle size={14} className="shrink-0" />
          <p className="flex-1">{t('billing.gifts.cancelNotice')}</p>
          <button type="button" onClick={() => setCancelNotice(false)} className="text-amber-400/60 hover:text-amber-400 transition-colors"><X size={14} /></button>
        </div>
      )}

      {giftRefundResult && (
        <div className={`flex items-center justify-between gap-2 px-4 py-3 rounded-xl border text-xs mb-6 ${giftRefundResult.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
          <div className="flex items-center gap-2">
            {giftRefundResult.type === 'success' ? <CheckCircle2 size={14} className="shrink-0" /> : <AlertCircle size={14} className="shrink-0" />}
            <p>{giftRefundResult.message}</p>
          </div>
          <button type="button" onClick={() => setGiftRefundResult(null)} className="opacity-60 hover:opacity-100"><X size={14} /></button>
        </div>
      )}

      {/* Gift Purchase Banner */}
      <div id="setting-purchase-gift" className="flex items-center gap-5 border border-[var(--cyan-accent)]/15 rounded-2xl p-5 mb-8"
        style={{ backgroundColor: 'var(--bg-panel)', backgroundImage: 'linear-gradient(135deg, color-mix(in srgb, var(--cyan-accent) 6%, transparent) 0%, transparent 100%)' }}>
        <div className="w-14 h-14 shrink-0 rounded-2xl bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/20 flex items-center justify-center">
          <Gift size={24} className="text-[var(--cyan-accent)]" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold tracking-tight mb-0.5" style={{ color: 'var(--text-primary)' }}>{t('billing.giftBanner.title')}</h3>
          <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>{t('billing.giftBanner.description')}</p>
          <button type="button" onClick={() => setGiftModalOpen(true)}
            className="btn-cta flex items-center gap-2 text-[10px] px-4 py-2 rounded-xl transition-all">
            <Sparkles size={12} /> {t('billing.giftBanner.purchaseButton')}
          </button>
        </div>
      </div>

      {/* Gift Inventory */}
      <SettingsSection title={t('billing.gifts.inventory')} className="mb-6">
        <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>{t('billing.gifts.inventoryDescription')}</p>
        {giftsLoading ? (
          <div className="py-8 text-center text-xs" style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</div>
        ) : pendingGifts.length === 0 ? (
          <div className="py-10 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-2xl border border-[var(--glass-border)] flex items-center justify-center mb-3" style={{ backgroundColor: 'var(--bg-input)' }}>
              <Gift size={28} className="text-slate-500" />
            </div>
            <p className="text-sm font-bold mb-1" style={{ color: 'var(--text-primary)' }}>{t('billing.gifts.inventoryEmpty')}</p>
            <p className="text-xs max-w-xs" style={{ color: 'var(--text-secondary)' }}>{t('billing.gifts.inventoryEmptyDesc')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {pendingGifts.map(g => (
              <div key={g.id} className="flex items-center justify-between py-3 px-4 rounded-xl border border-default" style={{ backgroundColor: 'var(--bg-input)' }}>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/20 flex items-center justify-center">
                    <Gift size={16} className="text-[var(--cyan-accent)]" />
                  </div>
                  <div>
                    <p className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>
                      {g.plan === 'pro' ? t('billing.gifts.planPro') : t('billing.gifts.planEssential')} — {g.durationMonths} {t('billing.gifts.mo')}
                    </p>
                    <p className="text-[11px] font-mono" style={{ color: 'var(--text-secondary)' }}>
                      {t('billing.gifts.codeMasked')}: {maskCode(g.code)} · {new Date(g.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button id={`setting-copy-gift-code-${g.id}`} type="button" onClick={() => copyToClipboard(g.id, g.code)}
                    className="flex items-center gap-1 text-[10px] font-bold text-[var(--cyan-accent)] hover:opacity-80 transition-opacity">
                    {copiedId === g.id ? <Check size={11} /> : <Copy size={11} />}
                    {copiedId === g.id ? t('common.copied') || 'Copied' : t('billing.gifts.copyCode')}
                  </button>
                  <button id={`setting-send-gift-to-friend-${g.id}`} type="button" onClick={() => openFriendPicker(g.id)}
                    className="flex items-center gap-1 text-[10px] font-bold px-3 py-1.5 rounded-lg bg-[var(--cyan-accent)]/15 text-[var(--cyan-accent)] border border-[var(--cyan-accent)]/25 hover:bg-[var(--cyan-accent)]/25 transition-all">
                    <Users size={11} /> {t('billing.gifts.sendToFriend')}
                  </button>
                  {giftRefundEligibility !== null && (Date.now() - new Date(g.createdAt).getTime() < 5 * 24 * 60 * 60 * 1000) && (
                    <button
                      id={`setting-gift-refund-${g.id}`}
                      type="button"
                      disabled={!giftRefundEligibility.eligible}
                      onClick={giftRefundEligibility.eligible ? () => { setGiftRefundModalOpen(true); setGiftRefundResult(null); } : undefined}
                      title={giftRefundEligibility.eligible ? undefined : refundReasonToTooltip(giftRefundEligibility.reason, t)}
                      className={`btn-cta-danger flex items-center gap-1 text-[10px] px-3 py-1.5 rounded-xl transition-all ${
                        giftRefundEligibility.eligible
                          ? ''
                          : 'cursor-not-allowed opacity-50'
                      }`}
                    >
                      <RotateCcw size={11} /> {t('billing.refund.requestButton')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      {/* Redeem a Code */}
      <SettingsSection title={t('billing.gifts.redeemTitle')} className="mb-6">
        <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>{t('billing.gifts.redeemDescription')}</p>
        <div id="setting-redeem-gift-code" className="flex flex-wrap gap-3">
          <input type="text" value={giftRedeemCode} onChange={e => setGiftRedeemCode(e.target.value)} placeholder="HOWL-AAAAA-BBBBB-CCCCC"
            className="flex-1 min-w-[200px] rounded-xl px-4 py-2.5 text-sm border outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50"
            style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
            onKeyDown={e => { if (e.key === 'Enter') handleRedeemCode(); }} />
          <button type="button" onClick={handleRedeemCode} disabled={giftRedeemLoading || !giftRedeemCode.trim()}
            className="btn-cta text-[10px] px-5 py-2.5 rounded-xl transition-all disabled:opacity-50">
            {giftRedeemLoading ? t('billing.gifts.redeeming') : t('billing.gifts.redeem')}
          </button>
        </div>
        {giftRedeemResult && (
          <div className={`mt-3 flex items-center gap-2 px-4 py-3 rounded-xl border text-xs ${giftRedeemResult.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
            {giftRedeemResult.type === 'success' ? <CheckCircle2 size={14} className="shrink-0" /> : <AlertCircle size={14} className="shrink-0" />}
            <p>{giftRedeemResult.message}</p>
          </div>
        )}
      </SettingsSection>

      {/* Gift History */}
      <SettingsSection title={t('billing.gifts.history')}>
        {giftsError ? (
          <div className="text-sm text-red-400 py-4 text-center">{giftsError}</div>
        ) : giftsLoading ? (
          <div className="py-8 text-center text-xs" style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</div>
        ) : giftsSent.length === 0 && giftsReceived.length === 0 ? (
          <div className="py-12 flex flex-col items-center justify-center text-center">
            <div className="w-20 h-20 rounded-2xl border border-[var(--glass-border)] flex items-center justify-center mb-4" style={{ backgroundColor: 'var(--bg-input)' }}>
              <Gift size={32} className="text-slate-500" />
            </div>
            <p className="text-sm font-bold mb-2" style={{ color: 'var(--text-primary)' }}>{t('billing.gifts.emptyTitle')}</p>
            <p className="text-xs max-w-xs" style={{ color: 'var(--text-secondary)' }}>{t('billing.gifts.emptyDescription')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {giftsSent.length > 0 && (
              <>
                <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-secondary)' }}>{t('billing.gifts.sent')}</p>
                {giftsSent.map(g => (
                  <div key={g.id} className="flex items-center justify-between py-3 px-4 rounded-xl border border-default" style={{ backgroundColor: 'var(--bg-input)' }}>
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/20 flex items-center justify-center"><Gift size={16} className="text-[var(--cyan-accent)]" /></div>
                      <div>
                        <p className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>
                          {g.plan === 'pro' ? t('billing.gifts.planPro') : t('billing.gifts.planEssential')} — {g.durationMonths} {t('billing.gifts.mo')}
                        </p>
                        <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                          {t('billing.gifts.to')} {g.recipient ? `${g.recipient.username}#${g.recipient.discriminator}` : g.recipientUsername || t('billing.gifts.anyone')} · {new Date(g.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {g.status === 'pending' && (
                        <button type="button" onClick={() => copyToClipboard(g.id, g.code)} className="text-[10px] font-bold text-[var(--cyan-accent)] hover:opacity-80 flex items-center gap-1 transition-opacity">
                          {copiedId === g.id ? <Check size={11} /> : <Copy size={11} />}
                          {copiedId === g.id ? t('common.copied') || 'Copied' : t('billing.gifts.code')}
                        </button>
                      )}
                      <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-lg ${giftStatusStyle(g.status)}`}>
                        {t(`billing.gifts.status.${g.status}`)}
                      </span>
                    </div>
                  </div>
                ))}
              </>
            )}
            {giftsReceived.length > 0 && (
              <>
                <p className="text-[10px] font-bold uppercase tracking-widest mb-2 mt-4" style={{ color: 'var(--text-secondary)' }}>{t('billing.gifts.received')}</p>
                {claimResult && (
                  <div className={`mb-2 flex items-center justify-between gap-2 px-4 py-3 rounded-xl border text-xs ${claimResult.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
                    <div className="flex items-center gap-2">
                      {claimResult.type === 'success' ? <CheckCircle2 size={14} className="shrink-0" /> : <AlertCircle size={14} className="shrink-0" />}
                      <p>{claimResult.message}</p>
                    </div>
                    <button type="button" onClick={() => setClaimResult(null)} className="opacity-60 hover:opacity-100"><X size={14} /></button>
                  </div>
                )}
                {giftsReceived.map(g => (
                  <div key={g.id} className="flex items-center justify-between py-3 px-4 rounded-xl border border-default" style={{ backgroundColor: 'var(--bg-input)' }}>
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center"><Gift size={16} className="text-emerald-400" /></div>
                      <div>
                        <p className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>
                          {g.plan === 'pro' ? t('billing.gifts.planPro') : t('billing.gifts.planEssential')} — {g.durationMonths} {t('billing.gifts.mo')}
                        </p>
                        <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                          {t('billing.gifts.from')} {g.sender.username}#{g.sender.discriminator} · {new Date(g.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {g.status === 'pending' && (
                        <button
                          type="button"
                          onClick={() => handleClaimGift(g.id)}
                          disabled={claimLoadingId === g.id}
                          className="btn-cta text-[10px] px-3 py-1.5 rounded-xl transition-all disabled:opacity-50"
                        >
                          {claimLoadingId === g.id ? t('billing.gifts.claiming') : t('billing.gifts.claim')}
                        </button>
                      )}
                      <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-lg ${g.status === 'redeemed' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-cyan-500/20 text-cyan-400'}`}>
                        {g.status === 'pending'
                          ? t('billing.gifts.status.pendingReceived')
                          : t(`billing.gifts.status.${g.status}`)}
                      </span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </SettingsSection>

      {/* Gift Purchase Modal */}
      {giftModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setGiftModalOpen(false)} onKeyDown={(e) => { if (e.key === 'Escape') setGiftModalOpen(false); }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-full max-w-md rounded-2xl border border-[var(--glass-border)] p-6" style={{ backgroundColor: 'var(--bg-panel)' }} onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => setGiftModalOpen(false)} className="absolute top-4 right-4 text-white/40 hover:text-white/70 transition-colors"><X size={16} /></button>

            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/20 flex items-center justify-center">
                <Gift size={20} className="text-[var(--cyan-accent)]" />
              </div>
              <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>{t('billing.giftModal.title')}</h3>
            </div>

            <div className="space-y-4">
              <div id="setting-gift-plan-select">
                <label className="text-[10px] font-bold uppercase tracking-widest block mb-2" style={{ color: 'var(--text-secondary)' }}>{t('billing.giftModal.selectPlan')}</label>
                <div className="flex gap-2">
                  {(['essential', 'pro'] as const).map((p) => (
                    <button key={p} type="button" onClick={() => setGiftPlan(p)}
                      className={`flex-1 text-xs font-semibold py-2.5 rounded-xl border transition-all ${giftPlan === p ? 'btn-cta-selected' : 'bg-fill-hover border-[var(--glass-border)] hover:bg-fill-active'}`}
                      style={giftPlan !== p ? { color: 'var(--text-secondary)' } : undefined}>
                      {p === 'essential' ? t('billing.howlProEssential') : t('settings.howlPro')}
                    </button>
                  ))}
                </div>
              </div>

              <div id="setting-gift-duration-select">
                <label className="text-[10px] font-bold uppercase tracking-widest block mb-2" style={{ color: 'var(--text-secondary)' }}>{t('billing.giftModal.selectDuration')}</label>
                <Dropdown<number>
                  options={[1, 2, 3, 6, 12].map(m => ({ value: m, label: t('billing.giftModal.monthOption', { count: m }) }))}
                  value={giftDuration}
                  onChange={v => setGiftDuration(v)}
                  size="md"
                  className="w-full"
                />
              </div>

              {giftError && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl border text-xs bg-red-500/10 border-red-500/20 text-red-400">
                  <AlertTriangle size={14} className="shrink-0" />
                  <p>{giftError}</p>
                </div>
              )}

              <button type="button" onClick={handlePurchaseGift} disabled={giftLoading}
                className="btn-cta w-full text-xs py-3 rounded-xl transition-all disabled:opacity-50">
                {giftLoading ? t('billing.giftModal.purchasing') : t('billing.giftModal.purchase')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Friend Picker Modal — 3-step flow: pick → confirm → sent */}
      {friendPickerGiftId && (() => {
        const activeGift = giftsSent.find(g => g.id === friendPickerGiftId);
        const planLabel = activeGift?.plan === 'pro' ? t('billing.gifts.planPro') : t('billing.gifts.planEssential');
        const months = activeGift?.durationMonths ?? 0;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={closeFriendPicker} onKeyDown={(e) => { if (e.key === 'Escape') closeFriendPicker(); }}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div className="relative w-full max-w-sm rounded-2xl border border-[var(--glass-border)] p-6" style={{ backgroundColor: 'var(--bg-panel)' }} onClick={(e) => e.stopPropagation()}>
              <button type="button" onClick={closeFriendPicker} className="absolute top-4 right-4 text-white/40 hover:text-white/70 transition-colors"><X size={16} /></button>

              {/* Step 1 — Pick a friend */}
              {pickerStep === 'pick' && (
                <>
                  <div className="flex items-center gap-3 mb-5">
                    <div className="w-10 h-10 rounded-xl bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/20 flex items-center justify-center">
                      <Users size={20} className="text-[var(--cyan-accent)]" />
                    </div>
                    <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>{t('billing.gifts.selectFriend')}</h3>
                  </div>

                  <div className="max-h-72 overflow-y-auto space-y-1">
                    {friendsLoading ? (
                      <div className="py-8 text-center text-xs" style={{ color: 'var(--text-secondary)' }}>{t('common.loading')}</div>
                    ) : friends.length === 0 ? (
                      <div className="py-8 text-center text-xs" style={{ color: 'var(--text-secondary)' }}>{t('billing.gifts.noFriends')}</div>
                    ) : (
                      friends.map(friend => (
                        <button key={friend.id} type="button" onClick={() => pickFriend(friend)}
                          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-fill-hover transition-all text-left">
                          <img src={friend.avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${friend.id}`} alt="" className="w-8 h-8 rounded-[var(--radius-lg)] object-cover" loading="lazy" decoding="async" width={32} height={32} />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{friend.username}</p>
                            <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>#{friend.discriminator}</p>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}

              {/* Step 2 — Confirm */}
              {pickerStep === 'confirm' && selectedFriend && (
                <>
                  <div className="flex items-center gap-3 mb-5">
                    <button type="button" onClick={() => { setPickerStep('pick'); setSelectedFriend(null); setAssignError(null); }}
                      className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-fill-hover transition-colors"
                      style={{ color: 'var(--text-secondary)' }} title={t('common.back', 'Back')}>
                      <ArrowLeft size={16} />
                    </button>
                    <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>{t('billing.gifts.confirmTitle')}</h3>
                  </div>

                  <div className="flex flex-col items-center text-center mb-5">
                    <img src={selectedFriend.avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${selectedFriend.id}`} alt="" className="w-20 h-20 rounded-[var(--radius-lg)] object-cover mb-3" loading="lazy" decoding="async" width={80} height={80} />
                    <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{selectedFriend.username}<span style={{ color: 'var(--text-secondary)' }}>#{selectedFriend.discriminator}</span></p>
                    <p className="text-xs mt-3" style={{ color: 'var(--text-primary)' }}>
                      {t('billing.gifts.confirmPrompt', { plan: planLabel, count: months })}
                    </p>
                    <p className="text-[11px] mt-2 max-w-[280px]" style={{ color: 'var(--text-secondary)' }}>
                      {t('billing.gifts.confirmCaveat')}
                    </p>
                  </div>

                  {assignError && (
                    <div className="mb-4 flex items-center gap-2 px-4 py-3 rounded-xl border text-xs bg-red-500/10 border-red-500/20 text-red-400">
                      <AlertCircle size={14} className="shrink-0" />
                      <p>{assignError}</p>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button type="button" onClick={closeFriendPicker} disabled={assignLoading}
                      className="btn-secondary flex-1 text-xs py-2.5">
                      {t('common.cancel')}
                    </button>
                    <button type="button" onClick={handleConfirmSend} disabled={assignLoading}
                      className="btn-cta flex-1 text-xs py-2.5 rounded-xl transition-all disabled:opacity-50">
                      {assignLoading ? t('billing.gifts.sending') : t('billing.gifts.confirmSend')}
                    </button>
                  </div>
                </>
              )}

              {/* Step 3 — Sent */}
              {pickerStep === 'sent' && selectedFriend && (
                <>
                  <div className="flex items-center gap-3 mb-5">
                    <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                      <CheckCircle2 size={20} className="text-emerald-400" />
                    </div>
                    <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>{t('billing.gifts.sentTitle')}</h3>
                  </div>

                  <div className="flex flex-col items-center text-center mb-5">
                    <img src={selectedFriend.avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${selectedFriend.id}`} alt="" className="w-20 h-20 rounded-[var(--radius-lg)] object-cover mb-3" loading="lazy" decoding="async" width={80} height={80} />
                    <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{selectedFriend.username}<span style={{ color: 'var(--text-secondary)' }}>#{selectedFriend.discriminator}</span></p>
                    <p className="text-xs mt-3" style={{ color: 'var(--text-secondary)' }}>{t('billing.gifts.sentBody')}</p>
                  </div>

                  <button type="button" onClick={closeFriendPicker}
                    className="btn-cta w-full text-xs py-2.5 rounded-xl transition-all">
                    {t('billing.gifts.done')}
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {giftRefundModalOpen && giftRefundEligibility?.eligible && (
        <RefundConfirmModal
          type="gift"
          amount={giftRefundEligibility.amount!}
          currency={giftRefundEligibility.currency || 'usd'}
          loading={giftRefundLoading}
          onConfirm={handleGiftRefund}
          onCancel={() => setGiftRefundModalOpen(false)}
        />
      )}
    </div>
  );
};

export default GiftInventoryTab;
