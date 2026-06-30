// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../services/api';
import type { User } from '../types';
import { Calendar, AlertCircle, Loader2, LogOut } from 'lucide-react';
import { DatePicker } from './DatePicker';

interface DateOfBirthPromptProps {
  user: User;
  onComplete: (updatedUser: User) => void;
}

export const DateOfBirthPrompt: React.FC<DateOfBirthPromptProps> = ({ user, onComplete }) => {
  const { t } = useTranslation();
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const inputCls = "w-full rounded-xl border px-4 py-3 text-sm text-white outline-none transition-all duration-200";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dateOfBirth || isLoading) return;

    // Client-side age check (backend also enforces)
    const dob = new Date(dateOfBirth);
    const ageDiffMs = Date.now() - dob.getTime();
    const ageYears = ageDiffMs / (1000 * 60 * 60 * 24 * 365.25);
    if (ageYears < 13) {
      setError(t('login.mustBe13', 'You must be at least 13 years old to use Howl.'));
      return;
    }

    setError(null);
    setIsLoading(true);
    try {
      await apiClient.setDateOfBirth(dateOfBirth);
      onComplete({ ...user, needsDateOfBirth: false });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save date of birth');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-dvh w-full items-center justify-center overflow-hidden" style={{ backgroundColor: 'var(--bg-app)' }}>
      <div className="w-80 text-center">
        <form onSubmit={handleSubmit} className="space-y-4">
          <Calendar size={48} className="mx-auto" style={{ color: 'var(--cyan-accent)' }} />
          <p className="text-white text-lg font-semibold">
            {t('login.dobPromptTitle', 'One More Step')}
          </p>
          <p className="text-sm" style={{ color: 'rgba(148,163,184,0.8)' }}>
            {t('login.dobPromptDescription', 'Please enter your date of birth to continue. This is required for age verification.')}
          </p>

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
              autoFocus
            />
            <p className="text-[10px] mt-1 text-left" style={{ color: 'rgba(148,163,184,0.4)' }}>
              {t('login.dateOfBirthHint')}
            </p>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-left">
              <AlertCircle size={14} className="shrink-0" style={{ color: 'var(--danger)' }} />
              <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading || !dateOfBirth}
            className="w-full rounded-xl py-3 text-sm font-semibold transition-all duration-200 hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
            style={{
              background: isLoading ? 'var(--accent-glow)' : 'linear-gradient(135deg, var(--cyan-accent) 0%, #06b6d4 100%)',
              color: 'var(--text-on-accent)',
              boxShadow: isLoading ? 'none' : '0 0 30px var(--accent-emphasis)',
            }}
          >
            {isLoading ? <Loader2 size={18} className="animate-spin mx-auto" /> : t('login.dobPromptContinue', 'Continue')}
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
