// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useCallback } from 'react';
// useAppVisible (Electron-aware) — usePageVisible only watched DOM events
// and missed Electron window-blur transitions under IPC load. The
// LazyGif/LetterAvatar/ServerIcon migration mirrors the prior fix in
// useBackgroundSettings.ts.
import { useAppVisible } from '../hooks/useAppVisible';
import { getImageDims, rememberImageDims } from '../utils/imageDimCache';
import { retryOnExpired, toOriginalUploadPath } from '../utils/signedImageRetry';

// Small LRU cache for canvas-captured frames (external GIFs, encrypted blob
// attachments, and any animated source without a server-generated frame).
// Uploaded GIFs prefer the server-generated frame URL (HTTP cache, no canvas
// CPU) when frameSrc is provided.
const CANVAS_FRAME_CACHE = new Map<string, string>();
const CANVAS_CACHE_MAX = 50;

/**
 * Heuristic: could this URL point to animated content?
 * - data:image/{gif,webp,apng,avif} — animated MIME
 * - blob: — encrypted attachment, can't introspect → assume might be
 * - file extension match (handles signed URL query strings)
 *
 * Static formats (.jpg/.png/.svg/.heic) return false so we don't waste a
 * canvas-capture per render on plain photos.
 */
function maybeAnimatedUrl(src: string): boolean {
  if (src.startsWith('data:image/gif')) return true;
  if (src.startsWith('data:image/webp')) return true;
  if (src.startsWith('data:image/apng')) return true;
  if (src.startsWith('data:image/avif')) return true;
  if (src.startsWith('blob:')) return true;
  // Match extension before optional query/fragment so signed CDN URLs work.
  return /\.(gif|webp|apng|avif)(\?|#|$)/i.test(src);
}

/**
 * Image component that pauses animated playback when the page/app loses focus.
 *
 * Three modes (resolved per-render):
 * 1. frameSrc provided → frame-swap (zero CPU, no canvas, no CORS)
 * 2. URL looks animated (or `animated` opted-in) → canvas capture
 * 3. Static URL → plain <img>
 *
 * Canvas mode is automatic when no frameSrc is available — caller no longer
 * needs to opt in via `animated={true}`. The opt-in remains as an override
 * for cases where URL-based detection underreports (e.g. a static `.png`
 * that's actually an animated PNG, or an opaque CDN URL with no extension).
 */
export function LazyGif({ src, frameSrc, alt, className, style, draggable, animated, forceStatic, onError, onClick, onImageLoad }: {
  src: string;
  /** Server-generated frozen frame URL. When provided, uses instant frame-swap instead of canvas. */
  frameSrc?: string;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
  draggable?: boolean;
  /** Force canvas-capture freeze even when the URL doesn't look animated.
   *  Default behavior auto-detects via URL extension / data: prefix / blob: scheme. */
  animated?: boolean;
  /** Force static frame display regardless of page visibility (e.g. server below required power-up tier). */
  forceStatic?: boolean;
  onError?: React.ReactEventHandler<HTMLImageElement>;
  onClick?: React.MouseEventHandler<HTMLImageElement>;
  /** Fired once per src after the underlying <img> finishes its initial load.
   *  `dims` carries the natural pixel size when available — callers can cache this
   *  to reserve layout space (via aspect-ratio) on subsequent renders of the same URL. */
  onImageLoad?: (dims?: { w: number; h: number }) => void;
}) {
  const isFocused = useAppVisible();

  // Frame swap state
  const [frameLoaded, setFrameLoaded] = useState<string | null>(null);
  // Frame URL gave a 404/decode error. Sticky for the lifetime of frameSrc.
  // Triggered for legacy uploads that predate the worker, or when the worker
  // failed asynchronously. Falls back to canvas capture so the freeze still
  // works without a server-generated frame derivative.
  const [frameError, setFrameError] = useState(false);

  // Mode selection — frameSwap when the server frame URL is provided AND it
  // hasn't errored; canvas capture as the universal fallback when the URL
  // might be animated. The `animated` prop is an explicit override for
  // callers that know better than URL heuristics (e.g. an animated `.png`
  // that's actually APNG, served from a CDN that strips the extension hint).
  const useFrameSwap = !!frameSrc && !frameError;
  const useCanvas = (!frameSrc || frameError) && (animated || maybeAnimatedUrl(src));
  const isGif = useFrameSwap || useCanvas;

  // Canvas capture state
  const ref = useRef<HTMLImageElement>(null);
  const dimsRef = useRef<{ w: number; h: number } | null>(null);
  const [canvasFrame, setCanvasFrame] = useState<string | null>(
    () => useCanvas ? (CANVAS_FRAME_CACHE.get(src) ?? null) : null,
  );

  const hasReportedLoad = useRef(false);

  // Single load-event handler used by all three render paths. Captures naturalDims
  // and forwards them to the consumer so they can populate a per-URL dimension cache.
  const handleLoadEvent = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const dims = img.naturalWidth > 0 && img.naturalHeight > 0
      ? { w: img.naturalWidth, h: img.naturalHeight }
      : undefined;
    // Persist to the shared cross-component dim cache so future renders of
    // the same URL (same chat, different chat, after page reload) can
    // reserve layout space via aspect-ratio before the image loads.
    if (dims) rememberImageDims(src, dims);
    if (!hasReportedLoad.current) {
      hasReportedLoad.current = true;
      onImageLoad?.(dims);
    }
  }, [onImageLoad, src]);

  // Read cached dims once so the first render already has aspect-ratio
  // reserved — prevents layout jump while the image bytes are in flight.
  // Per-URL lookup is synchronous (in-memory after initial localStorage
  // hydration at module load).
  const cachedDims = getImageDims(src);
  const dimStyle: React.CSSProperties | undefined = cachedDims
    ? { aspectRatio: `${cachedDims.w} / ${cachedDims.h}` }
    : undefined;
  const mergedStyle: React.CSSProperties | undefined =
    dimStyle && style ? { ...style, ...dimStyle }
    : dimStyle ?? style;

  // Frame swap: lazy-load frame on blur
  useEffect(() => {
    if (!useFrameSwap || !frameSrc || isFocused) return;
    // Already loaded this frame
    if (frameLoaded === frameSrc) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => { if (!cancelled) setFrameLoaded(frameSrc); };
    // Server frame missing (legacy upload before frame_*.webp existed, or the
    // worker failed). Mark sticky-error so we switch to canvas-capture mode on
    // the next render — the GIF still pauses, just via the more expensive
    // local canvas path instead of the cheap frame swap.
    img.onerror = () => { if (!cancelled) setFrameError(true); };
    img.src = frameSrc;
    return () => { cancelled = true; img.onload = null; img.onerror = null; };
  }, [useFrameSwap, frameSrc, isFocused, frameLoaded]);

  // Reset both frame-loaded and frame-error when frameSrc changes (e.g. different message)
  useEffect(() => { setFrameLoaded(null); setFrameError(false); }, [frameSrc]);

  // Canvas: capture dimensions on first load
  const onLoad = useCallback(() => {
    if (!useCanvas) return;
    const el = ref.current;
    if (!el || dimsRef.current) return;
    const w = el.offsetWidth || el.naturalWidth;
    const h = el.offsetHeight || el.naturalHeight;
    if (w > 0 && h > 0) dimsRef.current = { w, h };
  }, [useCanvas]);

  const captureFrame = useCallback(() => {
    const el = ref.current;
    if (!el || !dimsRef.current) return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = el.naturalWidth || dimsRef.current.w;
      canvas.height = el.naturalHeight || dimsRef.current.h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(el, 0, 0);
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }, []);

  // Canvas: freeze/unfreeze on focus change
  useEffect(() => {
    if (!useCanvas) return;
    if (!isFocused) {
      const cached = CANVAS_FRAME_CACHE.get(src);
      if (cached) { setCanvasFrame(cached); return; }
      if (!dimsRef.current) return;
      const frame = captureFrame();
      if (frame) {
        if (CANVAS_FRAME_CACHE.size >= CANVAS_CACHE_MAX) {
          const oldest = CANVAS_FRAME_CACHE.keys().next().value;
          if (oldest !== undefined) CANVAS_FRAME_CACHE.delete(oldest);
        }
        CANVAS_FRAME_CACHE.set(src, frame);
        setCanvasFrame(frame);
      }
    } else {
      setCanvasFrame(null);
    }
  }, [isFocused, useCanvas, captureFrame, src]);

  // Reset canvas frame when src changes
  useEffect(() => {
    if (useCanvas) setCanvasFrame(CANVAS_FRAME_CACHE.get(src) ?? null);
  }, [src, useCanvas]);

  // Reset load flag when src changes
  useEffect(() => { hasReportedLoad.current = false; }, [src]);

  const originalSrcPath = toOriginalUploadPath(src);
  const handleError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (!retryOnExpired(e)) onError?.(e);
  };

  // Render: plain image
  if (!isGif) {
    return (
      <img src={src} alt={alt} className={className} style={mergedStyle}
        draggable={draggable} decoding="async"
        data-original-src={originalSrcPath}
        onError={handleError} onClick={onClick} onLoad={handleLoadEvent} />
    );
  }

  // Render: frame swap (uploaded GIFs)
  if (useFrameSwap) {
    const showFrame = (forceStatic || !isFocused) && frameLoaded === frameSrc;
    return (
      <img src={showFrame ? frameSrc! : src} alt={alt} className={className} style={mergedStyle}
        draggable={draggable} decoding="async"
        data-original-src={originalSrcPath}
        onError={handleError} onClick={onClick}
        onLoad={handleLoadEvent} />
    );
  }

  // Render: canvas capture (Klipy/encrypted fallback)
  const frozen = (forceStatic || !isFocused) && canvasFrame != null && dimsRef.current != null;
  const imgSrc = frozen ? canvasFrame! : src;
  const imgStyle = frozen
    ? { ...style, width: dimsRef.current!.w, height: dimsRef.current!.h }
    : mergedStyle;
  // crossOrigin only for external URLs — blob: URLs are same-origin and don't need it
  const needsCrossOrigin = !src.startsWith('blob:');

  return (
    <img ref={ref} src={imgSrc} alt={alt} className={className} style={imgStyle}
      draggable={draggable} decoding="async" crossOrigin={needsCrossOrigin ? 'anonymous' : undefined}
      data-original-src={originalSrcPath}
      onError={handleError} onClick={onClick}
      onLoad={(e) => { onLoad(); handleLoadEvent(e); }} />
  );
}
