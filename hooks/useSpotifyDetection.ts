// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef } from 'react';
import { socketService } from '../services/socket';

interface UseSpotifyDetectionOpts {
  enabled: boolean;              // activitySharingEnabled master toggle
  shareSpotifyActivity: boolean; // per-source toggle
}

/**
 * Bridges Electron local Spotify detection to the backend via Socket.IO.
 *
 * When Spotify playback is detected by the Electron main process, this hook
 * emits `set-activity` to the server with type 'spotify'. The server validates
 * that the user has Spotify connected and sharing enabled before accepting.
 *
 * The server-side Spotify poll (30s) continues running as the authoritative
 * source — it enriches with album art, track IDs, etc. This hook provides
 * the fast-path for instant updates.
 *
 * The hook does NOT emit clear-activity when Spotify stops — the server poll
 * handles cleanup authoritatively (the user may still be playing on another device).
 *
 * No-op when running in browser (non-Electron) or when detection is disabled.
 */
export function useSpotifyDetection(opts: UseSpotifyDetectionOpts): void {
  const { enabled, shareSpotifyActivity } = opts;
  const lastEmittedRef = useRef<{ name: string; at: number } | null>(null);
  const DEBOUNCE_MS = 10_000; // 10s — shorter than game's 30s since tracks change faster

  useEffect(() => {
    const electron = window.electron;
    if (!electron?.isElectron) return;
    if (!electron.onSpotifyDetected) return; // older Electron build without Spotify detection

    if (!enabled || !shareSpotifyActivity) {
      // Don't clear activity — the server poll manages Spotify activity lifecycle
      return;
    }

    const unsubDetected = electron.onSpotifyDetected((track) => {
      if (!track?.name) return;

      const now = Date.now();
      const last = lastEmittedRef.current;
      if (last && last.name === track.name && now - last.at < DEBOUNCE_MS) return;

      lastEmittedRef.current = { name: track.name, at: now };
      socketService.emitSetActivity({
        type: 'spotify',
        name: track.name,
        details: track.artist,
      });
    });

    const unsubCleared = electron.onSpotifyCleared(() => {
      lastEmittedRef.current = null;
      // Don't emit clear-activity — let the server poll handle cleanup
    });

    // Query current state on mount
    electron.getDetectedSpotify().then((track) => {
      if (track?.name) {
        lastEmittedRef.current = { name: track.name, at: Date.now() };
        socketService.emitSetActivity({
          type: 'spotify',
          name: track.name,
          details: track.artist,
        });
      }
    }).catch(() => {});

    return () => {
      unsubDetected();
      unsubCleared();
    };
  }, [enabled, shareSpotifyActivity]);
}
