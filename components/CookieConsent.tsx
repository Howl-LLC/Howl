// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, ChevronDown, ChevronUp } from 'lucide-react';
import { initSentryIfConsented } from '../src/sentry';
import { getBackendOrigin } from '../config';

export const COOKIE_CONSENT_KEY = 'howl_cookie_consent';

/** Update when ToS or Privacy Policy changes materially — triggers re-consent banner. */
export const CURRENT_POLICY_VERSION = '2026-03-04';

export interface ConsentState {
  essential: true;
  analytics: boolean;
  advertising: boolean;
  policyVersion: string;
  timestamp: number;
}

export function getStoredConsent(): ConsentState | null {
  try {
    const raw = localStorage.getItem(COOKIE_CONSENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Backcompat: old consent objects may lack advertising/policyVersion
    return {
      essential: true,
      analytics: parsed.analytics ?? false,
      advertising: parsed.advertising ?? false,
      policyVersion: parsed.policyVersion ?? '',
      timestamp: parsed.timestamp ?? 0,
    };
  } catch {
    return null;
  }
}

export function storeConsent(analytics: boolean, advertising: boolean): void {
  const consent: ConsentState = { essential: true, analytics, advertising, policyVersion: CURRENT_POLICY_VERSION, timestamp: Date.now() };
  localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify(consent));
  window.dispatchEvent(new Event('howl-consent-change'));
  if (analytics) initSentryIfConsented();
  // Best-effort server-side consent log
  fetch(`${getBackendOrigin()}/api/v1/auth/consent-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analytics, advertising, policyVersion: CURRENT_POLICY_VERSION }),
  }).catch(() => {});
}

export const CookieConsent: React.FC = () => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [analyticsChecked, setAnalyticsChecked] = useState(false);
  const [advertisingChecked, _setAdvertisingChecked] = useState(false);

  useEffect(() => {
    const existing = getStoredConsent();
    if (!existing) {
      setVisible(true);
    } else if (existing.policyVersion !== CURRENT_POLICY_VERSION) {
      // Downgrade consent until user explicitly re-consents under new policy
      storeConsent(false, false);
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  const handleAcceptAll = () => {
    storeConsent(true, false);
    setVisible(false);
  };

  const handleEssentialOnly = () => {
    storeConsent(false, false);
    setVisible(false);
  };

  const handleSavePreferences = () => {
    storeConsent(analyticsChecked, advertisingChecked);
    setVisible(false);
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[var(--z-toast)] flex justify-center p-4 pointer-events-none">
      <div
        className="pointer-events-auto w-full max-w-lg rounded-2xl border p-5 shadow-2xl"
        style={{
          backgroundColor: '#0a0d12',
          borderColor: 'rgba(7, 111, 160, 0.18)',
          backdropFilter: 'blur(20px)',
          boxShadow: '0 -4px 40px rgba(0, 0, 0, 0.5)',
        }}
        role="dialog"
        aria-label={t('cookies.title')}
      >
        <div className="flex items-start gap-3 mb-3">
          <div className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center" style={{ backgroundColor: 'rgba(7, 111, 160, 0.12)' }}>
            <Shield size={18} style={{ color: '#076FA0' }} />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-white">{t('cookies.title')}</h3>
            <p className="text-xs mt-1 leading-relaxed" style={{ color: 'rgba(255,255,255,0.6)' }}>
              {t('cookies.description')}{' '}
              <a href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-[#076FA0] hover:underline">
                {t('cookies.privacyPolicyLink')}
              </a>
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest mb-3 transition-colors"
          style={{ color: 'rgba(255,255,255,0.5)' }}
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {t('cookies.customize')}
        </button>

        {expanded && (
          <div className="space-y-2.5 mb-4 pl-1">
            <label className="flex items-center gap-3 cursor-default">
              <input type="checkbox" checked disabled className="w-3.5 h-3.5 rounded-lg accent-[#076FA0] cursor-not-allowed opacity-60" />
              <div>
                <span className="text-xs font-semibold text-white">{t('cookies.essential')}</span>
                <p className="text-[10px] leading-snug" style={{ color: 'rgba(255,255,255,0.45)' }}>{t('cookies.essentialDesc')}</p>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={analyticsChecked}
                onChange={(e) => setAnalyticsChecked(e.target.checked)}
                className="w-3.5 h-3.5 rounded-lg border-2 border-[rgba(255,255,255,0.25)] bg-transparent checked:bg-[#076FA0] checked:border-[#076FA0] accent-[#076FA0] cursor-pointer"
              />
              <div>
                <span className="text-xs font-semibold text-white">{t('cookies.analytics')}</span>
                <p className="text-[10px] leading-snug" style={{ color: 'rgba(255,255,255,0.45)' }}>{t('cookies.analyticsDesc')}</p>
              </div>
            </label>

          </div>
        )}

        <div className="flex gap-2">
          {expanded ? (
            <button
              type="button"
              onClick={handleSavePreferences}
              className="flex-1 px-4 py-2 rounded-lg text-xs font-bold transition-all hover:brightness-110 active:scale-[0.98]"
              style={{ background: '#02385A', color: '#ffffff' }}
            >
              {t('cookies.savePreferences')}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleEssentialOnly}
                className="flex-1 px-4 py-2 rounded-lg text-xs font-bold transition-all hover:brightness-110 active:scale-[0.98]"
                style={{ background: '#02385A', color: '#ffffff' }}
              >
                {t('cookies.essentialOnly')}
              </button>
              <button
                type="button"
                onClick={handleAcceptAll}
                className="flex-1 px-4 py-2 rounded-lg text-xs font-bold transition-all hover:brightness-110 active:scale-[0.98]"
                style={{ background: '#02385A', color: '#ffffff' }}
              >
                {t('cookies.acceptAll')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
