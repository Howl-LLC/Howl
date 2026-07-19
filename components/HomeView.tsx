// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { isElectron as detectElectron } from '../config';

import { useTranslation } from 'react-i18next';
import { longPressBindings } from '../hooks/useLongPress';
import { Heart, MessageSquare, X, Mail, Users, Megaphone, Gamepad2, Music, ChevronLeft, ChevronRight } from 'lucide-react';
import { User, ActivityHistoryEntry } from '../types';
import { useAuthStore, useSocialStore, useDmStore, useAppStore } from '../stores';
import { UserAvatar } from './UserAvatar';
import { FriendNameLabel } from './FriendsView';
import { apiClient } from '../services/api';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { useTypingStore } from '../stores/typingStore';
import { TypingStatusDot } from './TypingStatusDot';
import { assetPath } from '../utils/assetPath';
import { DownloadAppBanner } from './DownloadAppBanner';

interface HomeViewProps {
  onNavigateToDM?: (userId: string) => void;
  onFriendRightClick?: (user: User, e: React.MouseEvent) => void;
  onNavigateToFriends?: () => void;
  showGameLibrary?: boolean;
  onNavigateToSettings?: () => void;
}

const isElectron = detectElectron();

function getRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  const diffWeeks = Math.floor(diffDays / 7);
  return `${diffWeeks}w ago`;
}

function GameImage({ src, alt, className, fallback, fallbackSrc, fallbackClassName }: { src: string; alt: string; className: string; fallback: React.ReactNode; fallbackSrc?: string; fallbackClassName?: string }) {
  const [stage, setStage] = React.useState<'primary' | 'fallback' | 'failed'>('primary');
  React.useEffect(() => { setStage('primary'); }, [src]);
  if (stage === 'failed' || !src) return <>{fallback}</>;
  const activeSrc = stage === 'fallback' && fallbackSrc ? fallbackSrc : src;
  const activeClass = stage === 'fallback' && fallbackClassName ? fallbackClassName : className;
  return <img src={activeSrc} alt={alt} className={activeClass} onError={() => { if (stage === 'primary' && fallbackSrc) setStage('fallback'); else setStage('failed'); }} loading="lazy" decoding="async" />;
}

/* ── Memoized friend card (extracted for hooks in .map()) ── */

const HomeFriendCard = React.memo(function HomeFriendCard({
  friend,
  onNavigateToDM,
  onFriendRightClick,
}: {
  friend: User;
  onNavigateToDM?: (userId: string) => void;
  onFriendRightClick?: (user: User, e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const isFriendTyping = useTypingStore(
    useCallback(
      (s: { typingDmUsers: Record<string, number> }) => s.typingDmUsers[friend.id] !== undefined,
      [friend.id]
    )
  );

  return (
    <button
      type="button"
      onClick={() => onNavigateToDM?.(friend.id)}
      {...(onFriendRightClick ? longPressBindings((e) => { e.preventDefault(); onFriendRightClick(friend, e); }) : {})}
      className="flex items-center gap-3 p-3 rounded-xl border border-default bg-fill-hover hover:border-[var(--cyan-accent)]/20 hover:bg-fill-hover transition-all text-left group"
    >
      <UserAvatar user={friend} size={36}>
        <TypingStatusDot
          status={friend.status}
          isTyping={isFriendTyping}
          size={12}
          className="absolute -bottom-0.5 -right-0.5"
        />
      </UserAvatar>
      <div className="flex-1 min-w-0">
        <FriendNameLabel
          user={friend}
          className="text-xs font-bold truncate group-hover:text-[var(--cyan-accent)] transition-colors"
        />
        {friend.activity && friend.activity.type !== 'bio' ? (
          <p className="text-[10px] truncate flex items-center gap-1" style={{ color: friend.activity.type === 'spotify' ? '#1DB954' : friend.activity.type === 'twitch_live' ? '#9146FF' : friend.activity.type === 'youtube_live' ? '#FF0000' : 'var(--cyan-accent)' }}>
            {friend.activity.type === 'spotify'
              ? <Music size={10} className="shrink-0" />
              : friend.activity.type === 'twitch_live' || friend.activity.type === 'youtube_live'
              ? <span className="shrink-0 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              : <Gamepad2 size={10} className="shrink-0" />
            }
            <span className="truncate">{friend.activity.type === 'twitch_live' || friend.activity.type === 'youtube_live' ? `${friend.activity.name}${friend.activity.state ? ` · ${friend.activity.state}` : ''}` : friend.activity.name}</span>
          </p>
        ) : (
          <p className="text-[10px] capitalize text-t-secondary">
            {friend.status === 'dnd' ? t('home.doNotDisturb') : friend.status}
          </p>
        )}
      </div>
    </button>
  );
});

export const HomeView: React.FC<HomeViewProps> = React.memo(({ onNavigateToDM, onFriendRightClick, onNavigateToFriends, showGameLibrary = true, onNavigateToSettings }) => {
  const { t } = useTranslation();
  const currentUser = useAuthStore(s => s.currentUser);
  const hasSteamLinked = useAuthStore(s => s.hasSteamLinked);
  const friends = useSocialStore(s => s.homeFriends);
  const dmChannels = useDmStore(s => s.dmChannels);
  const updateAvailable = useAppStore(s => s.updateAvailable);
  const updateDownloading = useAppStore(s => s.updateDownloading);
  const updateReady = useAppStore(s => s.updateReady);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [donateOpen, setDonateOpen] = useState(false);
  const [activityHistory, setActivityHistory] = useState<ActivityHistoryEntry[]>([]);
  const activityScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    if (showGameLibrary) {
      apiClient.activityHistory().then(setActivityHistory).catch(() => {});
    }
  }, [showGameLibrary]);

  const onlineFriends = useMemo(() => {
    const online = friends.filter(f => f.status === 'online' || f.status === 'idle' || f.status === 'dnd');

    const lastDmTime = new Map<string, number>();
    for (const ch of dmChannels) {
      if (ch.otherUser?.id && ch.lastMessage?.createdAt) {
        lastDmTime.set(ch.otherUser.id, new Date(ch.lastMessage.createdAt).getTime());
      }
    }

    return online.sort((a, b) => {
      const ta = lastDmTime.get(a.id) ?? 0;
      const tb = lastDmTime.get(b.id) ?? 0;
      if (ta !== tb) return tb - ta;
      return a.username.localeCompare(b.username);
    });
  }, [friends, dmChannels]);

  const recentActivities = useMemo(() => {
    const items: Array<{ name: string; type: string; details?: string | null; state?: string | null; largeImage?: string | null; platform?: string | null; platformId?: string | null; startedAt: string; endedAt?: string | null; isLive: boolean; durationMs?: number | null }> = [];

    // Current activity first (if any)
    if (currentUser?.activity && currentUser.activity.type !== 'bio') {
      items.push({
        name: currentUser.activity.name, type: currentUser.activity.type,
        details: currentUser.activity.details, state: currentUser.activity.state,
        largeImage: currentUser.activity.largeImage, platform: currentUser.activity.platform,
        platformId: currentUser.activity.platformId, startedAt: currentUser.activity.startedAt,
        endedAt: null, isLive: true, durationMs: currentUser.activity.durationMs,
      });
    }

    // Add history, skip duplicates by name, limit ONE spotify entry total
    const hasSpotify = items.some(i => i.type === 'spotify');
    for (const h of activityHistory) {
      if (items.length >= 8) break;
      if (items.some(i => i.name === h.name)) continue;
      if (h.type === 'spotify' && (hasSpotify || items.some(i => i.type === 'spotify'))) continue;
      items.push({
        name: h.name, type: h.type, details: h.details, state: null,
        largeImage: h.largeImage, platform: h.platform, platformId: h.platformId,
        startedAt: h.startedAt, endedAt: h.endedAt ?? null, isLive: false, durationMs: null,
      });
    }

    return items;
  }, [currentUser?.activity, activityHistory]);

  const updateScrollArrows = useCallback(() => {
    const el = activityScrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    updateScrollArrows();
    const el = activityScrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateScrollArrows, { passive: true });
    const ro = new ResizeObserver(updateScrollArrows);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateScrollArrows);
      ro.disconnect();
    };
  }, [recentActivities, updateScrollArrows]);

  const scrollActivities = useCallback((direction: 'left' | 'right') => {
    const el = activityScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction === 'left' ? -el.clientWidth : el.clientWidth, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setFeedbackOpen(false); setDonateOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex-1 flex overflow-hidden animate-in fade-in duration-300 relative">
      {/* Main content — ambient gradient orbs removed (the page sits flush on
          var(--bg-app) like the rest of the in-app surfaces; no glow, no
          rainbow radial bleed). */}
      <div className="flex-1 overflow-y-auto relative z-[1]">
        <div className="p-6 sm:p-8 lg:p-12 max-w-6xl 2xl:max-w-7xl mx-auto space-y-10">

          {/* Header row */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-5">
              <img src={assetPath('/howl-logo.png')} alt="Howl" className="h-16 w-16 sm:h-20 sm:w-20 rounded-[20px] object-cover shrink-0 shadow-[0_0_24px_color-mix(in srgb, var(--cyan-accent) 15%, transparent)]" loading="lazy" decoding="async" />
              <div>
                <h1 className="font-clash text-4xl sm:text-5xl font-semibold text-t-primary tracking-[-0.02em]">Howl</h1>
              </div>
            </div>

            {/* Top-right actions */}
            <div className="flex flex-wrap items-center justify-end gap-2 min-w-0">
              {(updateAvailable || updateReady) && (
                <button
                  type="button"
                  onClick={() => {
                    if (updateReady) {
                      window.electron?.restartForUpdate?.();
                    } else if (!updateDownloading) {
                      useAppStore.getState().setUpdateDownloading(true);
                      window.electron?.checkForUpdate?.();
                    }
                  }}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border transition-all relative"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--cyan-accent) 20%, transparent)',
                    background: 'color-mix(in srgb, var(--cyan-accent) 8%, transparent)',
                    color: 'var(--cyan-accent)',
                  }}
                >
                  {!updateDownloading && !updateReady && (
                    <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--cyan-accent)' }} />
                  )}
                  {updateDownloading ? (
                    <>
                      <span className="w-3.5 h-3.5 rounded-full border-[1.5px] border-current/20 border-t-current animate-spin" />
                      Updating...
                    </>
                  ) : updateReady ? (
                    <>
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      Restart
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="8 12 12 16 16 12"/><line x1="12" y1="8" x2="12" y2="16"/></svg>
                      Update Available
                    </>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => setFeedbackOpen(true)}
                className="btn-cta flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
              >
                <MessageSquare size={13} /> {t('home.feedback')}
              </button>
              <button
                type="button"
                onClick={() => setDonateOpen(true)}
                className="btn-cta flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
                style={{ background: '#ec4899' }}
              >
                <Heart size={13} /> {t('home.supportUs')}
              </button>
            </div>
          </div>

          {/* Web-only: prompt the user to install the native desktop app.
              Renders nothing in Electron or on mobile (see component). */}
          <DownloadAppBanner />

          <div className="space-y-10">
              {/* Sponsor Banner */}
              <section className="rounded-2xl border backdrop-blur-xl p-5 glass" style={{ backgroundColor: 'color-mix(in srgb, var(--glass-bg) 85%, transparent)' }}>
                <div className="flex items-center gap-4 mb-4">
                  <h2 className="text-t-primary text-sm font-semibold tracking-tight flex items-center shrink-0">
                    <Megaphone size={14} className="text-[var(--cyan-accent)] mr-2" /> {t('home.sponsorBannerTitle')}
                  </h2>
                  <div className="h-px flex-1 bg-gradient-to-r from-white/[0.06] to-transparent" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {[0, 1, 2].map((i) => (
                    <a
                      key={i}
                      href="mailto:support@howlpro.com?subject=Sponsorship%20Inquiry"
                      className="border border-default rounded-xl min-h-[160px] flex flex-col items-center justify-center gap-2 transition-all hover:border-[var(--cyan-accent)]/20 hover:bg-fill-hover group"
                      style={{ backgroundColor: 'var(--fill-hover)' }}
                    >
                      <Megaphone size={20} className="text-t-secondary opacity-30 group-hover:text-[var(--cyan-accent)]/30 transition-colors" />
                      <span className="text-t-secondary opacity-40 text-[10px] font-medium group-hover:opacity-60 transition-colors">{t('home.sponsorSlotAvailable')}</span>
                    </a>
                  ))}
                </div>
                <p className="text-[10px] text-center mt-3 text-t-secondary">
                  {t('home.sponsorContactCta')} <a href="mailto:support@howlpro.com" className="text-[var(--cyan-accent)] hover:underline">support@howlpro.com</a>
                </p>
              </section>

              {/* Online Friends */}
              <section className="rounded-2xl border backdrop-blur-xl p-6 glass" style={{ backgroundColor: 'color-mix(in srgb, var(--glass-bg) 85%, transparent)' }}>
                <div className="flex items-center gap-4 mb-5">
                  <h2 className="text-t-primary text-sm font-semibold tracking-tight flex items-center shrink-0">
                    <Users size={16} className="text-[var(--cyan-accent)] mr-2.5" /> {t('home.friendsOnline')}
                  </h2>
                  <div className="h-px flex-1 bg-gradient-to-r from-white/[0.06] to-transparent" />
                  {onlineFriends.length > 0 && (
                    <span className="text-[10px] font-bold tabular-nums text-t-secondary">{onlineFriends.length}</span>
                  )}
                </div>

                {/* 2-col grid, max 2 rows (4 items). Empty state matches populated height. */}
                <div>
                  {onlineFriends.length === 0 ? (
                    <div className="grid grid-cols-2 gap-3">
                      {/* Invisible spacer row so the section doesn't collapse */}
                      <div className="col-span-2 rounded-xl p-6 flex flex-col items-center justify-center text-center border border-[var(--glass-border)]" style={{ backgroundColor: 'var(--fill-hover)' }}>
                        <div className="w-10 h-10 rounded-full bg-fill-hover flex items-center justify-center mb-2">
                          <Users size={18} className="text-t-secondary opacity-40" />
                        </div>
                        <p className="text-sm font-medium mb-0.5 text-t-primary">{t('home.noFriendsOnline')}</p>
                        <p className="text-[11px] text-t-secondary">{t('home.friendsOnlineDescription')}</p>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        {onlineFriends.slice(0, 6).map((friend) => (
                          <HomeFriendCard
                            key={friend.id}
                            friend={friend}
                            onNavigateToDM={onNavigateToDM}
                            onFriendRightClick={onFriendRightClick}
                          />
                        ))}
                      </div>
                      {onlineFriends.length > 6 && onNavigateToFriends && (
                        <button
                          type="button"
                          onClick={onNavigateToFriends}
                          className="w-full mt-3 py-2 text-center text-xs font-semibold hover:bg-fill-hover rounded-lg transition-colors text-t-accent"
                        >
                          {t('home.seeAllOnline', { count: onlineFriends.length, defaultValue: `See all ${onlineFriends.length} online` })}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </section>

              {/* Activity Library */}
              {showGameLibrary && (
                <section className="rounded-2xl border backdrop-blur-xl p-6 glass" style={{ backgroundColor: 'color-mix(in srgb, var(--glass-bg) 85%, transparent)' }}>
                  <div className="flex items-center gap-4 mb-5">
                    <h2 className="text-t-primary text-sm font-semibold tracking-tight flex items-center shrink-0">
                      <Gamepad2 size={16} className="text-[var(--cyan-accent)] mr-2.5" /> {t('home.activityLibrary')}
                    </h2>
                    <div className="h-px flex-1 bg-gradient-to-r from-white/[0.06] to-transparent" />
                  </div>
                  <div style={{ minHeight: 120 }}>
                    {recentActivities.length > 0 ? (
                      <>
                        <div className="relative">
                          {canScrollLeft && (
                            <button type="button" onClick={() => scrollActivities('left')}
                              className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full flex items-center justify-center backdrop-blur-md border border-[var(--glass-border)] transition-all hover:bg-fill-hover hover:scale-110 bg-floating">
                              <ChevronLeft size={16} className="text-t-primary" />
                            </button>
                          )}
                          {canScrollRight && (
                            <button type="button" onClick={() => scrollActivities('right')}
                              className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full flex items-center justify-center backdrop-blur-md border border-[var(--glass-border)] transition-all hover:bg-fill-hover hover:scale-110 bg-floating">
                              <ChevronRight size={16} className="text-t-primary" />
                            </button>
                          )}
                          <div
                            ref={activityScrollRef}
                            className="flex gap-3 overflow-x-auto no-scrollbar scroll-smooth"
                            style={{ scrollSnapType: 'x mandatory' }}
                          >
                            {recentActivities.map((act) => {
                              const imgSrc = sanitizeImgSrc(act.largeImage)
                                || (act.platform === 'steam' && act.platformId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${act.platformId}/library_600x900.jpg` : '');
                              const steamFallbackSrc = !sanitizeImgSrc(act.largeImage) && act.platform === 'steam' && act.platformId
                                ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${act.platformId}/header.jpg` : undefined;
                              const isSpotify = act.type === 'spotify';
                              const accentColor = isSpotify ? '#1DB954' : 'var(--cyan-accent)';
                              return (
                                <div
                                  key={act.name}
                                  className="relative rounded-xl overflow-hidden transition-all shrink-0"
                                  style={{
                                    width: 'calc(25% - 9px)', minWidth: '160px', scrollSnapAlign: 'start',
                                    border: act.isLive ? `1px solid ${isSpotify ? 'rgba(29,185,52,0.3)' : 'rgba(6,182,212,0.3)'}` : '1px solid var(--border-subtle)',
                                  }}
                                >
                                  {/* Blurred background */}
                                  <div style={{ position: 'relative', overflow: 'hidden', height: '100%' }}>
                                    {imgSrc ? (
                                      <img src={imgSrc} alt="" loading="lazy" decoding="async" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(14px) brightness(0.35) saturate(1.3)', transform: 'scale(1.4)' }} />
                                    ) : (
                                      <div style={{ position: 'absolute', inset: 0, background: act.isLive ? (isSpotify ? 'rgba(29,185,52,0.08)' : 'rgba(6,182,212,0.08)') : 'var(--overlay-backdrop)' }} />
                                    )}
                                    <div style={{ position: 'relative', zIndex: 1, padding: '10px', display: 'flex', flexDirection: 'column', height: '100%' }}>
                                      {/* Live indicator — consistent height wrapper */}
                                      <div style={{ minHeight: 20 }} className="mb-2">
                                        {act.isLive ? (
                                          <div className="flex items-center gap-1">
                                            {isSpotify
                                              ? <svg width={10} height={10} viewBox="0 0 496 512" fill="#1DB954"><path d="M248 8C111.1 8 0 119.1 0 256s111.1 248 248 248 248-111.1 248-248S384.9 8 248 8zm100.7 364.9c-4.2 6.6-12.9 8.6-19.5 4.4-53.5-32.7-120.8-40.1-200.1-22-7.6 1.7-15.3-3-17-10.7-1.7-7.6 3-15.3 10.7-17 86.7-19.8 161.1-11.3 221.1 25.5 6.6 4.1 8.6 12.8 4.4 19.4l.4-.6zm26.8-68.9c-5.2 8.4-16.2 11-24.6 5.8-61.2-37.6-154.5-48.5-226.9-26.5-9.2 2.8-18.9-2.4-21.7-11.6-2.8-9.2 2.4-18.9 11.6-21.7 82.6-25.2 185.3-13 254.4 30.3 8.4 5.1 11 16.2 5.8 24.6l.4-1zm2.3-71.8C310.6 196.3 180.5 192 105 213.4c-11 3.4-22.7-2.8-26.1-13.8-3.4-11 2.8-22.7 13.8-26.1 86.7-24.6 230.7-19.9 321.9 30.2 9.9 5.9 13.1 18.8 7.2 28.7-5.9 9.9-18.8 13.1-28.7 7.2l-.3-.3z"/></svg>
                                              : <Gamepad2 size={10} className="text-t-accent" />
                                            }
                                            <span className="text-[8px] font-semibold uppercase" style={{ color: isSpotify ? '#1DB954' : 'var(--cyan-accent)', letterSpacing: '0.07em' }}>
                                              {isSpotify ? t('activity.listeningTo', { defaultValue: 'Listening to Spotify' }) : t('activity.nowPlaying', { defaultValue: 'Now Playing' })}
                                            </span>
                                          </div>
                                        ) : null}
                                      </div>
                                      {/* Large image on top */}
                                      <GameImage
                                        src={imgSrc}
                                        alt={act.name}
                                        className="w-full aspect-square rounded-lg object-cover mb-2.5 border border-[var(--glass-border)]"
                                        fallbackSrc={steamFallbackSrc}
                                        fallbackClassName="w-full aspect-square rounded-lg object-contain mb-2.5 border border-[var(--glass-border)] bg-black/40"
                                        fallback={
                                          <div className="w-full aspect-square rounded-lg flex items-center justify-center mb-2.5"
                                            style={{ backgroundColor: act.isLive ? `${accentColor}14` : 'var(--fill-hover)' }}>
                                            {isSpotify
                                              ? <Music size={28} style={{ color: act.isLive ? '#1DB954' : 'var(--text-secondary)', opacity: act.isLive ? 0.8 : 0.25 }} />
                                              : <Gamepad2 size={28} style={{ color: act.isLive ? 'var(--cyan-accent)' : 'var(--text-secondary)', opacity: act.isLive ? 0.8 : 0.25 }} />
                                            }
                                          </div>
                                        }
                                      />
                                      {/* Details pushed to bottom */}
                                      <p className="text-[11px] font-semibold truncate mt-auto" style={{ color: '#fff' }}>{act.name}</p>
                                      {isSpotify && act.details && (
                                        <p className="text-[9px] truncate mt-0.5" style={{ color: 'var(--text-secondary)' }}>{act.details}</p>
                                      )}
                                      <p className="text-[9px] truncate mt-0.5" style={{ color: act.isLive ? accentColor : 'var(--text-faint)' }}>
                                        {act.isLive
                                          ? (isSpotify ? '' : (act.platform === 'steam' ? t('activity.steamGame', { defaultValue: 'via Steam' }) : ''))
                                          : act.endedAt
                                            ? getRelativeTime(act.endedAt)
                                            : act.platform === 'steam'
                                              ? t('activity.steamGame', { defaultValue: 'via Steam' })
                                              : t('activity.recentlyPlayed', { defaultValue: 'Recently played' })
                                        }
                                      </p>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-col items-center justify-center gap-3 text-t-secondary min-h-[120px]">
                        <Gamepad2 size={36} className="opacity-20" />
                        <p className="text-sm font-medium text-center opacity-50">
                          {isElectron
                            ? t('home.noGamesElectron', { defaultValue: 'Launch a game and it\u2019ll appear here automatically.' })
                            : t('home.noGamesWeb', { defaultValue: 'Use the Howl desktop app to detect games, or connect Steam.' })
                          }
                        </p>
                        {!isElectron && !hasSteamLinked && onNavigateToSettings && (
                          <button
                            type="button"
                            onClick={onNavigateToSettings}
                            className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 text-[11px]"
                          >
                            <img src={assetPath('/sso-steam.svg')} alt="" className="w-3 h-3 opacity-70" loading="lazy" decoding="async" width={12} height={12} /> {t('home.connectSteam', { defaultValue: 'Connect Steam' })}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </section>
              )}
          </div>

        </div>
      </div>


      {/* Feedback popup */}
      {feedbackOpen && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[var(--overlay-backdrop)] backdrop-blur-sm" onClick={() => setFeedbackOpen(false)} />
          <div className="relative w-full max-w-md border border-[var(--glass-border)] rounded-2xl shadow-2xl overflow-hidden spring-pop-in bg-floating">
            <div className="flex items-center justify-between p-5 border-b border-[var(--glass-border)]">
              <h3 className="text-sm font-semibold text-t-primary flex items-center gap-2">
                <MessageSquare size={16} className="text-[var(--cyan-accent)]" /> {t('home.sendFeedback')}
              </h3>
              <button type="button" onClick={() => setFeedbackOpen(false)} className="p-1 rounded-lg hover:bg-fill-hover transition-all text-t-secondary"><X size={16} /></button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-[11px] text-t-secondary">{t('home.sendFeedbackDescription', { defaultValue: 'Have feedback, a bug report, or a feature request? Send us an email and we\'ll get back to you.' })}</p>
              <div className="flex items-center justify-center py-6">
                <a
                  href="mailto:support@howlpro.com"
                  className="flex items-center gap-2.5 px-5 py-3 rounded-xl text-sm font-semibold bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/20 hover:bg-[var(--cyan-accent)]/15 hover:border-[var(--cyan-accent)]/30 transition-all text-[var(--cyan-accent)]"
                >
                  <Mail size={16} />
                  support@howlpro.com
                </a>
              </div>
              <p className="text-[10px] text-center" style={{ color: 'rgba(148,163,184,0.4)' }}>
                {t('home.feedbackEmailNote', { defaultValue: 'We read every email and typically respond within 24 hours.' })}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Donate popup */}
      {donateOpen && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[var(--overlay-backdrop)] backdrop-blur-sm" onClick={() => setDonateOpen(false)} />
          <div className="relative w-full max-w-md border border-[var(--glass-border)] rounded-2xl shadow-2xl overflow-hidden spring-pop-in bg-floating">
            <div className="flex items-center justify-between p-5 border-b border-[var(--glass-border)]">
              <h3 className="text-sm font-semibold text-t-primary flex items-center gap-2">
                <Heart size={16} className="text-pink-400" /> {t('home.supportHowlTitle')}
              </h3>
              <button type="button" onClick={() => setDonateOpen(false)} className="p-1 rounded-lg hover:bg-fill-hover transition-all text-t-secondary"><X size={16} /></button>
            </div>
            <div className="p-6 space-y-5">
              <div className="text-center">
                <div className="w-14 h-14 rounded-2xl bg-pink-500/10 border border-pink-500/20 flex items-center justify-center mx-auto mb-4">
                  <Heart size={24} className="text-pink-400" />
                </div>
                <p className="text-sm font-bold text-t-primary mb-2">{t('home.supportHowlTagline')}</p>
                <p className="text-[11px] leading-relaxed text-t-secondary">
                  {t('home.supportHowlDescription')}
                </p>
              </div>
              {/* Donate button only renders when VITE_DONATE_URL is baked into
                  the build (a static Stripe donation-page URL). If unset, the
                  whole button is hidden so the modal doesn't dangle a broken
                  action. Set VITE_DONATE_URL=https://donate.stripe.com/<id>
                  in .env before building. */}
              {(() => {
                const donateUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DONATE_URL) || '';
                let validUrl: URL | null = null;
                try {
                  if (donateUrl) {
                    const parsed = new URL(donateUrl);
                    if (parsed.protocol === 'https:') validUrl = parsed;
                  }
                } catch { /* invalid — treat as unset */ }
                if (!validUrl) return null;
                return (
                  <button
                    type="button"
                    onClick={() => {
                      // In Electron, prefer the explicit openExternal IPC (uses
                      // a Stripe-domain allowlist). In web, open a new tab.
                      const w = window as unknown as { electron?: { openExternal?: (u: string) => Promise<{ success: boolean }> } };
                      if (w.electron?.openExternal) {
                        w.electron.openExternal(validUrl!.href).then((r) => {
                          if (!r?.success) window.open(validUrl!.href, '_blank', 'noopener,noreferrer');
                        }).catch(() => {
                          window.open(validUrl!.href, '_blank', 'noopener,noreferrer');
                        });
                      } else {
                        window.open(validUrl!.href, '_blank', 'noopener,noreferrer');
                      }
                      setDonateOpen(false);
                    }}
                    className="w-full py-3 rounded-xl text-xs font-semibold bg-gradient-to-r from-pink-500 to-rose-500 text-white hover:from-pink-400 hover:to-rose-400 transition-all flex items-center justify-center gap-2"
                  >
                    <Heart size={14} /> {t('home.donateViaStripe')}
                  </button>
                );
              })()}
              <p className="text-[10px] text-center text-t-secondary opacity-50">{t('home.supportHowlClosing')}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
