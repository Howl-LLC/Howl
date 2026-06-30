// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Shield, Download, Clock, Send, RefreshCw,
  AlertCircle, CheckCircle2, Mail
} from 'lucide-react';
import { User } from '../../types';
import { apiClient } from '../../services/api';
import { ConfirmDialog } from './SettingsWidgets';
import { getBackendOrigin } from '../../config';
import { getStoredConsent, storeConsent as storeCookieConsent } from '../CookieConsent';

export interface DataControlsTabProps {
  user: User;
}

export const DataControlsTab: React.FC<DataControlsTabProps> = ({ user: _user }) => {
  const { t } = useTranslation();

  const [exportPassword, setExportPassword] = useState('');
  const [exportStatus, setExportStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [exportError, setExportError] = useState('');
  const [cacheClearLoading, setCacheClearLoading] = useState(false);
  const [confirmClearCache, setConfirmClearCache] = useState(false);
  const [exportRequest, setExportRequest] = useState<{
    hasRequest: boolean;
    requestId?: string;
    status?: string;
    createdAt?: string;
    expiresAt?: string;
    error?: string;
    downloadToken?: string;
    nextAvailableAt?: string;
  } | null>(null);
  const [exportStatusLoading, setExportStatusLoading] = useState(false);

  const loadExportStatus = useCallback(async () => {
    setExportStatusLoading(true);
    try {
      const status = await apiClient.getExportStatus();
      setExportRequest(status);
    } catch { /* ignore */ }
    setExportStatusLoading(false);
  }, []);

  useEffect(() => {
    loadExportStatus();
  }, [loadExportStatus]);

  const handleRequestExport = async () => {
    if (!exportPassword) { setExportError(t('settings.data.passwordRequired')); return; }
    setExportStatus('loading');
    setExportError('');
    try {
      await apiClient.requestDataExport(exportPassword);
      setExportStatus('success');
      setExportPassword('');
      loadExportStatus();
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : t('settings.data.exportRequestFailed'));
      setExportStatus('error');
    }
  };

  const exportTimeAgo = (iso?: string) => {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return t('settings.data.justNow');
    if (diff < 3600000) return t('settings.data.minutesAgo', { count: Math.floor(diff / 60000) });
    if (diff < 86400000) return t('settings.data.hoursAgo', { count: Math.floor(diff / 3600000) });
    return new Date(iso).toLocaleDateString();
  };

  const req = exportRequest;
  const hasPendingOrProcessing = req?.hasRequest && (req.status === 'pending' || req.status === 'processing');
  const isReady = req?.hasRequest && req.status === 'ready';
  const isFailed = req?.hasRequest && req.status === 'failed';
  const isExpired = req?.hasRequest && req.status === 'expired';
  const onCooldown = !!req?.nextAvailableAt && new Date(req.nextAvailableAt) > new Date();

  const downloadUrl = isReady && req.downloadToken && req.requestId
    ? `${getBackendOrigin()}/api/gdpr/download/${req.requestId}?token=${req.downloadToken}`
    : null;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h2 className="text-lg font-bold mb-1 text-t-primary">{t('settings.dataControls')}</h2>
        <p className="text-xs text-t-secondary">{t('settings.data.manageHowHowlStores')}</p>
      </div>

      {/* Export My Data */}
      <div id="setting-request-data-export" className="rounded-2xl overflow-hidden bg-panel">
        <div className="px-6 py-5 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-3">
            <Download size={18} className="text-t-primary" />
            <div>
              <h3 className="text-sm font-semibold text-t-primary">{t('settings.data.requestDataExport')}</h3>
              <p className="text-xs mt-0.5 text-t-secondary">
                {t('settings.data.requestDataExportDesc')}
              </p>
            </div>
          </div>
        </div>
        <div className="p-6 space-y-4">
          {/* Current request status */}
          {exportStatusLoading && (
            <div className="flex items-center gap-2 text-xs text-t-secondary">
              <RefreshCw size={14} className="animate-spin" /> {t('settings.data.checkingExportStatus')}
            </div>
          )}

          {hasPendingOrProcessing && (
            <div className="flex items-start gap-3 p-4 rounded-xl" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--cyan-accent) 20%, transparent)' }}>
              <RefreshCw size={16} className="shrink-0 mt-0.5 animate-spin text-t-accent" />
              <div>
                <p className="text-sm font-medium text-t-accent">
                  {req.status === 'pending' ? t('settings.data.exportQueued') : t('settings.data.exportInProgress')}
                </p>
                <p className="text-xs mt-1 text-t-secondary">
                  {t('settings.data.exportBeingPrepared')}
                  {req.createdAt && <span className="ml-1">{t('settings.data.requested', { time: exportTimeAgo(req.createdAt) })}</span>}
                </p>
                <button id="setting-refresh-export-status" type="button" onClick={loadExportStatus} className="text-xs mt-2 underline text-t-accent">
                  {t('settings.data.refreshStatus')}
                </button>
              </div>
            </div>
          )}

          {isReady && downloadUrl && (
            <div className="flex items-start gap-3 p-4 rounded-xl" style={{ backgroundColor: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)' }}>
              <CheckCircle2 size={16} className="shrink-0 mt-0.5" style={{ color: '#22c55e' }} />
              <div className="flex-1">
                <p className="text-sm font-medium" style={{ color: '#22c55e' }}>{t('settings.data.exportReady')}</p>
                <p className="text-xs mt-1 text-t-secondary">
                  {t('settings.data.exportReadyDesc')}
                  {req.expiresAt && (
                    <span className="ml-1">
                      {t('settings.data.linkExpires', { date: new Date(req.expiresAt).toLocaleString() })}
                    </span>
                  )}
                </p>
                <a
                  id="setting-download-data-export"
                  href={downloadUrl}
                  className="inline-flex items-center gap-2 mt-3 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ backgroundColor: 'var(--accent-primary)', color: '#fff' }}
                >
                  <Download size={14} /> {t('settings.data.downloadExport')}
                </a>
              </div>
            </div>
          )}

          {isReady && !downloadUrl && (
            <div className="flex items-start gap-3 p-4 rounded-xl" style={{ backgroundColor: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)' }}>
              <Mail size={16} className="shrink-0 mt-0.5" style={{ color: '#22c55e' }} />
              <div className="flex-1">
                <p className="text-sm font-medium" style={{ color: '#22c55e' }}>{t('settings.data.exportReady')}</p>
                <p className="text-xs mt-1 leading-relaxed text-t-secondary">
                  {t('settings.data.exportReadyEmail')}
                </p>
              </div>
            </div>
          )}

          {isFailed && (
            <div className="flex items-start gap-3 p-4 rounded-xl" style={{ backgroundColor: 'var(--danger-subtle)', border: '1px solid var(--danger-muted)' }}>
              <AlertCircle size={16} className="shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
              <div>
                <p className="text-sm font-medium" style={{ color: 'var(--danger)' }}>{t('settings.data.exportFailed')}</p>
                <p className="text-xs mt-1 text-t-secondary">
                  {req.error || t('settings.data.exportFailedDesc')}
                </p>
              </div>
            </div>
          )}

          {isExpired && (
            <div className="flex items-start gap-3 p-4 rounded-xl" style={{ backgroundColor: 'rgba(100,116,139,0.08)', border: '1px solid rgba(100,116,139,0.2)' }}>
              <Clock size={16} className="shrink-0 mt-0.5" style={{ color: '#64748b' }} />
              <div>
                <p className="text-sm font-medium" style={{ color: '#94a3b8' }}>{t('settings.data.exportExpired')}</p>
                <p className="text-xs mt-1 text-t-secondary">
                  {t('settings.data.exportExpiredDesc')}
                </p>
              </div>
            </div>
          )}

          {/* Request form -- shown when no active request */}
          {!hasPendingOrProcessing && (
            <>
              {onCooldown && (
                <div className="flex items-start gap-3 p-4 rounded-xl" style={{ backgroundColor: 'rgba(100,116,139,0.08)', border: '1px solid rgba(100,116,139,0.2)' }}>
                  <Clock size={16} className="shrink-0 mt-0.5" style={{ color: '#64748b' }} />
                  <div>
                    <p className="text-sm font-medium" style={{ color: '#94a3b8' }}>{t('settings.data.cooldownActive')}</p>
                    <p className="text-xs mt-1 text-t-secondary">
                      {t('settings.data.cooldownDesc')}{' '}
                      <strong className="text-t-primary">
                        {new Date(req!.nextAvailableAt!).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </strong>.
                    </p>
                  </div>
                </div>
              )}

              {!onCooldown && (
                <div className="flex items-start gap-3 p-3 rounded-lg text-xs bg-floating text-t-secondary">
                  <Shield size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--accent-primary)' }} />
                  <span>{t('settings.data.securityConfirmPassword')}</span>
                </div>
              )}

              {!onCooldown && (
              <div id="setting-export-confirm-password" className="flex items-end gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium mb-1.5 text-t-secondary">{t('settings.data.confirmPassword')}</label>
                  <input
                    type="password"
                    value={exportPassword}
                    onChange={(e) => { setExportPassword(e.target.value); setExportError(''); setExportStatus('idle'); }}
                    placeholder={t('settings.data.enterYourPassword')}
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-input-surface text-t-primary"
                    style={{ border: '1px solid var(--border-color)' }}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleRequestExport(); }}
                    autoComplete="one-time-code"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleRequestExport}
                  disabled={exportStatus === 'loading' || !exportPassword}
                  className="px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 shrink-0"
                  style={{
                    backgroundColor: exportStatus === 'loading' ? 'var(--bg-floating)' : 'var(--accent-primary)',
                    color: '#fff',
                    opacity: !exportPassword ? 0.5 : 1,
                  }}
                >
                  {exportStatus === 'loading' ? (
                    <><RefreshCw size={14} className="animate-spin" /> {t('settings.data.requesting')}</>
                  ) : (
                    <><Send size={14} /> {t('settings.data.requestExport')}</>
                  )}
                </button>
              </div>
              )}

              {exportStatus === 'success' && (
                <div className="flex items-center gap-2 text-xs font-medium" style={{ color: '#22c55e' }}>
                  <CheckCircle2 size={14} /> {t('settings.data.exportSubmitted')}
                </div>
              )}
              {exportError && (
                <div className="flex items-center gap-2 text-xs font-medium" style={{ color: 'var(--danger)' }}>
                  <AlertCircle size={14} /> {exportError}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Cookie Preferences */}
      <div className="rounded-2xl overflow-hidden bg-panel">
        <div className="px-6 py-5 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-3">
            <Shield size={18} className="text-t-primary" />
            <div>
              <h3 className="text-sm font-semibold text-t-primary">{t('settings.data.cookiePreferences')}</h3>
              <p className="text-xs mt-0.5 text-t-secondary">
                {t('settings.data.cookiePreferencesDesc')}
              </p>
            </div>
          </div>
        </div>
        <div className="p-6 space-y-3">
          <label id="setting-cookie-essential" className="flex items-center gap-3 cursor-default">
            <input type="checkbox" checked disabled className="w-3.5 h-3.5 rounded-lg accent-[var(--cyan-accent)] cursor-not-allowed opacity-60" />
            <div>
              <span className="text-xs font-semibold text-t-primary">{t('settings.data.essentialCookies')}</span>
              <p className="text-[10px] text-t-secondary">{t('settings.data.essentialCookiesDesc')}</p>
            </div>
          </label>
          <label id="setting-cookie-error-reporting" className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={getStoredConsent()?.analytics ?? false}
              onChange={(e) => {
                const consent = getStoredConsent();
                storeCookieConsent(e.target.checked, consent?.advertising ?? false);
                if (!e.target.checked) window.location.reload();
              }}
              className="w-3.5 h-3.5 rounded-lg border-2 border-slate-600 bg-transparent checked:bg-[var(--cyan-accent)] checked:border-[var(--cyan-accent)] accent-[var(--cyan-accent)] cursor-pointer"
            />
            <div>
              <span className="text-xs font-semibold text-t-primary">{t('settings.data.errorReporting')}</span>
              <p className="text-[10px] text-t-secondary">{t('settings.data.errorReportingDesc')}</p>
            </div>
          </label>

        </div>
      </div>

      {/* CCPA: Do Not Sell or Share */}
      <div className="rounded-2xl overflow-hidden bg-panel">
        <div className="px-6 py-5">
          <div className="flex items-center gap-3">
            <Shield size={18} className="text-t-primary" />
            <div>
              <h3 className="text-sm font-semibold text-t-primary">{t('settings.data.doNotSell')}</h3>
              <p className="text-xs mt-0.5 text-t-secondary">
                {t('settings.data.doNotSellDesc')}
              </p>
            </div>
          </div>
        </div>
        <div className="p-6 pt-0">
          <div className="flex items-start gap-3 p-4 rounded-xl" style={{ backgroundColor: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)' }}>
            <CheckCircle2 size={16} className="shrink-0 mt-0.5" style={{ color: '#22c55e' }} />
            <p className="text-xs leading-relaxed text-t-secondary">
              {t('settings.data.doNotSellStatement')}
            </p>
          </div>
          <p className="text-xs mt-4 text-t-secondary">
            <a href="/privacy-policy#ccpa" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)' }}>{t('settings.data.privacyPolicy')}</a>
          </p>
        </div>
      </div>

      {/* Local Data Cache */}
      <div id="setting-clear-local-cache" className="rounded-2xl overflow-hidden bg-panel">
        <div className="px-6 py-5 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-3">
            <Shield size={18} className="text-t-primary" />
            <div>
              <h3 className="text-sm font-semibold text-t-primary">{t('settings.data.localDataCache')}</h3>
              <p className="text-xs mt-0.5 text-t-secondary">
                {t('settings.data.localDataCacheDesc')}
              </p>
            </div>
          </div>
        </div>
        <div className="p-6">
          <button
            type="button"
            disabled={cacheClearLoading}
            onClick={() => setConfirmClearCache(true)}
            className="btn-cta-danger px-4 py-2 rounded-xl text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cacheClearLoading ? t('settings.data.clearing') : t('settings.data.clearLocalMessageCache')}
          </button>
          <p className="text-[10px] mt-2 text-t-secondary">
            {t('settings.data.clearCacheDesc')}
          </p>
        </div>
      </div>

      {/* Data Retention Info */}
      <div className="rounded-2xl overflow-hidden bg-panel">
        <div className="px-6 py-5 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-3">
            <Shield size={18} className="text-t-primary" />
            <h3 className="text-sm font-semibold text-t-primary">{t('settings.data.whatWeStore')}</h3>
          </div>
        </div>
        <div className="p-6">
          <p className="text-xs mb-4 leading-relaxed text-t-secondary">
            {t('settings.data.whatWeStoreIntro')}
          </p>
          <ul className="space-y-2 text-xs text-t-secondary">
            <li className="flex items-start gap-2"><span className="shrink-0 mt-0.5" style={{ color: 'var(--accent-primary)' }}>•</span>{t('settings.data.storeProfileInfo')}</li>
            <li className="flex items-start gap-2"><span className="shrink-0 mt-0.5" style={{ color: 'var(--accent-primary)' }}>•</span>{t('settings.data.storeEmail')}</li>
            <li className="flex items-start gap-2"><span className="shrink-0 mt-0.5" style={{ color: 'var(--accent-primary)' }}>•</span>{t('settings.data.storeDateOfBirth')}</li>
            <li className="flex items-start gap-2"><span className="shrink-0 mt-0.5" style={{ color: 'var(--accent-primary)' }}>•</span>{t('settings.data.storeMessages')}</li>
            <li className="flex items-start gap-2"><span className="shrink-0 mt-0.5" style={{ color: 'var(--accent-primary)' }}>•</span>{t('settings.data.storeMemberships')}</li>
            <li className="flex items-start gap-2"><span className="shrink-0 mt-0.5" style={{ color: 'var(--accent-primary)' }}>•</span>{t('settings.data.storeSessions')}</li>
            <li className="flex items-start gap-2"><span className="shrink-0 mt-0.5" style={{ color: 'var(--accent-primary)' }}>•</span>{t('settings.data.storePasswords')}</li>
            <li className="flex items-start gap-2"><span className="shrink-0 mt-0.5" style={{ color: 'var(--accent-primary)' }}>•</span>{t('settings.data.storeBilling')}</li>
          </ul>
          <p className="text-xs mt-4 text-t-secondary">
            {t('settings.data.deleteAccountHint')}
          </p>
          <p className="text-xs mt-4 text-t-secondary">
            {t('settings.data.contactSupport')}
          </p>
        </div>
      </div>

      <p className="text-xs text-center text-t-secondary">
        <a id="setting-privacy-policy-link" href="/privacy-policy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)' }}>{t('settings.data.privacyPolicy')}</a>
        {' · '}
        <a id="setting-contact-data-protection" href="mailto:support@howlpro.com" style={{ color: 'var(--accent-primary)' }}>{t('settings.data.contactDataProtection')}</a>
      </p>
      {confirmClearCache && (
        <ConfirmDialog
          title={t('settings.data.clearCacheTitle')}
          desc={t('settings.data.clearCacheConfirmDesc')}
          confirmLabel={t('settings.data.clearCache')}
          danger
          onConfirm={async () => {
            setConfirmClearCache(false);
            setCacheClearLoading(true);
            try {
              const dbs = await indexedDB.databases?.() || [];
              for (const db of dbs) {
                if (db.name && (db.name.startsWith('howl-dm-cache-') || db.name.startsWith('howl-dm-search-'))) {
                  indexedDB.deleteDatabase(db.name);
                }
              }
            } catch {
              const userId = _user?.id;
              if (userId) {
                try { indexedDB.deleteDatabase(`howl-dm-cache-${userId}`); } catch { /* ignore */ }
                try { indexedDB.deleteDatabase(`howl-dm-search-${userId}`); } catch { /* ignore */ }
              }
            }
            window.location.reload();
          }}
          onCancel={() => setConfirmClearCache(false)}
        />
      )}
    </div>
  );
};

export default DataControlsTab;
