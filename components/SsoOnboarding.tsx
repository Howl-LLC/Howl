// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../services/api';
import type { User } from '../types';
import { ShieldCheck, AlertCircle, Loader2, FileText, Eye, EyeOff } from 'lucide-react';
import { DatePicker } from './DatePicker';

interface SsoOnboardingProps {
  user: User;
  onComplete: (updatedUser: User, password: string) => void;
}

export const SsoOnboarding: React.FC<SsoOnboardingProps> = ({ user, onComplete }) => {
  const { t } = useTranslation();
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Steam OpenID doesn't expose an email, so the backend assigns a synthetic
  // `<provider>_<id>@sso.local` placeholder at signup. Detect that here and
  // require a real email before completing onboarding so the user can receive
  // password-reset, verification, and notification email.
  const hasSyntheticEmail = /^[a-z]+_[^@]+@sso\.local$/i.test(user.email ?? '');
  const [email, setEmail] = useState('');
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const inputCls = "w-full rounded-xl border px-4 py-3 text-sm text-white outline-none transition-all duration-200";
  const inputStyle = {
    backgroundColor: 'rgba(15,23,42,0.8)',
    borderColor: 'rgba(51,65,85,0.5)',
  };

  const pwChecks = [
    { label: t('settings.account.pw12Chars'), ok: newPassword.length >= 12 },
    { label: t('settings.account.pwUppercase'), ok: /[A-Z]/.test(newPassword) },
    { label: t('settings.account.pwNumber'), ok: /[0-9]/.test(newPassword) },
    { label: t('settings.account.pwSymbol'), ok: /[^A-Za-z0-9]/.test(newPassword) },
  ];
  const passed = pwChecks.filter(c => c.ok).length;
  const allPassed = passed === 4;
  const passwordsMatch = newPassword === confirmPassword;
  const colors = ['var(--danger)', 'var(--warning)', 'var(--warning)', 'var(--success)'];
  const barColor = passed === 0 ? 'rgba(51,65,85,0.5)' : colors[passed - 1];

  const canSubmit = !!dateOfBirth && agreedToTerms && allPassed && passwordsMatch && confirmPassword.length > 0 && !isLoading && (!hasSyntheticEmail || emailValid);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setIsLoading(true);
    try {
      // Atomic: DOB + terms + password (+ email for Steam SSO) in one request
      const submittedEmail = hasSyntheticEmail ? email.trim().toLowerCase() : undefined;
      await apiClient.completeOnboarding(dateOfBirth, newPassword, submittedEmail);
      // Providing a new email flips the account back to unverified — the app
      // gate (App root, keyed on emailVerified) will render SsoEmailVerification until the user
      // enters the 6-digit code. Reflect that immediately in local state so
      // we don't show the home screen for one render.
      onComplete({
        ...user,
        email: submittedEmail ?? user.email,
        emailVerified: submittedEmail ? false : user.emailVerified,
        needsOnboarding: false,
        needsDateOfBirth: false,
        hasPassword: true,
      }, newPassword);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to complete setup');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-dvh w-full items-center justify-center overflow-hidden" style={{ backgroundColor: 'var(--bg-app)' }}>
      <div className="w-[420px] text-center max-h-[90vh] overflow-y-auto px-2">
        <form onSubmit={handleSubmit} className="space-y-5">
          <ShieldCheck size={48} className="mx-auto" style={{ color: 'var(--cyan-accent)' }} />
          <p className="text-white text-lg font-semibold">
            {t('login.ssoOnboardingTitle', 'Complete Your Account')}
          </p>
          <p className="text-sm" style={{ color: 'rgba(148,163,184,0.8)' }}>
            {t('login.ssoOnboardingDescription', 'Before you can start using Howl, we need a few things.')}
          </p>

          {/* Email (only shown for SSO providers that don't expose email — Steam) */}
          {hasSyntheticEmail && (
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5 text-left" style={{ color: 'rgba(148,163,184,0.7)' }}>
                {t('login.emailLabel', 'Email')}
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(null); }}
                className={inputCls}
                style={inputStyle}
                placeholder="you@example.com"
                autoComplete="email"
                maxLength={254}
                required
              />
              <p className="text-[10px] mt-1 text-left" style={{ color: 'rgba(148,163,184,0.4)' }}>
                {t('login.steamEmailHint', "Steam doesn't share your email with apps, so we need you to provide one for account recovery and notifications.")}
              </p>
            </div>
          )}

          {/* Date of Birth */}
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5 text-left" style={{ color: 'rgba(148,163,184,0.7)' }}>
              {t('login.dateOfBirth')}
            </label>
            <DatePicker
              value={dateOfBirth}
              onChange={setDateOfBirth}
              max={new Date().toISOString().split('T')[0]}
              className={inputCls}
              required
              autoFocus={!hasSyntheticEmail}
            />
            <p className="text-[10px] mt-1 text-left" style={{ color: 'rgba(148,163,184,0.4)' }}>
              {t('login.dateOfBirthHint')}
            </p>
          </div>

          {/* Password */}
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5 text-left" style={{ color: 'rgba(148,163,184,0.7)' }}>
              {t('login.passwordSetupTitle', 'Set Your Password')}
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => { setNewPassword(e.target.value); setError(null); }}
                className={inputCls + " pr-11"}
                style={inputStyle}
                placeholder={t('settings.newPassword')}
                autoComplete="new-password"
                maxLength={128}
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Strength indicator */}
          {newPassword && (
            <div className="space-y-1.5 text-left">
              <div className="flex gap-1">
                {[0, 1, 2, 3].map(i => (
                  <div key={i} className="h-1 flex-1 rounded-full transition-colors duration-200"
                    style={{ backgroundColor: i < passed ? barColor : 'rgba(51,65,85,0.3)' }} />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                {pwChecks.map(c => (
                  <span key={c.label} className="text-[10px]" style={{ color: c.ok ? 'var(--success)' : 'rgba(148,163,184,0.5)' }}>
                    {c.ok ? '\u2713' : '\u25CB'} {c.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Confirm password */}
          <div>
            <input
              type={showPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => { setConfirmPassword(e.target.value); setError(null); }}
              className={inputCls}
              style={inputStyle}
              placeholder={t('settings.confirmNewPassword')}
              autoComplete="new-password"
              maxLength={128}
            />
            {confirmPassword && !passwordsMatch && (
              <p className="text-[10px] mt-1 text-left" style={{ color: 'var(--danger)' }}>
                {t('login.passwordsMustMatch', "Passwords don't match")}
              </p>
            )}
          </div>

          {/* Terms */}
          <label className="flex items-start gap-3 cursor-pointer text-left">
            <input
              type="checkbox"
              checked={agreedToTerms}
              onChange={(e) => setAgreedToTerms(e.target.checked)}
              className="mt-1 w-4 h-4 rounded-lg border-2 border-slate-600 bg-transparent checked:bg-[var(--cyan-accent)] checked:border-[var(--cyan-accent)] accent-[var(--cyan-accent)] cursor-pointer shrink-0"
            />
            <span className="text-xs leading-relaxed" style={{ color: 'rgba(148,163,184,0.8)' }}>
              <FileText size={12} className="inline mr-1" style={{ color: 'var(--cyan-accent)' }} />
              {t('login.ssoAgreePrefix', 'I agree to the')}{' '}
              <a href="/terms-of-service" target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline">
                {t('login.termsOfService', 'Terms of Service')}
              </a>{' '}
              {t('login.and', 'and')}{' '}
              <a href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline">
                {t('login.privacyPolicy', 'Privacy Policy')}
              </a>
            </span>
          </label>

          {error && (
            <div className="flex items-center gap-2 text-left">
              <AlertCircle size={14} className="shrink-0" style={{ color: 'var(--danger)' }} />
              <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="btn-cta w-full rounded-xl py-3 text-sm font-semibold transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? <Loader2 size={18} className="animate-spin mx-auto" /> : t('login.dobPromptContinue', 'Continue')}
          </button>
        </form>
      </div>
    </div>
  );
};
