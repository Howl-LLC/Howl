// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Smartphone, Monitor, X, ShieldCheck } from 'lucide-react';
import { apiClient, type SessionInfo } from '../../services/api';
import type { TrustedDeviceInfo } from '../../services/apiTypes';
import { SettingsSection, ConfirmDialog } from './SettingsWidgets';

export interface SessionsTabProps {}

export const SessionsTab: React.FC<SessionsTabProps> = () => {
  const { t } = useTranslation();

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [trustedDevices, setTrustedDevices] = useState<TrustedDeviceInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);

  useEffect(() => {
    setSessionsLoading(true);
    setSessionsError(null);
    // Fetch sessions + trusted devices in parallel. Both feed the same UI
    // (sessions are the primary rows; trust is shown as a badge on any
    // session whose trustedDeviceId maps to a row here).
    Promise.all([
      apiClient.getSessions(),
      apiClient.listTrustedDevices().catch(() => [] as TrustedDeviceInfo[]),
    ])
      .then(([s, td]) => { setSessions(s); setTrustedDevices(td); })
      .catch(() => setSessionsError(t('settings.sessions.loadError')))
      .finally(() => setSessionsLoading(false));
  }, []);

  // Map of sessionId → trustedDeviceId so we can render the trust badge.
  // A trust row without any active session still gets its own list entry.
  const sessionIdToTrustId = new Map<string, string>();
  for (const td of trustedDevices) {
    for (const s of td.activeSessions) sessionIdToTrustId.set(s.id, td.id);
  }

  const handleRevokeSession = useCallback(async (sessionId: string) => {
    if (revoking) return;
    setRevoking(sessionId);
    try {
      await apiClient.revokeSession(sessionId);
      setSessions((s) => s.filter((x) => x.id !== sessionId));
      // If this session was the only thing keeping a trust row alive in
      // the UI, drop the trust row too (the SetNull cascade leaves the
      // trust row on the server, but the user will re-associate it on
      // next login from that browser if they still have the cookie).
      const trustId = sessionIdToTrustId.get(sessionId);
      if (trustId) {
        setTrustedDevices((td) => td.map((d) => d.id === trustId
          ? { ...d, activeSessions: d.activeSessions.filter((s) => s.id !== sessionId) }
          : d));
      }
    } catch {
      console.error('Failed to revoke session');
    } finally {
      setRevoking(null);
    }
  }, [revoking, sessionIdToTrustId]);

  const handleRevokeTrustedDevice = useCallback(async (trustId: string) => {
    if (revoking) return;
    setRevoking(`trust:${trustId}`);
    try {
      await apiClient.revokeTrustedDevice(trustId);
      setTrustedDevices((td) => td.filter((d) => d.id !== trustId));
    } catch {
      console.error('Failed to revoke trusted device');
    } finally {
      setRevoking(null);
    }
  }, [revoking]);

  const handleRevokeAllSessions = useCallback(async () => {
    if (revoking) return;
    setRevoking('all');
    try {
      await apiClient.revokeAllOtherSessions();
      setSessions((s) => s.filter((x) => x.isCurrent));
    } catch {
      console.error('Failed to revoke all sessions');
    } finally {
      setRevoking(null);
    }
  }, [revoking]);

  const current = sessions.find((s) => s.isCurrent);
  const others = sessions.filter((s) => !s.isCurrent);
  const deviceIcon = (type: string) => type === 'mobile' ? <Smartphone size={20} className="text-slate-500" /> : <Monitor size={20} className="text-slate-500" />;
  const timeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return t('settings.sessions.justNow');
    if (diff < 3600000) return t('settings.sessions.minutesAgo', { count: Math.floor(diff / 60000) });
    if (diff < 86400000) return t('settings.sessions.hoursAgo', { count: Math.floor(diff / 3600000) });
    return t('settings.sessions.daysAgo', { count: Math.floor(diff / 86400000) });
  };

  /** Trust pill — uses Howl's --success token (green range the design
   *  system already owns) rather than arbitrary emerald-500 shades, so a
   *  future theme swap stays coherent. Compact, uppercase micro-pill to
   *  match the "text-[10px] font-bold uppercase tracking-wider" rhythm
   *  the rest of this page uses for labels. */
  const TrustedPill = () => (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-[9px] font-black uppercase tracking-[0.15em]"
      style={{ borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--success-muted)', color: 'var(--success)', background: 'var(--success-subtle)' }}
    >
      <ShieldCheck size={10} /> {t('settings.sessions.trusted', 'Trusted')}
    </span>
  );

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2 text-t-primary">{t('settings.sessions')}</h2>
      <p className="text-xs mb-4 text-t-secondary">{t('settings.sessions.description')}</p>
      <p className="text-xs mb-6 text-amber-400/90">{t('settings.sessions.warning')}</p>

      {sessionsError && (
        <div className="text-sm text-red-400 py-4 text-center">{sessionsError}</div>
      )}
      {sessionsLoading ? (
        <p className="text-sm py-8 text-center text-t-secondary">{t('settings.sessions.loading')}</p>
      ) : !sessionsError && (
        <>
          <SettingsSection title={t('settings.currentDevice')} className="mb-6">
            {current ? (
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl border border-[var(--glass-border)] flex items-center justify-center bg-input-surface">
                  {deviceIcon(current.deviceType)}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-bold uppercase tracking-wider text-t-primary">{current.deviceName}</p>
                    {sessionIdToTrustId.get(current.id) && <TrustedPill />}
                  </div>
                  <p className="text-[11px] mt-0.5 text-t-secondary">{current.ip ?? t('settings.sessions.unknownIp')} · {t('settings.sessions.activeNow')}</p>
                </div>
              </div>
            ) : (
              <p className="text-xs py-4 text-t-secondary">{t('settings.sessions.currentNotFound')}</p>
            )}
          </SettingsSection>

          <SettingsSection title={t('settings.otherDevices')} className="mb-6">
            {others.length === 0 ? (
              <p className="text-xs py-4 text-t-secondary">{t('settings.noOtherDevices')}</p>
            ) : (
              <ul id="setting-revoke-session" className="space-y-3">
                {others.map((d) => (
                  <li key={d.id} className="flex items-center justify-between py-3 px-4 rounded-xl border border-[var(--glass-border)] bg-input-surface">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl border border-[var(--glass-border)] flex items-center justify-center shrink-0 bg-panel">
                        {deviceIcon(d.deviceType)}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-bold uppercase tracking-wider text-t-primary">{d.deviceName}</p>
                          {sessionIdToTrustId.get(d.id) && <TrustedPill />}
                        </div>
                        <p className="text-[11px] mt-0.5 text-t-secondary">{d.ip ?? t('settings.sessions.unknownIp')} · {timeAgo(d.lastActiveAt)}</p>
                      </div>
                    </div>
                    <button type="button" onClick={() => handleRevokeSession(d.id)} disabled={revoking !== null} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" title={t('settings.logOutThisDevice')} aria-label={t('settings.logOutThisDevice')}><X size={14} /></button>
                  </li>
                ))}
              </ul>
            )}
          </SettingsSection>

          {/* Dormant trust — browsers with a valid howl_device_id cookie but
              no signed-in session (user signed out, but the cookie carries
              trust until the 90-day expiry). Rendered dimmer than live
              sessions to signal lower priority while still letting the user
              revoke trust on demand. */}
          {(() => {
            const sessionlessTrust = trustedDevices.filter((td) => td.activeSessions.length === 0);
            if (sessionlessTrust.length === 0) return null;
            return (
              <div id="setting-revoke-trusted-device" className="mb-6">
                <div className="flex items-center gap-2 px-1 mb-3">
                  <ShieldCheck size={12} style={{ color: 'var(--success)' }} />
                  <h3 className="text-[10px] font-black uppercase tracking-[0.15em] text-t-tertiary">
                    {t('settings.sessions.dormantTrust', 'Dormant trusted devices')}
                  </h3>
                  <span className="text-[10px] text-t-quaternary">· {t('settings.sessions.dormantTrustDesc', 'signed out but still trusted')}</span>
                </div>
                <ul className="space-y-2">
                  {sessionlessTrust.map((td) => (
                    <li
                      key={td.id}
                      className="flex items-center justify-between py-2.5 px-4 rounded-xl border border-[var(--glass-border)] bg-panel/50"
                      style={{ opacity: 0.85 }}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg border border-[var(--glass-border)] flex items-center justify-center shrink-0 bg-input-surface">
                          {deviceIcon(td.deviceType || 'web')}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-xs font-bold uppercase tracking-[0.1em] text-t-secondary">
                              {td.label || t('settings.sessions.unknownDevice', 'Unknown device')}
                            </p>
                            <TrustedPill />
                          </div>
                          <p className="text-[10px] mt-0.5 text-t-tertiary">
                            {t('settings.sessions.lastSeen', 'Last seen')} {timeAgo(td.lastSeenAt)}
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRevokeTrustedDevice(td.id)}
                        disabled={revoking !== null}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title={t('settings.sessions.revokeTrust', 'Revoke trust')}
                        aria-label={t('settings.sessions.revokeTrust', 'Revoke trust')}
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}

          <div id="setting-revoke-all-sessions" className="border border-[var(--glass-border)] rounded-2xl p-6 bg-panel">
            <h3 className="text-sm font-semibold mb-2 text-t-primary">{t('settings.revokeAllSessions')}</h3>
            <p className="text-xs mb-4 text-t-secondary">{t('settings.sessions.revokeAllDesc')}</p>
            <button type="button" onClick={() => setConfirmRevokeAll(true)} disabled={revoking !== null} className="btn-cta-danger text-[10px] font-semibold px-5 py-2.5 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed">{revoking === 'all' ? t('settings.sessions.revoking') : t('settings.revokeAllSessions')}</button>
          </div>
        </>
      )}
      {confirmRevokeAll && (
        <ConfirmDialog
          title={t('settings.sessions.revokeAllConfirmTitle')}
          desc={t('settings.sessions.revokeAllConfirmDesc')}
          confirmLabel={t('settings.sessions.revokeAllConfirmLabel')}
          danger
          onConfirm={() => { setConfirmRevokeAll(false); handleRevokeAllSessions(); }}
          onCancel={() => setConfirmRevokeAll(false)}
        />
      )}
    </div>
  );
};

export default SessionsTab;
