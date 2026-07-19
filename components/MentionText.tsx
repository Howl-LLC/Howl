// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useMemo, useSyncExternalStore, Suspense, lazy } from 'react';
import { parseContentWithMentions, type MentionSegment } from '../utils/mentionUtils';
import { parseInlineMarkdown, parseContentBlocks, type InlineMarkdownSegment, type BlockSegment } from '../utils/markdownUtils';
import { getTwemojiUrl } from '../utils/twemoji';
import { useSpoilerReveal } from './SpoilerRevealContext';
import { useSettings } from '../contexts/SettingsContext';
import { getCustomEmojiMap, subscribeCustomEmojis } from '../utils/customEmojiStore';
import { LazyGif } from './LazyGif';
import { LazyIframe } from './LazyIframe';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { retryOnExpired, toOriginalUploadPath } from '../utils/signedImageRetry';
import { getImageDims, rememberImageDims } from '../utils/imageDimCache';
import { API_BASE_URL, isElectron, getWebOrigin } from '../config';
import { isValidYouTubeId } from '../utils/securityUtils';
import { ImageLightbox } from './ImageLightbox';
import { RoleNameStyle } from './RoleNameStyle';
import type { Server } from '../types';
import { apiClient } from '../services/api';

// CodeBlockEmbed pulls in highlight.js + 26 language grammars + DOMPurify
// (~200–250 kB). Only loaded when a message actually contains a ```code```
// block, which is a minority of messages. Fallback renders the raw code in
// a plain <pre> so text is immediately visible while the chunk streams in.
const CodeBlockEmbed = lazy(() =>
  import('./CodeBlockEmbed').then((m) => ({ default: m.CodeBlockEmbed })),
);

function CodeBlockFallback({ code }: { code: string }) {
  return (
    <pre
      className="my-2 rounded-xl overflow-hidden border p-3 text-sm"
      style={{
        backgroundColor: 'var(--fill-hover)',
        borderColor: 'var(--glass-border)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        margin: '0.5rem 0',
      }}
    >
      {code}
    </pre>
  );
}

/**
 * Return the hostname to send as the `parent` query param for embed iframes
 * (Twitch). In Electron the page origin is `howl-app://app` so
 * window.location.hostname is the literal string "app", which Twitch rejects.
 * Use the canonical web frontend host (registered for the embed) instead.
 */
function getEmbedParent(): string {
  if (typeof window === 'undefined') return 'app.howlpro.com';
  if (isElectron()) return new URL(getWebOrigin()).hostname;
  return window.location.hostname || 'app.howlpro.com';
}

/** Route external link-preview images through the backend proxy to avoid CSP img-src issues. */
function proxyImageUrl(url: string | null): string {
  if (!url) return '';
  const trimmed = url.trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return trimmed;
  return `${API_BASE_URL}/link-preview/image?url=${encodeURIComponent(trimmed)}`;
}

const InviteEmbedLazy = React.lazy(() => import('./InviteEmbed'));

interface InviteCtx {
  servers: Server[];
  onJoinServer?: (code: string) => void;
  onViewServer?: (serverId: string) => void;
}

// Matches: /invite/CODE (new path format) or ?invite=CODE (legacy query format)
const HOWL_INVITE_RE = /\/invite\/([A-Za-z0-9\-_]{3,32})(?:[?#]|$)|[?&]invite=([A-Za-z0-9\-_]{3,32})(?:&|$)/;

// Session-scoped cache of image URLs that have 404'd / failed to load. If the
// same broken URL is referenced by many messages (common for stale uploads)
// we render a link directly instead of firing N network requests + N onError
// console entries. Scoped per-session; clears on app restart.
const _failedImageUrls = new Set<string>();
const _FAILED_IMAGES_MAX = 500;
function markImageFailed(url: string) {
  if (_failedImageUrls.size >= _FAILED_IMAGES_MAX) {
    const oldest = _failedImageUrls.values().next().value;
    if (oldest) _failedImageUrls.delete(oldest);
  }
  _failedImageUrls.add(url);
}

// Uses the persistent localStorage-backed cache so dims survive page reload.
// Every chat image the user has ever seen renders with aspect-ratio reserved
// on first render post-reload — no scroll jump when bytes arrive.

/** <img> wrapper that reads/writes the shared image dim cache so layout space
 *  is reserved on repeat renders of the same URL. First-EVER load of a new
 *  URL is still unknown; every render after that has an aspect-ratio applied
 *  via inline style so the browser reserves space before bytes arrive. */
function CachedImg({ src, style, onLoad, ...rest }: { src: string } & React.ImgHTMLAttributes<HTMLImageElement>) {
  const cached = getImageDims(src);
  const reservedStyle = cached ? { aspectRatio: `${cached.w} / ${cached.h}` } : null;
  return (
    <img
      {...rest}
      src={src}
      style={reservedStyle ? { ...(style ?? {}), ...reservedStyle } : style}
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          rememberImageDims(src, { w: img.naturalWidth, h: img.naturalHeight });
        }
        onLoad?.(e);
      }}
    />
  );
}

/** Inline image embed with lightbox on click instead of navigation. */
function ImageEmbed({ href, alt, linkKey, originalHref }: { href: string; alt: string; linkKey: string; originalHref?: string }) {
  const [failed, setFailed] = React.useState(() => _failedImageUrls.has(href));
  const [loaded, setLoaded] = React.useState(false);
  const [lightboxOpen, setLightboxOpen] = React.useState(false);
  // Read cached natural dims on mount — when present, we render the image directly
  // with aspect-ratio reservation and skip the placeholder skeleton entirely.
  const [dims, setDims] = React.useState<{ w: number; h: number } | undefined>(() => getImageDims(href));
  const isAnimatedGif = /\.gif(?:\?|$)/i.test(href) || /giphy\.com|tenor\.com/i.test(href);
  // Skip bare-hostname URLs (e.g. https://imgur.com/ from a mistyped markdown
  // image link) — they 4xx and pollute the CSP report stream.
  let hasRealPath = true;
  try {
    const u = new URL(href);
    hasRealPath = !!u.pathname && u.pathname !== '/';
  } catch { /* non-URL strings fall through as-is */ }
  if (!hasRealPath) {
    return (
      <a key={linkKey} href={originalHref || href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline break-all">
        {alt || href}
      </a>
    );
  }
  if (failed) {
    return (
      <a key={linkKey} href={originalHref || href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline">
        {alt}
      </a>
    );
  }
  return (
    <>
      <button
        key={linkKey}
        type="button"
        onClick={() => setLightboxOpen(true)}
        className="inline-block my-1 relative text-left focus:outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 rounded-lg"
      >
        {!loaded && !dims && (
          <div className="rounded-lg overflow-hidden max-w-sm h-48 bg-fill-hover animate-pulse" />
        )}
        <LazyGif
          src={sanitizeImgSrc(href)}
          alt={alt || 'embedded image'}
          className="max-w-sm max-h-80 rounded-lg object-contain cursor-pointer hover:opacity-95 ring-1 ring-white/[0.06]"
          style={
            (loaded || dims)
              ? (dims ? { aspectRatio: `${dims.w} / ${dims.h}` } : undefined)
              : { position: 'absolute', visibility: 'hidden' }
          }
          draggable={false}
          onError={() => { markImageFailed(href); setFailed(true); }}
          onImageLoad={(loadedDims) => {
            setLoaded(true);
            if (loadedDims) {
              rememberImageDims(href, loadedDims);
              if (!dims) setDims(loadedDims);
            }
          }}
          animated={isAnimatedGif}
        />
      </button>
      <ImageLightbox
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        imageDisplayUrl={sanitizeImgSrc(href)}
        imageLinkUrl={originalHref || href}
        fileName={alt || 'embed'}
      />
    </>
  );
}

/** Inline video embed with fallback to plain link on error. */
function VideoEmbed({ href, linkKey }: { href: string; linkKey: string }) {
  const [failed, setFailed] = React.useState(false);
  if (failed) {
    return (
      <a key={linkKey} href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline break-all">
        {href}
      </a>
    );
  }
  return (
    <span key={linkKey} className="block my-1">
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline text-sm break-all">{href}</a>
      <video
        src={href}
        controls
        playsInline
        preload="metadata"
        className="mt-1 max-w-sm max-h-80 rounded-lg object-contain ring-1 ring-[var(--border-subtle)]"
        onError={() => setFailed(true)}
      >
        <track kind="captions" />
      </video>
    </span>
  );
}

/** GIF page embed (Giphy/Tenor) — fetches media URL via link-preview oEmbed, shimmer while loading. */
function GifPageEmbed({ href, linkKey }: { href: string; linkKey: string }) {
  const [mediaUrl, setMediaUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiClient.getLinkPreview(href);
        if (cancelled) return;
        if (data?.image) {
          setMediaUrl(data.image);
        } else {
          console.warn('[GifPageEmbed] No image in link-preview response for', href, data);
          setFailed(true);
        }
      } catch (err) {
        console.warn('[GifPageEmbed] link-preview fetch failed for', href, err);
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [href]);

  if (failed) {
    return (
      <a key={linkKey} href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline break-all">
        {href}
      </a>
    );
  }
  if (loading) {
    return (
      <span key={linkKey} className="block my-1">
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline text-sm break-all">{href}</a>
        <div className="rounded-lg overflow-hidden max-w-sm h-48 bg-fill-hover animate-pulse mt-1" />
      </span>
    );
  }
  return <ImageEmbed key={linkKey} href={mediaUrl!} alt="GIF" linkKey={linkKey} originalHref={href} />;
}

/** Steam store widget embed — official iframe. */
function SteamStoreEmbed({ appId, href, linkKey }: { appId: string; href: string; linkKey: string }) {
  return (
    <span key={linkKey} className="block my-1">
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline text-sm break-all">{href}</a>
      <div className="mt-1.5 rounded-xl overflow-hidden border" style={{ borderColor: 'var(--glass-border)', maxWidth: 430 }}>
        <LazyIframe
          src={`https://store.steampowered.com/widget/${encodeURIComponent(appId)}/`}
          title="Steam Store"
          width="100%"
          height="190"
          frameBorder={0}
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          loading="lazy"
          style={{ display: 'block' }}
          placeholderHeight={190}
        />
      </div>
    </span>
  );
}

/** Twitch live stream player embed. */
function TwitchStreamEmbed({ channel, href, linkKey }: { channel: string; href: string; linkKey: string }) {
  const parent = getEmbedParent();
  return (
    <span key={linkKey} className="block my-1">
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline text-sm break-all">{href}</a>
      <div className="mt-1.5 rounded-lg w-full max-w-[520px] aspect-video overflow-hidden border" style={{ borderColor: 'rgba(145,70,255,0.15)' }}>
        <LazyIframe
          src={`https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${encodeURIComponent(parent)}&muted=true&autoplay=false`}
          title={`Twitch stream: ${channel}`}
          className="w-full h-full"
          frameBorder={0}
          sandbox="allow-scripts allow-same-origin allow-popups"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          loading="lazy"
          style={{ display: 'block' }}
          placeholderHeight={293}
        />
      </div>
    </span>
  );
}

/** Twitch clip embed. */
function TwitchClipEmbed({ slug, href, linkKey }: { slug: string; href: string; linkKey: string }) {
  const parent = getEmbedParent();
  return (
    <span key={linkKey} className="block my-1">
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline text-sm break-all">{href}</a>
      <div className="mt-1.5 rounded-lg w-full max-w-[520px] aspect-video overflow-hidden border" style={{ borderColor: 'rgba(145,70,255,0.15)' }}>
        <LazyIframe
          src={`https://clips.twitch.tv/embed?clip=${encodeURIComponent(slug)}&parent=${encodeURIComponent(parent)}&autoplay=false`}
          title="Twitch clip"
          className="w-full h-full"
          frameBorder={0}
          sandbox="allow-scripts allow-same-origin allow-popups"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          loading="lazy"
          style={{ display: 'block' }}
          placeholderHeight={293}
        />
      </div>
    </span>
  );
}

/** Twitch VOD embed. */
function TwitchVideoEmbed({ videoId, href, linkKey }: { videoId: string; href: string; linkKey: string }) {
  const parent = getEmbedParent();
  return (
    <span key={linkKey} className="block my-1">
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline text-sm break-all">{href}</a>
      <div className="mt-1.5 rounded-lg w-full max-w-[520px] aspect-video overflow-hidden border" style={{ borderColor: 'rgba(145,70,255,0.15)' }}>
        <LazyIframe
          src={`https://player.twitch.tv/?video=${encodeURIComponent(videoId)}&parent=${encodeURIComponent(parent)}&muted=true&autoplay=false`}
          title="Twitch video"
          className="w-full h-full"
          frameBorder={0}
          sandbox="allow-scripts allow-same-origin allow-popups"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          loading="lazy"
          style={{ display: 'block' }}
          placeholderHeight={293}
        />
      </div>
    </span>
  );
}

// Link preview LRU cache
// Prevents re-fetching OG data when Virtuoso remounts message components on scroll.
const _ogCache = new Map<string, { title: string | null; description: string | null; image: string | null; siteName: string | null; favicon: string | null }>();
const OG_CACHE_MAX = 100;

function ogCacheGet(url: string) {
  const entry = _ogCache.get(url);
  if (entry) { _ogCache.delete(url); _ogCache.set(url, entry); } // LRU touch
  return entry;
}

function ogCacheSet(url: string, data: typeof _ogCache extends Map<string, infer V> ? V : never) {
  if (_ogCache.size >= OG_CACHE_MAX) {
    const oldest = _ogCache.keys().next().value;
    if (oldest !== undefined) _ogCache.delete(oldest);
  }
  _ogCache.set(url, data);
}

/** Generic OG link preview card. Fetches OG tags from the backend link-preview endpoint. */
function LinkPreviewCard({ href, linkKey }: { href: string; linkKey: string }) {
  const [data, setData] = React.useState<{ title: string | null; description: string | null; image: string | null; siteName: string | null; favicon: string | null } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [imgFailed, setImgFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const cached = ogCacheGet(href);
    if (cached) { setData(cached); setLoading(false); return; }
    (async () => {
      try {
        const result = await apiClient.getLinkPreview(href);
        if (cancelled) return;
        if (result && (result.title || result.description)) {
          ogCacheSet(href, result);
          setData(result);
        } else {
          setFailed(true);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [href]);

  if (failed) return null;

  if (loading) {
    // Render no skeleton — the loaded card varies wildly in height (~80px text-only vs ~280px with image).
    // Any fixed skeleton causes rubber-banding on reveal. Cards "appear" instead of resizing.
    return null;
  }

  if (!data) return null;

  let hostname = '';
  try { hostname = new URL(href).hostname; } catch { /* ignore */ }

  const hasImage = data.image && !imgFailed;

  return (
    <div key={linkKey} className="mt-1.5 rounded-xl overflow-hidden" style={{ maxWidth: 400, background: 'var(--fill-hover)', border: '1px solid var(--border-subtle)' }}>
      {hasImage && (
        <CachedImg
          src={proxyImageUrl(data.image)}
          alt=""
          className="w-full object-cover cursor-pointer"
          style={{ maxHeight: 200 }}
          onClick={() => window.open(href, '_blank', 'noopener,noreferrer')}
          onError={() => setImgFailed(true)}
          draggable={false}
          referrerPolicy="no-referrer"
        />
      )}
      <div className="cursor-pointer" style={{ padding: '10px 12px' }} onClick={() => window.open(href, '_blank', 'noopener,noreferrer')}>
        <div className="flex items-center gap-1.5" style={{ marginBottom: 4 }}>
          {data.favicon && (
            <img
              src={proxyImageUrl(data.favicon)}
              alt=""
              style={{ width: 14, height: 14, borderRadius: 3 }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          )}
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{data.siteName || hostname}</span>
        </div>
        {data.title && (
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--cyan-accent)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {data.title}
          </div>
        )}
        {data.description && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' }}>
            {data.description}
          </div>
        )}
      </div>
    </div>
  );
}

/** X/Twitter tweet embed — official iframe. */
function TweetEmbed({ tweetId, href, linkKey }: { tweetId: string; href: string; linkKey: string }) {
  return (
    <span key={linkKey} className="block my-1">
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline text-sm break-all">{href}</a>
      <div className="mt-1.5 rounded-xl overflow-hidden border" style={{ borderColor: 'rgba(29,155,240,0.15)', maxWidth: 400 }}>
        <LazyIframe
          src={`https://platform.twitter.com/embed/Tweet.html?id=${encodeURIComponent(tweetId)}&theme=dark&dnt=true`}
          title="Tweet"
          width="100%"
          height="300"
          frameBorder={0}
          sandbox="allow-scripts allow-same-origin allow-popups"
          loading="lazy"
          style={{ display: 'block' }}
          placeholderHeight={300}
        />
      </div>
    </span>
  );
}

/** Reddit post embed — official iframe. */
function RedditPostEmbed({ sub, postId, slug, href, linkKey }: { sub: string; postId: string; slug: string; href: string; linkKey: string }) {
  const embedUrl = `https://embed.reddit.com/r/${encodeURIComponent(sub)}/comments/${encodeURIComponent(postId)}/${encodeURIComponent(slug)}/?embed=true&ref_source=embed&theme=dark`;
  return (
    <span key={linkKey} className="block my-1">
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline text-sm break-all">{href}</a>
      <div className="mt-1.5 rounded-xl overflow-hidden border" style={{ borderColor: 'rgba(255,69,0,0.15)', maxWidth: 440 }}>
        <LazyIframe
          src={embedUrl}
          title="Reddit post"
          width="100%"
          height="360"
          frameBorder={0}
          sandbox="allow-scripts allow-same-origin allow-popups"
          loading="lazy"
          style={{ display: 'block' }}
          placeholderHeight={360}
        />
      </div>
    </span>
  );
}

/** Kick live stream player embed.
 *  NOTE: sandbox is omitted for Kick. Kick's embedded player requires unrestricted
 *  script execution and same-origin access that conflicts with the sandbox allowlist
 *  (the player fails to initialise with sandbox restrictions). The iframe is still
 *  origin-isolated by the browser's default cross-origin policy, and CSP frame-src
 *  restricts which domains can be loaded. */
function KickStreamEmbed({ channel, href, linkKey }: { channel: string; href: string; linkKey: string }) {
  return (
    <span key={linkKey} className="block my-1">
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline text-sm break-all">{href}</a>
      <div className="mt-1.5 rounded-lg w-full max-w-[520px] aspect-video overflow-hidden border" style={{ borderColor: 'rgba(83,252,24,0.15)' }}>
        <LazyIframe
          src={`https://player.kick.com/${encodeURIComponent(channel)}?muted=true&autoplay=false`}
          title={`Kick stream: ${channel}`}
          className="w-full h-full"
          frameBorder={0}
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          loading="lazy"
          style={{ display: 'block' }}
          placeholderHeight={293}
        />
      </div>
    </span>
  );
}

/** TikTok video embed using TikTok's official standalone embed player (iframe, no external JS). */
const TikTokEmbed: React.FC<{ videoId: string; href: string; linkKey: string }> = ({ videoId, href, linkKey }) => (
  <span key={linkKey} className="block my-1">
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline text-sm break-all">{href}</a>
    <div className="mt-1.5 rounded-lg w-full max-w-[325px] aspect-[9/16] overflow-hidden">
      <LazyIframe
        src={`https://www.tiktok.com/embed/v2/${videoId}`}
        title="TikTok embed"
        className="w-full h-full"
        sandbox="allow-scripts allow-same-origin allow-popups"
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
        loading="lazy"
        style={{ display: 'block' }}
        placeholderHeight={578}
      />
    </div>
  </span>
);

interface MentionTextProps {
  content: string;
  className?: string;
  style?: React.CSSProperties;
  /** Optional message id for spoiler reveal tracking (resets when channel/server changes). */
  messageId?: string;
  authorPlan?: string | null;
  /** Optional list of known member usernames for distinguishing user vs role mentions. */
  memberNames?: string[];
  showEmbeds?: boolean;
  onMentionClick?: (user: { id: string; username: string; avatar?: string | null; status?: string }, e: React.MouseEvent) => void;
  usersByName?: Map<string, { id: string; username: string; avatar?: string | null; discriminator?: string; status?: string; role?: string; roleColor?: string | null; roleStyle?: string; nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null; stripePlan?: string | null; effectivePlan?: string | null }>;
  /** Server list for invite embed membership check */
  servers?: Server[];
  /** Called when user clicks Join on an invite embed */
  onJoinServer?: (code: string) => void;
  /** Called when user clicks View Server on an invite embed (already a member) */
  onViewServer?: (serverId: string) => void;
}

const COLOR_TEXT_RE = /\{color:(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))\}([\s\S]*?)\{\/color\}/g;
const COLOR_TEXT_STRIP_RE = /\{color:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\}([\s\S]*?)\{\/color\}/g;

type SpoilerReveal = { messageId?: string; isRevealed: (id: string) => boolean; reveal: (id: string) => void };
type EmbedCtx = { enabled: boolean; counter: { count: number }; maxEmbeds: number };



/** Twemoji image with native-emoji fallback on CDN load error. */
function TwemojiImg({ src, alt, size, keyProp }: { src: string; alt: string; size: number; keyProp: string }) {
  const [failed, setFailed] = React.useState(false);
  if (failed) {
    return <span key={keyProp} className="inline-block align-middle leading-none" style={{ fontSize: `${size}em` }}>{alt}</span>;
  }
  return (
    <img
      key={keyProp}
      src={src}
      alt={alt}
      className="inline-block align-middle"
      style={{ width: `${size}em`, height: `${size}em`, verticalAlign: 'middle' }}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/** Split a string into alternating emoji and non-emoji runs (Unicode Extended_Pictographic). */
function splitEmojiRuns(text: string): Array<{ emoji: boolean; value: string }> {
  const runs: Array<{ emoji: boolean; value: string }> = [];
  try {
    const re = /\p{Extended_Pictographic}+|\P{Extended_Pictographic}+/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      runs.push({ emoji: /\p{Extended_Pictographic}/u.test(m[0]), value: m[0] });
    }
  } catch {
    runs.push({ emoji: false, value: text });
  }
  if (runs.length === 0 && text) runs.push({ emoji: false, value: text });
  return runs;
}

/** Split an emoji run into single graphemes (one image per emoji). */
function segmentGraphemes(str: string): string[] {
  try {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    return [...segmenter.segment(str)].map((s) => s.segment);
  } catch {
    return [...str];
  }
}

/** Size when emoji is alongside text (slightly larger than 1em for visibility). */
const TWEMOJI_SIZE_INLINE_EM = 1.5;
/** Size when the message is only emoji(s) — show big. */
const TWEMOJI_SIZE_STANDALONE_EM = 3.5;

/** True if content has no mentions and is only emoji (unicode or :custom:) and optional whitespace. */
function isEmojiOnlyMessage(segments: MentionSegment[], customEmojiMap?: Map<string, string>): boolean {
  const hasMention = segments.some((s) => s.type !== 'text');
  if (hasMention) return false;
  let hasEmoji = false;
  for (const s of segments) {
    if (s.type !== 'text') continue;
    const stripped = customEmojiMap && customEmojiMap.size > 0
      ? s.value.replace(/:([a-zA-Z0-9_]+):/g, (full, name) => customEmojiMap.has(name) ? '' : full)
      : s.value;
    if (stripped !== s.value) hasEmoji = true;
    if (/\p{Extended_Pictographic}/u.test(stripped)) hasEmoji = true;
    const withoutSpace = stripped.replace(/\s/g, '');
    if (withoutSpace.length > 0 && !/^\p{Extended_Pictographic}+$/u.test(withoutSpace)) return false;
  }
  return hasEmoji;
}

const CUSTOM_EMOJI_RE = /:([a-zA-Z0-9_]+):/g;

/** Split text by :name: custom emoji patterns, returning alternating text and custom emoji segments. */
function splitCustomEmoji(value: string, emojiMap: Map<string, string>): Array<{ type: 'text' | 'custom'; value: string; url?: string }> {
  if (emojiMap.size === 0) return [{ type: 'text', value }];
  const parts: Array<{ type: 'text' | 'custom'; value: string; url?: string }> = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  CUSTOM_EMOJI_RE.lastIndex = 0;
  while ((m = CUSTOM_EMOJI_RE.exec(value)) !== null) {
    const url = emojiMap.get(m[1]);
    if (!url) continue;
    if (m.index > lastIndex) parts.push({ type: 'text', value: value.slice(lastIndex, m.index) });
    parts.push({ type: 'custom', value: m[1], url });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < value.length) parts.push({ type: 'text', value: value.slice(lastIndex) });
  if (parts.length === 0) parts.push({ type: 'text', value });
  return parts;
}

/** Render a string with emoji (twemoji + custom server emoji) and optional size. */
function renderTextWithEmoji(
  value: string,
  emojiSizeEm: number,
  keyPrefix: string,
  customEmojiMap?: Map<string, string>,
): React.ReactNode {
  const segments = splitCustomEmoji(value, customEmojiMap ?? new Map());
  return segments.map((seg, si) => {
    if (seg.type === 'custom') {
      return (
        <img
          key={`${keyPrefix}-ce-${si}`}
          src={sanitizeImgSrc(seg.url)}
          alt={`:${seg.value}:`}
          className="inline-block align-middle"
          style={{ width: `${emojiSizeEm}em`, height: `${emojiSizeEm}em`, verticalAlign: 'middle', margin: '0 0.08em', objectFit: 'contain' }}
          draggable={false}
          data-original-src={toOriginalUploadPath(seg.url)}
          onError={retryOnExpired}
        />
      );
    }
    return splitEmojiRuns(seg.value).map((run, j) =>
      run.emoji ? (
        <span key={`${keyPrefix}-${si}-${j}`} className="inline-block align-middle leading-none" style={{ margin: '0 0.08em' }}>
          {segmentGraphemes(run.value).map((one, k) => {
            const src = getTwemojiUrl(one);
            return src ? (
              <TwemojiImg key={`${keyPrefix}-${si}-${j}-${k}`} keyProp={`${keyPrefix}-${si}-${j}-${k}`} src={src} alt={one} size={emojiSizeEm} />
            ) : (
              <span key={`${keyPrefix}-${si}-${j}-${k}`} className="inline-block align-middle leading-none" style={{ fontSize: `${emojiSizeEm}em` }}>
                {one}
              </span>
            );
          })}
        </span>
      ) : (
        <span key={`${keyPrefix}-${si}-${j}`}>{run.value}</span>
      )
    );
  });
}

/** Render inline markdown segments (bold, italic, underline, strikethrough, code, link, spoiler) with emoji support inside. */
// eslint-disable-next-line security/detect-unsafe-regex -- anchored at $, no nested quantifiers
const IMAGE_URL_RE = /\.(?:png|jpe?g|gif|webp|bmp|avif)(?:\?[^\s]*)?$/i;
const IMAGE_HOST_RE = /(?:i\.imgur\.com|media\.tenor\.com|media\d*\.giphy\.com|pbs\.twimg\.com|cdn\.discordapp\.com|media\.discordapp\.net)/i;

// eslint-disable-next-line security/detect-unsafe-regex -- anchored both ends, no nested quantifiers
const GIPHY_PAGE_RE = /^https?:\/\/(?:www\.)?giphy\.com\/gifs\/(?:.*-)?([a-zA-Z0-9]+)$/i;
// eslint-disable-next-line security/detect-unsafe-regex -- anchored both ends, no nested quantifiers
const TENOR_PAGE_RE = /^https?:\/\/(?:www\.)?tenor\.com\/(?:[a-z]{2}\/)?view\/[\w-]+-(\d+)$/i;

// eslint-disable-next-line security/detect-unsafe-regex -- anchored at $, no nested quantifiers
const VIDEO_URL_RE = /\.(?:mp4|webm)(?:\?[^\s]*)?$/i;

function isVideoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return VIDEO_URL_RE.test(u.pathname);
  } catch {
    return VIDEO_URL_RE.test(url);
  }
}

function isImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (IMAGE_URL_RE.test(u.pathname)) return true;
    // Host-based match requires a non-trivial path — bare https://media.tenor.com/
    // is not a real image and renders as a 4xx <img> if we let it through.
    if (IMAGE_HOST_RE.test(u.hostname) && u.pathname && u.pathname !== '/') return true;
    return false;
  } catch {
    return IMAGE_URL_RE.test(url);
  }
}

const SPOTIFY_EMBED_RE = /^https?:\/\/open\.spotify\.com\/(track|album|playlist|artist|episode|show)\/([a-zA-Z0-9]+)/i;

function extractSpotifyEmbed(url: string): { type: string; id: string } | null {
  const m = url.match(SPOTIFY_EMBED_RE);
  if (!m) return null;
  return { type: m[1].toLowerCase(), id: m[2] };
}

function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
    if (YT_HOSTS.has(u.hostname)) {
      if (u.pathname.startsWith('/watch')) return u.searchParams.get('v');
      const shortOrEmbed = u.pathname.match(/^\/(?:shorts|embed|v)\/([a-zA-Z0-9_-]+)/);
      if (shortOrEmbed) return shortOrEmbed[1];
    }
  } catch { /* ignored */ }
  return null;
}

// Steam URL extraction
function extractSteamAppId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'store.steampowered.com') return null;
    const m = u.pathname.match(/^\/app\/(\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Twitch URL extraction
const TWITCH_NON_CHANNEL = new Set([
  'directory', 'settings', 'search', 'downloads', 'prime', 'turbo',
  'products', 'jobs', 'p', 'user', 'subs', 'friends', 'inventory',
  'wallet', 'drops', 'store', 'subscriptions', 'videos', 'moderator',
]);

function extractTwitchChannel(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'twitch.tv' && u.hostname !== 'www.twitch.tv' && u.hostname !== 'm.twitch.tv') return null;
    const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts.length !== 1) return null;
    const name = parts[0].toLowerCase();
    if (TWITCH_NON_CHANNEL.has(name)) return null;
    if (!/^[a-z0-9_]{1,25}$/i.test(parts[0])) return null;
    return parts[0];
  } catch { return null; }
}

function extractTwitchClipSlug(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'clips.twitch.tv') {
      const slug = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean)[0];
      return slug && /^[a-zA-Z0-9_-]+$/.test(slug) ? slug : null;
    }
    if (u.hostname === 'twitch.tv' || u.hostname === 'www.twitch.tv' || u.hostname === 'm.twitch.tv') {
      const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
      if (parts.length === 3 && parts[1] === 'clip' && /^[a-zA-Z0-9_-]+$/.test(parts[2])) {
        return parts[2];
      }
    }
    return null;
  } catch { return null; }
}

function extractTwitchVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'twitch.tv' && u.hostname !== 'www.twitch.tv' && u.hostname !== 'm.twitch.tv') return null;
    const m = u.pathname.match(/^\/videos\/(\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

// TikTok URL extraction
function isTikTokShortUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname === 'vm.tiktok.com') return true;
    if ((u.hostname === 'tiktok.com' || u.hostname === 'www.tiktok.com' || u.hostname === 'm.tiktok.com') && /^\/t\//.test(u.pathname)) return true;
    return false;
  } catch { return false; }
}

function extractTikTokVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'tiktok.com' && u.hostname !== 'www.tiktok.com' && u.hostname !== 'vm.tiktok.com' && u.hostname !== 'm.tiktok.com') return null;
    const m = u.pathname.match(/^\/@[\w.]+\/video\/(\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

// YouTube Shorts detection
function isYouTubeShorts(url: string): boolean {
  try {
    const u = new URL(url);
    const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
    return YT_HOSTS.has(u.hostname) && u.pathname.startsWith('/shorts/');
  } catch { return false; }
}

// X/Twitter URL extraction
function extractTweetId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'twitter.com' && u.hostname !== 'www.twitter.com'
      && u.hostname !== 'x.com' && u.hostname !== 'www.x.com'
      && u.hostname !== 'mobile.twitter.com' && u.hostname !== 'mobile.x.com') return null;
    const m = u.pathname.match(/^\/\w+\/status\/(\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Reddit URL extraction
function extractRedditPost(url: string): { sub: string; postId: string; slug: string } | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'reddit.com' && u.hostname !== 'www.reddit.com'
      && u.hostname !== 'old.reddit.com' && u.hostname !== 'new.reddit.com'
      && u.hostname !== 'm.reddit.com') return null;
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored at ^, no nested quantifiers
    const m = u.pathname.match(/^\/r\/([\w]+)\/comments\/([\w]+)(?:\/([\w-]*))?/);
    if (!m) return null;
    return { sub: m[1], postId: m[2], slug: m[3] || '' };
  } catch { return null; }
}

// Kick URL extraction
const KICK_NON_CHANNEL = new Set([
  'categories', 'browse', 'settings', 'search', 'following',
  'dashboard', 'clip', 'video', 'terms-of-service', 'privacy-policy',
  'community-guidelines', 'dmca-policy', 'contact', 'about',
]);

function extractKickChannel(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'kick.com' && u.hostname !== 'www.kick.com' && u.hostname !== 'm.kick.com') return null;
    const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts.length !== 1) return null;
    const name = parts[0].toLowerCase();
    if (KICK_NON_CHANNEL.has(name)) return null;
    if (!/^[a-z0-9_]{1,25}$/i.test(parts[0])) return null;
    return parts[0];
  } catch { return null; }
}

function renderMarkdownRun(runValue: string, emojiSizeEm: number, keyPrefix: string, spoilerReveal?: SpoilerReveal, cem?: Map<string, string>, inviteCtx?: InviteCtx, embedCtx?: EmbedCtx): React.ReactNode {
  const mdSegments = parseInlineMarkdown(runValue);
  return mdSegments.map((seg: InlineMarkdownSegment, idx: number) => {
    const key = `${keyPrefix}-md-${idx}`;
    if (seg.type === 'link') {
      const trimmedUrl = seg.url.trim();
      let parsedProtocol = '';
      try { parsedProtocol = new URL(trimmedUrl, 'https://placeholder.invalid').protocol; } catch { /* invalid URL */ }
      const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
      if (!SAFE_PROTOCOLS.has(parsedProtocol)) {
        return <span key={key}>{seg.value}</span>;
      }
      const rawUrl = trimmedUrl;
      const href = rawUrl.startsWith('http') ? rawUrl
        : rawUrl.startsWith('mailto:') ? rawUrl
        : (rawUrl.startsWith('/') && !rawUrl.startsWith('//')) ? rawUrl
        : `https://${rawUrl}`;
      const isBareUrl = seg.value === seg.url;
      const canEmbed = embedCtx && embedCtx.enabled && embedCtx.counter.count < embedCtx.maxEmbeds;
      // Direct images — NOT gated by showEmbeds (controlled by displayImagesLinks)
      if (isBareUrl && isImageUrl(href)) {
        return <ImageEmbed key={key} href={href} alt={seg.value} linkKey={key} />;
      }
      // Direct videos — NOT gated by showEmbeds
      if (isBareUrl && isVideoUrl(href)) {
        return <VideoEmbed key={key} href={href} linkKey={key} />;
      }
      // GIF pages — gated
      if (isBareUrl && (GIPHY_PAGE_RE.test(href) || TENOR_PAGE_RE.test(href)) && canEmbed) {
        embedCtx.counter.count++;
        return <GifPageEmbed key={key} href={href} linkKey={key} />;
      }
      // YouTube — gated (with Shorts vertical detection)
      const ytId = isBareUrl ? extractYouTubeId(href) : null;
      if (ytId && isValidYouTubeId(ytId) && canEmbed) {
        embedCtx.counter.count++;
        const isShorts = isYouTubeShorts(href);
        return (
          <span key={key} className="block my-1">
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline text-sm break-all">{seg.value}</a>
            <div className={isShorts ? "mt-1 rounded-lg w-[325px] aspect-[9/16] overflow-hidden" : "mt-1 rounded-lg max-w-full w-[520px] aspect-video overflow-hidden"}>
              <LazyIframe
                src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(ytId)}`}
                title={isShorts ? "YouTube Short" : "YouTube video"}
                className="w-full h-full"
                sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                loading="lazy"
                style={{ border: 'none' }}
                placeholderHeight={isShorts ? 578 : 293}
              />
            </div>
          </span>
        );
      }
      // Spotify — gated
      const spotifyEmbed = isBareUrl ? extractSpotifyEmbed(href) : null;
      if (spotifyEmbed && canEmbed) {
        embedCtx.counter.count++;
        const embedSrc = `https://open.spotify.com/embed/${encodeURIComponent(spotifyEmbed.type)}/${encodeURIComponent(spotifyEmbed.id)}?theme=0`;
        const embedHeight = spotifyEmbed.type === 'track' || spotifyEmbed.type === 'episode' ? 80 : 152;
        return (
          <span key={key} className="block my-1">
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline text-sm break-all">{seg.value}</a>
            <div className="mt-1.5 rounded-xl overflow-hidden border" style={{ borderColor: 'rgba(29, 185, 52, 0.15)', maxWidth: 400 }}>
              <LazyIframe
                src={embedSrc}
                title={`Spotify ${spotifyEmbed.type}`}
                width="100%"
                height={embedHeight}
                frameBorder={0}
                allow="encrypted-media"
                sandbox="allow-scripts allow-same-origin allow-popups"
                loading="lazy"
                style={{ borderRadius: 12, display: 'block' }}
                placeholderHeight={embedHeight}
              />
            </div>
          </span>
        );
      }
      // Steam store — gated
      if (isBareUrl && canEmbed) {
        const steamAppId = extractSteamAppId(href);
        if (steamAppId) {
          embedCtx.counter.count++;
          return <SteamStoreEmbed key={key} appId={steamAppId} href={href} linkKey={key} />;
        }
      }
      // Twitch clip — gated (check before channel to avoid false match)
      if (isBareUrl && canEmbed) {
        const twitchClip = extractTwitchClipSlug(href);
        if (twitchClip) {
          embedCtx.counter.count++;
          return <TwitchClipEmbed key={key} slug={twitchClip} href={href} linkKey={key} />;
        }
      }
      // Twitch VOD — gated (check before channel)
      if (isBareUrl && canEmbed) {
        const twitchVideo = extractTwitchVideoId(href);
        if (twitchVideo) {
          embedCtx.counter.count++;
          return <TwitchVideoEmbed key={key} videoId={twitchVideo} href={href} linkKey={key} />;
        }
      }
      // Twitch channel/stream — gated (after clip and VOD)
      if (isBareUrl && canEmbed) {
        const twitchChannel = extractTwitchChannel(href);
        if (twitchChannel) {
          embedCtx.counter.count++;
          return <TwitchStreamEmbed key={key} channel={twitchChannel} href={href} linkKey={key} />;
        }
      }
      // TikTok full URL — gated (render real embed player for full video URLs)
      if (isBareUrl && canEmbed) {
        const tikTokId = extractTikTokVideoId(href);
        if (tikTokId) {
          embedCtx.counter.count++;
          return <TikTokEmbed key={key} videoId={tikTokId} href={href} linkKey={key} />;
        }
      }
      // TikTok short URL — gated (short URLs don't contain the video ID directly;
      // resolving the redirect is out of scope, so fall back to OG card)
      if (isBareUrl && canEmbed && isTikTokShortUrl(href)) {
        embedCtx.counter.count++;
        return <LinkPreviewCard key={key} href={href} linkKey={key} />;
      }
      // X/Twitter tweet — gated
      if (isBareUrl && canEmbed) {
        const tweetId = extractTweetId(href);
        if (tweetId) {
          embedCtx.counter.count++;
          return <TweetEmbed key={key} tweetId={tweetId} href={href} linkKey={key} />;
        }
      }
      // Reddit post — gated
      if (isBareUrl && canEmbed) {
        const redditPost = extractRedditPost(href);
        if (redditPost) {
          embedCtx.counter.count++;
          return <RedditPostEmbed key={key} sub={redditPost.sub} postId={redditPost.postId} slug={redditPost.slug} href={href} linkKey={key} />;
        }
      }
      // Kick stream — gated
      if (isBareUrl && canEmbed) {
        const kickChannel = extractKickChannel(href);
        if (kickChannel) {
          embedCtx.counter.count++;
          return <KickStreamEmbed key={key} channel={kickChannel} href={href} linkKey={key} />;
        }
      }
      // Howl invite — NOT gated by showEmbeds
      if (isBareUrl && inviteCtx) {
        const inviteMatch = href.match(HOWL_INVITE_RE);
        const inviteCode = inviteMatch?.[1] ?? inviteMatch?.[2];
        if (inviteCode) {
          return (
            <span key={key} className="block my-1">
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline text-sm break-all">{seg.value}</a>
              <div className="mt-1.5">
                <React.Suspense fallback={<div className="animate-pulse bg-fill-hover rounded-2xl h-[180px]" style={{ maxWidth: 360 }} />}>
                  <InviteEmbedLazy code={inviteCode} servers={inviteCtx.servers} onJoinServer={inviteCtx.onJoinServer} onViewServer={inviteCtx.onViewServer} />
                </React.Suspense>
              </div>
            </span>
          );
        }
      }
      // Generic OG card — gated, last fallback for bare URLs
      if (isBareUrl && canEmbed && /^https?:\/\//i.test(href)) {
        embedCtx.counter.count++;
        return (
          <span key={key} className="block my-1">
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline text-sm break-all">{seg.value}</a>
            <LinkPreviewCard href={href} linkKey={`${key}-og`} />
          </span>
        );
      }
      const display = renderTextWithEmoji(seg.value, emojiSizeEm, `${keyPrefix}-${idx}`, cem);
      const looksLikeUrl = /^https?:\/\//i.test(seg.value.trim());
      const isMasked = !isBareUrl && looksLikeUrl;
      if (isMasked) {
        let displayHost = '';
        let actualHost = '';
        try { displayHost = new URL(seg.value.trim()).hostname; } catch { /* ignore */ }
        try { actualHost = new URL(href).hostname; } catch { /* ignore */ }
        const hostnameMismatch = displayHost && actualHost && displayHost !== actualHost;
        return (
          <span key={key} className="inline-flex items-center gap-0.5">
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-accent)] hover:underline" title={href}>
              {display}
            </a>
            <span className={`text-[10px] break-all ${hostnameMismatch ? 'text-amber-400 opacity-90 font-semibold' : 'opacity-50'}`} style={hostnameMismatch ? {} : { color: 'var(--text-secondary)' }}>({actualHost || href})</span>
          </span>
        );
      }
      return (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--cyan-accent)] hover:underline"
        >
          {display}
        </a>
      );
    }
    if (seg.type === 'spoiler') {
      const spoilerId = spoilerReveal?.messageId != null ? `${spoilerReveal.messageId}-${key}` : key;
      const revealed = spoilerReveal?.isRevealed(spoilerId) ?? false;
      const inner = renderTextWithEmoji(seg.value, emojiSizeEm, `${keyPrefix}-${idx}`, cem);
      return (
        <span
          key={key}
          role="button"
          tabIndex={0}
          data-spoiler
          data-spoiler-id={spoilerId}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); spoilerReveal?.reveal(spoilerId); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); spoilerReveal?.reveal(spoilerId); } }}
          className="cursor-pointer rounded-lg px-0.5 inline-block relative"
          style={{ userSelect: revealed ? 'text' : 'none' }}
        >
          {revealed ? (
            inner
          ) : (
            <>
              <span style={{ visibility: 'hidden' }}>{inner}</span>
              <span
                aria-hidden
                className="rounded-lg px-0.5 absolute left-0 top-0 right-0 bottom-0"
                style={{
                  backgroundColor: 'var(--spoiler-overlay)',
                  pointerEvents: 'none',
                }}
              />
            </>
          )}
        </span>
      );
    }
    const inner = renderTextWithEmoji(seg.value, emojiSizeEm, `${keyPrefix}-${idx}`, cem);
    switch (seg.type) {
      case 'bold':
        return <strong key={key}>{inner}</strong>;
      case 'italic':
        return <em key={key}>{inner}</em>;
      case 'boldItalic':
        return <strong key={key}><em>{inner}</em></strong>;
      case 'underline':
        return <span key={key} style={{ textDecoration: 'underline' }}>{inner}</span>;
      case 'strikethrough':
        return <span key={key} style={{ textDecoration: 'line-through' }}>{inner}</span>;
      case 'code':
        return (
          <code
            key={key}
            className="px-1.5 py-0.5 rounded-lg bg-fill-active font-mono text-[0.9em]"
            style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}
          >
            {seg.value}
          </code>
        );
      default:
        return <span key={key}>{inner}</span>;
    }
  });
}

/** Render a single line of text (inline markdown + emoji). Used for paragraphs and list items. */
function renderLine(line: string, emojiSizeEm: number, keyPrefix: string, spoilerReveal?: SpoilerReveal, cem?: Map<string, string>, inviteCtx?: InviteCtx, embedCtx?: EmbedCtx): React.ReactNode {
  const segments = splitCustomEmoji(line, cem ?? new Map());
  return segments.map((seg, si) => {
    if (seg.type === 'custom') {
      return (
        <img
          key={`${keyPrefix}-ce-${si}`}
          src={sanitizeImgSrc(seg.url)}
          alt={`:${seg.value}:`}
          className="inline-block align-middle"
          style={{ width: `${emojiSizeEm}em`, height: `${emojiSizeEm}em`, verticalAlign: 'middle', margin: '0 0.08em', objectFit: 'contain' }}
          draggable={false}
          data-original-src={toOriginalUploadPath(seg.url)}
          onError={retryOnExpired}
        />
      );
    }
    return splitEmojiRuns(seg.value).map((run, j) =>
      run.emoji ? (
        <span key={`${keyPrefix}-${si}-${j}`} className="inline-block align-middle leading-none" style={{ margin: '0 0.08em' }}>
          {segmentGraphemes(run.value).map((one, k) => {
            const src = getTwemojiUrl(one);
            return src ? (
              <TwemojiImg key={`${keyPrefix}-${si}-${j}-${k}`} keyProp={`${keyPrefix}-${si}-${j}-${k}`} src={src} alt={one} size={emojiSizeEm} />
            ) : (
              <span key={`${keyPrefix}-${si}-${j}-${k}`} className="inline-block align-middle leading-none" style={{ fontSize: `${emojiSizeEm}em` }}>
                {one}
              </span>
            );
          })}
        </span>
      ) : (
        <span key={`${keyPrefix}-${si}-${j}`}>{renderMarkdownRun(run.value, emojiSizeEm, `${keyPrefix}-r-${si}-${j}`, spoilerReveal, cem, inviteCtx, embedCtx)}</span>
      )
    );
  });
}

/** Render block-level segments (headers, subtext, blockquote, codeblock, list, paragraph). */
function renderBlocks(blocks: BlockSegment[], emojiSizeEm: number, keyPrefix: string, spoilerReveal?: SpoilerReveal, cem?: Map<string, string>, inviteCtx?: InviteCtx, embedCtx?: EmbedCtx): React.ReactNode {
  return blocks.map((block, bi) => {
    const key = `${keyPrefix}-b-${bi}`;
    switch (block.type) {
      case 'header': {
        const HeaderTag = block.level === 1 ? 'div' : block.level === 2 ? 'div' : 'div';
        const headerClass = block.level === 1 ? 'text-lg font-bold' : block.level === 2 ? 'text-base font-bold' : 'text-sm font-bold';
        return (
          <HeaderTag key={key} className={headerClass} style={{ marginTop: bi > 0 ? '0.5em' : undefined, marginBottom: '0.15em' }}>
            {renderLine(block.text, emojiSizeEm, `${key}-h`, spoilerReveal, cem, inviteCtx, embedCtx)}
          </HeaderTag>
        );
      }
      case 'subtext':
        return (
          <div key={key} className="text-xs opacity-80" style={{ marginTop: bi > 0 ? '0.35em' : undefined, marginBottom: '0.25em' }}>
            {renderLine(block.text, emojiSizeEm, `${key}-s`, spoilerReveal, cem, inviteCtx, embedCtx)}
          </div>
        );
      case 'blockquote':
        return (
          <div
            key={key}
            className="border-l-2 pl-3 my-1 opacity-90 border-default"
            style={{ marginTop: bi > 0 ? '0.35em' : undefined }}
          >
            {block.lines.map((ln, li) => (
              <div key={`${key}-${li}`} className="py-0.5">
                {renderLine(ln, emojiSizeEm, `${key}-q-${li}`, spoilerReveal, cem, inviteCtx, embedCtx)}
              </div>
            ))}
          </div>
        );
      case 'codeblock':
        return (
          <Suspense key={key} fallback={<CodeBlockFallback code={block.code} />}>
            <CodeBlockEmbed code={block.code} lang={block.lang} />
          </Suspense>
        );
      case 'list':
        return (
          <ul key={key} className="list-disc list-inside my-1 space-y-0.5" style={{ marginTop: bi > 0 ? '0.35em' : undefined }}>
            {block.items.map((item, li) => (
              <li key={`${key}-${li}`} style={{ marginLeft: item.indent * 1.5 + 'em' }}>
                {renderLine(item.text, emojiSizeEm, `${key}-l-${li}`, spoilerReveal, cem, inviteCtx, embedCtx)}
              </li>
            ))}
          </ul>
        );
      case 'paragraph':
      default:
        return (
          <span key={key} className="block">
            {block.lines.map((ln, li) => (
              <span key={`${key}-${li}`} className="block">
                {li > 0 && <br />}
                {renderLine(ln, emojiSizeEm, `${key}-p-${li}`, spoilerReveal, cem, inviteCtx, embedCtx)}
              </span>
            ))}
          </span>
        );
    }
  });
}

function renderSegments(
  segments: MentionSegment[],
  emojiSizeEm: number,
  spoilerReveal: SpoilerReveal,
  cem: Map<string, string>,
  onMentionClick?: MentionTextProps['onMentionClick'],
  usersByName?: MentionTextProps['usersByName'],
  inviteCtx?: InviteCtx,
  embedCtx?: EmbedCtx,
): React.ReactNode {
  return segments.map((seg: MentionSegment, i: number) =>
    seg.type === 'text' ? (
      seg.value.includes('\n') ? (
        <span key={i} className="block">
          {renderBlocks(parseContentBlocks(seg.value), emojiSizeEm, `seg-${i}`, spoilerReveal, cem, inviteCtx, embedCtx)}
        </span>
      ) : (
        <span key={i}>
          {renderLine(seg.value, emojiSizeEm, `t${i}`, spoilerReveal, cem, inviteCtx, embedCtx)}
        </span>
      )
    ) : (() => {
      const pillClass = seg.kind === 'everyone' || seg.kind === 'here'
        ? 'px-1 rounded-lg mention-pill bg-amber-500/20 text-amber-300'
        : seg.kind === 'role'
          ? 'px-1 rounded-lg mention-pill bg-indigo-500/20 text-indigo-300'
          : 'px-1 rounded-lg mention-pill bg-[var(--cyan-accent)]/20 text-[var(--cyan-accent)]';
      if (seg.kind === 'user' && usersByName) {
        const rawName = seg.value.startsWith('@') ? seg.value.slice(1) : seg.value;
        const user = usersByName.get(rawName.toLowerCase())
          ?? usersByName.get(rawName.replace(/#\d{4}$/, '').toLowerCase());
        if (user) {
          const plan = user.effectivePlan || user.stripePlan;
          const hasCustomStyle = plan === 'pro' && (user.nameColor || user.nameFont || user.nameEffect);
          const inner = hasCustomStyle
            ? <RoleNameStyle name={seg.value} overrideColor={user.nameColor} overrideFont={user.nameFont} nameEffect={user.nameEffect} />
            : seg.value;
          if (onMentionClick) {
            return (
              <button key={i} type="button" className={`${pillClass} cursor-pointer hover:brightness-125 transition-[filter]`} onClick={(e) => onMentionClick(user, e)}>
                {inner}
              </button>
            );
          }
          return <span key={i} className={`${pillClass} cursor-default`}>{inner}</span>;
        }
      }
      return <span key={i} className={`${pillClass} cursor-default`}>{seg.value}</span>;
    })()
  );
}

export const MentionText = React.memo(function MentionText({ content, className, style, messageId, authorPlan, memberNames, showEmbeds, onMentionClick, usersByName, servers, onJoinServer, onViewServer }: MentionTextProps) {
  const cem = useSyncExternalStore(subscribeCustomEmojis, getCustomEmojiMap);
  const { isRevealed, reveal } = useSpoilerReveal();
  const spoilerReveal: SpoilerReveal = { messageId, isRevealed, reveal };
  const { chatSettings } = useSettings();
  const showEmbedsEnabled = showEmbeds ?? chatSettings?.showEmbeds ?? true;
  const embedCounter = React.useRef({ count: 0 });
  embedCounter.current.count = 0;
  const embedCtx: EmbedCtx = { enabled: showEmbedsEnabled, counter: embedCounter.current, maxEmbeds: 2 };
  const inviteCtx = useMemo<InviteCtx | undefined>(
    () => servers?.length ? { servers, onJoinServer, onViewServer } : undefined,
    [servers, onJoinServer, onViewServer],
  );

  const parsed = useMemo(() => {
    if (authorPlan === 'pro' && COLOR_TEXT_RE.test(content)) {
      COLOR_TEXT_RE.lastIndex = 0;
      return { type: 'color' as const, content };
    }
    const displayContent = content.replace(COLOR_TEXT_STRIP_RE, '$1');
    const segments = parseContentWithMentions(displayContent, undefined, undefined, memberNames);
    const emojiOnly = isEmojiOnlyMessage(segments, cem);
    return { type: 'plain' as const, segments, emojiOnly };
  }, [content, authorPlan, cem, memberNames]);

  if (parsed.type === 'color') {
    COLOR_TEXT_RE.lastIndex = 0;
    const parts: React.ReactNode[] = [];
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    let partKey = 0;
    while ((match = COLOR_TEXT_RE.exec(content)) !== null) {
      if (match.index > lastIdx) {
        const slice = content.slice(lastIdx, match.index);
        const segs = parseContentWithMentions(slice, undefined, undefined, memberNames);
        const emojiOnly = isEmojiOnlyMessage(segs, cem);
        const sz = emojiOnly ? TWEMOJI_SIZE_STANDALONE_EM : TWEMOJI_SIZE_INLINE_EM;
        parts.push(<React.Fragment key={partKey++}>{renderSegments(segs, sz, spoilerReveal, cem, onMentionClick, usersByName, inviteCtx, embedCtx)}</React.Fragment>);
      }
      const innerSegs = parseContentWithMentions(match[2], undefined, undefined, memberNames);
      const innerEmojiOnly = isEmojiOnlyMessage(innerSegs, cem);
      const innerSz = innerEmojiOnly ? TWEMOJI_SIZE_STANDALONE_EM : TWEMOJI_SIZE_INLINE_EM;
      parts.push(
        <span key={partKey++} style={{ color: match[1] }}>
          {renderSegments(innerSegs, innerSz, spoilerReveal, cem, onMentionClick, usersByName, inviteCtx, embedCtx)}
        </span>
      );
      lastIdx = match.index + match[0].length;
    }
    if (lastIdx < content.length) {
      const slice = content.slice(lastIdx);
      const segs = parseContentWithMentions(slice, undefined, undefined, memberNames);
      const emojiOnly = isEmojiOnlyMessage(segs, cem);
      const sz = emojiOnly ? TWEMOJI_SIZE_STANDALONE_EM : TWEMOJI_SIZE_INLINE_EM;
      parts.push(<React.Fragment key={partKey}>{renderSegments(segs, sz, spoilerReveal, cem, onMentionClick, usersByName, inviteCtx, embedCtx)}</React.Fragment>);
    }
    return <span className={className} style={style}>{parts}</span>;
  }

  const emojiSizeEm = parsed.emojiOnly ? TWEMOJI_SIZE_STANDALONE_EM : TWEMOJI_SIZE_INLINE_EM;

  return (
    <span className={className} style={style}>
      {renderSegments(parsed.segments, emojiSizeEm, spoilerReveal, cem, onMentionClick, usersByName, inviteCtx, embedCtx)}
    </span>
  );
});
