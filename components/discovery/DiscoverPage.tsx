// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, X, Compass } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useDiscoveryStore } from '../../stores/discoveryStore';
import { ServerCard } from './ServerCard';
import { CategoryRail } from './CategoryRail';
import { FeaturedRow } from './FeaturedRow';
import { DiscoverFilters } from './DiscoverFilters';
import { HowlBrand } from '../brand/HowlBrand';

const SEARCH_DEBOUNCE_MS = 300;

interface DiscoverPageProps {
  /**
   * When true, the page renders WITHOUT its own top chrome (Howl logo, search bar
   * in the header, sign-in button, back arrow). The host (AppLayout) supplies the
   * shell. The page content (filters, featured, category rows, server grid)
   * renders normally. Used when an authenticated user navigates to /discover from
   * the in-app sidebar — the discover page becomes a section inside the app, not
   * a full-page takeover.
   */
  embedded?: boolean;
}

/**
 * Top-level Discover hub.
 *
 * Filter state is mirrored to URL search params so the user can bookmark or
 * share a filtered view. The store is the source of truth for *fetching* —
 * the URL is just a serialized snapshot.
 */
export const DiscoverPage: React.FC<DiscoverPageProps> = ({ embedded = false }) => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentUser = useAuthStore((s) => s.currentUser);
  const isAuthenticated = !!currentUser;

  const {
    authMode,
    filters,
    items,
    nextCursor,
    loading,
    loadingMore,
    error,
    featured,
    featuredLoaded,
    categories,
    categoriesLoaded,
    setAuthMode,
    setFilters,
    fetchInitial,
    fetchMore,
    fetchSidebars,
  } = useDiscoveryStore();

  // Auth-mode sync — switching login state must refresh the lists.
  useEffect(() => {
    const desired = isAuthenticated ? 'authenticated' : 'anonymous';
    if (authMode !== desired) {
      setAuthMode(desired);
    }
  }, [isAuthenticated, authMode, setAuthMode]);

  // URL → store hydration (one-shot, on mount or when URL changes via back/forward).
  useEffect(() => {
    const q = searchParams.get('q') ?? '';
    const category = searchParams.get('category');
    const language = searchParams.get('language');
    const tag = searchParams.get('tag');
    setFilters({ q, category, language, tag });
    // Initial / URL-driven fetch
    void fetchInitial();
    void fetchSidebars();
    // We intentionally only re-run this when the URL search changes.
    // Filter-state edits in the UI flow through setFilters() + the debounced
    // effect below.
  }, [searchParams, authMode, fetchInitial, fetchSidebars, setFilters]);

  // Local search input (debounced into store + URL).
  const [searchInput, setSearchInput] = useState(filters.q);
  // Keep the local input in sync when the URL drives a change (browser nav).
  useEffect(() => {
    setSearchInput(filters.q);
  }, [filters.q]);

  const debounceRef = useRef<number | null>(null);
  const onSearchInput = (value: string) => {
    setSearchInput(value);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      pushFilters({ q: value });
    }, SEARCH_DEBOUNCE_MS);
  };

  // Filter mutators (write to URL, which then triggers the hydrate effect).
  const pushFilters = useCallback(
    (patch: { q?: string; category?: string | null; language?: string | null; tag?: string | null }) => {
      const next = new URLSearchParams(searchParams);
      const apply = (key: string, val: string | null | undefined) => {
        if (val === undefined) return;
        if (val === null || val === '') next.delete(key);
        else next.set(key, val);
      };
      if ('q' in patch) apply('q', patch.q ?? '');
      if ('category' in patch) apply('category', patch.category);
      if ('language' in patch) apply('language', patch.language);
      if ('tag' in patch) apply('tag', patch.tag);
      setSearchParams(next, { replace: false });
    },
    [searchParams, setSearchParams]
  );

  // Refresh on window focus so toggling community mode in another tab is
  // reflected without manual reload. invalidate() no-ops while a fetch is
  // already in-flight, so a focus-flap during a slow fetch won't double-fire.
  useEffect(() => {
    const onFocus = () => {
      useDiscoveryStore.getState().invalidate();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Infinite scroll
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !nextCursor) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void fetchMore();
      },
      { rootMargin: '400px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [nextCursor, fetchMore]);

  const isEmpty = !loading && items.length === 0;
  const showFeatured = featuredLoaded ? featured.length > 0 : true;

  // Search input fragment, rendered in different positions for each mode:
  // standalone → top sticky header; embedded → inside the hero (Discord-style).
  const searchField = (
    <div
      className="relative w-full mx-auto"
      style={{ width: 'clamp(220px, 60vw, 720px)', maxWidth: '720px' }}
    >
      <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none" />
      <input
        type="text"
        value={searchInput}
        onChange={(e) => onSearchInput(e.target.value)}
        placeholder={t('discover.searchPlaceholder', 'Search public servers')}
        className="w-full pl-9 pr-9 py-2.5 rounded-full border border-[var(--border-subtle)] bg-[var(--fill-hover)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 focus:border-[var(--cyan-accent)]/50 transition-all"
        aria-label={t('discover.searchAria', 'Search servers')}
        maxLength={120}
      />
      {searchInput && (
        <button
          type="button"
          onClick={() => onSearchInput('')}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
          aria-label={t('common.clear', 'Clear')}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );

  // Standalone-mode top header: 3-column grid (logo, search, sign-in) so
  // the search bar is visually centered and scales with viewport width.
  const headerBar = (
    <header
      className="sticky top-0 z-30 backdrop-blur-md border-b border-[var(--border-subtle)]"
      style={{ background: 'color-mix(in srgb, var(--bg-app) 85%, transparent)' }}
    >
      <div
        className="mx-auto max-w-7xl px-4 sm:px-6 py-3 grid items-center gap-3"
        style={{ gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)' }}
      >
        {/* LEFT: Howl logo + wordmark — shared <HowlBrand /> so this matches
            the landing-page top-left lockup byte-for-byte (36×36 logo, 22px
            Clash Display wordmark, etc.). No bespoke sizing here. */}
        <Link to="/" className="inline-flex items-center w-fit" style={{ textDecoration: 'none' }}>
          <HowlBrand />
        </Link>

        {/* CENTER: search bar (responsive, centered) */}
        <div className="justify-self-center w-full">{searchField}</div>

        {/* RIGHT: Sign in (only in standalone mode, which is unauthed-only).
            Matches the landing-page "Get Howl" CTA exactly: #02385A background,
            white text, borderRadius 8, padding 8×18, no pill shape. */}
        <div className="justify-self-end">
          {!isAuthenticated && (
            <Link
              to="/login"
              className="hidden sm:inline-flex items-center text-sm font-semibold transition-[filter]"
              style={{ background: '#02385A', color: '#fff', padding: '8px 18px', borderRadius: 12 }}
              onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(1.12)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.filter = ''; }}
            >
              {t('auth.signIn', 'Sign in')}
            </Link>
          )}
        </div>
      </div>
    </header>
  );

  // Hero section — flat "Howl logo blue" #02385A (sampled directly from the
  // logo PNG background). Earlier passes used #076FA0 (--cyan-accent) which
  // is significantly brighter than the actual logo color. No shader, no
  // gradient layers — clean canvas for a custom design drop-in later.
  const heroSection = (
    <section
      className="relative overflow-hidden border-b border-[var(--border-subtle)]"
      style={{ minHeight: 'clamp(220px, 32vh, 360px)', background: '#02385A' }}
    >
      <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 py-12 md:py-16">
        <h1
          className="text-4xl md:text-5xl font-extrabold tracking-tight leading-[1.05]"
          style={{ color: '#ffffff' }}
        >
          {t('discover.heroTitlePrefix', 'Find your')}{' '}
          <span style={{ color: '#ffffff' }}>
            {t('discover.heroTitleEm', 'community')}
          </span>
        </h1>

        <p className="mt-3 text-base max-w-xl leading-relaxed" style={{ color: 'rgba(255,255,255,0.78)' }}>
          {t('discover.heroSubtitle', 'Browse servers built around the stuff you actually care about. Gaming, music, art, study groups, take your pick.')}
        </p>

        {/* In embedded mode, the search lives inside the hero (no sticky top header). */}
        {embedded && <div className="mt-6">{searchField}</div>}
      </div>
    </section>
  );

  return (
    <div
      className={`${embedded ? 'flex-1 min-w-0 w-full h-full overflow-y-auto' : 'min-h-full'}`}
      style={{ background: 'var(--bg-app)' }}
    >
      {!embedded && headerBar}
      {heroSection}

      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-8 space-y-8">
        {/* Category rail (with fixed-position arrows that don't overlap pinned items) */}
        <section>
          <CategoryRail
            categories={categories}
            activeCategory={filters.category}
            onSelect={(key) => pushFilters({ category: key })}
            loading={!categoriesLoaded}
          />
        </section>

        {/* Featured grid */}
        <FeaturedRow servers={featured} loading={!featuredLoaded && showFeatured} />

        {/* Main grid + filters */}
        <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
          <DiscoverFilters
            language={filters.language}
            tag={filters.tag}
            onLanguageChange={(lang) => pushFilters({ language: lang })}
            onTagChange={(tag) => pushFilters({ tag })}
          />

          <div>
            {error && (
              <div className="mb-4 px-4 py-3 rounded-lg border border-rose-500/40 bg-rose-500/10 text-sm" style={{ color: 'var(--text-primary)' }}>
                {error}
              </div>
            )}

            {loading && items.length === 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--fill-hover)] animate-pulse" style={{ height: 220 }} />
                ))}
              </div>
            ) : isEmpty ? (
              <div className="rounded-2xl border border-dashed border-[var(--border-subtle)] p-10 text-center">
                <Compass size={28} className="mx-auto mb-3 text-[var(--text-tertiary)]" />
                <p className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                  {t('discover.emptyTitle', 'No servers match your filters')}
                </p>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {t('discover.emptyHint', 'Try clearing a filter or searching for something else.')}
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                  {items.map((s) => (
                    <ServerCard key={s.id} server={s} />
                  ))}
                </div>
                <div ref={sentinelRef} className="h-12 mt-4 flex items-center justify-center text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {loadingMore ? t('discover.loadingMore', 'Loading…') : nextCursor ? t('discover.scrollForMore', 'Scroll for more') : items.length > 0 ? t('discover.endOfResults', "That's everything for now.") : null}
                </div>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};

export default DiscoverPage;
