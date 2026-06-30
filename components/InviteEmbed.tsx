// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiClient, type InvitePreview } from '../services/api';
import { getBackendOrigin } from '../config';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';
import { ServerIcon } from './ServerIcon';
import type { Server } from '../types';

interface InviteEmbedProps {
  code: string;
  servers: Server[];
  onJoinServer?: (code: string) => void;
  onViewServer?: (serverId: string) => void;
}

const resolveUrl = (url: string | null): string | null =>
  url ? (url.startsWith('/') ? getBackendOrigin() + url : url) : null;

const InviteEmbed: React.FC<InviteEmbedProps> = ({ code, servers, onJoinServer, onViewServer }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    apiClient.resolveInvite(code).then((data) => {
      if (!cancelled) {
        setPreview(data);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setError(true);
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [code]);

  if (loading) {
    return (
      <div
        className="animate-pulse bg-fill-hover rounded-2xl h-[180px]"
        style={{ maxWidth: 360 }}
      />
    );
  }

  if (error || !preview) {
    return (
      <span className="inline-block bg-fill-hover text-t-secondary text-xs px-3 py-2 rounded-xl">
        {t('sidebar.invalidOrExpiredInvite', 'Invite expired or invalid')}
      </span>
    );
  }

  const isMember = servers.some((s) => s.id === preview.serverId);
  const isApplyToJoin = preview.joinMethod === 'apply_to_join';
  const bannerSrc = sanitizeImgSrc(resolveUrl(preview.serverBanner));
  const iconSrc = resolveUrl(preview.serverIcon);

  return (
    <div
      className="border border-[var(--glass-border)] rounded-2xl overflow-hidden"
      style={{ maxWidth: 360, background: 'var(--fill-hover)' }}
    >
      {/* Banner */}
      <div className="h-[80px] relative overflow-hidden">
        {bannerSrc ? (
          <LazyGif
            src={bannerSrc}
            frameSrc={getFrameUrl(bannerSrc)}
            alt=""
            className="w-full h-full object-cover"
            style={{ objectPosition: `center ${preview.serverBannerPositionY}%` }}
          />
        ) : (
          <div
            className="w-full h-full"
            style={{ background: 'linear-gradient(135deg, var(--accent-subtle), rgba(15,23,42,0.9))' }}
          />
        )}
      </div>

      {/* Content */}
      <div className="px-3 pb-3">
        {/* Icon + Name + Joined badge */}
        <div className="flex items-center gap-2.5">
          <div
            className="relative z-10 -mt-6 flex-shrink-0"
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              border: '3px solid rgba(15,15,26,0.95)',
              overflow: 'hidden',
            }}
          >
            <ServerIcon icon={iconSrc} name={preview.serverName} size={42} className="rounded-xl" />
          </div>

          <span
            className="text-sm font-semibold truncate"
            style={{ color: 'var(--text-primary)' }}
          >
            {preview.serverName}
          </span>

          {isMember && (
            <span className="flex items-center gap-1 text-[9px] font-bold text-[var(--cyan-accent)] bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/20 px-1.5 py-0.5 rounded-md uppercase tracking-wide shrink-0">
              ✓ {t('serverSettings.joined', 'Joined')}
            </span>
          )}
        </div>

        {/* Description */}
        {preview.description && (
          <p
            className="text-[11px] line-clamp-2 mt-0.5"
            style={{ color: 'var(--text-secondary)' }}
          >
            {preview.description}
          </p>
        )}

        {/* Counts */}
        <div
          className="flex gap-3 text-[11px] mt-2"
          style={{ color: 'var(--text-secondary)' }}
        >
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />
            {preview.onlineCount.toLocaleString()} {t('serverSettings.online', 'Online')}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-gray-500 flex-shrink-0" />
            {t('serverSettings.members', { count: preview.memberCount, defaultValue: '{{count}} members' })}
          </span>
        </div>

        {/* Actions — full width */}
        <div className="mt-2.5">
          {isMember ? (
            <button
              type="button"
              className="w-full bg-fill-hover hover:bg-fill-active border border-[var(--fill-active)] text-t-secondary text-xs font-semibold rounded-lg px-4 py-2 transition-colors uppercase tracking-wide"
              onClick={() => onViewServer?.(preview.serverId)}
            >
              {t('inviteEmbed.viewServer', 'View Server')}
            </button>
          ) : (
            <button
              type="button"
              className="btn-cta w-full text-xs font-semibold rounded-xl px-4 py-2 transition-[filter]"
              onMouseEnter={(e) => { (e.currentTarget.style.filter = 'brightness(1.1)'); }}
              onMouseLeave={(e) => { (e.currentTarget.style.filter = ''); }}
              onClick={() => {
                // Apply-to-join servers route through the dedicated invite
                // page so the application modal can render the questions.
                // The inline join handler returns void without a modal hook,
                // which would otherwise leave the click as a silent no-op.
                if (isApplyToJoin) {
                  navigate(`/invite/${encodeURIComponent(code)}`);
                } else {
                  onJoinServer?.(code);
                }
              }}
            >
              {isApplyToJoin
                ? t('inviteEmbed.applyToJoin', 'Apply to Join')
                : t('sidebar.joinServer', 'Join Server')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default React.memo(InviteEmbed);
