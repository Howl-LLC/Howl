// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, Shield, Copy, Check, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import * as dmKeyManager from '../../services/dmKeyManager';

interface EncryptionSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSetupComplete: () => void;
}

export const EncryptionSetupModal: React.FC<EncryptionSetupModalProps> = ({ isOpen, onClose, onSetupComplete }) => {
  const { t } = useTranslation();
  const [step, setStep] = useState<'password' | 'recovery'>('password');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  if (!isOpen) return null;

  const handleSetup = async () => {
    if (password.length < 8) {
      setError(t('dm.securePasswordTooShort'));
      return;
    }
    // Length check first, then value comparison (both are user-facing UI, not crypto)
    if (password.length !== confirmPassword.length || !confirmPassword.startsWith(password)) {
      setError(t('dm.securePasswordMismatch'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await dmKeyManager.setup(password);
      setRecoveryKey(result.recoveryKey);
      setStep('recovery');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Setup failed');
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
    setPassword('');
    setConfirmPassword('');
    setRecoveryKey('');
    setStep('password');
    setSavedConfirmed(false);
    onSetupComplete();
  };

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={undefined}>
      <div
        ref={dialogRef}
        className="rounded-2xl border border-[var(--glass-border)] p-7 w-full max-w-md flex flex-col shadow-2xl spring-pop-in"
        style={{ backgroundColor: 'var(--bg-panel)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Shield size={18} className="text-emerald-400" />
            <span className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('dm.setupSecureDmsTitle')}</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-fill-active transition-colors" style={{ color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>

        {step === 'password' && (
          <>
            <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>{t('dm.secureSetupDescription')}</p>
            <input
              type="password"
              placeholder={t('dm.securePasswordPlaceholder')}
              value={password}
              onChange={(e) => { setPassword(e.target.value); if (error) setError(null); }}
              className={`w-full px-3 py-2.5 rounded-lg bg-black/30 border text-sm text-t-primary placeholder-t-secondary mb-3 outline-none transition-colors ${error ? 'border-red-500/70 focus:border-red-500' : 'border-[var(--glass-border)] focus:border-[var(--cyan-accent)]/50'}`}
              autoFocus
              aria-invalid={!!error}
            />
            <input
              type="password"
              placeholder={t('dm.securePasswordConfirmPlaceholder')}
              value={confirmPassword}
              onChange={(e) => { setConfirmPassword(e.target.value); if (error) setError(null); }}
              onKeyDown={(e) => e.key === 'Enter' && handleSetup()}
              className={`w-full px-3 py-2.5 rounded-lg bg-black/30 border text-sm text-t-primary placeholder-t-secondary mb-4 outline-none transition-colors ${error ? 'border-red-500/70 focus:border-red-500' : 'border-[var(--glass-border)] focus:border-[var(--cyan-accent)]/50'}`}
              aria-invalid={!!error}
            />
            {error && (
              <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 mb-3 animate-[shake_0.35s_ease-in-out]">
                <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-[13px] text-red-300 leading-snug">{error}</p>
              </div>
            )}
            <button
              type="button"
              onClick={handleSetup}
              disabled={loading || !password || !confirmPassword}
              className="btn-cta w-full py-2.5 rounded-xl disabled:opacity-50 text-sm transition-colors flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
              {t('dm.secureSetupButton')}
            </button>
          </>
        )}

        {step === 'recovery' && (
          <>
            <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>{t('dm.secureRecoveryDescription')}</p>
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
            <label className="flex items-center gap-2 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={savedConfirmed}
                onChange={(e) => setSavedConfirmed(e.target.checked)}
                className="w-4 h-4 rounded-lg border-[var(--border-strong)] bg-black/30"
              />
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('dm.secureRecoverySavedConfirm')}</span>
            </label>
            <button
              type="button"
              onClick={handleFinish}
              disabled={!savedConfirmed}
              className="btn-cta w-full py-2.5 rounded-xl disabled:opacity-50 text-sm transition-colors"
            >
              {t('dm.secureDone')}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  );
};
