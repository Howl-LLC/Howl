// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../services/api';
import type { User } from '../types';
import { Lock, AlertCircle, Loader2, Eye, EyeOff, LogOut } from 'lucide-react';

interface PasswordSetupPromptProps {
  user: User;
  onComplete: (updatedUser: User, password: string) => void;
}

export const PasswordSetupPrompt: React.FC<PasswordSetupPromptProps> = ({ user, onComplete }) => {
  const { t } = useTranslation();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const inputCls = "w-full rounded-xl border px-4 py-3 text-sm text-white outline-none transition-all duration-200";
  const inputStyle = {
    backgroundColor: 'rgba(15,23,42,0.8)',
    borderColor: 'rgba(51,65,85,0.5)',
  };

  const checks = [
    { label: t('settings.account.pw12Chars'), ok: newPassword.length >= 12 },
    { label: t('settings.account.pwUppercase'), ok: /[A-Z]/.test(newPassword) },
    { label: t('settings.account.pwNumber'), ok: /[0-9]/.test(newPassword) },
    { label: t('settings.account.pwSymbol'), ok: /[^A-Za-z0-9]/.test(newPassword) },
  ];
  const passed = checks.filter(c => c.ok).length;
  const allPassed = passed === 4;
  const passwordsMatch = newPassword === confirmPassword;
  const canSubmit = allPassed && passwordsMatch && confirmPassword.length > 0 && !isLoading;

  const colors = ['var(--danger)', 'var(--warning)', 'var(--warning)', 'var(--success)'];
  const barColor = passed === 0 ? 'rgba(51,65,85,0.5)' : colors[passed - 1];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setIsLoading(true);
    try {
      await apiClient.changePassword(undefined, newPassword);
      onComplete({ ...user, hasPassword: true }, newPassword);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('settings.account.failedToChangePassword'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-dvh w-full items-center justify-center overflow-hidden" style={{ backgroundColor: 'var(--bg-app)' }}>
      <div className="w-96 text-center">
        <form onSubmit={handleSubmit} className="space-y-5">
          <Lock size={48} className="mx-auto" style={{ color: 'var(--cyan-accent)' }} />
          <p className="text-white text-lg font-semibold">
            {t('login.passwordSetupTitle', 'Set Your Password')}
          </p>
          <p className="text-sm" style={{ color: 'rgba(148,163,184,0.8)' }}>
            {t('login.passwordSetupDescription', 'Create a password so you can log in with email and keep your account secure.')}
          </p>

          {/* Password input */}
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
              autoFocus
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
                {checks.map(c => (
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

          {error && (
            <div className="flex items-center gap-2 text-left">
              <AlertCircle size={14} className="shrink-0" style={{ color: 'var(--danger)' }} />
              <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-xl py-3 text-sm font-semibold transition-all duration-200 hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
            style={{
              background: isLoading ? 'var(--accent-glow)' : 'linear-gradient(135deg, var(--cyan-accent) 0%, #06b6d4 100%)',
              color: 'var(--text-on-accent)',
              boxShadow: isLoading ? 'none' : '0 0 30px var(--accent-emphasis)',
            }}
          >
            {isLoading ? <Loader2 size={18} className="animate-spin mx-auto" /> : t('login.passwordSetupContinue', 'Set Password & Continue')}
          </button>

          <button
            type="button"
            onClick={() => { apiClient.logout(); apiClient.clearToken(); window.location.href = '/'; }}
            className="flex items-center justify-center gap-1.5 mx-auto mt-1 text-xs transition-colors hover:underline"
            style={{ color: 'rgba(148,163,184,0.6)' }}
          >
            <LogOut size={12} />
            {t('login.logOut', 'Log out')}
          </button>
        </form>
      </div>
    </div>
  );
};
