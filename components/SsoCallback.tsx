// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../services/api';
import type { User } from '../types';
import { Loader2, AlertCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface SsoCallbackProps {
  onAuthSuccess: (user: User, loginPassword?: string) => void;
}

export const SsoCallback: React.FC<SsoCallbackProps> = ({ onAuthSuccess }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const exchanged = useRef(false);

  useEffect(() => {
    if (exchanged.current) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const err = params.get('error');

    if (err) {
      const knownErrors: Record<string, string> = {
        sso_failed: t('sso.ssoFailed'),
        invalid_state: t('sso.invalidState'),
        access_denied: t('sso.accessDenied'),
        email_exists: t('sso.emailExists'),
        suspended: t('sso.suspended'),
        username_unavailable: t('sso.usernameUnavailable'),
      };
      setError(knownErrors[err] ?? t('sso.authFailed'));
      return;
    }

    if (code) {
      exchanged.current = true;
      apiClient.exchangeSsoCode(code)
        .then((result) => {
          if ('mfaRequired' in result && result.mfaRequired) {
            // SSO matched an MFA-enrolled account — hand the challenge off to
            // the login screen's MFA flow.
            try {
              sessionStorage.setItem('howl_sso_mfa', JSON.stringify({
                mfaToken: result.mfaToken,
                methods: result.methods,
                ts: Date.now(),
              }));
            } catch { /* sessionStorage unavailable — login will surface the error */ }
            navigate('/login', { replace: true });
          } else if ('user' in result && result.user) {
            navigate('/home', { replace: true });
            onAuthSuccess(result.user);
          } else {
            navigate('/auth/callback', { replace: true });
            setError(t('sso.failedToComplete'));
          }
        })
        .catch((e: Error) => {
          navigate('/auth/callback', { replace: true });
          setError(e?.message || t('sso.failedToComplete'));
        });
    } else {
      setError(t('sso.noCodeReceived'));
    }
  }, [onAuthSuccess]);

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden" style={{ backgroundColor: 'var(--bg-app)' }}>
      <div className="text-center">
        {error ? (
          <div className="space-y-4">
            <AlertCircle size={48} className="mx-auto" style={{ color: 'var(--danger)' }} />
            <p className="text-white text-lg font-semibold">{t('sso.authFailedTitle')}</p>
            <p className="text-sm" style={{ color: 'rgba(148,163,184,0.8)' }}>{error}</p>
            <a href="/" className="inline-block mt-4 px-6 py-2.5 rounded-xl text-sm font-bold" style={{ background: 'linear-gradient(135deg, var(--cyan-accent), #06b6d4)', color: 'var(--text-on-accent)' }}>
              {t('sso.backToLogin')}
            </a>
          </div>
        ) : (
          <div className="space-y-3">
            <Loader2 size={40} className="animate-spin mx-auto" style={{ color: 'var(--cyan-accent)' }} />
            <p className="text-sm" style={{ color: 'rgba(148,163,184,0.8)' }}>{t('sso.completingSignIn')}</p>
          </div>
        )}
      </div>
    </div>
  );
};
