// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { User, GameActivity, MutualFriend, MutualServer, formatUsername } from '../types';
import { UserPlus, MoreVertical, Ban, UserX, Shield, ChevronRight, UserMinus, Gamepad2, Music, Headphones, Loader2, User as UserIcon } from 'lucide-react';
import { apiClient } from '../services/api';
import { formatActivityElapsed } from '../utils/activityUtils';
import { RoleNameStyle } from './RoleNameStyle';
import type { RoleStyle } from './RoleNameStyle';
import { getAvatarEffectClass } from '../shared/planPerks';
import { ProfileBadges } from './ProfileBadges';
import { useContextMenuPosition } from '../utils/contextMenuStyles';
import { sanitizeCssUrl } from '../utils/securityUtils';
import { useGifFrameUrl } from '../hooks/useGifFrameUrl';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { useUiStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';

export type UserWithRole = User & {
  role?: string;
  roleColor?: string | null;
  roleStyle?: RoleStyle;
  /** Every role assigned to this member in the active server. Sorted by
   *  hierarchy (lower `position` = higher rank, like Discord). The popup
   *  renders these as colored chips below the username. */
  roles?: Array<{ id?: string; name: string; color?: string | null; style?: string; position?: number; displaySeparately?: boolean; isEveryone?: boolean }>;
  nickname?: string | null;
  serverAvatar?: string | null;
  serverBanner?: string | null;
};

import { LetterAvatar } from './LetterAvatar';
import { STATUS_COLORS as statusColors } from '../shared/statusColors';

interface UserProfilePopupProps {
  /** Server owner can kick; cannot kick owner */
  canKick?: boolean;
  isTargetOwner?: boolean;
  onClose: () => void;
  onCreateDM: (userId: string) => void;
  /** When provided, sending from the message input will send this message and then open the DM (and close popup). */
  onSendMessageAndOpenDM?: (userId: string, content: string) => void;
  onInviteToServer?: () => void;
  onOpenModView?: (userId: string) => void;
  onKick?: (userId: string) => void;
  onBlock?: (userId: string) => void;
  /** When true, show Unblock instead of Block; requires onUnblock. */
  isBlocked?: boolean;
  onUnblock?: (userId: string) => void;
  onReport?: (userId: string) => void;
  onIgnore?: (userId: string) => void;
  /** Send a friend request for this user (called with full user for username#discriminator). */
  onAddFriend?: (user: UserWithRole) => void;
  /** Cancel an outgoing friend request (requestId from friendStatus.outgoingRequestId). */
  onCancelFriendRequest?: (requestId: string) => void;
  /** Remove this user from friends. */
  onRemoveFriend?: (userId: string) => void;
  /** Open the full two-column profile modal for this user. */
  onViewFullProfile?: (user: UserWithRole, initialTab?: 'showcase' | 'activity' | 'friends' | 'servers') => void;
}

export const UserProfilePopup: React.FC<UserProfilePopupProps> = React.memo(({
  canKick,
  isTargetOwner,
  onClose,
  onInviteToServer,
  onOpenModView,
  onKick,
  onBlock,
  isBlocked,
  onUnblock,
  onReport,
  onIgnore,
  onAddFriend,
  onCancelFriendRequest,
  onRemoveFriend,
  onViewFullProfile,
}) => {
  const target = useUiStore(s => s.userProfileTarget);
  const friendStatus = useUiStore(s => s.profileFriendStatus);
  const currentUserId = useAuthStore(s => s.currentUser)?.id ?? '';
  // target is guaranteed non-null by the parent's conditional render guard
  const user = target?.user as UserWithRole;
  const anchorRect = target?.anchorRect ?? null;
  const { t } = useTranslation();
  const bannerDisplayUrl = useGifFrameUrl(user?.serverBanner || user?.banner);
  const [moreOpen, setMoreOpen] = useState(false);
  const [listenAlongLoading, setListenAlongLoading] = useState(false);
  const [listenAlongMsg, setListenAlongMsg] = useState<string | null>(null);
  const [spotifyElapsed, setSpotifyElapsed] = useState('0:00');
  const [spotifyProgress, setSpotifyProgress] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  const isSelf = user.id === currentUserId;

  const handleListenAlong = useCallback(async () => {
    setListenAlongLoading(true);
    setListenAlongMsg(null);
    try {
      const result = await apiClient.listenAlong(user.id);
      if (result.ok) {
        setListenAlongMsg(t('spotify.listenAlong.started', { track: result.track, artist: result.artist, defaultValue: `Now playing ${result.track} by ${result.artist}` }));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('NO_ACTIVE_DEVICE')) {
        setListenAlongMsg(t('spotify.listenAlong.noDevice', { defaultValue: 'Open Spotify on a device to listen along' }));
      } else if (msg.includes('PREMIUM_REQUIRED')) {
        setListenAlongMsg(t('spotify.listenAlong.premiumRequired', { defaultValue: 'Spotify Premium is required for Listen Along' }));
      } else if (msg.includes('MISSING_SCOPE')) {
        setListenAlongMsg(t('spotify.listenAlong.reconnect', { defaultValue: 'Reconnect Spotify to enable Listen Along' }));
      } else {
        setListenAlongMsg(t('spotify.listenAlong.error', { defaultValue: "Couldn't start playback" }));
      }
    }
    setListenAlongLoading(false);
  }, [user.id, t]);

  const spotifyAct = useMemo(() => {
    if (user.activity?.type === 'spotify') return user.activity;
    if (user.secondaryActivity?.type === 'spotify') return user.secondaryActivity;
    return null;
  }, [user.activity, user.secondaryActivity]);

  useEffect(() => {
    if (!spotifyAct) {
      setSpotifyElapsed('0:00');
      setSpotifyProgress(0);
      return;
    }
    const updateProgress = () => {
      const started = new Date(spotifyAct.startedAt).getTime();
      const elapsedMs = Math.max(0, Date.now() - started);
      const elapsedSec = Math.floor(elapsedMs / 1000);
      const mins = Math.floor(elapsedSec / 60);
      const secs = elapsedSec % 60;
      setSpotifyElapsed(`${mins}:${secs.toString().padStart(2, '0')}`);
      const durationMs = spotifyAct.durationMs;
      if (durationMs && durationMs > 0) {
        setSpotifyProgress(Math.min(100, (elapsedMs / durationMs) * 100));
      } else {
        setSpotifyProgress(Math.min(100, (elapsedMs / 240000) * 100));
      }
    };
    updateProgress();
    const interval = setInterval(updateProgress, 1000);
    return () => clearInterval(interval);
  }, [spotifyAct?.startedAt, spotifyAct?.type, spotifyAct?.durationMs]);

  const spotifyDuration = useMemo(() => {
    const ms = spotifyAct?.durationMs;
    if (!ms || ms <= 0) return '';
    const totalSec = Math.floor(ms / 1000);
    return `${Math.floor(totalSec / 60)}:${(totalSec % 60).toString().padStart(2, '0')}`;
  }, [spotifyAct?.durationMs]);

  const showModActions = !!canKick && !isTargetOwner && !isSelf;

  const bottomSafeArea = useMemo(() => {
    const composer = document.querySelector('[data-chat-composer]') as HTMLElement | null;
    if (composer) {
      const rect = composer.getBoundingClientRect();
      return Math.max(0, window.innerHeight - rect.top + 8);
    }
    return 80;
  }, []);

  const { menuRef, style: posStyle } = useContextMenuPosition(
    anchorRect?.left ?? 0,
    anchorRect?.top ?? 0,
    380,
    500,
    bottomSafeArea,
  );

  const combinedRef = (el: HTMLDivElement | null) => {
    (cardRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    (menuRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
  };

  useEffect(() => {
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      const outsideCard = cardRef.current && !cardRef.current.contains(target);
      const outsideMore = !moreRef.current || !moreRef.current.contains(target);
      if (outsideCard && outsideMore) onClose();
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const close = () => setMoreOpen(false);
    if (moreOpen) document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [moreOpen]);

  // Mutual friends + servers — fetched lazily once per popup open.
  const [mutuals, setMutuals] = useState<{ friends: MutualFriend[]; servers: MutualServer[] } | null>(null);
  useEffect(() => {
    if (!user?.id || isSelf) { setMutuals(null); return; }
    let cancelled = false;
    apiClient.getUserMutuals(user.id)
      .then((res) => { if (!cancelled) setMutuals({ friends: res.mutualFriends, servers: res.mutualServers }); })
      .catch(() => { /* leave as null; section just won't render */ });
    return () => { cancelled = true; };
  }, [user?.id, isSelf]);

  if (!anchorRect) return null;

  // Portal to document.body so the popup escapes ancestor stacking contexts
  // (members column, chat area, anywhere it's invoked from). Without this,
  // `position: fixed` stacks within the nearest containing stacking context —
  // which means the message composer's own stacking layer could paint over
  // the popup even though our z-index is numerically higher.
  const portalTarget = typeof document !== 'undefined' ? document.body : null;
  const popup = (
    <div
      ref={combinedRef}
      role="dialog"
      aria-label="User profile"
      className="fixed z-[8000] w-[380px] max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-2xl border overflow-x-hidden spring-pop-in"
      style={{
        ...posStyle,
        // Match the floating status bar / DM panel frosted-glass treatment.
        // bg-chat alone is very translucent — the heavy backdrop-blur is what
        // makes content behind the popup read as a soft wash instead of a
        // legible image, so the username/badges/text-input row stays readable
        // even on top of a busy custom background.
        backgroundColor: 'var(--bg-chat)',
        backdropFilter: 'blur(24px) saturate(1.1)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
        borderColor: 'var(--border-subtle)',
        boxShadow: 'var(--shadow-xl)',
      }}
    >
      {/* Banner + actions */}
      <div
        className="h-[120px] relative flex items-start justify-end gap-1.5 pr-3 pt-2.5 bg-cover"
        style={
          user.banner && sanitizeCssUrl(bannerDisplayUrl)
            ? { backgroundImage: sanitizeCssUrl(bannerDisplayUrl), backgroundPosition: `center ${user.bannerPositionY ?? 50}%`, backgroundSize: (user.bannerZoom ?? 100) > 100 ? `${user.bannerZoom}%` : 'cover' }
            : { background: 'linear-gradient(135deg, color-mix(in srgb, var(--cyan-accent) 22%, transparent) 0%, color-mix(in srgb, var(--cyan-accent) 4%, transparent) 100%)' }
        }
      >
        {user.banner && <div className="absolute inset-0 bg-black/40" aria-hidden />}
        <div className="relative z-10 flex items-center gap-1.5">
        {onViewFullProfile && (
          <button type="button" onClick={() => onViewFullProfile(user)} className="p-1.5 rounded-lg hover:bg-black/10 text-white" title={t('profile.viewFullProfile')}>
            <UserIcon size={16} />
          </button>
        )}
        {!isSelf && (
          <>
            {isBlocked && onUnblock ? (
              <button type="button" onClick={() => { onUnblock(user.id); onClose(); }} className="p-1.5 rounded-lg hover:bg-black/10 text-white" title={t('common.unblock')}>
                <Ban size={16} />
              </button>
            ) : onBlock ? (
              <button type="button" onClick={() => { onBlock(user.id); onClose(); }} className="p-1.5 rounded-lg hover:bg-black/10 text-white" title={t('common.block')}>
                <Ban size={16} />
              </button>
            ) : null}
            {friendStatus?.status === 'friends' && onRemoveFriend && (
              <button type="button" onClick={() => onRemoveFriend(user.id)} className="p-1.5 rounded-lg hover:bg-black/10 text-white" title={t('profile.removeFriend')}>
                <UserMinus size={16} />
              </button>
            )}
            {friendStatus?.status === 'pending_outgoing' && onCancelFriendRequest && friendStatus.outgoingRequestId && (
              <button type="button" onClick={() => onCancelFriendRequest(friendStatus.outgoingRequestId!)} className="p-1.5 rounded-lg hover:bg-black/10 text-white" title={t('profile.cancelFriendRequest')}>
                <UserX size={16} />
              </button>
            )}
            {(friendStatus?.status === 'none' || !friendStatus) && onAddFriend && (
              <button type="button" onClick={() => onAddFriend(user)} className="p-1.5 rounded-lg hover:bg-black/10 text-white" title={t('profile.addFriend')}>
                <UserPlus size={16} />
              </button>
            )}
            <div className="relative" ref={moreRef}>
              <button type="button" onClick={(e) => { e.stopPropagation(); setMoreOpen((v) => !v); }} className="p-1.5 rounded-lg hover:bg-black/10 text-white">
                <MoreVertical size={16} />
              </button>
              {moreOpen && (
                <div
                  className="absolute right-0 top-full mt-1 py-1 min-w-[180px] rounded-xl border shadow-xl z-10"
                  style={{ backgroundColor: 'var(--bg-floating)', borderColor: 'var(--border-subtle)' }}
                >
                  <button type="button" onClick={() => { setMoreOpen(false); onViewFullProfile?.(user); }} className="w-full px-4 py-2 text-left text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{t('profile.viewFullProfile')}</button>
                  {friendStatus?.status === 'friends' && onRemoveFriend && <button type="button" onClick={() => { onRemoveFriend(user.id); setMoreOpen(false); }} className="w-full px-4 py-2 text-left text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{t('profile.removeFriend')}</button>}
                  {friendStatus?.status === 'pending_outgoing' && onCancelFriendRequest && friendStatus.outgoingRequestId && <button type="button" onClick={() => { onCancelFriendRequest(friendStatus.outgoingRequestId!); setMoreOpen(false); }} className="w-full px-4 py-2 text-left text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{t('profile.cancelFriendRequest')}</button>}
                  {(friendStatus?.status === 'none' || !friendStatus) && onAddFriend && <button type="button" onClick={() => { onAddFriend(user); setMoreOpen(false); }} className="w-full px-4 py-2 text-left text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{t('profile.addFriend')}</button>}
                  {onInviteToServer && <button type="button" onClick={() => { onInviteToServer(); setMoreOpen(false); }} className="w-full px-4 py-2 text-left text-[12px] font-medium flex items-center justify-between" style={{ color: 'var(--text-primary)' }}>{t('profile.inviteToServer')} <ChevronRight size={14} /></button>}
                  <div className="h-px my-1" style={{ backgroundColor: 'var(--border-subtle)' }} />
                  {onIgnore && <button type="button" onClick={() => { onIgnore(user.id); setMoreOpen(false); onClose(); }} className="w-full px-4 py-2 text-left text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{t('profile.ignore')}</button>}
                  {isBlocked && onUnblock ? <button type="button" onClick={() => { onUnblock(user.id); setMoreOpen(false); onClose(); }} className="w-full px-4 py-2 text-left text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{t('common.unblock')}</button> : onBlock ? <button type="button" onClick={() => { onBlock(user.id); setMoreOpen(false); onClose(); }} className="w-full px-4 py-2 text-left text-[12px] font-medium text-red-400">{t('common.block')}</button> : null}
                  {onReport && <button type="button" onClick={() => { onReport(user.id); setMoreOpen(false); onClose(); }} className="w-full px-4 py-2 text-left text-[12px] font-medium text-red-400">{t('profile.reportUserProfile')}</button>}
                  {showModActions && (
                    <>
                      <div className="h-px my-1" style={{ backgroundColor: 'var(--border-subtle)' }} />
                      {onOpenModView && <button type="button" onClick={() => { onOpenModView(user.id); setMoreOpen(false); onClose(); }} className="w-full px-4 py-2 text-left text-[12px] font-medium flex items-center gap-2" style={{ color: 'var(--text-primary)' }}><Shield size={14} /> {t('profile.openInModView')}</button>}
                      {onKick && <button type="button" onClick={() => { onKick(user.id); setMoreOpen(false); onClose(); }} className="w-full px-4 py-2 text-left text-[12px] font-medium text-red-400">{t('profile.kickUser', { username: user.username })}</button>}
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}
        </div>
      </div>

      {/* Bottom content — sits over the popup-level frosted glass wrapper */}
      <div className="rounded-b-2xl">
      {/* Avatar + status */}
      <div className="px-6 pb-4 -mt-8">
        <div className={`relative inline-block overflow-visible rounded-[var(--radius-lg)] ${(user.effectivePlan ?? user.stripePlan) === 'pro' ? getAvatarEffectClass(user.avatarEffect) : ''}`}>
          <div className="relative rounded-[var(--radius-lg)] overflow-hidden cursor-pointer" style={{ width: 80, height: 80 }} onClick={() => onViewFullProfile?.(user)}>
            <LetterAvatar avatar={user.serverAvatar || user.avatar} username={formatUsername(user)} />
          </div>
          <div
            className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full flex items-center justify-center"
            style={{ backgroundColor: statusColors[user.status] ?? statusColors.offline }}
          />
        </div>
        <div className="mt-3 flex items-center flex-wrap gap-2">
          {(() => {
            const isPro = (user.effectivePlan ?? user.stripePlan) === 'pro';
            const hasProEffects = isPro && (user.nameColor || user.nameFont || user.nameEffect);
            const hasRoleStyle = user.roleColor || user.role;
            if (hasRoleStyle || hasProEffects) {
              return <RoleNameStyle name={user.nickname || formatUsername(user)} color={user.roleColor ?? undefined} style={user.roleStyle ?? 'solid'} overrideColor={user.nameColor ?? undefined} overrideFont={user.nameFont ?? undefined} nameEffect={user.nameEffect ?? undefined} className="text-lg font-black tracking-tight" />;
            }
            return <span className="text-lg font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>{user.nickname || formatUsername(user)}</span>;
          })()}
          <ProfileBadges badges={user.badges} size="sm" />
        </div>
        {(() => {
          // Role chip strip — surfaces every role the member has in the
          // active server, sorted by hierarchy (lower position = higher
          // rank, like Discord). Hidden in DM contexts where `roles` is
          // unset; falls back to the legacy single-role subtitle below.
          const sortedRoles = (user.roles ?? [])
            .filter((r) => !r.isEveryone)
            .slice()
            .sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
          if (sortedRoles.length === 0) return null;
          return (
            <div className="mt-2 flex flex-wrap gap-1">
              {sortedRoles.map((role, i) => (
                <span
                  key={role.id ?? `${role.name}-${i}`}
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded-md border leading-tight"
                  style={{
                    backgroundColor: role.color ? `color-mix(in srgb, ${role.color} 14%, transparent)` : 'var(--fill-hover)',
                    borderColor: role.color ? `color-mix(in srgb, ${role.color} 28%, transparent)` : 'var(--glass-border)',
                    color: role.color || 'var(--text-secondary)',
                  }}
                >
                  {role.name}
                </span>
              ))}
            </div>
          );
        })()}
        {(() => {
          // Legacy single-role + customStatus subtitle. Drop `user.role` once
          // we're already rendering the full chip strip above — otherwise the
          // highest role would show up twice.
          const hasChipStrip = (user.roles?.filter((r) => !r.isEveryone).length ?? 0) > 0;
          const subtitleParts = [hasChipStrip ? null : user.role, user.customStatus].filter(Boolean);
          if (subtitleParts.length === 0) return null;
          return (
            <p className="text-[11px] mt-1 uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
              {subtitleParts.join(' • ')}
            </p>
          );
        })()}
        {user.activityBio && (
          <p className="text-[12px] mt-2.5" style={{ color: 'var(--text-secondary)', lineHeight: 1.4 }}>
            {user.activityBio}
          </p>
        )}
        {(() => {
          const renderSpotifyCard = (act: GameActivity, marginClass: string) => {
            const img = sanitizeImgSrc(act.largeImage) || '';
            return (
              <div key={`spotify-${act.platformId || act.name}`} className={`${marginClass} rounded-xl overflow-hidden`}>
                <div style={{ position: 'relative', overflow: 'hidden' }}>
                  {img ? (
                    <img src={img} alt="" loading="lazy" decoding="async" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(14px) brightness(0.35) saturate(1.3)', transform: 'scale(1.4)' }} />
                  ) : (
                    <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }} />
                  )}
                  <div style={{ position: 'relative', zIndex: 1, padding: '10px 12px' }}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <svg width={12} height={12} viewBox="0 0 496 512" fill="#1DB954"><path d="M248 8C111.1 8 0 119.1 0 256s111.1 248 248 248 248-111.1 248-248S384.9 8 248 8zm100.7 364.9c-4.2 6.6-12.9 8.6-19.5 4.4-53.5-32.7-120.8-40.1-200.1-22-7.6 1.7-15.3-3-17-10.7-1.7-7.6 3-15.3 10.7-17 86.7-19.8 161.1-11.3 221.1 25.5 6.6 4.1 8.6 12.8 4.4 19.4l.4-.6zm26.8-68.9c-5.2 8.4-16.2 11-24.6 5.8-61.2-37.6-154.5-48.5-226.9-26.5-9.2 2.8-18.9-2.4-21.7-11.6-2.8-9.2 2.4-18.9 11.6-21.7 82.6-25.2 185.3-13 254.4 30.3 8.4 5.1 11 16.2 5.8 24.6l.4-1zm2.3-71.8C310.6 196.3 180.5 192 105 213.4c-11 3.4-22.7-2.8-26.1-13.8-3.4-11 2.8-22.7 13.8-26.1 86.7-24.6 230.7-19.9 321.9 30.2 9.9 5.9 13.1 18.8 7.2 28.7-5.9 9.9-18.8 13.1-28.7 7.2l-.3-.3z"/></svg>
                        <span className="text-[9px] font-semibold uppercase" style={{ color: '#1DB954', letterSpacing: '0.07em' }}>
                          {t('activity.listeningTo', { defaultValue: 'Listening to Spotify' })}
                        </span>
                      </div>
                      {!isSelf && (
                        <button
                          type="button"
                          onClick={handleListenAlong}
                          disabled={listenAlongLoading}
                          className="flex items-center justify-center shrink-0 rounded-full transition-colors"
                          style={{ width: 24, height: 24, background: 'var(--fill-active)', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' }}
                          title={t('spotify.listenAlong.button', { defaultValue: 'Listen Along' })}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--fill-stronger)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--fill-active)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'; }}
                        >
                          {listenAlongLoading ? <Loader2 size={12} className="animate-spin" /> : <Headphones size={12} />}
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2.5">
                      {img ? (
                        <img src={img} alt="" className="w-14 h-14 rounded-md shrink-0 object-cover" loading="lazy" decoding="async" width={56} height={56} style={{ border: '1px solid var(--glass-border)' }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      ) : (
                        <div className="w-14 h-14 rounded-md shrink-0 flex items-center justify-center" style={{ background: 'var(--fill-hover)', border: '1px solid var(--glass-border)' }}>
                          <Music size={20} style={{ color: '#1DB954' }} />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold truncate">
                          <a href={act.platformId ? `https://open.spotify.com/track/${act.platformId}` : `https://open.spotify.com/search/${encodeURIComponent(act.name)}`} target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: '#fff', textDecoration: 'none' }}>
                            {act.name}
                          </a>
                        </div>
                        {act.details && (
                          <div className="text-[10.5px] truncate mt-px">
                            <span style={{ color: 'rgba(255,255,255,0.45)' }}>by </span>
                            <a href={`https://open.spotify.com/search/${encodeURIComponent(act.details)}`} target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: 'rgba(255,255,255,0.65)', textDecoration: 'none' }}>
                              {act.details}
                            </a>
                          </div>
                        )}
                        {act.state && (
                          <div className="text-[9.5px] truncate mt-px">
                            <span style={{ color: 'rgba(255,255,255,0.3)' }}>on </span>
                            <a href={`https://open.spotify.com/search/${encodeURIComponent(act.state)}`} target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: 'rgba(255,255,255,0.4)', textDecoration: 'none' }}>
                              {act.state}
                            </a>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 px-3 py-1.5" style={{ background: 'color-mix(in srgb, var(--text-primary) 3%, transparent)' }}>
                  <span className="text-[9px] tabular-nums" style={{ color: 'var(--text-secondary)', opacity: 0.6, minWidth: 28 }}>{spotifyElapsed}</span>
                  <div className="flex-1 rounded-full overflow-hidden" style={{ height: 3, background: 'color-mix(in srgb, var(--text-primary) 10%, transparent)' }}>
                    <div className="h-full rounded-full" style={{ background: '#1DB954', width: `${Math.min(100, spotifyProgress)}%`, transition: 'width 1s linear' }} />
                  </div>
                  {spotifyDuration && (
                    <span className="text-[9px] tabular-nums text-right" style={{ color: 'var(--text-secondary)', opacity: 0.6, minWidth: 28 }}>{spotifyDuration}</span>
                  )}
                </div>
                {listenAlongMsg && (
                  <p className="text-[9px] text-center mt-1.5 px-2" style={{ color: 'var(--text-secondary)' }}>{listenAlongMsg}</p>
                )}
              </div>
            );
          };

          const renderGameHeroCard = (act: GameActivity, marginClass: string) => {
            const gameImg = sanitizeImgSrc(act.largeImage)
              || (act.platform === 'steam' && act.platformId
                ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${act.platformId}/header.jpg`
                : '');
            return (
              <div key={`game-${act.name}`} className={`${marginClass} rounded-xl overflow-hidden`}>
                <div style={{ position: 'relative', overflow: 'hidden' }}>
                  {gameImg ? (
                    <img src={gameImg} alt="" loading="lazy" decoding="async" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(14px) brightness(0.35) saturate(1.3)', transform: 'scale(1.4)' }} />
                  ) : (
                    <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }} />
                  )}
                  <div style={{ position: 'relative', zIndex: 1, padding: '10px 12px' }}>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Gamepad2 size={12} style={{ color: 'var(--cyan-accent)' }} />
                      <span className="text-[9px] font-semibold uppercase" style={{ color: 'var(--cyan-accent)', letterSpacing: '0.07em' }}>
                        {t('activity.nowPlaying', { defaultValue: 'Now Playing' })}
                      </span>
                    </div>
                    <div className="flex items-center gap-2.5">
                      {gameImg ? (
                        <img src={gameImg} alt="" className="w-14 h-14 rounded-md shrink-0 object-cover" loading="lazy" decoding="async" width={56} height={56} style={{ border: '1px solid var(--glass-border)' }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      ) : (
                        <div className="w-14 h-14 rounded-md shrink-0 flex items-center justify-center" style={{ background: 'var(--fill-hover)', border: '1px solid var(--glass-border)' }}>
                          <Gamepad2 size={20} style={{ color: 'var(--cyan-accent)' }} />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold truncate" style={{ color: '#fff' }}>{act.name}</div>
                        {act.details && (
                          <div className="text-[10.5px] truncate mt-px" style={{ color: 'rgba(255,255,255,0.5)' }}>{act.details}</div>
                        )}
                        <div className="text-[9px] mt-1" style={{ color: 'rgba(255,255,255,0.4)' }}>
                          {formatActivityElapsed(act.startedAt)} {t('activity.elapsed', { defaultValue: 'elapsed' })}
                          {act.platform === 'steam' && <span style={{ opacity: 0.7, marginLeft: 6 }}>{t('activity.steamGame', { defaultValue: 'via Steam' })}</span>}
                          {act.type === 'detected_game' && <span style={{ opacity: 0.7, marginLeft: 6 }}>{t('activity.detectedGame', { defaultValue: 'Detected on desktop' })}</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          };

          const primary = user.activity && user.activity.type !== 'bio' ? user.activity : null;
          const secondary = user.secondaryActivity && user.secondaryActivity.type !== 'bio' ? user.secondaryActivity : null;
          const cards: React.ReactNode[] = [];

          if (primary) {
            if (primary.type === 'spotify') cards.push(renderSpotifyCard(primary, 'mt-3'));
            else cards.push(renderGameHeroCard(primary, 'mt-3'));
          }

          if (secondary && secondary.type !== primary?.type) {
            if (secondary.type === 'spotify') cards.push(renderSpotifyCard(secondary, 'mt-2'));
            else cards.push(renderGameHeroCard(secondary, 'mt-2'));
          }

          return cards.length > 0 ? <>{cards}</> : null;
        })()}
        {!isSelf && mutuals && (mutuals.friends.length > 0 || mutuals.servers.length > 0) && (
          <div className="mt-3 space-y-1.5">
            {mutuals.friends.length > 0 && (
              <button
                type="button"
                onClick={() => onViewFullProfile?.(user, 'friends')}
                className="w-full flex items-center gap-2 px-2 py-1.5 -mx-2 rounded-lg hover:bg-fill-hover transition-colors group"
              >
                <div className="flex -space-x-1.5 shrink-0">
                  {mutuals.friends.slice(0, 4).map((f) => (
                    <div key={f.id} className="w-5 h-5 rounded-[var(--radius-lg)] overflow-hidden">
                      <LetterAvatar avatar={f.avatar} username={f.username} size={20} className="rounded-full" />
                    </div>
                  ))}
                </div>
                <span className="text-[11px] font-semibold flex-1 text-left text-t-secondary group-hover:text-t-primary transition-colors">
                  {t('profile.mutualFriendsCount', { count: mutuals.friends.length, defaultValue: '{{count}} Mutual Friends' })}
                </span>
                <ChevronRight size={12} className="text-t-secondary opacity-50 shrink-0" />
              </button>
            )}
            {mutuals.servers.length > 0 && (
              <button
                type="button"
                onClick={() => onViewFullProfile?.(user, 'servers')}
                className="w-full flex items-center gap-2 px-2 py-1.5 -mx-2 rounded-lg hover:bg-fill-hover transition-colors group"
              >
                <div className="flex -space-x-1.5 shrink-0">
                  {mutuals.servers.slice(0, 4).map((s) => (
                    <div key={s.id} className="w-5 h-5 rounded-md overflow-hidden flex items-center justify-center" style={{ backgroundColor: 'var(--fill-active)' }}>
                      {s.icon ? (
                        <LazyGif src={sanitizeImgSrc(s.icon)} frameSrc={getFrameUrl(s.icon)} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-[8px] font-bold text-t-secondary">{s.name.slice(0, 2).toUpperCase()}</span>
                      )}
                    </div>
                  ))}
                </div>
                <span className="text-[11px] font-semibold flex-1 text-left text-t-secondary group-hover:text-t-primary transition-colors">
                  {t('profile.mutualServersCount', { count: mutuals.servers.length, defaultValue: '{{count}} Mutual Servers' })}
                </span>
                <ChevronRight size={12} className="text-t-secondary opacity-50 shrink-0" />
              </button>
            )}
          </div>
        )}
      </div>

      </div>
    </div>
  );
  return portalTarget ? createPortal(popup, portalTarget) : popup;
});
