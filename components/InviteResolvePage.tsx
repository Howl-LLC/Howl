// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { X, Monitor } from 'lucide-react';
import { apiClient, type InvitePreview } from '../services/api';
import { getBackendOrigin, isElectron } from '../config';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';
import { LetterAvatar } from './LetterAvatar';
import { ApplyToJoinModal } from './community/ApplyToJoinModal';
import type { JoinByInviteResult } from '../utils/serverActions';
import type { ApplicationQuestion } from '../services/api/community';

const resolveUrl = (url: string | null): string | null =>
  url ? (url.startsWith('/') ? getBackendOrigin() + url : url) : null;

interface InviteResolvePageProps {
  servers: Array<{ id: string; channels: Array<{ id: string }> }>;
  onJoin: (code: string) => Promise<JoinByInviteResult>;
  onViewServer: (serverId: string) => void;
  isLoggedIn: boolean;
  /** Invite code override — used when rendered outside a <Route> (e.g. authenticated gate). Falls back to useParams. */
  inviteCode?: string;
}

export const InviteResolvePage: React.FC<InviteResolvePageProps> = ({ servers, onJoin, onViewServer, isLoggedIn, inviteCode }) => {
  const { code: routeCode } = useParams<{ code: string }>();
  const code = inviteCode || routeCode;
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [application, setApplication] = useState<{
    serverId: string;
    serverName: string;
    questions: ApplicationQuestion[];
    existingStatus: 'pending' | null;
  } | null>(null);

  useEffect(() => {
    if (!code) { setError(true); setLoading(false); return; }
    let cancelled = false;
    apiClient.resolveInvite(code).then((data) => {
      if (!cancelled) { setPreview(data); setLoading(false); }
    }).catch(() => {
      if (!cancelled) { setError(true); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [code]);

  const inElectron = isElectron();
  const isMember = preview ? servers.some((s) => s.id === preview.serverId) : false;

  // Opens the invite inside the installed Electron app via the howl://
  // protocol handler. Uses a programmatic anchor click so the user-gesture
  // context is preserved (modern Chromium blocks protocol launches from
  // script-initiated navigations without one). Mirrors the SSO callback
  // pattern in PasskeyLoginPage.
  const openInDesktop = () => {
    if (!code) return;
    const url = `howl://invite/${encodeURIComponent(code)}`;
    try {
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener noreferrer';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      window.location.href = url;
    }
  };

  const bannerSrc = preview ? sanitizeImgSrc(resolveUrl(preview.serverBanner)) : null;
  const iconSrc = preview ? sanitizeImgSrc(resolveUrl(preview.serverIcon)) : null;

  const handleJoin = async () => {
    if (!code) return;
    setJoining(true);
    setJoinError(null);
    try {
      const result = await onJoin(code);
      if (result.kind === 'application_required') {
        setApplication({
          serverId: result.serverId,
          serverName: result.serverName,
          questions: result.questions,
          existingStatus: result.existingApplication?.status ?? null,
        });
        setJoining(false);
      }
      // 'joined' path: onJoin already navigated; nothing more to do.
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Failed to join server');
      setJoining(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-6" style={{ backgroundColor: 'var(--bg-app)' }}>
      {loading && (
        <div className="animate-pulse rounded-2xl" style={{ width: 400, height: 300, background: 'var(--fill-hover)' }} />
      )}
      {error && (
        <div className="text-center">
          <p className="text-lg font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
            {t('sidebar.invalidOrExpiredInvite', 'Invalid or expired invite.')}
          </p>
          <button type="button" onClick={() => navigate(isLoggedIn ? '/home' : '/')} className="text-sm text-[var(--cyan-accent)] hover:underline">
            {t('common.goHome', 'Go Home')}
          </button>
        </div>
      )}
      {preview && (
        <div className="relative border border-[var(--border-subtle)] rounded-2xl overflow-hidden" style={{ width: 400, background: 'var(--fill-hover)' }}>
          {/* Close button */}
          <button
            type="button"
            onClick={() => navigate(isLoggedIn ? '/home' : '/')}
            className="absolute top-2 right-2 z-20 p-1.5 rounded-lg bg-black/40 hover:bg-black/60 text-white/60 hover:text-white/90 transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
          {/* Banner */}
          <div className="h-[100px] relative overflow-hidden">
            {bannerSrc ? (
              <LazyGif src={bannerSrc} frameSrc={getFrameUrl(bannerSrc)} alt="" className="w-full h-full object-cover" style={{ objectPosition: `center ${preview.serverBannerPositionY}%` }} draggable={false} />
            ) : (
              <div className="w-full h-full" style={{ background: 'linear-gradient(135deg, var(--accent-muted), rgba(15,23,42,0.9))' }} />
            )}
          </div>

          {/* Content */}
          <div className="px-5 pb-5">
            <div className="flex items-center gap-3">
              <div className="relative z-10 -mt-7 shrink-0" style={{ width: 56, height: 56, borderRadius: 12, border: '3px solid rgba(15,23,42,0.9)', overflow: 'hidden' }}>
                {iconSrc ? (
                  <LazyGif src={iconSrc} frameSrc={getFrameUrl(iconSrc)} alt={preview.serverName} className="w-full h-full object-cover" draggable={false} />
                ) : (
                  <LetterAvatar avatar={null} username={preview.serverName} size={50} className="rounded-xl" />
                )}
              </div>
              <span className="text-base font-bold truncate" style={{ color: 'var(--text-primary)' }}>{preview.serverName}</span>
            </div>

            {preview.description && (
              <p className="text-xs mt-2 line-clamp-3" style={{ color: 'var(--text-tertiary)' }}>{preview.description}</p>
            )}

            <div className="flex gap-4 text-xs mt-3" style={{ color: 'var(--text-secondary)' }}>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                {preview.onlineCount.toLocaleString()} Online
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-gray-500" />
                {preview.memberCount.toLocaleString()} Members
              </span>
            </div>

            {joinError && <p className="text-xs text-red-400 mt-3">{joinError}</p>}

            <div className="mt-4 space-y-2">
              {!isLoggedIn ? (
                <button type="button" onClick={() => { try { sessionStorage.setItem('howl_returnTo', `/invite/${code}`); } catch { /* ignore */ } navigate('/login'); }}
                  className="btn-cta w-full py-2.5 text-sm rounded-xl">
                  {t('sidebar.joinServer', 'Join Server')}
                </button>
              ) : isMember ? (
                <button type="button" onClick={() => onViewServer(preview.serverId)}
                  className="btn-cta w-full py-2.5 text-sm rounded-xl">
                  {t('sidebar.openServer', 'Open server')}
                </button>
              ) : (
                <button type="button" onClick={handleJoin} disabled={joining}
                  className="btn-cta w-full py-2.5 text-sm rounded-xl">
                  {joining ? t('common.loading', 'Joining...') : t('sidebar.joinServer', 'Join Server')}
                </button>
              )}

              {/* When NOT in Electron, offer to hand off to the installed
                  desktop app via the howl:// protocol. Browser will prompt
                  "Open Howl?" if the handler is registered; if not, nothing
                  happens and the user stays on the web invite page. */}
              {!inElectron && (
                <button type="button" onClick={openInDesktop}
                  className="w-full py-2 text-xs font-medium rounded-xl border border-[var(--border-subtle)] flex items-center justify-center gap-2 transition-colors hover:bg-[var(--fill-hover)]"
                  style={{ color: 'var(--text-secondary)' }}>
                  <Monitor size={13} />
                  {t('sidebar.openInDesktop', 'Open in Howl Desktop')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {application && (
        <ApplyToJoinModal
          serverId={application.serverId}
          serverName={application.serverName}
          serverIcon={iconSrc}
          questions={application.questions}
          description={preview?.description ?? null}
          existingStatus={application.existingStatus}
          onClose={() => setApplication(null)}
        />
      )}
    </div>
  );
};
