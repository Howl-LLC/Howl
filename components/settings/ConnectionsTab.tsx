// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpCircle } from 'lucide-react';
import { apiClient } from '../../services/api';
import { getBackendOrigin } from '../../config';
import { assetPath } from '../../utils/assetPath';

const SSO_PROVIDERS: { id: string; label: string; icon: React.ReactNode; color: string; descriptionKey: string; comingSoon?: boolean }[] = [
  { id: 'google', label: 'Google', color: '#4285F4', descriptionKey: 'settings.connections.googleDesc', icon: (
    <img src={assetPath('/sso-google.svg')} alt="Google" className="w-full h-full rounded-full" loading="lazy" decoding="async" />
  )},
  { id: 'apple', label: 'Apple', color: '#A2AAAD', descriptionKey: 'settings.connections.appleDesc', comingSoon: true, icon: (
    <img src={assetPath('/sso-apple.svg')} alt="Apple" className="w-full h-full rounded-full" loading="lazy" decoding="async" />
  )},
  { id: 'steam', label: 'Steam', color: '#1B2838', descriptionKey: 'settings.connections.steamDesc', icon: (
    <img src={assetPath('/sso-steam.svg')} alt="Steam" className="w-full h-full rounded-full" loading="lazy" decoding="async" />
  )},
];

export interface ConnectionsTabProps {}

export const ConnectionsTab: React.FC<ConnectionsTabProps> = () => {
  const { t } = useTranslation();
  const [ssoAccounts, setSsoAccounts] = useState<Array<{ id: string; provider: string; email: string | null }>>([]);
  const [ssoLoading, setSsoLoading] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [ssoUnlinking, setSsoUnlinking] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);

  useEffect(() => {
    setSsoLoading(true);
    setSsoError(null);
    apiClient.getSsoAccounts().then(setSsoAccounts).catch(() => setSsoError(t('settings.connections.loadError'))).finally(() => setSsoLoading(false));
  }, []);

  // Detect SSO link result from URL params (redirect back from OAuth callback)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linked = params.get('sso_linked');
    const error = params.get('sso_error');

    if (linked) {
      setSsoAccounts([]);
      setSsoLoading(true);
      apiClient.getSsoAccounts().then(setSsoAccounts).catch(() => {}).finally(() => setSsoLoading(false));
      const url = new URL(window.location.href);
      url.searchParams.delete('sso_linked');
      window.history.replaceState({}, '', url.pathname + url.hash);
    }
    if (error) {
      const errorMessages: Record<string, string> = {
        already_linked_other: t('settings.connections.alreadyLinkedOther', 'This account is already connected to a different Howl user.'),
        too_many_connections: t('settings.connections.tooManyConnections', 'You have too many connected accounts. Please disconnect one first.'),
        user_not_found: t('settings.connections.userNotFound', 'User not found.'),
        suspended: t('settings.connections.suspended', 'Your account is suspended.'),
        invalid_link_token: t('settings.connections.invalidLinkToken', 'Link session expired. Please try again.'),
        link_failed: t('settings.connections.linkFailed', 'Failed to connect. Please try again.'),
      };
      setSsoError(errorMessages[error] || t('settings.connections.connectError', 'Failed to connect'));
      const url = new URL(window.location.href);
      url.searchParams.delete('sso_error');
      window.history.replaceState({}, '', url.pathname + url.hash);
    }
  }, []);

  // Electron: listen for SSO link result from deep link callback
  useEffect(() => {
    if (!(window as any).electron?.onSsoSettingsCallback) return;
    const cleanup = (window as any).electron.onSsoSettingsCallback((data: Record<string, string>) => {
      const linked = data.sso_linked;
      const error = data.sso_error;

      if (linked) {
        setSsoAccounts([]);
        setSsoLoading(true);
        apiClient.getSsoAccounts().then(setSsoAccounts).catch(() => {}).finally(() => setSsoLoading(false));
      }
      if (error) {
        const errorMessages: Record<string, string> = {
          already_linked_other: t('settings.connections.alreadyLinkedOther', 'This account is already connected to a different Howl user.'),
          too_many_connections: t('settings.connections.tooManyConnections', 'You have too many connected accounts. Please disconnect one first.'),
          user_not_found: t('settings.connections.userNotFound', 'User not found.'),
          suspended: t('settings.connections.suspended', 'Your account is suspended.'),
          invalid_link_token: t('settings.connections.invalidLinkToken', 'Link session expired. Please try again.'),
          link_failed: t('settings.connections.linkFailed', 'Failed to connect. Please try again.'),
        };
        setSsoError(errorMessages[error] || t('settings.connections.connectError', 'Failed to connect'));
      }
    });
    return cleanup;
  }, [t]);

  const handleSsoConnect = async (provider: string) => {
    setConnecting(provider);
    setSsoError(null);
    try {
      const { linkToken } = await apiClient.getSsoLinkToken(provider);
      // Electron: use IPC to open system browser (deep link returns via onSsoSettingsCallback)
      if ((window as any).electron?.startSsoLink) {
        (window as any).electron.startSsoLink({ provider, linkToken });
        setConnecting(null); // Don't keep spinner — callback comes async via deep link
        return;
      }
      // Web: direct navigation (unchanged)
      const sanitizedProvider = provider.replace(/[^a-z0-9-]/gi, '');
      const base = getBackendOrigin();
      const target = `${base}/api/auth/sso/${sanitizedProvider}?link_token=${encodeURIComponent(linkToken)}`;
      const parsed = new URL(target);
      if (parsed.protocol === 'https:' || parsed.hostname === 'localhost') {
        window.location.href = target;
      }
    } catch (err: unknown) {
      setSsoError(err instanceof Error ? err.message : t('settings.connections.connectError', 'Failed to connect'));
      setConnecting(null);
    }
  };

  const handleSsoDisconnect = async (accountId: string) => {
    setSsoUnlinking(accountId);
    try {
      await apiClient.unlinkSsoAccount(accountId);
      setSsoAccounts((prev) => prev.filter((a) => a.id !== accountId));
    } catch {
      /* handled */
    } finally {
      setSsoUnlinking(null);
    }
  };

  const linkedProviders = new Map(ssoAccounts.map((a) => [a.provider, a]));

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2 text-t-primary">{t('settings.connections')}</h2>
      <p className="text-xs mb-8 text-t-secondary">{t('settings.connections.description')}</p>

      {ssoError && (
        <div className="text-sm text-red-400 py-4 text-center">{ssoError}</div>
      )}
      {ssoLoading ? (
        <div className="flex items-center justify-center py-16">
          <span className="inline-block w-8 h-8 border-2 border-[var(--border-strong)] border-t-white rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-3">
          {SSO_PROVIDERS.map((provider) => {
            const linked = linkedProviders.get(provider.id);
            return (
              <div key={provider.id} id={`setting-connect-${provider.id}-sso`} className={`border rounded-2xl p-5 transition-all bg-panel ${linked ? 'border-[rgba(16,185,129,0.25)]' : 'border-default'}`}>
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-full overflow-hidden shrink-0">
                    {provider.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-t-primary">{provider.label}</span>
                      {linked && (
                        <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-lg bg-emerald-500/15 text-emerald-400">{t('settings.connections.connected')}</span>
                      )}
                    </div>
                    {linked ? (
                      <p className="text-[11px] mt-0.5 text-t-secondary">{linked.email || t('settings.connections.linkedAs', { provider: provider.label })}</p>
                    ) : (
                      <p className="text-[11px] mt-0.5 text-t-secondary">{t(provider.descriptionKey)}</p>
                    )}
                  </div>
                  {linked ? (
                    <button
                      type="button"
                      onClick={() => handleSsoDisconnect(linked.id)}
                      disabled={ssoUnlinking === linked.id}
                      className="btn-cta-danger text-[10px] font-semibold px-4 py-2 rounded-xl transition-all disabled:opacity-50 shrink-0"
                    >
                      {ssoUnlinking === linked.id ? t('settings.connections.unlinking') : t('settings.disconnect')}
                    </button>
                  ) : provider.comingSoon ? (
                    <span className="text-[10px] font-semibold uppercase tracking-wide px-4 py-2 rounded-lg border border-default text-t-secondary shrink-0">
                      {t('settings.comingSoon')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleSsoConnect(provider.id)}
                      disabled={connecting === provider.id}
                      className="btn-cta text-[10px] font-semibold px-4 py-2 rounded-xl transition-all shrink-0 disabled:opacity-50"
                    >
                      {connecting === provider.id ? t('settings.connections.connecting', 'Connecting...') : t('settings.connect')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-8 border border-[var(--glass-border)] rounded-2xl p-5 bg-panel">
        <div className="flex items-start gap-3">
          <HelpCircle size={16} className="text-[var(--cyan-accent)] mt-0.5 shrink-0" />
          <div>
            <p className="text-xs font-bold mb-1 text-t-primary">{t('settings.connections.aboutTitle')}</p>
            <p className="text-[11px] leading-relaxed text-t-secondary">
              {t('settings.connections.aboutBody')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConnectionsTab;
