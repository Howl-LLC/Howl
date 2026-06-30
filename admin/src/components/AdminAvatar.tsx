// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { letterAvatar } from '../utils';
import { resolveUrl } from '../api';

interface AdminAvatarProps {
  src: string | null | undefined;
  name: string;
  size: number;
  rounded?: number;
  /** Custom fallback when no src. If omitted, uses letter avatar. */
  fallback?: React.ReactElement;
}

const AdminAvatar: React.FC<AdminAvatarProps> = ({ src, name, size, rounded, fallback }) => {
  const resolvedSrc = src ? resolveUrl(src) : null;
  const isGif = resolvedSrc ? /\.gif(\?|$)/i.test(resolvedSrc) : false;
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frozen, setFrozen] = useState(false);

  const freezeGif = useCallback(() => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || !img.naturalWidth) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.drawImage(img, 0, 0);
    setFrozen(true);
  }, []);

  useEffect(() => {
    if (!isGif) return;
    const handler = () => {
      if (document.hidden) freezeGif();
      else setFrozen(false);
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [isGif, freezeGif]);

  if (!resolvedSrc) {
    return fallback ?? letterAvatar(name, size);
  }

  const br = rounded ?? (size > 40 ? 16 : 10);

  if (isGif) {
    return (
      <div className="relative shrink-0 overflow-hidden" style={{ width: size, height: size, borderRadius: br }}>
        <img
          ref={imgRef}
          src={resolvedSrc}
          alt=""
          style={{ width: size, height: size, objectFit: 'cover', display: frozen ? 'none' : 'block' }}
        />
        <canvas
          ref={canvasRef}
          style={{ width: size, height: size, objectFit: 'cover', display: frozen ? 'block' : 'none' }}
        />
      </div>
    );
  }

  return (
    <img
      src={resolvedSrc}
      alt=""
      className="shrink-0 object-cover"
      style={{ width: size, height: size, borderRadius: br }}
    />
  );
};

export default AdminAvatar;
