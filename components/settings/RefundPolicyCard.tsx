// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, Minus, Crown, Rocket, Gift, ShieldCheck } from 'lucide-react';
import { apiClient } from '../../services/api';
import { SettingsSection } from './SettingsWidgets';
import { refundReasonToTooltip } from '../../utils/refundReasons';
import { useAuthStore } from '../../stores/authStore';

type CategoryEligibility = {
  eligible: boolean;
  reason?: string;
  amount?: number;
  currency?: string;
  chargeDate?: string;
};

type EligibilityResponse = {
  subscription: CategoryEligibility;
  gift: CategoryEligibility;
  power_up: CategoryEligibility;
  hasUsed: { subscription: boolean; gift: boolean; power_up: boolean };
  policy: { windowDays: number; maxAmountUsd: number; perCategoryLimit: number };
};

type DisplayState = 'available' | 'used' | 'na';

/** Map server eligibility into a tri-state visual.
 *
 * `Available`: a refund can be issued right now.
 * `Used`: the lifetime per-category cap has been consumed (real denial).
 * `N/A`: nothing eligible exists yet — no active sub, no recent gift purchase, no power-up,
 *   no charges in the 5-day window, etc. Surfaced as a muted dash so the user doesn't read
 *   "Unavailable" as a denial.
 */
function categoryDisplayState(r: CategoryEligibility, hasUsed: boolean): DisplayState {
  if (r.eligible) return 'available';
  if (hasUsed || r.reason === 'already_refunded') return 'used';
  return 'na';
}

export const RefundPolicyCard: React.FC = () => {
  const { t } = useTranslation();
  const [data, setData] = useState<EligibilityResponse | null>(null);

  // Re-fetch when subscription state changes (gift redeem, self-purchase, refund, admin grant)
  // so the card flips between Available / Used / N/A in real time.
  const stripePlan = useAuthStore(s => s.currentUser?.stripePlan);
  const stripeStatus = useAuthStore(s => s.currentUser?.stripeStatus);
  const stripePeriodEnd = useAuthStore(s => s.currentUser?.stripePeriodEnd);

  useEffect(() => {
    apiClient.getRefundEligibility().then(setData).catch(() => setData(null));
  }, [stripePlan, stripeStatus, stripePeriodEnd]);

  if (!data) return null;

  const categories: Array<{
    key: 'subscription' | 'power_up' | 'gift';
    label: string;
    icon: React.ReactNode;
  }> = [
    {
      key: 'subscription',
      label: t('billing.refund.typeSubscription', 'Subscription'),
      icon: <Crown size={14} className="text-[var(--cyan-accent)]" />,
    },
    {
      key: 'power_up',
      label: t('billing.refund.typePowerUp', 'Power-Up'),
      icon: <Rocket size={14} className="text-[var(--cyan-accent)]" />,
    },
    {
      key: 'gift',
      label: t('billing.refund.typeGift', 'Gift Purchase'),
      icon: <Gift size={14} className="text-[var(--cyan-accent)]" />,
    },
  ];

  return (
    <SettingsSection title={t('billing.refund.policyTitle', 'Refund Policy')} className="mb-6">
      <div className="flex items-start gap-3 mb-4">
        <ShieldCheck size={16} className="text-[var(--cyan-accent)] shrink-0 mt-0.5" />
        <ul className="text-xs space-y-1.5" style={{ color: 'var(--text-secondary)' }}>
          <li>
            {t('billing.refund.policyWindow', '{{days}}-day refund window from the date of charge.', { days: data.policy.windowDays })}
          </li>
          <li>
            {t('billing.refund.policyLimit', '{{count}} refund per category (subscription, power-up, gift) for the lifetime of your account.', { count: data.policy.perCategoryLimit })}
          </li>
          <li>
            {t('billing.refund.policyMax', 'Maximum ${{amount}} per refund.', { amount: data.policy.maxAmountUsd })}
          </li>
          <li>{t('billing.refund.policyAdminGranted', 'Admin-granted plans cannot be self-refunded.')}</li>
        </ul>
      </div>

      <div className="border-t border-default pt-3 space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-secondary)' }}>
          {t('billing.refund.statusHeading', 'Your Refund Status')}
        </p>
        {categories.map(cat => {
          const result = data[cat.key];
          const state = categoryDisplayState(result, data.hasUsed[cat.key]);
          const tooltip = state === 'available'
            ? t('billing.refund.tooltip.available', 'Available. Click "Request Refund" in the relevant tab.')
            : refundReasonToTooltip(result.reason, t);
          const badgeClass = state === 'available'
            ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
            : state === 'used'
              ? 'bg-red-500/10 text-red-400 border border-red-500/20'
              : 'bg-fill-active text-t-secondary border border-default';
          return (
            <div key={cat.key} className="flex items-center justify-between py-1.5">
              <div className="flex items-center gap-2">
                {cat.icon}
                <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{cat.label}</span>
              </div>
              <div
                title={tooltip}
                aria-label={tooltip}
                className={`flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-lg ${badgeClass}`}
              >
                {state === 'available' && <Check size={12} />}
                {state === 'used' && <X size={12} />}
                {state === 'na' && <Minus size={12} />}
                {state === 'available' && t('billing.refund.statusAvailable', 'Available')}
                {state === 'used' && t('billing.refund.statusUsed', 'Used')}
                {state === 'na' && '–'}
              </div>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
};

export default RefundPolicyCard;
