// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, Sparkles, EyeOff, Users, Globe as GlobeIcon, ArrowLeft, ScrollText, ChevronRight } from 'lucide-react';
import { apiClient, type PublicServerProfile as PublicServerProfileType } from '../../services/api';
import { sanitizeImgSrc } from '../../utils/sanitizeImgSrc';
import { LetterAvatar } from '../LetterAvatar';
import { useAuthStore } from '../../stores/authStore';
import { parseInlineMarkdown } from '../../utils/markdownUtils';
import { formatCount } from './formatCount';

/**
 * Render markdown text inline-only. We intentionally don't pull in the full
 * MentionText pipeline here — public profile descriptions are display-only,
 * never have mentions/emoji, and shouldn't drag the heavy editor into the
 * anonymous-route bundle. parseInlineMarkdown handles bold/italic/code/link.
 */
const renderInline = (text: string): React.ReactNode[] => {
  const segments = parseInlineMarkdown(text);
  return segments.map((seg, i) => {
    switch (seg.type) {
      case 'plain': return <React.Fragment key={i}>{seg.value}</React.Fragment>;
      case 'bold': return <strong key={i}>{seg.value}</strong>;
      case 'italic': return <em key={i}>{seg.value}</em>;
      case 'boldItalic': return <strong key={i}><em>{seg.value}</em></strong>;
      case 'underline': return <u key={i}>{seg.value}</u>;
      case 'strikethrough': return <s key={i}>{seg.value}</s>;
      case 'code': return <code key={i} className="px-1 py-0.5 rounded-lg bg-[var(--fill-hover)] text-xs">{seg.value}</code>;
      case 'spoiler': return <span key={i} className="px-1 rounded-lg bg-[var(--fill-hover)]">{seg.value}</span>;
      case 'link': return (
        <a key={i} href={seg.url} target="_blank" rel="noopener noreferrer nofollow" className="text-[var(--cyan-accent)] hover:underline">
          {seg.value}
        </a>
      );
      default: return null;
    }
  });
};

const renderDescription = (description: string): React.ReactNode => {
  const paragraphs = description.split(/\n{2,}/);
  return paragraphs.map((para, i) => (
    <p key={i} className="leading-relaxed mb-3 last:mb-0 whitespace-pre-wrap break-words">
      {renderInline(para)}
    </p>
  ));
};

export interface PublicServerProfilePageProps {
  /** Optional vanity override — used when rendered outside a <Route> (App.tsx renders it directly). Falls back to useParams. */
  vanity?: string;
}

export const PublicServerProfile: React.FC<PublicServerProfilePageProps> = ({ vanity: vanityProp }) => {
  const { t } = useTranslation();
  const { vanity: routeVanity } = useParams<{ vanity: string }>();
  const vanity = vanityProp ?? routeVanity;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const currentUser = useAuthStore((s) => s.currentUser);
  const isAuthenticated = !!currentUser;

  const [profile, setProfile] = useState<PublicServerProfileType | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    if (!vanity) { setNotFound(true); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setError(null);
    apiClient
      .publicServerProfile(vanity)
      .then((data) => { if (!cancelled) { setProfile(data); setLoading(false); } })
      .catch((err: Error & { status?: number }) => {
        if (cancelled) return;
        if (err.status === 404) { setNotFound(true); setLoading(false); return; }
        setError(err.message || 'Failed to load server');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [vanity]);

  // Apply-to-join modal handoff
  // We expose the ?apply=1 query param so the apply-to-join modal can detect
  // it and open. Here we render a button that toggles the param.
  const applyOpen = searchParams.get('apply') === '1';

  const handleJoin = async () => {
    if (!profile) return;
    if (!isAuthenticated) {
      // Persist where to come back to so login → back-to-profile flows.
      try { sessionStorage.setItem('howl_returnTo', `/s/${vanity ?? ''}`); } catch { /* ignore */ }
      navigate('/login');
      return;
    }
    if (profile.joinMethod === 'apply_to_join') {
      // Set the query param so the apply-to-join modal picks up the trigger.
      navigate(`/s/${vanity}?apply=1`);
      return;
    }
    setJoining(true);
    setJoinError(null);
    try {
      // Discoverable servers can be joined directly from the public profile —
      // the vanity URL itself is the join link, no invite code needed. Falls
      // back to the legacy invite-code path if a server was set up before
      // joinMethod=discoverable shipped.
      const result = profile.joinMethod === 'discoverable'
        ? await apiClient.publicServerJoin(vanity ?? profile.id)
        : profile.inviteCode
          ? await apiClient.joinServerByInvite(profile.inviteCode)
          : null;
      if (!result) {
        setJoinError(t('discover.noInviteAvailable', 'This server has no public invite. Ask a member for an invite link.'));
        setJoining(false);
        return;
      }
      // Apply-to-join servers short-circuit above (line ~102) — if we
      // somehow get here with the application_required branch, route to the
      // dedicated invite page rather than crashing on .channels access.
      if ('applicationRequired' in result) {
        navigate(`/s/${vanity}?apply=1`);
        return;
      }
      const server = result;
      const ch = server.channels?.[0];
      navigate(ch ? `/channels/${server.id}/${ch.id}` : `/channels/${server.id}`);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Failed to join server');
      setJoining(false);
    }
  };

  const bannerSrc = useMemo(() => {
    if (!profile) return null;
    return sanitizeImgSrc(profile.bannerSplash || profile.banner) ?? null;
  }, [profile]);
  const iconSrc = useMemo(() => sanitizeImgSrc(profile?.icon ?? null) ?? null, [profile]);
  const bannerIsHex = !!profile?.banner && profile.banner.startsWith('#');

  if (loading) {
    return (
      <div className="min-h-full flex items-center justify-center" style={{ background: 'var(--bg-app)' }}>
        <div className="animate-pulse rounded-2xl" style={{ width: 480, height: 320, background: 'var(--fill-hover)' }} />
      </div>
    );
  }

  if (notFound || !profile) {
    return (
      <div className="min-h-full flex items-center justify-center px-6" style={{ background: 'var(--bg-app)' }}>
        <div className="text-center max-w-md">
          <p className="text-lg font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
            {t('discover.profileNotFoundTitle', 'Server not found')}
          </p>
          <p className="text-sm mb-6" style={{ color: 'var(--text-tertiary)' }}>
            {t('discover.profileNotFoundHint', 'This server may have been deleted or made private.')}
          </p>
          <Link to="/discover" className="text-sm text-[var(--cyan-accent)] hover:underline">
            {t('discover.browseAll', 'Browse all servers')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full" style={{ background: 'var(--bg-app)' }}>
      {/* Top nav */}
      <div className="sticky top-0 z-30 backdrop-blur-md border-b border-[var(--border-subtle)]" style={{ background: 'color-mix(in srgb, var(--bg-app) 85%, transparent)' }}>
        <div className="mx-auto max-w-5xl px-4 sm:px-6 py-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/discover'))}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border-subtle)] hover:bg-[var(--fill-hover)] transition-colors"
            aria-label={t('common.back', 'Back')}
          >
            <ArrowLeft size={16} />
          </button>
          <Link to="/discover" className="text-sm font-medium hover:underline" style={{ color: 'var(--text-secondary)' }}>
            {t('discover.title', 'Discover')}
          </Link>
          <ChevronRight size={14} className="text-[var(--text-tertiary)]" />
          <span className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>{profile.name}</span>
        </div>
      </div>

      {/* Banner */}
      <div className="relative w-full h-48 sm:h-72 overflow-hidden">
        {bannerSrc ? (
          <img
            src={bannerSrc}
            alt=""
            className="w-full h-full object-cover"
            style={{ objectPosition: `center ${profile.bannerPositionY ?? 50}%` }}
            draggable={false}
          />
        ) : bannerIsHex ? (
          <div className="w-full h-full" style={{ background: profile.banner ?? undefined }} />
        ) : (
          <div className="w-full h-full" style={{ background: 'linear-gradient(135deg, var(--accent-muted), rgba(15,23,42,0.9))' }} />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg-app)] via-transparent to-transparent" aria-hidden="true" />
      </div>

      <main className="mx-auto max-w-5xl px-4 sm:px-6 -mt-12 pb-16 relative z-10">
        {/* Header card */}
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--fill-hover)] p-5 sm:p-6 shadow-lg">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-5">
            <div className="flex items-end gap-4">
              <div className="relative shrink-0 -mt-12 sm:-mt-16 overflow-hidden rounded-2xl border-[4px] border-[var(--bg-app)]" style={{ width: 88, height: 88 }}>
                {iconSrc ? (
                  <img src={iconSrc} alt="" className="w-full h-full object-cover" draggable={false} />
                ) : (
                  <LetterAvatar avatar={null} username={profile.name} size={80} className="rounded-xl" />
                )}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-2xl font-bold truncate" style={{ color: 'var(--text-primary)' }}>{profile.name}</h1>
                  {profile.verified && (
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold flex items-center gap-1 bg-sky-500/90 text-white">
                      <ShieldCheck size={10} />
                      {t('discover.badge.verified', 'Verified')}
                    </span>
                  )}
                  {profile.featured && (
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold flex items-center gap-1 bg-amber-500/90 text-black">
                      <Sparkles size={10} />
                      {t('discover.badge.featured', 'Featured')}
                    </span>
                  )}
                  {profile.mature && (
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold flex items-center gap-1 bg-rose-600/90 text-white">
                      <EyeOff size={10} />
                      {t('discover.badge.mature', '18+')}
                    </span>
                  )}
                </div>
                {profile.shortDescription && (
                  <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>{profile.shortDescription}</p>
                )}
                <div className="mt-2 flex items-center flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    {formatCount(profile.onlineCount)} {t('discover.online', 'online')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Users size={11} />
                    {formatCount(profile.memberCount)} {t('discover.members', 'members')}
                  </span>
                  {profile.language && (
                    <span className="flex items-center gap-1.5 uppercase tracking-wide">
                      <GlobeIcon size={11} />
                      {profile.language}
                    </span>
                  )}
                  {profile.category && (
                    <span className="flex items-center gap-1.5">
                      <span className="w-1 h-1 rounded-full bg-current opacity-50" />
                      {profile.category}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-col items-stretch sm:items-end gap-2 min-w-[180px]">
              {profile.isMember ? (
                <Link
                  to={`/channels/${profile.id}`}
                  className="btn-cta inline-flex items-center justify-center px-5 py-2.5 rounded-xl text-sm transition-colors"
                >
                  {t('discover.openServer', 'Open Server')}
                </Link>
              ) : !isAuthenticated ? (
                <button
                  type="button"
                  onClick={handleJoin}
                  className="btn-cta inline-flex items-center justify-center px-5 py-2.5 rounded-xl text-sm transition-colors"
                >
                  {t('discover.signInToJoin', 'Sign in to join')}
                </button>
              ) : profile.joinMethod === 'apply_to_join' ? (
                <button
                  type="button"
                  onClick={handleJoin}
                  className="btn-cta inline-flex items-center justify-center px-5 py-2.5 rounded-xl text-sm transition-colors"
                >
                  {t('discover.applyToJoin', 'Apply to Join')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleJoin}
                  disabled={joining}
                  className="btn-cta inline-flex items-center justify-center px-5 py-2.5 rounded-xl text-sm transition-colors disabled:opacity-50"
                >
                  {joining ? t('common.loading', 'Joining…') : t('discover.joinServer', 'Join Server')}
                </button>
              )}
              {applyOpen && profile.joinMethod === 'apply_to_join' && (
                <p className="text-[11px] text-right" style={{ color: 'var(--text-tertiary)' }}>
                  {t('discover.applyHandoffPending', 'Application form will open here.')}
                </p>
              )}
              {(joinError || error) && (
                <p className="text-xs text-rose-400 max-w-[260px] text-right">{joinError ?? error}</p>
              )}
            </div>
          </div>

          {/* Tags */}
          {profile.tags && profile.tags.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-1.5">
              {profile.tags.map((tag) => (
                <Link
                  key={tag}
                  to={`/discover?tag=${encodeURIComponent(tag)}`}
                  className="px-2.5 py-0.5 rounded-full text-[11px] border border-[var(--border-subtle)] hover:bg-[var(--bg-app)] transition-colors"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {tag}
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Two-column body */}
        <div className="mt-6 grid gap-6 md:grid-cols-[1fr_280px]">
          {/* Description */}
          <article className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--fill-hover)] p-5 sm:p-6 text-sm" style={{ color: 'var(--text-primary)' }}>
            <h2 className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: 'var(--text-secondary)' }}>
              {t('discover.about', 'About')}
            </h2>
            {profile.description ? (
              <div>{renderDescription(profile.description)}</div>
            ) : (
              <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                {t('discover.noDescription', 'This server hasn’t added a description yet.')}
              </p>
            )}
          </article>

          {/* Rules */}
          <aside className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--fill-hover)] p-5 sm:p-6">
            <h2 className="text-xs font-semibold uppercase tracking-wide mb-3 flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
              <ScrollText size={12} />
              {t('discover.rules', 'Rules')}
            </h2>
            {profile.rules && profile.rules.length > 0 ? (
              <ol className="space-y-2 text-sm">
                {profile.rules.slice(0, 8).map((rule, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="font-semibold shrink-0" style={{ color: 'var(--cyan-accent)' }}>{i + 1}.</span>
                    <span style={{ color: 'var(--text-secondary)' }} className="break-words">{rule}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('discover.noRules', 'No rules listed.')}
              </p>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
};

export default PublicServerProfile;
