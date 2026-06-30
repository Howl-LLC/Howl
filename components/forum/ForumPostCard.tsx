// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Pin, Lock } from 'lucide-react';
import type { ForumPost } from '../../types';
import { apiClient } from '../../services/api';
import { RoleNameStyle } from '../RoleNameStyle';
import { getAvatarEffectClass } from '../../shared/planPerks';
import { relativeTime } from '../../utils/relativeTime';
import { useNotificationStore } from '../../stores/notificationStore';

/* -- Props ------------------------------------------------- */

interface ForumPostCardProps {
  post: ForumPost;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

/* -- Helpers ----------------------------------------------- */

/** Dark gradient fallback derived from first tag color (or cyan default). */
function heroGradient(hex?: string): string {
  const base = hex || '#076FA0';
  return `linear-gradient(135deg, ${base}15 0%, ${base}08 50%, ${base}10 100%)`;
}

/** Convert hex to rgba for tag pill backgrounds. */
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return `rgba(7, 111, 160, ${alpha})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* -- Component -------------------------------------------- */

export function ForumPostCard({ post, onClick, onContextMenu }: ForumPostCardProps) {
  const { t } = useTranslation();
  const [heroImgError, setHeroImgError] = useState(false);
  const hasUnread = useNotificationStore(s => s.forumPostUnreadIds.has(post.id));

  const firstTagColor = post.tags?.[0]?.color;

  const authorInitial = useMemo(
    () => (post.author?.username?.[0] ?? '?').toUpperCase(),
    [post.author?.username],
  );

  const resolvedHeroUrl = useMemo(
    () => (post.imageUrl ? apiClient.resolveAssetUrl(post.imageUrl) : undefined),
    [post.imageUrl],
  );

  const resolvedAvatarUrl = useMemo(
    () => (post.author?.avatar ? apiClient.resolveAssetUrl(post.author.avatar) : undefined),
    [post.author?.avatar],
  );

  const isPro = post.author?.stripePlan === 'pro';
  const avatarEffectCls = getAvatarEffectClass(post.author?.avatarEffect);

  /* -- Hero banner ----------------------------------------- */

  const showHeroImage = !!resolvedHeroUrl && !heroImgError;

  const heroBanner = (
    <div className="relative h-[100px] w-full overflow-hidden rounded-t-lg">
      {showHeroImage ? (
        <img
          src={resolvedHeroUrl}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setHeroImgError(true)}
          loading="lazy"
        />
      ) : (
        <div
          className="h-full w-full"
          style={{ background: heroGradient(firstTagColor) }}
        />
      )}

      {/* Bottom gradient overlay for text legibility */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2"
        style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%)' }}
      />

      {/* Pinned badge overlaid top-right */}
      {post.pinned && (
        <span
          className="absolute top-2 right-2.5 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-amber-400"
          style={{ background: 'rgba(0,0,0,0.5)' }}
        >
          <Pin size={10} />
          {t('forum.pinned', 'Pinned')}
        </span>
      )}

      {/* Unread-replies indicator overlaid top-left */}
      {hasUnread && (
        <span
          className="absolute top-2 left-2 w-2 h-2 rounded-full bg-[var(--cyan-accent)]"
          style={{ boxShadow: '0 0 6px var(--accent-glow)' }}
          aria-label={t('forum.unreadReplies', 'New replies')}
          title={t('forum.unreadReplies', 'New replies')}
        />
      )}
    </div>
  );

  /* -- Tag pills ------------------------------------------ */

  const tagPills = post.tags?.map((tag) => (
    <span
      key={tag.id}
      className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] leading-tight whitespace-nowrap"
      style={{
        backgroundColor: hexToRgba(tag.color, 0.15),
        color: tag.color,
      }}
    >
      {tag.emoji && <span className="text-[10px]">{tag.emoji}</span>}
      {tag.name}
    </span>
  ));

  /* -- Author avatar -------------------------------------- */

  const authorAvatar = resolvedAvatarUrl ? (
    <img
      src={resolvedAvatarUrl}
      alt=""
      className={`h-4 w-4 shrink-0 rounded-[var(--radius-lg)] object-cover ${avatarEffectCls}`}
    />
  ) : (
    <div
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--radius-lg)] text-[8px] font-semibold text-[var(--text-on-accent)] ${avatarEffectCls}`}
      style={{ background: `var(--cyan-accent, #076FA0)` }}
    >
      {authorInitial}
    </div>
  );

  /* -- Meta row ------------------------------------------- */

  const metaRow = (
    <div className="flex items-center gap-1.5 text-[11px]">
      {authorAvatar}

      <RoleNameStyle
        name={post.author?.username ?? t('forum.unknown', 'Unknown')}
        overrideColor={post.author?.nameColor}
        overrideFont={isPro ? post.author?.nameFont : null}
        nameEffect={isPro ? post.author?.nameEffect : null}
        className="max-w-[120px] truncate text-[11px]"
      />

      <span className="text-t-tertiary">&middot;</span>

      <span className="flex shrink-0 items-center gap-0.5 text-t-secondary">
        <MessageSquare size={11} />
        {post.messageCount}
      </span>

      <span className="text-t-tertiary">&middot;</span>

      <span className="shrink-0 text-t-tertiary">
        {relativeTime(post.lastActivityAt || post.createdAt)}
      </span>
    </div>
  );

  /* -- Card ----------------------------------------------- */

  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="relative w-full cursor-pointer overflow-hidden text-left transition-all duration-150"
      style={{
        background: 'var(--fill-hover)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '12px',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--fill-active)';
        e.currentTarget.style.borderColor = 'var(--glass-border)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--fill-hover)';
        e.currentTarget.style.borderColor = 'var(--border-subtle)';
      }}
    >
      {/* Locked overlay */}
      {post.locked && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/30">
          <Lock size={20} className="text-t-secondary" />
        </div>
      )}

      {/* Hero banner */}
      {heroBanner}

      {/* Card body */}
      <div className="flex flex-col gap-1.5 px-3 pt-2.5 pb-3">
        {/* Tag pills */}
        {tagPills && tagPills.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">{tagPills}</div>
        )}

        {/* Title */}
        <span className="truncate text-sm font-medium text-t-primary">
          {post.title}
        </span>

        {/* Content preview */}
        <p className="line-clamp-2 text-xs text-t-secondary">
          {post.content || '\u00A0'}
        </p>

        {/* Meta */}
        {metaRow}
      </div>
    </button>
  );
}
