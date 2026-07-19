// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect, useCallback, useMemo, Suspense } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Channel, Message, User } from '../types';
import { Phone, Video, Pin, UserPlus, Users, X, Volume2, CornerUpLeft, CornerUpRight, MessageCirclePlus, Copy, Link2, Trash2, Flag, ChevronRight, ChevronDown, PhoneOff, FileDown, FileText, Smile, Pencil, Check, Search, Maximize2, WrapText, Calendar, BarChart3, EyeOff, PanelRight } from 'lucide-react';
const RightPanel = React.lazy(() => import('./SearchModal').then(m => ({ default: m.RightPanel })));
import { MessageInput, type MessageInputHandle } from './MessageInput';
import { LexicalEditEditor, type LexicalEditEditorHandle } from './LexicalEditEditor';
import { RoleNameStyle } from './RoleNameStyle';
import type { UserWithRole } from './UserProfilePopup';
import { MentionText } from './MentionText';
import { API_BASE_URL, getWebOrigin, getBackendOrigin } from '../config';
import { GLASS_MENU_CLASS } from '../utils/contextMenuStyles';
import { useIsMobile } from '../hooks/useIsMobile';
import { useRenderLoopDetector } from '../hooks/useRenderLoopDetector';
import { useKeyboardAware } from '../hooks/useKeyboardAware';
import { longPressBindings } from '../hooks/useLongPress';
import { useSwipeGesture } from '../hooks/useSwipeGesture';
import { doubleTapBindings } from '../hooks/useDoubleTap';
import { ImageLightbox } from './ImageLightbox';
const EmojiPicker = React.lazy(() => import('./EmojiPicker').then(m => ({ default: m.EmojiPicker })));
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';
import { LetterAvatar } from './LetterAvatar';
import { UserAvatar } from './UserAvatar';
import { GroupAvatarComposite } from './GroupAvatarComposite';
import { EmptyChatState } from './EmptyChatState';
import { EventReminderEmbed } from './calendar/EventReminderEmbed';
import { PollEmbed } from './PollEmbed';
import { GiftDmCard } from './dm/GiftDmCard';
import { ThreadBar } from './ThreadBar';
import { AgeGateOverlay } from './channel/AgeGateOverlay';
import { OtrFacedIndicator } from './OtrFacedIndicator';
import { DmRecoverabilityIndicator } from './DmRecoverabilityIndicator';
import type { RecoverabilityState } from '../utils/recoverabilityState';
import type { Poll, Thread } from '../types';
import { getRecentEmojis, addRecentEmoji } from '../utils/recentEmojiStorage';
import { resolveMessageAuthor } from '../utils/messageAuthor';
import { getTwemojiUrl } from '../utils/twemoji';
import type { EmojiSearchEntry } from '../utils/emojiData';
import { getSubmenuPosition } from '../utils/contextMenuStyles';
import { getPlanPerks, getAvatarEffectClass, type PlanTier } from '../shared/planPerks';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { toOriginalUploadPath } from '../utils/signedImageRetry';
import { fetchSignedMediaUrl, fetchMediaBlobUrl } from '../services/mediaUrl';
import { isValidCssColor } from '../utils/securityUtils';
import { useSettings } from '../contexts/SettingsContext';
import { useSpoilerRevealActions } from './SpoilerRevealContext';
import { MENTION_HIGHLIGHT_PRESETS } from '../utils/uiDensityStorage';
import { useMessageStore } from '../stores/messageStore';
import { useTypingStore } from '../stores/typingStore';
import { useServerStore } from '../stores/serverStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useDmStore } from '../stores/dmStore';
import type { DmChannelEntry } from '../stores/types';
import { getScrollPosition, saveScrollPosition } from '../utils/scrollPositionStorage';
import { useAuthStore } from '../stores/authStore';
import { useAppStore } from '../stores/appStore';
import { useThreadPollStore } from '../stores/threadPollStore';
import { useNotificationStore } from '../stores/notificationStore';
import { apiClient } from '../services/api';
import { bareChannelId, isOtrRoomKey } from '../services/mls/roomKey';
import { otrTierSlideClass } from '../utils/otrTierSlide';

const EMPTY_ARRAY: never[] = [];
const EMPTY_MSG_ARRAY: Message[] = [];
const EMPTY_TYPING: Record<string, { username: string; expires: number }> = {};
const EMPTY_THREAD_ARRAY: Thread[] = [];
const EMPTY_THREAD_MAP: Record<string, Thread> = {};

type ChatItem =
  | { kind: 'separator'; day: string; label: string }
  | { kind: 'message'; msg: Message };

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|avif)(\?|$)/i;
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|mkv|avi)(\?|$)/i;

let _emojiSearchIndex: EmojiSearchEntry[] | null = null;
async function getEmojiSearchIndex(): Promise<EmojiSearchEntry[]> {
  if (!_emojiSearchIndex) {
    const mod = await import('../utils/emojiData');
    _emojiSearchIndex = mod.EMOJI_SEARCH_INDEX;
  }
  return _emojiSearchIndex;
}

function emojiShortcode(emoji: string): string {
  if (!_emojiSearchIndex) {
    getEmojiSearchIndex();
    return emoji;
  }
  const entry = _emojiSearchIndex.find((e) => e.emoji === emoji);
  if (entry) return `:${entry.keywords.split(' ').slice(0, 3).join('_')}:`;
  return emoji;
}

// Blob URL cache: survives Virtuoso mount/unmount cycles
// Eliminates the async fetch→blob→createObjectURL→setState cycle on remount.
// Entries are lightweight (~60 bytes each). LRU eviction at 500 keeps memory bounded.
interface BlobCacheEntry {
  blobUrl: string;
  size?: number;
  dims?: { w: number; h: number };
  /** Timestamp (ms) when this entry was created or last accessed. */
  _ts: number;
}
const _blobCache = new Map<string, BlobCacheEntry>();
const BLOB_CACHE_MAX = 100;
/** Entries older than 10 minutes are considered expired. */
const BLOB_CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * Grace period before revoking blob URLs on LRU eviction.
 * Virtuoso may re-mount a previously-visible image within seconds of
 * scrolling it off-screen. Immediate revocation would cause a broken
 * image flash. 30 seconds gives plenty of time for re-access while
 * still freeing memory promptly. The TTL sweep acts as a backstop.
 */
const BLOB_REVOKE_GRACE_MS = 30_000;
/** Pending revoke timers — cancelled if the entry is re-accessed. */
const _pendingRevokes = new Map<string, ReturnType<typeof setTimeout>>();

function blobCacheGet(key: string): BlobCacheEntry | undefined {
  // Cancel any pending revoke — this URL is still needed
  const pendingTimer = _pendingRevokes.get(key);
  if (pendingTimer !== undefined) {
    clearTimeout(pendingTimer);
    _pendingRevokes.delete(key);
  }

  const entry = _blobCache.get(key);
  if (!entry) return undefined;
  // TTL check: if expired, revoke and evict
  if (Date.now() - entry._ts > BLOB_CACHE_TTL_MS) {
    _blobCache.delete(key);
    if (entry.blobUrl.startsWith('blob:')) URL.revokeObjectURL(entry.blobUrl);
    return undefined;
  }
  // LRU touch: delete and re-insert so it's last in iteration order
  entry._ts = Date.now();
  _blobCache.delete(key);
  _blobCache.set(key, entry);
  return entry;
}

function blobCacheSet(key: string, entry: Omit<BlobCacheEntry, '_ts'>): void {
  // Cancel pending revoke for this key if we're re-setting it
  const pendingTimer = _pendingRevokes.get(key);
  if (pendingTimer !== undefined) {
    clearTimeout(pendingTimer);
    _pendingRevokes.delete(key);
  }

  if (_blobCache.size >= BLOB_CACHE_MAX) {
    // Evict oldest (first in Map iteration order)
    const oldest = _blobCache.keys().next().value;
    if (oldest !== undefined) {
      const evicted = _blobCache.get(oldest);
      _blobCache.delete(oldest);
      // Deferred revoke: schedule blob URL revocation after a grace period.
      // If the image is re-mounted by Virtuoso before the timer fires,
      // blobCacheGet/blobCacheSet will cancel the pending revoke.
      if (evicted && evicted.blobUrl.startsWith('blob:')) {
        const blobUrl = evicted.blobUrl;
        const revokeTimer = setTimeout(() => {
          _pendingRevokes.delete(oldest);
          URL.revokeObjectURL(blobUrl);
        }, BLOB_REVOKE_GRACE_MS);
        _pendingRevokes.set(oldest, revokeTimer);
      }
    }
  }
  _blobCache.set(key, { ...entry, _ts: Date.now() });
}

// Text file content cache: survives Virtuoso mount/unmount cycles
// Eliminates async fetch->setState height change on remount.
// Only caches non-encrypted files (same privacy rule as blob cache).
interface TextCacheEntry {
  content: string;
  /** Timestamp (ms) when this entry was created or last accessed. */
  _ts: number;
}
const _textCache = new Map<string, TextCacheEntry>();
const TEXT_CACHE_MAX = 100;
/** Entries older than 10 minutes are considered expired. */
const TEXT_CACHE_TTL_MS = 10 * 60 * 1000;

function textCacheGet(key: string): string | undefined {
  const entry = _textCache.get(key);
  if (entry === undefined) return undefined;
  // TTL check: remove expired entries
  if (Date.now() - entry._ts > TEXT_CACHE_TTL_MS) {
    _textCache.delete(key);
    return undefined;
  }
  // LRU touch
  entry._ts = Date.now();
  _textCache.delete(key);
  _textCache.set(key, entry);
  return entry.content;
}

function textCacheSet(key: string, content: string): void {
  if (_textCache.size >= TEXT_CACHE_MAX) {
    const oldest = _textCache.keys().next().value;
    if (oldest !== undefined) _textCache.delete(oldest);
  }
  _textCache.set(key, { content, _ts: Date.now() });
}

/** Clear blob and text caches. Call on logout to free memory and prevent data leaks. */
export function clearMediaCaches(): void {
  // Cancel all pending deferred revokes
  for (const timer of _pendingRevokes.values()) clearTimeout(timer);
  _pendingRevokes.clear();
  // Revoke all blob URLs to release underlying memory
  for (const entry of _blobCache.values()) {
    if (entry.blobUrl.startsWith('blob:')) {
      URL.revokeObjectURL(entry.blobUrl);
    }
  }
  _blobCache.clear();
  _textCache.clear();
}

/**
 * Click-to-reveal spoiler overlay for attachments.
 *
 * Heavy blur + dark glass + centered chip with "Spoiler / Click to reveal".
 * Wraps the underlying attachment thumbnail so the entire tile is clickable.
 * The child media should already have `pointer-events-none` so the wrapping
 * button captures clicks.
 */
function SpoilerAttachmentOverlay({ onReveal, ariaLabel, className, style, children }: {
  onReveal: () => void;
  ariaLabel: string;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onReveal}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onReveal(); } }}
      aria-label={ariaLabel}
      className={`mt-1 relative block text-left overflow-hidden focus:outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 focus:ring-offset-2 focus:ring-offset-[var(--bg-chat)] cursor-pointer group/spoiler ${className ?? ''}`}
      style={style}
    >
      {children}
      <span
        aria-hidden
        className="absolute inset-0"
        style={{
          backdropFilter: 'blur(40px) saturate(0.85)',
          WebkitBackdropFilter: 'blur(40px) saturate(0.85)',
          backgroundColor: 'rgba(10, 14, 16, 0.55)',
        }}
      />
      <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span
          className="inline-flex items-center gap-2 transition-colors group-hover/spoiler:[background:rgba(20,32,34,0.88)] group-hover/spoiler:[border-color:rgba(152,197,172,0.45)]"
          style={{
            background: 'rgba(14, 22, 24, 0.78)',
            border: '1px solid rgba(152, 197, 172, 0.22)',
            borderRadius: '12px',
            padding: '10px 18px 10px 14px',
          }}
        >
          <EyeOff size={20} className="text-white shrink-0" />
          <span className="flex flex-col">
            <span className="text-[13px] font-semibold text-white leading-tight">{t('chat.spoilerLabel', 'Spoiler')}</span>
            <span className="text-[10px] font-medium text-white/55 leading-tight">{t('chat.spoilerHint', 'Click to reveal')}</span>
          </span>
        </span>
      </span>
    </button>
  );
}

/** Renders a message attachment: image (auth-fetched blob) or download link. */
export function MessageAttachment({ attachmentUrl, attachmentName, attachmentContentType, attachmentSize, attachmentWidth, attachmentHeight, getToken, onForward, hideImages = false, showAltText = false, isSticker = false, encryptedFileKey, onImageLoad, isSpoiler = false, messageId, altText }: { attachmentUrl: string; attachmentName?: string | null; attachmentContentType?: string | null; attachmentSize?: number | null; attachmentWidth?: number | null; attachmentHeight?: number | null; getToken?: () => string | null; onForward?: (attachment: { url: string; name: string; contentType?: string }) => void; hideImages?: boolean; showAltText?: boolean; isSticker?: boolean; encryptedFileKey?: string; onImageLoad?: () => void; /** Sender-marked spoiler flag. */ isSpoiler?: boolean; /** Message id used to scope the click-to-reveal state. */ messageId?: string; /** Alt text for the image, from `Message.attachmentAlt`. */ altText?: string | null }) {
  const { t } = useTranslation();
  const { isRevealed, reveal } = useSpoilerRevealActions();
  // Scope reveal state to "this message's attachment" so different
  // messages reveal independently. Reuses the SpoilerRevealContext that
  // already wraps both server channels and DMs (see AppLayout.tsx).
  const revealKey = `attachment:${messageId ?? attachmentUrl}`;
  const revealed = isRevealed(revealKey);
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored at $, no nested quantifiers
  const baseUrl = API_BASE_URL.replace(/\/api(\/v\d+)?$/, '');
  const fullUrl = attachmentUrl.startsWith('http') ? attachmentUrl : `${baseUrl}${attachmentUrl}`;
  const displayName = attachmentName ?? attachmentUrl.split('/').pop() ?? 'file';
  const displayContentType = attachmentContentType ?? undefined;
  const isImageByType = (displayContentType ?? '').startsWith('image/');
  const isImageByExt = !displayContentType && (IMAGE_EXTENSIONS.test(displayName) || IMAGE_EXTENSIONS.test(attachmentUrl));
  const isImage = isImageByType || isImageByExt;
  const isVideoByType = (displayContentType ?? '').startsWith('video/');
  const isVideoByExt = !displayContentType && (VIDEO_EXTENSIONS.test(displayName) || VIDEO_EXTENSIONS.test(attachmentUrl));
  const isVideo = isVideoByType || isVideoByExt;

  const isExternal = fullUrl.startsWith('http') && !fullUrl.startsWith(new URL(baseUrl).origin);

  // Cache-aware initial state
  // If this image was previously loaded, skip the entire async cycle.
  // useState initializer runs once on mount — synchronous, no re-render.
  const cached = isImage ? blobCacheGet(fullUrl) : undefined;
  const [blobUrl, setBlobUrl] = useState<string | null>(cached?.blobUrl ?? null);
  const [blobSize, setBlobSize] = useState<number | undefined>(cached?.size);
  const [loading, setLoading] = useState(cached ? false : (isImage || isVideo));
  const [error, setError] = useState(false);
  const [videoRetry, setVideoRetry] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [preloadDims, setPreloadDims] = useState<{ w: number; h: number } | null>(cached?.dims ?? null);

  // Compute display dimensions for both loading placeholder and loaded image.
  // Prevents height jump on mount: browser reserves space before image decodes.
  const knownW = attachmentWidth ?? preloadDims?.w;
  const knownH = attachmentHeight ?? preloadDims?.h;
  const imgDisplayStyle: React.CSSProperties | undefined = (knownW && knownH) ? (() => {
    const maxH = 256;  // matches max-h-64 (16rem = 256px)
    const maxW = 384;  // matches max-w-sm (24rem = 384px)
    const scale = Math.min(1, maxW / knownW, maxH / knownH);
    return { width: Math.round(knownW * scale), height: Math.round(knownH * scale) };
  })() : undefined;

  // Same-origin fetch (skip if cached)
  useEffect(() => {
    if (cached) return; // Already have blob URL from cache
    if ((!isImage && !isVideo) || isExternal) return;
    let objectUrl: string | null = null;
    const abortController = new AbortController();

    if (encryptedFileKey) {
      import('../services/dmEncryption').then(({ fetchAndDecryptFile }) =>
        fetchAndDecryptFile(fullUrl, encryptedFileKey, attachmentSize ?? undefined)
      ).then(async (blob) => {
        if (abortController.signal.aborted) return;
        if (!blob) { setError(true); setLoading(false); return; }
        if (isImage) {
          // Cap pixels/frames on sender-controlled bytes before render.
          const { guardedImageObjectURL } = await import('../services/mediaDecodeGuard');
          const guarded = await guardedImageObjectURL(blob);
          if ('blocked' in guarded) {
            if (!abortController.signal.aborted) { setError(true); setLoading(false); }
            return;
          }
          objectUrl = guarded.url; // assign before the abort check so cleanup revokes it
          if (abortController.signal.aborted) return;
        } else {
          objectUrl = URL.createObjectURL(blob); // video: frame-by-frame decode (lower-risk residual)
        }
        setBlobUrl(objectUrl);
        setBlobSize(blob.size);
        setLoading(false);
        // Don't cache encrypted blobs — they contain sensitive decrypted data
      }).catch(() => { if (!abortController.signal.aborted) { setError(true); setLoading(false); } });
    } else {
      // Treat backend origin as "same origin" too (Electron page origin differs
      // from the api origin); only then attach the Bearer token.
      const isSameOrigin = fullUrl.startsWith(window.location.origin) || fullUrl.startsWith(getBackendOrigin()) || fullUrl.startsWith('/') || !fullUrl.startsWith('http');
      const token = isSameOrigin ? (getToken?.() ?? null) : null;
      if (isVideo) {
        // Non-encrypted video: resolve a streamable signed CDN URL (do NOT blob
        // the whole file) and point <video src> at it. The signed URL is short-
        // lived; an expiry re-fetches via the videoRetry nonce on the element's
        // onError. fetchSignedMediaUrl preserves the same two-hop ?as=json shape.
        fetchSignedMediaUrl(fullUrl, token, abortController.signal)
          .then((signedUrl) => { setBlobUrl(signedUrl); })
          .catch(() => { if (!abortController.signal.aborted) setError(true); })
          .finally(() => { if (!abortController.signal.aborted) setLoading(false); });
      } else {
        fetchMediaBlobUrl(fullUrl, token, abortController.signal)
          .then((blob) => {
            objectUrl = URL.createObjectURL(blob);
            setBlobUrl(objectUrl);
            setBlobSize(blob.size);
            // Cache the blob URL for future remounts
            if (isImage) blobCacheSet(fullUrl, { blobUrl: objectUrl, size: blob.size });
          })
          .catch(() => { if (!abortController.signal.aborted) setError(true); })
          .finally(() => { if (!abortController.signal.aborted) setLoading(false); });
      }
    }
    return () => {
      abortController.abort();
      // Don't revoke if cached — the cache owns the URL now
      if (objectUrl && !_blobCache.has(fullUrl)) URL.revokeObjectURL(objectUrl);
    };
  }, [fullUrl, isImage, isVideo, isExternal, getToken, encryptedFileKey, videoRetry]);


  // External image preload (skip if cached)
  useEffect(() => {
    if (cached) return; // Already have URL from cache
    // External (non-/api/uploads) media. Mirror the same-origin gate: now that
    // non-encrypted video also resolves through blobUrl, an external video must
    // be handled here (point <video src> straight at the external URL) instead of
    // being left on a perpetual loading spinner. External media is never encrypted.
    if ((!isImage && !isVideo) || !isExternal) return;
    if (isVideo) {
      setBlobUrl(fullUrl);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const img = new Image();
    // Only set crossOrigin for GIFs that will use canvas capture (Klipy/external).
    // Uploaded GIFs use frame-swap (no crossOrigin needed), and mismatched
    // crossOrigin between preload and <img> causes double-download in Chrome.
    const isGifType = (displayContentType ?? '').startsWith('image/gif');
    const hasServerFrame = !encryptedFileKey && !!getFrameUrl(fullUrl);
    if (isGifType && !hasServerFrame) img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!cancelled) {
        let dims: { w: number; h: number } | undefined;
        if (img.naturalWidth > 0 && img.naturalHeight > 0 && !attachmentWidth) {
          dims = { w: img.naturalWidth, h: img.naturalHeight };
          setPreloadDims(dims);
        }
        setBlobUrl(fullUrl);
        setLoading(false);
        // Cache external URL + dimensions for future remounts
        if (isImage) blobCacheSet(fullUrl, { blobUrl: fullUrl, dims });
      }
    };
    let retried = false;
    img.onerror = () => {
      if (cancelled) return;
      // Retry once via the unresolved /api/uploads/<file> path with a cache
      // bust — the signed CDN URL may have expired (30-min HMAC window) and
      // an intermediary cache could be replaying the stale URL. The backend
      // re-signs on the next hit. External hosts (Klipy/Giphy/etc.) return
      // undefined from toOriginalUploadPath and skip straight to error.
      const originalPath = toOriginalUploadPath(fullUrl);
      if (!retried && originalPath) {
        retried = true;
        const sep = originalPath.includes('?') ? '&' : '?';
        img.src = `${originalPath}${sep}_=${Date.now()}`;
        return;
      }
      setError(true);
      setLoading(false);
    };
    img.src = fullUrl;
    return () => { cancelled = true; img.onload = null; img.onerror = null; };
  }, [fullUrl, isImage, isVideo, isExternal, encryptedFileKey, attachmentWidth]);

  // Spoiler gate: sender-marked spoiler blurs image/video until clicked.
  // Non-media attachments render normally regardless of the flag.
  const isMedia = isImage || isVideo;
  const showSpoilerOverlay = isMedia && isSpoiler && !revealed;

  if (isImage) {
    if (hideImages) return null;
    if (loading) {
      if (imgDisplayStyle) {
        return <div className="mt-1 rounded-lg overflow-hidden max-w-sm bg-fill-hover animate-pulse text-t-secondary" style={{ height: imgDisplayStyle.height }}>{t('chat.loading')}</div>;
      }
      return <div className="mt-1 rounded-lg overflow-hidden max-w-sm h-32 bg-fill-hover animate-pulse text-t-secondary">{t('chat.loading')}</div>;
    }
    if (error || !blobUrl) {
      // Reserve the SAME height as the loading/loaded states so a failed image
      // (e.g. a 403 from the CDN) does not collapse its row. A row that shrinks
      // on error changes the total list height, which thrashes Virtuoso's
      // alignToBottom top-padding and causes the visible load-time jitter burst.
      if (imgDisplayStyle) {
        return <div className="mt-1 rounded-lg overflow-hidden max-w-sm bg-fill-hover flex items-center justify-center text-sm text-t-secondary" style={{ height: imgDisplayStyle.height }}>{t('chat.couldNotLoadImage')}</div>;
      }
      return <div className="mt-1 rounded-lg overflow-hidden max-w-sm h-32 bg-fill-hover flex items-center justify-center text-sm text-t-secondary">{t('chat.couldNotLoadImage')}</div>;
    }
    return (
      <>
        {showSpoilerOverlay ? (
          <SpoilerAttachmentOverlay
            onReveal={() => reveal(revealKey)}
            ariaLabel={t('chat.spoilerRevealAria', 'Reveal spoiler attachment')}
            className="rounded-lg max-h-64 max-w-full"
            style={imgDisplayStyle}

          >
            <LazyGif
              src={blobUrl}
              frameSrc={!encryptedFileKey ? getFrameUrl(fullUrl) : undefined}
              animated={false}
              className={`max-h-64 max-w-full object-contain ring-1 ring-[var(--border-subtle)] ${isSticker ? 'howl-sticker-img' : ''}`}
              onImageLoad={onImageLoad}
              alt={altText ?? ''}
            />
          </SpoilerAttachmentOverlay>
        ) : (
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="mt-1 rounded-lg max-h-64 max-w-full overflow-hidden block text-left focus:outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50 focus:ring-offset-2 focus:ring-offset-[var(--bg-chat)]"
            style={imgDisplayStyle}
          >
            <LazyGif src={blobUrl} frameSrc={!encryptedFileKey ? getFrameUrl(fullUrl) : undefined} animated={displayContentType === 'image/gif' && (!!encryptedFileKey || !getFrameUrl(fullUrl))} className={`max-h-64 max-w-full object-contain cursor-pointer hover:opacity-95 ring-1 ring-[var(--border-subtle)] ${isSticker ? 'howl-sticker-img' : ''}`} onImageLoad={onImageLoad} alt={altText ?? ''} />
            {showAltText && attachmentName && <span className="block text-xs mt-0.5 px-1 py-0.5 rounded-lg bg-black/40 text-t-secondary">{attachmentName}</span>}
          </button>
        )}
        <ImageLightbox
          open={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
          imageDisplayUrl={blobUrl}
          imageLinkUrl={fullUrl}
          fileName={attachmentName ?? 'image'}
          fileSizeBytes={blobSize}
          onForwardClick={onForward}
          attachmentUrlPath={attachmentUrl}
          attachmentContentType={attachmentContentType ?? undefined}
        />
      </>
    );
  }
  if (isVideo) {
    if (hideImages) return null;
    // Both encrypted (blob) and non-encrypted (signed CDN URL) resolve into blobUrl now.
    const videoSrc = blobUrl;
    const videoLoading = loading;
    const videoError = error || !blobUrl;

    if (videoLoading) return <div className="mt-1 rounded-lg overflow-hidden max-w-md h-36 bg-fill-hover animate-pulse flex items-center justify-center text-t-secondary">{t('chat.loading')}</div>;
    if (videoError) return (
      <div className="mt-1 flex items-center gap-2">
        <FileDown size={14} className="text-t-secondary" />
        {encryptedFileKey ? (
          <EncryptedDownloadLink fullUrl={fullUrl} label={displayName} fileKey={encryptedFileKey} mimeType={displayContentType} expectedSize={attachmentSize ?? undefined} />
        ) : (
          <span className="text-xs text-t-secondary">{t('chat.videoUnavailable', 'Video unavailable')}</span>
        )}
      </div>
    );
    if (showSpoilerOverlay) {
      // No <video controls> in spoiler state — clicking the wrapper button
      // should reveal, not start playback. preload="metadata" still pulls
      // the first frame so the placeholder isn't a flat gray box.
      return (
        <SpoilerAttachmentOverlay
          onReveal={() => reveal(revealKey)}
          ariaLabel={t('chat.spoilerRevealAria', 'Reveal spoiler attachment')}
          className="max-w-md rounded-lg"
        >
          <video
            src={videoSrc!}
            preload="metadata"
            muted
            playsInline
            className="max-h-80 max-w-full rounded-lg ring-1 ring-[var(--border-subtle)] pointer-events-none"
          >
            <track kind="captions" />
          </video>
        </SpoilerAttachmentOverlay>
      );
    }
    return (
      <div className="mt-1 max-w-md">
        <video
          src={videoSrc!}
          controls
          playsInline
          // preload="metadata" fetches enough bytes for duration + the first
          // frame so the player shows a real preview instead of a gray box.
          // Dropped the empty poster="" attribute — that suppressed the
          // browser's auto-generated thumbnail.
          preload="metadata"
          className="max-h-80 max-w-full rounded-lg ring-1 ring-[var(--border-subtle)]"
          onError={() => { if (!encryptedFileKey && videoRetry < 2) setVideoRetry((n) => n + 1); }}
        >
          <track kind="captions" />
        </video>
        {showAltText && attachmentName && (
          <span className="block text-xs mt-0.5 px-1 py-0.5 rounded-lg bg-black/40 text-t-secondary">{attachmentName}</span>
        )}
      </div>
    );
  }

  // Detect text-based files
  const TEXT_EXTENSIONS = /\.(txt|md|json|csv|log|xml|yml|yaml|toml|ini|cfg|conf|sh|bat|py|js|ts|jsx|tsx|css|html|sql|env)$/i;
  const isTextFile = (displayContentType ?? '').startsWith('text/') || TEXT_EXTENSIONS.test(displayName);

  if (isTextFile) {
    return <TextFileEmbed attachmentUrl={attachmentUrl} attachmentName={displayName} getToken={getToken} encryptedFileKey={encryptedFileKey} expectedSize={attachmentSize ?? undefined} onLoadComplete={onImageLoad} />;
  }

  const label = displayName;
  return (
    <div className="mt-1 flex items-center gap-2">
      <FileDown size={14} className="text-t-secondary" />
      {encryptedFileKey ? (
        <EncryptedDownloadLink fullUrl={fullUrl} label={label} fileKey={encryptedFileKey} mimeType={displayContentType} expectedSize={attachmentSize ?? undefined} />
      ) : (
        <AuthDownloadLink fullUrl={fullUrl} label={label} getToken={getToken} />
      )}
    </div>
  );
}

function TextFileEmbed({ attachmentUrl, attachmentName, getToken, encryptedFileKey, expectedSize, onLoadComplete }: {
  attachmentUrl: string;
  attachmentName: string;
  getToken?: () => string | null;
  encryptedFileKey?: string;
  expectedSize?: number;
  onLoadComplete?: () => void;
}) {
  const { t } = useTranslation();
  const baseUrl = API_BASE_URL.replace(/\/api\/v\d+$/, '').replace(/\/api$/, '');
  const fullUrl = attachmentUrl.startsWith('http') ? attachmentUrl : `${baseUrl}${attachmentUrl}`;
  const cached = !encryptedFileKey ? textCacheGet(fullUrl) : undefined;
  const [content, setContent] = useState<string | null>(cached ?? null);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [wordWrap, setWordWrap] = useState(true);

  useEffect(() => {
    if (cached) { onLoadComplete?.(); return; }
    const ac = new AbortController();
    if (encryptedFileKey) {
      import('../services/dmEncryption').then(({ fetchAndDecryptFile }) =>
        fetchAndDecryptFile(fullUrl, encryptedFileKey, expectedSize)
      ).then(async (blob) => {
        if (ac.signal.aborted || !blob) { setError(true); setLoading(false); onLoadComplete?.(); return; }
        const text = (await blob.text()).slice(0, 50000);
        setContent(text);
        setLoading(false);
        // Don't cache encrypted content
        onLoadComplete?.();
      }).catch(() => { if (!ac.signal.aborted) { setError(true); setLoading(false); onLoadComplete?.(); } });
    } else {
      // Treat backend origin as "same origin" too — under Electron the page
      // origin is howl-app://app, but auth-token-bearing requests still go
      // to api.howlpro.com. Without this, attached images on protected
      // routes 401 because no Authorization header is sent.
      const isSameOrigin = fullUrl.startsWith(window.location.origin) || fullUrl.startsWith(getBackendOrigin()) || fullUrl.startsWith('/') || !fullUrl.startsWith('http');
      const token = isSameOrigin ? getToken?.() : null;
      fetch(fullUrl, { signal: ac.signal, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) })
        .then(r => r.ok ? r.text() : Promise.reject(new Error('Failed')))
        .then(text => {
          const trimmed = text.slice(0, 50000);
          setContent(trimmed);
          textCacheSet(fullUrl, trimmed);
        })
        .catch(() => { if (!ac.signal.aborted) setError(true); })
        .finally(() => { if (!ac.signal.aborted) { setLoading(false); onLoadComplete?.(); } });
    }
    return () => ac.abort();
  }, [fullUrl, encryptedFileKey]);

  const lineCount = content ? content.split('\n').length : 0;
  const fileSize = content ? new Blob([content]).size : 0;
  const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

  const handleDownload = async () => {
    if (!content) return;
    const blob = new Blob([content], { type: 'text/plain' });
    const { downloadBlob } = await import('../utils/downloadFile');
    await downloadBlob(blob, attachmentName);
  };

  if (loading) {
    return (
      <div className="mt-2 mr-4 rounded-xl overflow-hidden border max-w-full" style={{ backgroundColor: 'var(--fill-hover)', borderColor: 'var(--glass-border)' }}>
        <div className="px-3.5 py-3 flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg animate-pulse" style={{ backgroundColor: 'var(--fill-hover)' }} />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-24 rounded-lg animate-pulse" style={{ backgroundColor: 'var(--fill-hover)' }} />
            <div className="h-2.5 w-16 rounded-lg animate-pulse" style={{ backgroundColor: 'var(--fill-hover)' }} />
          </div>
        </div>
      </div>
    );
  }

  if (error || !content) {
    return (
      <div className="mt-1 flex items-center gap-2">
        <FileDown size={14} className="text-t-secondary" />
        {encryptedFileKey ? (
          <EncryptedDownloadLink fullUrl={fullUrl} label={attachmentName} fileKey={encryptedFileKey} mimeType="text/plain" expectedSize={expectedSize} />
        ) : (
          <AuthDownloadLink fullUrl={fullUrl} label={attachmentName} getToken={getToken} />
        )}
      </div>
    );
  }

  const previewLines = content.split('\n').slice(0, 3).join('\n');

  return (
    <>
      <div className="mt-2 mr-4 rounded-xl overflow-hidden border max-w-full" style={{ backgroundColor: 'var(--fill-hover)', borderColor: 'var(--glass-border)' }}>
        <div className="px-3.5 py-2.5 flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg shrink-0 flex items-center justify-center" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 15%, transparent)' }}>
            <FileText size={18} className="text-t-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold truncate text-t-primary">{attachmentName}</div>
            <div className="text-[11px] mt-0.5 text-t-secondary">{formatSize(fileSize)} · {lineCount} {lineCount === 1 ? 'line' : 'lines'}</div>
          </div>
          <div className="flex gap-0.5 shrink-0">
            <button type="button" onClick={() => setWordWrap(w => !w)} className={`w-7 h-7 rounded-md flex items-center justify-center hover:bg-fill-hover transition-colors ${wordWrap ? '' : 'bg-fill-hover'}`} title={wordWrap ? t('common.nowrap', 'Disable word wrap') : t('common.wordWrap', 'Enable word wrap')}>
              <WrapText size={15} className="text-t-secondary" />
            </button>
            <button type="button" onClick={() => setExpanded(e => !e)} className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-fill-hover transition-colors" title={expanded ? t('common.collapse', 'Collapse') : t('common.expand', 'Expand')}>
              <ChevronDown size={15} className={`transition-transform ${expanded ? 'rotate-180' : ''} text-t-secondary`} />
            </button>
            <button type="button" onClick={handleDownload} className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-fill-hover transition-colors" title={t('common.download', 'Download')}>
              <FileDown size={15} className="text-t-secondary" />
            </button>
            <button type="button" onClick={() => setLightboxOpen(true)} className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-fill-hover transition-colors" title={t('common.enlarge', 'Enlarge')}>
              <Maximize2 size={15} className="text-t-secondary" />
            </button>
          </div>
        </div>
        <div
          className="border-t px-3.5 py-2.5 font-mono text-xs leading-relaxed overflow-hidden relative text-t-secondary"
          style={{
            borderColor: 'var(--border-subtle)',
            backgroundColor: 'var(--bg-code)',
            maxHeight: expanded ? '300px' : '72px',
            overflowY: expanded ? 'auto' : 'hidden',
            whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
            wordBreak: wordWrap ? 'break-word' : 'normal',
            overflowX: wordWrap ? 'hidden' : 'auto',
          }}
        >
          {expanded ? content : previewLines}
          {!expanded && lineCount > 3 && (
            <div className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none" style={{ background: 'linear-gradient(transparent, var(--bg-code))' }} />
          )}
        </div>
      </div>
      {/* Portal the lightbox to document.body. The message row is rendered
          inside a Virtuoso scroll container whose ancestors may create
          stacking contexts (transform, contain, z-indexed panels), and a
          bare `position: fixed` inside that subtree stacks relative to the
          nearest containing block rather than the viewport — which is why
          this modal was leaking to the right of the chat area instead of
          covering the whole screen. Portaling escapes all of that. */}
      {lightboxOpen && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[var(--z-max)] flex items-center justify-center p-4" style={{ backgroundColor: 'var(--overlay-backdrop)', backdropFilter: 'blur(8px)' }} onClick={() => setLightboxOpen(false)}>
          <div className="w-full max-w-2xl rounded-xl border overflow-hidden bg-floating" style={{ borderColor: 'var(--glass-border)' }} onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 flex items-center justify-between border-b" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center gap-2.5">
                <FileText size={18} className="text-t-accent" />
                <div>
                  <div className="text-sm font-semibold text-t-primary">{attachmentName}</div>
                  <div className="text-[11px] text-t-secondary">{formatSize(fileSize)} · {lineCount} lines</div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={handleDownload} className="px-3 py-1.5 rounded-md flex items-center gap-1.5 text-[11px] font-semibold hover:bg-fill-hover transition-colors text-t-secondary">
                  <FileDown size={13} />
                  {t('common.download', 'Download')}
                </button>
                <button type="button" onClick={() => setLightboxOpen(false)} className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-fill-hover transition-colors">
                  <X size={16} className="text-t-secondary" />
                </button>
              </div>
            </div>
            <div className="px-4 py-3 font-mono text-[13px] leading-relaxed text-t-secondary" style={{ backgroundColor: 'var(--bg-code)', maxHeight: '70vh', overflowY: 'auto', whiteSpace: wordWrap ? 'pre-wrap' : 'pre', wordBreak: wordWrap ? 'break-word' : 'normal', overflowX: wordWrap ? 'hidden' : 'auto' }}>
              {content}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function EncryptedDownloadLink({ fullUrl, label, fileKey, mimeType, expectedSize }: { fullUrl: string; label: string; fileKey: string; mimeType?: string; expectedSize?: number }) {
  const [loading, setLoading] = useState(false);
  const handleClick = () => {
    setLoading(true);
    import('../services/dmEncryption').then(({ fetchAndDecryptFile }) =>
      fetchAndDecryptFile(fullUrl, fileKey, expectedSize)
    ).then(async (blob) => {
      if (!blob) return;
      const finalBlob = mimeType ? new Blob([blob], { type: mimeType }) : blob;
      const { downloadBlob } = await import('../utils/downloadFile');
      await downloadBlob(finalBlob, label);
    }).catch(() => {
      window.dispatchEvent(new CustomEvent('howl:download-toast', { detail: { message: 'Failed to download', type: 'warning' } }));
    }).finally(() => setLoading(false));
  };
  return (
    <button type="button" onClick={handleClick} disabled={loading} className="text-sm underline cursor-pointer hover:opacity-80" style={{ color: 'var(--text-link)' }}>
      {loading ? '...' : label}
    </button>
  );
}

function AuthDownloadLink({ fullUrl, label, getToken }: { fullUrl: string; label: string; getToken?: () => string | null }) {
  const [loading, setLoading] = useState(false);
  const handleClick = async () => {
    setLoading(true);
    try {
      // Backend origin counts as internal even though it's a different host
      // from the page origin under Electron (howl-app://app vs api.howlpro.com).
      const isExternal = /^https?:\/\//i.test(fullUrl) && !fullUrl.startsWith(window.location.origin) && !fullUrl.startsWith(getBackendOrigin());
      const token = !isExternal ? getToken?.() : null;
      const { downloadUrl } = await import('../utils/downloadFile');
      await downloadUrl(fullUrl, label, token);
    } catch {
      window.dispatchEvent(new CustomEvent('howl:download-toast', { detail: { message: 'Failed to download', type: 'warning' } }));
    } finally {
      setLoading(false);
    }
  };
  return (
    <button type="button" onClick={handleClick} disabled={loading} className="text-sm font-medium hover:underline truncate max-w-xs text-t-accent">
      {loading ? '\u2026' : label}
    </button>
  );
}

interface ChatAreaProps {
  channel: Channel;
  onSendMessage: (content: string, replyToMessageId?: string, attachment?: { url: string; name: string; contentType?: string }) => void;
  /** Upload file (max 50MB). When provided, attach button is shown. */
  uploadFile?: (file: File) => Promise<{ url: string; name: string; contentType: string; size: number }>;
  /** For authenticated attachment viewing (images and download). */
  getToken?: () => string | null;
  /** When user clicks Forward in image lightbox, call with attachment so app can open forward modal */
  onForwardImage?: (attachment: { url: string; name: string; contentType?: string }) => void;
  /** When user clicks Forward in message context menu, call with payload (text and/or attachment) to open forward modal */
  onForwardMessage?: (payload: { attachment?: { url: string; name: string; contentType?: string }; text?: string }) => void;
  onUserClick?: (user: UserWithRole, e: React.MouseEvent) => void;
  onUserRightClick?: (user: UserWithRole, e: React.MouseEvent) => void;
  /** When set (e.g. DM), header name is clickable for profile popup and context menu */
  headerUser?: UserWithRole | null;
  /** When set (group DM), header shows group icon and name is clickable to edit */
  headerGroup?: { id: string; name: string; icon?: string | null } | null;
  onGroupHeaderClick?: () => void;
  /** Whether this DM channel is E2E encrypted */
  encrypted?: boolean;
  /** When true, input is disabled and blockBanner is shown (DM block) */
  sendDisabled?: boolean;
  blockBanner?: string | null;
  /** Disabled-composer placeholder reason. Falls back to blockBanner when unset.
      Used for cases (e.g. MLS-locked) that disable the composer but show their
      reason via a different banner, so no amber blockBanner is rendered. */
  composerPlaceholder?: string | null;
  /** DM/group only: pinned message IDs for context menu and indicators */
  pinnedMessageIds?: string[];
  onPinMessage?: (messageId: string) => void;
  onUnpinMessage?: (messageId: string) => void;
  onVoiceCall?: () => void;
  onVideoCall?: () => void;
  /** When set (DM peer hasn't published MLS KeyPackages), the call buttons are disabled
   *  with this string as the tooltip instead of starting a call that would just block. */
  callBlockedReason?: string | null;
  onShowPinned?: () => void;
  onAddFriendsToDm?: () => void;
  /** When true, show the notification strip (with placeholder if empty) */
  showServerNotificationStrip?: boolean;
  /** When true, show a banner above the text box: "You're sending messages too fast. Please slow down." (no duration) */
  rateLimitBanner?: boolean;
  /** Transient error message from automod / content filter / slow mode (shown above text box, auto-clears) */
  messageSendError?: string | null;
  /** Optional content rendered between the ChatArea header and the message list.
   *  Used by DMView to show the active-call / incoming-call / "user is in a call"
   *  preview banners while keeping the DM header above them. */
  topBanner?: React.ReactNode;
  /** When true, hides the message list (Virtuoso) and composer, leaving only the header + topBanner.
   *  Used when the DM call is in panel-fullscreen mode and the call should take over the DM panel. */
  chatHidden?: boolean;
  /** When true (e.g. server owner/admin), delete message option shown for any message */
  canDeleteAnyMessage?: boolean;
  canMentionEveryone?: boolean;
  onDeleteMessage?: (messageId: string) => void;
  onEditMessage?: (messageId: string, newContent: string) => void;
  onReportMessage?: (messageId: string) => void;
  onReactMessage?: (messageId: string, emoji: string) => void;
  /** DM/Group: ref to the outer DM container so reply bar can span its full width */
  dmContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** Server only: fetch pinned messages for the channel (opens pinned modal) */
  getChannelPins?: (channelId: string) => Promise<Array<Message & { pinnedAt: string; pinnedById: string }>>;
  /** Group DM only: show Members column toggle in header (no roles, all members) */
  groupMembersColumnOpen?: boolean;
  onGroupMembersColumnToggle?: () => void;
  groupMembersCount?: number;
  /** 1-on-1 DM only: toggle the DM profile panel (rendered by DMView, not here). */
  profilePanelOpen?: boolean;
  onProfilePanelToggle?: () => void;
  /** 1-on-1 DM only: toggle Off the Record. Shown only when otrEligible. */
  onToggleOffTheRecord?: () => void;
  offTheRecordActive?: boolean;
  otrEligible?: boolean;
  /** 1-on-1 DM only: resolved recoverability state for the header chip. Null/undefined hides it. */
  recoverabilityState?: RecoverabilityState | null;
  /** Called when the recoverability popover's "Switch to Self recovery" link is clicked. */
  onOpenRecoverySettings?: () => void;
  /** Called when user clicks Join on an invite embed */
  onJoinInvite?: (code: string) => void;
  /** Called when user clicks View Server on an invite embed */
  onViewServer?: (serverId: string) => void;
  hideHeader?: boolean;
  /** Pass-through to MessageInput — render inline (no portal, no fixed positioning).
   *  Used by QuickTextPanel so the composer stays inside the popout card. */
  inline?: boolean;
  onLoadMoreMessages?: () => void;
  onNavigateToMessage?: (channelId: string, messageId: string) => void;
  onTyping?: () => void;
  /** Navigate to a channel (text or voice) when clicked in the panel Text/Pinned views */
  onSelectChannel?: (channelId: string) => void;
  onVotePoll?: (pollId: string, optionId: string) => void;
  onRemoveVotePoll?: (pollId: string, optionId: string) => void;
  onClosePoll?: (pollId: string) => void;
  onDeletePoll?: (pollId: string) => void;
  onOpenThread?: (thread: Thread) => void;
  onCreateThread?: (parentMessageId: string, parentContent: string) => void;
  onCreatePoll?: () => void;
  canCreatePoll?: boolean;
  onCreateThreadFromMenu?: () => void;
  canCreateThread?: boolean;
  /** Mark a message as unread (sets read cursor to just before this message's timestamp) */
  onMarkUnread?: (messageTimestamp: string, channelId: string) => void;
  onSlashCommand?: (command: string, args: Record<string, string>) => void;
  /** Reserve right-padding (px) on the chat-header actions row. Used in
   *  Classic-layout server mode when the members column is closed: the
   *  top-right action bubble shrinks to icon-only and floats over the chat
   *  area; this padding pushes pin/search left so they don't sit beneath it. */
  headerActionsRightPad?: number;
}

/** Copy an image URL to the clipboard as PNG (the only format reliably supported by Clipboard API). */
async function copyImageToClipboard(imageUrl: string): Promise<boolean> {
  try {
    // Use the backend origin for relative paths — `window.location.origin` is
    // howl-app://app under Electron and our custom protocol handler doesn't
    // proxy /api/uploads, so fetching against it 404s.
    const fullUrl = imageUrl.startsWith('http') ? imageUrl : `${getBackendOrigin()}${imageUrl}`;
    const response = await fetch(fullUrl, { credentials: 'include' });
    if (!response.ok) return false;
    const blob = await response.blob();

    if (blob.type === 'image/png') {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    }

    // Convert non-PNG to PNG via canvas (clipboard API only reliably supports PNG)
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const objectUrl = URL.createObjectURL(blob);

    return new Promise<boolean>((resolve) => {
      img.onload = async () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(false); return; }
          ctx.drawImage(img, 0, 0);
          const pngBlob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
          if (!pngBlob) { resolve(false); return; }
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
          resolve(true);
        } catch { resolve(false); }
        finally { URL.revokeObjectURL(objectUrl); }
      };
      img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(false); };
      img.src = objectUrl;
    });
  } catch { return false; }
}

/** Estimated height/width of message context menu so we can flip it upward/left when near viewport edge */
const MESSAGE_MENU_EST_HEIGHT = 440;
const MESSAGE_MENU_EST_WIDTH = 220;
const MESSAGE_MENU_PADDING = 8;

function getMessageMenuPosition(x: number, y: number): { left: number; top: number } {
  let left = x;
  let top = y;
  if (top + MESSAGE_MENU_EST_HEIGHT > window.innerHeight - MESSAGE_MENU_PADDING) {
    top = y - MESSAGE_MENU_EST_HEIGHT;
  }
  if (top < MESSAGE_MENU_PADDING) top = MESSAGE_MENU_PADDING;
  if (left + MESSAGE_MENU_EST_WIDTH > window.innerWidth - MESSAGE_MENU_PADDING) {
    left = window.innerWidth - MESSAGE_MENU_EST_WIDTH - MESSAGE_MENU_PADDING;
  }
  if (left < MESSAGE_MENU_PADDING) left = MESSAGE_MENU_PADDING;
  return { left, top };
}

/** Wraps a message row with swipe-right-to-reply on mobile */
const SwipeableMessageRow: React.FC<{
  children: React.ReactNode;
  onReply: () => void;
  existingTouchHandlers?: {
    onTouchStart?: (e: React.TouchEvent) => void;
    onTouchMove?: (e: React.TouchEvent) => void;
    onTouchEnd?: (e: React.TouchEvent) => void;
    onContextMenu?: (e: React.MouseEvent) => void;
  };
}> = React.memo(({ children, onReply, existingTouchHandlers }) => {
  const rowRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const COMMIT_DISTANCE = 60;

  const swipe = useSwipeGesture({
    direction: 'right',
    threshold: COMMIT_DISTANCE,
    velocityThreshold: 0.5,
    maxCrossAxis: 30,
    enabled: true,
    onDrag: (dx) => {
      const clamped = Math.max(0, Math.min(dx, COMMIT_DISTANCE + 20));
      if (rowRef.current) {
        rowRef.current.style.transition = 'none';
        rowRef.current.style.transform = `translateX(${clamped}px)`;
      }
      if (indicatorRef.current) {
        const pct = Math.min(clamped / COMMIT_DISTANCE, 1);
        indicatorRef.current.style.opacity = String(pct);
        indicatorRef.current.style.transform = `scale(${0.5 + pct * 0.5})`;
      }
    },
    onSwipe: () => {
      navigator.vibrate?.(10);
      if (rowRef.current) {
        rowRef.current.style.transition = 'transform 0.2s ease-out';
        rowRef.current.style.transform = '';
      }
      if (indicatorRef.current) {
        indicatorRef.current.style.opacity = '0';
        indicatorRef.current.style.transform = '';
      }
      onReply();
    },
    onCancel: () => {
      if (rowRef.current) {
        rowRef.current.style.transition = 'transform 0.15s ease-out';
        rowRef.current.style.transform = '';
      }
      if (indicatorRef.current) {
        indicatorRef.current.style.transition = 'opacity 0.15s, transform 0.15s';
        indicatorRef.current.style.opacity = '0';
        indicatorRef.current.style.transform = '';
        setTimeout(() => {
          if (indicatorRef.current) indicatorRef.current.style.transition = '';
        }, 160);
      }
    },
  });

  const mergedHandlers = useMemo(() => ({
    onTouchStart: (e: React.TouchEvent) => {
      swipe.bind.onTouchStart(e);
      existingTouchHandlers?.onTouchStart?.(e);
    },
    onTouchMove: (e: React.TouchEvent) => {
      swipe.bind.onTouchMove(e);
      existingTouchHandlers?.onTouchMove?.(e);
    },
    onTouchEnd: (e: React.TouchEvent) => {
      swipe.bind.onTouchEnd(e);
      existingTouchHandlers?.onTouchEnd?.(e);
    },
    onContextMenu: existingTouchHandlers?.onContextMenu,
  }), [swipe.bind, existingTouchHandlers]);

  return (
    <div className="relative overflow-hidden">
      <div
        ref={indicatorRef}
        className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center justify-center"
        style={{ opacity: 0, width: 32, height: 32, borderRadius: '50%', backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 15%, transparent)' }}
      >
        <CornerUpLeft size={16} className="text-t-accent" />
      </div>
      <div ref={rowRef} {...mergedHandlers}>
        {children}
      </div>
    </div>
  );
});
SwipeableMessageRow.displayName = 'SwipeableMessageRow';

// Composer resting height, cached across the per-channel ChatArea remount
// (server channels remount it via an ErrorBoundary key). Seeding inputBarHeight
// from this on mount keeps the message-list footer the right height BEFORE
// Virtuoso positions, so the footer no longer grows 0->actual underneath the
// initial scroll-to-bottom — the reflow that was racing the force-scroll and
// causing the load jitter. 0 = not yet measured (footer falls back to 80).
let cachedRestingBarHeight = 0;

export const ChatArea: React.FC<ChatAreaProps> = React.memo(({ channel, onSendMessage, uploadFile, getToken, onForwardImage, onForwardMessage, onUserClick, onUserRightClick, headerUser, headerGroup, onGroupHeaderClick, encrypted = false, sendDisabled, blockBanner, composerPlaceholder, pinnedMessageIds: pinnedMessageIdsProp, onPinMessage, onUnpinMessage, onVoiceCall, onVideoCall, callBlockedReason = null, onAddFriendsToDm, showServerNotificationStrip = false, rateLimitBanner = false, messageSendError = null, topBanner, chatHidden = false, canDeleteAnyMessage = false, canMentionEveryone, onDeleteMessage, onEditMessage, onReportMessage, onReactMessage, dmContainerRef, getChannelPins, groupMembersColumnOpen = false, onGroupMembersColumnToggle, groupMembersCount = 0, profilePanelOpen = false, onProfilePanelToggle, onToggleOffTheRecord, offTheRecordActive, otrEligible, recoverabilityState, onOpenRecoverySettings, onJoinInvite, onViewServer, hideHeader = false, inline = false, onLoadMoreMessages, onNavigateToMessage, onTyping, onSelectChannel, onVotePoll, onRemoveVotePoll, onClosePoll, onDeletePoll, onOpenThread, onCreateThread, onCreatePoll, canCreatePoll, onCreateThreadFromMenu, canCreateThread, onMarkUnread, onSlashCommand, headerActionsRightPad }) => {
  useRenderLoopDetector('ChatArea');
  // Store selectors
  const channelId = channel.id;
  const isOtrRoom = isOtrRoomKey(channelId);
  const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tierSlideClass = otrTierSlideClass(isOtrRoom, prefersReducedMotion);
  const isDMChannel = !!(headerUser || headerGroup);
  const currentUser = useAuthStore(s => s.currentUser);
  const currentUserId = currentUser?.id ?? '';
  const activeServerId = useNavigationStore(s => s.activeServerId);
  const servers = useServerStore(s => s.servers);
  const serverMembers = useServerStore(s => s.serverMembers);
  // Mention candidates: server channels mention members; DMs mention the
  // peer (1:1) or the group's other participants. Subscribing to the
  // matching DM entry keeps `@` autocomplete reactive to membership/profile
  // changes (e.g. someone joins a group DM, peer renames).
  const dmOtherUsers = useDmStore(useCallback(
    (s: { dmChannels: DmChannelEntry[] }) => {
      if (!isDMChannel || !headerGroup) return null;
      return s.dmChannels.find(c => c.id === channelId)?.otherUsers ?? null;
    },
    [isDMChannel, headerGroup, channelId]
  ));
  const users: User[] = useMemo(() => {
    if (!isDMChannel) return serverMembers as User[];
    if (headerGroup) return (dmOtherUsers ?? []) as unknown as User[];
    if (headerUser) return [headerUser as unknown as User];
    return [];
  }, [isDMChannel, headerGroup, headerUser, dmOtherUsers, serverMembers]);
  const statusBarDocked = useAppStore(s => s.floatingBarDocked);
  // Channel messages vs DM messages: use the appropriate store bucket based on context
  const channelMessages = useMessageStore(useCallback((s: { messages: Record<string, Message[]> }) => s.messages[channelId] ?? EMPTY_MSG_ARRAY, [channelId]));
  const dmMessages = useMessageStore(useCallback((s: { dmMessages: Record<string, Message[]> }) => s.dmMessages[channelId] ?? EMPTY_MSG_ARRAY, [channelId]));
  const messages = isDMChannel ? dmMessages : channelMessages;
  const channelHasMoreFlag = useMessageStore(useCallback((s: { channelHasMore: Record<string, boolean> }) => s.channelHasMore[channelId] ?? false, [channelId]));
  const dmHasMoreFlag = useMessageStore(useCallback((s: { dmHasMore: Record<string, boolean> }) => s.dmHasMore[channelId] ?? false, [channelId]));
  // Empty-state gate: presence in the *HasMore record proves a fetch has
  // landed, so we can distinguish "loading first page" from "fetched, channel
  // is genuinely empty" without flashing the placeholder mid-load.
  const channelFetched = useMessageStore(useCallback((s: {
    channelHasMore: Record<string, boolean>;
    dmHasMore: Record<string, boolean>;
  }) => (isDMChannel ? channelId in s.dmHasMore : channelId in s.channelHasMore),
  [channelId, isDMChannel]));
  const hasMoreMessages = isDMChannel ? dmHasMoreFlag : channelHasMoreFlag;
  const showEmptyState = channelFetched && messages.length === 0;
  const emptyStateSurface: 'channel' | 'dm' | 'group-dm' | 'otr' =
    headerGroup ? 'group-dm'
    : headerUser ? (isOtrRoomKey(channelId) ? 'otr' : 'dm')
    : 'channel';
  // OTR rooms are ephemeral — no history fetch ever lands, so dmHasMore['<id>#otr']
  // is never seeded and channelFetched/showEmptyState stay false, hiding the OTR
  // empty-room explainer + start-composer placeholder on open. Seed an empty
  // "fetched" bucket once the room is open and still empty. Re-read LIVE store
  // state (not the render-time closure): an incoming OTR message — e.g. the
  // on-open re-pull burst — can land via addDmMessage between this render and the
  // passive-effect flush, and addDmMessage doesn't set dmHasMore, so the stale
  // closure would otherwise wipe it. Only ever seed a genuinely empty, un-fetched
  // bucket, so a delivered message is never clobbered.
  useEffect(() => {
    if (!isDMChannel || !isOtrRoom || channelFetched) return;
    const ms = useMessageStore.getState();
    if (!(channelId in ms.dmHasMore) && (ms.dmMessages[channelId]?.length ?? 0) === 0) {
      ms.setDmMessages(channelId, [], false);
    }
  }, [isDMChannel, isOtrRoom, channelFetched, channelId, messages.length]);
  const channelPinIds = useMessageStore(useCallback((s: { channelPinnedMessageIds: Record<string, string[]> }) => s.channelPinnedMessageIds[channelId] ?? EMPTY_ARRAY as string[], [channelId]));
  const dmPinIds = useMessageStore(useCallback((s: { dmPinnedMessageIds: Record<string, string[]> }) => s.dmPinnedMessageIds[channelId] ?? EMPTY_ARRAY as string[], [channelId]));
  const storePinnedMessageIds = isDMChannel ? dmPinIds : channelPinIds;
  const pinnedMessageIds = pinnedMessageIdsProp ?? storePinnedMessageIds;
  const userPlan = currentUser?.stripePlan ?? null;
  const typingRecord = useTypingStore(useCallback((s: { typingByChannel: Record<string, Record<string, { username: string; expires: number }>> }) => s.typingByChannel[channelId] ?? EMPTY_TYPING, [channelId]));
  const typingUsers = useMemo(() => Object.entries(typingRecord).map(([userId, e]) => ({ userId, username: e.username })), [typingRecord]);
  const polls = useThreadPollStore(useCallback((s: { channelPolls: Record<string, Poll[]> }) => s.channelPolls[channelId] ?? EMPTY_ARRAY as Poll[], [channelId]));
  const pollsMap = useMemo(() => { const m: Record<string, Poll> = {}; for (const p of polls) m[p.id] = p; return m; }, [polls]);
  const channelThreads = useThreadPollStore(useCallback(
    (s: { channelThreads: Record<string, Thread[]> }) => s.channelThreads[channelId] ?? EMPTY_THREAD_ARRAY,
    [channelId]
  ));
  const threadsByMessage = useMemo(() => {
    if (channelThreads.length === 0) return EMPTY_THREAD_MAP;
    const m: Record<string, Thread> = {};
    for (const t of channelThreads) if (t.parentMessageId) m[t.parentMessageId] = t;
    return m;
  }, [channelThreads]);

  const lastReadAt = useNotificationStore(useCallback(
    (s: { channelLastReadAt: Record<string, string> }) => s.channelLastReadAt[channelId] ?? null,
    [channelId]
  ));

  const firstUnreadIndex = useMemo(() => {
    if (!lastReadAt || !messages.length) return null;
    const readTime = new Date(lastReadAt).getTime();
    const idx = messages.findIndex(m => new Date(m.timestamp).getTime() > readTime);
    return idx >= 0 ? idx : null;
  }, [lastReadAt, messages]);

  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { keyboardOpen, viewportHeight } = useKeyboardAware(isMobile);
  // No-op on desktop: useKeyboardAware never flips keyboardOpen when !isMobile.
  const keyboardHeight = useMemo(() => {
    if (!keyboardOpen || typeof window === 'undefined') return 0;
    return Math.max(0, window.innerHeight - viewportHeight);
  }, [keyboardOpen, viewportHeight]);
  const { uiDensity, chatMessageDisplay, messageGroupSpacing, cssZoomLevel, chatSettings, accessibilitySettings, timeFormat: timeFormatProp, streamerSettings: _streamerSettings, mentionHighlightColor } = useSettings();
  const mentionRgb = MENTION_HIGHLIGHT_PRESETS[mentionHighlightColor]?.rgb ?? MENTION_HIGHLIGHT_PRESETS.cyan.rgb;

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const messageInputRef = useRef<MessageInputHandle>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const dragCounterRef = useRef(0);

  const isDM = isDMChannel;

  const otrEmptyPlaceholder = (isDM && isOtrRoomKey(channelId) && showEmptyState && headerUser)
    ? t('chat.otrComposerPlaceholder', 'Send a message to start this chat and invite {{name}}', { name: headerUser.username })
    : undefined;

  const d = uiDensity;
  const compactMessages = chatMessageDisplay === 'compact';
  const messageGapPx = Math.max(0, Math.min(24, messageGroupSpacing));
  const perks = getPlanPerks((userPlan ?? null) as PlanTier);
  const MAX_ATTACHMENT_MB = perks.maxUploadMB;

  // Avatar sizing tracks UI density (compact = tighter rows; default ≈ Discord
  // default; spacious = roomy). The grouped-message hover-timestamp slot must
  // match the avatar width so its right-aligned timestamp lines up with where
  // the text begins below the avatar on the first message of a group.
  const avatarSizePx = d === 'compact' ? 32 : d === 'spacious' ? 48 : 40;
  const avatarSlotWidthClass = d === 'compact' ? 'w-8' : d === 'spacious' ? 'w-12' : 'w-10';
  // Match the message-list horizontal padding to the composer wrapper's
  // density-aware padding (5px 10px 10px / 4px 8px 8px / 6px 14px 14px in
  // MessageInput.tsx). Without this, message rows started ~6–8 px to the right
  // of the typing-area box edge — a small but visible misalignment between
  // the chat list and the composer.
  const messageListPaddingX = d === 'compact' ? '8px' : d === 'spacious' ? '14px' : '10px';

  // Seed from the cached resting height so the footer doesn't reflow under the
  // initial scroll on a fresh mount (see cachedRestingBarHeight above). prev is
  // seeded to the same value so the first run of the resize effect is a no-op
  // (prev === inputBarHeight) rather than a spurious force-scroll.
  const [inputBarHeight, setInputBarHeight] = useState(cachedRestingBarHeight);
  const prevInputBarHeightRef = useRef(cachedRestingBarHeight);
  const handleBarHeightChange = useCallback((h: number) => {
    setInputBarHeight(h);
    // Track the resting (minimum plausible) height; min() ignores transient-tall
    // states (reply bar, attachment preview, multiline). First plausible value seeds it.
    if (h >= 40) cachedRestingBarHeight = cachedRestingBarHeight === 0 ? h : Math.min(cachedRestingBarHeight, h);
  }, []);

  const showImagesUploaded = chatSettings?.displayImagesUploaded ?? true;
  const showImageDesc = chatSettings?.imageDescriptions ?? false;
  const showSendBtn = accessibilitySettings?.showSendButton ?? false;
  const convertEmoticons = chatSettings?.convertEmoticons ?? true;
  const roleColorMode = accessibilitySettings?.roleColorMode ?? 'in-names';
  const showEmojiReactions = chatSettings?.showEmojiReactions ?? true;
  const showEmbeds = chatSettings?.showEmbeds ?? true;
  const ttsRate = accessibilitySettings?.ttsRate ?? 100;
  // Cache the Intl.DateTimeFormat instance — date.toLocaleTimeString creates
  // a fresh formatter under the hood for every call, which adds up when the
  // chat list renders 30–80 visible messages on every re-render.
  // hour: 'numeric' (no leading zero) matches Discord's format — "1:59 PM"
  // not "01:59 PM". Used by both the message-row gutter timestamp and the
  // header timestamp (via formatHeaderTs below).
  const timeFormatter = useMemo(() => {
    const tf = timeFormatProp ?? 'auto';
    const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
    if (tf === '12h') opts.hour12 = true;
    else if (tf === '24h') opts.hour12 = false;
    return new Intl.DateTimeFormat(undefined, opts);
  }, [timeFormatProp]);
  const formatTs = useCallback((date: Date) => timeFormatter.format(date), [timeFormatter]);

  // Discord-style header timestamp: "Today at H:MM PM" / "Yesterday at H:MM PM"
  // for recent messages, "M/D/YYYY H:MM PM" otherwise. Numeric (no leading
  // zero) on month/day/hour to match Discord exactly. The first-of-group
  // message header uses this; subsequent messages use the gutter timestamp
  // (just-the-time) since the date is implicit from the date divider.
  const formatHeaderTs = useCallback((date: Date) => {
    const time = timeFormatter.format(date);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayDiff = Math.round((today.getTime() - dayStart.getTime()) / 86400000);
    if (dayDiff === 0) return `Today at ${time}`;
    if (dayDiff === 1) return `Yesterday at ${time}`;
    return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} ${time}`;
  }, [timeFormatter]);

  // Stable mention-click handler so MentionText (React.memo'd) doesn't re-render
  // on every parent re-render due to a fresh inline closure.
  const handleMentionClick = useMemo<
    | ((user: { id: string; username: string; avatar?: string | null; status?: string }, e: React.MouseEvent) => void)
    | undefined
  >(
    () => (onUserClick
      ? (user, e) => onUserClick(user as UserWithRole, e)
      : undefined),
    [onUserClick],
  );

  const formatDateSeparator = useCallback((date: Date) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (msgDay.getTime() === today.getTime()) return t('dateSeparator.today');
    if (msgDay.getTime() === yesterday.getTime()) return t('dateSeparator.yesterday');
    return date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }, [t]);

  const isDifferentDay = useCallback((a: Date, b: Date) => {
    return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate();
  }, []);

  const isDMHeader = !!(headerUser || headerGroup);
  const headerGap = d === 'compact' ? 'gap-2' : d === 'spacious' ? 'gap-3' : 'gap-2.5';
  // Scroll Management
  // Design: Virtuoso's native `followOutput` handles append auto-scroll.
  // Manual `firstItemIndex` adjustment handles prepend stability.
  // `key={channel.id}` on Virtuoso forces clean remount on channel switch.
  // Single `handleMediaLoad` callback replaces all onImageLoad scroll hacks.

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const isAtBottomRef = useRef(true);
  const unseenCountRef = useRef(0);
  const isScrollingRef = useRef(false);

  // Direct handle on Virtuoso's underlying scroller. Used for force-scrolls
  // where we want to bypass Virtuoso's index/alignment math entirely.
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const forceScrollToBottom = useCallback((_reason: string = 'manual') => {
    const el = scrollerElRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const [showScrollDown, setShowScrollDown] = useState(false);
  const [, triggerBadgeRender] = useState(0);

  // firstItemIndex pattern: Virtuoso needs a stable decreasing index for prepends.
  const INITIAL_FIRST_INDEX = 100000;
  const firstItemIndexRef = useRef(INITIAL_FIRST_INDEX);
  const [firstItemIndex, setFirstItemIndex] = useState(INITIAL_FIRST_INDEX);

  // Track previous messages array for prepend detection
  const prevMessagesRef = useRef<Message[] | null>(null);

  // Track previous flatItems length for prepend index adjustment.
  // Separators are first-class rows, so we decrement firstItemIndex by
  // (newFlatLength - prevFlatLength) rather than raw message count.
  const prevFlatLengthRef = useRef<number | null>(null);

  // Stable refs so the rangeChanged callback (which fires constantly during scroll)
  // doesn't re-bind on every render and force Virtuoso to re-create its observer.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // Stable ref for flatItems — used inside handleRangeChanged and renderMessageItem
  // so those callbacks don't re-bind on every flatItems change.
  const flatItemsRef = useRef<ChatItem[]>([]);
  const hasMoreMessagesRef = useRef(hasMoreMessages);
  hasMoreMessagesRef.current = hasMoreMessages;
  const onLoadMoreMessagesRef = useRef(onLoadMoreMessages);
  onLoadMoreMessagesRef.current = onLoadMoreMessages;

  // Brief highlight flash on jump-to-message landing. The color comes from the
  // user's mention-highlight setting (Appearance tab) — keeps the visual
  // language consistent with the existing mention-highlight bar.
  const [flashedMessageId, setFlashedMessageId] = useState<string | null>(null);
  const flashTimeoutRef = useRef<number | null>(null);
  const flashMessage = useCallback((id: string) => {
    setFlashedMessageId(id);
    if (flashTimeoutRef.current != null) window.clearTimeout(flashTimeoutRef.current);
    flashTimeoutRef.current = window.setTimeout(() => {
      setFlashedMessageId(null);
      flashTimeoutRef.current = null;
    }, 1600);
  }, []);
  useEffect(() => () => { if (flashTimeoutRef.current != null) window.clearTimeout(flashTimeoutRef.current); }, []);

  // Virtuoso callbacks

  const handleFollowOutput = useCallback((isAtBottom: boolean) => {
    // Always use 'auto' (instant). 'smooth' causes visual conflicts when media
    // loads during the animation — handleMediaLoad fires scrollToIndex which
    // cancels the smooth scroll mid-animation, causing a jarring jump.
    // Discord also uses instant scroll for new messages.
    return isAtBottom ? 'auto' : false;
  }, []);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    isAtBottomRef.current = atBottom;
    if (atBottom) {
      unseenCountRef.current = 0;
      setShowScrollDown(false);
      // Mark channel/DM as read when user reaches the bottom
      if (channelId) {
        const notif = useNotificationStore.getState();
        notif.clearChannelLastReadAt(channelId);
        // Optimistic store clear so the dot disappears the moment the user
        // reaches the bottom — no waiting on the API echo via channel-read-state /
        // dm-read-state. Idempotent with the socket echo when it arrives.
        if (isDMChannel) {
          // Unread/notification state is keyed by the BARE dm channel id, but an
          // active OTR room makes channelId the `${id}#otr` room key — un-namespace
          // before clearing, else the OTR badge stays stuck.
          const bareId = bareChannelId(channelId);
          if (isOtrRoomKey(channelId)) {
            // OTR unread lives in its own parallel maps; no mentions, no server read state.
            notif.removeOtrUnreadDmChannel(bareId);
            notif.clearOtrDmUnread(bareId);
          } else {
            notif.removeUnreadDmChannel(bareId);
            notif.clearDmUnread(bareId);
            notif.clearDmMention(bareId);
            apiClient.markDmAsRead(bareId).catch(() => {});
          }
        } else {
          notif.removeChannelUnread(channelId);
          notif.clearChannelMention(channelId);
          apiClient.markChannelRead(channelId).catch(() => {});
        }
        // Save "at bottom" so the next visit restores cleanly to the latest message
        // even if the saved messageId from a prior scroll is no longer in the loaded set.
        saveScrollPosition(channelId, { messageId: null, atBottom: true });
      }
    } else {
      setShowScrollDown(true);
    }
  }, [channelId, isDMChannel]);

  // Fired on every render-range change during scroll. Two responsibilities:
  // 1. Save the topmost-visible message id so we can restore scroll position
  //    on the next visit to this channel.
  // 2. Trigger pagination earlier than `startReached` (which only fires at the
  //    exact top), so older history is in flight before the user reaches the
  //    boundary — avoids the brief blank/spinner pause Discord doesn't have.
  const PREFETCH_THRESHOLD_ITEMS = 10;
  const handleRangeChanged = useCallback((range: { startIndex: number; endIndex: number }) => {
    const flatIndex = range.startIndex - firstItemIndexRef.current;

    // Earlier pagination: when the rendered window is within N items of the
    // start of the loaded list, kick off a fetch. Cheap because the action
    // itself is guarded against duplicate in-flight requests.
    if (
      flatIndex < PREFETCH_THRESHOLD_ITEMS
      && hasMoreMessagesRef.current
      && onLoadMoreMessagesRef.current
    ) {
      onLoadMoreMessagesRef.current();
    }

    // Save scroll position (only when not at bottom — bottom is saved separately
    // by handleAtBottomStateChange so we always have a fresh anchor).
    // Walk from flatIndex to find the nearest message item for a stable anchor.
    if (channelId && !isAtBottomRef.current) {
      const items = flatItemsRef.current;
      for (let i = Math.max(0, flatIndex); i < items.length; i++) {
        const fi = items[i];
        if (fi.kind === 'message') {
          saveScrollPosition(channelId, { messageId: fi.msg.id, atBottom: false });
          break;
        }
      }
    }
  }, [channelId]);

  // If all loaded messages are read (no unread in batch), mark as read and clear lastReadAt
  // so the next load scrolls to bottom instead of a stale unread position.
  useEffect(() => {
    if (!channelId || !messages.length) return;
    if (firstUnreadIndex === null && lastReadAt) {
      const notif = useNotificationStore.getState();
      notif.clearChannelLastReadAt(channelId);
      // Optimistic store clear (matches handleAtBottomStateChange path).
      if (isDMChannel) {
        // Unread/notification state is bare-id keyed; an active OTR room makes
        // channelId the `${id}#otr` room key — un-namespace before clearing.
        const bareId = bareChannelId(channelId);
        if (isOtrRoomKey(channelId)) {
          // OTR unread lives in its own parallel maps; no mentions, no server read state.
          notif.removeOtrUnreadDmChannel(bareId);
          notif.clearOtrDmUnread(bareId);
        } else {
          notif.removeUnreadDmChannel(bareId);
          notif.clearDmUnread(bareId);
          notif.clearDmMention(bareId);
          apiClient.markDmAsRead(bareId).catch(() => {});
        }
      } else {
        notif.removeChannelUnread(channelId);
        notif.clearChannelMention(channelId);
        apiClient.markChannelRead(channelId).catch(() => {});
      }
    }
  }, [channelId, isDMChannel, firstUnreadIndex, lastReadAt, messages.length]);

  const handleScrollingChange = useCallback((scrolling: boolean) => {
    isScrollingRef.current = scrolling;
  }, []);

  // Stable startReached + components props for Virtuoso. Inline literals here would
  // change identity every render and force Virtuoso to re-bind its IntersectionObserver
  // and re-render Header/Footer, contributing to scroll jank.
  const handleStartReached = useCallback(() => {
    if (hasMoreMessages && onLoadMoreMessages) onLoadMoreMessages();
  }, [hasMoreMessages, onLoadMoreMessages]);

  // Header always reserves the spinner's footprint so the list doesn't jump downward
  // when hasMoreMessages flips false.
  const virtuosoComponents = useMemo(() => {
    const Header = () => (
      <div className="flex justify-center py-3" style={{ minHeight: 44 }}>
        {hasMoreMessages && (
          <span className="inline-block w-5 h-5 border-2 border-[var(--border-strong)] border-t-[var(--text-secondary)] rounded-full animate-spin" />
        )}
      </div>
    );
    const Footer = () => <div style={{ height: inputBarHeight || 80 }} />;
    return { Header, Footer };
  }, [hasMoreMessages, inputBarHeight]);

  // Flat items: messages + date separators as first-class rows
  // Separators are independent Virtuoso rows, not inline elements inside message rows.
  // This eliminates: (1) duplicate separators from GroupedVirtuoso index mis-alignment,
  // (2) zero-sized-element warnings from height-0 group headers, and (3) prepend jitter
  // because separators are their own rows — they never get added-to or removed-from an
  // existing message row, so firstItemIndex decrements cleanly.
  const flatItems = useMemo<ChatItem[]>(() => {
    const items: ChatItem[] = [];
    let prev: Message | null = null;
    for (const msg of messages) {
      const d = new Date(msg.timestamp);
      if (!prev || isDifferentDay(d, new Date(prev.timestamp))) {
        const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        items.push({ kind: 'separator', day: dayKey, label: formatDateSeparator(d) });
      }
      items.push({ kind: 'message', msg });
      prev = msg;
    }
    return items;
  }, [messages, formatDateSeparator, isDifferentDay]);
  flatItemsRef.current = flatItems;

  // Helper: find the flat-item index for a given message ID.
  const flatIndexOfMessage = useCallback((msgId: string): number => {
    for (let i = 0; i < flatItems.length; i++) {
      const fi = flatItems[i];
      if (fi.kind === 'message' && fi.msg.id === msgId) return i;
    }
    return -1;
  }, [flatItems]);

  // Channel switch reset
  // key={channel.id} on Virtuoso handles internal state reset (scroll position, virtualizer).
  // This effect resets OUR refs and state. Declared before the messages effect so that
  // on channel switch, prevMessagesRef is nulled before the messages effect compares IDs.
  useEffect(() => {
    firstItemIndexRef.current = INITIAL_FIRST_INDEX;
    setFirstItemIndex(INITIAL_FIRST_INDEX);
    prevMessagesRef.current = null;
    prevFlatLengthRef.current = null;
    isAtBottomRef.current = true;
    unseenCountRef.current = 0;
    setShowScrollDown(false);
  }, [channel.id]);

  // Prepend detection + unseen count tracking
  // followOutput handles auto-scrolling on appends.
  // This effect handles: (a) prepend → adjust firstItemIndex, (b) append while scrolled up → unseen count.
  // It anchors on the previous-first message's index in the new array, so concurrent prepend+append
  // (a socket message arriving during pagination) is detected correctly and firstItemIndex is decremented.
  //
  // firstItemIndex adjustment uses flatItems.length delta (via prevFlatLengthRef) so that
  // separator rows are counted. Unseen tracking still uses raw message counts (separators
  // are not "messages" the user needs to read).
  useEffect(() => {
    const prev = prevMessagesRef.current;
    prevMessagesRef.current = messages;
    const prevFlatLen = prevFlatLengthRef.current;
    prevFlatLengthRef.current = flatItems.length;

    if (!prev || prev.length === 0 || messages.length === 0) return;
    if (messages.length <= prev.length) return;

    const prevFirstId = prev[0]?.id;
    const prevLastId = prev[prev.length - 1]?.id;
    const currLastId = messages[messages.length - 1]?.id;

    // prependedCount = new index of the previous first message (in messages array).
    // 0  → no prepend (first item unchanged)
    // >0 → that many messages were prepended above the previous head
    // -1 → previous first message no longer present (mid-list deletion or full replace) → skip adjust
    const prependedCount = messages.findIndex((m) => m.id === prevFirstId);

    if (prependedCount > 0 && prevFlatLen != null) {
      // Find the flat-item index of the previously-first message in the NEW flatItems.
      // This equals the number of rows prepended (messages + their separators).
      let prependedFlatRows = 0;
      for (let i = 0; i < flatItems.length; i++) {
        const fi = flatItems[i];
        if (fi.kind === 'message' && fi.msg.id === prevFirstId) {
          prependedFlatRows = i;
          break;
        }
      }
      if (prependedFlatRows > 0) {
        firstItemIndexRef.current -= prependedFlatRows;
        setFirstItemIndex(firstItemIndexRef.current);
      }
    } else if (prependedCount > 0) {
      // First render after channel switch (prevFlatLen is null): fall back to message count.
      // This branch should rarely fire — channel reset nulls prevMessagesRef too.
      firstItemIndexRef.current -= prependedCount;
      setFirstItemIndex(firstItemIndexRef.current);
    }

    const tailChanged = currLastId !== prevLastId;
    const tail = messages[messages.length - 1];
    const tailIsMine = tailChanged && !!tail && !!currentUserId && tail.authorId === currentUserId;

    if (tailIsMine) {
      // The local user's own send → always follow it to the bottom, independent
      // of Virtuoso's debounced at-bottom flag (which can read stale right after
      // the composer height changes on send). rAF lets Virtuoso commit the new
      // row first. Prepend-only updates leave currLastId unchanged, so this never
      // fires while loading older history.
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
      });
    } else if (tailChanged && !isAtBottomRef.current) {
      // appendedCount = total growth minus what was prepended (clamp prepend < 0 to 0).
      const appendedCount = messages.length - prev.length - Math.max(0, prependedCount);
      if (appendedCount > 0) {
        unseenCountRef.current += appendedCount;
        setShowScrollDown(true);
        triggerBadgeRender(n => n + 1);
      }
    }
  }, [messages, flatItems, currentUserId]);

  // Mobile keyboard: keep input visible
  useEffect(() => {
    if (keyboardOpen && isAtBottomRef.current) {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' });
    }
    // Only react to keyboard open/close, NOT message count changes
  }, [keyboardOpen]);

  // Jump to message (search results, pinned, replies, cross-channel navigation)
  // navigationStore.pendingScrollTarget is set by callers wanting us to scroll to a specific
  // message. If the target is already loaded, scroll. Otherwise fetch a window of messages
  // centered on the target via the backend `?around=:id` endpoint and replace the loaded
  // window — the next render of this effect picks it up and scrolls.
  const pendingScrollTarget = useNavigationStore((s) => s.pendingScrollTarget);
  // Tracks the messageId currently being fetched, so we don't double-fire when the effect
  // re-runs while a fetch is in flight.
  const aroundFetchInFlightRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingScrollTarget) {
      aroundFetchInFlightRef.current = null;
      return;
    }
    if (pendingScrollTarget.channelId !== channel.id) return;

    const fi = flatIndexOfMessage(pendingScrollTarget.messageId);
    if (fi >= 0) {
      virtuosoRef.current?.scrollToIndex({
        index: firstItemIndex + fi,
        behavior: 'auto',
        align: 'center',
      });
      flashMessage(pendingScrollTarget.messageId);
      aroundFetchInFlightRef.current = null;
      useNavigationStore.getState().setPendingScrollTarget(null);
      return;
    }

    // Target not in loaded messages — fetch the around-window once.
    if (aroundFetchInFlightRef.current === pendingScrollTarget.messageId) return;
    aroundFetchInFlightRef.current = pendingScrollTarget.messageId;
    const targetSnapshot = pendingScrollTarget.messageId;
    const channelSnapshot = channel.id;

    (async () => {
      try {
        if (isDMChannel) {
          const result = await apiClient.getDMMessages(channelSnapshot, { around: targetSnapshot, limit: 100 });
          // Stale-result guard: by now the user may have clicked a different target.
          const currentTarget = useNavigationStore.getState().pendingScrollTarget;
          if (currentTarget?.messageId !== targetSnapshot || currentTarget.channelId !== channelSnapshot) return;
          let processed = result.messages;
          if (encrypted) {
            const { decryptDMMessages } = await import('../services/dmEncryption');
            const dmChannel = useDmStore.getState().dmChannels.find((ch) => ch.id === channelSnapshot);
            processed = await decryptDMMessages(channelSnapshot, processed, true, dmChannel);
            // Recheck staleness after async decrypt.
            const t2 = useNavigationStore.getState().pendingScrollTarget;
            if (t2?.messageId !== targetSnapshot || t2.channelId !== channelSnapshot) return;
          }
          useMessageStore.getState().setDmMessages(channelSnapshot, processed, result.hasMore);
        } else {
          const result = await apiClient.getChannelMessages(channelSnapshot, { around: targetSnapshot, limit: 100 });
          const currentTarget = useNavigationStore.getState().pendingScrollTarget;
          if (currentTarget?.messageId !== targetSnapshot || currentTarget.channelId !== channelSnapshot) return;
          useMessageStore.getState().setChannelMessages(channelSnapshot, result.messages, result.hasMore);
        }
        // Reset firstItemIndex so the new window is anchored at the same logical
        // position as a fresh load — avoids stale prepend offsets from prior pagination.
        firstItemIndexRef.current = INITIAL_FIRST_INDEX;
        setFirstItemIndex(INITIAL_FIRST_INDEX);
        prevMessagesRef.current = null;
        prevFlatLengthRef.current = null;
        // Effect re-runs on messages change; fi>=0 branch will then fire and scroll.
      } catch (err) {
        // 404 = message deleted or in inaccessible channel. 403 = no access. Either
        // way, give up so we don't loop. The user sees the channel without scroll.
        console.warn('[ChatArea] jump-to-message around-fetch failed', err);
        aroundFetchInFlightRef.current = null;
        // Only clear if our target is still the active one (don't stomp a new request).
        const currentTarget = useNavigationStore.getState().pendingScrollTarget;
        if (currentTarget?.messageId === targetSnapshot && currentTarget.channelId === channelSnapshot) {
          useNavigationStore.getState().setPendingScrollTarget(null);
        }
      }
    })();
  }, [pendingScrollTarget, messages, channel.id, firstItemIndex, isDMChannel, encrypted, flashMessage, flatIndexOfMessage]);

  // Restore saved scroll position (Discord-style channel-switch memory)
  // initialTopMostItemIndex (computed below + passed to Virtuoso) handles the
  // warm-cache case where messages are already in store at mount. For the cold-load
  // case (mount with empty messages, then they arrive), this effect re-runs once
  // and scrollToIndex's the saved position. positionRestoredRef gates it to a
  // single fire per channel mount.
  const positionRestoredRef = useRef(false);
  useEffect(() => {
    if (positionRestoredRef.current) return;
    if (messages.length === 0) return;
    positionRestoredRef.current = true;
    // First-unread takes precedence over saved position — fresh notifications win.
    if (firstUnreadIndex != null) return;
    const saved = getScrollPosition(channelId);
    if (!saved || saved.atBottom || !saved.messageId) return;
    const fi = flatIndexOfMessage(saved.messageId);
    if (fi >= 0) {
      virtuosoRef.current?.scrollToIndex({
        index: firstItemIndex + fi,
        behavior: 'auto',
      });
    }
  }, [messages, firstUnreadIndex, firstItemIndex, channelId, flatIndexOfMessage]);

  // initialTopMostItemIndex computed once per channel switch (channelId is stable for
  // an instance lifetime — key={channel.id} on the Virtuoso forces a fresh mount).
  // Priority: first-unread > saved scroll position > bottom (default).
  const initialTopMostItemIndex = useMemo(() => {
    if (firstUnreadIndex != null) {
      const targetMsgId = messages[firstUnreadIndex]?.id;
      if (targetMsgId) {
        const fi = flatIndexOfMessage(targetMsgId);
        if (fi >= 0) return firstItemIndex + fi;
      }
      return firstItemIndex + firstUnreadIndex;
    }
    const saved = getScrollPosition(channelId);
    if (saved && !saved.atBottom && saved.messageId) {
      const fi = flatIndexOfMessage(saved.messageId);
      if (fi >= 0) return firstItemIndex + fi;
    }
    return flatItems.length > 0 ? firstItemIndex + flatItems.length - 1 : 0;
    // Intentionally only reacts to channelId — Virtuoso reads this prop only at first
    // render. Recomputing on every messages change wastes findIndex calls.
  }, [channelId]);

  // Media load handler
  // When an image/GIF/video finishes loading, its rendered height may change.
  // Virtuoso's followOutput only fires for new data items, not height changes of existing items.
  // After the LazyGif fix, this only fires ONCE per image (on genuine initial load).
  // Uses a single rAF: Virtuoso's ResizeObserver processes the height change synchronously,
  // so by the next frame its internal state is updated. We then nudge to LAST only if still
  // at bottom. No setTimeout — avoids double-adjustment that caused rubber-banding.
  const handleMediaLoad = useCallback(() => {
    if (!isAtBottomRef.current || isScrollingRef.current) return;
    requestAnimationFrame(() => {
      if (isAtBottomRef.current && !isScrollingRef.current) {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' });
      }
    });
  }, []);

  // When the input bar height changes (multiline expand/collapse, attachment preview),
  // if we were at the bottom, stay at the bottom.
  useEffect(() => {
    const prev = prevInputBarHeightRef.current;
    prevInputBarHeightRef.current = inputBarHeight;
    if (prev === inputBarHeight) return;
    if (inputBarHeight <= 0) return;
    const isFirstMeasurement = prev === 0;
    if (isFirstMeasurement || isAtBottomRef.current) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          forceScrollToBottom(isFirstMeasurement ? 'firstMeasure' : 'inputResize');
        });
      });
    }
  }, [inputBarHeight, forceScrollToBottom]);

  const [messageMenu, setMessageMenu] = useState<{ x: number; y: number; message: Message } | null>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [rightPanelMode, setRightPanelMode] = useState<'search' | 'pinned' | null>(null);
  const [pinnedList, setPinnedList] = useState<Array<Message & { pinnedAt: string; pinnedById: string }>>([]);
  const [pinnedListLoading, setPinnedListLoading] = useState(false);
  const [reactionPickerMsgId, setReactionPickerMsgId] = useState<string | null>(null);
  const reactionPickerMsgIdRef = useRef<string | null>(null);
  reactionPickerMsgIdRef.current = reactionPickerMsgId;
  const [reactionFullPickerOpen, setReactionFullPickerOpen] = useState(false);
  const reactionFullPickerAnchorRef = useRef<HTMLButtonElement>(null);
  const lastDoubleTapReactRef = useRef<string | null>(null);
  const [recentReactionEmojis, setRecentReactionEmojis] = useState<string[]>(() => getRecentEmojis(currentUserId));
  const [reactionSubmenuOpen, setReactionSubmenuOpen] = useState(false);
  const [reactionSubmenuPos, setReactionSubmenuPos] = useState<{ left: number; top: number } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<LexicalEditEditorHandle>(null);

  // Ctrl+K toggles search panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setRightPanelMode(prev => prev === 'search' ? null : 'search');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const usersById = useMemo(() => new Map(users.map(u => [u.id, u])), [users]);
  const memberNames = useMemo(() => users.map(u => u.username), [users]);
  const usersByName = useMemo(() => {
    const map = new Map<string, typeof users[0]>();
    for (const u of users) {
      const key = u.username.toLowerCase();
      if (!map.has(key)) map.set(key, u);
      if (u.discriminator) map.set(`${key}#${u.discriminator}`, u);
    }
    return map;
  }, [users]);
  const currentUserRole = useMemo(() => {
    if (!currentUser) return null;
    const entry = users.find(u => u.id === currentUser.id);
    return ((entry as UserWithRole | undefined)?.role as string | undefined)?.toLowerCase() ?? null;
  }, [users, currentUser?.id]);
  const pinnedMessageIdsSet = useMemo(() => new Set(pinnedMessageIds), [pinnedMessageIds]);

  const mentionedMsgIds = useMemo(() => {
    if (!currentUser) return new Set<string>();
    const myName = currentUser.username.toLowerCase();
    const myDisc = currentUser.discriminator;
    const myRole = currentUserRole;
    const result = new Set<string>();
    for (const msg of messages) {
      if (!msg.content) continue;
      const lc = msg.content.toLowerCase();
      if (lc.includes('@everyone') || lc.includes('@here')) { result.add(msg.id); continue; }
      if (lc.includes(`@${myName}`) || lc.includes(`@<${myName}>`)) { result.add(msg.id); continue; }
      if (myDisc && lc.includes(`@${myName}#${myDisc}`)) { result.add(msg.id); continue; }
      if (myRole && (lc.includes(`@${myRole}`) || lc.includes(`@<${myRole}>`))) { result.add(msg.id); continue; }
    }
    return result;
  }, [messages, currentUser?.id, currentUser?.username, currentUser?.discriminator, currentUserRole]);

  const decryptedContentMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages) {
      map.set(m.id, m.content);
    }
    return map;
  }, [messages]);

  const getReplyContent = (replyTo: { id: string; content: string }): string => {
    const decrypted = decryptedContentMap.get(replyTo.id);
    if (decrypted !== undefined) return decrypted;
    try {
      const parsed = JSON.parse(replyTo.content);
      if (parsed?._olmE2E || parsed?._megolmE2E || parsed?._groupE2E || (typeof parsed?.type === 'number' && parsed?.body)) {
        return '\u{1F512} Encrypted message';
      }
    } catch { /* not JSON, show as-is */ }
    return replyTo.content;
  };

  const quickReact = useCallback((msgId: string, emoji: string) => {
    onReactMessage?.(msgId, emoji);
    const updated = addRecentEmoji(emoji, currentUserId);
    setRecentReactionEmojis(updated);
    setReactionPickerMsgId(null);
    setReactionFullPickerOpen(false);
    setReactionSubmenuOpen(false);
    setReactionSubmenuPos(null);
  }, [onReactMessage, currentUserId]);

  const openFullReactionPicker = useCallback((msgId: string, anchorEl?: HTMLElement | null) => {
    if (anchorEl) {
      (reactionFullPickerAnchorRef as React.MutableRefObject<HTMLElement | null>).current = anchorEl;
    }
    setReactionPickerMsgId(msgId);
    setReactionFullPickerOpen(true);
    setReactionSubmenuOpen(false);
    setReactionSubmenuPos(null);
    setMessageMenu(null);
  }, []);

  const closeReactionPicker = useCallback(() => {
    setReactionPickerMsgId(null);
    setReactionFullPickerOpen(false);
    setReactionSubmenuOpen(false);
    setReactionSubmenuPos(null);
  }, []);

  const startEditing = useCallback((msg: Message) => {
    if (msg.type === 'system') return;
    setEditingMessageId(msg.id);
    setEditValue(msg.content);
    setMessageMenu(null);
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingMessageId(null);
    setEditValue('');
  }, []);

  const handleEditLastMessage = useCallback(() => {
    if (!currentUserId || !onEditMessage) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.authorId === currentUserId && msg.type !== 'system' && (msg.type as string) !== 'imported') {
        startEditing(msg);
        return;
      }
    }
  }, [messages, currentUserId, onEditMessage, startEditing]);

  const renderInlineToolbar = (msg: Message, _inline: boolean) => {
    if (isMobile || msg.type === 'system' || editingMessageId === msg.id) return null;
    const btn = 'msg-action-btn w-6 h-6 flex items-center justify-center rounded-full hover:bg-fill-hover active:scale-90 transition-all';
    // max-w cap + overflow guard keeps the toolbar from clipping off the right
    // edge of the chat column into the member panel when the message row is
    // narrow / the container's padding is small. The toolbar's natural width
    // is ~200-240px; capping at calc(100% - 1rem) ensures it always sits
    // within its ancestor's paint box.
    return (
      <span
        className={`absolute right-4 -top-3 flex items-center gap-0.5 py-0.5 px-1 rounded-lg z-[var(--z-dropdown)] opacity-0 pointer-events-none group-hover/msg:opacity-100 group-hover/msg:pointer-events-auto transition-opacity duration-100 glass max-w-[calc(100%-1rem)]`}
      >
        {showEmojiReactions && recentReactionEmojis.slice(0, 3).map(emoji => (
          <button key={emoji} type="button" title={emoji} onClick={() => quickReact(msg.id, emoji)} className={`${btn} hover:bg-fill-strong text-xs leading-none`}>{emoji}</button>
        ))}
        {showEmojiReactions && (
          <button type="button" title={t('chat.allReactions')} onClick={(e) => openFullReactionPicker(msg.id, e.currentTarget)} className={`${btn} hover:bg-[var(--cyan-accent)]/20 text-t-secondary`}><Smile size={12} /></button>
        )}
        <div className="w-px h-4 mx-0.5" style={{ backgroundColor: 'var(--glass-border)' }} />
        <button type="button" title={t('chat.reply')} aria-label={t('chat.reply')} onClick={() => setReplyingTo(msg)} className={`${btn} text-t-secondary`}><CornerUpLeft size={12} /></button>
        {!!currentUserId && msg.authorId === currentUserId && onEditMessage && (msg.type as string) !== 'system' && (msg.type as string) !== 'imported' && (
          <button type="button" title={t('chat.editMessage')} aria-label={t('chat.editMessage')} onClick={() => startEditing(msg)} className={`${btn} text-t-secondary`}><Pencil size={12} /></button>
        )}
        {!!currentUserId && (msg.authorId === currentUserId || canDeleteAnyMessage) && onDeleteMessage && (
          <button type="button" title={t('common.delete')} aria-label={t('common.delete')} onClick={() => onDeleteMessage(msg.id)} className={`${btn} hover:bg-red-500/20 text-t-secondary`}><Trash2 size={12} /></button>
        )}
        <button type="button" title={t('common.more')} aria-label={t('common.more')} onClick={(e) => setMessageMenu({ x: e.clientX, y: e.clientY, message: msg })} className={`${btn} text-t-secondary`}><ChevronDown size={12} /></button>
      </span>
    );
  };

  const submitEdit = useCallback(() => {
    if (!editingMessageId) return;
    const trimmed = editValue.trim();
    if (!trimmed) { cancelEditing(); return; }
    onEditMessage?.(editingMessageId, trimmed);
    cancelEditing();
  }, [editingMessageId, editValue, cancelEditing, onEditMessage]);

  // Resolve channels for the active server (used by age gate navigation)
  const activeServerChannels = useMemo(() => {
    if (!activeServerId) return [];
    const server = servers.find((s) => s.id === activeServerId);
    return server?.channels ?? [];
  }, [activeServerId, servers]);

  // Age gate
  // Navigate the user away from the current age-restricted channel. Try the
  // best landing spot first; fall back through wider matches; only resort to
  // browser history when no in-server destination exists. Silently no-oping
  // here would leave the user stuck on the gated channel with no exit.
  const ageGateGoBack = useCallback(() => {
    if (onSelectChannel && activeServerChannels && activeServerChannels.length > 0) {
      const safe = activeServerChannels.find(
        (c) => c.id !== channel.id && !c.ageRestricted && (c.type === 'text' || c.type === 'forum'),
      );
      if (safe) { onSelectChannel(safe.id); return; }
      const anyNonRestricted = activeServerChannels.find(
        (c) => c.id !== channel.id && !c.ageRestricted,
      );
      if (anyNonRestricted) { onSelectChannel(anyNonRestricted.id); return; }
    }
    // Last-resort fallback — leave the gated view via browser history.
    if (typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back();
    }
  }, [onSelectChannel, activeServerChannels, channel]);

  // Scroll: managed by Virtuoso followOutput + firstItemIndex + handleMediaLoad (see scroll section above)

  // Fetch pinned list when pinned panel opens (server, DM, group chat)
  useEffect(() => {
    if (rightPanelMode !== 'pinned' || !getChannelPins || !channel.id) return;
    setPinnedListLoading(true);
    getChannelPins(channel.id)
      .then(setPinnedList)
      .catch(() => setPinnedList([]))
      .finally(() => setPinnedListLoading(false));
  }, [rightPanelMode, getChannelPins, channel.id]);

  // Input-related state and handlers moved to MessageInput component

  // Precompute the message ID that should show the unread divider.
  // Used inside renderMessageItem to avoid per-row index-mapping overhead.
  const firstUnreadMessageId = firstUnreadIndex != null ? messages[firstUnreadIndex]?.id ?? null : null;

  // Plain Virtuoso signature: (absoluteIndex, item). Separator items get their own row;
  // message items render the full message card with grouping, reactions, threads, etc.
  const renderMessageItem = (absoluteIndex: number, item: ChatItem) => {
    // Separator row
    if (item.kind === 'separator') {
      return (
        <div className="flex items-center gap-3 py-2 select-none" aria-hidden>
          <div className="flex-1 h-px" style={{ backgroundColor: 'var(--border-subtle)' }} />
          <span className="text-[10px] font-bold uppercase tracking-wider shrink-0" style={{ color: 'var(--text-secondary)' }}>{item.label}</span>
          <div className="flex-1 h-px" style={{ backgroundColor: 'var(--border-subtle)' }} />
        </div>
      );
    }

    // Message row
    const msg = item.msg;
    // Walk backwards in flatItems to find the previous message (skipping separators).
    const flatIdx = absoluteIndex - firstItemIndex;
    let prevMsg: Message | null = null;
    for (let i = flatIdx - 1; i >= 0; i--) {
      const fi = flatItems[i];
      if (fi?.kind === 'message') { prevMsg = fi.msg; break; }
    }
    // Day boundary is when the previous item in flatItems is a separator (or nothing).
    // We check the actual item before this message in the flat array.
    const prevFlatItem = flatIdx > 0 ? flatItems[flatIdx - 1] : null;
    const isDayBoundary = !prevFlatItem || prevFlatItem.kind === 'separator';
    const GROUP_THRESHOLD_MS = 7 * 60 * 1000;
    const isGrouped = !compactMessages
      && !isDayBoundary
      && prevMsg != null
      && prevMsg.authorId === msg.authorId
      && prevMsg.type !== 'system'
      && msg.type !== 'system'
      && !msg.replyTo
      && !msg.replyToMessageId
      && (new Date(msg.timestamp).getTime() - new Date(prevMsg.timestamp).getTime()) < GROUP_THRESHOLD_MS;
    const isFirstUnread = firstUnreadMessageId != null && msg.id === firstUnreadMessageId;
    const unreadDividerEl = isFirstUnread ? (
      <div className="flex items-center gap-3 py-1.5 select-none" aria-label="New messages">
        <div className="flex-1 h-px" style={{ backgroundColor: 'color-mix(in srgb, var(--danger) 50%, transparent)' }} />
        <span className="text-[10px] font-bold uppercase tracking-wider shrink-0" style={{ color: 'color-mix(in srgb, var(--danger) 80%, transparent)' }}>{t('chat.newMessages')}</span>
        <div className="flex-1 h-px" style={{ backgroundColor: 'color-mix(in srgb, var(--danger) 50%, transparent)' }} />
      </div>
    ) : null;
    const userFromList = resolveMessageAuthor(usersById, users, msg.authorId, currentUser as unknown as User, currentUserId);
    const isImported = msg.type === 'imported';
    const authorName = isImported && msg.systemPayload?.discordAuthor
      ? msg.systemPayload.discordAuthor
      : ((userFromList as any)?.nickname || msg.authorUsername || userFromList?.username || t('common.unknown'));
    if (msg.type === 'system' && msg.systemPayload?.kind === 'event_reminder') {
      const reminderPayload = msg.systemPayload as { eventId: string; eventTitle: string; eventDescription?: string | null; eventStartTime: string; eventEndTime: string; eventColor: string; timing: string; allDay: boolean };
      return (
        <div key={msg.id} style={{ paddingTop: messageGapPx }}>
          {unreadDividerEl}
          <div className={`rounded-2xl px-4 pt-3 pb-2 min-w-0 overflow-visible`}>
            <div className="flex items-start gap-3">
              <div className="rounded-lg shrink-0 flex items-center justify-center" style={{ width: 32, height: 32, backgroundColor: 'var(--accent-subtle)' }}>
                <Calendar size={16} className="text-t-accent" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold text-t-accent">Howl Calendar</span>
                  <span className="text-[9px] font-bold px-1 py-0.5 rounded-lg text-t-accent" style={{ backgroundColor: 'var(--accent-muted)' }}>BOT</span>
                  <span className="text-[10px] ml-1" style={{ color: 'var(--text-tertiary)' }}>
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </span>
                </div>
                <EventReminderEmbed payload={reminderPayload} serverId={activeServerId ?? ''} />
              </div>
            </div>
          </div>
        </div>
      );
    }
    if (msg.type === 'system' && msg.systemPayload?.kind === 'pin') {
      const sysAuthor = usersById.get(msg.authorId);
      const sysPlan = sysAuthor?.effectivePlan || sysAuthor?.stripePlan;
      const sysNameEl = sysPlan === 'pro' && (sysAuthor?.nameColor || sysAuthor?.nameFont || sysAuthor?.nameEffect)
        ? <RoleNameStyle name={authorName} overrideColor={sysAuthor!.nameColor} overrideFont={sysAuthor!.nameFont} nameEffect={sysAuthor!.nameEffect} />
        : null;
      return (
        <div key={msg.id} style={{ paddingTop: messageGapPx }}>
          {unreadDividerEl}
          <div className="flex justify-center py-2">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-panel text-t-secondary">
              <Pin size={12} />
              {sysNameEl ? <>{sysNameEl} {t('chat.pinnedMessage', { author: '' }).replace(/^\s+/, '')}</> : t('chat.pinnedMessage', { author: authorName })}
            </div>
          </div>
        </div>
      );
    }
    if (msg.type === 'system' && (msg.systemPayload?.kind === 'call_started' || msg.systemPayload?.kind === 'call_ended' || msg.systemPayload?.kind === 'call_missed')) {
      const callKind = msg.systemPayload.kind as string;
      const durSec = (msg.systemPayload as Record<string, unknown>)?.durationSeconds as number | undefined;
      const fmtDur = (s: number) => { const m = Math.floor(s / 60); const r = s % 60; return s < 60 ? `${s}s` : r > 0 ? `${m}m ${r}s` : `${m}m`; };
      const isMissed = callKind === 'call_missed';
      const isEnded = callKind === 'call_ended';
      // call_missed system messages are authored by the caller, so the
      // "Missed call from {caller}" wording only makes sense from the
      // recipient's perspective. The caller themselves should see "You
      // called — no answer." instead.
      const isFromMe = msg.authorId === currentUserId;
      const sysAuthor = usersById.get(msg.authorId);
      const sysPlan = sysAuthor?.effectivePlan || sysAuthor?.stripePlan;
      const sysNameEl = sysPlan === 'pro' && (sysAuthor?.nameColor || sysAuthor?.nameFont || sysAuthor?.nameEffect)
        ? <RoleNameStyle name={authorName} overrideColor={sysAuthor!.nameColor} overrideFont={sysAuthor!.nameFont} nameEffect={sysAuthor!.nameEffect} />
        : null;
      const callText = isMissed
        ? (isFromMe
            ? t('chat.callNoAnswer', 'You called. No answer.')
            : (sysNameEl ? <>{t('chat.missedCallFrom', { author: '' }).replace(/^\s+/, '')}</> : t('chat.missedCallFrom', { author: authorName })))
        : isEnded
          ? (durSec != null && durSec > 0 ? t('chat.callEndedDuration', { duration: fmtDur(durSec) }) : t('chat.callEnded'))
          : (sysNameEl ? <>{t('chat.startedCall', { author: '' }).replace(/^\s+/, '')}</> : t('chat.startedCall', { author: authorName }));
      return (
        <div key={msg.id} style={{ paddingTop: messageGapPx }}>
          {unreadDividerEl}
          <div className="flex justify-center py-2">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-panel" style={{ color: isMissed ? 'var(--danger)' : 'var(--text-secondary)' }}>
              {isMissed ? <PhoneOff size={12} /> : <Phone size={12} />}
              {sysNameEl && !isEnded && !(isMissed && isFromMe) ? <>{sysNameEl} {callText}</> : callText}
            </div>
          </div>
        </div>
      );
    }
    // Group membership changes (add / kick) — render as a centered system line
    // with the actor's name styled, matching the pin/call system lines. Without
    // this branch these fell through to the full message renderer and the
    // actor's Pro name customization never showed.
    if (msg.type === 'system' && (msg.systemPayload?.kind === 'member_removed' || msg.systemPayload?.kind === 'members_added')) {
      const sysAuthor = usersById.get(msg.authorId);
      const isOwn = msg.authorId === currentUser?.id;
      const sysPlan = isOwn ? (currentUser?.effectivePlan || currentUser?.stripePlan) : (sysAuthor?.effectivePlan || sysAuthor?.stripePlan || msg.authorStripePlan);
      const sysNameColor = isOwn ? currentUser?.nameColor : (sysAuthor?.nameColor ?? msg.authorNameColor);
      const sysNameFont = isOwn ? currentUser?.nameFont : (sysAuthor?.nameFont ?? msg.authorNameFont);
      const sysNameEffect = isOwn ? currentUser?.nameEffect : (sysAuthor?.nameEffect ?? msg.authorNameEffect);
      // The server builds content as "<actor> <action> … from the group" with
      // the actor's username first; style just that leading name.
      const actorName = msg.authorUsername ?? sysAuthor?.username ?? authorName;
      const styledActor = sysPlan === 'pro' && (sysNameColor || sysNameFont || sysNameEffect);
      const body = msg.content ?? '';
      const restAfterName = styledActor && actorName && body.startsWith(actorName) ? body.slice(actorName.length) : null;
      const MembershipIcon = msg.systemPayload.kind === 'members_added' ? UserPlus : Users;
      return (
        <div key={msg.id} style={{ paddingTop: messageGapPx }}>
          {unreadDividerEl}
          <div className="flex justify-center py-2">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-panel text-t-secondary">
              <MembershipIcon size={12} />
              {restAfterName !== null
                ? <><RoleNameStyle name={actorName} overrideColor={sysNameColor} overrideFont={sysNameFont} nameEffect={sysNameEffect} />{restAfterName}</>
                : body}
            </div>
          </div>
        </div>
      );
    }
    // Gift DM card (kind: 'gift') — only renders in DM context
    if (msg.type === 'system' && msg.systemPayload?.kind === 'gift' && isDM) {
      const giftId = msg.systemPayload.giftId as string | undefined;
      const plan = (msg.systemPayload.plan as string | undefined) ?? 'pro';
      const durationMonths = (msg.systemPayload.durationMonths as number | undefined) ?? 0;
      const claimedAt = msg.systemPayload.claimedAt as string | undefined;
      if (giftId) {
        return (
          <div key={msg.id} style={{ paddingTop: messageGapPx }}>
            {unreadDividerEl}
            <GiftDmCard
              giftId={giftId}
              plan={plan}
              durationMonths={durationMonths}
              claimedAt={claimedAt ?? null}
              senderUsername={msg.authorUsername ?? null}
              senderAvatar={msg.authorAvatar ?? null}
              isRecipient={msg.authorId !== currentUserId}
            />
          </div>
        );
      }
    }
    // Poll system messages
    if (msg.type === 'system' && msg.systemPayload?.kind === 'poll') {
      const pollId = msg.systemPayload.pollId as string;
      const poll = pollsMap[pollId];
      if (poll) {
        return (
          <div key={msg.id} style={{ paddingTop: messageGapPx }}>
            {unreadDividerEl}
            <div className="px-4 py-2">
              <PollEmbed
                poll={poll}
                onVote={onVotePoll ?? (() => {})}
                onRemoveVote={onRemoveVotePoll ?? (() => {})}
                onClose={onClosePoll}
                onDelete={onDeletePoll}
                currentUserId={currentUserId}
                canManage={canDeleteAnyMessage}
                serverId={isDM ? undefined : activeServerId}
                channelId={isDM ? undefined : channel.id}
                dmChannelId={isDM ? channel.id : undefined}
              />
            </div>
          </div>
        );
      }
      // Poll data not loaded yet — show placeholder (will re-render when polls prop updates)
      return (
        <div key={msg.id} style={{ paddingTop: messageGapPx }}>
          {unreadDividerEl}
          <div className="px-4 py-2">
            <div className="rounded-xl border p-4 flex items-center gap-2 bg-panel border-default">
              <BarChart3 size={16} className="text-t-accent" />
              <span className="text-sm text-t-secondary">{t('chat.pollRemoved')}</span>
            </div>
          </div>
        </div>
      );
    }

    const displayAvatar = isImported && msg.systemPayload?.discordAuthorAvatar
      ? msg.systemPayload.discordAuthorAvatar
      : ((userFromList as any)?.serverAvatar || ((msg.authorAvatar != null && msg.authorAvatar !== '') ? msg.authorAvatar : (userFromList?.avatar ?? null)));
    const isBot = userFromList?.isBot ?? false;
    const authorUser: UserWithRole = {
      id: msg.authorId,
      username: msg.authorUsername ?? userFromList?.username ?? t('common.unknown'),
      discriminator: msg.authorDiscriminator ?? userFromList?.discriminator,
      avatar: displayAvatar,
      banner: userFromList?.banner ?? undefined,
      nickname: (userFromList as any)?.nickname ?? undefined,
      serverAvatar: (userFromList as any)?.serverAvatar ?? undefined,
      serverBanner: (userFromList as any)?.serverBanner ?? undefined,
      status: (userFromList?.status as User['status']) ?? 'offline',
      roleColor: msg.authorRoleColor ?? (userFromList as UserWithRole)?.roleColor ?? undefined,
      roleStyle: (msg.authorRoleStyle as UserWithRole['roleStyle']) ?? (userFromList as UserWithRole)?.roleStyle ?? 'solid',
      role: (userFromList as UserWithRole)?.role,
    };
    const _roleColor = roleColorMode === 'hidden' ? undefined : (msg.authorRoleColor ?? undefined);
    const isOwnMessage = msg.authorId === currentUser?.id;
    const effectiveStripePlan = isOwnMessage ? (currentUser?.effectivePlan || currentUser?.stripePlan || msg.authorStripePlan) : msg.authorStripePlan;
    const effectiveNameColor = isOwnMessage ? currentUser?.nameColor : msg.authorNameColor;
    const effectiveNameFont = isOwnMessage ? currentUser?.nameFont : msg.authorNameFont;
    const effectiveNameEffect = isOwnMessage ? currentUser?.nameEffect : msg.authorNameEffect;
    const effectiveAvatarEffect = isOwnMessage ? currentUser?.avatarEffect : msg.authorAvatarEffect;
    // Username sizing — `text-base` (16px) on default/spacious density to match
    // Discord. Compact density keeps text-sm (14px) for tighter rows. The
    // timestamp span next to the name is text-xs (12px), so the name now reads
    // as the dominant element on the row instead of looking smaller than the
    // adjacent timestamp.
    const nameClassSize = d === 'compact' ? 'text-sm' : 'text-base';
    const nameEl = isBot ? (
      <span className={`${nameClassSize} font-semibold text-violet-400`}>{authorName}</span>
    ) : roleColorMode === 'next-to-names' ? (
      <span className={`${nameClassSize} font-semibold inline-flex items-center gap-1.5 text-t-primary`}>
        {msg.authorRoleColor && <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: isValidCssColor(msg.authorRoleColor) ? msg.authorRoleColor : undefined }} />}
        {authorName}
      </span>
    ) : (
      <RoleNameStyle name={authorName} color={_roleColor} style={msg.authorRoleStyle ?? 'solid'} className={`${nameClassSize} font-semibold`} overrideColor={effectiveStripePlan === 'pro' ? effectiveNameColor : undefined} overrideFont={effectiveStripePlan === 'pro' ? effectiveNameFont : undefined} nameEffect={effectiveStripePlan === 'pro' ? effectiveNameEffect : undefined} />
    );
    const wrap = onUserClick || onUserRightClick;
    const isPinned = pinnedMessageIdsSet.has(msg.id);
    const isMentioned = mentionedMsgIds.has(msg.id);
    const lpHandlers = longPressBindings((e) => { e.preventDefault(); setMessageMenu({ x: e.clientX, y: e.clientY, message: msg }); });
    const isRegularMessage = (msg.type as string) !== 'system' && (msg.type as string) !== 'imported';
    const dtHandlers = isMobile && isRegularMessage && onReactMessage
      ? doubleTapBindings(() => {
          lastDoubleTapReactRef.current = msg.id;
          quickReact(msg.id, '👍');
          setTimeout(() => { lastDoubleTapReactRef.current = null; }, 400);
        }, msg.id)
      : null;
    const mobileTouchHandlers = isMobile && isRegularMessage ? {
      onTouchStart: lpHandlers.onTouchStart,
      onTouchMove: lpHandlers.onTouchMove,
      onTouchEnd: (e: React.TouchEvent) => {
        lpHandlers.onTouchEnd(e);
        dtHandlers?.onTouchEnd(e);
      },
      onContextMenu: lpHandlers.onContextMenu,
    } : undefined;

    const isFlashed = flashedMessageId === msg.id;
    const messageRowEl = (
      <div
        data-msg-id={msg.id}
        className={`relative group/msg ${isFlashed ? 'message-flash' : ''} ${compactMessages
          ? `rounded-lg px-2 py-1 min-w-0 overflow-visible ${isMentioned ? '' : 'hover:bg-fill-hover'}`
          : `rounded-2xl px-4 ${isGrouped ? 'py-1' : 'py-1.5'} min-w-0 overflow-visible transition-colors duration-150 ${isMentioned ? '' : 'hover:bg-fill-hover'}`
        }`}
        {...(isMobile && isRegularMessage ? {} : lpHandlers)}
        style={{
          contain: 'layout style',
          ...(isFlashed ? ({ ['--mention-flash-rgb' as any]: mentionRgb } as React.CSSProperties) : {}),
          ...(isMentioned ? {
            backgroundColor: `rgba(${mentionRgb}, 0.07)`,
            borderRadius: 0,
          } : {}),
        }}
      >
        {isMentioned && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: '2px',
              background: `rgba(${mentionRgb}, 0.6)`,
              boxShadow: `0 0 8px rgba(${mentionRgb}, 0.25), 2px 0 12px rgba(${mentionRgb}, 0.1)`,
              pointerEvents: 'none',
            }}
          />
        )}
        <div className={`flex min-w-0 ${compactMessages ? 'items-baseline gap-2 flex-wrap' : 'items-start gap-3'}`}>
          {!compactMessages && (isGrouped ? (
            // Hover-only timestamp on grouped messages. The slot's height is
            // locked to ONE chat line (`--chat-font-size` × `--chat-line-height`
            // — 24px on default density) so `flex items-center` puts the
            // timestamp's vertical center on the same y as the first line of
            // message text in the sibling column. The message `<p>` no longer
            // carries an mt-1, so neither does the slot — both children of the
            // items-start flex row start at row top, centering against the
            // same line.
            <div
              className={`${avatarSlotWidthClass} shrink-0 flex items-center justify-center opacity-0 group-hover/msg:opacity-100 transition-opacity select-none`}
              style={{ minHeight: 'calc(var(--chat-font-size) * var(--chat-line-height))' }}
            >
              <span className="text-[11px] font-medium whitespace-nowrap tabular-nums text-t-secondary" style={{ lineHeight: 1 }}>
                {formatTs(msg.timestamp)}
              </span>
            </div>
          ) : (
            <div className={`rounded-[var(--radius-lg)] shrink-0 ${effectiveStripePlan === 'pro' && effectiveAvatarEffect ? getAvatarEffectClass(effectiveAvatarEffect) : ''}`}>
              <LetterAvatar avatar={displayAvatar} username={authorName} size={avatarSizePx} className="rounded-[var(--radius-lg)]" />
            </div>
          ))}
          <div className="flex-1 min-w-0 overflow-hidden">
            {msg.replyTo && (
              <div className="flex items-center gap-1.5 mb-0.5 pl-2 py-0.5 border-l-2 rounded-lg border-[var(--cyan-accent)] min-w-0 text-xs" style={{ opacity: 0.9 }}>
                {(() => {
                  const replyAuthor = usersById.get(msg.replyTo!.authorId);
                  const replyPlan = replyAuthor?.effectivePlan || replyAuthor?.stripePlan;
                  const replyName = msg.replyTo!.authorUsername ?? t('common.unknown');
                  return replyPlan === 'pro' && (replyAuthor?.nameColor || replyAuthor?.nameFont || replyAuthor?.nameEffect)
                    ? <RoleNameStyle name={replyName} className="text-xs font-semibold shrink-0 truncate max-w-[30%]" overrideColor={replyAuthor!.nameColor} overrideFont={replyAuthor!.nameFont} nameEffect={replyAuthor!.nameEffect} />
                    : <span className="text-xs font-semibold text-t-accent shrink-0 truncate max-w-[30%]">{replyName}</span>;
                })()}
                <span className="truncate text-t-secondary min-w-0 flex-1">
                  {getReplyContent(msg.replyTo)}
                </span>
              </div>
            )}
            {!msg.replyTo && msg.replyToMessageId && (
              <div className="flex items-center gap-1.5 mb-0.5 pl-2 py-0.5 border-l-2 rounded-lg border-[var(--text-secondary)] min-w-0 text-xs" style={{ opacity: 0.6 }}>
                <span className="italic text-t-secondary truncate">{t('chat.originalMessageDeleted', 'Original message was deleted')}</span>
              </div>
            )}
            {editingMessageId === msg.id ? (
              <div className="flex items-start gap-2 my-1">
                <LexicalEditEditor
                  ref={editInputRef}
                  initialValue={editValue}
                  onSave={(text) => {
                    if (!text) { cancelEditing(); return; }
                    onEditMessage?.(editingMessageId, text);
                    cancelEditing();
                  }}
                  onCancel={cancelEditing}
                  onChange={(text) => setEditValue(text)}
                  className="flex-1 rounded-lg px-3 py-1.5 text-sm border border-[var(--glass-border)] bg-fill-hover outline-none focus-within:border-[var(--cyan-accent)]/50 transition-colors text-t-primary"
                />
                <button type="button" onClick={submitEdit} className="p-1.5 rounded-md hover:bg-[var(--cyan-accent)]/20 transition-colors shrink-0 text-t-accent" title={t('common.save')}><Check size={16} /></button>
                <button type="button" onClick={cancelEditing} className="p-1.5 rounded-md hover:bg-red-500/20 transition-colors shrink-0 text-t-secondary" title={t('common.cancel')}><X size={16} /></button>
              </div>
            ) : compactMessages ? (
              <>
                {renderInlineToolbar(msg, false)}
                <div className="flex items-baseline gap-2 flex-wrap min-w-0">
                  {wrap && !isBot ? (
                    <button type="button" onClick={(e) => onUserClick?.(authorUser, e)} {...longPressBindings((e) => { e.preventDefault(); onUserRightClick?.(authorUser, e); })} className="hover:underline focus:outline-none rounded-lg shrink-0">
                      {nameEl}
                    </button>
                  ) : (
                    <span className="shrink-0">{nameEl}</span>
                  )}
                  <span className="text-[11px] shrink-0 text-t-secondary">
                    {formatTs(msg.timestamp)}
                  </span>
                  {isImported && <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0" style={{ backgroundColor: 'rgba(88,101,242,0.15)', color: '#7289da' }}>{t('chat.discordImport')}</span>}
                  <span className="min-w-0 break-words whitespace-pre-wrap inline text-t-primary" style={{ overflowWrap: 'anywhere', fontSize: 'var(--chat-font-size)', lineHeight: 'var(--chat-line-height)' }}>
                    {msg.attachmentUrl && msg.content === '(attachment)' ? null : <MentionText content={msg.content} messageId={msg.id} authorPlan={msg.authorStripePlan} memberNames={memberNames} showEmbeds={showEmbeds} onMentionClick={handleMentionClick} usersByName={usersByName} servers={servers} onJoinServer={onJoinInvite} onViewServer={onViewServer} />}
                  </span>
                  {msg.editedAt && <span className="text-[10px] opacity-60 shrink-0 italic" title={t('chat.editedAt', { date: new Date(msg.editedAt).toLocaleString() })}>{t('chat.edited')}</span>}
                  {isPinned && <Pin size={12} className="shrink-0 opacity-50 inline" aria-label={t('chat.pinned')} />}
                </div>
                {msg.forwarded && (
                  <div className="flex items-center gap-1.5 mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                    <CornerUpRight size={12} className="shrink-0 opacity-80" />
                    <span className="text-[10px] italic">{t('chat.forwarded')}</span>
                  </div>
                )}
                {msg.attachmentUrl && (
                  <div className="mt-1">
                    <MessageAttachment attachmentUrl={msg.attachmentUrl} attachmentName={msg.attachmentName} attachmentContentType={msg.attachmentContentType} attachmentSize={msg.attachmentSize} attachmentWidth={msg.attachmentWidth} attachmentHeight={msg.attachmentHeight} getToken={getToken} onForward={onForwardImage} hideImages={!showImagesUploaded} showAltText={showImageDesc} isSticker={!!msg.attachmentUrl && (msg.attachmentUrl.includes('/stickers/') || (msg.content === msg.attachmentName?.replace(/\.png$/, '')))} encryptedFileKey={msg._encryptedFileKey} onImageLoad={handleMediaLoad} isSpoiler={!!(msg.attachmentIsSpoiler)} messageId={msg.id} altText={msg.attachmentAlt} />
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="flex items-baseline gap-2 flex-wrap mb-1" style={{ display: isGrouped ? 'none' : undefined }}>
                  {wrap && !isBot ? (
                    <button type="button" onClick={(e) => onUserClick?.(authorUser, e)} {...longPressBindings((e) => { e.preventDefault(); onUserRightClick?.(authorUser, e); })} className="hover:underline focus:outline-none rounded-lg">
                      {nameEl}
                    </button>
                  ) : (
                    <span>{nameEl}</span>
                  )}
                  <span className="text-[11px] text-t-secondary">
                    {formatHeaderTs(msg.timestamp)}
                  </span>
                  {isImported && <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ backgroundColor: 'rgba(88,101,242,0.15)', color: '#7289da' }}>{t('chat.discordImport')}</span>}
                </div>
                {msg.forwarded && (
                  <div className="flex items-center gap-1.5 mt-0.5 mb-0.5" style={{ color: 'var(--text-tertiary)' }}>
                    <CornerUpRight size={14} className="shrink-0 opacity-80" />
                    <span className="text-xs italic">{t('chat.forwarded')}</span>
                  </div>
                )}
                {renderInlineToolbar(msg, false)}
                <p className={`min-w-0 text-t-primary ${msg.forwarded ? 'pl-3 border-l-2 border-default' : ''}`} style={{ fontSize: 'var(--chat-font-size)', lineHeight: 'var(--chat-line-height)' }}>
                  <span className="min-w-0 break-words whitespace-pre-wrap" style={{ overflowWrap: 'anywhere' }}>{msg.attachmentUrl && msg.content === '(attachment)' ? null : <MentionText content={msg.content} messageId={msg.id} authorPlan={msg.authorStripePlan} memberNames={memberNames} showEmbeds={showEmbeds} onMentionClick={handleMentionClick} usersByName={usersByName} servers={servers} onJoinServer={onJoinInvite} onViewServer={onViewServer} />}</span>
                  {msg.editedAt && <span className="text-[10px] opacity-60 shrink-0 italic ml-1" title={t('chat.editedAt', { date: new Date(msg.editedAt).toLocaleString() })}>{t('chat.edited')}</span>}
                  {isPinned && <Pin size={12} className="shrink-0 opacity-50 inline ml-1" aria-label={t('chat.pinned')} />}
                </p>
                {msg.attachmentUrl && (
                  <MessageAttachment attachmentUrl={msg.attachmentUrl} attachmentName={msg.attachmentName} attachmentContentType={msg.attachmentContentType} attachmentSize={msg.attachmentSize} attachmentWidth={msg.attachmentWidth} attachmentHeight={msg.attachmentHeight} getToken={getToken} onForward={onForwardImage} hideImages={!showImagesUploaded} showAltText={showImageDesc} encryptedFileKey={msg._encryptedFileKey} onImageLoad={handleMediaLoad} isSpoiler={!!(msg.attachmentIsSpoiler)} messageId={msg.id} altText={msg.attachmentAlt} />
                )}
              </>
            )}
            {msg.reactions && msg.reactions.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {msg.reactions.map(r => {
                  const isMine = !!currentUserId && r.userIds.includes(currentUserId);
                  return (
                    <button
                      key={r.emoji}
                      type="button"
                      onClick={() => onReactMessage?.(msg.id, r.emoji)}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-colors ${
                        isMine
                          ? 'bg-[var(--cyan-accent)]/15 border-[var(--cyan-accent)]/40 text-[var(--cyan-accent)]'
                          : 'bg-fill-hover border-[var(--glass-border)] hover:bg-fill-active'
                      } ${lastDoubleTapReactRef.current === msg.id && r.emoji === '👍' ? 'reaction-pop' : ''}`}
                      style={{ color: isMine ? undefined : 'var(--text-secondary)' }}
                      title={`${r.userIds.length} ${r.userIds.length === 1 ? 'reaction' : 'reactions'}`}
                    >
                      <span>{r.emoji}</span>
                      <span className="font-medium">{r.userIds.length}</span>
                    </button>
                  );
                })}
                {showEmojiReactions && (
                  <button
                    type="button"
                    onClick={(e) => openFullReactionPicker(msg.id, e.currentTarget)}
                    className="inline-flex items-center justify-center w-7 h-7 rounded-full border border-[var(--glass-border)] hover:bg-fill-active transition-colors text-t-secondary"
                    title={t('chat.addReaction')}
                  >
                    <Smile size={12} />
                  </button>
                )}
              </div>
            )}
          {threadsByMessage[msg.id] && onOpenThread && (
            <ThreadBar thread={threadsByMessage[msg.id]} onClick={() => onOpenThread(threadsByMessage[msg.id])} />
          )}
          </div>
        </div>
      </div>
    );

    return (
      <div key={msg.id} style={{ paddingTop: isGrouped ? (isMentioned ? 0 : 1) : messageGapPx }}>
        {unreadDividerEl}
        {isMobile && isRegularMessage ? (
          <SwipeableMessageRow
            onReply={() => setReplyingTo(msg)}
            existingTouchHandlers={mobileTouchHandlers}
          >
            {messageRowEl}
          </SwipeableMessageRow>
        ) : messageRowEl}
      </div>
    );
  };

  const renderMessageMenuPortal = () => {
    if (!messageMenu) return null;
    const msg = messageMenu.message;
    const isOwn = !!currentUserId && msg.authorId === currentUserId;
    const showEdit = isOwn && onEditMessage && msg.type !== 'system' && msg.type !== 'imported';
    const showDelete = !!currentUserId && (isOwn || canDeleteAnyMessage) && onDeleteMessage;
    const showReport = !!currentUserId && !isOwn && onReportMessage;
    const isPinnedMsg = pinnedMessageIdsSet.has(msg.id);
    const btn = 'w-full px-4 py-2.5 text-left text-sm rounded-lg hover:bg-fill-active flex items-center gap-2';
    const { left: menuLeft, top: menuTop } = getMessageMenuPosition(messageMenu.x, messageMenu.y);
    return createPortal(
      <>
        <div className="fixed inset-0 z-[var(--z-popover)]" onClick={() => setMessageMenu(null)} aria-hidden />
        <div className="fixed z-[var(--z-popover)] py-2 min-w-[200px] rounded-2xl border shadow-2xl spring-pop-in backdrop-blur-xl" style={{ left: menuLeft, top: menuTop, backgroundColor: 'var(--glass-bg)', borderColor: 'var(--glass-border)', boxShadow: '0 0 0 1px var(--border-subtle) inset, 0 25px 50px -12px rgba(0,0,0,0.4)', backdropFilter: 'blur(24px) saturate(1.4)', WebkitBackdropFilter: 'blur(24px) saturate(1.4)' }}>
          {showEmojiReactions && <div className="relative" onMouseEnter={(e) => { const rect = e.currentTarget.getBoundingClientRect(); setReactionSubmenuOpen(true); setReactionSubmenuPos(getSubmenuPosition(rect, 220, 380)); }} onMouseLeave={() => { setReactionSubmenuOpen(false); setReactionSubmenuPos(null); }}>
            <button type="button" className={`${btn} text-t-primary`} onClick={(e) => { const rect = e.currentTarget.parentElement!.getBoundingClientRect(); setReactionSubmenuOpen(prev => !prev); if (!reactionSubmenuOpen) setReactionSubmenuPos(getSubmenuPosition(rect, 220, 380)); }}><Smile size={16} /> {t('chat.addReaction')} <ChevronRight size={14} className="ml-auto opacity-60" /></button>
            {reactionSubmenuOpen && reactionSubmenuPos && createPortal(
              <div
                className={`fixed z-[var(--z-popover)] py-1.5 glass ${GLASS_MENU_CLASS}`}
                style={{ left: reactionSubmenuPos.left, top: reactionSubmenuPos.top, minWidth: 210 }}
                onMouseEnter={() => setReactionSubmenuOpen(true)}
                onMouseLeave={() => { setReactionSubmenuOpen(false); setReactionSubmenuPos(null); }}
              >
                {(recentReactionEmojis.length > 0 ? recentReactionEmojis.slice(0, 10) : ['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F44F}', '\u{1F525}', '\u{1F389}', '\u{1F60D}', '\u{1F914}']).map(emoji => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => { quickReact(msg.id, emoji); setMessageMenu(null); }}
                    className="flex items-center gap-3 w-full px-3 py-1 rounded-lg hover:bg-fill-active transition-colors text-left"
                  >
                    <span className="text-xs font-medium truncate flex-1 text-t-secondary">{emojiShortcode(emoji)}</span>
                    <img src={getTwemojiUrl(emoji)} alt={emoji} className="w-5 h-5 flex-shrink-0" draggable={false} loading="lazy" decoding="async" width={20} height={20} />
                  </button>
                ))}
                <div className="h-px my-1 mx-2" style={{ backgroundColor: 'var(--glass-border)' }} />
                <button
                  type="button"
                  onClick={(e) => { const el = document.querySelector(`[data-msg-id="${CSS.escape(msg.id)}"]`) as HTMLElement | null; setMessageMenu(null); setReactionSubmenuOpen(false); setReactionSubmenuPos(null); openFullReactionPicker(msg.id, el ?? e.currentTarget); }}
                  className="flex items-center gap-3 w-full px-3 py-1 rounded-lg hover:bg-fill-active transition-colors text-left text-t-secondary"
                >
                  <span className="text-xs font-medium flex-1">{t('chat.viewMore')}</span>
                  <Smile size={18} className="flex-shrink-0 opacity-60" />
                </button>
              </div>,
              document.body
            )}
          </div>}
          <button type="button" onClick={() => { setReplyingTo(msg); setMessageMenu(null); }} className={`${btn} text-t-primary`}><CornerUpLeft size={16} /> {t('chat.reply')}</button>
          {showEdit && <button type="button" onClick={() => startEditing(msg)} className={`${btn} text-t-primary`}><Pencil size={16} /> {t('chat.editMessage')}</button>}
          <button type="button" onClick={() => { const attachment = msg.attachmentUrl ? { url: msg.attachmentUrl, name: msg.attachmentName ?? 'file', contentType: msg.attachmentContentType ?? undefined } : undefined; const text = msg.content && msg.content !== '(attachment)' ? msg.content : undefined; if (attachment || text) onForwardMessage?.({ attachment, text }); setMessageMenu(null); }} className={`${btn} text-t-primary`}><CornerUpRight size={16} /> {t('chat.forward')}</button>
          <button type="button" onClick={() => { onCreateThread?.(msg.id, msg.content); setMessageMenu(null); }} className={`${btn} text-t-primary`}><MessageCirclePlus size={16} /> {t('chat.createThread')}</button>
          <div className="h-px my-1 bg-[var(--border-subtle)]" />
          <button type="button" onClick={() => { navigator.clipboard?.writeText(msg.content); setMessageMenu(null); }} className={`${btn} text-t-primary`}><Copy size={16} /> {t('chat.copyText')}</button>
          {msg.attachmentUrl && !msg._encryptedFileKey && typeof navigator.clipboard?.write === 'function' && (msg.attachmentContentType?.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|avif)(?:\?|$)/i.test(msg.attachmentUrl)) && (
            <button type="button" onClick={async () => { await copyImageToClipboard(msg.attachmentUrl!); setMessageMenu(null); }} className={`${btn} text-t-primary`}><Copy size={16} /> {t('chat.copyImage')}</button>
          )}
          {isPinnedMsg
            ? <button type="button" onClick={() => { onUnpinMessage?.(msg.id); setMessageMenu(null); }} className={`${btn} text-t-primary`}><Pin size={16} /> {t('chat.unpinMessage')}</button>
            : <button type="button" onClick={() => { onPinMessage?.(msg.id); setMessageMenu(null); }} className={`${btn} text-t-primary`}><Pin size={16} /> {t('chat.pinMessage')}</button>
          }
          <button type="button" onClick={() => { onMarkUnread?.(msg.timestamp instanceof Date ? msg.timestamp.toISOString() : String(msg.timestamp), channel.id); setMessageMenu(null); }} className={`${btn} text-t-primary`}><MessageCirclePlus size={16} /> {t('chat.markUnread')}</button>
          <button type="button" onClick={() => { const url = `${getWebOrigin()}${window.location.pathname}#${msg.id}`; navigator.clipboard?.writeText(url); setMessageMenu(null); }} className={`${btn} text-t-primary`}><Link2 size={16} /> {t('chat.copyMessageLink')}</button>
          <button type="button" onClick={() => { if (msg.content && msg.content !== '(attachment)' && typeof speechSynthesis !== 'undefined') { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(msg.content); u.rate = ttsRate / 100; speechSynthesis.speak(u); } setMessageMenu(null); }} className={`${btn} text-t-primary`}><Volume2 size={16} /> {t('chat.speakMessage')}</button>
          {(showDelete || showReport) && (
            <>
              <div className="h-px my-1 bg-[var(--border-subtle)]" />
              {showDelete && <button type="button" onClick={() => { onDeleteMessage?.(msg.id); setMessageMenu(null); }} className={btn} style={{ color: 'var(--danger)' }}><Trash2 size={16} /> {t('chat.deleteMessage')}</button>}
              {showReport && <button type="button" onClick={() => { onReportMessage?.(msg.id); setMessageMenu(null); }} className={btn} style={{ color: 'var(--danger)' }}><Flag size={16} /> {t('chat.reportMessage')}</button>}
            </>
          )}
        </div>
      </>,
      document.body
    );
  };

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!uploadFile) return;
    if (!e.dataTransfer.types.includes('Files')) return;
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDraggingFile(true);
  }, [uploadFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!uploadFile) return;
    e.dataTransfer.dropEffect = 'copy';
  }, [uploadFile]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDraggingFile(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDraggingFile(false);
    if (!uploadFile) return;
    const file = e.dataTransfer.files?.[0];
    if (!file || file.size === 0) return;
    messageInputRef.current?.attachFile(file);
  }, [uploadFile]);

  return (
    <div ref={chatContainerRef} className="flex-1 flex flex-col min-h-0 min-w-0 relative overflow-hidden overscroll-none" style={{ contain: 'layout style', backgroundColor: 'var(--bg-chat)' }} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {/* DM / Group DM header -- floating glass bubble, matching server sub-header style */}
      {isDMHeader && (
        <div className="flex items-center shrink-0 relative z-20" style={{ display: hideHeader ? 'none' : undefined, paddingTop: d === 'compact' ? 10 : d === 'spacious' ? 18 : 14, paddingBottom: d === 'compact' ? 2 : d === 'spacious' ? 4 : 3, paddingLeft: d === 'compact' ? 12 : d === 'spacious' ? 20 : 16, paddingRight: d === 'compact' ? 12 : d === 'spacious' ? 20 : 16 }}>
          <div
            className={`rounded-2xl flex items-center ${headerGap} transition-colors duration-200 flex-1 min-w-0`}
            style={{
              backgroundColor: 'var(--bg-chat)',
              backdropFilter: 'blur(24px) saturate(1.1)',
              WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
              border: '2px solid var(--border-subtle)',
              boxShadow: '0 4px 6px -1px rgba(0,0,0,0.12), 0 24px 48px -12px rgba(0,0,0,0.2)',
              padding: d === 'compact' ? '8px 12px' : d === 'spacious' ? '12px 16px' : '10px 14px',
            } as React.CSSProperties}
          >
            {headerGroup ? (
              <button type="button" onClick={onGroupHeaderClick} className={`w-9 h-9 overflow-hidden shrink-0 flex items-center justify-center rounded-[var(--radius-lg)] focus:outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/40 ${headerGroup.icon ? 'border border-[var(--glass-border)]' : ''}`} style={headerGroup.icon ? { backgroundColor: 'var(--fill-active)' } : undefined}>
                {headerGroup.icon ? (
                  <LazyGif src={sanitizeImgSrc(headerGroup.icon)} frameSrc={getFrameUrl(headerGroup.icon)} alt="" className="w-full h-full object-cover" />
                ) : (
                  <GroupAvatarComposite
                    members={users.slice(0, 4).map(u => ({ avatar: u.avatar, username: u.username }))}
                    size={36}
                  />
                )}
              </button>
            ) : headerUser ? (
              <UserAvatar user={headerUser} size={36} shape="squircle" />
            ) : null}
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="text-[15px] font-semibold tracking-tight capitalize truncate text-t-primary">
                {headerGroup && onGroupHeaderClick ? (
                  <button type="button" onClick={onGroupHeaderClick} className="hover:opacity-80 focus:outline-none">{channel.name}</button>
                ) : headerUser && (onUserClick || onUserRightClick) ? (
                  <button type="button" onClick={(e) => onUserClick?.(headerUser, e)} {...longPressBindings((e) => { e.preventDefault(); onUserRightClick?.(headerUser, e); })} className="hover:opacity-80 focus:outline-none">{(() => {
                    const plan = headerUser.effectivePlan || headerUser.stripePlan;
                    return plan === 'pro' && (headerUser.nameColor || headerUser.nameFont || headerUser.nameEffect)
                      ? <RoleNameStyle name={channel.name} overrideColor={headerUser.nameColor} overrideFont={headerUser.nameFont} nameEffect={headerUser.nameEffect} />
                      : channel.name;
                  })()}</button>
                ) : channel.name}
              </span>
            </div>
            <div className="flex items-center gap-0.5 shrink-0" style={headerActionsRightPad ? { paddingRight: headerActionsRightPad } : undefined}>
              {onVoiceCall && (callBlockedReason
                ? <button type="button" disabled className="p-2 rounded-lg text-t-secondary opacity-40 cursor-not-allowed" title={callBlockedReason} aria-label={callBlockedReason}><Phone size={17} /></button>
                : <button type="button" onClick={onVoiceCall} className="p-2 rounded-lg hover:bg-fill-active transition-colors text-t-secondary" title={t('chat.voiceCall')} aria-label={t('chat.voiceCall')}><Phone size={17} /></button>)}
              {onVideoCall && (callBlockedReason
                ? <button type="button" disabled className="p-2 rounded-lg text-t-secondary opacity-40 cursor-not-allowed" title={callBlockedReason} aria-label={callBlockedReason}><Video size={17} /></button>
                : <button type="button" onClick={onVideoCall} className="p-2 rounded-lg hover:bg-fill-active transition-colors text-t-secondary" title={t('chat.videoCall')} aria-label={t('chat.videoCall')}><Video size={17} /></button>)}
              {getChannelPins && (
                <button type="button" onClick={() => setRightPanelMode(prev => prev === 'pinned' ? null : 'pinned')} className="relative p-2 rounded-lg hover:bg-fill-active transition-colors" style={{ color: rightPanelMode === 'pinned' ? 'var(--cyan-accent)' : 'var(--text-secondary)' }} title={t('chat.pinnedMessages')} aria-label={t('chat.pinnedMessages')} aria-expanded={rightPanelMode === 'pinned'}>
                  <Pin size={17} />
                  {pinnedMessageIds.length > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-[var(--cyan-accent)] text-black text-[9px] font-bold px-0.5">{pinnedMessageIds.length > 99 ? '99+' : pinnedMessageIds.length}</span>}
                </button>
              )}
              <button type="button" onClick={() => setRightPanelMode(prev => prev === 'search' ? null : 'search')} className="p-2 rounded-lg hover:bg-fill-active transition-colors" style={{ color: rightPanelMode === 'search' ? 'var(--cyan-accent)' : 'var(--text-secondary)' }} title={`${t('search.placeholder', 'Search messages')} (Ctrl+K)`} aria-label={t('search.placeholder', 'Search messages')} aria-expanded={rightPanelMode === 'search'}>
                <Search size={17} />
              </button>
              {headerUser && !headerGroup && !offTheRecordActive && recoverabilityState && (
                <DmRecoverabilityIndicator
                  state={recoverabilityState}
                  peerName={headerUser.username}
                  onGoOtr={onToggleOffTheRecord ?? (() => {})}
                  onOpenRecoverySettings={onOpenRecoverySettings ?? (() => {})}
                />
              )}
              {headerUser && !headerGroup && otrEligible && onToggleOffTheRecord && (
                <OtrFacedIndicator active={!!offTheRecordActive} onToggle={onToggleOffTheRecord} />
              )}
              {headerUser && !headerGroup && onProfilePanelToggle && (
                <button
                  type="button"
                  onClick={onProfilePanelToggle}
                  className="p-2 rounded-lg hover:bg-fill-active transition-colors"
                  style={{ color: profilePanelOpen ? 'var(--cyan-accent)' : 'var(--text-secondary)' }}
                  title={t('chat.profilePanel', 'Profile')}
                  aria-label={t('chat.profilePanel', 'Profile')}
                  aria-expanded={profilePanelOpen}
                >
                  <PanelRight size={17} />
                </button>
              )}
              {onAddFriendsToDm && <button type="button" onClick={onAddFriendsToDm} className="p-2 rounded-lg hover:bg-fill-active transition-colors text-t-secondary" title={t('chat.addFriends')} aria-label={t('chat.addFriends')}><UserPlus size={17} /></button>}
              {headerGroup && onGroupMembersColumnToggle && (
                <button
                  type="button"
                  onClick={onGroupMembersColumnToggle}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-sm font-medium transition-colors shrink-0 text-t-primary ${groupMembersColumnOpen ? 'bg-fill-active' : 'bg-transparent hover:bg-fill-hover'}`}
                  title={t('chat.members')}
                >
                  <Users size={15} />
                  <span className="text-[11px] font-semibold tabular-nums" style={{ opacity: 0.7 }}>{groupMembersCount}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {topBanner && (
        <div className={chatHidden ? 'flex-1 min-h-0 flex flex-col' : 'shrink-0'}>
          {topBanner}
        </div>
      )}

      {!chatHidden && blockBanner && (
        <div className="px-5 py-2 border-b shrink-0 border-default" style={{ backgroundColor: 'var(--warning-subtle)' }}>
          <p className="text-sm text-amber-500/90">{blockBanner}</p>
        </div>
      )}

      {/* Main content: server view with sub-header, or DM view */}
      {!chatHidden && (!isDM && showServerNotificationStrip ? (
        <div className="flex-1 flex min-h-0 min-w-0 items-stretch relative">
        {/* Content column: sub-header + chat */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0 relative">
        {/* Server text channel header — sits absolute over the chat with
            ml-auto actions on the right. The Classic top-right action bubble
            (z-20, AppLayout) lands at the same position when members closed,
            so headerActionsRightPad shifts pin/search left to clear it. */}
        <div className="flex items-center justify-between absolute top-0 left-0 right-0 z-20 pointer-events-none" style={{ display: hideHeader ? 'none' : undefined, paddingTop: d === 'compact' ? 10 : d === 'spacious' ? 18 : 14, paddingBottom: d === 'compact' ? 2 : d === 'spacious' ? 4 : 3, paddingLeft: d === 'compact' ? 12 : d === 'spacious' ? 20 : 16, paddingRight: d === 'compact' ? 12 : d === 'spacious' ? 20 : 16 }}>
          <div className="flex items-center gap-0.5 shrink-0 pointer-events-auto ml-auto" style={headerActionsRightPad ? { paddingRight: headerActionsRightPad } : undefined}>
            {getChannelPins && (
              <button type="button" onClick={() => setRightPanelMode(prev => prev === 'pinned' ? null : 'pinned')} className="relative p-1.5 rounded-lg hover:bg-fill-active transition-colors" style={{ color: rightPanelMode === 'pinned' ? 'var(--cyan-accent)' : 'var(--text-secondary)' }} title={t('chat.pinnedMessages')}>
                <Pin size={15} />
                {pinnedMessageIds.length > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-[var(--cyan-accent)] text-black text-[9px] font-bold px-0.5">{pinnedMessageIds.length > 99 ? '99+' : pinnedMessageIds.length}</span>}
              </button>
            )}
            <button type="button" onClick={() => setRightPanelMode(prev => prev === 'search' ? null : 'search')} className="p-1.5 rounded-lg hover:bg-fill-active transition-colors" style={{ color: rightPanelMode === 'search' ? 'var(--cyan-accent)' : 'var(--text-secondary)' }} title={`${t('search.placeholder', 'Search messages')} (Ctrl+K)`}>
              <Search size={15} />
            </button>
          </div>
        </div>
          {/* Chat feed */}
          <div className="flex-1 flex flex-col min-w-0 relative">
            {channel.ageRestricted && <AgeGateOverlay channelId={channel.id} onGoBack={ageGateGoBack} />}
            {showEmptyState && (
              <EmptyChatState
                surface={emptyStateSurface}
                channelName={channel.name}
                otherUser={headerUser}
                groupMembers={dmOtherUsers as Array<{ avatar?: string | null; username: string }> | undefined}
              />
            )}
            <Virtuoso
              key={channel.id}
              ref={virtuosoRef}
              scrollerRef={(el) => { scrollerElRef.current = el as HTMLElement | null; }}
              data={flatItems}
              alignToBottom
              /* Collapse the ResizeObserver measurement into a single frame so
                 async row-height settle (images/embeds) and alignToBottom's
                 top-padding recompute stop interleaving across frames; that
                 interleave is the load-time jitter burst. Emits benign
                 "ResizeObserver loop" console warnings, already filtered in
                 src/sentry.ts ignoreErrors. */
              skipAnimationFrameInResizeObserver
              defaultItemHeight={80}
              computeItemKey={(_index, item) => item.kind === 'separator' ? `sep-${item.day}` : `msg-${item.msg.id}`}
              role="log"
              aria-label="Message history"
              className="flex-1 min-h-0 min-w-0 will-change-transform overflow-x-hidden overscroll-contain"
              style={{ paddingLeft: messageListPaddingX, paddingRight: messageListPaddingX, paddingTop: d === 'compact' ? '46px' : d === 'spacious' ? '58px' : '52px', paddingBottom: keyboardHeight > 0 ? keyboardHeight : undefined }}
              followOutput={handleFollowOutput}
              atBottomThreshold={40}
              atBottomStateChange={handleAtBottomStateChange}
              isScrolling={handleScrollingChange}
              rangeChanged={handleRangeChanged}
              overscan={300}
              increaseViewportBy={{ top: 800, bottom: 600 }}
              firstItemIndex={firstItemIndex}
              initialTopMostItemIndex={initialTopMostItemIndex}
              startReached={handleStartReached}
              components={virtuosoComponents}
              itemContent={renderMessageItem}
            />
            {showScrollDown && (
              <button
                type="button"
                onClick={() => {
                  virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' });
                  unseenCountRef.current = 0;
                  setShowScrollDown(false);
                }}
                className="absolute bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-[var(--glass-border)] shadow-lg transition-colors text-t-primary"
                style={{ backgroundColor: 'color-mix(in srgb, var(--bg-app) 92%, transparent)' }}
              >
                <ChevronDown size={14} />
                {unseenCountRef.current > 0
                  ? `${unseenCountRef.current} new message${unseenCountRef.current > 1 ? 's' : ''}`
                  : firstUnreadIndex != null && messages.length - firstUnreadIndex > 0
                  ? `${messages.length - firstUnreadIndex} new message${messages.length - firstUnreadIndex > 1 ? 's' : ''}`
                  : 'Jump to present'}
              </button>
            )}
            {renderMessageMenuPortal()}
          </div>
        </div>
          {rightPanelMode && <Suspense fallback={null}><RightPanel
            mode={rightPanelMode}
            onClose={() => setRightPanelMode(null)}
            onSetMode={(m) => setRightPanelMode(m)}
            serverId={activeServerId}
            channelId={channel.id}
            encrypted={isDMChannel ? encrypted : false}
            dmChannelId={isDMChannel ? channel.id : undefined}
            onNavigateToMessage={onNavigateToMessage}
            pinnedList={pinnedList}
            pinnedListLoading={pinnedListLoading}
            pinnedCount={pinnedMessageIds.length}
            onUnpinMessage={onUnpinMessage}
            onRemovePinnedFromList={(msgId) => setPinnedList((prev) => prev.filter((m) => m.id !== msgId))}
            usersById={usersById}
            showPinned={!!getChannelPins}
          /></Suspense>}
        </div>
      ) : (
      <>
      <div className="flex-1 flex min-h-0 min-w-0 relative">
      {/* Feed: message cards (no timeline, card style) - flex-1 min-h-0 so it fills space; content top-aligned */}
      <div key={isOtrRoom ? 'otr' : 'saved'} data-otr-slide={isOtrRoom ? 'otr' : 'saved'} className={`flex-1 min-h-0 min-w-0 flex flex-col relative ${tierSlideClass}`}>
        {channel.ageRestricted && <AgeGateOverlay channelId={channel.id} onGoBack={ageGateGoBack} />}
        {showEmptyState && (
          <EmptyChatState
            surface={emptyStateSurface}
            channelName={channel.name}
            otherUser={headerUser}
            groupMembers={dmOtherUsers as Array<{ avatar?: string | null; username: string }> | undefined}
          />
        )}
        <Virtuoso
          key={channel.id}
          ref={virtuosoRef}
          scrollerRef={(el) => { scrollerElRef.current = el as HTMLElement | null; }}
          data={flatItems}
          alignToBottom
          /* See the server-strip Virtuoso above: collapses ResizeObserver
             measurement into one frame to kill the load-time padding-thrash
             burst (benign "ResizeObserver loop" warnings filtered in src/sentry.ts). */
          skipAnimationFrameInResizeObserver
          defaultItemHeight={80}
          computeItemKey={(_index, item) => item.kind === 'separator' ? `sep-${item.day}` : `msg-${item.msg.id}`}
          role="log"
          aria-label="Message history"
          className="flex-1 min-h-0 min-w-0 will-change-transform overflow-x-hidden overscroll-contain"
          style={{ paddingLeft: messageListPaddingX, paddingRight: messageListPaddingX, paddingBottom: keyboardHeight > 0 ? keyboardHeight : undefined }}
          followOutput={handleFollowOutput}
          atBottomThreshold={40}
          atBottomStateChange={handleAtBottomStateChange}
          isScrolling={handleScrollingChange}
          rangeChanged={handleRangeChanged}
          overscan={300}
          increaseViewportBy={{ top: 800, bottom: 600 }}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={initialTopMostItemIndex}
          startReached={handleStartReached}
          components={virtuosoComponents}
          itemContent={renderMessageItem}
        />
        {showScrollDown && (
          <button
            type="button"
            onClick={() => {
              virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' });
              unseenCountRef.current = 0;
              setShowScrollDown(false);
            }}
            className="absolute bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-[var(--glass-border)] shadow-lg transition-colors text-t-primary"
            style={{ backgroundColor: 'color-mix(in srgb, var(--bg-app) 92%, transparent)' }}
          >
            <ChevronDown size={14} />
            {unseenCountRef.current > 0
              ? `${unseenCountRef.current} new message${unseenCountRef.current > 1 ? 's' : ''}`
              : firstUnreadIndex != null && messages.length - firstUnreadIndex > 0
              ? `${messages.length - firstUnreadIndex} new message${messages.length - firstUnreadIndex > 1 ? 's' : ''}`
              : 'Jump to present'}
          </button>
        )}
        {renderMessageMenuPortal()}
      </div>
      {rightPanelMode && <Suspense fallback={null}><RightPanel
        mode={rightPanelMode}
        onClose={() => setRightPanelMode(null)}
        onSetMode={(m) => setRightPanelMode(m)}
        serverId={activeServerId}
        channelId={channel.id}
        encrypted={isDMChannel ? encrypted : false}
        dmChannelId={isDMChannel ? channel.id : undefined}
        onNavigateToMessage={onNavigateToMessage}
        pinnedList={pinnedList}
        pinnedListLoading={pinnedListLoading}
        pinnedCount={pinnedMessageIds.length}
        onUnpinMessage={onUnpinMessage}
        onRemovePinnedFromList={(msgId) => setPinnedList((prev) => prev.filter((m) => m.id !== msgId))}
        usersById={usersById}
        showPinned={!!getChannelPins}
      /></Suspense>}
      </div>
      </>
      ))}


      {!chatHidden && reactionPickerMsgId && reactionFullPickerOpen && (
        <EmojiPicker
          open
          onClose={closeReactionPicker}
          onSelect={(emoji) => quickReact(reactionPickerMsgId, emoji)}
          anchorRef={reactionFullPickerAnchorRef}
          activeServerId={activeServerId}
          servers={servers}
          zoomLevel={cssZoomLevel}
          userPlan={userPlan}
          userId={currentUserId}
        />
      )}

      {!chatHidden && (
      <div className="shrink-0" data-chat-composer>
        <MessageInput
          ref={messageInputRef}
          channel={channel}
          users={users}
          encrypted={encrypted}
          sendDisabled={sendDisabled}
          blockBanner={blockBanner}
          composerPlaceholder={composerPlaceholder}
          rateLimitBanner={rateLimitBanner}
          messageSendError={messageSendError}
          onSendMessage={onSendMessage}
          onTyping={onTyping}
          uploadFile={uploadFile}
          activeServerId={activeServerId}
          servers={servers}
          userPlan={userPlan}
          zoomLevel={cssZoomLevel}
          replyingTo={replyingTo}
          onCancelReply={() => setReplyingTo(null)}
          convertEmoticons={convertEmoticons}
          showSendBtn={showSendBtn}
          maxAttachmentMB={MAX_ATTACHMENT_MB}
          statusBarDocked={inline ? false : statusBarDocked}
          dmContainerRef={dmContainerRef}
          typingUsers={typingUsers}
          headerUser={!!headerUser}
          headerGroup={!!headerGroup}
          isDM={isDM}
          otrEmptyPlaceholder={otrEmptyPlaceholder}
          chatContainerRef={chatContainerRef}
          inline={inline}
          uiDensity={d}
          currentUserId={currentUserId}
          canMentionEveryone={canMentionEveryone}
          onBarHeightChange={handleBarHeightChange}
          onCreatePoll={onCreatePoll}
          canCreatePoll={canCreatePoll}
          onCreateThread={onCreateThreadFromMenu}
          canCreateThread={canCreateThread}
          onEditLastMessage={handleEditLastMessage}
          onSlashCommand={onSlashCommand}
        />
      </div>
      )}

      {isDraggingFile && uploadFile && (
        <div
          className="absolute inset-0 z-[var(--z-modal)] flex flex-col items-center justify-center pointer-events-none"
          style={{
            backgroundColor: 'var(--overlay-backdrop)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            border: '2px dashed var(--cyan-accent)',
            borderRadius: '12px',
            margin: '8px',
          }}
        >
          <div
            className="flex flex-col items-center gap-3 px-8 py-6 rounded-2xl bg-floating"
            style={{
              border: '1px solid var(--glass-border)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            }}
          >
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--cyan-accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span className="text-base font-semibold text-t-primary">
              {t('chat.dropToUpload')}
            </span>
            <span className="text-xs text-t-secondary">
              {t('chat.attachFile', { maxMB: MAX_ATTACHMENT_MB })}
            </span>
          </div>
        </div>
      )}

    </div>
  );
});
