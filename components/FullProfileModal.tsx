// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { formatUsername, MutualFriend, ActivityHistoryEntry } from '../types';
import type { UserWithRole } from './UserProfilePopup';
import { UserPlus, UserMinus, UserX, MoreVertical, Shield, ChevronRight, Gamepad2, X, Layout, Music, Headphones, Loader2, Lock, ExternalLink } from 'lucide-react';
import { SpotifyIcon, TwitchIcon, YouTubeIcon, GitHubIcon, RedditIcon } from './icons/AppIcons';
import { SteamIcon, EpicIcon, RiotIcon } from './icons/GamePlatformIcons';
import { LetterAvatar } from './LetterAvatar';
import { ProfileBadges } from './ProfileBadges';
import { RoleNameStyle } from './RoleNameStyle';
import type { RoleStyle } from './RoleNameStyle';
import { getAvatarEffectClass } from '../shared/planPerks';
import { formatActivityElapsed } from '../utils/activityUtils';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { retryOnExpired, toOriginalUploadPath } from '../utils/signedImageRetry';
import { sanitizeCssUrl } from '../utils/securityUtils';
import { useBreakpoint } from '../hooks/useIsMobile';
import { useGifFrameUrl } from '../hooks/useGifFrameUrl';
import { useProfileData } from '../hooks/useProfileData';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';
import { apiClient } from '../services/api';
import { ShowcaseGrid } from './showcase/ShowcaseGrid';
import { assetPath } from '../utils/assetPath';
import { useUiStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { STATUS_COLORS as statusColors } from '../shared/statusColors';
const EMPTY_ROLES: Array<{ id?: string; name: string; color: string | null; style?: import('./RoleNameStyle').RoleStyle | string; position?: number }> = [];
const EMPTY_CONNECTIONS: Array<{ provider: string; displayName: string | null; providerId?: string }> = [];

function formatRelativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function buildProviderProfileUrl(conn: { provider: string; displayName?: string | null; providerId?: string | null }): string | null {
  const { provider, displayName, providerId } = conn;
  switch (provider) {
    case 'steam':   return providerId ? `https://steamcommunity.com/profiles/${providerId}` : null;
    case 'spotify': return providerId ? `https://open.spotify.com/user/${providerId}` : null;
    case 'twitch':  return displayName ? `https://www.twitch.tv/${encodeURIComponent(displayName)}` : null;
    case 'youtube': return providerId ? `https://www.youtube.com/channel/${encodeURIComponent(providerId)}` : null;
    case 'github':  return displayName ? `https://github.com/${encodeURIComponent(displayName)}` : null;
    case 'reddit':  return displayName ? `https://www.reddit.com/user/${encodeURIComponent(displayName)}` : null;
    default: return null;
  }
}

const PROVIDER_ICONS: Record<string, React.FC<{ size?: number; className?: string }>> = {
  steam: SteamIcon,
  spotify: SpotifyIcon,
  twitch: TwitchIcon,
  youtube: YouTubeIcon,
  github: GitHubIcon,
  reddit: RedditIcon,
  epic: EpicIcon,
  riot: RiotIcon,
};

export interface FullProfileModalProps {
  onClose: () => void;
  onCreateDM: (userId: string) => void;
  onSendMessageAndOpenDM?: (userId: string, content: string) => void;
  onAddFriend?: (user: UserWithRole) => void;
  onCancelFriendRequest?: (requestId: string) => void;
  onRemoveFriend?: (userId: string) => void;
  isBlocked?: boolean;
  onBlock?: (userId: string) => void;
  onUnblock?: (userId: string) => void;
  onReport?: (userId: string) => void;
  onIgnore?: (userId: string) => void;
  onInviteToServer?: () => void;
  canKick?: boolean;
  isTargetOwner?: boolean;
  onOpenModView?: (userId: string) => void;
  onKick?: (userId: string) => void;
  serverRoles?: Array<{ id?: string; name: string; color: string | null; style?: RoleStyle; position?: number }>;
  onOpenUserProfile?: (user: MutualFriend) => void;
  serverName?: string;
  serverIcon?: string | null;
}

export const FullProfileModal: React.FC<FullProfileModalProps> = React.memo(({
  onClose,
  onAddFriend, onCancelFriendRequest, onRemoveFriend,
  isBlocked, onBlock, onUnblock, onReport, onIgnore, onInviteToServer,
  canKick, isTargetOwner, onOpenModView, onKick, serverRoles, onOpenUserProfile, serverName, serverIcon,
}) => {
  const fullProfileTarget = useUiStore(s => s.fullProfileTarget);
  const friendStatus = useUiStore(s => s.profileFriendStatus);
  const currentUserId = useAuthStore(s => s.currentUser)?.id ?? '';
  // target is guaranteed non-null by the parent's conditional render guard
  const user = fullProfileTarget?.user as UserWithRole;
  const _serverId = fullProfileTarget?.serverId;
  const serverJoinedAt = fullProfileTarget?.serverJoinedAt;
  const initialTab = fullProfileTarget?.initialTab;
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'showcase' | 'activity' | 'friends' | 'servers'>(initialTab ?? 'activity');
  const [tabInitialized, setTabInitialized] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const breakpoint = useBreakpoint();
  const isMobileView = breakpoint === 'mobile';
  const isTabletView = breakpoint === 'tablet';
  const isMobileOrTablet = isMobileView || isTabletView;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollProgress, setScrollProgress] = useState(0);

  const isSelf = user.id === currentUserId;
  const { showcaseData, showcaseLoading, mutualFriends, mutualServers, activityHistory, profileData, loading, spotifyProfile } = useProfileData(user.id, { isSelf, serverId: _serverId });
  const bannerDisplayUrl = useGifFrameUrl(profileData?.banner || user.banner);
  const isPrivateProfile = !isSelf && profileData?.private === true;
  const showModActions = !!canKick && !isTargetOwner && !isSelf;
  const userCreatedAt = profileData?.createdAt;

  const [spotifyElapsed, setSpotifyElapsed] = useState('0:00');
  const [spotifyProgress, setSpotifyProgress] = useState(0);

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

  // Default to Showcase once it's loaded — unless an explicit initialTab was
  // requested (e.g. clicked "X Mutual Friends/Servers" in the quick profile).
  useEffect(() => {
    if (tabInitialized || showcaseLoading) return;
    setActiveTab(initialTab ?? 'showcase');
    setTabInitialized(true);
  }, [showcaseLoading, tabInitialized, initialTab]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Close more menu on outside click
  useEffect(() => {
    if (!moreOpen) return;
    const close = (e: MouseEvent) => { if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [moreOpen]);

  const handleMobileScroll = useCallback(() => {
    if (!scrollRef.current || !isMobileOrTablet) return;
    const scrollTop = scrollRef.current.scrollTop;
    const THRESHOLD = 80;
    setScrollProgress(Math.min(1, scrollTop / THRESHOLD));
  }, [isMobileOrTablet]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isMobileOrTablet) return;
    el.addEventListener('scroll', handleMobileScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleMobileScroll);
  }, [isMobileOrTablet, handleMobileScroll]);

  const compactBarVisible = isMobileOrTablet && scrollProgress >= 0.7;
  const bannerHeight = isMobileOrTablet ? Math.max(0, 140 - scrollProgress * 140) : 360;
  const identityOpacity = isMobileOrTablet ? Math.max(0, 1 - scrollProgress * 1.5) : 1;

  // Activity items: current activity first + history, deduplicated by name
  const activityItems = useMemo(() => {
    const items: Array<ActivityHistoryEntry & { isLive: boolean }> = [];
    if (user.activity && user.activity.type !== 'bio') {
      items.push({ id: 'live-primary', type: user.activity.type, name: user.activity.name, details: user.activity.details, largeImage: user.activity.largeImage, smallImage: user.activity.smallImage, platformId: user.activity.platformId, platform: user.activity.platform, startedAt: user.activity.startedAt, endedAt: null, isLive: true });
    }
    if (user.secondaryActivity && user.secondaryActivity.type !== 'bio' && user.secondaryActivity.type !== user.activity?.type) {
      items.push({ id: 'live-secondary', type: user.secondaryActivity.type, name: user.secondaryActivity.name, details: user.secondaryActivity.details, largeImage: user.secondaryActivity.largeImage, smallImage: user.secondaryActivity.smallImage, platformId: user.secondaryActivity.platformId, platform: user.secondaryActivity.platform, startedAt: user.secondaryActivity.startedAt, endedAt: null, isLive: true });
    }
    const hasSpotify = items.some(i => i.type === 'spotify');
    for (const h of activityHistory) {
      if (items.length >= 20) break;
      if (items.some(i => i.name === h.name)) continue;
      if (h.type === 'spotify' && (hasSpotify || items.some(i => i.type === 'spotify'))) continue;
      items.push({ ...h, isLive: false });
    }
    return items;
  }, [user.activity, user.secondaryActivity, activityHistory]);

  // Friend button
  const renderFriendButton = () => {
    if (isSelf) return null;
    if (friendStatus?.status === 'friends' && onRemoveFriend) {
      return (
        <button type="button" onClick={() => onRemoveFriend(user.id)}
          className="p-1.5 rounded-lg border border-[var(--glass-border)] transition-colors text-t-secondary hover:bg-fill-hover"
          title={t('profile.removeFriend')}>
          <UserMinus size={15} />
        </button>
      );
    }
    if (friendStatus?.status === 'pending_outgoing' && onCancelFriendRequest && friendStatus.outgoingRequestId) {
      return (
        <button type="button" onClick={() => onCancelFriendRequest(friendStatus.outgoingRequestId!)}
          className="p-1.5 rounded-lg border border-[var(--glass-border)] transition-colors text-t-secondary hover:bg-fill-hover"
          title={t('profile.cancelFriendRequest')}>
          <UserX size={15} />
        </button>
      );
    }
    if ((friendStatus?.status === 'none' || !friendStatus) && onAddFriend) {
      return (
        <button type="button" onClick={() => onAddFriend(user)}
          className="p-1.5 rounded-lg border border-[var(--glass-border)] transition-colors text-t-secondary hover:bg-fill-hover"
          title={t('profile.addFriend')}>
          <UserPlus size={15} />
        </button>
      );
    }
    return null;
  };

  // More menu
  const renderMoreMenu = (mobile?: boolean) => {
    if (!moreOpen) return null;

    if (mobile) {
      // Mobile: fixed bottom sheet
      return (
        <>
          <div className="fixed inset-0 z-[9200]" style={{ backgroundColor: 'var(--overlay-backdrop)' }} onClick={() => setMoreOpen(false)} />
          <div className="fixed bottom-0 left-0 right-0 z-[9201] bg-panel border-t border-[var(--glass-border)] rounded-t-2xl py-2 px-1"
            style={{ maxHeight: '60vh', overflowY: 'auto' }}>
            <div className="w-8 h-0.5 rounded-full mx-auto mb-2" style={{ backgroundColor: 'var(--fill-active)' }} />
            {friendStatus?.status === 'friends' && onRemoveFriend && (
              <button type="button" onClick={() => { onRemoveFriend(user.id); setMoreOpen(false); }} className="w-full px-5 py-3 text-left text-[13px] font-medium text-t-primary hover:bg-fill-hover rounded-lg">{t('profile.removeFriend')}</button>
            )}
            {friendStatus?.status === 'pending_outgoing' && onCancelFriendRequest && friendStatus.outgoingRequestId && (
              <button type="button" onClick={() => { onCancelFriendRequest(friendStatus.outgoingRequestId!); setMoreOpen(false); }} className="w-full px-5 py-3 text-left text-[13px] font-medium text-t-primary hover:bg-fill-hover rounded-lg">{t('profile.cancelFriendRequest')}</button>
            )}
            {(friendStatus?.status === 'none' || !friendStatus) && onAddFriend && (
              <button type="button" onClick={() => { onAddFriend(user); setMoreOpen(false); }} className="w-full px-5 py-3 text-left text-[13px] font-medium text-t-primary hover:bg-fill-hover rounded-lg">{t('profile.addFriend')}</button>
            )}
            {onInviteToServer && (
              <button type="button" onClick={() => { onInviteToServer(); setMoreOpen(false); }} className="w-full px-5 py-3 text-left text-[13px] font-medium flex items-center justify-between text-t-primary hover:bg-fill-hover rounded-lg">{t('profile.inviteToServer')} <ChevronRight size={14} /></button>
            )}
            <div className="h-px my-1 mx-4 bg-[var(--border-subtle)]" />
            {onIgnore && (
              <button type="button" onClick={() => { onIgnore(user.id); setMoreOpen(false); onClose(); }} className="w-full px-5 py-3 text-left text-[13px] font-medium text-t-primary hover:bg-fill-hover rounded-lg">{t('profile.ignore')}</button>
            )}
            {isBlocked && onUnblock
              ? <button type="button" onClick={() => { onUnblock(user.id); setMoreOpen(false); onClose(); }} className="w-full px-5 py-3 text-left text-[13px] font-medium text-t-primary hover:bg-fill-hover rounded-lg">{t('common.unblock')}</button>
              : onBlock
                ? <button type="button" onClick={() => { onBlock(user.id); setMoreOpen(false); onClose(); }} className="w-full px-5 py-3 text-left text-[13px] font-medium text-red-400 hover:bg-fill-hover rounded-lg">{t('common.block')}</button>
                : null
            }
            {onReport && (
              <button type="button" onClick={() => { onReport(user.id); setMoreOpen(false); onClose(); }} className="w-full px-5 py-3 text-left text-[13px] font-medium text-red-400 hover:bg-fill-hover rounded-lg">{t('profile.reportUserProfile')}</button>
            )}
            {(onOpenModView || onKick) && (
              <>
                <div className="h-px my-1 mx-4 bg-[var(--border-subtle)]" />
                {onOpenModView && <button type="button" onClick={() => { onOpenModView(user.id); setMoreOpen(false); onClose(); }} className="w-full px-5 py-3 text-left text-[13px] font-medium flex items-center gap-2 text-t-primary hover:bg-fill-hover rounded-lg"><Shield size={14} /> {t('profile.openInModView')}</button>}
                {onKick && <button type="button" onClick={() => { onKick(user.id); setMoreOpen(false); onClose(); }} className="w-full px-5 py-3 text-left text-[13px] font-medium text-red-400 hover:bg-fill-hover rounded-lg">{t('profile.kickUser', { username: user.username })}</button>}
              </>
            )}
          </div>
        </>
      );
    }

    // Desktop: existing absolute dropdown
    return (
      <div className="absolute right-0 top-full mt-1 py-1 min-w-[180px] rounded-xl border border-default shadow-xl z-10 bg-floating">
        {friendStatus?.status === 'friends' && onRemoveFriend && (
          <button type="button" onClick={() => { onRemoveFriend(user.id); setMoreOpen(false); }} className="w-full px-4 py-2 text-left text-[12px] font-medium text-t-primary hover:bg-fill-hover">{t('profile.removeFriend')}</button>
        )}
        {friendStatus?.status === 'pending_outgoing' && onCancelFriendRequest && friendStatus.outgoingRequestId && (
          <button type="button" onClick={() => { onCancelFriendRequest(friendStatus.outgoingRequestId!); setMoreOpen(false); }} className="w-full px-4 py-2 text-left text-[12px] font-medium text-t-primary hover:bg-fill-hover">{t('profile.cancelFriendRequest')}</button>
        )}
        {(friendStatus?.status === 'none' || !friendStatus) && onAddFriend && (
          <button type="button" onClick={() => { onAddFriend(user); setMoreOpen(false); }} className="w-full px-4 py-2 text-left text-[12px] font-medium text-t-primary hover:bg-fill-hover">{t('profile.addFriend')}</button>
        )}
        {onInviteToServer && (
          <button type="button" onClick={() => { onInviteToServer(); setMoreOpen(false); }} className="w-full px-4 py-2 text-left text-[12px] font-medium flex items-center justify-between text-t-primary hover:bg-fill-hover">{t('profile.inviteToServer')} <ChevronRight size={14} /></button>
        )}
        <div className="h-px my-1 bg-[var(--border-subtle)]" />
        {onIgnore && (
          <button type="button" onClick={() => { onIgnore(user.id); setMoreOpen(false); onClose(); }} className="w-full px-4 py-2 text-left text-[12px] font-medium text-t-primary hover:bg-fill-hover">{t('profile.ignore')}</button>
        )}
        {isBlocked && onUnblock
          ? <button type="button" onClick={() => { onUnblock(user.id); setMoreOpen(false); onClose(); }} className="w-full px-4 py-2 text-left text-[12px] font-medium text-t-primary hover:bg-fill-hover">{t('common.unblock')}</button>
          : onBlock
            ? <button type="button" onClick={() => { onBlock(user.id); setMoreOpen(false); onClose(); }} className="w-full px-4 py-2 text-left text-[12px] font-medium text-red-400 hover:bg-fill-hover">{t('common.block')}</button>
            : null
        }
        {onReport && (
          <button type="button" onClick={() => { onReport(user.id); setMoreOpen(false); onClose(); }} className="w-full px-4 py-2 text-left text-[12px] font-medium text-red-400 hover:bg-fill-hover">{t('profile.reportUserProfile')}</button>
        )}
        {showModActions && (
          <>
            <div className="h-px my-1 bg-[var(--border-subtle)]" />
            {onOpenModView && <button type="button" onClick={() => { onOpenModView(user.id); setMoreOpen(false); onClose(); }} className="w-full px-4 py-2 text-left text-[12px] font-medium flex items-center gap-2 text-t-primary hover:bg-fill-hover"><Shield size={14} /> {t('profile.openInModView')}</button>}
            {onKick && <button type="button" onClick={() => { onKick(user.id); setMoreOpen(false); onClose(); }} className="w-full px-4 py-2 text-left text-[12px] font-medium text-red-400 hover:bg-fill-hover">{t('profile.kickUser', { username: user.username })}</button>}
          </>
        )}
      </div>
    );
  };

  // Tab renderers
  const renderShowcaseTab = () => {
    // Loading state
    if (showcaseLoading) {
      return (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={20} className="animate-spin text-t-secondary" style={{ opacity: 0.3 }} />
        </div>
      );
    }

    // If user has a bento layout, render the grid
    if (showcaseData && showcaseData.layout.length > 0) {
      return <ShowcaseGrid layout={showcaseData.layout} mobileLayout={showcaseData.mobileLayout ?? null} gameAccounts={showcaseData.gameAccounts} spotifyData={spotifyProfile} spotifyActivity={spotifyAct || null} steamPlaytime={showcaseData.steamPlaytime} steamRecentActivity={showcaseData.steamRecentActivity} platformProfiles={showcaseData.platformProfiles} />;
    }

    // Empty state
    return (
      <div className="flex flex-col items-center justify-center py-12 rounded-xl border border-dashed" style={{ borderColor: 'var(--glass-border)' }}>
        <Layout size={28} className="text-t-secondary" style={{ opacity: 0.2 }} />
        <p className="text-sm font-semibold mt-3 text-t-secondary" style={{ opacity: 0.3 }}>
          {isSelf ? t('profile.showcaseEmpty', 'Your showcase is empty') : t('profile.showcaseEmptyOther', 'No showcase to display')}
        </p>
        {isSelf && (
          <p className="text-[11px] mt-1 text-t-secondary" style={{ opacity: 0.2 }}>
            {t('profile.showcaseEmptyHint', 'Go to Settings \u2192 Showcase to set it up')}
          </p>
        )}
      </div>
    );
  };

  const renderActivityTab = () => {
    if (loading) return <div className="text-xs text-center py-8 text-t-secondary" style={{ opacity: 0.4 }}>{t('common.loading')}</div>;

    if (activityItems.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-t-secondary" style={{ opacity: 0.3 }}>
          <Gamepad2 size={28} />
          <p className="text-sm font-medium mt-3">{t('profile.noActivity', 'No recent activity')}</p>
        </div>
      );
    }

    return (
      <>
        {activityItems.length > 0 && (
          <p className="text-[10px] font-bold uppercase tracking-widest mb-3 text-t-secondary" style={{ opacity: 0.5 }}>
            {t('profile.recentActivity', 'Recent activity')}
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          {activityItems.map((item) => {
            const actImg = sanitizeImgSrc(item.largeImage)
              || (item.platform === 'steam' && item.platformId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.platformId}/header.jpg` : '');

            if (item.type === 'spotify' && item.isLive) {
              return (
                <div key={item.id || item.name} className="rounded-xl overflow-hidden mb-1.5">
                  <div style={{ position: 'relative', overflow: 'hidden' }}>
                    {actImg ? (
                      <img src={actImg} alt="" loading="lazy" decoding="async" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(14px) brightness(0.35) saturate(1.3)', transform: 'scale(1.4)' }} />
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
                            onClick={() => { apiClient.listenAlong(user.id).catch(() => {}); }}
                            className="flex items-center justify-center shrink-0 rounded-full transition-colors"
                            style={{ width: 24, height: 24, background: 'var(--fill-active)', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' }}
                            title={t('spotify.listenAlong.button', { defaultValue: 'Listen Along' })}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--fill-stronger)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)'; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--fill-active)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'; }}
                          >
                            <Headphones size={12} />
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-2.5">
                        {actImg ? (
                          <img src={actImg} alt="" className="w-14 h-14 rounded-md shrink-0 object-cover" loading="lazy" decoding="async" width={56} height={56} style={{ border: '1px solid var(--glass-border)' }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        ) : (
                          <div className="w-14 h-14 rounded-md shrink-0 flex items-center justify-center" style={{ background: 'var(--fill-hover)', border: '1px solid var(--glass-border)' }}>
                            <Music size={20} style={{ color: '#1DB954' }} />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-semibold truncate">
                            <a href={item.platformId ? `https://open.spotify.com/track/${item.platformId}` : `https://open.spotify.com/search/${encodeURIComponent(item.name)}`} target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: '#fff', textDecoration: 'none' }}>
                              {item.name}
                            </a>
                          </div>
                          {item.details && (
                            <div className="text-[10.5px] truncate mt-px">
                              <span style={{ color: 'var(--text-secondary)', opacity: 0.7 }}>by </span>
                              <a href={`https://open.spotify.com/search/${encodeURIComponent(item.details)}`} target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>{item.details}</a>
                            </div>
                          )}
                          {user.activity?.state && (
                            <div className="text-[9.5px] truncate mt-px">
                              <span style={{ color: 'var(--text-tertiary)' }}>on </span>
                              <a href={`https://open.spotify.com/search/${encodeURIComponent(user.activity.state)}`} target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: 'var(--text-tertiary)', textDecoration: 'none' }}>{user.activity.state}</a>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 px-3 py-1.5" style={{ background: 'color-mix(in srgb, var(--text-primary) 3%, transparent)' }}>
                    <span className="text-[9px] tabular-nums text-t-secondary" style={{ opacity: 0.6, minWidth: 28 }}>{spotifyElapsed}</span>
                    <div className="flex-1 rounded-full overflow-hidden" style={{ height: 3, background: 'color-mix(in srgb, var(--text-primary) 10%, transparent)' }}>
                      <div className="h-full rounded-full" style={{ background: '#1DB954', width: `${Math.min(100, spotifyProgress)}%`, transition: 'width 1s linear' }} />
                    </div>
                    {spotifyDuration && (
                      <span className="text-[9px] tabular-nums text-right text-t-secondary" style={{ opacity: 0.6, minWidth: 28 }}>{spotifyDuration}</span>
                    )}
                  </div>
                </div>
              );
            }

            // Live game hero card (matches UserProfilePopup design)
            if (item.isLive && item.type !== 'spotify') {
              return (
                <div key={item.id || item.name} className="rounded-xl overflow-hidden mb-1.5">
                  <div style={{ position: 'relative', overflow: 'hidden' }}>
                    {actImg ? (
                      <img src={actImg} alt="" loading="lazy" decoding="async" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(14px) brightness(0.35) saturate(1.3)', transform: 'scale(1.4)' }} />
                    ) : (
                      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }} />
                    )}
                    <div style={{ position: 'relative', zIndex: 1, padding: '10px 12px' }}>
                      <div className="flex items-center gap-1.5 mb-2">
                        <Gamepad2 size={12} className="text-t-accent" />
                        <span className="text-[9px] font-semibold uppercase text-t-accent" style={{ letterSpacing: '0.07em' }}>
                          {t('activity.nowPlaying', { defaultValue: 'Now Playing' })}
                        </span>
                      </div>
                      <div className="flex items-center gap-2.5">
                        {actImg ? (
                          <img src={actImg} alt="" className="w-14 h-14 rounded-md shrink-0 object-cover" loading="lazy" decoding="async" width={56} height={56} style={{ border: '1px solid var(--glass-border)' }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        ) : (
                          <div className="w-14 h-14 rounded-md shrink-0 flex items-center justify-center" style={{ background: 'var(--fill-hover)', border: '1px solid var(--glass-border)' }}>
                            <Gamepad2 size={20} className="text-t-accent" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-semibold truncate" style={{ color: '#fff' }}>{item.name}</div>
                          {item.details && (
                            <div className="text-[10.5px] truncate mt-px" style={{ color: 'var(--text-secondary)' }}>{item.details}</div>
                          )}
                          <div className="text-[9px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                            {formatActivityElapsed(item.startedAt)} {t('activity.elapsed', { defaultValue: 'elapsed' })}
                            {item.platform === 'steam' && <span style={{ opacity: 0.7, marginLeft: 6 }}>{t('activity.steamGame', { defaultValue: 'via Steam' })}</span>}
                            {item.type === 'detected_game' && <span style={{ opacity: 0.7, marginLeft: 6 }}>{t('activity.detectedGame', { defaultValue: 'Detected on desktop' })}</span>}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            }

            return (
              <div key={item.id || item.name}
                className="flex items-center gap-3.5 px-3.5 py-3 rounded-lg border transition-colors"
                style={{
                  backgroundColor: item.isLive ? 'color-mix(in srgb, var(--cyan-accent) 4%, transparent)' : 'var(--fill-hover)',
                  borderColor: item.isLive ? 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)' : 'var(--border-subtle)',
                }}>
                {actImg ? (
                  <img src={actImg} alt="" className="w-10 h-10 rounded-lg shrink-0 object-cover" loading="lazy" decoding="async" width={40} height={40} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <div className="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center"
                    style={{ backgroundColor: item.isLive ? 'color-mix(in srgb, var(--cyan-accent) 10%, transparent)' : 'var(--fill-hover)' }}>
                    {item.type === 'spotify'
                      ? <Music size={18} style={{ color: item.isLive ? '#1DB954' : 'var(--text-secondary)', opacity: item.isLive ? 0.8 : 0.3 }} />
                      : <Gamepad2 size={18} style={{ color: item.isLive ? 'var(--cyan-accent)' : 'var(--text-secondary)', opacity: item.isLive ? 0.8 : 0.3 }} />
                    }
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold truncate text-t-primary">{item.name}</p>
                  {item.type === 'spotify' && item.details && (
                    <p className="text-[10px] truncate text-t-secondary" style={{ opacity: 0.5 }}>{item.details}</p>
                  )}
                  <p className="text-[11px] truncate" style={{ color: item.isLive ? 'var(--cyan-accent)' : 'var(--text-secondary)', opacity: item.isLive ? 1 : 0.5 }}>
                    {item.isLive
                      ? `${t('activity.nowPlaying', { defaultValue: 'Playing now' })} \u00b7 ${formatActivityElapsed(item.startedAt)}`
                      : `${formatRelativeTime(item.startedAt)}${item.platform === 'steam' ? ' \u00b7 via Steam' : item.type === 'detected_game' ? ' \u00b7 Detected on desktop' : item.type === 'spotify' ? ' \u00b7 via Spotify' : ''}`
                    }
                  </p>
                </div>
                {item.isLive && <div className="w-2 h-2 rounded-full shrink-0 animate-pulse bg-[var(--cyan-accent)]" />}
              </div>
            );
          })}
        </div>
      </>
    );
  };

  const renderFriendsTab = () => {
    if (isSelf) return <p className="text-xs text-center py-8 text-t-secondary" style={{ opacity: 0.4 }}>{t('profile.noMutualsForSelf', 'Mutual info is shown on other profiles')}</p>;
    if (loading) return <div className="text-xs text-center py-8 text-t-secondary" style={{ opacity: 0.4 }}>{t('common.loading')}</div>;
    if (mutualFriends.length === 0) return <p className="text-xs text-center py-8 text-t-secondary" style={{ opacity: 0.4 }}>{t('profile.noMutualFriends', 'No mutual friends')}</p>;

    return (
      <>
        <p className="text-[10px] font-bold uppercase tracking-widest mb-3 text-t-secondary" style={{ opacity: 0.5 }}>
          {t('profile.mutualFriendsCount', { count: mutualFriends.length, defaultValue: '{{count}} mutual friends' })}
        </p>
        <div className="flex flex-col gap-0.5">
          {mutualFriends.map(friend => {
            const isPro = friend.effectivePlan === 'pro';
            const hasNameStyle = isPro && (friend.nameColor || friend.nameFont || friend.nameEffect);
            return (
              <div key={friend.id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors cursor-pointer hover:bg-fill-hover"
                onClick={() => onOpenUserProfile?.(friend)}>
                <div className={`relative shrink-0 w-[34px] h-[34px] rounded-full ${isPro ? getAvatarEffectClass(friend.avatarEffect) : ''}`}>
                  <div className="w-full h-full rounded-[var(--radius-lg)] overflow-hidden">
                    <LetterAvatar avatar={friend.avatar} username={friend.username} />
                  </div>
                </div>
                <span className="flex-1 text-[13px] font-semibold truncate text-t-primary">
                  {hasNameStyle
                    ? <RoleNameStyle name={formatUsername(friend)} overrideColor={friend.nameColor ?? undefined} overrideFont={friend.nameFont ?? undefined} nameEffect={friend.nameEffect ?? undefined} />
                    : formatUsername(friend)}
                </span>
                {friend.badges && friend.badges.length > 0 && <ProfileBadges badges={friend.badges} size="sm" />}
                <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: statusColors[friend.status] ?? statusColors.offline }} />
              </div>
            );
          })}
        </div>
      </>
    );
  };

  const renderServersTab = () => {
    if (isSelf) return <p className="text-xs text-center py-8 text-t-secondary" style={{ opacity: 0.4 }}>{t('profile.noMutualsForSelf', 'Mutual info is shown on other profiles')}</p>;
    if (loading) return <div className="text-xs text-center py-8 text-t-secondary" style={{ opacity: 0.4 }}>{t('common.loading')}</div>;
    if (mutualServers.length === 0) return <p className="text-xs text-center py-8 text-t-secondary" style={{ opacity: 0.4 }}>{t('profile.noMutualServers', 'No mutual servers')}</p>;

    return (
      <>
        <p className="text-[10px] font-bold uppercase tracking-widest mb-3 text-t-secondary" style={{ opacity: 0.5 }}>
          {t('profile.mutualServersCount', { count: mutualServers.length, defaultValue: '{{count}} mutual servers' })}
        </p>
        <div className="flex flex-col gap-0.5">
          {mutualServers.map(server => (
            <div key={server.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors cursor-pointer hover:bg-fill-hover">
              <div className="w-[34px] h-[34px] rounded-lg shrink-0 overflow-hidden flex items-center justify-center text-xs font-bold"
                style={{ backgroundColor: server.icon ? 'transparent' : 'var(--fill-active)' }}>
                {server.icon ? (
                  <LazyGif src={sanitizeImgSrc(server.icon)} frameSrc={getFrameUrl(server.icon)} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-t-secondary">{server.name.slice(0, 2).toUpperCase()}</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold truncate text-t-primary">{server.name}</p>
                <p className="text-[11px] text-t-secondary" style={{ opacity: 0.5 }}>
                  {t('profile.memberCount', { count: server.memberCount, defaultValue: '{{count}} members' })}
                </p>
              </div>
            </div>
          ))}
        </div>
      </>
    );
  };

  // Render
  const tabs = useMemo(() => {
    const list: Array<{ key: 'showcase' | 'activity' | 'friends' | 'servers'; label: string; count: number | null }> = [
      { key: 'showcase', label: t('profile.showcase', 'Showcase'), count: null },
      { key: 'activity', label: t('profile.activity', 'Activity'), count: null },
      { key: 'friends', label: t('profile.friends', 'Friends'), count: isSelf ? null : mutualFriends.length },
      { key: 'servers', label: t('profile.servers', 'Servers'), count: isSelf ? null : mutualServers.length },
    ];
    return list;
  }, [t, isSelf, mutualFriends.length, mutualServers.length]);

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center p-4" style={isMobileOrTablet ? { padding: 0 } : undefined}>
      {/* Backdrop — lighter than the global --overlay-backdrop so the chat behind
          bleeds through the glass panels, matching QuickProfile's depth. */}
      <div className="absolute inset-0 backdrop-blur-sm" style={{ backgroundColor: 'rgba(0,0,0,0.3)' }} onClick={onClose} />

      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-label="User profile"
        className={`relative flex flex-col rounded-2xl border border-default overflow-hidden spring-pop-in ${
          isMobileOrTablet ? 'w-full h-full rounded-none border-0' : 'w-[1150px] max-w-[calc(100vw-2rem)] max-h-[min(900px,calc(100vh-2rem))]'
        }`}
        style={isMobileOrTablet ? undefined : { boxShadow: 'var(--shadow-xl)' }}
      >
        {isMobileOrTablet ? (
          <>
            {/* Compact sticky bar — appears on scroll */}
            <div
              className="flex items-center gap-2.5 px-3 border-b border-default shrink-0 bg-panel"
              style={{
                height: compactBarVisible ? '48px' : '0',
                opacity: compactBarVisible ? 1 : 0,
                overflow: 'hidden',
                transition: 'height 0.2s ease, opacity 0.15s ease',
              }}
            >
              <button type="button" onClick={onClose}
                className="w-11 h-11 rounded-lg flex items-center justify-center transition-colors text-t-secondary hover:bg-fill-hover shrink-0">
                <X size={14} />
              </button>
              <div className={`w-8 h-8 rounded-[var(--radius-lg)] overflow-hidden border-2 shrink-0 ${(user.effectivePlan ?? user.stripePlan) === 'pro' ? getAvatarEffectClass(user.avatarEffect) : ''}`}
                style={{ borderColor: 'color-mix(in srgb, var(--cyan-accent) 20%, transparent)' }}>
                {(profileData?.avatar || user.avatar) ? (
                  <img src={sanitizeImgSrc(profileData?.avatar || user.avatar)} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" data-original-src={toOriginalUploadPath(profileData?.avatar || user.avatar)} onError={retryOnExpired} />
                ) : (
                  <LetterAvatar username={user.username} size={32} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <RoleNameStyle name={user.username} color={user.roleColor ?? undefined} style={user.roleStyle ?? 'solid'}
                    overrideFont={user.nameFont} nameEffect={user.nameEffect} overrideColor={user.nameColor}
                    className="text-[13px] font-bold truncate" />
                  <span className="text-[10px] text-t-tertiary">#{user.discriminator}</span>
                  {(user.effectivePlan ?? user.stripePlan) && (
                    <span className="text-[7px] px-1 py-px rounded-lg font-bold" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)', color: 'var(--cyan-accent)' }}>
                      {(user.effectivePlan ?? user.stripePlan) === 'pro' ? 'PRO' : 'ESS'}
                    </span>
                  )}
                  <div className="w-[5px] h-[5px] rounded-full shrink-0" style={{ backgroundColor: statusColors[user.status || 'offline'] }} />
                </div>
              </div>
              <button type="button" onClick={(e) => { e.stopPropagation(); setMoreOpen(v => !v); }}
                className="w-11 h-11 rounded-lg flex items-center justify-center text-t-secondary hover:bg-fill-hover shrink-0">
                <MoreVertical size={12} />
              </button>
            </div>

            {/* Mobile more menu (bottom sheet) */}
            {renderMoreMenu(true)}

            {/* Scrollable content */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto">
              {/* Banner — shrinks on scroll */}
              <div className="relative shrink-0"
                style={{ height: `${bannerHeight}px`, transition: 'height 0.05s linear', overflow: 'hidden' }}>
                {(profileData?.banner || user.banner) ? (
                  <>
                    <div className="absolute inset-0 bg-cover bg-center"
                      style={{
                        backgroundImage: sanitizeCssUrl(bannerDisplayUrl),
                        backgroundPosition: `center ${profileData?.bannerPositionY ?? user.bannerPositionY ?? 50}%`,
                        backgroundSize: ((profileData?.bannerZoom ?? user.bannerZoom ?? 100) > 100 ? `${profileData?.bannerZoom ?? user.bannerZoom}%` : 'cover'),
                      }} />
                    <div className="absolute inset-0 bg-black/30" />
                  </>
                ) : (
                  <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--cyan-accent) 12%, transparent) 0%, var(--bg-panel) 100%)' }} />
                )}
                <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[var(--bg-panel)]" />
                {!compactBarVisible && (
                  <button type="button" onClick={onClose}
                    className="absolute top-3 left-3 z-10 w-11 h-11 rounded-lg flex items-center justify-center transition-colors text-t-secondary hover:bg-fill-hover"
                    style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}>
                    <X size={14} />
                  </button>
                )}
                {!compactBarVisible && (
                  <button type="button" onClick={(e) => { e.stopPropagation(); setMoreOpen(v => !v); }}
                    className="absolute top-3 right-3 z-10 w-11 h-11 rounded-lg flex items-center justify-center text-t-secondary"
                    style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}>
                    <MoreVertical size={14} />
                  </button>
                )}
              </div>

              {/* Identity section — fades on scroll */}
              <div style={{ opacity: identityOpacity, transform: `translateY(${scrollProgress * -10}px)`, transition: 'opacity 0.15s ease' }}
                className="px-4 -mt-6 relative z-[2]">
                <div className="flex items-end gap-3">
                  <div className={`relative rounded-[var(--radius-lg)] overflow-hidden ${(user.effectivePlan ?? user.stripePlan) === 'pro' ? getAvatarEffectClass(user.avatarEffect) : ''}`}
                    style={{ width: '56px', height: '56px' }}>
                    {(profileData?.avatar || user.avatar) ? (
                      <img src={sanitizeImgSrc(profileData?.avatar || user.avatar)} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" data-original-src={toOriginalUploadPath(profileData?.avatar || user.avatar)} onError={retryOnExpired} />
                    ) : (
                      <LetterAvatar username={user.username} size={56} />
                    )}
                  </div>
                  <div className="pb-1">
                    <div className="flex items-center gap-1">
                      <RoleNameStyle name={user.username} color={user.roleColor ?? undefined} style={user.roleStyle ?? 'solid'}
                        overrideFont={user.nameFont} nameEffect={user.nameEffect} overrideColor={user.nameColor}
                        className="text-sm font-bold" />
                      <span className="text-[11px] text-t-tertiary">#{user.discriminator}</span>
                    </div>
                    <div className="flex gap-1 mt-0.5 items-center">
                      {(user.effectivePlan ?? user.stripePlan) && (
                        <span className="text-[8px] px-1.5 py-px rounded-lg font-bold" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)', color: 'var(--cyan-accent)' }}>
                          {(user.effectivePlan ?? user.stripePlan) === 'pro' ? 'PRO' : 'ESS'}
                        </span>
                      )}
                      <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: statusColors[user.status || 'offline'] }} />
                      <ProfileBadges badges={user.badges} size="sm" />
                    </div>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex gap-2 mt-3">
                  {user.id !== currentUserId && friendStatus?.status === 'none' && onAddFriend && (
                    <button type="button" onClick={() => onAddFriend(user)}
                      className="btn-cta flex-1 h-11 rounded-xl flex items-center justify-center gap-1.5 text-[11px] font-semibold">
                      <UserPlus size={12} /> Add friend
                    </button>
                  )}
                </div>
              </div>

              {/* Tab bar */}
              {!isPrivateProfile && (
              <div className="flex border-b border-default px-3 mt-2 sticky bg-panel" style={{ top: 0, zIndex: 5 }}>
                {tabs.map(tab => {
                  const isActive = activeTab === tab.key;
                  return (
                    <button key={tab.key} type="button" onClick={() => setActiveTab(tab.key)}
                      className="flex items-center gap-1 px-2.5 py-2.5 text-[11px] font-semibold transition-colors whitespace-nowrap"
                      style={{
                        color: isActive ? 'var(--cyan-accent)' : 'var(--text-secondary)',
                        opacity: isActive ? 1 : 0.5,
                        borderBottom: isActive ? '2px solid var(--cyan-accent)' : '2px solid transparent',
                        minHeight: '44px',
                      }}>
                      {tab.label}
                      {tab.count !== null && tab.count > 0 && (
                        <span className="text-[9px] px-1.5 py-px rounded-full font-semibold"
                          style={{ backgroundColor: isActive ? 'color-mix(in srgb, var(--cyan-accent) 15%, transparent)' : 'var(--fill-active)', color: isActive ? 'var(--cyan-accent)' : 'var(--text-secondary)' }}>
                          {tab.count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              )}

              {/* Tab content */}
              <div className="p-3 pb-8">
                {isPrivateProfile ? (
                  <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
                    <div className="w-16 h-16 rounded-full bg-fill-hover flex items-center justify-center mb-4">
                      <Lock size={28} className="text-t-secondary" />
                    </div>
                    <h3 className="text-base font-semibold text-t-primary mb-2">
                      {t('profile.privateProfile')}
                    </h3>
                    <p className="text-sm text-t-secondary max-w-xs">
                      {t('profile.privateProfileDesc')}
                    </p>
                  </div>
                ) : (
                  <>
                    {activeTab === 'showcase' && renderShowcaseTab()}
                    {activeTab === 'activity' && renderActivityTab()}
                    {activeTab === 'friends' && renderFriendsTab()}
                    {activeTab === 'servers' && renderServersTab()}
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
        {/* Close button */}
        <button type="button" onClick={onClose}
          className="absolute top-3 right-3 z-10 w-7 h-7 rounded-lg flex items-center justify-center transition-colors text-t-secondary hover:bg-fill-hover"
          style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}>
          <X size={14} />
        </button>

        {/* Full-width banner */}
        <div className="h-[360px] bg-cover relative shrink-0"
          style={(profileData?.banner || user.banner) && sanitizeCssUrl(bannerDisplayUrl)
            ? { backgroundImage: sanitizeCssUrl(bannerDisplayUrl), backgroundPosition: `center ${profileData?.bannerPositionY ?? user.bannerPositionY ?? 50}%`, backgroundSize: ((profileData?.bannerZoom ?? user.bannerZoom ?? 100) > 100 ? `${profileData?.bannerZoom ?? user.bannerZoom}%` : 'cover') }
            : { background: 'linear-gradient(135deg, color-mix(in srgb, var(--cyan-accent) 12%, transparent) 0%, var(--bg-panel) 100%)' }
          }>
          {(profileData?.banner || user.banner) && <div className="absolute inset-0 bg-black/30" />}
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/40" />
        </div>

        {/* Two-column layout below banner */}
        <div className="flex min-h-[440px]" style={{ marginTop: '-48px', position: 'relative', zIndex: 2 }}>
          {/* LEFT PANEL */}
          <div className="w-[300px] shrink-0 flex flex-col border-r glass overflow-hidden">
            {/* Scrollable identity content */}
            <div className="flex-1 overflow-y-auto px-5 pb-4">
              {/* Avatar + status */}
              <div className="relative inline-block mb-3">
                <div className={`relative rounded-[var(--radius-lg)] overflow-hidden ${(user.effectivePlan ?? user.stripePlan) === 'pro' ? getAvatarEffectClass(user.avatarEffect) : ''}`}
                  style={{ width: 88, height: 88 }}>
                  <LetterAvatar avatar={user.avatar} username={formatUsername(user)} />
                </div>
                <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: statusColors[user.status] ?? statusColors.offline }} />
              </div>

              {/* Name + badges */}
              <div className="flex items-center gap-1.5 flex-wrap mb-3">
                {(() => {
                  const isPro = (user.effectivePlan ?? user.stripePlan) === 'pro';
                  const hasProEffects = isPro && (user.nameColor || user.nameFont || user.nameEffect);
                  const hasRoleStyle = user.roleColor || user.role;
                  if (hasRoleStyle || hasProEffects) {
                    return <RoleNameStyle name={formatUsername(user)} color={user.roleColor ?? undefined} style={user.roleStyle ?? 'solid'} overrideColor={user.nameColor ?? undefined} overrideFont={user.nameFont ?? undefined} nameEffect={user.nameEffect ?? undefined} className="text-lg font-black tracking-tight" />;
                  }
                  return <span className="text-lg font-black tracking-tight text-t-primary">{formatUsername(user)}</span>;
                })()}
                <ProfileBadges badges={user.badges} size="sm" />
              </div>

              {/* Action buttons (not self) */}
              {!isSelf && (
                <div className="flex gap-1.5 mb-4">
                  {renderFriendButton()}
                  <div className="relative" ref={moreRef}>
                    <button type="button" onClick={(e) => { e.stopPropagation(); setMoreOpen(v => !v); }}
                      className="p-1.5 rounded-lg border border-[var(--glass-border)] transition-colors text-t-secondary hover:bg-fill-hover">
                      <MoreVertical size={15} />
                    </button>
                    {renderMoreMenu()}
                  </div>
                </div>
              )}

              {/* About Me */}
              {!isPrivateProfile && (profileData?.bio || user.customStatus || user.activityBio) && (
                <div className="border-t border-default pt-3 mb-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest mb-1.5 text-t-secondary" style={{ opacity: 0.5 }}>{t('profile.aboutMe', 'About Me')}</p>
                  <p className="text-xs leading-relaxed text-t-primary" style={{ opacity: 0.8 }}>
                    {profileData?.bio || user.activityBio || user.customStatus}
                  </p>
                </div>
              )}

              {/* Member Since */}
              <div className="border-t border-default pt-3 mb-3">
                <p className="text-[10px] font-bold uppercase tracking-widest mb-2 text-t-secondary" style={{ opacity: 0.5 }}>{t('profile.memberSince', 'Member Since')}</p>
                <div className="flex gap-4">
                  {userCreatedAt && (
                    <div className="flex items-center gap-1.5">
                      <span title={t('profile.howl', { defaultValue: 'Howl' })}>
                        <img src={assetPath('/howl-logo.png')} alt="" className="w-4 h-4 rounded-sm object-cover" loading="lazy" decoding="async" width={16} height={16} />
                      </span>
                      <span className="text-[11px] text-t-secondary">
                        {new Date(userCreatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                    </div>
                  )}
                  {(profileData?.serverJoinedAt || serverJoinedAt) && (
                    <div className="flex items-center gap-1.5">
                      <span title={serverName || ''}>
                        {serverIcon ? (
                          <img src={serverIcon} alt="" className="w-4 h-4 rounded-full object-cover" loading="lazy" decoding="async" width={16} height={16} data-original-src={toOriginalUploadPath(serverIcon)} onError={retryOnExpired} />
                        ) : (
                          <div className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold" style={{ backgroundColor: 'rgba(167,139,250,0.15)', color: '#a78bfa' }}>
                            {(serverName || '?')[0]}
                          </div>
                        )}
                      </span>
                      <span className="text-[11px] text-t-secondary">
                        {new Date(profileData?.serverJoinedAt || serverJoinedAt!).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Roles — server context only. Sorted by hierarchy (lower
                  position = higher rank, like Discord). The /users/:id/profile
                  endpoint already sorts and filters @everyone server-side; the
                  client-side sort here is a defensive fallback for older API
                  responses or `serverRoles` passed via prop. */}
              {((profileData?.serverRoles && profileData.serverRoles.length > 0) || (serverRoles && serverRoles.length > 0)) && (
                <div className="border-t border-default pt-3 mb-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest mb-2 text-t-secondary" style={{ opacity: 0.5 }}>{t('profile.roles')}</p>
                  <div className="flex flex-wrap gap-1">
                    {(profileData?.serverRoles || serverRoles || EMPTY_ROLES)
                      .slice()
                      .sort((a, b) => (a.position ?? 999) - (b.position ?? 999))
                      .map((role, i) => (
                      <span key={role.id ?? i} className="text-[11px] font-medium px-2 py-0.5 rounded-md border"
                        style={{
                          backgroundColor: role.color ? `color-mix(in srgb, ${role.color} 12%, transparent)` : 'var(--fill-hover)',
                          borderColor: role.color ? `color-mix(in srgb, ${role.color} 25%, transparent)` : 'var(--glass-border)',
                          color: role.color || 'var(--text-secondary)',
                        }}>
                        {role.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Linked Apps (filter out SSO-only providers like Google/Apple) */}
              {!isPrivateProfile && (() => {
                const linkedApps = profileData?.connections || EMPTY_CONNECTIONS;
                return linkedApps.length > 0 ? (
                  <div className="border-t border-default pt-3 mb-3">
                    <p className="text-[10px] font-bold uppercase tracking-widest mb-2 text-t-secondary" style={{ opacity: 0.5 }}>{t('profile.linkedApps', 'Linked Apps')}</p>
                    <div className="flex flex-col gap-1">
                      {linkedApps.map((conn, i) => {
                        const profileUrl = buildProviderProfileUrl(conn);
                        const ProviderIcon = PROVIDER_ICONS[conn.provider];
                        const inner = (
                          <div className="flex items-center gap-2 px-2 py-1.5 -mx-2 rounded-lg transition-colors hover:bg-fill-hover cursor-pointer group">
                            <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ backgroundColor: 'var(--fill-hover)' }}>
                              {ProviderIcon ? (
                                <ProviderIcon size={12} className="opacity-60" />
                              ) : (
                                <Gamepad2 size={12} className="opacity-60" />
                              )}
                            </div>
                            <span className="text-xs transition-colors text-t-secondary group-hover:text-t-primary truncate flex-1">
                              {conn.displayName || conn.provider.charAt(0).toUpperCase() + conn.provider.slice(1)}
                            </span>
                            {profileUrl && <ExternalLink size={10} className="opacity-0 group-hover:opacity-40 transition-opacity text-t-secondary shrink-0" />}
                          </div>
                        );
                        return profileUrl ? (
                          <a key={i} href={profileUrl} target="_blank" rel="noopener noreferrer" className="no-underline" style={{ textDecoration: 'none' }}>
                            {inner}
                          </a>
                        ) : (
                          <div key={i}>{inner}</div>
                        );
                      })}
                    </div>
                  </div>
                ) : null;
              })()}
            </div>

          </div>

          {/* RIGHT PANEL */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden glass">
            {/* Tab bar */}
            {!isPrivateProfile && (
            <div className="flex gap-0 border-b border-default px-5 shrink-0">
              {tabs.map(tab => {
                const isActive = activeTab === tab.key;
                return (
                  <button key={tab.key} type="button" onClick={() => setActiveTab(tab.key)}
                    className="flex items-center gap-1.5 px-4 py-3 text-xs font-semibold transition-colors whitespace-nowrap"
                    style={{
                      color: isActive ? 'var(--cyan-accent)' : 'var(--text-secondary)',
                      opacity: isActive ? 1 : 0.5,
                      borderBottom: isActive ? '2px solid var(--cyan-accent)' : '2px solid transparent',
                    }}>
                    {tab.label}
                    {tab.count !== null && tab.count > 0 && (
                      <span className="text-[10px] px-1.5 py-px rounded-full font-semibold"
                        style={{ backgroundColor: isActive ? 'color-mix(in srgb, var(--cyan-accent) 15%, transparent)' : 'var(--fill-active)', color: isActive ? 'var(--cyan-accent)' : 'var(--text-secondary)' }}>
                        {tab.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            )}

            {/* Tab content — scrollable */}
            <div className="flex-1 overflow-y-auto p-5">
              {isPrivateProfile ? (
                <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
                  <div className="w-16 h-16 rounded-full bg-fill-hover flex items-center justify-center mb-4">
                    <Lock size={28} className="text-t-secondary" />
                  </div>
                  <h3 className="text-base font-semibold text-t-primary mb-2">
                    {t('profile.privateProfile')}
                  </h3>
                  <p className="text-sm text-t-secondary max-w-xs">
                    {t('profile.privateProfileDesc')}
                  </p>
                </div>
              ) : (
                <>
                  {activeTab === 'showcase' && renderShowcaseTab()}
                  {activeTab === 'activity' && renderActivityTab()}
                  {activeTab === 'friends' && renderFriendsTab()}
                  {activeTab === 'servers' && renderServersTab()}
                </>
              )}
            </div>
          </div>
        </div>
          </>
        )}
      </div>
    </div>
  );
});
