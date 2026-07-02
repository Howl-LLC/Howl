// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect } from 'react';
import { X, ShieldAlert, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as mlsCoordinator from '../../services/mls/mlsCoordinator';
import { routeEstablishOutcome } from '../../utils/mlsRetry';
import { useUiStore } from '../../stores/uiStore';
import { aikFingerprint } from '../../utils/aikFingerprint';
import { useFocusTrap } from '../../hooks/useFocusTrap';

export interface KeyChangeReviewTarget {
  userId: string;
  username: string;
  candidateAik: string;
  pinnedAik: string;
  self: boolean;
  /** Channel to recover after accepting (the DM the banner was opened from). */
  dmChannelId: string;
  isGroup: boolean;
  mlsGroupId?: string | null;
  /** 1:1 peer to re-establish with after accept (null for group DMs). */
  recipientUserId: string | null;
}

interface KeyChangeReviewModalProps {
  target: KeyChangeReviewTarget | null;
  onClose: () => void;
  showToast?: (message: string, type: 'info' | 'warning') => void;
}

/**
 * Warn+acknowledge review for a changed security key (AIK pin rejection). Shows the
 * old and new key fingerprints; Accept re-pins to the observed key and kicks off
 * channel recovery (catch-up -> establish -> 1:1 group reset); Cancel keeps the
 * conversation blocked. Never auto-accepts — this dialog IS the informed consent.
 */
export const KeyChangeReviewModal: React.FC<KeyChangeReviewModalProps> = ({ target, onClose, showToast }) => {
  const { t } = useTranslation();
  const [oldFp, setOldFp] = useState<string | null>(null);
  const [newFp, setNewFp] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  useEffect(() => {
    setError(null);
    setOldFp(null);
    setNewFp(null);
    if (!target) return;
    let cancelled = false;
    void aikFingerprint(target.userId, target.pinnedAik).then((fp) => { if (!cancelled) setOldFp(fp); });
    void aikFingerprint(target.userId, target.candidateAik).then((fp) => { if (!cancelled) setNewFp(fp); });
    return () => { cancelled = true; };
  }, [target]);

  if (!target) return null;

  const handleAccept = async () => {
    setAccepting(true);
    setError(null);
    try {
      const ok = await mlsCoordinator.acceptKeyChange(target.userId, target.candidateAik);
      if (!ok) {
        // Not accepted — usually because the rejection already resolved out-of-band
        // (attested rotation landed, self-heal, or another tab accepted). If nothing
        // is pending for this user anymore, clear the stale banner and close instead
        // of dead-ending on an error.
        const remaining = await mlsCoordinator.listKeyChangeAlerts().catch(() => null);
        if (remaining && !remaining.some((a) => a.userId === target.userId)) {
          useUiStore.getState().clearKeyChangeAlert(target.userId);
          onClose();
          return;
        }
        setError(t('encryption.keyChangeAcceptFailed', 'This key could not be accepted. Reload and try again.'));
        return;
      }
      useUiStore.getState().clearKeyChangeAlert(target.userId);
      useUiStore.getState().clearEstablishFailure(target.dmChannelId);
      onClose();
      // Recovery runs in the background — the banner is gone; failures surface as a toast
      // and the channel keeps failing closed until the next establish succeeds.
      void mlsCoordinator
        .recoverChannelAfterKeyChange(target.dmChannelId, target.recipientUserId, target.isGroup, target.mlsGroupId)
        .catch((err) => {
          // Re-record a typed establish failure (arms the presence retry / composer copy).
          routeEstablishOutcome(target.dmChannelId, err);
          showToast?.(
            t('encryption.keyChangeRecoverFailed', 'Key accepted, but the conversation could not be re-established yet. It will retry on next open.'),
            'warning',
          );
        });
    } catch {
      // Worker timeout / crash / lock mid-accept: visible feedback, not an unhandled rejection.
      setError(t('encryption.keyChangeAcceptFailed', 'This key could not be accepted. Reload and try again.'));
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !accepting && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="key-change-review-title"
        className="rounded-2xl border border-[var(--glass-border)] p-6 w-full max-w-md max-h-[90vh] overflow-y-auto flex flex-col shadow-2xl"
        style={{ backgroundColor: 'var(--bg-panel)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <span id="key-change-review-title" className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            <ShieldAlert size={16} className="text-amber-500" />
            {target.self
              ? t('encryption.keyChangeModalSelfTitle', 'Your security key changed')
              : t('encryption.keyChangeModalTitle', { name: target.username, defaultValue: "{{name}}'s security key changed" })}
          </span>
          <button type="button" onClick={() => !accepting && onClose()} className="p-1.5 rounded-lg hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>

        <p className="text-[13px] leading-snug mb-4" style={{ color: 'var(--text-secondary)' }}>
          {target.self
            ? t('encryption.keyChangeModalSelfBody', 'A device signed in as you presented a security key this device does not recognize. This usually means you reset encryption on another device. If you did not, do not accept.')
            : t('encryption.keyChangeModalBody', { name: target.username, defaultValue: 'This usually means {{name}} reset their encryption or moved to a new device. It could also mean someone is impersonating them. If you can, verify one of the fingerprints below with them over another channel before accepting.' })}
        </p>

        <div className="rounded-xl border p-3 mb-3 bg-black/20" style={{ borderColor: 'var(--border-subtle)' }}>
          <p className="text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
            {t('encryption.keyChangeOldKey', 'Previously trusted key')}
          </p>
          <p className="font-mono text-[12px] break-all" style={{ color: 'var(--text-primary)' }}>{oldFp ?? '…'}</p>
        </div>
        <div className="rounded-xl border p-3 mb-4 bg-black/20" style={{ borderColor: 'var(--border-subtle)' }}>
          <p className="text-[11px] font-medium mb-1 text-amber-500">
            {t('encryption.keyChangeNewKey', 'New key')}
          </p>
          <p className="font-mono text-[12px] break-all" style={{ color: 'var(--text-primary)' }}>{newFp ?? '…'}</p>
        </div>

        <p className="text-[12px] leading-snug mb-4" style={{ color: 'var(--text-secondary)' }}>
          {t('encryption.keyChangeModalConsequence', 'Accepting trusts the new key on this device and resumes the conversation. Rejecting keeps messaging blocked.')}
        </p>

        {error && <p className="text-[12px] text-red-400 mb-3">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => !accepting && onClose()}
            className="px-4 py-2 rounded-xl text-[13px] font-medium hover:bg-fill-active"
            style={{ color: 'var(--text-secondary)' }}
          >
            {t('encryption.keyChangeReject', 'Not now')}
          </button>
          <button
            type="button"
            onClick={() => void handleAccept()}
            disabled={accepting}
            className="px-4 py-2 rounded-xl text-[13px] font-semibold bg-amber-500/90 hover:bg-amber-500 text-black disabled:opacity-60 inline-flex items-center gap-2"
          >
            {accepting && <Loader2 size={14} className="animate-spin" />}
            {t('encryption.keyChangeAccept', 'Accept new key')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default KeyChangeReviewModal;
