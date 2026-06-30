// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Lock, Loader2, Layout, ExternalLink } from 'lucide-react';
import type { UserWithRole } from './UserProfilePopup';
import { formatUsername, User } from '../types';
import { LetterAvatar } from './LetterAvatar';
import { ProfileBadges } from './ProfileBadges';
import { RoleNameStyle } from './RoleNameStyle';
import { ShowcaseGrid } from './showcase/ShowcaseGrid';
import { getAvatarEffectClass } from '../shared/planPerks';
import { STATUS_COLORS as statusColors } from '../shared/statusColors';
import { sanitizeCssUrl } from '../utils/securityUtils';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { useGifFrameUrl } from '../hooks/useGifFrameUrl';
import { useAuthStore } from '../stores/authStore';
import { useProfileData } from '../hooks/useProfileData';

export interface DMProfilePanelProps {
  user: UserWithRole;
  onViewFullProfile: (user: UserWithRole) => void;
  /** When provided (group DM), renders a back arrow that returns to the member list. */
  onBack?: () => void;
}

export function DMProfilePanel({ user, onViewFullProfile, onBack }: DMProfilePanelProps) {
  const { t } = useTranslation();
  const currentUserId = useAuthStore(s => s.currentUser)?.id ?? '';
  const isSelf = user.id === currentUserId;
  const { showcaseData, showcaseLoading, mutualFriends, mutualServers, profileData, spotifyProfile } = useProfileData(user.id, { isSelf });

  const isPrivateProfile = !isSelf && profileData?.private === true;
  const isPro = (user.effectivePlan ?? user.stripePlan) === 'pro';
  const bannerSrc = profileData?.banner || user.banner;
  const bannerDisplayUrl = useGifFrameUrl(bannerSrc);
  const bio = profileData?.bio || user.activityBio || user.customStatus;
  const status = (user.status as User['status']) ?? 'offline';

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto" style={{ backgroundColor: 'var(--bg-chat)' }}>
      {onBack && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-default shrink-0 sticky top-0 z-10" style={{ backgroundColor: 'var(--bg-chat)' }}>
          <button type="button" onClick={onBack} className="p-1.5 rounded-lg hover:bg-fill-hover transition-colors text-t-secondary" aria-label={t('common.back', 'Back')}>
            <ArrowLeft size={18} />
          </button>
          <span className="text-sm font-semibold text-t-primary truncate">{formatUsername(user)}</span>
        </div>
      )}

      {/* Banner */}
      <div
        className="h-24 bg-cover bg-center relative shrink-0"
        style={bannerSrc && sanitizeCssUrl(bannerDisplayUrl)
          ? { backgroundImage: sanitizeCssUrl(bannerDisplayUrl), backgroundPosition: `center ${profileData?.bannerPositionY ?? user.bannerPositionY ?? 50}%` }
          : { background: 'linear-gradient(135deg, color-mix(in srgb, var(--cyan-accent) 12%, transparent) 0%, var(--bg-panel) 100%)' }}
      />

      {/* Avatar + name */}
      <div className="px-4 -mt-8">
        <div className="relative inline-block mb-2">
          <div className={`relative rounded-[var(--radius-lg)] overflow-hidden border-4 ${isPro ? getAvatarEffectClass(user.avatarEffect) : ''}`} style={{ width: 72, height: 72, borderColor: 'var(--bg-chat)' }}>
            <LetterAvatar avatar={user.avatar} username={formatUsername(user)} />
          </div>
          <div className="absolute bottom-0 right-0 w-4 h-4 rounded-full border-2" style={{ backgroundColor: statusColors[status] ?? statusColors.offline, borderColor: 'var(--bg-chat)' }} />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap mb-1">
          {(() => {
            const hasProEffects = isPro && (user.nameColor || user.nameFont || user.nameEffect);
            const hasRoleStyle = user.roleColor || user.role;
            if (hasRoleStyle || hasProEffects) {
              return <RoleNameStyle name={formatUsername(user)} color={user.roleColor ?? undefined} style={user.roleStyle ?? 'solid'} overrideColor={user.nameColor ?? undefined} overrideFont={user.nameFont ?? undefined} nameEffect={user.nameEffect ?? undefined} className="text-base font-black tracking-tight" />;
            }
            return <span className="text-base font-black tracking-tight text-t-primary">{formatUsername(user)}</span>;
          })()}
          <ProfileBadges badges={user.badges} size="sm" />
        </div>
      </div>

      {isPrivateProfile ? (
        <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
          <div className="w-14 h-14 rounded-full bg-fill-hover flex items-center justify-center mb-3"><Lock size={24} className="text-t-secondary" /></div>
          <h3 className="text-sm font-semibold text-t-primary mb-1">{t('profile.privateProfile', 'Private Profile')}</h3>
          <p className="text-xs text-t-secondary max-w-[220px]">{t('profile.privateProfileDesc', 'This user keeps their profile private.')}</p>
        </div>
      ) : (
        <div className="px-4 pb-6 flex flex-col gap-4 mt-2">
          {bio && (
            <div className="border-t border-default pt-3">
              <p className="text-[10px] font-bold uppercase tracking-widest mb-1.5 text-t-secondary" style={{ opacity: 0.5 }}>{t('profile.aboutMe', 'About Me')}</p>
              <p className="text-xs leading-relaxed text-t-primary" style={{ opacity: 0.8 }}>{bio}</p>
            </div>
          )}

          {profileData?.createdAt && (
            <div className="border-t border-default pt-3">
              <p className="text-[10px] font-bold uppercase tracking-widest mb-1 text-t-secondary" style={{ opacity: 0.5 }}>{t('profile.memberSince', 'Member Since')}</p>
              <p className="text-xs text-t-primary" style={{ opacity: 0.8 }}>{new Date(profileData.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</p>
            </div>
          )}

          {user.activity && (
            <div className="border-t border-default pt-3">
              <p className="text-[10px] font-bold uppercase tracking-widest mb-1.5 text-t-secondary" style={{ opacity: 0.5 }}>{t('profile.currentActivity', 'Activity')}</p>
              <p className="text-xs font-semibold text-t-primary truncate">{user.activity.name}</p>
              {user.activity.details && <p className="text-[11px] text-t-secondary truncate">{user.activity.details}</p>}
            </div>
          )}

          {/* Showcase */}
          <div className="border-t border-default pt-3">
            {showcaseLoading ? (
              <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin text-t-secondary" style={{ opacity: 0.3 }} /></div>
            ) : showcaseData && showcaseData.layout.length > 0 ? (
              <ShowcaseGrid
                layout={showcaseData.layout}
                mobileLayout={showcaseData.mobileLayout ?? null}
                gameAccounts={showcaseData.gameAccounts}
                spotifyData={spotifyProfile}
                spotifyActivity={user.activity?.type === 'spotify' ? user.activity : null}
                steamPlaytime={showcaseData.steamPlaytime}
                steamRecentActivity={showcaseData.steamRecentActivity}
                platformProfiles={showcaseData.platformProfiles}
              />
            ) : (
              <div className="flex flex-col items-center justify-center py-8 rounded-xl border border-dashed" style={{ borderColor: 'var(--glass-border)' }}>
                <Layout size={22} className="text-t-secondary" style={{ opacity: 0.2 }} />
                <p className="text-xs font-semibold mt-2 text-t-secondary" style={{ opacity: 0.3 }}>{t('profile.showcaseEmptyOther', 'No showcase to display')}</p>
              </div>
            )}
          </div>

          {/* Mutuals (compact) */}
          {!isSelf && (mutualServers.length > 0 || mutualFriends.length > 0) && (
            <div className="border-t border-default pt-3 flex flex-col gap-3">
              {mutualServers.length > 0 && (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest mb-2 text-t-secondary" style={{ opacity: 0.5 }}>{t('profile.mutualServersCount', { count: mutualServers.length, defaultValue: '{{count}} mutual servers' })}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {mutualServers.slice(0, 12).map(s => (
                      <div key={s.id} title={s.name} className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center text-[10px] font-bold shrink-0" style={{ backgroundColor: s.icon ? 'transparent' : 'var(--fill-active)' }}>
                        {s.icon ? <img src={sanitizeImgSrc(s.icon)} alt="" className="w-full h-full object-cover" /> : <span className="text-t-secondary">{s.name.slice(0, 2).toUpperCase()}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {mutualFriends.length > 0 && (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest mb-2 text-t-secondary" style={{ opacity: 0.5 }}>{t('profile.mutualFriendsCount', { count: mutualFriends.length, defaultValue: '{{count}} mutual friends' })}</p>
                  <div className="flex flex-col gap-0.5">
                    {mutualFriends.slice(0, 8).map(f => (
                      <div key={f.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg">
                        <div className="w-6 h-6 rounded-full overflow-hidden shrink-0"><LetterAvatar avatar={f.avatar} username={f.username} /></div>
                        <span className="text-[12px] font-medium truncate text-t-primary">{formatUsername(f)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="px-4 pb-4 mt-auto shrink-0">
        <button type="button" onClick={() => onViewFullProfile(user)} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors text-t-secondary hover:bg-fill-hover border border-default">
          <ExternalLink size={14} />
          {t('profile.viewFullProfile', 'View Full Profile')}
        </button>
      </div>
    </div>
  );
}
