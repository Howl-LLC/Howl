// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { assetPath } from '../utils/assetPath';
import { HowlBrand } from './brand/HowlBrand';
import { LANDING_SHOTS } from './landingImageManifest';

/* ════════════════════════════════════════════════════════════════════════
   Howl Landing Page

   Implements the "Howl Landing Page" design.
   The playful "Roo" mascots that the designer dragged around are baked in as
   static, locked decorations at the exact desktop / mobile positions chosen
   in the design. Real app wiring (OS-aware download URLs, /login, the legal
   doc links) is preserved.

   ── Aligned to upstream conventions ───────────────────────────────────────
   • All asset references go through `assetPath()` so the page works in both
     web (https://) and Electron (file://) builds.
   • Accent color uses the app-wide `--cyan-accent` token (#076FA0 — Howl
     "logo blue"), defined in app.css. The local `--howl-*` scoped vars
     resolve to it, so we never deviate from the brand dark blue.
   • OS detection includes ios / android (download for those is currently
     "#" until store listings are live).
   • Download base URL follows the same env knob (`VITE_DOWNLOAD_BASE_URL`)
     and filenames as the rest of the app (Howl-Setup.exe / Howl-x64.dmg /
     Howl-amd64.deb).
   • Footer links use the real route paths the app actually serves
     (/terms-of-service, /community-guidelines, /refund-policy,
     /law-enforcement, …); they render via `components/LegalPage.tsx`.
   ════════════════════════════════════════════════════════════════════════ */

/* ─── Asset roots (served from /public/landing) ─── */
const asset = (p: string) => assetPath(`/landing/assets/${p}`);
const shot = (p: string) => assetPath(`/landing/screenshots/${p}`);

/* Responsive screenshot: <picture> with AVIF/WebP variants over a PNG fallback.
   Widths come from the generated manifest; picture{display:contents} preserves
   the inner <img>'s layout. */
const SHOT_SIZES = '(max-width: 900px) 92vw, 600px';

function shotSrcSet(name: string, ext: 'avif' | 'webp'): string {
  return (LANDING_SHOTS[name]?.widths ?? [])
    .map((w) => `${shot(`${name}-${w}.${ext}`)} ${w}w`)
    .join(', ');
}

type ShotProps = {
  name: string;
  alt: string;
  style?: React.CSSProperties;
  sizes?: string;
  draggable?: boolean;
  loading?: 'lazy' | 'eager';
  fetchPriority?: 'high' | 'low' | 'auto';
};

function Shot({ name, alt, style, sizes = SHOT_SIZES, draggable, loading = 'lazy', fetchPriority }: ShotProps) {
  const meta = LANDING_SHOTS[name];
  return (
    <picture>
      <source type="image/avif" srcSet={shotSrcSet(name, 'avif')} sizes={sizes} />
      <source type="image/webp" srcSet={shotSrcSet(name, 'webp')} sizes={sizes} />
      <img
        src={shot(`${name}.png`)}
        alt={alt}
        width={meta?.w}
        height={meta?.h}
        loading={loading}
        decoding="async"
        fetchPriority={fetchPriority}
        draggable={draggable}
        style={style}
      />
    </picture>
  );
}

/* ─── Download wiring (mirrors the prior LandingPage so file URLs match
   what `npm run dist` actually publishes to `releases.howlpro.com`). ─── */

type UserOS = 'windows' | 'mac' | 'linux' | 'ios' | 'android';

const DOWNLOAD_BASE = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DOWNLOAD_BASE_URL)
  || 'https://releases.howlpro.com';

// Windows ships a single combined NSIS installer containing both x64 and
// arm64 payloads (electron-builder picks the right one at install time).
// Linux ships .deb by default — the .deb runs postinstall that SUIDs
// chrome-sandbox and installs an AppArmor profile granting userns to Howl.
// Debian/Ubuntu-only; Fedora/Arch users can grab the AppImage directly
// from releases.howlpro.com.
const DOWNLOAD_FILES: Record<UserOS, string> = {
  windows: 'Howl-Setup.exe',
  mac: 'Howl-x64.dmg',
  linux: 'Howl-amd64.deb',
  ios: '',
  android: '',
};

const DOWNLOAD_URLS: Record<UserOS, string> = {
  windows: `${DOWNLOAD_BASE}/${DOWNLOAD_FILES.windows}`,
  // macOS build is not yet signed/notarized — flip to the file URL once
  // code signing is ready.
  mac: '#',
  linux: `${DOWNLOAD_BASE}/${DOWNLOAD_FILES.linux}`,
  ios: '#',
  android: '#',
};

const DOWNLOAD_LABEL: Record<UserOS, string> = {
  windows: 'Download',
  mac: 'Download',
  linux: 'Download',
  ios: 'Open in App',
  android: 'Open in App',
};

function detectOS(): UserOS {
  if (typeof navigator === 'undefined') return 'windows';
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.platform || '').toLowerCase();
  if (ua.includes('iphone') || ua.includes('ipad') || (platform.includes('mac') && navigator.maxTouchPoints > 1)) return 'ios';
  if (ua.includes('android')) return 'android';
  if (ua.includes('mac') || platform.includes('mac')) return 'mac';
  if (ua.includes('linux') || platform.includes('linux')) return 'linux';
  return 'windows';
}

/* ─── Global lightbox (any screenshot can open it) ─── */

type OpenLightbox = (src: string, alt?: string) => void;
const LightboxContext = createContext<OpenLightbox>(() => {});
const useLightbox = () => useContext(LightboxContext);

/* ─── Hooks ─── */

function useIsMobile(query = '(max-width: 900px)'): boolean {
  const [match, setMatch] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const cb = () => setMatch(mq.matches);
    mq.addEventListener('change', cb);
    setMatch(mq.matches);
    return () => mq.removeEventListener('change', cb);
  }, [query]);
  return match;
}

/* Mouse-tracking perspective tilt for a single card. */
/* High-Hz mice (240–1000 Hz) fire mousemove far faster than the screen
   refresh, so unconditionally setting React state on every event drives a
   re-render per event. We coalesce to one update per animation frame:
   pointer events update a ref synchronously, but the React state setter
   only fires inside the next rAF. Cancels any pending rAF on unmount /
   mouse-leave so we don't leak callbacks. */
function useCardTilt(baseTransform: string, maxTilt = 6) {
  const ref = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const rafRef = useRef(0);
  const pendingRef = useRef({ x: 0, y: 0 });
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / rect.width - 0.5;
    const cy = (e.clientY - rect.top) / rect.height - 0.5;
    pendingRef.current = { x: cy * -maxTilt, y: cx * maxTilt };
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setTilt(pendingRef.current);
    });
  }, [maxTilt]);
  const onMouseLeave = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    pendingRef.current = { x: 0, y: 0 };
    setTilt({ x: 0, y: 0 });
  }, []);
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);
  const style: React.CSSProperties = {
    transition: 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)',
    transform: `${baseTransform} rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
  };
  return { ref, style, onMouseMove, onMouseLeave };
}

/* Lighter tilt for two-card stacks. Same rAF-coalesced pattern as useCardTilt. */
function useStackTilt() {
  const ref = useRef<HTMLDivElement>(null);
  const [t, setT] = useState({ x: 0, y: 0 });
  const rafRef = useRef(0);
  const pendingRef = useRef({ x: 0, y: 0 });
  const onMouseMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = (e.clientX - r.left) / r.width - 0.5;
    const cy = (e.clientY - r.top) / r.height - 0.5;
    pendingRef.current = { x: cy * -4, y: cx * 4 };
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setT(pendingRef.current);
    });
  };
  const onMouseLeave = () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    pendingRef.current = { x: 0, y: 0 };
    setT({ x: 0, y: 0 });
  };
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);
  const cardTransition = 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)';
  return { ref, t, onMouseMove, onMouseLeave, cardTransition };
}

/* ─── Scroll-reveal wrapper ─── */

type RevealType = 'up' | 'left' | 'right' | 'scale' | 'blur' | string;

function RevealDiv({
  children, delay = 0, style, className = '', type = 'up',
}: { children: React.ReactNode; delay?: number; style?: React.CSSProperties; className?: string; type?: RevealType }) {
  const aliasMap: Record<string, string> = { left: 'sr-left', right: 'sr-right', scale: 'sr-scale', blur: 'sr-blur' };
  let typeClass = '';
  if (type && type.startsWith('sr-')) typeClass = ` ${type}`;
  else if (aliasMap[type]) typeClass = ` ${aliasMap[type]}`;
  return (
    <div className={`sr${typeClass} ${className}`} style={{ ...style, transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

/* ─── Locked decorative mascot ─── */

type StickerPos = { x: number; y: number; w: number; rot?: number };

/* The designer dragged these around then locked them. We render the saved
   desktop / mobile position statically — purely decorative, no interaction. */
function LockedSticker({
  src, alt = '', desktop, mobile, aspect,
}: { src: string; alt?: string; desktop: StickerPos; mobile: StickerPos; aspect: number }) {
  const isMobile = useIsMobile();
  const s = isMobile ? mobile : desktop;
  const rot = s.rot || 0;
  return (
    <div
      aria-hidden="true"
      className="roo-deco"
      style={{
        position: 'absolute', left: s.x, top: s.y,
        width: s.w, height: s.w * aspect,
        zIndex: 20, pointerEvents: 'none', userSelect: 'none',
        transform: rot ? `rotate(${rot}deg)` : undefined,
        transformOrigin: 'center center',
      }}
    >
      <img
        src={src} alt={alt} draggable={false} loading="lazy" decoding="async"
        style={{
          width: '100%', height: '100%', display: 'block', pointerEvents: 'none',
          filter: 'drop-shadow(0 10px 28px rgba(0,0,0,0.35)) drop-shadow(0 0 0.5px rgba(255,255,255,0.4))',
        }}
      />
    </div>
  );
}

/* ─── Nav ─── */

function Nav({ scrolled }: { scrolled: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const linkStyle: React.CSSProperties = {
    color: 'var(--text-muted)', textDecoration: 'none',
    fontFamily: 'var(--font-body)', fontSize: 14, fontWeight: 500,
    transition: 'color 0.15s',
  };
  const links = [
    { label: 'Features', href: '#features' },
    { label: 'Pricing', href: '#pricing' },
  ];
  /* About is rendered separately below as a <Link to="/about"> so the nav button
     and the footer About link both go to the dedicated /about page. */

  return (
    <>
      <nav style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000,
        padding: '0 clamp(24px, 4vw, 64px)', height: 64,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: scrolled ? 'var(--surface-veil)' : 'transparent',
        backdropFilter: scrolled ? 'blur(20px) saturate(1.3)' : 'none',
        WebkitBackdropFilter: scrolled ? 'blur(20px) saturate(1.3)' : 'none',
        borderBottom: '1px solid rgba(255,255,255,0.10)',
        transition: 'background 0.3s, backdrop-filter 0.3s, border-color 0.3s',
      }}>
        <a href="#" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
          <HowlBrand logoSrc={asset('howl-logo-v4.png')} />
        </a>

        <div className="nav-links-desktop" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {links.map(l => (
            <a key={l.href} href={l.href}
              style={{ ...linkStyle, padding: '6px 14px', display: 'inline-flex', alignItems: 'center' }}
              onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.color = 'var(--text)'; }}
              onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
            >{l.label}</a>
          ))}
          <Link to="/about"
            style={{ ...linkStyle, padding: '6px 14px', display: 'inline-flex', alignItems: 'center' }}
            onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
          >About</Link>
          <img src={asset('howl-mascot-hero.png')} alt="" aria-hidden="true" decoding="async"
            style={{ width: 40, height: 40, objectFit: 'contain', marginLeft: 6, filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.25))', pointerEvents: 'none' }} />
          {/* Get Howl scrolls to whichever download CTA (#hero-download or
             #download) is closer to the user's current scroll position — see
             the data-nearest-of branch in onRootClick. */}
          <a href="#download" data-nearest-of="hero-download,download" style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 18px', marginLeft: 8,
            background: '#02385A', color: '#fff', borderRadius: 12,
            fontFamily: 'var(--font-body)', fontSize: 14, fontWeight: 600, textDecoration: 'none', transition: 'filter 0.15s',
          }}
            onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.filter = 'brightness(1.12)'; }}
            onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.filter = ''; }}
          >Get Howl</a>
        </div>

        {/* Mobile mascot — left of the hamburger */}
        <img src={asset('howl-mascot-hero.png')} alt="" aria-hidden="true" className="nav-mascot-mobile" decoding="async"
          style={{ display: 'none', width: 40, height: 40, objectFit: 'contain', marginLeft: 'auto', marginRight: 6, filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.25))', pointerEvents: 'none' }} />

        <button className="nav-hamburger" onClick={() => setMenuOpen(o => !o)} aria-label="Menu"
          style={{ display: 'none', background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 8 }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {menuOpen
              ? <path d="M18 6L6 18M6 6l12 12" />
              : <><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></>}
          </svg>
        </button>
      </nav>

      {menuOpen && (
        <div className="nav-mobile-menu" style={{
          position: 'fixed', top: 64, left: 0, right: 0, bottom: 0,
          background: 'oklch(0.10 0.012 230 / 0.95)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 48, gap: 32, zIndex: 1500,
        }}>
          {links.map(l => (
            <a key={l.href} href={l.href} onClick={() => setMenuOpen(false)} style={{ ...linkStyle, fontSize: 20 }}>{l.label}</a>
          ))}
          <Link to="/about" onClick={() => setMenuOpen(false)} style={{ ...linkStyle, fontSize: 20 }}>About</Link>
          <a href="#download" data-nearest-of="hero-download,download" onClick={() => setMenuOpen(false)} style={{
            padding: '12px 32px', borderRadius: 12, background: '#02385A', color: '#fff',
            fontFamily: 'var(--font-body)', fontSize: 16, fontWeight: 600, textDecoration: 'none',
          }}>Get Howl</a>
        </div>
      )}
    </>
  );
}

/* ─── Hero ─── */

const BEZEL_SHADOW = `
  0 60px 140px -30px rgba(0,0,0,0.75),
  0 28px 70px -18px rgba(0, 0, 0, 0.4),
  inset 0 1px 0 rgba(255,255,255,0.08),
  inset 0 -1px 0 rgba(0,0,0,0.4),
  inset 1px 0 0 rgba(255,255,255,0.04),
  inset -1px 0 0 rgba(0,0,0,0.3)
`;

/* The screenshot bezels are intentionally a neutral dark (not blue) so they
   read as device chrome rather than as accented surfaces — keeps the brand
   blue (#076FA0) reserved for CTAs and accents. */
const BEZEL_FILL = 'oklch(0.24 0.07 240)'; /* dark, blue-tinted — the "logo dark blue" family for screenshot bezels, lightbox frame, and showcase card */

function HeroSection({ userOS }: { userOS: UserOS }) {
  const isMobile = useIsMobile();
  const chatTilt = useCardTilt('perspective(1600px) rotateY(10deg) rotateX(5deg) rotateZ(0.5deg)');
  const showcaseTilt = useCardTilt('perspective(1400px) rotateY(-14deg) rotateX(6deg) rotateZ(-1deg)');
  const calendarTilt = useCardTilt('perspective(1400px) rotateX(8deg) rotateY(-5deg) rotateZ(1.5deg)');

  const heroPuppy = isMobile ? { x: 164, y: 879 } : { x: 797, y: -79 };
  const heroWave: StickerPos = isMobile
    ? { x: -43, y: -35, w: 241, rot: -7.3 }
    : { x: 18, y: -56, w: 302, rot: -6.6 };

  const sheen: React.CSSProperties = {
    position: 'absolute', inset: 0, borderRadius: 12,
    background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.06) 0%, transparent 35%)',
    pointerEvents: 'none', zIndex: 0,
  };
  const topEdge: React.CSSProperties = {
    position: 'absolute', top: 0, left: '8%', right: '8%', height: 1,
    background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)',
    pointerEvents: 'none', zIndex: 1,
  };

  const downloadDisabled = DOWNLOAD_URLS[userOS] === '#';

  return (
    <section id="hero" style={{
      position: 'relative', minHeight: '100vh', display: 'flex',
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden', padding: '80px clamp(24px, 6vw, 80px) 60px',
    }}>
      <div className="hero-inner" style={{
        position: 'relative', zIndex: 2, width: '100%', maxWidth: 1240,
        display: 'flex', alignItems: 'flex-start', gap: 'clamp(32px, 5vw, 64px)',
      }}>
        {/* Left: text + CTA */}
        <div style={{ flex: '0 1 480px', minWidth: 280 }}>
          <RevealDiv delay={0}>
            <h1 style={{
              fontFamily: 'var(--font-display)', fontWeight: 600,
              fontSize: 'clamp(42px, 6vw, 80px)', lineHeight: 1.0,
              letterSpacing: '-0.02em', color: 'var(--text)', margin: '0 0 28px',
            }}>
              Howl
            </h1>
          </RevealDiv>

          <RevealDiv delay={100}>
            <p style={{
              fontFamily: 'var(--font-body)', fontSize: 'clamp(15px, 1.8vw, 19px)',
              lineHeight: 1.65, color: 'var(--text-muted)', margin: '0 0 12px', maxWidth: 420,
            }}>
              Community app for everybody. Chat with friends, apply for competitive servers, and discover casual ones. Howl has something for every style and preference.
            </p>
          </RevealDiv>

          {/* Waving Roo — floating, no layout impact */}
          <div className="hero-roo-video-wrap" style={{ position: 'relative', height: 0 }}>
            <div aria-hidden="true" className="roo-deco" style={{
              position: 'absolute', left: 0, top: 0, width: heroWave.w,
              transform: `translate(${heroWave.x}px, ${heroWave.y}px) rotate(${heroWave.rot}deg)`,
              transformOrigin: 'center center', pointerEvents: 'none', userSelect: 'none', zIndex: 5,
            }}>
              <img src={asset('roo-waving.webp')} alt="" draggable={false} decoding="async"
                style={{ display: 'block', width: '100%', height: 'auto', pointerEvents: 'none' }} />
            </div>
          </div>

          {/* Segmented CTA — Download / Open in Browser
             id="hero-download" so the nav "Get Howl" can pick whichever of the
             two download CTAs (hero vs DownloadSection) is closer to the user's
             current scroll position. */}
          <RevealDiv delay={160}>
            {/* 3-segment bar — Download / Open in Browser / Discover.
               flex:1 per segment + maxWidth on the wrapper keeps the segments
               equal-width so the bar reads as a single balanced rectangle that
               lines up with the paragraph above (maxWidth ~420). */}
            <div id="hero-download" style={{ display: 'inline-flex', alignItems: 'stretch', marginTop: 56, scrollMarginTop: 96, maxWidth: 480, width: '100%' }}>
              <div className="seg-bar" style={{
                display: 'flex', alignItems: 'stretch', width: '100%', background: '#02385A', borderRadius: 12,
                boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255,255,255,0.06) inset',
                overflow: 'hidden', fontFamily: 'var(--font-body)',
                opacity: downloadDisabled ? 0.7 : 1,
              }}>
                <a
                  href={downloadDisabled ? undefined : DOWNLOAD_URLS[userOS]}
                  aria-disabled={downloadDisabled || undefined}
                  className="btn-primary seg-link"
                  style={{
                    flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px',
                    color: '#fff', textDecoration: 'none', fontSize: 15, fontWeight: 600,
                    transition: 'background 0.15s', cursor: downloadDisabled ? 'not-allowed' : 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                  onClick={downloadDisabled ? (e) => e.preventDefault() : undefined}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  {DOWNLOAD_LABEL[userOS]}{downloadDisabled ? ' · Coming soon' : ''}
                </a>
                <div className="seg-divider" style={{ width: 1, background: 'rgba(255,255,255,0.18)' }} />
                <Link to="/login" className="seg-link" style={{
                  flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px',
                  color: '#fff', textDecoration: 'none', fontSize: 15, fontWeight: 600, transition: 'background 0.15s',
                  whiteSpace: 'nowrap',
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  Browser
                </Link>
                <div className="seg-divider" style={{ width: 1, background: 'rgba(255,255,255,0.18)' }} />
                <Link to="/discover" className="seg-link" style={{
                  flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px',
                  color: '#fff', textDecoration: 'none', fontSize: 15, fontWeight: 600, transition: 'background 0.15s',
                  whiteSpace: 'nowrap',
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
                  </svg>
                  Discover
                </Link>
              </div>
            </div>
          </RevealDiv>

          {/* Floating puppy — locked, decorative */}
          <div className="hero-floating-roo" style={{
            position: 'absolute', left: heroPuppy.x, top: heroPuppy.y, zIndex: 10,
            width: 140, height: 140, pointerEvents: 'none', userSelect: 'none',
          }}>
            <img src={asset('roo-puppy.webp')} alt="Roo" draggable={false} decoding="async"
              style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none', filter: 'drop-shadow(0 6px 16px rgba(0,0,0,0.3))' }} />
          </div>
        </div>

        {/* Right: perspective screenshots */}
        <RevealDiv delay={200} type="scale" style={{ flex: '1 1 620px', position: 'relative', minHeight: 400 }}>
          <div className="hero-screenshot-stack" style={{ position: 'relative', width: '100%', paddingBottom: '70%', perspective: 1200 }}>
            {/* Chat */}
            <div ref={chatTilt.ref} onMouseMove={chatTilt.onMouseMove} onMouseLeave={chatTilt.onMouseLeave} style={{
              ...chatTilt.style, position: 'absolute', top: 0, left: 0, width: '90%',
              borderRadius: 12, padding: 6, border: '1px solid rgba(255, 255, 255, 0.18)',
              background: BEZEL_FILL, boxShadow: BEZEL_SHADOW, zIndex: 2, transformOrigin: '30% 50%', overflow: 'hidden',
            }}>
              <div style={sheen} /><div style={topEdge} />
              <Shot name="chat-final" alt="Howl Chat" loading="eager" fetchPriority="high" style={{ position: 'relative', zIndex: 2, width: '100%', display: 'block', borderRadius: 12 }} />
            </div>

            {/* Showcase */}
            <div ref={showcaseTilt.ref} onMouseMove={showcaseTilt.onMouseMove} onMouseLeave={showcaseTilt.onMouseLeave} style={{
              ...showcaseTilt.style, position: 'absolute', top: '-10%', right: '-2%', width: '54%',
              borderRadius: 12, padding: 6, border: '1px solid rgba(255, 255, 255, 0.20)',
              background: BEZEL_FILL, boxShadow: BEZEL_SHADOW, zIndex: 3, transformOrigin: '70% 50%', overflow: 'hidden',
            }}>
              <div style={sheen} /><div style={topEdge} />
              <Shot name="showcase-real" alt="Howl Showcase" loading="eager" fetchPriority="low" style={{ position: 'relative', zIndex: 2, width: '100%', display: 'block', borderRadius: 12 }} />
            </div>

            {/* Calendar */}
            <div ref={calendarTilt.ref} onMouseMove={calendarTilt.onMouseMove} onMouseLeave={calendarTilt.onMouseLeave} style={{
              ...calendarTilt.style, position: 'absolute', bottom: '-8%', left: '8%', width: '72%',
              borderRadius: 12, padding: 5, border: '1px solid rgba(255, 255, 255, 0.16)',
              background: BEZEL_FILL,
              boxShadow: '0 40px 100px -20px rgba(0,0,0,0.7), 0 20px 50px -14px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(0,0,0,0.4)',
              zIndex: 1, transformOrigin: '50% 100%', overflow: 'hidden',
            }}>
              <div style={sheen} /><div style={topEdge} />
              <Shot name="calendar" alt="Howl Calendar" loading="eager" fetchPriority="low" style={{ position: 'relative', zIndex: 2, width: '100%', display: 'block', borderRadius: 12 }} />
            </div>

            {/* Ground shadow */}
            <div style={{ position: 'absolute', bottom: '-6%', left: '10%', width: '80%', height: 40, background: 'radial-gradient(ellipse, rgba(0,0,0,0.35) 0%, transparent 70%)', borderRadius: '50%', zIndex: 0, filter: 'blur(12px)' }} />
            {/* Soft glow */}
            <div style={{ position: 'absolute', top: '15%', left: '15%', width: '70%', height: '70%', borderRadius: '50%', zIndex: 0, background: 'radial-gradient(circle, rgba(255, 255, 255, 0.10) 0%, transparent 65%)', filter: 'blur(60px)' }} />
          </div>
        </RevealDiv>
      </div>

      {/* Bottom fade into the page */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 140, background: 'linear-gradient(to top, var(--surface-0), transparent)', zIndex: 3, pointerEvents: 'none' }} />
    </section>
  );
}

/* ─── Feature visuals ─── */

function EncryptionStackVisual() {
  const openLightbox = useLightbox();
  const tl = useCardTilt('perspective(1600px) rotateY(10deg) rotateX(5deg) rotateZ(0.5deg)');
  const bl = useCardTilt('perspective(1600px) rotateY(-12deg) rotateX(-4deg) rotateZ(-0.8deg)');

  const bezel: React.CSSProperties = {
    position: 'absolute', borderRadius: 12, padding: 6,
    border: '1px solid rgba(255, 255, 255, 0.18)', background: BEZEL_FILL,
    overflow: 'hidden', cursor: 'zoom-in', boxShadow: BEZEL_SHADOW,
  };
  const sheen: React.CSSProperties = { position: 'absolute', inset: 0, borderRadius: 12, background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.06) 0%, transparent 35%)', pointerEvents: 'none', zIndex: 0 };
  const topEdge: React.CSSProperties = { position: 'absolute', top: 0, left: '8%', right: '8%', height: 1, background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)', pointerEvents: 'none', zIndex: 1 };
  const img: React.CSSProperties = { position: 'relative', zIndex: 2, width: '100%', display: 'block', borderRadius: 12 };

  return (
    <div className="feature-stack-visual" style={{ position: 'relative', width: '100%', paddingBottom: '78%', perspective: 1600 }}>
      <div ref={tl.ref} onMouseMove={tl.onMouseMove} onMouseLeave={tl.onMouseLeave}
        onClick={() => openLightbox(shot('privacy-encryption.png'), 'Howl Encryption Settings')}
        style={{ ...bezel, ...tl.style, top: '0%', left: '-2%', width: '64%', zIndex: 3, transformOrigin: '85% 60%' }}>
        <div style={sheen} /><div style={topEdge} />
        <Shot name="privacy-encryption" alt="Howl Encryption Settings" style={img} />
      </div>
      <div ref={bl.ref} onMouseMove={bl.onMouseMove} onMouseLeave={bl.onMouseLeave}
        onClick={() => openLightbox(shot('privacy-social.png'), 'Howl Social & Privacy')}
        style={{ ...bezel, ...bl.style, bottom: '0%', right: '-3%', width: '58%', zIndex: 4, transformOrigin: '15% 40%' }}>
        <div style={sheen} /><div style={topEdge} />
        <Shot name="privacy-social" alt="Howl Social & Privacy" style={img} />
      </div>
    </div>
  );
}

function DraggableRooVisual() {
  const openLightbox = useLightbox();
  const { ref, t, onMouseMove, onMouseLeave, cardTransition } = useStackTilt();
  return (
    <div ref={ref} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}
      className="feature-stack-visual" style={{ position: 'relative', width: '100%', minHeight: 380, perspective: 1200 }}>
      <div className="feature-stack-back" onClick={() => openLightbox(shot('entry-rules.png'), 'Howl Entry Rules')}
        style={{
          position: 'absolute', top: 0, left: 0, width: '78%', borderRadius: 12, overflow: 'hidden', padding: 4, cursor: 'zoom-in',
          border: '1px solid rgba(255, 255, 255, 0.18)', background: BEZEL_FILL,
          boxShadow: '0 40px 80px -20px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.08)',
          transform: `rotateY(${12 + t.y}deg) rotateX(${2 + t.x}deg)`, transformOrigin: 'right center', transition: cardTransition, zIndex: 1,
        }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: 12, background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.05) 0%, transparent 35%)', pointerEvents: 'none' }} />
        <Shot name="entry-rules" alt="Howl Entry Rules" style={{ width: '100%', display: 'block', borderRadius: 12 }} />
      </div>
      <div className="feature-stack-front" onClick={() => openLightbox(shot('applications.png'), 'Howl Applications')}
        style={{
          position: 'absolute', top: 50, right: 0, width: '72%', borderRadius: 12, overflow: 'hidden', padding: 4, cursor: 'zoom-in',
          border: '1px solid rgba(255, 255, 255, 0.22)', background: BEZEL_FILL,
          boxShadow: '0 40px 80px -20px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.1)',
          transform: `rotateY(${-8 + t.y}deg) rotateX(${2 + t.x}deg)`, transformOrigin: 'left center', transition: cardTransition, zIndex: 2,
        }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: 12, background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.05) 0%, transparent 35%)', pointerEvents: 'none' }} />
        <Shot name="applications" alt="Howl Applications" style={{ width: '100%', display: 'block', borderRadius: 12 }} />
      </div>
    </div>
  );
}

function SingleScreenshot({ name, alt, tilt = 'rotateY(0deg)', origin = 'center' }: { name: string; alt: string; tilt?: string; origin?: string }) {
  const openLightbox = useLightbox();
  const ref = useRef<HTMLDivElement>(null);
  const [t, setT] = useState({ x: 0, y: 0 });
  const onMove = (e: React.MouseEvent) => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setT({ x: ((e.clientY - r.top) / r.height - 0.5) * -4, y: ((e.clientX - r.left) / r.width - 0.5) * 4 });
  };
  return (
    <div style={{ position: 'relative', width: '100%', minHeight: 380, perspective: 1400 }}>
      <div ref={ref} onMouseMove={onMove} onMouseLeave={() => setT({ x: 0, y: 0 })}
        onClick={() => openLightbox(shot(`${name}.png`), alt)}
        style={{
          position: 'relative', width: '100%', borderRadius: 12, overflow: 'hidden', padding: 6, cursor: 'zoom-in',
          border: '1px solid rgba(255, 255, 255, 0.18)', background: BEZEL_FILL,
          boxShadow: '0 60px 140px -30px rgba(0,0,0,0.75), 0 28px 70px -18px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(0,0,0,0.4)',
          transform: `${tilt} rotateX(${t.x}deg) rotateY(${t.y}deg)`, transformOrigin: origin, transition: 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)',
        }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: 12, background: 'linear-gradient(135deg, rgba(255,255,255,0.06) 0%, transparent 35%)', pointerEvents: 'none', zIndex: 0 }} />
        <div style={{ position: 'absolute', top: 0, left: '8%', right: '8%', height: 1, background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)', pointerEvents: 'none', zIndex: 1 }} />
        <Shot name={name} alt={alt} style={{ position: 'relative', zIndex: 2, width: '100%', display: 'block', borderRadius: 12 }} />
      </div>
    </div>
  );
}

type CarouselImg = { name: string; alt: string; objectPosition?: string };

function ScreenshotCarousel({ images, tilt = 'rotateY(0deg)' }: { images: CarouselImg[]; tilt?: string }) {
  const openLightbox = useLightbox();
  const [idx, setIdx] = useState(0);
  const len = images.length;
  const goTo = (i: number) => setIdx((i % len + len) % len);
  const positionOf = (i: number) => ((i - idx) % len + len) % len;

  return (
    <div style={{ position: 'relative', width: '100%', minHeight: 420, perspective: 1400, paddingBottom: 36 }}>
      {images.map((im, i) => {
        const pos = positionOf(i);
        const tx = pos * 48;
        const scale = 1 - pos * 0.05;
        const opacity = pos === 0 ? 1 : 0.85 - pos * 0.1;
        return (
          <div key={i} style={{
            position: 'absolute', top: 0, left: 0, width: '100%',
            transform: `translateX(${tx}px) scale(${scale}) ${tilt}`, transformOrigin: 'top left',
            opacity, zIndex: 100 - pos, pointerEvents: 'none',
            transition: 'transform 0.55s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.45s ease, filter 0.45s ease',
            filter: pos === 0 ? 'none' : `brightness(${1 - pos * 0.08})`,
          }}>
            <div style={{
              position: 'relative', width: '100%', aspectRatio: '1.39 / 1', borderRadius: 12, overflow: 'hidden', padding: 6,
              border: '1px solid rgba(255, 255, 255, 0.18)', background: BEZEL_FILL,
              boxShadow: '0 60px 140px -30px rgba(0,0,0,0.75), 0 28px 70px -18px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(0,0,0,0.4)',
            }}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: 12, background: 'linear-gradient(135deg, rgba(255,255,255,0.06) 0%, transparent 35%)', pointerEvents: 'none', zIndex: 0 }} />
              <div style={{ position: 'absolute', top: 0, left: '8%', right: '8%', height: 1, background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)', pointerEvents: 'none', zIndex: 1 }} />
              <Shot name={im.name} alt={im.alt} draggable={false}
                style={{ position: 'absolute', inset: 6, zIndex: 2, width: 'calc(100% - 12px)', height: 'calc(100% - 12px)', objectFit: 'cover', objectPosition: im.objectPosition || 'center top', display: 'block', borderRadius: 12 }} />
            </div>
          </div>
        );
      })}

      <button onClick={() => goTo(idx - 1)} aria-label="Previous screenshot"
        style={{ position: 'absolute', left: 0, top: 0, bottom: 36, width: '50%', background: 'transparent', border: 'none', padding: 0, cursor: 'w-resize', zIndex: 150 }} />
      <button onClick={() => goTo(idx + 1)} aria-label="Next screenshot"
        style={{ position: 'absolute', right: 0, top: 0, bottom: 36, width: '50%', background: 'transparent', border: 'none', padding: 0, cursor: 'e-resize', zIndex: 150 }} />

      <div style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 8, zIndex: 200 }}>
        {images.map((_, i) => (
          <button key={i} onClick={(e) => { e.stopPropagation(); goTo(i); }} aria-label={`Go to screenshot ${i + 1}`}
            style={{ width: i === idx ? 22 : 8, height: 8, borderRadius: 12, background: i === idx ? 'var(--howl-accent)' : 'rgba(255,255,255,0.25)', border: 'none', padding: 0, cursor: 'pointer', transition: 'width 0.25s ease, background 0.25s ease' }} />
        ))}
      </div>

      <button onClick={(e) => { e.stopPropagation(); const im = images[idx]; openLightbox(shot(`${im.name}.png`), im.alt); }} aria-label="Zoom screenshot"
        style={{
          position: 'absolute', top: 10, right: 10, width: 34, height: 34, borderRadius: '50%',
          background: 'rgba(15, 23, 42, 0.7)', border: '1px solid rgba(255,255,255,0.18)', color: '#fff', cursor: 'zoom-in',
          display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
          boxShadow: '0 6px 16px rgba(0,0,0,0.4)', zIndex: 200, transition: 'background 0.15s ease, transform 0.15s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(15, 23, 42, 0.92)'; e.currentTarget.style.transform = 'scale(1.06)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(15, 23, 42, 0.7)'; e.currentTarget.style.transform = 'scale(1)'; }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><line x1="20" y1="20" x2="16.5" y2="16.5" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
        </svg>
      </button>
    </div>
  );
}

/* ─── Feature card ─── */

type FeatureCardProps = {
  title: string; desc: string; bullets?: string[];
  animType: string; reverse?: boolean; index: number; visual: React.ReactNode;
  learnMore?: { label: string; to: string };
};

function FeatureCard({ title, desc, bullets, animType, reverse, index, visual, learnMore }: FeatureCardProps) {
  return (
    <div style={{ position: 'relative', padding: 'clamp(80px, 10vw, 140px) 0', borderTop: index === 0 ? 'none' : '1px solid rgba(255,255,255,0.06)' }}>
      <RevealDiv type={animType}>
        <div className="feature-row" style={{
          position: 'relative', zIndex: 2, display: 'flex', flexDirection: reverse ? 'row-reverse' : 'row',
          alignItems: 'center', gap: 'clamp(40px, 6vw, 96px)', maxWidth: 1200, margin: '0 auto',
        }}>
          <div style={{ flex: '1 1 420px', minWidth: 0 }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(36px, 5vw, 60px)', fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.015em', lineHeight: 1.05, margin: '0 0 10px', textWrap: 'balance' } as React.CSSProperties}>{title}</h2>
            <p style={{ fontFamily: 'var(--font-body)', fontSize: 'clamp(16px, 1.4vw, 18px)', lineHeight: 1.65, color: 'var(--text-muted)', margin: 0, maxWidth: '52ch', whiteSpace: 'pre-line' }}>{desc}</p>
            {bullets && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 32 }}>
                {bullets.map((b, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 14, paddingBottom: 14, borderBottom: i < bullets.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                    <div style={{ flexShrink: 0, width: 22, height: 22, marginTop: 1, borderRadius: 12, background: 'linear-gradient(135deg, rgba(var(--howl-button-rgb), 0.3), rgba(var(--howl-button-rgb), 0.08))', border: '1px solid rgba(var(--howl-button-rgb), 0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--howl-button)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    </div>
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 15, color: 'var(--text-muted)', lineHeight: 1.5 }}>{b}</span>
                  </div>
                ))}
              </div>
            )}
            {learnMore && (
              <Link to={learnMore.to} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 28,
                color: 'var(--howl-button)', fontFamily: 'var(--font-body)', fontSize: 15, fontWeight: 600,
                textDecoration: 'none',
              }}
                onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.opacity = '0.8'; }}
                onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.opacity = '1'; }}
              >
                {learnMore.label}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </Link>
            )}
          </div>
          <div style={{ flex: '1 1 540px', minWidth: 0, position: 'relative' }}>{visual}</div>
        </div>
      </RevealDiv>
    </div>
  );
}

function FeaturesSection() {
  const cards: FeatureCardProps[] = [
    {
      title: 'Quantum-safe and private.', animType: 'sr-card-pop', reverse: false, index: 0,
      desc: "Your DMs, group chats, and calls are end-to-end encrypted with MLS (RFC 9420) and secured by post-quantum key exchange. You hold your own keys by default, so we can't read them.",
      bullets: [
        'End-to-end encrypted with MLS (RFC 9420), the IETF messaging standard',
        'Post-quantum key exchange: X-Wing (X25519 + ML-KEM-768)',
        'You hold your keys by default, with forward secrecy on every message',
        'Encrypted voice, video, and screen-share calls too',
      ],
      learnMore: { label: 'How our encryption works', to: '/about#security' },
      visual: (
        <div style={{ position: 'relative' }}>
          <EncryptionStackVisual />
          <LockedSticker src={asset('roo-lock-key.webp')} alt="Lock & Key Roo" desktop={{ x: 315, y: 89, w: 432, rot: -4 }} mobile={{ x: 18, y: 376, w: 396, rot: -4 }} aspect={2048 / 2732} />
        </div>
      ),
    },
    {
      title: 'Invite, join, done.', animType: 'sr-card-pop', reverse: true, index: 1,
      desc: 'With different server entry rules, start a competitive group, require applications via clips and rise to the top of the discover boards.\nOr just invite your friends with a link or an open-door policy. You choose!',
      bullets: ['One-link invites and custom vanity URLs', 'Optional server applications for communities that want them', 'Works instantly on web, desktop, and mobile'],
      visual: (
        <div style={{ position: 'relative' }}>
          <DraggableRooVisual />
          <LockedSticker src={asset('roo-wave-animated.webp')} alt="Waving Roo" desktop={{ x: 855, y: 74, w: 487, rot: 0 }} mobile={{ x: 77, y: 115, w: 375, rot: 0 }} aspect={2048 / 2732} />
        </div>
      ),
    },
    {
      title: 'New events or exciting news?', animType: 'sr-card-pop', reverse: false, index: 2,
      desc: 'Check out server calendars.',
      bullets: ['Schedule role-based events', 'Coordinate sessions', 'Plan for game drops or anything else'],
      visual: (
        <div style={{ position: 'relative' }}>
          <SingleScreenshot name="server-calendar" alt="Howl Server Calendar" tilt="rotateY(-10deg) rotateX(2deg)" origin="left center" />
          <LockedSticker src={asset('roo-megaphone.webp')} alt="Megaphone Roo" desktop={{ x: -493, y: 149, w: 343, rot: -6 }} mobile={{ x: 90, y: -260, w: 371, rot: -6 }} aspect={2048 / 2732} />
        </div>
      ),
    },
    {
      title: 'Make it yours.', animType: 'sr-card-pop', reverse: true, index: 3,
      desc: 'Everyone has a different style. Create your own with highly customizable themes, status bars, showcase cards, names, animated backgrounds, banners and profile pictures.',
      bullets: ['Five themes plus fully Custom', 'Animated profile and name effects with Pro', 'Custom backgrounds, particles, and showcase cards'],
      visual: (
        <div style={{ position: 'relative' }}>
          <ScreenshotCarousel images={[
            { name: 'appearance-1', alt: 'Howl Appearance — Preview & Theme' },
            { name: 'appearance-2', alt: 'Howl Appearance — Layout & Colors' },
            { name: 'appearance-3', alt: 'Howl Appearance — Density & Scaling' },
          ]} tilt="rotateY(8deg) rotateX(3deg)" />
          <LockedSticker src={asset('painter-roo.webp')} alt="Painter Roo" desktop={{ x: 966, y: -104, w: 376, rot: 0 }} mobile={{ x: 97, y: -542, w: 388, rot: 0 }} aspect={2048 / 2732} />
        </div>
      ),
    },
    {
      title: 'Your space, your rools.', animType: 'sr-tilt-left', reverse: false, index: 4,
      desc: 'Tools to build and run communities without the bloat. Discover servers, manage applications, schedule events.',
      bullets: ['Server discovery: browse and join public communities', 'Apply to join: gate your server with custom applications', 'Group calendar: schedule events and game nights'],
      visual: (
        <div style={{ position: 'relative' }}>
          <ScreenshotCarousel images={[
            { name: 'roles', alt: 'Howl Roles' },
            { name: 'self-roles', alt: 'Howl Self Roles' },
            { name: 'safety', alt: 'Howl Safety' },
            { name: 'auto-filter', alt: 'Howl Auto Filter' },
          ]} tilt="rotateY(-8deg) rotateX(3deg)" />
          <LockedSticker src={asset('roo-reading-transparent.webp')} alt="Reading Roo" desktop={{ x: -242, y: 40, w: 89, rot: 0 }} mobile={{ x: 79, y: -82, w: 80, rot: 0 }} aspect={634 / 551} />
        </div>
      ),
    },
  ];

  return (
    <section id="features" style={{ position: 'relative', padding: '40px clamp(24px, 6vw, 80px) 80px', overflow: 'hidden' }}>
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1200, margin: '0 auto' }}>
        <RevealDiv style={{ textAlign: 'center', maxWidth: 760, margin: '0 auto 24px' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(36px, 5.5vw, 68px)', fontWeight: 600, color: 'var(--text)', margin: '0 0 20px', letterSpacing: '-0.02em', lineHeight: 1.05, textWrap: 'balance' } as React.CSSProperties}>Roo has fun.<br />You should too.</h2>
          <p style={{ fontFamily: 'var(--font-body)', fontSize: 'clamp(15px, 1.4vw, 18px)', color: 'var(--text-faint)', maxWidth: '52ch', margin: '0 auto', lineHeight: 1.65 }}>Some of our favorite things are listed below. We're open to suggestions, improvements, and fresh ideas. Drop them in the feedback button in Howl.</p>
        </RevealDiv>

        <div>
          {cards.map((card) => <FeatureCard key={card.index} {...card} />)}
        </div>
      </div>
    </section>
  );
}

/* ─── Showcase (currently hidden — see the render below for why) ─── */
function _ShowcaseSection() {
  return (
    <section id="showcase" style={{ padding: '100px clamp(24px, 6vw, 80px)', maxWidth: 1200, margin: '0 auto' }}>
      <RevealDiv style={{ textAlign: 'center', marginBottom: 48 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(28px, 4vw, 48px)', fontWeight: 700, color: 'var(--text)', margin: '12px 0 16px', letterSpacing: '-0.02em' }}>
          <span style={{ color: 'var(--howl-accent)' }}>Showcase</span>, Showoff.
        </h2>
        <p style={{ fontFamily: 'var(--font-body)', fontSize: 17, color: 'var(--text-faint)', maxWidth: '55ch', margin: '0 auto', lineHeight: 1.6 }}>Connect your Steam, game accounts, and Spotify. Showcase cards display your K/D, playtime, rank history, and music right on your profile.</p>
      </RevealDiv>

      <RevealDiv delay={150}>
        {/* Neutral dark surface (no blue tint) — see "dont deviate from the dark blue":
            the bezel itself is neutral so the screenshot's UI accents read correctly. */}
        <div style={{
          position: 'relative', maxWidth: 880, margin: '0 auto', borderRadius: 12, overflow: 'hidden', padding: 8,
          border: '1px solid rgba(255,255,255,0.10)', background: BEZEL_FILL,
          boxShadow: '0 60px 140px -30px rgba(0,0,0,0.7), 0 24px 60px -16px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)',
        }}>
          <div style={{ position: 'absolute', inset: 0, borderRadius: 12, background: 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, transparent 35%)', pointerEvents: 'none', zIndex: 0 }} />
          <Shot name="showcase-real" alt="Howl Showcase Cards" style={{ position: 'relative', zIndex: 1, width: '100%', display: 'block', borderRadius: 12 }} />
        </div>
      </RevealDiv>
    </section>
  );
}

/* ─── Pricing ─── */

function PricingSection() {
  const plans = [
    { name: 'Free', price: '$0', sub: 'forever', features: ['50MB uploads', '720p 30fps webcam', '1080p 30fps screen share', 'Voice bitrate 96 kbps', '2 showcase cards', 'Banner color only'], cta: 'Get Started', accent: false },
    { name: 'Pro Essential', price: '$4.99', sub: '/mo', features: ['100MB uploads', 'Up to 1080p 30fps webcam', '1080p 60fps screen share', 'Voice bitrate 128 kbps', '4 showcase cards', 'Banner image upload'], cta: 'Subscribe', accent: false },
    { name: 'Howl Pro', price: '$8.99', sub: '/mo', features: ['500MB uploads', 'Up to 1440p 30fps webcam', '1440p 60fps screen share', 'Voice bitrate 384 kbps', 'Up to 12 showcase cards', 'Hero showcase card (3×2)', 'Animated GIF banner & backgrounds', 'Profile & name effects', 'Custom name color & font', 'Colored chat text'], cta: 'Go Pro', accent: true },
  ];

  return (
    <section id="pricing" style={{ padding: '100px clamp(24px, 6vw, 80px)', maxWidth: 1100, margin: '0 auto' }}>
      <RevealDiv style={{ textAlign: 'center', marginBottom: 64 }}>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-faint)' }}>Pricing</span>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(28px, 4vw, 48px)', fontWeight: 700, color: 'var(--text)', margin: '12px 0 16px', letterSpacing: '-0.02em' }}>Simple, honest pricing</h2>
        <p style={{ fontFamily: 'var(--font-body)', fontSize: 17, color: 'var(--text-faint)', maxWidth: '50ch', margin: '0 auto', lineHeight: 1.6 }}>Howl is free to use. Pro unlocks extra flair. Never paywalled features.</p>
      </RevealDiv>

      <div className="pricing-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 20, alignItems: 'stretch' }}>
        {/* Free + Pro Essential stacked */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {plans.filter(p => !p.accent).map((p, i) => (
            <RevealDiv key={p.name} delay={i * 100} style={{ padding: 28, borderRadius: 12, flex: 1, background: 'var(--surface-1)', border: '1px solid var(--border-soft)', display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: 'var(--text-faint)', marginBottom: 8 }}>{p.name}</span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 20 }}>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 700, color: 'var(--text)' }}>{p.price}</span>
                <span style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--text-faint)' }}>{p.sub}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, marginBottom: 24 }}>
                {p.features.map((f, j) => (
                  <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--howl-button)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-muted)' }}>{f}</span>
                  </div>
                ))}
              </div>
              <Link to="/login" style={{ display: 'block', textAlign: 'center', padding: '10px 20px', borderRadius: 12, background: 'var(--surface-2)', color: 'var(--text)', fontFamily: 'var(--font-body)', fontSize: 14, fontWeight: 600, textDecoration: 'none' }}>{p.cta}</Link>
            </RevealDiv>
          ))}
        </div>

        {/* Featured Howl Pro */}
        {plans.filter(p => p.accent).map(p => (
          <RevealDiv key={p.name} delay={200} style={{ padding: 36, borderRadius: 12, background: 'var(--surface-1)', border: '1px solid rgba(var(--howl-button-rgb), 0.45)', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 20, right: 20, padding: '4px 10px', borderRadius: 12, background: 'rgba(var(--howl-button-rgb), 0.18)', border: '1px solid rgba(var(--howl-button-rgb), 0.4)', fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 600, color: 'var(--text)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Most Popular</div>
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 12 }}>{p.name}</span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 32 }}>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 56, fontWeight: 700, color: 'var(--text)' }}>{p.price}</span>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 16, color: 'var(--text-faint)' }}>{p.sub}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, marginBottom: 32 }}>
              {p.features.map((f, j) => (
                <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--howl-button)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 15, color: 'var(--text-muted)' }}>{f}</span>
                </div>
              ))}
            </div>
            <Link to="/login" className="btn-primary" style={{ display: 'block', textAlign: 'center', padding: '14px 28px', borderRadius: 12, background: '#02385A', color: '#fff', fontFamily: 'var(--font-body)', fontSize: 16, fontWeight: 600, textDecoration: 'none', boxShadow: '0 8px 24px var(--accent-glow)' }}>{p.cta}</Link>
          </RevealDiv>
        ))}
      </div>
    </section>
  );
}

/* ─── Download ─── */

function DownloadSection({ userOS }: { userOS: UserOS }) {
  const downloadDisabled = DOWNLOAD_URLS[userOS] === '#';
  return (
    <section id="download" style={{ padding: '100px clamp(24px, 6vw, 80px) 60px', maxWidth: 700, margin: '0 auto', textAlign: 'center' }}>
      <RevealDiv>
        <div style={{ padding: '64px 48px', borderRadius: 12, background: 'var(--surface-1)', border: '1px solid var(--border-soft)' }}>
          <span style={{ display: 'block', fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Get Howl</span>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(28px, 4vw, 48px)', fontWeight: 700, color: 'var(--text)', margin: '0 0 16px', letterSpacing: '-0.02em' }}>Come Play!</h2>
          <p style={{ fontFamily: 'var(--font-body)', fontSize: 17, color: 'var(--text-faint)', lineHeight: 1.6, margin: '0 0 32px' }}>Join the open beta. Free, private, and takes under a minute.</p>
          <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap' }}>
            {/* 3-segment bar — Download / Open in Browser / Discover. flex:1
               segments inside a maxWidth wrapper so the bar reads as a single
               balanced rectangle that visually lines up under the heading. */}
            <div className="seg-bar" style={{
              display: 'flex', alignItems: 'stretch', width: '100%', maxWidth: 520, background: '#02385A', borderRadius: 12,
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255,255,255,0.06) inset',
              overflow: 'hidden', fontFamily: 'var(--font-body)',
              opacity: downloadDisabled ? 0.7 : 1,
            }}>
              <a
                href={downloadDisabled ? undefined : DOWNLOAD_URLS[userOS]}
                aria-disabled={downloadDisabled || undefined}
                className="btn-primary seg-link"
                style={{
                  flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px',
                  color: '#fff', textDecoration: 'none', fontSize: 15, fontWeight: 600,
                  transition: 'background 0.15s', cursor: downloadDisabled ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
                onClick={downloadDisabled ? (e) => e.preventDefault() : undefined}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                {DOWNLOAD_LABEL[userOS]}{downloadDisabled ? ' · Coming soon' : ''}
              </a>
              <div className="seg-divider" style={{ width: 1, background: 'rgba(255,255,255,0.18)' }} />
              <Link to="/login" className="seg-link" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px', color: '#fff', textDecoration: 'none', fontSize: 15, fontWeight: 600, transition: 'background 0.15s', whiteSpace: 'nowrap' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                Browser
              </Link>
              <div className="seg-divider" style={{ width: 1, background: 'rgba(255,255,255,0.18)' }} />
              <Link to="/discover" className="seg-link" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 16px', color: '#fff', textDecoration: 'none', fontSize: 15, fontWeight: 600, transition: 'background 0.15s', whiteSpace: 'nowrap' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" /></svg>
                Discover
              </Link>
            </div>
          </div>
        </div>
      </RevealDiv>
    </section>
  );
}

/* ─── Footer (real legal links — paths match App.tsx routes) ─── */

function Footer() {
  const linkStyle: React.CSSProperties = { fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-faint)', textDecoration: 'none', transition: 'color 0.15s' };
  const hover = (on: boolean) => (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.color = on ? 'var(--text-muted)' : 'var(--text-faint)'; };
  return (
    <footer style={{ padding: '40px clamp(24px, 6vw, 80px)', maxWidth: 1200, margin: '0 auto', borderTop: '1px solid var(--border-soft)', display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Crypto disambiguation — Howl is a messaging app, not a token. This is
          explicit so impersonators / fake-airdrop sites can't claim association.
          Kept visible (not hidden behind a legal-page link) so anyone scrolling
          the landing reads it. */}
      <p style={{
        fontFamily: 'var(--font-body)', fontSize: 12, lineHeight: 1.55,
        color: 'var(--text-faint)', margin: 0, maxWidth: '90ch',
      }}>
        <strong style={{ color: 'var(--text-muted)' }}>No crypto, no tokens, no coins.</strong>{' '}
        Howl is a messaging app and is not affiliated with, does not issue, and does not endorse any
        cryptocurrency, token, coin, NFT, memecoin, ICO, airdrop, or related digital asset.
        Any wallet, ticker, contract, or exchange listing claiming a Howl connection is not us.
        We do not solicit investment, run a presale, or distribute crypto rewards.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-faint)' }}>© {new Date().getFullYear()} Howl LLC. Built with care, not surveillance.</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
          <Link to="/about" style={linkStyle} onMouseEnter={hover(true)} onMouseLeave={hover(false)}>About</Link>
          <Link to="/credits" style={linkStyle} onMouseEnter={hover(true)} onMouseLeave={hover(false)}>Credits</Link>
          <Link to="/terms-of-service" style={linkStyle} onMouseEnter={hover(true)} onMouseLeave={hover(false)}>Terms</Link>
          <Link to="/privacy-policy" style={linkStyle} onMouseEnter={hover(true)} onMouseLeave={hover(false)}>Privacy</Link>
          <Link to="/community-guidelines" style={linkStyle} onMouseEnter={hover(true)} onMouseLeave={hover(false)}>Community</Link>
          <Link to="/dmca-policy" style={linkStyle} onMouseEnter={hover(true)} onMouseLeave={hover(false)}>DMCA</Link>
          <Link to="/refund-policy" style={linkStyle} onMouseEnter={hover(true)} onMouseLeave={hover(false)}>Refunds</Link>
          <Link to="/law-enforcement" style={linkStyle} onMouseEnter={hover(true)} onMouseLeave={hover(false)}>Law Enforcement</Link>
          <Link to="/accessibility" style={linkStyle} onMouseEnter={hover(true)} onMouseLeave={hover(false)}>Accessibility</Link>
        </div>
      </div>
    </footer>
  );
}

/* ─── Lightbox overlay ─── */

function LightboxOverlay({ state, onClose }: { state: { src: string; alt: string } | null; onClose: () => void }) {
  if (!state) return null;
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(2, 6, 23, 0.85)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'clamp(20px, 5vw, 60px)',
      cursor: 'zoom-out', animation: 'lightboxFadeIn 0.2s ease-out',
    }}>
      {/* Neutral dark frame (no blue gradient) — keeps the lightboxed screenshot the focal point,
          and avoids the blue surround the user flagged. */}
      <div style={{
        display: 'inline-block', borderRadius: 12, padding: 6, border: '1px solid rgba(255, 255, 255, 0.18)',
        background: BEZEL_FILL,
        boxShadow: '0 60px 140px -20px rgba(0,0,0,0.8)', animation: 'lightboxPop 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)', cursor: 'zoom-out',
      }}>
        <img src={state.src} alt={state.alt} style={{ display: 'block', maxWidth: 'min(1400px, calc(92vw - 12px))', maxHeight: 'calc(90vh - 12px)', width: 'auto', height: 'auto', borderRadius: 12 }} />
      </div>
    </div>
  );
}

/* ─── Scoped styles + hand-drawn SVG filters ─── */

const LANDING_CSS = `
.howl-landing {
  --surface-0: #000000;
  --surface-1: oklch(0.14 0 0);
  --surface-2: oklch(0.19 0 0);
  --surface-3: oklch(0.24 0 0);
  --surface-veil: oklch(0.08 0 0 / 0.72);
  --text: oklch(0.98 0.005 230);
  --text-muted: oklch(0.78 0.012 230);
  --text-faint: oklch(0.58 0.014 230);
  --border-soft: oklch(0.98 0.01 230 / 0.06);
  --border: oklch(0.98 0.01 230 / 0.10);
  --border-strong: oklch(0.98 0.01 230 / 0.18);
  /* Pin the brand accent locally so the landing page renders the same way
     regardless of which [data-theme] the user picked in-app. Without this,
     selecting Light / Grey / Custom would repaint every CTA on the landing
     too. */
  --cyan-accent: #076FA0;
  --accent-glow: rgba(7, 111, 160, 0.30);
  /* All accent variants resolve to the brand "logo blue" — #076FA0 — so we
     never deviate from the dark blue, no matter which CSS var a section uses. */
  --howl-deep: var(--cyan-accent);
  --howl-accent: var(--cyan-accent); --howl-accent-rgb: 7, 111, 160;
  --howl-glow: var(--accent-glow);
  --howl-button: var(--cyan-accent); --howl-button-rgb: 7, 111, 160;
  --font-body: 'Satoshi', 'Plus Jakarta Sans', sans-serif;
  --font-display: 'Clash Display', 'Plus Jakarta Sans', sans-serif;
  background: var(--surface-0);
  color: var(--text);
  font-family: var(--font-body);
  position: relative;
  isolation: isolate;
  height: 100vh;
  overflow-y: auto;
  overflow-x: hidden;
  scroll-behavior: smooth;
  -webkit-font-smoothing: antialiased;
}
.howl-landing *, .howl-landing *::before, .howl-landing *::after { box-sizing: border-box; }
.howl-landing picture { display: contents; }
.howl-landing ::-webkit-scrollbar { width: 6px; }
.howl-landing ::-webkit-scrollbar-track { background: transparent; }
.howl-landing ::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 3px; }
.howl-landing ::-webkit-scrollbar-thumb:hover { background: oklch(0.98 0.01 230 / 0.28); }

/* Scroll reveal — subtle below the hero */
.howl-landing .sr { opacity: 0; will-change: transform, opacity, filter; transform: translateY(8px); transition: opacity 0.4s ease-out, transform 0.4s ease-out; }
.howl-landing .sr.sr-vis { opacity: 1; transform: none; }

/* Hero — hand-drawn cel-frame pop */
.howl-landing #hero .sr { transform: scale(0.86) rotate(-2deg); transition: none; }
.howl-landing #hero .sr.sr-vis { animation: handDrawnPop 0.55s steps(5, jump-end) forwards, handDrawnBoil 0.55s steps(5, jump-end) forwards; }
@keyframes handDrawnPop {
  0%   { opacity: 0; transform: scale(0.78) rotate(-3deg); }
  20%  { opacity: 1; transform: scale(1.06) rotate(2.2deg); }
  40%  { opacity: 1; transform: scale(0.94) rotate(-1.4deg); }
  60%  { opacity: 1; transform: scale(1.025) rotate(0.8deg); }
  80%  { opacity: 1; transform: scale(0.992) rotate(-0.3deg); }
  100% { opacity: 1; transform: scale(1) rotate(0deg); }
}
@keyframes handDrawnBoil {
  0%   { filter: url(#boil1); }
  20%  { filter: url(#boil2); }
  40%  { filter: url(#boil3); }
  60%  { filter: url(#boil1); }
  80%  { filter: url(#boil2); }
  100% { filter: none; }
}

/* Per-card feature entrances — the sr-vis reset (below) animates them home */
.howl-landing #features .sr.sr-card-pop { transform: scale(0.86); transition: opacity 0.7s ease-out, transform 0.7s cubic-bezier(0.34, 1.56, 0.64, 1); }
.howl-landing #features .sr.sr-tilt-left { transform: translateX(-80px) rotate(-2.5deg); transition: opacity 0.9s ease-out, transform 0.9s cubic-bezier(0.22, 1, 0.36, 1); }
.howl-landing #features .sr.sr-tilt-right { transform: translateX(80px) rotate(2.5deg); transition: opacity 0.9s ease-out, transform 0.9s cubic-bezier(0.22, 1, 0.36, 1); }
.howl-landing #features .sr.sr-vis { transform: none; filter: none; }

@media (prefers-reduced-motion: reduce) {
  .howl-landing .sr { transform: none; transition: opacity 0.3s linear; }
  .howl-landing .sr.sr-vis { animation: none !important; filter: none !important; transform: none; }
  .howl-landing #features .sr.sr-card-pop,
  .howl-landing #features .sr.sr-tilt-left,
  .howl-landing #features .sr.sr-tilt-right { transform: none; }
  /* Decorative animated mascots — these are <img>s pointing at animated
     WebPs/GIFs (roo-waving, roo-puppy, roo-megaphone, painter-roo, etc.).
     The browser decodes + composites their frames continuously regardless
     of viewport visibility, which is the biggest single perf cost on the
     landing page. Under reduce-motion we hide the whole sticker layer; it's
     purely decorative so nothing in the information flow is lost. Also
     suppresses .roo-deco transforms applied via the LockedSticker rotation. */
  .howl-landing .roo-deco,
  .howl-landing .hero-floating-roo,
  .howl-landing .hero-roo-video-wrap { display: none !important; }
  /* Tilt cards (chat / showcase / pricing screenshots) — drop the transform
     transition so hover doesn't ease at all under reduce-motion. */
  .howl-landing .hero-screenshot-stack > div { transition: none !important; }
}

/* Button feedback */
.howl-landing .btn-primary:hover { filter: brightness(1.08); transform: translateY(-2px); box-shadow: 0 12px 32px var(--howl-glow); }
.howl-landing .btn-primary:active { transform: translateY(0) scale(0.98); filter: brightness(0.95); transition-duration: 0.1s; }
.howl-landing .btn-primary[aria-disabled='true']:hover { filter: none; transform: none; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255,255,255,0.06) inset; }
.howl-landing .seg-link:hover { background: rgba(255,255,255,0.08); }
.howl-landing a, .howl-landing button, .howl-landing [role='button'] { cursor: pointer; }

/* Lightbox */
@keyframes lightboxFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes lightboxPop { from { opacity: 0; transform: scale(0.94); } to { opacity: 1; transform: scale(1); } }

/* Responsive */
@media (max-width: 900px) {
  .howl-landing .feature-row { flex-direction: column !important; align-items: stretch !important; }
  .howl-landing .feature-row > div { width: 100% !important; flex-basis: auto !important; }
  .howl-landing .hero-inner { flex-direction: column !important; align-items: stretch !important; }
  .howl-landing .hero-inner > div { width: 100% !important; flex-basis: auto !important; }
  .howl-landing .pricing-grid { grid-template-columns: 1fr !important; }
  .howl-landing .hero-screenshot-stack { padding-bottom: 0 !important; perspective: none !important; }
  .howl-landing .hero-screenshot-stack > div { position: relative !important; width: 100% !important; top: auto !important; left: auto !important; right: auto !important; bottom: auto !important; transform: none !important; margin-bottom: 18px !important; }
  .howl-landing .hero-screenshot-stack > div:empty { display: none !important; }
  .howl-landing .feature-stack-visual { min-height: 0 !important; padding-bottom: 0 !important; perspective: none !important; }
  .howl-landing .feature-stack-visual > div { position: relative !important; top: auto !important; left: auto !important; right: auto !important; bottom: auto !important; width: 100% !important; transform: none !important; margin-bottom: 14px !important; }
  .howl-landing .feature-stack-visual > div:empty { display: none !important; }
  .howl-landing #hero { padding: 60px 20px 40px !important; }
}
@media (max-width: 768px) {
  .howl-landing .nav-links-desktop { display: none !important; }
  .howl-landing .nav-hamburger { display: block !important; }
  .howl-landing .nav-mascot-mobile { display: block !important; }
}
@media (max-width: 600px) {
  /* Segmented CTA bar (hero + DownloadSection): on narrow viewports the three
     nowrap segments overflow their fixed-radius wrapper, so stack them into a
     single full-width column and turn the vertical dividers into horizontal ones. */
  .howl-landing .seg-bar { flex-direction: column !important; }
  .howl-landing .seg-bar .seg-link { flex: none !important; width: 100% !important; white-space: normal !important; }
  .howl-landing .seg-bar .seg-divider { width: 100% !important; height: 1px !important; }
}
`;

function HandDrawnFilters() {
  return (
    <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}>
      <defs>
        <filter id="boil1" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves={2} seed={1} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={3.2} />
        </filter>
        <filter id="boil2" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves={2} seed={7} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={3.6} />
        </filter>
        <filter id="boil3" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.022" numOctaves={2} seed={13} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={3} />
        </filter>
      </defs>
    </svg>
  );
}

/* ─── Page ─── */

export function LandingPage() {
  const [userOS] = useState<UserOS>(detectOS);
  const [scrolled, setScrolled] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const openLightbox = useCallback<OpenLightbox>((src, alt = '') => setLightbox({ src, alt }), []);

  useEffect(() => { document.title = 'Howl — Talk freely. Stay private.'; }, []);

  // Escape closes the lightbox
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // Reveal-on-scroll within the landing scroll container
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('sr-vis'); io.unobserve(e.target); }
      });
    }, { root, threshold: 0.12, rootMargin: '0px 0px -12% 0px' });
    root.querySelectorAll('.sr').forEach(el => io.observe(el));
    return () => io.disconnect();
  }, []);

  // Smooth-scroll in-page anchors within the container.
  // Links with `data-nearest-of="id1,id2,…"` pick whichever listed target is
  // closest to the user's current scroll position — used by the nav "Get Howl"
  // button so it lands on the hero CTA when scrolled high and on the bottom
  // DownloadSection CTA when scrolled low, rather than always jumping all the
  // way to the bottom of the page.
  const onRootClick = useCallback((e: React.MouseEvent) => {
    const root = rootRef.current;
    if (!root) return;
    const a = (e.target as HTMLElement).closest('a[href^="#"], a[data-nearest-of]') as HTMLAnchorElement | null;
    if (!a) return;

    const nearestList = a.getAttribute('data-nearest-of');
    if (nearestList) {
      const ids = nearestList.split(',').map(s => s.trim()).filter(Boolean);
      const candidates = ids
        .map(id => root.querySelector(`#${CSS.escape(id)}`))
        .filter((el): el is HTMLElement => el instanceof HTMLElement);
      if (candidates.length === 0) return; // fall through to the normal anchor handler below
      e.preventDefault();
      const rootRect = root.getBoundingClientRect();
      const viewMid = root.scrollTop + root.clientHeight / 2;
      let best = candidates[0];
      let bestDist = Infinity;
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        const elMid = r.top - rootRect.top + root.scrollTop + r.height / 2;
        const d = Math.abs(elMid - viewMid);
        if (d < bestDist) { best = el; bestDist = d; }
      }
      best.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const href = a.getAttribute('href') || '';
    if (!href.startsWith('#')) return;
    e.preventDefault();
    const id = href.slice(1);
    if (!id) { root.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    root.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  return (
    <LightboxContext.Provider value={openLightbox}>
      <style>{LANDING_CSS}</style>
      <HandDrawnFilters />
      <div
        ref={rootRef}
        className="howl-landing"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 40)}
        onClick={onRootClick}
      >
        <Nav scrolled={scrolled} />
        <HeroSection userOS={userOS} />
        <FeaturesSection />
        {/* ShowcaseSection is hidden until we have a clean showcase-real.png
            (the current one bakes in a placeholder demo username);
            the function below is kept so it's one line away from coming back. */}
        <PricingSection />
        <DownloadSection userOS={userOS} />
        <Footer />
        <LightboxOverlay state={lightbox} onClose={() => setLightbox(null)} />
      </div>
    </LightboxContext.Provider>
  );
}
