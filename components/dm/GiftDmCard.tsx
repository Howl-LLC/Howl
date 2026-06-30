// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Gift } from 'lucide-react';
import { apiClient } from '../../services/api';
import { LetterAvatar } from '../LetterAvatar';

interface GiftDmCardProps {
  giftId: string;
  plan: string;              // 'pro' | 'essential'
  durationMonths: number;
  claimedAt?: string | null; // ISO string when card has been claimed
  senderUsername: string | null;
  senderAvatar: string | null;
  /** True if the viewer is the recipient (not the sender) — only they see Claim. */
  isRecipient: boolean;
}

/**
 * In-thread DM card rendered for `kind: 'gift'` system messages.
 *
 * The sender sees a passive "you sent a gift" state; the recipient sees a
 * Claim button until they redeem. After a successful claim the backend emits
 * `subscription-updated` (handled globally by useBillingSocketEvents) and
 * `dm-system-message-updated` flips this card to "Claimed".
 */
export const GiftDmCard: React.FC<GiftDmCardProps> = ({
  giftId, plan, durationMonths, claimedAt, senderUsername, senderAvatar, isRecipient,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const planLabel = plan === 'pro' ? t('billing.gifts.planPro') : t('billing.gifts.planEssential');
  const isClaimed = Boolean(claimedAt);

  const handleClaim = async () => {
    setError(null);
    setLoading(true);
    try {
      await apiClient.claimGift(giftId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('billing.gifts.claimError'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="px-4 py-2">
      <div
        className="rounded-2xl border p-4 max-w-md"
        style={{
          backgroundColor: 'var(--bg-input)',
          borderColor: 'color-mix(in srgb, var(--cyan-accent) 25%, transparent)',
          backgroundImage: 'linear-gradient(135deg, color-mix(in srgb, var(--cyan-accent) 6%, transparent) 0%, transparent 60%)',
        }}
      >
        {/* Header: sender + caption */}
        <div className="flex items-center gap-3 mb-3">
          <div className="w-9 h-9 rounded-[var(--radius-lg)] overflow-hidden shrink-0">
            <LetterAvatar avatar={senderAvatar} username={senderUsername || ''} size={36} className="rounded-full" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {t('billing.gifts.dmCard.title', { username: senderUsername || '' })}
            </p>
            <p className="text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>
              {planLabel} · {durationMonths} {t('billing.gifts.mo')}
            </p>
          </div>
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--cyan-accent) 25%, transparent)',
            }}>
            <Gift size={16} style={{ color: 'var(--cyan-accent)' }} />
          </div>
        </div>

        {/* Body: action area */}
        {isClaimed ? (
          <div
            className="text-[11px] font-semibold px-3 py-2 rounded-lg text-center"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--success, #10b981) 10%, transparent)',
              color: 'var(--success, #10b981)',
            }}
          >
            {t('billing.gifts.dmCard.claimed')}
          </div>
        ) : isRecipient ? (
          <>
            <button
              type="button"
              onClick={handleClaim}
              disabled={loading}
              className="btn-cta w-full text-xs py-2.5 rounded-xl transition-all disabled:opacity-50"
            >
              {loading ? t('billing.gifts.dmCard.claiming') : t('billing.gifts.dmCard.claim')}
            </button>
            {error && (
              <p className="text-[11px] mt-2 text-red-400">{error}</p>
            )}
          </>
        ) : (
          // Sender's view: just a quiet badge
          <div
            className="text-[11px] px-3 py-2 rounded-lg text-center"
            style={{ backgroundColor: 'var(--bg-panel)', color: 'var(--text-secondary)' }}
          >
            {t('billing.gifts.sent')}
          </div>
        )}
      </div>
    </div>
  );
};
