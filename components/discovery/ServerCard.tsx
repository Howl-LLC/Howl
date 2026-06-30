// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Users, Globe as GlobeIcon, ShieldCheck, Sparkles, EyeOff } from 'lucide-react';
import type { ServerCardSummary } from '../../services/api';
import { sanitizeImgSrc } from '../../utils/sanitizeImgSrc';
import { LetterAvatar } from '../LetterAvatar';
import { formatCount } from './formatCount';

interface ServerCardProps {
  server: ServerCardSummary;
}

export const ServerCard: React.FC<ServerCardProps> = ({ server }) => {
  const { t } = useTranslation();
  const target = `/s/${encodeURIComponent(server.vanityUrl || server.slug || server.id)}`;
  const visibleTags = (server.tags ?? []).slice(0, 3);
  const isBlurred = !!server.blurred;

  const bannerSrc = sanitizeImgSrc(server.bannerSplash || server.banner) ?? null;
  const iconSrc = sanitizeImgSrc(server.icon) ?? null;
  const bannerIsHex = !!server.banner && server.banner.startsWith('#');

  return (
    <Link
      to={target}
      className="group block rounded-2xl overflow-hidden border border-[var(--border-subtle)] bg-[var(--fill-hover)] transition-transform duration-150 hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cyan-accent)]"
      aria-label={t('discover.cardAria', '{{name}} — view server details', { name: server.name })}
    >
      {/* Banner */}
      <div className="relative h-24 w-full overflow-hidden">
        {bannerSrc ? (
          <img
            src={bannerSrc}
            alt=""
            className={`w-full h-full object-cover transition-[filter] ${isBlurred ? 'blur-md scale-110' : ''}`}
            draggable={false}
            loading="lazy"
          />
        ) : bannerIsHex ? (
          <div className="w-full h-full" style={{ background: server.banner ?? undefined }} />
        ) : (
          <div className="w-full h-full" style={{ background: 'linear-gradient(135deg, var(--accent-muted), rgba(15,23,42,0.9))' }} />
        )}

        {/* Badges (top-left) */}
        <div className="absolute top-2 left-2 flex gap-1">
          {server.featured && (
            <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold flex items-center gap-1 bg-amber-500/90 text-black">
              <Sparkles size={10} />
              {t('discover.badge.featured', 'Featured')}
            </span>
          )}
          {server.verified && (
            <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold flex items-center gap-1 bg-sky-500/90 text-white">
              <ShieldCheck size={10} />
              {t('discover.badge.verified', 'Verified')}
            </span>
          )}
        </div>

        {/* NSFW indicator (top-right) */}
        {server.mature && (
          <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded-md text-[10px] font-semibold flex items-center gap-1 bg-rose-600/90 text-white">
            <EyeOff size={10} />
            {t('discover.badge.mature', '18+')}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="px-4 pt-3 pb-4">
        <div className="flex items-center gap-3">
          <div
            className="relative -mt-7 shrink-0 overflow-hidden rounded-xl border-[3px] border-[var(--bg-app)]"
            style={{ width: 48, height: 48 }}
          >
            {iconSrc ? (
              <img src={iconSrc} alt="" className="w-full h-full object-cover" draggable={false} loading="lazy" />
            ) : (
              <LetterAvatar avatar={null} username={server.name} size={42} className="rounded-lg" />
            )}
          </div>
          <h3 className="font-semibold text-sm truncate flex-1" style={{ color: 'var(--text-primary)' }} title={server.name}>
            {server.name}
          </h3>
        </div>

        {server.description && (
          <p className="mt-2 text-xs leading-snug line-clamp-2" style={{ color: 'var(--text-tertiary)' }}>
            {server.description}
          </p>
        )}

        <div className="mt-3 flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            {formatCount(server.onlineCount)} {t('discover.online', 'online')}
          </span>
          <span className="flex items-center gap-1.5">
            <Users size={11} />
            {formatCount(server.memberCount)}
          </span>
          {server.language && (
            <span className="flex items-center gap-1.5 ml-auto uppercase tracking-wide">
              <GlobeIcon size={11} />
              {server.language}
            </span>
          )}
        </div>

        {visibleTags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {visibleTags.map((tag) => (
              <span
                key={tag}
                className="px-2 py-0.5 rounded-full text-[10px] border border-[var(--border-subtle)]"
                style={{ color: 'var(--text-secondary)' }}
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
};

export default ServerCard;
