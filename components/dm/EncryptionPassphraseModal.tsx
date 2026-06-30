// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Shield, Loader2, Eye, EyeOff, X, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface EncryptionPassphraseModalProps {
  mode: 'setup' | 'unlock';
  onSubmit: (passphrase: string, remember: boolean) => Promise<void>;
  onSkip?: () => void;
  onRecover?: (recoveryKey: string, newPassphrase: string) => Promise<void>;
  /** Deliberate-dismiss escape hatch. When provided, renders a top-right X
   *  and wires Esc to it. Without this prop, the modal stays blocking
   *  (used when the caller truly cannot proceed without the passphrase). */
  onClose?: () => void;
}

export const EncryptionPassphraseModal: React.FC<EncryptionPassphraseModalProps> = ({ mode, onSubmit, onSkip, onRecover, onClose }) => {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [confirmNewPassphrase, setConfirmNewPassphrase] = useState('');

  // Esc dismisses when onClose is provided. Mirrors LogoutConfirmModal
  // + other confirm dialogs; no-op when the caller opted into a blocking
  // modal by leaving onClose undefined.
  useEffect(() => {
    if (!onClose) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const isSetup = mode === 'setup';
  const canSubmit = isSetup
    ? passphrase.length >= 8 && passphrase === confirmPassphrase
    : passphrase.length > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      await onSubmit(passphrase, remember);
    } catch {
      setError(isSetup
        ? t('encryption.setupFailed')
        : t('encryption.incorrectPassphrase'));
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="relative bg-[var(--bg-panel)] rounded-2xl shadow-2xl border border-[var(--glass-border)] p-6 max-w-sm w-full mx-4">
        {/* Escape hatch — without this users who hit this modal at startup
            with no way forward (forgot passphrase, don't have recovery key
            handy, etc.) get trapped on a dead-end screen. Esc also closes. */}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className="absolute top-3 right-3 p-1.5 rounded-lg text-t-secondary hover:text-t-primary hover:bg-fill-active transition-colors"
          >
            <X size={16} />
          </button>
        )}
        <div className="flex items-center gap-2 mb-4 pr-8">
          <Shield size={20} className="text-[var(--cyan-accent)]" />
          <h2 className="text-lg font-bold text-t-primary">
            {isSetup ? t('encryption.createPassphrase') : t('encryption.enterPassphrase')}
          </h2>
        </div>

        <p className="text-[12px] text-t-secondary mb-4">
          {isSetup
            ? t('encryption.createPassphraseDesc')
            : t('encryption.enterPassphraseDesc')}
        </p>

        {isSetup && (
          <p className="text-[10px] text-t-secondary mb-3">
            {t('encryption.passphraseHint')}
          </p>
        )}

        <div className="space-y-3">
          <div className={`relative ${error ? 'animate-[shake_0.35s_ease-in-out]' : ''}`}>
            <input
              type={showPassphrase ? 'text' : 'password'}
              placeholder={isSetup ? t('encryption.createPassphrasePlaceholder') : t('encryption.enterPassphrasePlaceholder')}
              value={passphrase}
              onChange={(e) => { setPassphrase(e.target.value); if (error) setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) handleSubmit(); }}
              className={`w-full px-3 py-2.5 pr-10 rounded-lg bg-black/30 border text-sm text-t-primary placeholder-t-secondary outline-none transition-colors ${error ? 'border-red-500/70 focus:border-red-500' : 'border-[var(--glass-border)] focus:border-[var(--cyan-accent)]/50'}`}
              autoFocus
              aria-invalid={!!error}
              aria-describedby={error ? 'passphrase-error' : undefined}
            />
            <button
              type="button"
              onClick={() => setShowPassphrase(!showPassphrase)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-t-secondary hover:text-t-primary"
            >
              {showPassphrase ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          {isSetup && (
            <input
              type={showPassphrase ? 'text' : 'password'}
              placeholder={t('encryption.confirmPassphrase')}
              value={confirmPassphrase}
              onChange={(e) => setConfirmPassphrase(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) handleSubmit(); }}
              className="w-full px-3 py-2.5 rounded-lg bg-black/30 border border-[var(--glass-border)] text-sm text-t-primary placeholder-t-secondary outline-none focus:border-[var(--cyan-accent)]/50"
            />
          )}

          {isSetup && passphrase.length > 0 && passphrase.length < 8 && (
            <p className="text-xs text-amber-400">{t('encryption.passphraseMinLength')}</p>
          )}

          {isSetup && confirmPassphrase.length > 0 && passphrase !== confirmPassphrase && (
            <p className="text-xs text-amber-400">{t('encryption.passphraseMismatch')}</p>
          )}

          {error && (
            <div
              id="passphrase-error"
              role="alert"
              className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30"
            >
              <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-[13px] text-red-300 leading-snug">{error}</p>
            </div>
          )}

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="w-3.5 h-3.5 rounded-lg border-[var(--border-strong)] bg-black/30 text-[var(--cyan-accent)] focus:ring-[var(--cyan-accent)]/30"
            />
            <span className="text-[11px] text-t-secondary">{t('encryption.rememberOnDevice')}</span>
          </label>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || loading}
            className="btn-cta w-full py-2.5 rounded-xl disabled:opacity-50 text-[12px] font-semibold transition-colors flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
            {isSetup ? t('encryption.setUp') : t('encryption.unlock')}
          </button>

          {isSetup && onSkip && (
            <button
              type="button"
              onClick={onSkip}
              className="w-full py-2 text-[11px] text-t-secondary hover:text-t-primary transition-colors"
            >
              {t('common.skipForNow')}
            </button>
          )}

          {!isSetup && onRecover && !recoveryMode && (
            <button
              type="button"
              onClick={() => { setRecoveryMode(true); setError(null); }}
              className="w-full py-2 text-[11px] text-t-secondary hover:text-t-primary transition-colors"
            >
              {t('encryption.forgotPassphrase')}
            </button>
          )}

          {recoveryMode && onRecover && (
            <div className="mt-3 pt-3 border-t border-[var(--glass-border)] space-y-2">
              <p className="text-[11px] text-t-secondary">{t('encryption.recoveryInstructions')}</p>
              <input
                type="text"
                placeholder={t('encryption.recoveryKeyPlaceholder')}
                value={recoveryKey}
                onChange={(e) => setRecoveryKey(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-black/30 border border-[var(--glass-border)] text-sm text-t-primary placeholder-t-secondary outline-none focus:border-[var(--cyan-accent)]/50 font-mono"
              />
              <input
                type="password"
                placeholder={t('encryption.newPassphrasePlaceholder')}
                value={newPassphrase}
                onChange={(e) => setNewPassphrase(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-black/30 border border-[var(--glass-border)] text-sm text-t-primary placeholder-t-secondary outline-none focus:border-[var(--cyan-accent)]/50"
              />
              <input
                type="password"
                placeholder={t('encryption.confirmNewPassphrase')}
                value={confirmNewPassphrase}
                onChange={(e) => setConfirmNewPassphrase(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-black/30 border border-[var(--glass-border)] text-sm text-t-primary placeholder-t-secondary outline-none focus:border-[var(--cyan-accent)]/50"
              />
              <button
                type="button"
                onClick={async () => {
                  if (!recoveryKey.trim() || newPassphrase.length < 8 || newPassphrase !== confirmNewPassphrase) return;
                  setLoading(true);
                  setError(null);
                  try {
                    await onRecover(recoveryKey.trim(), newPassphrase);
                  } catch {
                    setError(t('encryption.recoveryFailed'));
                  } finally {
                    setLoading(false);
                  }
                }}
                disabled={loading || !recoveryKey.trim() || newPassphrase.length < 8 || newPassphrase !== confirmNewPassphrase}
                className="w-full py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-[var(--text-on-accent)] text-[12px] font-semibold transition-colors flex items-center justify-center gap-2"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : null}
                {t('encryption.recoverAndSetNew')}
              </button>
              <button
                type="button"
                onClick={() => { setRecoveryMode(false); setError(null); }}
                className="w-full py-2 text-[11px] text-t-secondary hover:text-t-primary transition-colors"
              >
                {t('encryption.backToPassphrase')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
