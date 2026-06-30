// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CreditCard, Lock, Receipt, ExternalLink, HelpCircle } from 'lucide-react';
import { apiClient } from '../../services/api';
import { SettingsSection } from './SettingsWidgets';
import { isValidRedirectUrl } from '../../utils/securityUtils';
import { useAppVisible } from '../../hooks/useAppVisible';
import { RefundPolicyCard } from './RefundPolicyCard';

export interface PaymentTabProps {
  onNavigate: (page: string) => void;
}

/** Friendly card-brand label. Stripe returns lowercase strings like
 *  "visa", "mastercard", "amex", "discover", "diners", "jcb", "unionpay";
 *  fall back to title-case for anything we don't recognise. */
const cardBrandLabel = (brand: string) => {
  const b = brand.toLowerCase();
  switch (b) {
    case 'visa':       return 'Visa';
    case 'mastercard': return 'Mastercard';
    case 'amex':       return 'American Express';
    case 'discover':   return 'Discover';
    case 'diners':     return 'Diners Club';
    case 'jcb':        return 'JCB';
    case 'unionpay':   return 'UnionPay';
    default:           return brand.charAt(0).toUpperCase() + brand.slice(1);
  }
};

/** Background tint for the brand badge, keyed by brand. */
const cardBrandTint = (brand: string): { bg: string; fg: string } => {
  switch (brand.toLowerCase()) {
    case 'visa':       return { bg: 'rgba(26, 31, 113, 0.18)', fg: '#8aa7ff' };
    case 'mastercard': return { bg: 'rgba(235, 0, 27, 0.15)',  fg: '#ff6b6b' };
    case 'amex':       return { bg: 'rgba(0, 102, 178, 0.18)', fg: '#5fb3ff' };
    case 'discover':   return { bg: 'rgba(255, 96, 0, 0.18)',  fg: '#ffaf66' };
    default:           return { bg: 'var(--fill-active)',      fg: 'var(--text-secondary)' };
  }
};

const formatCurrency = (amount: number, currency: string) => {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: 2 }).format(amount / 100);
};

export const PaymentTab: React.FC<PaymentTabProps> = ({ onNavigate }) => {
  const { t } = useTranslation();
  const isElectron = !!(window as any).__ELECTRON_WINDOW__;
  const visible = useAppVisible();
  const [paymentMethods, setPaymentMethods] = useState<Array<{ id: string; brand: string; last4: string; expMonth: number; expYear: number; isDefault: boolean }>>([]);
  const [paymentMethodsLoading, setPaymentMethodsLoading] = useState(false);
  const [paymentMethodsError, setPaymentMethodsError] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Array<{ id: string; amount: number; currency: string; status: string; description: string; created: string; invoiceUrl: string | null; invoicePdf: string | null }>>([]);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [transactionsError, setTransactionsError] = useState<string | null>(null);

  useEffect(() => {
    setPaymentMethodsLoading(true);
    apiClient.getPaymentMethods().then(data => setPaymentMethods(data.methods)).catch(() => setPaymentMethodsError(t('billing.payment.loadMethodsError'))).finally(() => setPaymentMethodsLoading(false));
    setTransactionsLoading(true);
    apiClient.getTransactions().then(data => setTransactions(data.transactions)).catch(() => setTransactionsError(t('billing.payment.loadTransactionsError'))).finally(() => setTransactionsLoading(false));
  }, []);

  useEffect(() => {
    if (visible && isElectron) {
      // Re-fetch billing data when returning from external billing portal
      apiClient.getPaymentMethods().then(data => setPaymentMethods(data.methods)).catch(() => {});
      apiClient.getTransactions().then(data => setTransactions(data.transactions)).catch(() => {});
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

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>{t('billing.payment.title')}</h2>
      <p className="text-xs mb-8" style={{ color: 'var(--text-secondary)' }}>{t('billing.payment.description')}</p>

      <RefundPolicyCard />

      <SettingsSection title={t('billing.payment.methods')} className="mb-6">
        <div id="setting-manage-payment-methods">
        <div className="flex items-center gap-2 mb-4">
          <Lock size={14} className="text-slate-500" />
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('billing.payment.securityNote')}</p>
        </div>
        {paymentMethodsError ? (
          <div className="text-sm text-red-400 py-4 text-center">{paymentMethodsError}</div>
        ) : paymentMethodsLoading ? (
          <div className="py-6 text-center text-xs" style={{ color: 'var(--text-secondary)' }}>{t('billing.payment.loadingMethods')}</div>
        ) : paymentMethods.length > 0 ? (
          <div className="space-y-2 mb-4">
            {paymentMethods.map(pm => {
              const tint = cardBrandTint(pm.brand);
              const expYearShort = String(pm.expYear).slice(-2);
              const expMonthPadded = String(pm.expMonth).padStart(2, '0');
              return (
                <div key={pm.id} className="flex items-center justify-between py-3.5 px-4 rounded-xl border border-default" style={{ backgroundColor: 'var(--bg-input)' }}>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: tint.bg }}>
                      <CreditCard size={18} style={{ color: tint.fg }} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                          {cardBrandLabel(pm.brand)} •••• {pm.last4}
                        </p>
                        {pm.isDefault && (
                          <span className="text-[8px] font-semibold px-1.5 py-0.5 rounded-lg bg-[var(--cyan-accent)]/20 text-[var(--cyan-accent)]">{t('billing.payment.default')}</span>
                        )}
                      </div>
                      <p className="text-[11px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>{t('billing.payment.expires', { date: `${expMonthPadded}/${expYearShort}` })}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex items-center gap-3 py-4 px-4 rounded-xl border border-default mb-4" style={{ backgroundColor: 'var(--bg-input)' }}>
            <div className="w-10 h-10 rounded-xl border border-[var(--glass-border)] flex items-center justify-center"><CreditCard size={20} className="text-slate-500" /></div>
            <div>
              <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{t('billing.payment.noMethods')}</p>
              <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('billing.payment.noMethodsHint')}</p>
            </div>
          </div>
        )}
        <button type="button" onClick={handleOpenPortal}
          className="btn-cta text-[10px] font-semibold px-5 py-2.5 rounded-xl transition-all">
          {paymentMethods.length > 0 ? t('billing.payment.manageMethods') : t('billing.payment.addMethod')}
        </button>
        </div>
      </SettingsSection>

      <div id="setting-transaction-history">
      <SettingsSection title={t('billing.payment.transactionHistory')} className="mb-6">
        {transactionsError ? (
          <div className="text-sm text-red-400 py-4 text-center">{transactionsError}</div>
        ) : transactionsLoading ? (
          <div className="py-6 text-center text-xs" style={{ color: 'var(--text-secondary)' }}>{t('billing.payment.loadingTransactions')}</div>
        ) : transactions.length > 0 ? (
          <div id="setting-view-invoice" className="space-y-2">
            {transactions.map(tx => (
              <div key={tx.id} className="flex items-center justify-between py-3.5 px-4 rounded-xl border border-default" style={{ backgroundColor: 'var(--bg-input)' }}>
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${tx.status === 'paid' ? 'bg-emerald-500/10' : tx.status === 'open' ? 'bg-amber-500/10' : 'bg-fill-hover'}`}>
                    <Receipt size={16} className={tx.status === 'paid' ? 'text-emerald-400' : tx.status === 'open' ? 'text-amber-400' : 'text-slate-500'} />
                  </div>
                  <div>
                    <p className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{tx.description}</p>
                    <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                      {new Date(tx.created).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-sm font-bold tabular-nums ${tx.status === 'paid' ? '' : 'opacity-50'}`} style={{ color: 'var(--text-primary)' }}>
                    {formatCurrency(tx.amount, tx.currency)}
                  </span>
                  <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-lg ${tx.status === 'paid' ? 'bg-emerald-500/20 text-emerald-400' : tx.status === 'open' ? 'bg-amber-500/20 text-amber-400' : tx.status === 'void' ? 'bg-slate-500/20 text-slate-400' : 'bg-red-500/20 text-red-400'}`}>
                    {tx.status}
                  </span>
                  {tx.invoiceUrl && (
                    <a href={tx.invoiceUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:text-[var(--cyan-accent)] transition-colors">
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-3 py-8 px-4 rounded-xl border border-default" style={{ backgroundColor: 'var(--bg-input)' }}>
            <div className="w-10 h-10 rounded-xl border border-[var(--glass-border)] flex items-center justify-center shrink-0"><Receipt size={20} className="text-slate-500" /></div>
            <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{t('billing.payment.noTransactions')}</p>
          </div>
        )}
      </SettingsSection>
      </div>

      <div id="setting-billing-gift-inventory-link" className="border border-[var(--cyan-accent)]/20 rounded-xl p-4 flex items-start gap-3" style={{ backgroundColor: 'var(--bg-panel)' }}>
        <HelpCircle size={18} className="text-[var(--cyan-accent)] shrink-0 mt-0.5" />
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('billing.payment.redeemHint')} <button type="button" onClick={() => onNavigate('gift-inventory')} className="text-[var(--cyan-accent)] hover:underline">{t('billing.payment.yourInventory')}</button>.</p>
      </div>
    </div>
  );
};

export default PaymentTab;
