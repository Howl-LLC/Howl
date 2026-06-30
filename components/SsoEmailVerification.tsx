// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../services/api';
import type { User } from '../types';
import { Mail, AlertCircle, Loader2, CheckCircle } from 'lucide-react';

interface SsoEmailVerificationProps {
  user: User;
  onVerified: (updatedUser: User) => void;
}

/**
 * Full-screen gate shown to SSO users whose email is not yet verified.
 * Provides a code entry field and a "Resend verification email" button.
 * Also polls /auth/me periodically to detect when verification completes
 * via a different tab/device.
 */
export const SsoEmailVerification: React.FC<SsoEmailVerificationProps> = ({ user, onVerified }) => {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputCls = "w-full rounded-xl border px-4 py-3 text-sm text-white outline-none transition-all duration-200 text-center tracking-[0.3em] font-mono text-lg";
  const inputStyle = {
    backgroundColor: 'rgba(15,23,42,0.8)',
    borderColor: 'rgba(51,65,85,0.5)',
  };

  // Poll /auth/me every 10s to detect verification completion
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const me = await apiClient.me();
        if (me.emailVerified !== false) {
          onVerified(me);
        }
      } catch {
        // Silently ignore -- user may not be connected
      }
    }, 10_000);
    return () => clearInterval(interval);
  }, [onVerified]);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  const handleVerify = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (verifying || code.length !== 6) return;
    setVerifying(true);
    setError(null);
    try {
      const verifiedUser = await apiClient.verifyEmailAuthenticated(code);
      onVerified(verifiedUser);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.somethingWentWrong', 'Something went wrong. Please try again.'));
    } finally {
      setVerifying(false);
    }
  }, [verifying, code, onVerified, t]);

  const handleResend = useCallback(async () => {
    if (resending || resendCooldown > 0) return;
    setResending(true);
    setError(null);
    setResent(false);
    try {
      await apiClient.resendVerificationAuthenticated();
      setResent(true);
      setResendCooldown(60);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.somethingWentWrong', 'Something went wrong. Please try again.'));
    } finally {
      setResending(false);
    }
  }, [resending, resendCooldown, t]);

  return (
    <div className="flex h-dvh w-full items-center justify-center overflow-hidden" style={{ backgroundColor: 'var(--bg-app)' }}>
      <div className="w-[420px] text-center px-2">
        <form onSubmit={handleVerify} className="space-y-5">
          <Mail size={48} className="mx-auto" style={{ color: 'var(--cyan-accent)' }} />
          <p className="text-white text-lg font-semibold">
            {t('login.verifyEmailTitle', 'Verify your email')}
          </p>
          <p className="text-sm" style={{ color: 'rgba(148,163,184,0.8)' }}>
            {t('login.ssoVerifyEmailDescription', "We've sent a verification code to your email address. Please check your inbox and enter the code to continue.")}
          </p>

          {user.email && (
            <div
              className="rounded-xl px-4 py-2.5 text-sm inline-block"
              style={{ backgroundColor: 'rgba(15,23,42,0.8)', border: '1px solid rgba(51,65,85,0.5)', color: 'rgba(148,163,184,0.9)' }}
            >
              {user.email}
            </div>
          )}

          {/* Verification code input */}
          <div>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(null); }}
              className={inputCls}
              style={inputStyle}
              placeholder="000000"
              maxLength={6}
              autoFocus
            />
          </div>

          {resent && (
            <div className="flex items-center justify-center gap-2">
              <CheckCircle size={14} style={{ color: 'var(--success)' }} />
              <p className="text-sm" style={{ color: 'var(--success)' }}>
                {t('login.verificationResent', 'Verification email sent!')}
              </p>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center gap-2">
              <AlertCircle size={14} className="shrink-0" style={{ color: 'var(--danger)' }} />
              <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={verifying || code.length !== 6}
            className="w-full rounded-xl py-3 text-sm font-semibold transition-all duration-200 hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
            style={{
              background: verifying ? 'var(--accent-glow)' : 'linear-gradient(135deg, var(--cyan-accent) 0%, #06b6d4 100%)',
              color: 'var(--text-on-accent)',
              boxShadow: verifying ? 'none' : '0 0 30px var(--accent-emphasis)',
            }}
          >
            {verifying ? <Loader2 size={18} className="animate-spin mx-auto" /> : t('login.verifyEmail', 'Verify Email')}
          </button>

          <button
            type="button"
            onClick={handleResend}
            disabled={resending || resendCooldown > 0}
            className="w-full text-sm font-medium transition-colors duration-200 disabled:opacity-50"
            style={{ color: 'var(--cyan-accent)' }}
          >
            {resending ? (
              <Loader2 size={14} className="animate-spin mx-auto" />
            ) : resendCooldown > 0 ? (
              t('login.resendIn', 'Resend in {{seconds}}s', { seconds: resendCooldown })
            ) : (
              t('login.resendVerification', 'Resend verification email')
            )}
          </button>

          <p className="text-[11px]" style={{ color: 'rgba(148,163,184,0.4)' }}>
            {t('login.verifyEmailHint', "Didn't receive the email? Check your spam folder or click above to resend.")}
          </p>
        </form>
      </div>
    </div>
  );
};
