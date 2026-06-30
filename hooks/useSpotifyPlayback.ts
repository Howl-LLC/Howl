// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect, useRef, useCallback } from 'react';
import { apiClient } from '../services/api';
import type { GameActivity } from '../types';

export interface UseSpotifyPlaybackOpts {
  /** Whether the player panel is currently open/visible */
  isOpen: boolean;
  /** The current user's spotify activity from the activity system (if any) */
  spotifyActivity: GameActivity | null;
}

export interface SpotifyPlaybackState {
  /** Whether there's an active Spotify device */
  hasActiveDevice: boolean;
  /** Whether music is currently playing (vs paused) */
  isPlaying: boolean;
  /** Current progress in ms — interpolated between polls */
  progressMs: number;
  /** Whether shuffle is enabled */
  shuffleOn: boolean;
  /** Current repeat mode */
  repeatMode: 'off' | 'track' | 'context';
  /** Whether the user has Spotify Premium */
  isPremium: boolean;
  /** Whether the user dismissed the premium overlay (controls should be grayed) */
  premiumDismissed: boolean;
  /** Loading state for initial fetch */
  loading: boolean;
}

export interface SpotifyPlaybackControls {
  togglePlayPause: () => void;
  skipNext: () => void;
  skipPrevious: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  dismissPremium: () => void;
}

const POLL_INTERVAL_MS = 5_000;
const PROGRESS_TICK_MS = 1_000;
const DEBOUNCE_MS = 300;
const SKIP_REFETCH_DELAY_MS = 1_000;

const INITIAL_STATE: SpotifyPlaybackState = {
  hasActiveDevice: false,
  isPlaying: false,
  progressMs: 0,
  shuffleOn: false,
  repeatMode: 'off',
  isPremium: true,
  premiumDismissed: false,
  loading: true,
};

export function useSpotifyPlayback(opts: UseSpotifyPlaybackOpts): [SpotifyPlaybackState, SpotifyPlaybackControls] {
  const { isOpen, spotifyActivity } = opts;
  const [state, setState] = useState<SpotifyPlaybackState>(INITIAL_STATE);

  const lastActionRef = useRef(0);
  const progressRef = useRef(0);
  const isPlayingRef = useRef(false);
  const durationRef = useRef(0);
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Keep refs in sync with state for interval callbacks
  useEffect(() => { progressRef.current = state.progressMs; }, [state.progressMs]);
  useEffect(() => { isPlayingRef.current = state.isPlaying; }, [state.isPlaying]);
  useEffect(() => {
    durationRef.current = spotifyActivity?.durationMs ?? 0;
  }, [spotifyActivity?.durationMs]);

  // Reset premiumDismissed when player closes
  useEffect(() => {
    if (!isOpen) {
      setState(s => s.premiumDismissed ? { ...s, premiumDismissed: false } : s);
    }
  }, [isOpen]);

  // Fetch playback state

  const fetchPlaybackState = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiClient.getSpotifyPlaybackState();
      if (signal?.aborted) return;

      if (!data.active) {
        setState(s => ({
          ...s,
          hasActiveDevice: false,
          isPlaying: false,
          progressMs: 0,
          isPremium: data.isPremium ?? s.isPremium,
          loading: false,
        }));
        return;
      }

      setState(s => ({
        ...s,
        hasActiveDevice: true,
        isPlaying: !!data.playing,
        progressMs: data.track?.progressMs ?? 0,
        shuffleOn: !!data.shuffle,
        repeatMode: data.repeat ?? 'off',
        isPremium: data.isPremium ?? true,
        loading: false,
      }));
    } catch {
      // Network error — just mark loading done, don't disrupt existing state
      setState(s => s.loading ? { ...s, loading: false } : s);
    }
  }, []);

  // Polling effect

  useEffect(() => {
    if (!isOpen) {
      // Clean up when closed or no activity
      if (pollTimeoutRef.current) { clearTimeout(pollTimeoutRef.current); pollTimeoutRef.current = null; }
      if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
      setState(INITIAL_STATE);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    // Immediate first fetch
    fetchPlaybackState(controller.signal);

    // Schedule recurring polls
    const schedulePoll = () => {
      pollTimeoutRef.current = setTimeout(async () => {
        if (controller.signal.aborted) return;
        await fetchPlaybackState(controller.signal);
        if (!controller.signal.aborted) schedulePoll();
      }, POLL_INTERVAL_MS);
    };
    schedulePoll();

    return () => {
      controller.abort();
      abortRef.current = null;
      if (pollTimeoutRef.current) { clearTimeout(pollTimeoutRef.current); pollTimeoutRef.current = null; }
    };
  }, [isOpen, spotifyActivity, fetchPlaybackState]);

  // Progress interpolation

  useEffect(() => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }

    if (!isOpen || !state.isPlaying) return;

    progressIntervalRef.current = setInterval(() => {
      const maxDuration = durationRef.current;
      setState(s => {
        const next = s.progressMs + PROGRESS_TICK_MS;
        if (maxDuration > 0 && next >= maxDuration) return { ...s, progressMs: maxDuration };
        return { ...s, progressMs: next };
      });
    }, PROGRESS_TICK_MS);

    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
    };
  }, [isOpen, state.isPlaying]);

  // Control helpers

  const debounced = useCallback((): boolean => {
    const now = Date.now();
    if (now - lastActionRef.current < DEBOUNCE_MS) return false;
    lastActionRef.current = now;
    return true;
  }, []);

  const handleControlError = useCallback((result: { ok?: boolean; error?: string; code?: string }) => {
    if (result.code === 'PREMIUM_REQUIRED') {
      setState(s => ({ ...s, isPremium: false }));
    } else if (result.code === 'NO_ACTIVE_DEVICE') {
      setState(s => ({ ...s, hasActiveDevice: false }));
    }
  }, []);

  const forceRefetchAfterSkip = useCallback(() => {
    setTimeout(() => {
      if (!abortRef.current?.signal.aborted) {
        fetchPlaybackState(abortRef.current?.signal);
      }
    }, SKIP_REFETCH_DELAY_MS);
  }, [fetchPlaybackState]);

  // Controls

  const togglePlayPause = useCallback(() => {
    if (!debounced()) return;
    const wasPlaying = isPlayingRef.current;
    setState(s => ({ ...s, isPlaying: !wasPlaying }));
    apiClient.spotifyPlayPause(wasPlaying ? 'pause' : 'play')
      .then(r => { if (r.code) handleControlError(r); })
      .catch(() => {});
  }, [debounced, handleControlError]);

  const skipNext = useCallback(() => {
    if (!debounced()) return;
    setState(s => ({ ...s, progressMs: 0 }));
    apiClient.spotifyNext()
      .then(r => { if (r.code) handleControlError(r); else forceRefetchAfterSkip(); })
      .catch(() => {});
  }, [debounced, handleControlError, forceRefetchAfterSkip]);

  const skipPrevious = useCallback(() => {
    if (!debounced()) return;
    setState(s => ({ ...s, progressMs: 0 }));
    apiClient.spotifyPrevious()
      .then(r => { if (r.code) handleControlError(r); else forceRefetchAfterSkip(); })
      .catch(() => {});
  }, [debounced, handleControlError, forceRefetchAfterSkip]);

  const toggleShuffle = useCallback(() => {
    if (!debounced()) return;
    const newState = !state.shuffleOn;
    setState(s => ({ ...s, shuffleOn: newState }));
    apiClient.spotifyShuffle(newState)
      .then(r => { if (r.code) handleControlError(r); })
      .catch(() => {});
  }, [debounced, state.shuffleOn, handleControlError]);

  const cycleRepeat = useCallback(() => {
    if (!debounced()) return;
    const cycle: Record<string, 'off' | 'track' | 'context'> = { off: 'context', context: 'track', track: 'off' };
    const next = cycle[state.repeatMode] ?? 'off';
    setState(s => ({ ...s, repeatMode: next }));
    apiClient.spotifyRepeat(next)
      .then(r => { if (r.code) handleControlError(r); })
      .catch(() => {});
  }, [debounced, state.repeatMode, handleControlError]);

  const dismissPremium = useCallback(() => {
    setState(s => ({ ...s, premiumDismissed: true }));
  }, []);

  return [
    state,
    { togglePlayPause, skipNext, skipPrevious, toggleShuffle, cycleRepeat, dismissPremium },
  ];
}
