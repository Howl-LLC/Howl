// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, Lock, Loader2, Copy, Check, X, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as dmKeyManager from '../../services/dmKeyManager';
import { withOtrServerRecoveryGuard } from '../../utils/otrServerRecoveryGuard';

interface EncryptionChoiceModalProps {
  accountPassword: string;
  onComplete: () => void;
  /** Deliberate-dismiss escape hatch. When provided, renders a top-right X
   *  and binds Esc. The user keeps their session; Secure DMs simply stay
   *  unset until they revisit Settings → Encryption. */
  onClose?: () => void;
}

type Step = 'choose' | 'secure-easy-confirm' | 'max-privacy-passphrase' | 'max-privacy-recovery';

export const EncryptionChoiceModal: React.FC<EncryptionChoiceModalProps> = ({ accountPassword, onComplete, onClose }) => {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('choose');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Maximum Privacy form state
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');

  // Recovery key state
  const [recoveryKey, setRecoveryKey] = useState('');
  const [copied, setCopied] = useState(false);
  const [savedConfirmed, setSavedConfirmed] = useState(false);

  const handleSecureEasy = async () => {
    setLoading(true);
    setError(null);
    try {
      // Re-check the server for an existing bundle right before calling
      // setup(). Without this, a parallel tryAutoUnlock (from remembered-
      // device flow on another tab/session) can create the bundle between
      // the time the modal was opened and the user clicking Continue,
      // making setup() return 409 "Secure DMs already set up".
      const hasBundle = await dmKeyManager.checkSetup();
      if (hasBundle) {
        // Bundle exists — try to unlock with the account password instead
        // of setting up again. For a Secure-and-Easy user, account password
        // IS the derived key, so unlock succeeds if the previous setup
        // was also Secure-and-Easy.
        await dmKeyManager.unlock(accountPassword);
      } else {
        await dmKeyManager.setup(accountPassword);
      }
      const proceed = await withOtrServerRecoveryGuard(() => dmKeyManager.enablePasswordDerived());
      if (!proceed) { setLoading(false); return; }
      dmKeyManager.rememberOnDevice(accountPassword);
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('encryption.setupFailed'));
      setLoading(false);
    }
  };

  const handleMaxPrivacySubmit = async () => {
    if (passphrase.length < 8) {
      setError(t('encryption.passphraseMinLength'));
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setError(t('encryption.passphraseMismatch'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await dmKeyManager.setup(passphrase);
      setRecoveryKey(result.recoveryKey);
      setStep('max-privacy-recovery');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('encryption.setupFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(recoveryKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFinish = () => {
    setRecoveryKey('');
    onComplete();
  };

  // Esc = close (only when caller opted in by passing onClose). The
  // recovery-key step deliberately ignores dismiss: closing then would
  // discard a key the user hasn't saved yet, so we only allow close
  // from the pre-key steps.
  useEffect(() => {
    if (!onClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && step !== 'max-privacy-recovery') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, step]);

  const canCloseAtThisStep = !!onClose && step !== 'max-privacy-recovery';

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div
        className="relative rounded-2xl border border-[var(--glass-border)] p-8 w-full max-w-2xl flex flex-col shadow-2xl spring-pop-in"
        style={{ backgroundColor: 'var(--bg-panel)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {canCloseAtThisStep && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className="absolute top-3 right-3 p-1.5 rounded-lg text-t-secondary hover:text-t-primary hover:bg-fill-active transition-colors"
          >
            <X size={16} />
          </button>
        )}
        {step === 'choose' && (
          <>
            <div className="text-center mb-6">
              <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('encryption.chooseProtection')}
              </h2>
              <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>
                {t('encryption.chooseProtectionDesc')}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              {/* Card 1: Self recovery (recommended) */}
              <button
                onClick={() => setStep('max-privacy-passphrase')}
                className="relative text-left p-5 rounded-xl border border-[var(--cyan-accent)]/50 transition-all duration-200 hover:bg-[var(--cyan-accent)]/5 group"
                style={{ backgroundColor: 'var(--bg-elevated)' }}
              >
                <span
                  className="absolute top-3 right-3 px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wide"
                  style={{ backgroundColor: 'var(--cyan-accent)', color: 'var(--text-on-accent)' }}
                >
                  {t('encryption.recommended', 'Recommended')}
                </span>
                <Lock size={24} className="mb-3" style={{ color: 'var(--cyan-accent)' }} />
                <h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                  {t('encryption.maxPrivacy')}
                </h3>
                <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
                  {t('encryption.maxPrivacyDesc')}
                </p>
                <p className="text-[10px] font-medium mb-3" style={{ color: 'var(--cyan-accent)' }}>
                  {t('encryption.maxPrivacyTagline')}
                </p>
                <ul className="space-y-1.5">
                  <li className="text-[11px] flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                    <Check size={10} style={{ color: 'var(--cyan-accent)' }} /> {t('encryption.separatePassphrase')}
                  </li>
                  <li className="text-[11px] flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                    <Check size={10} style={{ color: 'var(--cyan-accent)' }} /> {t('encryption.recoveryKeyMustSave')}
                  </li>
                  <li className="text-[11px] flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                    <Check size={10} style={{ color: 'var(--cyan-accent)' }} /> {t('encryption.loseBothWarning')}
                  </li>
                </ul>
              </button>

              {/* Card 2: Server recovery */}
              <button
                onClick={() => setStep('secure-easy-confirm')}
                className="text-left p-5 rounded-xl border border-[var(--glass-border)] hover:border-[var(--cyan-accent)]/50 transition-all duration-200 hover:bg-[var(--cyan-accent)]/5 group"
                style={{ backgroundColor: 'var(--bg-elevated)' }}
              >
                <ShieldCheck size={24} className="mb-3" style={{ color: 'var(--cyan-accent)' }} />
                <h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                  {t('encryption.secureEasy')}
                </h3>
                <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
                  {t('encryption.secureEasyDesc')}
                </p>
                <p className="text-[10px] font-medium mb-3" style={{ color: 'var(--cyan-accent)' }}>
                  {t('encryption.secureEasyTagline')}
                </p>
                <ul className="space-y-1.5">
                  <li className="text-[11px] flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                    <Check size={10} style={{ color: 'var(--cyan-accent)' }} /> {t('encryption.noPassphraseNeeded')}
                  </li>
                  <li className="text-[11px] flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                    <Check size={10} style={{ color: 'var(--cyan-accent)' }} /> {t('encryption.noRecoveryKeyNeeded')}
                  </li>
                  <li className="text-[11px] flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                    <Check size={10} style={{ color: 'var(--cyan-accent)' }} /> {t('encryption.howlCanAssist')}
                  </li>
                </ul>
              </button>
            </div>
          </>
        )}

        {step === 'secure-easy-confirm' && (
          <>
            <div className="text-center mb-6">
              <ShieldCheck size={36} className="mx-auto mb-3" style={{ color: 'var(--cyan-accent)' }} />
              <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('encryption.secureEasy')}
              </h2>
              <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>
                {t('encryption.secureEasyConfirmDesc')}
              </p>
            </div>
            {error && (
              <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 mb-3 animate-[shake_0.35s_ease-in-out]">
                <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-[13px] text-red-300 leading-snug">{error}</p>
              </div>
            )}
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => { setStep('choose'); setError(null); }}
                disabled={loading}
                className="px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-fill-hover transition-colors"
                style={{ color: 'var(--text-secondary)' }}
              >
                {t('common.back')}
              </button>
              <button
                onClick={handleSecureEasy}
                disabled={loading}
                className="btn-cta px-6 py-2.5 rounded-xl text-sm transition-all flex items-center gap-2 disabled:opacity-50"
              >
                {loading && <Loader2 size={14} className="animate-spin" />}
                {t('common.continue')}
              </button>
            </div>
          </>
        )}

        {step === 'max-privacy-passphrase' && (
          <>
            <div className="text-center mb-5">
              <Lock size={36} className="mx-auto mb-3" style={{ color: 'var(--cyan-accent)' }} />
              <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('encryption.maxPrivacy')}
              </h2>
              <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>
                {t('encryption.createPassphraseDesc')}
              </p>
            </div>
            <input
              type="password"
              placeholder={t('encryption.encryptionPassphrasePlaceholder')}
              value={passphrase}
              onChange={(e) => { setPassphrase(e.target.value); setError(null); }}
              className={`w-full px-3 py-2.5 rounded-lg bg-black/30 border text-sm text-t-primary placeholder-t-secondary mb-3 outline-none transition-colors ${error ? 'border-red-500/70 focus:border-red-500' : 'border-[var(--glass-border)] focus:border-[var(--cyan-accent)]/50'}`}
              autoFocus
              aria-invalid={!!error}
            />
            <input
              type="password"
              placeholder={t('encryption.confirmPassphrase')}
              value={confirmPassphrase}
              onChange={(e) => { setConfirmPassphrase(e.target.value); setError(null); }}
              onKeyDown={(e) => e.key === 'Enter' && handleMaxPrivacySubmit()}
              className={`w-full px-3 py-2.5 rounded-lg bg-black/30 border text-sm text-t-primary placeholder-t-secondary mb-4 outline-none transition-colors ${error ? 'border-red-500/70 focus:border-red-500' : 'border-[var(--glass-border)] focus:border-[var(--cyan-accent)]/50'}`}
              aria-invalid={!!error}
            />
            {error && (
              <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 mb-3 animate-[shake_0.35s_ease-in-out]">
                <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-[13px] text-red-300 leading-snug">{error}</p>
              </div>
            )}
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => { setStep('choose'); setError(null); setPassphrase(''); setConfirmPassphrase(''); }}
                disabled={loading}
                className="px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-fill-hover transition-colors"
                style={{ color: 'var(--text-secondary)' }}
              >
                {t('common.back')}
              </button>
              <button
                onClick={handleMaxPrivacySubmit}
                disabled={loading || !passphrase || !confirmPassphrase}
                className="btn-cta px-6 py-2.5 rounded-xl text-sm transition-all flex items-center gap-2 disabled:opacity-50"
              >
                {loading && <Loader2 size={14} className="animate-spin" />}
                {t('common.continue')}
              </button>
            </div>
          </>
        )}

        {step === 'max-privacy-recovery' && (
          <>
            <div className="text-center mb-4">
              <Lock size={36} className="mx-auto mb-3" style={{ color: 'var(--cyan-accent)' }} />
              <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('encryption.saveRecoveryKey')}
              </h2>
              <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>
                {t('encryption.saveRecoveryKeyDesc')}
              </p>
            </div>
            <div className="relative bg-black/40 border border-[var(--glass-border)] rounded-lg p-4 mb-4 font-mono text-sm text-emerald-300 break-all select-all">
              {recoveryKey}
              <button
                type="button"
                onClick={handleCopy}
                className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-fill-active transition-colors"
              >
                {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} className="text-t-secondary" />}
              </button>
            </div>
            <label className="flex items-center gap-2 mb-4 cursor-pointer justify-center">
              <input
                type="checkbox"
                checked={savedConfirmed}
                onChange={(e) => setSavedConfirmed(e.target.checked)}
                className="w-4 h-4 rounded-lg border-[var(--border-strong)] bg-black/30"
              />
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('encryption.savedRecoveryKey')}</span>
            </label>
            <div className="flex justify-center">
              <button
                onClick={handleFinish}
                disabled={!savedConfirmed}
                className="btn-cta px-6 py-2.5 rounded-xl text-sm transition-all disabled:opacity-50"
              >
                {t('common.done')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
};
