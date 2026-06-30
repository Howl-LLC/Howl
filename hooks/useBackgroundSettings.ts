// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect, useMemo } from 'react';
import type { User } from '../types';
import { useAppVisible } from './useAppVisible';
import { getFrameUrl } from '../utils/getFrameUrl';

// Per-URL load state cached across remounts. The 'failed' state is sticky —
// once a frame URL 404s/times out, we never retry it for that URL, so the
// GIF stays visible without burning network on a known-bad frame.
type FrameLoadState = 'pending' | 'loaded' | 'failed';
const __frameLoadCache = new Map<string, FrameLoadState>();
// Pin in-flight preload Images so the GC can't drop them mid-fetch (Firefox
// otherwise aborts the request as NS_BINDING_ABORTED if the closure that
// holds the only reference goes out of scope before the response lands).
const __frameLoadingImages = new Set<HTMLImageElement>();

/**
 * Manages background image / particle visual settings.
 * Syncs from server profile on login, caches to localStorage for instant render,
 * and handles GIF frozen-frame capture on blur/visibility change.
 */
export function useBackgroundSettings(currentUser: User | null) {
  // Background image state (server-stored, localStorage as instant-render cache)
  const [backgroundImage, setBackgroundImage] = useState<string | null>(() => {
    try {
      return localStorage.getItem('howl_bg_image');
    } catch { return null; }
  });
  const [backgroundOpacity, setBackgroundOpacity] = useState<number>(() => {
    try { return parseFloat(localStorage.getItem('howl_bg_opacity') ?? '0.15'); } catch { return 0.15; }
  });
  const [backgroundBlur, setBackgroundBlur] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('howl_bg_blur') ?? '0', 10); } catch { return 0; }
  });
  const [bgGifAlwaysPlay, setBgGifAlwaysPlay] = useState<boolean>(() => {
    try { return localStorage.getItem('howl_bg_gif_always_play') === 'true'; } catch { return false; }
  });

  // Sync from server profile on user load
  useEffect(() => {
    if (!currentUser) return;
    const serverBg = currentUser.backgroundImage ?? null;
    setBackgroundImage(serverBg);
    if (currentUser.backgroundOpacity !== undefined) setBackgroundOpacity(currentUser.backgroundOpacity);
    if (currentUser.backgroundBlur !== undefined) setBackgroundBlur(currentUser.backgroundBlur);
    if (currentUser.bgGifAlwaysPlay !== undefined) setBgGifAlwaysPlay(currentUser.bgGifAlwaysPlay);
  }, [currentUser?.id, currentUser?.backgroundImage, currentUser?.backgroundOpacity, currentUser?.backgroundBlur, currentUser?.bgGifAlwaysPlay]);

  // Cache to localStorage for instant render on next load
  useEffect(() => {
    try {
      if (backgroundImage) localStorage.setItem('howl_bg_image', backgroundImage);
      else localStorage.removeItem('howl_bg_image');
      localStorage.setItem('howl_bg_opacity', String(backgroundOpacity));
      localStorage.setItem('howl_bg_blur', String(backgroundBlur));
      localStorage.setItem('howl_bg_gif_always_play', bgGifAlwaysPlay ? 'true' : 'false');
    } catch { /* quota exceeded — ignore */ }
  }, [backgroundImage, backgroundOpacity, backgroundBlur, bgGifAlwaysPlay]);

  // GIF frozen-frame (server-generated frame URL swap)
  // Use the unified `useAppVisible` signal — it tracks document.hidden +
  // window blur/focus AND the Electron IPC channel. The previous hook
  // (`usePageVisible`) only watched DOM events, which on Electron sometimes
  // missed the visibility flip and left `isFocused` stuck on true when the
  // window was actually blurred — the symptom the user reported as
  // "background GIF still playing after we 'fixed' it."
  const isFocused = useAppVisible();

  const bgFrameUrl = useMemo(
    () => bgGifAlwaysPlay ? undefined : getFrameUrl(backgroundImage),
    [backgroundImage, bgGifAlwaysPlay],
  );

  // Track frame load state per-URL. Initialise from the module cache so a
  // remount of the hook doesn't re-preload a frame we already validated.
  const [frameState, setFrameState] = useState<FrameLoadState>(
    () => bgFrameUrl ? (__frameLoadCache.get(bgFrameUrl) ?? 'pending') : 'pending',
  );

  // Reset state when bgFrameUrl changes (different background uploaded /
  // bgGifAlwaysPlay toggled / user logged out).
  useEffect(() => {
    setFrameState(bgFrameUrl ? (__frameLoadCache.get(bgFrameUrl) ?? 'pending') : 'pending');
  }, [bgFrameUrl]);

  // Eagerly preload the frame as soon as we know the URL — DON'T wait for
  // the first blur. Two reasons: (1) the freeze swap should be instant when
  // the user alt-tabs, not "150ms later once the frame finishes downloading,"
  // and (2) preloading on mount avoids the racy preload-during-blur path that
  // was being aborted on rapid focus toggles.
  useEffect(() => {
    if (!bgFrameUrl) return;
    const cached = __frameLoadCache.get(bgFrameUrl);
    if (cached === 'loaded' || cached === 'failed') return;

    __frameLoadCache.set(bgFrameUrl, 'pending');
    const img = new window.Image();
    __frameLoadingImages.add(img);
    const done = () => { __frameLoadingImages.delete(img); };
    img.onload = () => {
      __frameLoadCache.set(bgFrameUrl, 'loaded');
      setFrameState('loaded');
      done();
    };
    img.onerror = () => {
      __frameLoadCache.set(bgFrameUrl, 'failed');
      setFrameState('failed');
      done();
    };
    img.src = bgFrameUrl;
  }, [bgFrameUrl]);

  // Freeze means: render the static frame in place of the GIF. We freeze when:
  //   - the window is blurred AND
  //   - we have a known-good frame URL (loaded successfully).
  // If the frame failed to load (e.g. CDN 401, network error), we keep the
  // GIF visible rather than show a blank background.
  const frozen = !isFocused && !!bgFrameUrl && frameState === 'loaded';

  return {
    backgroundImage, setBackgroundImage,
    backgroundOpacity, setBackgroundOpacity,
    backgroundBlur, setBackgroundBlur,
    bgGifAlwaysPlay, setBgGifAlwaysPlay,
    /** @deprecated retained for callers that still read it; prefer rendering
     *  both layers and using `frozen` to toggle which one is `display: block`.
     *  CSS background-image URL swaps don't always stop the underlying GIF
     *  decode — the only reliable way to pause a GIF is to remove the
     *  element with `display: none`. */
    activeBgImage: frozen ? bgFrameUrl : backgroundImage,
    /** The original (animated) URL, always present when there's a background. */
    bgImageUrl: backgroundImage,
    /** The static frozen-frame URL, if available. */
    bgFrameUrl: bgFrameUrl ?? null,
    /** True when the GIF should be hidden and the frozen frame shown. */
    frozen,
  };
}
