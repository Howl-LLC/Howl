// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { retryOnExpired, toOriginalUploadPath } from '../utils/signedImageRetry';
// Use the unified visibility signal — it tracks document.hidden + window
// blur/focus AND the Electron IPC channel. The previous hook (usePageVisible)
// only watched DOM events, which on Electron sometimes missed the visibility
// flip and left isFocused stuck on true when the window was actually blurred —
// the symptom the user reported as "avatar GIFs still playing on Electron".
import { useAppVisible } from '../hooks/useAppVisible';

const GIF_RE = /\.gif(\?|$)/i;

const AVATAR_COLORS = [
  '#5b3a3a', '#5b3a4f', '#4a3560', '#3d2d5e',
  '#2d4a6b', '#264d5e', '#2a5450', '#24504a',
  '#35593e', '#2e5038', '#6b5630', '#5e5335',
  '#6b4a2e', '#5e3d24', '#2a5258', '#24504d',
  '#3d3f6b', '#4a3d6b', '#6b3558', '#2a5460',
];

function colorFromName(name: string): string {
  // Strip trailing #XXXX discriminator so "Super" and "Super#0000" hash identically
  const base = name.replace(/#\d{4}$/, '');
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = base.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

const DEFAULT_SVG_PATH = '/default-avatar.svg';

function isDefaultAvatar(avatar: string | null | undefined): boolean {
  if (!avatar) return true;
  if (avatar === DEFAULT_SVG_PATH) return true;
  if (avatar.endsWith(DEFAULT_SVG_PATH)) return true;
  return false;
}

const GifAvatar: React.FC<{
  src: string;
  originalSrc?: string;
  alt: string;
  className: string;
  style: React.CSSProperties;
  onError?: () => void;
}> = ({ src, originalSrc, alt, className, style, onError }) => {
  const imgRef = useRef<HTMLImageElement>(null);
  const isFocused = useAppVisible();
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const captureFrame = useCallback(() => {
    const el = imgRef.current;
    if (!el || !el.naturalWidth) return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = el.naturalWidth;
      canvas.height = el.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(el, 0, 0);
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    if (!isFocused) {
      const frame = captureFrame();
      if (frame) setFrozenFrame(frame);
    } else {
      setFrozenFrame(null);
    }
  }, [isFocused, loaded, captureFrame]);

  return (
    <img
      ref={imgRef}
      src={frozenFrame || src}
      alt={alt}
      className={className}
      style={style}
      draggable={false}
      crossOrigin="anonymous"
      data-original-src={originalSrc}
      onLoad={() => setLoaded(true)}
      onError={(e) => {
        if (!retryOnExpired(e)) onError?.();
      }}
    />
  );
};

interface LetterAvatarProps {
  avatar?: string | null;
  username: string;
  /**
   * When provided, LetterAvatar is self-sizing (sets its own width/height/fontSize)
   * and shape should come from className (e.g. "rounded-full", "squircle").
   * When omitted, fills its parent with w-full h-full and inherits borderRadius.
   */
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export const LetterAvatar: React.FC<LetterAvatarProps> = ({
  avatar,
  username,
  size,
  className = '',
  style,
}) => {
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [avatar]);

  const hasCustomAvatar = !isDefaultAvatar(avatar) && !imgError;
  const fillParent = !size;
  const sizeStyle = size ? { width: size, height: size } : {};
  // App-wide avatar shape: every profile picture is a squircle (matches the server-rail icon
  // radius, --radius-lg). Applied as an inline style so it wins over any caller `rounded-full`
  // class; the fillParent case still inherits its (squircle) parent. Callers can override via `style`.
  const radiusStyle = fillParent ? { borderRadius: 'inherit' as const } : { borderRadius: 'var(--radius-lg)' };
  const fontSize = size ? Math.max(10, Math.round(size * 0.44)) : undefined;

  if (hasCustomAvatar) {
    const sanitized = sanitizeImgSrc(avatar);
    const originalSrc = toOriginalUploadPath(avatar);
    const isGif = GIF_RE.test(sanitized);

    if (!isGif) {
      return (
        <img
          src={sanitized}
          alt={username}
          className={`block object-cover ${fillParent ? 'w-full h-full' : 'shrink-0'} ${className}`}
          style={{ ...sizeStyle, ...radiusStyle, ...style }}
          draggable={false}
          data-original-src={originalSrc}
          onError={(e) => { if (!retryOnExpired(e)) setImgError(true); }}
        />
      );
    }

    return (
      <GifAvatar
        src={sanitized}
        originalSrc={originalSrc}
        alt={username}
        className={`block object-cover ${fillParent ? 'w-full h-full' : 'shrink-0'} ${className}`}
        style={{ ...sizeStyle, ...radiusStyle, ...style }}
        onError={() => setImgError(true)}
      />
    );
  }

  const letter = (username || '?')[0].toUpperCase();
  const bg = colorFromName(username);

  return (
    <div
      className={`flex items-center justify-center select-none ${fillParent ? 'w-full h-full' : 'shrink-0 overflow-hidden'} ${className}`}
      style={{
        ...sizeStyle,
        ...radiusStyle,
        backgroundColor: bg,
        color: 'rgba(255,255,255,0.85)',
        fontSize,
        fontWeight: 800,
        lineHeight: 1,
        letterSpacing: '-0.02em',
        ...style,
      }}
      aria-label={username}
    >
      {letter}
    </div>
  );
};

export { isDefaultAvatar, colorFromName };
export default LetterAvatar;
