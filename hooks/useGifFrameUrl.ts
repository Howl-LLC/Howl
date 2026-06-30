// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect } from 'react';
// useAppVisible (not usePageVisible) — Electron-aware via IPC. The DOM-only
// hook missed visibility flips under heavy IPC load and left CSS background
// GIFs running while the window was blurred.
import { useAppVisible } from './useAppVisible';
import { getFrameUrl } from '../utils/getFrameUrl';

// Pin in-flight preload Images so they can't be GC'd between re-renders. When
// the useEffect closure goes out of scope before the fetch completes, Firefox
// aborts the request (NS_BINDING_ABORTED) and the frame never preloads, so the
// GIF keeps animating when the page blurs. Holding a strong reference until
// onload/onerror keeps the fetch alive.
const __frameLoadedUrls = new Set<string>();
const __frameLoadingImages = new Set<HTMLImageElement>();

/**
 * For CSS backgroundImage contexts where LazyGif can't be used.
 * Returns the frozen frame URL when unfocused, original URL when focused.
 * Preloads the frame to avoid flashing — stays on GIF until frame is cached.
 */
export function useGifFrameUrl(url: string | null | undefined): string | null | undefined {
  const isFocused = useAppVisible();
  const frameUrl = getFrameUrl(url);
  const [frameReady, setFrameReady] = useState(() => frameUrl ? __frameLoadedUrls.has(frameUrl) : false);

  // Lazy-load frame on first blur
  useEffect(() => {
    if (!frameUrl) return;
    if (__frameLoadedUrls.has(frameUrl)) {
      if (!frameReady) setFrameReady(true);
      return;
    }
    if (isFocused || frameReady) return;

    const img = new Image();
    __frameLoadingImages.add(img);
    const done = () => { __frameLoadingImages.delete(img); };
    img.onload = () => { __frameLoadedUrls.add(frameUrl); setFrameReady(true); done(); };
    img.onerror = () => { /* Frame missing — GIF keeps playing */ done(); };
    img.src = frameUrl;
  }, [frameUrl, isFocused, frameReady]);

  // Reset when URL changes
  useEffect(() => {
    setFrameReady(frameUrl ? __frameLoadedUrls.has(frameUrl) : false);
  }, [frameUrl]);

  if (!isFocused && frameUrl && frameReady) return frameUrl;
  return url;
}
