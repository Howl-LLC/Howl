// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef } from 'react';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { retryOnExpired, toOriginalUploadPath } from '../utils/signedImageRetry';
// useAppVisible — Electron-aware. usePageVisible missed window-blur events
// under IPC load, so server icon GIFs kept playing on Electron when the
// window lost focus. See useBackgroundSettings.ts for prior art.
import { useAppVisible } from '../hooks/useAppVisible';

const ANIMATED_RE = /\.(gif|webp|apng)(\?|$)/i;

function colorFromName(_name: string): string {
  return '#1a1c22';
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

interface ServerIconProps {
  icon?: string | null;
  name: string;
  className?: string;
  imgClassName?: string;
  size?: number;
  /** When true (active server) animated icon plays. Also plays on hover. */
  active?: boolean;
  /** When true, GIF animation is permanently frozen (e.g. server below required power-up tier). */
  freezeAnimation?: boolean;
}

const STATIC_FRAME_CACHE_LIMIT = 100;
const staticFrameCache = new Map<string, string>();
function setStaticFrameCached(key: string, value: string) {
  if (staticFrameCache.size >= STATIC_FRAME_CACHE_LIMIT) {
    const oldest = staticFrameCache.keys().next().value;
    if (oldest !== undefined) staticFrameCache.delete(oldest);
  }
  staticFrameCache.set(key, value);
}

export const ServerIcon: React.FC<ServerIconProps> = React.memo(({
  icon: rawIcon,
  name,
  className = '',
  imgClassName = '',
  size,
  active = true,
  freezeAnimation = false,
}) => {
  const icon = rawIcon || null;

  const sizeStyle: React.CSSProperties = size
    ? { width: size, height: size }
    : { width: '100%', height: '100%' };

  const maybeAnimated = !!(icon && ANIMATED_RE.test(icon));
  const isFocused = useAppVisible();
  const [hovered, setHovered] = useState(false);
  const [staticFrame, setStaticFrame] = useState<string | null>(() =>
    icon ? staticFrameCache.get(icon) ?? null : null,
  );

  // Canvas ref for fallback frozen frame (when toDataURL fails due to CORS)
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasFallbackReady, setCanvasFallbackReady] = useState(false);

  useEffect(() => {
    if (!maybeAnimated || !icon) {
      setStaticFrame(null);
      setCanvasFallbackReady(false);
      return;
    }
    const cached = staticFrameCache.get(icon);
    if (cached) {
      setStaticFrame(cached);
      return;
    }
    setStaticFrame(null);
    setCanvasFallbackReady(false);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0);
          const dataUrl = canvas.toDataURL('image/png');
          setStaticFrameCached(icon, dataUrl);
          setStaticFrame(dataUrl);
          return;
        }
      } catch {
        // Tainted canvas (cross-origin CDN) — toDataURL failed, use canvas fallback
      }
      drawToCanvasRef(img);
    };
    // onerror = the network/decode pipeline failed entirely — there is no
    // image to capture or draw. Calling drawToCanvasRef here used to throw
    // `DOMException: CanvasRenderingContext2D.drawImage: Passed-in image
    // is "broken"` because the <img> never reached a usable state.
    // The fallback render below (the live <img> with onError={retryOnExpired})
    // already handles the "image failed" case.
    img.onerror = () => { /* nothing to do — no usable bitmap */ };
    img.src = icon;

    function drawToCanvasRef(loadedImg: HTMLImageElement) {
      // Belt-and-suspenders: refuse to drawImage a broken/empty bitmap.
      // Even though this is now only invoked from onload, a partial-decode
      // error (rare) could still leave naturalWidth at 0.
      if (!loadedImg.naturalWidth || !loadedImg.naturalHeight) return;
      const c = canvasRef.current;
      if (!c) {
        // Canvas ref not mounted yet — retry once on next frame
        requestAnimationFrame(() => {
          const c2 = canvasRef.current;
          if (!c2) return;
          if (!loadedImg.naturalWidth || !loadedImg.naturalHeight) return;
          c2.width = loadedImg.naturalWidth;
          c2.height = loadedImg.naturalHeight;
          const ctx2 = c2.getContext('2d');
          if (ctx2) {
            ctx2.drawImage(loadedImg, 0, 0);
            setCanvasFallbackReady(true);
          }
        });
        return;
      }
      c.width = loadedImg.naturalWidth;
      c.height = loadedImg.naturalHeight;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.drawImage(loadedImg, 0, 0);
        setCanvasFallbackReady(true);
      }
    }
  }, [icon, maybeAnimated]);

  if (!icon) {
    const bg = colorFromName(name);
    const letters = initials(name);
    return (
      <div
        className={`flex items-center justify-center select-none font-black shrink-0 ${className}`}
        style={{
          ...sizeStyle,
          background: bg,
          fontSize: size
            ? `${Math.max(8, Math.round(size * 0.38))}px`
            : `calc(var(--sidebar-w, 48) * 0.266px)`,
          color: '#fff',
          textShadow: '0 1px 2px rgba(0,0,0,0.35)',
          lineHeight: 1,
        }}
        title={name}
        aria-label={name}
      >
        {letters}
      </div>
    );
  }

  const originalIconPath = toOriginalUploadPath(icon);

  if (!maybeAnimated) {
    return (
      <img
        src={sanitizeImgSrc(icon)}
        alt={name}
        draggable={false}
        loading="lazy"
        className={`block object-cover pointer-events-none ${imgClassName || className}`}
        style={sizeStyle}
        data-original-src={originalIconPath}
        onError={retryOnExpired}
      />
    );
  }

  const shouldAnimate = !freezeAnimation && (active || hovered) && isFocused;

  return (
    <div
      style={{ ...sizeStyle, position: 'relative', overflow: 'hidden' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Animated GIF — shown when active/hovered and page focused */}
      {shouldAnimate && (
        <img
          key="animated"
          src={sanitizeImgSrc(icon)}
          alt={name}
          draggable={false}
          className={`block object-cover ${imgClassName || className}`}
          style={{ ...sizeStyle, position: 'absolute', inset: 0 }}
          data-original-src={originalIconPath}
          onError={retryOnExpired}
        />
      )}

      {/* Static frame (data URL from toDataURL cache) — preferred frozen display */}
      {!shouldAnimate && staticFrame && (
        <img
          key="static"
          src={staticFrame}
          alt={name}
          draggable={false}
          className={`block object-cover ${imgClassName || className}`}
          style={{ ...sizeStyle, position: 'absolute', inset: 0 }}
        />
      )}

      {/* Canvas fallback — always in DOM so ref is available for useEffect drawing.
          Visible only when not animating AND no staticFrame data URL. */}
      <canvas
        ref={canvasRef}
        style={{
          ...sizeStyle,
          position: 'absolute',
          inset: 0,
          display: (!shouldAnimate && !staticFrame && canvasFallbackReady) ? 'block' : 'none',
          objectFit: 'cover',
        }}
      />

      {/* Fallback layer: render the actual GIF whenever the freeze pipeline
          isn't ready (canvas not drawn yet AND no staticFrame). Previously
          showed initials, which made icons appear to "vanish" the moment the
          window lost focus before the new Image() in the useEffect had
          finished loading. Showing the live GIF here keeps the icon visible
          (animating) until the freeze frame is captured — the freeze layer
          on top will replace it once ready. */}
      {!shouldAnimate && !staticFrame && !canvasFallbackReady && icon && (
        <img
          key="fallback"
          src={sanitizeImgSrc(icon)}
          alt={name}
          draggable={false}
          className={`block object-cover ${imgClassName || className}`}
          style={{ ...sizeStyle, position: 'absolute', inset: 0 }}
          data-original-src={originalIconPath}
          onError={retryOnExpired}
        />
      )}
    </div>
  );
});
